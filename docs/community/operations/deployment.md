---
title: "Deployment and operations"
summary: "Image variants, persistent state, secrets, limits, health, backups, and rollout constraints."
status: current
type: guide
scope: community
audience:
  - operator
  - contributor
  - coding-agent
topics:
  - deployment
  - operations
  - persistence
  - security
related:
  - docs/community/configuration/README.md
  - docs/community/architecture/overview.md
  - docs/community/architecture/document-processing.md
  - docs/community/architecture/release-resilience.md
  - docs/community/runtimes/typst.md
  - docs/community/runtimes/latex-worker.md
code_paths:
  - backend/Dockerfile
  - backend/src/process_lifecycle.rs
  - backend/src/server/runtime.rs
  - compose.build.yaml
  - .env.example
  - backend/migrations
  - workers/latex/toss-latex-worker.apparmor
---

# Deployment and operations

## Deployment unit

Production currently uses one application image containing:

- the Rust/Axum API and in-process background operations;
- database migrations;
- the precompressed React SPA;
- versioned distribution files;
- the selected built-in Typst catalog.

PostgreSQL is required. S3-compatible storage is optional and recommended for
production project assets. An external Git provider is a durability target,
not a prerequisite for normal editing.

## Optional worker topology

ADR-0008 adds independently scalable processor images beside the existing
application image. Core remains the policy and durable-queue owner. Processors
pull leased work through a versioned protocol and use short-lived transfer
tickets rather than database or object-store credentials.

Community ships a pinned native TeX Live worker for
`latex.compile.pdf/v1`. A deployment may omit the worker and its Core identity
entirely; the operation is then unavailable without affecting browser editing,
preview, or local export. If Core is configured to expect the identity but no
compatible session is healthy, the operation reports `waiting` and accepts only
the bounded queue configured by the operator. Slots must be at least one; omit
the worker instead of using zero as an off switch.

Processing inputs, staged outputs, and durable processing artifacts currently
live in PostgreSQL. S3 settings apply to Workspace project assets, including
assets read while Core constructs a project bundle, but do not move processing
blobs. Include processing retention in database capacity planning. Workers see
only transfer tickets.

An absent optional processor does not fail the application's `/ready` or stop
browser editing. Capability state exposes compatible capacity; worker process
liveness and logs are deployment probes.

Where the platform permits it, `/internal/v1/processing/*` is reachable through
a worker-only service or ingress rather than the public browser route. Network
separation is defense in depth: Core still authenticates every worker request,
and a shared development endpoint does not weaken the credential checks.

### Enable the local processing profile

Build the exact worker image first and print its production contract:

```bash
sudo apparmor_parser -r workers/latex/toss-latex-worker.apparmor
docker compose -f compose.build.yaml --profile processing build latex-worker
docker run --rm toss-latex-worker:local contract
mkdir -p tmp/processing-config
openssl rand -hex 32 > tmp/processing-config/worker.token
```

The profile load is required on AppArmor hosts, including Ubuntu 24.04, where
unprivileged user namespaces are restricted by default. It attaches only the
worker container and its dedicated `/usr/local/bin/toss-bwrap` helper; it does
not replace a distribution-owned `/usr/bin/bwrap` profile. Review and install
the equivalent policy through node provisioning in production. On a host that
does not use AppArmor and already permits rootless user namespaces, set
`PROCESSING_APPARMOR_PROFILE=unconfined` instead.

Create `tmp/processing-config/deployment.toml` from
[`deployment.example.toml`](../configuration/deployment.example.toml). Keep the
default limits, remove any unused provider examples, and replace `<contract>`
with the exact value printed by the image:

```toml
schema = 1

[frontend]
enabled_features = []

[document_processing]

[[document_processing.worker_identities]]
id = "community-latex"
token_file = "worker.token"

[[document_processing.worker_identities.operations]]
id = "latex.compile.pdf/v1"
processor_contracts = ["<contract>"]
```

Then start the optional profile with the normal Community stack:

