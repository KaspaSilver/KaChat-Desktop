// Web Push: notifications while KaChat is closed (an installed iPhone app on iOS 16.4+, Android
// Chrome, desktop browsers). The browser half; the signed auth, the body and the address helpers
// are in ui/web-push-core.js, what a push looks like on screen in public/sw-push.js, and what the
// push service has to add in docs/WEB_PUSH_SERVER.md.
//
// End to end:
//   1. Notifications on (Settings > Notifications > Push Notifications) and allowed by the browser.
//   2. GET {pushIndexer}/v1/push/web-config -> the service's VAPID public key. A 404 means the
//      service has no Web Push yet: nothing else happens and Settings says so.
//   3. pushManager.subscribe({ userVisibleOnly: true, applicationServerKey }) in the app's worker.
//   4. POST /v1/push/register, platform "web", device_token = the subscription endpoint, the same
//      lists iOS registers (chats, groups, public rooms, KaPosts) plus `web_push` {endpoint, p256dh,
//      auth}, signed with the wallet key exactly as iOS signs, plus a device-key proof (a P-256 key
//      this browser keeps, non-extractable, in IndexedDB) so the registration can later be removed
//      or moved to another account without the old account's key.
//   5. Registered again whenever what it sends changes (a chat added or silenced, a group muted, a
//      room's bell, KaPosts switches, another account), when the subscription changes, and once a
//      day; removed when notifications are switched off, on sign out and when the account is
//      removed from this device.
//   6. Meanwhile the app keeps a small mirror in IndexedDB for the worker: names for addresses,
//      which chats ring without sound, blocked senders, group names by blinded id, the badge count
//      and what is on screen. Names and flags only - never a key, never message text.
import {
  PUSH_PATHS, PUSH_DEVICE_AUTH_SCHEME, buildPushAuth, buildDeviceAuthPreimage, buildRegistrationFields,
  registrationFingerprint, vapidKeyBytes, sameBytes, toBase64, toBase64Url, bytesToHex, utf8, clampAuthTimestamp,
  nextDeviceCounter, normalizeWebDeviceToken,
} from "./web-push-core.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { shouldRegisterServiceWorker } from "./origin-migration.js";

const REG_KEY_PREFIX = "kachat-web-push-registration-v1";
const CONFIG_CACHE_KEY = "kachat-web-push-config-v1";
const CONFIG_TTL_MS = 6 * 3600 * 1000;
const UNAVAILABLE_TTL_MS = 30 * 60 * 1000;
const REFRESH_MS = 24 * 3600 * 1000;
const TICK_MS = 60 * 1000;

let deps = null;
let status = { state: "starting", detail: "" };
let syncTimer = 0;
let syncRunning = false;
let syncAgain = false;
let forceNext = false;
let retryDelayMs = 0;
let lastFocusKey = null;
let lastBadge = null;
let lastMirrorJson = "";

// ---- the store shared with public/sw.js ------------------------------------------------------
const PUSH_DB = "kachat-push";
const PUSH_STORE = "kv";
function pushDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") { reject(new Error("No IndexedDB")); return; }
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
      if (value === undefined) tx.objectStore(PUSH_STORE).delete(key);
      else tx.objectStore(PUSH_STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally { db.close(); }
}

// ---- environment -----------------------------------------------------------------------------
function appBase() {
  try { return import.meta.env.BASE_URL || "/"; } catch { return "/"; }
}
export function isIosDevice() {
  const ua = navigator.userAgent || "";
  return /iPhone|iPad|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}
