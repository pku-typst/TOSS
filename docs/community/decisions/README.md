---
title: "Architecture decision index"
summary: "Accepted and superseded cross-cutting decisions and the current documents that implement them."
status: current
type: index
scope: community
audience:
  - contributor
  - operator
  - coding-agent
topics:
  - architecture-decisions
  - rationale
related:
  - docs/community/architecture/overview.md
  - docs/community/product/overview.md
code_paths:
  - docs/community/decisions
---

# Architecture decision index

Decision records explain stable choices that cannot be inferred safely from one
module. They do not duplicate implementation guides or track unfinished work.

| Decision | Outcome |
| --- | --- |
| [ADR-0001](./0001-browser-compilation.md) | Compile Typst and optional LaTeX in the browser |
| [ADR-0002](./0002-workspace-and-external-git.md) | Keep the workspace authoritative and external Git manual |
| [ADR-0003](./0003-configured-distributions.md) | Separate product policy through validated distributions |
| [ADR-0004](./0004-single-application-replica.md) | Operate one application replica until coordination is distributed |
| [ADR-0005](./0005-explicit-provider-bindings.md) | Bind provider accounts explicitly to one stable platform account |
| [ADR-0006](./0006-defer-background-rendering.md) | Superseded: defer server rendering and keep preview exclusively in the browser |
| [ADR-0007](./0007-community-database-baseline.md) | Start Community TOSS from one new database baseline |
| [ADR-0008](./0008-durable-document-processing.md) | Add durable document processing without changing browser compilation |

Add a decision only for a durable, cross-cutting tradeoff. Current behavior and
operations still belong in architecture and guide pages.

## Related

- [Architecture overview](../architecture/overview.md)
- [Product overview](../product/overview.md)
