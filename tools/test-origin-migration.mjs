// node tools/test-origin-migration.mjs - the kachat.app/desktop -> desktop.kachat.app hand-off
// (ui/origin-migration.js, DSK-013): message validation on both sides, what travels, and the
// receiver's store-and-acknowledge path. localStorage and the IndexedDB chat store are in-memory.
import assert from "node:assert/strict";
import {
  migrationConfig, migrationRole, isMigratableLocalStorageKey, isMigratableChatKey, isRebuildableCacheKey,
  collectLocalStorageEntries, filterChatEntries, hashSnapshot, hasSavedAccounts,
  validateReadyMessage, validateAckMessage, validateDataMessage, createMigrationReceiver,
  MSG_READY, MSG_DATA, MSG_ACK, PROTOCOL_VERSION, MIGRATED_IN_MARKER_KEY, MIGRATED_MARKER_KEY,
} from "../ui/origin-migration.js";

class MemoryStorage {
  constructor(entries = []) { this.map = new Map(entries); }
  getItem(key) { return this.map.has(key) ? this.map.get(key) : null; }
  setItem(key, value) { this.map.set(key, String(value)); }
  removeItem(key) { this.map.delete(key); }
  get length() { return this.map.size; }
  key(index) { return [...this.map.keys()][index] ?? null; }
}
class MemoryChatStore {
  constructor(entries = []) { this.map = new Map(entries); this.failPut = false; }
  async getAll() { return [...this.map]; }
  async clear() { this.map.clear(); }
  async putAll(entries) { if (this.failPut) { this.failPut = false; throw new Error("quota"); } for (const [k, v] of entries) this.map.set(k, v); }
  async getMany(keys) { return keys.map((k) => [k, this.map.has(k) ? this.map.get(k) : null]); }
}

const OLD = "https://kachat.app";
const NEW = "https://desktop.kachat.app";
const NONCE = "ab".repeat(32);
const opener = { name: "opener-window" };
const popup = { name: "popup-window" };
let passed = 0;
async function test(name, fn) { await fn(); passed += 1; console.log(`ok - ${name}`); }

// ---- the old origin's storage, as the app leaves it ----
const sealedAccounts = JSON.stringify([
  { address: "kaspa:qqtestaddressone", name: "Main", sealed: { v: 1, iv: "00".repeat(12), ct: "ff".repeat(40) } },
  { address: "kaspa:qqtestaddresstwo", name: "Savings", sealed: { v: 1, iv: "11".repeat(12), ct: "ee".repeat(40) } },
]);
const oldStorage = new MemoryStorage([
  ["kachat-saved-accounts-v1", sealedAccounts],
  ["kachat-app-password-v1", JSON.stringify({ version: 2, salt: "aa", hash: "bb", iterations: 600000, wrappedKey: { iv: "cc", ct: "dd" } })],
  ["kachat-shell-testing-wallet-v2", JSON.stringify({ address: "kaspa:qqtestaddressone" })],
  ["kachat-account-data-v1:kaspa:qqtestaddressone:kachat-nextcloud-v1", JSON.stringify({ server: "https://cloud.example" })],
  ["kachat-address-book-v1", "{}"],
  ["kachat-theme-preference-v1", "dark"],
  ["kachat.pwa.iosHintDismissed", "1"],
  ["kachat-kns-pending-commit-v1", "{\"recover\":true}"],
  // caches that rebuild themselves - never sent
  ["kachat-kas-price-cache-v2", "{}"],
  ["kachat-account-data-v1:kaspa:qqtestaddressone:kachat-cold-cache-v1", "{}"],
  ["kachat-profile-cache-v1:social:index", "[]"],
  ["kachat-kns-domain-cache-v1", "{}"],
  ["kachat-broadcast-messages-cache-v1", "[]"],
  ["kachat.browser.node-registry.v1", "{}"],
  ["kachat-public-nodes-seen", "[]"],
  ["kachat-vault-session-v1", "x"],
  // not the app's / the migration's own
  ["link-site-pref", "nope"],
  [MIGRATED_MARKER_KEY, "{}"],
]);
const oldChat = [
  ["kachat-account-data-v1:kaspa:qqtestaddressone:kachat-shell-step25-state", JSON.stringify({ contacts: [], conversations: [] })],
  ["kachat-account-data-v1:kaspa:qqtestaddressone:kachat-address-book-photo-v1:kaspa:qqfriend", "data:image/png;base64,AAAA"],
  ["kachat-shell-message-history-v1", "[]"],
  ["weird-binary", new Uint8Array([1, 2])],
  ["kachat-not-text", { a: 1 }],
];

