// The indexer outage fallback (iOS 4f8e14bb, KaPost ee5ec98): the detector, how a fetch counts, the
// chain's history in the indexer's row shapes, and .kachat's failover.
// Run: node tools/test-indexer-outage.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createIndexerHealth, indexerFetchOutcome, fromIndexerOrChain, shouldSkipIndexer, watchIndexerFetch, indexerKey } from "../engine/indexer-health.js";
import { createChainHistory, parseChainRows, CHAIN_PAGE_SIZE } from "../engine/chain-history.js";
import { KachatNamesRegistry } from "../engine/kachat-names/registry.js";

const URL_A = "https://indexer.example/";
let passed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
function memoryStorage() {
  const map = new Map();
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k) };
}
function health(start = 1_000_000) {
  const clock = { at: start };
  const storage = memoryStorage();
  return { clock, storage, h: createIndexerHealth({ now: () => clock.at, storage }) };
}
const down3 = ({ h, clock }) => { for (let i = 0; i < 3; i += 1) { h.recordFailure(URL_A); clock.at += 5_000; } };
const hex = (text) => Buffer.from(text, "utf8").toString("hex");

test("one failure is no outage; three, 5 s apart, are", () => {
  const s = health();
  s.h.recordFailure(URL_A); assert.equal(s.h.isDown(URL_A), false);
  s.clock.at += 5_000; s.h.recordFailure(URL_A); assert.equal(s.h.isDown(URL_A), false);
  s.clock.at += 5_000; s.h.recordFailure(URL_A); assert.equal(s.h.isDown(URL_A), true);
});
test("failures inside 5 s count once", () => {
  const s = health();
  for (let i = 0; i < 20; i += 1) { s.h.recordFailure(URL_A); s.clock.at += 100; }
  assert.equal(s.h.isDown(URL_A), false);
});
test("failures over two minutes apart aren't a run", () => {
  const s = health();
  for (let i = 0; i < 4; i += 1) { s.h.recordFailure(URL_A); s.clock.at += 121_000; }
  assert.equal(s.h.isDown(URL_A), false);
});
test("an answer clears a run", () => {
  const s = health();
  s.h.recordFailure(URL_A); s.clock.at += 5_000; s.h.recordFailure(URL_A); s.clock.at += 5_000;
  s.h.recordAnswer(URL_A);
  s.h.recordFailure(URL_A);
  assert.equal(s.h.isDown(URL_A), false);
});
test("going down and coming back are announced, with when it began", () => {
  const s = health();
  const heard = [];
  s.h.subscribe((change) => heard.push(change));
  const start = s.clock.at + 10_000;
  down3(s);
  s.h.recordAnswer(URL_A);
  assert.deepEqual(heard.map((c) => c.down), [true, false]);
  assert.equal(heard[1].downSinceMs, start);
  assert.equal(heard[1].key, indexerKey(URL_A));
});
test("an outage the page was closed during is closed by the first answer", () => {
  const s = health();
  down3(s);
  const reopened = createIndexerHealth({ now: () => s.clock.at, storage: s.storage });
  const heard = [];
  reopened.subscribe((change) => heard.push(change));
  assert.equal(reopened.isDown(URL_A), false, "it has to be seen failing again first");
  reopened.recordAnswer(URL_A);
  assert.equal(heard[0].down, false);
  assert.ok(heard[0].downSinceMs > 0);
});
test("indexers are tracked apart", () => {
  const s = health();
  down3(s);
  assert.equal(s.h.isDown("https://other.example/x"), false);
  assert.equal(s.h.isDown(`${URL_A}deep/path?x=1`), true);
});
test("one recovery check a minute", () => {
  const s = health();
  down3(s);
  assert.equal(s.h.claimRecoveryCheck(URL_A), false, "the first waits a minute");
  s.clock.at += 60_000;
  assert.equal(s.h.claimRecoveryCheck(URL_A), true);
  assert.equal(s.h.claimRecoveryCheck(URL_A), false);
});
test("what a fetch says about the indexer", () => {
  const res = (status, type = "application/json") => ({ status, headers: { get: () => type } });
  const o = (args) => indexerFetchOutcome({ offline: false, ...args });
  assert.equal(o({ response: res(200) }), "answered");
  assert.equal(o({ response: res(404) }), "answered");
  assert.equal(o({ response: res(400) }), "answered");
  assert.equal(o({ response: res(429) }), "down");
  assert.equal(o({ response: res(503) }), "down");
  assert.equal(o({ response: res(200, "text/html; charset=utf-8") }), "down");
  assert.equal(o({ response: res(429), relayLimited: true }), "inconclusive", "the relay's limit isn't the indexer");
  assert.equal(o({ error: new TypeError("Failed to fetch") }), "down");
  assert.equal(o({ error: Object.assign(new Error("x"), { name: "AbortError" }), elapsedMs: 200 }), "inconclusive");
  assert.equal(o({ error: Object.assign(new Error("x"), { name: "AbortError" }), elapsedMs: 20_000 }), "down", "Desktop's timeouts are aborts");
  assert.equal(indexerFetchOutcome({ error: new TypeError("x"), offline: true }), "inconclusive", "no connection says nothing");
});
test("while up the indexer is asked; a one-off failure is thrown", async () => {
  const s = health();
  let chain = 0;
  assert.equal(await fromIndexerOrChain(URL_A, async () => "indexer", async () => { chain += 1; return "chain"; }, { health: s.h }), "indexer");
  await assert.rejects(fromIndexerOrChain(URL_A, async () => { throw new Error("blip"); }, async () => { chain += 1; return "chain"; }, { health: s.h }), /blip/);
  assert.equal(chain, 0);
});
test("while down the chain answers, and the indexer isn't asked", async () => {
  const s = health();
  down3(s);
  let asked = 0;
  const answer = await fromIndexerOrChain(URL_A, async () => { asked += 1; return "indexer"; }, async () => "chain", { health: s.h, probe: () => {} });
  assert.equal(answer, "chain");
  assert.equal(asked, 0);
});
test("the failure that confirms the outage falls to the chain at once", async () => {
  const s = health();
  s.h.recordFailure(URL_A); s.clock.at += 5_000; s.h.recordFailure(URL_A); s.clock.at += 5_000;
  const answer = await fromIndexerOrChain(URL_A, async () => { s.h.recordFailure(URL_A); throw new Error("down"); }, async () => "chain", { health: s.h, probe: () => {} });
  assert.equal(answer, "chain");
});
test("the recovery probe goes out once a minute while down", () => {
  const s = health();
  down3(s);
  s.clock.at += 60_000;
  let probes = 0;
  assert.equal(shouldSkipIndexer(URL_A, { health: s.h, probe: () => { probes += 1; } }), true);
  assert.equal(shouldSkipIndexer(URL_A, { health: s.h, probe: () => { probes += 1; } }), true);
  return new Promise((resolve) => setTimeout(() => { assert.equal(probes, 1); resolve(); }, 5));
});
test("watchIndexerFetch reports before the caller sees the result", async () => {
  const s = health();
  const fail = () => watchIndexerFetch(URL_A, async () => { throw new TypeError("x"); }, { health: s.h });
  for (let i = 0; i < 3; i += 1) { await assert.rejects(fail()); s.clock.at += 5_000; }
  assert.equal(globalThis.navigator?.onLine === false || s.h.isDown(URL_A), true);
  await watchIndexerFetch(URL_A, async () => ({ status: 200, headers: { get: () => "application/json" } }), { health: s.h });
  assert.equal(s.h.isDown(URL_A), false);
});

