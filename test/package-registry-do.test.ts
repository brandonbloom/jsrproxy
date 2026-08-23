import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, test } from "node:test";
import { PackageDurableObject } from "../src/durable-objects.ts";

const digest = (body: string) => createHash("sha256").update(body).digest("hex");

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
        return Response.json({ state: "ready", uploads: [{
          key: "synthetic/acme/widget/0.1.100/mod.ts",
          sha256: digest("export const widget = true;\n"),
          body: btoa("export const widget = true;\n"),
        }, {
          key: "synthetic/acme/widget/0.1.100.ready.json",
          sha256: digest('{"manifest_sha256":"example"}'),
          body: btoa('{"manifest_sha256":"example"}'),
        }] });
      },
    };
  }
}

class Bucket {
  objects = new Map<string, { customMetadata: Record<string, string> }>();
  async head(key: string) { return this.objects.get(key) ?? null; }
  async put(key: string, _value: ArrayBuffer, options: { customMetadata: Record<string, string> }) {
    if (this.objects.has(key)) return null;
    const object = { customMetadata: options.customMetadata };
    this.objects.set(key, object);
    return object;
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
    const status = await object.fetch(new Request("https://package.invalid/status"));
    assert.deepEqual(await status.json(), {
      meta: { scope: "acme", name: "widget", versions: { "0.1.100": { yanked: false } } },
      jobs: [{ branch: "main", commitSha: "first", major: 0, version: "0.1.100", state: "ready" }],
      recoveries: [],
    });
  });

  test("leases a pending job to the package Container without persisting its PAT", async () => {
    const storage = new Storage();
    const materializer = new Materializer();
    const object = new PackageDurableObject({ storage }, { MATERIALIZER: materializer, ARTIFACTS: new Bucket() });
    await object.fetch(new Request("https://package.invalid/refresh", {
      method: "POST",
      body: JSON.stringify({
        package: { scope: "acme", name: "widget" },
        discovery: { defaultBranch: "main", branches: [{ name: "main", sha: "first", committedAt: 100 }] },
      }),
    }));

    const originalFetch = globalThis.fetch;
    let requests = 0;
    globalThis.fetch = async () => {
      requests++;
      if (requests === 1) return new Response(null, { status: 302, headers: { location: "https://codeload.github.com/acme/widget/tar.gz/first" } });
      return new Response(new Uint8Array([1]), { status: 200 });
    };
    let response: Response;
    try {
      response = await object.fetch(new Request("https://package.invalid/materialize", {
        method: "POST",
        body: JSON.stringify({ owner: "acme", repository: "widget", pat: "secret", statusUrl: "https://proxy.invalid/-/status/@acme/widget" }),
      }));
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.equal(response.status, 200);
    assert.equal(materializer.requests.length, 1);
    assert.equal(materializer.requests[0]!.url, "https://materializer.internal/materialize-archive");
    const context = JSON.parse(materializer.requests[0]!.headers.get("x-jsrproxy-materialization") ?? "{}") as { job: { version: string } };
    assert.equal(context.job.version, "0.1.100");
    assert.equal(materializer.requests[0]!.headers.get("x-jsrproxy-materialization")?.includes("secret"), false);
    assert.equal(JSON.stringify([...storage.values.values()]).includes("secret"), false);
    assert.deepEqual((await response.json() as { meta: unknown }).meta, {
      scope: "acme",
      name: "widget",
      versions: { "0.1.100": { yanked: false } },
    });
  });
});
