import { fingerprintPat, githubPat } from "./auth.ts";
import { parseConfig } from "./config.ts";
import { decodeRepositoryName } from "./identity.ts";
import { fallThrough, type ImmutableCache } from "./fallthrough.ts";
import { parsePackageIdentity } from "./identity.ts";

export { AdmissionDurableObject, PackageDurableObject } from "./durable-objects.ts";
export { fallThrough } from "./fallthrough.ts";

export interface Env {
  JSRPROXY_CONFIG?: string;
  AUTH_FINGERPRINT_SECRET?: string;
  ADMISSION?: DurableObjectNamespaceLike;
  PACKAGES?: DurableObjectNamespaceLike;
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
      return Response.json(
        { error: "synthetic registry materialization is not configured" },
        { status: 501, headers: { "cache-control": "no-store" } },
      );
    }
    const edgeCache = (caches as CacheStorage & { default: ImmutableCache }).default;
    return fallThrough(request, fetch, edgeCache);
  },
};

export default worker;
