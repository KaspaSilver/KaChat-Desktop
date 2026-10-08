// Public-chat sender verification (audit DSK-045): a `kchat:1:bcast:` post is accepted only as a
// self-send, its sender being the address input 0 spends from - never output 0 on its own.
// Runs the real engine (KaspaEngine.handleBlockAddedEvent) and the real Kaspa WASM against
// block-added events shaped like the node's, with the Kaspa REST API stubbed in memory. Nothing
// leaves the machine. Run from the repo root:
//
//   node tools/test-broadcast-sender.mjs

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  BroadcastSenderVerifier, BROADCAST_SENDER, extractBroadcastHitsFromBlock,
  judgeBroadcastSender, restBroadcastSenderShape, broadcastInputOutpoint,
} from "../engine/broadcasts.js";
import { KaspaEngine } from "../engine/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");

const r = {
  pass: 0, fail: 0, failures: [],
  check(ok, label) { if (ok) this.pass++; else { this.fail++; this.failures.push(label); } },
  eq(a, b, label) { this.check(a === b, `${label}: got ${String(a)}, expected ${String(b)}`); },
};

const kaspa = await import("../kaspa/kaspa.js");
await kaspa.default({ module_or_path: readFileSync(join(repo, "kaspa/kaspa_bg.wasm")) });

const NET = "mainnet";
const addressOf = (tail) => new kaspa.PrivateKey("5a".padEnd(62, "0") + tail).toAddress(NET).toString();
const ALICE = addressOf("4d");   // honest poster
const MALLORY = addressOf("4e"); // attacker: funds the tx
const VICTIM = addressOf("4f");  // whom output 0 pays in the forged post

let txCounter = 0;
const fakeTxid = () => (0xb000 + ++txCounter).toString(16).padStart(64, "0");
const hex = (text) => Buffer.from(text, "utf8").toString("hex");
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** An output as the node streams it: verbose address present (the usual case), or only the
 *  `{ version, script }` script public key (`verbose: false`). */
function output(address, { verbose = true, value = 20_000_000n } = {}) {
  const spk = kaspa.payToAddressScript(address);
  const out = { value, scriptPublicKey: { version: spk.version, script: spk.script } };
  if (verbose) out.verboseData = { scriptPublicKeyType: "pubkey", scriptPublicKeyAddress: address };
  return out;
}

/** A broadcast transaction as it sits in a block-added notification. `inputUtxoAddress` adds the
 *  spent UTXO to input 0's verbose data (newer nodes); today's notifications leave it out. */
function bcastTx({ txId = fakeTxid(), channel = "general", content = "hello", outputs, prev = { transactionId: fakeTxid(), index: 0 }, inputUtxoAddress = null }) {
  const input = { previousOutpoint: prev, signatureScript: "41" + "00".repeat(65), sequence: 0n, sigOpCount: 1 };
  if (inputUtxoAddress) input.verboseData = { utxoEntry: { amount: 25_000_000n, scriptPublicKey: kaspa.payToAddressScript(inputUtxoAddress), blockDaaScore: 1n, isCoinbase: false, verboseData: { scriptPublicKeyType: "pubkey", scriptPublicKeyAddress: inputUtxoAddress } } };
  return {
    version: 0, inputs: [input], outputs, lockTime: 0n, subnetworkId: "00".repeat(20), gas: 0n,
    payload: hex(`kchat:1:bcast:${channel}:${content}`),
    verboseData: { transactionId: txId, hash: txId, computeMass: 2000n, blockHash: "aa".repeat(32), blockTime: 1_791_000_000_000n },
  };
}
const blockEvent = (...transactions) => ({ type: "block-added", data: { block: { header: { timestamp: 1_791_000_000_000n }, transactions } } });

/** REST transaction shape (`/transactions/{id}?resolve_previous_outpoints=light`, real field names). */
function restTx(txId, inputAddress, outputAddresses) {
  return {
    transaction_id: txId,
    inputs: [{ transaction_id: txId, index: 0, previous_outpoint_hash: "cc".repeat(32), previous_outpoint_index: "0", previous_outpoint_address: inputAddress, previous_outpoint_amount: 25_000_000 }],
    outputs: outputAddresses.map((address, index) => ({ transaction_id: txId, index, amount: 20_000_000, script_public_key_address: address, script_public_key_type: "pubkey" })),
  };
}