export function isStandalone() {
  try {
    return document.documentElement.classList.contains("standalone")
      || window.matchMedia?.("(display-mode: standalone)")?.matches
      || window.navigator.standalone === true;
  } catch { return false; }
}
/** An iPhone/iPad browser tab: no notifications at all until KaChat is on the Home Screen. */
export function needsHomeScreenInstall() {
  return isIosDevice() && !isStandalone();
}
function pushSupported() {
  return typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && typeof Notification !== "undefined";
}
function regKey() { return `${REG_KEY_PREFIX}:${deps?.network?.() || "mainnet"}`; }
function loadRegistration() {
  try { return JSON.parse(localStorage.getItem(regKey()) || "null"); } catch { return null; }
}
function saveRegistration(value) {
  try {
    if (value) localStorage.setItem(regKey(), JSON.stringify(value));
    else localStorage.removeItem(regKey());
  } catch { /* the next start registers again, harmlessly */ }
}
function log(text) { try { deps?.log?.(`Web Push: ${text}`); } catch { /* no log */ } }
function setStatus(state, detail = "") {
  if (status.state === state && status.detail === detail) return;
  status = { state, detail };
  try { deps?.onStatus?.(status); } catch { /* the line redraws next time */ }
}
export function webPushStatus() { return status; }

/** The Settings line ("Notifications when KaChat is closed: ..."). */
export function webPushStatusText(value = status) {
  const prefix = "Notifications when KaChat is closed:";
  switch (value.state) {
    case "on": return `${prefix} on.`;
    case "needs-install": return `${prefix} add KaChat to your Home Screen first (Share > Add to Home Screen), then open it from there and allow notifications.`;
    case "unsupported": return `${prefix} not supported by this browser.`;
    case "off": return `${prefix} off.`;
    case "ask": return `${prefix} allow notifications to turn them on.`;
    case "denied": return `${prefix} blocked in your browser's settings for this site.`;
    case "unavailable": return `${prefix} not available on this server yet. KaChat notifies you while it is open.`;
    case "signed-out": return `${prefix} open your account to turn them on.`;
    case "error": return `${prefix} couldn't turn on${value.detail ? ` (${value.detail})` : ""}. Trying again.`;
    default: return `${prefix} connecting...`;
  }
}

// ---- the server's Web Push config ------------------------------------------------------------
function cleanBase(base) { return String(base || "").trim().replace(/\/+$/, ""); }
async function fetchWebConfig(base, { force = false } = {}) {
  let cache = null;
  try { cache = JSON.parse(localStorage.getItem(CONFIG_CACHE_KEY) || "null"); } catch { cache = null; }
  const now = Date.now();
  if (!force && cache && cache.base === base) {
    if (cache.vapidKey && now - cache.at < CONFIG_TTL_MS) return { vapidKey: cache.vapidKey };
    if (cache.unavailable && now - cache.at < UNAVAILABLE_TTL_MS) return { unavailable: true };
  }
  const response = await fetch(`${base}${PUSH_PATHS.webConfig}`, { cache: "no-store", headers: { Accept: "application/json" } });
  // 404 / 405: this push service has no Web Push yet (docs/WEB_PUSH_SERVER.md).
  if (response.status === 404 || response.status === 405 || response.status === 501) {
    try { localStorage.setItem(CONFIG_CACHE_KEY, JSON.stringify({ base, unavailable: true, at: now })); } catch { /* asked again */ }
    return { unavailable: true };
  }
  if (!response.ok) throw new Error(`web-config HTTP ${response.status}`);
  let json = null;
  try { json = await response.json(); } catch { json = null; }
  const vapidKey = String(json?.vapid_public_key || "").trim();
  if (!vapidKey) {
    try { localStorage.setItem(CONFIG_CACHE_KEY, JSON.stringify({ base, unavailable: true, at: now })); } catch { /* asked again */ }
    return { unavailable: true };
  }
  vapidKeyBytes(vapidKey); // throws on a malformed key
  try { localStorage.setItem(CONFIG_CACHE_KEY, JSON.stringify({ base, vapidKey, at: now })); } catch { /* fetched again */ }
  return { vapidKey };
}

