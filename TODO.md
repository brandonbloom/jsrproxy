# Spec-completion backlog

This is the remaining work required to make the implementation conform to
[`DESIGN.md`](DESIGN.md). Completed vertical-slice behavior is not repeated
here: authenticated `jsr:` resolution, GitHub archive fetching, credential-free
materialization, immutable R2 publication, JSR manifest checksums, and basic
root import-map rewriting are implemented.

## P0 — Correctness and security boundaries

- [x] Expose authenticated `/-/status/@<scope>/<name>` and version-specific
  status routes with safe job and diagnostic data.
- [x] Replace `?recover=true` with a separately authenticated operator control
  scoped to one package/version, requiring a reason and producing a durable
  audit record. Ordinary package consumers cannot trigger recovery.
- [ ] Make package-state updates explicit Durable Object SQLite transactions and
  persist the source provenance, manifest identity, retry state, and recovery
  audit records specified in the design.
- [ ] Stream archive input and materializer output with bounded resource use;
  remove the in-memory base64 artifact batch protocol before supporting larger
  repositories.
- [ ] Impose and test archive, per-file, total-output, path-normalization, and
  case-collision limits equivalent to the accepted JSR publishing subset.

## P0 — Publish-compatible materialization

- [ ] Implement package-file selection: `include`, `exclude`, `.gitignore`,
  root-config handling, and rejection of unsupported workspace-member
  resolution.
- [ ] Replace textual import substitution with syntax-aware graph walking that
  covers static imports/exports, dynamic imports, import attributes, type-only
  references, and `@deno-types` directives.
- [ ] Resolve import-map and package-manifest aliases exactly as Deno publishing
  does; emit only valid relative, `jsr:`, `npm:`, `data:`, `bun:`, and `node:`
  specifiers and reject unsupported external imports.
- [ ] Generate JSR-compatible module-graph metadata where useful, and use
  upstream JSR/Deno modules with recorded provenance whenever their dependency
  boundaries fit this project.

## P1 — Authentication, caching, and failures

- [ ] Add bounded Worker-isolate admission and repository-decision LRUs that
  reuse, but never extend, Durable Object expiry.
- [ ] Persist GitHub rate-limit state and apply `Retry-After` / reset behavior
  consistently to discovery, authorization, and source retrieval.
- [ ] Distinguish deterministic source errors from operational failures across
  every materialization stage; only the former may issue tombstones.
- [ ] Verify synthetic and fallthrough cache behavior under authorization
  expiry, revocation, R2 outage, GitHub outage, and checksum disagreement.

## P1 — Contract and integration coverage

- [ ] Add Deno registry contract fixtures for metadata, media types,
  `If-None-Match`, `If-Modified-Since`, unversioned/caret selection, exact
  yanked downloads, and `deno outdated --update`.
- [ ] Split the Worker request handler from Cloudflare Container exports so
  Node-level route tests can exercise it without the Workers runtime package.
- [ ] Add staging tests for Container cold starts, abandoned leases, concurrent
  branch observations, partial publication, recovery, and PAT revocation.
- [ ] Exercise normal packages beyond `crude-spec`, including multi-export,
  ignored-file, malformed-source, and workspace cases.

## P2 — Operations and documentation

- [ ] Add structured, secret-safe observability for materialization outcomes,
  latency, queue/lease age, retries, and R2 integrity conflicts.
- [ ] Add deployment/runbook guidance for rollbacks, recovery auditing,
  Container capacity, token rotation, and staging-to-production promotion.
- [ ] Reconcile every section of `DESIGN.md` with the implementation as each
  item lands; remove statements that describe planned rather than shipped
  behavior.
- [ ] Add automated dependency/provenance review for copied JSR/Deno units and
  keep `materializer/UPSTREAM.md` current.

## Explicit non-goals

- Active failure notifications, the JSR management API, npm compatibility,
  publisher-side CI mutation, arbitrary branch addressing, and workspace-member
  resolution remain out of scope as stated in `DESIGN.md`.
