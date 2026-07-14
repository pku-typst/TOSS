# TOSS Repository Guide

## Scope

This is the public Community TOSS repository. Every tracked source file,
fixture, document, screenshot, log excerpt, and commit must be appropriate for
a public open-source project. Use synthetic examples and public services only.
Never add credentials, personal data, private hosts, proprietary packages or
fonts, downstream deployment configuration, or material copied from a private
repository without an explicit provenance and licensing review.

Open-source dependencies authored by companies are allowed when their licenses
permit the intended use and redistribution. Product identity, private assets,
and downstream policy remain separate concerns.

## Module ownership

| Path | Responsibility |
| --- | --- |
| `web/` | React/Vite application, CodeMirror workspace, browser compiler workers, preview, i18n, and UI composition |
| `backend/` | Rust/Axum modular monolith for REST, realtime collaboration, access, Git, storage, templates, and runtime asset delivery |
| `protocol/` | Checked-in OpenAPI contract and isolated TypeScript generator toolchain |
| `distributions/community/` | Neutral product configuration, Help content, starter templates, and public Typst catalog |
| `prebuilt/` | Reproducible browser-runtime provenance and ignored, fetched package caches |
| `third-party/typst.ts/` | Public Apache-2.0 source submodule pinned to an exact revision |
| `docs/community/` | Public engineering Wiki and accepted architecture decisions |
| `scripts/` | Public-safe build, validation, backup, bootstrap, and smoke-test orchestration |

Generated directories such as `web/dist/`, `web/public/typst-runtime/`,
`web/public/busytex/`, `backend/target/`, caches, and test results are not source
modules. Regenerate them through their owning scripts. Package directories
under `prebuilt/` are ignored caches hydrated from pinned public releases;
never hand-edit or commit them.

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

Do not recreate horizontal `application/`, `repositories/`, `services/`, global
`domain/`, or generic CRUD layers. Business values and lifecycle states belong
to their owning context. Cross-context reuse uses an owner-named facade. Keep
database queries and locking in the owning persistence adapter, and compose
cross-context transactions through explicit transactional facades.

Errors belong to the capability that produces them. HTTP status and public
error-code mapping stay at transport edges. Context queries return owner-defined
serializable read contracts that OpenAPI references directly; do not create
field-for-field response duplicates.

External repository models remain provider-neutral. Provider REST DTOs, URL
rules, pagination, OAuth refresh, and permission semantics stay under
`external_repositories/provider/<provider>/`.

The root `protocol/` directory and `backend/src/protocol/` form an integration
boundary, not a shared domain model. Regenerate the checked-in OpenAPI and web
types together after a wire change.

Community TOSS begins with `202607120001_baseline.sql` and intentionally does
not support in-place upgrades from earlier TOSS database histories. That
baseline is checksum-compatible with the audited pre-extraction schema and is
immutable. Add a forward migration for schema changes; never edit, renumber,
delete, or consolidate the baseline or any published migration. Validate both
a fresh database and an upgrade from the latest Community release when a
migration transforms existing data.

## Distribution boundary

Community is the default, self-contained distribution. Core modules must not
assume a downstream product name, private package, one Git provider, or a
deployment environment. Product identity, starter content, Help, public
resources, and optional capabilities come from the validated distribution.

Keep browser compilation client-side unless an architecture decision explicitly
changes that model. Preserve persistent compiler and renderer sessions and the
incremental vector path when changing Typst preview behavior.

## Submodule and runtime artifacts

The URL and pinned commit in `.gitmodules` and the parent gitlink are canonical.
Do not configure a floating branch or use `git submodule update --remote` as an
incidental step. Work on a named branch inside `third-party/typst.ts/`, follow
its own `AGENTS.md`, commit and test there first, then update the parent gitlink
separately.

The prebuilt compiler manifest must match the exact submodule revision, build
recipe, release artifact, file list, sizes, and hashes. BusyTeX artifacts must
match their public source revision, release tag, and manifest. Do not commit
generated browser-runtime binaries; hydrate them with
`scripts/fetch-runtime-artifacts.mjs`.

## Tests

Backend changes:

```bash
cd backend
cargo fmt --all -- --check
cargo clippy --locked --all-targets
cargo check --locked
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
cd ../protocol
npm run generate:types
npm run check:types
```

Cross-module changes use `scripts/ci-checks.sh` with a disposable PostgreSQL
database. Keep deterministic unit coverage in Rust tests or Vitest and browser
workflows in Playwright; fixtures must be synthetic and public-safe.