function snapshot() {
  const { entries, skipped } = filterChatEntries(oldChat);
  return { snapshot: { localStorage: collectLocalStorageEntries(oldStorage), chatStore: entries }, skipped };
}
function dataEvent(overrides = {}, dataOverrides = {}) {
  return {
    origin: OLD,
    source: opener,
    data: { type: MSG_DATA, v: PROTOCOL_VERSION, nonce: NONCE, snapshot: snapshot().snapshot, ...dataOverrides },
    ...overrides,
  };
}
function receiver({ storage = new MemoryStorage(), chatStore = new MemoryChatStore(), confirm = async () => true, maxChars } = {}) {
  const replies = [];
  const r = createMigrationReceiver({ expectedOrigin: OLD, source: opener, nonce: NONCE, storage, chatStore, confirm, reply: (m) => replies.push(m), maxChars, now: () => 1234 });
  return { r, replies, storage, chatStore };
}

await test("config + roles: old under /desktop/, new on its own origin, nothing elsewhere", () => {
  // off by default: the live build must never show the move screen before desktop.kachat.app exists
  assert.equal(migrationConfig().enabled, false);
  assert.equal(migrationRole({ origin: OLD, pathname: "/desktop/" }, migrationConfig()), "none");
  const cfg = migrationConfig({ enabled: "1" });
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.from, OLD);
  assert.equal(cfg.to, NEW);
  assert.equal(cfg.fromPath, "/desktop/");
  assert.equal(migrationRole({ origin: OLD, pathname: "/desktop/" }, cfg), "old");
  assert.equal(migrationRole({ origin: OLD, pathname: "/desktop" }, cfg), "old");
  assert.equal(migrationRole({ origin: OLD, pathname: "/post/abc" }, cfg), "none");
  assert.equal(migrationRole({ origin: NEW, pathname: "/" }, cfg), "new");
  assert.equal(migrationRole({ origin: "https://kachatdesktoptest.duckdns.org", pathname: "/" }, cfg), "none");
  assert.equal(migrationRole({ origin: "http://localhost:5173", pathname: "/" }, cfg), "none");
  assert.equal(migrationConfig({ enabled: "0" }).enabled, false);
  assert.equal(migrationConfig({ from: NEW, to: NEW }).enabled, false);
  const local = migrationConfig({ enabled: "1", from: "http://127.0.0.1:5181", fromPath: "/", to: "http://localhost:5182" });
  assert.equal(migrationRole({ origin: "http://127.0.0.1:5181", pathname: "/" }, local), "old");
  assert.equal(migrationRole({ origin: "http://localhost:5182", pathname: "/" }, local), "new");
});

