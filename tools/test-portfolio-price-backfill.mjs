// node tools/test-portfolio-price-backfill.mjs - the background price backfill (ui/portfolio.js,
// iOS PortfolioViewModel.startPriceBackfillIfNeeded) across an account switch: the previous
// account's loop, asleep between passes, must not keep the next account's rows "price pending".
// Runs the real ui/portfolio.js (through Vite) against a stub DOM and a fake CoinGecko.
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

// --- The browser, as far as ui/portfolio.js looks at it ------------------------------------------
// Every element is the same forgiving stub: any property reads as a callable stub, writes are kept.
function stubElement() {
  const own = new Map();
  const fn = function () { return stubElement(); };
  return new Proxy(fn, {
    get(_, key) {
      if (own.has(key)) return own.get(key);
      if (key === Symbol.toPrimitive) return () => "";
      if (key === Symbol.iterator) return function* () {};
      if (key === "then") return undefined;
      if (key === "length") return 0;
      if (key === "querySelectorAll" || key === "getElementsByClassName") return () => [];
      if (key === "querySelector") return () => stubElement();
      if (key === "closest") return () => null;
      if (key === "hidden") return true;
      if (key === "value" || key === "textContent" || key === "innerHTML") return "";
      if (key === "dataset" || key === "style") { const value = {}; own.set(key, value); return value; }
      return stubElement();
    },
    set(_, key, value) { own.set(key, value); return true; },
    apply() { return stubElement(); },
  });
}
const local = new MemoryStorage();
globalThis.localStorage = local;
globalThis.sessionStorage = new MemoryStorage();
globalThis.document = stubElement();
globalThis.document.querySelector = () => stubElement();
globalThis.document.querySelectorAll = () => [];
globalThis.document.createElement = () => stubElement();
globalThis.document.body = stubElement();
globalThis.document.visibilityState = "visible";
globalThis.window = globalThis;
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};

// CoinGecko: account A's day has no price anywhere; account B's day is in the range answer.
const DAY = 86_400_000;
const now = Date.now();
const dayA = Math.floor((now - 400 * DAY) / DAY) * DAY + 3_600_000; // older than the keyless window
const dayB = Math.floor((now - 3 * DAY) / DAY) * DAY + 3_600_000;
const requests = [];
let rangeAnswers = false;
globalThis.fetch = async (url) => {
  requests.push(String(url));
  if (String(url).includes("/market_chart") && rangeAnswers) {
    return new Response(JSON.stringify({ prices: [[dayB, 0.25]] }), { status: 200 });
  }
  return new Response("{}", { status: 404 });
};

const vite = await createServer({
  configFile: false, root: process.cwd(), logLevel: "silent", appType: "custom",
  server: { middlewareMode: true, hmr: false, ws: false, watch: null },
  optimizeDeps: { noDiscovery: true, include: [] },
});
const portfolio = await vite.ssrLoadModule("/ui/portfolio.js");

const PREFIX = "kachat-account-data-v1";
let wallet = "kaspa:qzaccounta";
const scoped = (base) => `${PREFIX}:${wallet}:${base}`;
const PENDING = "Price loading, will fill in automatically";
const pendingState = (id, timestamp) => JSON.stringify({
  activeId: "11111111-1111-4111-8111-11111111111" + id,
  portfolios: [{
    id: "11111111-1111-4111-8111-11111111111" + id, name: "Main", createdAt: 1, updatedAt: 1,
    transactions: [{ id: "22222222-2222-4222-8222-22222222222" + id, type: "buy", amountKas: 100, fiatValue: 0, timestamp, notes: PENDING, updatedAt: 1 }],
  }],
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`ok - ${name}`); }
  catch (error) { failed += 1; console.error(`FAIL - ${name}\n${error?.stack || error}`); }
}

await test("an account switch while the previous account's loop sleeps starts the new account's backfill", async () => {
  local.setItem(scoped("kachat-portfolios-v1"), pendingState("A", dayA));
  portfolio.initPortfolio({
    accountScopedKey: (base) => scoped(base),
    escapeHtml: (s) => String(s ?? ""), showToast() {}, currencyCode: () => "usd",
    addressCardHtml: () => "", engine: null, appendEngineLog() {},
  });
  portfolio.resetPortfolioForAccount(); // starts A's loop
  await sleep(3500); // A's first pass: the range call and the paced per-day lookups fail, then it sleeps 30 s
  assert.ok(requests.some((url) => url.includes("/history")), "A's first pass ran");
  wallet = "kaspa:qzaccountb";
  local.setItem(scoped("kachat-portfolios-v1"), pendingState("B", dayB));
  rangeAnswers = true;
  requests.length = 0;
  portfolio.resetPortfolioForAccount();
  await sleep(500);
  assert.ok(requests.some((url) => url.includes("/market_chart")), "B's loop didn't wait out A's sleep");
  const row = JSON.parse(local.getItem(scoped("kachat-portfolios-v1"))).portfolios[0].transactions[0];
  assert.equal(row.notes, null, "B's row is priced");
  assert.equal(row.fiatValue, 25);
});

await vite.close();
console.log(failed ? `${failed} price backfill check(s) failed` : "all price backfill checks passed");
process.exit(failed ? 1 : 0);
