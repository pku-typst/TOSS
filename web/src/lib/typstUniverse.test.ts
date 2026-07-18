import { describe, expect, it, vi } from "vitest";
import type {
  PackageRegistry,
  PackageResolveContext,
  PackageSpec
} from "@myriaddreamin/typst.ts/internal.types";
import {
  createHttpTypstPackageRequester,
  HybridPackageRegistry,
  UniversePackageRegistry
} from "@/lib/typstUniverse";

const previewSpec: PackageSpec = {
  namespace: "preview",
  name: "fixture",
  version: "1.2.3"
};

function archiveContext(entries: Array<[string, Uint8Array]>): PackageResolveContext {
  return {
    untar: (_bytes, callback) => {
      for (const [path, data] of entries) callback(path, data, 0);
    }
  };
}

describe("Typst Universe package registry", () => {
  it("downloads a preview package once and rematerializes it from memory", () => {
    const insertFile = vi.fn();
    const requestPackage = vi.fn(() => ({ bytes: new Uint8Array([1, 2, 3]) }));
    const onStatus = vi.fn();
    const registry = new UniversePackageRegistry({ insertFile }, requestPackage, onStatus);
    const context = archiveContext([
      ["typst.toml", new TextEncoder().encode("[package]")],
      ["src/lib.typ", new TextEncoder().encode("#let answer = 42")]
    ]);

    expect(registry.resolve(previewSpec, context)).toBe(
      "/@memory/universe/packages/preview/fixture/1.2.3"
    );
    expect(registry.resolve(previewSpec, context)).toBe(
      "/@memory/universe/packages/preview/fixture/1.2.3"
    );
    expect(requestPackage).toHaveBeenCalledTimes(1);
    expect(insertFile).toHaveBeenCalledTimes(4);
    expect(onStatus.mock.calls.map(([status]) => status.phase)).toEqual([
      "downloading",
      "complete"
    ]);
  });

  it("rejects unsafe archive paths before writing any files", () => {
    const insertFile = vi.fn();
    const registry = new UniversePackageRegistry({ insertFile }, () => ({
      bytes: new Uint8Array([1])
    }));
    const context = archiveContext([
      ["typst.toml", new Uint8Array([1])],
      ["../secret", new Uint8Array([2])]
    ]);

    expect(() => registry.resolve(previewSpec, context)).toThrow("Unsafe path");
    expect(insertFile).not.toHaveBeenCalled();
  });

  it("leaves non-preview namespaces for other registries", () => {
    const requestPackage = vi.fn(() => ({ bytes: new Uint8Array([1]) }));
    const registry = new UniversePackageRegistry({ insertFile: vi.fn() }, requestPackage);
    expect(
      registry.resolve(
        { namespace: "local", name: "nv", version: "0.6.0" },
        archiveContext([])
      )
    ).toBeUndefined();
    expect(requestPackage).not.toHaveBeenCalled();
  });

  it("backs off briefly after a package download failure", () => {
    const requestPackage = vi.fn(() => {
      throw new Error("upstream unavailable");
    });
    const registry = new UniversePackageRegistry({ insertFile: vi.fn() }, requestPackage);
    const context = archiveContext([]);

    expect(() => registry.resolve(previewSpec, context)).toThrow("upstream unavailable");
    expect(() => registry.resolve(previewSpec, context)).toThrow("upstream unavailable");
    expect(requestPackage).toHaveBeenCalledOnce();
  });
});

describe("hybrid Typst package registry", () => {
  it("prefers a local package before consulting the Universe registry", () => {
    const localResolve = vi.fn(() => "/local/package");
    const universeResolve = vi.fn(() => "/universe/package");
    const local: PackageRegistry = { resolve: localResolve };
    const universe: PackageRegistry = { resolve: universeResolve };
    const registry = new HybridPackageRegistry(local, universe);

    expect(registry.resolve(previewSpec, archiveContext([]))).toBe("/local/package");
    expect(localResolve).toHaveBeenCalledOnce();
    expect(universeResolve).not.toHaveBeenCalled();
  });
});

describe("Typst package HTTP requester", () => {
  it("uses a credentialed synchronous worker request to the backend endpoint", () => {
    class FakeXmlHttpRequest {
      static last: FakeXmlHttpRequest | undefined;
      responseType = "";
      withCredentials = false;
      status = 200;
      response: ArrayBuffer = new Uint8Array([1, 2, 3]).buffer;
      method = "";
      url = "";
      async = true;

      constructor() {
        FakeXmlHttpRequest.last = this;
      }

      open(method: string, url: string, async: boolean) {
        this.method = method;
        this.url = url;
        this.async = async;
      }

      send(_body: unknown) {}
    }
    vi.stubGlobal("XMLHttpRequest", FakeXmlHttpRequest);
    try {
      const response = createHttpTypstPackageRequester({
        kind: "toss",
        baseUrl: "https://typst.example/v1/typst/packages/",
        withCredentials: true,
      })(previewSpec);
      expect(Array.from(response.bytes)).toEqual([1, 2, 3]);
      expect(FakeXmlHttpRequest.last).toMatchObject({
        method: "GET",
        url: "https://typst.example/v1/typst/packages/preview/fixture/1.2.3",
        async: false,
        responseType: "arraybuffer",
        withCredentials: true
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
