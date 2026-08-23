import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { PackageDurableObject } from "../src/durable-objects.ts";

class Storage {
  values = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> { return this.values.get(key) as T | undefined; }
  async put<T>(key: string, value: T): Promise<void> { this.values.set(key, value); }
}

class Materializer {
  requests: Request[] = [];

  idFromName(name: string): string { return name; }

  get(_id: string) {
    return {
      fetch: async (request: Request) => {
        this.requests.push(request);
        return Response.json({ state: "ready" });
      },
    };
  }
}

describe("package registry durable object", () => {
  test("persists a refreshed package and exposes a version only after completion", async () => {
    const object = new PackageDurableObject({ storage: new Storage() });
    const refresh = () => new Request("https://package.invalid/refresh", {
      method: "POST",
      body: JSON.stringify({
        package: { scope: "acme", name: "widget" },
        discovery: { defaultBranch: "main", branches: [{ name: "main", sha: "first", committedAt: 100 }] },
      }),
    });
    const pending = await object.fetch(refresh());
    assert.deepEqual((await pending.json() as { meta: unknown }).meta, { scope: "acme", name: "widget", versions: {} });
    assert.equal((await object.fetch(new Request("https://package.invalid/complete", { method: "POST", body: JSON.stringify({ version: "0.1.100", state: "ready" }) }))).status, 200);
    const metadata = await object.fetch(new Request("https://package.invalid/metadata"));
    assert.deepEqual(await metadata.json(), { scope: "acme", name: "widget", versions: { "0.1.100": { yanked: false } } });
  });

  test("leases a pending job to the package Container without persisting its PAT", async () => {
    const storage = new Storage();
    const materializer = new Materializer();
    const object = new PackageDurableObject({ storage }, { MATERIALIZER: materializer });
    await object.fetch(new Request("https://package.invalid/refresh", {
      method: "POST",
      body: JSON.stringify({
        package: { scope: "acme", name: "widget" },
        discovery: { defaultBranch: "main", branches: [{ name: "main", sha: "first", committedAt: 100 }] },
      }),
    }));

    const response = await object.fetch(new Request("https://package.invalid/materialize", {
      method: "POST",
      body: JSON.stringify({ owner: "acme", repository: "widget", pat: "secret", statusUrl: "https://proxy.invalid/-/status/@acme/widget" }),
    }));
    assert.equal(response.status, 200);
    assert.equal(materializer.requests.length, 1);
    const body = await materializer.requests[0]!.json() as { githubPat: string; job: { version: string } };
    assert.equal(body.githubPat, "secret");
    assert.equal(body.job.version, "0.1.100");
    assert.equal(JSON.stringify([...storage.values.values()]).includes("secret"), false);
    assert.deepEqual((await response.json() as { meta: unknown }).meta, {
      scope: "acme",
      name: "widget",
      versions: { "0.1.100": { yanked: false } },
    });
  });
});
