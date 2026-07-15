---
title: "Document processing architecture"
summary: "Current architecture for durable jobs, immutable inputs, capability workers, artifacts, quotas, and the frontend task center."
status: current
type: architecture
scope: community
audience:
  - contributor
  - operator
  - coding-agent
topics:
  - document-processing
  - background-jobs
  - artifacts
  - concurrency
related:
  - docs/community/decisions/0008-durable-document-processing.md
  - docs/community/architecture/backend.md
  - docs/community/architecture/frontend.md
  - docs/community/reference/worker-protocol.md
  - docs/community/runtimes/latex-worker.md
  - docs/community/operations/deployment.md
code_paths:
  - backend/src/document_processing
  - backend/migrations
  - protocol
  - web/src/pages/processing
  - workers/processing-sdk
  - workers/latex
---

# Document processing architecture

This page describes the implemented Document Processing foundation. Community
currently ships one durable operation, `latex.compile.pdf/v1`, plus its public
job API, internal worker protocol, global task center, SDK, and optional native
TeX Live worker image. The reserved PPTX operation identifiers describe the
extension boundary; they are not enabled Community endpoints or processors.

## Outcomes and non-goals

Document Processing handles explicit operations that have a durable outcome:

- build a project into an artifact under a controlled runtime;
- export an immutable project snapshot into another file format;
- import an uploaded file into a validated new Workspace project;
- retain bounded diagnostics and provenance after the initiating tab closes;
- support future automation without coupling it to an editor session.

It does not accelerate live preview, retain resident project compilers, choose
between browser and server compilers, or provide an arbitrary remote-command
platform.

## Topology

```text
browser or API client
  contextual submit action
          |
          v
core API: Document Processing
  authorize -> reserve -> capture/validate -> enqueue
          |                         |
          |                         +---- PostgreSQL job and attempt state
          +---- immutable input ---------- PostgreSQL processing blob
          |
          | authenticated pull, lease, and transfer tickets
          v
worker agent ---- per-job sandbox ---- pinned processor runtime
          |
          +---- staged artifact ---------- PostgreSQL processing blob
          |
          v
core API: validate -> finalize -> publish artifact or provision project
          |
          v
global user task center
```

The core application may remain a single replica for realtime and Git reasons.
Worker replicas are stateless execution capacity and may scale independently.

## Bounded-context ownership

| Capability | Owner |
| --- | --- |
| Job, attempt, lease, retry, cancellation, capability status | Document Processing |
| Immutable processing input and result artifact metadata | Document Processing |
| Project authorization and current principal | Access |
| Accepted Yjs update projection | Collaboration |
| Authoritative files, settings, project creation, and replacement | Workspace |
| Distribution allowlist and user-facing operation policy | Distribution |
| Bounded processing blobs and transfer tickets | Document Processing; PostgreSQL in the current implementation |
| Processor implementation and toolchain | Independently deployed worker |

Document Processing calls narrow owner-named facades. It does not import
Workspace, Collaboration, or Access persistence modules. A file-import worker
returns a candidate bundle; only Workspace may turn that bundle into an
authoritative project.

The worker protocol is storage-agnostic, but the current implementation stores
bounded input, staging, and artifact bytes in PostgreSQL. Project assets may
still come from the Workspace object-storage adapter while Core captures an
input bundle. Moving processing blobs to object storage is a future adapter;
workers already use transfer tickets and therefore need no protocol change.

External repository jobs remain owned by External Repositories. Similar lease
patterns do not justify a global business-level `background_jobs` module. A
narrow technical helper may be extracted later only after identical invariants
exist in multiple contexts.

## Typed operation registry

Execution extensibility is narrower than product extensibility. Core knows each
operation's input, options, permissions, result schema, and finalizer. A worker
advertises an implementation of that known operation.

The registry recognizes these versioned identifiers:

| Operation | Class | Input | Result | Community status |
| --- | --- | --- | --- | --- |
| `latex.compile.pdf/v1` | project build | LaTeX `project-bundle/v1` | PDF and optional log | Implemented and distribution-enabled |
| `typst.export.pptx/v1` | project export | Typst project bundle | PPTX and conversion report | Reserved; no public endpoint or Community processor |
| `pptx.import.typst/v1` | file import | PPTX input blob | Typst Workspace bundle and report | Reserved; no public endpoint or Community processor |

Reserving a public operation does not enable it. Availability is the
intersection of a core-known contract, the selected distribution's allowlist,
deployment worker configuration, and live compatible capacity. A new semantic
operation requires a Community protocol change; a new implementation of an
existing operation does not.

Options are operation-specific structures, not an unrestricted JSON object.
The operation version changes when input, result, option, or finalization
semantics change incompatibly.

