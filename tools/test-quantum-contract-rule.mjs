// node tools/test-quantum-contract-rule.mjs - iOS 0b4e27e: a quantum (KIP-22) P2SH address is not a
// .kachat contract. A KIP-22 spend of its own P2SH address passes, any other P2SH spend (registry
// covenants) is a contract, a P2SH output alone never hides a received payment, and on this
// wallet's own sends "every outside output is P2SH" still means the commit.
import assert from "node:assert/strict";
import { isKachatContractTransaction, isKip22Spend } from "../engine/sync.js";
import { quantumRedeemScript, quantumAddressForRedeem } from "../engine/quantum.js";
import { encodeAddress, AddressVersion } from "../engine/kachat-names/registry-state.js";
import { verifyRestTransactionSignatures, computeSighash } from "../engine/payment-signatures.js";
import { p2shScript, p2pkScript } from "../engine/kachat-names/codec.js";
import { schnorr } from "@noble/curves/secp256k1.js";

const bytes = (fill) => new Uint8Array(32).fill(fill);
const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const p2pk = (fill) => encodeAddress("kaspa", AddressVersion.pubKey, bytes(fill));
const redeemA = quantumRedeemScript(bytes(0x11));
const quantumA = quantumAddressForRedeem(redeemA, "kaspa");
const quantumB = quantumAddressForRedeem(quantumRedeemScript(bytes(0x22)), "kaspa");
const kip22Sig = (redeem, sighash = "01") => `41${"ab".repeat(64)}${sighash}22${toHex(redeem)}`;
const input = (address, signatureScript) => ({ previous_outpoint_address: address, signature_script: signatureScript });
const output = (address) => ({ script_public_key_address: address, amount: 100_000_000 });
const payeeKey = p2pk(0x33);
const ourChatting = p2pk(0x44);
const ourQuantumChange = quantumAddressForRedeem(quantumRedeemScript(bytes(0x55)), "kaspa");
const own = new Set([ourChatting, ourQuantumChange]);

// isKip22Spend
assert.equal(isKip22Spend(input(quantumA, kip22Sig(redeemA))), true, "a KIP-22 spend of its own address");
assert.equal(isKip22Spend(input(quantumA, kip22Sig(redeemA, "81"))), true, "the sighash byte is not part of the shape check");
assert.equal(isKip22Spend(input(quantumB, kip22Sig(redeemA))), false, "a redeem that hashes to another address");
assert.equal(isKip22Spend(input(quantumA, kip22Sig(redeemA).slice(0, -2))), false, "a short script");
assert.equal(isKip22Spend(input(quantumA, `40${kip22Sig(redeemA).slice(2)}`)), false, "a wrong signature push");
assert.equal(isKip22Spend(input(quantumA, "ab".repeat(3795))), false, "a covenant-sized registry script");
assert.equal(isKip22Spend(input(quantumA, "")), false, "no script");
assert.equal(isKip22Spend({ signature_script: kip22Sig(redeemA) }), false, "no spent address");

// Received payments (no input of ours)
assert.equal(isKachatContractTransaction({
  inputs: [input(quantumA, kip22Sig(redeemA))],
  outputs: [output(payeeKey), output(quantumB)],
}, own), false, "paid FROM a quantum address, quantum change: a payment");
assert.equal(isKachatContractTransaction({
  inputs: [input(p2pk(0x66), "41" + "cd".repeat(64) + "01")],
  outputs: [output(payeeKey), output(quantumB)],
}, own), false, "paid from a key address with quantum change: a payment");
assert.equal(isKachatContractTransaction({
  inputs: [input(quantumA, "ab".repeat(3795))],
  outputs: [output(payeeKey)],
}, own), true, "a covenant spend (registry reveal/bond/offer) stays a contract");
assert.equal(isKachatContractTransaction({
  payload: Buffer.from("kchat:1:name:buy:alice").toString("hex"),
  inputs: [input(p2pk(0x66), "")],
  outputs: [output(payeeKey)],
}, own), true, "a kchat:1:name: payload is a contract");
assert.equal(isKachatContractTransaction({
  payload: Buffer.from("kchat:1:offer:x").toString("hex"),
  inputs: [], outputs: [],
}), true, "a kchat:1:offer: payload is a contract, with or without own addresses");

