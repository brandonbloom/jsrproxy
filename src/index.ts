import { fingerprintPat, githubPat } from "./auth.ts";
import { parseConfig } from "./config.ts";
import { discoverGitHubBranches, GitHubBranchDiscoveryError } from "./github-branches.ts";
import { proxyableRepositoryName } from "./identity.ts";
import { type R2BucketLike, serveArtifact } from "./r2-artifacts.ts";
import { fallThrough, type ImmutableCache } from "./fallthrough.ts";
import { parsePackageIdentity } from "./identity.ts";

export { AdmissionDurableObject, PackageDurableObject } from "./durable-objects.ts";
export { fallThrough } from "./fallthrough.ts";
export { ContainerProxy } from "@cloudflare/containers";
export { MaterializerContainer } from "./materializer-container.ts";

export interface Env {
  JSRPROXY_CONFIG?: string;
  AUTH_FINGERPRINT_SECRET?: string;
  ADMISSION?: DurableObjectNamespaceLike;
  PACKAGES?: DurableObjectNamespaceLike;
  MATERIALIZER?: DurableObjectNamespaceLike;
  ARTIFACTS?: R2BucketLike;
}

interface DurableObjectNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
}

const worker = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const config = parseConfig(env.JSRPROXY_CONFIG);
    const url = new URL(request.url);
    const identity = parsePackageIdentity(url.pathname);
    const requestedScope = configuredScope(url.pathname, config.scopes);
    if (requestedScope && !identity) return new Response("invalid package name", { status: 404 });
    if (identity && config.scopes.has(identity.scope)) {
      const pat = githubPat(request);
      if (!pat) return new Response("GitHub PAT required", { status: 401 });
      if (!env.AUTH_FINGERPRINT_SECRET || !env.ADMISSION || !env.PACKAGES) {
        return new Response("synthetic registry is not configured", { status: 503 });
      }
      const repository = proxyableRepositoryName(identity.name);
      if (!repository) return new Response("invalid package name", { status: 404 });
      const fingerprint = await fingerprintPat(env.AUTH_FINGERPRINT_SECRET, pat);
      const admission = await env.ADMISSION.get(env.ADMISSION.idFromName(fingerprint)).fetch(
        new Request("https://admission.internal/check", { method: "POST", body: JSON.stringify({ pat }) }),
      );
      if (!admission.ok) return new Response("GitHub authorization unavailable", { status: 503, headers: admission.headers });
      if (!(await admission.json() as { granted?: boolean }).granted) return new Response("not found", { status: 404 });
      const scope = config.scopes.get(identity.scope)!;
      const packageAuthorization = await env.PACKAGES.get(env.PACKAGES.idFromName(`@${identity.scope}/${identity.name}`)).fetch(
        new Request("https://package.internal/authorize", { method: "POST", body: JSON.stringify({ fingerprint, owner: scope.owner, repository, pat }) }),
      );
      if (!packageAuthorization.ok) return new Response("GitHub authorization unavailable", { status: 503, headers: packageAuthorization.headers });
      if (!(await packageAuthorization.json() as { granted?: boolean }).granted) return new Response("not found", { status: 404 });
      if (isPackageMetadataPath(url.pathname)) {
        return refreshPackageMetadata(env.PACKAGES, identity, scope.owner, repository, pat, url.origin);
      }
      const artifact = syntheticArtifactPath(url.pathname, identity);
      if (artifact && env.ARTIFACTS) return serveArtifact(env.ARTIFACTS, artifact.versionPrefix, artifact.key, request);
      return Response.json(
        { error: "synthetic registry materialization is not configured" },
        { status: 501, headers: { "cache-control": "no-store" } },
      );
    }
    const edgeCache = (caches as CacheStorage & { default: ImmutableCache }).default;
    return fallThrough(request, fetch, edgeCache);
  },
};

function configuredScope<T>(pathname: string, scopes: ReadonlyMap<string, T>): string | undefined {
  const match = /^\/@([a-z0-9][a-z0-9-]*)\//.exec(pathname);
  return match && scopes.has(match[1]) ? match[1] : undefined;
}

function syntheticArtifactPath(pathname: string, identity: { scope: string; name: string }): { versionPrefix: string; key: string } | undefined {
  const segments = pathname.split("/");
  const prefix = `synthetic/${identity.scope}/${identity.name}`;
  if (segments.length === 4 && segments[3]?.endsWith("_meta.json")) {
    const version = segments[3].slice(0, -"_meta.json".length);
    return version ? { versionPrefix: `${prefix}/${version}`, key: `${prefix}/${segments[3]}` } : undefined;
  }
  if (segments.length >= 5 && segments[3]) {
    return { versionPrefix: `${prefix}/${segments[3]}`, key: `${prefix}/${segments.slice(3).join("/")}` };
  }
  return undefined;
}

async function refreshPackageMetadata(
  packages: DurableObjectNamespaceLike,
  identity: { scope: string; name: string },
  owner: string,
  repository: string,
  pat: string,
  origin: string,
): Promise<Response> {
  let discovery;
  try {
    discovery = await discoverGitHubBranches(owner, repository, pat);
  } catch (error) {
    if (error instanceof GitHubBranchDiscoveryError) {
      if (error.status === 401 || error.status === 404) return new Response("not found", { status: 404 });
      return new Response("GitHub branch discovery unavailable", {
        status: 503,
        headers: error.retryAfterSeconds ? { "retry-after": String(error.retryAfterSeconds) } : undefined,
      });
    }
    return new Response("GitHub branch discovery failed", { status: 502 });
  }

  const branches = [...discovery.branches].map(([name, tip]) => ({ name, ...tip }));
  const response = await packages.get(packages.idFromName(`@${identity.scope}/${identity.name}`)).fetch(
    new Request("https://package.internal/refresh", {
      method: "POST",
      body: JSON.stringify({ package: identity, discovery: { defaultBranch: discovery.defaultBranch, branches } }),
    }),
  );
  if (!response.ok) return new Response("package registry unavailable", { status: 503, headers: response.headers });
  let result = await response.json() as {
    meta?: { scope: string; name: string; versions: Record<string, { yanked: boolean }> };
    jobs?: Array<{ state: string }>;
  };
  if (!result.meta || !result.jobs) return new Response("package registry returned an invalid response", { status: 502 });
  if (result.jobs.some((job) => job.state === "pending")) {
    const materialization = await packages.get(packages.idFromName(`@${identity.scope}/${identity.name}`)).fetch(
      new Request("https://package.internal/materialize", {
        method: "POST",
        body: JSON.stringify({
          owner,
          repository,
          pat,
          statusUrl: `${origin}/-/status/@${identity.scope}/${identity.name}`,
        }),
      }),
    );
    if (!materialization.ok) {
      return new Response("package materialization pending", {
        status: 503,
        headers: { "retry-after": materialization.headers.get("retry-after") ?? "1" },
      });
    }
    result = await materialization.json() as typeof result;
    if (!result.meta || !result.jobs) return new Response("package materialization returned an invalid response", { status: 502 });
  }
  if (Object.keys(result.meta.versions).length === 0 && result.jobs.some((job) => job.state === "pending" || job.state === "leased")) {
    return new Response("package materialization pending", { status: 503, headers: { "retry-after": "1" } });
  }
  return Response.json(result.meta, { headers: { "cache-control": "public, max-age=60" } });
}

function isPackageMetadataPath(pathname: string): boolean {
  const segments = pathname.split("/");
  return segments.length === 4 && segments[3] === "meta.json";
}

export default worker;
