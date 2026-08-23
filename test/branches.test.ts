import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { releaseMajor, selectBranches } from "../src/branches.ts";

const tip = (sha: string, committedAt = 1_700_000_000) => ({ sha, committedAt });

describe("branch selection", () => {
  test("recognizes only exact vN release branches", () => {
    assert.equal(releaseMajor("v0"), 0);
    assert.equal(releaseMajor("v12"), 12);
    assert.equal(releaseMajor("v01"), undefined);
    assert.equal(releaseMajor("release/v1"), undefined);
  });

  test("assigns default branch to major zero before a release branch", () => {
    const result = selectBranches({ defaultBranch: "main", branches: new Map([["main", tip("a")]]) }, {});
    assert.deepEqual(result.branches, [{ branch: "main", major: 0, tip: tip("a") }]);
  });

  test("retains the release high-water mark and suppresses a duplicate default tip", () => {
    const result = selectBranches(
      { defaultBranch: "main", branches: new Map([["main", tip("same")], ["v2", tip("same")], ["junk", tip("x")]]) },
      { highestObservedReleaseMajor: 1 },
    );
    assert.deepEqual(result.state, { highestObservedReleaseMajor: 2 });
    assert.deepEqual(result.branches, [{ branch: "v2", major: 2, tip: tip("same") }]);

    const afterDeletion = selectBranches(
      { defaultBranch: "main", branches: new Map([["main", tip("next")]]) },
      result.state,
    );
    assert.equal(afterDeletion.branches[0]?.major, 3);
  });
});