Processors are bounded transformations from an immutable input to a candidate
result. They do not receive application or provider credentials and cannot
publish project mutations themselves. Any future operation with an external or
authoritative side effect requires an idempotent Core-owned finalizer rather
than granting that side effect to processor code.

## Aggregate model

`ProcessingJob` is the user-visible aggregate. `ProcessingAttempt` records each
execution lease separately so retries do not overwrite operational evidence.

```text
ProcessingJob
  id, operation, version, requester, optional project
  input, normalized options, state, phase
  attempt count and retry policy
  result artifact/project, public failure, timestamps, expiry
       |
       +-- ProcessingAttempt
             attempt number, claim id, worker session
             processor contract, lease, outcome, timestamps
       |
       +-- ProcessingArtifact
             role, media type, filename, size, digest, blob key
```

The forward migration adds dedicated processing tables after the immutable
Community baseline; it does not edit or repurpose the published baseline.
Existing browser-uploaded PDF artifacts remain Workspace-owned; a processing
artifact becomes a Workspace artifact only through an explicit future facade.

## Authorization and visibility

Submission checks an operation-specific permission before reserving input or
capacity. Job list, detail, diagnostics, cancellation, retry, and artifact
download each authorize the current principal; possession of a job identifier
is never sufficient.

Project-derived jobs remain subject to current project access. If a requester's
access is revoked, task queries may retain only the minimum audit-safe status
allowed by policy and artifact download stops immediately. Any download URL is
short-lived and minted only after that check. Import jobs are requester-owned
until their result is provisioned through Workspace. Worker identities have no
user-facing job-list permission and learn no principal identity beyond fields
strictly required by an operation contract.

## Job lifecycle

The public lifecycle is:

```text
preparing -> queued -> running -> finalizing -> succeeded
```

`failed` is reachable from preparation, execution, or finalization.
`cancelled` is reachable only before finalization, and `expired` is for
abandoned preparation or queue entries under retention policy.

- `preparing` reserves idempotency and quota while the API projects accepted
  collaboration updates, captures a project, or validates an uploaded file.
- `queued` means the immutable input is complete and the job may be claimed.
- `running` means exactly one unexpired claim fences the current attempt.
- `finalizing` means a worker has delivered staged output and Core owns
  validation and publication. Worker lease loss cannot abandon this phase, and
  the job is no longer cancellable after Core accepts delivery. A separate
  Core-owned finalization fence prevents concurrent recovery attempts.
- terminal state is committed only after result publication or project
  provisioning is durable.

Phases are a small closed vocabulary such as `capturing_input`,
`waiting_for_worker`, `processing`, `uploading_result`, `validating_result`, and
`publishing_result`. A processor must not report invented percentages when its
toolchain has no trustworthy measure of progress.

## Submission and idempotency

Creation commands are semantic endpoints while queries use one common job
resource. The current public surface is:

```text
POST /v1/projects/{project_id}/builds
GET  /v1/processing/capabilities
GET  /v1/processing/jobs
GET  /v1/processing/jobs/{job_id}
POST /v1/processing/jobs/{job_id}/cancel
GET  /v1/processing/jobs/{job_id}/artifacts/{artifact_id}
```

Future export, import, and explicit retry commands must use their own semantic
endpoints and enter the generated OpenAPI only when their owning behavior
exists. They are not generic operation-submission routes.

Creation accepts an `Idempotency-Key`. Its uniqueness scope includes the actor
and command endpoint. A concurrent duplicate returns the original job rather
than constructing another snapshot. The reservation stores a normalized
command digest; reusing a key with different operation, project, input, or
options returns a conflict. Keys expire under deployment policy and are not
permanent business identifiers.

Large file imports first create a bounded temporary processing input, stream
its content, verify its declared media type and digest, and reference the
completed input when creating a job. Unreferenced inputs expire automatically.

## Project input capture

The API, not the browser or worker, authors project input:

1. authorize the operation against the current principal and project;
2. reserve idempotency and admission capacity;
3. enter a short project-mutation fence shared by accepted Collaboration
   updates and Workspace mutations;
4. in one capture transaction, ask Collaboration to project every update
   accepted before the fence and ask Workspace to freeze the generation, tree,
   settings, documents, asset digests, and retention pins;
5. commit the snapshot descriptor and release the fence so editing continues;
6. resolve the pinned asset bytes through the owning storage facade;
7. build a deterministic `project-bundle/v1` archive;
8. persist its digest and immutable blob before making the job claimable.

The capture process has one documented lock order and never performs blob or
compiler I/O while holding the project fence. A failed preparation releases its
pins through idempotent cleanup. This gives a job one coherent accepted point
without holding the editor still for the duration of a build.

The manifest includes schema, project type, entry path, operation-relevant
settings, Workspace version, content generation, and sorted file records with
kind, length, and SHA-256. The `input_digest` covers the canonical manifest and
all file content. It is distinct from the browser's local `CompileWorld` and
from a user-created named snapshot.

