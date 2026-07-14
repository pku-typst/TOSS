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
  - capabilities
related:
  - docs/community/configuration/README.md
  - docs/community/product/overview.md
  - docs/community/runtimes/typst.md
  - docs/community/runtimes/latex.md
code_paths:
  - backend/src/distribution
  - distributions/community/toss.json
---

# Distribution configuration

A versioned distribution file selects product identity, capabilities, and
content without product-specific branches in core application code. The
Community distribution is the public baseline; downstream deployments may add
their own distribution directories as overlays.

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

The current schema is version 4 and rejects unknown fields.

| Section | Responsibility |
| --- | --- |
| `product` | Name, localized description, managed-name policy, mark, colors, favicon/touch icon, and indexing policy |
| `git` | External checkpoint branch prefix and safe fallback commit identity |
| `capabilities` | Enabled project types |
| `typst` | Built-in catalog root and starter templates |
| `template_gallery` | Built-in template metadata, sources, and thumbnails |
| `experience` | Landing content, Help topics, and resource links |

Startup fails on an unknown schema, malformed product values, unsafe paths,
missing catalog, invalid template, or project type that contradicts the
distribution capability set.

## Capabilities

`capabilities.project_types` must contain `typst` and may contain `latex`. A
LaTeX-enabled distribution configures a LaTeX starter; a Typst-only
distribution omits it. Backend project creation/copy and frontend controls both
enforce the selected set.

The frontend reads the same distribution during build. A Typst-only build may
alias the LaTeX editor and runtime to disabled modules and exclude BusyTeX
assets; runtime configuration cannot add them back.

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
- [Product model](../product/overview.md)
- [Typst runtime](../runtimes/typst.md)
- [LaTeX runtime](../runtimes/latex.md)
- [Decision: distributions](../decisions/0003-configured-distributions.md)
