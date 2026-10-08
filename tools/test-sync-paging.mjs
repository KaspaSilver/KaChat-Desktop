// node tools/test-sync-paging.mjs - block-time paging of the 1:1 message and handshake syncs
// (audit DSK-040; iOS KaChatAPIClient.getPaginated). fetch is stubbed with an in-memory
// kasia-indexer that answers like the real one: rows with block_time >= the query's, ascending,
// .take(min(limit, 50)). Nothing leaves the machine.
import assert from "node:assert/strict";

// --- The stub indexer -------------------------------------------------------------------------
const DAY = Date.UTC(2026, 9, 1);
const indexer = { messages: [], handshakesIn: [], handshakesOut: [], inbox: [], calls: [] };
const resetIndexer = () => { indexer.messages = []; indexer.handshakesIn = []; indexer.handshakesOut = []; indexer.inbox = []; indexer.calls = []; };
const hexOf = (text) => Buffer.from(text, "utf8").toString("hex");
const txidOf = (tag, i) => hexOf(tag).padEnd(32, "0") + i.toString(16).padStart(32, "0");

function page(rows, url, cap = 50) {
  const from = Number(url.searchParams.get("block_time") || 0);
  const limit = Math.min(Number(url.searchParams.get("limit") || 10), cap);
  return [...rows]
    .sort((a, b) => a.block_time - b.block_time || a.tx_id.localeCompare(b.tx_id))
    .filter((row) => row.block_time >= from)
    .slice(0, limit);
}

globalThis.fetch = async (input) => {
  const url = new URL(String(input));
  indexer.calls.push(`${url.pathname}?${url.searchParams}`);
  const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  if (url.pathname.endsWith("/contextual-messages/by-sender")) {
    const alias = url.searchParams.get("alias");
    return json(page(indexer.messages.filter((row) => row.alias === alias), url));
  }
  if (url.pathname.endsWith("/contextual-messages/by-inbox")) return json(page(indexer.inbox, url, 500));
  if (url.pathname.endsWith("/handshakes/by-receiver")) return json(page(indexer.handshakesIn, url));
  if (url.pathname.endsWith("/handshakes/by-sender")) return json(page(indexer.handshakesOut, url));
  // Kaspa REST (the handshake scan's second source): nothing there.
  if (url.pathname.includes("/full-transactions")) return json([]);
  return new Response("not found", { status: 404 });
};

const { ADDRESS_PREFIX } = await import("../engine/network.js");
const {
  syncConversationFromIndexer, syncConversationFromIndexerWithLegacyAliases, syncIncomingHandshakesFromIndexer,
  syncOutgoingHandshakesFromIndexer, fetchInboxMessages, fetchBlockTimePages, SYNC_MAX_PAGES, SYNC_REWIND_MS,
} = await import("../engine/sync.js");

const ME = `${ADDRESS_PREFIX}qpme000000000000000000000000000000000000000000000000000000`;
const PEER = `${ADDRESS_PREFIX}qppeer00000000000000000000000000000000000000000000000000000`;
const INDEXER = "https://indexer.test";
const ALIAS = "KaChat";
const aliasHex = hexOf(ALIAS);

// The decryptor answers for anything: these tests are about which rows arrive, not the cipher.
const decryptMessage = async (encryptedHex) => `clear:${encryptedHex}`;
const messageRow = (i, blockTime, alias = aliasHex) => ({
  tx_id: txidOf("m", i), sender: PEER, alias, block_time: blockTime, accepting_daa_score: 1,
  message_payload: hexOf(Buffer.from(`msg ${i}`).toString("base64")),
});
const handshakeRow = (i, blockTime) => ({
  tx_id: txidOf("h", i), sender: PEER, receiver: ME, block_time: blockTime, accepting_daa_score: 1,
  message_payload: hexOf(`hello ${i}`),
});
const syncMessages = (cursor, extra = {}) => syncConversationFromIndexer({
  conversationId: "c1", contact: { id: "p1", address: PEER }, walletAddress: ME, privateKeyHex: "11".repeat(32),
  decryptMessage, cursor, indexerUrl: INDEXER, alias: ALIAS, ...extra,
});
const syncHandshakes = (cursor, extra = {}) => syncIncomingHandshakesFromIndexer({
  walletAddress: ME, privateKeyHex: "11".repeat(32), decryptMessage, cursor, indexerUrl: INDEXER, ...extra,
});
const callsTo = (path) => indexer.calls.filter((call) => call.includes(path)).length;
const unique = (list) => new Set(list).size === list.length;

