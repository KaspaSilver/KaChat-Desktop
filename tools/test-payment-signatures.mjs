// node tools/test-payment-signatures.mjs - the received-payment signature check (iOS 5806362 +
// 8116ab9, KasiaTransactionBuilder.verifyTransactionSignatures) against real mainnet transactions as
// api.kaspa.org returns them (resolve_previous_outpoints=light), saved here so the test is offline.
//   v0, v1        ordinary payments: valid
//   missingFields a real v0 transaction whose REST answer does not reproduce its id (the API drops
//                 the sequence / lock time it set): unknown, so the payment is held, never dropped
// 8116ab9 (AND-042, XP-033, IOS-092): a P2PK input's blank / short / wrongly pushed signature script
// is a failure (invalid when the REST fields rebuild the id, unknown otherwise), a non-ALL sighash
// type is unknown, a bad previous-output index is unknown.
import assert from "node:assert/strict";

class MemoryStorage {
  constructor() { this.map = new Map(); }
  getItem(key) { return this.map.has(key) ? this.map.get(key) : null; }
  setItem(key, value) { this.map.set(key, String(value)); }
  removeItem(key) { this.map.delete(key); }
  get length() { return this.map.size; }
  key(index) { return [...this.map.keys()][index] ?? null; }
}
globalThis.localStorage = new MemoryStorage();

const { verifyRestTransactionSignatures, scriptPublicKeyFromAddress, parseU32 } = await import("../engine/payment-signatures.js");
const { encodeAddress, AddressVersion } = await import("../engine/kachat-names/registry-state.js");

