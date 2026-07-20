import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

type ServiceWorkerEvent = {
  request?: Request;
  respondWith?: (response: Promise<Response> | Response) => void;
  waitUntil?: (operation: Promise<unknown>) => void;
};

function serviceWorkerHarness(cachedResponse: Response | null = null) {
  const listeners = new Map<string, (event: ServiceWorkerEvent) => void>();
  const cache = {
    match: vi.fn(async () => cachedResponse),
    put: vi.fn(async () => undefined)
  };
  const caches = {
    keys: vi.fn(async () => [
      "typst-runtime-v2",
      "typst-runtime-v3",
      "typst-runtime-v4",
      "toss.project.asset.content.v2.project",
      "unrelated-cache"
    ]),
    delete: vi.fn(async () => true),
    open: vi.fn(async () => cache)
  };
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    new Response("network", { status: 200 })
  );
  const worker = {
    location: { origin: "https://toss.example" },
    clients: { claim: vi.fn(async () => undefined) },
    skipWaiting: vi.fn(),
    addEventListener: vi.fn(
      (name: string, listener: (event: ServiceWorkerEvent) => void) => {
        listeners.set(name, listener);
      }
    )
  };

  vm.runInNewContext(
    readFileSync(new URL("../../public/sw.js", import.meta.url), "utf8"),
    {
      self: worker,
      caches,
      fetch: fetchMock,
      URL,
      Promise,
      Response,
      Request,
      Blob
    }
  );

  return { listeners, cache, caches, fetchMock };
}

async function dispatchFetch(
  listeners: Map<string, (event: ServiceWorkerEvent) => void>,
  url: string
) {
  let response: Promise<Response> | undefined;
  listeners.get("fetch")?.({
    request: new Request(url),
    respondWith(next) {
      response = Promise.resolve(next);
    }
  });
  if (!response) throw new Error(`Service worker did not handle ${url}`);
  return response;
}

describe("application service worker", () => {
  it.each(["", "?runtime=current-build"])(
    "bypasses caches for runtime manifest %s",
    async (query) => {
      const harness = serviceWorkerHarness(new Response("stale", { status: 200 }));

      const response = await dispatchFetch(
        harness.listeners,
        `https://toss.example/typst-runtime/manifest.json${query}`
      );

      await expect(response.text()).resolves.toBe("network");
      expect(harness.cache.match).not.toHaveBeenCalled();
      expect(harness.fetchMock).toHaveBeenCalledOnce();
      expect(harness.fetchMock.mock.calls[0][1]).toMatchObject({ cache: "no-store" });
    }
  );

  it("cache-hits a content-addressed runtime module", async () => {
    const harness = serviceWorkerHarness(new Response("cached", { status: 200 }));

    const response = await dispatchFetch(
      harness.listeners,
      `https://toss.example/typst-runtime/current/${"a".repeat(64)}/compiler.wasm`
    );

    await expect(response.text()).resolves.toBe("cached");
    expect(harness.cache.match).toHaveBeenCalledOnce();
    expect(harness.fetchMock).not.toHaveBeenCalled();
  });

  it("removes the previous runtime cache during activation", async () => {
    const harness = serviceWorkerHarness();
    let activation: Promise<unknown> | undefined;

    harness.listeners.get("activate")?.({
      waitUntil(operation) {
        activation = operation;
      }
    });
    await activation;

    expect(harness.caches.delete).toHaveBeenCalledWith("typst-runtime-v2");
    expect(harness.caches.delete).toHaveBeenCalledWith("typst-runtime-v3");
    expect(harness.caches.delete).toHaveBeenCalledWith("unrelated-cache");
    expect(harness.caches.delete).not.toHaveBeenCalledWith("typst-runtime-v4");
    expect(harness.caches.delete).not.toHaveBeenCalledWith(
      "toss.project.asset.content.v2.project"
    );
  });
});
