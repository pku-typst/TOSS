---
title: "Browser AI assistant design draft"
summary: "Current working design for an optional browser-only BYOK project assistant isolated in a sandboxed Runtime, with tool use, human-reviewed edits, and compile feedback."
status: current
type: architecture
scope: community
audience:
  - contributor
  - frontend-contributor
  - operator
  - coding-agent
topics:
  - ai-assistant
  - browser-agent
  - byok
  - browser-isolation
  - opaque-origin
  - tool-calling
  - workspace
related:
  - docs/community/architecture/frontend.md
  - docs/community/decisions/0009-typed-optional-features.md
  - docs/community/configuration/deployment.md
  - docs/community/configuration/distributions.md
  - web/DESIGN.md
code_paths:
  - web/src/pages/WorkspacePage.tsx
  - web/src/pages/workspace
  - web/src/features/ai
  - web/src/ai-runtime
  - web/src/lib/deploymentCapabilities.ts
  - web/distributionBuildConfig.ts
  - web/vite.ai-runtime.config.ts
  - web/scripts/headless-ai-runtime.mjs
  - backend/src/deployment_config.rs
  - backend/src/server/ai_runtime.rs
  - backend/src/server/mod.rs
  - backend/src/server/web_build_manifest.rs
  - distributions/community/toss.json
---

# Browser AI assistant design draft

This page is the current working design and implementation record for the
Community browser AI assistant. It records the baseline agreed during design
discussion, the infrastructure slice now present on `dev`, and the remaining
choices. Sections marked as implemented are current contracts; the agent,
provider, tool, and review sections remain target design until their delivery
slices land. Durable rationale may later be promoted into an ADR.

## Agreed baseline

| Area | Baseline |
| --- | --- |
| Runtime | The provider connection and agent loop run in a browser AI Runtime isolated as a unique opaque-origin iframe. TOSS Core does not proxy or execute model requests. |
| User-provided AI | BYOK includes cloud API credentials, short-lived tokens, user-controlled gateways, OpenAI-compatible endpoints, and local services such as Ollama, LM Studio, or vLLM. |
| Connections | TOSS ships no branded provider preset. A user defines each connection's name, API protocol, endpoint, model, and optional credential. The host application may persist sanitized non-secret profiles in account-scoped Local Storage for later reuse. |
| Credentials | The user enters a credential into the sandboxed Runtime surface, and it exists only in that Runtime instance's memory. The host application, TOSS Core, and project never receive it. Reload, tab close, logout, account change, or endpoint change clears it. |
| Integration boundary | A one-time bootstrap transfers a versioned, capability-scoped `MessageChannel` carrying agent turns, typed tool calls, tool results, cancellation, and safe view events. It never exposes a generic authenticated fetch operation. |
| Network confinement | A fixed bootstrap validates the selected credential-free endpoint and tightens Runtime CSP to that exact endpoint origin before loading provider code or accepting a credential. |
| Deployment topology | The Community default serves the Runtime artifact from the application URL origin and forces it into an opaque security principal. A real second deployment origin is a deferred compatibility or higher-assurance mode, not a first-release prerequisite. |
| Feature dimension | AI is an optional frontend feature, independent from project types and Document Processing operations. |
| Agent loop | One user request may contain multiple model, tool, review, and compile-feedback turns. |
| Writes | The agent may propose an edit but may not silently modify a project. Every mutation requires an explicit review decision. |
| Workspace | Project text, collaboration, compiler state, and diagnostics remain owned by their existing Workspace, Yjs, and compiler lifecycles. |
| UI | Assistant, Settings, and Revisions share one mutually exclusive right-side auxiliary panel. |
| Durability | The assistant is an interactive browser feature, not a durable background task and not a processing worker. |

## Implementation status

The first infrastructure slice is implemented, but it intentionally accepts no
credential and makes no provider request. It contains:

- the `ai_assistant` distribution/build/deployment gate, included by Community
  but disabled by default;
- a lazy feature entry expressed to the Workspace through a generic optional
  panel descriptor;
- one mutually exclusive auxiliary-panel state for Assistant, Settings, and
  Revisions;
- a separately built `/_ai-runtime/bootstrap.html` artifact with a fixed,
  versioned protocol and deterministic fake provider;
- Runtime-owned English and Simplified Chinese UI catalogs selected through a
  bounded locale value in the channel handshake, without exposing host storage
  or importing the host catalog into the opaque principal;
- an opaque `sandbox="allow-scripts"` iframe and one-use `MessageChannel`;
- explicit Core routes, per-response nonces, Runtime CSP, public immutable
  CORS/CORP module assets, and fixed not-found behavior while disabled;
- a schema-2 web build manifest and Runtime build descriptor that make rollout
  skew a startup error;
- an AI-excluded build check proving there is no Assistant chunk or Runtime
  artifact; and
- a real Chromium smoke covering the HTTP boundary, DOM and storage isolation,
  fake streaming/cancellation, panel preservation, and session invalidation on
  Runtime navigation.

`pi-agent-core`, provider adapters, connection profiles, credentials, Workspace
tools, edit review, and compilation feedback are subsequent slices. Firefox
and WebKit validation is also still required before enabling the feature by
default.

## Goals

- let a user ask project-aware questions without uploading the entire project
  eagerly;
- let an agent inspect files, selections, project structure, and current
  compiler diagnostics through bounded tools;
- support repeated tool calls and compile feedback inside one agent run;
- present proposed edits as reviewable diffs and apply accepted changes through
  the collaboration-aware Workspace path;
- support user-configured cloud, gateway, compatible, and local model
  connections without introducing a TOSS AI backend;
- keep AI code outside builds and deployments that do not include and enable
  the feature;
