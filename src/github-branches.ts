import { githubRequest } from "./auth.ts";
import { type BranchDiscovery, type CommitTip } from "./branches.ts";

interface RepositoryResponse {
  default_branch?: unknown;
}

interface BranchResponse {
  name?: unknown;
  commit?: { sha?: unknown };
}

interface CommitResponse {
  commit?: { committer?: { date?: unknown } };
}

/** A GitHub response that distinguishes an absent repository from an outage. */
export class GitHubBranchDiscoveryError extends Error {
  readonly status: number;
  readonly retryAfterSeconds: number | undefined;

  constructor(response: Response) {
    const retryAfter = response.headers.get("retry-after");
    super(`GitHub branch discovery failed with ${response.status}${retryAfter ? ` (retry after ${retryAfter}s)` : ""}`);
    this.status = response.status;
    this.retryAfterSeconds = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) : undefined;
  }
}

/** Fetches the default and `vN` branch tips required for package versioning. */
export async function discoverGitHubBranches(
  owner: string,
  repository: string,
  pat: string,
  fetcher: typeof fetch = fetch,
): Promise<BranchDiscovery> {
  const root = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`;
  const repositoryResponse = await fetcher(githubRequest(root, pat));
  if (!repositoryResponse.ok) throw githubFailure(repositoryResponse);
  const metadata = await repositoryResponse.json() as RepositoryResponse;
  if (typeof metadata.default_branch !== "string" || metadata.default_branch.length === 0) {
    throw new Error("GitHub repository response has no default branch");
  }

  const branches = await listBranches(`${root}/branches?per_page=100`, pat, fetcher);
  const selected = branches.filter((branch) => branch.name === metadata.default_branch || /^v(?:0|[1-9][0-9]*)$/.test(branch.name));
  if (!selected.some((branch) => branch.name === metadata.default_branch)) {
    throw new Error(`GitHub did not return default branch ${metadata.default_branch}`);
  }
  const timestamps = new Map<string, Promise<number>>();
  for (const branch of selected) {
    if (timestamps.has(branch.sha)) continue;
    timestamps.set(branch.sha, (async () => {
      const response = await fetcher(githubRequest(`${root}/commits/${encodeURIComponent(branch.sha)}`, pat));
      if (!response.ok) throw githubFailure(response);
      const commit = await response.json() as CommitResponse;
      const date = commit.commit?.committer?.date;
      const committedAt = typeof date === "string" ? Date.parse(date) / 1_000 : Number.NaN;
      if (!Number.isSafeInteger(committedAt) || committedAt < 0) {
        throw new Error(`GitHub commit ${branch.sha} has an invalid committer timestamp`);
      }
      return committedAt;
    })());
  }
  const tips = new Map<string, CommitTip>();
  for (const branch of selected) {
    tips.set(branch.name, { sha: branch.sha, committedAt: await timestamps.get(branch.sha)! });
  }
  return { defaultBranch: metadata.default_branch, branches: tips };
}

async function listBranches(url: string, pat: string, fetcher: typeof fetch): Promise<Array<{ name: string; sha: string }>> {
  const branches: Array<{ name: string; sha: string }> = [];
  let next: string | undefined = url;
  while (next) {
    const response = await fetcher(githubRequest(next, pat));
    if (!response.ok) throw githubFailure(response);
    const page = await response.json() as BranchResponse[];
    if (!Array.isArray(page)) throw new Error("GitHub branches response was not an array");
    for (const branch of page) {
      if (typeof branch.name !== "string" || typeof branch.commit?.sha !== "string") {
        throw new Error("GitHub branch response was malformed");
      }
      branches.push({ name: branch.name, sha: branch.commit.sha });
    }
    next = linkTarget(response.headers.get("link"), "next");
  }
  return branches;
}

function linkTarget(link: string | null, relation: string): string | undefined {
  for (const part of link?.split(",") ?? []) {
    const match = /^\s*<([^>]+)>;\s*rel="([^"]+)"\s*$/.exec(part);
    if (match?.[2].split(" ").includes(relation)) return match[1];
  }
  return undefined;
}

function githubFailure(response: Response): GitHubBranchDiscoveryError {
  return new GitHubBranchDiscoveryError(response);
}
