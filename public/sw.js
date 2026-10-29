// Nova LiveOS service worker — v0.1.0
// Caches the static shell only. All data (modules, screens, records) is
// fetched live from the data layer and is never baked into the cache.
const CACHE = "liveos-shell-0.1.1";
const SHELL = [
  "./", "./index.html", "./styles.css", "./app.js", "./config.js",
  "./manifest.webmanifest", "./favicon.ico",
  "./lib/core.mjs", "./lib/data.mjs", "./lib/seed-data.mjs",
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
    caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy));
      return res;
    }).catch(() => caches.match("./index.html", { ignoreSearch: true })))
  );
});
