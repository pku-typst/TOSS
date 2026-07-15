---
title: "Configuration index"
summary: "Sources, precedence, secret boundaries, and navigation for runtime configuration."
status: current
type: index
scope: community
audience:
  - operator
  - contributor
  - coding-agent
topics:
  - configuration
  - environment
  - secrets
related:
  - docs/community/configuration/distributions.md
  - docs/community/configuration/external-git.md
  - docs/community/architecture/document-processing.md
  - docs/community/reference/worker-protocol.md
  - docs/community/operations/deployment.md
code_paths:
  - .env.example
  - distributions/community/toss.json
  - distributions/community/help
  - docs/community/configuration/external-git.example.toml
---

# Configuration index

The application separates product configuration from credentials and mutable
administrator policy.

| Source | Owns | May contain secrets? |
| --- | --- | --- |
| Distribution JSON selected by `TOSS_CONFIG` | Product identity, project/processing capabilities, Gallery, Help, resource links, Git naming, built-in runtime catalog | No |
| External provider TOML selected by `EXTERNAL_GIT_CONFIG` | Provider instance IDs, kinds, brands, public URLs, OAuth client IDs, callbacks, login visibility | No |
| Environment / secret manager | Database, session, S3, OIDC, provider client secrets, grant encryption, limits, paths, worker identities/tokens, and worker timing | Yes |
| PostgreSQL administrator settings | Mutable site authentication and access policy when not deployment-managed | Yes |
| Checked-in runtime manifests | Exact compiler, package, font, and BusyTeX provenance | No |

`.env.example` is the canonical common environment template. It contains safe
development placeholders, not production values. Dynamic provider secret names
cannot all be enumerated there; they follow
`EXTERNAL_GIT_<INSTANCE_ID>_CLIENT_SECRET`.

## Precedence

- Build-time distribution capabilities bound the code included in the SPA.
- Runtime `TOSS_CONFIG` may select an equal or smaller capability set; it cannot
  activate code omitted from the image.
- Non-empty `OIDC_*` and explicitly set `AUTH_*` environment values override
  the corresponding database-backed administrator settings.
- Provider TOML never reads credentials from fields in the document; secret
  environment names are derived from the validated instance ID.
- Distribution-relative file paths resolve from the distribution JSON.

## Secret boundary

Never put passwords, client secrets, session keys, S3 credentials, encryption
keys, access tokens, employee data, or authenticated URLs in distribution JSON,
provider TOML, the browser bundle, or logs. Use Kubernetes Secrets or an
equivalent deployment secret manager.

Worker identities are Core deployment policy. Keep
`PROCESSING_WORKER_IDENTITIES_JSON` and the matching worker token in a secret
manager, and allow only the exact operation and processor contracts printed by
the deployed image. Never expose worker tokens through distribution Help,
public capability responses, or browser configuration.

## Related

- [Distributions](./distributions.md)
- [External Git configuration](./external-git.md)
- [Durable document processing](../architecture/document-processing.md)
- [Worker protocol](../reference/worker-protocol.md)
- [Deployment](../operations/deployment.md)
