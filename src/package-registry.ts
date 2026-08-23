import { type BranchDiscovery, type BranchState, selectBranches } from "./branches.ts";
import { type VersionAssignment, VersionAllocator } from "./version-allocator.ts";

export interface PackageName {
  scope: string;
  name: string;
}

export interface MaterializationJob {
  branch: string;
  commitSha: string;
  major: number;
  version: string;
  state: "pending" | "leased" | "ready" | "yanked";
  diagnostic?: TombstoneDiagnostic;
}

export interface TombstoneDiagnostic {
  id: string;
  failureClass: string;
  message: string;
}

interface VersionRecord extends MaterializationJob {
  assignment: VersionAssignment;
}

/** A JSR package `meta.json` document. */
export interface PackageMeta {
  scope: string;
  name: string;
  versions: Record<string, { yanked: boolean }>;
}

/**
 * Storage-independent state machine for one synthetic package.
 *
 * The Package Durable Object persists these records in SQLite and calls these
 * transitions inside transactions. Keeping the rules independent from the
 * Cloudflare API makes their publication behavior directly testable.
 */
export class PackageRegistry {
  readonly #allocator = new VersionAllocator();
  readonly #versions = new Map<string, VersionRecord>();
  readonly name: PackageName;
  #branches: BranchState = {};

  constructor(name: PackageName) {
    this.name = name;
  }

  /** Observes branch tips and creates materialization jobs for new assignments. */
  refresh(discovery: BranchDiscovery): readonly MaterializationJob[] {
    const selection = selectBranches(discovery, this.#branches);
    this.#branches = selection.state;
    const created: MaterializationJob[] = [];
    for (const branch of selection.branches) {
      const assignment = this.#allocator.allocate(branch.major, branch.tip.sha, branch.tip.committedAt);
      const existing = this.#versions.get(assignment.version);
      if (existing) continue;
      const record: VersionRecord = {
        assignment,
        branch: branch.branch,
        commitSha: branch.tip.sha,
        major: branch.major,
        version: assignment.version,
        state: "pending",
      };
      this.#versions.set(record.version, record);
      created.push(copyJob(record));
    }
    return created;
  }

  /** Marks a complete artifact set ready after its R2 ready marker exists. */
  markReady(version: string): void {
    const record = this.#requirePending(version);
    record.state = "ready";
  }

  /** Publishes an irreversible yanked tombstone for a deterministic source failure. */
  markYanked(version: string, diagnostic: TombstoneDiagnostic): void {
    const record = this.#requirePending(version);
    record.state = "yanked";
    record.diagnostic = { ...diagnostic };
  }

  /** Returns only concrete versions that are safe for a client to resolve. */
  meta(): PackageMeta {
    const versions: Record<string, { yanked: boolean }> = {};
    for (const record of this.#versions.values()) {
      if (record.state === "ready" || record.state === "yanked") {
        versions[record.version] = { yanked: record.state === "yanked" };
      }
    }
    return { scope: this.name.scope, name: this.name.name, versions };
  }

  /** Snapshot used by the authenticated package-status route. */
  jobs(): readonly MaterializationJob[] {
    return [...this.#versions.values()].map(copyJob);
  }

  #requirePending(version: string): VersionRecord {
    const record = this.#versions.get(version);
    if (!record) throw new Error(`unknown version: ${version}`);
    if (record.state !== "pending" && record.state !== "leased") {
      throw new Error(`version ${version} cannot transition from ${record.state}`);
    }
    return record;
  }
}

function copyJob(record: VersionRecord): MaterializationJob {
  return {
    branch: record.branch,
    commitSha: record.commitSha,
    major: record.major,
    version: record.version,
    state: record.state,
    diagnostic: record.diagnostic && { ...record.diagnostic },
  };
}
