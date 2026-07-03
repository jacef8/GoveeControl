/* Govee Control — minimal offline shell.
   Bump CACHE on every deploy so installed PWAs don't serve a stale page. */
const CACHE = "govee-v27";
const SHELL = ["./", "./index.html", "./manifest.json"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  // Never cache proxy/API calls — always go to network for live light state.
  if (/^\/(govee|ai|automations|triggers|health)\b/.test(url.pathname)) return;
  // App shell: cache-first, fall back to network.
  e.respondWith(caches.match(e.request).then(hit => hit || fetch(e.request)));
});
