---
title: "Single-replica release resilience"
summary: "Contract for replacing the single application process without losing accepted work."
status: current
type: architecture
scope: community
audience:
  - operator
  - backend-contributor
  - frontend-contributor
  - coding-agent
topics:
  - deployment
  - graceful-shutdown
  - websocket
  - durability
  - resilience
related:
  - docs/community/decisions/0004-single-application-replica.md
  - docs/community/architecture/collaboration.md
  - docs/community/architecture/versioning.md
  - docs/community/operations/deployment.md
  - docs/community/development/testing.md
code_paths:
  - backend/src/process_lifecycle.rs
  - backend/src/server/runtime.rs
  - backend/src/collaboration/connection_lifecycle.rs
  - backend/src/native_process.rs
  - backend/src/protocol_compatibility.rs
  - web/src/lib/protocolCompatibility.ts
  - web/src/lib/reconnectPolicy.ts
  - web/src/lib/realtime.ts
  - web/scripts/headless-release-resilience.mjs
---

# Single-replica release resilience

TOSS runs one application replica because Collaboration fan-out and Versioning
locks are process-local. Replacing that process may briefly disconnect clients,
but must preserve accepted work and leave durable operations recoverable.

This contract does not provide multiple replicas, zero-downtime rollout, a
separate Web deployment, or protocol-range negotiation. ADR-0004 remains the
authority for the replica constraint.

## Invariants

1. Core persists a collaborative update before acknowledging it.
2. The active browser Y.Doc reconciles unacknowledged local state after
   reconnect; writable bindings also use generation-scoped IndexedDB.
3. Drain fences new ordinary requests, WebSocket mutations, and background
   claims while allowing admitted work to settle.
4. HTTP, Collaboration, and background owners share one drain deadline.
5. Native Git children are interrupted as process groups and reaped; their
   owning context performs any required repair or retry transition.
6. A replacement reconstructs state from PostgreSQL and persistent Git data,
   not predecessor memory.
7. An incompatible first-party Web build is fenced before mutation.

These properties reduce interruption; they do not keep the service available
when its only process cannot start.

## Process lifecycle

Startup validates configuration, runs migrations, and binds the listener
before starting background owners. A bind failure therefore cannot strand
newly claimed work.

Core uses one monotonic drain signal. `SIGTERM`, an interrupt, signal-listener
failure, and an unexpected end of the Axum server future enter the same
sequence:

1. mark readiness unavailable and fence new admission;
2. stop accepting connections and stop new background claims;
3. settle admitted HTTP and Collaboration work;
4. close Collaboration sockets with code `1012`; and
5. wait for all owned background tasks.

All steps share the deadline from `CORE_DRAIN_TIMEOUT_SECONDS`. On expiry, Core
logs unfinished owners, aborts remaining background tasks, and exits with an
error. After a successful drain, an original signal-listener or server error is
still returned.

| Route | Contract |
| --- | --- |
| `GET /health` | The reached process can serve the handler. |
| `GET /ready` | Core is not draining, PostgreSQL responds within one second, and required data and Git paths are directories. |

Probes do not run migrations, repairs, remote operations, or artifact fetches.
The platform termination grace period must exceed the Core drain timeout.

## Collaboration and browser recovery

Every socket atomically subscribes to its room and revalidates the effective
principal, write capability, and project generations before bootstrap. Later
access or generation changes arrive through the active room subscription.

For each accepted Yjs mutation, Core checks current generations and commits the
update before broadcasting it or queuing `yjs.ack`. During drain, a socket stops
reading new frames. Its FIFO command channel orders any queued acknowledgement
before the `1012` close. If persistence succeeds but delivery of the
acknowledgement fails, Yjs idempotency makes the next sync safe.

The browser keeps the active Y.Doc mounted across reconnect. Writable bindings
persist it under this identity:

```text
principal ID : project UUID : document UUID : collaboration revision
```

After authoritative bootstrap, the browser sends a full Yjs snapshot and then
resumes incremental updates. A different principal or collaboration revision
uses a different binding and must authorize again. Without IndexedDB, only the
active tab retains pending state.

Close code `1012` uses a fast jittered retry. Other abnormal closes use capped
exponential jitter, and the attempt counter resets only after `bootstrap.done`.
Repeated failure uses the normal connection status and manual retry UI; product
copy does not expose deployment mechanics.

## Web/Core compatibility

Web and Core ship in one image with one internal `PROTOCOL_EPOCH`; Core also
validates the Web build manifest at startup. The epoch changes only when an
already loaded first-party Web build could issue an unsafe request.

The first-party API client sends `x-toss-protocol-epoch` on REST requests and
`protocol_epoch` on realtime URLs. An explicit mismatch returns HTTP `426` with
`client_incompatible` or closes the socket with code `4406`. A missing epoch is
accepted for non-Web clients that share `/v1` routes.

The browser maps incompatibility and a changed or unverifiable Web entry to one
reload-required state. Same-build interruptions and code `1012` remain on the
automatic recovery path. The epoch is not a public API version, release
counter, feature registry, or supported-version range.

## Context-owned recovery

The process owns the deadline; each context owns its correctness rules.

| Context | Drain and recovery |
| --- | --- |
| Collaboration | Settle the accepted frame, close sockets, then bootstrap PostgreSQL and reconcile the browser Y.Doc. |
| Workspace | Finish admitted transactions; database rollback prevents partial aggregate writes. |
| Versioning | Interrupt and reap Git, repair an interrupted receive-pack, and restore coherent ref, worktree, and Workspace state. |
| External Repositories | Stop claims, interrupt Git, and persist the normal retry, lease, captured-commit, or ambiguous-result transition. |
| Document Processing | Stop claims; durable leases expire for reacquisition while stale finalization tokens remain fenced. |
| Object cleanup | Finish or defer the current durable item. |

Background loops observe the shared drain signal directly. Native process
wrappers terminate and await their process groups on every non-success path.

## Verification and observability

`npm --prefix web run test:release-resilience` replaces Core while two browser
contexts edit one project. It covers acknowledged and pending Yjs state,
document and control reconnect, Git recovery, graceful exit, drain timeout, and
optional processing-claim recovery. Focused owner tests cover subprocess
reaping, receive-pack repair, durable job fencing, room-admission races,
compatibility, and reconnect timing. See [Testing](../development/testing.md)
for prerequisites and the full validation workflow.

Core logs the configured deadline, drain reason, duration, and unfinished owner
names. Logs must not contain document content, Yjs payloads, credentials,
session tokens, or authenticated Git URLs.

Reconnect always reauthorizes. Browser persistence and a previous socket are
recovery inputs, never access capabilities.

## Related

- [Decision: single application replica](../decisions/0004-single-application-replica.md)
- [Collaboration architecture](./collaboration.md)
- [Versioning and direct Git](./versioning.md)
- [Deployment and operations](../operations/deployment.md)
- [Testing and validation](../development/testing.md)
