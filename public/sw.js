// KaChat service worker. Two jobs:
//   1. Keep the app shell openable from the home screen when the network is slow or gone: the
//      built assets are content-hashed (immutable), so they are cached on first sight and served
//      from cache after that; the page itself and everything else same-origin go network-first
//      with the cache as the fallback. Nothing that talks to Nextcloud (/nc-proxy) or to a
//      third-party host is ever cached - those are live API calls.
//   2. Show notifications on iOS. A home-screen web app on iOS 16.4+ gets the Notification
//      permission, but `new Notification()` throws there; the only way to show one is through
//      this worker (see notificationclick below and showAppNotification in ui/app.js).
const CACHE = "kachat-shell-v1";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

function isCacheable(request, url) {
  if (request.method !== "GET") return false;
  if (url.origin !== self.location.origin) return false;
  if (url.pathname.startsWith("/nc-proxy/")) return false;
  if (url.pathname === "/sw.js") return false;
  return true;
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  let url;
  try { url = new URL(request.url); } catch { return; }
  if (!isCacheable(request, url)) return; // the network handles it, untouched

  const hashedAsset = url.pathname.startsWith("/assets/");
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    if (hashedAsset) {
      // Immutable by construction: the file name changes when the content does.
      const cached = await cache.match(request);
      if (cached) return cached;
      const response = await fetch(request);
      if (response.ok) cache.put(request, response.clone());
      return response;
    }
    try {
      const response = await fetch(request);
      if (response.ok && (request.mode === "navigate" || response.type === "basic")) {
        cache.put(request, response.clone());
      }
      return response;
    } catch (error) {
      const cached = await cache.match(request, { ignoreSearch: request.mode === "navigate" });
      if (cached) return cached;
      if (request.mode === "navigate") {
        const shell = await cache.match("/", { ignoreSearch: true });
        if (shell) return shell;
      }
      throw error;
    }
  })());
});

// A tap on a worker-shown notification: focus the app (or open it) and tell it what was tapped,
// so it can open the chat / tab the notification was about (ui/app.js listens for this).
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    let client = all.find((c) => "focus" in c) || null;
    if (client) {
      try { client = (await client.focus()) || client; } catch { /* focus can be refused */ }
    } else if (self.clients.openWindow) {
      client = await self.clients.openWindow("/");
    }
    if (client) {
      try { client.postMessage({ type: "kachat:notification-click", data }); } catch { /* best-effort */ }
    }
  })());
});
