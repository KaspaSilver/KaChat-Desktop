// node tools/test-history-coinbase.mjs - iOS d194a38: address history lists a block reward only once
// the chain accepted it; everything else (a payment just sent is briefly unaccepted too) is listed.
import assert from "node:assert/strict";
import { isCoinbaseTransaction, transactionBelongsInHistory } from "../engine/sync.js";

const COINBASE = "0100000000000000000000000000000000000000";
const NATIVE = "0000000000000000000000000000000000000000";

assert.equal(isCoinbaseTransaction({ subnetwork_id: COINBASE, inputs: [] }), true, "the coinbase subnetwork");
assert.equal(isCoinbaseTransaction({ subnetwork_id: COINBASE.toUpperCase(), inputs: [{}] }), true, "any case, inputs ignored when the subnetwork is given");
assert.equal(isCoinbaseTransaction({ subnetwork_id: NATIVE, inputs: [] }), false, "a native transaction is never a coinbase by its subnetwork");
assert.equal(isCoinbaseTransaction({ inputs: [] }), true, "no subnetwork field: no inputs means a coinbase");
assert.equal(isCoinbaseTransaction({ inputs: [{ previous_outpoint_hash: "aa" }] }), false, "no subnetwork field, inputs: an ordinary transaction");

assert.equal(transactionBelongsInHistory({ subnetwork_id: COINBASE, is_accepted: true }), true, "an accepted reward is listed");
assert.equal(transactionBelongsInHistory({ subnetwork_id: COINBASE, is_accepted: false }), false, "an unaccepted reward never paid anything");
assert.equal(transactionBelongsInHistory({ subnetwork_id: COINBASE }), false, "a reward with no acceptance answer is not listed");
assert.equal(transactionBelongsInHistory({ subnetwork_id: NATIVE, inputs: [{}], is_accepted: false }), true, "an ordinary transaction is listed even while unaccepted");
assert.equal(transactionBelongsInHistory({ subnetwork_id: NATIVE, inputs: [{}] }), true, "an ordinary transaction without the field is listed");

console.log("history coinbase filter: ok");
