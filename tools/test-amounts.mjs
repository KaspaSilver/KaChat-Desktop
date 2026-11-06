// node tools/test-amounts.mjs - the one exact KAS amount parser (engine/amounts.js, iOS IOS-010),
// the UTXO sanity helpers (IOS-020) and the submit acceptance check (IOS-014) in engine/transactions.js.
// Nothing leaves the machine: fetch is stubbed and the RPC is an in-memory object.
import assert from "node:assert/strict";
import {
  sompiFromUserText, sanitizeAmountInput, kasTextFromSompi, kasToSompi, utxoAmountSompi,
  MAX_TYPED_SOMPI, MAX_U64, MAX_SUPPLY_SOMPI, checkedUtxoAnswer, kasExact8Text,
} from "../engine/amounts.js";

globalThis.fetch = async () => new Response("", { status: 404 });
const { sanitizeUtxoEntries, totalUtxoSompi, submitConfirmingAcceptance, isTransactionKnown, sendKaspa, SEND_OUTCOME_UNKNOWN, SEND_OUTCOME_UNKNOWN_MESSAGE, isLostSubmitAnswer, excludeJustSpentUtxos, noteSpentOutpoints, clearJustSpentOutpoints, JUST_SPENT_HOLD_MS, maxSendEntries, MAX_SEND_INPUT_LIMIT } = await import("../engine/transactions.js");

let pass = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// MARK: sompiFromUserText
test("dot and comma decimals", () => {
  assert.equal(sompiFromUserText("1.5"), 150_000_000n);
  assert.equal(sompiFromUserText("1,5"), 150_000_000n);
  assert.equal(sompiFromUserText(".5"), 50_000_000n);
  assert.equal(sompiFromUserText(",5"), 50_000_000n);
  assert.equal(sompiFromUserText("5."), 500_000_000n);
  assert.equal(sompiFromUserText("  2  "), 200_000_000n);
  assert.equal(sompiFromUserText("0"), 0n);
  assert.equal(sompiFromUserText("0.00000001"), 1n);
  assert.equal(sompiFromUserText("007.10"), 710_000_000n);
});
test("exact where floats are not", () => {
  // 0.29 * 1e8 = 28999999.999999996 in floating point; 1.1 * 1e8 = 110000000.00000001
  assert.equal(sompiFromUserText("0.29"), 29_000_000n);
  assert.equal(sompiFromUserText("1.1"), 110_000_000n);
  assert.equal(sompiFromUserText("38.25128251"), 3_825_128_251n);
  assert.equal(sompiFromUserText("12345678901.12345678"), 1_234_567_890_112_345_678n);
});
test("Arabic-Indic and Persian digits, Arabic decimal separator", () => {
  assert.equal(sompiFromUserText("١٫٥"), 150_000_000n); // ١٫٥
  assert.equal(sompiFromUserText("۲,۵"), 250_000_000n); // ۲,۵
});
test("refuses what is not one plain amount", () => {
  for (const bad of ["", " ", ".", ",", "1.2.3", "1,2,3", "1,234.5", "1e3", "1E-8", "-1", "+1", "0x10", "abc", "1 000",
    "1.123456789", "Infinity", "NaN", "１", null, undefined, {}, []]) {
    assert.equal(sompiFromUserText(bad), null, `"${String(bad)}" should not parse`);
  }
});
test("capped at the supply, never overflowing", () => {
  assert.equal(sompiFromUserText("29000000000"), MAX_TYPED_SOMPI);
  assert.equal(sompiFromUserText("29000000000.00000001"), null);
  assert.equal(sompiFromUserText("99999999999"), null);
  assert.equal(sompiFromUserText("999999999999999999999999"), null);
  assert.equal(sompiFromUserText("0000000000000000001"), 100_000_000n); // leading zeros are not digits of size
});