// ---- the device key (P-256, never leaves this browser) ----------------------------------------
async function deviceKey() {
  let stored = null;
  try { stored = await kvGet("deviceKey"); } catch { stored = null; }
  if (stored?.privateKey && stored?.publicRaw) return stored;
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const publicRaw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const value = { privateKey: pair.privateKey, publicRaw, keyId: bytesToHex(sha256(publicRaw)) };
  await kvSet("deviceKey", value);
  return value;
}
async function deviceProof({ challenge, method, path, deviceToken, timestampMs }) {
  const key = await deviceKey();
  let last = 0;
  try { last = Number(await kvGet("deviceCounter")) || 0; } catch { last = 0; }
  const counter = nextDeviceCounter(last);
  await kvSet("deviceCounter", counter);
  const preimage = buildDeviceAuthPreimage({
    nonce: challenge.nonce, method, path, deviceToken, keyId: key.keyId, counter, timestampMs, expiresAtMs: challenge.expires_at_ms,
  });
  // WebCrypto signs IEEE P1363 (r||s, 64 bytes); the service accepts it next to DER.
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key.privateKey, utf8(preimage)));
  return { scheme: PUSH_DEVICE_AUTH_SCHEME, key_id: key.keyId, pubkey: toBase64(key.publicRaw), counter, signature: toBase64(signature) };
}

// ---- requests ----------------------------------------------------------------------------------
async function fetchChallenge(base) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(`${base}${PUSH_PATHS.challenge}`, { method: "POST", headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error(`challenge HTTP ${response.status}`);
      const json = await response.json();
      if (!json?.nonce || !Number.isFinite(Number(json.expires_at_ms))) throw new Error("bad challenge");
      return { nonce: String(json.nonce), issued_at_ms: Number(json.issued_at_ms) || Date.now(), expires_at_ms: Number(json.expires_at_ms) };
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 600 * (attempt + 1)));
    }
  }
  throw lastError || new Error("challenge failed");
}
async function readError(response) {
  try {
    const text = await response.text();
    try { return String(JSON.parse(text)?.error || text).slice(0, 160); } catch { return text.slice(0, 160); }
  } catch { return ""; }
}

/** Remove a registration. With the wallet key it is signed as iOS signs an unregister (empty lists,
 *  no group line); without it, the device key alone proves this browser made it. */
async function unregisterEndpoint({ base, endpoint, wallet = null }) {
  const deviceToken = normalizeWebDeviceToken(endpoint);
  const challenge = await fetchChallenge(base);
  let auth;
  if (wallet?.privateKeyHex && wallet?.address) {
    auth = buildPushAuth({
      privateKeyHex: wallet.privateKeyHex, walletAddress: wallet.address, challenge, method: "DELETE", path: PUSH_PATHS.unregister,
      deviceToken, watchedAddresses: [], watchedGroupIds: [], primaryAddress: "", aliases: [], withGroupIds: false,
    }).auth;
  } else {
    // No wallet signature: the service skips the wallet binding and checks the device key.
    const timestampMs = clampAuthTimestamp(Date.now(), challenge.issued_at_ms, challenge.expires_at_ms);
    auth = { wallet_pubkey: "", wallet_address: "", nonce: challenge.nonce, timestamp_ms: timestampMs, expires_at_ms: challenge.expires_at_ms, signature: "" };
  }
  auth.device_auth = await deviceProof({ challenge, method: "DELETE", path: PUSH_PATHS.unregister, deviceToken, timestampMs: auth.timestamp_ms });
  const response = await fetch(`${base}${PUSH_PATHS.unregister}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ device_token: deviceToken, auth }),
  });
  if (!response.ok && response.status !== 404) throw new Error(`unregister HTTP ${response.status}: ${await readError(response)}`);
}

async function registerFields({ base, fields, wallet }) {
  const challenge = await fetchChallenge(base);
  const { auth } = buildPushAuth({
    privateKeyHex: wallet.privateKeyHex, walletAddress: wallet.address, challenge, method: "POST", path: PUSH_PATHS.register,
    deviceToken: fields.device_token, watchedAddresses: fields.watched_addresses, watchedGroupIds: fields.watched_group_ids,
    primaryAddress: fields.primary_address || "", aliases: fields.aliases, withGroupIds: true,
  });
  auth.device_auth = await deviceProof({ challenge, method: "POST", path: PUSH_PATHS.register, deviceToken: fields.device_token, timestampMs: auth.timestamp_ms });
  const response = await fetch(`${base}${PUSH_PATHS.register}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ ...fields, auth }),
  });
  return { status: response.status, reason: response.ok ? "" : await readError(response) };
}

