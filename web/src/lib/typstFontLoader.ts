import {
  _resolveAssets,
  type BeforeBuildFn,
  type LoadRemoteFontsOptions
} from "@myriaddreamin/typst.ts/options.init";

type FontBuilder = {
  add_raw_font(font: Uint8Array): Promise<void> | void;
};

type FontBuildContext = {
  builder: FontBuilder;
};

type MarkedFontLoader = BeforeBuildFn & {
  _kind: "fontLoader";
  _preloadRemoteFontOptions: LoadRemoteFontsOptions;
};

async function fetchFont(url: string, fetcher: typeof fetch) {
  const response = await fetcher(url);
  if (!response.ok) {
    throw new Error(`Typst font fetch failed: ${response.status}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

/**
 * Browser-only font loader for typst.ts.
 *
 * The upstream loader eagerly constructs a dynamic-import `Function` for its
 * optional Node cache fallback, even when a browser fetcher was supplied. That
 * violates the application's CSP. The beforeBuild API already supplies the
 * font builder, so the browser can load the same fonts directly without eval.
 */
export function loadBrowserFonts(
  userFonts: Array<string | Uint8Array>,
  options: LoadRemoteFontsOptions
): BeforeBuildFn {
  const fonts = [...userFonts, ..._resolveAssets(options)];
  const loader = (async (_mark, rawContext) => {
    const { builder } = rawContext as FontBuildContext;
    const buffers = await Promise.all(
      fonts.map((font) =>
        font instanceof Uint8Array ? Promise.resolve(font) : fetchFont(font, options.fetcher ?? fetch)
      )
    );
    for (const buffer of buffers) {
      await builder.add_raw_font(buffer);
    }
  }) as MarkedFontLoader;

  // TypstCompilerDriver uses these marks to avoid adding its default loader.
  loader._kind = "fontLoader";
  loader._preloadRemoteFontOptions = options;
  return loader;
}
