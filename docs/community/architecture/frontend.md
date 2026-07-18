---
title: "Frontend architecture"
summary: "Ownership of route, remote, collaborative, lifecycle, compiler, and presentation state in the browser."
status: current
type: architecture
scope: community
audience:
  - frontend-contributor
  - coding-agent
topics:
  - react
  - state-management
  - xstate
  - yjs
  - compilation
related:
  - docs/community/architecture/overview.md
  - docs/community/architecture/collaboration.md
  - docs/community/architecture/document-processing.md
  - docs/community/architecture/browser-ai-assistant.md
  - docs/community/runtimes/typst.md
  - docs/community/decisions/0008-durable-document-processing.md
  - web/DESIGN.md
code_paths:
  - web/src/App.tsx
  - web/src/composition/applicationRuntime.tsx
  - web/src/browserBackend
  - web/src/router.tsx
  - web/src/pages/workspace
  - web/src/pages/processing
  - web/src/features/ai
  - web/src/lib
---

# Frontend architecture

The browser does not use one global store. State stays with the system that
owns its invariants.

| State | Owner |
| --- | --- |
| Route identity, navigation, and page metadata | React Router |
| Remote request cache and mutation state | TanStack Query |
| Local presentation state | Component state or a focused reducer |
| Collaborative text | Yjs; React subscribes through `useSyncExternalStore` |
| Editor transactions and selections | CodeMirror |
| Compiler and renderer sessions | Persistent browser workers/runtimes |
| Meaningful asynchronous lifecycles | Feature-scoped XState actors |

XState is used when a process has invalid transitions, supersession,
cancellation, reconnect, or stale-result rules. It must not wrap a single
promise or mirror a boolean.

## Application runtime boundary

Pages depend on bounded frontend ports owned by Projects, Templates,
Workspace, Collaboration, and Compilation. The composition root selects Core
or browser adapters once and exposes only the narrow owner hooks. It does not
expose a generic backend object or make components branch on a backend kind.

`ApplicationRuntimeProvider` groups stable application-lifetime dependencies;
it is not a global state store. A provider should split out only when it gains
an independent update or subscription lifecycle. This keeps the component tree
shallow without merging the bounded contexts behind the ports.

The Core adapters call the versioned HTTP and WebSocket contracts. The browser
adapters retain projects, templates, Workspace files, and Yjs updates in
IndexedDB and coordinate tabs through browser primitives. Route and feature
components use the same ports in both targets.

## Workspace session

One Workspace session generation owns the low-frequency projection for one
effective access identity and project:

- file tree and settings;
- document identities and inactive document bodies;
- asset metadata;
- content epoch and accepted settings revision;
- active path and lifecycle state.

TanStack Query owns bootstrap and delta requests. Results enter the local
projection only through a generation fence. Changing access identity or
starting another project generation cancels pending loads, compilation,
exports, and revision work so old results cannot publish into the new session.
Content replacement is terminal for the old generation.

High-frequency engine data does not live in actor context. Yjs owns text,
CodeMirror owns editor transactions, and the preview reducer owns page/viewport
geometry. Actors own the lifecycle around those engines.

## Realtime and invalidation

A document actor owns Y.Doc lifecycle and the active document WebSocket. A
separate project actor owns the control stream. Committed
`workspace.changed` events drive a coalesced delta cycle; reconnect completion
always causes one catch-up read because broadcasts are ephemeral.

| Projection | Refresh policy |
| --- | --- |
| Active document and presence | WebSocket/Yjs; no HTTP polling |
| Tree, inactive documents, settings, assets | Event invalidation plus reconnect catch-up; no idle polling |
| Revision history | Only while open; refresh the head page every 30 seconds |
| Project access | Only while its settings surface is visible; invalidate on events and local mutations |
| External jobs | Adaptive polling only while a nonterminal job is visible |
| Process health | Actual request outcomes and server/Kubernetes probes; no browser `/health` polling |

## Compilation and preview

Typst and optional LaTeX inputs are sent to dedicated browser workers. Typst
uses persistent compiler and renderer sessions and incremental vector output.
PDF generation is requested only for the PDF renderer or export path.

Compile and export actors carry the Workspace generation that created them.
Only the current generation may publish diagnostics, mappings, PDF artifacts,
or canvases. Source/preview navigation also carries a mapping revision, so a
jump cannot use positions from a superseded compile.

The compiler-facing state is projected once per changed input set as an
immutable `CompileWorld`. Paths are normalized, the active Yjs document
replaces its stored projection, and exact document and asset equality decides
whether the existing World can be reused. There is no sampled-content hash: an
equal-length edit anywhere in an inactive document or asset still creates a new
World. Unchanged file nodes retain their identities, while the projector keeps
its decoded-font cache private and reuses a font buffer until that font's bytes
change.

