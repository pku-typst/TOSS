# BusyTeX runtime package

`build-manifest.json` pins the public BusyTeX build repository, source
revision, release tag, file sizes, and SHA-256 values. The ignored `package/`
directory is hydrated directly from those release assets:

```bash
node scripts/fetch-runtime-artifacts.mjs busytex
```

Do not commit or hand-edit downloaded runtime files. Update the dependency,
upstream release provenance, manifest, and browser tests together.
