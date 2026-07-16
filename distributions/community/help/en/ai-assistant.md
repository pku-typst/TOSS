## Add your own AI connection

If the deployment enables the optional Assistant, open **Assistant** from the Workspace toolbar and add a connection. TOSS does not select a provider for you. Enter:

- a local name for the connection;
- one supported API protocol: OpenAI-compatible Chat Completions, OpenAI Responses, or Anthropic Messages;
- the provider or local-service base URL; and
- the exact model ID understood by that endpoint;
- whether the model emits reasoning content;
- an exact JSON object for model/Provider-specific request parameters;
- that model's context-window size in tokens; and
- its maximum output size in tokens.

The endpoint must use HTTPS, except that HTTP is allowed for `localhost` and `127.0.0.1`. URLs containing credentials, query parameters, fragments, or the TOSS application origin are rejected.

Signed-in accounts retain this non-secret connection metadata, including the reasoning-capability declaration, Provider request parameters, and two token limits, in account-scoped browser storage. Anonymous sessions can use a connection for the current page session, but its metadata is not saved.

## Enter a credential safely

After saving the non-secret profile, the isolated Runtime shows the exact bound destination, protocol, and model. Enter an API key or short-lived token there, or leave the field empty for an unauthenticated local endpoint.

The credential is held only in that opaque, sandboxed Runtime's memory. TOSS Core, the host application, the project, Local Storage, and Session Storage do not receive it. Reloading the page, replacing the Runtime, switching the connection, logging out, or changing account clears the in-memory credential.

The Runtime permits requests only below the configured base URL, omits browser credentials, rejects redirects, and loads only the selected protocol implementation before accepting your credential.

## Provider and browser requirements

The browser sends model requests directly from an opaque origin, so the endpoint must accept CORS requests whose `Origin` is `null`. A local service may also trigger browser Local Network Access controls. TOSS does not silently proxy a failed request through its backend.

If a request fails, check the endpoint path, protocol, model ID, credential, Provider request parameters, endpoint CORS policy, and local-service browser permissions. A successful connection in another desktop client does not prove that browser CORS is enabled.

## Current project access

At the start of every message, Workspace gives the assistant a small current-state
summary: project and document identity, live or revision mode, read/edit access,
file counts, synchronization state, compilation status and diagnostic counts,
and whether an edit is awaiting review. This helps the assistant understand the
current situation, but it does not include source text, a full file listing, or
raw diagnostics. The assistant must use the bounded tools below when it needs
exact or newer project data.

For Typst projects, the assistant also has a local `query_typst_docs` tool. It
searches a bundled Typst 0.15.0 API index and a small set of compile-verified
recipes for topics such as document metadata, content versus strings, set/show
rules, arrays, and imports. A Typst Runtime loads and validates the reference
during its isolated startup, then searches it from private memory; it is not
added to every conversation turn and does not contact `typst.app` or any
backend. Model-facing queries and returned reference text are English, while
the assistant still answers in your language. Compilation and human review
remain authoritative because documentation lookup cannot prove that a proposed
change is correct for the current project.

The assistant can use three bounded, read-only Workspace tools during its multi-turn `pi-agent-core` loop:

- list project directories, text documents, and assets;
- read a bounded range from one project text document; and
- search literal text across project text documents.

Reads use the current Workspace view. The active live document comes from the latest collaboration/editor projection, while revision mode reads the selected immutable revision. Source returned to the model is prefixed as `line | code`; that prefix is display metadata and is not part of the file. Switching the Workspace generation or selected revision replaces the isolated Runtime so an older tool call cannot return into the new view. The selected project's local conversation remains available, but a replacement Runtime requires the credential again.

In a writable live project, the assistant can also submit `apply_patch` for the current active text document. It must use the exact snapshot returned by a read and provide one contextual, single-file unified-diff proposal. Paths, old-file starts, context, and removed lines must match that snapshot exactly. Workspace derives the redundant hunk counts and new-file coordinates from the validated body; this does not enable fuzzy matching or automatic rebasing. Before review, Workspace builds an unpublished candidate World and compiles it in a dedicated, lazily started browser worker. A failed candidate is not shown for acceptance: bounded diagnostics return to the agent so it can revise the patch. A passing candidate opens the central Editor with the canonical diff, a compile-passed indicator, and **Reject** and **Accept changes** actions. Nothing changes before acceptance. Accept performs one final exact-content, compiler-World, and permission check, then writes through the existing collaborative document transaction. Any local or remote source change makes the proposal stale. Revision and read-only views do not expose this tool.

For a small whole-file rewrite, or after repeated patch-format failures, the assistant can instead use `write_file`. It is available only after one `read_project_file` call returned the complete active file from line one without truncation; partial reads cannot authorize a replacement. The assistant must submit the entire desired content, not only changed lines. Workspace preserves the file's uniform LF/CRLF convention and an existing final newline, derives a focused diff itself, labels the review as a full-file replacement, and uses exactly the same isolated compilation, freshness checks, human review, and collaborative write path as `apply_patch`. The initial limit is 400 logical lines and 65,536 content characters. It still cannot create, delete, rename, or write an inactive or binary file.

