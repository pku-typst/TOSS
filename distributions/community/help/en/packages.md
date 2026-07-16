## Import a package

Use the normal Typst package syntax, for example:

```typst
#import "@preview/cetz:0.4.2": *
```

The service validates and caches Typst Universe archives, then supplies them to the browser compiler. A package that is not already cached needs network access during its first compilation.

A deployment may also publish private or built-in packages through its active
catalog. Import one with the exact catalog version:

```typst
#import "@local/package-name:1.2.3": *
```

`@local` packages never fall back to Typst Universe. If the exact package is
not present in the active deployment catalog, the request fails.

## Add project assets

Drag files into **Files** or use the upload action. Keep paths relative and use forward slashes in Typst source.

```typst
#image("images/result.png", width: 70%)
```

Large images increase upload, synchronization, and browser compilation time. Resize source images to the resolution the document actually needs.

Packages can execute Typst code during compilation. Review unfamiliar packages and pin explicit versions for reproducible projects. When the optional AI Assistant is enabled, it can list, read, and search the text files of an exact `@preview` or available `@local` package. This is read-only, never grants arbitrary network access, and sends package text to the selected model only when the model calls one of those tools.
