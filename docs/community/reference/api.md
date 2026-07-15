---
title: "API surface"
summary: "Human-oriented map of REST, realtime, Git HTTP, and administration endpoints."
status: current
type: reference
scope: community
audience:
  - contributor
  - integrator
  - coding-agent
topics:
  - api
  - rest
  - websocket
  - git
related:
  - protocol/README.md
  - docs/community/architecture/collaboration.md
  - docs/community/architecture/document-processing.md
  - docs/community/reference/worker-protocol.md
  - docs/community/architecture/error-model.md
code_paths:
  - protocol/openapi.json
  - backend/src/protocol
  - web/src/lib/api/generated.ts
---

# API surface

The Rust service exposes browser APIs, WebSocket collaboration, and Git smart
HTTP from the same origin. The generated REST authority is
[`protocol/openapi.json`](../../../protocol/openapi.json); Rust operations and wire
schemas originate in `backend/src/protocol/`, and browser declarations are
generated into `web/src/lib/api/generated.ts`. This page summarizes product
policy and does not replace that machine-readable contract.

Ordinary `/v1` failures use the JSON envelope
`{ "code": "...", "message": "...", "request_id": "..." }`. `code` is stable
and intended for control flow; `message` is diagnostic text and `request_id`
correlates the response with server logs. Git smart HTTP retains its native
protocol error bodies. Regeneration and compatibility rules are documented in
[Application protocols](../../../protocol/README.md).

## Health

- `GET /health`

## Authentication and public configuration

- `GET /v1/experience`
- `GET /v1/help`
- `GET /favicon.ico`
- `GET /v1/product-assets/favicon`
- `GET /v1/product-assets/touch-icon`
- `GET /v1/auth/config`
- `POST /v1/auth/local/login`
- `POST /v1/auth/local/register`
- `GET /v1/auth/oidc/login`
- `GET /v1/auth/oidc/callback`
- `GET /v1/auth/gitlab/login`
- `GET /v1/auth/gitlab/callback`
- `GET /v1/auth/external-git/{provider_id}/login`
- `GET /v1/auth/me`
- `POST /v1/auth/logout`

`GET /v1/auth/config` returns sanitized runtime policy and distribution fields,
including `distribution_id`, `enabled_project_types`, product branding,
anonymous-access policy, and an ordered `identity_providers` list. It never returns config
paths, client secrets, token encryption keys, or credentials.

`GET /v1/experience` returns product identity, localized landing content, and
resources visible to the current request. `GET /v1/help` returns localized
Markdown topics plus the same filtered resources. Both endpoints are public,
but entries marked `authenticated` in the distribution are returned only when
the request carries a valid session. Their responses use `Cache-Control:
private, no-store` and `Vary: Cookie, Authorization`. Product asset responses
are passive, size-bounded distribution files and are sent with `nosniff`.

The `oidc` and `gitlab` login/callback route pairs currently drive the same
configured OIDC client. They are naming aliases, not independent providers.
The parameterized login route starts a configured external-provider login such
as a GitHub App web flow. It returns through the provider instance's shared
`/v1/external-git/providers/{provider_id}/callback` route. Only instances with
login enabled appear in `identity_providers`.

## Realtime collaboration

- `GET /v1/realtime/auth/{project_id}`
- `GET /v1/realtime/ws/{doc_id}?project_id={uuid}&collaboration_revision={revision}`
- `GET /v1/realtime/projects/{project_id}`

The WebSocket handshake accepts the current authenticated session, share token,
or named guest session. The server re-evaluates project access before upgrade.

Event kinds include:

- `bootstrap.done`;
- `yjs.sync`, `yjs.update`, and `yjs.ack`;
- `presence.join`, `presence.leave`, `presence.meta`, and `presence.cursor`;
- `workspace.changed` after a committed document, tree, settings, or asset
  mutation; the payload contains a `scope`, nullable affected `path`, and a
  collaboration revision for document changes;
- `document.changed` when an open document binding has been superseded by a
  newer collaboration revision;
- `access.changed` when project authorization must be revalidated;
- `project.replaced` when destructive repository materialization changes the
  collaboration generation;
- `server.error` for persistence failures.

Server events contain `doc_id`, `user_id`, `kind`, `payload`, and an RFC 3339
`at` timestamp. Events originating from a live client connection also contain
`connection_id`; presence is maintained per connection and displayed per
member, so closing one of a member's tabs does not remove their other active
tabs. The editor keeps the collaborator count deduplicated by member and shows
a separate editing-session count when one member has multiple live connections.
Read-only peers participate in presence but cannot send document updates.
Access changes close the current stream and invalidate the browser's cached
project capabilities, causing a page reload through fresh authorization.
Resynchronization errors close only the affected stream and reconnect through
a new bootstrap.
Malformed or unknown events are ignored by the browser.

