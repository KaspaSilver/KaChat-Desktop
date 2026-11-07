// Wallet-screen races in ui/app.js, run from their own source with the page around them stubbed:
// a failed KNS profile write is retried on the domain (and account) it was for, never on whatever
// the editor has open by then; setting a primary domain doesn't pop its detail back up after you
// left it, or touch another account; and an address's history never lands under the address
// opened after it.
//
//   node tools/test-wallet-screen-races.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const app = readFileSync(join(here, "..", "ui", "app.js"), "utf8");

// --- source extraction (as tools/test-ui-shell-guards.mjs) -------------------------------------
function skipLiteral(src, i) {
  const c = src[i];
  if (c === "/" && src[i + 1] === "/") { const end = src.indexOf("\n", i); return end < 0 ? src.length : end; }
  if (c === "/" && src[i + 1] === "*") return src.indexOf("*/", i + 2) + 2;
  if (c === '"' || c === "'") {
    for (let j = i + 1; j < src.length; j += 1) { if (src[j] === "\\") { j += 1; continue; } if (src[j] === c) return j + 1; }
  }
  if (c === "`") {
    for (let j = i + 1; j < src.length; j += 1) {
      if (src[j] === "\\") { j += 1; continue; }
      if (src[j] === "`") return j + 1;
      if (src[j] === "$" && src[j + 1] === "{") j = matchClose(src, j + 1, "{", "}") - 1;
    }
  }
  return i;
}
function matchClose(src, open, a, b) {
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    const next = skipLiteral(src, i);
    if (next !== i) { i = next - 1; continue; }
    if (src[i] === a) depth += 1;
    else if (src[i] === b) { depth -= 1; if (depth === 0) return i + 1; }
  }
  throw new Error("unbalanced source");
}
function extractFunction(src, name) {
  const match = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(src);
  assert.ok(match, `function ${name} in the source`);
  const paramsEnd = matchClose(src, match.index + match[0].length - 1, "(", ")");
  const bodyStart = src.indexOf("{", paramsEnd);
  return src.slice(match.index, matchClose(src, bodyStart, "{", "}"));
}
function sandbox(sources, overrides = {}) {
  const calls = [];
  const scope = new Proxy(overrides, {
    has: (target, key) => typeof key === "string" && (key in target || !(key in globalThis)),
    get: (target, key) => {
      if (key === Symbol.unscopables) return undefined;
      if (key in target) return target[key];
      const fn = (...args) => { calls.push([key, ...args]); return undefined; };
      target[key] = fn;
      return fn;
    },
    set: (target, key, value) => { target[key] = value; return true; },
  });
  const names = sources.map((src) => /function\s+([A-Za-z0-9_$]+)/.exec(src)?.[1]).filter(Boolean);
  // eslint-disable-next-line no-new-func
  const run = new Function("scope", `with (scope) { ${sources.join("\n")}\n return { ${names.join(", ")} }; }`);
  return { fns: run(scope), calls, scope: overrides, called: (name) => calls.filter((c) => c[0] === name) };
}

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`ok - ${name}`); }
  catch (error) { console.error(`not ok - ${name}`); throw error; }
}
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// --- 1. KNS profile Retry ----------------------------------------------------------------------
function knsWritesPage({ failKeys = [] } = {}) {
  const engine = { address: "kaspa:qaccounta", writes: [] };
  const fail = new Set(failKeys);
  const page = sandbox([extractFunction(app, "runKnsProfileWrites"), extractFunction(app, "retryFailedKnsUpdates")], {
    engine: Object.assign(engine, {
      submitKnsProfileField: async (assetId, key, value) => {
        engine.writes.push([assetId, key, value]);
        if (fail.has(key)) throw new Error(`${key} rejected`);
      },
      clearKnsCache() {},
      confirmKnsProfileUpdate: async () => {},
    }),
    failedKnsUpdates: {},
    failedKnsUpdatesTarget: null,
    KNS_FIELD_LABELS: { bio: "Bio", x: "X" },
    knsEditAssetId: () => page.scope.editingAssetId,
    editingAssetId: "asset-a",
    refreshOwnKnsProfile: async () => {},
  });
  return { ...page, engine, fail };
}

