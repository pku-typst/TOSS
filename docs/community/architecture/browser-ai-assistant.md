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
discussion, the implemented infrastructure/provider/read/review slices now
present on `dev`, and the remaining choices. Sections marked as implemented are
current contracts; isolated candidate compile feedback is implemented, while
selection, current-preview diagnostics, general verification, and broader edit
behavior remain target design until their delivery slices land. Durable
rationale may later be promoted into an ADR.

## Agreed baseline

| Area | Baseline |
| --- | --- |
| Runtime | The provider connection and agent loop run in a browser AI Runtime isolated as a unique opaque-origin iframe. TOSS Core does not proxy or execute model requests. |
| User-provided AI | BYOK includes cloud API credentials, short-lived tokens, user-controlled gateways, OpenAI-compatible endpoints, and local services such as Ollama, LM Studio, or vLLM. |
| Connections | TOSS ships no branded provider preset. A user defines each connection's name, API protocol, endpoint, model, reasoning capability, exact Provider request parameters, context window, maximum output tokens, and optional credential. The host application may persist sanitized non-secret profiles in account-scoped Local Storage for later reuse. |
| Credentials | The user enters a credential into the sandboxed Runtime surface, and it exists only in that Runtime instance's memory. The host application, TOSS Core, and project never receive it. Reload, tab close, logout, account change, or endpoint change clears it. |
| Conversations | A project owns zero or more local browser conversations and one active-conversation pointer. Conversations never cross an account or project boundary. Switching conversations resets the Runtime Agent context but keeps the current in-memory credential. |
| Conversation persistence | For signed-in accounts, the host persists a bounded, sanitized transcript projection in IndexedDB. It never persists credentials, reasoning, system prompts, raw tool results, source excerpts, or patches. Anonymous conversations remain component-memory only. TOSS Core does not store them. |
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

The infrastructure, provider, bounded Workspace-read, and first reviewed-edit
slices are implemented. They contain:

- the `ai_assistant` distribution/build/deployment gate, included by Community
  but disabled by default;
- a lazy feature entry expressed to the Workspace through a generic optional
  panel descriptor;
- one mutually exclusive auxiliary-panel state for Assistant, Settings, and
  Revisions;
- a separately built `/_ai-runtime/bootstrap.html` artifact with a fixed,
  versioned protocol and deterministic fake provider for tests;
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
  a local OpenAI-compatible SSE endpoint through the real pi adapter,
  an executed local Typst 0.15 documentation query, multi-turn history,
  credential binding and clearing, panel preservation, and session invalidation
  on Runtime navigation; the same harness can optionally
  exercise a user-supplied external endpoint without placing its credential in
  command arguments or repository files;
- strict schema-v1, account-scoped Local Storage profiles containing only a
  connection name, protocol, normalized endpoint, model ID, reasoning
  capability declaration, bounded Provider request JSON, context window, and
  maximum output tokens; anonymous
  sessions keep the same metadata in component memory only;
- project-bound multiple conversations with create, select, rename, and delete
  controls; authenticated conversations use a bounded account/project-scoped
  IndexedDB store, while anonymous conversations remain in memory;
- a sanitized durable projection containing visible user/assistant text and
  allowlisted tool presentation summaries, explicitly excluding reasoning,
  credentials, system prompts, raw tool results, source excerpts, and patches;
- Runtime-owned optional credential entry after the exact endpoint policy and
  selected protocol module are installed, with the credential retained only by
  the current Runtime `Agent` closure;
- exact `0.80.7` dependencies on `@earendil-works/pi-agent-core` and
  `@earendil-works/pi-ai`, a stateful streaming multi-turn `Agent`, cancellation,
  bounded provider requests, and generic model construction without a provider
  catalog or preset; and
- lazy protocol adapters for OpenAI-compatible Chat Completions, OpenAI
  Responses, and Anthropic Messages, plus a full-base-URL fetch fence that
  forces omitted browser credentials, rejected redirects, and no referrer;
- a Workspace-owned, bounded project-state snapshot attached to every user
  turn and incorporated into the Runtime system prompt, covering project/view
  identity, active document, access, file counts, synchronization state,
  compilation summary, and pending review without eagerly sending source;
- protocol-v1 content lifecycles for separate text and reasoning blocks,
  bounded conversation initialization and switching, plus a
  host-side transcript projection made of sanitized text, reasoning, and tool
  activity parts rather than a second copy of the agent message model;
