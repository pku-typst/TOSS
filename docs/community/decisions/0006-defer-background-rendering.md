---
title: "ADR-0006: Defer server-side background rendering"
summary: "Historical rationale for deferring server rendering until it had a distinct durable product outcome."
status: superseded
type: decision
scope: community
audience:
  - contributor
  - operator
  - coding-agent
topics:
  - compilation
  - background-jobs
  - resource-management
related:
  - docs/community/decisions/0001-browser-compilation.md
  - docs/community/decisions/0008-durable-document-processing.md
  - docs/community/architecture/frontend.md
  - docs/community/runtimes/typst.md
  - docs/community/operations/deployment.md
code_paths:
  - web/src/pages/workspace/compileWorld.ts
  - web/src/pages/workspace/compilationActor.ts
  - web/src/lib/typst.worker.ts
---

# ADR-0006: Defer server-side background rendering

ADR-0008 supersedes this decision for explicit durable document processing.
The browser-only interactive compilation boundary remains accepted; this
record preserves why a server compiler was rejected when it had no distinct
durable product outcome.

## Decision

Do not ship a server-side Typst compiler, render worker, render-job API, or user
preference in the current architecture. Interactive preview and explicit local
PDF export remain browser-only.

Server rendering may be reconsidered only as an explicit durable background
action. It must never become a preferred compiler, live-preview accelerator,
race against the browser, or automatic fallback. A future deployment switch
may make the action available or unavailable; it must not introduce a runtime
priority selector.

## Why defer it

The persistent browser compiler already owns the low-latency editing loop and
scales its CPU and memory cost with the client. A second compiler lane adds
queueing, admission control, snapshot capture, artifact storage, observability,
security boundaries, and deployment capacity without adding a distinct user
outcome to that loop.

Background rendering becomes valuable only when work must outlive the browser,
be invoked by automation, run in a scheduled or batch workflow, or produce an
artifact under a controlled server environment. None of those requirements is
part of the current product contract.

## Constraints if revisited

A future design must preserve these boundaries:

- capture accepted collaboration updates before taking the immutable job
  snapshot;
- use durable, idempotent jobs with explicit cancellation, expiry, quotas, and
  per-project fairness;
- queue or reject work under resource pressure while leaving browser preview
  and export fully operational;
- publish immutable artifacts with integrity metadata and authorization checks;
- expose submission as an explicit user or automation action, not as a preview
  setting;
- begin with the official native Typst CLI for compatibility and operational
  simplicity; use a server-side `typst.ts` runtime only if a measured workload
  demonstrates a material benefit that justifies another runtime contract;
- keep CPU, memory, concurrency, and storage sizing deployment-local rather
  than embedding one environment's quota in the application protocol.

## Consequences

- the application and deployment carry no idle server compiler fleet;
- browser compilation remains usable when background capacity is exhausted or
  absent;
- there is no promise that an export continues after the browser closes;
- the rejected worker implementation is not maintained alongside the active
  architecture;
- adoption requires a new accepted decision and end-to-end product,
  operational, and failure-mode tests.

## Related

- [Browser-side compilation](./0001-browser-compilation.md)
- [Durable document processing](./0008-durable-document-processing.md)
- [Frontend architecture](../architecture/frontend.md)
- [Typst browser runtime](../runtimes/typst.md)
- [Deployment](../operations/deployment.md)
