---
title: "ADR-0007: Community database baseline"
summary: "Start Community TOSS from one audited schema baseline and reject incompatible migration histories."
status: accepted
type: decision
scope: community
audience:
  - contributor
  - operator
  - coding-agent
topics:
  - database
  - migrations
  - compatibility
related:
  - docs/community/operations/deployment.md
  - docs/community/development/testing.md
  - docs/community/architecture/backend.md
code_paths:
  - backend/migrations
  - backend/src/server/runtime.rs
  - scripts/check-migration-baseline.mjs
---

# ADR-0007: Community database baseline

## Decision

Community TOSS begins with
`backend/migrations/202607120001_baseline.sql` as its only initial migration.
An installation with another migration history must use a new PostgreSQL
database; Community TOSS does not attempt an in-place conversion.

The baseline contains only the application schema and generic required seed
rows. The repository pins it byte-for-byte and verifies its checksum so
compatible installations share one SQLx version and migration chain.

The baseline is immutable. After the first Community release, every schema
change is a new forward migration, and upgrades are supported from the latest
Community release rather than from incompatible histories.

## Consequences

- Fresh installations have one reviewable starting schema instead of replaying
  an unrelated development history.
- Pointing Community TOSS at a database from another migration history fails
  validation by design. Operators must not bypass the failure by editing
  `_sqlx_migrations`.
- Compatible distributions use the same public migration chain.
- Operators replacing an older installation must preserve required content
  through an explicit export/import or backup-and-rebuild plan.
- Once Community TOSS is released, consolidation is no longer permitted; all
  subsequent evolution is forward-only.

## Related

- [Deployment and operations](../operations/deployment.md)
- [Testing and validation](../development/testing.md)
- [Backend architecture](../architecture/backend.md)
