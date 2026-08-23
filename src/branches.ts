export interface CommitTip {
  sha: string;
  /** Git committer timestamp in whole Unix seconds. */
  committedAt: number;
}

export interface BranchDiscovery {
  defaultBranch: string;
  branches: ReadonlyMap<string, CommitTip>;
}

export interface BranchState {
  /** Highest release major ever seen, including deleted branches. */
  highestObservedReleaseMajor: number | undefined;
}

export interface SelectedBranch {
  branch: string;
  major: number;
  tip: CommitTip;
}

export interface BranchSelection {
  state: BranchState;
  branches: readonly SelectedBranch[];
}

/** Returns the major owned by an exactly named release branch. */
export function releaseMajor(branch: string): number | undefined {
  const match = /^v(0|[1-9][0-9]*)$/.exec(branch);
  if (!match) {
    return undefined;
  }
  const major = Number(match[1]);
  return Number.isSafeInteger(major) ? major : undefined;
}

/**
 * Selects only the default and vN branches, retaining the historic major
 * high-water mark when a release branch is later deleted.
 */
export function selectBranches(discovery: BranchDiscovery, prior: BranchState): BranchSelection {
  const releases: SelectedBranch[] = [];
  let observed = prior.highestObservedReleaseMajor;

  for (const [branch, tip] of discovery.branches) {
    const major = releaseMajor(branch);
    if (major === undefined) {
      continue;
    }
    releases.push({ branch, major, tip });
    observed = observed === undefined ? major : Math.max(observed, major);
  }

  const defaultTip = discovery.branches.get(discovery.defaultBranch);
  if (!defaultTip) {
    throw new Error(`default branch ${discovery.defaultBranch} was not returned by GitHub`);
  }
  const defaultMajor = observed === undefined ? 0 : observed + 1;
  const sameCommitRelease = releases
    .filter((release) => release.tip.sha === defaultTip.sha)
    .sort((left, right) => right.major - left.major)[0];

  return {
    state: { highestObservedReleaseMajor: observed },
    branches: sameCommitRelease ? releases : [...releases, { branch: discovery.defaultBranch, major: defaultMajor, tip: defaultTip }],
  };
}
