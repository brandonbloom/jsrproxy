import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { decodeRepositoryName, encodeRepositoryName, parsePackageIdentity } from "../src/identity.ts";

describe("repository-name encoding", () => {
  test("is reversible and canonical", () => {
    assert.equal(encodeRepositoryName("foo-bar"), "foo--bar");
    assert.equal(encodeRepositoryName("my_repo.v2"), "my-x5frepo-x2ev2");
    assert.equal(encodeRepositoryName("MiXeD"), "mixed");
    assert.equal(decodeRepositoryName("my-x5frepo-x2ev2"), "my_repo.v2");
    assert.equal(decodeRepositoryName("caf-xc3-xa9"), "café");
  });

  test("rejects ambiguous and malformed encodings", () => {
    assert.throws(() => decodeRepositoryName("foo-bar"), /malformed escape/);
    assert.throws(() => decodeRepositoryName("foo-x5Fbar"), /invalid character/);
    assert.throws(() => decodeRepositoryName("-xc3"), /invalid UTF-8/);
  });

  test("identifies a package path", () => {
    assert.deepEqual(parsePackageIdentity("/@brandonbloom/foo--bar/meta.json"), {
      scope: "brandonbloom",
      name: "foo--bar",
    });
    assert.equal(parsePackageIdentity("/-/status/@brandonbloom/foo"), undefined);
  });
});
