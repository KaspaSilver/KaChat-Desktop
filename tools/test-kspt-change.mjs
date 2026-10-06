// Cold Storage (KasSigner) send: change is kept whenever storage mass allows it, the fee shown is
// inputs - outputs, and only SIGHASH_ALL signatures are broadcast. Runs against the real Kaspa
// WASM with an in-memory engine; nothing leaves the machine. Run from the repo root:
//
//   node tools/test-kspt-change.mjs
//
// Covers audit DSK-021 (ports iOS e6f0dfe / IOS-013) and iOS 5096466 (IOS-019).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  buildUnsignedTransaction, broadcastSigned, unsignedToKsptBytes, decodeKspt,
  storageMass, fitsStorageMass, calculateMass, calculateFee,
  MAX_FOLDED_CHANGE_SOMPI, SMALL_SEND_MASS_MESSAGE,
} from "../ui/kspt.js";

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
const RATE = 100n; // protocol minimum, sompi per gram
const fromAddress = new kaspa.PrivateKey("5a".padEnd(62, "0") + "4d").toAddress(NET).toString();
const toAddress = new kaspa.PrivateKey("5a".padEnd(62, "0") + "4e").toAddress(NET).toString();

let txCounter = 0;
const fakeTxid = () => (++txCounter).toString(16).padStart(64, "0");
const fmt = (s) => { const v = s.toString().padStart(9, "0"); return `${v.slice(0, -8)}.${v.slice(-8)}`; };

/** In-memory engine: the UTXOs at `fromAddress`, and a recorder for submitted transactions. */
function fakeEngine(amounts) {
  const entries = amounts.map((amount) => ({
    outpoint: { transactionId: fakeTxid(), index: 0 },
    amount,
    scriptPublicKey: kaspa.payToAddressScript(fromAddress),
    blockDaaScore: 1000n,
    isCoinbase: false,
  }));
  const engine = {
    kaspa,
    submitted: [],
    async balanceForAddress() { return { entries }; },
    async connect() {},
    async withRpc(fn) {
      return fn({ async submitTransaction({ transaction }) { engine.submitted.push(transaction); return { transactionId: transaction.id }; } });
    },
  };
  return engine;
}

const sum = (xs) => xs.reduce((a, b) => a + b, 0n);
const baseFee1in2out = calculateFee(calculateMass(1, [34, 34], 0), RATE); // 203,600 sompi

