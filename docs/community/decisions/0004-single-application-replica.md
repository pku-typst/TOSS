---
title: "ADR-0004: Single application replica"
summary: "Run one application replica until realtime fan-out and Git locking use distributed coordination."
status: accepted
type: decision
scope: community
audience:
  - operator
  - contributor
  - coding-agent
topics:
  - scaling
  - realtime
  - locking
related:
  - docs/community/operations/deployment.md
  - docs/community/architecture/collaboration.md
  - docs/community/architecture/versioning.md
code_paths:
  - backend/src/collaboration
  - backend/src/versioning
  - backend/src/server
---

# ADR-0004: Single application replica

## Decision

Production runs one application replica. Realtime room fan-out and per-project
Git locks are process-local, so multiple replicas are not safe even with shared
PostgreSQL, volumes, or sticky sessions.

## Consequences

- vertical resource sizing and browser-side compilation are the current scale
  model;
- a shared event bus alone is insufficient without distributed Git locking and
  reconnect/catch-up semantics;
- deployment manifests must not raise replica count as an availability shortcut;
- horizontal scaling requires a deliberate replacement architecture and
  failure-mode tests.

## Related

- [Deployment](../operations/deployment.md)
- [Collaboration](../architecture/collaboration.md)
- [Versioning](../architecture/versioning.md)
