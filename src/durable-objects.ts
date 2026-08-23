/**
 * Durable Object entry points. Their persistent schema and GitHub/R2 adapters
 * are added with the authenticated materialization path; keeping the classes
 * present now makes the Wrangler migration explicit and stable.
 */
export class AdmissionDurableObject {
  async fetch(): Promise<Response> {
    return new Response("admission service is not configured", { status: 503 });
  }
}

export class PackageDurableObject {
  async fetch(): Promise<Response> {
    return new Response("package service is not configured", { status: 503 });
  }
}
