import { classifyGitHubResponse, githubRequest } from "./auth.ts";
import { parseConfig } from "./config.ts";

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
    if (request.method !== "POST" || url.pathname !== "/authorize") return new Response("not found", { status: 404 });
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
}
