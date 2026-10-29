// Nova LiveOS service worker — v1.0.1
// Caches the static shell only. All data (modules, screens, records) is
// fetched live from the data layer and is never baked into the cache.
//
// v1.0.1 strategy: NETWORK-FIRST for same-origin shell assets. The cache
// is an offline fallback only — a fresh tab must never be served a stale
// shell while the network can give it the current one (the v1.0.0
// cache-first handler pinned the first load of an upgraded deployment to
// the old shell until a manual reload). Cross-origin and non-GET
// requests (all data calls) are never intercepted.
const CACHE = "liveos-shell-1.0.1";
const SHELL = [
  "./", "./index.html", "./styles.css", "./app.js", "./config.js",
  "./manifest.webmanifest", "./favicon.ico",
  "./lib/core.mjs", "./lib/data.mjs", "./lib/seed-data.mjs",
  "./lib/icons.mjs", "./lib/features.mjs", "./lib/auth.mjs", "./lib/net.mjs",
  "./assets/nova-logo.jpg", "./assets/icon-192.png", "./assets/icon-512.png",
  "./assets/apple-touch-icon.png", "./assets/favicon-32.png"
];
self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return; // data calls go straight to the network
  e.respondWith(
    fetch(e.request).then((res) => {
      if (res && res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
      }
      return res;
    }).catch(async () => {
      const hit = await caches.match(e.request, { ignoreSearch: true });
      return hit || caches.match("./index.html", { ignoreSearch: true });
    })
  );
});