- preserve the existing frontend state-ownership and generation-fence rules.

## Non-goals

The first design does not provide:

- a shared deployment API key in browser code or deployment configuration;
- a TOSS model proxy, token broker, AI billing service, or server-side agent;
- a Document Processing operation or a durable job for interactive AI work;
- arbitrary shell execution, arbitrary HTTP fetch, browser JavaScript
  execution, remote MCP servers, or sub-agents;
- silent edits, an approve-everything mode, or autonomous multi-file changes;
- a second compiler or an AI-specific compilation path;
- a replacement for the browser live preview;
- a generic capability registry that combines AI with project types or worker
  health;
- simultaneous opaque-origin and real-origin Runtime deployment modes in the
  first release.

## Runtime boundary

```text
TOSS host security principal              opaque AI Runtime principal

Assistant chat and activity UI            credential-entry surface
Workspace context and review UI           credential/endpoint binding
AiRuntimeClient                           pi-agent-core Agent
typed Workspace tool adapters             pi-ai provider adapter
        |                                           |
        |    capability-scoped MessageChannel       |
        +-------------------------------------------+
        |                                           |
Workspace | Yjs | compiler actors           user model endpoint

TOSS Core serves the SPA, the static Runtime artifact, bootstrap
configuration, and ordinary project APIs. It receives neither model
credentials nor the AI transcript.
```

The AI Runtime is a separately built static browser artifact in the same web
release, served from a reserved, explicitly handled path such as
`/_ai-runtime/bootstrap.html`. It is embedded as:

```html
<iframe
  src="/_ai-runtime/bootstrap.html"
  sandbox="allow-scripts"
  referrerpolicy="no-referrer"
></iframe>
```

Omitting `allow-same-origin` forces the document into a unique opaque origin.
The Runtime therefore cannot access the host DOM, Local Storage, IndexedDB,
cookies, or service-worker registration, even though its URL has the same
origin as the application. Combining `allow-scripts` and `allow-same-origin`
on this same-origin iframe would destroy that isolation and is forbidden.

The Runtime entry response also carries CSP `sandbox allow-scripts`. This
preserves the opaque principal if the URL is opened as a top-level page rather
than through the intended iframe. The entry route is dedicated, generated from
an immutable build template with a per-response nonce, and independent of
authentication. Its initial navigation may still carry a path-matching host
cookie at the HTTP layer, although Runtime JavaScript cannot read that cookie;
the handler must neither consume nor reflect authentication state. Narrowing
the application's authentication cookie path is a useful independent
hardening candidate, subject to normal authentication regression testing.

The Runtime has no direct Workspace API, persistent credential store, or
generic network RPC. Its small visible surface owns credential entry and
connection status. Model text, Markdown, links, diagnostics, filenames, diffs,
and tool output are rendered by the host as untrusted data, never inserted into
the credential-holding Runtime DOM. Public Runtime modules and lazy chunks are
loaded by an opaque principal and therefore need explicit anonymous CORS, for
example `Access-Control-Allow-Origin: *`, plus a compatible
`Cross-Origin-Resource-Policy` header. They must be public, immutable,
content-addressed assets and contain no per-user data.

