// Why the Review needs no folded change (iOS bfe9f022 SendFeeEstimate.total(extra:)): the Kaspa WASM
// generator Desktop sends through never folds change too small to keep into the fee. It refuses the
// send, so what summary.fees says is what the transaction pays. If an SDK update starts folding,
// this fails, and the Review has to start showing it. Fake coins, nothing leaves the machine. Run
// from the repo root:
//
//   node tools/test-generator-small-change.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { deriveSpendingWallet } from "../engine/wallet.js";
import { NETWORK_ID } from "../engine/network.js";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const kaspa = await import("../kaspa/kaspa.js");
await kaspa.default({ module_or_path: readFileSync(join(repo, "kaspa/kaspa_bg.wasm")) });

// Public all-zero-entropy 24-word BIP39 test mnemonic - not a real wallet.
const WORDS = [...Array(23).fill("abandon"), "art"].join(" ");
const source = deriveSpendingWallet(kaspa, WORDS, 1).address;
const destination = deriveSpendingWallet(kaspa, WORDS, 0).address;

let count = 0;
const coin = (amount) => ({
  address: source,
  outpoint: { transactionId: (0xc4b000 + ++count).toString(16).padStart(64, "0"), index: 0 },
  amount,
  scriptPublicKey: kaspa.payToAddressScript(source),
  blockDaaScore: 1000n,
  isCoinbase: false,
});

const COIN = 1_000_000_000n; // 10 KAS
async function build(remainder, priorityFee = 0n, payload = undefined) {
  return kaspa.createTransactions({
    entries: [coin(COIN)],
    outputs: [{ address: destination, amount: COIN - remainder }],
    priorityFee,
    changeAddress: source,
    networkId: NETWORK_ID,
    ...(payload ? { payload } : {}),
  });
}

// Every remainder from nothing up to just past a coin's worth of mass: refused, never one output.
for (const payload of [undefined, new Uint8Array(200)]) {
  for (let remainder = 0n; remainder <= 400_000n; remainder += 97n) {
    await assert.rejects(build(remainder, 0n, payload), /Insufficient funds|Storage mass exceeds maximum/, `remainder ${remainder}`);
  }
}
await assert.rejects(build(600_000n, 500_000n), /Insufficient funds|Storage mass exceeds maximum/);

// Past that the change is kept as its own output, and the summary's fee is the whole fee.
const kept = await build(50_000_000n);
const tx = kept.transactions[0].transaction;
const outputs = [...tx.outputs].map((output) => BigInt(output.value));
assert.equal(outputs.length, 2);
assert.equal(COIN - outputs.reduce((sum, value) => sum + value, 0n), BigInt(kept.summary.fees));

console.log("generator-small-change: ok");
