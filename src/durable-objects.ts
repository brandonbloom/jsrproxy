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

  constructor(state: DurableState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/authorize") return this.#authorize(request);
    if (request.method === "POST" && url.pathname === "/refresh") return this.#refresh(request);
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
    await this.state.storage.put(key, result.decision);
    return Response.json(result.decision);
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
