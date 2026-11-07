// node tools/test-message-sync-app.mjs - the 1:1 message / handshake sync in ui/app.js: a rewind
// during a sync is not overwritten and its catch-up runs, the handshake scan state stays bounded
// and survives a full storage, and the sweep wiring (hidden payments, counts, indexer, unread).
// app.js can't be loaded in node, so the pieces with behaviour are cut out of its source and run
// against stubs; the one-line wiring is checked on the source.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../ui/app.js", import.meta.url), "utf8");
const between = (start, end) => {
  const from = app.indexOf(start);
  const to = app.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `markers found: ${start}`);
  return app.slice(from, to);
};

let pass = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// --- Finding 7: a rewind during a sync -------------------------------------------------------
const syncSource = between("const conversationSyncInFlight = new Set();", "// The chats whose leftover sends have been settled");
function syncHarness(work) {
  const log = [];
  const env = {
    state: { conversations: [] },
    engine: { address: "kaspa:me", isKasiaCipherLoaded: () => true },
    activeConversationId: null,
    contactForConversation: () => ({ id: "p", address: "kaspa:peer" }),
    setChatFetchState: () => {},
    persistState: () => log.push("persist"),
    renderMessages: () => {},
    renderChats: () => {},
    appendEngineLog: (line) => log.push(line),
    syncOneConversationWork: (...args) => work(...args),
  };
  const names = Object.keys(env);
  const exportsList = "({ syncOneConversation, rewindConversationCursor, conversationRewindCount, conversationSyncInFlight })";
  // eslint-disable-next-line no-new-func
  const api = new Function(...names, `${syncSource}\nreturn ${exportsList};`)(...names.map((n) => env[n]));
  return { api, env, log };
}

test("a rewind while the conversation is syncing re-runs the catch-up once that run ends", async () => {
  const runs = [];
  let release;
  const { api, env } = syncHarness(async (entry, options) => {
    runs.push({ catchUp: options.catchUp, rewindsAtStart: options.rewindsAtStart, cursorAtStart: entry.sync?.cursor });
    if (runs.length === 1) await new Promise((resolve) => { release = resolve; });
    return runs.length === 2 ? 3 : 0;
  });
  const entry = { id: "c1", sync: { cursor: 5000 } };
  env.state.conversations.push(entry);
  const first = api.syncOneConversation(entry, { quiet: true });
  await tick();
  // noteConversationActivated mid-run: rewinds and asks for its catch-up, which finds the run in
  // flight and returns 0 (as before).
  api.rewindConversationCursor(entry, 0);
  assert.equal(await api.syncOneConversation(entry, { catchUp: true }), 0);
  assert.equal(entry.sync.cursor, 0);
  release();
  await first;
  for (let i = 0; i < 5 && runs.length < 2; i += 1) await tick();
  assert.equal(runs.length, 2, "the asked-for catch-up ran after the in-flight sync");
  assert.equal(runs[1].catchUp, true, "silently, as a catch-up");
  assert.equal(runs[1].cursorAtStart, 0, "from the rewound cursor");
  assert.equal(runs[1].rewindsAtStart, 1);
  await tick();
  assert.equal(runs.length, 2, "and only once");
});

test("no rewind: a skipped caller still just skips (no extra run)", async () => {
  const runs = [];
  let release;
  const { api, env } = syncHarness(async () => { runs.push(1); if (runs.length === 1) await new Promise((r) => { release = r; }); return 0; });
  const entry = { id: "c2", sync: { cursor: 10 } };
  env.state.conversations.push(entry);
  const first = api.syncOneConversation(entry);
  await tick();
  assert.equal(await api.syncOneConversation(entry), 0);
  release();
  await first;
  await tick(); await tick();
  assert.equal(runs.length, 1);
});

test("a rewound conversation deleted meanwhile is not fetched again", async () => {
  const runs = [];
  let release;
  const { api } = syncHarness(async () => { runs.push(1); if (runs.length === 1) await new Promise((r) => { release = r; }); return 0; });
  const entry = { id: "c3", sync: { cursor: 10 } }; // never in state.conversations
  const first = api.syncOneConversation(entry);
  await tick();
  api.rewindConversationCursor(entry, 0);
  release();
  await first;
  await tick(); await tick();
  assert.equal(runs.length, 1);
});