```bash
export TOSS_DEPLOYMENT_CONFIG_DIR=./tmp/processing-config
docker compose -f compose.build.yaml --profile processing up --build
```

Compose mounts this directory read-only into both Core and the worker. Core
resolves `token_file` relative to the TOML; the worker reads the same file
through `PROCESSING_WORKER_TOKEN_FILE`.

The local profile gives `/work` a bounded tmpfs and runs bubblewrap as a
non-root user. Its repository AppArmor policy permits namespace setup and then
stacks a child profile that strips capabilities. `seccomp=unconfined` remains a
local validation concession, not a production policy. A production deployment
must use reviewed AppArmor/SELinux and syscall policies, drop capabilities,
prevent privilege escalation, disable network in the per-job namespace, bound
ephemeral storage, and make its termination grace period at least as long as
the admitted job drain policy.

## Image variants

`backend/Dockerfile` accepts one build argument:

```bash
docker build -f backend/Dockerfile \
  --build-arg TOSS_DISTRIBUTION=community \
  -t typst-collaboration:<immutable-tag> .
```

`community` includes Typst and optional LaTeX. A downstream distribution may
produce a smaller Typst-only frontend without the browser LaTeX worker, CodeMirror
LaTeX language bundle, or BusyTeX WASM/data files.

The final image sets `TOSS_CONFIG` to the matching in-image distribution. An
operator may override it only with project types and frontend features present
in the checked web build manifest; Core rejects an incompatible pairing. Use
immutable commit-derived image tags in deployment manifests; do not infer a tag
from a different repository's commit.

`workers/latex/Dockerfile` builds the optional worker separately. Its TeX Live
base is pinned by digest, and `toss-latex-worker contract` prints the exact
allowlist value that must accompany that image. Do not reuse a contract printed
by a different source tree or tag.

## Persistent state

| State | Default location | Production expectation |
| --- | --- | --- |
| Users, sessions, RBAC, projects, documents, Yjs updates/snapshots, Workspace PDF artifacts, processing jobs/blobs/artifacts, external Git jobs | PostgreSQL | Managed PostgreSQL with backups and processing-retention sizing |
| Project assets | Inline PostgreSQL bytes or S3-compatible storage | S3/MinIO for large or numerous assets |
| Git repositories/revision history and thumbnails | `DATA_DIR` / `GIT_STORAGE_PATH` | Persistent volume with backup |
| Typst Universe cache | `TYPST_PACKAGE_CACHE_DIR` | Bounded local cache; reproducible from upstream/catalog |
| Built-in packages and fonts | Image or mounted catalog | Immutable, versioned release input |

External Git checkpoints are not the primary live-editing store. A provider
outage should affect repository operations and requested checkpoints, while
existing authenticated users continue editing against workspace storage.

Workspace PDF artifacts and Document Processing blobs/artifacts are currently
stored directly in PostgreSQL. Include both in database capacity and retention
planning; configuring S3 does not move them out of the database.

## Replica and filesystem constraint

Run one application replica. WebSocket fan-out and per-project Git worktree
locks are process-local, so two replicas can accept collaborators that cannot
see each other's live events and can race while mutating the same repository.
A shared database, shared volume, or sticky sessions do not remove this
constraint. Horizontal scaling requires a shared realtime bus and distributed
Git locking. See
[Single-replica release resilience](../architecture/release-resilience.md) for
replacement behavior.

The application volume must be mounted read-write and survive pod replacement.
Losing it loses local Git revision history even when the live document rows in
PostgreSQL remain intact. Back up PostgreSQL and the Git volume as one logical
recovery point; object storage follows its own versioning/backup policy.

## Configuration and secrets

Use `.env.example` as the canonical common application template. At minimum a
production deployment must provide:

- `DATABASE_URL`;
- a high-entropy `SESSION_SECRET`;
- `COOKIE_SECURE=true` behind HTTPS;
- `TOSS_CONFIG` if the in-image default is not used;
- `TOSS_DEPLOYMENT_CONFIG` if `/app/config/deployment.toml` is not used;
- persistent `DATA_DIR`/`GIT_STORAGE_PATH`;
- the selected authentication configuration.

