---
title: "TOSS"
summary: "Self-hosted collaborative writing for Typst and optional LaTeX with browser compilation, realtime editing, versioning, and explicit external Git workflows."
status: current
type: overview
scope: community
audience:
  - user
  - contributor
  - operator
  - coding-agent
topics:
  - typst
  - collaboration
  - self-hosting
related:
  - docs/community/README.md
  - docs/community/product/overview.md
  - docs/community/development/setup.md
code_paths:
  - web
  - backend
  - distributions/community
---

# TOSS

TOSS is a self-hosted collaborative typesetting platform centered on Typst. It
combines realtime multi-user editing, browser-side compilation and preview,
project storage, sharing, local revision history, direct Git access, and
owner-controlled external repository workflows in one service.

TOSS stands for Typst Open-Source Server.

## Core behavior

- CodeMirror and Yjs provide multi-file realtime editing, presence, remote
  cursors, read-only/read-write sharing, and named guest sessions.
- Typst compiles in a persistent browser worker and renders through incremental
  vector updates. Source and preview support bidirectional navigation.
- Community deployments can also compile LaTeX through a persistent BusyTeX
  worker.
- PostgreSQL stores accounts, access policy, workspace content, collaboration
  state, jobs, and PDF artifacts. A persistent volume stores local Git history;
  S3-compatible storage is optional for project assets.
- The Template Gallery combines built-in templates, personal project templates,
  and organization-shared templates.
- GitHub, GitLab, Gitea, and Forgejo or Codeberg provider instances can support
  login and repository access without making one provider part of the domain
  model.

The platform workspace is authoritative while users collaborate. External Git
is explicit: import creates a project, inbound sync replaces a linked project
from a selected branch, and checkpoint publishes the current workspace. Normal
edits do not create external commits, and collaborators do not need write access
to the owner's external repository.

## Architecture

```text
Browser
  React + CodeMirror + Yjs
  Typst / optional BusyTeX workers -> canvas preview / PDF
             |
             | same-origin REST + WebSocket + Git HTTP
             v
Rust/Axum modular monolith
  access | workspace | collaboration | versioning | external repositories
       |                 |                         |
       v                 v                         v
  PostgreSQL       persistent Git volume     S3/MinIO (optional)
                                                  |
                              explicit jobs -> external Git provider
```

The Rust service also serves the precompressed SPA, so production uses one
application image and origin. The current coordination model requires one
application replica. See the
[architecture overview](./docs/community/architecture/overview.md).

## Repository map

| Path | Responsibility |
| --- | --- |
| `web/` | React application, editor, previews, browser workers, and localization |
| `backend/` | Axum API, collaboration, access, storage, Git, and provider adapters |
| `protocol/` | Checked-in OpenAPI contract and generated TypeScript workflow |
| `distributions/community/` | Product configuration, Help content, and starter templates |
| `prebuilt/` | Reproducible browser compiler and optional LaTeX runtime inputs |
| `third-party/typst.ts/` | Public compiler and renderer fork pinned as a submodule |
| `docs/community/` | Engineering documentation and architecture decisions |

Product identity and optional capabilities are selected through a validated
distribution file. This repository ships the self-contained Community
distribution and keeps the core suitable for downstream distributions.

## Quick start

Prerequisites are Docker with Compose, Git, and Git LFS.

```bash
git lfs install
git lfs pull
cp .env.example .env
docker compose up --build
```

Open <http://localhost:8080>. Compose starts PostgreSQL, MinIO, and the
Community application.

The service does not create a default administrator. Before the intended
administrator first registers or signs in, set `BOOTSTRAP_ADMIN_EMAILS` in
`.env` to that account's exact email address. The matching account is promoted
after successful authentication.

## Build from source

The pinned tools are Node.js 24.x with npm 11.x, Rust 1.97.0, PostgreSQL 16,
Git LFS, `pkg-config`, and OpenSSL development headers.

```bash
git lfs pull
git submodule update --init third-party/typst.ts

cd protocol
npm ci

cd ../web
npm ci
npm run verify:typst-compiler
npm run build

cd ../backend
DATABASE_URL=postgres://typst:typst@127.0.0.1:5432/typst \
WEB_STATIC_DIR=../web/dist \
TOSS_CONFIG=../distributions/community/toss.json \
CORE_API_PORT=8080 \
cargo run --locked
```

## Validation

```bash
node scripts/check-docs.mjs

cd backend
cargo fmt --all -- --check
cargo clippy --locked --all-targets
cargo test --locked

cd ../web
npm test
npm run build
```

The repository-wide workflow is `scripts/ci-checks.sh` and requires a
disposable PostgreSQL database. See
[testing and validation](./docs/community/development/testing.md).

## License

TOSS is distributed under GNU AGPLv3; see [LICENSE](./LICENSE). Public
dependencies and bundled runtime artifacts retain their respective licenses
and provenance. The `typst.ts` submodule retains its Apache-2.0 license and
history.

## Related

- [Community documentation](./docs/community/README.md)
- [Product overview](./docs/community/product/overview.md)
- [Development setup](./docs/community/development/setup.md)