// MARK: sanitizeAmountInput
test("sanitizer: digits, one point, comma as point, decimals cap", () => {
  assert.equal(sanitizeAmountInput("1,5"), "1.5");
  assert.equal(sanitizeAmountInput("1.2.3"), "1.23");
  assert.equal(sanitizeAmountInput("12abc,34"), "12.34");
  assert.equal(sanitizeAmountInput("0.123456789"), "0.12345678");
  assert.equal(sanitizeAmountInput("10.555", 2), "10.55");
  assert.equal(sanitizeAmountInput("-1e3"), "13");
  assert.equal(sanitizeAmountInput("١٫٢"), "1.2");
  assert.equal(sanitizeAmountInput(""), "");
  assert.equal(sanitizeAmountInput(null), "");
});

// MARK: kasTextFromSompi / kasToSompi
test("kasTextFromSompi is exact and round-trips", () => {
  assert.equal(kasTextFromSompi(150_000_000n), "1.5");
  assert.equal(kasTextFromSompi(0n), "0");
  assert.equal(kasTextFromSompi(1n), "0.00000001");
  assert.equal(kasTextFromSompi(-250_000_000n), "-2.5");
  assert.equal(kasTextFromSompi("not a number"), "0");
  for (const s of [1n, 29_000_000n, 3_825_128_251n, MAX_TYPED_SOMPI]) assert.equal(sompiFromUserText(kasTextFromSompi(s)), s);
});
// MARK: kasExact8Text - balances with iOS's %.8f (toolbar, QR screens, toolbar copy)
test("kasExact8Text: exactly 8 decimals, -- when unknown", () => {
  assert.equal(kasExact8Text("1.5"), "1.50000000");
  assert.equal(kasExact8Text("0"), "0.00000000");
  assert.equal(kasExact8Text("12"), "12.00000000");
  assert.equal(kasExact8Text("0.00000001"), "0.00000001");
  assert.equal(kasExact8Text("38.25128251"), "38.25128251");
  assert.equal(kasExact8Text(2.5), "2.50000000");
  // exact past what a Double holds (%.8f would round the last digits)
  assert.equal(kasExact8Text("12345678901.12345678"), "12345678901.12345678");
  for (const unknown of ["--", "", null, undefined, "abc", "1.2.3"]) assert.equal(kasExact8Text(unknown), "--");
});
test("kasToSompi: engine-side reading of KAS text and numbers", () => {
  assert.equal(kasToSompi("1,5"), 150_000_000n);
  assert.equal(kasToSompi(0.29), 29_000_000n);
  assert.equal(kasToSompi(1e-7), 10n);
  assert.equal(kasToSompi(0.1 + 0.2), 30_000_000n);
  assert.equal(kasToSompi("0.30000000000000004"), 30_000_000n); // float text cut to 8, like the SDK
  assert.equal(kasToSompi("1e-7"), null);
  assert.equal(kasToSompi(-1), null);
  assert.equal(kasToSompi(Number.NaN), null);
  assert.equal(kasToSompi(1e21), null);
  assert.equal(kasToSompi("99999999999999"), null); // the SDK's kaspaToSompi panics on this one
  assert.equal(kasToSompi(null), null);
});

// MARK: IOS-020 - node-supplied UTXO values
test("utxoAmountSompi / sanitizeUtxoEntries drop unusable amounts", () => {
  assert.equal(utxoAmountSompi({ amount: 5n }), 5n);
  assert.equal(utxoAmountSompi({ amount: "7" }), 7n);
  assert.equal(utxoAmountSompi({ amount: 0n }), null);
  assert.equal(utxoAmountSompi({ amount: -1n }), null);
  assert.equal(utxoAmountSompi({ amount: "1.5" }), null);
  assert.equal(utxoAmountSompi({ amount: "abc" }), null);
  assert.equal(utxoAmountSompi({ amount: 2 ** 60 }), null); // an unsafe JS number is not trusted
  assert.equal(utxoAmountSompi({ amount: MAX_U64 + 1n }), null);
  assert.equal(utxoAmountSompi({}), null);
  const kept = sanitizeUtxoEntries([{ amount: 1n }, { amount: "x" }, null, { amount: MAX_U64 }]);
  assert.equal(kept.length, 2);
  assert.deepEqual(sanitizeUtxoEntries(undefined), []);
});
test("totalUtxoSompi refuses a set past u64", () => {
  assert.equal(totalUtxoSompi([{ amount: 2n }, { amount: 3n }]), 5n);
  assert.throws(() => totalUtxoSompi([{ amount: MAX_U64 }, { amount: 1n }]), /amount overflow/);
});