OIDC deployments additionally configure `OIDC_ISSUER`, `OIDC_CLIENT_ID`,
`OIDC_CLIENT_SECRET`, `OIDC_REDIRECT_URI`, the groups claim, and user-facing
`IDENTITY_PROVIDER_ID`/`IDENTITY_PROVIDER_DISPLAY_NAME` metadata.

External repository support is optional. Add providers under `external_git` in
the deployment TOML, provide one deployment encryption key and the derived
per-instance client-secret variables, and register one callback per instance.
Generic OIDC credentials are never reused for repository access.
Provider schemas, callback paths, scopes, brand rules, and secret names have one
canonical reference: [External Git configuration](../configuration/external-git.md).

Set `OIDC_REDIRECT_URI` to exactly one of the supported callback routes and
register that exact absolute URL in the provider application:

- `/v1/auth/oidc/callback` for a generic OIDC naming convention; or
- `/v1/auth/gitlab/callback` when GitLab is the configured issuer.

The two routes are aliases, not two independent OAuth clients.

The public auth configuration returns an ordered `identity_providers` list.
Generic OIDC and each external provider with login enabled appear as separate
buttons. Provider-login account binding and email-conflict semantics are
described in [Identity and access](../architecture/identity-and-access.md).

Authentication settings normally live in PostgreSQL and are editable by a site
administrator. Non-empty `OIDC_*` values and explicit `AUTH_*` values in the
environment override the database at runtime; use that mechanism only for
deployment-managed policy.

The service does not create a default administrator or print a one-time
password. Before the intended administrator first signs in or registers, set
`BOOTSTRAP_ADMIN_EMAILS` to a comma-separated list of exact email addresses.
Each matching account is promoted after successful authentication. Remove the
bootstrap value after verifying administrator access if ongoing promotion is
not desired.

Document Processing is optional. Core reads lowercase identities, token-file
references, and exact operation/processor-contract allowlists from the
`document_processing` deployment section. The worker reads the matching token
through `PROCESSING_WORKER_TOKEN_FILE`; `PROCESSING_WORKER_TOKEN` remains a
standalone SDK fallback, not Core configuration. Never place token contents in
distribution JSON, deployment TOML, an image layer, logs, or source control.
Rotate by admitting a second identity/token file, rolling capacity to it,
draining the old worker, and then removing the old identity.

Distribution JSON is not a secret store. Keep passwords, OAuth secrets, token
encryption keys, S3 credentials, and session keys in Kubernetes Secrets or an
equivalent secret manager.

## Request and package limits

`MAX_REQUEST_BODY_BYTES` defaults to 64 MiB and bounds HTTP uploads, including
uploads whose final backing store is S3. Uploads currently pass through and are
buffered by the application; there is no multipart or presigned direct-to-S3
path yet. Raising the limit therefore requires application-memory, ingress
timeout/body-size, and storage capacity review. S3 reduces PostgreSQL growth,
but does not bypass this request limit.

Typst package downloads are guarded by archive, extracted-size, per-file, file
count, and total-cache limits. Keep the `TYPST_PACKAGE_*` values aligned with
the policy in `.env.example`; disabling `TYPST_UNIVERSE_ENABLED` leaves only the
built-in catalog available.

Community LaTeX has a separate `DATA_DIR/texlive` cache and
`LATEX_TEXLIVE_*` limits. Its BusyTeX/TeX Live 2026 browser assets are
revision/hash pinned, and the default on-demand endpoint matches that build.
Production Community deployments may use a monitored, compatible immutable
mirror; see
[Community LaTeX runtime](../runtimes/latex.md). These settings have no effect
in a Typst-only distribution.

Durable processing limits and lease/transfer durations live under
`document_processing` in the deployment TOML. Review PostgreSQL growth, worker
CPU/memory, `/work` ephemeral storage, ingress timeouts, and termination grace
together before raising them.

