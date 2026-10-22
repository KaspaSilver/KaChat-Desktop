// Quantum-safe spending addresses (KIP-22, iOS bba1b1e + e001786): the derivation, the P2SH script
// it pays to, how a spend signs, what it costs, the index mapping, the change rule and the restore
// scan. Offline only: the RPC is an in-memory UTXO set that records what would be submitted, the
// coins are fake, and nothing leaves the machine. Run from the repo root:
//
//   node tools/test-quantum-addresses.mjs
//
// The address vectors are Android's (KaChatForAndroid ff70d4c3 QuantumAddressTest), computed there
// by an independent pure-Python implementation (BIP39 PBKDF2, BIP32 with its own secp256k1
// arithmetic, blake2b-256, Kaspa's cashaddr checksum) that first reproduces the legacy spending
// addresses below - which this app has always derived - before its P2SH output is trusted.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { blake2b } from "@noble/hashes/blake2.js";
import { schnorr } from "@noble/curves/secp256k1.js";

import * as Q from "../engine/quantum.js";
import { deriveSpendingWallet, deriveSpendingAddressRange, spendingDerivationPath } from "../engine/wallet.js";
import { sendKaspa, sendMaxKaspa, sweepAllToSelf, estimateMaxSend, estimateOnchainFeeDetail, floorFeeSompiFor } from "../engine/transactions.js";
import { computeSighash, scriptPublicKeyFromAddress } from "../engine/payment-signatures.js";
import { p2shScript, p2pkScript, hex, unhex } from "../engine/kachat-names/codec.js";
import { p2shAddress, decodeAddress, AddressVersion } from "../engine/kachat-names/registry-state.js";
import { calculateMass } from "../ui/kspt.js";
import { discoverQuantumMatches, applyQuantumDiscovery } from "../ui/spending-discovery.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");

const r = {
  pass: 0, fail: 0, failures: [],
  check(ok, label) { if (ok) this.pass++; else { this.fail++; this.failures.push(label); } },
  eq(a, b, label) { this.check(a === b, `${label}: got ${String(a)}, expected ${String(b)}`); },
  async throws(fn, pred, label) {
    try { await fn(); this.check(false, `${label}: did not throw`); } catch (e) { this.check(pred(e), `${label}: threw ${e?.message}`); }
  },
};

const kaspa = await import("../kaspa/kaspa.js");
await kaspa.default({ module_or_path: readFileSync(join(repo, "kaspa/kaspa_bg.wasm")) });

const NET = "mainnet";
const KAS = 100_000_000n;
// Public all-zero-entropy 24-word BIP39 test mnemonic - not a real wallet.
const WORDS = [...Array(23).fill("abandon"), "art"].join(" ");
const B = Q.QUANTUM_INDEX_BASE;

let txCounter = 0;
const fakeTxid = () => (0xabc000 + ++txCounter).toString(16).padStart(64, "0");
function coin(address, amountSompi) {
  return {
    address,
    outpoint: { transactionId: fakeTxid(), index: txCounter % 3 },
    amount: amountSompi,
    scriptPublicKey: kaspa.payToAddressScript(address),
    blockDaaScore: 1000n,
    isCoinbase: false,
  };
}
function stubRpc() {
  const rpc = {
    utxos: new Map(),
    submitted: [],
    async getUtxosByAddresses(addresses) {
      const list = (Array.isArray(addresses) ? addresses : addresses?.addresses || []).map(String);
      return { entries: list.flatMap((a) => rpc.utxos.get(a) || []) };
    },
    async submitTransaction({ transaction }) {
      rpc.submitted.push(transaction);
      return { transactionId: transaction.id };
    },
  };
  return rpc;
}
// The generator's PendingTransaction.submit only takes a real RpcClient: route it to the stub.
kaspa.PendingTransaction.prototype.submit = async function submitToStub(rpc) {
  return (await rpc.submitTransaction({ transaction: this.transaction })).transactionId;
};

const scriptOf = (spk) => String(typeof spk === "string" ? spk : spk?.script ?? "").toLowerCase();
const blake = (bytes) => blake2b(bytes, { dkLen: 32 });