// This wallet's own sends
assert.equal(isKachatContractTransaction({
  inputs: [input(ourChatting, "")],
  outputs: [output(quantumB), output(ourChatting)],
}, own), true, "own send whose only outside output is P2SH: the commit, never a 'sent 0.2' chat");
assert.equal(isKachatContractTransaction({
  inputs: [input(ourChatting, "")],
  outputs: [output(payeeKey), output(ourQuantumChange)],
}, own), false, "own send to a key address with quantum change of our own: a payment");
assert.equal(isKachatContractTransaction({
  inputs: [input(ourChatting.toUpperCase(), "")],
  outputs: [output(quantumB), output(ourChatting)],
}, own), true, "own addresses match in any case");
assert.equal(isKachatContractTransaction({
  inputs: [input(ourChatting, "")],
  outputs: [output(ourQuantumChange)],
}, own), false, "a self-send (no outside output) is not a contract");
assert.equal(isKachatContractTransaction({
  inputs: [input(ourChatting, "")],
  outputs: [output(quantumB)],
}), false, "without own addresses no send counts as ours (only rules 1 and 2 apply)");

// iOS 54265bf: a KIP-22 input's signature is checked like a P2PK one (else a forged all-quantum
// "payment" would pass the contract filter with nothing verified).
{
  const priv = new Uint8Array(32).fill(7);
  const key = schnorr.getPublicKey(priv);
  const redeem = quantumRedeemScript(key);
  const spentAddress = quantumAddressForRedeem(redeem, "kaspa");
  const spentAmount = 250_000_000n;
  const prevTxid = new Uint8Array(32).fill(0x9a);
  const payTo = p2pkScript(bytes(0x33));
  const model = {
    version: 0, lockTime: 0n, gas: 0n, payload: new Uint8Array(0), subnetworkId: new Uint8Array(20),
    inputs: [{ txid: prevTxid, index: 1, sequence: 0n, sigOpCount: 1 }],
    outputs: [{ amount: 200_000_000n, scriptVersion: 0, script: payTo, covenant: null }],
  };
  const sighash = computeSighash(model, 0, p2shScript(redeem), spentAmount);
  const sig = schnorr.sign(sighash, priv, new Uint8Array(32));
  const restTx = (sigScriptHex, address = spentAddress) => ({
    transaction_id: "00".repeat(32), version: 0, payload: "", subnetwork_id: "00".repeat(20),
    inputs: [{ previous_outpoint_hash: toHex(prevTxid), previous_outpoint_index: 1, sequence: 0, sig_op_count: 1,
      signature_script: sigScriptHex, previous_outpoint_address: address, previous_outpoint_amount: spentAmount.toString() }],
    outputs: [{ script_public_key: toHex(payTo), amount: "200000000" }],
  });
  const good = `41${toHex(sig)}0122${toHex(redeem)}`;
  assert.equal(await verifyRestTransactionSignatures(restTx(good)), "valid", "a real KIP-22 spend verifies");
  const tampered = `41${toHex(sig.map((b, k) => (k === 5 ? b ^ 1 : b)))}0122${toHex(redeem)}`;
  assert.notEqual(await verifyRestTransactionSignatures(restTx(tampered)), "valid", "a tampered KIP-22 signature never verifies");
  assert.equal(await verifyRestTransactionSignatures(restTx(good, quantumB)), "invalid", "IOS-097: a redeem that hashes to another address is invalid outright (the claimed id doesn't even rebuild)");
  assert.equal(await verifyRestTransactionSignatures(restTx("zz")), "invalid", "IOS-097: a P2SH signature script that isn't hex is invalid");
  assert.equal(await verifyRestTransactionSignatures(restTx(`41${toHex(sig)}8122${toHex(redeem)}`)), "unknown", "a non-ALL sighash byte is unknown");
  assert.equal(await verifyRestTransactionSignatures(restTx("ab".repeat(3795))), "unknown", "a covenant-shaped P2SH spend is skipped here (a contract elsewhere); nothing checked is unknown (IOS-106)");
}

console.log("quantum contract rule: ok");
