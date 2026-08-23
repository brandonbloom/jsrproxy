const SHA256_HEADER = "x-jsrproxy-sha256";

interface R2StoredObject {
  customMetadata?: Record<string, string>;
}

export interface R2PublicationBucket {
  head(key: string): Promise<R2StoredObject | null>;
  put(
    key: string,
    value: ArrayBuffer,
    options: {
      onlyIf: { etagDoesNotMatch: string };
      customMetadata: Record<string, string>;
      httpMetadata: { contentType: string };
    },
  ): Promise<R2StoredObject | null>;
}

/**
 * Accepts one immutable materializer upload through the Container outbound
 * handler. A retried upload succeeds only when the existing R2 object has the
 * same independently verified SHA-256 digest.
 */
export async function publishArtifact(
  bucket: R2PublicationBucket,
  request: Request,
): Promise<Response> {
  if (request.method !== "PUT") return new Response("method not allowed", { status: 405, headers: { allow: "PUT" } });
  const key = artifactKey(new URL(request.url).pathname);
  if (!key) return new Response("invalid artifact key", { status: 400 });
  const expected = request.headers.get(SHA256_HEADER);
  if (!expected || !/^[0-9a-f]{64}$/.test(expected)) {
    return new Response(`missing or invalid ${SHA256_HEADER}`, { status: 400 });
  }
  const bytes = await request.arrayBuffer();
  if (await sha256Hex(bytes) !== expected) return new Response("artifact checksum did not match body", { status: 422 });

  const options = {
    onlyIf: { etagDoesNotMatch: "*" },
    customMetadata: { sha256: expected },
    httpMetadata: { contentType: contentType(key) },
  };
  const written = await bucket.put(key, bytes, options);
  if (written) return new Response(null, { status: 201 });

  const existing = await bucket.head(key);
  if (existing?.customMetadata?.sha256 === expected) return new Response(null, { status: 200 });
  return new Response("artifact key already exists with different bytes", { status: 409 });
}

function artifactKey(pathname: string): string | undefined {
  const segments = pathname.split("/");
  if (segments[0] !== "" || segments[1] !== "synthetic" || segments.length < 5) return undefined;
  const decoded = segments.slice(1).map((segment) => {
    try { return decodeURIComponent(segment); } catch { return undefined; }
  });
  if (decoded.some((segment) => !segment || segment === "." || segment === ".." || segment.includes("\\"))) return undefined;
  const key = decoded.join("/");
  return /^synthetic\/[a-z0-9][a-z0-9-]*\/[a-z0-9-]+\/[0-9]+\.[0-9]+\.[0-9]+(?:\.ready\.json|_meta\.json|\/.*)?$/.test(key) ? key : undefined;
}

function contentType(key: string): string {
  if (/\.(?:ts|mts|cts|tsx)$/.test(key)) return "application/typescript";
  if (/\.(?:js|mjs|cjs|jsx)$/.test(key)) return "application/javascript";
  if (key.endsWith(".json")) return "application/json";
  if (key.endsWith(".wasm")) return "application/wasm";
  return "application/octet-stream";
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  let hex = "";
  for (const byte of digest) hex += byte.toString(16).padStart(2, "0");
  return hex;
}