// MARK: IOS-014 - a submit the network accepted is never a failure
const TXID = "ab".repeat(32);
test("submit success returns the node's id", async () => {
  const txid = await submitConfirmingAcceptance({ rpc: { getMempoolEntry: async () => ({ mempoolEntry: {} }) }, submit: async () => ({ transactionId: TXID }), txid: TXID, recheckMs: 1 });
  assert.equal(txid, TXID);
});
// MARK: iOS fdb32549 / KaPay 953b255 - a send with no answer, and an answer that can't be believed
const NOT_FOUND = { getMempoolEntry: async () => { throw new Error("not found"); } };
const withNoRest = async (fn) => {
  const saved = globalThis.fetch;
  globalThis.fetch = async () => new Response("", { status: 404 });
  try { return await fn(); } finally { globalThis.fetch = saved; }
};
test("a timed out submit the network never shows is unknown, not failed", () => withNoRest(async () => {
  await assert.rejects(
    submitConfirmingAcceptance({ rpc: NOT_FOUND, submit: async () => { throw new Error("Transaction broadcast timed out after 15 seconds."); }, txid: TXID, lostAnswerWaitMs: 1 }),
    (error) => error.code === SEND_OUTCOME_UNKNOWN && error.txid === TXID && error.message === SEND_OUTCOME_UNKNOWN_MESSAGE,
  );
}));
test("a timed out submit that turns up during the longer look counts as sent", () => withNoRest(async () => {
  let looks = 0;
  const rpc = { getMempoolEntry: async () => { looks += 1; return looks > 4 ? { mempoolEntry: {} } : null; } };
  const txid = await submitConfirmingAcceptance({ rpc, submit: async () => { throw new Error("websocket closed"); }, txid: TXID, lostAnswerWaitMs: 1, recheckMs: 1 });
  assert.equal(txid, TXID);
  assert.ok(looks > 2, "past the ordinary look");
}));
test("no connection and a node's rejection stay plain failures", () => withNoRest(async () => {
  for (const message of ["websocket is not connected", "fee too low"]) {
    await assert.rejects(
      submitConfirmingAcceptance({ rpc: NOT_FOUND, submit: async () => { throw new Error(message); }, txid: TXID, lostAnswerWaitMs: 1 }),
      new RegExp(message),
    );
  }
  assert.equal(isLostSubmitAnswer(new Error("connection lost")), true);
  assert.equal(isLostSubmitAnswer(new Error("not connected")), false);
}));
test("a lost answer on the first node stays lost when the next one rejects it", () => withNoRest(async () => {
  let calls = 0;
  const withRpc = async (run) => run({ ...NOT_FOUND });
  await assert.rejects(
    submitConfirmingAcceptance({ withRpc, submit: async () => { calls += 1; throw new Error(calls === 1 ? "timed out" : "orphan"); }, txid: TXID, orphanWaitMs: 0, lostAnswerWaitMs: 1 }),
    (error) => error.code === SEND_OUTCOME_UNKNOWN,
  );
}));
test("an answer with another id doesn't count: the network has to have ours", () => withNoRest(async () => {
  await assert.rejects(
    submitConfirmingAcceptance({ rpc: NOT_FOUND, submit: async () => ({ transactionId: "cd".repeat(32) }), txid: TXID, lostAnswerWaitMs: 1 }),
    (error) => error.code === SEND_OUTCOME_UNKNOWN && error.txid === TXID,
  );
  const known = { getMempoolEntry: async ({ transactionId }) => (transactionId === TXID ? { mempoolEntry: {} } : null) };
  assert.equal(await submitConfirmingAcceptance({ rpc: known, submit: async () => ({ transactionId: "cd".repeat(32) }), txid: TXID, lostAnswerWaitMs: 1 }), TXID);
}));
test("a sent transaction the network can't see goes out again, at most twice", () => withNoRest(async () => {
  let submits = 0;
  const txid = await submitConfirmingAcceptance({ rpc: NOT_FOUND, submit: async () => { submits += 1; return TXID; }, txid: TXID, recheckMs: 1 });
  assert.equal(txid, TXID);
  assert.equal(submits, 1, "the send doesn't wait for this");
  await new Promise((resolve) => setTimeout(resolve, 3600));
  assert.equal(submits, 3);
}));
test("one the network can see isn't sent again", () => withNoRest(async () => {
  let submits = 0;
  await submitConfirmingAcceptance({ rpc: { getMempoolEntry: async () => ({ mempoolEntry: {} }) }, submit: async () => { submits += 1; return TXID; }, txid: TXID, recheckMs: 1 });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(submits, 1);
}));
test("a refused submit whose transaction is in the mempool counts as sent", async () => {
  const rpc = { getMempoolEntry: async ({ transactionId }) => (transactionId === TXID ? { mempoolEntry: { fee: 1n } } : null) };
  const txid = await submitConfirmingAcceptance({ rpc, submit: async () => { throw new Error("transaction already in the mempool"); }, txid: TXID });
  assert.equal(txid, TXID);
});
test("a refused submit the REST API reports accepted counts as sent", async () => {
  const saved = globalThis.fetch;
  globalThis.fetch = async (url) => (String(url).includes(`/transactions/${TXID}`)
    ? new Response(JSON.stringify({ is_accepted: true }), { status: 200 })
    : new Response("", { status: 404 }));
  try {
    const txid = await submitConfirmingAcceptance({ rpc: {}, submit: async () => { throw new Error("orphan"); }, txid: TXID });
    assert.equal(txid, TXID);
  } finally { globalThis.fetch = saved; }
});
test("a refused submit the network does not have is rethrown", async () => {
  const rpc = { getMempoolEntry: async () => { throw new Error("not found"); } };
  await assert.rejects(
    submitConfirmingAcceptance({ rpc, submit: async () => { throw new Error("fee too low"); }, txid: TXID }),
    /fee too low/,
  );
  assert.equal(await isTransactionKnown({ rpc, txid: "not-a-txid" }), false);
});