async function main() {
  // MARK: Derivation at m/22'/111111'/0'/0/<n>
  const seed = new kaspa.Mnemonic(WORDS).toSeed("");
  r.eq(String(seed), "408b285c123836004f4b8842c89324c1f01382450c0d439af345ba7fc49acf705489c6fc77dbd4e3dc1dd8cc6bc9f043db8ada1e243c4a0eafb290d399480840", "derivation: the BIP39 seed is the Python reference's");
  const legacyExpected = [
    "kaspa:qppt49jerlp2vjquvhfjcpzkna7g26jzu2r88wwsnt3zndq4qvnnywxtsehh8",
    "kaspa:qphqs4c490zy80q6rjlnetvyv3hclg8zz6h8l774rsprdprryz88xk3qp39k7",
    "kaspa:qzqmrwjk6qyvd267q034qlhrhpdjdvtedl3uw298aha0hk2sl0kv62y06lahf",
  ];
  legacyExpected.forEach((address, i) => r.eq(deriveSpendingWallet(kaspa, WORDS, i).address, address, `derivation: legacy spending #${i} matches the reference (proves the reference)`));
  const quantumExpected = [
    { address: "kaspa:pp4csja82vqaa9hstf6ned49w8j2tl79jmwjk5v79999qxsrfkj9zvq7y9wme", redeem: "2008ddc68dcaad0b901868b764afe822a54e09e930064b21cc0846b4d08620136eac" },
    { address: "kaspa:pzc4ja4jywkqelzxeqn42z6mfqcf0aacgudadtszz52xpc9vr5wkxuyd47277", redeem: "203bc3d2f941e0e3f87bdff4ac632974ed3378ccebf0cd2821ed7496334bccbdf8ac" },
    { address: "kaspa:prm5kldes5ynvrmm5rl59ss78hdfmu74l8yxq8cqf0d33hfjcvvm7fr6m2aas", redeem: "20979a19859d7ce76ec130ea57c417fcefc88694434fa50ee5de9e5620df5e2d82ac" },
  ];
  const quantumWallets = quantumExpected.map((_, n) => deriveSpendingWallet(kaspa, WORDS, B + n));
  quantumExpected.forEach(({ address, redeem }, n) => {
    const w = quantumWallets[n];
    r.eq(w.address, address, `derivation: quantum #${n} address matches the Python reference`);
    r.eq(hex(w.redeemScript), redeem, `derivation: quantum #${n} redeem script (0x20 <x-only key> OP_CHECKSIG) matches the reference`);
    r.eq(w.xOnlyPublicKeyHex, redeem.slice(2, 66), `derivation: quantum #${n} x-only key is the redeem script's`);
    r.check(w.quantum === true, `derivation: quantum #${n} is flagged quantum`);
    r.eq(w.derivationPath, `m/22'/111111'/0'/0/${n}`, `derivation: quantum #${n} path`);
    // the x-only key from the signing key itself (BIP340), by an independent library
    r.eq(hex(schnorr.getPublicKey(unhex(w.privateKeyHex))), w.xOnlyPublicKeyHex, `derivation: quantum #${n} key's BIP340 x-only public key (noble) agrees`);
  });
  r.check(quantumWallets[0].address !== deriveSpendingWallet(kaspa, WORDS, 0).address, "derivation: the legacy and quantum chains never share an address");
  // Path parsing: the hardened markers are honoured (the same key as hand-stepping each hardened
  // child), and an unhardened spelling is a different key.
  {
    const master = new kaspa.XPrv(seed);
    const stepped = master.deriveChild(22, true).deriveChild(111111, true).deriveChild(0, true).deriveChild(0, false).deriveChild(1, false);
    r.eq(stepped.toPrivateKey().toString(), quantumWallets[1].privateKeyHex, "path: m/22'/111111'/0'/0/1 equals stepping 22', 111111', 0', 0, 1 by hand");
    const unhardened = master.derivePath("m/22/111111/0/0/1").toPrivateKey().toString();
    r.check(unhardened !== quantumWallets[1].privateKeyHex, "path: the unhardened spelling derives a different key (hardening is parsed)");
    r.eq(spendingDerivationPath(B + 7), "m/22'/111111'/0'/0/7", "path: public index base+7 is quantum chain index 7");
    r.eq(spendingDerivationPath(7), "m/44'/111111'/1'/0/7", "path: index 7 stays on the legacy chain");
  }
  // The batch derivation (Discover, the address list) agrees with the single one, across the base.
  {
    const range = deriveSpendingAddressRange(kaspa, WORDS, "", { start: B, count: 3 });
    r.eq(range.map((e) => e.address).join(","), quantumExpected.map((e) => e.address).join(","), "derivation: the range derivation gives the same quantum addresses");
    const legacyRange = deriveSpendingAddressRange(kaspa, WORDS, "", { start: 0, count: 3 });
    r.eq(legacyRange.map((e) => e.address).join(","), legacyExpected.join(","), "derivation: the range derivation keeps the legacy chain");
  }
  // Testnet: the same script under kaspatest.
  r.eq(Q.quantumAddressForRedeem(quantumWallets[0].redeemScript, "kaspatest"), kaspa.addressFromScriptPublicKey(kaspa.payToScriptHashScript(quantumWallets[0].redeemScript), "testnet-10").toString(), "address: testnet prefix matches the SDK's");

  // MARK: Script and address
  for (const [n, w] of quantumWallets.entries()) {
    const redeem = w.redeemScript;
    const spk = p2shScript(redeem);
    r.eq(hex(spk), `aa20${hex(blake(redeem))}87`, `script #${n}: OP_BLAKE2B <blake2b(redeem)> OP_EQUAL`);
    r.eq(hex(spk), scriptOf(kaspa.payToScriptHashScript(redeem)), `script #${n}: the registry codec's P2SH equals the SDK's payToScriptHashScript`);
    r.eq(hex(spk), scriptOf(kaspa.ScriptBuilder.fromScript(redeem).createPayToScriptHashScript()), `script #${n}: equals the SDK ScriptBuilder's (the KNS commit's construction)`);
    r.eq(w.address, p2shAddress(spk), `address #${n}: the .kachat registry helper p2shAddress gives the same address`);
    r.eq(w.address, kaspa.addressFromScriptPublicKey(kaspa.payToScriptHashScript(redeem), NET).toString(), `address #${n}: the SDK's address for that script agrees`);
    // address -> scriptPublicKey round trips, so a sighash uses the right script
    r.eq(scriptOf(kaspa.payToAddressScript(w.address)), hex(spk), `round trip #${n}: SDK payToAddressScript(address) is the P2SH script`);
    r.eq(hex(scriptPublicKeyFromAddress(w.address)), hex(spk), `round trip #${n}: payment-signatures scriptPublicKeyFromAddress agrees`);
    const decoded = decodeAddress(w.address);
    r.check(decoded.version === AddressVersion.scriptHash && hex(decoded.payload) === hex(blake(redeem)), `round trip #${n}: version 8, payload blake2b(redeem)`);
    r.check(Q.isP2shScript(spk) && !Q.isP2shScript(p2pkScript(redeem.slice(1, 33))), `script #${n}: isP2shScript tells P2SH from P2PK`);
  }

  // MARK: Index mapping (1,000,000 + n <-> "Address #n")
  r.check(!Q.isQuantumIndex(0) && !Q.isQuantumIndex(999_999) && Q.isQuantumIndex(1_000_000), "index: the base is the first quantum index");
  r.eq(Q.spendingIndexTitle(3), "Address #3", "index: a legacy row reads Address #3");
  r.eq(Q.spendingIndexTitle(B), "Address #0", "index: quantum base reads Address #0 (e001786)");
  r.eq(Q.spendingIndexTitle(B + 12), "Address #12", "index: quantum base+12 reads Address #12, not 1000012");
  r.eq(Q.chainLocalIndex(B + 4), 4, "index: chain-local number for the toast");
  // A quantum primary never widens the legacy chain; old records read as "no quantum slot yet".
  {
    const old = Q.spendingStateFromRecord({ activeIndex: 2, maxIndex: 7, hidden: [1], labels: { 1: "x" } });
    r.check(old.qMaxIndex === -1 && old.activeIndex === 2 && old.maxIndex === 7, "state: a record from before the port has no quantum slot");
    const rotated = Q.spendingRecordFromState({ ...old, activeIndex: B + 4 }, { activeIndex: 2, maxIndex: 7 });
    r.check(rotated.activeIndex === 2 && rotated.qActive === 4 && rotated.maxIndex === 7 && rotated.qMaxIndex === 4, `state: a quantum primary is stored apart, legacy bound untouched (${JSON.stringify(rotated)})`);
    const back = Q.spendingStateFromRecord(rotated);
    r.check(back.activeIndex === B + 4 && back.maxIndex === 7 && back.qMaxIndex === 4, "state: and reads back as public index base+4");
    const shrunk = Q.spendingRecordFromState({ ...back, qMaxIndex: 1, qSpent: [] }, rotated);
    r.eq(shrunk.qMaxIndex, 4, "state: the quantum bound only grows");
    // iOS 28ecee0: a quantum-space value in a legacy field never widens the legacy chain.
    const strayActive = Q.spendingStateFromRecord({ activeIndex: B + 3, maxIndex: 5 });
    r.check(strayActive.maxIndex === 5 && strayActive.activeIndex === B + 3 && strayActive.qMaxIndex === 3, `state: a quantum primary stored in activeIndex is read as quantum, legacy bound untouched (${JSON.stringify(strayActive)})`);
    const strayMax = Q.spendingStateFromRecord({ activeIndex: 2, maxIndex: B + 9 });
    r.check(strayMax.maxIndex === 2 && Q.revealedSpendingIndices(strayMax).length === 3, `state: a stored legacy max in quantum space is ignored (${JSON.stringify(strayMax)})`);
    const marked = Q.spendingRecordFromState({ ...back, qSpent: ["KASPA:PABC"] }, rotated);
    r.eq(Q.spendingRecordFromState({ ...Q.spendingStateFromRecord(marked), qSpent: [] }, marked).qSpent.join(), "kaspa:pabc", "state: a spent mark is never unmarked");
    r.eq(Q.revealedSpendingIndices({ maxIndex: 1, qMaxIndex: 1 }).join(","), `0,1,${B},${B + 1}`, "state: revealed indices cover both chains");
    r.eq(Q.revealedSpendingIndices({ maxIndex: 0, qMaxIndex: -1 }).join(","), "0", "state: no quantum slot, legacy only");
  }

  // MARK: Change goes to a fresh quantum slot
  {
    const fresh = Q.nextFreshQuantumIndex(4);
    r.eq(fresh, B + 5, "change: the next fresh slot is one past the quantum bound");
    r.eq(Q.nextFreshQuantumIndex(-1), B, "change: the first quantum slot when none was revealed");
    r.eq(Q.spendingChangeIndex({ purpose: "payment", sourceIndex: 3, primaryIndex: 0, qMaxIndex: 4 }), fresh, "change: a chat payment from ANY spending address lands on a fresh quantum slot");
    r.eq(Q.spendingChangeIndex({ purpose: "withdraw", sourceIndex: B + 1, primaryIndex: 0, qMaxIndex: 4 }), fresh, "change: a quantum source always rotates (never back to a revealed key)");
    r.eq(Q.spendingChangeIndex({ purpose: "withdraw", sourceIndex: 2, primaryIndex: 2, qMaxIndex: 4 }), fresh, "change: the legacy primary rotates onto a fresh quantum slot");
    r.eq(Q.spendingChangeIndex({ purpose: "withdraw", sourceIndex: 3, primaryIndex: 2, qMaxIndex: 4 }), null, "change: a legacy non-primary keeps same-address change, as before");
    r.eq(Q.spendingChangeIndex({ purpose: "withdraw", sourceIndex: B + 1, primaryIndex: B + 1, qMaxIndex: 4, selfSend: true }), null, "change: Compound (a self-send) consolidates into the address");
    r.eq(Q.spendingChangeIndex({ purpose: "kns", sourceIndex: 2, primaryIndex: 2, qMaxIndex: 4 }), fresh, "change: a KNS transfer from the primary rotates onto a fresh quantum slot");
    r.eq(Q.spendingChangeIndex({ purpose: "kns", sourceIndex: 3, primaryIndex: 2, qMaxIndex: 4 }), null, "change: a KNS transfer from another address keeps its change");
  }

  // MARK: Mass and fee for the bigger input
  {
    r.eq(Q.KIP22_SIGNATURE_SCRIPT_SIZE - Q.SCHNORR_SIGNATURE_SCRIPT_SIZE, 35, "mass: a KIP-22 signature script is 35 bytes bigger");
    for (let n = 1; n <= 5; n += 1) {
      const shape = { inputSigScriptLens: Array(n).fill(66), outputScriptLens: [34, 35], payloadLength: 0 };
      r.eq(Q.kip22ExtraFeeMass(shape, n), 35n * BigInt(n), `mass: ${n} quantum input(s) cost exactly 35 grams each`);
      r.eq(calculateMass(n, [34, 35], 0, 1, Q.KIP22_SIGNATURE_SCRIPT_SIZE) - calculateMass(n, [34, 35], 0), 35n * BigInt(n), `mass: ui/kspt calculateMass prices ${n} quantum input(s) 35 grams each`);
      r.eq(Q.txFeeMass(shape), calculateMass(n, [34, 35], 0), `mass: engine/quantum txFeeMass agrees with ui/kspt calculateMass (${n} inputs)`);
    }
    // A big payload makes the size term lead: then a byte counts twice, and so does the estimate.
    const heavy = { inputSigScriptLens: [66], outputScriptLens: [34], payloadLength: 4000 };
    r.eq(Q.kip22ExtraFeeMass(heavy, 1), 70n, "mass: when 2 grams/byte leads, the extra 35 bytes cost 70 grams");
  }

  // MARK: A quantum spend, built and signed by the engine against fake coins
  const src = quantumWallets[1];
  const changeWallet = quantumWallets[2];
  const dest = legacyExpected[0];
  const legacySrc = deriveSpendingWallet(kaspa, WORDS, 1);
  {
    const rpc = stubRpc();
    rpc.utxos.set(src.address, [coin(src.address, 150n * KAS), coin(src.address, 70n * KAS)]);
    const sent = await sendKaspa({ kaspa, rpc, privateKey: src.privateKey, sourceAddress: src.address, destinationAddress: dest, amountKas: "200", changeAddress: changeWallet.address, redeemScript: src.redeemScript });
    r.eq(rpc.submitted.length, 1, "spend: one transaction would be submitted");
    const tx = rpc.submitted[0];
    r.eq(sent.txids[0], String(tx.id), "spend: the txid returned is the transaction's");
    const inputs = [...tx.inputs];
    r.eq(inputs.length, 2, "spend: both coins are spent");
    const model = Q.sighashModelOfSdkTransaction(tx);
    const tail = `22${hex(src.redeemScript)}`;
    for (const [i, input] of inputs.entries()) {
      const script = unhex(String(input.signatureScript));
      r.eq(script.length, 101, `spend input ${i}: signature script is 101 bytes`);
      r.eq(script[0], 0x41, `spend input ${i}: push 65 (0x41)`);
      r.eq(script[65], 0x01, `spend input ${i}: SIGHASH_ALL after the 64-byte signature`);
      r.eq(script[66], 0x22, `spend input ${i}: push 34 (0x22) for the redeem script`);
      r.eq(hex(script.slice(66)), tail, `spend input ${i}: the redeem script follows, exactly iOS's buildCanonicalPushData`);
      // the KNS reveal's helper builds the same script from the same signature
      const viaKns = kaspa.ScriptBuilder.fromScript(src.redeemScript).encodePayToScriptHashSignatureScript(hex(script.slice(0, 66)));
      r.eq(String(viaKns).toLowerCase(), hex(script), `spend input ${i}: identical to ScriptBuilder.encodePayToScriptHashSignatureScript (the KNS reveal's pattern)`);
      // the sighash hashes the spent UTXO's P2SH scriptPublicKey...
      const p2sh = unhex(scriptOf(input.utxo.scriptPublicKey));
      r.eq(hex(p2sh), hex(p2shScript(src.redeemScript)), `spend input ${i}: the spent UTXO's script is the P2SH`);
      const sighash = computeSighash(model, i, p2sh, BigInt(input.utxo.amount));
      r.check(schnorr.verify(script.slice(1, 65), sighash, unhex(src.xOnlyPublicKeyHex)), `spend input ${i}: Schnorr signature verifies over the P2SH sighash (payment-signatures computeSighash)`);
      // ...and not the redeem script
      const wrong = computeSighash(model, i, src.redeemScript, BigInt(input.utxo.amount));
      r.check(!schnorr.verify(script.slice(1, 65), wrong, unhex(src.xOnlyPublicKeyHex)), `spend input ${i}: the signature does NOT verify over a redeem-script sighash`);
    }
    const outputs = [...tx.outputs];
    r.eq(BigInt(outputs[0].value), 200n * KAS, "spend: the recipient gets the amount");
    r.eq(scriptOf(outputs[0].scriptPublicKey), scriptOf(kaspa.payToAddressScript(dest)), "spend: to the recipient");
    r.eq(scriptOf(outputs[1].scriptPublicKey), hex(p2shScript(changeWallet.redeemScript)), "spend: change lands on the fresh quantum address");
    const fee = inputs.reduce((s, i) => s + BigInt(i.utxo.amount), 0n) - outputs.reduce((s, o) => s + BigInt(o.value), 0n);
    const realMass = Q.signedSdkTransactionComputeMass(tx);
    r.eq(fee, realMass * 100n, `spend: fee is exactly the real (101-byte) compute mass at 100 sompi/gram (fee ${fee}, mass ${realMass})`);
    r.check(Q.verifyKip22Spend(tx, src.redeemScript), "spend: the engine's own offline check passes");

    // The same send from a legacy address: the fee differs by exactly 35 grams per input.
    const rpc2 = stubRpc();
    rpc2.utxos.set(legacySrc.address, [coin(legacySrc.address, 150n * KAS), coin(legacySrc.address, 70n * KAS)]);
    await sendKaspa({ kaspa, rpc: rpc2, privateKey: legacySrc.privateKey, sourceAddress: legacySrc.address, destinationAddress: dest, amountKas: "200", changeAddress: changeWallet.address });
    const ltx = rpc2.submitted[0];
    const lfee = [...ltx.inputs].reduce((s, i) => s + BigInt(i.utxo.amount), 0n) - [...ltx.outputs].reduce((s, o) => s + BigInt(o.value), 0n);
    r.eq(fee - lfee, 35n * 2n * 100n, "spend: a quantum source pays exactly 35 grams x 2 inputs more than a legacy one");
    // SDK rate pin: the generator's own fee for a plain spend is its compute mass x 100.
    r.eq(lfee, Q.signedSdkTransactionComputeMass(ltx) * 100n, "rate: the SDK generator charges 100 sompi per gram of compute mass");
    r.eq([...ltx.inputs][0].signatureScript.length / 2, 66, "spend: a plain Schnorr input is unchanged (66 bytes)");

    // The estimate the screens show prices the bigger input too.
    const rpc3 = stubRpc();
    rpc3.utxos.set(src.address, [coin(src.address, 150n * KAS), coin(src.address, 70n * KAS)]);
    rpc3.utxos.set(legacySrc.address, [coin(legacySrc.address, 150n * KAS), coin(legacySrc.address, 70n * KAS)]);
    const qEst = await estimateOnchainFeeDetail({ kaspa, rpc: rpc3, sourceAddress: src.address, amountKas: "200" });
    const lEst = await estimateOnchainFeeDetail({ kaspa, rpc: rpc3, sourceAddress: legacySrc.address, amountKas: "200" });
    // The estimate is a self-send (output and change to the source), so its two outputs are P2SH
    // too: one script byte more each, 11 grams (1 byte + 10 per script byte). The rest is the
    // inputs' 35 grams each.
    const outputsExtra = 2n * 11n;
    r.eq(qEst.massGrams - lEst.massGrams, 70n + outputsExtra, "estimate: the mass estimate adds 35 grams x 2 inputs (plus the P2SH outputs' byte)");
    r.eq(qEst.feeSompi - lEst.feeSompi, (70n + outputsExtra) * 100n, "estimate: the fee estimate adds 35 grams x 2 inputs x 100 (plus the outputs')");
  }

  // MARK: Max and Compound (hand-built transactions) sign the same way
  {
    const rpc = stubRpc();
    rpc.utxos.set(src.address, [coin(src.address, 3n * KAS), coin(src.address, 2n * KAS), coin(src.address, KAS)]);
    const est = await estimateMaxSend({ kaspa, rpc, sourceAddress: src.address, destinationAddress: dest });
    const sent = await sendMaxKaspa({ kaspa, rpc, privateKey: src.privateKey, sourceAddress: src.address, destinationAddress: dest, redeemScript: src.redeemScript, expectedAmountSompi: est.amountSompi, expectedOutpoints: est.outpoints });
    const tx = rpc.submitted[0];
    r.eq([...tx.outputs].length, 1, "max: one output, no change");
    r.eq(sent.amountSompi, est.amountSompi, "max: sends the estimated amount");
    r.check([...tx.inputs].every((i) => i.signatureScript.length / 2 === 101), "max: every input carries the KIP-22 signature script");
    r.check(Q.verifyKip22Spend(tx, src.redeemScript), "max: signatures verify offline");
    r.check(sent.feeSompi >= Q.signedSdkTransactionComputeMass(tx) * 100n, "max: the fee covers the real mass");
    const draft = kaspa.createTransaction([...rpc.utxos.get(src.address)], [{ address: dest, amount: 5n * KAS }], 0n);
    r.eq(floorFeeSompiFor(kaspa, draft) - BigInt(kaspa.calculateTransactionFee(NET, draft, 1)), 35n * 3n * 100n, "max: the floor adds 35 grams x 3 inputs over the SDK's");

    const rpc2 = stubRpc();
    rpc2.utxos.set(src.address, [coin(src.address, 3n * KAS), coin(src.address, 2n * KAS)]);
    await sweepAllToSelf({ kaspa, rpc: rpc2, privateKey: src.privateKey, sourceAddress: src.address, redeemScript: src.redeemScript });
    const ctx = rpc2.submitted[0];
    r.eq([...ctx.outputs].length, 1, "compound: one output");
    r.eq(scriptOf([...ctx.outputs][0].scriptPublicKey), hex(p2shScript(src.redeemScript)), "compound: consolidates into the address itself");
    r.check(Q.verifyKip22Spend(ctx, src.redeemScript), "compound: signatures verify offline");
  }

  // MARK: Refusals (nothing is submitted)
  {
    const rpc = stubRpc();
    rpc.utxos.set(src.address, [coin(src.address, 5n * KAS)]);
    await r.throws(() => sendKaspa({ kaspa, rpc, privateKey: src.privateKey, sourceAddress: src.address, destinationAddress: dest, amountKas: "1" }),
      (e) => /quantum-safe address/.test(e.message), "refuse: P2SH coins without the redeem script");
    await r.throws(() => sendKaspa({ kaspa, rpc, privateKey: src.privateKey, sourceAddress: src.address, destinationAddress: dest, amountKas: "1", redeemScript: changeWallet.redeemScript }),
      (e) => /does not belong/.test(e.message), "refuse: another address's redeem script");
    await r.throws(() => sendMaxKaspa({ kaspa, rpc, privateKey: src.privateKey, sourceAddress: src.address, destinationAddress: dest }),
      (e) => /quantum-safe address/.test(e.message), "refuse: Max from P2SH coins without the redeem script");
    await r.throws(() => sweepAllToSelf({ kaspa, rpc, privateKey: changeWallet.privateKey, sourceAddress: src.address, redeemScript: src.redeemScript }),
      (e) => /quantum-safe signature does not verify/.test(e.message), "refuse: a key that is not the redeem script's (the offline check catches it)");
    r.eq(rpc.submitted.length, 0, "refuse: nothing was submitted");
    // A tampered signature script is caught by the offline check.
    const tx = kaspa.createTransaction([...rpc.utxos.get(src.address)], [{ address: dest, amount: 4n * KAS }], 0n);
    const sig = kaspa.createInputSignature(tx, 0, src.privateKey, kaspa.SighashType.All);
    const bad = unhex(sig); bad[10] ^= 1;
    tx.inputs = [...tx.inputs].map((input) => { input.signatureScript = hex(Q.kip22SignatureScript(bad, src.redeemScript)); return input; });
    let caught = false;
    try { Q.verifyKip22Spend(tx, src.redeemScript); } catch { caught = true; }
    r.check(caught, "refuse: a flipped signature bit fails the offline check");
    let malformed = false;
    try { Q.kip22SignatureScript(unhex(sig).slice(1), src.redeemScript); } catch { malformed = true; }
    r.check(malformed, "refuse: a signature not in 0x41 <64> 0x01 form is never wrapped");
  }

  // MARK: Restore scans the quantum chain
  {
    const addr = (i) => `kaspa:q${i}`;
    const derive = async (start, end) => { const m = new Map(); for (let i = start; i < end; i += 1) m.set(i, addr(i)); return m; };
    const touched = new Set([B + 0, B + 3, B + 9]);
    const funded = new Set([B + 3, B + 9]);
    const asked = [];
    const result = await discoverQuantumMatches({
      derive,
      activity: async (list) => { r.eq(list.length, Q.QUANTUM_SCAN_FLOOR, "restore: the activity filter sees the whole 200-slot window"); return new Map(list.filter((a) => touched.has(Number(a.slice(7)))).map((a) => [a, 1])); },
      fundedAmong: async (list) => { asked.push(...list); return new Set(list.filter((a) => funded.has(Number(a.slice(7))))); },
      base: B,
      floor: Q.QUANTUM_SCAN_FLOOR,
    });
    r.eq(asked.length, 3, "restore: balances asked only of touched slots");
    r.eq([...result.matchedIndices].sort((a, b) => a - b).join(","), `${B + 3},${B + 9}`, "restore: funded slots match");
    const applied = applyQuantumDiscovery({ qMaxIndex: 1, hidden: [B + 3] }, result, B);
    r.eq(applied.qMaxIndex, 9, "restore: the quantum bound covers the highest match");
    r.check(!applied.hidden.includes(B + 3) && !applied.hidden.includes(B + 9), "restore: matches are shown");
    r.eq(applied.hidden.join(","), [2, 4, 5, 6, 7, 8].map((n) => B + n).join(","), "restore: the empty slots swept in stay hidden");
    const noRoute = await discoverQuantumMatches({ derive, activity: async () => null, fundedAmong: async (list) => new Set(list.filter((a) => a === addr(B + 150))), base: B, floor: Q.QUANTUM_SCAN_FLOOR });
    r.eq([...noRoute.matchedIndices].join(), String(B + 150), "restore: without the bulk route, balances of the whole window decide");
  }

  // MARK: Restore keeps sweeping while a window shows activity (iOS da2c8e2, IOS-101)
  {
    const addr = (i) => `kaspa:q${i}`;
    const idx = (a) => Number(a.slice(7));
    const derive = async (start, end) => { const m = new Map(); for (let i = start; i < end; i += 1) m.set(i, addr(i)); return m; };
    const sweep = async ({ touched, funded, activityAvailable = true, limit = Q.QUANTUM_SCAN_LIMIT, fundedFails = false }) => {
      const windows = [];
      const result = await discoverQuantumMatches({
        derive,
        activity: async (list) => { windows.push(idx(list[0]) - B); return activityAvailable ? new Map(list.filter((a) => touched.has(idx(a))).map((a) => [a, 1])) : null; },
        fundedAmong: async (list) => { if (fundedFails) throw new Error("node down"); return new Set(list.filter((a) => funded.has(idx(a)))); },
        base: B,
        floor: Q.QUANTUM_SCAN_FLOOR,
        limit,
      });
      return { result, windows };
    };
    r.eq(Q.QUANTUM_SCAN_FLOOR, 200, "restore: a step is 200 slots (iOS quantumScanFloor)");
    r.eq(Q.QUANTUM_SCAN_LIMIT, 10_000, "restore: the sweep stops at 10,000 at the latest (iOS quantumScanLimit)");

    // Funds past slot 199 (the old fixed window's miss): activity in 0-199, 200-399 and 400-599 keeps
    // the sweep going; the first quiet window (600-799) ends it.
    const deep = await sweep({ touched: new Set([B + 5, B + 250, B + 450]), funded: new Set([B + 450]) });
    r.eq(deep.windows.join(","), "0,200,400,600", "restore: steps on while a window shows activity, stops at the first quiet one");
    r.eq([...deep.result.matchedIndices].join(","), String(B + 450), "restore: a funded slot past 199 is found");
    r.eq(deep.result.highestUsed, 450, "restore: the chain's end comes from the deepest used slot");
    // A used-but-empty slot past the deepest funded one still sets the end.
    const usedPast = await sweep({ touched: new Set([B + 100, B + 330]), funded: new Set([B + 100]) });
    r.eq(usedPast.result.highestUsed, 330, "restore: a used, unfunded slot counts toward the end, not only funded ones");
    const appliedUsed = applyQuantumDiscovery({ qMaxIndex: -1, hidden: [] }, usedPast.result, B);
    r.eq(appliedUsed.qMaxIndex, 330, "restore: the quantum bound goes past every used slot");
    r.check(!appliedUsed.hidden.includes(B + 100), "restore: the funded slot is shown");
    r.check(appliedUsed.hidden.includes(B + 330) && appliedUsed.hidden.includes(B + 0) && appliedUsed.hidden.length === 330,
      "restore: every other slot swept in stays hidden, the used-but-empty end slot included");
    r.eq(Q.nextFreshQuantumIndex(appliedUsed.qMaxIndex), B + 331, "restore: the next fresh slot is past the deepest used one");
    // A quiet window ends it even when something sits further on (one window of gap, as iOS).
    const gap = await sweep({ touched: new Set([B + 150, B + 1000]), funded: new Set([B + 1000]) });
    r.eq(gap.windows.join(","), "0,200", "restore: a whole quiet window ends the sweep");
    r.eq(gap.result.matchCount, 0, "restore: nothing past a quiet window is looked at");
    r.eq(gap.result.highestUsed, 150, "restore: the end still covers the used slot before the gap");
    // Without the bulk route only the first window's balances can be read, as before.
    const noRoute = await sweep({ touched: new Set(), funded: new Set([B + 150, B + 300]), activityAvailable: false });
    r.eq(noRoute.windows.join(","), "0", "restore: without the bulk route the sweep stops after the first window");
    r.eq([...noRoute.result.matchedIndices].join(","), String(B + 150), "restore: without the bulk route, the first window's balances decide");
    r.eq(noRoute.result.highestUsed, 150, "restore: without the bulk route the end comes from the funded slot");
    // Balances unreadable: nothing is shown, but the end still goes past the used slots.
    const noBalances = await sweep({ touched: new Set([B + 7, B + 260]), funded: new Set([B + 7]), fundedFails: true });
    r.eq(noBalances.result.matchCount, 0, "restore: unreadable balances show nothing");
    r.eq(noBalances.result.highestUsed, 260, "restore: unreadable balances still raise the end past used slots");
    r.eq(noBalances.windows.join(","), "0,200,400", "restore: unreadable balances don't stop the activity sweep");
    // Busy forever: the limit ends it.
    const busy = await sweep({ touched: { has: () => true }, funded: new Set(), limit: 1000 });
    r.eq(busy.windows.length, 5, "restore: the sweep never passes its limit");
    r.eq(busy.result.highestUsed, 999, "restore: the end covers the whole swept range");
    const busyFull = await sweep({ touched: { has: () => true }, funded: new Set() });
    r.eq(busyFull.windows.length, 50, "restore: at most 10,000 slots (50 windows of 200)");
    // The bound only grows.
    r.eq(applyQuantumDiscovery({ qMaxIndex: 900, hidden: [] }, usedPast.result, B).qMaxIndex, 900, "restore: a lower end never lowers the bound");
  }

  // MARK: Fresh slots are checked on chain before use (iOS da2c8e2 verifiedFreshQuantumIndex)
  {
    const addr = (i) => `kaspa:q${i}`;
    const run = async ({ qMaxIndex, used, unknown = new Set(), limit, failAddressAt = null }) => {
      const asked = [];
      const raised = [];
      let bound = qMaxIndex;
      const index = await Q.verifiedFreshQuantumIndex({
        qMaxIndex,
        addressAt: (i) => (i === failAddressAt ? null : addr(i)),
        usedState: async (a) => { const i = Number(a.slice(7)); asked.push(i - B); if (unknown.has(i)) return null; return used.has(i); },
        raiseBound: (q) => { raised.push(q); bound = Math.max(bound, q); },
        ...(limit != null ? { limit } : {}),
      });
      return { index, asked, raised, bound };
    };
    const clean = await run({ qMaxIndex: 4, used: new Set() });
    r.eq(clean.index, B + 5, "fresh: an unused next slot is taken as is");
    r.eq(clean.asked.join(","), "5", "fresh: the slot is asked about before use");
    r.eq(clean.raised.length, 0, "fresh: nothing raised for an unused slot");
    const skip = await run({ qMaxIndex: 4, used: new Set([B + 5, B + 6]) });
    r.eq(skip.index, B + 7, "fresh: used slots are skipped");
    r.eq(skip.raised.join(","), "5,6", "fresh: the chain's end is raised past each used slot");
    r.eq(skip.bound, 6, "fresh: the stored bound ends past the used slots");
    const empty = await run({ qMaxIndex: -1, used: new Set([B + 0]) });
    r.eq(empty.index, B + 1, "fresh: a chain with no slots yet still checks slot 0");
    const unknownAnswer = await run({ qMaxIndex: 4, used: new Set([B + 5]), unknown: new Set([B + 5]) });
    r.eq(unknownAnswer.index, B + 5, "fresh: a check that can't be answered takes the slot (a REST outage never blocks a send)");
    const throwing = await Q.verifiedFreshQuantumIndex({ qMaxIndex: 2, addressAt: addr, usedState: async () => { throw new Error("offline"); } });
    r.eq(throwing, B + 3, "fresh: a check that throws takes the slot");
    const underivable = await run({ qMaxIndex: 4, used: new Set([B + 5]), failAddressAt: B + 5 });
    r.eq(underivable.index, B + 5, "fresh: an underivable slot is returned unchecked (the caller decides)");
    r.eq(underivable.asked.length, 0, "fresh: nothing to ask without an address");
    const allUsed = await run({ qMaxIndex: 4, used: { has: () => true } });
    r.eq(Q.FRESH_QUANTUM_PROBE_LIMIT, 20, "fresh: at most 20 skips (iOS)");
    r.eq(allUsed.asked.length, 20, "fresh: the check stops after 20 used slots");
    r.eq(allUsed.index, B + 25, "fresh: after 20 skips the next slot is taken");
  }

  // MARK: Generate New Address and the Request Payment preview check the slot too (iOS 2343e84,
  // IOS-101 narrowed): ui/app.js revealNextSpendingAddress's fresh path and openCreatePaymentRequest's
  // Fresh Address preview go through verifiedFreshQuantumSlot, never the unchecked next index.
  {
    const app = readFileSync(join(repo, "ui/app.js"), "utf8");
    const body = (name) => {
      const at = app.indexOf(`function ${name}(`);
      if (at < 0) return "";
      const next = app.slice(at + 10).search(/\n(?:async )?function /);
      return next < 0 ? app.slice(at) : app.slice(at, at + 10 + next);
    };
    const generate = body("revealNextSpendingAddress");
    const request = body("openCreatePaymentRequest");
    r.check(generate.length > 0 && request.length > 0, "fresh-slot use: both functions found in ui/app.js");
    r.check(/readyIndex = await verifiedFreshQuantumSlot\(\)/.test(generate), "fresh-slot use: Generate takes a checked slot");
    r.check(!/nextFreshQuantumIndex\(/.test(generate), "fresh-slot use: Generate never takes the unchecked next index");
    r.check(/await verifiedFreshQuantumSlot\(\)/.test(request), "fresh-slot use: the Request Payment preview shows a checked slot");
    r.check(!/nextFreshQuantumIndex\(/.test(request), "fresh-slot use: the preview never shows the unchecked next index");
    r.check(!/nextFreshQuantumIndex\(/.test(app), "fresh-slot use: no unchecked fresh slot anywhere in ui/app.js");
    // Generate's write, replayed on the pure part: the bound lands on the checked slot, past the
    // used ones, and that slot is shown (un-hidden).
    let bound = 4;
    const used = new Set([B + 5, B + 6]);
    const readyIndex = await Q.verifiedFreshQuantumIndex({ qMaxIndex: bound, addressAt: (i) => `kaspa:q${i}`, usedState: async (a) => used.has(Number(a.slice(7))), raiseBound: (q) => { bound = Math.max(bound, q); } });
    const hidden = new Set([B + 7, B + 3]);
    hidden.delete(readyIndex);
    r.eq(readyIndex, B + 7, "Generate: slots used elsewhere are skipped");
    r.eq(Q.chainLocalIndex(readyIndex), 7, "Generate: the saved bound is the checked slot");
    r.eq(hidden.has(B + 7), false, "Generate: the new slot is shown");
  }

  // MARK: A quantum source never takes change back (iOS da2c8e2, IOS-104)
  {
    r.eq(Q.QUANTUM_CHANGE_UNAVAILABLE, "Couldn't prepare the next address. Try again.", "no-change-to-source: the iOS error text");
    const rule = (args) => Q.freshChangeRequired({ ...args, freshIndex: Q.spendingChangeIndex({ qMaxIndex: 4, primaryIndex: 0, ...args }) });
    r.eq(rule({ purpose: "payment", sourceIndex: B + 2 }), true, "no-change-to-source: a chat payment from a quantum source must have its fresh slot");
    r.eq(rule({ purpose: "payment", sourceIndex: 3 }), false, "no-change-to-source: a chat payment from a legacy source may fall back to itself");
    r.eq(rule({ purpose: "withdraw", sourceIndex: B + 2 }), true, "no-change-to-source: a Manage Addresses send from a quantum source must have its fresh slot");
    r.eq(rule({ purpose: "withdraw", sourceIndex: B + 2, primaryIndex: B + 2 }), true, "no-change-to-source: a quantum primary too");
    r.eq(rule({ purpose: "withdraw", sourceIndex: 0 }), false, "no-change-to-source: the legacy primary keeps its fallback");
    r.eq(rule({ purpose: "withdraw", sourceIndex: 3 }), false, "no-change-to-source: a legacy non-primary keeps same-address change");
    r.eq(rule({ purpose: "withdraw", sourceIndex: B + 2, selfSend: true }), false, "no-change-to-source: Compound (a self-send) still consolidates in place");
    r.eq(rule({ purpose: "kns", sourceIndex: B + 2, primaryIndex: B + 2 }), false, "no-change-to-source: a KNS transfer is unchanged");
    // The app's change helpers (ui/app.js freshChangeForSpendingIndex / freshSpendingChangeAddress),
    // replayed on the pure parts: derivation fails -> a quantum source throws, a legacy one returns null.
    const pick = async ({ purpose, sourceIndex, derivable }) => {
      const ruleIndex = Q.spendingChangeIndex({ purpose, sourceIndex, primaryIndex: 0, qMaxIndex: 4 });
      if (ruleIndex == null) return null;
      const freshIndex = await Q.verifiedFreshQuantumIndex({ qMaxIndex: 4, addressAt: () => (derivable ? "kaspa:qfresh" : null), usedState: async () => false });
      const address = derivable ? "kaspa:qfresh" : null;
      if (address) return { index: freshIndex, address };
      if (Q.freshChangeRequired({ purpose, sourceIndex, freshIndex: ruleIndex })) throw new Error(Q.QUANTUM_CHANGE_UNAVAILABLE);
      return null;
    };
    await r.throws(() => pick({ purpose: "payment", sourceIndex: B + 1, derivable: false }), (e) => e.message === Q.QUANTUM_CHANGE_UNAVAILABLE, "no-change-to-source: a quantum payment with no fresh slot throws");
    await r.throws(() => pick({ purpose: "withdraw", sourceIndex: B + 1, derivable: false }), (e) => e.message === Q.QUANTUM_CHANGE_UNAVAILABLE, "no-change-to-source: a quantum send with no fresh slot throws");
    r.eq(await pick({ purpose: "withdraw", sourceIndex: 0, derivable: false }), null, "no-change-to-source: a legacy primary with no fresh slot falls back (change to source)");
    r.eq((await pick({ purpose: "payment", sourceIndex: B + 1, derivable: true }))?.index, B + 5, "no-change-to-source: a derivable fresh slot is used");
  }

  // MARK: The shield reads the full history (iOS da2c8e2, IOS-105)
  {
    const me = "kaspa:pqme";
    const history = (count, spendAt = -1) => Array.from({ length: count }, (_, i) => ({
      inputs: i === spendAt ? [{ previous_outpoint_address: me.toUpperCase() }] : [{ previous_outpoint_address: "kaspa:qsomeoneelse" }],
    }));
    const probe = async (txs, { failAt = -1 } = {}) => {
      const offsets = [];
      const answer = await Q.quantumSpentFromHistory(me, async (offset, limit) => {
        offsets.push(offset);
        r.eq(limit, 200, "shield: pages of 200");
        if (offset === failAt) return null;
        return txs.slice(offset, offset + limit);
      });
      return { answer, offsets };
    };
    const buried = await probe(history(450, 320));
    r.eq(buried.answer, true, "shield: a spend buried under later activity is found");
    r.eq(buried.offsets.join(","), "0,200", "shield: the walk stops at the page with the spend");
    const first = await probe(history(450, 3));
    r.eq(first.offsets.join(","), "0", "shield: a spend on the first page is one request");
    const never = await probe(history(450));
    r.eq(never.answer, false, "shield: a full history without a spend is 'not spent'");
    r.eq(never.offsets.join(","), "0,200,400", "shield: every page is read before saying 'not spent'");
    const exact = await probe(history(400));
    r.eq(exact.answer, false, "shield: a history that ends on a page boundary is read to the empty page");
    r.eq(exact.offsets.join(","), "0,200,400", "shield: the empty page ends it");
    const broken = await probe(history(450, 420), { failAt: 200 });
    r.eq(broken.answer, null, "shield: an unreadable page answers unknown, never 'not spent'");
    const deep = await probe(history(20_000, 15_000));
    r.eq(deep.answer, null, "shield: a history deeper than 10,000 transactions answers unknown");
    r.eq(deep.offsets.length, 50, "shield: at most 50 pages (10,000 transactions)");
    r.eq(await Q.quantumSpentFromHistory(me, async () => { throw new Error("offline"); }), null, "shield: a failing request answers unknown");
    r.eq(await Q.quantumSpentFromHistory(me, async () => ({ error: "bad" })), null, "shield: a malformed page answers unknown");
    r.eq(await Q.quantumSpentFromHistory("", async () => []), null, "shield: no address, no answer");
  }

  for (const f of r.failures) console.log(`FAIL ${f}`);
  console.log(`quantum addresses: ${r.pass} checks passed, ${r.fail} failed`);
  process.exit(r.fail ? 1 : 0);
}

await main();