- user-declared model context/output limits, a `transformContext` budget pass
  before every provider request, explicit context/call/time budget failures,
  and a sanitized live usage projection that distinguishes provider-reported
  tokens from estimates;
- a connection-level reasoning capability declaration plus exact, bounded JSON
  request overrides; pi does not synthesize a universal reasoning field, and
  an empty object leaves Provider defaults authoritative;
- `list_project_files`, `read_project_file`, and `search_project_text` tools
  backed by a generation/revision-fenced Workspace-owned port, with current
  Yjs text for the active live document and bounded line-numbered output; and
- writable-live-only `apply_patch` and `write_file` tools. The former validates
  one contextual single-file unified-diff proposal; the latter is a bounded
  fallback that requires a complete, untruncated read of the exact snapshot and
  accepts the complete replacement text. Both feed one shared unpublished
  candidate pipeline, isolated compilation, explicit review, and final
  freshness-checked Yjs transaction.

The current slice does not yet expose active selection, current-preview
diagnostics, a general compile-current-World tool, inactive-document editing,
file creation/deletion/rename, or multi-file edits. Connection testing without inference, model discovery,
redaction-focused browser tests, Firefox, and WebKit validation also remain
before enabling the feature by default.

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
| Host to Runtime | initialize locale, tool definitions, and a bounded conversation; update locale; switch conversation; start a user turn with its conversation ID and a bounded Workspace-state snapshot; return a tool result; cancel a turn; clear the session |
| Runtime to host | ready and connection state, typed content start/delta/end events, typed tool call, turn completion, sanitized usage and error state |

Protocol version 1 initializes with a bounded locale, non-secret connection
profile including user-declared context and output limits, tool definitions,
conversation ID, and restored visible history. It
can replace the inactive conversation without recreating the Runtime, reports
`credential_required` or `ready`, starts and cancels turns, clears the session,
and returns only stable sanitized errors. Every start-turn message repeats the
conversation ID, and the Runtime rejects a mismatch. Each turn carries an exact
Workspace-state snapshot validated on both sides. The Runtime emits distinct
`text` and `reasoning` blocks through
`content_start`, ordered `content_delta`, and `content_end` messages. The host
rejects duplicate, missing, or out-of-order block transitions instead of
guessing at malformed provider output.

Tool lifecycle events remain separate from model content. The host view stores
only the tool name, a small allowlisted input summary, state, outcome, and
timestamps for presentation; patches, source results, credentials, and raw
protocol messages do not enter the view transcript. While a Runtime is alive,
the canonical model/tool history remains inside its `pi-agent-core` Agent. For
reload or conversation switching, the host supplies only a bounded sequence of
completed visible user/final-answer pairs; it does not reconstruct private
reasoning or the prior tool protocol.

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
6. for a Typst project, it loads and validates the bundled API, BM25, recipe,
   and provenance modules while the nonce-authorized bootstrap graph can still
   grow;
7. after the complete project-specific module graph is resident, it installs
   another intersecting policy with `script-src 'none'` and `worker-src 'none'`,
   so no later script, module, or worker can be loaded after a credential
   exists;
