// KaChat service worker. Two jobs:
//   1. Keep the app shell openable from the home screen when the network is slow or gone: the
//      built assets are content-hashed (immutable), so they are cached on first sight and served
//      from cache after that; the page itself and everything else same-origin go network-first
//      with the cache as the fallback. Nothing that talks to Nextcloud (/nc-proxy) or to a
//      third-party host is ever cached - those are live API calls.
//   2. Show notifications. A home-screen web app on iOS 16.4+ gets the Notification
//      permission, but `new Notification()` throws there (and on Android Chrome); the only way
//      to show one is through this worker (see notificationclick below and showAppNotification
//      in ui/app.js).
//   3. Web Push (closed-app notifications, ui/web-push.js): every push becomes a notification
//      (public/sw-push.js decides the wording), the app icon's badge follows, and a changed
//      subscription is renewed.
// Bumped per release that changes the shell: the old name is deleted on activate, which is
// what clears the previous release's hashed assets out of the cache.
const CACHE = "kachat-shell-v2";

// The push payload -> notification mapping (a classic script defining self.KaChatPushMap). Kept
// apart so tools/test-web-push.mjs can run it; a missing file must not stop the worker.
try { importScripts("sw-push.js"); } catch { /* the push handler falls back to the server's own wording */ }

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name)));
    // No clients.claim(): taking over a page mid-load left its early requests (the module
    // preloads the built page issues) outside the worker and the later ones inside, which
    // Chrome reports as "preload ... not used because it is a cross-world service worker
    // resource mismatch" and then fetches twice. Control begins with the next navigation.
  })());
});

// The app's base path (the published site lives under /desktop/), read from where this worker
// was registered rather than assumed to be the root.
function appBase() {
  try { return new URL(self.registration.scope).pathname; } catch { return "/"; }
}

function isCacheable(request, url) {
  if (request.method !== "GET") return false;
  if (url.origin !== self.location.origin) return false;
  if (url.pathname.startsWith(`${appBase()}nc-proxy/`) || url.pathname.includes("/nc-proxy/")) return false;
  if (url.pathname === `${appBase()}sw.js`) return false;
  return true;
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  let url;
  try { url = new URL(request.url); } catch { return; }
  if (!isCacheable(request, url)) return; // the network handles it, untouched

  const hashedAsset = url.pathname.startsWith(`${appBase()}assets/`);
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
        const shell = await cache.match(appBase(), { ignoreSearch: true });
        if (shell) return shell;
      }
      throw error;
    }
  })());
});

