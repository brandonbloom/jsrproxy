export interface VersionAssignment {
  major: number;
  sequence: number;
  attempt: number;
  commitSha: string;
  version: string;
}

interface MajorAllocations {
  highWater: number;
  assignments: Map<string, VersionAssignment>;
  currentAttempts: Map<string, number>;
}

/**
 * Storage-independent reference implementation of the allocator contract.
 * A Durable Object persists these same rows in a SQLite transaction.
 */
export class VersionAllocator {
  readonly #majors = new Map<number, MajorAllocations>();

  allocate(major: number, commitSha: string, committedAt: number): VersionAssignment {
    validateInputs(major, commitSha, committedAt);
    const allocations = this.#forMajor(major);
    const attempt = allocations.currentAttempts.get(commitSha);
    if (attempt !== undefined) {
      return allocations.assignments.get(key(commitSha, attempt))!;
    }
    return this.#append(allocations, major, commitSha, committedAt, 0);
  }

  /** Allocates a replacement only for an administrator-approved tombstone recovery. */
  recover(major: number, commitSha: string, committedAt: number): VersionAssignment {
    validateInputs(major, commitSha, committedAt);
    const allocations = this.#forMajor(major);
    const current = allocations.currentAttempts.get(commitSha);
    if (current === undefined) {
      throw new Error("cannot recover a commit without an existing assignment");
    }
    return this.#append(allocations, major, commitSha, committedAt, current + 1);
  }

  #forMajor(major: number): MajorAllocations {
    let allocations = this.#majors.get(major);
    if (!allocations) {
      allocations = { highWater: -1, assignments: new Map(), currentAttempts: new Map() };
      this.#majors.set(major, allocations);
    }
    return allocations;
  }

  #append(
    allocations: MajorAllocations,
    major: number,
    commitSha: string,
    committedAt: number,
    attempt: number,
  ): VersionAssignment {
    const sequence = Math.max(committedAt, allocations.highWater + 1);
    const assignment = { major, sequence, attempt, commitSha, version: `${major}.1.${sequence}` };
    allocations.highWater = sequence;
    allocations.assignments.set(key(commitSha, attempt), assignment);
    allocations.currentAttempts.set(commitSha, attempt);
    return assignment;
  }
}

function key(commitSha: string, attempt: number): string {
  return `${commitSha}\u0000${attempt}`;
}

function validateInputs(major: number, commitSha: string, committedAt: number): void {
  if (!Number.isSafeInteger(major) || major < 0) throw new Error("major must be a non-negative safe integer");
  if (commitSha.length === 0) throw new Error("commit SHA must not be empty");
  if (!Number.isSafeInteger(committedAt) || committedAt < 0) {
    throw new Error("commit timestamp must be a non-negative whole Unix second");
  }
}
