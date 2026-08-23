import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { AdmissionDurableObject } from "../src/durable-objects.ts";

class MemoryStorage {
  readonly values = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.values.set(key, value);
  }
}

describe("admission durable object", () => {
  test("uses GitHub once then serves the unextended cached decision", async () => {
    const storage = new MemoryStorage();
    const object = new AdmissionDurableObject(
      { storage },
      { JSRPROXY_CONFIG: JSON.stringify({ trusted_github_users: ["trusted"] }) },
    );
    const originalFetch = globalThis.fetch;
    let requests = 0;
    globalThis.fetch = async (request) => {
      requests += 1;
      assert.equal(request.url, "https://api.github.com/user");
      assert.equal(request.headers.get("authorization"), "Bearer secret");
      return Response.json({ login: "trusted" });
    };
    try {
      const request = () => new Request("https://admission.invalid/check", { method: "POST", body: JSON.stringify({ pat: "secret" }) });
      const first = await object.fetch(request());
      assert.equal(first.status, 200);
      assert.equal((await first.json() as { granted: boolean }).granted, true);
      await object.fetch(request());
      assert.equal(requests, 1);
      assert.equal(JSON.stringify([...storage.values.values()]).includes("secret"), false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("turns GitHub rate limits into a retryable failure without caching them", async () => {
    const storage = new MemoryStorage();
    const object = new AdmissionDurableObject({ storage }, {});
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(null, { status: 429, headers: { "retry-after": "9" } });
    try {
      const response = await object.fetch(new Request("https://admission.invalid/check", { method: "POST", body: JSON.stringify({ pat: "secret" }) }));
      assert.equal(response.status, 503);
      assert.equal(response.headers.get("retry-after"), "9");
      assert.equal(storage.values.size, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
