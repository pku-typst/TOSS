---
title: "Browser/server protocol"
summary: "Authority, generation, compatibility, and wire conventions for REST and realtime contracts."
status: current
type: reference
scope: community
audience:
  - contributor
  - integrator
  - coding-agent
topics:
  - protocol
  - openapi
  - websocket
related:
  - docs/community/reference/api.md
  - docs/community/architecture/error-model.md
  - docs/community/architecture/collaboration.md
code_paths:
  - protocol/openapi.json
  - backend/src/protocol
  - web/src/lib/api/generated.ts
---

# Browser/server protocol

This directory contains the versioned integration contract between the browser
and Rust service. It is not a bounded context, shared domain-model package, or
place for UI state.

## Sources and generated artifacts

- Context-owned read contracts and transport request DTOs in Rust are the JSON
  schema sources. Business types stay with their owning bounded context.
- `backend/src/protocol/rest.rs` assembles OpenAPI. Operation markers, common
  parameters, and transport error schemas are grouped under
  `backend/src/protocol/rest/` by capability.
- `backend/src/protocol/realtime.rs` owns versioned WebSocket messages.
- `protocol/openapi.json` is generated and checked in so the web build does not
  require a Rust toolchain.
- `web/src/lib/api/generated.ts` is generated from OpenAPI. Do not add view
  models or application state to it.

After a wire change, regenerate both artifacts:

```bash
cd backend
cargo run --locked --example export_protocol -- ../protocol/openapi.json

cd ../protocol
npm run generate:types
npm run check:types
```

Backend tests reject Axum/OpenAPI method and path drift. The web build rejects a
stale TypeScript artifact.

## Compatibility policy

The product has not reached its first public release, so `v1` may still receive
intentional destructive cleanup. After `v1` is declared stable:

- additive operations and optional fields are compatible;
- removing or renaming operations, fields, enum values, or status meanings is
  breaking;
- making an optional field required is breaking;
- clients ignore unknown response fields and realtime event kinds;
- breaking REST changes require a new URL version;
- breaking realtime changes require a new realtime protocol version.

Database rows, application commands, repository records, and frontend view
models are not wire contracts even when their fields currently resemble one.

## HTTP conventions

- JSON field names use `snake_case`.
- UUIDs are strings and timestamps use RFC 3339.
- Successful mutations without a body return `204 No Content`.
- Ordinary `/v1` errors use `{ "code", "message", "request_id" }`.
- `code` is a stable semantic identifier for control flow.
- `message` is a safe English fallback and is not a localization key.
- `request_id` matches the response header and server log correlation ID.
- Git smart HTTP retains native protocol bodies rather than the JSON envelope.

HTTP status/public-code mapping belongs at transport edges. Bounded-context
errors describe capability failures and preserve useful sources without
depending on Axum.

## Realtime conventions

Realtime messages are discriminated by `kind`. Yjs binary updates remain
base64-encoded inside the JSON envelope. Presence and cursors are transport
state, not canonical project content.

A `workspace.changed` event is a committed, scoped invalidation for document,
tree, settings, or asset state. Clients coalesce invalidations and run catch-up
reads after reconnect. A `project.replaced` event changes the collaboration
generation and requires a workspace reload. Unknown event kinds are ignored for
forward compatibility.

## Related

- [API reference](../docs/community/reference/api.md)
- [Error model](../docs/community/architecture/error-model.md)
- [Collaboration architecture](../docs/community/architecture/collaboration.md)