Job identifiers, queue timestamps, and other volatile submission metadata do
not enter the content digest. If a processor consumes a source epoch, that
stable value is part of the manifest and digest; it is never derived from the
worker start time.

An import result uses `workspace-bundle/v1`. The bundle may suggest a project
name and entry path, but Core revalidates path uniqueness, file count, expanded
size, media types, project type, and entry existence before Workspace provisions
a project. A worker never receives project-write credentials.

## Queue, fairness, and admission

PostgreSQL is the durable queue. Claim selection uses row locking with
`SKIP LOCKED`, but scheduling policy belongs above the SQL primitive.
Claim, queued cancellation, and queue expiry all serialize on the same job row:
whichever commits first determines whether a running attempt exists.

Current deployment-local limits cover:

- queued jobs globally;
- active jobs per requester and per project;
- input bundle, diagnostic, and artifact sizes;
- attempts, wall time, queue wait, and retention;
- worker slots per capability.

FIFO creation time is the baseline among jobs eligible for a compatible
processor, with per-requester and per-project active limits preventing one
account or project from occupying every slot. There is currently one enabled
Community operation, so per-operation admission partitions are not implemented.
They must be added before enabling operations with materially different
resource classes. Priority is not user-controlled.

Capacity has no replicated free-slot field. Session registration owns each
processor's slot ceiling, Core owns the count of unexpired running claims, and
the agent owns its local semaphore. An acquire request carries a short-lived
offer only after the agent has local permits. Core intersects that offer with
the registered ceiling and active claims in the same transaction that creates
the next attempt. Session heartbeat reports liveness and processor health, not
capacity.

## Availability and degradation

Capability state has four independent inputs:

1. Core recognizes the operation and schema version.
2. The selected distribution allows the operation.
3. Deployment configuration expects a scoped worker identity for it.
4. A compatible worker session is healthy and has or can regain capacity.

The public capability projection reports three states rather than one boolean:

| State | Meaning |
| --- | --- |
| `available` | The operation is allowed and at least one compatible worker session is healthy; jobs may still queue behind occupied slots |
| `waiting` | The operation is configured and admission still permits bounded work, but compatible capacity is temporarily offline |
| `unavailable` | The operation is disallowed, unconfigured, contract-incompatible, or administratively disabled and does not accept work |

A waiting operation may accept a bounded, expiring job while workers are
temporarily offline. The frontend presents that condition before submission
rather than implying that execution has started.

Queue exhaustion returns an explicit rate or service error. A local browser
preview or export remains usable, but the server does not report that separate
action as successful completion of the requested durable job.

## Attempts, fencing, and cancellation

Every claim creates a random `claim_id` and a new attempt row. Heartbeat, phase,
artifact staging, failure, release, and completion all compare that identifier
with the current unexpired database claim. Server/database time is authoritative
for lease decisions.

At-least-once execution is safe because publication is claim-fenced:

- an expired worker may finish locally but cannot create a visible artifact;
- retry creates a new claim rather than extending an ambiguous old attempt;
- staged blobs are private until Core finalizes them;
- orphan staging data is removed asynchronously;
- an infrastructure attempt may use another compatible processor contract, and
  the winning contract is recorded on the result.

Cancellation and worker-delivery acceptance serialize on the job row. If
cancellation commits first, completion is rejected and staged output remains
unpublished. If delivery acceptance commits first, the job enters the
non-cancellable `finalizing` phase; a later cancel returns that current state
and Core finishes or recovers publication. Queued work cancels immediately;
running work sets a request observed by heartbeat and the sandbox cancellation
channel. Lease expiry is the final fence when a process does not cooperate.

The worker claim closes when delivery is accepted. Finalization uses a separate
random Core ownership token and lease because blob validation cannot hold a
database row lock. Every publication step compares that token, and terminal
commit is unique per job. Workspace project provisioning uses the processing
job ID as its idempotency key, so recovery after a crash returns the project
already created by that job instead of creating a second one.

## Failure and retry policy

Workers return a closed failure classification; Core owns retry policy.

| Class | Example | Initial policy |
| --- | --- | --- |
| invalid input | unsafe bundle, missing entry | terminal |
| processor rejected | LaTeX compile error | terminal with bounded diagnostic |
| unsupported dependency | package absent from runtime | terminal |
| resource limit | output too large, deterministic timeout | terminal |
| transient infrastructure | transfer or temporary storage outage | bounded backoff |
| worker interrupted | pod or sandbox loss | bounded retry after lease expiry |
| internal contract violation | invalid processor output | terminal and operator alert |

Retries never change an invalid source into success by selecting an unrelated
runtime. The current API performs only policy-owned retries for retryable
attempt failures; it does not expose a manual retry command. A future manual
retry must create a new linked job rather than reopening a terminal aggregate.

