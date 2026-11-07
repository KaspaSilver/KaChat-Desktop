// node tools/test-web-push-logout.mjs - Web Push after Log Out (ui/web-push.js): while this browser
// is logged out (kachat-session-logged-out-v1, set by Log Out in any tab) a sync round registers
// nothing, even in a tab whose wallet is still in memory, and a registration made meanwhile is
// removed again. The browser parts (service worker, Notification, localStorage, fetch) are stubs;
// nothing leaves the machine.
import assert from "node:assert/strict";

class MemoryStorage {
  constructor() { this.map = new Map(); }
  getItem(key) { return this.map.has(key) ? this.map.get(key) : null; }
  setItem(key, value) { this.map.set(key, String(value)); }
  removeItem(key) { this.map.delete(key); }
}
const storage = new MemoryStorage();
const calls = [];
const noop = () => {};
const define = (name, value) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
define("localStorage", storage);
define("window", globalThis);
define("PushManager", function PushManager() {});
define("Notification", { permission: "granted" });
define("navigator", { userAgent: "node", platform: "node", maxTouchPoints: 0, serviceWorker: { addEventListener: noop, getRegistration: async () => null, register: async () => null, ready: new Promise(noop) } });
define("document", { visibilityState: "hidden", addEventListener: noop });
define("matchMedia", () => ({ matches: false }));
globalThis.addEventListener = noop;
define("fetch", async (url, init = {}) => {
  calls.push({ url: String(url), method: init.method || "GET" });
  return new Response("{}", { status: 404, headers: { "content-type": "application/json" } });
});

const { initWebPush, scheduleWebPushSync, webPushStatus, isSessionLoggedOut, SESSION_LOGGED_OUT_KEY } = await import("../ui/web-push.js");

const BASE = "https://push.example";
const WALLET = { privateKeyHex: "11".repeat(32), address: "kaspa:qqwallet" };
const REG_KEY = "kachat-web-push-registration-v1:mainnet";
initWebPush({
  network: () => "mainnet",
  endpoint: () => BASE,
  enabled: () => true,
  wallet: () => WALLET, // a tab still holding its keys when another tab logged out
  collect: async () => ({ watchedAddresses: [WALLET.address], watchedGroupIds: [], aliases: [] }),
  mirror: () => ({}),
  focusKey: () => "",
  log: noop,
  onStatus: noop,
});
/** One sync round, waited for until `done()` (or briefly when there is nothing to wait for). The
 *  challenge is retried with back-off (about 4 s against the 404 stub). */
const round = async (done = null) => {
  calls.length = 0;
  scheduleWebPushSync({ force: true, delayMs: 0 });
  const until = Date.now() + (done ? 6000 : 60);
  while (Date.now() < until && !(done && done())) await new Promise((resolve) => setTimeout(resolve, 30));
};

let passed = 0;
async function test(name, fn) { await fn(); passed += 1; console.log(`ok - ${name}`); }

await test("the flag is read from storage", () => {
  assert.equal(SESSION_LOGGED_OUT_KEY, "kachat-session-logged-out-v1");
  assert.equal(isSessionLoggedOut({ getItem: () => "true" }), true);
  assert.equal(isSessionLoggedOut({ getItem: () => null }), false);
  assert.equal(isSessionLoggedOut({ getItem: () => { throw new Error("blocked"); } }), false);
});

await test("logged out: a round with a wallet in memory registers nothing and asks no server", async () => {
  storage.setItem(SESSION_LOGGED_OUT_KEY, "true");
  await round();
  assert.deepEqual(calls, []);
  assert.equal(webPushStatus().state, "signed-out");
});

await test("logged out: a registration made meanwhile is removed, never renewed", async () => {
  storage.setItem(REG_KEY, JSON.stringify({ endpoint: "https://web.push.apple.com/x", base: BASE, wallet: WALLET.address, fingerprint: "f", at: Date.now() }));
  await round(() => JSON.parse(storage.getItem(REG_KEY) || "null")?.removeFailures === 1 || storage.getItem(REG_KEY) === null);
  assert.ok(calls.some((c) => c.url === `${BASE}/v1/push/challenge`), "the unregister was started");
  assert.ok(!calls.some((c) => c.url.endsWith("/v1/push/register") || c.url.endsWith("/v1/push/web-config")), JSON.stringify(calls));
  // The stub service answers 404, so the removal is kept to be tried again (removeStored's rule).
  const stored = JSON.parse(storage.getItem(REG_KEY) || "null");
  assert.ok(stored === null || stored.removeFailures === 1, JSON.stringify(stored));
  assert.equal(webPushStatus().state, "signed-out");
  storage.removeItem(REG_KEY);
});

await test("signed in again: the round goes on to the service (the gate was the flag)", async () => {
  storage.removeItem(SESSION_LOGGED_OUT_KEY);
  await round();
  assert.ok(calls.some((c) => c.url === `${BASE}/v1/push/web-config`), JSON.stringify(calls));
});

console.log(`\n${passed} web-push logout tests passed`);
process.exit(0);
