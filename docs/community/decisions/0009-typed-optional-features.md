---
title: "ADR-0009: Typed optional feature dimensions"
summary: "Keep project types, browser features, and durable processing operations separate while composing deployment topology from one TOML file."
status: accepted
type: decision
scope: community
audience:
  - contributor
  - operator
  - coding-agent
topics:
  - optional-features
  - deployment-configuration
  - distributions
related:
  - docs/community/configuration/deployment.md
  - docs/community/configuration/distributions.md
  - docs/community/architecture/document-processing.md
  - docs/community/architecture/browser-ai-assistant.md
code_paths:
  - backend/src/deployment_config.rs
  - backend/src/distribution
  - backend/src/document_processing
  - web/distributionBuildConfig.ts
  - web/src/lib/deploymentCapabilities.ts
  - web/src/features/ai
---

# ADR-0009: Typed optional feature dimensions

## Decision

TOSS does not model every optional behavior as one generic capability. Three
independent dimensions retain their own ownership and lifecycle:

| Dimension | Examples | Activation and state |
| --- | --- | --- |
| Project types | Typst, LaTeX | Cross-layer distribution contract; no health state |
| Frontend features | Browser AI assistant | Included by the web build and enabled by deployment configuration; feature-local runtime state |
| Document Processing operations | Native LaTeX build, PPTX import/export | Allowed by the distribution, enabled by configured worker identities, and dynamically available through worker sessions |

One strict `TOSS_DEPLOYMENT_CONFIG` TOML document composes optional deployment
topology. Its `frontend`, `external_git`, and `document_processing` sections
remain typed by their owners. Sharing one file format does not introduce a
generic feature aggregate, state machine, resolver, or frontend hook.

The distribution JSON remains separate. It owns product policy, build-time
bounds, project-type content, and Help. The deployment TOML owns the installed
topology. Credentials remain in environment variables or mounted secret files.

## Consequences

- Vite reads only project types and frontend features; it never parses worker
  operation policy.
- `/v1/auth/config` exposes project types and enabled frontend features, not
  Document Processing availability.
- `/v1/processing/capabilities` exposes only operations configured for this
  deployment; heartbeat and slot state apply only to those operations.
- a worker identity operation outside the distribution allowlist fails Core
  startup instead of appearing as an unavailable feature;
- Help topics use typed project-type, frontend-feature, and processing-operation
  requirements;
- a checked web build manifest prevents runtime configuration from activating
  code omitted from the SPA;
- browser AI remains a frontend feature and does not become a Worker job or
  require an AI backend;
- optional Workspace UI is contributed through typed generic extension
  descriptors. Core toolbar interfaces do not acquire feature-specific flags
  or callbacks such as `onToggleAssistant`.

## Rejected alternative

A universal capability registry would force booleans, worker health, browser
session state, and cross-layer project contracts into one abstraction. It would
also encourage generic `useCapability(id)` calls that obscure the owning
bounded context. Common loading and filtering utilities do not justify that
semantic coupling.

## Related

- [Deployment configuration](../configuration/deployment.md)
- [Distribution configuration](../configuration/distributions.md)
- [Document Processing](../architecture/document-processing.md)
- [Browser AI assistant](../architecture/browser-ai-assistant.md)
