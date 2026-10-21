// The change output is priced at ITS OWN script (iOS 40e8c50): change rotated onto a fresh
// quantum-safe (KIP-22) slot is a 35-byte P2SH script, a byte longer than P2PK - 11 mass grams -
// and KaChat's 100 sompi/gram is the network's minimum, not a margin above it, so a fee priced on
// the sender's 34-byte script would be ~1,100 sompi short of the built transaction's minimum.
// Desktop builds every change-carrying send through the Kaspa WASM generator, which sizes change
// from the change address itself; this pins that, for a legacy and a quantum source, plain and
// with a payload. Also pins two refusals ported alongside it:
// - iOS ca53cd1: a coin locked to another address is never signed with this key (Desktop has no
//   pending-coin cache; the SDK signer refuses before anything is submitted);
// - iOS 2a8ca5a: a .kas transfer out of a quantum-safe address, or to a script address, is refused
//   with iOS's text before anything is built.
// Offline only: fake coins, an in-memory RPC that records what would be submitted, nothing leaves
// the machine. Run from the repo root:
//
//   node tools/test-change-script-fee.mjs

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import * as Q from "../engine/quantum.js";
import { deriveSpendingWallet } from "../engine/wallet.js";
import { sendKaspa, sendMaxKaspa, sendPayloadToSelf } from "../engine/transactions.js";
import { transferDomain, KNS_QUANTUM_SOURCE_MESSAGE, KNS_SCRIPT_RECIPIENT_MESSAGE } from "../engine/kns-write.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");

const r = {
  pass: 0, fail: 0, failures: [],
  check(ok, label) { if (ok) this.pass++; else { this.fail++; this.failures.push(label); } },
  eq(a, b, label) { this.check(a === b, `${label}: got ${String(a)}, expected ${String(b)}`); },
  async throws(fn, pred, label) {
    try { await fn(); this.check(false, `${label}: did not throw`); } catch (e) { this.check(pred(e), `${label}: threw ${e?.message ?? e}`); }
  },
};

const kaspa = await import("../kaspa/kaspa.js");
await kaspa.default({ module_or_path: readFileSync(join(repo, "kaspa/kaspa_bg.wasm")) });

const KAS = 100_000_000n;
// Public all-zero-entropy 24-word BIP39 test mnemonic - not a real wallet.
const WORDS = [...Array(23).fill("abandon"), "art"].join(" ");
const B = Q.QUANTUM_INDEX_BASE;
const MIN_SOMPI_PER_GRAM = 100n;

