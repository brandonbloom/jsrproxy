import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { PackageDurableObject } from "../src/durable-objects.ts";

class Storage {
  values = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> { return this.values.get(key) as T | undefined; }
  async put<T>(key: string, value: T): Promise<void> { this.values.set(key, value); }
}

describe("package authorization durable object", () => {
  test("caches a repository grant by fingerprint without storing its PAT", async () => {
    const storage = new Storage();
    const object = new PackageDurableObject({ storage });
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async (request) => {
      calls += 1;
      assert.equal(request.url, "https://api.github.com/repos/acme/widget");
      assert.equal(request.headers.get("authorization"), "Bearer pat");
      return Response.json({ private: true, name: "widget" });
    };
    const request = () => new Request("https://package.invalid/authorize", { method: "POST", body: JSON.stringify({ fingerprint: "fp", owner: "acme", repository: "widget", pat: "pat" }) });
    try {
      assert.equal((await object.fetch(request())).status, 200);
      assert.equal((await object.fetch(request())).status, 200);
      assert.equal(calls, 1);
      assert.equal(JSON.stringify([...storage.values.values()]).includes("pat"), false);
    } finally { globalThis.fetch = originalFetch; }
  });

  test("rejects an old repository name that GitHub redirects to a renamed repository", async () => {
    const storage = new Storage();
    const object = new PackageDurableObject({ storage });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => Response.json({ name: "widget-renamed" });
    try {
      const response = await object.fetch(new Request("https://package.invalid/authorize", {
        method: "POST",
        body: JSON.stringify({ fingerprint: "fp", owner: "acme", repository: "widget", pat: "pat" }),
      }));
      assert.deepEqual(await response.json(), { granted: false, expiresAt: (await storage.get<{ expiresAt: number }>("repository:fp"))!.expiresAt });
    } finally { globalThis.fetch = originalFetch; }
  });
});
