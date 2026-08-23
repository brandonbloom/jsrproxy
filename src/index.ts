import { parseConfig } from "./config.ts";
import { fallThrough, type ImmutableCache } from "./fallthrough.ts";
import { parsePackageIdentity } from "./identity.ts";

export { AdmissionDurableObject, PackageDurableObject } from "./durable-objects.ts";
export { fallThrough } from "./fallthrough.ts";

export interface Env {
  JSRPROXY_CONFIG?: string;
}

const worker = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const config = parseConfig(env.JSRPROXY_CONFIG);
    const identity = parsePackageIdentity(new URL(request.url).pathname);
    if (identity && config.scopes.has(identity.scope)) {
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
