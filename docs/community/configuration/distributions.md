---
title: "Distribution configuration"
summary: "Schema, validation, and extension points for configurable product distributions."
status: current
type: reference
scope: community
audience:
  - contributor
  - operator
  - coding-agent
topics:
  - distributions
  - branding
  - templates
  - optional-features
related:
  - docs/community/configuration/README.md
  - docs/community/product/overview.md
  - docs/community/runtimes/typst.md
  - docs/community/runtimes/latex.md
  - docs/community/architecture/document-processing.md
code_paths:
  - backend/src/distribution
  - distributions/community/toss.json
  - distributions/community/help
---

# Distribution configuration

A versioned distribution file selects product identity, typed feature bounds,
and content without product-specific branches in core application code. The
Community distribution is the public baseline; other builds may add their own
distribution directories.

## Layout

```text
distributions/<id>/
  toss.json
  assets/
  help/<locale>/
  templates/
  templates/gallery/
  templates/gallery-thumbnails/
  typst/catalog.json
```

`TOSS_CONFIG` may be absolute or relative to the process working directory.
Paths inside the JSON resolve relative to that file. If it is absent, source
development searches for the Community distribution and then uses embedded
Community defaults.

The current schema is version 6 and rejects unknown fields.

| Section | Responsibility |
| --- | --- |
| `product` | Name, localized description, managed-name policy, mark, colors, favicon/touch icon, and indexing policy |
| `git` | External checkpoint branch prefix and safe fallback commit identity |
| `project_types` | Included cross-layer project types and their starter templates |
| `frontend_features` | Frontend feature build bounds and safe defaults |
| `ai_assistant` | Required connection policy when the Assistant is included: Community user-defined connections or one downstream managed provider/model catalog |
| `document_processing` | Product allowlist of durable processing operations |
| `typst` | Built-in catalog root |
| `template_gallery` | Built-in template metadata, sources, and thumbnails |
| `experience` | Landing content, Help topics, and resource links |

Startup fails on an unknown schema, malformed product values, unsafe paths,
missing catalog, invalid template, or processing operation that contradicts
the distribution's project-type set.

## Three typed dimensions

`project_types.typst` is required and `project_types.latex` is optional. Each
entry owns its starter template. Backend project creation/copy and frontend
controls enforce the selected set as one cross-layer product contract.

`frontend_features.included` bounds browser feature code a distribution may
ship. `default_enabled` must be a subset. The deployment TOML may enable only
included features, and the web build manifest provides a second artifact-level
fence. Community includes `ai_assistant` as an optional frontend feature but
does not enable it by default. The Community web artifact therefore contains
its lazy host chunk and matching isolated Runtime, while deployment
configuration still decides whether either route is exposed. Browser AI
remains separate from Document Processing.

