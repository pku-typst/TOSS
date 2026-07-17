---
title: "Versioning and direct Git"
summary: "Local Git revision history, Workspace flushes, direct smart-HTTP transport, and concurrency policy."
status: current
type: architecture
scope: community
audience:
  - backend-contributor
  - operator
  - coding-agent
topics:
  - git
  - revisions
  - autosave
  - smart-http
related:
  - docs/community/architecture/overview.md
  - docs/community/architecture/external-repositories.md
  - docs/community/product/overview.md
  - docs/community/architecture/release-resilience.md
  - docs/community/operations/deployment.md
code_paths:
  - backend/src/versioning
  - backend/src/workspace/revision_paths.rs
  - backend/src/access/personal_token.rs
---

# Versioning and direct Git

Every project has one local Git repository. Git commits are the revision model;
the UI does not read a parallel database snapshot history. A revision ID is a
commit OID.

## Workspace flush

- Document, asset, tree, and settings changes mark Versioning state dirty and
  record contributing authenticated or guest authors.
- The background flush worker creates a local commit after the configured
  autosave interval. A manual revision request flushes immediately with the
  supplied summary.
- Contributors are represented through deterministic commit identity and
  `Co-authored-by` trailers. Named guests are marked unverified.
- Materialization writes a complete Workspace snapshot in a same-filesystem
  staging directory before replacing the worktree.
- Project paths reserve every case variant of `.git` so content can never
  address repository metadata.

Flush completion compares the captured Workspace version while holding the
project lock. An edit that arrived during materialization remains pending for
the next commit; completion of an older snapshot cannot clear newer dirty or
contributor state.

## Revision reads

The revision list walks Git history. Opening a revision reads its tree into a
read-only transfer artifact. Nearby revisions may use an anchor/delta transfer;
the result is still a projection of Git trees, not a second history store.

Text and binary entries are kept distinct at the Workspace/Versioning boundary.
Git bytes never masquerade as object-store records, and Workspace callers do
not interpret repository internals.

## Direct Git smart HTTP

The project-scoped Git endpoint delegates protocol transport to
`git http-backend`. The generated URL includes the platform username as a Basic
Auth hint; the personal access token in the password position authenticates the
request. Clone and fetch require project read access, while receive-pack/push
requires the project owner.

Policy around receive-pack is application-owned:

- force and stale non-fast-forward pushes are rejected;
- the Workspace version is captured before Git receives data;
- successful receive-pack content is validated and applied with a
  compare-and-swap against that captured version;
- concurrent browser edits therefore cannot be overwritten by an in-flight
  push;
- if post-receive processing fails, Versioning restores the default ref and
  worktree and restores the pre-push Workspace snapshot when it is safe.

CGI headers and stderr are bounded. Output is spooled and streamed rather than
retained as one unbounded response. `GIT_HTTP_BACKEND_TIMEOUT_SECONDS` bounds
the subprocess. Drain interrupts and reaps an admitted backend, then uses the
normal receive-pack recovery path when required.

## Locking and storage

Git worktrees are mutable filesystem state. All project Git operations use the
Versioning-owned process-local project lock. The repository volume must be
persistent and backed up with PostgreSQL as one logical recovery point.

This lock is one reason the application supports one replica. Shared storage
does not turn a process-local mutex into distributed coordination. See
[Single-replica release resilience](./release-resilience.md) for interrupted
Git recovery.

## Relationship to external repositories

Direct Git exposes the platform's own local repository. External repository
checkpoints are separate durable jobs that ask Versioning for a target local
commit and then push through a configured provider. A direct Git push is not an
external checkpoint, and normal Workspace flushes are never pushed
automatically.

## Related

- [External repositories](./external-repositories.md)
- [Product model](../product/overview.md)
- [Single-replica release resilience](./release-resilience.md)
- [Deployment](../operations/deployment.md)
- [Decision: Workspace and external Git](../decisions/0002-workspace-and-external-git.md)
