import { classifyGitHubResponse, githubRequest } from "./auth.ts";
import { type BranchDiscovery } from "./branches.ts";
import { parseConfig } from "./config.ts";
import { type PackageName, PackageRegistry, type PackageRegistrySnapshot, type TombstoneDiagnostic } from "./package-registry.ts";

interface DurableStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
}

interface DurableState {
  storage: DurableStorage;
}

interface AdmissionEnvironment {
  JSRPROXY_CONFIG?: string;
}

interface MaterializerNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
}

interface PackageEnvironment {
  MATERIALIZER?: MaterializerNamespace;
}

interface AdmissionRecord {
  granted: boolean;
  expiresAt: number;
}

/**
 * Shared, secret-free GitHub-user admission cache for one PAT fingerprint.
 * The raw PAT exists only in the request body while GitHub is contacted.
 */
export class AdmissionDurableObject {
  private readonly state: DurableState;
  private readonly env: AdmissionEnvironment;

  constructor(state: DurableState, env: AdmissionEnvironment) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/check") {
      return new Response("not found", { status: 404 });
    }
    const body = await request.json().catch(() => undefined) as { pat?: unknown } | undefined;
    if (typeof body?.pat !== "string" || body.pat.length === 0) {
      return new Response("invalid admission request", { status: 400 });
    }

    const cached = await this.state.storage.get<AdmissionRecord>("admission");
    if (cached && cached.expiresAt > Date.now()) return Response.json(cached);

    const github = await fetch(githubRequest("https://api.github.com/user", body.pat));
    const result = classifyGitHubResponse(github);
    if (result.kind === "unavailable") {
      return Response.json(result, {
        status: 503,
        headers: result.retryAfterSeconds ? { "retry-after": String(Math.ceil(result.retryAfterSeconds)) } : undefined,
      });
    }

    let granted = false;
    if (result.decision.granted) {
      const user = await github.json().catch(() => undefined) as { login?: unknown } | undefined;
      const trusted = parseConfig(this.env.JSRPROXY_CONFIG).trustedGitHubUsers;
      granted = typeof user?.login === "string" && trusted.includes(user.login);
    }
    const record = { granted, expiresAt: result.decision.expiresAt };
    await this.state.storage.put("admission", record);
    return Response.json(record);
  }
}

export class PackageDurableObject {
  private readonly state: DurableState;
  private readonly env: PackageEnvironment;

