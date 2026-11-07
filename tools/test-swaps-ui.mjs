// ChangeNOW Swap screen guards, run on the real ui/swaps.js with the page, the portfolio, the dialogs
// and ChangeNOW stubbed: a swap whose fresh payout address or exchange comes back after an account
// switch is neither created for nor filed under the account switched to (it stays with the account
// it was started from), and the deposit card keeps naming the coin the deposit address takes after
// the pair is flipped. Run from the repo root:
//
//   node tools/test-swaps-ui.mjs

import { registerHooks } from "node:module";

const r = {
  pass: 0, fail: 0, failures: [],
  check(ok, label) { if (ok) this.pass++; else { this.fail++; this.failures.push(label); } },
};

// --- The page ---------------------------------------------------------------------------------------
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
};
globalThis.window = {
  setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 5)),
  clearTimeout: (id) => clearTimeout(id),
  open: () => {},
};
const handlers = {};
const root = {
  innerHTML: "",
  contains: () => false,
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener: (type, fn) => { handlers[type] = fn; },
};
globalThis.document = {
  activeElement: null,
  querySelector: (sel) => (sel === "[data-swaps-root]" ? root : null),
  addEventListener: () => {},
};

// ChangeNOW through the relay: the probe says "on"; estimates answer at once; an exchange waits
// for the test to let it through.
const calls = [];
let createGate = null;
window.fetch = async (url, init = {}) => {
  const text = String(url);
  calls.push({ url: text, method: init.method || "GET", body: init.body || null });
  const reply = (body) => ({ ok: true, status: 200, headers: { get: () => "" }, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) });
  if (text.includes("__swap")) return reply("on");
  if (text.includes("estimated-amount")) return reply({ fromAmount: 100, toAmount: 1000 });
  if (/\/v2\/exchange(\?|%3F|$)/.test(text) || (init.method === "POST")) {
    const body = await new Promise((resolve) => { createGate = resolve; });
    return reply(body);
  }
  return reply({});
};

// --- Stubs for the modules ui/swaps.js imports --------------------------------------------------------
const dataModule = (source) => `data:text/javascript,${encodeURIComponent(source)}`;
const STUBS = {
  "./portfolio.js": dataModule(`export const listPortfolios = () => []; export const addTransactionToPortfolio = () => {}; export const portfolioIdsContainingTx = () => new Set();`),
  "./dialogs.js": dataModule(`export const confirmDialog = async () => true;`),
  "../engine/endpoints.js": dataModule(`export const proxiedUrl = (url) => "/nc-proxy/" + encodeURIComponent(url);`),
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (/\/ui\/swaps\.js$/.test(context.parentURL || "")) {
      if (STUBS[specifier]) return { url: STUBS[specifier], shortCircuit: true };
      if (/\.(css|png)$/.test(specifier)) return { url: dataModule(`export default "asset";`), shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

// --- The app around it --------------------------------------------------------------------------------
let account = "kaspa:qalice";
const addressesOf = { "kaspa:qalice": ["kaspa:qalice-0", "kaspa:qalice-1"], "kaspa:qbob": ["kaspa:qbob-0", "kaspa:qbob-1"] };
let revealGate = null;
const deps = {
  engine: { drawQrFor: async () => {} },
  escapeHtml: (v) => String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])),
  accountScopedKey: (key) => `kachat-account-data-v1:${account}:${key}`,
  nextFreshSpendingIndex: () => 1,
  spendingAddressAt: (index) => addressesOf[account][index],
  revealNextSwapAddress: () => new Promise((resolve) => { revealGate = resolve; }),
  showToast: () => {},
  currencySymbol: () => "$",
};
const HISTORY = (who) => `kachat-account-data-v1:${who}:kachat-swap-history-v1`;
const AGREED = (who) => `kachat-account-data-v1:${who}:kachat-swap-disclaimer-agreed-v1`;
store.set(AGREED("kaspa:qalice"), "1");
store.set(AGREED("kaspa:qbob"), "1");

const swaps = await import("../ui/swaps.js");
swaps.initSwaps(deps);
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));
await settle();

const el = (attrs) => ({ closest: (sel) => { const m = /^\[([^\]=]+)\]$/.exec(sel); return m && m[1] in attrs ? { ...attrs[m[1]], dataset: attrs[m[1]].dataset || {} } : null; } });
const type = async (value) => {
  handlers.input({ target: el({ "data-swap-field": { value, dataset: { swapField: "send" } } }) });
  await settle();
};
const click = async (attr) => { handlers.click({ target: el({ [attr]: {} }) }); await settle(); };
const switchTo = (who) => { account = who; swaps.resetSwapsForAccount(); };
const posts = () => calls.filter((c) => c.method === "POST");
const historyOf = (who) => JSON.parse(store.get(HISTORY(who)) || "[]");

// 1. The account switches while the fresh payout address is being revealed: no exchange is opened.
await type("100");
await click("data-swap-create");
r.check(typeof revealGate === "function", "the swap asks for a fresh payout address");
switchTo("kaspa:qbob");
revealGate(1);
await settle();
r.check(posts().length === 0, "no exchange is created after the account switched during the address reveal");
r.check(historyOf("kaspa:qbob").length === 0 && historyOf("kaspa:qalice").length === 0, "nothing is filed for either account");

// 2. The account switches while ChangeNOW opens the exchange: filed under the account it was for.
await type("100");
await click("data-swap-create");
revealGate(1);
await settle();
r.check(posts().length === 1, "the exchange is requested");
const payout = JSON.parse(posts()[0].body || "{}").address;
r.check(payout === "kaspa:qbob-1", `it pays out to the account that started it (got ${payout})`);
switchTo("kaspa:qalice");
createGate({ id: "ex-bob", payinAddress: "0xDEPOSITBOB", toAmount: 1000, status: "new" });
await settle();
r.check(historyOf("kaspa:qalice").length === 0, "the swap is not filed under the account switched to");
const bobHistory = historyOf("kaspa:qbob");
r.check(bobHistory.length === 1 && bobHistory[0].id === "ex-bob" && bobHistory[0].payoutAddress === "kaspa:qbob-1", "the swap is filed under the account it was created for");
r.check(!root.innerHTML.includes("0xDEPOSITBOB"), "the switched-to account's screen does not show the other account's deposit address");

// 3. Flipping the pair after the deposit address came back keeps the coin it takes.
await type("100");
await click("data-swap-create");
revealGate(1);
await settle();
createGate({ id: "ex-alice", payinAddress: "0xDEPOSITALICE", toAmount: 1000, status: "new" });
await settle();
r.check(root.innerHTML.includes("Send USDC Coin (Polygon) to this address"), "the deposit card names the coin to send");
r.check(historyOf("kaspa:qalice").length === 1, "the swap is filed for the open account");
await click("data-swap-flip");
r.check(root.innerHTML.includes("0xDEPOSITALICE"), "the deposit card is still shown after the flip");
r.check(root.innerHTML.includes("Send USDC Coin (Polygon) to this address") && !root.innerHTML.includes("Send Kaspa to this address"),
  "after a flip the deposit card still names the coin the address takes, not the newly selected side");
r.check(!root.innerHTML.includes("data-swap-open-spending"), "no Go to Spending Addresses link on a deposit that isn't KAS");

if (r.fail) {
  console.error(`test-swaps-ui: ${r.fail} failed, ${r.pass} passed`);
  for (const f of r.failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`test-swaps-ui: ${r.pass} passed`);
process.exit(0);