## Artifact publication and reuse

Workers upload only to claim-scoped staging roles with declared media types and
limits. Core streams or delegates an expiring upload, verifies size and digest,
validates the operation result, rechecks the current project and requester
authorization, and then atomically records visible artifact metadata. A deleted
project or revoked grant cannot turn staged bytes into a downloadable result.

An operation may declare deterministic artifact reuse. The cache identity is:

```text
reuse scope
+ operation and schema version
+ input digest
+ processor contract
+ normalized options digest
```

Initially, project operations reuse only within the same source project and
file imports reuse only for the same requester. Cross-tenant semantic cache
hits are disabled because their latency can disclose that another principal
submitted matching content. Physical content-addressed blob deduplication may
remain a storage detail, but it never grants visibility or skips authorization.

A cache hit creates a new authorized job and artifact reference. It does not
reuse another job's visibility. Mutable compiler work directories are not part
of this cache. Blob reference tracking and retention prevent one job's deletion
from removing content still used by another result.

## Worker and sandbox trust boundaries

The worker agent is operator-controlled and may authenticate to the internal
protocol only for configured operations. The untrusted processor sandbox sees
an input directory, output directory, normalized request, resource limits, and
cancellation signal. It must not see the worker token, database URL,
object-storage credentials, user cookies, or general project API.

Production execution uses a per-job OS isolation boundary with a read-only root,
non-root identity, bounded CPU, memory, processes, temporary storage, and time,
and no network unless an operation contract explicitly requires a restricted
destination. A local subprocess executor may exist for trusted development but
is not a multi-tenant security profile.

## Frontend task center

Submission remains contextual:

- project build actions live with build/export controls;
- project export actions live in the export menu;
- file import begins from project creation/import surfaces.

State is centralized in a global task center opened from the application header.
Desktop uses a right-side drawer; small screens use a full-screen route or
sheet. The badge counts the current user's queued and running jobs and surfaces
failed work without adding job lifecycle to the preview component.

“Global” is a presentation location, not a global Job bounded context. The
first view reads Document Processing summaries. Other contexts may later
contribute namespaced task summaries and contextual actions through a composed
read model while retaining their own aggregates, permissions, and retry rules.

TanStack Query owns job lists, details, mutations, and adaptive polling. Polling
runs while a nonterminal job is relevant and stops at terminal state. Upload
orchestration may use a feature-scoped actor, but server job state does not enter
the Workspace session, compilation actor, preview reducer, or Yjs state. A full
job-history page is deferred until volume or automation makes the drawer
insufficient.

## Observability and cleanup

Logs and metrics correlate job, attempt, operation, worker session, claim, and
processor contract without including source content or service credentials.
Required metrics include queue age/depth, active attempts, lease loss, duration,
failure class, cache hits, staged bytes, and artifact cleanup failures.

Reapers handle abandoned preparation, expired queue entries, expired leases,
unreferenced uploads, orphan staged results, and retention. Cleanup is
idempotent and uses the existing object-deletion discipline rather than deleting
blobs inside a user request transaction.

## Verification

Repository CI currently proves:

- database-backed worker-request replay, concurrent duplicate fencing, retry
  after transactional `5xx`, and changed-payload conflicts;
- an end-to-end fake-worker flow against a freshly migrated Core, including
  submission idempotency, offline/online capability state, claim and ticket
  replay, transfer integrity, duplicate upload, finalization, artifact download,
  exact cache reuse without an attempt, cancellation, and session drain;
- deterministic project-bundle construction and SDK verification of the exact
  Core manifest shape, file kinds, paths, sizes, and digests;
- frontend account-scoped query keys, cancellation rules, adaptive polling,
  semantic build submission, and fresh idempotency keys;
- worker formatting, linting, unit tests, processor-contract drift, and both
  generated OpenAPI documents.

Release validation additionally runs the real worker image for pdfLaTeX and
XeLaTeX in the deployment sandbox. Broader race injection, lease-expiry fault
tests, archive-bomb fixtures, and a compatibility corpus remain hardening work;
this page does not claim those are already automated.

## Source boundaries

The implementation keeps these explicit boundaries:

```text
backend/src/document_processing/     owning context and public HTTP edge
protocol/                            generated public API plus separate worker contract
web/src/pages/processing/            task center and contextual actions
workers/processing-sdk/              protocol client and lease guard
workers/latex/                       Community processor and image
```

Domain behavior must not move into distribution overlays, build patches, or a
generic command runner.

## Related

- [Durable worker decision](../decisions/0008-durable-document-processing.md)
- [Backend architecture](./backend.md)
- [Frontend architecture](./frontend.md)
- [Worker protocol](../reference/worker-protocol.md)
- [LaTeX worker runtime](../runtimes/latex-worker.md)
- [Deployment](../operations/deployment.md)
