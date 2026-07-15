---
title: "Architecture overview"
summary: "Runtime topology, data ownership, bounded contexts, and the main cross-context flows."
status: current
type: architecture
scope: community
audience:
  - contributor
  - operator
  - coding-agent
topics:
  - architecture
  - modular-monolith
  - storage
  - boundaries
  - document-processing
related:
  - docs/community/architecture/frontend.md
  - docs/community/architecture/backend.md
  - docs/community/architecture/collaboration.md
  - docs/community/architecture/versioning.md
  - docs/community/architecture/external-repositories.md
  - docs/community/architecture/identity-and-access.md
  - docs/community/architecture/document-processing.md
code_paths:
  - backend/src/server
  - backend/src/app_state.rs
  - backend/src
  - web/src
  - workers
  - protocol/worker-openapi.json
---

# Architecture overview

The product is a same-origin browser application backed by a Rust modular
monolith. Browser compilation is part of the product architecture, not an
optimization layered over a server compiler.

```text
Browser
  React + CodeMirror + Yjs
  Typst / optional LaTeX browser workers -> canvas preview and local PDF
          |
          | REST + WebSocket + Git smart HTTP
          v
Rust / Axum application
  access | workspace | collaboration | versioning | templates
  external repositories | document processing | experience | runtime support
       |                 |                     |
       v                 v                     v
  PostgreSQL      persistent filesystem    S3-compatible storage
                         |
                         +---- explicit import/checkpoint ---- external provider

Optional native processor ---- authenticated pull/leases ---- document processing
```

The Core production image contains the backend, precompressed SPA, migrations,
one selected distribution, and its allowed built-in runtime assets. Optional
native processors are built and deployed as separate images.

## Runtime stores

| Store | Owned state | Failure effect |
| --- | --- | --- |
| Browser memory and IndexedDB | Active Yjs state, account-scoped Workspace snapshots, compiler/runtime caches | The active tab may continue locally; clearing site data requires rebootstrap and runtime downloads |
| PostgreSQL | Identity, sessions, access, project metadata, text documents, Yjs logs/snapshots, asset metadata, PDF artifacts, processing blobs, and job state | Application cannot provide authoritative editing, authorization, or durable processing |
| Persistent filesystem | Local Git repositories, revision history, thumbnails, and optional package caches | Live database text may remain, but local Git history or thumbnails are unavailable |
| S3-compatible storage | Project asset bytes when configured | Text editing continues; affected asset operations fail |
| External provider | Repository state after explicit import or checkpoint | Ordinary Workspace editing continues |

S3 is optional. Without it, project asset bytes are stored inline in
PostgreSQL. PDF artifacts currently remain in PostgreSQL even when S3 is
configured.

## Bounded contexts

| Context | Owns |
| --- | --- |
| Workspace | Projects, file trees, documents, assets, settings, thumbnails, archives, PDF artifacts, and content generations |
| Collaboration | Yjs persistence, realtime rooms, presence, cursors, and project invalidation events |
| Versioning | Local Git state, revisions, Workspace flushes, direct Git smart HTTP, and per-project Git locking |
| External repositories | Provider grants and adapters, repository links, discovery, inbound jobs, and outbound checkpoints |
| Identity and access | Accounts, sessions, OIDC, organizations, roles, grants, share links, guests, and personal access tokens |
| Templates | Gallery discovery, built-in instantiation, personal-template publication, and template sharing policy |
| Experience | Product identity, landing and Help content, assets, and resource visibility |
| Document Processing | Explicit durable jobs, immutable inputs, attempts/leases, worker capacity, staged and published artifacts, cancellation, and retention |

Distribution loading, Typst/LaTeX runtimes, object storage, cleanup, audit, and
server composition support these contexts but do not own product aggregates.

## Main flows

### Normal editing

1. Access authorizes the project and effective write capability.
2. Workspace provides the tree, settings, document identities, and asset
   catalog.
3. Collaboration bootstraps the active document's Yjs generation and persists
   accepted updates before broadcasting them.
4. Workspace mutations publish a scoped committed invalidation.
5. Versioning records the project as dirty and later flushes a coherent
   Workspace snapshot into local Git.

### Project creation

Ordinary creation, template instantiation, copy, and external import all use
the Workspace project-provisioning transaction. The process composes the
project graph, initial Access owner grant, and Versioning initialization rather
than letting each caller reproduce their SQL.

### Destructive content replacement

Inbound external sync and accepted direct-Git pushes validate a complete
snapshot before Workspace atomically replaces documents, directories, assets,
the entry-file setting, and content generation. Collaboration state for the
old generation is cleared in the same database transaction. Runtime object
cleanup and client invalidation happen after commit through their owning
capabilities.

### External checkpoint

An owner request creates a durable job. The worker asks Versioning for the
target local commit, resolves the link and connector grant through External
Repositories, and pushes only the managed provider branch. Provider network
I/O never sits in the Workspace transaction.

## Document processing

ADR-0008 introduced the Document Processing bounded context for explicit jobs
that must outlive a browser session, beginning with native LaTeX-to-PDF. The
application owns job policy and durable state while independent pull workers
own processor execution. Workers receive immutable input bundles and
short-lived transfer capabilities; they do not receive database or
object-store credentials.

This capability does not put a server compiler into the interactive preview
path or change the single-application-replica constraint. Omitting all worker
identities preserves the browser product while making durable operations
unavailable.

## Deployment constraint

Run one application replica. Realtime fan-out and Git locks are process-local.
Horizontal scaling requires both a shared event bus and distributed locking for
project repositories; a shared database, volume, or sticky sessions alone is
not sufficient.

## Related

- [Backend architecture](./backend.md)
- [Frontend architecture](./frontend.md)
- [Collaboration](./collaboration.md)
- [Versioning](./versioning.md)
- [External repositories](./external-repositories.md)
- [Durable document processing](./document-processing.md)
- [Deployment](../operations/deployment.md)
