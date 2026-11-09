// The remaining money and account fixes of the 2026-11-09 audits (KaChat iOS 4f8e14bb, KaPay 2da5f4b).
// Run: node tools/test-money-audit-remaining.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { submitConfirmingAcceptance } from "../engine/transactions.js";
import { verifiedFreshQuantumIndex, QUANTUM_INDEX_BASE } from "../engine/quantum.js";

const store = new Map();
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
const { resumePendingKnsReveals, pendingKnsReveals, KNS_REVEAL_MISSING_LIFETIME_MS } = await import("../engine/kns-write.js");

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const app = read("ui/app.js");
const index = read("engine/index.js");
let passed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const NOT_FOUND = { getMempoolEntry: async () => { throw new Error("not found"); } };

function orphaning() {
  const seen = [];
  return { seen, submit: async (_, { allowOrphan = false } = {}) => { seen.push(allowOrphan); if (allowOrphan) return { transactionId: "ab" }; throw new Error("transaction is an orphan where orphan is disallowed"); } };
}
test("a money send is never put in the orphan pool", async () => {
  const { seen, submit } = orphaning();
  await assert.rejects(submitConfirmingAcceptance({ rpc: NOT_FOUND, submit, txid: "ab", orphanWaitMs: 1, escalateOrphan: false, lostAnswerWaitMs: 1 }), /orphan/);
  assert.deepEqual(seen, [false, false]);
});
test("a message still may be (it chains on its own change)", async () => {
  const { seen, submit } = orphaning();
  await submitConfirmingAcceptance({ rpc: NOT_FOUND, submit, txid: "ab", orphanWaitMs: 1, lostAnswerWaitMs: 1, recheckMs: 0 }).catch(() => {});
  assert.deepEqual(seen.slice(0, 3), [false, false, true]);
});
test("change doesn't take the slot the Receive QR points at", async () => {
  const reserved = QUANTUM_INDEX_BASE + 5;
  assert.equal(await verifiedFreshQuantumIndex({ qMaxIndex: 4, addressAt: () => "kaspa:x", usedState: () => false, reservedIndex: reserved }), reserved + 1);
  assert.equal(await verifiedFreshQuantumIndex({ qMaxIndex: 4, addressAt: () => "kaspa:x", usedState: () => false }), reserved);
});

// .kas reveals owed: the record, read back through the module.
const ME = "kaspa:qme";
const KEY = `kachat-account-data-v1:${ME}:kachat-kns-pending-reveals-v1`;
const file = (records) => store.set(KEY, JSON.stringify(records));
const fakeEngine = (entries) => ({
  address: ME, privateKey: null, kaspa: null, connect: async () => {},
  withRpc: async (fn) => fn({ getUtxosByAddresses: async () => ({ entries }) }),
});
test("no key loaded: nothing is done and nothing is dropped", async () => {
  store.clear();
  file([{ id: "a", createdAt: 0, payloadJson: "{}", commitAddressString: "a", commitAmountSompi: "1", revealAmountSompi: "1" }]);
  assert.equal(await resumePendingKnsReveals({ engine: fakeEngine([]) }), 0);
  assert.equal(pendingKnsReveals(ME).length, 1);
  assert.ok(KNS_REVEAL_MISSING_LIFETIME_MS === 86_400_000);
});
test("records are kept per account, under the prefix account removal sweeps", () => {
  assert.match(KEY, /^kachat-account-data-v1:/);
  assert.deepEqual(pendingKnsReveals("kaspa:qother"), []);
});

test("wiring", () => {
  const kns = read("engine/kns-write.js");
  assert.equal(kns.split("commitWithRevealFiled({").length - 1, 3, "defined once, used by registration and profile edits");
  assert.equal(kns.split("revealOrLeaveFiled(() =>").length - 1, 2);
  assert.match(kns, /KaChat will finish it the next time it opens\./);
  assert.match(index, /expectedFeeSompi: options\.expectedFeeSompi \?\? null,\n\s+escalateOrphan: false,/);
  assert.match(index, /options\.ownerAddress && options\.ownerAddress !== this\.address/);
  assert.equal(app.split("ownerAddress: envelope.fromAddress").length - 1, 3, "edits, notices and reactions are bound to their account");
  assert.match(app, /isQuantumIndex\(index\) \? null : \{ id: "public"/);
  assert.match(app, /isQuantumAddressSpentLocally\(address, owner\)\) return false;/);
  assert.match(app, /for \(const earlier of takePreviousChattingAddresses\(address\)\)/);
  assert.match(app, /movePreviousChattingAddresses\(previousAddress, engine\.address\);/);
  assert.match(app, /const cache = loadSpendingBalCache\(\);\n\s+balances = new Map/);
  assert.match(read("index.html"), /data-spending-detail-options/);
});

for (const [name, fn] of tests) {
  try { await fn(); passed += 1; console.log(`ok - ${name}`); }
  catch (error) { console.log(`FAIL ${name}\n  ${error?.stack || error}`); process.exitCode = 1; }
}
console.log(`money audit remaining: ${passed}/${tests.length} passed`);
