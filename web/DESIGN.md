---
title: "Product and editor design language"
summary: "Shared visual, interaction, shell, and workspace rules across configured distributions."
status: current
type: reference
scope: community
audience:
  - contributor
  - designer
  - coding-agent
topics:
  - design-system
  - user-experience
  - frontend
related:
  - docs/community/architecture/frontend.md
  - docs/community/architecture/document-processing.md
  - docs/community/configuration/distributions.md
  - docs/community/development/testing.md
code_paths:
  - web/src/design-tokens.css
  - web/src/design-system.css
  - web/src/design/runtimeTheme.ts
  - web/src/components/ui.tsx
  - web/src/styles.css
  - web/src/pages
  - web/src/features
---

# Product and editor design language

The product uses one compact professional-editor system across configured
distributions. Identity and accent values come from the distribution rather
than page-specific branches.

## Design code layers

Design decisions flow in one direction. A feature may compose a lower layer,
but a lower layer must never know about a feature.

| Layer | Owner | Responsibility |
| --- | --- | --- |
| Distribution identity | validated experience configuration | Product name, mark, accent, contrast color, and public content |
| Semantic tokens | `src/design-tokens.css` | Meaningful color, type, density, shape, elevation, focus, and motion values |
| UI primitives | `src/components/ui.tsx`, `src/design-system.css` | Controls and recurring presentation patterns with complete interaction states |
| Application shell | `src/styles.css` | Document defaults, top navigation, startup skeletons, and route loading |
| Feature composition | co-located page and feature stylesheets | Domain-specific layout, information hierarchy, responsive behavior, and exceptional interactions |
| Isolated surfaces | `src/design/runtimeTheme.ts` and the isolated surface stylesheet | A resolved, validated subset of semantic tokens transported across the isolation boundary |

NVIDIA Elements is the implementation layer for many primitives. Feature code
consumes TOSS semantics and TOSS wrappers; it does not treat NVIDIA Elements
reference variables as a second application design system.

## Component and styling boundary

- Use NVIDIA Elements for controls, dialogs, menus, tooltips, fields, badges,
  progress, and page-shell primitives.
- Use the wrappers in `src/components/ui.tsx` when one exists. Add a primitive
  there when several features need the same control or state model. Do not add
  a generic component merely to avoid a small amount of feature markup.
- Use semantic properties from `src/design-tokens.css`. Distribution accent
  values populate `--toss-brand-*` at runtime. Literal colors are limited to
  audited identity marks, syntax highlighting, data visualization, and
  illustrations whose color carries content rather than application state.
- CSS owns page composition, editor geometry, responsive behavior, and the few
  product illustrations that are not component concerns. Avoid selectors that
  reach into NVIDIA Elements shadow DOM or reproduce a component's interaction
  behavior.
- Use ordinary semantic HTML when it is the correct primitive. Navigation is
  implemented with React Router links rather than button-shaped click handlers.

## Semantic tokens

Token names describe purpose rather than a page or feature. The portable set
covers:

- brand roles and interaction variants;
- canvas, shell, container, raised, field, selected, hover, and disabled layers;
- primary, muted, emphasis, placeholder, and disabled text;
- structural borders and danger, warning, and success feedback;
- application typography, spacing, compact control heights, radii, focus, and
  motion.

Feature CSS uses `--toss-*` properties for application decisions. Direct
`--nve-*` use belongs in the token or primitive implementation layer. Audited
content palettes may remain at a feature boundary when color itself carries
meaning, such as provider identity, collaborator presence, or illustration
artwork. A new token is justified when a meaning is shared; one-off geometry
remains local to the owning feature.

Token changes must be checked against at least the product shell, a data-entry
page, the workspace, and an isolated surface. A distribution accent must remain
legible with its configured contrast color and must not replace warning,
danger, success, or running semantics.

## UI primitives and patterns

Primitives own their complete interaction contract: hover, focus-visible,
disabled, validation, keyboard operation, accessible name, and compact sizing.
The current shared layer includes buttons, icon buttons with tooltips, inputs,
textareas, selects, checkboxes, badges, dialogs, cards, page and section
headings, and empty states.

Feature code still owns domain behavior. A disclosure that expands tool calls,
for example, may remain semantic HTML because it is not a generic button
variant. Conversely, a textarea must not be restyled separately in every
feature simply because its surrounding workflow differs.

Patterns such as section headings and empty states are intentionally small.
They establish alignment, typography, and state hierarchy without hiding the
feature's content model behind a configuration object.

## Feature composition and CSS ownership

`src/styles.css` owns only application-wide document and shell presentation.
Each route, bounded page area, reusable component, and optional feature imports
its own stylesheet from its owning module. An optional feature stylesheet must
be reachable only through that feature's enabled build entry so a disabled
build excludes both behavior and presentation.

During feature work:

1. use an existing semantic token and primitive;
2. add only the domain layout and exceptional presentation locally;
3. promote a repeated visual contract into the shared layer when it has more
   than one real consumer;
