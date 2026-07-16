---
title: "ADR-0001: Browser-side compilation"
summary: "Keep the interactive Typst and optional LaTeX preview loop exclusively in browser workers."
status: accepted
type: decision
scope: community
audience:
  - contributor
  - operator
  - coding-agent
topics:
  - compilation
  - browser
  - webassembly
related:
  - docs/community/runtimes/typst.md
  - docs/community/runtimes/latex.md
  - docs/community/architecture/frontend.md
  - docs/community/decisions/0006-defer-background-rendering.md
  - docs/community/decisions/0008-durable-document-processing.md
code_paths:
  - web/src/lib/typst.worker.ts
  - web/src/lib/latex.worker.ts
  - backend/src/typst_runtime
---

# ADR-0001: Browser-side compilation

## Decision

Interactive Typst and Community LaTeX compilation run in dedicated browser
workers. The server supplies authorized project state and bounded runtime
resources but is never a preferred compiler, hedge, race participant, or
fallback in the live preview loop.

Durable server-side document processing is a separate, explicit asynchronous
product workflow. ADR-0008 accepts that boundary without changing the
browser-only interactive compilation decision.

## Consequences

- compilation capacity scales with clients rather than application replicas;
- source content does not need a separate compiler-service hop;
- persistent WASM/compiler sessions improve edit latency;
- first-load size, browser memory, worker lifecycle, and cross-origin delivery
  are product concerns;
- durable server processing is a separate bounded context, not an optimization
  hidden inside the preview adapter.

## Related

- [Typst runtime](../runtimes/typst.md)
- [Community LaTeX runtime](../runtimes/latex.md)
- [Frontend architecture](../architecture/frontend.md)
- [Durable document processing](./0008-durable-document-processing.md)
- [Superseded background-rendering decision](./0006-defer-background-rendering.md)