const ME = "kaspa:me", THEM = "kaspa:them";
const row = (id, time, senders, payload, outputs = [[ME, 100]]) => ({
  transaction_id: id, block_time: time, is_accepted: true, payload: hex(payload),
  inputs: senders.map((address) => ({ previous_outpoint_address: address })),
  outputs: outputs.map(([address, amount]) => ({ script_public_key_address: address, amount })),
});
function history(pages) {
  const urls = [];
  const clock = { at: 1_000 };
  const chain = createChainHistory({
    now: () => clock.at,
    sleep: async () => {},
    restBase: () => "https://rest.example",
    fetchImpl: async (url) => {
      urls.push(url);
      const page = typeof pages === "function" ? pages(url) : pages;
      return { status: page.status ?? 200, json: async () => page.rows ?? page };
    },
  });
  return { chain, urls, clock };
}
const verifyAs = (table) => async (raw, txid) => ({ check: table[txid] ? "valid" : "invalid", sender: table[txid] || null });

test("unaccepted rows are left out; a short page ends the read", async () => {
  const { transactions, rows } = parseChainRows([row("a", 5, [ME], "x"), { ...row("b", 6, [ME], "y"), is_accepted: false }]);
  assert.equal(rows, 2);
  assert.deepEqual(transactions.map((t) => t.txId), ["a"]);
  const { chain, urls } = history([row("a", 5, [ME], "x")]);
  await chain.chainTransactions(ME, 0);
  assert.equal(urls.length, 1);
});
test("too much history throws rather than move a cursor past what it never saw", async () => {
  const full = Array.from({ length: CHAIN_PAGE_SIZE }, (_, i) => row(`t${i}`, 10_000 + i, [ME], "x"));
  const { chain, urls } = history(full);
  await assert.rejects(chain.chainTransactions(ME, 0), /Too much history/);
  assert.equal(urls.length, 20);
});
test("the read stops at the page that reaches 'since'", async () => {
  const full = Array.from({ length: CHAIN_PAGE_SIZE }, (_, i) => row(`t${i}`, 10_000 + i, [ME], "x"));
  const { chain, urls } = history(full);
  const out = await chain.chainTransactions(ME, 10_050);
  assert.equal(urls.length, 1);
  assert.equal(out.length, CHAIN_PAGE_SIZE - 50);
  assert.equal(out[0].blockTime, 10_050, "oldest first");
});
test("a 429 backs off for 30 s", async () => {
  const { chain, urls, clock } = history({ status: 429 });
  await assert.rejects(chain.chainTransactions(ME, 0), /answered 429/);
  await assert.rejects(chain.chainTransactions(ME, 0), /busy/);
  assert.equal(urls.length, 1);
  clock.at += 31_000;
  await assert.rejects(chain.chainTransactions(ME, 0), /answered 429/);
});
test("one sweep shares a read for a moment", async () => {
  const { chain, urls } = history([row("a", 5, [ME], "x")]);
  await chain.chainTransactions(ME, 0);
  await chain.chainTransactions(ME, 0);
  assert.equal(urls.length, 1);
});
test("messages come back in the indexer's shape, by alias, proven by their author", async () => {
  const { chain } = history([
    row("good", 5, [THEM], "kchat:1:comm:aabb:QUJD"),
    row("legacy", 6, [THEM], "ciph_msg:1:comm:aabb:REVG"),
    row("otherAlias", 7, [THEM], "kchat:1:comm:ccdd:R0hJ"),
    row("notTheirs", 8, [ME], "kchat:1:comm:aabb:SktM"),
    row("forged", 9, [THEM], "kchat:1:comm:aabb:TU5P"),
  ]);
  const rows = await chain.contextualRows({ address: THEM, alias: "aabb", verify: verifyAs({ good: THEM, legacy: THEM, forged: "kaspa:someoneelse" }) });
  assert.deepEqual(rows.map((r) => r.tx_id), ["good", "legacy"]);
  assert.equal(Buffer.from(rows[0].message_payload, "hex").toString(), "QUJD", "hex(BASE64), as the indexer serves it");
  assert.equal(rows[0].sender, THEM);
});
test("handshakes sent and received", async () => {
  const { chain } = history([
    row("in", 5, [THEM], "kchat:1:handshake:SEALED"),
    row("out", 6, [ME], "ciph_msg:1:handshake:SEALED", [[THEM, 1]]),
    row("plain", 7, [THEM], "hello"),
  ]);
  const incoming = await chain.handshakeRows({ address: ME, sent: false, verify: verifyAs({ in: THEM }) });
  assert.deepEqual(incoming.map((r) => [r.tx_id, r.sender, r.receiver]), [["in", THEM, ME]]);
  assert.equal(Buffer.from(incoming[0].message_payload, "hex").toString(), "SEALED", "without its protocol prefix");
  const sent = await chain.handshakeRows({ address: ME, sent: true, verify: verifyAs({ out: ME }) });
  assert.deepEqual(sent.map((r) => [r.tx_id, r.receiver]), [["out", THEM]]);
});
test("a row that can't be verified stays out; a proven one isn't asked again", async () => {
  const { chain, clock } = history([row("a", 5, [THEM], "kchat:1:comm:aa:QQ==")]);
  let calls = 0;
  const verify = async () => { calls += 1; return { check: "valid", sender: THEM }; };
  await chain.contextualRows({ address: THEM, alias: "aa", verify });
  clock.at += 60_000;
  assert.equal((await chain.contextualRows({ address: THEM, alias: "aa", verify })).length, 1);
  assert.equal(calls, 1);
  const { chain: other } = history([row("a", 5, [THEM], "kchat:1:comm:aa:QQ==")]);
  assert.equal((await other.contextualRows({ address: THEM, alias: "aa", verify: async () => { throw new Error("no"); } })).length, 0);
});
test("self-stash by scope, only this wallet's", async () => {
  const { chain } = history([
    row("a", 5, [ME], "kchat:1:self_stash:saved_handshake:DATA"),
    row("b", 6, [ME], "kchat:1:self_stash:other:DATA"),
    row("c", 7, [THEM], "kchat:1:self_stash:saved_handshake:DATA"),
  ]);
  const rows = await chain.selfStashRows({ owner: ME, scope: "saved_handshake" });
  assert.deepEqual(rows.map((r) => r.tx_id), ["a"]);
  assert.equal(Buffer.from(rows[0].stashed_data, "hex").toString(), "DATA");
});