let pass = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// --- 1:1 messages -----------------------------------------------------------------------------
test("messages: 60 rows inside 90 s all arrive and the cursor ends at the newest", async () => {
  resetIndexer();
  for (let i = 1; i <= 60; i += 1) indexer.messages.push(messageRow(i, DAY + i * 1000));
  const cursor = DAY + 1000; // the last sync stopped at the first of them
  const result = await syncMessages(cursor);
  assert.equal(result.messages.length, 60);
  assert.ok(unique(result.messages.map((m) => m.txid)), "no duplicate txids across pages");
  assert.equal(result.nextCursor, DAY + 60_000);
  assert.equal(result.complete, true);
  assert.equal(result.pages, 2);
  // First page rewound 90 s, the second from the first page's newest row.
  const asked = indexer.calls.map((call) => Number(new URLSearchParams(call.split("?")[1]).get("block_time")));
  assert.deepEqual(asked, [cursor - SYNC_REWIND_MS, DAY + 50_000]);
});

test("messages: a burst of 50 inside 90 s no longer hides the message after it", async () => {
  resetIndexer();
  for (let i = 1; i <= 50; i += 1) indexer.messages.push(messageRow(i, DAY + i * 1000));
  const first = await syncMessages(0);
  assert.equal(first.messages.length, 50);
  indexer.messages.push(messageRow(51, DAY + 3_600_000)); // an hour later
  const second = await syncMessages(first.nextCursor, { knownTxids: first.messages.map((m) => m.txid) });
  assert.deepEqual(second.messages.map((m) => m.txid), [txidOf("m", 51)]);
  assert.equal(second.nextCursor, DAY + 3_600_000);
});

test("messages: 120 rows sharing one block_time do not loop and progress is made", async () => {
  resetIndexer();
  const T = DAY + 500_000;
  for (let i = 1; i <= 120; i += 1) indexer.messages.push(messageRow(i, T));
  indexer.messages.push(messageRow(500, T + 1000));
  const result = await syncMessages(T - 5000);
  assert.ok(result.pages <= SYNC_MAX_PAGES);
  assert.equal(result.pages, 3); // rewound page, the same block_time again (stalled), then T + 1
  assert.ok(result.messages.some((m) => m.txid === txidOf("m", 500)), "the row after the tie arrives");
  assert.equal(result.nextCursor, T + 1000);
  assert.ok(unique(result.messages.map((m) => m.txid)));
  // And the next sync, rewound into the tie again, still terminates and still moves on.
  indexer.messages.push(messageRow(501, T + 2000));
  const next = await syncMessages(result.nextCursor, { knownTxids: result.messages.map((m) => m.txid) });
  assert.deepEqual(next.messages.map((m) => m.txid), [txidOf("m", 501)]);
  assert.equal(next.nextCursor, T + 2000);
});

test("messages: only the tie and nothing after it still ends (no infinite loop)", async () => {
  resetIndexer();
  const T = DAY + 700_000;
  for (let i = 1; i <= 120; i += 1) indexer.messages.push(messageRow(i, T));
  const result = await syncMessages(T);
  assert.equal(result.pages, 3);
  assert.equal(result.complete, true);
  assert.equal(result.nextCursor, T);
});