const FIXTURES = {"v0":{"transaction_id":"73c4bcbb285066ed63139c6cbc5c61e344d310a4a42dceb42752841c81a96421","version":0,"subnetwork_id":"0000000000000000000000000000000000000000","payload":"6b636861743a313a636f6d6d3a3937633263333633353731643a6f755a512f7736335058342f6c6471414134554d453068522b645154557339674b324f575339425944654e4331686249353461764649525932614779665355612f75524c6f697761675168594177736632446b7a375a7a38645061396546784d7230302b553679384462736677312b4350614557495248496275304356414d5766322f62726a784d6b4949557357744557746838766c5a61304e37553277664f","inputs":[{"previous_outpoint_hash":"43f766ab42aaa08844ece280e84dfa3092358acd5487a4148f1920cea39fea4b","previous_outpoint_index":"0","previous_outpoint_address":"kaspa:qzk2jrk7wq3zdw2n0260v87fglky82cg5u3pwy73wpktk3u864yecm5djll40","previous_outpoint_amount":195749331,"signature_script":"41f530b317de5005a7ee0e3a91803fb45088ce43af0d9e725f7514ba7a1773a3e3da52b1400526c7431d04d6697f89febbd538d0c9ae9e1c6273482a772a5ef14f01","sig_op_count":"1"}],"outputs":[{"index":0,"amount":195568328,"script_public_key":"20aca90ede702226b9537ab4f61fc947ec43ab08a7221713d1706cbb4787d5499cac","script_public_key_address":"kaspa:qzk2jrk7wq3zdw2n0260v87fglky82cg5u3pwy73wpktk3u864yecm5djll40","covenant_authorizing_input":null,"covenant_id":null}]},"v1":{"transaction_id":"97b1f40d00c696eeecd9563be173bc1929ab146db32e8f23e9d67575eff39b79","version":1,"subnetwork_id":"97b1000000000000000000000000000000000000","payload":"95789c8dcd792843011cc0f1f75e426e8626e44ec87a11a5146ac97d451a72162657422b6598e5684b720c39e6564c16424b7894891c19535bb694359b651bbd9d357ff8ffcdf78fdf3f9f5fbf1f64800efb585c9aed17952e17acba017f93665351348e64eb5c920712b6d11352aec07faf26fa6774b0e708223e71fb9d1988597da11ce304f8e00a55e91f20f3e1cdb26c7f6c27bec9a417d0e2d06232137ff0599a144d325e6bec28c514be526a03c403ef39a9d3536c8508c0080c22e66179d030af14c0ced18a4bb119acc47620a5ae16c4c1db2bae2621c37fd117bda3531d8a608ea7366d289cb84e5b35256e2aee9f37eae708d349613a6e540579a191d3b2bcb1d6cc73b8ca62d827fb01ff2f427043a70c7f4b477b655d07c2c02a7e4822056b1f64421e564e565af114437debd27c09aaad6aea9b7a55b70737497897d4adc516f9d98ca96cc6d358ededb4efd7ecd5b15338626904bda95ebb9638a4530d1a6771840cd55098af9507a73decf388c87b16be7c52a45ed7e3e1acdb71568c1ee95e086dd048908947523e9b400a70971d89a3f870db64477670aa5900bf40645b749eed28971889b1bf7c3cb2070001a29e","inputs":[{"previous_outpoint_hash":"97b18c603f4a4711cea105b982e762915b2873df970df9fb030297f39fe2f2e2","previous_outpoint_index":"0","previous_outpoint_address":"kaspa:qqt9pdktna9dzf8u2rz6jnqvpcda8nxpreaxnspq0m5hnumsmvqnu6nxxclec","previous_outpoint_amount":381428448,"signature_script":"410fd934777951dc52f74fbc9d8c4de671d59323f49b378baecb66fcea9137e6ae454094293bf907850172cf924b217c85aaa0a74b9a1b00c70ed474afe5eafe1401","sig_op_count":"0"}],"outputs":[{"index":0,"amount":381177148,"script_public_key":"201650b6cb9f4ad124fc50c5a94c0c0e1bd3ccc11e7a69c0207ee979f370db013eac","script_public_key_address":"kaspa:qqt9pdktna9dzf8u2rz6jnqvpcda8nxpreaxnspq0m5hnumsmvqnu6nxxclec","covenant_authorizing_input":null,"covenant_id":null}]},"missingFields":{"transaction_id":"f208a937f4bab5966d11504bde84dc4410504e5631c2d4aae23bfc47c557927f","version":0,"subnetwork_id":"0000000000000000000000000000000000000000","payload":null,"inputs":[{"previous_outpoint_hash":"5fc1ba14059a145b6a062b02af2dac518b51db870d25523ea8a048781b404645","previous_outpoint_index":"0","previous_outpoint_address":"kaspa:qzk2jrk7wq3zdw2n0260v87fglky82cg5u3pwy73wpktk3u864yecm5djll40","previous_outpoint_amount":500000000,"signature_script":"4140260c191d26666ebdab40895ad38d38ed6e2b2ac4c38fca18b2b0c6febbc6faed4271cd7ba2ca506adbc69b4c516eb7b4f3398c82f54473b5911f71b4a933d701","sig_op_count":"1"},{"previous_outpoint_hash":"852fd248f8a599d413b3a857106ad56bb24839488922782d94d7f74b00c6f76c","previous_outpoint_index":"0","previous_outpoint_address":"kaspa:qzk2jrk7wq3zdw2n0260v87fglky82cg5u3pwy73wpktk3u864yecm5djll40","previous_outpoint_amount":95485528,"signature_script":"41ec8b8df6b6a876e65f94842a22f8c0167a5c1056250dc9f08feac1b73e041c1d21623aafc315ba6ac91c1ae8f8a895a52fbd6a2197945e9b0c2d20a60ed7d30001","sig_op_count":"1"}],"outputs":[{"index":0,"amount":595211325,"script_public_key":"20af1044f8c7ac523b7862ac6d6d5d91909d22d93001775ae65dce7f3541e4950dac","script_public_key_address":"kaspa:qzh3q38cc7k9ywmcv2kx6m2ajxgf6gkexqqhwkhxth887d2puj2s6ah2epnet","covenant_authorizing_input":null,"covenant_id":null}]}};
const clone = (value) => JSON.parse(JSON.stringify(value));

assert.equal(await verifyRestTransactionSignatures(FIXTURES.v0), "valid", "a real v0 payment verifies");
assert.equal(await verifyRestTransactionSignatures(FIXTURES.v1), "valid", "a real v1 payment verifies (no sig-op counts, covenant flags)");
assert.equal(await verifyRestTransactionSignatures(FIXTURES.missingFields), "unknown", "fields the API drops: held, not judged");

// A forged signature over the exact transaction: the id still reproduces, so it is invalid.
const badSig = clone(FIXTURES.v0);
const s = badSig.inputs[0].signature_script;
badSig.inputs[0].signature_script = s.slice(0, 10) + (s[10] === "0" ? "1" : "0") + s.slice(11);
assert.equal(await verifyRestTransactionSignatures(badSig), "invalid", "a wrong signature on the real transaction is invalid");