8. only then does the full Runtime present its credential input; and
9. changing the base URL destroys and recreates the iframe, clearing the old
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
| Assistant       connection / model          x  |
+------------------------------------------------+
| conversation                       + rename del |
+------------------------------------------------+
| user and assistant messages                    |
| compact tool activity                          |
| edit proposal summaries                        |
+------------------------------------------------+
| explicit context chips                         |
| multiline composer                    Send/Stop |
+------------------------------------------------+
```

The header opens connection management and closes the panel. A compact row
below it selects, creates, renames, or deletes a project conversation. These
controls are disabled during a running turn and during the one-time Runtime
handshake. Changing the active connection recreates the Runtime and clears its
credential; changing only the conversation reuses the Runtime and credential
while resetting the Agent context.

The message surface uses the product's flat professional editor language.
Tool calls are compact human-readable activity rows such as `Read main.typ`,
`Searched 8 files`, or `Waiting for compilation`. Consecutive reasoning and
tool parts are grouped into one collapsible **Agent activity** section. It opens
while work is active and collapses after completion unless the user has chosen
a state. Reasoning is labeled as model-provided, rendered as untrusted plain
text, and kept visually separate from the final Markdown answer; raw tool JSON
is never shown. File references expose only validated path/range summaries.

Assistant text is rendered incrementally as Markdown with fenced code, GFM
tables, and baseline KaTeX math using `$...$` inline or opening and closing
`$$` display delimiters on their own lines. The Markdown pipeline keeps raw HTML disabled and configures KaTeX
with `trust: false`; CSS and fonts are local build assets rather than CDN
resources. Typst and LaTeX source remains fenced code. Display math scrolls
horizontally inside a narrow panel. The host batches high-frequency view updates
to an animation frame and uses a separate coarse live region so streaming does
not announce every token. Copy applies only to the final answer, not reasoning
or tool data.

The composer supports a multiline prompt, Enter to send, Shift+Enter for a
newline, and a Stop action while the run is active. It shows explicit context
chips for the active file, selected text, diagnostics, a historical revision,
or files chosen through an `@` picker. A chip expresses user focus; it does not
eagerly copy the whole project into the model request.

Streaming follows the bottom only while the user remains at the bottom. A user
reading earlier content receives a `Jump to latest` affordance instead of
being pulled down by every delta.

## Conversation lifecycle and persistence

Conversation is a host-owned feature entity, not a `pi-agent-core` entity and
not a Core aggregate. Its identity is scoped by `(accountId, projectId)`, and a
project has an ordered collection plus one active-conversation pointer. The
current implementation keeps at most 50 conversations per project, 200
presentation messages per conversation, and 2 MiB of serialized conversation
data. The first prompt supplies an automatic bounded title; the user may rename
or delete it. Deleting the last conversation immediately creates an empty
replacement.

For an authenticated account, the `AiConversationStore` persists schema-v1
records in the host origin's `toss-ai-conversations` IndexedDB database. The
stored projection contains visible user text, visible assistant answer text,
allowlisted tool name/path/query/range summaries, terminal state, and
timestamps. It excludes all reasoning blocks, credentials, system prompts,
provider request/response envelopes, raw tool inputs and results, returned
source excerpts, and edit patches. A final answer can itself quote project
content, so this is local browser data rather than a secret-free audit log; a
person or script with access to the browser profile can inspect it. Core never
receives or backs up this database. Anonymous conversations are kept only in
component memory and disappear when the project page is replaced.

Writes are serialized, streaming updates are debounced, and terminal updates
flush immediately. Scope cleanup captures the old account/project before a new
scope becomes active, so a delayed write cannot land in another project. Quota,
corruption, or IndexedDB failures fail down to the in-memory collection rather
than blocking chat. Loading validates and bounds every record instead of
trusting browser storage.

The Runtime receives at most the newest 24 messages (12 completed visible
user/assistant pairs), capped at 32,768 characters per message and 48,000
characters total. Interrupted, cancelled, failed, tool-only, and empty answers
remain visible when useful but are not restored into model context. A
conversation switch is rejected while a turn or handshake is active. Otherwise
the Runtime resets `Agent` messages, installs the selected bounded history, and
changes the provider session key from
`connectionId:oldConversationId` to `connectionId:newConversationId`; the
credential stays in the same Runtime heap. A page reload restores the local
transcript but creates a new Runtime, so the user must enter the credential
again.

## Contextual entry points

The toolbar is the general entry point. The first release should also expose
two contextual actions:

- `Ask Assistant` for a non-empty editor selection;
- `Explain` or `Suggest fix` beside compiler diagnostics.

These actions open the panel and populate a draft with visible context. They do
not send a model request before the user can inspect or amend the prompt.

Revision mode and read-only access still permit explanation. They do not
register a mutation tool. Anonymous sessions use memory-only connections and
conversations; broader eligibility policy for shared projects remains open.

## AI connections

The first-run panel shows one `Add AI connection` action. Connection creation
uses one progressively disclosed dialog rather than a wizard. There is no
provider gallery or branded quick-start choice. The form contains a connection
name, a supported API protocol, an endpoint, a model, a reasoning-capability
declaration, an exact Provider request-parameter JSON object, a context window,
a maximum output-token count, and an optional credential. Context and output
limits are explicit common fields because a generic endpoint and model ID do
not provide trustworthy model metadata. The JSON object carries
Provider/model-specific options without pretending they share one schema.

Common behavior is:

1. name the connection and select a supported API protocol;
2. enter non-secret endpoint metadata in the host and an optional credential
   in the Runtime-owned sandboxed surface, which displays the exact bound
   destination base URL;
3. test connectivity and authentication without intentionally starting a paid
   inference request;
4. discover models when supported or accept a manual model ID, declare whether
   it emits reasoning, enter documented Provider request parameters, and set
   the context window and maximum output;
5. review the normalized profile and save.

The current connection-management slice implements profile creation, selection,
editing, removal, the Runtime credential step, and a manually entered model
ID. A saved profile becomes active without claiming that authentication or
model availability was tested. Connectivity testing and model discovery in
steps 3 and 4 remain planned work.

Connectivity errors must distinguish unreachable endpoints, browser or CORS
blocking, rejected credentials, unsupported model discovery, and invalid
responses. TOSS never silently redirects a failed connection through a proxy.

Non-secret connection metadata is retained in account-scoped Local Storage so
a future application instance can restore the connection name, protocol,
endpoint, model, reasoning-capability declaration, Provider request parameters,
context window, and maximum output. Session Storage is not used for connection
profiles: it adds another persistence path without satisfying next-session
reuse.

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
    reasoning: boolean
    requestOverrides: bounded JSON object
    contextWindow: integer tokens
    maxOutputTokens: integer tokens
```

