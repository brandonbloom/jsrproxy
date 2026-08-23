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
