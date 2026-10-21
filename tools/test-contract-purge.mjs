// node tools/test-contract-purge.mjs - DSK-055: the on-load contract purge matches iOS
// purgeContractAddressPaymentChats. Only a chat whose CONTACT is a script address is a contract
// chat; a payment bubble from a quantum-safe (KIP-22, P2SH) sender survives, in the self chat and
// everywhere else. The one-time recovery un-suppresses what the old address-shape sweep hid, and
// nothing else.
import assert from "node:assert/strict";
import { contractPurgePlan, contractSuppressionRecovery } from "../ui/contract-purge.js";
import { isScriptAddress } from "../engine/sync.js";
import { quantumRedeemScript, quantumAddressForRedeem } from "../engine/quantum.js";
import { encodeAddress, AddressVersion } from "../engine/kachat-names/registry-state.js";

const bytes = (fill) => new Uint8Array(32).fill(fill);
const p2pk = (fill) => encodeAddress("kaspa", AddressVersion.pubKey, bytes(fill));
const quantumPayer = quantumAddressForRedeem(quantumRedeemScript(bytes(0x11)), "kaspa");
const registryContract = encodeAddress("kaspa", AddressVersion.scriptHash, bytes(0x22));
const me = p2pk(0x33);
const alice = p2pk(0x44);
const bob = p2pk(0x45);
assert.equal(isScriptAddress(quantumPayer), true, "a quantum address is P2SH");
assert.equal(isScriptAddress(alice), false);

const tx = (n) => n.toString(16).padStart(64, "0");
const payment = (txid, sender, receiver) => ({
  id: `m-${txid.slice(-4)}`, txid, sender, receiver, messageType: "payment", transport: "kaspa-payment",
});
const text = (id) => ({ id, txid: tx(9000 + Number(id.slice(1))), messageType: null, transport: "kasia" });
const opts = { isScriptAddress };

// --- The purge -------------------------------------------------------------------------------
{
  const rows = [
    // Note to Self: "Received 1 KAS / From: kaspa:p…" paid from a quantum address (Build 199).
    { id: "self", isSelf: true, contactAddress: me, messages: [payment(tx(1), quantumPayer, me), payment(tx(2), alice, me)] },
    // An ordinary chat holding a payment from/to script addresses (a contact's quantum spending
    // address, a notice's quantum receiver): never judged by address shape.
    { id: "alice", isSelf: false, contactAddress: alice, messages: [payment(tx(3), quantumPayer, me), payment(tx(4), alice, registryContract), text("t1")] },
    // An older build's "Sent 0.2" chat with the .kachat commit contract: only payments, so it goes.
    { id: "commit", isSelf: false, contactAddress: registryContract, messages: [payment(tx(5), me, registryContract), payment(tx(6), me, registryContract)] },
    // A Message Request a chat payment from a quantum payer opened: its contact is a script
    // address, so - as on iOS - its payments are suppressed and the emptied chat goes.
    { id: "qreq", isSelf: false, contactAddress: quantumPayer, messages: [payment(tx(7), quantumPayer, me)] },
    // A script-contact chat that also holds a non-payment row is suppressed but not deleted.
    { id: "mixed", isSelf: false, contactAddress: registryContract, messages: [payment(tx(8), me, registryContract), text("t2")] },
  ];
  const { txIds, emptiedIds } = contractPurgePlan(rows, opts);
  assert.deepEqual(new Set(txIds), new Set([tx(5), tx(6), tx(7), tx(8)]), "only script-contact chats' payments");
  assert.ok(!txIds.includes(tx(1)), "a self-chat bubble from a quantum P2SH sender survives");
  assert.ok(!txIds.includes(tx(3)) && !txIds.includes(tx(4)), "an ordinary chat's script sender/receiver survives");
  assert.deepEqual(emptiedIds, ["commit", "qreq"], "script-contact chats the purge empties are removed");
  assert.deepEqual(contractPurgePlan([], opts), { txIds: [], emptiedIds: [] });
  // The self chat is never a contract chat, whatever its contact address reads as.
  assert.deepEqual(contractPurgePlan([{ id: "s", isSelf: true, contactAddress: quantumPayer, messages: [payment(tx(1), quantumPayer, me)] }], opts),
    { txIds: [], emptiedIds: [] });
}

// --- The one-time recovery -------------------------------------------------------------------
{
  const suppressed = {
    [tx(11)]: 1, // self chat: old sweep hid a quantum payer's payment          -> recovered
    [tx(12)]: 1, // alice: old sweep hid a payment whose receiver was P2SH      -> recovered
    [tx(13)]: 1, // still hidden in a script-contact chat (the iOS rule's own)  -> stays
    [tx(14)]: 1, // suppressed by a live scan, never had a bubble anywhere      -> stays
    [tx(15)]: 1, // moved out of the self chat by a notice, then hidden in bob  -> recovered in bob only
    [tx(16)]: 1, // a script chat still shows it                                -> stays
  };
  const rows = [
    { id: "self", isSelf: true, contactAddress: me, messages: [], hiddenMessageKeys: ["m-0b", tx(11).toUpperCase(), "m-0f", tx(15), tx(99)] },
    { id: "alice", isSelf: false, contactAddress: alice, messages: [], hiddenMessageKeys: ["m-0c", tx(12), tx(13), "user-deleted", tx(98)] },
    { id: "bob", isSelf: false, contactAddress: bob, messages: [], hiddenMessageKeys: ["m-0f", tx(15)] },
    { id: "commit", isSelf: false, contactAddress: registryContract, messages: [payment(tx(16), me, registryContract)], hiddenMessageKeys: [tx(13)] },
    { id: "self-copy", isSelf: false, contactAddress: alice, messages: [], hiddenMessageKeys: [tx(16)] },
  ];
  const plan = contractSuppressionRecovery(rows, suppressed, opts);
  assert.deepEqual(new Set(plan.txIds), new Set([tx(11), tx(12), tx(15)]), "un-suppresses the right entries only");
  assert.deepEqual(plan.selfTxIds, [tx(11)], "the stranger sweep re-reads only what returns to the self chat");
  const unhide = Object.fromEntries(plan.unhide.map(({ id, keys }) => [id, keys]));
  assert.deepEqual(unhide.self, [tx(11).toUpperCase()], "the stored key is removed as stored; the moved copy stays hidden");
  assert.deepEqual(unhide.alice, [tx(12)], "a user-deleted or unsuppressed hidden key stays hidden");
  assert.deepEqual(unhide.bob, [tx(15)]);
  assert.equal(unhide.commit, undefined, "script-contact chats are never un-hidden");
  assert.equal(unhide["self-copy"], undefined, "a txid a script chat holds is never recovered elsewhere");
  // A Set of ids reads the same as the stored map; nothing suppressed, nothing to do.
  assert.deepEqual(new Set(contractSuppressionRecovery(rows, new Set(Object.keys(suppressed)), opts).txIds), new Set(plan.txIds));
  assert.deepEqual(contractSuppressionRecovery(rows, {}, opts), { txIds: [], selfTxIds: [], unhide: [] });

  // After recovery, the purge leaves the recovered self-chat payment alone when it is filed again.
  const refiled = [{ id: "self", isSelf: true, contactAddress: me, messages: [payment(tx(11), quantumPayer, me)] }];
  assert.deepEqual(contractPurgePlan(refiled, opts).txIds, []);
}

console.log("contract purge ok");
