// The engine's hand-built and KNS transactions against a stub RPC and the real Kaspa WASM. Nothing
// leaves the machine: the RPC is an in-memory UTXO set that records what is submitted, and the
// KNS API is a stubbed fetch. Run from the repo root:
//
//   node tools/test-onchain-builds.mjs
//
// Covers audit DSK-017 (the KNS commit is a plain exact payment the reveal can spend), EXT-005
// (a transfer is recorded before its commit, cleared after its reveal, blocks a second commit and
// can be finished from the record) and DSK-020 (the self-stash note is one output, no change).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import * as K from "../engine/kns-write.js";
import { sendPayloadToSelf, sendPayloadTransaction, submitConfirmingAcceptance, isOrphanRejection } from "../engine/transactions.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");

const r = {
  pass: 0, fail: 0, failures: [],
  check(ok, label) { if (ok) this.pass++; else { this.fail++; this.failures.push(label); } },
  eq(a, b, label) { this.check(a === b, `${label}: got ${String(a)}, expected ${String(b)}`); },
  async throws(fn, pred, label) {
    try { await fn(); this.check(false, `${label}: did not throw`); } catch (e) { this.check(pred(e), `${label}: threw ${e?.code || ""} ${e?.message}`); }
  },
};

const kaspa = await import("../kaspa/kaspa.js");
await kaspa.default({ module_or_path: readFileSync(join(repo, "kaspa/kaspa_bg.wasm")) });

const NET = "mainnet";
const KAS = 100_000_000n;
const ownerKey = new kaspa.PrivateKey("5a".padEnd(62, "0") + "4d");
const ownerAddress = ownerKey.toAddress(NET).toString();
const recipientAddress = new kaspa.PrivateKey("5a".padEnd(62, "0") + "4e").toAddress(NET).toString();

let txCounter = 0;
const fakeTxid = () => (++txCounter).toString(16).padStart(64, "0");
function utxo(address, amountSompi, txid = fakeTxid(), index = 0) {
  return {
    address,
    outpoint: { transactionId: txid, index },
    amount: amountSompi,
    scriptPublicKey: kaspa.payToAddressScript(address),
    blockDaaScore: 1000n,
    isCoinbase: false,
  };
}

/** An in-memory node: UTXOs by address, every submitted Transaction kept, and an optional hook
 *  that can refuse a submission (to simulate a refused reveal). */
function stubRpc() {
  const rpc = {
    utxos: new Map(),
    submitted: [],
    refuse: null,
    attempts: [],
    async getUtxosByAddresses(addresses) {
      const list = (Array.isArray(addresses) ? addresses : addresses?.addresses || []).map(String);
      return { entries: list.flatMap((a) => rpc.utxos.get(a) || []) };
    },
    async submitTransaction({ transaction, allowOrphan = false }) {
      rpc.attempts.push({ id: String(transaction.id), allowOrphan: Boolean(allowOrphan) });
      const refusal = rpc.refuse?.(transaction, Boolean(allowOrphan));
      if (refusal) throw new Error(refusal);
      rpc.submitted.push(transaction);
      return { transactionId: transaction.id };
    },
  };
  return rpc;
}

// The generator's PendingTransaction.submit only takes a real RpcClient; route it to the stub.
kaspa.PendingTransaction.prototype.submit = async function submitToStub(rpc) {
  const response = await rpc.submitTransaction({ transaction: this.transaction, allowOrphan: false });
  return response.transactionId;
};

function fakeEngine(rpc) {
  return {
    kaspa,
    rpc,
    privateKey: ownerKey,
    address: ownerAddress,
    log: () => {},
    async connect() {},
    async withRpc(fn) { return fn(rpc); },
  };
}

const scriptHex = (spk) => String(typeof spk === "string" ? spk : spk?.script ?? "").toLowerCase();
const payloadHex = (tx) => String(tx.payload ?? "");

