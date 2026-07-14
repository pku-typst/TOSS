---
title: "Collaboration architecture"
summary: "Yjs document bootstrap, realtime control events, persistence, authorization generations, and reconnect behavior."
status: current
type: architecture
scope: community
audience:
  - frontend-contributor
  - backend-contributor
  - operator
  - coding-agent
topics:
  - yjs
  - websocket
  - presence
  - persistence
related:
  - docs/community/architecture/frontend.md
  - docs/community/architecture/backend.md
  - docs/community/architecture/identity-and-access.md
  - docs/community/operations/deployment.md
code_paths:
  - backend/src/collaboration
  - backend/src/protocol/realtime.rs
  - web/src/pages/workspace
---

# Collaboration architecture

Collaboration uses one Yjs stream for the active document and one project
control stream for committed metadata invalidations. The active Y.Text is the
collaborative authority in the browser; PostgreSQL stores the durable update
log, compacted snapshots, and the Workspace text projection.

## Document identity and bootstrap

The WebSocket route identifies a project, immutable document UUID, and
collaboration revision. Renaming a path does not change the room. An
authoritative content replacement advances the revision and creates a fresh
room.

1. The backend authorizes the current session, share token, or named guest and
   validates the document identity.
2. Under the document lock, it loads or creates the compacted Yjs snapshot and
   every required update after its safe watermark.
3. A new collaboration generation is seeded deterministically from the SQL
   document. Browsers do not invent independent initial CRDT state.
4. The server sends the state followed by `bootstrap.done`.
5. Only after bootstrap may the client publish or render the active binding as
   ready.

## Update durability

Writable clients send `yjs.update` and `yjs.sync`. Each update is authorized
against the current access and content generations, persisted, and only then
broadcast. A persistence failure emits `server.error` and closes the affected
stream so reconnect starts from authoritative state.

Compaction uses `yrs` to merge the current snapshot and all following updates
before moving the safe watermark. `COLLAB_DOC_UPDATE_RETAIN` controls how much
already compacted history remains; it never limits bootstrap correctness.

## Presence and cursors

Presence is connection-scoped while the UI aggregates by member. Multiple tabs
therefore count as one collaborator without allowing one closing tab to remove
the others. When a member has more than one live connection, the editor shows a
separate editing-session count; it does not claim that browser tabs are distinct
people or that each connection is a distinct physical device. Read-only clients
participate in presence but do not send document updates or editable cursor
positions.

Cursor markers remain connection-scoped. Each server event states whether its
connection is the receiving socket, allowing the client to hide only its own
cursor while still rendering another tab or device signed in to the same
account. Cursor presence never crosses document rooms.

The room does not retain a roster. Every existing connection answers a join
with its presence metadata, including connections owned by the same member, so
a newly opened tab can discover all live sessions symmetrically.

Presence is ephemeral session state, not an audit or revision log.

## Project control stream

The separate control socket carries:

- `workspace.changed` after a committed document, tree, settings, or asset
  mutation;
- `document.changed` when an open document binding was superseded;
- `access.changed` after project authorization changes;
- `project.replaced` after destructive content replacement.

`workspace.changed` may include a path and document collaboration revision.
The browser coalesces these invalidations into a Workspace delta. Every
completed socket bootstrap or reconnect triggers one catch-up read because an
event may have occurred while the connection was absent.

Malformed or incomplete events are rejected before they affect the session.
In particular, an incomplete `project.replaced` message cannot invalidate an
editor.

## Generation and lock ordering

Access mutations advance an Access-owned project epoch. Durable Yjs writes take
the matching shared access-generation lock; grant changes take the exclusive
lock. A write is therefore linearized before or after the permission change.

Workspace content replacement uses the same pattern with content generation.
It replaces project content and clears the old Collaboration history inside
one transaction. A prior write either commits before replacement and is
cleared, or waits and is rejected against the new epoch.

The browser treats an access or content generation change as session
supersession: it closes old bindings, cancels pending work, and reboots through
fresh authorization rather than reconnecting with a stale `canWrite` decision.

## Replica constraint

Rooms and fan-out are process-local. Production must use one application
replica until a shared realtime bus is implemented. See
[Deployment](../operations/deployment.md).

## Related

- [Frontend architecture](./frontend.md)
- [Identity and access](./identity-and-access.md)
- [API guide](../reference/api.md)
- [Deployment](../operations/deployment.md)
