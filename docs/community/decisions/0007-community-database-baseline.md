---
title: "ADR-0007: Community database baseline"
summary: "Start Community TOSS from one audited schema baseline and reject in-place upgrades from pre-Community database histories."
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
An installation moving from an earlier TOSS release or any pre-Community
migration history must use a new PostgreSQL database; Community TOSS does not
attempt an in-place upgrade from those histories.

The canonical SQL file was produced before the Community extraction and was
reviewed to contain only the application schema and generic required seed
rows. It is retained byte-for-byte, including its historical first-line
product label, so audited downstream distributions already using this
unreleased schema share the same SQLx version and checksum. That comment has no
runtime or product-identity meaning.

The baseline is immutable. After the first Community release, every schema
change is a new forward migration, and upgrades are supported from the latest
Community release rather than from pre-Community histories.

## Consequences

- Fresh installations have one reviewable starting schema instead of replaying
  an unrelated development history.
- Pointing Community TOSS at an earlier TOSS database fails migration
  validation by design. Operators must not bypass the failure by editing
  `_sqlx_migrations`.
- A migration-compatible downstream distribution can reuse the same core
  binary without substituting a private migration directory.
- Operators replacing an older installation must preserve required content
  through an explicit export/import or backup-and-rebuild plan.
- Once Community TOSS is released, consolidation is no longer permitted; all
  subsequent evolution is forward-only.

## Related

- [Deployment and operations](../operations/deployment.md)
- [Testing and validation](../development/testing.md)
- [Backend architecture](../architecture/backend.md)