await test("what travels: app keys and chat entries as stored; caches, foreign and own keys stay", () => {
  const { snapshot: snap, skipped } = snapshot();
  const keys = snap.localStorage.map(([k]) => k);
  for (const k of ["kachat-saved-accounts-v1", "kachat-app-password-v1", "kachat-shell-testing-wallet-v2",
    "kachat-account-data-v1:kaspa:qqtestaddressone:kachat-nextcloud-v1", "kachat-address-book-v1",
    "kachat-theme-preference-v1", "kachat.pwa.iosHintDismissed", "kachat-kns-pending-commit-v1"]) assert.ok(keys.includes(k), k);
  for (const k of ["kachat-kas-price-cache-v2", "kachat-account-data-v1:kaspa:qqtestaddressone:kachat-cold-cache-v1",
    "kachat-profile-cache-v1:social:index", "kachat-kns-domain-cache-v1", "kachat-broadcast-messages-cache-v1",
    "kachat.browser.node-registry.v1", "kachat-public-nodes-seen", "kachat-vault-session-v1", "link-site-pref", MIGRATED_MARKER_KEY]) {
    assert.ok(!keys.includes(k), k);
  }
  assert.ok(isRebuildableCacheKey("kachat-kas-daily-price-v2"));
  assert.ok(!isRebuildableCacheKey("kachat-kns-pending-transfer-v1:abc"));
  // sealed records travel byte for byte
  assert.equal(snap.localStorage.find(([k]) => k === "kachat-saved-accounts-v1")[1], sealedAccounts);
  assert.deepEqual(snap.chatStore.map(([k]) => k), [
    "kachat-account-data-v1:kaspa:qqtestaddressone:kachat-address-book-photo-v1:kaspa:qqfriend",
    "kachat-account-data-v1:kaspa:qqtestaddressone:kachat-shell-step25-state",
    "kachat-shell-message-history-v1",
  ]);
  assert.equal(skipped, 1);
  assert.ok(isMigratableLocalStorageKey("kachat-language-v1"));
  assert.ok(!isMigratableChatKey("other"));
  assert.ok(hasSavedAccounts(oldStorage));
  assert.ok(!hasSavedAccounts(new MemoryStorage([["kachat-theme-preference-v1", "dark"]])));
});

await test("hash is order-independent and changes with any byte", () => {
  const { snapshot: snap } = snapshot();
  const h = hashSnapshot(snap);
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(hashSnapshot({ localStorage: [...snap.localStorage].reverse(), chatStore: [...snap.chatStore].reverse() }), h);
  const changed = { ...snap, localStorage: snap.localStorage.map(([k, v], i) => [k, i === 0 ? `${v} ` : v]) };
  assert.notEqual(hashSnapshot(changed), h);
  // a key moved from one half to the other is a different snapshot
  const [first, ...rest] = snap.localStorage;
  assert.notEqual(hashSnapshot({ localStorage: rest, chatStore: [first, ...snap.chatStore] }), h);
});

await test("receiver: wrong origin is rejected and nothing is stored", async () => {
  const { r, replies, storage } = receiver();
  for (const origin of ["https://evil.example", "http://kachat.app", "https://kachat.app.evil.example", "https://link.kachat.app", NEW, "null"]) {
    const res = await r.handle(dataEvent({ origin }));
    assert.equal(res.accepted, false);
    assert.equal(res.reason, "origin");
  }
  assert.equal(replies.length, 0);
  assert.equal(storage.length, 0);
  assert.equal(r.active, true);
});

await test("receiver: a message from another window of the right origin is rejected", async () => {
  const { r, replies } = receiver();
  const res = await r.handle(dataEvent({ source: { name: "some other kachat.app frame" } }));
  assert.deepEqual([res.accepted, res.reason], [false, "source"]);
  assert.equal(replies.length, 0);
});

await test("receiver: wrong or missing nonce is rejected", async () => {
  const { r, replies, storage } = receiver();
  for (const nonce of ["cd".repeat(32), NONCE.toUpperCase(), NONCE.slice(2), "", undefined, 42]) {
    const res = await r.handle(dataEvent({}, { nonce }));
    assert.deepEqual([res.accepted, res.reason], [false, "nonce"]);
  }
  assert.equal(replies.length, 0);
  assert.equal(storage.length, 0);
});

await test("receiver: oversize payload is rejected", async () => {
  const { r, replies, storage } = receiver({ maxChars: 1000 });
  const res = await r.handle(dataEvent());
  assert.deepEqual([res.accepted, res.reason], [false, "size"]);
  assert.equal(replies.length, 0);
  assert.equal(storage.length, 0);
  // and the real limit: one huge value
  const big = receiver();
  const huge = { localStorage: [["kachat-theme-preference-v1", "x".repeat(128 * 1024 * 1024 + 1)]], chatStore: [] };
  const res2 = await big.r.handle(dataEvent({}, { snapshot: huge }));
  assert.equal(res2.reason, "size");
});

