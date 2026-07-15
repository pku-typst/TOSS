---
title: "Document processing worker protocol"
summary: "Current contract for authenticated worker sessions, capability claims, leases, transfers, completion, and compatibility."
status: current
type: reference
scope: community
audience:
  - backend-contributor
  - operator
  - coding-agent
topics:
  - worker-protocol
  - leases
  - authentication
  - artifacts
related:
  - docs/community/architecture/document-processing.md
  - docs/community/decisions/0008-durable-document-processing.md
  - docs/community/architecture/identity-and-access.md
  - docs/community/architecture/error-model.md
  - docs/community/runtimes/latex-worker.md
code_paths:
  - backend/src/document_processing
  - protocol
  - scripts
  - workers/processing-sdk
---

# Document processing worker protocol

This page defines worker protocol version 1 as implemented by Community Core
and the public processing SDK. Its generated contract is checked in separately
as `protocol/worker-openapi.json`; browser types are generated only from
`protocol/openapi.json`, so service credentials and internal lifecycle
operations do not enter the web client surface.

## Protocol role

The protocol connects Community Core, which owns durable state and
authorization, to operator-controlled worker agents, which own execution
capacity. It is a pull protocol over authenticated HTTPS. It is not a public
user API, arbitrary plugin RPC system, or direct transport into a processor
sandbox.

Core responsibilities:

- validate worker identity and allowed operations;
- select eligible queued work and create fenced attempts;
- issue scoped, expiring transfer tickets;
- own lease time, retry policy, cancellation, and terminal state;
- validate and publish results.

Worker-agent responsibilities:

- advertise build-time-known compatible processors and slot ceilings;
- offer locally reserved capacity when acquiring claims;
- long-poll for claims rather than read the database;
- verify immutable input size and digest;
- keep an active lease while its sandbox runs;
- terminate the sandbox after cancellation or lease loss;
- stage bounded results and report a closed outcome.

## Authentication and authorization

Each deployment provisions a worker identity outside the distribution file. A
credential is scoped to an allowlist of operation identifiers and protocol
versions. The server stores or loads only the verifier required by its chosen
credential mechanism; raw credentials never appear in logs, database job
payloads, distribution resources, or public capability responses.

Credential scope is necessary but not sufficient. Deployment policy also
approves the processor contracts that may serve each operation, normally from
their verified manifests. A self-advertised contract hash is not authority to
claim work, and users do not choose a processor contract as a priority setting.

The current implementation uses bearer tokens. Core loads deployment-owned
identity, token, operation, and exact processor-contract allowlists from
`PROCESSING_WORKER_IDENTITIES_JSON`, hashes candidates, and compares
fingerprints in constant time. The SDK accepts its token from
`PROCESSING_WORKER_TOKEN_FILE` or `PROCESSING_WORKER_TOKEN`. Mutual TLS or
workload identity may replace bearer authentication later without changing
claim semantics.

Browser sessions, personal access tokens, external-provider grants, and worker
credentials are not interchangeable. Internal routes reject cookies as a
substitute for worker authentication.

## Version layers

Compatibility has three independent versions:

- worker protocol version: session, claim, transfer, and completion wire shape;
- operation version: typed input, options, result, and finalization semantics;
- processor contract: exact runtime implementation, packages, fonts, flags, and
  output policy.

A protocol minor addition must remain ignorable or optional. An incompatible
wire change uses a new protocol major. Operation versions are selected by exact
identifier. Processor contracts are opaque SHA-256 identities accompanied by
bounded human-readable provenance.

## Routes

```text
POST   /internal/v1/processing/worker-sessions
POST   /internal/v1/processing/worker-sessions/{session_id}/heartbeat
DELETE /internal/v1/processing/worker-sessions/{session_id}

POST   /internal/v1/processing/claims:acquire
POST   /internal/v1/processing/claims/{claim_id}/heartbeat
POST   /internal/v1/processing/claims/{claim_id}/artifacts
POST   /internal/v1/processing/claims/{claim_id}/complete
POST   /internal/v1/processing/claims/{claim_id}/fail
POST   /internal/v1/processing/claims/{claim_id}/release

GET|PUT /internal/v1/processing/transfers/{transfer_id}
```

Every mutation accepts a request identifier for tracing. Retrying the same
payload with the same identifier is idempotent within a bounded window; reusing
that identifier with a different payload is a contract error.

## Worker session

Session creation includes:

```json
{
  "worker_instance": "opaque deployment-local identifier",
  "protocol_versions": [1],
  "processors": [
    {
      "operation": "latex.compile.pdf/v1",
      "processor_contract": "sha256:...",
      "runtime_version": "bounded display value",
      "slots": 1
    }
  ]
}
```

