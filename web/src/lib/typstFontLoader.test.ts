import { describe, expect, it, vi } from "vitest";
import { loadBrowserFonts } from "@/lib/typstFontLoader";

describe("loadBrowserFonts", () => {
  it("loads byte and URL fonts through the supplied browser fetcher", async () => {
    const localFont = new Uint8Array([1, 2]);
    const remoteFont = new Uint8Array([3, 4]);
    const fetcher = vi.fn(async () => new Response(remoteFont));
    const addRawFont = vi.fn(async () => undefined);
    const loader = loadBrowserFonts([localFont, "https://fonts.test/remote.otf"], {
      assets: false,
      fetcher
    });

    await loader(undefined as never, { builder: { add_raw_font: addRawFont } });

    expect(fetcher).toHaveBeenCalledOnce();
    expect(addRawFont).toHaveBeenNthCalledWith(1, localFont);
    expect(addRawFont).toHaveBeenNthCalledWith(2, remoteFont);
    expect((loader as { _kind?: string })._kind).toBe("fontLoader");
    expect((loader as { _preloadRemoteFontOptions?: { assets?: false } })._preloadRemoteFontOptions)
      .toEqual(expect.objectContaining({ assets: false }));
  });

  it("rejects failed font responses before building the compiler", async () => {
    const loader = loadBrowserFonts(["https://fonts.test/missing.otf"], {
      assets: false,
      fetcher: vi.fn(async () => new Response(null, { status: 404 }))
    });

    await expect(
      loader(undefined as never, { builder: { add_raw_font: vi.fn() } })
    ).rejects.toThrow("Typst font fetch failed: 404");
  });
});