test("messages: a short page stops paging", async () => {
  resetIndexer();
  for (let i = 1; i <= 10; i += 1) indexer.messages.push(messageRow(i, DAY + i * 1000));
  const result = await syncMessages(0);
  assert.equal(result.messages.length, 10);
  assert.equal(result.pages, 1);
  assert.equal(result.complete, true);
  assert.equal(callsTo("/contextual-messages/by-sender"), 1);
});

test("messages: an empty answer keeps the cursor", async () => {
  resetIndexer();
  const result = await syncMessages(DAY);
  assert.equal(result.messages.length, 0);
  assert.equal(result.nextCursor, DAY);
  assert.equal(result.pages, 1);
});

test("messages: paging stops at the 20-page cap", async () => {
  resetIndexer();
  for (let i = 1; i <= 2000; i += 1) indexer.messages.push(messageRow(i, DAY + i * 10));
  const result = await syncMessages(0);
  assert.equal(SYNC_MAX_PAGES, 20);
  assert.equal(result.pages, 20);
  assert.equal(callsTo("/contextual-messages/by-sender"), 20);
  assert.equal(result.complete, false);
  // 50 on the first page, then 49 new per page (each repeats the previous page's newest row).
  assert.equal(result.messages.length, 50 + 19 * 49);
  assert.ok(unique(result.messages.map((m) => m.txid)));
  assert.equal(result.nextCursor, Math.max(...result.messages.map((m) => m.createdAt)));
});

test("messages: a failing later page keeps the pages read", async () => {
  resetIndexer();
  for (let i = 1; i <= 80; i += 1) indexer.messages.push(messageRow(i, DAY + i * 1000));
  const realFetch = globalThis.fetch;
  let n = 0;
  globalThis.fetch = async (input) => (++n === 2 ? new Response("{}", { status: 503 }) : realFetch(input));
  try {
    const result = await syncMessages(0);
    assert.equal(result.messages.length, 50);
    assert.equal(result.complete, false);
    assert.match(result.pageError, /503/);
    assert.equal(result.nextCursor, DAY + 50_000);
  } finally { globalThis.fetch = realFetch; }
});

test("messages: a failing first page still throws", async () => {
  resetIndexer();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: "down" }), { status: 500 });
  try {
    await assert.rejects(() => syncMessages(0), /Kasia indexer request failed \(500\)\. down/);
  } finally { globalThis.fetch = realFetch; }
});

test("legacy aliases: an alias that hit the page cap holds the cursor at its newest row", async () => {
  resetIndexer();
  const legacyHex = hexOf("abc123");
  for (let i = 1; i <= 2000; i += 1) indexer.messages.push(messageRow(i, DAY + i * 10, legacyHex));
  indexer.messages.push(messageRow(9000, DAY + 900_000));
  const result = await syncConversationFromIndexerWithLegacyAliases({
    conversationId: "c1", contact: { id: "p1", address: PEER }, walletAddress: ME, privateKeyHex: "11".repeat(32),
    decryptMessage, cursor: 0, indexerUrl: INDEXER, alias: ALIAS, legacyAliases: ["abc123"],
  });
  const legacyNewest = DAY + (50 + 19 * 49) * 10;
  assert.equal(result.nextCursor, legacyNewest); // not DAY + 900000 from the primary alias
  assert.equal(result.messages.length, 1 + 50 + 19 * 49);
});

// --- Incoming handshakes ----------------------------------------------------------------------
test("handshakes: 60 inside 90 s all arrive and the cursor ends at the newest", async () => {
  resetIndexer();
  for (let i = 1; i <= 60; i += 1) indexer.handshakesIn.push(handshakeRow(i, DAY + i * 1000));
  const result = await syncHandshakes(DAY + 1000);
  assert.equal(result.handshakes.length, 60);
  assert.ok(unique(result.handshakes.map((h) => h.txid)));
  assert.equal(result.nextCursor, DAY + 60_000);
  assert.equal(result.indexerPages, 2);
  assert.equal(result.indexerComplete, true);
});

