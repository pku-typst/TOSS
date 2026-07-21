# TOSS Repository Guide

## Scope

Everything tracked here must be public-safe. Use synthetic data and public
services. Never add credentials, personal data, private hosts, proprietary
assets, downstream deployment configuration, or private material without an
explicit provenance and licensing review. Company-authored open-source
dependencies are allowed when their licenses permit use and redistribution.

## Module ownership

| Path | Responsibility |
| --- | --- |
| `web/` | React/Vite application, CodeMirror workspace, browser compiler workers, preview, task center, i18n, and UI composition |
| `backend/` | Rust/Axum modular monolith for REST, realtime collaboration, access, Git, storage, templates, document processing, and runtime asset delivery |
| `workers/` | Public processing SDK and independently deployed, sandboxed processor implementations |
| `protocol/` | Checked-in public and worker OpenAPI contracts plus the isolated browser TypeScript generator toolchain |
| `distributions/community/` | Neutral product configuration, Help content, starter templates, and public Typst catalog |
| `config/` | Safe default deployment topology; secrets are mounted separately and never tracked |
| `prebuilt/` | Reproducible browser-runtime provenance and ignored, fetched package caches |
| `third-party/typst.ts/` | Public Apache-2.0 source submodule pinned to an exact revision |
| `docs/community/` | Public engineering Wiki and accepted architecture decisions |
| `scripts/` | Public-safe build, validation, backup, bootstrap, and smoke-test orchestration |

Generated outputs, caches, test results, and fetched `prebuilt/` packages are
not source. Regenerate them through their owning scripts; never hand-edit or
commit them.

## Architecture boundaries

The backend is a modular monolith organized as vertical bounded contexts:

| Path | Owner |
| --- | --- |
| `backend/src/access/` | Authentication, principals, authorization, organizations, grants, shares, and personal access tokens |
| `backend/src/workspace/` | Projects, files, assets, settings, archives, snapshots, and workspace-owned policy |
| `backend/src/collaboration/` | Realtime transport, rooms, Yjs persistence, and collaboration invalidation |
| `backend/src/versioning/` | Git locking, commits, local history, smart HTTP, merge validation, and rejected-push recovery |
| `backend/src/external_repositories/` | Provider-neutral linking, import, sync, checkpoints, grants, jobs, and provider adapters |
| `backend/src/templates/` | Built-in, personal, and organization-shared template workflows |
| `backend/src/experience/` | Runtime product identity and user-facing content contracts |
| `backend/src/distribution/` | Validated distribution configuration and source-file policy |
| `backend/src/typst_runtime/` | Built-in assets, public package proxying, and cache policy |
| `backend/src/latex_runtime/` | Optional BusyTeX requests, upstream resolution, and cache policy |
| `backend/src/document_processing/` | Durable jobs, immutable inputs, attempts, leases, worker sessions, cancellation, quotas, and artifacts |

Do not create horizontal `application/`, `repositories/`, `services/`, global
`domain/`, or generic CRUD layers. Values and lifecycle states stay with their
owner. Cross-context calls use owner-named facades; queries and locks stay in
owner persistence; multi-context transactions use explicit transactional
facades.

Errors belong to the producing capability; HTTP status and public-code mapping
stay at transport edges. OpenAPI references owner-defined read contracts
directly; do not add field-for-field response copies.

External repository models remain provider-neutral. Provider DTOs, URL rules,
pagination, OAuth refresh, and permission semantics stay under
`external_repositories/provider/<provider>/`.

`protocol/` and `backend/src/protocol/` are integration boundaries, not a shared
domain model. Public API changes regenerate OpenAPI and browser types together;
worker-wire changes regenerate worker OpenAPI separately. Worker credentials
and lifecycle routes never enter the browser generator.

## Change ownership and acceptance

Before implementation, state the user-visible outcome, the owner of every
decision, and one end-to-end acceptance scenario. Trace that scenario through
Web, Core, the durable job input, the worker, and the returned artifact before
choosing files to change. Existing code placement is evidence, not proof of
correct ownership.