test("the sync's cursor write keeps a rewind made during the run", () => {
  const work = between("async function syncOneConversationWork(", "// A reply names the txid of the message it answers.");
  assert.match(work, /rewindsAtStart = conversationRewindCount\(conversationEntry\.id\)/);
  assert.match(work, /const rewoundMeanwhile = conversationRewindCount\(conversationEntry\.id\) !== rewindsAtStart;/);
  assert.match(work, /cursor: rewoundMeanwhile \? Number\(conversationEntry\.sync\?\.cursor \|\| 0\) : Number\(result\.nextCursor/);
  // Every rewind goes through the counted helper: activation, reply gaps and Re-sync.
  assert.match(between("function noteConversationActivated(", "/// Conversations with a sync already in flight."), /rewindConversationCursor\(conversationEntry, 0\);/);
  assert.match(between("function scheduleReplyGapRefetch(", "// XP-003 (iOS hybrid mode"), /rewindConversationCursor\(conversationEntry, rewindTo\);/);
  assert.match(app, /conversationEntry\.unreadCount = 0;\s*\/\/[^\n]*\n\s*rewindConversationCursor\(conversationEntry, 0\);/);
  assert.doesNotMatch(app, /sync = \{ \.\.\.\(conversationEntry\.sync \|\| \{\}\), cursor: (0|rewindTo)[ ,}]/, "no uncounted rewind left");
});

// --- Finding 11: the handshake scan state ----------------------------------------------------
const handshakeStateSource = between("const HANDSHAKE_PROCESSED_TXIDS_MAX", "/** The scan state for the active wallet");
function handshakeHarness(storage) {
  const log = [];
  // eslint-disable-next-line no-new-func
  const make = new Function("localStorage", "accountScopedKey", "HANDSHAKE_SYNC_KEY", "appendEngineLog", "engine",
    `${handshakeStateSource.replace("let handshakeSyncState =", "var handshakeSyncState =")}\nreturn { loadHandshakeSyncState, persistHandshakeSyncState, HANDSHAKE_PROCESSED_TXIDS_MAX, get: () => handshakeSyncState, set: (v) => { handshakeSyncState = v; } };`);
  const api = make(storage, (key, wallet) => `${key}:${wallet}`, "hs", (line) => log.push(line), { address: "kaspa:me" });
  return { api, log };
}

test("the handshake scan state loads capped to the newest 2000 txids", () => {
  const data = new Map();
  const storage = { getItem: (k) => (data.has(k) ? data.get(k) : null), setItem: (k, v) => data.set(k, String(v)), removeItem: (k) => data.delete(k) };
  const ids = Array.from({ length: 2600 }, (_, i) => `tx${i}`);
  data.set("hs:kaspa:me", JSON.stringify({ walletAddress: "kaspa:me", cursor: 9, parserVersion: 3, processedTxids: ids, declinedTxids: [] }));
  const { api } = handshakeHarness(storage);
  assert.equal(api.HANDSHAKE_PROCESSED_TXIDS_MAX, 2000);
  const loaded = api.loadHandshakeSyncState("kaspa:me");
  assert.equal(loaded.processedTxids.length, 2000);
  assert.equal(loaded.processedTxids[0], "tx600", "the oldest are the ones dropped");
  assert.equal(loaded.processedTxids.at(-1), "tx2599");
  assert.equal(loaded.cursor, 9);
});

test("a full storage does not throw out of the handshake sweep", () => {
  const storage = {
    getItem: () => null,
    setItem: () => { const error = new Error("QuotaExceededError"); error.name = "QuotaExceededError"; throw error; },
    removeItem: () => {},
  };
  const { api, log } = handshakeHarness(storage);
  api.set({ walletAddress: "kaspa:me", cursor: 1, parserVersion: 3, processedTxids: ["a"], declinedTxids: [] });
  assert.doesNotThrow(() => api.persistHandshakeSyncState());
  assert.ok(log.some((line) => /Could not save the handshake scan state/.test(line)));
});

test("the incoming handshake pass caps processed txids before saving", () => {
  const pass = between("async function syncIncomingHandshakeRequests(", "// Restore-parity pass (matches iOS)");
  assert.match(pass, /processedTxids\.length > HANDSHAKE_PROCESSED_TXIDS_MAX\) \{\s*handshakeSyncState\.processedTxids = handshakeSyncState\.processedTxids\.slice\(-HANDSHAKE_PROCESSED_TXIDS_MAX\);/);
  assert.ok(pass.indexOf("slice(-HANDSHAKE_PROCESSED_TXIDS_MAX)") < pass.indexOf("persistHandshakeSyncState();"));
});

// --- Findings 1, 2, 3, 10: sweep wiring ------------------------------------------------------
test("a deleted payment bubble is skipped and its txid counted as known", () => {
  const work = between("async function syncOneConversationWork(", "// A reply names the txid of the message it answers.");
  const payments = work.slice(work.indexOf("engine.syncIncomingPayments"));
  assert.match(work, /const hiddenPaymentKeys = new Set\(\(conversationEntry\.hiddenMessageKeys \|\| \[\]\)/);
  assert.match(payments, /knownTxids: \[\.\.\.new Set\(\[[^\n]*\.\.\.hiddenPaymentKeys\]\)\]/);
  assert.match(payments, /if \(hiddenPayment\(incoming\)\) continue;/);
  assert.ok(payments.indexOf("hiddenPayment(incoming)") < payments.indexOf("maybeNotifyIncoming"), "skipped before it can notify");
});

test("the 4-wide sweep adds each count after its await", () => {
  const sweep = between("async function refreshAllConversations(", "// No \"Delete Account\"");
  assert.doesNotMatch(sweep.slice(sweep.indexOf("await Promise.all"), sweep.indexOf("}));")), /added \+= await sync/);
  assert.match(sweep, /const found = await syncOneConversation\(conversationEntry, \{ quiet, catchUp \}\); added \+= found;/);
});

test("both handshake scans read Settings > Connectivity's indexer", () => {
  const incoming = between("async function syncIncomingHandshakeRequests(", "// Restore-parity pass (matches iOS)");
  const outgoing = between("async function syncOutgoingHandshakeEvidence(", "// Stranger payments");
  for (const pass of [incoming, outgoing]) {
    assert.match(pass, /indexerUrl: currentIndexerUrl\(\),/);
    assert.doesNotMatch(pass, /indexerUrlInput\?\.value \|\| undefined/);
  }
});

test("a handshake row bumps unread only when live, like a message", () => {
  const incoming = between("async function syncIncomingHandshakeRequests(", "// Restore-parity pass (matches iOS)");
  assert.match(incoming, /async function syncIncomingHandshakeRequests\(\{ quiet = true, catchUp = pendingInitialCatchUp \} = \{\}\)/);
  assert.match(incoming, /if \(!catchUp && isLiveMessageTime\(message\.createdAt\) && activeConversationId !== conversationEntry\.id\) \{\s*conversationEntry\.unreadCount/);
  assert.match(app, /syncIncomingHandshakeRequests\(\{ quiet, catchUp \}\)/, "the sweep passes its catch-up flag");
});

test("notes to self stuck on Sending are healed by the sync", () => {
  const work = between("async function syncOneConversationWork(", "// A reply names the txid of the message it answers.");
  assert.match(work, /if \(contact\.address === engine\.address\) \{\s*for \(const message of conversationEntry\.messages \|\| \[\]\) \{\s*if \(message\.direction === "outgoing" && message\.status === MESSAGE_STATUSES\.PENDING && message\.txid/);
  assert.match(work, /String\(message\.id \|\| ""\)\.startsWith\("indexer-"\)/, "only rows read back from the chain");
});

for (const [name, fn] of tests) {
  try { await fn(); pass += 1; }
  catch (error) { console.error(`FAIL ${name}\n  ${error?.stack || error}`); process.exitCode = 1; }
}
console.log(`message sync (app): ${pass}/${tests.length} passed`);