test("handshakes: 120 sharing one block_time do not loop and progress is made", async () => {
  resetIndexer();
  const T = DAY + 500_000;
  for (let i = 1; i <= 120; i += 1) indexer.handshakesIn.push(handshakeRow(i, T));
  indexer.handshakesIn.push(handshakeRow(500, T + 1000));
  const result = await syncHandshakes(T - 5000);
  assert.equal(result.indexerPages, 3);
  assert.ok(result.handshakes.some((h) => h.txid === txidOf("h", 500)));
  assert.equal(result.nextCursor, T + 1000);
});

test("handshakes: a short page stops paging", async () => {
  resetIndexer();
  for (let i = 1; i <= 7; i += 1) indexer.handshakesIn.push(handshakeRow(i, DAY + i * 1000));
  const result = await syncHandshakes(0);
  assert.equal(result.handshakes.length, 7);
  assert.equal(result.indexerPages, 1);
  assert.equal(callsTo("/handshakes/by-receiver"), 1);
});

test("handshakes: paging stops at the 20-page cap and the cursor holds there", async () => {
  resetIndexer();
  for (let i = 1; i <= 2000; i += 1) indexer.handshakesIn.push(handshakeRow(i, DAY + i * 10));
  const result = await syncHandshakes(0);
  assert.equal(result.indexerPages, 20);
  assert.equal(callsTo("/handshakes/by-receiver"), 20);
  assert.equal(result.indexerComplete, false);
  assert.equal(result.handshakes.length, 50 + 19 * 49);
  assert.equal(result.nextCursor, DAY + (50 + 19 * 49) * 10);
});

test("outgoing handshakes: full pages are followed from the cursor (no rewind)", async () => {
  resetIndexer();
  for (let i = 1; i <= 75; i += 1) indexer.handshakesOut.push({ tx_id: txidOf("o", i), receiver: PEER, block_time: DAY + i * 1000, message_payload: "00" });
  const result = await syncOutgoingHandshakesFromIndexer({ walletAddress: ME, cursor: DAY, indexerUrl: INDEXER });
  assert.equal(result.handshakes.length, 75);
  assert.equal(result.nextCursor, DAY + 75_000);
  assert.equal(Number(new URLSearchParams(indexer.calls[0].split("?")[1]).get("block_time")), DAY);
});

test("inbox: a tie wider than a page steps past it instead of stopping", async () => {
  resetIndexer();
  const T = DAY + 10_000;
  for (let i = 1; i <= 150; i += 1) indexer.inbox.push({ tx_id: txidOf("i", i), sender: PEER, block_time: T });
  indexer.inbox.push({ tx_id: txidOf("i", 999), sender: ME, block_time: T + 5 });
  const found = await fetchInboxMessages({ tag: "ab".repeat(16), cursor: T, indexerUrl: INDEXER });
  assert.ok(found.some((row) => row.txid === txidOf("i", 999)));
  assert.ok(unique(found.map((row) => row.txid)));
});

// --- Group live read (POST /group-messages/since: strictly newer-than, limit 200) --------------
const memoryStorage = new Map();
globalThis.localStorage ??= {
  getItem: (key) => (memoryStorage.has(key) ? memoryStorage.get(key) : null),
  setItem: (key, value) => { memoryStorage.set(key, String(value)); },
  removeItem: (key) => { memoryStorage.delete(key); },
};
const { GroupManager } = await import("../engine/group-store.js");