  constructor(state: DurableState, env: PackageEnvironment = {}) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/authorize") return this.#authorize(request);
    if (request.method === "POST" && url.pathname === "/refresh") return this.#refresh(request);
    if (request.method === "POST" && url.pathname === "/materialize") return this.#materialize(request);
    if (request.method === "POST" && url.pathname === "/complete") return this.#complete(request);
    if (request.method === "GET" && url.pathname === "/metadata") return this.#metadata();
    if (request.method === "GET" && url.pathname === "/status") return this.#status();
    return new Response("not found", { status: 404 });
  }

  async #authorize(request: Request): Promise<Response> {
    const body = await request.json().catch(() => undefined) as {
      fingerprint?: unknown; owner?: unknown; repository?: unknown; pat?: unknown;
    } | undefined;
    if (!body || typeof body.fingerprint !== "string" || typeof body.owner !== "string" || typeof body.repository !== "string" || typeof body.pat !== "string") {
      return new Response("invalid authorization request", { status: 400 });
    }
    const key = `repository:${body.fingerprint}`;
    const cached = await this.state.storage.get<AdmissionRecord>(key);
    if (cached && cached.expiresAt > Date.now()) return Response.json(cached);

    const github = await fetch(githubRequest(`https://api.github.com/repos/${encodeURIComponent(body.owner)}/${encodeURIComponent(body.repository)}`, body.pat));
    const result = classifyGitHubResponse(github);
    if (result.kind === "unavailable") {
      return Response.json(result, { status: 503, headers: result.retryAfterSeconds ? { "retry-after": String(Math.ceil(result.retryAfterSeconds)) } : undefined });
    }
    let decision = result.decision;
    if (decision.granted) {
      const repository = await github.json().catch(() => undefined) as { name?: unknown } | undefined;
      if (typeof repository?.name !== "string" || repository.name.toLowerCase() !== body.repository) {
        decision = { ...decision, granted: false };
      }
    }
    await this.state.storage.put(key, decision);
    return Response.json(decision);
  }

  async #refresh(request: Request): Promise<Response> {
    const body = await request.json().catch(() => undefined) as { package?: unknown; discovery?: unknown } | undefined;
    const name = parsePackageName(body?.package);
    const discovery = parseDiscovery(body?.discovery);
    if (!name || !discovery) return new Response("invalid package refresh", { status: 400 });
    const registry = await this.#registry(name);
    const created = registry.refresh(discovery);
    await this.state.storage.put("registry", registry.snapshot());
    return Response.json({ meta: registry.meta(), jobs: registry.jobs(), created });
  }

  async #complete(request: Request): Promise<Response> {
    const body = await request.json().catch(() => undefined) as {
      version?: unknown; state?: unknown; diagnostic?: unknown;
    } | undefined;
    if (typeof body?.version !== "string" || (body.state !== "ready" && body.state !== "yanked")) {
      return new Response("invalid completion", { status: 400 });
    }
    const registry = await this.#registry();
    try {
      if (body.state === "ready") registry.markReady(body.version);
      else {
        const diagnostic = parseDiagnostic(body.diagnostic);
        if (!diagnostic) return new Response("invalid tombstone diagnostic", { status: 400 });
        registry.markYanked(body.version, diagnostic);
      }
    } catch (error) {
      return new Response(error instanceof Error ? error.message : "invalid completion", { status: 409 });
    }
    await this.state.storage.put("registry", registry.snapshot());
    return Response.json(registry.meta());
  }

  async #materialize(request: Request): Promise<Response> {
    const body = await request.json().catch(() => undefined) as {
      owner?: unknown; repository?: unknown; pat?: unknown; statusUrl?: unknown;
    } | undefined;
    if (
      typeof body?.owner !== "string" || body.owner.length === 0 ||
      typeof body.repository !== "string" || body.repository.length === 0 ||
      typeof body.pat !== "string" || body.pat.length === 0 ||
      typeof body.statusUrl !== "string" || body.statusUrl.length === 0
    ) {
      return new Response("invalid materialization request", { status: 400 });
    }
    if (!this.env.MATERIALIZER) return new Response("materializer is not configured", { status: 503 });

    const registry = await this.#registry();
    const job = registry.leaseNext();
    if (!job) return Response.json({ meta: registry.meta(), jobs: registry.jobs() });
    await this.state.storage.put("registry", registry.snapshot());

    let response: Response;
    try {
      const archive = await githubArchive(body.owner, body.repository, job.commitSha, body.pat);
      if (!archive) return this.#releaseLease(job.version);
      const container = this.env.MATERIALIZER.get(
        this.env.MATERIALIZER.idFromName(`@${registry.name.scope}/${registry.name.name}`),
      );
      response = await container.fetch(new Request("https://materializer.internal/materialize-archive", {
        method: "POST",
        headers: {
          "content-type": "application/gzip",
          "x-jsrproxy-materialization": JSON.stringify({
          job: {
            package: registry.name,
            branch: job.branch,
            commitSha: job.commitSha,
            version: job.version,
          },
          source: { owner: body.owner, repository: body.repository },
          statusUrl: body.statusUrl,
        }),
        },
        body: archive.body,
        duplex: "half",
      } as RequestInit & { duplex: "half" }));
    } catch (error) {
      console.warn("materializer request failed", error instanceof Error ? error.message : "unknown error");
      return this.#releaseLease(job.version);
    }
    if (!response.ok) {
      const detail = await response.text();
      const reason = detail === "source archive unavailable" || detail.startsWith("artifact publication unavailable:")
        ? detail
        : "unknown error";
      console.warn("materializer returned an error", response.status, reason);
      return this.#releaseLease(job.version);
    }

    const outcome = parseMaterializationOutcome(await response.json().catch(() => undefined));
    if (!outcome) return this.#releaseLease(job.version);
    const completed = await this.#registry();
    try {
      if (outcome.state === "ready") completed.markReady(job.version);
      else completed.markYanked(job.version, outcome.diagnostic);
    } catch {
      return new Response("materialization completion conflicted", { status: 409 });
    }
    await this.state.storage.put("registry", completed.snapshot());
    return Response.json({ meta: completed.meta(), jobs: completed.jobs() });
  }

  async #releaseLease(version: string): Promise<Response> {
    const registry = await this.#registry();
    try {
      registry.releaseLease(version);
    } catch {
      return new Response("materialization lease conflicted", { status: 409 });
    }
    await this.state.storage.put("registry", registry.snapshot());
    return new Response("materialization unavailable", { status: 503, headers: { "retry-after": "1" } });
  }

  async #metadata(): Promise<Response> {
    const registry = await this.#registry();
    return Response.json(registry.meta());
  }

  async #status(): Promise<Response> {
    const registry = await this.#registry();
    return Response.json({ meta: registry.meta(), jobs: registry.jobs() });
  }

  async #registry(initialName?: PackageName): Promise<PackageRegistry> {
    const snapshot = await this.state.storage.get<PackageRegistrySnapshot>("registry");
    if (snapshot) {
      const registry = PackageRegistry.fromSnapshot(snapshot);
      if (initialName && (registry.name.scope !== initialName.scope || registry.name.name !== initialName.name)) {
        throw new Error("package identity does not match Durable Object state");
      }
      return registry;
    }
    if (!initialName) throw new Error("package state has not been initialized");
    return new PackageRegistry(initialName);
  }
}

