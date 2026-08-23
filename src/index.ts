import { fingerprintPat, githubPat } from "./auth.ts";
import { parseConfig } from "./config.ts";
import { discoverGitHubBranches, GitHubBranchDiscoveryError } from "./github-branches.ts";
import { decodeRepositoryName } from "./identity.ts";
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
  ARTIFACTS?: R2BucketLike;
}

interface DurableObjectNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
}

const worker = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const config = parseConfig(env.JSRPROXY_CONFIG);
    const identity = parsePackageIdentity(new URL(request.url).pathname);
    if (identity && config.scopes.has(identity.scope)) {
      const pat = githubPat(request);
      if (!pat) return new Response("GitHub PAT required", { status: 401 });
      if (!env.AUTH_FINGERPRINT_SECRET || !env.ADMISSION || !env.PACKAGES) {
        return new Response("synthetic registry is not configured", { status: 503 });
      }
      let repository: string;
      try { repository = decodeRepositoryName(identity.name); } catch { return new Response("invalid package name", { status: 404 }); }
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
      if (isPackageMetadataPath(new URL(request.url).pathname)) {
        return refreshPackageMetadata(env.PACKAGES, identity, scope.owner, repository, pat);
      }
      const artifact = syntheticArtifactPath(new URL(request.url).pathname, identity);
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
  const result = await response.json() as {
    meta?: { scope: string; name: string; versions: Record<string, { yanked: boolean }> };
    jobs?: Array<{ state: string }>;
  };
  if (!result.meta || !result.jobs) return new Response("package registry returned an invalid response", { status: 502 });
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
