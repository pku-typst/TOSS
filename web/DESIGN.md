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
  - web/src/components
  - web/src/pages
---

# Product and editor design language

The product uses one compact professional-editor system across configured
distributions. Identity and accent values come from the distribution rather
than page-specific branches.

## Component and styling boundary

- Use NVIDIA Elements for controls, dialogs, menus, tooltips, fields, badges,
  progress, and page-shell primitives.
- Use semantic properties from `src/design-tokens.css`; do not add literal UI
  colors for application states. Distribution accent values populate
  `--toss-brand-*` at runtime.
- CSS owns page composition, editor geometry, responsive behavior, and the few
  product illustrations that are not component concerns. Avoid selectors that
  reach into NVIDIA Elements shadow DOM or reproduce a component's interaction
  behavior.
- Use ordinary semantic HTML when it is the correct primitive. Navigation is
  implemented with React Router links rather than button-shaped click handlers.

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

## Related

- [Frontend architecture](../docs/community/architecture/frontend.md)
- [Durable document processing](../docs/community/architecture/document-processing.md)
- [Distribution configuration](../docs/community/configuration/distributions.md)
- [Testing](../docs/community/development/testing.md)
