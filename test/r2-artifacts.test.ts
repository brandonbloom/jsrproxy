import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { serveArtifact } from "../src/r2-artifacts.ts";

describe("R2 artifact serving", () => {
  test("requires the marker and serves TypeScript with validators", async () => {
    const objects = new Map<string, { body: ReadableStream<Uint8Array>; httpEtag: string; uploaded: Date; httpMetadata?: { contentType?: string } }>();
    objects.set("synthetic/a/b/1.1.1.ready.json", { body: new Response("{}").body!, httpEtag: "marker", uploaded: new Date(0) });
    objects.set("synthetic/a/b/1.1.1/mod.ts", { body: new Response("export {};").body!, httpEtag: "body", uploaded: new Date(0) });
    const bucket = { get: async (key: string) => objects.get(key) ?? null };
    const response = await serveArtifact(bucket, "synthetic/a/b/1.1.1", "synthetic/a/b/1.1.1/mod.ts", new Request("https://proxy.invalid"));
    assert.equal(response.headers.get("content-type"), "application/typescript");
    assert.equal(await response.text(), "export {};");
    const cached = await serveArtifact(bucket, "synthetic/a/b/1.1.1", "synthetic/a/b/1.1.1/mod.ts", new Request("https://proxy.invalid", { headers: { "if-none-match": "\"body\"" } }));
    assert.equal(cached.status, 304);
  });
});
