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
  - docs/community/configuration/deployment.md
  - docs/community/configuration/external-git.md
  - docs/community/architecture/document-processing.md
  - docs/community/reference/worker-protocol.md
  - docs/community/operations/deployment.md
code_paths:
  - .env.example
  - distributions/community/toss.json
  - distributions/community/help
  - config/deployment.toml
  - docs/community/configuration/deployment.example.toml
---

# Configuration index

The application separates product configuration from credentials and mutable
administrator policy.

| Source | Owns | May contain secrets? |
| --- | --- | --- |
| Distribution JSON selected by `TOSS_CONFIG` | Product identity, project types, included frontend features, allowed processing operations, Gallery, Help, resources, Git naming, and runtime catalog | No |
| Deployment TOML selected by `TOSS_DEPLOYMENT_CONFIG` | Enabled frontend features, external provider registry, worker identities/contract allowlists, and processing resource policy | No; it references secret files |
| Environment / secret manager | Database, session, S3, OIDC, provider client secrets, grant encryption, paths, and worker token files | Yes |
| PostgreSQL administrator settings | Mutable site authentication and access policy when not deployment-managed | Yes |
| Checked-in runtime manifests | Exact compiler, package, font, and BusyTeX provenance | No |

`.env.example` is the canonical common environment template. It contains safe
development placeholders, not production values. Dynamic provider secret names
cannot all be enumerated there; they follow
`EXTERNAL_GIT_<INSTANCE_ID>_CLIENT_SECRET`.

## Precedence

- Build-time project types and frontend features bound the code included in the SPA.
- Runtime `TOSS_CONFIG` may select an equal or smaller project/frontend set;
  the checked web build manifest rejects omitted code at startup.
- `TOSS_DEPLOYMENT_CONFIG` selects enabled frontend features, provider topology,
  and worker identities. A deployment selection cannot exceed distribution
  policy.
- Non-empty `OIDC_*` and explicitly set `AUTH_*` environment values override
  the corresponding database-backed administrator settings.
- Deployment TOML never reads provider credentials from fields in the document; secret
  environment names are derived from the validated instance ID.
- Distribution-relative file paths resolve from the distribution JSON.

## Secret boundary

Never put passwords, client secrets, session keys, S3 credentials, encryption
keys, access tokens, employee data, or authenticated URLs in distribution JSON,
deployment TOML, the browser bundle, or logs. Use Kubernetes Secrets or an
equivalent deployment secret manager.

Worker identity metadata and exact contracts belong in
`document_processing.worker_identities`; each identity references a mounted
`token_file`. Never expose token contents through distribution Help, public
capability responses, browser configuration, or the TOML file.

## Related

- [Distributions](./distributions.md)
- [Deployment TOML](./deployment.md)
- [External Git configuration](./external-git.md)
- [Durable document processing](../architecture/document-processing.md)
- [Worker protocol](../reference/worker-protocol.md)
- [Deployment](../operations/deployment.md)