// A forged amount (more KAS to us than was sent): never valid.
const moreMoney = clone(FIXTURES.v0);
moreMoney.outputs[0].amount = String(BigInt(moreMoney.outputs[0].amount) * 10n);
assert.notEqual(await verifyRestTransactionSignatures(moreMoney), "valid", "an inflated amount never passes");

// An input the API did not resolve: looked up through the resolver, else unknown.
const unresolved = clone(FIXTURES.v0);
const spent = { address: unresolved.inputs[0].previous_outpoint_address, amount: unresolved.inputs[0].previous_outpoint_amount };
delete unresolved.inputs[0].previous_outpoint_address;
delete unresolved.inputs[0].previous_outpoint_amount;
assert.equal(await verifyRestTransactionSignatures(unresolved), "unknown", "an unresolved input with no lookup is unknown");
assert.equal(await verifyRestTransactionSignatures(unresolved, { resolveSpentOutput: async () => spent }), "valid", "the previous transaction resolves it");

// AND-042: a key-address input's signature script must be well formed. Blank, short or pushed with
// another opcode is a failure, never a skip. The v0 and v1 fixtures' REST fields rebuild their ids
// (signature scripts are not part of the id), so there it is invalid; the missingFields fixture's
// don't, so there it is unknown (held, then asked of the node).
const withSigScript = (fixture, inputIndex, script) => {
  const t = clone(fixture);
  t.inputs[inputIndex].signature_script = script;
  return t;
};
for (const [name, fixture] of [["v0", FIXTURES.v0], ["v1", FIXTURES.v1]]) {
  const real = fixture.inputs[0].signature_script;
  assert.equal(await verifyRestTransactionSignatures(withSigScript(fixture, 0, "")), "invalid", `${name}: a blank signature script is a failure`);
  assert.equal(await verifyRestTransactionSignatures(withSigScript(fixture, 0, real.slice(0, 64))), "invalid", `${name}: a short signature script is a failure`);
  assert.equal(await verifyRestTransactionSignatures(withSigScript(fixture, 0, "40" + real.slice(2))), "invalid", `${name}: another push is a failure`);
  assert.equal(await verifyRestTransactionSignatures(withSigScript(fixture, 0, "zz" + real.slice(2))), "invalid", `${name}: a script that isn't hex is a failure`);
  const noScript = clone(fixture);
  delete noScript.inputs[0].signature_script;
  assert.equal(await verifyRestTransactionSignatures(noScript), "invalid", `${name}: a missing signature script is a failure`);
}
assert.equal(await verifyRestTransactionSignatures(withSigScript(FIXTURES.missingFields, 1, "")), "unknown", "a blank script where the REST fields don't rebuild the id: unknown");
// Either input of the two-input missingFields transaction: the failure is still judged by the id.
assert.equal(await verifyRestTransactionSignatures(withSigScript(FIXTURES.missingFields, 0, "")), "unknown");

// A sighash type other than SIGHASH_ALL can't be checked here: unknown, never a silent pass.
for (const type of ["02", "03", "81", "00"]) {
  const real = FIXTURES.v0.inputs[0].signature_script;
  assert.equal(await verifyRestTransactionSignatures(withSigScript(FIXTURES.v0, 0, real.slice(0, 130) + type)), "unknown", `sighash type 0x${type} is unknown`);
}
// A failure on an earlier input then a non-ALL type: unknown (the non-ALL input can't be decided).
{
  const t = clone(FIXTURES.missingFields);
  t.inputs[0].signature_script = "";
  t.inputs[1].signature_script = t.inputs[1].signature_script.slice(0, 130) + "02";
  assert.equal(await verifyRestTransactionSignatures(t), "unknown");
}

// A non-key-address input (here: spent from a P2SH address) is not signature-checked, so a blank
// script there is skipped as before - the spent script is worked out first.
{
  const t = clone(FIXTURES.v0);
  t.inputs[0].previous_outpoint_address = encodeAddress("kaspa", AddressVersion.scriptHash, new Uint8Array(32).fill(0x11));
  t.inputs[0].signature_script = "";
  assert.ok(scriptPublicKeyFromAddress(t.inputs[0].previous_outpoint_address)?.[0] === 0xaa, "fixture address is P2SH");
  assert.equal(await verifyRestTransactionSignatures(t), "valid", "a P2SH input is skipped, not failed");
}

