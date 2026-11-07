// node tools/test-portfolio-address-import.mjs - Add Chatting Address / Add Kaspa Address (ui/portfolio.js
// runAddressImport, iOS PortfolioAddressImporter) while the address's history is still being
// fetched: an account switch meanwhile leaves the account switched to without the address's rows,
// and a second import of the same address started meanwhile adds no second copy of a transaction.
// Runs the real ui/portfolio.js (through Vite) against a stub DOM and a fake Kaspa REST API.
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
// Every element's click listeners are kept, so the modals' own handler can be driven.
const clickHandlers = [];
const element = () => {
  const el = stubElement();
  el.addEventListener = (type, handler) => { if (type === "click") clickHandlers.push(handler); };
  return el;
};
globalThis.document = stubElement();
globalThis.document.querySelector = () => element();
globalThis.document.querySelectorAll = () => [];
globalThis.document.createElement = () => element();
globalThis.document.body = stubElement();
globalThis.document.visibilityState = "visible";
globalThis.document.addEventListener = () => {};
globalThis.window = globalThis;
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};

const CHATTING = "kaspa:qqt9pdktna9dzf8u2rz6jnqvpcda8nxpreaxnspq0m5hnumsmvqnu6nxxclec";
const OTHER = "kaspa:qzk2jrk7wq3zdw2n0260v87fglky82cg5u3pwy73wpktk3u864yecm5djll40";
const blockTime = Date.now() - 3 * 86_400_000;
const history = [
  { transaction_id: "a".repeat(64), block_time: blockTime, is_accepted: true, inputs: [{ previous_outpoint_address: OTHER, previous_outpoint_amount: "600000000" }], outputs: [{ script_public_key_address: CHATTING, amount: "500000000" }, { script_public_key_address: OTHER, amount: "99990000" }] },
  { transaction_id: "b".repeat(64), block_time: blockTime + 60_000, is_accepted: true, inputs: [{ previous_outpoint_address: OTHER, previous_outpoint_amount: "300000000" }], outputs: [{ script_public_key_address: CHATTING, amount: "200000000" }, { script_public_key_address: OTHER, amount: "99990000" }] },
];
// Each history fetch waits for the test to answer it.
const pendingFetches = [];
globalThis.fetch = async (url) => {
  if (String(url).includes("/full-transactions")) {
    const offset = Number(new URL(String(url)).searchParams.get("offset") || 0);
    if (offset > 0) return new Response("[]", { status: 200 });
    await new Promise((resolve) => pendingFetches.push(resolve));
    return new Response(JSON.stringify(history), { status: 200 });
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
const keyOf = (who, base) => `${PREFIX}:${who}:${base}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const rowsOf = (who) => (JSON.parse(local.getItem(keyOf(who, "kachat-portfolios-v1")) || "null")?.portfolios || [])
  .flatMap((p) => p.transactions || []);
const feesOf = (who) => JSON.parse(local.getItem(keyOf(who, "kachat-portfolio-fees-v1")) || "[]");
const toasts = [];

portfolio.initPortfolio({
  accountScopedKey: (base) => scoped(base),
  escapeHtml: (s) => String(s ?? ""), showToast: (text) => toasts.push(text), currencyCode: () => "usd",
  addressCardHtml: () => "", engine: { address: CHATTING }, appendEngineLog() {},
});
/** The Portfolio sheet's "Add Chatting Address" row. */
const addChattingAddress = () => {
  const row = { dataset: { portfolioAction: "chatting" } };
  const target = { closest: (sel) => (sel === "[data-portfolio-action]" ? row : null) };
  for (const handler of clickHandlers) handler({ target, preventDefault() {}, stopPropagation() {} });
};
const waitFor = async (check) => { for (let i = 0; i < 200 && !check(); i += 1) await sleep(10); };

let failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`ok - ${name}`); }
  catch (error) { failed += 1; console.error(`FAIL - ${name}\n${error?.stack || error}`); }
}

await test("an account switch while the history is fetched imports nothing into the account switched to", async () => {
  addChattingAddress();
  await waitFor(() => pendingFetches.length === 1);
  assert.equal(pendingFetches.length, 1, "the import fetches the address's history");
  wallet = "kaspa:qzaccountb";
  portfolio.resetPortfolioForAccount();
  pendingFetches.shift()();
  await sleep(100);
  assert.equal(rowsOf("kaspa:qzaccountb").length, 0, "account B got none of the address's rows");
  assert.equal(feesOf("kaspa:qzaccountb").length, 0, "account B got none of its fees");
  assert.equal(rowsOf("kaspa:qzaccounta").length, 0, "account A's ledger is untouched (the import stopped)");
});

await test("two imports of one address overlapping add each transaction once", async () => {
  toasts.length = 0;
  wallet = "kaspa:qzaccountc"; // a ledger that holds none of the address's rows yet
  portfolio.resetPortfolioForAccount();
  addChattingAddress();
  await waitFor(() => pendingFetches.length === 1);
  // The sheet opened again while the first import is still fetching: a second import starts.
  addChattingAddress();
  await waitFor(() => pendingFetches.length === 2);
  assert.equal(pendingFetches.length, 2, "both imports are fetching");
  pendingFetches.shift()();
  await sleep(100);
  assert.equal(rowsOf(wallet).length, 2, "the first import saved the address's two transactions");
  pendingFetches.shift()();
  await sleep(100);
  const rows = rowsOf(wallet);
  assert.equal(rows.length, 2, `no transaction is in the ledger twice (got ${rows.length} rows)`);
  assert.equal(new Set(rows.map((t) => t.sourceTxId)).size, 2);
});

await vite.close();
console.log(failed ? `${failed} address import check(s) failed` : "all address import checks passed");
process.exit(failed ? 1 : 0);