This is the unreleased feature's first connection schema; development drafts
do not create a compatibility chain. The Runtime rejects impossible token pairs
that leave no bounded input and safety allowance. The request object must be a
bounded JSON object. It cannot override model identity, messages, system
instructions, tools, tool choice, streaming fields, token-limit fields, or
headers, and recursively rejects credential-like and prototype-mutating keys.

The Local Storage key is scoped by the authenticated account ID. Logging out
retains that account's non-secret profiles for its next login, clears all
in-memory credentials, and prevents another account from seeing those profiles
through the product UI. Account scoping is an application boundary, not a
claim that Local Storage hides data from same-origin JavaScript or a person
with browser-profile access.

A stored endpoint must be a base URL without URL user information, query
parameters, or a fragment. Credentials, signed URLs, arbitrary headers, and
protocol options classified as secrets are not profile metadata. Provider
request overrides are non-secret configuration only. Every stored profile is
parsed, size-bounded, normalized, and validated again on load rather than
treated as trusted state.

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
connection metadata stays in component memory and is not restored after the
page is replaced. Credentials are not shared between tabs or accounts.

## Agent and tool loop

One user request may run several internal turns:

```text
user asks for a fix
  -> model reads relevant files
  -> tool returns bounded snapshots
  -> model submits a candidate edit
  -> isolated candidate compiler returns bounded errors/diagnostics
  -> model repairs and resubmits until the candidate passes
  -> browser pauses for review
  -> user accepts or rejects
  -> tool reports the decision
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

Before each user turn, the Workspace owner supplies a schema-versioned snapshot
of the current project name and type, live or revision view, entry and active
paths, read/edit access, Workspace/document readiness, text/asset counts,
compile state and diagnostic counts, and pending-review state. The Runtime
places that JSON inside a delimited system-prompt context block and explicitly
treats every value as untrusted project data rather than instructions. This
gives the model basic orientation without sending source, selections, full file
lists, or diagnostics. If exact or newer data matters, the model must call a
bounded Workspace tool.

The stable system prompt states that the Runtime is a browser Workspace
assistant, requests responses in the user's language, describes the granted
tool and mutation constraints, and asks the model to acknowledge uncertainty.
All model-visible system instructions, tool descriptions, and parameter
descriptions come from one locale-independent English definition. Runtime and
host presentation labels may still follow the selected UI locale; changing
that locale cannot alter the prompt or Provider tool schemas.
For Typst projects the prompt also directs the model to query the bundled,
version-pinned reference before guessing syntax, signatures, parameter types,
or fixes for compiler diagnostics. The reference is retrieved only when the
model calls its tool; it is not injected into every turn.
It is refreshed from the turn snapshot before `Agent.prompt`; the snapshot is
then frozen for that turn while tool results remain authoritative for changing
state. `pi-agent-core` is the sole owner of the live canonical model/tool loop.
The host owns only the presentation transcript and the bounded visible-history
projection used to restore a conversation; it does not implement a second
agent loop. TOSS deliberately does not combine pi with a second agent runtime
such as AI SDK.

Reasoning behavior is explicit connection metadata, not a hidden Runtime
default. The boolean declares only that the model emits reasoning content; it
maps to pi's model capability so response blocks and multi-turn history are
handled correctly. It does not add a request field. The Agent thinking level
stays `off`, preventing pi from synthesizing a supposedly universal effort
parameter.

The bounded `requestOverrides` JSON object is merged into every generated
Provider payload inside the isolated Runtime, after pi has built the canonical
request. Nested objects are merged and arrays are replaced. Consequently users
can enter the exact shape documented by their model, such as OpenAI Responses
`reasoning`, OpenAI-compatible `reasoning_effort`, Anthropic `thinking`, or NIM
`chat_template_kwargs`/`nvext`, without TOSS translating between them. `{}`
leaves Provider defaults untouched. Invalid or unsupported fields surface as a
Provider error; TOSS never retries with guessed semantics.

Before every provider request, the Agent's `transformContext` hook reserves the
user-configured maximum output plus a fixed safety allowance. It first removes
complete older conversation turns from the provider view, then compacts older
completed tool payloads while preserving the current user request and latest
tool batch. The canonical Agent transcript is not mutated. The transform is
recalculated from that raw transcript on every request so previously omitted
history cannot reappear merely because a later response contains a usage
block. If the current request, system prompt, tool schemas, and latest tool
result still cannot fit, the run ends with
`ai_agent_context_budget_exceeded`; it never sends an over-budget request or
silently reduces the configured maximum output.

Provider usage is accepted from the final message of each internal model call.
The Runtime normalizes and sends only token counts: input, output, reasoning,
cache read/write, total, provider-call count, latest context size, and number
of compacted messages. It sends no prompt, source, patch, response body, price,
or credential. The host shows both latest context occupancy and cumulative
token traffic for the current user turn. `provider reported`, `partial usage`,
and `estimated` are distinct states because compatible endpoints are not
guaranteed to return streaming usage. OpenAI-compatible requests ask for the
standard streamed usage block; absence of that block is not treated as a
fabricated zero-token report.

## Initial tool surface

The Runtime exposes one local knowledge tool for Typst projects:

- `query_typst_docs`, which searches the bundled Typst 0.15.0 API and a small
  set of compile-verified usage recipes.

This tool is owned and executed by the isolated Runtime. It does not cross the
Workspace bridge, receive project content, access the Provider credential, or
perform a network request. The API and BM25 data are generated as separate
Runtime chunks. A Typst Runtime loads and validates those chunks during
bootstrap, before the final `script-src 'none'` policy is installed, and keeps
the decoded index in its private heap. LaTeX projects do not pay that cost.
Queries therefore require no later module load or network request, and the
Runtime's Provider-only `fetch` policy and locked CSP need no additional
destination. Search input and output are bounded; exact names, API signatures,
parameter types, enum values, official documentation routes, and ranked recipes
are returned as structured data. The model uses English API names or keywords
for lookup while continuing to answer in the user's language.

The reference asset is pinned to the same Typst language version as the
typst.ts compiler fork. Build validation checks its upstream revision,
checksums, normalized entry count, metadata signature, and the fork's declared
Typst dependency. A version mismatch fails the build rather than silently
giving the Agent newer or older advice. API signatures alone do not explain
all language conventions, so compile-verified recipes cover the narrow cases
most likely to produce plausible but invalid edits, initially document
metadata, content versus strings, set/show rules, arrays/dictionaries, and
imports/includes. Candidate compilation remains authoritative; documentation
lookup is guidance, not an acceptance oracle.

The Workspace-owned tool slice fixes these names and bounded schemas:

- `list_project_files`;
- `read_project_file`; and
- `search_project_text`; and
- `apply_patch`, only for writable live views; and
- `write_file`, only for writable live views and fully read small files.

Workspace tools are advertised from the Host in the versioned Runtime handshake, registered
as `pi-agent-core` tools only when granted, and executed through a
generation/revision-fenced Workspace application port. The active live document uses
the current collaboration/editor projection rather than a stale project copy.
Each tool call is correlated by session, turn, and call ID; cancellation crosses
the Runtime boundary, and both sides enforce call-count and concurrency budgets.

The broader first tool set should cover these narrow operations:

| Intent | Behavior |
| --- | --- |
| List project files | Return bounded path, kind, and identity metadata. |
| Read a text file | Return bounded, line-numbered text and an immutable snapshot reference. |
| Search project text | Return bounded path/range excerpts with line numbers, without arbitrary filesystem access. |
| Read active selection | Return the active document identity, line-numbered range, text, and snapshot reference. |
| Read diagnostics | Return diagnostics for an exact compiler World and target. |
| Propose one file patch | Validate a contextual single-file unified-diff proposal, compile an isolated candidate World, return failures for repair, and enter review only after it passes. |
| Propose one full-file replacement | Require a complete read of the exact snapshot, derive a canonical review diff from bounded replacement text, and use the same compile/review path as a patch. |
| Verify current project | Await the current browser compiler result for an exact generation and World. |

There is no generic filesystem, fetch, shell, JavaScript, database, Git, or
backend-impersonation tool. Tool outputs are structured, size-bounded, and
safe to render. Expected failures use stable typed reasons such as permission
denied, snapshot stale, generation expired, user rejected, compile superseded,
runtime failed, or output too large.

Text presented to the model follows the conventional numbered-code view. A
read result includes a one-based line range and a display string such as:

```text
snapshot: doc_7f...@sv_31...
path: main.typ
lines: 37-40
37 | #let title = "Example"
38 |
39 | = Introduction
40 | Existing text.
```

The `N | ` prefix is presentation metadata, not file content. Tool descriptions
and the system capability prompt explicitly tell the model not to copy those
prefixes into an edit. Search and selection results use the same convention so
the model sees one location vocabulary across tools.

The preferred write-side tool accepts a contextual single-file unified-diff
proposal rather than replacement text or an editor command. Its essential input is:

```text
path: normalized project path
base_snapshot: immutable snapshot returned by a read tool
patch: |
  --- a/main.typ
  +++ b/main.typ
  @@ -39,2 +39,2 @@
   = Introduction
  -Existing text.
  +Revised text.
