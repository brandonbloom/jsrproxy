import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parsePackageIdentity, proxyableRepositoryName } from "../src/identity.ts";

describe("repository-name identity mapping", () => {
  test("case-folds valid GitHub repository names", () => {
    assert.equal(proxyableRepositoryName("MyLib"), "mylib");
    assert.equal(proxyableRepositoryName("foo-bar"), "foo-bar");
  });

  test("rejects names outside JSR's proxyable identity tier", () => {
    assert.equal(proxyableRepositoryName("a"), undefined);
    assert.equal(proxyableRepositoryName("-widget"), undefined);
    assert.equal(proxyableRepositoryName("foo--bar"), undefined);
    assert.equal(proxyableRepositoryName("three.js"), undefined);
    assert.equal(proxyableRepositoryName("a".repeat(59)), undefined);
    assert.equal(proxyableRepositoryName("a".repeat(58)), "a".repeat(58));
  });

  test("identifies a package path", () => {
    assert.deepEqual(parsePackageIdentity("/@brandonbloom/foo-bar/meta.json"), {
      scope: "brandonbloom",
      name: "foo-bar",
    });
    assert.equal(parsePackageIdentity("/@brandonbloom/foo--bar/meta.json"), undefined);
    assert.equal(parsePackageIdentity("/-/status/@brandonbloom/foo"), undefined);
  });
});
