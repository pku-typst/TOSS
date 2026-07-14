---
title: "ADR-0003: Configured product distributions"
summary: "Keep public-core behavior neutral and select branded capabilities through validated distribution files."
status: accepted
type: decision
scope: community
audience:
  - contributor
  - operator
  - coding-agent
topics:
  - distributions
  - product-configuration
  - public-core
related:
  - docs/community/configuration/distributions.md
  - docs/community/product/overview.md
  - docs/community/configuration/README.md
code_paths:
  - backend/src/distribution
  - distributions/community/toss.json
---

# ADR-0003: Configured product distributions

## Decision

One application core supports the Community product and downstream
distributions. A validated distribution file supplies product identity,
capabilities, templates, Help, resources, and runtime catalog selection.
Secrets remain outside that file.

## Consequences

- public-core modules cannot assume a downstream identity or one Git provider;
- startup rejects invalid capabilities and missing referenced assets;
- build-time capability removal bounds what runtime configuration can enable;
- downstream packages and fonts remain separate from Community content;
- product variation does not justify forks throughout the UI or backend.

## Related

- [Distribution configuration](../configuration/distributions.md)
- [Product overview](../product/overview.md)
- [Configuration index](../configuration/README.md)
