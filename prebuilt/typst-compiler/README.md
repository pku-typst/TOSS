# Prebuilt Typst compiler package

This directory contains the versioned browser compiler package generated from
the exact `third-party/typst.ts` submodule revision. The WASM binary is stored
with Git LFS; the manifest binds every file to its source revision, pinned
builder Dockerfile, byte size, and SHA-256.

Do not edit generated package files by hand. Regenerate only when the compiler
source or build recipe changes:

```bash
node scripts/prebuilt-typst-compiler.mjs build
node scripts/prebuilt-typst-compiler.mjs verify
```

Ordinary application builds only run `verify` and copy this package. They do
not compile or optimize Typst WASM.
