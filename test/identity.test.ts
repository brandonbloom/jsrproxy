import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parsePackageIdentity, parsePackageRecoveryPath, parsePackageStatusPath, proxyableRepositoryName } from "../src/identity.ts";

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

  test("identifies package status routes", () => {
    assert.deepEqual(parsePackageStatusPath("/-/status/@acme/widget"), {
      identity: { scope: "acme", name: "widget" },
      version: undefined,
    });
    assert.deepEqual(parsePackageStatusPath("/-/status/@acme/widget/1.2.3"), {
      identity: { scope: "acme", name: "widget" },
      version: "1.2.3",
    });
    assert.equal(parsePackageStatusPath("/-/status/@acme/widget/not-a-version"), undefined);
  });

  test("identifies package recovery routes", () => {
    assert.deepEqual(parsePackageRecoveryPath("/-/recover/@acme/widget/1.2.3"), {
      identity: { scope: "acme", name: "widget" },
      version: "1.2.3",
    });
    assert.equal(parsePackageRecoveryPath("/-/recover/@acme/widget"), undefined);
  });
});
