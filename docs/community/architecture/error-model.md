---
title: "Error model"
summary: "Normative ownership, conversion, transport, localization, and logging rules for failures."
status: current
type: architecture
scope: community
audience:
  - backend-contributor
  - frontend-contributor
  - coding-agent
topics:
  - errors
  - api
  - observability
  - localization
related:
  - docs/community/architecture/backend.md
  - docs/community/reference/api.md
  - protocol/README.md
code_paths:
  - backend/src/http_response.rs
  - backend/src/protocol/rest/error.rs
  - web/src/lib/api/core.ts
  - web/src/lib/i18n.ts
---

# Error model

There is no shared application-error enum. A failure belongs to the capability
that can produce it and is translated only when it crosses a transport, worker,
or process boundary.

```text
policy or value error
        |
capability-owned semantic error
        |
adapter error with source chain
        |
HTTP, WebSocket, Git, worker, or process representation
```

## Ownership

Validation and invariant failures live beside the value or policy that defines
them. A cohesive user goal may own a semantic error enum when callers need to
distinguish outcomes such as disabled registration, invalid credentials,
repository conflict, persistence failure, or unavailable storage.

Do not create:

- a global application/operation/use-case error enum;
- a horizontal `errors/` bucket;
- a one-variant enum that transparently forwards an existing concrete error;
- internal `Result<T, String>` contracts;
- variants named after HTTP status codes.

Infrastructure adapters retain typed sources. Capability boundaries classify
expected constraints and preserve unexpected source chains.

## REST boundary

Ordinary `/v1` failures use one transport-owned envelope:

```json
{
  "code": "auth_credentials_invalid",
  "message": "Incorrect email or password",
  "request_id": "correlation-id"
}
```

- `code` is a stable snake-case protocol value used for control flow and
  localization.
- `message` is safe English fallback text, not a translation key.
- `request_id` is returned in both `x-request-id` and the normalized error
  envelope.
- Raw SQL, provider, command, filesystem, and cryptographic diagnostics never
  enter the public response.

`ApiErrorCode` is a protocol-wide vocabulary, not a domain model. Context HTTP
modules explicitly map their capability failures to status, code, and safe
message. The shared HTTP response module constructs the envelope and handles
framework fallbacks; it does not own context status mappings.

## Other boundaries

- WebSocket failures use versioned events or close reasons.
- Git smart HTTP preserves Git protocol bodies.
- Background jobs persist a stable failure code, phase, and retryability, not
  an REST error object or raw source-chain text.
- Startup/configuration failures retain operator-facing sources and terminate
  at the process boundary.

## Frontend localization

The browser localizes by `code`. Fallback order is a registered localized
message, a safe server fallback where permitted, then a generic localized
status message. Unknown codes must not expose untrusted internal text.

## Logging

- Adapters return errors without logging them.
- The outer HTTP, worker, or process boundary records an unexpected failure
  once with request/project/job correlation.
- Expected validation, authorization, and conflict outcomes are not error-level
  operational incidents.
- Best-effort work that still returns success logs its own failed side effect,
  because no error crosses the boundary.
- Do not stringify an error merely to move it across internal layers.

## Verification

Capability tests cover semantic classification. HTTP integration tests cover
status, stable code, request correlation, and redaction. Protocol generation
protects the enum. Frontend tests cover localization and unknown-code fallback.
Worker tests cover retry classification and persisted failure codes.

## Related

- [Backend architecture](./backend.md)
- [API guide](../reference/api.md)
- [Protocol workflow](../../../protocol/README.md)