## Organizations and project listing

- `GET|POST /v1/organizations`
- `GET /v1/organizations/mine`
- `GET|POST /v1/projects`
- `PATCH /v1/projects/{project_id}`
- `POST /v1/projects/{project_id}/copy`
- `GET|PATCH /v1/projects/{project_id}/archive`
- `GET|PUT /v1/projects/{project_id}/thumbnail`

`POST /v1/projects` and project copy enforce the active distribution's
`enabled_project_types`. A Typst-only distribution accepts only Typst projects.

## Template gallery

- `GET /v1/templates`
- `GET /v1/templates/builtin/{template_id}/thumbnail`
- `POST /v1/templates/builtin/{template_id}/projects`

All Gallery routes require authentication. The catalog response combines
deployment-owned built-ins with accessible personal and organization-shared
project templates. Each item identifies its source, localized metadata, project
type, thumbnail state, owner when applicable, and whether the current user may
edit the source project.

Built-in instantiation accepts a project name and creates an independent normal
project from the configured directory tree. Personal/shared templates continue
to use `POST /v1/projects/{project_id}/copy`; project-template and organization
permissions remain enforced by that path.

## Project tree, documents, and settings

- `GET /v1/projects/{project_id}/tree`
- `POST /v1/projects/{project_id}/files`
- `PATCH /v1/projects/{project_id}/files/move`
- `DELETE /v1/projects/{project_id}/files/{path}`
- `GET /v1/projects/{project_id}/settings`
- `PATCH /v1/projects/{project_id}/settings/entry-file`
- `PATCH /v1/projects/{project_id}/settings/latex-engine`
- `GET|POST /v1/projects/{project_id}/documents`
- `PUT /v1/projects/{project_id}/documents/by-path/{path}`
- `GET|PUT|DELETE /v1/projects/{project_id}/documents/{document_id}`

## Assets and PDF artifacts

- `GET|POST /v1/projects/{project_id}/assets`
- `GET|DELETE /v1/projects/{project_id}/assets/{asset_id}`
- `GET /v1/projects/{project_id}/assets/{asset_id}/raw`
- `POST /v1/projects/{project_id}/pdf-artifacts`
- `GET /v1/projects/{project_id}/pdf-artifacts/latest`

Uploads are bounded by `MAX_REQUEST_BODY_BYTES`. Asset authorization always
uses the containing project, including raw-content responses. PDF upload bodies
are base64 encoded and the resulting bytes are currently stored in PostgreSQL.

## Durable document processing

- `GET /v1/processing/capabilities`
- `POST /v1/projects/{project_id}/builds`
- `GET /v1/processing/jobs`
- `GET /v1/processing/jobs/{job_id}`
- `POST /v1/processing/jobs/{job_id}/cancel`
- `GET /v1/processing/jobs/{job_id}/artifacts/{artifact_id}`

Community currently enables only `latex.compile.pdf/v1`. Build submission
requires authentication, current project read access, a LaTeX project, a
configured worker identity, and an `Idempotency-Key`; it returns `202` for a new
durable job and the existing job for an exact replay. The capability response
distinguishes `available`, configured-but-offline `waiting`, and `unavailable`.

Job lists are requester-owned and recheck current project access. Cancellation
is allowed during preparation, queueing, and active execution, but not after
Core accepts delivery into finalization. Artifact downloads reauthorize the
requester and containing project on every request. Internal worker routes and
their separate generated contract are documented in
[Worker protocol](./worker-protocol.md); browser clients must not call them.

## Revisions

- `GET|POST /v1/projects/{project_id}/revisions`
- `GET /v1/projects/{project_id}/revisions/{revision_id}/documents`

Revision IDs are local Git commit OIDs. Revision document responses support
incremental anchors used by the workspace to avoid retransferring unchanged
files/assets when moving between nearby history states.

## Sharing, roles, templates, and organizations

