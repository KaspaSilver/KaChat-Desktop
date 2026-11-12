// node tools/test-nextcloud-direct.mjs - Nextcloud on a site KaChat hosts (desktop.kachat.app,
// owner 2026-11-12): KaChat talks to the person's Nextcloud directly, never through the site's
// relay, so the app password never passes through a server KaChat runs. Runs the real
// ui/nextcloud.js (through Vite, for import.meta.env) with the page's hostname set to the live site
// and a fake fetch that records every request.
import assert from "node:assert/strict";
import { createServer } from "vite";

class MemoryStorage {
  constructor() { this.map = new Map(); }
  getItem(key) { return this.map.has(key) ? this.map.get(key) : null; }
  setItem(key, value) { this.map.set(key, String(value)); }
  removeItem(key) { this.map.delete(key); }
  get length() { return this.map.size; }
  key(index) { return [...this.map.keys()][index] ?? null; }
}

const PREFIX = "kachat-account-data-v1";
const WALLET = "kaspa:qzwalletaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SERVER = "https://cloud.example.test";
const local = new MemoryStorage();

function stubElement(extra = {}) {
  return {
    hidden: false, disabled: false, innerHTML: "", textContent: "", value: "", dataset: {}, style: {},
    isConnected: true, childElementCount: 0, classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {}, removeEventListener() {}, setAttribute() {}, removeAttribute() {}, appendChild() {},
    querySelector: () => stubElement(), querySelectorAll: () => [], closest: () => null, focus() {}, ...extra,
  };
}
const settingsEl = stubElement({ querySelector: () => null });
globalThis.window = globalThis;
globalThis.addEventListener = () => {};
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
globalThis.localStorage = local;
Object.defineProperty(globalThis, "location", { value: { hostname: "desktop.kachat.app", search: "", hash: "", href: "https://desktop.kachat.app/" }, configurable: true });
globalThis.document = {
  visibilityState: "visible",
  body: stubElement(),
  createElement: () => stubElement(),
  querySelector: (selector) => (selector === "[data-nextcloud-settings]" ? settingsEl : null),
  querySelectorAll: () => [],
  addEventListener() {},
};

// Every request, as the page made it. The fake Nextcloud answers like one that allows this site.
const requests = [];
globalThis.fetch = async (url, init = {}) => {
  const headers = new Headers(init.headers || {});
  requests.push({ url: String(url), method: String(init.method || "GET").toUpperCase(), mode: init.mode, credentials: init.credentials, relayHeader: headers.get("x-kachat-nextcloud-origin"), auth: headers.get("authorization") });
  const method = String(init.method || "GET").toUpperCase();
  if (method === "MKCOL") return new Response(null, { status: 201 });
  if (method === "PUT") return new Response(null, { status: 201, headers: { "OC-ETag": '"e1"' } });
  return new Response(null, { status: 200 });
};

const vite = await createServer({
  configFile: false, root: process.cwd(), logLevel: "silent", appType: "custom",
  server: { middlewareMode: true, hmr: false, ws: false, watch: null },
  optimizeDeps: { noDiscovery: true, include: [] },
});
const nextcloud = await vite.ssrLoadModule("/ui/nextcloud.js");
const { initNextcloud, resetNextcloudForAccount, isNextcloudConnected, uploadNextcloudMedia, revokeAppPassword, nextcloudDirectOnly, nextcloudUnavailableReason, storedNextcloudLoginsFor } = nextcloud;

const scopedKey = (base, w = WALLET) => `${PREFIX}:${w}:${base}`;
function storeAccount(fields = {}) {
  local.setItem(scopedKey("kachat-nextcloud-v1"), JSON.stringify({
    server: SERVER, username: "sam", userId: "sam", appPassword: "app-pass",
    startFolder: null, backupFolder: null, autoBackup: false, lastAutoBackup: 0, ...fields,
  }));
}
let started = false;
function start() {
  if (started) { resetNextcloudForAccount(); return; }
  started = true;
  initNextcloud({
    accountScopedKey: (base, address = WALLET) => scopedKey(base, address),
    escapeHtml: (s) => String(s), appendEngineLog() {}, showToast() {},
    sealBackupPayload: async (json) => json, openBackupPayload: async (raw) => raw,
    backupKeyAvailable: () => true,
    portfolioBackupSync: () => null, importPortfolioSync: () => false,
  });
}

let failures = 0;
async function test(name, fn) {
  try { await fn(); console.log(`ok - ${name}`); }
  catch (error) { failures += 1; console.log(`FAIL - ${name}\n`, error); }
}

await test("the live site is on, direct only", () => {
  assert.equal(nextcloudUnavailableReason(), null);
  assert.equal(nextcloudDirectOnly(), true);
});

await test("a direct login works there, and every request goes straight to the server with no cookies", async () => {
  local.map.clear();
  storeAccount({ direct: true });
  start();
  assert.equal(isNextcloudConnected(), true);
  requests.length = 0;
  await uploadNextcloudMedia(new Blob(["hello"], { type: "image/jpeg" }), "photo.jpg", "image/jpeg").catch(() => {});
  assert.ok(requests.length > 0, "it made requests");
  for (const request of requests) {
    assert.ok(request.url.startsWith(`${SERVER}/`), `straight to the server: ${request.url}`);
    assert.ok(!request.url.includes("nc-proxy"), `never the relay: ${request.url}`);
    assert.equal(request.relayHeader, null, "no relay header");
    assert.equal(request.credentials, "omit", "no cookies");
    assert.equal(request.mode, "cors");
  }
});

await test("a login saved there back when it went through the relay is never used", async () => {
  local.map.clear();
  storeAccount();
  start();
  assert.equal(isNextcloudConnected(), false);
});

await test("revoking an app password there goes straight to the server too, even an old relay login", async () => {
  requests.length = 0;
  await revokeAppPassword({ server: SERVER, username: "sam", appPassword: "app-pass" });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, `${SERVER}/ocs/v2.php/core/apppassword`);
  assert.equal(requests[0].method, "DELETE");
  local.map.clear();
  storeAccount();
  assert.deepEqual(storedNextcloudLoginsFor(WALLET), [{ server: SERVER, username: "sam", appPassword: "app-pass", direct: false }]);
});

await vite.close();
if (failures) { console.log(`${failures} failed`); process.exit(1); }
console.log("nextcloud direct: all passed");
