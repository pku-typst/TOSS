---
title: "Deployment configuration"
summary: "Strict TOML topology for optional frontend features, external Git providers, and Document Processing workers."
status: current
type: reference
scope: community
audience:
  - operator
  - contributor
  - coding-agent
topics:
  - deployment
  - configuration
  - optional-features
  - secrets
related:
  - docs/community/configuration/README.md
  - docs/community/configuration/distributions.md
  - docs/community/configuration/external-git.md
  - docs/community/architecture/document-processing.md
  - docs/community/architecture/browser-ai-assistant.md
code_paths:
  - config/deployment.toml
  - backend/src/deployment_config.rs
  - backend/src/document_processing/config.rs
  - backend/src/external_repositories/config.rs
  - backend/src/server/ai_runtime.rs
---

# Deployment configuration

`TOSS_DEPLOYMENT_CONFIG` selects one strict schema-1 TOML document. An unset
path uses the distribution's frontend defaults with no external Git provider
and no Document Processing worker identity. Community declares no default
frontend features, so its implicit deployment is empty. The container image
defaults to `/app/config/deployment.toml`.

Start with [deployment.example.toml](./deployment.example.toml). The checked-in
[`config/deployment.toml`](../../../config/deployment.toml) is the runnable
Community default.

## Sections

```toml
schema = 1

[frontend]
enabled_features = []

[external_git]
providers = []

[document_processing]
worker_identities = []
```

The sections share a file but not a domain model:

- `frontend.enabled_features` selects browser features already included by the
  distribution and web build;
- `external_git.providers` is the provider registry owned by External
  Repositories;
- `document_processing.worker_identities` is the exact operation and processor
  contract allowlist owned by Document Processing;
- Document Processing limits and lease durations are scalar fields under its
  section rather than separate environment variables.

Unknown sections and fields, duplicate values, unsupported operations, and
frontend features absent from the distribution fail startup.

Community includes the browser Assistant in its web build but leaves it off by
default. To expose the Assistant and its isolated Runtime routes, use:

```toml
[frontend]
enabled_features = ["ai_assistant"]
```

When it is not enabled, the toolbar has no Assistant descriptor and Core
returns not found for the entire reserved `/_ai-runtime` namespace rather than
letting it fall through to the SPA static handler.

Community's `user_defined` connection policy accepts no deployment fields for
provider, model, credential, or Agent limits. Those values belong to the user
or to hard safety bounds.

For a downstream `managed_catalog` distribution only, deployment configuration
may narrow the distribution's approved profiles and choose a default inside
that subset:

```toml
[frontend]
enabled_features = ["ai_assistant"]

[frontend.ai_assistant]
enabled_model_profiles = ["example-model"]
default_model_profile = "example-model"
```

Both fields are optional. Omitting the subsection uses the distribution's full
ordered profile list and default. An empty list, duplicate or unknown profile,
or default outside the enabled subset fails startup. Deployment configuration
cannot add a profile, change its metadata, replace the managed endpoint, or
change the connection-policy kind. API keys and personal request/turn/catalog
limits never belong in this TOML.

## Worker identities and secrets

```toml
[[document_processing.worker_identities]]
id = "community-latex"
token_file = "worker.token"

[[document_processing.worker_identities.operations]]
id = "latex.compile.pdf/v1"
processor_contracts = ["sha256:<64 lowercase or uppercase hexadecimal digits>"]
```

Relative token paths resolve from the directory containing the deployment
TOML. Absolute paths are also accepted. The token file must contain 32–512
non-whitespace characters. Core stores only its SHA-256 fingerprint in memory
and compares request tokens in constant time.

The TOML itself must not contain worker tokens, OAuth client secrets, database
credentials, session keys, or grant-encryption keys. Mount token files from a
Secret. Provider client secrets and `EXTERNAL_GIT_TOKEN_ENCRYPTION_KEY` remain
environment/secret-manager values.

## Typed activation rules

```text
project type = runtime distribution ∩ web build

frontend feature = distribution included
                 ∩ deployment enabled
                 ∩ web build

processing operation = distribution allowed
                     ∩ configured worker identity
                     + live session/capacity state
```

The equations describe compatibility checks, not one generic capability
engine. Each owner exposes its own typed read contract.

## Related

- [Configuration index](./README.md)
- [Distribution configuration](./distributions.md)
- [External Git configuration](./external-git.md)
- [Document Processing](../architecture/document-processing.md)
- [Browser AI assistant](../architecture/browser-ai-assistant.md)
- [Decision: typed optional features](../decisions/0009-typed-optional-features.md)
