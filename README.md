# jsrproxy

`jsrproxy` is an experimental JSR read-through proxy. It preserves ordinary
[`jsr.io`](https://jsr.io) reads while allowing selected JSR scopes to be
synthesized from GitHub repositories. A caller supplies a GitHub personal
access token (PAT); the Worker verifies the caller and repository access,
discovers the repository's default and `vN` branches, and is intended to
materialize JSR-compatible artifacts into Cloudflare R2.

The design is documented in [DESIGN.md](DESIGN.md). The deployment components
are a Cloudflare Worker, Durable Objects, R2, and a Rust materializer packaged
as a Cloudflare Container.

## Why it exists

[JSR does not provide a private-repository workflow](https://github.com/jsr-io/jsr/issues/203).
Publishing packages is an additional step that every project's CI must
reproduce before consumers can use a revision. `jsrproxy` lets selected GitHub
repositories be consumed directly, following the same general model as Go's
module ecosystem.

The goal is to retain JSR's TypeScript-first package experience: type-aware
packages and zero-configuration ESM consumption, without falling back to the
extra package-management configuration commonly needed for npm.

## Status

This project is experimental. It is only expected to work for Brandon Bloom's
personal use at this point: the checked-in staging configuration trusts only
the `brandonbloom` GitHub account and maps only the `@brandonbloom` and
`@crudetc` scopes. It is not a multi-user service configuration.

Authorization, branch discovery, registry persistence, R2 serving, and
Container job dispatch are implemented. The materializer accepts a root
`deno.json` or `jsr.json` with exports and rewrites its direct quoted import-map
aliases to relative, `jsr:`, or `npm:` specifiers. Other deterministic source
errors produce a yanked tombstone; infrastructure failures remain pending.
Full `deno publish`-compatible graph walking and specifier rewriting are still
out of scope. Reads outside configured synthetic scopes fall through to
`jsr.io`.

## Security model

For a configured scope, `jsrproxy` verifies the caller's GitHub PAT and uses
it only in the Worker to read the mapped repository's pinned source archive.
Durable state retains only a non-reversible fingerprint. The Container receives
the archive and credential-free job context with network access disabled; the
Package Durable Object verifies the materializer's hashes and writes immutable
artifacts to private R2. The PAT is not stored in Durable Objects, R2, the
Cache API, Container input, or logs.

The proxy still handles the PAT on every configured-scope request, so its
operator and deployment must be trusted with callers' repository access. This
is suitable for a personal or tightly administered deployment, not a public
service for the commons or an untrusted multi-user registry.

## Development

Prerequisites: Node.js, Deno, Rust, Docker-compatible container tooling, and a
Cloudflare account with Workers, Durable Objects, R2, and Containers enabled.

```sh
npm install
npm test
npm run check
cargo test --workspace
```

The test suite uses no live Cloudflare or GitHub credentials.

## Operating notes

- Configure `AUTH_FINGERPRINT_SECRET` with `npx wrangler secret put
  AUTH_FINGERPRINT_SECRET`. Do not commit it.
- Treat `JSRPROXY_CONFIG` as deployment-owned configuration. It controls the
  trusted GitHub users and synthetic scope-to-owner mappings; update it before
  making the service available to anyone else.
- Deploy staging with `npx wrangler deploy --env staging`. The Worker requires
  the R2 buckets and Container entitlement described in
  [DEPLOYMENT.md](DEPLOYMENT.md).
- A client accesses a configured scope by setting `JSR_URL` to the proxy and
  `DENO_AUTH_TOKENS=<github-pat>@<proxy-host>`. Use an expiring fine-grained
  PAT with read-only access to the required GitHub repositories. Never put a
  PAT in a URL, repository file, or log.
- Requests for configured scopes require the PAT to authenticate as a trusted
  GitHub user and authorize access to the mapped repository. Other JSR reads
  do not forward caller credentials to `jsr.io`.
- `?recover=true` on a package metadata request starts replacement attempts for
  published outcomes after a confirmed proxy repair. It is an experimental
  operator control in this personal deployment; it preserves old immutable
  artifacts and allocates fresh versions.

See [DEPLOYMENT.md](DEPLOYMENT.md) for the deployment checklist and
[DESIGN.md](DESIGN.md) for the registry and security model.
