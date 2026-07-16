## Import a package

Use the normal Typst package syntax, for example:

```typst
#import "@preview/cetz:0.4.2": *
```

The service validates and caches Typst Universe archives, then supplies them to the browser compiler. A package that is not already cached needs network access during its first compilation.

## Add project assets

Drag files into **Files** or use the upload action. Keep paths relative and use forward slashes in Typst source.

```typst
#image("images/result.png", width: 70%)
```

Large images increase upload, synchronization, and browser compilation time. Resize source images to the resolution the document actually needs.

Packages can execute Typst code during compilation. Review unfamiliar packages and pin explicit versions for reproducible projects.