/** In-memory pending storage; `log` records each write (key, parsed value) in order. */
function memoryStorage() {
  const map = new Map();
  const log = [];
  return {
    map, log,
    getItem: async (k) => (map.has(k) ? map.get(k) : null),
    setItem: async (k, v) => { map.set(k, v); log.push(["set", k, JSON.parse(v)]); },
    removeItem: async (k) => { map.delete(k); log.push(["remove", k]); },
  };
}

// KNS API stub: /<domain>/owner answers with `knsOwner.current` (or 404 when null).
const knsOwner = { current: ownerAddress };
globalThis.fetch = async (url) => {
  const href = String(url);
  const m = href.match(/\/([^/]+\.kas)\/owner$/);
  if (m && knsOwner.current) {
    const body = JSON.stringify({ success: true, data: { owner: knsOwner.current, asset: decodeURIComponent(m[1]), id: "asset-1" } });
    return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
  }
  return new Response("", { status: 404 });
};

async function main() {
  // MARK: DSK-017 - the old path really refused a payload-less commit
  await r.throws(
    () => sendPayloadTransaction({ kaspa, rpc: stubRpc(), privateKey: ownerKey, sourceAddress: ownerAddress, destinationAddress: ownerAddress, amountKas: "2" }),
    (e) => /Payload is required/.test(e.message),
    "sendPayloadTransaction still refuses a missing payload (why the commit no longer uses it)",
  );

  // MARK: DSK-017 - the commit build
  {
    const rpc = stubRpc();
    rpc.utxos.set(ownerAddress, [utxo(ownerAddress, 1n * KAS), utxo(ownerAddress, 5n * KAS), utxo(ownerAddress, KAS / 2n)]);
    const engine = fakeEngine(rpc);
    const payload = K.buildTransferPayload("asset-1", recipientAddress);
    const redeem = K.buildKnsRedeemScript(kaspa, K.xOnlyPublicKeyHexFromPrivateKey(ownerKey), payload);
    r.check(redeem.commitAddressString.startsWith("kaspa:p"), "commit address is a P2SH kaspa:p… address");
    const commitAmountSompi = 2n * KAS;
    const commit = await K.sendKnsCommitTransaction({
      engine, commitAddressString: redeem.commitAddressString, commitAmountKas: 2,
      commitScriptPublicKey: redeem.commitScriptPublicKey, commitAmountSompi,
    });
    r.eq(rpc.submitted.length, 1, "commit: one transaction broadcast");
    const tx = rpc.submitted[0];
    r.eq(commit.txid, tx.id, "commit: returned txid is the broadcast transaction");
    r.eq(payloadHex(tx), "", "commit: carries no payload");
    const outputs = tx.outputs;
    const commitOut = outputs[commit.outputIndex];
    r.eq(scriptHex(commitOut.scriptPublicKey), scriptHex(redeem.commitScriptPublicKey), "commit: located output pays the P2SH script");
    r.eq(BigInt(commitOut.value), commitAmountSompi, "commit: located output holds exactly the commit amount (exactAmount)");
    r.eq(outputs.filter((o) => scriptHex(o.scriptPublicKey) === scriptHex(redeem.commitScriptPublicKey)).length, 1, "commit: exactly one P2SH output");
    const inSum = tx.inputs.reduce((s, i) => s + BigInt(i.utxo?.amount ?? 0), 0n);
    const outSum = outputs.reduce((s, o) => s + BigInt(o.value), 0n);
    r.check(inSum > outSum && inSum - outSum < KAS / 100n, `commit: fee is small and positive (${inSum - outSum} sompi)`);

    // MARK: DSK-017 - the reveal spends that output
    const reveal = await K.buildAndSubmitKnsReveal({
      engine, commitTxId: commit.txid, commitOutputIndex: commit.outputIndex, commitAmountSompi,
      commitScriptPublicKey: redeem.commitScriptPublicKey, builder: redeem.builder,
      revealTargetAddress: ownerAddress, revealAmountSompi: commitAmountSompi,
    });
    r.eq(rpc.submitted.length, 2, "reveal: broadcast");
    const rtx = rpc.submitted[1];
    r.eq(rtx.inputs.length, 1, "reveal: one input");
    r.eq(rtx.inputs[0].previousOutpoint.transactionId, commit.txid, "reveal: spends the commit transaction");
    r.eq(Number(rtx.inputs[0].previousOutpoint.index), commit.outputIndex, "reveal: spends the commit output index");
    r.eq(rtx.outputs.length, 1, "reveal: one output");
    r.eq(BigInt(rtx.outputs[0].value), commitAmountSompi - reveal.fee, "reveal: output is commit minus fee");
    r.check(String(rtx.inputs[0].signatureScript).toLowerCase().includes(redeem.redeemScriptHex.toLowerCase()), "reveal: signature script carries the redeem script");

    // locateKnsCommitOutput falls back to the last txid, output 0, when it cannot match.
    const fallback = K.locateKnsCommitOutput({ txids: ["a", "b"] }, null, null);
    r.check(fallback.txid === "b" && fallback.index === 0, "locateKnsCommitOutput: falls back to the last txid, output 0");
  }

  // MARK: EXT-005 - transfer recorded before the commit, cleared after the reveal
  const store = memoryStorage();
  K.setKnsPendingStorage(store);
  const key = K.pendingKnsTransferKey();
  r.eq(key, "kachat-kns-pending-transfer-v1:mainnet", "pending transfers: network-scoped key");
  {
    const rpc = stubRpc();
    rpc.utxos.set(ownerAddress, [utxo(ownerAddress, 10n * KAS)]);
    const engine = fakeEngine(rpc);
    knsOwner.current = ownerAddress;
    let submittedAtFirstWrite = null;
    const origSet = store.setItem;
    store.setItem = async (k, v) => { if (submittedAtFirstWrite == null) submittedAtFirstWrite = rpc.submitted.length; return origSet(k, v); };
    rpc.refuse = (tx) => { if (rpc.submitted.length === 1) knsOwner.current = recipientAddress; return null; }; // owner moves with the reveal
    const result = await K.transferDomain({ engine, domain: "alice.kas", assetId: "asset-1", toAddress: recipientAddress, source: { kind: "identity" } });
    store.setItem = origSet;
    r.eq(submittedAtFirstWrite, 0, "transfer: the record is written before anything is broadcast");
    const firstWrite = store.log.find((e) => e[0] === "set")?.[2]?.["asset-1"];
    r.eq(firstWrite?.status, "committing", "transfer: first record status is committing");
    r.eq(firstWrite?.commitTxId, null, "transfer: first record has no commit txid yet");
    r.eq(firstWrite?.recipient, recipientAddress, "transfer: record keeps the recipient");
    r.eq(firstWrite?.source?.address, ownerAddress, "transfer: record keeps the source address");
    r.eq(firstWrite?.network, "mainnet", "transfer: record keeps the network");
    const committedWrite = store.log.filter((e) => e[0] === "set").map((e) => e[2]["asset-1"]).find((rec) => rec?.status === "committed");
    r.eq(committedWrite?.commitTxId, result.commitTxid, "transfer: commit txid recorded after broadcast");
    r.eq(rpc.submitted.length, 2, "transfer: commit and reveal broadcast");
    r.eq(store.map.has(key), false, "transfer: record cleared after the reveal");
    r.eq(result.verified, true, "transfer: verified against the (stubbed) indexer");
  }

  // MARK: EXT-005 - a refused reveal leaves Retry reveal, blocks a second commit, resumes
  {
    const rpc = stubRpc();
    rpc.utxos.set(ownerAddress, [utxo(ownerAddress, 10n * KAS)]);
    const engine = fakeEngine(rpc);
    knsOwner.current = ownerAddress;
    rpc.refuse = () => (rpc.submitted.length === 1 ? "transaction fee too low (stub refusal)" : null);
    let commitTxid = null;
    await r.throws(
      () => K.transferDomain({ engine, domain: "bob.kas", assetId: "asset-2", toAddress: recipientAddress, onStatus: (p) => { if (p.status === "committed") commitTxid = p.commitTxid; } }),
      (e) => e.code === "knsTransferRevealPending" && e.pendingTransfer?.status === "reveal-failed",
      "refused reveal: knsTransferRevealPending with the record",
    );
    const record = await K.getPendingKnsTransfer("asset-2");
    r.eq(record?.status, "reveal-failed", "refused reveal: record kept as reveal-failed");
    r.eq(record?.commitTxId, commitTxid, "refused reveal: record holds the commit txid");
    const before = rpc.submitted.length;
    await r.throws(
      () => K.transferDomain({ engine, domain: "bob.kas", assetId: "asset-2", toAddress: recipientAddress }),
      (e) => e.code === "knsTransferPending",
      "second transfer of the same domain is refused",
    );
    r.eq(rpc.submitted.length, before, "second transfer: nothing broadcast");
    r.eq((await K.listPendingKnsTransfers({ sourceAddress: ownerAddress })).length, 1, "listPendingKnsTransfers: one for the owner");
    r.eq((await K.listPendingKnsTransfers({ sourceAddress: recipientAddress })).length, 0, "listPendingKnsTransfers: none for another address");

    // The commit confirmed: it is now an unspent output at the P2SH address.
    const commitTx = rpc.submitted[0];
    const idx = commitTx.outputs.findIndex((o) => BigInt(o.value) === 2n * KAS);
    rpc.utxos.set(record.commitAddress, [{ ...utxo(record.commitAddress, 2n * KAS, commitTx.id, idx), scriptPublicKey: commitTx.outputs[idx].scriptPublicKey }]);
    rpc.refuse = () => { knsOwner.current = recipientAddress; return null; };
    const resumed = await K.resumeKnsTransfer({ engine, assetId: "asset-2" });
    r.eq(resumed.status, "revealed", "resume: revealed");
    const rtx = rpc.submitted[rpc.submitted.length - 1];
    r.eq(rtx.inputs[0].previousOutpoint.transactionId, commitTx.id, "resume: reveal spends the recorded commit");
    r.eq(Number(rtx.inputs[0].previousOutpoint.index), idx, "resume: at the commit output index");
    r.eq(await K.getPendingKnsTransfer("asset-2"), null, "resume: record cleared");
  }

  // MARK: EXT-005 - resume from the record alone (commit only in the mempool), and an already-spent reveal
  {
    const rpc = stubRpc();
    rpc.utxos.set(ownerAddress, [utxo(ownerAddress, 10n * KAS)]);
    const engine = fakeEngine(rpc);
    knsOwner.current = ownerAddress;
    rpc.refuse = () => (rpc.submitted.length === 1 ? "stub refusal" : null);
    await K.transferDomain({ engine, domain: "carol.kas", assetId: "asset-3", toAddress: recipientAddress }).catch(() => {});
    const record = await K.getPendingKnsTransfer("asset-3");
    rpc.refuse = () => { knsOwner.current = recipientAddress; return null; };
    const resumed = await K.resumeKnsTransfer({ engine, assetId: "asset-3" });
    const rtx = rpc.submitted[rpc.submitted.length - 1];
    r.check(resumed.status === "revealed" && rtx.inputs[0].previousOutpoint.transactionId === record.commitTxId, "resume (mempool commit): reveal spends the recorded txid");

    knsOwner.current = ownerAddress;
    rpc.refuse = () => (rpc.submitted.length === 3 ? "stub refusal" : null);
    await K.transferDomain({ engine, domain: "dave.kas", assetId: "asset-4", toAddress: recipientAddress }).catch(() => {});
    rpc.refuse = () => { knsOwner.current = recipientAddress; return "output already spent by transaction in the mempool"; };
    const again = await K.resumeKnsTransfer({ engine, assetId: "asset-4" });
    r.eq(again.status, "revealed", "resume (already spent): treated as our earlier reveal");
    r.eq(await K.getPendingKnsTransfer("asset-4"), null, "resume (already spent): record cleared");
  }

  // MARK: EXT-005 - a commit that fails before broadcast clears its record
  {
    const rpc = stubRpc();
    rpc.utxos.set(ownerAddress, [utxo(ownerAddress, KAS)]); // 1 KAS cannot fund a 2 KAS commit
    const engine = fakeEngine(rpc);
    knsOwner.current = ownerAddress;
    rpc.refuse = null;
    await r.throws(() => K.transferDomain({ engine, domain: "erin.kas", assetId: "asset-5", toAddress: recipientAddress }), () => true, "underfunded transfer throws");
    r.eq(rpc.submitted.length, 0, "underfunded transfer: nothing broadcast");
    r.eq(await K.getPendingKnsTransfer("asset-5"), null, "underfunded transfer: record cleared");

    // No commit recorded and none on chain: resume reports no-commit and keeps the record.
    const map = { "asset-6": { kind: "transfer", network: "mainnet", assetId: "asset-6", domain: "frank.kas", recipient: recipientAddress, source: { address: ownerAddress }, commitTxId: null, commitAmountSompi: "200000000", status: "commit-unknown", createdAt: Date.now() } };
    await store.setItem(key, JSON.stringify(map));
    const none = await K.resumeKnsTransfer({ engine, assetId: "asset-6" });
    r.eq(none.status, "no-commit", "resume without a commit: no-commit");
    r.check(Boolean(await K.getPendingKnsTransfer("asset-6")), "resume without a commit: record kept for the caller to discard");
    await K.clearPendingKnsTransfer("asset-6");
  }
  K.setKnsPendingStorage(null);

  // MARK: DSK-020 - the self-stash note is one output, no change
  {
    const rpc = stubRpc();
    rpc.utxos.set(ownerAddress, [utxo(ownerAddress, KAS / 5n), utxo(ownerAddress, 3n * KAS), utxo(ownerAddress, KAS / 2n)]);
    const payload = new Uint8Array(180).fill(7);
    const result = await sendPayloadToSelf({ kaspa, rpc, privateKey: ownerKey, sourceAddress: ownerAddress, payload });
    r.eq(rpc.submitted.length, 1, "self-stash: one transaction");
    const tx = rpc.submitted[0];
    r.eq(tx.inputs.length, 1, "self-stash: one input (the largest coin)");
    r.eq(BigInt(tx.inputs[0].utxo.amount), 3n * KAS, "self-stash: spends the largest coin");
    r.eq(tx.outputs.length, 1, "self-stash: one output, no change");
    r.eq(scriptHex(tx.outputs[0].scriptPublicKey), scriptHex(kaspa.payToAddressScript(ownerAddress)), "self-stash: output back to the source");
    r.eq(BigInt(tx.outputs[0].value), 3n * KAS - result.feeSompi, "self-stash: output is input minus fee");
    r.check(payloadHex(tx).length === 360, "self-stash: carries the payload");
    const mass = kaspa.calculateTransactionMass(NET, tx, 1);
    r.check(mass != null && BigInt(mass) <= 100_000n, `self-stash: mass within the standard limit (${mass})`);
    const storage = kaspa.calculateStorageMass(NET, [Number(3n * KAS)], [Number(tx.outputs[0].value)]);
    r.check(storage != null && BigInt(storage) < 100n, `self-stash: storage mass is negligible (${storage})`);
  }

  // MARK: iOS 4eb492f - an orphan rejection waits for the parent instead of failing
  {
    const orphan = "transaction 00ab is an orphan where orphan is disallowed";
    r.check(isOrphanRejection(new Error(orphan)), "orphan rejection recognised");
    r.check(!isOrphanRejection(new Error("insufficient funds")), "other errors are not orphan rejections");

    // Refused once as an orphan, then accepted: the same signed transaction, sent twice.
    {
      const rpc = stubRpc();
      rpc.utxos.set(ownerAddress, [utxo(ownerAddress, 2n * KAS)]);
      let refusals = 0;
      rpc.refuse = () => (refusals++ === 0 ? orphan : null);
      const started = Date.now();
      const sent = await sendPayloadTransaction({ kaspa, rpc, privateKey: ownerKey, sourceAddress: ownerAddress, destinationAddress: recipientAddress, amountKas: "0.2", payload: "aa".repeat(40) });
      r.check(Date.now() - started >= 1400, "orphan once: waited ~1.5s before the resubmit");
      r.eq(rpc.submitted.length, 1, "orphan once: one transaction accepted");
      r.eq(rpc.attempts.length, 2, "orphan once: two submits");
      r.eq(rpc.attempts[0].id, rpc.attempts[1].id, "orphan once: the resubmit is the same transaction");
      r.eq(rpc.attempts[1].allowOrphan, false, "orphan once: resubmit still disallows orphans");
      r.eq(sent.txids[0], rpc.attempts[0].id, "orphan once: the send reports that transaction");
    }

    // Still an orphan after the wait: the node is asked to hold it (allowOrphan), nothing rebuilt.
    {
      const rpc = stubRpc();
      rpc.utxos.set(ownerAddress, [utxo(ownerAddress, 2n * KAS)]);
      rpc.refuse = (_tx, allowOrphan) => (allowOrphan ? null : orphan);
      const sent = await sendPayloadTransaction({ kaspa, rpc, privateKey: ownerKey, sourceAddress: ownerAddress, destinationAddress: recipientAddress, amountKas: "0.2", payload: "bb".repeat(40) });
      r.eq(rpc.attempts.length, 3, "orphan twice: three submits");
      r.check(rpc.attempts.every((a) => a.id === rpc.attempts[0].id), "orphan twice: every submit is the same transaction");
      r.eq(rpc.attempts.map((a) => a.allowOrphan).join(","), "false,false,true", "orphan twice: last submit allows an orphan");
      r.eq(rpc.submitted.length, 1, "orphan twice: one transaction accepted");
      r.eq(sent.txids[0], rpc.attempts[0].id, "orphan twice: the send reports that transaction");
    }

    // submitConfirmingAcceptance directly: a refused orphan rethrows the original error once both
    // retries fail; a non-orphan error is not retried.
    {
      const calls = [];
      await r.throws(
        () => submitConfirmingAcceptance({ submit: async (_rpc, opts) => { calls.push(opts?.allowOrphan); throw new Error(calls.length === 1 ? orphan : "rejected"); }, txid: null, orphanWaitMs: 0 }),
        (e) => e.message === orphan,
        "orphan never accepted: the original error is thrown",
      );
      r.eq(calls.join(","), "false,false,true", "orphan never accepted: wait, resubmit, then allow orphan");
      const plain = [];
      await r.throws(
        () => submitConfirmingAcceptance({ submit: async (_rpc, opts) => { plain.push(opts?.allowOrphan); throw new Error("bad signature"); }, txid: null, orphanWaitMs: 0 }),
        (e) => e.message === "bad signature",
        "non-orphan error: thrown as is",
      );
      r.eq(plain.length, 1, "non-orphan error: no resubmit");
      const legacy = await submitConfirmingAcceptance({ submit: async () => ({ transactionId: "f".repeat(64) }), txid: null });
      r.eq(legacy, "f".repeat(64), "a submit that ignores the options still works");
    }
  }

  for (const f of r.failures) console.log(`FAIL ${f}`);
  console.log(`onchain builds: ${r.pass} checks passed, ${r.fail} failed`);
  process.exit(r.fail ? 1 : 0);
}

await main();
