## Browser LaTeX preview

Community deployments can optionally enable LaTeX projects. Compilation runs in a browser worker using the selected pdfTeX or XeTeX engine.

Required TeX Live files are fetched through the service and cached on demand. A document that imports a new package therefore compiles more slowly the first time.

## Compatibility

The browser runtime covers common document workflows but is not a full desktop TeX Live installation. Shell escape and host programs are unavailable. Some packages that require native binaries, unusual font discovery, or unrestricted filesystem access will not work.

Use XeTeX when the document depends on modern font selection. Use pdfTeX for conventional packages that expect the classic engine.

For publication-critical output, download or synchronize the source and verify the final PDF with your organization’s supported LaTeX toolchain.
