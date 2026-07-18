---
title: "Typst browser runtime"
summary: "Browser compilation, package resolution, cache policy, and compiler-version contract."
status: current
type: guide
scope: community
audience:
  - contributor
  - operator
  - coding-agent
topics:
  - typst
  - webassembly
  - packages
  - provenance
related:
  - docs/community/architecture/frontend.md
  - docs/community/configuration/distributions.md
  - docs/community/development/testing.md
code_paths:
  - web/src/lib/typst.worker.ts
  - web/src/lib/typst.ts
  - web/scripts/sync-typst-assets.mjs
  - web/typst-runtime.config.json
  - distributions/community/typst/catalog.json
  - third-party/typst.ts
---

# Typst browser runtime

Typst compilation and rendering run in browser workers. In a Core deployment,
the backend serves authenticated package and font resources, but it is not a
second Typst compiler. A static deployment loads public runtime resources
directly. Persistent compiler and renderer sessions retain WASM state between
edits and use incremental vector updates for previews.

The React boundary supplies each compile from one immutable Workspace snapshot.
The runtime then diffs that snapshot against the last worker-acknowledged
Workspace and sends only document and asset upserts or deletions. Stable decoded
font-buffer identities let it skip font reloads when unrelated files change.
Snapshot revisions are local freshness tokens; they are not content digests or
server cache keys.

## Package resolution

The active distribution selects a versioned catalog. The Community catalog is
`distributions/community/typst/catalog.json` and may contain local packages,
seeded Typst Universe archives, and fonts with source, path, byte length, and
SHA-256 metadata.

In a Core deployment, `@preview/<name>:<version>` resolution proceeds through:

1. the immutable catalog seed in the application image;
2. a validated entry in the persistent package cache;
3. an on-demand fetch from Typst Universe when enabled.

For `@local/<name>:<version>` imports, resolution is intentionally narrower:
the exact package must be listed in the active catalog's `local_packages`
collection. A missing local package returns `404` and never falls through to
Typst Universe.

All local, seeded, and dynamic archives in that topology reach the browser
through `/v1/typst/packages/<namespace>/<name>/<version>`. Existing local,
seeded, and cached entries remain usable while the upstream is unavailable.
The same generic runtime asset endpoint supports browser compilation and
optional read-only package inspection; archive parsing and search remain
browser-side rather than forming an AI backend.

The static target has no private catalog or cache proxy. It resolves
`@preview` packages from the official public Typst package source and does not
advertise `@local` packages. The compiler and package-inspection tools share
the same package-source abstraction, so they cannot silently disagree about
where a package came from.

Package and font endpoints require a signed-in account. A named guest session
alone cannot fetch catalog resources. Supporting protected packages for
anonymous guests would require a project-scoped, short-lived resource grant;
making the entire catalog public is not an equivalent security model.

## Package configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `TYPST_UNIVERSE_ENABLED` | `true` | Permit upstream access after seed and cache misses |
| `TYPST_UNIVERSE_BASE_URL` | `https://packages.typst.org` | HTTPS upstream without credentials, query, or fragment |
| `TYPST_PACKAGE_CACHE_DIR` | `/tmp/typst-packages-cache` | Dynamic archive cache; mount writable storage when a warm cache matters |
| `TYPST_PACKAGE_CACHE_MAX_BYTES` | 4 GiB | Per-instance cache budget |
| `TYPST_PACKAGE_MAX_ARCHIVE_BYTES` | 64 MiB | Maximum downloaded archive |
| `TYPST_PACKAGE_MAX_EXTRACTED_BYTES` | 256 MiB | Maximum expanded package size |
| `TYPST_PACKAGE_MAX_FILE_BYTES` | 64 MiB | Maximum expanded file size |
| `TYPST_PACKAGE_MAX_FILES` | 4,096 | Maximum files in one archive |

The upstream URL must use HTTPS without credentials, query, or fragment. The
runtime follows at most three redirects, and every redirect target must remain
HTTPS. Before serving an archive, it validates transfer and expanded sizes,
file count, paths, manifest consistency, structure, and digest.

## Compiler and renderer contract

The public compiler source fork is pinned as `third-party/typst.ts`.
`web/typst-runtime.config.json` binds that source revision, the exact fork npm
package, its upstream ABI version, the renderer, and the browser cache version.
The package carries source and upstream provenance and is installed through
the npm lockfile; an application build never recompiles Rust/WASM implicitly.

Core builds copy the compiler WASM from the installed package into the
same-origin static runtime. Standalone builds put its exact-version jsDelivr
URL in the runtime manifest and omit the 30 MiB compiler from the Pages
artifact. In both cases the manifest records the raw byte length and SHA-256,
and the worker verifies both before instantiation. CDN gzip or Brotli is only a
transport encoding and does not change the verified bytes.

Updating only the submodule does not update the compiler used by the
application. A runtime upgrade publishes the new immutable fork package first,
then updates the submodule, npm dependency and lockfile, runtime configuration,
and renderer ABI pin together.

The wasm-bindgen JavaScript glue is part of the hashed application bundle, so
its ABI must stay coupled to the fetched WASM. The browser derives a runtime
build identity from the configured compiler and renderer pins, includes it in
the manifest request and decoded-module cache, and rejects a manifest whose
pins differ from the application build. The service worker caches only that
versioned manifest request; the mutable unversioned manifest always bypasses
its cache. Versioned WASM and font assets remain cache-first. This lets an
upgrade retain the large runtime-asset cache without pairing a new application
bundle with a stale compiler binary.

## Related

- [Frontend architecture](../architecture/frontend.md)
- [Distribution configuration](../configuration/distributions.md)
- [Testing and validation](../development/testing.md)