// ---- The small store the app and this worker share (ui/web-push.js writes it) ------------------
// "mirror": names and flags for wording pushes (never keys, never message text); "badge": the app
// icon's count; "focus": the chat / group / room on screen; "pendingClick": a tap that had to open
// the app, picked up once the app has booted; "webPush": the VAPID key a renewal subscribes with.
const PUSH_DB = "kachat-push";
const PUSH_STORE = "kv";
function pushDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(PUSH_DB, 1);
    request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains(PUSH_STORE)) request.result.createObjectStore(PUSH_STORE); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function kvGet(key) {
  const db = await pushDb();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction(PUSH_STORE, "readonly").objectStore(PUSH_STORE).get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally { db.close(); }
}
async function kvSet(key, value) {
  const db = await pushDb();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(PUSH_STORE, "readwrite");
      tx.objectStore(PUSH_STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally { db.close(); }
}
function iconUrl() { return `${appBase()}icons/icon-192.png`; }
async function windowClients() {
  try { return await self.clients.matchAll({ type: "window", includeUncontrolled: true }); } catch { return []; }
}

// A push. It ALWAYS ends in a showNotification: Safari revokes a subscription whose pushes show
// nothing, and Chrome shows its own "updated in the background" line instead. What iOS would not
// show at all (your own message, a blocked sender, the chat you are reading) is shown silently
// under a throwaway tag and closed at once.
self.addEventListener("push", (event) => {
  event.waitUntil(handlePush(event));
});

async function handlePush(event) {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; }
  catch { try { payload = { body: event.data ? event.data.text() : "" }; } catch { payload = {}; } }
  let mirror = {};
  try { mirror = (await kvGet("mirror")) || {}; } catch { mirror = {}; }
  // Notifications switched off in the app since this subscription was made: shown and closed (the
  // app unregisters on the next start; this covers the pushes already on their way).
  const switchedOff = mirror.enabled === false;
  let mapped;
  try {
    mapped = self.KaChatPushMap.notificationFromPush(payload, mirror, { icon: iconUrl() });
  } catch {
    mapped = { title: String(payload.title || "KaChat"), options: { body: String(payload.body || "New notification"), tag: "kachat-push", icon: iconUrl(), data: { route: { kind: "tab", tab: "chats" }, key: "", push: true } }, badge: null, suppress: false };
  }
  let suppress = Boolean(mapped.suppress) || switchedOff;
  const clients = await windowClients();
  // Open pages fetch straight away rather than at their next poll.
  for (const client of clients) {
    try { client.postMessage({ type: "kachat:push", data: { type: String(payload.type || ""), txId: String(payload.tx_id || "") } }); } catch { /* best-effort */ }
  }
  // The stream you are looking at, in a focused window, does not ring (iOS willPresent).
  if (!suppress && clients.some((client) => client.focused && client.visibilityState === "visible")) {
    try {
      const focus = await kvGet("focus");
      const key = self.KaChatPushMap?.routeKey(mapped.options?.data?.route);
      if (key && focus && focus.key === key && Date.now() - Number(focus.at || 0) < 12 * 3600 * 1000) suppress = true;
    } catch { /* ring */ }
  }
  if (suppress) {
    const tag = `kachat-quiet-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await self.registration.showNotification(mapped.title || "KaChat", { body: "", tag, silent: true, icon: iconUrl(), data: { quiet: true } });
    try { for (const note of await self.registration.getNotifications({ tag })) note.close(); } catch { /* it goes with the next one */ }
    return;
  }
  const options = { icon: iconUrl(), ...mapped.options };
  // The same message is already on screen, shown by the open app with its real text: keep that one.
  try {
    const key = options.data?.key;
    const existing = key ? (await self.registration.getNotifications({ tag: options.tag })).find((note) => note.data?.key === key) : null;
    if (existing) {
      await self.registration.showNotification(existing.title, { body: existing.body, tag: existing.tag, icon: existing.icon || iconUrl(), silent: true, data: existing.data });
      return;
    }
  } catch { /* show ours */ }
  if (mapped.badge != null) {
    try {
      let count = typeof mapped.badge === "number" ? mapped.badge : (Number(await kvGet("badge")) || 0) + 1;
      count = Math.max(0, Math.min(count, 99999));
      await kvSet("badge", count);
      if (self.navigator?.setAppBadge) await self.navigator.setAppBadge(count);
    } catch { /* the badge is a nicety */ }
  }
  if (!options.tag) delete options.renotify;
  await self.registration.showNotification(mapped.title || "KaChat", options);
}

// The subscription was renewed or revoked by the browser. Subscribe again with the same server key
// and leave a note: the app re-registers the new endpoint (signed with the wallet key, which this
// worker never has) and removes the old one the next time it runs, or right now if it is open.
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil((async () => {
    let subscription = event.newSubscription || null;
    try {
      if (!subscription) {
        const config = await kvGet("webPush");
        if (config?.vapidKey) {
          const raw = atob(String(config.vapidKey).replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(String(config.vapidKey).length / 4) * 4, "="));
          const key = Uint8Array.from(raw, (ch) => ch.charCodeAt(0));
          subscription = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
        }
      }
    } catch { /* the app subscribes on its next start */ }
    try {
      await kvSet("subscriptionChanged", { oldEndpoint: event.oldSubscription?.endpoint || null, endpoint: subscription?.endpoint || null, at: Date.now() });
    } catch { /* the app notices the endpoint differs anyway */ }
    for (const client of await windowClients()) {
      try { client.postMessage({ type: "kachat:push-subscription-changed" }); } catch { /* best-effort */ }
    }
  })());
});

// A tap on a worker-shown notification: focus the app (or open it) and tell it what was tapped,
// so it can open the chat / tab the notification was about (ui/app.js listens for this). An app
// that had to be opened cannot hear a message yet, so the tap also waits in the store until the
// app has booted and asks for it.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  if (data.quiet) return;
  event.waitUntil((async () => {
    const all = await windowClients();
    let client = all.find((c) => c.visibilityState === "visible" && "focus" in c) || all.find((c) => "focus" in c) || null;
    if (client) {
      try { client = (await client.focus()) || client; } catch { /* focus can be refused */ }
      try { client.postMessage({ type: "kachat:notification-click", data }); } catch { /* best-effort */ }
      return;
    }
    try { await kvSet("pendingClick", { data, at: Date.now() }); } catch { /* opens on its own screen */ }
    if (self.clients.openWindow) {
      try { await self.clients.openWindow(appBase()); } catch { /* nothing to open */ }
    }
  })());
});