await test("receiver: bad shapes are rejected (foreign keys, cache keys, non-strings, duplicates, wrong type)", async () => {
  const cases = [
    [{ type: MSG_READY }, "shape"],
    [{ v: 2 }, "shape"],
    [{ snapshot: null }, "shape"],
    [{ snapshot: { localStorage: {}, chatStore: [] } }, "shape"],
    [{ snapshot: { localStorage: [["kachat-x", 1]], chatStore: [] } }, "shape"],
    [{ snapshot: { localStorage: [["kachat-x"]], chatStore: [] } }, "shape"],
    [{ snapshot: { localStorage: [["evil-key", "v"]], chatStore: [] } }, "key"],
    [{ snapshot: { localStorage: [["kachat-kas-price-cache-v2", "{}"]], chatStore: [] } }, "key"],
    [{ snapshot: { localStorage: [[MIGRATED_IN_MARKER_KEY, "{}"]], chatStore: [] } }, "key"],
    [{ snapshot: { localStorage: [["kachat-a", "1"], ["kachat-a", "2"]], chatStore: [] } }, "duplicate"],
    [{ snapshot: { localStorage: [], chatStore: [["kachat-x", { o: 1 }]] } }, "shape"],
    [{ snapshot: { localStorage: [], chatStore: [["idb-other", "v"]] } }, "key"],
  ];
  for (const [patch, reason] of cases) {
    const { r, storage } = receiver();
    const res = await r.handle(dataEvent({}, patch));
    assert.deepEqual([res.accepted, res.reason], [false, reason], JSON.stringify(patch).slice(0, 80));
    assert.equal(storage.length, 0);
  }
  const { r } = receiver();
  assert.equal((await r.handle({ origin: OLD, source: opener, data: "kachat-migrate-data" })).reason, "shape");
});

await test("receiver: happy path stores everything, acknowledges with the stored hash, and is one-shot", async () => {
  const leftover = new MemoryStorage([["kachat-theme-preference-v1", "light"], ["kachat-kas-price-cache-v2", "{}"], ["unrelated", "keep"]]);
  const chat = new MemoryChatStore([["kachat-stale", "old"]]);
  let summarySeen = null;
  const { r, replies, storage, chatStore } = receiver({ storage: leftover, chatStore: chat, confirm: async (s) => { summarySeen = s; return true; } });
  const { snapshot: snap } = snapshot();
  const res = await r.handle(dataEvent());
  assert.equal(res.accepted, true);
  assert.equal(res.stored, true);
  // what the user was asked about
  assert.deepEqual(summarySeen.accounts.map((a) => a.name), ["Main", "Savings"]);
  assert.equal(summarySeen.hasAppPassword, true);
  assert.equal(summarySeen.existingAccounts, 0);
  // stored exactly
  for (const [k, v] of snap.localStorage) assert.equal(storage.getItem(k), v, k);
  for (const [k, v] of snap.chatStore) assert.equal(chatStore.map.get(k), v, k);
  assert.equal(storage.getItem("kachat-kas-price-cache-v2"), null, "this origin's old app keys are replaced");
  assert.equal(storage.getItem("unrelated"), "keep", "non-KaChat keys are never touched");
  assert.equal(chatStore.map.has("kachat-stale"), false);
  assert.ok(storage.getItem(MIGRATED_IN_MARKER_KEY));
  // acknowledged with the hash of what is stored = the hash of what was sent
  assert.equal(replies.length, 1);
  const ack = replies[0];
  assert.deepEqual([ack.type, ack.v, ack.nonce, ack.ok], [MSG_ACK, PROTOCOL_VERSION, NONCE, true]);
  assert.equal(ack.hash, hashSnapshot(snap));
  assert.equal(ack.counts.accounts, 2);
  // one-shot: a replay is ignored
  const again = await r.handle(dataEvent());
  assert.deepEqual([again.accepted, again.reason], [false, "inactive"]);
  assert.equal(replies.length, 1);
});