Compilation jobs pair the World object with a structured `CompileTarget`
(Typst output mode or LaTeX engine). Worker reset, preview reuse, PDF reuse, and
mapping validity each use one centralized comparison over those values rather
than independently assembled string keys. A render that observes a new World
synchronously hides artifacts and mappings belonging to the old one, even
before React effects deliver the new job to the compilation actor. Deferred
source/preview mapping responses must still reference the exact current World
and mapping object before they can affect the UI.

## Durable task center

Durable processing remains outside the Workspace session and compiler actors.
For an authenticated LaTeX project, **Build in background** submits an explicit
job when the capability is configured; a global task control in the application
header opens a responsive drawer with active and recent work. Completed tasks
expose their downloadable artifacts in the drawer and display the source
project name when it remains available.

The global surface does not create a global Job domain or frontend store. It
initially projects Document Processing jobs; another bounded context may later
contribute a namespaced summary without surrendering lifecycle ownership.

TanStack Query owns the account-scoped job list, capability projection, and
mutations. Active jobs refresh every two seconds; an open idle drawer refreshes
every fifteen seconds; a closed drawer with only terminal work stops polling.
Changing accounts changes the query key and closes/reset the drawer, so stale
work cannot cross an identity boundary. Component state owns only presentation
choices and transient download/cancel errors.

## Optional frontend features

Frontend features are independent from project types and durable processing
operations. The distribution bounds which feature chunks a web build may
contain; the deployment TOML selects an enabled subset. Core exposes that set
through `/v1/auth/config`, and the frontend intersects it with compile-time
build constants before presenting an entry point or loading a lazy chunk.

Project types use `deploymentProjectTypes`, frontend features use their own
typed feature projection, and Worker-backed actions query Document Processing
capabilities. Do not introduce a generic `useCapability(id)` hook or move
browser feature state into the Workspace session actor.

Optional Workspace panels use a narrower presentation extension: the toolbar
accepts typed panel descriptors and one generic `onTogglePanel(panel)` command.
A feature-local module owns its label, icon, lazy entry, and runtime state and
returns no descriptor when unavailable. The composition root may know which
features it composes, but shared toolbar components must not grow
feature-specific availability booleans or callbacks.

The PreviewPanel receives only the contextual submit/capability state needed by
its button. Durable job aggregates remain in the task-center query and are not
copied into the Workspace projection, compiler actors, preview reducer, or Yjs
documents.

## Presentation ownership

The browser has one semantic token layer and one primitive layer. Global CSS
owns only document defaults, the application shell, startup skeletons, and
route loading. Page, component, Workspace-area, and optional-feature styles are
co-located with the module that owns their markup and responsive behavior.
This keeps route styling independent of visit order and lets disabled optional
features disappear from the build graph together with their styles.

Feature styles consume TOSS semantic tokens rather than NVIDIA Elements
reference values. Direct palette values remain local only when color carries
content, such as provider identity, syntax, collaborator presence, a document
paper surface, or a product illustration. Shared headings, cards, empty states,
form controls, and feedback components come from the UI primitive layer; broad
classes such as `.error`, `.loading`, or `.muted` are not cross-page contracts.

## Browser persistence

The Core target treats PostgreSQL, project storage, and server-side Yjs
persistence as authoritative. IndexedDB contains bounded client projections and
caches.

The static browser target has no server authority. Its BrowserBackend owns the
project catalog, Workspace snapshots, assets, thumbnails, and Yjs persistence
in IndexedDB. A `BroadcastChannel` invalidates sibling tabs. Mutations use
transactions and generation checks so a stale load or concurrent Yjs update
cannot overwrite newer state.

Static builds currently expose Typst projects only. Server-owned access,
versioning, external repositories, durable processing, account administration,
and remote collaboration are absent rather than emulated by no-op adapters.

- Yjs IndexedDB persistence is keyed by member, project, immutable document ID,
  and collaboration revision.
- A plain Workspace snapshot is an offline/read-only seed, not a second CRDT
  authority or remote request cache.
- Query and asset caches are account-scoped and cleared when the session
  changes.
- Runtime packages, fonts, WASM, and render assets use browser HTTP/cache
  mechanisms with explicit runtime versions.

## Related

- [Collaboration](./collaboration.md)
- [Durable document processing](./document-processing.md)
- [Browser AI assistant](./browser-ai-assistant.md)
- [Typst runtime](../runtimes/typst.md)
- [LaTeX runtime](../runtimes/latex.md)
- [Web design language](../../../web/DESIGN.md)
- [Decision: browser compilation](../decisions/0001-browser-compilation.md)
- [Decision: durable document processing](../decisions/0008-durable-document-processing.md)
