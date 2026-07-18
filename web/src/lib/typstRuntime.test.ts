import { afterEach, describe, expect, it, vi } from "vitest";
import runtimeConfig from "../../typst-runtime.config.json";
import {
  loadTypstRuntimeManifest,
  TYPST_RUNTIME_BUILD_ID,
  TYPST_RUNTIME_MODULE_CACHE,
  type TypstRuntimeManifest
} from "./typstRuntime";

function runtimeManifest(
  overrides: Partial<TypstRuntimeManifest> = {}
): TypstRuntimeManifest {
  return {
    schema: 2,
    typst_ts_version: runtimeConfig.runtime_version,
    compiler_package_version: runtimeConfig.compiler.package_version,
    compiler_upstream_package_version: runtimeConfig.compiler.upstream_package_version,
    compiler_source_revision: runtimeConfig.compiler.source_revision,
    renderer_package_version: runtimeConfig.renderer.package_version,
    compiler: {
      url: "compiler/typst_ts_web_compiler_bg.wasm",
      sha256: "a".repeat(64),
      size_bytes: 1024
    },
    renderer: {
      url: "renderer/typst_ts_renderer_bg.wasm",
      sha256: "b".repeat(64),
      size_bytes: 512
    },
    ...overrides
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Typst runtime manifest", () => {
  it("loads through a build-specific cache key", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify(runtimeManifest()), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(loadTypstRuntimeManifest("https://toss.example/typst-runtime/")).resolves.toMatchObject({
      compiler_source_revision: runtimeConfig.compiler.source_revision
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [requestUrl, requestInit] = fetchMock.mock.calls[0];
    const url = new URL(String(requestUrl));
    expect(url.pathname).toBe("/typst-runtime/manifest.json");
    expect(url.searchParams.get("runtime")).toBe(TYPST_RUNTIME_BUILD_ID);
    expect(requestInit).toMatchObject({ cache: "no-store", credentials: "same-origin" });
    expect(TYPST_RUNTIME_MODULE_CACHE).toContain(TYPST_RUNTIME_BUILD_ID);
  });

  it("rejects a manifest built for another compiler ABI", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify(
            runtimeManifest({
              typst_ts_version: "0.8.0-rc3-source-map.previous",
              compiler_source_revision: "1".repeat(40)
            })
          ),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      )
    );

    await expect(loadTypstRuntimeManifest("https://toss.example/typst-runtime/")).rejects.toThrow(
      "incompatible with this application build"
    );
  });

  it("accepts an integrity-pinned HTTPS compiler and keeps the renderer local", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify(
            runtimeManifest({
              compiler: {
                url: runtimeConfig.compiler.browser_url,
                sha256: "c".repeat(64),
                size_bytes: 2048
              }
            })
          ),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      )
    );

    await expect(
      loadTypstRuntimeManifest("https://toss.example/typst-runtime/")
    ).resolves.toMatchObject({
      compiler: { url: runtimeConfig.compiler.browser_url },
      renderer: { url: "renderer/typst_ts_renderer_bg.wasm" }
    });
  });

  it.each([
    "http://cdn.example/compiler.wasm",
    "https://user@cdn.example/compiler.wasm",
    "https://cdn.example/compiler.wasm?mutable=1"
  ])("rejects unsafe external compiler URL %s", async (url) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify(
            runtimeManifest({
              compiler: {
                url,
                sha256: "c".repeat(64),
                size_bytes: 2048
              }
            })
          ),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      )
    );

    await expect(
      loadTypstRuntimeManifest("https://toss.example/typst-runtime/")
    ).rejects.toThrow("manifest is incomplete");
  });

  it("rejects an external renderer URL", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify(
            runtimeManifest({
              renderer: {
                url: "https://cdn.example/renderer.wasm",
                sha256: "d".repeat(64),
                size_bytes: 1024
              }
            })
          ),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      )
    );

    await expect(
      loadTypstRuntimeManifest("https://toss.example/typst-runtime/")
    ).rejects.toThrow("manifest is incomplete");
  });
});