// ---- the worker registration and its subscription -------------------------------------------
async function workerRegistration() {
  const scope = new URL(appBase(), window.location.href).href;
  let registration = null;
  try { registration = await navigator.serviceWorker.getRegistration(scope); } catch { registration = null; }
  if (!registration) {
    try { registration = await navigator.serviceWorker.getRegistration(); } catch { registration = null; }
  }
  if (!registration && shouldRegisterServiceWorker()) {
    // Not registered yet: ui/pwa.js registers on the page's load event, which this can run ahead
    // of - or that registration failed and nothing would ever try again. Start it here, and say
    // why when the browser refuses.
    try {
      registration = await navigator.serviceWorker.register(`${appBase()}sw.js`, { scope: appBase() });
    } catch (error) {
      throw new Error(`the app's service worker couldn't start (${error?.message || error})`);
    }
  }
  if (registration && !registration.active) {
    // Installing right now (first visit): wait a little for it to activate.
    registration = await Promise.race([navigator.serviceWorker.ready, new Promise((resolve) => setTimeout(() => resolve(registration), 8000))]);
  }
  return registration;
}
async function currentSubscription(registration, vapidKey) {
  const key = vapidKeyBytes(vapidKey);
  let subscription = await registration.pushManager.getSubscription();
  if (subscription && !sameBytes(subscription.options?.applicationServerKey, key)) {
    // The service changed its key: a subscription made for the old one can never be delivered to.
    try { await subscription.unsubscribe(); } catch { /* replaced below anyway */ }
    subscription = null;
  }
  if (!subscription) subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  try { await kvSet("webPush", { vapidKey }); } catch { /* a renewal in the worker then waits for the app */ }
  return subscription;
}
function subscriptionKeys(subscription) {
  const json = subscription.toJSON?.() || {};
  let p256dh = json.keys?.p256dh || "";
  let auth = json.keys?.auth || "";
  if (!p256dh && subscription.getKey) { const raw = subscription.getKey("p256dh"); if (raw) p256dh = toBase64Url(new Uint8Array(raw)); }
  if (!auth && subscription.getKey) { const raw = subscription.getKey("auth"); if (raw) auth = toBase64Url(new Uint8Array(raw)); }
  return { endpoint: subscription.endpoint, p256dh, auth };
}

// ---- the sync ------------------------------------------------------------------------------------
async function writeMirror(enabled) {
  let mirror = { enabled };
  try { mirror = { ...(deps?.mirror?.() || {}), enabled }; } catch { /* names wait for the next round */ }
  const json = JSON.stringify(mirror);
  if (json === lastMirrorJson) return;
  try { await kvSet("mirror", { ...mirror, updatedAt: Date.now() }); lastMirrorJson = json; } catch { /* next round */ }
}

