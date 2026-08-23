import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, test } from "node:test";
import { type ImmutableCache, fallThrough } from "../src/fallthrough.ts";

class MemoryCache implements ImmutableCache {
  readonly entries = new Map<string, Response>();

  async match(request: Request): Promise<Response | undefined> {
    return this.entries.get(request.url)?.clone();
  }

  async put(request: Request, response: Response): Promise<void> {
    this.entries.set(request.url, response.clone());
  }
}

const checksum = (bytes: string): string => `sha256-${createHash("sha256").update(bytes).digest("hex")}`;

describe("fallthrough", () => {
  test("strips the caller PAT and forces a non-document accept header", async () => {
    let forwarded: Request | undefined;
    const response = await fallThrough(
      new Request("http://proxy.invalid/@std/assert/meta.json", {
        headers: { authorization: "Bearer secret", "sec-fetch-dest": "document", accept: "text/html" },
      }),
      async (request) => {
        forwarded = request;
        return new Response("upstream", { headers: { "content-type": "application/json" } });
      },
    );
    assert.equal(forwarded?.url, "https://jsr.io/@std/assert/meta.json");
    assert.equal(forwarded?.headers.get("authorization"), null);
    assert.equal(forwarded?.headers.get("sec-fetch-dest"), null);
    assert.ok(!forwarded?.headers.get("accept")?.includes("text/html"));
    assert.equal(await response.text(), "upstream");
  });

  test("verifies and caches immutable module bytes against version metadata", async () => {
    const cache = new MemoryCache();
    const source = "export const answer: number = 42;\n";
    const requests: string[] = [];
    const fetcher: typeof fetch = async (request) => {
      requests.push(request.url);
      if (request.url.endsWith("/1.1.42_meta.json")) {
        return Response.json({ manifest: { "mod.ts": { checksum: checksum(source) } } });
      }
      if (request.url.endsWith("/1.1.42/mod.ts")) return new Response(source, { headers: { "content-type": "application/typescript" } });
      throw new Error(`unexpected upstream request: ${request.url}`);
    };
    const request = new Request("https://proxy.invalid/@scope/package/1.1.42/mod.ts", {
      headers: { authorization: "Bearer secret" },
    });

    assert.equal(await (await fallThrough(request, fetcher, cache)).text(), source);
    assert.deepEqual(requests, [
      "https://jsr.io/@scope/package/1.1.42_meta.json",
      "https://jsr.io/@scope/package/1.1.42/mod.ts",
    ]);
    assert.equal(await (await fallThrough(request, fetcher, cache)).text(), source);
    assert.equal(requests.length, 2);
  });

  test("rejects mismatched upstream module bytes without caching them", async () => {
    const cache = new MemoryCache();
    const fetcher: typeof fetch = async (request) => {
      if (request.url.endsWith("_meta.json")) {
        return Response.json({ manifest: { "mod.ts": { checksum: checksum("expected") } } });
      }
      return new Response("received");
    };
    const response = await fallThrough(
      new Request("https://proxy.invalid/@scope/package/1.1.42/mod.ts"),
      fetcher,
      cache,
    );
    assert.equal(response.status, 502);
    assert.equal(cache.entries.has("https://jsr.io/@scope/package/1.1.42/mod.ts"), false);
  });
});