function registry() {
  const clock = { at: 1_000_000 };
  const logs = [];
  const reg = new KachatNamesRegistry({
    isEnabled: () => true, indexerBase: () => "https://i.example", restBase: () => "https://r.example",
    fetch: async () => { throw new TypeError("network"); }, sleep: async () => {}, log: (...a) => logs.push(a.join(" ")),
    nowMs: () => clock.at, standbyWalk: false,
  });
  reg._nowMs = () => BigInt(clock.at);
  reg.source = { kind: "indexer", base: "https://i.example" };
  reg.manifest = { network: "testnet" };
  reg.refresh = async () => {};
  return { reg, clock, logs };
}
test(".kachat: a run of failures moves to the chain copy, not one", async () => {
  const { reg, clock } = registry();
  await assert.rejects(reg._get("https://i.example", "/names/x"));
  assert.equal(reg.source.kind, "indexer");
  clock.at += 5_000; await assert.rejects(reg._get("https://i.example", "/names/x"));
  assert.equal(reg.source.kind, "indexer");
  clock.at += 5_000; await assert.rejects(reg._get("https://i.example", "/names/x"));
  assert.equal(reg.source.kind, "chain");
  assert.equal(reg._indexerRetryNotBefore, clock.at + 60_000);
});
test(".kachat: a 404 is an answer", async () => {
  const { reg, clock } = registry();
  reg.deps.fetch = async () => ({ status: 404, text: async () => "" });
  for (let i = 0; i < 5; i += 1) { await assert.rejects(reg._get("https://i.example", "/names/x"), /not found/); clock.at += 5_000; }
  assert.equal(reg.source.kind, "indexer");
});
test(".kachat: on the chain the indexer waits out its backoff, which grows to ten minutes", async () => {
  const { reg, clock } = registry();
  for (let i = 0; i < 3; i += 1) { await assert.rejects(reg._get("https://i.example", "/names/x")); clock.at += 5_000; }
  let asked = 0;
  reg.deps.fetch = async () => { asked += 1; throw new TypeError("network"); };
  assert.equal((await reg._chooseSource({ registryCovenantId: new Uint8Array(32) })).kind, "chain");
  assert.equal(asked, 0);
  assert.equal(reg._failoverBackoffMs, 120_000);
  reg._failoverBackoffMs = 500_000;
  reg.source = { kind: "indexer", base: "https://i.example" };
  reg._failOverToChain(reg.manifest, new Error("x"));
  assert.equal(reg._failoverBackoffMs, 600_000);
});