async function syncOnce(force) {
  if (!pushSupported()) { setStatus(needsHomeScreenInstall() ? "needs-install" : "unsupported"); return; }
  const enabled = Boolean(deps.enabled());
  await writeMirror(enabled);
  const stored = loadRegistration();
  const permission = Notification.permission;
  if (!enabled || permission === "denied") {
    if (stored?.endpoint) {
      await removeStored(stored, deps.wallet?.());
      await dropSubscription();
    }
    setStatus(enabled ? "denied" : "off");
    return;
  }
  if (permission !== "granted") { setStatus(needsHomeScreenInstall() ? "needs-install" : "ask"); return; }
  const wallet = deps.wallet();
  if (!wallet?.privateKeyHex || !wallet?.address) { setStatus(stored?.endpoint ? "on" : "signed-out"); return; }
  const base = cleanBase(deps.endpoint());
  if (!base) { setStatus("unavailable"); return; }
  const config = await fetchWebConfig(base, { force });
  if (config.unavailable) { setStatus("unavailable"); return; }
  const registration = await workerRegistration();
  if (!registration?.pushManager) throw new Error("the app's service worker is not running");
  const subscription = await currentSubscription(registration, config.vapidKey);
  const keys = subscriptionKeys(subscription);
  if (!keys.p256dh || !keys.auth) throw new Error("the browser gave no encryption keys");

  // A registration this browser made on another server or for an old endpoint goes first.
  if (stored?.endpoint && (stored.endpoint !== keys.endpoint || stored.base !== base)) {
    await removeStored(stored, stored.wallet === wallet.address ? wallet : null);
  }
  const collected = await deps.collect();
  const fields = buildRegistrationFields({ ...collected, endpoint: keys.endpoint, p256dh: keys.p256dh, authSecret: keys.auth, primaryAddress: wallet.address });
  // The service refuses a registration with nothing to watch; your own address is always worth
  // watching (handshakes and payments to you are keyed on it - iOS has it through your own chat).
  if (!fields.watched_addresses.length && !fields.watched_group_ids.length) fields.watched_addresses = [wallet.address.toLowerCase()];
  const fingerprint = registrationFingerprint(fields, wallet.address);
  const current = loadRegistration();
  if (!force && current?.endpoint === keys.endpoint && current.base === base && current.wallet === wallet.address
    && current.fingerprint === fingerprint && Date.now() - Number(current.at || 0) < REFRESH_MS) {
    setStatus("on");
    return;
  }
  setStatus("working");
  // Another account had this browser: move the registration (the device key may remove it).
  if (current?.endpoint === keys.endpoint && current.wallet && current.wallet !== wallet.address) {
    try { await unregisterEndpoint({ base, endpoint: keys.endpoint }); } catch (error) { log(`could not release the previous account's registration: ${error.message}`); }
  }
  let result = await registerFields({ base, fields, wallet });
  if (result.status === 401 && /bound to another wallet/i.test(result.reason)) {
    // iOS attemptWalletBindingRecoveryUnregister: release it with the device key, then once more.
    try { await unregisterEndpoint({ base, endpoint: keys.endpoint }); } catch (error) { log(`recovery unregister failed: ${error.message}`); }
    result = await registerFields({ base, fields, wallet });
  }
  if (result.status === 404 || result.status === 405) {
    // A service with web-config but an old register route: treat as not there yet.
    setStatus("unavailable");
    return;
  }
  if (result.status !== 200) throw new Error(`register HTTP ${result.status}${result.reason ? `: ${result.reason}` : ""}`);
  saveRegistration({ endpoint: keys.endpoint, base, wallet: wallet.address, fingerprint, at: Date.now() });
  try { await kvSet("subscriptionChanged", undefined); } catch { /* fine */ }
  log(`registered (${fields.watched_addresses.length} chats, ${fields.watched_group_ids.length} group streams, ${fields.watched_broadcast_channels.length} rooms)`);
  setStatus("on");
}

/** Remove a stored registration. A failure is kept and tried again on later rounds (five at most:
 *  a server that is gone for good cannot hold the app hostage). */
async function removeStored(stored, wallet) {
  try {
    await unregisterEndpoint({ base: stored.base, endpoint: stored.endpoint, wallet: wallet && wallet.address === stored.wallet ? wallet : null });
    log("unregistered");
    saveRegistration(null);
    return true;
  } catch (error) {
    const failures = Number(stored.removeFailures || 0) + 1;
    log(`unregister failed (${failures}): ${error.message}`);
    saveRegistration(failures >= 5 ? null : { ...stored, removeFailures: failures });
    return false;
  }
}
/** Drop the browser's own subscription too: its endpoint then answers 410 and the service forgets
 *  the registration by itself even if the unregister above never reached it. */
async function dropSubscription() {
  try {
    const registration = await workerRegistration();
    const subscription = await registration?.pushManager?.getSubscription();
    if (subscription) await subscription.unsubscribe();
  } catch { /* nothing subscribed */ }
}

