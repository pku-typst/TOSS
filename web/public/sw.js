const TYPST_CACHE = "typst-runtime-v3";
const PROJECT_ASSET_CACHE_PREFIX = "toss.project.asset.content.v2.";
const TYPST_RUNTIME_MANIFEST_PATH = "/typst-runtime/manifest.json";

self.addEventListener("install", (event) => {
  event.waitUntil(Promise.resolve());
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter(
            (name) => name !== TYPST_CACHE && !name.startsWith(PROJECT_ASSET_CACHE_PREFIX)
          )
          .map((name) => caches.delete(name))
      );
      await self.clients.claim();
    })()
  );
});

function isTypstRuntimeAssetPath(pathname) {
  return (
    (pathname.startsWith("/typst-runtime/") && pathname !== TYPST_RUNTIME_MANIFEST_PATH) ||
    pathname.startsWith("/vendor/typst-assets/fonts/")
  );
}

function isVersionedTypstRuntimeManifest(url) {
  // The application build supplies this identity from its compiler/renderer
  // ABI pins. An unversioned manifest is mutable and must never be cache-first.
  return (
    url.pathname === TYPST_RUNTIME_MANIFEST_PATH &&
    Boolean(url.searchParams.get("runtime"))
  );
}

async function cacheFirst(cacheName, request) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  const network = await fetch(request);
  if (network.ok) {
    cache.put(request, network.clone()).catch(() => undefined);
  }
  return network;
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (isVersionedTypstRuntimeManifest(url) || isTypstRuntimeAssetPath(url.pathname)) {
    event.respondWith(cacheFirst(TYPST_CACHE, request));
    return;
  }

  if (url.pathname === TYPST_RUNTIME_MANIFEST_PATH) {
    event.respondWith(fetch(request, { cache: "no-store" }));
  }
});