Core intersects this list with credential scope and distribution/deployment
policy. The response chooses one protocol version and returns a random session
identifier, server time, heartbeat interval, and maximum long-poll duration.
Unknown or unapproved processor contracts remain visible to operators as a
configuration error but cannot claim jobs.

Session expiry and every claim lease use durable database state and server
time. Restarting Core therefore does not invalidate or duplicate an unexpired
claim. A restarted worker creates a new session and lets claims from the lost
session expire; it cannot adopt them by presenting their identifiers.

A session heartbeat reports processor health only:

```json
{
  "request_id": "uuid",
  "processors": [
    {
      "operation": "latex.compile.pdf/v1",
      "processor_contract": "sha256:...",
      "healthy": true
    }
  ]
}
```

It does not report available slots and does not renew job claims; each active
claim has its own heartbeat. Session expiry removes capacity from public
availability but does not immediately reassign a still-valid claim. Claim lease
expiry remains authoritative.

Deleting a session starts graceful drain: it prevents new claims but does not
cancel active ones. The agent releases or completes those claims before the
session closes, while an unclean shutdown falls back to lease expiry.
Before abandoning an outstanding long poll during graceful shutdown, the SDK
drains the session and resolves that acquisition. A claim committed just before
the drain is therefore still received and completed instead of being stranded
until lease expiry.

The registered slot ceiling and Core's unexpired running claims are the durable
capacity facts. The agent's semaphore is the local capacity fact. There is no
persisted free-slot projection that can drift between them.

## Claim acquisition

After reserving local semaphore permits, the agent sends an ephemeral capacity
offer and may long-poll within the server-provided maximum:

```json
{
  "request_id": "uuid",
  "session_id": "uuid",
  "offers": [
    {
      "operation": "latex.compile.pdf/v1",
      "processor_contract": "sha256:...",
      "slots": 1
    }
  ],
  "wait_seconds": 20
}
```

Offers must be a unique, credential-approved subset of the processors registered
on that session. Offered slots are positive, bounded by the registered
processor ceiling, and bounded in aggregate per request. They are commands, not
stored state.

Core serializes acquisitions for one session, counts its unexpired running
claims transactionally, and grants only within both the registered ceiling and
the current offer. Concurrent or retried acquisitions therefore cannot
oversubscribe a processor. The current implementation commits at most one claim
per response; an agent with remaining permits immediately offers them again.
Core selects only jobs matching an authenticated offered processor and current
admission policy.

A successful claim contains:

```json
{
  "job_id": "uuid",
  "attempt": 1,
  "claim_id": "uuid",
  "lease_expires_at": "timestamp",
  "operation": "latex.compile.pdf/v1",
  "processor_contract": "sha256:...",
  "options": {
    "engine": "xetex"
  },
  "input": {
    "schema": "project-bundle/v1",
    "size_bytes": 12345,
    "sha256": "...",
    "download_url": "/internal/v1/processing/transfers/uuid",
    "download_token": "opaque expiring secret"
  },
  "limits": {
    "wall_seconds": 300,
    "output_bytes": 67108864,
    "diagnostic_bytes": 65536
  }
}
```

The response never contains user credentials, storage keys, database
coordinates, or an unrestricted project URL. No eligible work returns `204`
after the long-poll window rather than an error.

Core may satisfy an exact deterministic artifact-cache hit during acquisition.
In that case it moves the job to Core-owned finalization, returns no claim for
that acquisition, and the agent immediately polls again. No worker attempt is
created.

## Lease and heartbeat

Claim heartbeat supplies one of the protocol's closed phases (`processing` or
`uploading_result`). Core updates the lease only when job, attempt, session,
claim identifier, and unexpired current ownership all match.

The response is one of:

- active with a new server-computed expiry;
- cancellation requested with a grace deadline;
- claim lost;
- job already terminal.

Network failure does not prove ownership loss, but the agent must stop the
sandbox before the last confirmed lease expires. It must never continue work on
the assumption that a failed heartbeat will eventually succeed. The SDK lease
guard centralizes server-time offset, renewal margin, cancellation propagation,
and process termination.

## Transfer tickets

A transfer ticket is an opaque, single-purpose capability bound to:

- direction;
- job, attempt, and claim;
- immutable input or declared artifact role;
- exact or maximum byte length;
- expected media type when known;
- expiry and use count.

The route contains a non-secret transfer identifier. The capability secret is
sent in a dedicated authorization header and is redacted by the SDK, Core, and
HTTP infrastructure. The Core-issued secret must not appear in the route URL,
access log, trace attribute, or diagnostic. The JSON field above represents
protocol delivery to the SDK; processor code and the sandbox never receive it.

