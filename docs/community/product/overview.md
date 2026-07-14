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
related:
  - docs/community/glossary.md
  - docs/community/architecture/overview.md
  - docs/community/architecture/versioning.md
  - docs/community/architecture/external-repositories.md
code_paths:
  - distributions/community/toss.json
  - backend/src/workspace
  - backend/src/collaboration
  - backend/src/versioning
  - backend/src/external_repositories
---

# Product model

The Community product is a self-hosted collaborative typesetting platform
centered on Typst.
It combines a multi-file editor, browser compilation, realtime collaboration,
project access control, local revision history, templates, and deliberate
external-repository transfer in one same-origin application.

## Distributions

The default Community distribution provides neutral, administrator-managed
identity, Typst and optional LaTeX projects, public-safe templates, and a public
package catalog. A deployment may define another distribution to select
branding, content, runtime catalog, project types, and external-checkpoint
naming without branching core product code. Credentials remain in
environment-backed secrets. See
[Distribution configuration](../configuration/distributions.md).

## User-visible invariants

- Typst and optional LaTeX compilation run in browser workers. Source is not
  sent to a second compilation service.
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
3. The Versioning context periodically flushes dirty Workspace state into the
   project's local Git repository. Users may also request a named revision.
4. The owner may connect an external repository. Collaborators do not need
   provider write permission; background jobs use the connector's grant.
5. The owner may request an outbound checkpoint or a destructive inbound
   sync. Both are durable asynchronous jobs and never block ordinary editing.

## Durability model

| Data | Primary live store | Recovery or portability path |
| --- | --- | --- |
| Accounts, access, text, settings, Yjs state, jobs | PostgreSQL | Database backup |
| Local revisions and thumbnails | Persistent application volume | Coordinated volume backup |
| Binary assets | S3-compatible storage when configured, otherwise PostgreSQL | Object-store or database backup; explicit external checkpoint |
| External provider history | Provider repository after an explicit checkpoint | Provider-native backup and policy |

A deployment may treat platform-only projects as working copies and an
external repository as its long-term portability boundary. That policy is not
a core requirement: Community deployments may expose several repository
providers or none.

## Related

- [Glossary](../glossary.md)
- [Architecture overview](../architecture/overview.md)
- [Versioning](../architecture/versioning.md)
- [External repositories](../architecture/external-repositories.md)
- [Decision: Workspace and external Git](../decisions/0002-workspace-and-external-git.md)