// IOS-092: the previous-output index is read strictly (a u32), a bad one is unknown, never a crash.
for (const bad of ["", "-1", "1.5", "4294967296", "0x1", " 0", "abc", null, undefined, 1.5, -1, 2 ** 32, Number.NaN, {}, []]) {
  const t = clone(FIXTURES.v0);
  if (bad === undefined) delete t.inputs[0].previous_outpoint_index; else t.inputs[0].previous_outpoint_index = bad;
  assert.equal(await verifyRestTransactionSignatures(t), "unknown", `index ${JSON.stringify(bad)} is unknown`);
}
assert.equal(parseU32("4294967295"), 4294967295);
assert.equal(parseU32(0), 0);
assert.equal(parseU32(7n), 7);
assert.equal(parseU32("4294967296"), null);
// A resolver is asked with the parsed index, never a coerced one.
{
  const t = clone(FIXTURES.v0);
  const spentOut = { address: t.inputs[0].previous_outpoint_address, amount: t.inputs[0].previous_outpoint_amount };
  delete t.inputs[0].previous_outpoint_address;
  delete t.inputs[0].previous_outpoint_amount;
  let askedIndex = null;
  assert.equal(await verifyRestTransactionSignatures(t, { resolveSpentOutput: async (_txid, index) => { askedIndex = index; return spentOut; } }), "valid");
  assert.equal(askedIndex, 0);
}

// A coinbase (no inputs) has nothing to check.
assert.equal(await verifyRestTransactionSignatures({ inputs: [], outputs: [] }), "valid");
// Schnorr P2PK script from an address.
const script = scriptPublicKeyFromAddress(FIXTURES.v0.outputs[0].script_public_key_address);
assert.equal(Array.from(script, (b) => b.toString(16).padStart(2, "0")).join(""), FIXTURES.v0.outputs[0].script_public_key);

// The payment sync (engine/sync.js, iOS 8116ab9): an unknown payment is filed only when our node
// confirms it (without its memo), otherwise held; a held one on the first page is due even when
// the known set has it (IOS-091), and a known one is never filed twice.
{
  const { syncIncomingPaymentsFromRest, heldPaymentTxids } = await import("../engine/sync.js");
  const tx = clone(FIXTURES.missingFields); // unknown: its REST fields don't rebuild its id
  const wallet = tx.outputs[0].script_public_key_address;
  const contact = { id: "c1", address: tx.inputs[0].previous_outpoint_address };
  const paid = BigInt(tx.outputs[0].amount);
  globalThis.fetch = async () => ({ ok: true, json: async () => [tx] });
  const run = (extra) => syncIncomingPaymentsFromRest({ conversationId: "conv", contact, walletAddress: wallet, ...extra });

  let result = await run({});
  assert.equal(result.messages.length, 0, "unknown and no node: not filed");
  assert.deepEqual(heldPaymentTxids(wallet), [tx.transaction_id], "unknown and no node: held");

  const asked = [];
  result = await run({ knownTxids: [tx.transaction_id], confirmUnspentPayment: async (...args) => { asked.push(args); return false; } });
  assert.equal(asked.length, 1, "a held txid is checked even when known (IOS-091)");
  assert.deepEqual(asked[0], [tx.transaction_id, wallet, paid], "the node is asked for the amount paid to us");
  assert.deepEqual(heldPaymentTxids(wallet), [tx.transaction_id], "the node doesn't confirm it: still held");

  result = await run({ knownTxids: [tx.transaction_id], confirmUnspentPayment: async () => true });
  assert.equal(result.messages.length, 0, "confirmed but already in the chat: not filed twice");
  assert.deepEqual(heldPaymentTxids(wallet), [], "confirmed: released");

  globalThis.localStorage = new MemoryStorage();
  result = await run({ confirmUnspentPayment: async () => true, decryptMessage: async () => JSON.stringify({ type: "payment", message: "forged memo" }) });
  assert.equal(result.messages.length, 1, "confirmed by the node: filed");
  assert.equal(result.messages[0].text, "Received 5.95211325 KAS", "filed without its memo");
  assert.equal(result.messages[0].chatPayment, false, "filed as a plain payment (no payload)");
  assert.deepEqual(heldPaymentTxids(wallet), []);
}

console.log("payment signatures: ok");
