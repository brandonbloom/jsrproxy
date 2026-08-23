import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { VersionAllocator } from "../src/version-allocator.ts";

describe("version allocation", () => {
  test("uses commit time unless the per-major high-water mark is later", () => {
    const allocator = new VersionAllocator();
    assert.equal(allocator.allocate(1, "first", 100).version, "1.1.100");
    assert.equal(allocator.allocate(1, "second", 100).version, "1.1.101");
    assert.equal(allocator.allocate(1, "third", 99).version, "1.1.102");
    assert.equal(allocator.allocate(2, "other-major", 1).version, "2.1.1");
  });

  test("reuses an ordinary assignment and allocates a new recovery attempt", () => {
    const allocator = new VersionAllocator();
    const first = allocator.allocate(0, "sha", 10);
    assert.deepEqual(allocator.allocate(0, "sha", 999), first);
    const recovered = allocator.recover(0, "sha", 1);
    assert.deepEqual(recovered, { major: 0, sequence: 11, version: "0.1.11", attempt: 1, commitSha: "sha" });
    assert.deepEqual(allocator.allocate(0, "sha", 1), recovered);
  });
});
