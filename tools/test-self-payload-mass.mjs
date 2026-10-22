// A payload sent back to the sender's own address - a chat message, a group or public-chat message,
// a KaPosts action - is ONE output of (inputs - fee), largest coins first, as iOS builds it
// (KaChatTransactionBuilder.selectUtxosForContextualMessage). The old shape, a nominal 0.2 KAS
// output plus change from the smallest coins, left a tiny change output whenever the wallet held
// small coins, and the node refused the message: "Storage mass exceeds maximum".
// Offline only: fake coins, an in-memory RPC that records what would be submitted.
//
//   node tools/test-self-payload-mass.mjs

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { sendKaspa } from "../engine/transactions.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");
const kaspa = await import("../kaspa/kaspa.js");
await kaspa.default({ module_or_path: readFileSync(join(repo, "kaspa/kaspa_bg.wasm")) });

let pass = 0, fail = 0;
const failures = [];
const check = (ok, label) => { if (ok) pass++; else { fail++; failures.push(label); } };

const KAS = 100_000_000n;
const key = new kaspa.PrivateKey("1".repeat(64));
const me = key.toKeypair().toAddress("mainnet").toString();
const other = new kaspa.PrivateKey("2".repeat(64)).toKeypair().toAddress("mainnet").toString();

let n = 0;
const coin = (sompi) => ({
  address: me,
  outpoint: { transactionId: (0xabc000 + ++n).toString(16).padStart(64, "0"), index: 0 },
  amount: sompi,
  scriptPublicKey: kaspa.payToAddressScript(me),
  blockDaaScore: 1000n,
  isCoinbase: false,
});
function stubRpc(coins) {
  const rpc = {
    submitted: [],
    async getUtxosByAddresses() { return { entries: coins }; },
    async submitTransaction({ transaction }) { rpc.submitted.push(transaction); return { transactionId: transaction.id }; },
  };
  return rpc;
}
kaspa.PendingTransaction.prototype.submit = async function submitToStub(rpc) {
  return (await rpc.submitTransaction({ transaction: this.transaction })).transactionId;
};
const payload = new TextEncoder().encode(`kchat:1:comm:abcdef0123456789:${"x".repeat(300)}`);
const amount = (out) => BigInt(out.value ?? out.amount);
const send = (rpc, extra = {}) => sendKaspa({
  kaspa, rpc, privateKey: key.toString(), sourceAddress: me, destinationAddress: me,
  amountKas: "0.2", payload, log: () => {}, ...extra,
});
const sumIn = (coins, tx) => tx.inputs.reduce((total, input) => {
  const id = input.previousOutpoint.transactionId;
  return total + (coins.find((c) => c.outpoint.transactionId === id)?.amount ?? 0n);
}, 0n);

// 1. The reported wallet shape: many coins just over 0.2 KAS. The old 0.2 + change shape left
//    ~0.01 KAS of change and a storage mass far over the limit.
{
  const coins = Array.from({ length: 12 }, () => coin(21_000_000n)); // 0.21 KAS each
  const rpc = stubRpc(coins);
  const result = await send(rpc);
  const tx = rpc.submitted[0];
  check(rpc.submitted.length === 1 && result.txids.length === 1, "small coins: one transaction submitted");
  check(tx?.outputs?.length === 1, `small coins: exactly one output (got ${tx?.outputs?.length})`);
  check(tx?.outputs?.[0] && kaspa.Address.validate(me), "small coins: the output is ours");
  const fee = sumIn(coins, tx) - amount(tx.outputs[0]);
  check(fee > 0n && fee < KAS / 100n, `small coins: the fee is the network fee only (${fee} sompi)`);
  check(tx.inputs.length === 1, `small coins: one coin covers it (got ${tx.inputs.length} inputs)`);
}

// 2. A big coin among small ones: the big one alone carries the message.
{
  const coins = [coin(3_000_000n), coin(4_000_000n), coin(5n * KAS), coin(2_500_000n)];
  const rpc = stubRpc(coins);
  await send(rpc);
  const tx = rpc.submitted[0];
  check(tx.inputs.length === 1 && sumIn(coins, tx) === 5n * KAS, "largest coin first: the 5 KAS coin alone");
  check(tx.outputs.length === 1, "largest coin first: one output");
}

// 3. Only small coins (0.01 KAS each, too small to carry the fee and a single-coin output within
//    the storage-mass limit): they are combined until both fit, still one output.
{
  const coins = Array.from({ length: 6 }, () => coin(1_000_000n)); // 0.01 KAS each
  const rpc = stubRpc(coins);
  await send(rpc);
  const tx = rpc.submitted[0];
  check(tx.outputs.length === 1, "dust coins: one output");
  check(amount(tx.outputs[0]) > 0n && amount(tx.outputs[0]) < sumIn(coins, tx), "dust coins: output is inputs minus fee");
  check(tx.inputs.length > 1, `dust coins: more than one coin combined (got ${tx.inputs.length})`);
}

// 4. A priority fee the person chose is paid on top of the network fee.
{
  const coins = [coin(KAS)];
  const plainRpc = stubRpc(coins);
  await send(plainRpc);
  const priorityRpc = stubRpc(coins);
  await send(priorityRpc, { feeKas: "0.001" });
  const plain = amount(plainRpc.submitted[0].outputs[0]);
  const withPriority = amount(priorityRpc.submitted[0].outputs[0]);
  check(plain - withPriority === 100_000n, `priority fee: 0.001 KAS more (${plain - withPriority})`);
}

// 5. Not a self-payload: a chat payment (exactAmount) and a send to someone else keep the generator
//    shape, an output of exactly the amount plus change.
{
  const coins = [coin(2n * KAS)];
  const rpc = stubRpc(coins);
  await sendKaspa({ kaspa, rpc, privateKey: key.toString(), sourceAddress: me, destinationAddress: other, amountKas: "0.5", payload, log: () => {} });
  const tx = rpc.submitted[0];
  check(tx.outputs.length === 2 && tx.outputs.some((o) => amount(o) === 50_000_000n), "payment to another address: exact amount + change");
  const exactRpc = stubRpc([coin(2n * KAS)]);
  await sendKaspa({ kaspa, rpc: exactRpc, privateKey: key.toString(), sourceAddress: me, destinationAddress: me, amountKas: "0.5", payload, exactAmount: true, log: () => {} });
  check(exactRpc.submitted[0].outputs.some((o) => amount(o) === 50_000_000n), "exactAmount self-send keeps the exact output");
}

// 6. Coin control: exactly the selected coins are spent, still one output.
{
  const coins = [coin(KAS), coin(30_000_000n), coin(40_000_000n)];
  const pick = [coins[1], coins[2]].map((c) => `${c.outpoint.transactionId}:${c.outpoint.index}`);
  const rpc = stubRpc(coins);
  await send(rpc, { selectedOutpoints: pick });
  const tx = rpc.submitted[0];
  check(tx.inputs.length === 2 && sumIn(coins, tx) === 70_000_000n && tx.outputs.length === 1, "coin control: both picked coins, one output");
}

console.log(`self-payload mass: ${pass} passed, ${fail} failed`);
if (fail) { for (const f of failures) console.log("  FAIL", f); process.exit(1); }
