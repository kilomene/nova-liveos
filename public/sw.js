// Nova LiveOS service worker — v1.0.5
// Caches the static shell only. All data (modules, screens, records) is
// fetched live from the data layer and is never baked into the cache.
//
// v1.0.1 strategy: NETWORK-FIRST for same-origin shell assets. The cache
// is an offline fallback only — a fresh tab must never be served a stale
// shell while the network can give it the current one (the v1.0.0
// cache-first handler pinned the first load of an upgraded deployment to
// the old shell until a manual reload). Cross-origin and non-GET
// requests (all data calls) are never intercepted.
//
// v1.0.2 SELF-RESCUE (in the activate handler below): network-first alone
// could not save a page that was ALREADY OPEN running a pre-guard shell.
// Proven live: a returning browser held the whole v1.0.0 session even
// after v1.0.1 was deployed — the old cache-first worker kept serving its
// own cached document, the SPA never reloaded, and the v1.0.1
// controllerchange reload guard could not help because that guard lives
// in the NEW app.js, which was never loaded. The one component a browser
// is guaranteed to refresh on its own schedule is this service worker
// script itself (update checks bypass the old worker). So the escape
// lives HERE: when an activation actually replaces a DIFFERENT older
// shell version, the new worker force-navigates each open window client
// onto the new shell. Shells older than the reload guard get exactly one
// hop: old page → (SW update) → this activate → navigate → new shell.
// Shells that DO have the guard (v1.0.1+) are doubly covered and the
// in-app guard simply never needs to fire for this hop.
const CACHE = "liveos-shell-1.0.5";
const SHELL = [
  "./", "./index.html", "./styles.css", "./app.js", "./config.js",
  "./manifest.webmanifest", "./favicon.ico",
  "./lib/core.mjs", "./lib/data.mjs", "./lib/seed-data.mjs",
  "./lib/icons.mjs", "./lib/features.mjs", "./lib/auth.mjs", "./lib/net.mjs",
  "./lib/snapshot.mjs", "./lib/refresh.mjs", "./lib/patch.mjs",
  "./assets/nova-logo.jpg", "./assets/icon-192.png", "./assets/icon-512.png",
  "./assets/apple-touch-icon.png", "./assets/favicon-32.png"
];
self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    // Delete every cache that is not this build's. Remember whether any
    // existed: a stale cache means this activation REPLACED a different
    // previous shell version. On a first-ever install there is no stale
    // cache, so nothing below may navigate — the page that triggered the
    // install just loaded fresh from the network anyway.
    const keys = await caches.keys();
    const stale = keys.filter((k) => k !== CACHE);
    const replacedDifferentVersion = stale.length > 0;
    await Promise.all(stale.map((k) => caches.delete(k)));
    await self.clients.claim();
    if (!replacedDifferentVersion) return;
    // SELF-RESCUE: this runs at most once per activation (activate fires
    // exactly once in a worker's life), and only on a version-changing
    // activation. Force each open window onto the new shell — the
    // navigation is then served by THIS worker's network-first fetch
    // handler, so the client lands on the current shell even if the page
    // it was running predates every in-app reload guard.
    //
    // The navigations are fired DETACHED from a zero-delay timer, never
    // awaited inside waitUntil — that distinction is the whole ballgame.
    // Awaiting client.navigate() here DEADLOCKS in Chromium (proven in
    // local simulation): the navigation waits for this worker to finish
    // activating, so the new worker can serve it, while the activation's
    // waitUntil waits for the navigation to complete — the page hangs
    // mid-navigation forever. Scheduling just past activation breaks
    // the circle: activation completes first, then each window is
    // navigated onto the new shell.
    setTimeout(() => {
      self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
        for (const client of wins) {
          try {
            if (typeof client.navigate !== "function") continue;
            if (new URL(client.url).origin !== self.location.origin) continue;
            const nav = client.navigate(client.url);
            if (nav && typeof nav.catch === "function") nav.catch(() => {});
          } catch { /* a client that refuses navigation still gets the new shell on its next load */ }
        }
      }).catch(() => {});
    }, 0);
  })());
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
