/* Service worker — network-first with a cache fallback.
 *
 * "Installable PWA" needs a SW with a fetch handler; this one is deliberately
 * network-first (always try the network, cache the result, fall back to cache
 * only when offline) so it NEVER serves stale JS/data while online — the
 * opposite failure mode of a cache-first SW. Enables home-screen install and a
 * working offline shell without a staleness footgun.
 */
const CACHE = "tvbrain-v1";

// Don't fill the cache with the giant data bundles on every page view —
// discovery.json alone is ~4.7 MB and data.json ~0.8 MB, and the offline
// shell doesn't need them. They still work online (network-first).
const NO_CACHE = /\/(discovery|neighbors|probes|filmographies)\.json$/;

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(
    fetch(req)
      .then(res => {
        if (!NO_CACHE.test(new URL(req.url).pathname)) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(async err => {
        // caches.match resolves to UNDEFINED on a miss, and respondWith
        // rejects with an opaque TypeError when handed undefined. Return a
        // real response so an offline miss reads as an offline miss.
        const hit = await caches.match(req);
        if (hit) return hit;
        return new Response(
          "Offline and this request isn't cached.",
          { status: 504, statusText: "Offline", headers: { "Content-Type": "text/plain" } },
        );
      })
  );
});