// MARK: IOS-012 - coin control never falls back to the whole wallet
test("a non-empty coin pick with no readable coin is refused, not sent automatically", async () => {
  let fetched = false;
  const rpc = { getUtxosByAddresses: async () => { fetched = true; return { entries: [] }; } };
  await assert.rejects(
    sendKaspa({ kaspa: {}, rpc, privateKey: "00", sourceAddress: "kaspa:qq", destinationAddress: "kaspa:qq", amountKas: "1", manualUtxos: [{ bogus: true }] }),
    /no longer available/,
  );
  assert.equal(fetched, false);
});

// MARK: the real SDK - sendKaspa end to end against an in-memory node
const { readFileSync } = await import("node:fs");
const { fileURLToPath } = await import("node:url");
const { dirname, join } = await import("node:path");
const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const kaspa = await import("../kaspa/kaspa.js");
await kaspa.default({ module_or_path: readFileSync(join(repo, "kaspa/kaspa_bg.wasm")) });
const KAS = 100_000_000n;
const key = new kaspa.PrivateKey("5a".padEnd(62, "0") + "4d");
const me = key.toAddress("mainnet").toString();
const them = new kaspa.PrivateKey("5a".padEnd(62, "0") + "4e").toAddress("mainnet").toString();
let counter = 0;
const coin = (amount) => ({
  address: me, outpoint: { transactionId: (++counter).toString(16).padStart(64, "0"), index: 0 },
  amount, scriptPublicKey: kaspa.payToAddressScript(me), blockDaaScore: 1000n, isCoinbase: false,
});
function node(entries) {
  const rpc = {
    submitted: [], mempool: new Set(), refuse: null,
    async getUtxosByAddresses() { return { entries }; },
    async submitTransaction({ transaction }) {
      const refusal = rpc.refuse?.(transaction);
      if (refusal) throw new Error(refusal);
      rpc.submitted.push(transaction);
      rpc.mempool.add(String(transaction.id));
      return { transactionId: transaction.id };
    },
    async getMempoolEntry({ transactionId }) {
      if (!rpc.mempool.has(transactionId)) throw new Error("not in mempool");
      return { mempoolEntry: { transaction: {} } };
    },
  };
  return rpc;
}
kaspa.PendingTransaction.prototype.submit = async function submitToStub(rpc) {
  return (await rpc.submitTransaction({ transaction: this.transaction, allowOrphan: false })).transactionId;
};
const paidTo = (tx, address) => tx.outputs
  .filter((o) => String(o.scriptPublicKey?.script ?? "").toLowerCase() === String(kaspa.payToAddressScript(address).script).toLowerCase())
  .reduce((sum, o) => sum + BigInt(o.value), 0n);

