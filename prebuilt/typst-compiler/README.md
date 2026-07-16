# Prebuilt Typst compiler package

This directory contains the versioned browser compiler package generated from
the exact `third-party/typst.ts` submodule revision. `build-manifest.json`
binds every file to that revision and the pinned builder; `artifact.json`
binds the reproducible package archive published by the typst.ts fork. The
ignored `package/` directory is hydrated and verified on demand:

```bash
node scripts/fetch-runtime-artifacts.mjs typst
```

Do not edit generated package files by hand. Regenerate only when the compiler
source or build recipe changes:

```bash
node scripts/prebuilt-typst-compiler.mjs build
node scripts/prebuilt-typst-compiler.mjs verify
```

After rebuilding, publish a deterministic package archive against the same
typst.ts source commit and update `artifact.json`. Ordinary application builds
download and verify that archive; they do not compile or optimize Typst WASM.
