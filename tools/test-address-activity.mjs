// Address Activity (iOS 56b75c8; KaPay 34f4b45 / 42470af): the chatting address counts plain
// transfers only, every address only receives newer than its floor, newest first; and a receive
// that spends any of our coins is our own.
import assert from "node:assert/strict";
import { isPlainTransferTx, txBlockTimeMs, catchUpCandidates, spendsOwnFunds } from "../ui/address-activity.js";

// Plain = no payload.
assert.equal(isPlainTransferTx({ payload: null }), true);
assert.equal(isPlainTransferTx({ payload: "" }), true);
assert.equal(isPlainTransferTx({}), true);
assert.equal(isPlainTransferTx({ payload: "6b636861743a313a" }), false); // "kchat:1:"
assert.equal(isPlainTransferTx({ payload: "00" }), false); // any payload, not only KaChat's
assert.equal(isPlainTransferTx(null), true);

assert.equal(txBlockTimeMs({ block_time: 1700 }), 1700);
assert.equal(txBlockTimeMs({ blockTime: "1800" }), 1800);
assert.equal(txBlockTimeMs({}), 0);
assert.equal(txBlockTimeMs({ block_time: "x" }), 0);

const plainOld = { transaction_id: "a", block_time: 1000, payload: "" };
const plainNew = { transaction_id: "b", block_time: 3000, payload: null };
const chatNew = { transaction_id: "c", block_time: 4000, payload: "6b636861743a313a706179" };
const noTime = { transaction_id: "d", payload: "" };
const ids = (look) => look.candidates.map((tx) => tx.transaction_id);

// No floor yet: everything may count (the increase bounds it), newest first, no block time first.
let look = catchUpCandidates([plainOld, plainNew, chatNew, noTime], 0);
assert.deepEqual(ids(look), ["d", "c", "b", "a"]);
assert.equal(look.nextFloor, 4000);

// Only newer than the floor; the chatting address only plain transfers.
look = catchUpCandidates([plainOld, plainNew, chatNew], 2000);
assert.deepEqual(ids(look), ["c", "b"]);
look = catchUpCandidates([plainOld, plainNew, chatNew], 2000, { chatting: true });
assert.deepEqual(ids(look), ["b"]);
assert.equal(look.nextFloor, 4000);

// The floor never moves back, and an empty fetch keeps it.
look = catchUpCandidates([plainOld], 5000);
assert.equal(look.nextFloor, 5000);
assert.deepEqual(ids(look), []);
assert.equal(catchUpCandidates([], 2000).nextFloor, 2000);
assert.equal(catchUpCandidates([noTime], 0).nextFloor, 0);

// The self-send check.
const own = new Set(["kaspa:me", "kaspa:spend1"]);
const ext = (address) => ({ previous_outpoint_address: address });
const raw = (hash, index) => ({ previous_outpoint_hash: hash, previous_outpoint_index: String(index) });
assert.equal(await spendsOwnFunds({ inputs: [ext("kaspa:other"), ext("kaspa:spend1")] }, own), true);
assert.equal(await spendsOwnFunds({ inputs: [ext("kaspa:other")] }, own), false);
assert.equal(await spendsOwnFunds({ inputs: [] }, own), null);
assert.equal(await spendsOwnFunds({}, own), null);
// Unresolved: a coin our addresses just spent.
assert.equal(await spendsOwnFunds({ inputs: [raw("ab", 1)] }, own, { recentOwnSpent: new Set(["ab:1"]) }), true);
// Unresolved: looked up in the tx that created it.
const lookups = [];
const outputAddress = async (hash, index) => { lookups.push(`${hash}:${index}`); return hash === "mine" ? "kaspa:me" : hash === "theirs" ? "kaspa:other" : null; };
assert.equal(await spendsOwnFunds({ inputs: [ext("kaspa:other"), raw("mine", 0)] }, own, { outputAddress }), true);
assert.equal(await spendsOwnFunds({ inputs: [raw("theirs", 2)] }, own, { outputAddress }), false);
// Can't be placed at all: unknown.
assert.equal(await spendsOwnFunds({ inputs: [raw("gone", 0)] }, own, { outputAddress }), null);
assert.equal(await spendsOwnFunds({ inputs: [{}] }, own), null);
assert.deepEqual(lookups, ["mine:0", "theirs:2", "gone:0"]);

console.log("address-activity: ok");