test("sendKaspa: a comma-decimal amount pays exactly that many sompi", async () => {
  const rpc = node([coin(5n * KAS)]);
  const result = await sendKaspa({ kaspa, rpc, privateKey: key, sourceAddress: me, destinationAddress: them, amountKas: "1,5", exactAmount: true });
  assert.equal(rpc.submitted.length, 1);
  assert.equal(paidTo(rpc.submitted[0], them), 150_000_000n);
  assert.equal(result.txids[0], rpc.submitted[0].id);
});
test("sendKaspa: an absurd amount is refused before the SDK, which stays usable", async () => {
  const rpc = node([coin(5n * KAS)]);
  await assert.rejects(
    sendKaspa({ kaspa, rpc, privateKey: key, sourceAddress: me, destinationAddress: them, amountKas: "99999999999999" }),
    /greater than 0/,
  );
  await assert.rejects(
    sendKaspa({ kaspa, rpc, privateKey: key, sourceAddress: me, destinationAddress: them, amountKas: "1", feeKas: "1e-3" }),
    /network fee/,
  );
  assert.equal(rpc.submitted.length, 0);
  assert.equal(kaspa.kaspaToSompi("1.5"), 150_000_000n);
});
test("sendKaspa: a node's garbage coin is skipped, not a crash", async () => {
  const rpc = node([{ ...coin(1n), amount: "garbage" }, coin(5n * KAS)]);
  await sendKaspa({ kaspa, rpc, privateKey: key, sourceAddress: me, destinationAddress: them, amountKas: "1", exactAmount: true });
  assert.equal(rpc.submitted.length, 1);
  assert.equal(rpc.submitted[0].inputs.length, 1);
});
test("sendKaspa: 'already in the mempool' for our own transaction is a sent payment, sent once", async () => {
  const rpc = node([coin(5n * KAS)]);
  // The first answer is lost after the node took it: it is in the mempool, but the call fails.
  rpc.refuse = (tx) => { if (!rpc.mempool.size) { rpc.mempool.add(String(tx.id)); return "connection reset"; } return "already in the mempool"; };
  const result = await sendKaspa({ kaspa, rpc, privateKey: key, sourceAddress: me, destinationAddress: them, amountKas: "1", exactAmount: true });
  assert.equal(result.txids.length, 1);
  assert.ok(rpc.mempool.has(result.txids[0]));
  assert.equal(rpc.submitted.length, 0); // never re-submitted as a second payment
});

// MARK: checkedUtxoAnswer (iOS 283cd28, IOS-020)
test("UTXO answers above the Kaspa supply are refused, per coin and in total", () => {
  const ok = { entries: [{ amount: 5n * 100_000_000n }, { entry: { amount: "7" } }] };
  assert.equal(checkedUtxoAnswer(ok), ok);
  assert.equal(checkedUtxoAnswer({ entries: [] }).entries.length, 0);
  assert.equal(checkedUtxoAnswer(null), null);
  assert.throws(() => checkedUtxoAnswer({ entries: [{ amount: MAX_SUPPLY_SOMPI + 1n }] }), /above the Kaspa supply/);
  assert.throws(() => checkedUtxoAnswer({ entries: [{ amount: MAX_U64 }] }), /above the Kaspa supply/);
  const half = MAX_SUPPLY_SOMPI / 2n + 1n;
  assert.throws(() => checkedUtxoAnswer({ entries: [{ amount: half }, { utxoEntry: { amount: half } }] }), /above the Kaspa supply/);
  // a non-integer is left for sanitizeUtxoEntries to drop, not refused here
  assert.doesNotThrow(() => checkedUtxoAnswer({ entries: [{ amount: 1.5 }] }));
  // DSK-046: the refusal marks the node at fault, so withRpc switches nodes instead of rethrowing.
  try { checkedUtxoAnswer({ entries: [{ amount: MAX_SUPPLY_SOMPI + 1n }] }); assert.fail("no throw"); }
  catch (error) { assert.equal(error.badNode, true); }
});