Core currently streams PostgreSQL-backed processing blobs directly. The ticket
shape deliberately does not expose that storage choice. A future signed
object-store redirect would require an explicit SDK origin policy and
credential-redaction review; it is not current behavior.

Transfer retries are bounded but supported. An input capability permits a
small configured number of reads within its claim and expiry. Artifact-ticket
creation is idempotent by request identifier, and an active claim may replace
an expired unused ticket for the same declared role without broadening its
limits.

Artifact-ticket creation declares role, media type, filename, and expected size.
Core rejects undeclared roles, unsafe filenames, excess artifact count, or
operation-incompatible media types before issuing an upload. Upload completion
does not publish the object.

## Completion and finalization

Completion lists staged artifacts by ticket result, role, size, and SHA-256 and
may include bounded typed metadata defined by the operation. Core locks the job
and verifies the current claim before accepting delivery.

Acceptance transitions the job to the non-cancellable `finalizing` phase,
closes the worker attempt, and makes Core responsible for recovery. The agent
may delete local work after this response. Core acquires its own durable
finalization fence rather than reusing the closed worker claim, then:

1. verifies every staged object's recorded size and digest;
2. validates operation-specific structure and safety;
3. publishes immutable artifact metadata or invokes Workspace provisioning;
4. commits the terminal job result;
5. schedules unreferenced staging cleanup.

If Core fails after accepting delivery, a reaper takes an expired finalization
fence and resumes. Artifact publication and Workspace provisioning are
idempotent by job ID, so a crash after their commit cannot duplicate a result.
Recovery does not ask the worker to rerun deterministic processing.

## Failure and release

Failure requests use a closed class plus bounded sanitized diagnostic:

```json
{
  "class": "processor_rejected",
  "code": "latex_compile_failed",
  "message": "main.tex:12: ..."
}
```

Workers do not choose `retry=true`. Core maps the class, attempt history, and
deployment policy to terminal failure or delayed retry. Unknown codes remain
internal contract violations rather than becoming public error vocabulary.

Release is for graceful shutdown before ambiguous side effects. It succeeds
only for the active claim and transitions according to cancellation and retry
policy. Killing a processor after output upload but before completion still
uses normal lease expiry and orphan cleanup.

## Error responses

Internal responses use stable machine codes and request IDs without source
content, credentials, SQL diagnostics, blob keys, or host paths. Expected
classes include authentication failure, unsupported protocol, processor scope
mismatch, claim lost, cancellation requested, transfer expired,
artifact rejected, and rate limit.

A `5xx` response is never proof that a state mutation did not commit. Every
mutating worker request is idempotent, and the SDK retries by request identifier
or queries the current claim before taking another action.

## Contract generation

Implementation keeps browser/user operations in the existing generated
`protocol/openapi.json` and worker routes in a separate
`protocol/worker-openapi.json`. The web client generator never consumes the
worker document. Canonical operation options, bundle manifests, result
metadata, and failure classes live in versioned processing schemas referenced
by both documents where appropriate.

CI regenerates both contracts from their owning backend markers and fails on
drift. The SDK's versioned Rust wire structs are checked through compilation
and protocol smoke tests; handwritten session, lease, transfer, and retry
behavior owns lifecycle safety.

## SDK boundary

The public worker SDK owns protocol mechanics:

- session negotiation and heartbeat;
- long polling and slot accounting;
- input download verification;
- lease guard and cancellation signal;
- staged artifact upload and digest calculation;
- idempotent completion, failure, and release;
- bounded retry for transport requests.

Processor implementations receive a typed request, verified input directory,
empty output directory, resource limits, and cancellation token. They do not
receive the HTTP client or service credential. The SDK must not expose an
arbitrary server-provided shell command executor.

## Conformance tests

CI runs a fake processor against a freshly migrated backend and covers exact
session/claim/ticket/completion replay, changed-payload request-ID conflict,
input digest and size, idempotent same-byte upload, Core finalization, artifact
download, cache reuse without an attempt, queued cancellation, capability
transitions, and graceful drain. Database tests separately exercise concurrent
in-progress request fencing and same-ID retry after a transactional server
failure. Worker unit tests cover bundle verification and path safety.

Lease-expiry fault injection, cancellation/completion race permutations,
truncated connections after commit, and expired-transfer fixtures are required
hardening additions, not claims of current coverage.

Generated SDK fixtures are public and synthetic. They contain no deployment
host, credential, private document, or downstream processor metadata.

## Related

- [Document processing architecture](../architecture/document-processing.md)
- [Durable worker decision](../decisions/0008-durable-document-processing.md)
- [Identity and access](../architecture/identity-and-access.md)
- [Error model](../architecture/error-model.md)
- [LaTeX worker runtime](../runtimes/latex-worker.md)
