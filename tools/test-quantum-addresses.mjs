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

  for (const f of r.failures) console.log(`FAIL ${f}`);
  console.log(`quantum addresses: ${r.pass} checks passed, ${r.fail} failed`);
  process.exit(r.fail ? 1 : 0);
}

await main();