When `frontend_features.included` contains `ai_assistant`, the top-level
`ai_assistant.connection_policy` is required. Community uses
`{"kind":"user_defined"}`. A downstream `managed_catalog` policy fixes one
credential-free HTTPS provider base URL, the `openai-completions` wire protocol,
`openai-models` discovery, and one or more verified recommendation profiles.
Profiles carry stable IDs, upstream model IDs, localized labels,
context/output defaults, reasoning capability, and bounded request overrides.
The policy may additionally enable custom profiles for other live-catalog
models, with editable defaults, strict numeric limits, mandatory catalog
matching, and a saved-profile bound. Duplicate IDs/models, unsafe URLs or
request fields, invalid token budgets/limits, and missing defaults fail
distribution loading. See the complete shape and ownership rules in
[Browser AI assistant](../architecture/browser-ai-assistant.md#connection-policy-ownership).

`document_processing.allowed_operations` is a closed allowlist of Core-known,
versioned operations. Community enables `latex.compile.pdf/v1`. This is product
policy, not worker configuration: the deployment TOML must configure a worker
identity with an exact processor-contract allowlist, and live availability
requires a compatible healthy session. Do not put worker identities, tokens,
or private processor configuration in the distribution file.

The frontend build reads `project_types`, `frontend_features`, and the AI
connection-policy kind when AI is included; it does not parse
`document_processing`. A Core-backed host build does not receive a managed
endpoint or model profile. A Typst-only build aliases the LaTeX editor and
runtime to disabled modules and excludes BusyTeX assets. Every build emits
`toss-build-manifest.json`, which Core checks against runtime configuration.
Schema 2 also binds an included AI host build to the exact
`/_ai-runtime/bootstrap.html` artifact, build ID, and connection-policy kind.
Core injects the validated full Runtime policy only when serving that no-store
entry.

A static build has no server injection point. It applies
`TOSS_BROWSER_ENABLED_FEATURES` when that comma-separated build setting is
present, otherwise it uses `frontend_features.default_enabled`. The explicit
selection may contain only distribution-included features; unknown, duplicate,
or empty items in a non-empty list fail the build. An empty value explicitly
disables all optional frontend features. The validated AI policy is embedded
only in the opaque Runtime entry, while host-side configuration stays redacted.
An AI-excluded build emits neither the Assistant chunk, candidate compiler/docs
tool, KaTeX assets, nor the Runtime artifact.

## Product identity

The backend exposes sanitized product values through `/v1/auth/config` and
renders them into production `index.html` before serving the SPA. Startup
skeleton, tab title, favicon, theme color, hydrated shell, landing page, and
sign-in page therefore use one identity without a pre-hydration branding flash.

When `product.name_managed` is true, the distribution name overrides the
database site name and the administrator field is read-only. Community leaves
the name administrator-managed.

Product assets must be bounded regular PNG, ICO, or passive SVG files below the
distribution root. Symlinks and path escapes are rejected.

## Gallery

Each `template_gallery.builtins` entry declares a stable ID, localized name and
description, category, tags, enabled project type, entry file, source directory,
optional thumbnail, featured flag, and optional accent.

Startup recursively validates source paths, symlinks, UTF-8 text, duplicate IDs,
entry files, file counts, and byte limits. Instantiation creates a normal
independent project through Workspace provisioning. Personal and shared
templates are existing projects and use the normal copy workflow.

Community sources must be public-safe. A downstream distribution owns any
private templates, packages, fonts, and resource links outside the Community
tree and must not make the Community fallback depend on them.

## Landing, Help, and resources

Landing content and resources are localized values in JSON. Help topic Markdown
is loaded at startup from distribution-relative files. Raw HTML is not rendered.

Every resource and Help topic declares `public` or `authenticated` visibility.
Public `/v1/experience` and `/v1/help` responses omit authenticated entries and
use private no-store caching with cookie/authorization variance.

Localized Help Center files are runtime product content. They remain bilingual
even though the engineering wiki is English-only.

Help topics may declare typed `availability.project_types`,
`availability.frontend_features`, and `availability.processing_operations`
requirements. Distribution loading rejects impossible requirements. Runtime
Help filtering uses enabled frontend features and configured processing
operations, but not transient worker heartbeat state.

## Build selection

```bash
docker build -f backend/Dockerfile \
  --build-arg TOSS_DISTRIBUTION=community \
  -t typst-collab:community .
```

`TOSS_DISTRIBUTION` selects files during image construction.
`TOSS_CONFIG` is the application path to the selected runtime JSON.
A downstream image supplies its own distribution directory and passes its
stable distribution ID to the same build argument.

## Related

- [Configuration index](./README.md)
- [Deployment configuration](./deployment.md)
- [Product model](../product/overview.md)
- [Typst runtime](../runtimes/typst.md)
- [LaTeX runtime](../runtimes/latex.md)
- [Document processing](../architecture/document-processing.md)
- [Decision: distributions](../decisions/0003-configured-distributions.md)
