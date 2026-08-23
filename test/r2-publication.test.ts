import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, test } from "node:test";
import { publishArtifact, publishArtifactBatch } from "../src/r2-publication.ts";

const digest = (body: string) => createHash("sha256").update(body).digest("hex");

class MemoryBucket {
  readonly objects = new Map<string, { body: ArrayBuffer; customMetadata: Record<string, string> }>();

  async head(key: string) {
    return this.objects.get(key) ?? null;
  }

  async put(key: string, body: ArrayBuffer, options: { onlyIf: { etagDoesNotMatch: string }; customMetadata: Record<string, string>; httpMetadata: { contentType: string } }) {
    assert.equal(options.onlyIf.etagDoesNotMatch, "*");
    if (this.objects.has(key)) return null;
    this.objects.set(key, { body, customMetadata: options.customMetadata });
    return this.objects.get(key)!;
  }
}

describe("R2 artifact publication", () => {
  test("writes a verified artifact once and accepts a matching retry", async () => {
    const bucket = new MemoryBucket();
    const body = "export const answer = 42;\n";
    const upload = () => new Request("http://artifacts.r2/synthetic/acme/widget/1.1.42/mod.ts", {
      method: "PUT",
      headers: { "x-jsrproxy-sha256": digest(body) },
      body,
    });
    assert.equal((await publishArtifact(bucket, upload())).status, 201);
    assert.equal((await publishArtifact(bucket, upload())).status, 200);
    assert.equal(bucket.objects.get("synthetic/acme/widget/1.1.42/mod.ts")?.customMetadata.sha256, digest(body));
  });

  test("rejects a mismatched body and an existing different artifact", async () => {
    const bucket = new MemoryBucket();
    const key = "http://artifacts.r2/synthetic/acme/widget/1.1.42/mod.ts";
    assert.equal((await publishArtifact(bucket, new Request(key, { method: "PUT", headers: { "x-jsrproxy-sha256": digest("expected") }, body: "received" }))).status, 422);
    assert.equal((await publishArtifact(bucket, new Request(key, { method: "PUT", headers: { "x-jsrproxy-sha256": digest("one") }, body: "one" }))).status, 201);
    assert.equal((await publishArtifact(bucket, new Request(key, { method: "PUT", headers: { "x-jsrproxy-sha256": digest("two") }, body: "two" }))).status, 409);
  });

  test("writes a batch in order and rejects malformed entries", async () => {
    const bucket = new MemoryBucket();
    const body = "export const answer = 42;\n";
    const marker = '{"manifest_sha256":"example"}';
    const batch = new Request("http://artifacts.r2/batch", {
      method: "PUT",
      body: JSON.stringify({
        uploads: [
          { key: "synthetic/acme/widget/1.1.42/mod.ts", sha256: digest(body), body: btoa(body) },
          { key: "synthetic/acme/widget/1.1.42.ready.json", sha256: digest(marker), body: btoa(marker) },
        ],
      }),
    });
    assert.equal((await publishArtifactBatch(bucket, batch)).status, 204);
    assert.deepEqual([...bucket.objects.keys()], [
      "synthetic/acme/widget/1.1.42/mod.ts",
      "synthetic/acme/widget/1.1.42.ready.json",
    ]);
    assert.equal((await publishArtifactBatch(bucket, new Request("http://artifacts.r2/batch", { method: "PUT", body: "{}" }))).status, 400);
  });
});