/** Stub fetch: `known` maps txId -> REST tx; anything else 404s. Records every call. */
function stubFetch(known, { searchStatus = 200, failNetwork = false } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || "GET", body: init.body });
    if (failNetwork) throw new TypeError("fetch failed");
    const u = new URL(url);
    if (u.pathname === "/transactions/search") {
      if (searchStatus !== 200) return { ok: false, status: searchStatus, json: async () => ({}) };
      const ids = JSON.parse(init.body).transactionIds;
      return { ok: true, status: 200, json: async () => ids.filter((id) => known.has(id)).map((id) => known.get(id)) };
    }
    const id = u.pathname.split("/").pop();
    if (!known.has(id)) return { ok: false, status: 404, json: async () => ({ detail: "not found" }) };
    return { ok: true, status: 200, json: async () => known.get(id) };
  };
  return { fetchImpl, calls };
}

/** A real engine with the WASM, one wanted room, a stubbed REST API and instant retries. */
function makeEngine(known, fetchOptions = {}) {
  const logs = [];
  const engine = new KaspaEngine({ log: (...parts) => logs.push(parts.join(" ")) });
  engine.kaspa = kaspa;
  engine.blockScanChannels = new Set(["general", "chess-arena"]);
  const stub = stubFetch(known, fetchOptions);
  engine.broadcastSenderVerifier = new BroadcastSenderVerifier({
    fetchImpl: stub.fetchImpl, restBase: () => "https://api.test", log: (message) => engine.log(message),
    sleep: () => Promise.resolve(), liveDelaysMs: [0, 0, 0],
  });
  const delivered = [];
  engine.onBroadcastBlockHits((rows) => delivered.push(...rows));
  return { engine, logs, delivered, calls: stub.calls };
}

