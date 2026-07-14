---
title: "Development setup"
summary: "Pinned toolchains, repository preparation, local services, and distribution-aware build workflow."
status: current
type: guide
scope: community
audience:
  - contributor
  - coding-agent
topics:
  - development
  - toolchains
  - local-environment
related:
  - docs/community/development/testing.md
  - docs/community/configuration/README.md
  - docs/community/runtimes/typst.md
code_paths:
  - rust-toolchain.toml
  - web/package.json
  - docker-compose.yml
  - .env.example
---

# Development setup

## Toolchains

The supported toolchain is pinned:

- Node.js 24.x and npm 11.x, enforced by `web/package.json`;
- Rust 1.97.0, selected by `rust-toolchain.toml`;
- PostgreSQL 16 for local containers;
- Git;
- `pkg-config` and the platform OpenSSL development package.

A local Typst CLI installed through Pixi is useful for template comparison and
offline debugging, but application preview does not invoke it. The browser uses
the versioned compiler package bound by `web/typst-runtime.config.json`.

Resolve dependency versions from registries instead of guessing them. Before a
dependency update, inspect `cargo update --dry-run --verbose`, `npm outdated`,
and `npm audit` in both npm workspaces. Cargo requirements follow the repository
convention of `x` or `0.y`; `Cargo.lock` owns the exact resolution.

## Prepare the repository

```bash
git submodule update --init third-party/typst.ts
node scripts/fetch-runtime-artifacts.mjs

cd web
npm ci
npm run verify:typst-compiler

cd ../protocol
npm ci
cd ..
```

The submodule is required to inspect or rebuild the compiler. The fetch step
hydrates ignored package caches from pinned public release assets and verifies
the compiler source revision, archive, and every extracted file. It downloads
BusyTeX only when the selected distribution enables LaTeX.

Do not hand-edit generated files under `web/dist/`,
`web/public/typst-runtime/`, `web/public/vendor/`, or
`prebuilt/*/package/`. The compiler package is a versioned release input with
its own reproducibility workflow.

## Start local dependencies

Copy `.env.example` to `.env`, then start the backing services:

```bash
docker compose up -d postgres minio minio-init
```

For a simple same-origin loop, build the SPA and let the Rust service serve it:

```bash
cd web
npm run build

cd ../backend
DATABASE_URL=postgres://typst:typst@127.0.0.1:5432/typst \
WEB_STATIC_DIR=../web/dist \
TOSS_CONFIG=../distributions/community/toss.json \
CORE_API_PORT=8080 \
cargo run --locked
```

Relative paths resolve from each command's working directory. The backend runs
database migrations during startup.

## Distribution build matrix

The frontend and backend must use capability-compatible distribution configs.
Community includes Typst and optional LaTeX. A Typst-only downstream build can
replace LaTeX modules with disabled stubs and remove `dist/busytex`; runtime
configuration cannot activate code omitted at build time.

## Implementation conventions

- Put deterministic TypeScript behavior in Vitest and user/browser workflows
  in Playwright.
- Put user-facing strings in the locale catalogs and run `npm run check:i18n`.
- Use the design tokens and components described in `web/DESIGN.md`.
- Keep distribution-specific identity in configuration returned by the server,
  not in public-core UI branches.
- Follow the ownership rules in the
  [architecture overview](../architecture/overview.md) and the error model.

## Related

- [Testing](./testing.md)
- [Configuration](../configuration/README.md)
- [Typst runtime](../runtimes/typst.md)