- `GET|POST /v1/projects/{project_id}/roles`
- `GET /v1/projects/{project_id}/access-users`
- `GET /v1/projects/{project_id}/organization-access`
- `PUT|DELETE /v1/projects/{project_id}/organization-access/{org_id}`
- `GET|POST /v1/projects/{project_id}/group-roles`
- `DELETE /v1/projects/{project_id}/group-roles/{group_name}`
- `PUT /v1/projects/{project_id}/template`
- `GET /v1/projects/{project_id}/template-organization-access`
- `PUT|DELETE /v1/projects/{project_id}/template-organization-access/{org_id}`
- `GET|POST /v1/projects/{project_id}/share-links`
- `DELETE /v1/projects/{project_id}/share-links/{share_link_id}`
- `GET /v1/share/{token}/resolve`
- `POST /v1/share/{token}/join`
- `POST /v1/share/{token}/temporary-login`

Share-link redemption by a signed-in user creates a durable project role. Named
temporary guests receive a scoped, expiring project session. Revoking a link
prevents new use; project roles already granted to authenticated users remain
visible to the project owner.

## Typst and optional LaTeX runtime assets

- `GET /v1/typst/packages/{namespace}/{name}/{version}`
- `GET /v1/typst/builtin/{path}`
- `GET /v1/latex/texlive/{path}`

The package endpoint serves validated built-in/seeded archives before falling
back to the configured Typst Universe source. The LaTeX TeXLive endpoint returns
`404` when the active distribution does not enable LaTeX. Typst package,
built-in asset, and TeXLive requests require an authenticated user session; a
named temporary guest session alone is not sufficient. See
[Community LaTeX runtime](../runtimes/latex.md) for proxy/cache limits.

## Direct Git smart HTTP

- `GET /v1/git/status/{project_id}`
- `GET /v1/git/repo-link/{project_id}`
- `GET|POST /v1/git/repo/{project_id}/{rest}`

Git transport requires a personal access token as the HTTP password. Clone and
fetch require project read access; push requires the project owner. Force
pushes and stale non-fast-forward updates are rejected.

## External Git connection, import, and checkpoints

- `GET|DELETE /v1/external-git/providers/{provider_id}/connection`
- `GET /v1/external-git/providers/{provider_id}/authorize`
- `GET /v1/external-git/providers/{provider_id}/callback`
- `GET /v1/external-git/providers/{provider_id}/owners`
- `GET /v1/external-git/providers/{provider_id}/repositories`
- `GET /v1/external-git/providers/{provider_id}/repositories/{repository_id}/branches`
- `POST /v1/external-git/imports`
- `GET /v1/external-git/jobs/{job_id}`
- `GET /v1/projects/{project_id}/external-git/status`
- `GET /v1/projects/{project_id}/external-git/branches`
- `POST /v1/projects/{project_id}/external-git/create`
- `POST /v1/projects/{project_id}/external-git/link`
- `POST /v1/projects/{project_id}/external-git/unlink`
- `POST /v1/projects/{project_id}/external-git/checkpoint`
- `POST /v1/projects/{project_id}/external-git/sync`

The public API uses validated provider-instance IDs and never accepts an
arbitrary clone URL. GitHub, GitLab, Gitea, and Forgejo adapters are
implemented; Codeberg uses the Forgejo protocol with explicit Codeberg brand
metadata. A deployment may configure more than one instance, including
multiple instances of one provider kind. Unlinked project operations and
imports carry an explicit provider-instance ID; linked project operations use
the provider persisted on the link. Import creates a new
project from a repository branch; sync is owner-only and replaces a linked
project from a selected branch. Checkpoint is owner-only and targets the
distribution-managed branch. Status values include `dirty`, `pending`,
`syncing`, `retry_wait`, `active`, `unlinked`, `reauth_required`, `conflict`,
and `error`.

Normal editing never calls either synchronization direction automatically.
Inbound operations return `202` with a durable job resource. The worker fetches
Git LFS, validates paths and configured size limits, stages assets, then applies
the complete project snapshot atomically.

Document upserts include `X-Project-Content-Epoch`, obtained from the project
tree response. A stale or missing generation is rejected so an editor opened
before a branch replacement cannot write the previous document back afterward.

## Profile security

- `GET|POST /v1/profile/security/tokens`
- `DELETE /v1/profile/security/tokens/{token_id}`

Personal access-token plaintext is returned once at creation. Tokens may expire
and record their last successful use.

## Administration

- `GET|PUT /v1/admin/settings/auth`
- `GET|POST /v1/admin/orgs/{org_id}/oidc-group-role-mappings`
- `DELETE /v1/admin/orgs/{org_id}/oidc-group-role-mappings/{group_name}`

Admin settings include `managed_fields`. Values owned by a distribution or
deployment policy are visible but read-only in the UI.

## Related

- [Protocol contract](../../../protocol/README.md)
- [Collaboration architecture](../architecture/collaboration.md)
- [Error model](../architecture/error-model.md)
