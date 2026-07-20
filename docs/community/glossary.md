---
title: "Glossary"
summary: "Canonical vocabulary for projects, collaboration, durable processing, Git, external providers, and distributions."
status: current
type: reference
scope: community
audience:
  - contributor
  - operator
  - product
  - coding-agent
topics:
  - terminology
  - workspace
  - versioning
  - external-git
  - document-processing
  - release-resilience
related:
  - docs/community/product/overview.md
  - docs/community/architecture/overview.md
  - docs/community/architecture/release-resilience.md
  - docs/community/architecture/document-processing.md
  - docs/community/architecture/external-repositories.md
  - docs/community/reference/worker-protocol.md
code_paths:
  - backend/src/workspace
  - backend/src/versioning
  - backend/src/external_repositories
  - backend/src/document_processing
  - backend/src/distribution
  - backend/src/process_lifecycle.rs
  - backend/src/protocol_compatibility.rs
  - web/src/pages/processing
  - workers/processing-sdk
---

# Glossary

Use these terms consistently in code, UI copy, and documentation.

| Term | Meaning |
| --- | --- |
| Project | The access-controlled product aggregate containing a typed file tree, settings, collaboration state, and history. |
| Workspace | The current editable state of a project. It is the live source of truth during normal editing. |
| Document | A UTF-8 text file stored in Workspace and edited collaboratively when active. |
| Asset | A binary project file. Its metadata is in PostgreSQL; bytes are inline or in S3-compatible storage. |
| Revision | A local Git commit representing a historical project state. Revision IDs are commit OIDs. |
| Flush | Materializing a Workspace snapshot into the local Git repository and creating a revision when required. |
| Direct Git | The platform's project-scoped Git smart-HTTP endpoint, authenticated with a personal access token. |
| External repository | A repository hosted by a configured GitHub, GitLab, Gitea, or Forgejo-compatible service. |
| Checkpoint | An owner-requested outbound push from the platform to a linked external repository's managed branch. It is not an autosave. |
| Import | Creating a new platform project from an external repository branch. |
| Inbound sync | Replacing an already linked Workspace from an external branch after validating and staging the complete snapshot. |
| Provider instance | One deployment-configured external repository service, identified by a stable `ProviderInstanceId`. Multiple instances may use the same adapter kind. |
| Provider kind | The protocol/API adapter: `github`, `gitlab`, `gitea`, or `forgejo`. |
| Provider brand | Explicit presentation metadata used for logos and colors. It never selects an adapter. |
| Repository connection | One platform user's OAuth grant for one configured provider instance. A user may connect multiple provider instances. |
| Project link | The association between one project, one provider instance, one external repository, and the platform user whose grant performs background work. |
| Distribution | A versioned JSON configuration plus assets and content that selects product identity, supported project types, frontend build bounds, and allowed processing operations. |
| Built-in template | An immutable project source loaded from the active distribution. Instantiation creates an independent project. |
| Personal template | An ordinary project marked by its owner as a reusable template and listed in the Gallery. Copies are independent. |
| Content epoch | A Workspace generation value used to reject writes from a client opened before destructive content replacement. |
| Collaboration revision | The generation of one immutable document identity's Yjs state. It changes when authoritative replacement supersedes the stream. |
| Access epoch | A project authorization generation used to invalidate realtime clients after grants change. |
| Core drain | The monotonic process state that fences new work and gives admitted work one deadline to settle before exit. |
| Protocol epoch | An internal first-party Web/Core incompatibility fence. It is not a public API version or release number. |
| Browser compiler worker | A browser Web Worker that owns an interactive Typst or BusyTeX compiler session. It is part of live preview and local export, not durable server processing. |
| Processing operation | A Core-known, versioned transformation contract such as `latex.compile.pdf/v1`, with typed input, options, result, permission, and finalization rules. |
| Processing job | The requester-visible durable aggregate for one explicit processing operation. It owns immutable input, lifecycle, cancellation, failure, and published artifacts. |
| Processing attempt | One fenced execution lease for a processing job. Infrastructure failures may create another attempt without creating another user job. |
| Processing worker | An independently deployed agent that advertises approved processor contracts, pulls leased work, and executes a processor in a bounded sandbox. It has no application database or object-store credential. |
| Processor contract | The exact implementation identity for a processing runtime, including toolchain, packages, fonts, flags, sandbox policy, and result rules. It is distinct from protocol and operation versions. |
| Processing artifact | An immutable result published by Core for a succeeded processing job and downloadable while authorization and retention permit. It is distinct from a browser-generated or Workspace-owned PDF artifact. |
| Task center | The account-scoped frontend projection of active and recent processing jobs. It is a global presentation surface, not a new business-level job owner. |

Avoid using “sync” without a qualifier. Say **Yjs collaboration**, **Workspace
delta refresh**, **local Git flush**, **external checkpoint**, or **inbound
sync**. Avoid using “worker” without distinguishing a **browser compiler
worker**, an in-process context-owned background loop, or a **processing
worker**.

## Related

- [Product model](./product/overview.md)
- [Architecture overview](./architecture/overview.md)
- [Single-replica release resilience](./architecture/release-resilience.md)
- [Durable document processing](./architecture/document-processing.md)
- [Worker protocol](./reference/worker-protocol.md)
- [External repositories](./architecture/external-repositories.md)
- [Versioning](./architecture/versioning.md)
