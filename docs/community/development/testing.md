---
title: "Testing and validation"
summary: "Required checks by subsystem, generated-protocol workflow, and distribution test matrix."
status: current
type: guide
scope: community
audience:
  - contributor
  - coding-agent
topics:
  - testing
  - continuous-integration
  - protocol
related:
  - docs/community/development/setup.md
  - docs/community/reference/api.md
  - protocol/README.md
code_paths:
  - scripts/check-docs.mjs
  - backend/Cargo.toml
  - workers/Cargo.toml
  - web/package.json
  - protocol/package.json
  - scripts/processing-protocol-smoke.mjs
  - scripts/processing-latex-worker-smoke.mjs
  - scripts/processing-latex-benchmark.mjs
---

# Testing and validation

Choose checks according to the changed ownership boundary. Run the complete
workflow before a release or after a cross-context change.
Hydrate the manifest-verified browser runtime inputs before installing the web
workspace or running its checks:

```bash
node scripts/fetch-runtime-artifacts.mjs
```

## Documentation

```bash
cd protocol
npm ci
cd ..
node scripts/check-docs.mjs
```

This validates frontmatter, repository-relative metadata targets, local links,
and API-reference coverage against the checked-in OpenAPI contract.

## Backend

```bash
cd backend
cargo fmt --all -- --check
cargo clippy --locked --all-targets -- -D warnings
cargo check --locked
cargo test --locked
```

The workspace denies unchecked panics, unwraps, indexing, and unjustified lint
suppressions. Do not weaken those lints for a change.

## Web application

```bash
cd web
npm test
npm run build
npm run check:typst-runtime
```

Vitest owns deterministic unit/component/state tests. Playwright owns complete
browser workflows and rendering behavior. Repository scripts are reserved for
multi-process stress, performance, migration, and smoke scenarios that do not
fit a unit-test runner.

## Processing workers

```bash
node scripts/check-latex-worker-contract.mjs
cd workers
cargo fmt --all -- --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
```

The contract check binds worker/SDK source, lockfiles, Dockerfile, and recipe to
the implementation digest embedded in the processor manifest. It also requires
the Dockerfile to use the manifest's pinned base and verify every declared
runtime fingerprint and tool version. Rust tests verify the Core-authored bundle
shape and reject unsafe paths, unknown file kinds, bad digests, and invalid
source epochs. They do not replace an image-level bubblewrap build.

## Browser/server protocol

After changing a route or wire schema, regenerate both checked-in artifacts:

```bash
cd backend
cargo run --locked --example export_protocol -- ../protocol/openapi.json
cargo run --locked --example export_worker_protocol -- ../protocol/worker-openapi.json

cd ../protocol
npm run generate:types
npm run check:types
```

Do not edit either OpenAPI document or `web/src/lib/api/generated.ts` manually.
Backend/CI checks reject Axum/OpenAPI drift and the web build rejects stale
browser TypeScript. Worker OpenAPI never feeds the browser generator.

## Distribution matrix

Capability-dependent web changes must test the Community baseline and each
downstream distribution maintained by the deployment. The Community build is:

```bash
cd web
TOSS_CONFIG=../distributions/community/toss.json npm test
TOSS_CONFIG=../distributions/community/toss.json npm run build
```

A Typst-only distribution must additionally verify that its build contains no
`dist/busytex` directory. Those overlay checks belong to that distribution's
internal documentation and CI configuration.

Community LaTeX changes additionally use the Playwright LaTeX scenario against
a Community backend and compatible TeX Live source:

```bash
cd web
WEB_BASE_URL=http://127.0.0.1:8080 npx playwright test tests/e2e/latex.spec.ts
```

## Integrated validation

Integration and browser scenarios must use a disposable PostgreSQL database.
They cover collaboration, Git, workspace replacement, caching, and rendered
browser behavior. A parent monorepo may provide an aggregate wrapper and add
downstream distribution jobs, but those deployment-specific commands are not
part of the Community contract.

Repository CI starts Core against that disposable database and runs
`scripts/processing-protocol-smoke.mjs` with a synthetic worker identity. The
smoke covers protocol/idempotency/finalization/cache behavior but intentionally
uses a minimal synthetic PDF. Before a worker release, enable the Compose
`processing` profile and run the real-image smoke so TeX Live, bubblewrap,
transfer, publication, artifact download, and exact-result reuse are exercised
together:

```bash
sudo apparmor_parser -r workers/latex/toss-latex-worker.apparmor
docker compose --profile processing up --build -d
CORE_API_URL=http://127.0.0.1:8080 \
  node scripts/processing-latex-worker-smoke.mjs
cd web
WEB_BASE_URL=http://127.0.0.1:8080 \
  npx playwright test tests/e2e/processing.spec.ts
```

Use the same running Community stack for a controlled browser/native latency
comparison:

```bash
CORE_API_URL=http://127.0.0.1:8080 \
LATEX_WORKER_CONTAINER=toss-latex-worker-1 \
node scripts/processing-latex-benchmark.mjs
```

The benchmark uses the same generated 21 KiB multi-pass corpus on both paths.
It measures new browser contexts, one-character edits in a persistent BusyTeX
worker, clean native jobs, and exact native artifact reuse separately. Override
`LATEX_BENCHMARK_RUNS`, `LATEX_BENCHMARK_COLD_RUNS`, or
`LATEX_BENCHMARK_ENGINES` for exploratory runs. Claim-to-delivery timing
requires the worker container name; the browser and backend end-to-end
measurements still run when Docker logs are unavailable.

## Migration baseline

`node scripts/check-migration-baseline.mjs` verifies the exact immutable
Community baseline checksum and rejects migration versions at or below the
baseline. Repository-wide CI then starts the application against an empty
PostgreSQL database, which proves the baseline creates a usable current schema.

Pre-Community database histories are deliberately outside the supported test
matrix. After the first Community release adds a forward migration, migration
changes must additionally test an upgrade from the latest released Community
schema with representative data. Never make an unsupported historical database
appear compatible by rewriting `_sqlx_migrations`.

## Related

- [Development setup](./setup.md)
- [API reference](../reference/api.md)
- [Protocol contract](../../../protocol/README.md)
- [Decision: Community database baseline](../decisions/0007-community-database-baseline.md)
