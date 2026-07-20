---
title: "Backend architecture"
summary: "Modular-monolith ownership rules, persistence boundaries, transactions, and protocol edges."
status: current
type: architecture
scope: community
audience:
  - backend-contributor
  - coding-agent
topics:
  - rust
  - bounded-contexts
  - persistence
  - transactions
related:
  - docs/community/architecture/overview.md
  - docs/community/architecture/document-processing.md
  - docs/community/architecture/error-model.md
  - docs/community/reference/api.md
  - protocol/README.md
code_paths:
  - backend/src
  - backend/src/server/routes.rs
  - backend/src/protocol
  - backend/migrations
  - workers/processing-sdk
  - protocol/worker-openapi.json
---

# Backend architecture

The backend is one Axum process organized as vertical contexts. Directory shape
follows business ownership; it is not a layered `handlers/services/repositories`
application and is not a collection of generic CRUD repositories.

## Dependency rules

- A context owns its models, workflows, HTTP edge, and persistence.
- Cross-context calls use a small owner-named façade exported by the context
  root. A caller never reaches into another context's persistence module.
- PostgreSQL-specific queries and locks stay with the context whose invariant
  they protect.
- A multi-context transaction receives one existing SQL connection and
  composes explicit transactional façades. Persistence functions do not each
  open independent transactions.
- Request DTOs and collection wrappers belong at HTTP edges. A canonical
  context read contract may serialize directly and be referenced by OpenAPI;
  do not add a field-for-field response copy.
- Business types remain with their feature owner. There is no global
  `domain.rs`, `types.rs`, `application/`, `services/`, or `repositories/`
  namespace.

`backend/src/text_enum.rs`, `database_error.rs`, and `http_response.rs` are
narrow technical adapters. They must not accumulate business vocabulary or
become generic helper buckets.

## Process composition

`backend/src/server/` owns startup, route assembly, static SPA delivery, and
health. `backend/src/app_state.rs` is the process composition root assembled by
the server; it is not a domain model. New capabilities should receive the
narrow context and adapter handles they need rather than the entire `AppState`.

Central route assembly makes the full HTTP surface auditable, while handlers
remain in their owning contexts. The checked-in OpenAPI document is assembled
from operation markers under `backend/src/protocol/rest/`, grouped by context.

## Persistence ownership

| Context | Representative tables or filesystem state |
| --- | --- |
| Access | users, accounts, sessions, organizations, project/template grants, share links, personal tokens |
| Workspace | projects, settings, documents, directories, assets, thumbnails, archives, PDF artifacts |
| Collaboration | Yjs update and compacted snapshot tables; in-process room registry |
| Versioning | Git repository metadata, dirty/flush state, contributors, and project worktrees |
| External repositories | encrypted grants, OAuth attempts, project links, inbound jobs, checkpoint queues |
| Document Processing | jobs, attempts, worker sessions, request fences, transfer tickets, input pins, blobs, and artifacts |
| Templates | No private storage tables; it composes Workspace template status, Access-owned template grants, and distribution-owned built-in sources |

Audit writes are best effort. `audit_events` is an observability trail and
must never be reconstructed into authoritative authorization, attribution, or
project state.

## Cross-context processes

The shared choreography is deliberately small:

- **Project provisioning** composes Workspace graph creation, Access ownership,
  and Versioning initialization.
- **Workspace activity** advances Workspace state and calls transactional
  Versioning and External Repositories bookkeeping.
- **Federated login** provisions an Access identity and may bind the exact same
  external-provider account.
- **Content replacement** composes Workspace replacement, Collaboration
  generation reset, local revision preservation, and External Repositories job
  state.

These are named processes, not a new horizontal application layer.

## Document-processing boundary

`backend/src/document_processing/` is a vertical context. It owns durable job
policy, attempts, immutable input manifests, processing blobs/artifacts, quotas,
cancellation, finalization, and processor availability. It calls narrow
Access, Collaboration, Workspace, and object-storage facades to authorize and
capture one accepted project generation; those contexts do not learn queue or
worker mechanics.

Independent pull workers execute typed operations through the separately
generated worker protocol. The public SDK and LaTeX processor live under
`workers/`; they do not import backend persistence modules, connect to the
application database, or publish Workspace state.

## Visibility and testing

Rust module visibility is the primary architecture enforcement mechanism.
Context-private modules stay private; each context root re-exports only the
surface intended for siblings. Tests assert behavior, persistence, and wire
contracts. Source-text scans for filenames, imports, SQL fragments, or function
names are not architecture tests.

If a boundary can no longer be expressed through module visibility, promote it
to a crate boundary or use an AST-aware dependency rule.

## Related

- [Architecture overview](./overview.md)
- [Durable document processing](./document-processing.md)
- [Error model](./error-model.md)
- [API guide](../reference/api.md)
- [Protocol workflow](../../../protocol/README.md)
