const ACCEPT_REGISTRY_CONTENT =
  "application/json, application/javascript, text/javascript, application/typescript, text/typescript, application/wasm, */*;q=0.8";

/** The subset of the Cache API used by the fallthrough cache. */
export interface ImmutableCache {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

interface VersionMetadata {
  manifest?: Record<string, { checksum?: unknown }>;
}

/**
 * Forwards a JSR read without forwarding caller credentials. Immutable version
 * metadata and module responses are cached only after module bytes match their
 * upstream `sha256-<hex>` manifest checksum.
 */
export async function fallThrough(
  request: Request,
  fetcher: typeof fetch = fetch,
  cache?: ImmutableCache,
): Promise<Response> {
  const upstream = upstreamRequest(request);
  if (request.method !== "GET") {
    return fetcher(upstream);
  }

  const cacheKey = new Request(upstream.url, { method: "GET" });
  const immutable = immutablePath(new URL(upstream.url).pathname);
  if (immutable && cache) {
    const cached = await cache.match(cacheKey);
    if (cached) {
      return cached;
    }
  }

  if (immutable?.kind === "version-metadata") {
    const response = await fetcher(upstream);
    return cacheResponse(cache, cacheKey, response);
  }

  if (immutable?.kind === "module") {
    const metadataResponse = await fetchVersionMetadata(upstream, immutable.version, fetcher, cache);
    if (!metadataResponse.ok) {
      return metadataResponse;
    }
    const metadata = await readVersionMetadata(metadataResponse);
    const expectedChecksum = metadata.manifest?.[immutable.path]?.checksum;
    if (typeof expectedChecksum !== "string" || !/^sha256-[0-9a-f]{64}$/.test(expectedChecksum)) {
      return new Response("upstream version metadata has no usable checksum for this module", { status: 502 });
    }

    const response = await fetcher(upstream);
    if (!response.ok) {
      return response;
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if ((await sha256Checksum(bytes)) !== expectedChecksum) {
      return new Response("upstream module bytes did not match version metadata", { status: 502 });
    }
    const verified = new Response(bytes, { status: response.status, statusText: response.statusText, headers: response.headers });
    return cacheResponse(cache, cacheKey, verified);
  }

  return fetcher(upstream);
}

function upstreamRequest(request: Request): Request {
  const upstream = new URL(request.url);
  upstream.protocol = "https:";
  upstream.hostname = "jsr.io";
  upstream.port = "";

  const headers = new Headers(request.headers);
  headers.delete("authorization");
  headers.delete("sec-fetch-dest");
  headers.set("accept", ACCEPT_REGISTRY_CONTENT);
  return new Request(upstream, { method: request.method, headers, body: request.body, redirect: "manual" });
}

async function fetchVersionMetadata(
  moduleRequest: Request,
  version: string,
  fetcher: typeof fetch,
  cache: ImmutableCache | undefined,
): Promise<Response> {
  const url = new URL(moduleRequest.url);
  const segments = url.pathname.split("/");
  url.pathname = `${segments.slice(0, 3).join("/")}/${version}_meta.json`;
  url.search = "";
  const metadataRequest = new Request(url, { method: "GET", headers: moduleRequest.headers });
  const cacheKey = new Request(url, { method: "GET" });
  if (cache) {
    const cached = await cache.match(cacheKey);
    if (cached) {
      return cached;
    }
  }
  return cacheResponse(cache, cacheKey, await fetcher(metadataRequest));
}

async function cacheResponse(
  cache: ImmutableCache | undefined,
  key: Request,
  response: Response,
): Promise<Response> {
  if (cache && response.ok) {
    await cache.put(key, response.clone());
  }
  return response;
}

async function readVersionMetadata(response: Response): Promise<VersionMetadata> {
  try {
    return (await response.json()) as VersionMetadata;
  } catch {
    return {};
  }
}

function immutablePath(pathname: string):
  | { kind: "version-metadata" }
  | { kind: "module"; version: string; path: string }
  | undefined {
  const segments = pathname.split("/");
  if (segments.length === 4 && segments[1]?.startsWith("@") && segments[3]?.endsWith("_meta.json")) {
    return { kind: "version-metadata" };
  }
  if (segments.length >= 5 && segments[1]?.startsWith("@") && segments[2] && segments[3]) {
    const path = decodeModulePath(segments.slice(4).join("/"));
    return path ? { kind: "module", version: segments[3], path } : undefined;
  }
  return undefined;
}

function decodeModulePath(path: string): string | undefined {
  try {
    const decoded = decodeURIComponent(path);
    return decoded.split("/").some((part) => part === "" || part === "." || part === "..") ? undefined : decoded;
  } catch {
    return undefined;
  }
}

async function sha256Checksum(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource));
  let hex = "";
  for (const byte of digest) hex += byte.toString(16).padStart(2, "0");
  return `sha256-${hex}`;
}
