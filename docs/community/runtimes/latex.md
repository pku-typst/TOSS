---
title: "Community LaTeX runtime"
summary: "BusyTeX lifecycle, TeX Live delivery, browser limits, and optional-distribution behavior."
status: current
type: guide
scope: community
audience:
  - contributor
  - operator
  - coding-agent
topics:
  - latex
  - busytex
  - webassembly
  - texlive
related:
  - docs/community/configuration/distributions.md
  - docs/community/architecture/frontend.md
  - docs/community/development/testing.md
code_paths:
  - web/src/lib/latex.worker.ts
  - web/src/lib/busyTexCompiler.ts
  - web/scripts/sync-busytex-assets.mjs
  - backend/src/latex_runtime
  - prebuilt/busytex/build-manifest.json
---

# Community LaTeX runtime

LaTeX is an optional distribution capability. A Typst-only distribution can
exclude the LaTeX editor module, worker bundle, BusyTeX JavaScript/WASM/data
files, and TeX Live route at build and runtime.

## Runtime and compile path

Community LaTeX uses `texlyre-busytex` 1.2.3 with the repository-pinned BusyTeX
build at `prebuilt/busytex/build-manifest.json`. That build contains TeX Live
2026 and is identified by the exact upstream source revision and release tag in
the manifest. The product currently exposes the existing XeLaTeX and pdfLaTeX
engine choices; BusyTeX also supports LuaLaTeX, but that is not part of the
application contract yet.

1. The workspace validates and sends the current text documents and binary
   assets to a dedicated browser worker.
2. The worker keeps one combined BusyTeX runner alive for the application
   origin. XeLaTeX and pdfLaTeX tools share that runner, so switching engines
   does not initialize a second WASM runtime.
3. BusyTeX mounts a new project MEMFS for every compile. Deleted or renamed
   project files therefore cannot leak from a prior run. TeX Live files fetched
   on demand remain registered in the long-lived runtime. Before compilation,
   the adapter registers the expected `.aux`, `.out`, `.toc`, `.bbl`, and related
   generated filenames as local misses, so Kpathsea does not incorrectly ask
   the TeX Live service for project build products.
4. BusyTeX runs the selected TeX driver, detects BibTeX and makeindex work,
   performs required reruns, converts XeTeX XDV output with `dvipdfmx`, and
   returns the PDF, log, and SyncTeX data. The application currently consumes the PDF
   and diagnostics; SyncTeX is available for a later source/preview navigation
   feature.
5. Only one compile runs at a time. While it is running, the outer compile
   client retains only the newest pending input instead of compiling every
   superseded keystroke.
6. A failed initialization or compile discards the runner. The next request
   starts from a clean runtime rather than retaining uncertain WASM state.

Shell escape is disabled. BusyTeX can emulate selected commands in JavaScript,
but the application does not register or enable those handlers.

This remains a full TeX compilation, not an incremental/watch compiler. The
long-lived WASM module, loaded TeX Live base, and on-demand TeX files are reused;
the project filesystem and generated auxiliary files are intentionally rebuilt
for each compile. BusyTeX manages the passes within that compile rather than
the application maintaining a second auxiliary-file state machine.

Before a compile request is cloned into the worker, paths must be unique and
project-relative. The browser accepts at most 4,096 files, 16 MiB per text
source, 64 MiB per binary asset, and 128 MiB decoded input in total. These are
browser memory-safety limits and are separate from HTTP upload policy.

## Pinned browser assets

The Community build copies six manifest-verified files from
`prebuilt/busytex/package/` to `web/public/busytex/1.2.3/`:

- the combined BusyTeX JavaScript/WASM engine and worker pipeline;
- the TeX Live 2026 basic data package and its loader.

Together they are approximately 120 MiB before transport compression and 76
MiB after the production gzip precompression step. This is a meaningful first
compile cost. The UI reports the compiler-download stage, HTTP caching avoids
unnecessary transfers, and Emscripten stores the preload data package in
IndexedDB for later runner initialization. Clearing site data or changing the
runtime cache version causes a fresh load.

The package directory is an ignored cache rather than repository content.
`scripts/fetch-runtime-artifacts.mjs` downloads the six files from the exact
BusyTeX build release named in the manifest and verifies every size and
SHA-256 before installation. A Typst-only build skips this download entirely.

Do not update one asset independently. Upgrade the npm dependency, exact
upstream build, manifest, tests, and TeX Live endpoint as one reviewed runtime
change.

## TeX Live on demand

Files outside the basic data package are requested by BusyTeX as
`{format}/{filename}`. The browser uses the authenticated same-origin endpoint
`GET /v1/latex/texlive/{format}/{filename}`. The backend validates a closed set
of BusyTeX/Kpathsea format identifiers and a single safe filename before it
looks in the cache or contacts an upstream.

The default upstream is `https://texlive2026.texlyre.org`, matching the pinned
BusyTeX build. The backend is deliberately a bounded proxy and cache, not an
independent CTAN package resolver: mixing a newer mutable CTAN tree with an
older browser format is the compatibility failure that this design removes.
Production operators may replace the default with a monitored, immutable mirror
that implements the same `{format}/{filename}` contract and contains the same
TeX Live generation.

Concurrent misses for one cache path share an in-flight operation. Successful
responses are written atomically below the versioned cache root; misses use a
short negative cache. A coalesced oldest-first sweep keeps the cache within its
budget. Upstream requests have a 5-second connect timeout and 120-second total
timeout, and HTTPS redirects cannot downgrade to non-loopback HTTP.

HTTP `404` is part of this file-miss protocol: TeX may probe optional config or
virtual-font files before selecting a fallback. Generated project auxiliary
files are filtered before transport, authentication/server errors remain hard
failures, and the final BusyTeX exit status determines whether any ordinary
TeX Live miss was actually required.

Configuration:

| Variable | Default | Purpose |
| --- | --- | --- |
| `LATEX_TEXLIVE_UPSTREAM_ENABLED` | `true` | Allow a cache miss to contact the configured BusyTeX file source |
| `LATEX_TEXLIVE_BASE_URL` | TeXlyre TeX Live 2026 endpoint | Base URL implementing `{format}/{filename}` |
| `LATEX_TEXLIVE_MAX_FILE_BYTES` | 64 MiB | Maximum cached or returned TeX Live file |
| `LATEX_TEXLIVE_CACHE_MAX_BYTES` | 4 GiB | Versioned on-demand file-cache budget |
| `LATEX_TEXLIVE_MISSING_TTL_SECONDS` | 300 | Negative-cache lifetime |

Set `LATEX_TEXLIVE_UPSTREAM_ENABLED=false` only for a deliberately preseeded
offline deployment. Every file not present in the browser's basic data package
must then already exist below `DATA_DIR/texlive/<cache-namespace>/`.

## Authorization and tests

`/v1/latex/texlive/*` requires a signed-in user and is only active when the
distribution enables LaTeX. BusyTeX performs synchronous same-origin requests
from its nested worker, so production must serve the SPA and API on one origin.
Named temporary guest sessions do not currently carry credentials into that
nested worker and cannot compile LaTeX projects.

The adapter and queue behavior are covered by Vitest; request and cache behavior
are covered by Rust tests. `web/tests/e2e/latex.spec.ts` creates XeLaTeX and
pdfLaTeX projects, compiles packages and references, edits one project live, and
requires a rendered browser canvas. It skips against Typst-only distributions.

## Related

- [Distribution configuration](../configuration/distributions.md)
- [Frontend architecture](../architecture/frontend.md)
- [Testing](../development/testing.md)
