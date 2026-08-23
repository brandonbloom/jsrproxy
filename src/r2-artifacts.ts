interface R2ObjectLike {
  body: ReadableStream<Uint8Array>;
  httpEtag: string;
  uploaded: Date;
  httpMetadata?: { contentType?: string };
}

export interface R2BucketLike {
  get(key: string): Promise<R2ObjectLike | null>;
}

/** Serves a concrete version only when its immutable ready marker exists. */
export async function serveArtifact(
  bucket: R2BucketLike,
  versionPrefix: string,
  key: string,
  request: Request,
): Promise<Response> {
  const marker = await bucket.get(`${versionPrefix}.ready.json`);
  if (!marker) return new Response("not found", { status: 404 });
  const object = await bucket.get(key);
  if (!object) return new Response("not found", { status: 404 });
  const etag = `"${object.httpEtag}"`;
  const modified = object.uploaded.toUTCString();
  if (request.headers.get("if-none-match") === etag || request.headers.get("if-modified-since") === modified) {
    return new Response(null, { status: 304, headers: { etag, "last-modified": modified } });
  }
  return new Response(object.body, {
    headers: {
      "content-type": object.httpMetadata?.contentType ?? contentType(key),
      "cache-control": "public, max-age=31536000, immutable",
      etag,
      "last-modified": modified,
    },
  });
}

function contentType(key: string): string {
  if (/\.(?:ts|mts|cts|tsx)$/.test(key)) return "application/typescript";
  if (/\.(?:js|mjs|cjs|jsx)$/.test(key)) return "application/javascript";
  if (key.endsWith(".json")) return "application/json";
  if (key.endsWith(".wasm")) return "application/wasm";
  return "application/octet-stream";
}
