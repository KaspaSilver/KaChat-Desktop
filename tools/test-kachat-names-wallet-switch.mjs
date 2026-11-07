// .kachat claims stay with the wallet that started them across a wallet switch
// (engine/kachat-names/actions.js _set / _upsertFor). The driver and a cancel run a step of one
// wallet's claim over several awaits; a switch in between used to upsert that claim - salt and all -
// into the newly loaded wallet's list, where its driver then finished it as "Registered": a name
// shown as that wallet's that it does not own. Pure storage, no network:
//
//   node tools/test-kachat-names-wallet-switch.mjs
import assert from "node:assert/strict";

const store = new Map([["kachat-network-v1", "testnet"]]);
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
};

const A = await import("../engine/kachat-names/actions.js");

const walletA = "kaspatest:qwalleta";
const walletB = "kaspatest:qwalletb";
const engine = { address: walletA };
const mem = new Map();
const storage = { get: (k) => mem.get(k) ?? null, set: (k, v) => { mem.set(k, v); } };
const actions = new A.KachatNamesActions({ engine, service: {}, registry: {}, storage });
const stored = () => JSON.parse(mem.get(A.registrationsStorageKey) || "{}");

const claim = (id, stage = A.Stage.waiting) => ({
  id, name: `name${id}`, years: 1, owner: "11".repeat(32), commitTxId: "22".repeat(32), commitScript: "aa",
  commitDaa: null, registerTxId: null, cancelTxId: null, stage, createdAt: 1, updatedAt: 1, lastError: null, salt: "33".repeat(32),
});

// Wallet A has a claim in progress; the driver took its snapshot of it.
actions._loadPending(walletA);
actions._upsert(claim("a1"));
const snapshot = actions._pending[0];

// The wallet switches while that step is awaiting the network.
engine.address = walletB;
actions._loadPending(walletB);
assert.equal(actions.pending.length, 0, "wallet B starts with no claims");

// The step finishes: register sent, then later the driver would finish it as registered.
actions._set(snapshot, (q) => { q.stage = A.Stage.registering; q.registerTxId = "44".repeat(32); });
assert.equal(actions.pending.length, 0, "A's claim is not filed in B's loaded list");
assert.equal(stored()[walletB.toLowerCase()], undefined, "nor in B's stored list");
const aStored = stored()[walletA.toLowerCase()];
assert.equal(aStored.length, 1, "A keeps its one claim");
assert.equal(aStored[0].stage, A.Stage.registering, "A's stored claim took the step's change");
assert.equal(aStored[0].registerTxId, "44".repeat(32));
assert.equal(aStored[0].salt, "33".repeat(32), "with its salt");

// A finished (cancelled) step of A's: stage set in A's store, nothing removed from B.
actions._upsert(claim("b1", A.Stage.taken));
actions._finishCancelled(snapshot);
assert.equal(actions.pending.length, 1, "B's own claim untouched");
assert.equal(stored()[walletA.toLowerCase()][0].stage, A.Stage.cancelled);

// A record found in no list (dismissed meanwhile) is not brought back.
actions._set(claim("gone"), (q) => { q.stage = A.Stage.failed; });
assert.ok(!actions.pending.some((p) => p.id === "gone"));
assert.ok(!Object.values(stored()).flat().some((p) => p.id === "gone"));

// A claim started under A and filed after the switch goes to A's list (startRegistration).
actions._upsertFor(walletA.toLowerCase(), claim("a2"));
assert.equal(actions.pending.length, 1, "B still lists only its own claim");
assert.deepEqual(stored()[walletA.toLowerCase()].map((p) => p.id), ["a1", "a2"]);
actions._upsertFor(walletA.toLowerCase(), { ...claim("a2"), lastError: "x" });
assert.equal(stored()[walletA.toLowerCase()][1].lastError, "x", "updated in place, not duplicated");
assert.equal(stored()[walletA.toLowerCase()].length, 2);

// Same wallet: the ordinary path (loaded list and storage both).
actions._upsertFor(walletB.toLowerCase(), claim("b2"));
assert.deepEqual(actions.pending.map((p) => p.id), ["b1", "b2"]);
actions._set(actions._pending[1], (q) => { q.lastError = "y"; });
assert.equal(actions.pending[1].lastError, "y");
assert.equal(stored()[walletB.toLowerCase()][1].lastError, "y");

// Switching back reads A's claims with every change made while B was loaded.
engine.address = walletA;
actions._loadPending(walletA);
assert.deepEqual(actions.pending.map((p) => [p.id, p.stage]), [["a1", A.Stage.cancelled], ["a2", A.Stage.waiting]]);

console.log("kachat-names wallet switch: all checks passed");
