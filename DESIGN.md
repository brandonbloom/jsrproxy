# JSR Read-Through Proxy — Design Spec

**Working name:** `jsrproxy`

A read-through proxy implementing the JSR registry read API. It synthesizes JSR
packages on demand from a GitHub repository's default branch and `vN` release
branches, requiring no publish step, and transparently forwards all other
traffic to `jsr.io`. Inspired by `proxy.golang.org`.

---

## 1. Goals

- Import TypeScript from a GitHub repository using a `jsr:` specifier. The
  default branch is the bleeding-edge version; `vN` branches are maintained
  major release lines. No tags, releases, or registry account are required.
- Derive ordinary SemVer versions that float under a caret range, including for
  major zero. Within a major, `deno outdated --update` pulls newly observed
  commits without a range edit; adopting a new major still requires one.
- Apply the [StableVer](https://github.com/brandonbloom/StableVer) compatibility
  contract to the branches exposed by the proxy.
- Keep `deno.json` ergonomics: bare specifiers, semver, `deno.lock` integrity,
  and deduplication.
- Support private repositories using the caller's GitHub PAT. This is a
  requirement, not an extension.
- Preserve `jsr.io` reads byte-for-byte outside scopes explicitly configured as
  GitHub-backed.
- Deploy as one Cloudflare Worker project containing a thin edge/control plane,
  a native Rust materializer image, and Cloudflare-managed storage.

## 2. Non-goals

- The JSR management API (`api.jsr.io`). No `deno publish` target.
- The npm compatibility registry (`npm.jsr.io`). Deno consumers only.
- Doc generation, JSR score, JSR build provenance, or slow-types checking.
- Arbitrary branch addressing. Only the default branch and `vN` branches are
  visible.
- Anonymous access to configured GitHub scopes. Trusted callers supply a PAT;
  anonymous jsr.io fallthrough remains available.
- Publisher-side CI or any mutation of the source repository. Publication stays
  implicit when a consumer first observes a new branch tip, and the proxy uses
  GitHub read-only.
- Deno workspace-member resolution. One repository is one synthetic root
  package; use package export subpaths and ordinary directories for multiple
  public entry points.
- Active materialization-failure notification. Yanked tombstones and the
  authenticated proxy status endpoint provide pull-based diagnostics.
- **Tag-derived versions.** See §6.4.
- **Commit pinning.** See §6.5. Pinning is what `deno.lock` is for.

## 3. Constraints

Four facts drive everything below.

**Import maps do not apply to remote modules.** A library served over plain
HTTPS cannot carry its own `deno.json`, so its internal bare specifiers dangle.
This is why raw Git URLs are unusable for real libraries and why the registry
protocol is worth implementing at all.

**`deno publish` solves that by rewriting source.** It rewrites specifiers in
source files to fully-qualified `jsr:`/`npm:` specifiers needing no import map,
and restricts external imports to `jsr:`, `npm:`, `data:`, `bun:`, and `node:`.
Any proxy synthesizing a package from a Git tree must do the same rewrite before
hashing, because the bytes hashed must be the bytes served.

**`JSR_URL` is global.** There is no per-scope registry syntax for `jsr:`
specifiers. Pointing Deno at the proxy routes _all_ `jsr:` traffic there,
including `@std/*`. Fallthrough is mandatory.

**Version resolution is client-side.** Deno fetches `meta.json`, matches the
range locally, then requests a concrete version. The server never sees the
range. Everything in §6 follows from this.

## 4. Architecture

```
deno ──JSR_URL──> Worker + bounded isolate auth cache ──> jsr.io (fallthrough)
                    │
                    ├──> Cache API ──> R2 (immutable bytes)
                    ├──> Admission Durable Object (per PAT fingerprint)
                    └──> Package Durable Object (per package)
                           ├── SQLite (branches, versions, jobs, repo auth)
                           ├──> GitHub (Worker fetches with caller's PAT)
                           ├──> Cloudflare Container (credential-free archive)
                           │      └── native Rust materializer
                           └──> R2 (verified immutable artifacts)
```

The production deployment uses four Cloudflare primitives:

- A [Worker](https://developers.cloudflare.com/workers/) terminates requests,
  validates names and credentials, handles jsr.io fallthrough, and streams
  cached or R2-backed responses. Each warm isolate also keeps bounded in-memory
  admission and repository-authorization caches for the hot path.
- Two SQLite-backed
  [Durable Object](https://developers.cloudflare.com/durable-objects/) classes
  coordinate mutable state. One admission object per PAT fingerprint caches the
  package-independent trusted-user check; one package object per GitHub package
  serializes repository-authorization results, branch refreshes, version
  allocation, and materialization jobs.
- [R2](https://developers.cloudflare.com/r2/) stores immutable synthesized
  artifacts and the evictable jsr.io cache. It is not publicly exposed; all
  reads pass through the Worker.
- A [Cloudflare Container](https://developers.cloudflare.com/containers/)
  attached to each active package object runs the native Rust binary on demand.
  Container instances sleep when idle. This avoids forcing the adapted Deno and
  JSR Rust modules into the Workers `wasm32` runtime.

Production therefore requires the Workers Paid plan; Cloudflare Containers are
not available on the Free plan.

The Worker and Durable Object are a small TypeScript control plane. Registry
semantics and materialization remain in Rust where practical. The Worker uses
the caller's GitHub PAT to fetch a pinned source archive, then sends the
archive and credential-free job context to a network-disabled Container. The
Container returns hashes and artifact bytes; the Package Durable Object verifies
them and writes to its private R2 binding. The PAT is never written to Durable
Object storage, R2, the Cache API, Container input, or logs.

Start with the `basic` Container instance type and benchmark representative
packages before lowering or raising it. Configure an explicit `max_instances`
budget. If that budget or container startup is temporarily exhausted, the
Durable Object retains the pending job and the Worker returns `503` with
`Retry-After`; no incomplete version is published.

Immutable responses may be stored in the Cache API, but the Worker still runs
first. Every synthetic request must pass the caller's cached GitHub
authorization check before a cached body is returned. Response-body Cache API
keys never contain the PAT. Authorization-decision cache keys contain only the
HMAC fingerprint described in §9.2.

Configuration assigns selected JSR scopes to GitHub owners:

```yaml
scopes:
  brandonbloom:
    type: github
    owner: brandonbloom # Optional; defaults to the scope name.

trusted_github_users:
  - brandonbloom
```

The `type` discriminator permits other backends without introducing parallel
configuration maps. For `type: github`, `owner` defaults to the scope name; an
explicit value supports a scope whose name differs from its GitHub owner.
`trusted_github_users` contains GitHub logins, not tokens; GitHub authenticates
the PAT before the proxy applies this admission allowlist.

Every package in a configured GitHub scope resolves only against its mapped
GitHub owner. A missing repository or a PAT without access returns `404`; it
never falls through to `jsr.io`. GitHub intentionally makes those cases
indistinguishable, and treating the scope as a total takeover prevents one
package identity from resolving differently for different callers.

Everything outside a configured GitHub scope falls through directly. Repository
authorization results are cached with short TTLs.

## 5. Namespace

```
@<scope>/<repository>  -> <configured-owner>/<repository>
```

For the configuration above:

```
jsr:@brandonbloom/whatever  -> github.com/brandonbloom/whatever
```

One repository is one package rooted at the repository root. A string
`exports` value defines its default entry point; an `exports` object defines
additional public subpaths without creating more package identities:

```json
{
  "exports": {
    ".": "./mod.ts",
    "./foo": "./packages/foo/mod.ts",
    "./bar": "./packages/bar/mod.ts"
  }
}
```

Consumers import those entries as `jsr:@brandonbloom/whatever`,
`jsr:@brandonbloom/whatever/foo`, and
`jsr:@brandonbloom/whatever/bar`. They share one version and one StableVer
contract. Repositories exposed through the proxy should use ordinary
subdirectories, not Deno workspaces. Although Deno permits a root package and
workspace members to coexist, workspace resolution depends on member configs
and identities that the one-repository-one-package model deliberately does not
reproduce. A root `workspace` declaration is ignored, and the proxy rejects any
module graph edge that resolves only through a workspace member.

If a repository retains a workspace declaration for development tooling, code
exposed by the root package may reference files beneath member directories only
through relative specifiers or specifiers explicitly mapped by the root
`imports` map. A bare specifier matching a workspace member's `name` is not
resolved and produces a deterministic materialization failure and permanent
yanked tombstone. Member-local config and import maps are likewise ignored.
Workspaces are therefore disrecommended even when the exposed root package
appears self-contained: local development can otherwise succeed under
resolution behavior absent from the materialized package.

There is no branch component in the package name. The default branch and every
`vN` branch contribute different majors to the same package's version list.

GitHub repository names are case-insensitive, so the package identity is the
repository name lowercased without escaping. A repository is proxyable only
when that name matches `^[a-z0-9][a-z0-9-]*$`, is 2–58 characters long, and has
no `--` sequence. Thus `MyLib` is served as `mylib`, while `three.js`,
`my_lib`, one-character names, and names longer than 58 characters are not
proxyable. The length limit keeps every synthetic identity publishable to
jsr.io.

The reserved `--` sequence keeps a future escaped-name tier unambiguous. If
support for otherwise invalid repository names becomes necessary, it can use a
marked escaped form such as `x--` without reinterpreting a live pass-through
identity.

## 6. Branches and Versions

### 6.1 Branch selection

The proxy recognizes only:

- the repository's default branch; and
- branches named exactly `vN`, where `N` is a non-negative decimal major with no
  leading zeros other than `v0`.

A `vN` branch owns major `N`. The default branch owns:

```
0                                if no vN branch has ever been observed
highest observed release major + 1 otherwise
```

The highest observed release major is persistent metadata. Deleting a release
branch does not make the default branch's major move backward.

Observing a new highest `vN` advances the default branch to major `N + 1`. If
the two branches point to the same commit, the commit is advertised only under
major `N`, reusing an existing assignment for that major if one exists. The
proxy does not also advertise it under major `N + 1`; the first divergent
default-branch commit begins the new major.

Branches that do not match `vN` are invisible to the registry.

### 6.2 Version allocation

Every major uses the same version shape:

```
<major>.1.<sequence>

e.g. 0.1.1787425200
     1.1.1787425200
```

For a newly observed commit:

```
candidate = commit committer timestamp as Unix seconds
sequence  = max(candidate, previous_sequence + 1)
```

One allocator record per `(package, major)` contains the highest allocated
sequence, immutable assignment rows keyed by `(commit sha, attempt)`, and a
current-assignment pointer for each commit. Ordinary allocation creates attempt
zero and subsequently reuses the current assignment. The package's Durable
Object updates these records in a SQLite transaction.

The same commit in the same major returns the same version unless the proxy
administrator invokes the narrowly scoped tombstone-recovery operation in
§8.1. Every allocation for a package reaches the same Durable Object, so
concurrent requests cannot assign one sequence to different commits.

The timestamp makes versions useful to humans in the ordinary case. The
high-water mark handles commits with equal or backward timestamps, rebases,
force-pushes, and clock skew. There is no collision field and no sleep: waiting
does not change a commit timestamp, and substituting materialization time would
make the version depend on which worker saw the commit first.

The fixed minor `1` is a transport convention, not a StableVer feature release.
The patch sequence orders proxy snapshots. It gives both `^0.1.x` and `^1.1.x`
the desired behavior: later commits within a major continue to match.

### 6.3 StableVer contract

Repositories exposed through `jsrproxy` are expected to follow StableVer:

- Major zero is the alpha release. Its features are alpha unless explicitly
  declared otherwise.
- From major one onward, documented features are stable unless marked otherwise,
  and undocumented functionality is internal.
- A breaking change to a stable feature requires that the feature was declared
  deprecated in the preceding major, with warning and a migration plan.

The proxy enforces branch and version mechanics; maintainers enforce the
stability labels, documentation, deprecation, and migration obligations.

When `vN` is the highest release branch, the default branch is major `N + 1`
under construction. A stable feature may be removed there only if `vN` already
declared it deprecated. The default branch is where the next major is assembled,
not a compatibility free-for-all. Before any release branch exists, it is the
major-zero alpha line and follows StableVer's alpha rules.

Unstable or exploratory work belongs on other branches, which the proxy does not
expose. The duration of a deprecation remains a human-scale project decision;
the proxy imposes no mechanical minimum.

This resembles Go's semantic import versioning in its use of separate major
lines, but the major remains in the SemVer range rather than the import path.

### 6.4 Why not tags

Tags and branch snapshots do not compose usefully in one version list. A tag
`v1.2.3` and a synthetic `1.1.<sequence>` compete under the same `^1` range;
whichever sorts higher wins for reasons unrelated to the branch's role.

The `vN` branch is the durable release line. Tags may exist in GitHub for other
purposes but do not affect registry metadata.

### 6.5 Why not commit pinning

`meta.json` must enumerate every version a client may resolve to, and matching
is client-side. Commits do not enumerate, and the proxy cannot know which commit
a client wants before serving `meta.json`.

Go escapes this by separating enumeration from resolution: `@v/list` carries
only tagged versions, while `@v/<revision>.info` is an independent endpoint that
accepts a branch, tag, or SHA and answers with the canonical version. JSR has no
equivalent endpoint, so the mechanism does not port.

Encoding the SHA in the name is rejected: the name is the package identity,
materialization bakes fully-qualified specifiers into downstream source, and a
SHA-pinned dependency therefore makes every upgrade a rename. SemVer ranges
cannot span it, `deno outdated` cannot see it, lockfile diffs read as add plus
remove, and nothing deduplicates.

Pinning is `deno.lock`'s job. It pins exactly, is already in the repository, and
does not corrupt package identity.

### 6.6 Immutability and history rewrites

`<version>_meta.json` and module files are immutable. First materialization of a
given `(name, version)` wins permanently.

A force-push does not remove issued versions or change their bytes. When the new
tip is first observed, the high-water rule gives it a version greater than every
earlier version in that major, even if its commit timestamp moved backward. It
therefore becomes the range-selected tip while locked older versions remain
resolvable.

## 7. Endpoints

### 7.1 Package metadata

```
GET /@<scope>/<name>/meta.json
```

Mutable, short TTL (60s). Contains `scope`, `name`, and the version map with
`yanked` status. Deno computes version selection from that map; the proxy does
not need to emit a separate `latest` field.

For a GitHub-backed name, the package's Durable Object discovers the default
branch and `vN` branches, assigns provisional versions to changed tips, and
creates durable materialization jobs. A provisional version is not returned to
Deno until its R2 objects exist and the Durable Object marks it ready.

A cold package request waits for the discovered jobs to produce source
artifacts or yanked tombstones, or to remain retryable. If only tombstones exist,
ordinary range resolution finds no version. A warm request may return its last
ready metadata while newly discovered tips are materialized, allowing existing
installs to proceed; the next metadata refresh includes the completed versions.
Entries are never removed. Deno's effective latest version is the highest ready,
non-yanked version. Deterministic source failures appear in the version map as
yanked tombstones but do not affect semver selection. The version index records
the branch name and commit SHA so retries need no branch lookup.

This creates an intentional one-poll lag on the warm path: the first
`deno outdated --update` after a push may trigger materialization while seeing
the previous ready version, and a later poll sees the new version after the job
completes.

An unversioned request normally selects the ready default-branch tip. Immediately
after cutting `vN`, while the default branch still points to the same commit,
the major-`N` version remains the highest selectable version until the default
branch diverges. An unversioned `deno add` selects it and writes a caret range
for that major; the range stays on that major until the consumer edits it.
`deno.lock` pins the exact selected version, so receiving later commits is
always a pull operation.

Version growth is bounded by branch tips observed during metadata refreshes, not
by every commit in Git history.

### 7.2 Version metadata

```
GET /@<scope>/<name>/<version>_meta.json
```

Immutable. Contains `manifest` (path -> `{size, checksum}`), `exports`, and
optionally `moduleGraph1`/`moduleGraph2`.

Checksums are `sha256-` followed by **hex**, not base64, computed over the bytes
as served — post-rewrite. Hash the exact buffer written to the store; a mismatch
here breaks every consumer at once.

`moduleGraph1`/`moduleGraph2` are optional prefetch optimizations. Deno 2.9.5
successfully resolves and executes a package when both are absent.

Also record proxy provenance here (source repository, branch name, full commit
SHA, and materialization time) under a non-conflicting key. A yanked failure
tombstone additionally records a stable diagnostic ID, failure class, and safe
diagnostic text.

### 7.3 Module files

```
GET /@<scope>/<name>/<version>/<path>
```

Immutable, indefinitely cacheable, must honor `If-None-Match` and
`If-Modified-Since` with `304`.

`Content-Type` must match the file's module media type, including TypeScript,
JavaScript, JSON, and Wasm where supported. Deno 2.9.5 uses a recognized
response media type in preference to the `.ts` URL path: a `.ts` module served
as `application/javascript` reaches V8 without type stripping and fails. Do not
let a mime-db-derived default apply — it maps `.ts` to `video/mp2t`.

### 7.4 Fallthrough

Requests outside configured GitHub scopes proxy to `https://jsr.io`.

- Forward bodies **byte-identical**; consumers hold lockfile hashes generated
  against jsr.io directly.
- Always send an `Accept` excluding `text/html` and never
  `Sec-Fetch-Dest: document`, or jsr.io returns a rendered HTML page.
- Cache immutable artifacts locally; honor upstream TTL on `meta.json`.
- Verify proxied file bytes against the upstream `<version>_meta.json` checksums
  before caching. This converts silent corruption into a loud failure.

### 7.5 Proxy status

```
GET /-/status/@<scope>/<name>
GET /-/status/@<scope>/<name>/<version>
```

Authenticated with the same caller PAT and repository-authorization gate as
synthetic artifacts. Returns branch observations, materialization job state,
ready versions, yanked tombstones, and safe failure diagnostics. The generated
failure module links to its version-specific status URL. This endpoint makes
the durable state inspectable but is not an active notification channel.

## 8. Materialization

Triggered when a package metadata refresh observes an unmaterialized branch tip.
The job is durable and idempotent; a version is advertised only after the job
produces either the source artifact or an immutable yanked failure tombstone.

1. The package Durable Object decodes the configured scope and repository name,
   refreshes the relevant branches, and allocates a version in one SQLite
   transaction.
2. In the same transaction, insert a pending job containing the branch name,
   commit SHA, major, and version. Do not expose the version in `meta.json`.
3. Fetch the Git tree tarball at the recorded SHA with the caller's PAT.
4. Start the package's Container and submit the archive plus credential-free
   job context to the Rust process.
5. Apply `include`/`exclude` and `.gitignore` semantics as `deno publish` does.
6. Read the repository-root `deno.json` / `jsr.json` for `exports`, `imports`,
   and optional source `name` and `version`. Honor both string and object forms
   of `exports`. **A package with no root config file or no `exports` is
   refused.** The proxy does not guess a package's public entrypoints. It ignores
   workspace configuration and refuses imports that require workspace-member
   resolution.
7. Rewrite the emitted config's `name` and `version` fields to the synthetic
   package identity and allocated version, so the shipped config agrees with the
   registry.
8. **Rewrite specifiers.** Walk the module graph, resolve each bare specifier
   through the package's own import map, and emit fully-qualified sources.
   Reject external imports that are not `jsr:`, `npm:`, `data:`, `bun:`, or
   `node:`.
9. Hash each output with SHA-256 in hexadecimal.
10. Return files and `<version>_meta.json` with SHA-256 digests to the Package
    Durable Object, which verifies and writes them to R2 using create-if-absent
    writes.
11. After every object has been verified, write an immutable R2 ready marker
    containing the manifest hash. The Worker refuses every concrete-version path
    whose marker is absent.
12. Report the completed manifest and marker to the Durable Object. In one
    transaction, verify the job identity and mark the version ready.

The Durable Object records job state and a lease before starting compute. Its
alarm returns an abandoned lease to `pending`; the next authorized request
resubmits the job with that caller's PAT. A retry writes the same R2 keys and
bytes. Partial R2 output is unreachable because package metadata contains only
ready versions and the Worker requires the ready marker for direct
concrete-version requests. Container-local disk is scratch space and is never
authoritative.

An error caused deterministically by the repository contents, such as a missing
root config, missing exports, an unsupported external import, or an import that
requires workspace-member resolution, is published as a yanked tombstone at the
already allocated version. The tombstone is a valid, immutable package
containing:

- a generated `deno.json` with the synthetic name, allocated version, and a
  default export; when the source export map is available, every original
  export key points to the same generated failure module;
- a generated module that throws a materialization-failure error containing a
  stable diagnostic ID and status URL; and
- version metadata and a ready marker produced through the same integrity path
  as a successful artifact.

The package's `meta.json` includes that version with `yanked: true`. Deno's
effective latest selection remains the highest ready, non-yanked version. Semver
resolution therefore keeps consumers on the last good artifact, while an exact
request remains downloadable and fails loudly rather than silently importing an
empty module. The failure diagnostic is durable and visible in registry
metadata.

Infrastructure failures, GitHub or R2 outages, Container capacity exhaustion,
materializer crashes, and suspected proxy bugs do not create tombstones. They
remain pending or retryable because publishing a tombstone is irreversible: the
same `(package, version)` can never later be replaced with source bytes. A
source-failure tombstone likewise remains issued if the branch is force-pushed;
the next observed commit receives a new version.

Step 8 is the whole job. Enumerating and hashing is straightforward. The
`--dry-run` mode of `deno publish` cannot be used as the materializer interface:
Deno 2.9.5 constructs the rewritten tarball in memory but exposes only the
source file list. There is no flag that writes the tarball or rewritten files.

### 8.1 Administrative recovery from a proxy bug

Here, **proxy administrator** means a principal with administrative control of
the `jsrproxy` deployment. It does not mean a trusted GitHub user, repository
owner, PAT holder, package consumer, or caller of the public registry and status
endpoints. Caller credentials never authorize this operation.

If a confirmed defect in the proxy or its adapted upstream code incorrectly
published a tombstone for valid repository contents, the proxy administrator may
authorize one fresh materialization attempt for the same `(package, major,
commit SHA)`. This is not a general rebuild facility and is not used to repair
invalid source.

The operation appends a new assignment with the next attempt number, allocates a
fresh sequence above the major's high-water mark, advances the commit's current
assignment pointer, and creates a new pending job. The original version and
tombstone bytes remain immutable and yanked. If recovery succeeds, the new
non-yanked version becomes selectable normally.

The experimental personal deployment exposes recovery as `?recover=true` on an
otherwise authorized package-metadata request. It is not appropriate for a
multi-user deployment: production use needs a separate deployment-administrator
control with an audit record. Recovery neither supplies a GitHub credential nor
bypasses repository authorization; the next authorized package request provides
the PAT that runs the pending replacement job.

### 8.2 Upstream-derived Rust implementation

Build a new Rust project and copy the narrow upstream modules needed from:

- Deno's publish implementation: publish-path collection,
  `ModuleContentProvider`, and `SpecifierUnfurler`;
- JSR's server implementation: tarball processing, manifest generation,
  content-type handling, and related storage behavior.

Adapt those modules behind local interfaces rather than forking either complete
application. Package the result as a Linux `amd64` image exposing a small
job-oriented HTTP interface to its owning Durable Object. Preserve applicable
copyright and license notices. Add an `UPSTREAM.md` ledger for every copied unit
recording the source repository, exact path, base commit, license, local
modifications, and update procedure. Keep contract fixtures against Deno and JSR
behavior so upstream changes can be reviewed and ported deliberately.

## 9. Authentication

One caller-supplied credential handles both proxy admission and GitHub access.

### 9.1 Caller-supplied GitHub PAT

The JSR **read** API defines no authentication, so the caller supplies a GitHub
personal access token through Deno's registry-auth mechanism:

```
JSR_URL=https://proxy.example.com/
DENO_AUTH_TOKENS=<github-pat>@proxy.example.com
```

Deno 2.9.5 applies `DENO_AUTH_TOKENS` to JSR registry fetches and sends
`Authorization: Bearer <github-pat>`. The Worker interprets that bearer value as
a GitHub PAT for configured GitHub scopes. Include the port in the token target
for a non-default port.

Use a
[fine-grained PAT](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)
restricted to the required owner and repositories, with read-only **Contents**
and **Metadata** permissions and an expiration. Classic PATs are accepted but
discouraged because their `repo` scope is much broader.

This moves credential lifecycle work from one service identity to every
consumer. Each developer and CI environment must hold and rotate its PAT, and
an expired token presents as a `401` during dependency resolution. The cost is
accepted in exchange for keeping a reusable GitHub credential out of persistent
proxy storage.

Deno supplies one bearer token for the registry host, while a fine-grained PAT
targets one GitHub resource owner. A deployment should therefore map its scopes
to one owner under normal operation; multiple scope aliases may map to that same
owner. Accessing unrelated owners requires separate proxy hostnames or a classic
PAT with the necessary access.

There is no secret-path fallback. A GitHub PAT must not appear in a URL or
access log. A request without a PAT may use jsr.io fallthrough but receives
`401` for a configured GitHub scope.

### 9.2 Admission and repository authorization

The PAT replaces both a separate proxy token and the proxy's GitHub credential:

1. Derive `fingerprint = HMAC-SHA-256(worker-secret, PAT)`.
2. Check the Worker isolate's admission cache by fingerprint. On a miss, ask the
   admission Durable Object named by that fingerprint; it calls GitHub's
   authenticated-user endpoint when its own cache is stale and requires the
   returned login to appear in `trusted_github_users`.
3. Check the isolate's repository-authorization cache by `(fingerprint, owner,
   repo)`. On a miss, ask the package Durable Object; it requests the mapped
   repository with the same PAT when its own decision is stale. GitHub's
   response determines whether the caller may read it.
4. Return `404` for a missing repository or insufficient repository access.

Cache every definitive admission result for at most 60 seconds in the admission
object, including an authenticated user who is not trusted and an invalid or
revoked credential. Cache every definitive repository-authorization result for
at most 60 seconds under `(fingerprint, owner, repo)` in the package object,
including granted, denied, and indistinguishably missing repositories. Neither
cache uses the per-colo Cache API, so concurrent requests, packages, and
Cloudflare locations share the appropriate refresh. The fingerprint is only an
object name and cache key; the raw PAT is never persisted. Revocation, allowlist
edits, newly granted access, or repository creation can therefore take at most
60 seconds to affect an already cached caller.

Do not cache timeouts, connection failures, GitHub 5xx responses, or `403`/`429`
rate-limit responses. Those are operational failures rather than authorization
decisions and follow the fail-closed behavior below.

Each Worker isolate keeps the same two decisions in bounded LRU caches using
the same keys. A Durable Object response includes the decision's absolute
`expires_at`, derived from the GitHub check that created it. The isolate copies
that expiry exactly; it never starts a new 60-second interval. Isolate eviction
only causes another Durable Object lookup, and an isolate cache hit cannot
extend the revocation bound. These caches contain fingerprints and decisions,
never PATs, and are acceleration layers rather than authorization authorities.

Consequently, a warm isolate serving the module files of an already authorized
package performs no Durable Object authorization hops. A cold isolate may pay
both hops once, but shared refresh and GitHub rate-limit behavior remain owned
by the Durable Objects rather than multiplied per colo.

A cold build spanning `N` packages normally performs one authenticated-user
lookup plus `N` repository lookups, rather than repeating both calls per
package. This is approximately `N + 1` GitHub authorization requests instead of
`2N`.

GitHub grants authenticated users a shared REST API budget, normally 5,000
requests per hour. The proxy reads and records GitHub's rate-limit headers,
avoids a separate rate-status request, and honors `Retry-After` or the reported
reset time after a `403` or `429`. An expired authorization decision that cannot
be refreshed fails closed with `503`; an unexpired positive decision continues
to serve ready versions without another GitHub authorization call.

Every synthetic metadata or artifact request passes this gate before reading the
Cache API or R2. If the grant is expired and GitHub is unavailable, fail closed
with `503`. GitHub remains the repository-authorization authority; the proxy
owns only the trusted-user allowlist.

### 9.3 Fetching source for materialization

The Package Durable Object uses the caller's PAT to fetch the pinned GitHub
archive through the Worker, follows only GitHub's `codeload.github.com`
redirect, and streams the archive to the Container. The Container receives no
PAT and has no GitHub egress; its sole outbound handler writes verified
artifacts to R2.

The Durable Object persists the job and its lease but not the PAT. An alarm can
expire an abandoned lease and return the job to `pending`, but cannot restart
GitHub work by itself. The next authorized request supplies a PAT and resumes
the job. The Worker and Container must not write the PAT to disk or logs.

This deliberately trusts the proxy with caller credentials. Unlike the public Go
proxy model, private resolution does not bypass the proxy; TLS termination and
Worker code are inside the credential trust boundary.

### 9.4 Proxy to jsr.io

None. Before fallthrough, the Worker removes the incoming `Authorization`
header. A GitHub PAT is never forwarded to jsr.io or incorporated into an
upstream cache key.

## 10. Cloudflare Storage and Coordination

### 10.1 Durable Objects

The Worker derives an admission Durable Object name from the HMAC fingerprint
of the caller's PAT. That object's SQLite database stores only the short-lived
authenticated login or definitive credential failure, trusted-user decision,
expiry, and observed rate-limit state. It never stores the PAT.

The Worker derives a Durable Object name from the canonical synthetic package
identity. All branch refreshes, version allocations, and job transitions for
that package therefore reach one serialized owner. Its SQLite database is
authoritative for:

- the decoded repository;
- observed branch tips and the highest `vN` major ever observed;
- package/major/SHA/attempt-to-sequence assignments, current-assignment pointers,
  and per-major high-water marks;
- version-to-branch/SHA mappings and ready or yanked-tombstone status;
- materialization jobs, retry state, manifests, and provenance;
- append-only administrative-recovery audit records; and
- short-lived HMAC-keyed positive and negative repository-authorization results.

Version allocation, job creation, and readiness changes use SQLite transactions.
D1 and Workers KV are not used for authoritative package state; neither is
needed when the consistency boundaries are one caller admission and one package.

### 10.2 R2

One private R2 bucket stores synthesized package files, version metadata, and
fallthrough cache entries under separate prefixes. R2 keys are deterministic.
Synthetic writes use the Workers R2 API's conditional `put` with
`If-None-Match: *`; an existing object is accepted only after its stored hash is
shown to match the new bytes. Store the SHA-256 value as R2 custom metadata so
this check requires only `head`, not a second download. A differing object is an
integrity failure.

The ready marker is written only after every referenced R2 object has been
written successfully. The Durable Object then commits the version as ready. R2
is the source of artifact bytes and completeness markers, while the Durable
Object is the source of which versions are advertised. The Cache API is only an
acceleration layer and can be discarded at any time.

Synthetic version artifacts are never deleted. Any deletion can break a lockfile
that pins the version. Growth is one version assignment per observed branch tip
and one artifact set per ready version or yanked tombstone. A run of broken
commits therefore leaves permanent tombstone entries in `meta.json`; this is the
cost of immutable, registry-visible failure history and is accepted at the
expected volume. Fallthrough objects may be evicted because jsr.io remains their
source of truth. Unreferenced partial output from permanently failed jobs may be
garbage-collected after a generous grace period.

### 10.3 Local development

Wrangler provides the Worker, Durable Object, and R2 development environment;
Docker runs the same materializer image used in production. Tests depend on
storage interfaces rather than Cloudflare globals so allocator and publication
semantics can also run as ordinary Rust and TypeScript unit tests.

## 11. Failure modes

| Scenario                                  | Behavior                                                |
| ----------------------------------------- | ------------------------------------------------------- |
| `jsr.io` unreachable                      | Serve from Cache API/R2; `502` on cold miss             |
| GitHub down with a valid cached grant     | Serve ready versions; defer branch refresh              |
| GitHub down after authorization TTL       | Fail synthetic requests closed with `503`               |
| Missing PAT for a configured scope        | `401`                                                   |
| PAT user is not trusted                   | `404`                                                   |
| Repository missing or PAT lacks access    | `404`; never fall through within the configured scope   |
| PAT revoked or loses repository access    | Cached grant lasts at most 60 seconds, then GitHub wins |
| Equal or backward commit timestamp        | Allocate `previous_sequence + 1` transactionally        |
| Branch force-pushed backward              | Allocate above high-water; issued versions unchanged    |
| `vN` branch deleted                       | Keep issued versions; default major does not rewind     |
| Concurrent observations of different tips | Package Durable Object serializes allocation            |
| Container unavailable or at capacity      | Keep job pending; `503` with `Retry-After`              |
| Container job abandoned                   | Expire lease; next PAT-bearing request resumes          |
| Repository contents cannot materialize    | Publish tombstone; ranges retain last ready version     |
| Infrastructure or suspected proxy failure | Keep version hidden and retry; do not tombstone         |
| Proxy bug caused an incorrect tombstone   | Administrator may allocate audited recovery attempt     |
| R2 unavailable                            | Serve Cache API hit; `502` otherwise                    |
| Existing R2 key has different bytes       | Fail integrity check; never publish version             |
| Checksum mismatch on fallthrough          | `502`; do not cache                                     |

## 12. Validation Results and Design Closure

Validated against Deno 2.9.5 with a hand-built local registry:

1. `DENO_AUTH_TOKENS` applies to JSR registry fetches and emits a bearer header.
2. A recognized response `Content-Type` takes precedence over the module path.
3. Both module graph fields may be absent.
4. `deno publish --dry-run` does not expose its rewritten tarball.
5. Plain HTTP works with a non-localhost hostname. Production deployments still
   require HTTPS because registry and GitHub credentials are bearer tokens.
6. With `1.0.0` ready and `1.0.1` marked `yanked: true`, caret and unversioned
   imports select `1.0.0`, an exact `1.0.1` import downloads and executes the
   tombstone, and `deno outdated --update` reports no update and leaves the lock
   on `1.0.0`. The package metadata needs no separate `latest` field.

The following design decisions are settled:

- typed JSR scope entries map entire scopes to GitHub owners, with the owner
  defaulting to the scope name, reversible repository-name encoding, and no
  jsr.io fallthrough inside those scopes;
- only the default branch and `vN` release branches are visible;
- StableVer governs compatibility across those release lines;
- one repository produces one synthetic package, with an `exports` object used
  for multiple public entry points; Deno workspace-member resolution is
  unsupported and workspaces are disrecommended;
- all majors use `<major>.1.<sequence>` with an atomic persisted high-water
  allocator;
- deterministic repository-content failures publish immutable yanked tombstones
  whose generated module fails loudly, while operational failures remain hidden
  and retryable;
- only the proxy deployment administrator may allocate an audited fresh version
  for a tombstoned SHA, and only to recover from a confirmed proxy defect;
- the implementation is a new Rust project containing attributed, adapted
  upstream modules rather than a fork of either full service;
- production runs as a Cloudflare Worker project using one SQLite-backed Durable
  Object per package, private R2 storage, and on-demand Containers for the
  native Rust materializer; and
- each trusted caller supplies a fine-grained GitHub PAT that the proxy forwards
  in memory, with positive and negative GitHub authorization decisions cached
  for at most 60 seconds and no GitHub credential persisted by the service.

There are no remaining product decisions for v1. Active notification is out of
scope; failures are discoverable through yanked tombstones and the authenticated
proxy status endpoint. Consumer PATs stay read-only, the proxy never mutates
GitHub, and publishers add no CI integration.

## 13. Build Order

**Cloudflare foundation.** Create one Wrangler project with the edge Worker,
SQLite-backed admission and package Durable Objects and migrations, private R2
binding, Container binding, secrets, Cache API policy, and local development
setup.

**Rust foundation.** Create the binary and storage interfaces, add the
`UPSTREAM.md` ledger, and import the first narrowly scoped upstream modules with
license notices intact. Package it as the Container image.

**Protocol fixtures.** Preserve the Deno 2.9.5 spike as executable contract
tests: authenticated `JSR_URL`, version metadata without a module graph, correct
and incorrect media types, plain HTTP development, caret and unversioned
selection around a yanked highest version, exact yanked-version download, and
`deno outdated --update` exclusion of yanked versions.

**Fallthrough.** Reverse-proxy to jsr.io with caching and checksum verification.
Useful alone as an availability cache, and it exercises the `JSR_URL` path end
to end.

**Identity and metadata.** Implement configured scope mapping, reversible name
encoding, GitHub branch discovery, branch rules, Durable Object schema, atomic
version allocation, and durable job state.

**Materialization.** Import the upstream publish behavior, process tarballs,
rewrite specifiers, generate manifests, publish conditionally to R2, and commit
ready versions transactionally. Add the deployment-administrator-only recovery
control, fresh-attempt allocation, and append-only audit trail.

**Authentication.** Add trusted-GitHub-user configuration, PAT admission and
repository checks, separately HMAC-keyed positive and negative admission and
repository-authorization caches, bounded isolate-local LRU acceleration using
inherited absolute expiries, header stripping on fallthrough and R2 writes, and
in-memory PAT forwarding to the Container. This ships with materialization —
private repositories are a requirement, not a follow-up.

**Cloudflare integration.** Exercise concurrent metadata refreshes, Container
cold starts and credential-free pending-job recovery, partial R2 publication,
PAT revocation and authorization-cache expiry, edge cache authorization gates,
one-user/many-package admission reuse across Cloudflare locations, zero-DO warm
artifact authorization, positive and negative decision reuse, non-extension of
expiry across cache layers, refusal to cache operational GitHub failures,
authorization stripping on jsr.io fallthrough, and recovery from an incorrectly
issued tombstone under `wrangler dev` and a staging deployment.
