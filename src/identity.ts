/**
 * Returns the JSR identity for a proxyable GitHub repository name.
 *
 * GitHub treats repository names case-insensitively, so the validated identity
 * is lowercase. Double hyphens are reserved for a future escaped-name tier.
 */
export function proxyableRepositoryName(repository: string): string | undefined {
  const name = repository.toLowerCase();
  return /^[a-z0-9][a-z0-9-]{1,57}$/.test(name) && !name.includes("--")
    ? name
    : undefined;
}

/** Parses the two segments that identify a synthetic JSR package. */
export function parsePackageIdentity(pathname: string): { scope: string; name: string } | undefined {
  const match = /^\/@([a-z0-9][a-z0-9-]*)\/([a-z0-9-]+)(?:\/|$)/.exec(pathname);
  if (!match) {
    return undefined;
  }
  const name = proxyableRepositoryName(match[2]);
  return name ? { scope: match[1], name } : undefined;
}

/** Parses the authenticated diagnostic route for a synthetic package. */
export function parsePackageStatusPath(pathname: string): { identity: { scope: string; name: string }; version?: string } | undefined {
  const match = /^\/-\/status\/@([a-z0-9][a-z0-9-]*)\/([a-z0-9-]+)(?:\/([0-9]+\.[0-9]+\.[0-9]+))?$/.exec(pathname);
  if (!match) return undefined;
  const name = proxyableRepositoryName(match[2]);
  if (!name) return undefined;
  return { identity: { scope: match[1], name }, version: match[3] };
}

/** Parses the deployment-operator recovery route for one published version. */
export function parsePackageRecoveryPath(pathname: string): { identity: { scope: string; name: string }; version: string } | undefined {
  const match = /^\/-\/recover\/@([a-z0-9][a-z0-9-]*)\/([a-z0-9-]+)\/([0-9]+\.[0-9]+\.[0-9]+)$/.exec(pathname);
  if (!match) return undefined;
  const name = proxyableRepositoryName(match[2]);
  if (!name) return undefined;
  return { identity: { scope: match[1], name }, version: match[3] };
}