External Git checkpoints and branch imports are asynchronous: each request
records a durable queue item instead of keeping an HTTP request open for a
clone/pull/push. `EXTERNAL_GIT_COMMAND_TIMEOUT_SECONDS`
defaults to 600 seconds for each authenticated Git command, and transient
failures enter bounded retry. Inbound concurrency and repository limits use
`EXTERNAL_GIT_INBOUND_WORKER_*` and `EXTERNAL_GIT_IMPORT_MAX_*`. Direct Git
smart-HTTP traffic waits for the Git subprocess and post-push Workspace apply;
`GIT_HTTP_BACKEND_TIMEOUT_SECONDS` bounds the subprocess at 120 seconds by
default. The ingress timeout must still accommodate the largest supported
clone, pull, or push without exceeding that application deadline. Direct-Git
request bodies are currently buffered; subprocess output is spooled to a
temporary file and streamed to the client. Memory capacity therefore remains
part of request-limit review, while temporary-disk capacity bounds responses.
Drain interrupts and reaps active Git subprocesses. External jobs persist their
normal recovery state; receive-pack completes its repair before quiescence.

## Health, startup, and rollout

- `GET /health` is liveness for the reached process.
- `GET /ready` returns `200` only while Core is not draining, PostgreSQL
  responds within one second, and the required data and Git paths are
  directories. Drain changes it to `503`.
- Startup validates the distribution schema and referenced catalog/templates,
  connects to PostgreSQL, runs migrations, and binds the listener before
  starting background owners.
- A malformed capability set or a missing required artifact fails startup
  instead of silently falling back.
- On `SIGTERM`, Core fences new work, drains admitted work for at most
  `CORE_DRAIN_TIMEOUT_SECONDS`, and closes Collaboration sockets with code
  `1012`.
- Set the platform termination grace period above the drain timeout. Compose
  uses 35 seconds for the default 30-second drain; increase both together.
- Roll out an immutable image, wait for readiness, and verify `/v1/auth/config`
  reports the expected `distribution_id` and `enabled_project_types`.
- For processing, deploy Core with the new exact contract allowlist before the
  worker, verify the authenticated capability changes from `waiting` to
  `available`, run one real build and artifact download, then drain old worker
  sessions. Roll back worker capacity before removing its still-admitted
  contract from Core.
- For a Typst-only image, also verify the project creation UI has no type
  selector and the image contains no `/app/web-dist/busytex` directory.

## Database compatibility

The first Community release starts at
`backend/migrations/202607120001_baseline.sql`. It does not support an in-place
upgrade from an earlier or unrelated migration history. The first deployment
on this line requires an empty PostgreSQL database and a new
`DATA_DIR`/`GIT_STORAGE_PATH`; reusing an older Git volume with a fresh database
leaves unowned repositories and is not a supported migration path.

An earlier database can contain the same SQLx migration version with a
different checksum. The resulting startup failure is intentional. Do not edit
`_sqlx_migrations`, mark the baseline as applied manually, or run it against an
already populated schema. Export required content before the cutover and keep
the old database and Git volume as one recoverable backup.

The baseline is immutable. After the first Community release, existing
Community databases apply only newer forward migrations, and releases that
change storage schemas require both fresh-install and supported-upgrade tests.
Back up PostgreSQL and persistent Git data before such a release. Object
storage should use its own versioning and backup policy.

## Deployment overlay boundary

Application behavior and generic image construction live in this repository.
A deployment repository owns its namespace and orchestration resources,
Services, ingress and domains, resource requests and limits, immutable image
reference, Secrets, volumes, and live rollout state. Exact live values belong
in that repository and cluster rather than in the Community application Wiki.

## Related

- [Configuration index](../configuration/README.md)
- [Architecture overview](../architecture/overview.md)
- [Durable document processing](../architecture/document-processing.md)
- [Single-replica release resilience](../architecture/release-resilience.md)
- [Typst runtime](../runtimes/typst.md)
- [Native LaTeX worker](../runtimes/latex-worker.md)
- [Decision: Community database baseline](../decisions/0007-community-database-baseline.md)
