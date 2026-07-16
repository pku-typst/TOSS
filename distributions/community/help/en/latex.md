## Browser LaTeX preview

Community deployments can optionally enable LaTeX projects. Live compilation runs in a persistent browser worker using the project's selected pdfTeX or XeTeX engine. Required TeX Live files are fetched through the service and cached on demand, so the first compilation that imports a new package is usually slower.

Use XeTeX when the document depends on modern font selection. Use pdfTeX for conventional packages that expect the classic engine.

## Native background PDF build

For a signed-in user, when the deployment provides compatible processing capacity, the preview toolbar also offers **Build PDF in background**. This explicit action captures an immutable project snapshot, runs native TeX Live 2026 with `latexmk` in an isolated worker, and publishes the result in **Tasks**. The task continues if you navigate away or close the browser.

If the worker is temporarily offline, the action can queue a bounded build. If no compatible worker is configured, only the background action is unavailable; browser preview and local PDF download continue normally. After signing in, see **Background tasks and task center** in Help for snapshot, cancellation, access, and retention behavior.

## Compatibility and output

The browser runtime covers common document workflows but is not a full desktop TeX Live installation. Shell escape and host programs are unavailable. The native worker provides a broader pinned TeX Live environment and trusted helper programs, but it is still sandboxed and does not provide unrestricted shell or filesystem access.

Browser and native builds use independent runtime, package, font, and sandbox contracts, so their PDFs can differ. For publication-critical output, use the native background result when it matches the required workflow, then apply any additional verification required by your organization.
