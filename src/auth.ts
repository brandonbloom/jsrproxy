/** The only credential form accepted for configured GitHub-backed scopes. */
export function githubPat(request: Request): string | undefined {
  const match = /^Bearer ([^\s]+)$/.exec(request.headers.get("authorization") ?? "");
  return match?.[1];
}

/** A stable secret-free identifier for a caller credential. */
export async function fingerprintPat(secret: string, pat: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret) as unknown as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(pat) as unknown as BufferSource),
  );
  return base64Url(signature);
}

export interface GitHubDecision {
  granted: boolean;
  expiresAt: number;
}

export type GitHubResult =
  | { kind: "decision"; decision: GitHubDecision }
  | { kind: "unavailable"; retryAfterSeconds?: number };

/** Classifies an authenticated GitHub REST response without persisting its PAT. */
export function classifyGitHubResponse(response: Response, now = Date.now()): GitHubResult {
  if (response.status === 401 || response.status === 404) {
    return { kind: "decision", decision: { granted: false, expiresAt: now + 60_000 } };
  }
  if (!response.ok || response.status === 403 || response.status === 429) {
    return { kind: "unavailable", retryAfterSeconds: retryAfter(response, now) };
  }
  return { kind: "decision", decision: { granted: true, expiresAt: now + 60_000 } };
}

/** Sends the minimally scoped authenticated request used by admission and repository gates. */
export function githubRequest(url: string, pat: string): Request {
  return new Request(url, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${pat}`,
      "x-github-api-version": "2022-11-28",
    },
  });
}

function retryAfter(response: Response, now: number): number | undefined {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter && /^\d+$/.test(retryAfter)) return Number(retryAfter);
  const reset = response.headers.get("x-ratelimit-reset");
  if (reset && /^\d+$/.test(reset)) return Math.max(1, Number(reset) * 1_000 - now + 1_000) / 1_000;
  return undefined;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
