const TYPST_CACHE = "typst-runtime-v2";
const PROJECT_ASSET_CACHE_PREFIX = "toss.project.asset.content.v2.";

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

function isTypstRuntimePath(pathname) {
  return (
    pathname.startsWith("/typst-runtime/") ||
    pathname.startsWith("/vendor/typst-assets/fonts/")
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

  if (isTypstRuntimePath(url.pathname)) {
    event.respondWith(cacheFirst(TYPST_CACHE, request));
  }
});