await test("kns retry: a failed write is retried on the domain it was for, not the one the editor has open now", async () => {
  const { fns, scope, engine, fail } = knsWritesPage({ failKeys: ["bio"] });
  await fns.runKnsProfileWrites("asset-a", { bio: "hello from A", x: "a_on_x" });
  assert.deepEqual(scope.failedKnsUpdates, { bio: "hello from A" });
  // The person opens another domain's Customize Profile; the banner's Retry is still up.
  scope.editingAssetId = "asset-b";
  fail.clear();
  engine.writes.length = 0;
  await fns.retryFailedKnsUpdates();
  assert.deepEqual(engine.writes, [["asset-a", "bio", "hello from A"]], "A's bio goes to A, never onto B");
  assert.deepEqual(scope.failedKnsUpdates, {});
});

await test("kns retry: after an account switch nothing is written with the new account's key", async () => {
  const { fns, scope, engine, called } = knsWritesPage({ failKeys: ["bio"] });
  await fns.runKnsProfileWrites("asset-a", { bio: "hello from A" });
  engine.address = "kaspa:qaccountb";
  scope.editingAssetId = "asset-of-b";
  engine.writes.length = 0;
  await fns.retryFailedKnsUpdates();
  assert.deepEqual(engine.writes, [], "no write at all");
  assert.deepEqual(scope.failedKnsUpdates, {}, "the old account's failures are dropped");
  assert.equal(called("hideKnsSaveBanner").length, 1);
});

await test("kns retry: a save on another domain replaces the old domain's failures instead of mixing them", async () => {
  const { fns, scope, engine, fail } = knsWritesPage({ failKeys: ["bio"] });
  await fns.runKnsProfileWrites("asset-a", { bio: "A bio" });
  fail.clear();
  fail.add("x");
  await fns.runKnsProfileWrites("asset-b", { x: "b_on_x" });
  assert.deepEqual(scope.failedKnsUpdates, { x: "b_on_x" });
  fail.clear();
  engine.writes.length = 0;
  await fns.retryFailedKnsUpdates();
  assert.deepEqual(engine.writes, [["asset-b", "x", "b_on_x"]]);
});

// --- 2. Set as Primary -------------------------------------------------------------------------
function primaryPage() {
  const engine = { address: "kaspa:qaccounta" };
  const write = deferred();
  const detailEl = { hidden: false };
  const page = sandbox([extractFunction(app, "setPrimaryDomain")], {
    engine: Object.assign(engine, { setKnsPrimaryDomain: () => write.promise }),
    settingPrimaryAssetId: null,
    setPrimaryError: "",
    ownKnsPrimaryDomain: "old.kas",
    domainDetailTarget: null,
    document: { querySelector: (selector) => (selector === "[data-domain-detail]" ? detailEl : null) },
    refreshOwnKnsProfileUntilResolved: async () => {},
  });
  // renderDomainDetail sets the shown target, as the real one does.
  page.scope.renderDomainDetail = (domain) => { page.scope.rendered.push(domain.inscriptionId); page.scope.domainDetailTarget = domain; detailEl.hidden = false; };
  page.scope.rendered = [];
  return { ...page, engine, write, detailEl };
}
const domainA = { inscriptionId: "asset-a", fullName: "alpha.kas" };
const domainB = { inscriptionId: "asset-b", fullName: "beta.kas" };

await test("set primary: Back to the list while it is written - the detail does not pop back up", async () => {
  const { fns, scope, write, detailEl } = primaryPage();
  const done = fns.setPrimaryDomain(domainA);
  assert.deepEqual(scope.rendered, ["asset-a"]);
  // closeDomainDetail
  scope.domainDetailTarget = null;
  detailEl.hidden = true;
  write.resolve();
  await done;
  assert.deepEqual(scope.rendered, ["asset-a"], "nothing drawn over the list");
  assert.equal(scope.ownKnsPrimaryDomain, "alpha.kas");
  assert.equal(scope.settingPrimaryAssetId, null);
});

await test("set primary: another domain opened meanwhile is the one redrawn (its button comes back)", async () => {
  const { fns, scope, write } = primaryPage();
  const done = fns.setPrimaryDomain(domainA);
  scope.renderDomainDetail(domainB);
  write.reject(new Error("node said no"));
  await done;
  assert.deepEqual(scope.rendered, ["asset-a", "asset-b", "asset-b"]);
  assert.equal(scope.setPrimaryError, "", "A's error is not shown under B");
  assert.equal(scope.settingPrimaryAssetId, null);
});

