/** Configuration for one synthetic JSR scope. */
export interface GitHubScope {
  type: "github";
  owner: string;
}

export interface ProxyConfig {
  scopes: ReadonlyMap<string, GitHubScope>;
  trustedGitHubUsers: readonly string[];
}

interface RawConfig {
  scopes?: Record<string, { type?: unknown; owner?: unknown }>;
  trusted_github_users?: unknown;
}

/** Parses the JSON configuration provided to the Worker by its deployment. */
export function parseConfig(value: string | undefined): ProxyConfig {
  if (!value) {
    return { scopes: new Map(), trustedGitHubUsers: [] };
  }

  let raw: RawConfig;
  try {
    raw = JSON.parse(value) as RawConfig;
  } catch {
    throw new Error("JSRPROXY_CONFIG must contain valid JSON");
  }

  const scopes = new Map<string, GitHubScope>();
  for (const [scope, entry] of Object.entries(raw.scopes ?? {})) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(scope)) {
      throw new Error(`invalid configured scope: ${scope}`);
    }
    if (entry.type !== "github") {
      throw new Error(`scope @${scope} must have type github`);
    }
    const owner = entry.owner ?? scope;
    if (typeof owner !== "string" || owner.length === 0) {
      throw new Error(`scope @${scope} has an invalid GitHub owner`);
    }
    scopes.set(scope, { type: "github", owner });
  }

  if (
    raw.trusted_github_users !== undefined &&
    (!Array.isArray(raw.trusted_github_users) ||
      raw.trusted_github_users.some((user) => typeof user !== "string" || user.length === 0))
  ) {
    throw new Error("trusted_github_users must be an array of non-empty strings");
  }

  return {
    scopes,
    trustedGitHubUsers: (raw.trusted_github_users ?? []) as string[],
  };
}
