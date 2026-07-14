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
  - web/package.json
  - protocol/package.json
---

# Testing and validation

Choose checks according to the changed ownership boundary. Run the complete
workflow before a release or after a cross-context change.

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

## Browser/server protocol

After changing a route or wire schema, regenerate both checked-in artifacts:

```bash
cd backend
cargo run --locked --example export_protocol -- ../protocol/openapi.json

cd ../protocol
npm run generate:types
npm run check:types
```

Do not edit `protocol/openapi.json` or `web/src/lib/api/generated.ts` manually.
Backend tests reject Axum/OpenAPI drift and the web build rejects stale generated
TypeScript.

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
