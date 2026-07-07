/* Service worker — network-first with a cache fallback.
 *
 * "Installable PWA" needs a SW with a fetch handler; this one is deliberately
 * network-first (always try the network, cache the result, fall back to cache
 * only when offline) so it NEVER serves stale JS/data while online — the
 * opposite failure mode of a cache-first SW. Enables home-screen install and a
 * working offline shell without a staleness footgun.
 */
const CACHE = "tvbrain-v1";

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
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(req))
  );
});
