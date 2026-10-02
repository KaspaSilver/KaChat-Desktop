// Background worker. The wallet itself runs in the popup and the full-tab view (they have the
// DOM, localStorage and a steady WebSocket); this worker does two small jobs: auto-lock, and
// the website-connect broker.
//
// Auto-lock: every interaction in the popup sends "activity", which re-arms a one-shot alarm
// for the user's auto-lock delay. When the alarm fires, the unlock key in storage.session is
// cleared, and the next time the popup opens it asks for the password. storage.session is also
// empty after a browser restart, so a restart always locks.
//
// Website connect: pages call window.kachat (public/inpage.js), the content script
// (public/content.js) forwards each call here, and this worker - which learns the calling site
// from the browser (sender), never from the page - answers the harmless ones and sends the rest
// to an approval window (approve.js). The approval window does the signing and hands the answer
// back. Nothing is approved without the user seeing the site's origin.

import { ext } from "./browser.js";

const ALARM = "kachat.autolock";
const SETTINGS_KEY = "kachat.settings";
const DEFAULT_AUTOLOCK_MINUTES = 15;

async function autoLockMinutes() {
  const settings = (await ext.storage.local.get(SETTINGS_KEY))?.[SETTINGS_KEY] || {};
  const minutes = Number(settings.autoLockMinutes);
  return Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_AUTOLOCK_MINUTES;
}

async function armAutoLock() {
  await ext.alarms.create(ALARM, { delayInMinutes: await autoLockMinutes() });
}

async function lockNow() {
  await ext.alarms.clear(ALARM);
  await ext.storage.session.clear();
}

const UNLOCK_KEY = "kachat.unlockKey";
const NETWORK_MIRROR_KEY = "kachat.network"; // net.js mirrors the pages' choice here (no localStorage in a worker)

async function onTestnet() {
  return (await ext.storage.local.get(NETWORK_MIRROR_KEY))?.[NETWORK_MIRROR_KEY] === "testnet";
}
/** Connections are kept per network, like the pages' net.js netKey. */
async function connectionsKey() {
  return (await onTestnet()) ? "kachat.connections.testnet" : "kachat.connections";
}
const MAX_MESSAGE_LENGTH = 4096;

const rejected = () => ({ error: { code: 4001, message: "The request was rejected in KaChat Wallet." } });
const unauthorized = () => ({ error: { code: 4100, message: "Connect first: call kachat.requestAccounts()." } });
const invalid = (message) => ({ error: { code: -32602, message } });

/** Approvals waiting on the user: id -> { id, origin, kind, params, resolve, windowId }. */
const approvals = new Map();

async function connections() {
  return (await ext.storage.local.get(await connectionsKey()))?.[await connectionsKey()] || {};
}

async function isUnlocked() {
  return Boolean((await ext.storage.session.get(UNLOCK_KEY))?.[UNLOCK_KEY]);
}

/** The calling site, from the browser's own record of the sender: top frame, http(s) only. */
function siteOrigin(sender) {
  if (sender?.id !== ext.runtime.id || !sender.tab) return null;
  if (sender.frameId != null && sender.frameId !== 0) return null;
  try {
    const url = new URL(sender.origin || sender.url);
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : null;
  } catch {
    return null;
  }
}

// The popup, the tab view and the approval window (which, being a window, has a tab too). A
// content script's sender URL is the website's, so it never passes.
function fromExtensionPage(sender) {
  return sender?.id === ext.runtime.id && String(sender.url || "").startsWith(ext.runtime.getURL(""));
}

async function restApi() {
  const settings = (await ext.storage.local.get(SETTINGS_KEY))?.[SETTINGS_KEY] || {};
  const testnet = await onTestnet();
  const configured = testnet ? settings.restApiTestnet : settings.restApi;
  return String(configured || (testnet ? "https://api-tn10.kaspa.org" : "https://api.kaspa.org")).replace(/\/+$/, "");
}

async function balanceOf(address) {
  const response = await fetch(`${await restApi()}/addresses/${encodeURIComponent(address)}/balance`, { headers: { Accept: "application/json" } });
  if (!response.ok) return { error: { code: 4900, message: `Balance unavailable (HTTP ${response.status}).` } };
  const json = await response.json();
  const total = Number(json?.balance ?? 0);
  return { result: { confirmed: total, unconfirmed: 0, total } };
}

