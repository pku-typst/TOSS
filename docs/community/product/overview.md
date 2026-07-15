---
title: "Product model"
summary: "User-visible capabilities, distributions, project lifecycle, and durability guarantees."
status: current
type: overview
scope: community
audience:
  - product
  - contributor
  - operator
  - coding-agent
topics:
  - product
  - distributions
  - collaboration
  - durability
  - document-processing
related:
  - docs/community/glossary.md
  - docs/community/architecture/overview.md
  - docs/community/architecture/document-processing.md
  - docs/community/architecture/versioning.md
  - docs/community/architecture/external-repositories.md
  - docs/community/runtimes/latex-worker.md
code_paths:
  - distributions/community/toss.json
  - distributions/community/help
  - backend/src/workspace
  - backend/src/collaboration
  - backend/src/versioning
  - backend/src/external_repositories
  - backend/src/document_processing
  - web/src/pages/processing
  - workers/latex
---

# Product model

The Community product is a self-hosted collaborative typesetting platform
centered on Typst.
It combines a multi-file editor, browser compilation, realtime collaboration,
project access control, local revision history, explicit durable document
processing, templates, and deliberate external-repository transfer in one
same-origin application.

## Distributions

The default Community distribution provides neutral, administrator-managed
identity, Typst and optional LaTeX projects, public-safe templates, and a public
package catalog. A deployment may define another distribution to select
branding, content, runtime catalog, project types, durable processing
operations, and external-checkpoint naming without branching core product code.
An enabled processing operation still requires an operator-provisioned,
compatible worker identity in the deployment TOML; contracts remain in that
non-secret topology and token contents remain in mounted secret files. See
[Distribution configuration](../configuration/distributions.md).

## Compilation and durable processing

Interactive compilation and durable processing are different product actions:

| Behavior | Interactive preview and local PDF | Durable LaTeX PDF build |
| --- | --- | --- |
| Trigger | Editing or the preview download control | Explicit **Build PDF in background** action |
| Runtime | Persistent Typst or BusyTeX worker in the browser | Optional native TeX Live worker isolated from Core |
| Input | Current browser Workspace projection | Immutable server-accepted project snapshot captured at submission |
| Lifetime | Tied to the browser session | Continues after the initiating tab closes |
| Result | Canvas preview or immediate local download | Retained artifact exposed through the account task center |
| Capacity | Uses the user's device | May queue, become temporarily unavailable, or be omitted by the deployment |

The native path is a compatibility and durability feature, not a preferred
compiler or preview fallback. Submitting it intentionally transfers the
captured project bundle through Core to an authenticated processing worker.
The worker receives only scoped input/output capabilities, not application,
database, object-store, or external-provider credentials. Edits accepted after
capture belong to the next build, so the artifact always represents one fixed
snapshot.

## User-visible invariants

- Typst and optional LaTeX interactive compilation run in browser workers.
  Ordinary editing never invokes a server compiler.
- Durable processing is always an explicit action. It never races, prefers,
  hedges, or silently replaces browser compilation.
- Processing jobs and artifacts are account-scoped and remain visible in the
  global task center while retained. Current project access is rechecked before
  a job is shown or an artifact is downloaded.
- Missing or saturated native worker capacity may queue or disable a durable
  action, but it never disables browser preview or local PDF export.
- Text edits are applied to the platform Workspace automatically. Realtime
  Yjs state is persisted by the backend and survives reconnects.
- The Workspace is authoritative during ordinary editing. External Git is not
  on the synchronous save path.
- Every project has local Git-backed revision history. Direct Git access and
  external repository integration are separate features.
- External import, inbound sync, and outbound checkpoints are explicit user
  actions. Ordinary edits never create provider commits automatically.
- A template creates an independent project. Future template changes never
  rewrite existing projects.
- Project access is enforced by the backend for REST, WebSocket, and Git
  boundaries; runtime package endpoints separately require a signed-in session.
  UI visibility is not the security boundary.

## Project lifecycle

1. A signed-in user creates a blank project, instantiates a Gallery template,
   copies an accessible project template, or imports a repository branch.
2. Members edit the Workspace through project roles, organization grants, or a
   scoped share session.
3. For a supported project, a signed-in member may explicitly capture the
   accepted Workspace state as a durable processing job. Editing continues;
   the resulting artifact remains tied to that immutable snapshot.
4. The Versioning context periodically flushes dirty Workspace state into the
   project's local Git repository. Users may also request a named revision.
5. The owner may connect an external repository. Collaborators do not need
   provider write permission; background jobs use the connector's grant.
6. The owner may request an outbound checkpoint or a destructive inbound
   sync. Both are durable asynchronous jobs and never block ordinary editing.

## Durability model

| Data | Primary live store | Recovery or portability path |
| --- | --- | --- |
| Accounts, access, text, settings, Yjs state, and Workspace PDF artifacts | PostgreSQL | Database backup |
| Processing jobs, immutable inputs, staged results, and published processing artifacts | PostgreSQL | Task-center download while retained; database backup |
| Local revisions and thumbnails | Persistent application volume | Coordinated volume backup |
| Binary assets | S3-compatible storage when configured, otherwise PostgreSQL | Object-store or database backup; explicit external checkpoint |
| External provider history | Provider repository after an explicit checkpoint | Provider-native backup and policy |

A deployment may treat platform-only projects as working copies and an
external repository as its long-term portability boundary. That policy is not
a core requirement: Community deployments may expose several repository
providers or none.

Processing artifacts are not a permanent publication archive. The deployment
controls queue expiry and retention; users should download important output or
publish it through their normal source/release workflow before it expires.

## Related

- [Glossary](../glossary.md)
- [Architecture overview](../architecture/overview.md)
- [Durable document processing](../architecture/document-processing.md)
- [Native LaTeX worker](../runtimes/latex-worker.md)
- [Versioning](../architecture/versioning.md)
- [External repositories](../architecture/external-repositories.md)
- [Decision: Workspace and external Git](../decisions/0002-workspace-and-external-git.md)
