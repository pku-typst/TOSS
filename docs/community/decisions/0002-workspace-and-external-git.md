---
title: "ADR-0002: Workspace authority and manual external Git"
summary: "Treat platform workspace state as authoritative and make repository import, sync, and checkpoint explicit."
status: accepted
type: decision
scope: community
audience:
  - contributor
  - operator
  - coding-agent
topics:
  - workspace
  - external-git
  - synchronization
related:
  - docs/community/architecture/external-repositories.md
  - docs/community/architecture/versioning.md
  - docs/community/product/overview.md
code_paths:
  - backend/src/external_repositories
  - backend/src/workspace
  - backend/src/versioning
---

# ADR-0002: Workspace authority and manual external Git

## Decision

The platform workspace is authoritative during collaboration. Import creates a
new project; inbound sync atomically replaces a linked project from a selected
branch; checkpoint writes the current workspace to the managed external branch.
These actions are explicit and owner-controlled. Ordinary edits do not produce
external commits.

## Consequences

- collaborators do not need write access to the owner's repository;
- provider outages do not stop normal editing when platform storage is healthy;
- durable jobs can retry long Git/LFS work without holding an HTTP request;
- inbound replacement needs generation checks so stale editors cannot restore
  old content;
- local Git revisions and external repository history have different purposes.

## Related

- [External repositories](../architecture/external-repositories.md)
- [Versioning](../architecture/versioning.md)
- [Product overview](../product/overview.md)