function groupHarness(rows) {
  memoryStorage.clear();
  const wallet = ME;
  localStorage.setItem("kachat-groups-v1", JSON.stringify({ [wallet]: { g1: {
    groupId: "aa".repeat(32), blindingKeyHex: "bb".repeat(32), isAdmin: false, currentEpoch: 0, updatedAt: 1,
    members: [{ address: PEER, xOnlyPubKeyHex: "cc".repeat(32), isAdmin: true }],
  } } }));
  const asked = [];
  const served = new Set();
  const engine = {
    address: wallet,
    scanGroupControlByRecipient: async () => [],
    scanGroupControlByRecipientPage: async () => ({ rows: [], nextCursor: null, rawCount: 0 }),
    scanGroupMessages: async () => [],
    scanGroupMessagesSince: async (ids, sinceBlockTime, limit) => {
      asked.push(sinceBlockTime);
      const page = rows.filter((row) => row.blockTime > sinceBlockTime).slice(0, limit);
      for (const row of page) served.add(row.txId);
      return { count: page.length, latestBlockTime: page.length ? page[page.length - 1].blockTime : sinceBlockTime, messages: page };
    },
  };
  const manager = new GroupManager(engine);
  return { manager, asked, served };
}

test("group since: 450 rows inside the 10 s rewind are all read and the cursor moves past them", async () => {
  const T = DAY + 50_000;
  const rows = Array.from({ length: 450 }, (_, i) => ({ txId: `g${i}`, blockTime: T + 1 + i, payloadString: "x" }));
  const { manager, asked, served } = groupHarness(rows);
  manager.sinceSupported = true;
  manager.sinceBlockTime = T;
  manager._sincePasses = 1; // not a full-scan pass
  await manager.syncGroups();
  assert.equal(served.size, 450);
  assert.equal(manager.sinceBlockTime, T + 450);
  assert.equal(asked[0], T - 10_000);
  assert.equal(asked.length, 3);
});

test("group since: more than a page sharing one block time ends and moves on", async () => {
  const T = DAY + 80_000;
  const rows = Array.from({ length: 450 }, (_, i) => ({ txId: `t${i}`, blockTime: T + 5, payloadString: "x" }));
  rows.push({ txId: "after", blockTime: T + 9, payloadString: "x" });
  const { manager, asked, served } = groupHarness(rows);
  manager.sinceSupported = true;
  manager.sinceBlockTime = T;
  manager._sincePasses = 1;
  await manager.syncGroups();
  assert.ok(served.has("after"));
  assert.equal(manager.sinceBlockTime, T + 9);
  assert.ok(asked.length <= 20);
});

test("group since: the page cap holds the cursor where the next page would start", async () => {
  const T = DAY + 90_000;
  const rows = Array.from({ length: 5000 }, (_, i) => ({ txId: `c${i}`, blockTime: T + 1 + i, payloadString: "x" }));
  const { manager, asked } = groupHarness(rows);
  manager.sinceSupported = true;
  manager.sinceBlockTime = T;
  manager._sincePasses = 1;
  await manager.syncGroups();
  assert.equal(asked.length, 20);
  // Each page after the first starts at the previous newest - 1 (ties come back), so 199 new
  // rows per page; after page 20 the next would start at T + 199 + 19 * 199.
  assert.equal(manager.sinceBlockTime, T + 199 + 19 * 199);
  assert.ok(manager.sinceBlockTime < T + 5000, "not past rows never read");
});

// --- The helper on its own --------------------------------------------------------------------
test("fetchBlockTimePages: a page that goes backwards stops", async () => {
  let calls = 0;
  const result = await fetchBlockTimePages({
    startBlockTime: 1000, limit: 2,
    fetchPage: async () => { calls += 1; return calls === 1 ? [{ tx_id: "a", block_time: 2000 }, { tx_id: "b", block_time: 2001 }] : [{ tx_id: "c", block_time: 5 }, { tx_id: "d", block_time: 6 }]; },
  });
  assert.equal(calls, 2);
  assert.equal(result.complete, false);
  assert.equal(result.newest, 2001);
});

for (const [name, fn] of tests) {
  try { await fn(); pass += 1; }
  catch (error) { console.error(`FAIL ${name}\n  ${error?.stack || error}`); process.exitCode = 1; }
}
console.log(`${pass}/${tests.length} sync paging tests passed`);