let txCounter = 0;
const fakeTxid = () => (0xc4a000 + ++txCounter).toString(16).padStart(64, "0");
function coin(address, amountSompi, lockedTo = address) {
  return {
    address,
    outpoint: { transactionId: fakeTxid(), index: txCounter % 3 },
    amount: amountSompi,
    scriptPublicKey: kaspa.payToAddressScript(lockedTo),
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

/** Byte length of a script given as hex, bytes or an SDK ScriptPublicKey ({ script }). */
const scriptBytes = (script) => {
  const value = typeof script === "string" || script instanceof Uint8Array ? script : script?.script ?? "";
  return value instanceof Uint8Array ? value : { length: String(value).length / 2 };
};
const feeOf = (tx) => [...tx.inputs].reduce((s, i) => s + BigInt(i.utxo.amount), 0n) - [...tx.outputs].reduce((s, o) => s + BigInt(o.value), 0n);
/** The fee mass of the SIGNED transaction from its real scripts: max(compute mass, 2 grams a byte). */
function realFeeMass(tx) {
  const inputs = [...tx.inputs];
  return Q.txFeeMass({
    inputSigScriptLens: inputs.map((i) => scriptBytes(i?.signatureScript ?? "").length),
    outputScriptLens: [...tx.outputs].map((o) => scriptBytes(o?.scriptPublicKey).length),
    payloadLength: scriptBytes(tx?.payload ?? "").length,
    sigOpCounts: inputs.map((i) => Number(i?.sigOpCount ?? 1)),
  });
}
const outLens = (tx) => [...tx.outputs].map((o) => scriptBytes(o?.scriptPublicKey).length);

const legacySrc = deriveSpendingWallet(kaspa, WORDS, 1);
const legacyOther = deriveSpendingWallet(kaspa, WORDS, 2);
const quantumSrc = deriveSpendingWallet(kaspa, WORDS, B + 1);
const quantumChange = deriveSpendingWallet(kaspa, WORDS, B + 2);
const dest = deriveSpendingWallet(kaspa, WORDS, 0).address;

/** One send through the engine; returns the transaction that would have been submitted. */
async function sendOnce({ source, changeAddress, coins, amountKas = "200", payload = null, destination = dest, exactAmount = false }) {
  const rpc = stubRpc();
  rpc.utxos.set(source.address, coins.map((amount) => coin(source.address, amount)));
  await sendKaspa({
    kaspa, rpc, privateKey: source.privateKey, sourceAddress: source.address, destinationAddress: destination,
    amountKas, changeAddress, payload, exactAmount, redeemScript: source.redeemScript || null,
  });
  if (rpc.submitted.length !== 1) throw new Error(`expected one transaction, got ${rpc.submitted.length}`);
  return rpc.submitted[0];
}

async function main() {
  // MARK: The change output is priced at its own script (iOS 40e8c50)
  const shapes = [
    { label: "two coins", coins: [150n * KAS, 70n * KAS], amountKas: "200" },
    { label: "five coins", coins: [60n * KAS, 50n * KAS, 40n * KAS, 30n * KAS, 25n * KAS], amountKas: "190" },
    // a chat-payment-sized payload (iOS buildPaymentTx): the payload rides with quantum change
    { label: "with a payload", coins: [150n * KAS, 70n * KAS], amountKas: "200", payload: new Uint8Array(180).fill(7), exactAmount: true },
  ];
  for (const source of [legacySrc, quantumSrc]) {
    const kind = source.quantum ? "quantum source" : "legacy source";
    for (const shape of shapes) {
      const toQuantum = await sendOnce({ source, changeAddress: quantumChange.address, ...shape });
      const toLegacy = await sendOnce({ source, changeAddress: legacyOther.address, ...shape });
      const label = `${kind}, ${shape.label}`;
      r.eq(outLens(toQuantum).join(","), "34,35", `${label}: change lands on the 35-byte quantum P2SH`);
      r.eq(outLens(toLegacy).join(","), "34,34", `${label}: legacy change is a 34-byte P2PK`);
      const fee = feeOf(toQuantum);
      const mass = realFeeMass(toQuantum);
      r.check(fee >= mass * MIN_SOMPI_PER_GRAM, `${label}: quantum-change fee ${fee} covers the built transaction's real mass ${mass} x 100 (${mass * MIN_SOMPI_PER_GRAM})`);
      r.check(feeOf(toLegacy) >= realFeeMass(toLegacy) * MIN_SOMPI_PER_GRAM, `${label}: legacy-change fee covers its real mass x 100`);
      // The quantum change costs exactly its 11 extra grams (1 byte + 10 per script byte): the
      // change was priced on the change address's script, not the sender's.
      r.eq(fee - feeOf(toLegacy), 11n * MIN_SOMPI_PER_GRAM, `${label}: quantum change pays exactly 11 grams x 100 more than P2PK change`);
    }
  }
  // A KNS commit (an exact payment into a P2SH) with its change rotated to a quantum slot: two
  // 35-byte outputs, both priced.
  {
    const commitAddress = quantumSrc.address; // any P2SH destination
    const tx = await sendOnce({ source: legacySrc, changeAddress: quantumChange.address, coins: [5n * KAS], amountKas: "2", destination: commitAddress, exactAmount: true });
    r.eq(outLens(tx).join(","), "35,35", "kns-like commit: P2SH output and quantum change");
    r.check(feeOf(tx) >= realFeeMass(tx) * MIN_SOMPI_PER_GRAM, `kns-like commit: fee ${feeOf(tx)} covers real mass ${realFeeMass(tx)} x 100`);
  }

  // MARK: Another address's coin is never signed with this key (iOS ca53cd1)
  // Desktop asks the node for the sending address's coins on every send (no pending-coin cache);
  // even a node that listed a coin locked to another address gets it refused by the signer, before
  // anything is submitted.
  {
    const cases = [
      ["generator send", (rpc) => sendKaspa({ kaspa, rpc, privateKey: legacySrc.privateKey, sourceAddress: legacySrc.address, destinationAddress: dest, amountKas: "1" })],
      ["max send", (rpc) => sendMaxKaspa({ kaspa, rpc, privateKey: legacySrc.privateKey, sourceAddress: legacySrc.address, destinationAddress: dest })],
      ["self-stash", (rpc) => sendPayloadToSelf({ kaspa, rpc, privateKey: legacySrc.privateKey, sourceAddress: legacySrc.address, payload: new Uint8Array(40) })],
      ["message (one output, total minus fee)", (rpc) => sendKaspa({ kaspa, rpc, privateKey: legacySrc.privateKey, sourceAddress: legacySrc.address, destinationAddress: legacySrc.address, amountKas: "1.5", payload: new Uint8Array(40) })],
    ];
    for (const [label, run] of cases) {
      const rpc = stubRpc();
      rpc.utxos.set(legacySrc.address, [coin(legacySrc.address, 15n * KAS / 10n, legacyOther.address)]);
      await r.throws(() => run(rpc), (e) => /sign/i.test(String(e?.message ?? e)), `foreign coin, ${label}: refused at signing`);
      r.eq(rpc.submitted.length, 0, `foreign coin, ${label}: nothing submitted`);
    }
  }

  // MARK: KNS and quantum addresses (iOS 2a8ca5a)
  {
    const engine = { kaspa, address: legacySrc.address, privateKey: legacySrc.privateKey };
    const asset = "a".repeat(64) + "i0";
    await r.throws(
      () => transferDomain({ engine, domain: "example.kas", assetId: asset, toAddress: dest, signer: { privateKey: quantumSrc.privateKey, address: quantumSrc.address } }),
      (e) => e.message === KNS_QUANTUM_SOURCE_MESSAGE,
      "kns: a transfer out of a quantum-safe address is refused with iOS's text",
    );
    await r.throws(
      () => transferDomain({ engine, domain: "example.kas", assetId: asset, toAddress: quantumChange.address }),
      (e) => e.message === KNS_SCRIPT_RECIPIENT_MESSAGE,
      "kns: a transfer to a quantum-safe (P2SH) address is refused with iOS's text",
    );
    r.eq(KNS_QUANTUM_SOURCE_MESSAGE, "KNS can't move a domain out of a quantum-safe address: KNS identifies a domain's owner by a public key, and a quantum-safe address keeps its key hidden.", "kns: source text is iOS's");
    r.eq(KNS_SCRIPT_RECIPIENT_MESSAGE, "A .kas domain can't be sent to a quantum-safe or other script address: KNS could never move it out again. Send it to a regular address instead.", "kns: recipient text is iOS's");
  }

  for (const f of r.failures) console.log(`FAIL ${f}`);
  console.log(`change script fee: ${r.pass} checks passed, ${r.fail} failed`);
  process.exit(r.fail ? 1 : 0);
}

await main();