The Runtime should use the high-level `Agent` from
[`@earendil-works/pi-agent-core`](https://github.com/earendil-works/pi/blob/main/packages/agent/README.md).
It already owns the model/tool loop, event sequence, cancellation, steering,
follow-up input, and awaited tool preflight. React must not recreate that loop
with effects and booleans.

Provider and model access should use
[`@earendil-works/pi-ai`](https://github.com/earendil-works/pi/blob/main/packages/ai/README.md).
TOSS does not ship its branded provider catalog or preset provider factories.
The Runtime constructs a connection from user-supplied configuration and
imports only the selected wire-protocol implementation through a lazy chunk.
It must not use the all-provider entry point by default. The existing
`pi-web-ui` package may inform interaction details, but TOSS does not adopt it
as a second component, storage, or application-state system.

This boundary follows existing ownership rules. The Runtime owns the AI loop
and provider transport. Workspace owns project state, compilation, permission,
and mutation. Tool schemas are an integration contract across those bounded
contexts, not a shared domain model or a generic browser message bus.

## Runtime protocol

An opaque child sends window messages with `event.origin === "null"`, so the
host cannot authenticate it through an exact child-origin comparison. Instead,
the host creates a one-use random nonce and a `MessageChannel`, targets the
exact iframe `contentWindow`, and transfers one port in a single bootstrap
message. `targetOrigin: "*"` is permitted only for that transfer because an
opaque origin has no serializable target origin; it is never used as a general
message destination.

The child accepts initialization only from `event.source === parent`, validates
the expected application URL origin derived from its immutable entry
configuration, and echoes the nonce and exact protocol/build identifier over
the transferred port. The host validates the expected `WindowProxy`, nonce,
and exact version,
then removes the global listener. All operational traffic uses only the
dedicated port. An iframe `load`, navigation, generation change, or failed
handshake closes the port and destroys the session. The first release fails
closed on any build mismatch instead of negotiating several protocol versions.
This is channel binding and replay protection, not code attestation; TLS,
artifact provenance, CSP, and the fixed Runtime route establish which code was
loaded.

Every envelope is runtime-validated and carries a session ID, request or turn
ID where applicable, bounded payload, and explicit message type. The bootstrap
ready exchange additionally carries the exact protocol version, build ID, and
one-use nonce.

The target semantic surface is deliberately narrow:

| Direction | Messages |
| --- | --- |
| Host to Runtime | initialize locale and tool definitions, update locale, start a user turn, return a tool result, cancel a turn, clear the session |
| Runtime to host | ready and connection state, assistant deltas, typed tool call, turn completion, sanitized usage and error state |

The implemented fake slice is smaller: initialize with a bounded locale,
update locale, start turn, cancel turn, clear session, ready, assistant delta,
turn completion, and sanitized error. Tool messages are added only with the
first Workspace tool slice.

The tool definitions already required by the model form the RPC interface
description. Both sides validate the same versioned schemas. The Runtime
validates model output before requesting a call; the host validates it again
before invoking a Workspace application port. Model output and a compromised
Runtime therefore cannot bypass host permission, freshness, review, budget, or
generation checks.

The protocol has no `fetch(url, headers, body)`, credential read, arbitrary
message forwarding, DOM command, or direct file operation. An active Runtime
may spend quota through permitted agent turns if the host is compromised; the
isolation protects direct credential disclosure and arbitrary credential reuse,
not the availability of an already authorized model session.

### Runtime bootstrap and network policy

The credential must not exist while Runtime network authority is broad. Startup
therefore has two stages:

1. the browser loads only a very small, fixed or hash-pinned bootstrap;
2. the host transfers the port and a validated, non-secret connection profile;
3. the bootstrap normalizes and validates the credential-free base URL,
   including scheme, host, port, path rules, and absence of URL user
   information, and rejects the TOSS application origin as a provider
   destination;
4. it inserts an early meta CSP that narrows `connect-src` to the endpoint's
   exact origin;
5. only after that policy is active does it dynamically load the full Runtime
   and selected provider adapter;
6. after the complete module graph is resident, it installs another
   intersecting policy with `script-src 'none'` and `worker-src 'none'`, so no
   later script, module, or worker can be loaded after a credential exists;
7. only then does the full Runtime present its credential input; and
8. changing the base URL destroys and recreates the iframe, clearing the old
   heap, port, agent session, and credential before another connection starts.

CSP delivered in the response is the immutable upper bound; the meta policy
only narrows it because multiple policies intersect and removing a meta element
does not undo an already applied policy. An illustrative Runtime response is:

```text
Content-Security-Policy:
  sandbox allow-scripts;
  default-src 'none';
  script-src 'nonce-<per-response-nonce>' 'strict-dynamic';
  connect-src https: http://localhost:* http://127.0.0.1:*;
  style-src 'nonce-<per-response-nonce>';
  worker-src 'none'; img-src 'none'; font-src 'none'; frame-src 'none';
  object-src 'none'; base-uri 'none'; form-action 'none';
  frame-ancestors 'self'
Referrer-Policy: no-referrer
X-Content-Type-Options: nosniff
X-DNS-Prefetch-Control: off
Permissions-Policy: camera=(), microphone=(), geolocation=(), display-capture=()
```

The exact policy must be verified in all supported browsers. For the first
release, the upper bound permits HTTPS plus `localhost` and IPv4 loopback HTTP
endpoints, not arbitrary plaintext LAN origins. IPv6 loopback remains pending
because Chromium rejects the wildcard-port IPv6 source expression used in the
first draft. The Runtime will perform provider requests
with `credentials: "omit"`, `redirect: "error"`, and no referrer. Authentication
is supplied only through the provider protocol's explicit header or body field.
The application CSP retains `connect-src 'self'` and permits only the reserved
Runtime frame path under its own origin. It never acquires provider origins.
`strict-dynamic` exists only to let the trusted bootstrap load its fixed Runtime
module graph from an opaque principal; the post-load policy removes that
authority before credential entry.

### Self-navigation limit

The iframe sandbox and CSP block popups, top-level navigation, forms, child
frames, objects, and non-allowed fetches, but they do not provide a portable
directive that prevents a child browsing context from navigating itself. The
current [CSP Level 3 navigation directives](https://www.w3.org/TR/CSP3/#directives-navigation)
cover form submission and embedding ancestry, not a general `navigate-to`
policy. The Host therefore treats every subsequent iframe `load` as terminal:
it closes the port, clears the session, and requires a fresh Runtime.

That behavior is revocation and detection, not prevention of the navigation
request itself. The implemented fake slice holds no secret, so this does not
expose a credential today. Before credentials land, the threat model must state
that the fixed, provenance-checked Runtime artifact is trusted not to encode a
secret in a navigation URL, and model/tool data must never become executable
Runtime DOM. If the product instead requires protection after arbitrary
Runtime-code compromise, the opaque iframe alone is insufficient and a
non-navigable credential/network execution boundary or another browser
mechanism must be designed and tested first.

## Activation

The assistant follows the existing frontend-feature equation:

```text
AI available = distribution includes ai_assistant
             & deployment enables ai_assistant
             & web build contains ai_assistant
```

Community now includes `ai_assistant` in the distribution build while leaving
it disabled by default. An operator opts in with the existing deployment
section:

```toml
[frontend]
enabled_features = ["ai_assistant"]
```

When unavailable, the toolbar entry does not render and the browser does not
load the assistant chunk. An AI-excluded distribution additionally emits no
Assistant chunk and no Runtime artifact. Protocol, endpoint, model, and
credential choices are user-side feature state, not deployment secrets and not
backend capabilities.

An enabled build also includes the matching Runtime artifact and serves its
reserved entry and asset routes with the required CSP, CORS, and isolation
headers. This needs no second hostname, Ingress, provider preset, model
credential, Worker identity, or dynamic backend capability. The Runtime entry
must be an explicit route rather than falling through the generic SPA static
handler. Core returns not found for both entry and assets when the feature is
not included or not deployment-enabled. The entry response is revalidated or
not stored, while content-hashed modules and styles may be immutable; the exact
host/Runtime build-ID handshake rejects rollout skew.

## Product terminology

An **AI connection** is the only connection concept exposed by this feature.
It has a user-selected name, an API protocol, an endpoint, a model, and an
optional credential. TOSS supplies no branded provider preset. The protocol is
still explicit because an arbitrary endpoint cannot tell the browser whether
it expects OpenAI-compatible, Anthropic Messages, or another supported wire
format.

BYOK is the product umbrella for user-supplied AI access. It includes a static
API key, a temporary token, a user-controlled gateway, an unauthenticated local
endpoint, or another compatible service. The UI does not expose a separate
taxonomy for credential ownership, billing, or transport.

An **agent run** begins with one user message and may contain several internal
model turns, tool calls, review decisions, and verification steps. An
**assistant message** is user-facing model output. Tool-only internal turns are
shown as activity rather than as empty chat bubbles.

## Workspace layout

The Workspace toolbar gains one `Assistant` entry when the feature is active.
It uses the same responsive view controls as Files, Preview, Settings, and
Revisions.

The toolbar does not expose `onToggleAssistant`, `assistantAvailable`, or any
other AI-specific prop. Its extension boundary is a list of typed optional
panel descriptors plus the generic `onTogglePanel(panel)` command. The AI
feature returns one descriptor when active and no descriptor when compiled out
or deployment-disabled. Icons, labels, lazy loading, and feature identity
remain inside the feature boundary; the Workspace page is the composition
root.

The previous independent right-panel booleans are replaced with one exclusive
selection and one shared auxiliary width:

```text
auxiliaryPanel = none | feature:ai_assistant | settings | revisions
```

Files and Preview remain independent. Opening Assistant closes Settings or
Revisions but does not change their owned data. Closing Assistant changes only
presentation: an active run or pending review remains available, and the
toolbar entry shows its running or attention state. Changing account, project,
access identity, or Workspace generation aborts the old session.

Responsive presentation is:

- a resizable, flat right-side panel on wide screens, initially about 380
  pixels and bounded to a practical editor-safe range;
- a right-side overlay drawer at intermediate widths so the editor and preview
  do not collapse;
- one full Workspace panel in the existing single-panel layout below the
  compact breakpoint;
- a full-content diff review on small screens rather than a nested narrow
  dialog.

## Assistant panel

The panel has three stable regions:

```text
+------------------------------------------------+
| Assistant       connection / model     +    x  |
+------------------------------------------------+
| user and assistant messages                    |
| compact tool activity                          |
| edit proposal summaries                        |
+------------------------------------------------+
| explicit context chips                         |
| multiline composer                    Send/Stop |
+------------------------------------------------+
```

The header switches the active connection or model, opens connection
management, starts a new conversation, and closes the panel. Changing a model
does not erase the conversation; the transcript records a subdued model-change
boundary.

The message surface uses the product's flat professional editor language.
Tool calls are compact human-readable activity rows such as `Read main.typ`,
`Searched 8 files`, or `Waiting for compilation`. Raw tool JSON and raw model
reasoning are not the default presentation. File references are interactive
and focus the corresponding Workspace document and location.

The composer supports a multiline prompt, Enter to send, Shift+Enter for a
newline, and a Stop action while the run is active. It shows explicit context
chips for the active file, selected text, diagnostics, a historical revision,
or files chosen through an `@` picker. A chip expresses user focus; it does not
eagerly copy the whole project into the model request.

Streaming follows the bottom only while the user remains at the bottom. A user
reading earlier content receives a `Jump to latest` affordance instead of
being pulled down by every delta.

## Contextual entry points

The toolbar is the general entry point. The first release should also expose
two contextual actions:

- `Ask Assistant` for a non-empty editor selection;
- `Explain` or `Suggest fix` beside compiler diagnostics.

These actions open the panel and populate a draft with visible context. They do
not send a model request before the user can inspect or amend the prompt.

Revision mode and read-only access still permit explanation. They do not
register a mutation tool. Anonymous and shared-project connection behavior
remains an open policy question.

## AI connections

The first-run panel shows one `Add AI connection` action. Connection creation
uses one progressively disclosed dialog rather than a wizard. There is no
provider gallery or branded quick-start choice. The form contains a connection
name, a supported API protocol, an endpoint, a model, and an optional
credential. Protocol-specific advanced fields appear only when that protocol
requires them.

Common behavior is:

1. name the connection and select a supported API protocol;
2. enter non-secret endpoint metadata in the host and an optional credential
   in the Runtime-owned sandboxed surface, which displays the exact bound
   destination base URL;
3. test connectivity and authentication without intentionally starting a paid
   inference request;
4. discover models when supported or accept a manual model ID;
5. choose a default model and save.

Connectivity errors must distinguish unreachable endpoints, browser or CORS
blocking, rejected credentials, unsupported model discovery, and invalid
responses. TOSS never silently redirects a failed connection through a proxy.

Non-secret connection metadata is retained in account-scoped Local Storage so
a future application instance can restore the connection name, protocol,
endpoint, and model. Session Storage is not used for connection profiles: it
adds another persistence path without satisfying next-session reuse.

The stored value uses a bounded, versioned schema such as:

```text
StoredAiConnectionsV1
  schema: 1
  activeConnectionId?: string
  connections:
    id: string
    name: string
    protocol: supported protocol identifier
    endpoint: normalized credential-free base URL
    model: string
```

The Local Storage key is scoped by the authenticated account ID. Logging out
retains that account's non-secret profiles for its next login, clears all
in-memory credentials, and prevents another account from seeing those profiles
through the product UI. Account scoping is an application boundary, not a
claim that Local Storage hides data from same-origin JavaScript or a person
with browser-profile access.

A stored endpoint must be a base URL without URL user information, query
parameters, or a fragment. Credentials, signed URLs, arbitrary headers, and
protocol options classified as secrets are not profile metadata. Every stored
profile is parsed, size-bounded, normalized, and validated again on load rather
than treated as trusted state.

A credential exists only in the JavaScript heap of the current Runtime iframe.
It is never exposed to host JavaScript or written to Local Storage, Session
Storage, IndexedDB, a service worker, a project, or Core. Reload, tab close,
logout, account change, or Runtime replacement clears it. A restored connection
that requires authentication returns to `Credential required`; the
Runtime-owned control prominently repeats the exact destination origin before
accepting a new credential.

The Runtime binds a credential to the full normalized, credential-free base URL
that was visible when the credential was entered, as well as the connection ID
and protocol. CSP confines network access at origin granularity, while Runtime
validation prevents a credential from silently moving between paths on the
same origin. Changing any bound value destroys the iframe and clears the
credential before another request. Requests use `credentials: "omit"`, reject
redirects, and never copy authorization material to a destination supplied per
model call. This prevents compromised host code from silently changing a
connection destination and reusing an existing secret.

The same dialog lists, edits, tests, and removes connections. The first release
does not duplicate connection management in Profile. Anonymous-session
behavior remains an open decision. Credentials are not shared between tabs or
accounts.

## Agent and tool loop

One user request may run several internal turns:

```text
user asks for a fix
  -> model requests diagnostics
  -> tool returns diagnostics
  -> model reads relevant files
  -> tool returns bounded snapshots
  -> model requests an edit
  -> browser pauses for review
  -> user accepts or rejects
  -> tool reports the decision
  -> model waits for exact compile feedback
  -> tool returns success or remaining diagnostics
  -> model may inspect and propose again
  -> model produces the user-facing result
```

Read-only calls may execute in parallel when their results are independent.
Mutations, review decisions, and verification execute sequentially. A run ends
when the model stops requesting tools, the user stops it, its Workspace
generation expires, a fatal runtime error occurs, or a configured turn/tool/
time/context budget is reached.

The UI groups internal work under the originating user request. It does not
turn each tool-only model message into a separate assistant bubble. Review
waiting, stale input, user rejection, compilation, and retry are still visible
as meaningful activity.

## Initial tool surface

The exact names and schemas remain to be settled, but the first tool set should
cover these narrow operations:

| Intent | Behavior |
| --- | --- |
| List project files | Return bounded path, kind, and identity metadata. |
| Read a text file | Return bounded text and an immutable snapshot reference. |
| Search project text | Return bounded path/range excerpts without arbitrary filesystem access. |
| Read active selection | Return the active document identity, range, text, and snapshot reference. |
| Read diagnostics | Return diagnostics for an exact compiler World and target. |
| Propose one file edit | Validate an edit against its base snapshot and enter human review. |
| Verify current project | Await the current browser compiler result for an exact generation and World. |

There is no generic filesystem, fetch, shell, JavaScript, database, Git, or
backend-impersonation tool. Tool outputs are structured, size-bounded, and
safe to render. Expected failures use stable typed reasons such as permission
denied, snapshot stale, generation expired, user rejected, compile superseded,
runtime failed, or output too large.

## Workspace application port

AI tool adapters consume a narrow Workspace-owned application port. They do
not reach into component refs, the TanStack Query cache, `Y.Doc`, CodeMirror,
compiler workers, or preview component state directly.

```text
AiWorkspacePort
  project reference and access mode
  list/search/read bounded text context
  capture active selection and document snapshot
  read or await exact compile diagnostics
  validate and apply one approved edit
  subscribe to generation invalidation
```

The port is assembled at the Workspace composition boundary. It delegates
each operation to the owner that already enforces its invariants. AI state does
not copy the Workspace file graph, live document text, assets, diagnostics, or
compiler output into an independent store.

## Edit proposal and review

The first release permits one outstanding, single-file proposal. A proposed
edit carries at least:

- the Workspace generation;
- immutable document identity and normalized path;
- a base snapshot reference, including the collaboration state needed for an
  exact freshness check;
- validated text changes;
- a candidate document used only for diff presentation.

The Assistant panel shows only a proposal summary. `Review changes` places the
central Editor into a diff surface with the current and proposed content and
explicit Reject and Accept actions. A narrow chat panel is not the code-review
surface.

Any local or remote change to the base document makes the open proposal stale.
Accept is disabled immediately. On acceptance, the Workspace owner performs a
final synchronous freshness and permission check, then applies the accepted
change as one collaboration-aware transaction. Compilation follows through
the existing compiler lifecycle. The agent receives the resulting document
and World references, not an optimistic success invented by the AI feature.

Reject and stale are tool feedback. The model may explain, reread, or propose a
replacement. Stopping a run cancels the pending tool call and exits review.
Revision and read-only modes never expose the apply operation.

Atomic multi-file edits, partial acceptance, automatic rebasing, and session-
wide write permission are outside the first release.

## Compile feedback

Verification does not create another compiler. A `verify current project`
tool asks the existing compilation owner to await a settled result for the
exact Workspace generation, immutable compile input World, and compile target.
It returns current success, bounded diagnostics, runtime failure, or
supersession.

This lets an agent repeat read, review, apply, and verify while keeping browser
Typst or LaTeX compilation authoritative. The AI feature never polls the
Preview component and never interprets a canvas as compiler state.

## State ownership

| State | Owner |
| --- | --- |
| Project identity, access, documents, and generation | Existing Workspace session |
| Collaborative active text | Yjs and CodeMirror |
| Compile inputs, lifecycle, diagnostics, and output | Existing compiler actors and reducers |
| Model/tool loop, canonical agent messages, streaming, and cancellation | `pi-agent-core` Agent inside the opaque-origin AI Runtime |
| Assistant transcript view projection | Feature-scoped host client memory populated by sanitized Runtime events |
| AI connection metadata | Versioned, account-scoped Local Storage profile store |
| AI connection credential and endpoint binding | Memory only inside the current opaque-origin Runtime iframe |
| Outstanding proposal and review decision | Feature-scoped review controller keyed by Workspace generation |
| Panel visibility, draft prompt, expanded rows, and scroll position | Focused React presentation state |

`AiRuntimeClient` and its Runtime session are keyed by access identity, project,
and Workspace generation. The client projects validated Runtime events into
React through an external-store subscription rather than copying every streamed
token through a chain of component props. High-frequency editor and compiler
data remains with its engine owner.

The agent library already owns its internal lifecycle. A feature-scoped actor
or reducer is justified only for TOSS-specific invalid transitions such as
review, stale proposal, application, verification, and generation expiry. It
must not mirror `Agent.state.isStreaming` or create a second model/tool loop.

## Security and privacy

- Model requests go directly from the browser to the selected endpoint.
- Credentials are entered and held in a dedicated opaque-origin Runtime. They
  never enter host JavaScript, TOSS Core, a project document, an agent message,
  a tool result, application logs, or error telemetry.
- No deployment-wide model credential may be sent to a browser.
- Credentials are never persisted. Reload, tab close, logout, and account
  change clear them; changing the connection's normalized base URL clears them
  before reuse.
- Persisted connection profiles contain only validated non-secret metadata and
  are treated as untrusted input every time they are loaded.
- The host and Runtime establish a dedicated `MessageChannel` through exact
  frame-window, parent-origin, one-time nonce, and build-version validation.
  Opaque `event.origin` is never mistaken for an authenticated child identity.
  Both sides reject unknown message types, schema versions, oversized payloads,
  duplicate IDs, and stale session IDs.
- The Runtime exposes agent semantics rather than a generic authenticated
  network primitive. Provider requests remain bound to the full normalized
  base URL shown during credential entry and reject redirects.
- Project files are untrusted model input, not instructions. Prompt injection
  cannot bypass the fixed tool allowlist or human write review.
- Context is acquired explicitly or through bounded tools. The feature does
  not upload every file, binary asset, hidden value, or unrelated project by
  default.
- Arbitrary network and code-execution tools are absent.
- Provider responses, Markdown, links, filenames, diagnostics, and tool
  details are rendered as untrusted content.
- The application CSP keeps model endpoints out of `connect-src`, permits only
  its own Runtime route in `frame-src`, and thereby blocks the Runtime from
  navigating itself to an attacker-controlled external frame document.
- The iframe uses `sandbox="allow-scripts"`, without `allow-same-origin`, form,
  popup, top-navigation, download, presentation, or pointer-lock permission.
  The Runtime response repeats `sandbox allow-scripts` in CSP so direct
  top-level navigation does not regain a normal principal.
- The Runtime response starts with `default-src 'none'`, a pinned bootstrap,
  no child frames, forms, objects, or base URL changes, and a bounded network
  upper policy. Before provider code or a credential exists, the bootstrap adds
  an intersecting policy with the selected endpoint's exact origin. After the
  fixed module graph loads, another intersecting policy forbids all later script
  and worker loads before credential entry.
- Runtime module and chunk responses allow anonymous cross-origin module loads
  from the opaque principal. They are public immutable assets and never carry
  configuration, credentials, or authenticated content.
- Runtime JavaScript cannot read host cookies or browser storage and cannot be
  controlled by the application's service worker. The initial iframe document
  request can nevertheless include a path-matching host cookie; its explicit
  static handler ignores authentication and never reflects request state.
- The Runtime bundle is small, pinned, self-hosted by the deployment, free of
  third-party page scripts and model-generated DOM, and does not register a
  service worker. Dependency review and reproducible artifact provenance are
  prerequisites for accepting even an in-memory credential.
- Provider endpoints must allow browser requests with an opaque `Origin: null`.
  Private-network and loopback endpoints remain subject to browser CORS,
  mixed-content, Local Network Access or Private Network Access, and browser
  permission policy. The product diagnoses these failures and never silently
  falls back to a Core proxy.
- Read-only and historical project modes do not expose mutation tools.

Memory-only storage limits at-rest and post-reload exposure. Opaque-principal
isolation also prevents ordinary host code from directly reading the
credential, but it is not a secure vault: hostile Runtime code can access the
secret, hostile host code can imitate the small credential UI or attempt quota
abuse through the deliberately narrow agent protocol, and a compromised build
can weaken the intended boundary. The security claim must remain this precise.

The claim assumes the browser, pinned Runtime artifact, and user-selected
provider perform their intended roles. It protects a credential correctly
entered into that Runtime against direct reads by ordinary host code and
against accidental application persistence. It does not protect against a
malicious browser extension, compromised browser, malicious Runtime artifact,
provider that deliberately echoes the secret, or host UI that tricks the user
into typing into an imitation control. Runtime-to-host events and errors still
apply exact-secret redaction as defense in depth, and provider adapters never
place credentials in URLs, but redaction is not promoted into an impossible
general noninterference guarantee.

### Prototype evidence to retain as regression tests

A local Chromium spike established the feasibility of the default, while not
substituting for the required cross-browser suite:

- the sandboxed same-URL frame raised security errors for parent DOM, Local
  Storage, cookies, and service-worker access;
- its window messages serialized the child origin as `null`, and its endpoint
  fetches carried `Origin: null`;
- the application's root service worker did not control or intercept the
  opaque frame;
- JavaScript module loading failed without anonymous CORS and succeeded with
  `Access-Control-Allow-Origin: *`;
- the entry navigation could carry the current path-matching HttpOnly cookie,
  although Runtime script could not read it; an opaque-frame POST using
  `credentials: "include"` did not carry the application's SameSite=Lax cookie,
  but the design still requires `credentials: "omit"` rather than relying on
  that incidental protection;
- an exact endpoint meta CSP blocked other endpoints, continued to apply after
  its meta element was removed, and intersected with the response policy; and
- the application's `frame-src 'self'` blocked the child from navigating its
  own frame to an external origin.

Firefox and WebKit behavior, Local Network Access prompts, provider streaming,
and production response-header composition remain implementation gates.

### Why a second origin is not the baseline

The required property is a different browser security principal, not a
different hostname. The opaque sandbox supplies that property without making a
second deployment topology mandatory. The trade-off is explicit:

| Concern | Same-URL opaque Runtime | Future real-origin Runtime |
| --- | --- | --- |
| Host DOM and storage | Browser-enforced opaque principal; no `allow-same-origin` | Same-origin policy isolates a genuinely different origin |
| Provider CORS identity | Sends `Origin: null`; some providers or gateways may reject it | Sends one stable, exact Runtime origin |
| Application cookies | Entry navigation may carry path-matching host cookies, but Runtime script cannot read them and provider fetches omit credentials | Host-only cookies stay on the app host; parent-domain cookies and port-only separation require care |
| Application service worker | Opaque document has no active application service-worker controller | Separate origin has a separate service-worker namespace and must not register one |
| Deployment cost | One artifact, hostname, certificate, and local-dev origin | Additional DNS, TLS, Ingress, CSP, CORS, and local-dev configuration |
| Credential UI authenticity | An iframe can be visually imitated by compromised host UI | A cross-origin iframe can still be visually imitated; only a separately visible top-level origin materially helps |
| Compromised Runtime code | Can read and misuse the credential | Can read and misuse the credential |

This makes provider and browser compatibility, rather than basic DOM
isolation, the main reason to introduce another origin.

### Optional real-origin compatibility mode

A distinct Runtime deployment origin remains a possible later mode when a
provider refuses `Origin: null`, an enterprise gateway requires an exact CORS
origin, local-network permission delegation requires a non-opaque origin, or
operators want a credential surface with an independently visible address-bar
identity. It would use the same origin-neutral Runtime bundle in a genuinely
cross-origin iframe with `sandbox="allow-scripts allow-same-origin"` and an
exact-origin bootstrap handshake.

That mode is not automatically safer. A different port is a different web
origin but does not isolate cookies. A subdomain on the same registrable site
isolates DOM access but is not a complete CSRF or same-site-cookie boundary;
Core must still enforce Origin or Fetch Metadata checks for authenticated
mutations. A different site provides a stronger cookie boundary but increases
deployment, CSP, CORS, certificate, and local-development complexity. If the
real risk is host UI spoofing during credential entry, a user-confirmed
top-level popup with a visibly separate origin is stronger than either iframe.

The first release implements only the opaque-origin mode, while keeping Runtime
assets and protocol schemas origin-neutral. A real-origin mode should be added
only after provider and browser compatibility evidence justifies a second
product topology. Experimental mechanisms such as credentialless iframes are
not part of the baseline.

### Why other browser primitives do not replace the iframe

- Shadow DOM and component boundaries organize UI but create no security
  principal.
- COOP, COEP, and `crossOriginIsolated` control process and shared-memory
  behavior; they do not prevent one same-origin document from reading another.
- A dedicated worker removes DOM access but gives its creator a direct message
  channel. If credential input remains in the host, the host already saw the
  secret; if input remains in the sandboxed Runtime, the worker is only an
  internal implementation detail.
- A service worker has the wrong persistence and interception lifecycle for an
  intentionally ephemeral credential holder.
- `srcdoc` can create an opaque document but makes immutable response headers,
  artifact provenance, module delivery, and direct-navigation hardening less
  explicit than a reserved static route.
- A popup is justified only if a visible address-bar origin is needed to help
  the user authenticate the credential surface. It is not required for the
  first release's DOM and storage boundary.

## Accessibility and interaction details

- The toolbar control, panel, connection dialog, context chips, activity rows,
  review controls, and status changes use NVIDIA Elements where it supplies
  the correct primitive.
- Opening and closing the panel restores focus predictably.
- Streaming text is visually incremental but assistive announcements are
  batched; screen readers are not notified for every token.
- Awaiting review, stopped, stale, rejected, applying, verifying, completed,
  and failed are distinguishable without relying on color alone.
- Enter sends, Shift+Enter inserts a newline, Escape closes transient menus,
  and all review actions remain keyboard reachable.
- Reduced-motion preferences disable decorative streaming animation.

## First-release scope

The proposed first release contains:

- the `ai_assistant` build and deployment gate with a lazy feature chunk;
- the same-release Runtime artifact, explicit reserved routes, opaque iframe
  sandbox, fixed bootstrap, and two-stage endpoint CSP;
- local AI connection creation, testing, selection, and removal;
- one current local conversation per project;
- streaming messages and repeated read-only tool calls;
- visible active-file, selection, diagnostic, revision, and `@file` context;
- contextual selection and diagnostic entry points;
- one outstanding single-file edit proposal;
- central diff review, explicit accept/reject, and stale detection;
- one collaboration-aware apply transaction per accepted proposal;
- exact browser compile feedback and repeated agent turns;
- cancellation and strict account/project/generation fences;
- deterministic fake-model and fake-tool test fixtures.

The first release excludes general attachments, generated artifacts, remote
MCP, web search, shell or JavaScript tools, sub-agents, durable AI tasks,
multi-file atomic edits, auto-approval, server-side prompts, shared operator
credentials, persistent browser credentials, and server-side conversation
storage. It also excludes a separately deployed real-origin Runtime mode.

## Testing strategy

No CI test uses a live model credential. Deterministic tests use the upstream
fake provider or a small in-memory stream implementation.

Vitest should cover:

- build/deployment gating and lazy-load boundaries;
- Local Storage profile versioning, corruption handling, account isolation,
  endpoint sanitization, full-base-URL binding, and memory-only credential
  lifetime and clearing;
- bootstrap endpoint normalization and rejection, exact-origin CSP policy
  construction, and the rule that full Runtime code loads only after policy
  installation and no new code loads after credential entry;
- exact build-version matching, frame-window and parent-origin checks, nonce
  validation, one-use port transfer, message validation, duplicate and stale
  IDs, size limits, cancellation, and Runtime replacement;
- endpoint changes, redirect rejection, credential-omitting fetch defaults,
  and the absence of a generic authenticated fetch message;
- repeated tool turns, parallel reads, sequential writes, and cancellation;
- accept, reject, stale snapshot, generation expiry, and compiler
  supersession;
- account/project changes while streaming or awaiting review;
- bounded context and tool output;
- event-to-view projection without token-level React state duplication.

Playwright should cover:

- first-run connection setup through the real opaque-origin Runtime and a fake
  browser endpoint;
- host CSP isolation, exact-endpoint Runtime CSP, provider `Origin: null` CORS
  diagnostics, anonymous module loading, iframe recreation, credential clearing,
  post-bootstrap script/worker blocking, and inability of host script to read
  the Runtime credential field;
- Runtime inability to read host DOM, cookies, Local Storage, IndexedDB, or
  service workers; self-navigation detection and session invalidation; and
  continued sandboxing when the Runtime entry is opened directly;
- wide, drawer, and single-panel Assistant layouts;
- selection and diagnostic contextual entry;
- a multi-turn read, proposal, review, apply, and verify workflow;
- collaboration changes from a second browser making a proposal stale;
- read-only and revision-mode absence of write controls;
- keyboard and focus behavior;
- an AI-excluded distribution build containing no Assistant entry or feature
  chunk.

Before enabling the feature by default anywhere, the isolation suite runs in
Chromium, Firefox, and WebKit, and the connection matrix exercises representative
OpenAI-compatible cloud endpoints, Ollama, LM Studio, and vLLM without live CI
credentials. It records `Origin: null`, streaming, preflight, loopback, mixed-
content, and Local Network Access behavior rather than assuming one browser's
policy applies to all of them.

## Open decisions

The following details are intentionally unsettled:

1. the initial wire-protocol adapters and which of them pass real browser CORS
   and streaming tests against user-configured endpoints;
2. the connection metadata schema and protocol-specific advanced fields;
3. whether anonymous sessions may persist a non-secret connection profile or
   remain memory-only;
4. the exact agent tool names, JSON schemas, output limits, and error codes;
5. prompt construction, project-data boundaries, context pruning, and
   transcript compaction;
6. default run budgets for model turns, tool calls, elapsed time, context, and
   repeated edit-review cycles;
7. whether a rejected proposal ends the run or normally lets the model offer a
   non-editing alternative;
8. the diff implementation and how proposed ranges are represented across
   CodeMirror and Yjs;
9. inactive-document edit behavior in the first release;
10. AI availability and connection-metadata behavior for anonymous and shared
    projects;
11. model switching semantics inside an existing conversation;
12. conversation retention, reset confirmation, and future history UI;
13. whether trusting the fixed Runtime artifact plus navigation-triggered
    revocation is sufficient for credentials, or provider execution needs an
    additional non-navigable boundary;
14. placement and sizing of the small Runtime-owned credential surface inside
    host-owned connection management;
15. tested opaque-origin CORS, mixed-content, and private-network behavior for
    cloud, gateway, and local endpoints, including any required Permissions
    Policy delegation;
16. cost and token-usage presentation without introducing telemetry of prompt
    or project content;
17. final names, icons, localized copy, and keyboard shortcuts;
18. whether the authentication cookie can safely use a narrower `/v1` path so
    it is absent even from the Runtime entry navigation;
19. the evidence threshold and deployment contract for a future real-origin
    compatibility mode.

## Proposed delivery slices

1. **Implemented:** record the working design and optional-feature dimensions.
2. **Implemented:** add the feature gate, generic auxiliary-panel extension,
   versioned host protocol client, separately built artifact, fixed bootstrap,
   explicit Core routes, and fake opaque-origin Runtime.
3. Add endpoint-bound CSP, secure connection management, `pi-agent-core`,
   selected provider adapters, and read-only multi-turn chat.
4. Add bounded Workspace read, search, selection, and diagnostic tools.
5. Add single-file review, stale detection, and collaboration-aware apply.
6. Add exact compile feedback and bounded repair loops.
7. Complete cross-browser CSP, opaque-origin CORS/private-network validation,
   accessibility, responsive behavior, artifact provenance, and cross-session
   security tests before enabling the feature in a deployment.

Each slice must preserve an AI-excluded build and may not introduce a server
fallback or worker dependency.

## Related

- [Frontend architecture](./frontend.md)
- [Typed optional feature dimensions](../decisions/0009-typed-optional-features.md)
- [Deployment configuration](../configuration/deployment.md)
- [Distribution configuration](../configuration/distributions.md)
- [Product and editor design language](../../../web/DESIGN.md)
