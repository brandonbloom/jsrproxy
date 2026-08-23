import { fingerprintPat, githubPat } from "./auth.ts";
import { parseConfig } from "./config.ts";
import { discoverGitHubBranches, GitHubBranchDiscoveryError } from "./github-branches.ts";
import { parsePackageRecoveryPath, parsePackageStatusPath, proxyableRepositoryName } from "./identity.ts";
import { type R2BucketLike, serveArtifact } from "./r2-artifacts.ts";
import { fallThrough, type ImmutableCache } from "./fallthrough.ts";
import { parsePackageIdentity } from "./identity.ts";

export {
  AdmissionDurableObject,
  AdmissionDurableObjectV2,
  PackageDurableObject,
  PackageDurableObjectV2,
} from "./durable-objects.ts";
export { fallThrough } from "./fallthrough.ts";
export { ContainerProxy } from "@cloudflare/containers";
export { MaterializerContainer } from "./materializer-container.ts";

export interface Env {
  JSRPROXY_CONFIG?: string;
  AUTH_FINGERPRINT_SECRET?: string;
  RECOVERY_SECRET?: string;
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
    const status = parsePackageStatusPath(url.pathname);
    const recovery = parsePackageRecoveryPath(url.pathname);
    const identity = status?.identity ?? recovery?.identity ?? parsePackageIdentity(url.pathname);
    const requestedScope = status?.identity.scope ?? recovery?.identity.scope ?? configuredScope(url.pathname, config.scopes) ?? configuredStatusScope(url.pathname, config.scopes) ?? configuredRecoveryScope(url.pathname, config.scopes);
    if (requestedScope && !identity) return new Response("invalid package name", { status: 404 });
    if (identity && config.scopes.has(identity.scope)) {
      if (recovery) return recoverPackage(request, env, identity, recovery.version);
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
      if (status) return packageStatus(env.PACKAGES, identity, status.version);
      if (isPackageMetadataPath(url.pathname)) {
        return refreshPackageMetadata(
          env.PACKAGES,
          identity,
          scope.owner,
          repository,
          pat,
          url.origin,
        );
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

function configuredStatusScope<T>(pathname: string, scopes: ReadonlyMap<string, T>): string | undefined {
  const match = /^\/-\/status\/@([a-z0-9][a-z0-9-]*)(?:\/|$)/.exec(pathname);
  return match && scopes.has(match[1]) ? match[1] : undefined;
}

function configuredRecoveryScope<T>(pathname: string, scopes: ReadonlyMap<string, T>): string | undefined {
  const match = /^\/-\/recover\/@([a-z0-9][a-z0-9-]*)(?:\/|$)/.exec(pathname);
  return match && scopes.has(match[1]) ? match[1] : undefined;
}

async function recoverPackage(
  request: Request,
  env: Env,
  identity: { scope: string; name: string },
  version: string,
): Promise<Response> {
  if (request.method !== "POST") return new Response("method not allowed", { status: 405, headers: { allow: "POST" } });
  if (!env.RECOVERY_SECRET) return new Response("recovery is not configured", { status: 503 });
  if (request.headers.get("x-jsrproxy-recovery-secret") !== env.RECOVERY_SECRET) return new Response("not found", { status: 404 });
  const body = await request.json().catch(() => undefined) as { reason?: unknown } | undefined;
  if (typeof body?.reason !== "string") return new Response("recovery reason is required", { status: 400 });
  if (!env.PACKAGES) return new Response("synthetic registry is not configured", { status: 503 });
  const response = await env.PACKAGES.get(env.PACKAGES.idFromName(`@${identity.scope}/${identity.name}`)).fetch(
    new Request("https://package.internal/recover", {
      method: "POST",
      body: JSON.stringify({ version, reason: body.reason, recoveredAt: Math.floor(Date.now() / 1_000) }),
    }),
  );
  return new Response(response.body, { status: response.status, headers: { "cache-control": "no-store", "content-type": response.headers.get("content-type") ?? "text/plain; charset=utf-8" } });
}

async function packageStatus(
  packages: DurableObjectNamespaceLike,
  identity: { scope: string; name: string },
  version: string | undefined,
): Promise<Response> {
  const response = await packages.get(packages.idFromName(`@${identity.scope}/${identity.name}`)).fetch(
    new Request("https://package.internal/status"),
  );
  if (!response.ok) return new Response("package status unavailable", { status: 503, headers: response.headers });
  const status = await response.json().catch(() => undefined) as {
    meta?: { scope: string; name: string; versions: Record<string, { yanked: boolean }> };
    jobs?: Array<{ version: string }>;
  } | undefined;
  if (!status?.meta || !Array.isArray(status.jobs)) return new Response("package status is invalid", { status: 502 });
  if (!version) return Response.json(status, { headers: { "cache-control": "no-store" } });
  const entry = status.meta.versions[version];
  const jobs = status.jobs.filter((job) => job.version === version);
  if (!entry && jobs.length === 0) return new Response("not found", { status: 404 });
  return Response.json({
    meta: { ...status.meta, versions: entry ? { [version]: entry } : {} },
    jobs,
  }, { headers: { "cache-control": "no-store" } });
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