async function main() {
  // --- the rule itself ---
  r.eq(judgeBroadcastSender(ALICE, ALICE).verdict, BROADCAST_SENDER.VERIFIED, "judge: self-send verified");
  r.eq(judgeBroadcastSender(ALICE, ALICE).senderAddress, ALICE, "judge: sender is the input address");
  r.eq(judgeBroadcastSender(MALLORY, VICTIM).verdict, BROADCAST_SENDER.FORGED, "judge: input X, output 0 Y is forged");
  r.eq(judgeBroadcastSender("", VICTIM).verdict, BROADCAST_SENDER.UNKNOWN, "judge: unknown input is unknown");
  r.eq(judgeBroadcastSender("", VICTIM).senderAddress, "", "judge: unknown input never yields output 0 as sender");
  r.eq(judgeBroadcastSender(ALICE, "").verdict, BROADCAST_SENDER.UNKNOWN, "judge: unknown output 0 is unknown");
  r.eq(judgeBroadcastSender("not-an-address", "not-an-address").verdict, BROADCAST_SENDER.UNKNOWN, "judge: malformed addresses are unknown");
  {
    const shape = restBroadcastSenderShape({
      inputs: [{ index: 1, previous_outpoint_address: VICTIM }, { index: 0, previous_outpoint_address: MALLORY }],
      outputs: [{ index: 1, script_public_key_address: MALLORY }, { index: 0, script_public_key_address: VICTIM }],
    });
    r.eq(shape.inputAddress, MALLORY, "REST shape: input 0 picked by index, not array position");
    r.eq(shape.outputAddress, VICTIM, "REST shape: output 0 picked by index, not array position");
  }
  {
    const prev = { transactionId: "AB".repeat(32), index: 3 };
    const op = broadcastInputOutpoint({ inputs: [{ previousOutpoint: prev }] });
    r.check(op && op.transactionId === "ab".repeat(32) && op.index === 3, "outpoint: input 0's previous outpoint, txid lowercased");
  }

  // --- extraction: senderAddress is never output 0 on its own ---
  {
    const forged = bcastTx({ outputs: [output(VICTIM)] });
    const [hit] = extractBroadcastHitsFromBlock(kaspa, blockEvent(forged), { networkId: NET });
    r.eq(hit.senderVerdict, BROADCAST_SENDER.UNKNOWN, "extract: no input data -> unknown");
    r.eq(hit.senderAddress, "", "extract: unknown hit has no sender (not output 0)");
    r.eq(hit.outputAddress, VICTIM, "extract: output 0 address read for comparison");
    const noVerbose = bcastTx({ outputs: [output(ALICE, { verbose: false })], inputUtxoAddress: ALICE });
    const [hit2] = extractBroadcastHitsFromBlock(kaspa, blockEvent(noVerbose), { networkId: NET });
    r.eq(hit2.outputAddress, ALICE, "extract: output 0 address derived from the script when verbose data is missing");
    r.eq(hit2.senderVerdict, BROADCAST_SENDER.VERIFIED, "extract: input utxoEntry + matching output 0 verified");
  }

  // --- 1. honest self-send, input address from REST: accepted, sender = input address ---
  {
    const txId = fakeTxid();
    const known = new Map([[txId, restTx(txId, ALICE, [ALICE, ALICE])]]);
    const { engine, delivered, calls, logs } = makeEngine(known);
    engine.handleBlockAddedEvent(blockEvent(bcastTx({ txId, outputs: [output(ALICE), output(ALICE)] })));
    r.eq(delivered.length, 0, "honest/REST: nothing delivered before verification");
    await flush(); await flush(); await flush();
    r.eq(delivered.length, 1, "honest/REST: delivered once verified");
    r.eq(delivered[0]?.senderAddress, ALICE, "honest/REST: sender is input 0's address");
    r.eq(delivered[0]?.txId, txId, "honest/REST: txid kept");
    r.eq(delivered[0]?.content, "hello", "honest/REST: content kept");
    r.check(delivered[0] && Object.keys(delivered[0]).sort().join() === "blockTime,channel,content,senderAddress,txId", "honest/REST: listener row keeps the indexer row shape");
    r.check(calls.length >= 1 && calls[0].url.includes(`/transactions/${txId}`) && calls[0].url.includes("resolve_previous_outpoints=light"), "honest/REST: looked up the tx with previous outpoints resolved");
    r.eq(engine.broadcastSenderVerdict(txId)?.verdict, BROADCAST_SENDER.VERIFIED, "honest/REST: verdict remembered");
    r.check(!logs.some((l) => l.includes("dropped")), "honest/REST: nothing logged as dropped");
  }

  // --- 2. Mallory: input from X, output 0 pays Y -> dropped and logged with the txid ---
  {
    const txId = fakeTxid();
    const known = new Map([[txId, restTx(txId, MALLORY, [VICTIM, MALLORY])]]);
    const { engine, delivered, logs } = makeEngine(known);
    engine.handleBlockAddedEvent(blockEvent(bcastTx({ txId, content: "send me KAS", outputs: [output(VICTIM), output(MALLORY)] })));
    await flush(); await flush(); await flush();
    r.eq(delivered.length, 0, "Mallory/REST: forged post not delivered");
    r.check(logs.some((l) => l.includes("dropped") && l.includes(txId)), "Mallory/REST: logged as dropped with the txid");
    r.eq(engine.broadcastSenderVerdict(txId)?.verdict, BROADCAST_SENDER.FORGED, "Mallory/REST: forged verdict remembered");
    // The same tx in a second DAG block: still dropped, no second log line.
    const before = logs.length;
    engine.handleBlockAddedEvent(blockEvent(bcastTx({ txId, content: "send me KAS", outputs: [output(VICTIM), output(MALLORY)] })));
    await flush();
    r.eq(delivered.length, 0, "Mallory/REST: second sighting still dropped");
    r.eq(logs.length, before, "Mallory/REST: dropped logged once per txid");
  }

  // --- 2b. Mallory with the node's own input data: dropped synchronously, no REST ---
  {
    const txId = fakeTxid();
    const { engine, delivered, calls, logs } = makeEngine(new Map());
    engine.handleBlockAddedEvent(blockEvent(bcastTx({ txId, outputs: [output(VICTIM)], inputUtxoAddress: MALLORY })));
    await flush();
    r.eq(delivered.length, 0, "Mallory/verbose: dropped");
    r.eq(calls.length, 0, "Mallory/verbose: no REST lookup needed");
    r.check(logs.some((l) => l.includes(txId) && l.includes("not a self-send")), "Mallory/verbose: logged with the txid and the reason");
  }

  // --- 3. unknown input address: never attributed to output 0, dropped after retries ---
  {
    const txId = fakeTxid();
    const { engine, delivered, calls, logs } = makeEngine(new Map()); // REST 404s forever
    engine.handleBlockAddedEvent(blockEvent(bcastTx({ txId, outputs: [output(VICTIM)] })));
    for (let i = 0; i < 10; i += 1) await flush();
    r.eq(delivered.length, 0, "unknown/404: not delivered (not attributed to output 0)");
    r.eq(calls.length, 3, "unknown/404: retried once per configured delay");
    r.eq(engine.broadcastSenderVerdict(txId), null, "unknown/404: no final verdict remembered (can be asked again)");
    r.check(logs.some((l) => l.includes("dropped") && l.includes(txId) && l.includes("unverified")), "unknown/404: logged as dropped/unverified with the txid");
  }
  {
    const txId = fakeTxid();
    const { engine, delivered } = makeEngine(new Map(), { failNetwork: true });
    engine.handleBlockAddedEvent(blockEvent(bcastTx({ txId, outputs: [output(VICTIM)] })));
    for (let i = 0; i < 10; i += 1) await flush();
    r.eq(delivered.length, 0, "unknown/network error: not delivered");
  }
  {
    // REST knows the tx but could not resolve the previous outpoint (null address).
    const txId = fakeTxid();
    const known = new Map([[txId, restTx(txId, null, [VICTIM])]]);
    const { engine, delivered } = makeEngine(known);
    engine.handleBlockAddedEvent(blockEvent(bcastTx({ txId, outputs: [output(VICTIM)] })));
    for (let i = 0; i < 10; i += 1) await flush();
    r.eq(delivered.length, 0, "unknown/unresolved outpoint: not delivered");
  }

  // --- 4. node verbose input data: honest post accepted with no REST call ---
  {
    const txId = fakeTxid();
    const { engine, delivered, calls } = makeEngine(new Map());
    engine.handleBlockAddedEvent(blockEvent(bcastTx({ txId, outputs: [output(ALICE)], inputUtxoAddress: ALICE })));
    r.eq(delivered.length, 1, "verbose: honest post delivered synchronously");
    r.eq(delivered[0]?.senderAddress, ALICE, "verbose: sender is input 0's address");
    r.eq(calls.length, 0, "verbose: no REST lookup");
  }

  // --- 5. chained posts: the next post spends the previous post's change, resolved locally ---
  {
    const first = fakeTxid();
    const second = fakeTxid();
    const known = new Map([[first, restTx(first, ALICE, [ALICE, ALICE])]]);
    const { engine, delivered, calls } = makeEngine(known);
    engine.handleBlockAddedEvent(blockEvent(bcastTx({ txId: first, outputs: [output(ALICE), output(ALICE)] })));
    await flush(); await flush(); await flush();
    const restCalls = calls.length;
    engine.handleBlockAddedEvent(blockEvent(bcastTx({ txId: second, content: "again", outputs: [output(ALICE), output(ALICE)], prev: { transactionId: first, index: 1 } })));
    r.eq(delivered.length, 2, "chained: second post delivered synchronously");
    r.eq(delivered[1]?.senderAddress, ALICE, "chained: sender from the earlier post's output");
    r.eq(calls.length, restCalls, "chained: no extra REST lookup");
    // Mallory spends a coin of her own that the stream saw, paying output 0 to Alice: dropped.
    const malloryCoin = fakeTxid();
    engine.handleBlockAddedEvent(blockEvent(bcastTx({ txId: malloryCoin, channel: "other", outputs: [output(MALLORY)], inputUtxoAddress: MALLORY })));
    const forged = fakeTxid();
    engine.handleBlockAddedEvent(blockEvent(bcastTx({ txId: forged, outputs: [output(ALICE)], prev: { transactionId: malloryCoin, index: 0 } })));
    await flush();
    r.check(!delivered.some((row) => row.txId === forged), "chained: forged post spending Mallory's seen coin dropped");
  }

  // --- 6. own posts: sender known without a lookup ---
  {
    const txId = fakeTxid();
    const { engine, delivered, calls } = makeEngine(new Map());
    engine.broadcastSenderVerifier.rememberOwnBroadcast(txId, ALICE);
    engine.handleBlockAddedEvent(blockEvent(bcastTx({ txId, outputs: [output(ALICE)] })));
    r.eq(delivered[0]?.senderAddress, ALICE, "own: delivered at once");
    r.eq(calls.length, 0, "own: no REST lookup");
  }

  // --- 7. same unknown tx in several blocks: one verification, one delivery per sighting ---
  {
    const txId = fakeTxid();
    const known = new Map([[txId, restTx(txId, ALICE, [ALICE])]]);
    const { engine, delivered, calls } = makeEngine(known);
    engine.handleBlockAddedEvent(blockEvent(bcastTx({ txId, outputs: [output(ALICE)] })));
    engine.handleBlockAddedEvent(blockEvent(bcastTx({ txId, outputs: [output(ALICE)] })));
    for (let i = 0; i < 6; i += 1) await flush();
    r.eq(calls.length, 1, "DAG duplicates: one REST lookup");
    r.check(delivered.length >= 1 && delivered.every((row) => row.senderAddress === ALICE), "DAG duplicates: delivered with the verified sender");
  }

  // --- 8. rooms nobody watches are not looked up ---
  {
    const txId = fakeTxid();
    const { engine, calls } = makeEngine(new Map());
    engine.handleBlockAddedEvent(blockEvent(bcastTx({ txId, channel: "unwatched", outputs: [output(VICTIM)] })));
    await flush();
    r.eq(calls.length, 0, "unwanted room: no REST lookup");
  }

  // --- 9. indexer rows (chess arena): verified against REST in bulk ---
  {
    const honest = fakeTxid();
    const forged = fakeTxid();
    const missing = fakeTxid();
    const known = new Map([
      [honest, restTx(honest, ALICE, [ALICE])],
      [forged, restTx(forged, MALLORY, [VICTIM])],
    ]);
    const { engine, calls, logs } = makeEngine(known);
    const rowsIn = [
      // The indexer guessed someone else for the honest row: the chain's sender wins.
      { txId: honest, channel: "chess-arena", senderAddress: VICTIM, content: "m", blockTime: 1 },
      // The indexer guessed the victim (output 0) for Mallory's row.
      { txId: forged, channel: "chess-arena", senderAddress: VICTIM, content: "m", blockTime: 2 },
      { txId: missing, channel: "chess-arena", senderAddress: VICTIM, content: "m", blockTime: 3 },
    ];
    const result = await engine.verifyBroadcastRows(rowsIn, { channel: "chess-arena" });
    r.eq(result.accepted.length, 1, "rows: one accepted");
    r.eq(result.accepted[0]?.senderAddress, ALICE, "rows: accepted row carries the verified sender, not the indexer's guess");
    r.eq(result.forged.length, 1, "rows: Mallory's row dropped");
    r.eq(result.unknown.length, 1, "rows: unanswerable row held back");
    r.check(calls.length === 1 && calls[0].method === "POST" && calls[0].url.includes("/transactions/search") && calls[0].url.includes("resolve_previous_outpoints=light"), "rows: one bulk search");
    r.check(logs.some((l) => l.includes(forged) && l.includes("dropped")), "rows: forged row logged with its txid");
    const again = await engine.verifyBroadcastRows(rowsIn, { channel: "chess-arena" });
    r.eq(calls.length, 1, "rows: verdicts cached, unknown row backs off (no new lookup)");
    r.eq(again.accepted.length + again.forged.length + again.unknown.length, 3, "rows: every row accounted for on the second pass");
  }
  {
    const a = fakeTxid();
    const b = fakeTxid();
    const known = new Map([[a, restTx(a, ALICE, [ALICE])], [b, restTx(b, MALLORY, [VICTIM])]]);
    const { engine, calls } = makeEngine(known, { searchStatus: 405 });
    const result = await engine.verifyBroadcastRows([
      { txId: a, channel: "chess-arena", senderAddress: ALICE, content: "m", blockTime: 1 },
      { txId: b, channel: "chess-arena", senderAddress: VICTIM, content: "m", blockTime: 2 },
    ]);
    r.eq(result.accepted.length, 1, "rows/search refused: fell back to per-tx lookups (accepted)");
    r.eq(result.forged.length, 1, "rows/search refused: fell back to per-tx lookups (forged)");
    r.eq(calls.filter((c) => c.method === "GET").length, 2, "rows/search refused: one GET per tx");
  }

  for (const f of r.failures) console.log(`FAIL ${f}`);
  console.log(`broadcast sender: ${r.pass} checks passed, ${r.fail} failed`);
  process.exit(r.fail ? 1 : 0);
}

await main();