async function runSync() {
  if (!deps) return;
  if (syncRunning) { syncAgain = true; return; }
  syncRunning = true;
  const force = forceNext;
  forceNext = false;
  try {
    await syncOnce(force);
    retryDelayMs = 0;
  } catch (error) {
    if (error?.notReady) {
      // The app is still starting (keys, chats): not a failure, just early.
      setStatus("starting");
      scheduleWebPushSync({ delayMs: 15_000 });
      return;
    }
    const message = String(error?.message || error || "unknown error");
    log(message);
    setStatus("error", message.length > 80 ? `${message.slice(0, 80)}...` : message);
    retryDelayMs = Math.min(retryDelayMs ? retryDelayMs * 3 : 60_000, 30 * 60_000);
    scheduleWebPushSync({ delayMs: retryDelayMs });
  } finally {
    syncRunning = false;
    if (syncAgain) { syncAgain = false; scheduleWebPushSync({ delayMs: 1500 }); }
  }
}

/** Ask for a sync: debounced, so a burst of changes is one registration. */
export function scheduleWebPushSync({ force = false, delayMs = 2500 } = {}) {
  if (!deps) return;
  if (force) forceNext = true;
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => { syncTimer = 0; runSync(); }, Math.max(0, delayMs));
}

/** Sign out / switch off: remove this browser's registration now (signed with the wallet key while
 *  it is still here, else with the device key). */
export async function webPushSignOut(wallet = null) {
  if (!deps) return;
  const stored = loadRegistration();
  if (stored?.endpoint) await removeStored(stored, wallet);
  await dropSubscription();
  try { await kvSet("mirror", { enabled: false, updatedAt: Date.now() }); lastMirrorJson = ""; } catch { /* fine */ }
  await setAppIconBadge(0);
  setStatus("signed-out");
}
/** An account removed from this device: its registration goes if it was this browser's. */
export async function webPushForgetAccount(address) {
  const stored = loadRegistration();
  if (stored?.wallet && stored.wallet === String(address || "").trim()) await webPushSignOut(null);
}

// ---- badge, focus, taps -------------------------------------------------------------------------
/** The app icon's badge (iOS 16.4+ home-screen apps, Chrome): the total unread count. */
export async function setAppIconBadge(count) {
  const value = Math.max(0, Math.floor(Number(count) || 0));
  if (value === lastBadge) return;
  lastBadge = value;
  try {
    if (value > 0) await navigator.setAppBadge?.(value);
    else await navigator.clearAppBadge?.();
  } catch { /* not supported here */ }
  try { await kvSet("badge", value); } catch { /* the worker counts from its own number */ }
}
async function writeFocus() {
  let key = "";
  try { key = document.visibilityState === "visible" ? String(deps?.focusKey?.() || "") : ""; } catch { key = ""; }
  if (key === lastFocusKey) return;
  lastFocusKey = key;
  try { await kvSet("focus", { key, at: Date.now() }); } catch { /* the worker rings, which is the safe side */ }
}
/** A tap that had to open the app: handed over once, if it is fresh. */
export async function takePendingNotificationClick() {
  let pending = null;
  try { pending = await kvGet("pendingClick"); } catch { return null; }
  if (!pending) return null;
  try { await kvSet("pendingClick", undefined); } catch { /* read once anyway */ }
  return Date.now() - Number(pending.at || 0) < 5 * 60_000 ? (pending.data || null) : null;
}

export function initWebPush(dependencies) {
  deps = dependencies;
  if (typeof window === "undefined") return;
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("message", (event) => {
      const type = event.data?.type;
      if (type === "kachat:push-subscription-changed") scheduleWebPushSync({ force: true, delayMs: 500 });
      else if (type === "kachat:push") { try { deps.onPush?.(event.data.data || {}); } catch { /* next poll */ } }
    });
  }
  document.addEventListener("visibilitychange", () => {
    writeFocus();
    if (document.visibilityState === "visible") scheduleWebPushSync({ delayMs: 1500 });
  });
  window.addEventListener("focus", () => writeFocus());
  setInterval(() => { if (document.visibilityState === "visible") writeFocus(); }, 1500);
  setInterval(() => scheduleWebPushSync({ delayMs: 0 }), TICK_MS);
  scheduleWebPushSync({ delayMs: 4000 });
  setStatus(pushSupported() ? "starting" : (needsHomeScreenInstall() ? "needs-install" : "unsupported"));
}
