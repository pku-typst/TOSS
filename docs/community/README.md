---
title: "Community documentation"
summary: "Navigation for the public collaborative typesetting platform."
status: current
type: index
scope: community
audience:
  - contributor
  - operator
  - coding-agent
topics:
  - documentation
  - navigation
  - community
related:
  - docs/community/product/overview.md
  - docs/community/architecture/overview.md
  - docs/community/architecture/release-resilience.md
  - docs/community/architecture/browser-ai-assistant.md
  - docs/community/architecture/document-processing.md
  - docs/community/development/setup.md
code_paths:
  - docs/community
  - distributions/community/help
  - protocol
  - web
---

# Community documentation

This directory is the self-contained engineering Wiki for the Community
product. It documents the public product model and extension points without
assuming a particular company, deployment platform, private package, or Git
provider.

All engineering documentation is maintained in English. Localized files under
`distributions/*/help/` are application Help Center content, not alternate
versions of this Wiki.

## Start here

| Goal | Read in this order |
| --- | --- |
| Understand the product | [Product model](./product/overview.md) → [Glossary](./glossary.md) |
| Understand the system | [Architecture overview](./architecture/overview.md) → the relevant context page |
| Set up a workstation | [Development setup](./development/setup.md) → [Testing](./development/testing.md) |
| Deploy or operate it | [Deployment](./operations/deployment.md) → [Configuration](./configuration/README.md) |
| Change an API | [API guide](./reference/api.md) → [Application protocols](../../protocol/README.md) |
| Change user-facing Help | [Distribution configuration](./configuration/distributions.md#landing-help-and-resources) → localized files under `distributions/community/help/` |
| Change a compiler runtime | [Typst runtime](./runtimes/typst.md) or [LaTeX runtime](./runtimes/latex.md) |
| Operate or extend durable processing | [Document processing](./architecture/document-processing.md) → [Worker protocol](./reference/worker-protocol.md) → [LaTeX worker](./runtimes/latex-worker.md) |
| Understand a design choice | [Decision records](./decisions/README.md) |

## Topic map

### Product and architecture

- [Product model](./product/overview.md) and [Glossary](./glossary.md)
- [Architecture overview](./architecture/overview.md)
- [Frontend](./architecture/frontend.md) and [Backend](./architecture/backend.md)
- [Browser AI assistant design draft](./architecture/browser-ai-assistant.md)
- [Durable document processing](./architecture/document-processing.md)
- [Collaboration](./architecture/collaboration.md),
  [Versioning](./architecture/versioning.md), and
  [single-replica release resilience](./architecture/release-resilience.md)
- [External repositories](./architecture/external-repositories.md)
- [Identity and access](./architecture/identity-and-access.md)
- [Error model](./architecture/error-model.md)

### Configuration and runtimes

- [Configuration index](./configuration/README.md)
- [Deployment configuration](./configuration/deployment.md)
- [Distribution configuration](./configuration/distributions.md)
- [External Git configuration](./configuration/external-git.md)
- [Typst runtime](./runtimes/typst.md), [browser LaTeX runtime](./runtimes/latex.md), and [native LaTeX worker](./runtimes/latex-worker.md)

### Development, operations, and reference

- [Development setup](./development/setup.md)
- [Testing and validation](./development/testing.md)
- [Deployment and operations](./operations/deployment.md)
- [API surface](./reference/api.md)
- [Worker protocol](./reference/worker-protocol.md)
- [Application protocols](../../protocol/README.md)
- [Product and editor design language](../../web/DESIGN.md)

## Sources of truth

When sources disagree, use this precedence:

1. generated contracts and executable configuration, including
   `protocol/openapi.json`, distribution JSON, manifests, and migrations;
2. current code and tests in the owning module;
3. current-reference pages in this Wiki;
4. accepted decision records, which preserve rationale but do not override an
   executable contract.

Update the owning page in the same change as behavior, configuration,
protocol, runtime, or operational changes. Describe current behavior in present
tense, put durable rationale in an ADR, and avoid completed task trackers or
migration diaries as reference documentation.

## Frontmatter contract

Every managed page uses the same YAML fields: `title`, `summary`, `status`,
`type`, `scope`, `audience`, `topics`, `related`, and `code_paths`. `scope` is
part of the retrieval and publication contract, not an informal label. The
final prose section is always **Related** so renderers that ignore frontmatter
can still traverse the Wiki.

## Related

- [Product model](./product/overview.md)
- [Architecture overview](./architecture/overview.md)
- [Single-replica release resilience](./architecture/release-resilience.md)
- [Browser AI assistant design draft](./architecture/browser-ai-assistant.md)
- [Durable document processing](./architecture/document-processing.md)
- [Development setup](./development/setup.md)
