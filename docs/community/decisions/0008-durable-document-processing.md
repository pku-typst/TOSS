---
title: "ADR-0008: Durable document processing workers"
summary: "Keep interactive compilation in the browser while adding explicit durable document-processing jobs through isolated capability workers."
status: accepted
type: decision
scope: community
audience:
  - contributor
  - operator
  - coding-agent
topics:
  - background-jobs
  - document-processing
  - workers
related:
  - docs/community/decisions/0001-browser-compilation.md
  - docs/community/decisions/0006-defer-background-rendering.md
  - docs/community/architecture/document-processing.md
  - docs/community/reference/worker-protocol.md
  - docs/community/runtimes/latex-worker.md
code_paths:
  - backend/src
  - backend/migrations
  - protocol
  - web/src
  - workers
---

# ADR-0008: Durable document processing workers

## Decision

Interactive Typst and LaTeX compilation remains exclusively browser-side. The
server does not race, prefer, hedge, or silently replace a browser compiler in
the editing loop.

Community TOSS adds a separate Document Processing bounded context for
explicit work that must survive a browser session, run under a controlled
runtime, or produce a durable artifact. The context owns immutable inputs,
jobs, attempts, leases, quotas, cancellation, artifacts, and capability
availability. Execution occurs in separately deployed workers through a
versioned pull protocol; workers do not connect to the application database or
receive object-storage credentials.

The first Community processor is a native LaTeX-to-PDF worker built from a
pinned TeX Live distribution and `latexmk`. The operation registry reserves
versioned project-export and file-import identifiers as extension points, but
their public endpoints, typed schemas, finalizers, and processors must land
before any distribution enables them.

## Boundaries

- Submitting a background job is always an explicit user or automation action.
- A job is never a preview preference, live-preview fallback, or compiler
  priority selector.
- Product operations are closed, versioned domain contracts. A worker may
  implement a known operation; it cannot invent an arbitrary command or JSON
  payload at runtime.
- PostgreSQL remains the durable queue, but only the owning backend context
  accesses its tables.
- Workers pull scoped claims over an internal protocol and use expiring transfer
  tickets for immutable inputs and staged outputs.
- Every attempt has a unique claim identifier that fences heartbeat, progress,
  failure, and completion writes.
- Untrusted document execution requires a per-job sandbox. Clearing environment
  variables or disabling shell escape alone is not an isolation boundary.
- Capacity, queue, runtime, and retention limits are deployment policy rather
  than user-selectable compiler priority.

## Why this is a distinct product outcome

ADR-0006 rejected server rendering because a second compiler lane added a large
control plane without producing a distinct outcome in the low-latency editing
loop. Durable processing has different requirements: it may outlive the tab,
produce an auditable artifact, run a native compatibility toolchain, import a
file into a new project, or execute under automation. Those outcomes justify a
queue and worker boundary without weakening the browser-first decision.

## Rejected alternatives

### Restore the Typst render-worker spike

The spike correctly explored immutable snapshots, leases, and artifact
provenance, but it coupled the queue to one Typst/PDF operation, placed the
lifecycle under Workspace, gave workers direct database and object-storage
access, and surfaced job state inside the preview component. It is historical
evidence, not the implementation base for this decision.

### Give every processor direct PostgreSQL access

This makes private or independently released processors part of the database
and migration trust boundary. It also lets a compromised document runtime reach
authoritative application state. A worker protocol is more work initially but
keeps persistence, authorization, and final publication inside Community Core.

### Introduce a general message broker

Redis, NATS, RabbitMQ, or a hosted queue would add an installation dependency
without removing the need for PostgreSQL-owned job state, authorization,
idempotency, and artifact finalization. PostgreSQL row locking is sufficient for
the initial queue; workers use HTTP long polling rather than database polling.

### Allow arbitrary command plugins

An executable command plus untyped options moves business validation into
deployment configuration and makes result publication impossible to audit.
New product semantics require a reviewed operation contract. Existing
operations remain extensible at the processor boundary.

### Reuse mutable project build directories

Cross-job auxiliary files introduce invalidation, confidentiality, worker
affinity, and fencing problems. The initial LaTeX worker starts from a clean
build directory. Exact repeat work is eliminated by immutable artifact caching,
not by sharing writable compiler state.

## Consequences

- Community Core has a durable job context and a service-to-service protocol.
- Community builds an optional LaTeX worker image separately from the API
  image.
- A deployment can omit all workers and retain the existing browser product.
- A configured but temporarily unavailable worker may leave an explicit job
  waiting within bounded queue and expiry policy; no browser action is silently
  reported as its replacement.
- Downstream processors can use a public worker SDK without inheriting database,
  object-storage, or application source internals.
- The frontend gains contextual submit actions and one global task center;
  processing state does not enter the compiler actor, Workspace session, or
  preview reducer.
- ADR-0006 is superseded for durable document processing. Its rejection of
  server participation in the interactive loop remains in force through
  ADR-0001 and this decision.

## Related

- [Browser-side compilation](./0001-browser-compilation.md)
- [Superseded deferral decision](./0006-defer-background-rendering.md)
- [Document processing architecture](../architecture/document-processing.md)
- [Worker protocol](../reference/worker-protocol.md)
- [LaTeX worker runtime](../runtimes/latex-worker.md)