Core owns admission, authorization, immutable capture of project-owned input,
job state, leases, quotas, and artifacts. A worker owns processor-specific
semantics, toolchains, dependency and package resolution, caches, and output
diagnostics. Immutable capture means project files, assets, settings, and
source identity; it does not make Core a second compiler or package resolver.
Distribution configuration may enable a neutral operation and describe its
user-facing inputs, but must not introduce processor-specific source analysis
into Core.

When a policy is removed, search the whole execution path and remove the
enforcement, derived capability state, capture logic, protocol fields, tests,
and documentation that existed only for that policy. Do not retain a lower
layer of the same assumption after removing its UI or configuration gate.

Type checks, contract hashes, worker registration, health endpoints, and queue
state are necessary infrastructure checks, not feature acceptance. A processing
change is complete only after a representative project creates a job, reaches
the real processor, and produces a downloadable artifact or the intended
structured failure.

Community begins with immutable `202607120001_baseline.sql` and does not support
in-place upgrades from earlier histories. Never edit, renumber, delete, or
consolidate a published migration. Add forward migrations and validate fresh
install plus upgrade from the latest Community release when a migration
transforms existing data.

## Process, realtime, and compatibility

- Run one Core replica. Process-local rooms and Git locks make shared storage,
  sticky sessions, or a shared database insufficient for horizontal scaling.
- Keep `AppState` at server, HTTP, and WebSocket composition edges. Background
  owners and reusable context workflows receive narrow facades and adapters.
- Core replacement uses one monotonic drain signal and one deadline. Contexts
  stop claims and own repair or retry; do not add independent lifecycle sources
  or a generic activity registry.
- Room APIs return sender and receiver as one atomic subscription. Revalidate
  the effective principal, write capability, and access/content generations
  after subscribing and before bootstrap. Persist accepted Yjs mutations before
  acknowledgement.
- Bump `PROTOCOL_EPOCH` only when an already loaded first-party Web build could
  mutate unsafely. Additive changes and releases alone do not bump it.

## Distribution boundary

Community is the self-contained default distribution. Core must not assume a
downstream product, private package, one Git provider, or deployment
environment. Identity, content, resources, and optional capabilities come from
the validated distribution.

Keep interactive compilation and preview client-side. Durable Document
Processing is explicit user work, never a preferred compiler, preview hedge, or
silent fallback. Preserve persistent compiler/renderer sessions and incremental
vector rendering.

## Submodule and runtime artifacts

The `.gitmodules` URL and parent gitlink are canonical. Never configure a
floating branch or use `git submodule update --remote` incidentally. Change
`third-party/typst.ts/` on a named branch under its own `AGENTS.md`, commit and
test there first, then update the parent gitlink.

Runtime manifests must match their exact source revision, package versions,
files, sizes, and hashes. The lockfile installs the fork compiler package;
`scripts/fetch-runtime-artifacts.mjs` hydrates only release-backed BusyTeX
assets when enabled. Do not commit generated browser binaries.

## Tests

Backend changes:

```bash
cd backend
cargo fmt --all -- --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
```

Web changes:

```bash
cd web
npm test
npm run build
npm run check:typst-runtime
```

Protocol changes:

```bash
cd backend
cargo run --locked --example export_protocol -- ../protocol/openapi.json
cargo run --locked --example export_worker_protocol -- ../protocol/worker-openapi.json
cd ../protocol
npm run generate:types
npm run check:types
```

Worker changes:

```bash
node scripts/check-latex-worker-contract.mjs
cd workers
cargo fmt --all -- --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
```

Cross-module changes use `scripts/ci-checks.sh` with a disposable PostgreSQL
database. Lifecycle, realtime admission, native-process, or Web/Core
compatibility changes must include
`npm --prefix web run test:release-resilience`, normally through that workflow.
Documentation changes run `node scripts/check-docs.mjs`. Keep deterministic
logic in Rust tests or Vitest and browser workflows in Playwright; all fixtures
remain synthetic and public-safe.