The candidate compiler is isolated from live preview state. Typst first performs a lightweight syntax-only check and returns obvious parser errors without starting the compiler. Syntax alone would miss imports, evaluation, resources, fonts, and layout failures, so passing source must still compile in a distinct World scope through a full diagnostics-only pass that exports no PDF/vector output and never touches the preview renderer; LaTeX uses a separate queue. Downloaded runtime modules and packages still benefit from browser caches, while compiler memory and incremental state are not shared; the candidate worker is released after an idle period. The tools still cannot read binary assets, inspect the current preview's diagnostics, run a general project compile on demand, create/delete/rename files, edit multiple files atomically, use a shell, perform arbitrary network requests, or call the backend. A model statement that it changed a file is not evidence of a change: only an accepted review and updated Editor are.

## Conversation and activity

Use the conversation selector above the transcript to create, switch, rename,
or delete conversations within the current project. Switching conversations
resets the model context but keeps the credential already entered into the
current Runtime. A running turn must finish or be stopped before switching.

For signed-in accounts, TOSS stores a bounded conversation projection in this
browser's IndexedDB, scoped by account and project. It contains visible user
messages, visible assistant answers, and small tool activity summaries. It does
not contain credentials, reasoning text, system prompts, raw tool results,
source excerpts returned by tools, or patches. Final answers can quote project
content, so local conversation history should still be treated as project data.
Anonymous conversations remain only while the project page stays open. A reload
restores signed-in conversation history but not the credential.

Answers stream into the conversation and support Markdown, code blocks, tables,
baseline KaTeX math (`$...$` inline, or opening and closing `$$` delimiters on
their own lines for a display block), and
copying the final answer. Typst or LaTeX source remains fenced code rather than
rendered math. Press Enter to send, Shift+Enter for a newline, or **Stop** to
cancel the current run. Automatic scrolling follows new content only while you
are near the bottom; otherwise use **Jump to latest**.

System instructions plus all model-visible tool and parameter descriptions are
defined once in English, independently of the selected UI locale. Presentation
labels remain localized, and the English system instruction asks the model to
answer in the user's language.

If a model returns reasoning, TOSS displays it separately from the answer as
model-provided text. Reasoning and tool calls are grouped in a collapsible
**Agent activity** section. It stays open while the agent is working and
collapses when the run finishes unless you chose otherwise. Tool cards show a
bounded description and state, not raw request/results, project source, or a
patch. Reasoning is not guaranteed to be complete or correct and is never
treated as proof that an action occurred.

Reasoning has two separate connection settings. **Model emits reasoning
content** declares a capability to pi so reasoning blocks and multi-turn history
are handled correctly; it does not add any request field. **Provider request
parameters (JSON)** is an exact object merged into every generated request.
Leave it as `{}` to use Provider defaults, or enter the shape documented by the
specific model—for example `reasoning`, `reasoning_effort`, `thinking`,
`chat_template_kwargs`, or `nvext`. TOSS does not translate between these
incompatible formats.

The JSON cannot replace model identity, messages, system instructions, tools,
tool choice, streaming fields, token-limit fields, headers, or credentials. Do
not place secrets in it. Invalid JSON is rejected when saving; fields rejected
by the endpoint produce a Provider error rather than an automatic fallback.

## Token limits and usage

TOSS treats the context window and maximum output as properties of each saved
connection because a user-defined endpoint cannot be trusted to publish model
metadata. Enter the real limits documented by your endpoint. Before every
internal model call, TOSS reserves the configured maximum output and a safety
allowance. It removes complete older turns from the model view first and can
compact older completed tool payloads, while retaining the current request and
latest tool result. This affects only the provider context; it does not delete
the visible local conversation. If the current request still cannot fit, the
turn ends with an explicit context-budget error instead of sending a truncated
request.

The token strip below the transcript shows current context occupancy,
cumulative input/output for the active user turn, model-call count, and whether
older context was compacted. **Provider reported** means every completed call
returned token usage. **Partial usage** means only some calls did. **Estimated**
means the endpoint supplied no usable token counts, so only the conservative
browser context estimate is available. Cache and reasoning details are
available in the strip's tooltip. TOSS does not send these counts to Core or an
analytics service, and it does not infer price from them.

## Data flow

Your prompt and conversation context go directly from the Runtime to the selected endpoint. When the model calls a Workspace tool, the bounded result—including requested project source excerpts—is returned to the Runtime and becomes part of the next provider request. Sanitized response content, bounded activity state, and token counts return to the host for display. The selected provider applies its own billing, retention, and privacy terms. TOSS Core does not proxy the credential or store the AI transcript or token usage; only the bounded local browser projection described above is retained.
