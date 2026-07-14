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
  - web/typst-runtime.config.json
  - distributions/community/typst/catalog.json
  - third-party/typst.ts
---

# Typst browser runtime

Typst compilation and rendering run in browser workers. The backend serves
authenticated package and font resources, but it is not a second Typst
compiler. Persistent compiler and renderer sessions retain WASM state between
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

For `@preview/<name>:<version>` imports, resolution proceeds through:

1. the immutable catalog seed in the application image;
2. a validated entry in the persistent package cache;
3. an on-demand fetch from Typst Universe when enabled.

All seeded and dynamic Universe archives reach the browser through
`/v1/typst/packages/preview/<name>/<version>`. The browser does not contact the
upstream registry directly. Existing seeds and cached entries remain usable
while the upstream is unavailable.

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

The public compiler/renderer source fork is pinned as the
`third-party/typst.ts` submodule. `web/typst-runtime.config.json` binds the
compiler source revision, wrapper and renderer versions, and browser cache
version. The web application consumes a versioned compiler package produced
from that revision rather than rebuilding Rust/WASM during every application
image build.

Compiler packages are release artifacts with reproducible provenance: the
source revision, builder image, tool versions, features, file sizes, and
digests must be recorded and verified before a web build. Updating only the
submodule gitlink does not update the compiler used by the application. A
runtime upgrade must publish the matching package and update the runtime
configuration together.

The concrete artifact publication location is a delivery concern. An internal
deployment may retain it in a protected artifact tree; an extracted Community
repository can publish the same package from its public CI. Neither choice
changes the browser or package-resolution contract described here.

## Related

- [Frontend architecture](../architecture/frontend.md)
- [Distribution configuration](../configuration/distributions.md)
- [Testing and validation](../development/testing.md)