async function openApproval(origin, kind, params) {
  for (const entry of approvals.values()) {
    if (entry.origin === origin) return { error: { code: -32002, message: "A request from this site is already waiting in KaChat Wallet." } };
  }
  const id = crypto.randomUUID();
  const entry = { id, origin, kind, params, createdAt: Date.now(), windowId: null };
  const answer = new Promise((resolve) => { entry.resolve = resolve; });
  approvals.set(id, entry);
  try {
    const win = await ext.windows.create({
      url: ext.runtime.getURL(`popup.html?view=approve&id=${encodeURIComponent(id)}`),
      type: "popup", width: 380, height: 640, focused: true,
    });
    entry.windowId = win?.id ?? null;
  } catch {
    approvals.delete(id);
    return { error: { code: 4900, message: "Couldn't open KaChat Wallet." } };
  }
  const result = await answer;
  approvals.delete(id);
  if (entry.windowId != null) ext.windows.remove(entry.windowId).catch(() => {});
  return result;
}

async function handleSiteRequest(method, params, origin) {
  const connection = (await connections())[origin] || null;
  const open = connection && (await isUnlocked());
  switch (method) {
    case "getNetwork":
      return { result: (await onTestnet()) ? "testnet-10" : "mainnet" };
    case "getAccounts":
      return { result: open ? [connection.address] : [] };
    case "requestAccounts":
      if (open) return { result: [connection.address] };
      return openApproval(origin, "connect", []);
    case "getPublicKey":
      return open ? { result: connection.publicKey } : unauthorized();
    case "getBalance":
      return open ? balanceOf(connection.address) : unauthorized();
    case "disconnect": {
      if (connection) {
        const all = await connections();
        delete all[origin];
        await ext.storage.local.set({ [await connectionsKey()]: all });
      }
      return { result: true };
    }
    case "sendKaspa": {
      if (!connection) return unauthorized();
      const [to, sompi, options] = params;
      const prefix = (await onTestnet()) ? "kaspatest:" : "kaspa:";
      if (typeof to !== "string" || !to.trim().toLowerCase().startsWith(prefix) || !/^[a-z]+:[a-z0-9]{50,90}$/.test(to.trim().toLowerCase())) return invalid(`sendKaspa: a ${prefix} address is required.`);
      if (!/^\d{1,19}$/.test(String(sompi)) || BigInt(sompi) <= 0n) return invalid("sendKaspa: the amount is a whole number of sompi above zero.");
      const priorityFee = String(options?.priorityFee ?? "0");
      if (!/^\d{1,15}$/.test(priorityFee)) return invalid("sendKaspa: priorityFee is a whole number of sompi.");
      return openApproval(origin, "sendKaspa", [to.trim().toLowerCase(), String(sompi), priorityFee]);
    }
    case "signMessage": {
      if (!connection) return unauthorized();
      const [message] = params;
      if (typeof message !== "string" || !message.length) return invalid("signMessage: the message is required.");
      if (message.length > MAX_MESSAGE_LENGTH) return invalid(`signMessage: messages are limited to ${MAX_MESSAGE_LENGTH} characters.`);
      return openApproval(origin, "signMessage", [message]);
    }
    default:
      return { error: { code: 4200, message: `KaChat Wallet does not support ${String(method).slice(0, 40)}.` } };
  }
}

ext.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message?.type) {
    case "activity": armAutoLock(); return false;
    case "lock": lockNow(); return false;
    case "dapp-request": {
      const origin = siteOrigin(sender);
      if (!origin) { sendResponse({ error: { code: 4100, message: "Requests are only accepted from the page itself." } }); return false; }
      handleSiteRequest(String(message.method || ""), Array.isArray(message.params) ? message.params : [], origin)
        .then(sendResponse, () => sendResponse({ error: { code: 4900, message: "KaChat Wallet hit an error." } }));
      return true;
    }
    case "approval-get": {
      if (!fromExtensionPage(sender)) return false;
      const entry = approvals.get(message.id);
      sendResponse(entry ? { id: entry.id, origin: entry.origin, kind: entry.kind, params: entry.params } : null);
      return false;
    }
    case "approval-result": {
      if (!fromExtensionPage(sender)) return false;
      const entry = approvals.get(message.id);
      if (entry) entry.resolve(message.error ? rejected() : { result: message.result });
      return false;
    }
    case "approval-ping":
      // The approval window keeps this worker awake while the user decides.
      return false;
    default:
      return false;
  }
});

// Closing the approval window is a rejection.
ext.windows?.onRemoved?.addListener((windowId) => {
  for (const entry of approvals.values()) if (entry.windowId === windowId) entry.resolve(rejected());
});

ext.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) lockNow();
});

// A browser restart already empties storage.session; this also clears a leftover alarm.
ext.runtime.onStartup?.addListener(() => { lockNow(); });