4. remove the superseded feature rules in the same change.

Do not create a page-specific palette, control height, focus ring, card header,
page heading, or empty-state implementation. Avoid broad selectors such as
`.error` or `.loading` that make a feature depend on incidental CSS imported by
another route. Feature modifiers may tune geometry around a shared primitive,
but they must not recreate its typography, color, or interaction contract.

CSS ownership follows component and bounded-area ownership, not arbitrary
line-count targets. A shared stylesheet is justified only by a shared visual
contract; selectors used by two pages do not belong in one page's stylesheet.
Moving unchanged selectors without establishing that boundary is not a
design-system improvement.

## Isolated surfaces

An iframe, worker-owned document, or future plugin surface cannot inherit the
host document's custom properties. It must not carry an unrelated hard-coded
theme or import NVIDIA Elements internals merely to resemble the host.

The host resolves the portable semantic token subset to concrete CSS values and
includes it in the authenticated initialization message. The isolated surface
validates the exact theme shape, applies only known custom properties, and uses
its own small stylesheet built entirely on those properties. Credentials and
other secrets are never part of the theme contract.

The runtime protocol stays at version 1 while the application is unreleased;
adding the initial theme field is part of defining that version, not a reason
to manufacture a version history. A future incompatible change after release
must follow the protocol compatibility policy.

## Product shell

- The same product name, mark, favicon, accent, and description must appear in
  static startup HTML and the hydrated application.
- Public Home explains the product visually and leads to Sign in and Help.
  Help content and resource links come from the active distribution.
- Route metadata owns page titles, selected navigation, and workspace layout.
  Unknown, forbidden, unavailable-project, and startup states always render an
  explicit recovery action.
- Static startup markup chooses the editor-shaped skeleton only for project and
  share routes. Product pages use a page-shaped skeleton, and route-level lazy
  loading preserves the already-rendered application shell.
- Help and Gallery data are cached in memory by account. Mutations explicitly
  invalidate their query; logout and session recovery clear every account-keyed
  browser cache.
- The authenticated shell exposes one account-scoped task control. Its badge
  summarizes active and failed durable work; its responsive drawer preserves
  project, state, failure, cancellation, and artifact-download context without
  turning the header into a second workflow page.
- Desktop and mobile navigation expose the same destinations. Icon-only actions
  require accessible labels and tooltips.

## Workspace

- Keep canvas, panel, preview, overlay, and popover surfaces on their
  corresponding NVIDIA Elements layer tokens.
- Workspace panels are continuous and flat. Elevation is reserved for menus,
  popovers, dialogs, and other floating UI.
- Page cards use the medium radius; workspace panels use square edges; compact
  controls use the extra-small radius.
- Preserve task and feedback semantics: danger, warning, success, and running
  states use status colors rather than being forced to the brand accent.
- Keep contextual submission beside the affected preview or import/export
  control, then project durable lifecycle into the global task center. A native
  background build must never look like a live-preview mode, preferred compiler,
  or automatic fallback.
- Closing the task drawer changes presentation only. It does not cancel work;
  explicit cancellation is available only while the owning domain permits it.
- Code syntax and collaborator cursors may use distinct palette colors for
  legibility, while editor chrome, focus, selection, and active states use the
  distribution accent.

## Verification

Vitest covers deterministic helpers and state boundaries. Playwright covers the
product shell, responsive overflow, authentication return paths, route states,
localized workflows, Gallery, and the editor/preview interaction. Distribution
builds and tests must pass for Community and every maintained downstream
distribution.

Design verification is evidence-based:

- primitive tests exercise behavior, keyboard/focus semantics, validation, and
  accessible structure;
- contract tests verify isolated-theme validation and transport;
- representative browser workflows verify real component rendering at compact
  workspace widths and ordinary page widths;
- build variants verify that optional feature code remains excluded when its
  capability is disabled.

Do not use exact product wording as a proxy for layout or behavior. Avoid a
bespoke regex checker that claims to validate the design system by scanning
source text; objective lint rules should use standard parser-based tooling and
be introduced only when they express a durable rule without an exception list.

## Review checklist

- Does the change reuse semantic tokens and a shared primitive where one
  already exists?
- Are all interaction states and keyboard paths present?
- Does responsive behavior preserve information hierarchy rather than merely
  hide controls?
- Is a status represented by its semantic tone instead of the brand color?
- Does optional feature code remain isolated, and is feature-specific styling
  kept out of shared primitives?
- If the UI crosses an isolation boundary, does it receive the resolved host
  theme rather than duplicating a palette?
- Were obsolete feature rules removed rather than left to compete in the
  cascade?

## Related

- [Frontend architecture](../docs/community/architecture/frontend.md)
- [Durable document processing](../docs/community/architecture/document-processing.md)
- [Distribution configuration](../docs/community/configuration/distributions.md)
- [Testing](../docs/community/development/testing.md)