async function githubArchive(owner: string, repository: string, commitSha: string, pat: string): Promise<Response | undefined> {
  const archive = await fetch(
    githubRequest(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/tarball/${encodeURIComponent(commitSha)}`, pat),
    { redirect: "manual" },
  );
  if (archive.ok && archive.body && new URL(archive.url).hostname === "codeload.github.com") return archive;
  if (!archive.status.toString().startsWith("30")) return undefined;
  const location = archive.headers.get("location");
  if (!location) return undefined;
  let redirect: URL;
  try {
    redirect = new URL(location);
  } catch {
    return undefined;
  }
  if (redirect.protocol !== "https:" || redirect.hostname !== "codeload.github.com") return undefined;
  const source = await fetch(redirect, { redirect: "manual" });
  return source.ok && source.body ? source : undefined;
}

function parsePackageName(value: unknown): PackageName | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { scope, name } = value as { scope?: unknown; name?: unknown };
  if (typeof scope !== "string" || typeof name !== "string") return undefined;
  return { scope, name };
}

function parseDiscovery(value: unknown): BranchDiscovery | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { defaultBranch, branches } = value as { defaultBranch?: unknown; branches?: unknown };
  if (typeof defaultBranch !== "string" || !Array.isArray(branches)) return undefined;
  const tips = new Map<string, { sha: string; committedAt: number }>();
  for (const branch of branches) {
    if (!branch || typeof branch !== "object") return undefined;
    const { name, sha, committedAt } = branch as { name?: unknown; sha?: unknown; committedAt?: unknown };
    if (typeof name !== "string" || typeof sha !== "string" || typeof committedAt !== "number" || !Number.isSafeInteger(committedAt) || committedAt < 0 || tips.has(name)) {
      return undefined;
    }
    tips.set(name, { sha, committedAt });
  }
  return { defaultBranch, branches: tips };
}

function parseDiagnostic(value: unknown): TombstoneDiagnostic | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { id, failureClass, message } = value as { id?: unknown; failureClass?: unknown; message?: unknown };
  return typeof id === "string" && typeof failureClass === "string" && typeof message === "string"
    ? { id, failureClass, message }
    : undefined;
}

function parseMaterializationOutcome(value: unknown):
  | { state: "ready" }
  | { state: "yanked"; diagnostic: TombstoneDiagnostic }
  | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { state, diagnostic } = value as { state?: unknown; diagnostic?: unknown };
  if (state === "ready") return { state };
  const parsedDiagnostic = parseDiagnostic(diagnostic);
  return state === "yanked" && parsedDiagnostic ? { state, diagnostic: parsedDiagnostic } : undefined;
}
