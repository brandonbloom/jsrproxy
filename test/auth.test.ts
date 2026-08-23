import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { classifyGitHubResponse, fingerprintPat, githubPat, githubRequest } from "../src/auth.ts";

describe("GitHub PAT handling", () => {
  test("extracts only a bearer PAT and produces a deterministic secret fingerprint", async () => {
    assert.equal(githubPat(new Request("https://proxy.invalid", { headers: { authorization: "Bearer pat" } })), "pat");
    assert.equal(githubPat(new Request("https://proxy.invalid", { headers: { authorization: "Basic abc" } })), undefined);
    const first = await fingerprintPat("worker-secret", "pat");
    assert.equal(first, await fingerprintPat("worker-secret", "pat"));
    assert.notEqual(first, await fingerprintPat("worker-secret", "other"));
    assert.match(first, /^[A-Za-z0-9_-]+$/);
  });

  test("treats credential denials as cacheable decisions and outages as retryable", () => {
    assert.deepEqual(classifyGitHubResponse(new Response(null, { status: 401 }), 1_000), {
      kind: "decision",
      decision: { granted: false, expiresAt: 61_000 },
    });
    assert.deepEqual(classifyGitHubResponse(new Response(null, { status: 429, headers: { "retry-after": "12" } })), {
      kind: "unavailable",
      retryAfterSeconds: 12,
    });
  });

  test("uses the GitHub REST media type and caller PAT", () => {
    const request = githubRequest("https://api.github.com/user", "pat");
    assert.equal(request.headers.get("authorization"), "Bearer pat");
    assert.equal(request.headers.get("accept"), "application/vnd.github+json");
  });
});