// MARK: iOS 3942a5b7 - a rejection is a verdict, just-spent coins, Max past one transaction's coins
const twoNodes = async (run) => { try { return await run({ ...NOT_FOUND }); } catch { return run({ ...NOT_FOUND }); } };
test("a lost answer then a node's rejection is a plain failure, not Not confirmed", () => withNoRest(async () => {
  let calls = 0;
  await assert.rejects(
    submitConfirmingAcceptance({ withRpc: twoNodes, submit: async () => { calls += 1; throw new Error(calls === 1 ? "timed out" : "transaction rejected: fee too low"); }, txid: TXID, lostAnswerWaitMs: 1 }),
    (error) => error.code !== SEND_OUTCOME_UNKNOWN && /fee too low/.test(error.message),
  );
  assert.equal(calls, 2);
}));
const heldCoin = (txid, index, amount) => ({ outpoint: { transactionId: txid, index }, amount: BigInt(amount) });
test("coins a send just spent are held back, then come back", async () => {
  clearJustSpentOutpoints();
  const coins = [heldCoin("aa", 0, 5), heldCoin("bb", 1, 7)];
  await submitConfirmingAcceptance({ rpc: { getMempoolEntry: async () => ({ mempoolEntry: {} }) }, submit: async () => ({ transactionId: TXID }), txid: TXID, spends: ["aa:0"], recheckMs: 1 });
  assert.deepEqual(excludeJustSpentUtxos(coins).map((c) => c.outpoint.transactionId), ["bb"]);
  assert.equal(excludeJustSpentUtxos(coins, Date.now() + JUST_SPENT_HOLD_MS + 1).length, 2, "held for a while, not for good");
  clearJustSpentOutpoints();
});
test("an unknown outcome holds its coins back; a rejection doesn't", () => withNoRest(async () => {
  clearJustSpentOutpoints();
  const coins = [heldCoin("aa", 0, 5), heldCoin("bb", 1, 7)];
  await assert.rejects(submitConfirmingAcceptance({ rpc: NOT_FOUND, submit: async () => { throw new Error("fee too low"); }, txid: TXID, spends: ["bb:1"], lostAnswerWaitMs: 1 }));
  assert.equal(excludeJustSpentUtxos(coins).length, 2);
  await assert.rejects(
    submitConfirmingAcceptance({ rpc: NOT_FOUND, submit: async () => { throw new Error("timed out"); }, txid: TXID, spends: ["bb:1"], lostAnswerWaitMs: 1 }),
    (error) => error.code === SEND_OUTCOME_UNKNOWN,
  );
  assert.deepEqual(excludeJustSpentUtxos(coins).map((c) => c.outpoint.transactionId), ["aa"]);
  clearJustSpentOutpoints();
}));
test("Max past one transaction's coins spends the largest 80; a coin-control pick is kept as is", () => {
  const many = Array.from({ length: MAX_SEND_INPUT_LIMIT + 5 }, (_, i) => heldCoin(`t${i}`, 0, 1000 + i));
  const picked = maxSendEntries(many);
  assert.equal(picked.length, MAX_SEND_INPUT_LIMIT);
  assert.equal(picked[0].amount, 1005n, "the five smallest are left out");
  assert.equal(maxSendEntries(many.slice(0, 3)).length, 3);
  const pick = many.slice(0, MAX_SEND_INPUT_LIMIT + 2).map((c) => `${c.outpoint.transactionId}:0`);
  assert.equal(maxSendEntries(many, pick).length, MAX_SEND_INPUT_LIMIT + 2, "the pick is refused later, by the plan, never trimmed");
});

for (const [name, fn] of tests) {
  try { await fn(); pass++; }
  catch (error) { console.error(`FAIL ${name}\n  ${error?.message || error}`); process.exitCode = 1; }
}
console.log(`amounts: ${pass}/${tests.length} passed`);
