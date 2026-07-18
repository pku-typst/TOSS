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
  - docs/community/architecture/document-processing.md
  - docs/community/runtimes/typst.md
  - docs/community/runtimes/latex-worker.md
  - docs/community/operations/deployment.md
code_paths:
  - .github/workflows/pages.yml
  - rust-toolchain.toml
  - web/package.json
  - workers/Cargo.toml
  - workers/latex/Dockerfile
  - compose.build.yaml
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

Docker is also required to build and exercise the native TeX Live worker. Its
real sandbox needs unprivileged user namespaces plus the repository AppArmor
policy on affected Linux hosts; ordinary browser-preview development does not.

A local Typst CLI installed through Pixi is useful for template comparison and
offline debugging, but application preview does not invoke it. Both Core-backed
and static builds use the versioned browser compiler package bound by
`web/typst-runtime.config.json`.

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

cd ../protocol
npm ci
cd ..
```

The submodule retains the exact public compiler source for audit and fork
development. `npm ci` installs the immutable compiler package and verifies its
registry integrity through the lockfile. The fetch step only hydrates BusyTeX
from its pinned public release when the selected distribution enables LaTeX.

Do not hand-edit generated files under `web/dist/`,
`web/public/typst-runtime/`, `web/public/vendor/`, or
`prebuilt/*/package/`. The compiler package is published by the fork's own
verified release workflow; application builds never rebuild it implicitly.

## Start local dependencies

Copy `.env.example` to `.env`, then start the backing services:

```bash
docker compose -f compose.build.yaml up -d postgres minio minio-init
```

For a simple same-origin loop, build the SPA and let the Rust service serve it:

```bash
cd web
npm run build

cd ../backend
DATABASE_URL=postgres://typst:typst@127.0.0.1:5432/typst \
WEB_STATIC_DIR=../web/dist \
TOSS_CONFIG=../distributions/community/toss.json \
TOSS_DEPLOYMENT_CONFIG=../config/deployment.toml \
CORE_API_PORT=8080 \
cargo run --locked
```

Relative paths resolve from each command's working directory. The backend runs
database migrations during startup.

For the frontend-only target, choose the deployment base path at build time:

```bash
cd web
TOSS_BASE_URL=/TOSS/ \
  TOSS_BROWSER_ENABLED_FEATURES=ai_assistant \
  npm run build:browser
npm run preview -- --host 127.0.0.1
```

The static target embeds the selected distribution's public templates, Help
content, product assets, and safe frontend policy. It stores projects locally
in IndexedDB and does not require Core. Use `/` for a root deployment or the
repository path, including leading and trailing slashes, for GitHub Pages.

### Publish with GitHub Pages

The `Pages` workflow builds, exercises, and deploys the standalone target on
pushes to `main` or a manual run from `main`. It explicitly enables the
Community BYOK Assistant without changing the Core deployment default, and
reads GitHub Pages' configured base path so project sites, user sites, and
custom domains use the same workflow without a hard-coded repository name. The
uploaded artifact is the same `/dist` tree that passed the Chromium static
smoke.

Before the first run, set the repository's **Settings → Pages → Build and
deployment → Source** to **GitHub Actions**. No deployment secret or `gh-pages`
branch is required. Restrict the automatically created `github-pages`
environment to `main` if the repository needs an explicit deployment
protection rule.

With no worker identity in the deployment TOML, processing operations are not
enabled or advertised while Typst and BusyTeX preview continue normally. This
is the supported Core-without-processors topology, not a degraded application
state.

## Optional processing worker

The public worker SDK and native LaTeX processor use a separate Rust workspace:

```bash
node scripts/check-latex-worker-contract.mjs
cd workers
cargo test --locked
```

The contract check binds the SDK, processor adapter, image recipe, and runtime
manifest to the exact processor contract. A local Core accepts that worker only
after the same contract and token are placed in Core's identity allowlist.

For an image-level build, install the host sandbox policy and use the Compose
`processing` profile. Follow the complete
[local processing profile](../operations/deployment.md#enable-the-local-processing-profile)
procedure rather than weakening the sandbox to make a development container
start. The default Compose topology deliberately omits this profile.

## Distribution build matrix

The frontend and backend must use distribution configs compatible with the
checked web build manifest. Community includes Typst and optional LaTeX. A
Typst-only downstream build can replace LaTeX modules with disabled stubs and
remove `dist/busytex`; runtime configuration cannot activate code omitted at
build time.

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
- [Durable document processing](../architecture/document-processing.md)
- [Typst runtime](../runtimes/typst.md)
- [Native LaTeX worker](../runtimes/latex-worker.md)
- [Deployment](../operations/deployment.md)
