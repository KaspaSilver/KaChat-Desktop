// Address Activity for the chatting address (iOS 56b75c8): plain transfers only, newer than the
// last look.
import assert from "node:assert/strict";
import { isPlainTransferTx, txBlockTimeMs, chattingCatchUpLook } from "../ui/address-activity.js";

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

// The first look only sets where it starts: nothing counts, the floor is the newest block time.
let look = chattingCatchUpLook([plainOld, plainNew, chatNew], 0, 9000);
assert.equal(look.firstLook, true);
assert.deepEqual(look.counted, []);
assert.equal(look.nextFloor, 4000);

// Later looks: only plain transfers newer than the floor; a payload tx stays quiet.
look = chattingCatchUpLook([plainOld, plainNew, chatNew], 2000, 9000);
assert.equal(look.firstLook, false);
assert.deepEqual(look.counted.map((tx) => tx.transaction_id), ["b"]);
assert.equal(look.nextFloor, 4000);

// A tx with no block time yet never counts, and an empty fetch moves the floor to now.
look = chattingCatchUpLook([noTime], 2000, 9000);
assert.deepEqual(look.counted, []);
assert.equal(look.nextFloor, 9000);
look = chattingCatchUpLook([], 2000, 9000);
assert.equal(look.nextFloor, 9000);

// The floor never moves back.
look = chattingCatchUpLook([plainOld], 5000, 9000);
assert.equal(look.nextFloor, 5000);
assert.deepEqual(look.counted, []);

console.log("address-activity: ok");
