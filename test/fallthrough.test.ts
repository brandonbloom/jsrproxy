import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { fallThrough } from "../src/index.ts";

describe("fallthrough", () => {
  test("strips the caller PAT and forces a non-document accept header", async () => {
    let forwarded: Request | undefined;
    const response = await fallThrough(
      new Request("http://proxy.invalid/@std/assert/meta.json", {
        headers: { authorization: "Bearer secret", "sec-fetch-dest": "document", accept: "text/html" },
      }),
      async (request) => {
        forwarded = request;
        return new Response("upstream", { headers: { "content-type": "application/json" } });
      },
    );
    assert.equal(forwarded?.url, "https://jsr.io/@std/assert/meta.json");
    assert.equal(forwarded?.headers.get("authorization"), null);
    assert.equal(forwarded?.headers.get("sec-fetch-dest"), null);
    assert.ok(!forwarded?.headers.get("accept")?.includes("text/html"));
    assert.equal(await response.text(), "upstream");
  });
});