```

The current slice accepts exactly the active existing text file per patch. The two
diff paths must both match `path`; create, delete, rename, binary, mode-change,
multi-file, context-free, and overlapping hunks are rejected. The old-file
start is a one-based unified-diff coordinate and must point at the exact hunk
body in the immutable snapshot. Context and removed lines must also match that
snapshot exactly: there is no fuzzy application and no automatic rebase. Hunk
line counts and new-file coordinates are redundant model output, so the host
derives and canonicalizes them from the validated body before compilation and
review. The host then builds the candidate document from the base snapshot,
applies output and changed-line limits, compiles the resulting unpublished
World, and only then enters review.
Failed compilation returns bounded structured diagnostics to the same agent
turn without creating an accept action. Line numbers help the model construct and
explain the patch, while the snapshot reference, document identity, Workspace
generation, and final collaboration-aware freshness check provide concurrency
safety.

`write_file` is a deliberate fallback for a small whole-file rewrite or for a
model that repeatedly fails to construct the patch format. Its input is:

```text
path: normalized active project path
base_snapshot: snapshot from one complete read_project_file result
content: complete desired file text without numbered display prefixes
```

The Workspace port records a full-read receipt only when one read starts at
line one, reaches the actual final line, and reports neither `has_more` nor
`content_truncated`. Partial reads cannot authorize replacement even though
they return a snapshot ID. Consequently, the initial implementation is bounded
by the read surface: at most 400 logical lines and 65,536 content characters.
It rejects empty, unchanged, NUL/lone-CR, or over-limit replacement input, and
does not rewrite a current file whose line endings are already mixed. Incoming
LF/CRLF line endings are normalized to the current file's uniform convention
and an existing final newline is preserved when the model omits it, so a model
cannot create incidental whole-file EOL churn.

The host computes a focused canonical unified diff from the old and replacement
texts. The model never supplies the review diff for `write_file`. Review marks
the operation as a full-file replacement and warns the user to check for
omitted content. The complete candidate then enters exactly the same compiler,
freshness, review-coordination, and collaboration transaction path used by
`apply_patch`; the two tools do not duplicate those lifecycle rules. Neither
tool creates, deletes, renames, or writes an inactive or binary file.

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
- the host-canonicalized unified diff and its parsed, validated text changes;
- a candidate document used only for preflight and diff presentation;
- a passing bounded compile result; and
- the exact immutable compiler-World revision used for that result.

The central Editor becomes the diff surface and presents explicit Reject and
Accept actions while the originating `pi-agent-core` tool call remains pending.
The narrow chat panel is not the code-review surface.

Any local or remote change to the base document or another compiler input makes the open proposal stale.
The patch is never silently rebased onto that newer text. Accept is disabled
immediately. On acceptance, the Workspace owner performs a final synchronous
freshness and permission check, then applies the already-reviewed candidate as
one collaboration-aware transaction. Normal live preview compilation follows
through the existing compiler lifecycle. The agent receives the accepted
document snapshot plus the pre-accept verification result, not an optimistic
success invented by the AI feature.

Reject and stale are tool feedback. The model may explain, reread, or propose a
replacement. Stopping a run cancels the pending tool call and exits review.
Revision and read-only modes never expose the apply operation.

Atomic multi-file edits, partial acceptance, automatic rebasing, and session-
wide write permission are outside the first release.

## Compile feedback

Candidate verification deliberately does create a separate, lazily started
compiler worker. Reusing the live preview worker would let candidate requests
supersede queued preview work and would replace its active World/incremental
renderer state with unaccepted source. Typst candidate checks therefore use a
distinct World scope and full diagnostics-only compilation without exporting a
PDF/vector artifact or entering the persistent preview renderer; LaTeX uses a
distinct runtime queue for the same reason.
Browser HTTP/module/package caches remain reusable, but compiler linear memory,
incremental state, and request queues do not. The candidate runtime is disposed
after 60 seconds idle.

A lightweight parse-only pass now precedes Typst candidate compilation. It uses
the existing official `typst-syntax` WASM parser, reports the first actionable
`Error` location without flooding the agent with recovery cascades, and
immediately returns obvious syntax failures without starting the candidate compiler. Parser bootstrap failure is
fail-open to the authoritative compile rather than blocking an otherwise valid
edit.

The parse-only pass is not the acceptance gate. Typst's parser is
error-recovering, and syntax alone cannot detect import, evaluation, resource,
font, or layout failures. Candidates that pass syntax parsing still require the
isolated diagnostics-only compile, which preserves those checks while avoiding
artifact serialization. Compiler initialization uses the browser font-builder
hook directly so the application can retain its strict CSP; it does not enable
the upstream loader's optional eval-based Node fallback.

The port binds each passing result to the exact immutable base CompileWorld and
target. A change to any compiler input while compiling or reviewing makes the
result stale. Compilation failures return bounded errors and structured
locations through the originating `apply_patch` or `write_file` call, allowing `pi-agent-core` to
repair and retry before the user sees an acceptance surface. A future `verify
current project` tool may still await the existing preview compilation owner;
that is distinct from pre-accept candidate verification.

This lets an agent repeat read, review, apply, and verify while keeping browser
Typst or LaTeX compilation authoritative. The AI feature never polls the
Preview component and never interprets a canvas as compiler state.

## State ownership

| State | Owner |
| --- | --- |
| Project identity, access, documents, and generation | Existing Workspace session |
| Collaborative active text | Yjs and CodeMirror |
| Compile inputs, lifecycle, diagnostics, and output | Existing compiler actors and reducers |
| Live model/tool loop, canonical in-Runtime agent messages, streaming, and cancellation | `pi-agent-core` Agent inside the opaque-origin AI Runtime |
| Per-turn project-state snapshot | Existing Workspace owner, exposed through the narrow AI application port |
| Conversation identity, active pointer, and sanitized transcript projection | AI feature domain in the host, account/project-scoped IndexedDB for authenticated users and memory for anonymous users |
| Bounded visible history supplied after reload/switch | AI feature projection derived from completed user/final-answer pairs |
| AI connection metadata | Versioned, account-scoped Local Storage profile store |
| AI connection credential and endpoint binding | Memory only inside the current opaque-origin Runtime iframe |
| Per-turn token usage and context projection | Runtime Agent, sanitized over protocol v1 and held in the host external-store snapshot |
| Outstanding proposal and review decision | Feature-scoped review controller keyed by Workspace generation |
| Panel visibility, draft prompt, expanded rows, and scroll position | Focused React presentation state |

`AiRuntimeClient` and its Runtime session are keyed by access identity, project,
and Workspace generation. The client projects validated Runtime events into
React through an external-store subscription rather than copying every streamed
token through a chain of component props. Content deltas are coalesced to an
animation frame, while terminal, error, cancellation, review, and connection
events flush immediately. High-frequency editor and compiler data remains with
its engine owner.

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
- Authenticated conversation history is local project data in host IndexedDB.
  It is account/project scoped, size-bounded, validated on load, and excludes
  credentials, reasoning, system prompts, raw tool results, source excerpts,
  and patches. Visible final answers may still contain project content. Core
  does not receive, synchronize, or back it up.
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

Credential memory-only storage limits at-rest and post-reload exposure. Opaque-principal
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

Firefox and WebKit behavior, Local Network Access prompts, the remaining wire
protocols, and production response-header composition remain implementation
gates. Chromium streaming and retained multi-turn context have also been
validated against a user-configured NVIDIA OpenAI-compatible inference
endpoint; that smoke is compatibility evidence, not a shipped provider preset.

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
- multiple project-bound local conversations with an active pointer, bounded
  authenticated-browser persistence, and memory-only anonymous behavior;
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
- IndexedDB conversation schema validation, account/project isolation, size and
  count bounds, sanitized persistence, interrupted-turn projection, serialized
  writes, and memory fallback;
- bootstrap endpoint normalization and rejection, exact-origin CSP policy
  construction, and the rule that full Runtime code loads only after policy
  installation and no new code loads after credential entry;
- exact build-version matching, frame-window and parent-origin checks, nonce
  validation, one-use port transfer, message validation, duplicate and stale
  IDs, size limits, cancellation, and Runtime replacement;
- conversation bootstrap/switch validation, history bounds, Runtime context
  reset, provider-session separation, and credential-required state retention;
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
- an actual `query_typst_docs` call whose Typst 0.15 result returns to the
  provider after the Runtime applies its locked CSP;
- creation and switching of multiple conversations without credential re-entry,
  restoration after reload, project isolation, and absence of credentials or
  reasoning in host browser persistence;
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

1. which additional wire-protocol adapters pass real browser CORS and
   streaming tests against user-configured endpoints; OpenAI-compatible Chat
   Completions has passed the Chromium smoke;
2. whether later UI affordances should help author common Provider JSON shapes
   without turning those helpers into a false cross-provider schema;
3. whether anonymous sessions should ever gain opt-in persistence for
   non-secret connection profiles beyond the current memory-only behavior;
4. the names, schemas, output limits, and error codes beyond the implemented
   `list_project_files`, `read_project_file`, `search_project_text`,
   `apply_patch`, and `write_file` tools;
5. future semantic summarization beyond the implemented deterministic
   `transformContext` windowing and tool-payload compaction;
6. default run budgets for model calls, tool calls, elapsed time, and repeated
   edit-review cycles; model context and maximum output are user-configured;
7. whether a rejected proposal ends the run or normally lets the model offer a
   non-editing alternative;
8. whether the current unified-diff review surface later adopts a CodeMirror
   merge presentation without changing the accepted patch contract;
9. inactive-document edit behavior in the first release;
10. future AI availability rules for shared projects;
11. model switching semantics inside an existing conversation;
12. retention duration, bulk clear/export controls, and whether local
    conversation history should support an explicit per-project disable switch;
13. whether trusting the fixed Runtime artifact plus navigation-triggered
    revocation is sufficient for credentials, or provider execution needs an
    additional non-navigable boundary;
14. placement and sizing of the small Runtime-owned credential surface inside
    host-owned connection management;
15. tested opaque-origin CORS, mixed-content, and private-network behavior for
    cloud, gateway, and local endpoints, including any required Permissions
    Policy delegation;
16. future price/cost presentation; sanitized token-usage presentation is
    implemented without telemetry of prompt or project content;
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
3. **Implemented:** add endpoint-bound CSP, secure connection management,
   `pi-agent-core`, selected provider adapters, and read-only multi-turn chat.
4. **Implemented:** add bounded Workspace list/read/search tools with
   line-numbered results.
5. **Implemented for the active live document:** add isolated pre-accept
   candidate compilation, bounded repair feedback, single-file review, stale
   detection, and collaboration-aware apply. Inactive-document editing remains.
6. Add selection/current-diagnostic context and a general exact-World
   verification tool.
7. Complete cross-browser CSP, opaque-origin CORS/private-network validation,
   accessibility, responsive behavior, artifact provenance, and cross-session
   security tests before enabling the feature in a deployment.

Each slice must preserve an AI-excluded build and may not introduce a server
fallback or server-side worker dependency.

## Related

- [Frontend architecture](./frontend.md)
- [Typed optional feature dimensions](../decisions/0009-typed-optional-features.md)
- [Deployment configuration](../configuration/deployment.md)
- [Distribution configuration](../configuration/distributions.md)
- [Product and editor design language](../../../web/DESIGN.md)
