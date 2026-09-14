// The only reason this file exists: android treats an installed app differently from a
// tab, and chrome will only build a real installed app (a WebAPK, rather than a bookmark
// with an icon) for a site that has a manifest and a service worker that can answer when
// the network cannot. The player kept losing its sound a few minutes after the screen
// went dark, and being an app rather than a tab is the last lever the page has.
//
// So this is deliberately the smallest worker that qualifies. It is not a caching
// strategy and it is not trying to be clever: two rules, and everything else is left
// alone.

const SHELL = "rd-shell-v1";
// Stamped by tools/stamp_assets.py, so a new build is a new url and a cached one can
// never be the wrong one. The icons and the heart never change at all.
const KEEPABLE = /\.(css|js|svg|png|jpe?g|webmanifest)$/i;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((cache) => cache.add("./"))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(names.filter((n) => n !== SHELL).map((n) => caches.delete(n)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  // Bandcamp's streams, telegram's pictures, the counter - none of this worker's
  // business. The streams in particular are fetched ahead by the player itself and live
  // in the browser's own cache; putting a second cache in front of them would only get
  // in the way.
  if (url.origin !== location.origin) return;
  // The catalogue carries links that die in 24 hours. It must never come from a cache.
  if (url.pathname.startsWith("/data/")) return;

  if (request.mode === "navigate") {
    // The page itself: always from the network when there is one, so a new build is
    // picked up immediately. The copy is only ever for the case where there is not.
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(SHELL).then((cache) => cache.put("./", copy));
          return response;
        })
        .catch(() => caches.match("./").then((hit) => hit || Response.error()))
    );
    return;
  }

  if (!KEEPABLE.test(url.pathname)) return;

  event.respondWith(
    caches.match(request).then(
      (hit) =>
        hit ||
        fetch(request).then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(SHELL).then((cache) => cache.put(request, copy));
          }
          return response;
        })
    )
  );
});
