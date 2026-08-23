import { parseConfig } from "./config.ts";
import { parsePackageIdentity } from "./identity.ts";

export { AdmissionDurableObject, PackageDurableObject } from "./durable-objects.ts";

export interface Env {
  JSRPROXY_CONFIG?: string;
}

/** Forwards non-synthetic JSR reads without forwarding caller credentials. */
export async function fallThrough(request: Request, fetcher: typeof fetch = fetch): Promise<Response> {
  const upstream = new URL(request.url);
  upstream.protocol = "https:";
  upstream.hostname = "jsr.io";
  upstream.port = "";

  const headers = new Headers(request.headers);
  headers.delete("authorization");
  headers.delete("sec-fetch-dest");
  headers.set(
    "accept",
    "application/json, application/javascript, text/javascript, application/typescript, text/typescript, application/wasm, */*;q=0.8",
  );
  return fetcher(new Request(upstream, { method: request.method, headers, body: request.body, redirect: "manual" }));
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
    return fallThrough(request);
  },
};

export default worker;