test("wiring: rooms, KaPlay, chats and fetches use the detector", () => {
  const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
  assert.match(read("engine/endpoints.js"), /watchIndexerFetch\(url, \(\) => routedFetch\(input, init\), \{ isRelayLimit: isRelayRateLimit \}\)/);
  const sync = read("engine/sync.js");
  assert.equal(sync.split("fromIndexerOrChain(").length - 1, 4);
  assert.match(sync, /signal: controller\.signal/);
  assert.match(read("ui/broadcasts.js"), /isIndexerTrackedBroadcastChannel\(channel\) && !isIndexerDown\(roomIndexerBase\(channel\)\)/);
  const app = read("ui/app.js");
  assert.match(app, /const floor = Math\.max\(0, Number\(downSinceMs\) - INDEXER_RECOVERY_MARGIN_MS\);\n\s+rewindAllSyncCursors\(floor\);\n\s+getGroupManager\(\)\?\.rewindGroupCursors\?\.\(floor\);/);
  const chess = read("ui/chess-tournaments.js");
  assert.match(chess, /if \(!flagIsConfirmed\(t, game, T\.flagAt\(game\)\)\) continue;/);
  assert.match(chess, /if \(!\(await arenaViewIsConfirmed\(\)\)\)/);
});

for (const [name, fn] of tests) {
  try { await fn(); passed += 1; console.log(`ok - ${name}`); }
  catch (error) { console.log(`FAIL ${name}\n  ${error?.stack || error}`); process.exitCode = 1; }
}
console.log(`indexer outage: ${passed}/${tests.length} passed`);
