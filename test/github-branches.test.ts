import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { discoverGitHubBranches } from "../src/github-branches.ts";

describe("GitHub branch discovery", () => {
  test("follows branch pagination and returns only the default and release branches", async () => {
    const requests: string[] = [];
    const fetcher: typeof fetch = async (request) => {
      requests.push(request.url);
      assert.equal(request.headers.get("authorization"), "Bearer secret");
      if (request.url.endsWith("/repos/acme/widget")) return Response.json({ default_branch: "main" });
      if (request.url.includes("branches?per_page=100")) {
        return Response.json(
          [{ name: "main", commit: { sha: "main-sha" } }, { name: "topic", commit: { sha: "topic-sha" } }],
          { headers: { link: '<https://api.github.com/repos/acme/widget/branches?page=2>; rel="next"' } },
        );
      }
      if (request.url.endsWith("branches?page=2")) return Response.json([{ name: "v2", commit: { sha: "main-sha" } }]);
      if (request.url.endsWith("commits/main-sha")) return Response.json({ commit: { committer: { date: "2024-01-01T00:00:00Z" } } });
      throw new Error(`unexpected request: ${request.url}`);
    };

    const discovery = await discoverGitHubBranches("acme", "widget", "secret", fetcher);
    assert.deepEqual(discovery, {
      defaultBranch: "main",
      branches: new Map([
        ["main", { sha: "main-sha", committedAt: 1_704_067_200 }],
        ["v2", { sha: "main-sha", committedAt: 1_704_067_200 }],
      ]),
    });
    assert.equal(requests.some((url) => url.endsWith("commits/topic-sha")), false);
    assert.equal(requests.filter((url) => url.endsWith("commits/main-sha")).length, 1);
  });
});