await test("receiver: declined confirmation stores nothing and says so", async () => {
  const { r, replies, storage } = receiver({ confirm: async () => false });
  const res = await r.handle(dataEvent());
  assert.deepEqual([res.accepted, res.stored, res.reason], [true, false, "declined"]);
  assert.equal(storage.length, 0);
  assert.deepEqual([replies[0].ok, replies[0].reason], [false, "declined"]);
});

await test("receiver: an existing account is reported, and a failed write rolls back", async () => {
  const existing = new MemoryStorage([["kachat-saved-accounts-v1", JSON.stringify([{ address: "kaspa:qqmine", name: "Mine" }])]]);
  const chat = new MemoryChatStore([["kachat-shell-message-history-v1", "mine"]]);
  chat.failPut = true;
  let seen = null;
  const { r, replies, storage, chatStore } = receiver({ storage: existing, chatStore: chat, confirm: async (s) => { seen = s; return true; } });
  const res = await r.handle(dataEvent());
  assert.equal(seen.existingAccounts, 1);
  assert.deepEqual([res.stored, res.reason], [false, "write-failed"]);
  assert.equal(storage.getItem("kachat-saved-accounts-v1"), JSON.stringify([{ address: "kaspa:qqmine", name: "Mine" }]));
  assert.equal(storage.getItem("kachat-app-password-v1"), null);
  assert.equal(chatStore.map.get("kachat-shell-message-history-v1"), "mine");
  assert.deepEqual([replies[0].ok, replies[0].reason], [false, "write-failed"]);
});

await test("old side: ready and ack are taken only from the opened window on the exact new origin", () => {
  const ready = { origin: NEW, source: popup, data: { type: MSG_READY, v: 1, nonce: NONCE } };
  assert.deepEqual(validateReadyMessage(ready, { expectedOrigin: NEW, popup }), { ok: true, nonce: NONCE });
  assert.equal(validateReadyMessage({ ...ready, origin: OLD }, { expectedOrigin: NEW, popup }).reason, "origin");
  assert.equal(validateReadyMessage({ ...ready, source: {} }, { expectedOrigin: NEW, popup }).reason, "source");
  assert.equal(validateReadyMessage({ ...ready, data: { ...ready.data, nonce: "short" } }, { expectedOrigin: NEW, popup }).reason, "nonce");
  const hash = "0f".repeat(32);
  const ack = { origin: NEW, source: popup, data: { type: MSG_ACK, v: 1, nonce: NONCE, ok: true, hash, counts: { accounts: 2 } } };
  const good = validateAckMessage(ack, { expectedOrigin: NEW, popup, nonce: NONCE });
  assert.equal(good.ok, true);
  assert.equal(good.ack.hash, hash);
  assert.equal(validateAckMessage(ack, { expectedOrigin: NEW, popup, nonce: "cd".repeat(32) }).reason, "nonce");
  assert.equal(validateAckMessage({ ...ack, origin: "https://evil.example" }, { expectedOrigin: NEW, popup, nonce: NONCE }).reason, "origin");
  assert.equal(validateAckMessage({ ...ack, data: { ...ack.data, hash: "nope" } }, { expectedOrigin: NEW, popup, nonce: NONCE }).reason, "shape");
});

await test("end to end in memory: sender snapshot -> receiver -> ack hash equals sender hash", async () => {
  const { snapshot: snap } = snapshot();
  const sentHash = hashSnapshot(snap);
  const { r, replies } = receiver();
  // what postMessage delivers is a structured clone
  const res = await r.handle({ origin: OLD, source: opener, data: structuredClone({ type: MSG_DATA, v: 1, nonce: NONCE, snapshot: snap }) });
  assert.equal(res.stored, true);
  const verdict = validateAckMessage({ origin: NEW, source: popup, data: replies[0] }, { expectedOrigin: NEW, popup, nonce: NONCE });
  assert.equal(verdict.ack.hash, sentHash);
  assert.equal(validateDataMessage({ origin: OLD, source: opener, data: { type: MSG_DATA, v: 1, nonce: NONCE, snapshot: snap } }, { expectedOrigin: OLD, source: opener, nonce: NONCE }).ok, true);
});

console.log(`\n${passed} origin-migration tests passed`);