async function main() {
  // --- storage mass arithmetic: iOS's own unit-test numbers, and agreement with the WASM ---
  r.eq(storageMass([20_000_000n], [19_800_000n]), 505n, "storage mass: 0.2 -> 0.198 (iOS test)");
  r.eq(storageMass([1000n * KAS], [19_800_000n]), 50_495n, "storage mass: 1000 KAS -> 0.198 (iOS test)");
  r.check(!fitsStorageMass([1000n * KAS], [1_000_000n]), "storage mass: 0.01 KAS from 1000 KAS does not fit");
  r.eq(storageMass([10n * KAS, 10n * KAS, 10n * KAS], [10n * KAS, 10n * KAS, 10n * KAS]), 0n, "storage mass: 3x3 equal is free");
  r.check(!fitsStorageMass([20_000_000n], [19_800_000n, 0n]), "storage mass: a zero output never fits");
  const wasmCases = [
    [[10n * KAS], [984_796_400n, 15_000_000n]],
    [[10n * KAS], [996_796_400n, 3_000_000n]],
    [[3n * KAS, 2n * KAS], [4n * KAS, 99_000_000n]],
    [[3n * KAS, 2n * KAS, 1n * KAS], [5n * KAS, 15_000_000n]],
    [[1000n * KAS], [19_800_000n]],
  ];
  for (const [ins, outs] of wasmCases) {
    const wasm = kaspa.calculateStorageMass(NET, ins.map(Number), outs.map(Number));
    r.eq(storageMass(ins, outs), BigInt(wasm), `storage mass matches WASM calculateStorageMass ${ins.map(fmt)} -> ${outs.map(fmt)}`);
  }

  // --- 0.15 KAS of change is kept (was folded into the fee under the old 0.2 KAS floor) ---
  {
    const engine = fakeEngine([10n * KAS]);
    const amountSompi = 10n * KAS - 15_000_000n - baseFee1in2out;
    const u = await buildUnsignedTransaction({ engine, fromAddress, toAddress, amountSompi, feeRateOverride: RATE });
    r.eq(u.outputs.length, 2, "0.15 change: recipient + change outputs");
    r.eq(u.changeSompi, 15_000_000n, "0.15 change: change kept");
    r.eq(u.outputs[1].valueSompi, 15_000_000n, "0.15 change: change output value");
    r.eq(u.feeSompi, baseFee1in2out, "0.15 change: fee is only the network fee");
    r.eq(u.foldedChangeSompi, 0n, "0.15 change: nothing folded");
    r.eq(u.feeSompi, sum(u.inputs.map((i) => i.amountSompi)) - sum(u.outputs.map((o) => o.valueSompi)), "0.15 change: fee = inputs - outputs");
    console.log(`0.15 KAS change: before = no change output, fee shown ${fmt(baseFee1in2out)}, paid ${fmt(baseFee1in2out + 15_000_000n)}; after = change ${fmt(u.changeSompi)} kept, fee shown/paid ${fmt(u.feeSompi)} (storage mass ${storageMass([10n * KAS], [amountSompi, 15_000_000n])})`);
  }

  // --- 0.03 KAS of change can't stand (C / 0.03 KAS > 100,000): folded, fee = inputs - outputs ---
  {
    const engine = fakeEngine([10n * KAS]);
    const amountSompi = 10n * KAS - 3_000_000n - baseFee1in2out;
    const u = await buildUnsignedTransaction({ engine, fromAddress, toAddress, amountSompi, feeRateOverride: RATE });
    r.eq(u.outputs.length, 1, "0.03 change: recipient output only");
    r.eq(u.changeSompi, 0n, "0.03 change: no change kept");
    r.eq(u.feeSompi, sum(u.inputs.map((i) => i.amountSompi)) - sum(u.outputs.map((o) => o.valueSompi)), "0.03 change: fee = inputs - outputs");
    r.eq(u.feeSompi, baseFee1in2out + 3_000_000n, "0.03 change: fee includes the folded change");
    r.eq(u.foldedChangeSompi, 3_000_000n, "0.03 change: folded amount reported for the warning");
    r.eq(u.baseFeeSompi, baseFee1in2out, "0.03 change: base fee kept separately");
    console.log(`0.03 KAS change: before = fee shown ${fmt(baseFee1in2out)}, paid ${fmt(u.feeSompi)}; after = fee shown ${fmt(u.feeSompi)} with a ${fmt(u.foldedChangeSompi)} KAS folded-change warning`);
  }

  // --- change above 0.1 KAS that can't stand is refused, not given away ---
  {
    const engine = fakeEngine([10n * KAS]);
    await r.throws(
      () => buildUnsignedTransaction({ engine, fromAddress, toAddress, amountSompi: 1_000_000n, feeRateOverride: RATE }),
      (e) => e.message === SMALL_SEND_MASS_MESSAGE,
      "0.01 KAS send from a 10 KAS coin: refused (would fold ~10 KAS)"
    );
    r.check(MAX_FOLDED_CHANGE_SOMPI === 10_000_000n, "max folded change is 0.1 KAS");
  }

  // --- multi-input (arithmetic path): 0.15 KAS of change kept ---
  {
    const engine = fakeEngine([3n * KAS, 2n * KAS, 1n * KAS]);
    const fee3 = calculateFee(calculateMass(3, [34, 34], 0), RATE);
    const amountSompi = 6n * KAS - 15_000_000n - fee3;
    const u = await buildUnsignedTransaction({ engine, fromAddress, toAddress, amountSompi, feeRateOverride: RATE });
    r.eq(u.inputs.length, 3, "3 inputs: all used");
    r.eq(u.changeSompi, 15_000_000n, "3 inputs: 0.15 change kept");
    r.eq(u.feeSompi, fee3, "3 inputs: fee = network fee");
  }

  // --- sighash: only SIGHASH_ALL is broadcast ---
  {
    const engine = fakeEngine([10n * KAS]);
    const amountSompi = 5n * KAS;
    const unsigned = await buildUnsignedTransaction({ engine, fromAddress, toAddress, amountSompi, feeRateOverride: RATE });
    const signedWith = (sighashType) => {
      const decoded = decodeKspt(unsignedToKsptBytes(unsigned));
      decoded.signed = true;
      decoded.inputs.forEach((input) => { input.signatureHex = "ab".repeat(64); input.sighashType = sighashType; });
      return decoded;
    };
    for (const [type, name] of [[0x02, "SIGHASH_NONE"], [0x03, "SIGHASH_SINGLE"], [0x81, "ALL|ANYONECANPAY"], [0x00, "0x00"]]) {
      await r.throws(
        () => broadcastSigned({ engine, unsigned, decoded: signedWith(type) }),
        (e) => e.message === "Input 0 was signed with a signature type that doesn't cover the whole transaction, so it won't be broadcast",
        `sighash ${name}: refused`
      );
    }
    r.eq(engine.submitted.length, 0, "sighash: nothing submitted for non-ALL signatures");
    const txId = await broadcastSigned({ engine, unsigned, decoded: signedWith(0x01) });
    r.eq(engine.submitted.length, 1, "sighash SIGHASH_ALL: submitted");
    r.check(typeof txId === "string" && txId.length === 64, "sighash SIGHASH_ALL: transaction id returned");
    const sigScript = String(engine.submitted[0].inputs[0].signatureScript);
    r.check(sigScript.endsWith("01") && sigScript.length === 132, `sighash SIGHASH_ALL: sig script ends with 0x01 (${sigScript.length / 2} bytes)`);
  }

  for (const f of r.failures) console.log(`FAIL ${f}`);
  console.log(`kspt change/sighash: ${r.pass} checks passed, ${r.fail} failed`);
  process.exit(r.fail ? 1 : 0);
}

await main();
