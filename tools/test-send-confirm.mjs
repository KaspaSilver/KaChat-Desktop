// node tools/test-send-confirm.mjs - every KAS send asks first (engine.confirmSpend, owner
// 2026-10-23: Face ID for every transaction). The app sets engine.authorizeSpend; a refusal stops
// the send before anything is built or connected, with SEND_CANCELLED.
import assert from "node:assert/strict";
import { KaspaEngine } from "../engine/index.js";

const engine = new KaspaEngine({ log: () => {} });
let built = 0;
// Stand-ins below the gate: reaching them means the send went ahead.
engine.requireWallet = () => {};
engine.requireSdk = () => {};
engine.connect = async () => { built += 1; throw new Error("reached the build"); };

const asked = [];
async function attempt(run) {
  try { await run(); return "sent"; }
  catch (error) { return error?.code === "SEND_CANCELLED" ? "cancelled" : "went ahead"; }
}

// No authorizer (tests, tools): as before.
assert.equal(await attempt(() => engine.send("kaspa:qpdest", "1.5")), "went ahead");

engine.authorizeSpend = async (details) => { asked.push(details); return false; };
built = 0;
assert.equal(await attempt(() => engine.send("kaspa:qpdest", "1.5")), "cancelled");
assert.equal(await attempt(() => engine.sendMax("kaspa:qpdest", null, null, { expectedAmountSompi: 250000000n })), "cancelled");
assert.equal(await attempt(() => engine.sendFromSpending({ mnemonic: "x", index: 1, destinationAddress: "kaspa:qpdest", amountKas: "2" })), "cancelled");
assert.equal(await attempt(() => engine.sendMaxFromSpending({ mnemonic: "x", index: 1, destinationAddress: "kaspa:qpdest" })), "cancelled");
assert.equal(await attempt(() => engine.transferKnsDomain({ domain: "alice.kas", assetId: "a", toAddress: "kaspa:qpdest" })), "cancelled");
assert.equal(built, 0, "a refused send builds and connects nothing");
assert.deepEqual(asked.map((d) => [d.to, d.amountKas ?? null, Boolean(d.max), d.domain ?? null]), [
  ["kaspa:qpdest", "1.5", false, null],
  ["kaspa:qpdest", null, true, null],
  ["kaspa:qpdest", "2", false, null],
  ["kaspa:qpdest", null, true, null],
  ["kaspa:qpdest", null, false, "alice.kas"],
]);
assert.equal(asked[1].amountSompi, 250000000n, "a Max send says how much");

// Confirmed: it goes ahead.
engine.authorizeSpend = async () => true;
assert.equal(await attempt(() => engine.send("kaspa:qpdest", "1.5")), "went ahead");
assert.equal(built, 1);

console.log("send confirm: ok (5 send paths gated, refusal builds nothing)");
