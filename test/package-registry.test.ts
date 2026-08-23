import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { PackageRegistry } from "../src/package-registry.ts";

const discovery = (sha: string, committedAt: number) => ({
  defaultBranch: "main",
  branches: new Map([["main", { sha, committedAt }]]),
});

describe("package registry state", () => {
  test("hides pending versions until their artifact marker is committed", () => {
    const registry = new PackageRegistry({ scope: "acme", name: "widget" });
    const [job] = registry.refresh(discovery("first", 100));
    assert.equal(job?.version, "0.1.100");
    assert.deepEqual(registry.meta(), { scope: "acme", name: "widget", versions: {} });

    registry.markReady("0.1.100");
    assert.deepEqual(registry.meta(), {
      scope: "acme",
      name: "widget",
      versions: { "0.1.100": { yanked: false } },
    });
  });

  test("keeps the latest ready artifact available while a new tip is pending", () => {
    const registry = new PackageRegistry({ scope: "acme", name: "widget" });
    registry.refresh(discovery("first", 100));
    registry.markReady("0.1.100");
    const [job] = registry.refresh(discovery("second", 101));
    assert.equal(job?.version, "0.1.101");
    assert.deepEqual(registry.meta().versions, { "0.1.100": { yanked: false } });
  });

  test("advertises a deterministic source failure only as a yanked tombstone", () => {
    const registry = new PackageRegistry({ scope: "acme", name: "widget" });
    registry.refresh(discovery("broken", 100));
    registry.markYanked("0.1.100", {
      id: "mat-4gdh9",
      failureClass: "missing-exports",
      message: "the root configuration has no exports field",
    });
    assert.deepEqual(registry.meta().versions, { "0.1.100": { yanked: true } });
    assert.deepEqual(registry.jobs()[0]?.diagnostic, {
      id: "mat-4gdh9",
      failureClass: "missing-exports",
      message: "the root configuration has no exports field",
    });
  });

  test("preserves branch and allocation state across Durable Object storage", () => {
    const registry = new PackageRegistry({ scope: "acme", name: "widget" });
    registry.refresh(discovery("first", 100));
    registry.markReady("0.1.100");
    const restored = PackageRegistry.fromSnapshot(registry.snapshot());

    const [job] = restored.refresh(discovery("second", 99));
    assert.equal(job?.version, "0.1.101");
    assert.deepEqual(restored.meta().versions, { "0.1.100": { yanked: false } });
  });

  test("refuses to mutate immutable published outcomes", () => {
    const registry = new PackageRegistry({ scope: "acme", name: "widget" });
    registry.refresh(discovery("first", 100));
    registry.markReady("0.1.100");
    assert.throws(() => registry.markYanked("0.1.100", { id: "x", failureClass: "x", message: "x" }));
  });

  test("releases failed work and recovers an expired lease", () => {
    const registry = new PackageRegistry({ scope: "acme", name: "widget" });
    registry.refresh(discovery("first", 100));
    const job = registry.leaseNext(1_000);
    assert.equal(job?.state, "leased");
    assert.equal(job?.leasedAt, 1_000);
    assert.equal(registry.leaseNext(1_001), undefined);
    registry.releaseLease("0.1.100");
    assert.equal(registry.jobs()[0]?.state, "pending");
    assert.equal(registry.jobs()[0]?.leasedAt, undefined);

    registry.leaseNext(2_000);
    const recovered = registry.leaseNext(122_000);
    assert.equal(recovered?.state, "leased");
    assert.equal(recovered?.leasedAt, 122_000);
  });
});