await test("set primary: an account switch meanwhile leaves the new account's primary alone", async () => {
  const { fns, scope, engine, write } = primaryPage();
  const done = fns.setPrimaryDomain(domainA);
  engine.address = "kaspa:qaccountb";
  write.resolve();
  await done;
  assert.equal(scope.ownKnsPrimaryDomain, "old.kas");
  assert.deepEqual(scope.rendered, ["asset-a"]);
  assert.equal(scope.settingPrimaryAssetId, null);
});

await test("set primary: still on the detail, it redraws with the new primary", async () => {
  const { fns, scope, write } = primaryPage();
  const done = fns.setPrimaryDomain(domainA);
  write.resolve();
  await done;
  assert.deepEqual(scope.rendered, ["asset-a", "asset-a"]);
});

// --- 3. An address's history --------------------------------------------------------------------
function fakeElement() {
  const el = {
    children: [], dataset: {}, listeners: {}, _html: "",
    classList: { add() {}, remove() {}, toggle() {} },
    get innerHTML() { return el._html; },
    set innerHTML(value) { el._html = String(value); el.children = []; },
    append(...nodes) { el.children.push(...nodes); },
    appendChild(node) { el.children.push(node); return node; },
    replaceChildren(...nodes) { el._html = ""; el.children = [...nodes]; },
    addEventListener(type, fn) { (el.listeners[type] ||= []).push(fn); },
    querySelector: () => null,
    setAttribute() {},
  };
  return el;
}
function historyPage() {
  const answers = new Map();
  const page = sandbox([extractFunction(app, "loadManageAddressTransactions")], {
    manageTxLoadTokens: new WeakMap(),
    manageAddressTransactionsList: null,
    getEndpoint: () => "https://api.test",
    transactionBelongsInHistory: () => true,
    document: { createElement: () => fakeElement() },
    fetch: (url) => {
      const address = decodeURIComponent(/addresses\/([^/]+)\//.exec(url)[1]);
      const d = deferred();
      answers.set(address, d);
      return d.promise;
    },
  });
  return { ...page, answers };
}
const okJson = (body) => ({ ok: true, status: 200, json: async () => body });

await test("history: a slow answer for the address left behind never lands under the one opened since", async () => {
  const { fns, answers } = historyPage();
  const list = fakeElement();
  const first = fns.loadManageAddressTransactions("kaspa:qaddress1", list);
  const second = fns.loadManageAddressTransactions("kaspa:qaddress2", list);
  answers.get("kaspa:qaddress2").resolve(okJson([]));
  await second;
  assert.match(list.innerHTML, /No transactions yet/);
  answers.get("kaspa:qaddress1").resolve(okJson([{ transaction_id: "tx-of-address-1", inputs: [], outputs: [] }]));
  await first;
  await tick();
  assert.match(list.innerHTML, /No transactions yet/, "address 2's empty history stays");
  assert.equal(list.children.length, 0, "no row of address 1's");
});

await test("history: a stale failure doesn't replace the newer list with an error", async () => {
  const { fns, answers } = historyPage();
  const list = fakeElement();
  const first = fns.loadManageAddressTransactions("kaspa:qaddress1", list);
  const second = fns.loadManageAddressTransactions("kaspa:qaddress2", list);
  answers.get("kaspa:qaddress2").resolve(okJson([{ transaction_id: "tx-2", inputs: [], outputs: [] }]));
  await second;
  assert.equal(list.children.length, 1);
  answers.get("kaspa:qaddress1").reject(new Error("offline"));
  await first;
  assert.equal(list.children.length, 1, "address 2's row is still there");
  assert.doesNotMatch(list.innerHTML, /Could not load/);
});

await test("history: separate lists don't cancel each other", async () => {
  const { fns, answers } = historyPage();
  const wallet = fakeElement();
  const spending = fakeElement();
  const a = fns.loadManageAddressTransactions("kaspa:qwallet", wallet);
  const b = fns.loadManageAddressTransactions("kaspa:qspending", spending);
  answers.get("kaspa:qwallet").resolve(okJson([]));
  answers.get("kaspa:qspending").resolve(okJson([]));
  await Promise.all([a, b]);
  assert.match(wallet.innerHTML, /No transactions yet/);
  assert.match(spending.innerHTML, /No transactions yet/);
});

console.log(`\n${passed} passed`);
