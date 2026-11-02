// node tools/test-nextcloud-shared-contacts.mjs - the contacts file shared with KaPay (iOS 6c80aea3,
// KaPay 99ab88a, NEXTCLOUD_SYNC.md §9). The first half drives the store's merge directly; the second
// runs the real ui/nextcloud.js (through Vite, for import.meta.env) against an in-memory WebDAV
// server. No real Nextcloud is involved: the fake answers only what these paths need.
import assert from "node:assert/strict";
import { createServer } from "vite";

class MemoryStorage {
  constructor() { this.map = new Map(); }
  getItem(key) { return this.map.has(key) ? this.map.get(key) : null; }
  setItem(key, value) { this.map.set(key, String(value)); }
  removeItem(key) { this.map.delete(key); }
  get length() { return this.map.size; }
  key(index) { return [...this.map.keys()][index] ?? null; }
}

const PREFIX = "kachat-account-data-v1";
const WALLET_A = "kaspa:qzwalletaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const WALLET_B = "kaspa:qzwalletbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const ALICE = "kaspa:qpalice00000000000000000000000000000000000000000000000000";
const BOB = "kaspa:qpbob0000000000000000000000000000000000000000000000000000";
const CAROL = "kaspa:qpcarol000000000000000000000000000000000000000000000000000";
const DAVE = "kaspa:qpdave0000000000000000000000000000000000000000000000000000";
const TESTNET_ERIN = "kaspatest:qperin000000000000000000000000000000000000000000000000";
const UUID_1 = "8F14E45F-CEEA-467F-A9B4-0C1D2E3F4A5B";
const UUID_2 = "0B1C2D3E-4F50-4162-8374-95A6B7C8D9E0";
const FILE_PATH = "KaChat/KaPay Contacts.json";

// Exactly what iOS writes: the output of Swift's JSONEncoder (.iso8601, [.prettyPrinted, .sortedKeys])
// on iOS's own ExportFile struct, with "/" escaped, " : " between key and value, an uppercase UUID
// and whole-second dates (the first entry's updatedAt was 10:00:00.75 before encoding).
const SWIFT_FILE = String.raw`{
  "deleted" : [
    {
      "address" : "${CAROL}",
      "deletedAt" : "2026-10-05T10:00:00Z"
    }
  ],
  "entries" : [
    {
      "address" : "${ALICE}",
      "createdAt" : "2026-10-01T10:00:00Z",
      "id" : "${UUID_1}",
      "name" : "Ünï \/ Alice",
      "note" : "paid \"rent\"",
      "photo" : "\/9j\/4AAQ+SkZJRg==",
      "updatedAt" : "2026-10-02T10:00:00Z"
    },
    {
      "address" : "${BOB}",
      "createdAt" : "2026-10-03T10:00:00Z",
      "id" : "${UUID_2}",
      "name" : "",
      "note" : "nameless",
      "updatedAt" : "2026-10-03T10:00:00Z"
    }
  ],
  "exportedAt" : "2026-11-01T20:00:00Z",
  "type" : "kachat-address-book",
  "version" : 1,
  "walletAddress" : "${WALLET_A}"
}`;

/** A file as KaPay would leave it, for the cases SWIFT_FILE doesn't cover. */
function kapayFile({ wallet = WALLET_A, entries = [], deleted, ...rest } = {}) {
  return JSON.stringify({
    ...(deleted ? { deleted } : {}),
    entries,
    exportedAt: "2026-11-01T20:00:00Z",
    type: "kachat-address-book",
    version: 1,
    ...(wallet ? { walletAddress: wallet } : {}),
    ...rest,
  });
}
function row(address, updatedAt, extra = {}) {
  return { address, createdAt: "2026-10-01T10:00:00Z", id: extra.id || UUID_1, name: extra.name ?? "From KaPay", note: extra.note ?? "", updatedAt, ...extra };
}

// --- The browser, as far as these modules look at it ---------------------------------------------
const local = new MemoryStorage();
const photos = new Map();
let wallet = WALLET_A;
let clock = Date.parse("2026-11-01T12:00:00Z");
let nowOffset = 0;
const realNow = Date.now.bind(Date);
Date.now = () => realNow() + nowOffset;

const documentListeners = new Map();
const settingsListeners = new Map();
function stubElement(extra = {}) {
  return {
    hidden: false, disabled: false, innerHTML: "", textContent: "", value: "", dataset: {}, style: {},
    isConnected: true, childElementCount: 0, classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {}, removeEventListener() {}, setAttribute() {}, removeAttribute() {}, appendChild() {},
    querySelector: () => stubElement(), querySelectorAll: () => [], closest: () => null, focus() {}, ...extra,
  };
}
const settingsEl = stubElement({
  addEventListener: (type, fn) => settingsListeners.set(type, fn),
  querySelector: () => null,
});
globalThis.window = globalThis;
globalThis.addEventListener = () => {};
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
globalThis.localStorage = local;
Object.defineProperty(globalThis, "location", { value: { hostname: "localhost", search: "", hash: "", href: "http://localhost/" }, configurable: true });
globalThis.document = {
  visibilityState: "visible",
  body: stubElement(),
  createElement: () => stubElement(),
  querySelector: (selector) => (selector === "[data-nextcloud-settings]" ? settingsEl : null),
  querySelectorAll: () => [],
  addEventListener: (type, fn) => documentListeners.set(type, fn),
};

// --- The fake WebDAV server ----------------------------------------------------------------------
const dav = {
  files: new Map(),    // "<user>/<path>" -> body
  folders: new Set(),
  log: [],             // { method, user, path, auth }
  hook: null,          // async ({ method, path }) => Response | undefined
  reset() { this.files.clear(); this.folders.clear(); this.log = []; this.hook = null; },
  put(user, path, body) { this.files.set(`${user}/${path}`, body); },
  get(user, path) { return this.files.get(`${user}/${path}`); },
  writes(path) { return this.log.filter((r) => r.method === "PUT" && r.path === path); },
};
const etagOf = (body) => `"etag-${String(body).length}"`;
globalThis.fetch = async (url, init = {}) => {
  const method = String(init.method || "GET").toUpperCase();
  const match = /nc-proxy\/[^/]+\/remote\.php\/dav\/files\/([^/]+)(?:\/(.*))?$/.exec(String(url));
  assert.ok(match, `the fake only speaks WebDAV: ${url}`);
  const user = decodeURIComponent(match[1]);
  const rawPath = match[2] || "";
  const path = rawPath.split("/").filter(Boolean).map(decodeURIComponent).join("/");
  const headers = new Headers(init.headers || {});
  dav.log.push({ method, user, path, rawPath, auth: headers.get("authorization"), origin: headers.get("x-kachat-nextcloud-origin"), contentType: headers.get("content-type") });
  const hooked = await dav.hook?.({ method, user, path });
  if (hooked) return hooked;
  const key = `${user}/${path}`;
  const parent = path.split("/").slice(0, -1).join("/");
  const parentExists = !parent || dav.folders.has(`${user}/${parent}`);
  switch (method) {
    case "GET":
      return dav.files.has(key) ? new Response(dav.files.get(key), { status: 200 }) : new Response("", { status: 404 });
    case "MKCOL":
      if (dav.folders.has(key)) return new Response("", { status: 405 });
      if (!parentExists) return new Response("", { status: 409 });
      dav.folders.add(key);
      return new Response(null, { status: 201 });
    case "PUT":
      if (!parentExists) return new Response("", { status: 409 });
      dav.files.set(key, typeof init.body === "string" ? init.body : await new Response(init.body).text());
      return new Response(null, { status: 201, headers: { "OC-ETag": etagOf(dav.files.get(key)) } });
    case "MOVE": {
      const destination = /\/remote\.php\/dav\/files\/[^/]+\/(.*)$/.exec(headers.get("destination") || "")?.[1] || "";
      const target = `${user}/${destination.split("/").map(decodeURIComponent).join("/")}`;
      dav.files.set(target, dav.files.get(key));
      dav.files.delete(key);
      return new Response(null, { status: 201, headers: { "OC-ETag": etagOf(dav.files.get(target)) } });
    }
    case "DELETE":
      return new Response(null, { status: dav.files.delete(key) ? 204 : 404 });
    case "PROPFIND":
      if (headers.get("depth") !== "0") return new Response(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"></d:multistatus>`, { status: 207 });
      if (!dav.files.has(key)) return new Response("", { status: 404 });
      return new Response(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:getetag>${etagOf(dav.files.get(key))}</d:getetag></d:multistatus>`, { status: 207 });
    default:
      return new Response("", { status: 405 });
  }
};

function storeAccount(address, fields = {}) {
  local.setItem(`${PREFIX}:${address}:kachat-nextcloud-v1`, JSON.stringify({
    server: "https://cloud.example.test", username: "sam", userId: "sam", appPassword: "app-pass",
    startFolder: null, backupFolder: null, autoBackup: true, autoRestoreDone: true,
    lastAutoBackup: Date.now(), backupFolderScanned: 2, ...fields,
  }));
}

// The modules come through Vite so nextcloud.js and the test share one store instance.
const vite = await createServer({
  configFile: false, root: process.cwd(), logLevel: "silent", appType: "custom",
  server: { middlewareMode: true, hmr: false, ws: false, watch: null },
  optimizeDeps: { noDiscovery: true, include: [] },
});
const store = await vite.ssrLoadModule("/ui/address-book-store.js");
const nextcloud = await vite.ssrLoadModule("/ui/nextcloud.js");
const {
  configureAddressBook, addressBookEntries, addressBookEntry, addressBookPhoto, saveAddressBookEntry, removeAddressBookEntry,
  mergeSharedContactsFile, sharedContactsFileJson, addressBookHoldsWallet, addressBookHasBackupData, archiveAddressBook,
  importAddressBookArchive, importAddressBookExport, addressBookExportJson, onAddressBookChange,
} = store;
const { initNextcloud, syncSharedContacts, resetNextcloudForAccount } = nextcloud;

const scopedKey = (base, w = wallet) => (String(w || "").trim() ? `${PREFIX}:${String(w).trim()}:${base}` : base);
function fresh({ activeWallet = WALLET_A } = {}) {
  local.map.clear();
  photos.clear();
  wallet = activeWallet;
  clock = Date.parse("2026-11-01T12:00:00Z");
  configureAddressBook({
    storage: local,
    photoStorage: { get: (k) => photos.get(k) ?? null, set: (k, v) => photos.set(k, v), remove: (k) => photos.delete(k) },
    scopedKey,
    wallet: () => wallet,
    isValidAddress: (a) => /^kaspa:[a-z0-9]{20,}$/.test(a),
    otherNetworkReason: (a) => (a.startsWith("kaspatest:") ? "That's a Testnet address." : null),
    now: () => clock,
  });
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// --- The file's format ---------------------------------------------------------------------------

test("reads what iOS writes, byte for byte: escapes, spacing, uppercase ids, empty names", () => {
  fresh();
  const result = mergeSharedContactsFile(SWIFT_FILE);
  assert.equal(result.changedHere, true);
  assert.equal(result.serverIsBehind, false, "the book now says what the file says");
  const alice = addressBookEntry(ALICE);
  assert.equal(alice.name, "Ünï / Alice");
  assert.equal(alice.note, 'paid "rent"');
  assert.equal(alice.id, UUID_1.toLowerCase());
  assert.equal(alice.updatedAt, Date.parse("2026-10-02T10:00:00Z"));
  assert.equal(addressBookPhoto(ALICE), "data:image/jpeg;base64,/9j/4AAQ+SkZJRg==");
  assert.equal(addressBookEntry(BOB).name, "", "a nameless entry counts like any other");
  assert.equal(addressBookEntry(CAROL), null);
  assert.deepEqual(archiveAddressBook().addressBookDeleted, [{ address: CAROL, deletedAt: "2026-10-05T10:00:00Z" }]);
});

test("writes the format iOS decodes: keys, dates, deleted always there, the owner named", () => {
  fresh();
  saveAddressBookEntry({ address: ALICE, name: "Alice", note: "n", photo: "data:image/jpeg;base64,QUJD" });
  clock += 1234;
  saveAddressBookEntry({ address: BOB, name: "" });
  clock += 1;
  const text = sharedContactsFileJson();
  let file = JSON.parse(text);
  assert.deepEqual(Object.keys(file), ["deleted", "entries", "exportedAt", "type", "version", "walletAddress"]);
  assert.deepEqual(file.deleted, [], "an empty list, as iOS encodes it, not left out");
  assert.equal(file.type, "kachat-address-book");
  assert.equal(file.version, 1);
  assert.equal(file.walletAddress, WALLET_A);
  const whole = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
  assert.match(file.exportedAt, whole, "whole seconds, as iOS writes them");
  const alice = file.entries.find((e) => e.address === ALICE);
  assert.deepEqual(Object.keys(alice), ["address", "createdAt", "id", "name", "note", "photo", "updatedAt"]);
  assert.equal(alice.photo, "QUJD", "raw base64, not a data URL");
  for (const e of file.entries) { assert.match(e.createdAt, whole); assert.match(e.updatedAt, whole); assert.match(e.id, /^[0-9a-f-]{36}$/); }
  assert.equal(file.entries.find((e) => e.address === BOB).photo, undefined, "nil photo is left out");
  removeAddressBookEntry(BOB);
  file = JSON.parse(sharedContactsFileJson());
  assert.deepEqual(Object.keys(file.deleted[0]), ["address", "deletedAt"]);
  assert.equal(file.deleted[0].address, BOB);
  assert.match(file.deleted[0].deletedAt, whole);
});

test("the manual export stays as it was, and importing the shared file by hand ignores deleted", () => {
  fresh();
  saveAddressBookEntry({ address: ALICE, name: "Alice" });
  removeAddressBookEntry(ALICE);
  assert.equal("deleted" in JSON.parse(addressBookExportJson()), false);
  fresh();
  const { added } = importAddressBookExport(SWIFT_FILE);
  assert.equal(added, 2);
  assert.equal(addressBookEntry(CAROL), null);
  assert.deepEqual(archiveAddressBook().addressBookDeleted, []);
});

test("a date as JSONDecoder's bare number is seconds since 2001", () => {
  fresh();
  mergeSharedContactsFile(kapayFile({ exportedAt: 815_000_000, entries: [row(ALICE, 815_000_000, { createdAt: 815_000_000 })] }));
  assert.equal(addressBookEntry(ALICE).updatedAt, (815_000_000 + 978_307_200) * 1000);
});

// --- Refusing a file ------------------------------------------------------------------------------

test("anything iOS's decode refuses throws and changes nothing", () => {
  fresh();
  saveAddressBookEntry({ address: DAVE, name: "Dave" });
  const before = JSON.stringify(addressBookEntries());
  const good = row(ALICE, "2026-10-02T10:00:00Z");
  const bad = [
    "", "<!doctype html><html>Sign in</html>", "{\"entries\":[", "[]", "null",
    SWIFT_FILE.slice(0, SWIFT_FILE.length - 10),
    kapayFile({ type: "something-else" }),
    JSON.stringify({ entries: [], exportedAt: "2026-11-01T20:00:00Z", version: 1 }),
    JSON.stringify({ entries: [], exportedAt: "2026-11-01T20:00:00Z", type: "kachat-address-book" }),
    JSON.stringify({ entries: [], type: "kachat-address-book", version: 1 }),
    JSON.stringify({ exportedAt: "2026-11-01T20:00:00Z", type: "kachat-address-book", version: 1 }),
    kapayFile({ entries: [good, { ...good, id: "not-a-uuid" }] }),
    kapayFile({ entries: [good, { ...good, note: undefined }] }),
    kapayFile({ entries: [good, { ...good, updatedAt: "yesterday" }] }),
    kapayFile({ entries: [good, { ...good, photo: 7 }] }),
    kapayFile({ entries: [good, null] }),
    kapayFile({ entries: [good], deleted: [{ address: BOB }] }),
    kapayFile({ entries: [good], deleted: "none" }),
  ];
  for (const text of bad) {
    assert.throws(() => mergeSharedContactsFile(text), /isn't a KaChat contacts export/, `refused: ${text.slice(0, 60)}`);
    assert.equal(JSON.stringify(addressBookEntries()), before);
  }
});

test("with no wallet there is nothing to merge into or write", () => {
  fresh({ activeWallet: "" });
  assert.throws(() => mergeSharedContactsFile(SWIFT_FILE), /Open a wallet first/);
  assert.throws(() => sharedContactsFileJson(), /Open a wallet first/);
  assert.equal(addressBookHoldsWallet(""), false);
});

// --- Merging --------------------------------------------------------------------------------------

test("per address the newest edit wins, and a tie keeps this device's copy", () => {
  fresh();
  clock = Date.parse("2026-10-10T10:00:00Z");
  saveAddressBookEntry({ address: ALICE, name: "Older here" });
  saveAddressBookEntry({ address: BOB, name: "Newer here" });
  saveAddressBookEntry({ address: DAVE, name: "Tie here" });
  const result = mergeSharedContactsFile(kapayFile({ entries: [
    row(ALICE, "2026-10-11T10:00:00Z", { name: "Newer there" }),
    row(BOB, "2026-10-09T10:00:00Z", { name: "Older there", id: UUID_2 }),
    row(DAVE, "2026-10-10T10:00:00Z", { name: "Tie there" }),
  ] }));
  assert.equal(addressBookEntry(ALICE).name, "Newer there");
  assert.equal(addressBookEntry(BOB).name, "Newer here");
  assert.equal(addressBookEntry(DAVE).name, "Tie here");
  assert.deepEqual(result, { changedHere: true, serverIsBehind: true });
  assert.equal(addressBookEntries().length, 3, "nothing duplicated");
});

test("sub-second local times don't read as the file being behind (the file's dates are whole seconds)", () => {
  fresh();
  clock = Date.parse("2026-10-10T10:00:00.875Z");
  saveAddressBookEntry({ address: ALICE, name: "Alice" });
  const own = sharedContactsFileJson();
  assert.deepEqual(mergeSharedContactsFile(own), { changedHere: false, serverIsBehind: false });
  assert.equal(addressBookEntry(ALICE).updatedAt, Date.parse("2026-10-10T10:00:00.875Z"));
});

test("a deletion stays deleted, either way, and survives the round trip", () => {
  fresh();
  clock = Date.parse("2026-10-10T10:00:00Z");
  saveAddressBookEntry({ address: ALICE, name: "Alice" });
  saveAddressBookEntry({ address: BOB, name: "Bob" });
  clock += 60_000;
  removeAddressBookEntry(ALICE);
  // The file still has Alice from before the deletion: she doesn't come back, and the file is behind.
  let result = mergeSharedContactsFile(kapayFile({ entries: [row(ALICE, "2026-10-10T10:00:00Z"), row(BOB, "2026-10-10T10:00:00Z", { id: UUID_2 })] }));
  assert.equal(addressBookEntry(ALICE), null);
  assert.deepEqual(result, { changedHere: false, serverIsBehind: true });
  // Bob deleted in KaPay: gone here, at KaPay's time.
  result = mergeSharedContactsFile(kapayFile({ deleted: [{ address: BOB, deletedAt: "2026-10-12T10:00:00Z" }] }));
  assert.equal(addressBookEntry(BOB), null);
  assert.equal(result.changedHere, true);
  // Both tombstones go back out, so a third client can't bring either back.
  const file = JSON.parse(sharedContactsFileJson());
  assert.deepEqual(file.entries, []);
  assert.deepEqual(file.deleted.map((t) => t.address).sort(), [ALICE, BOB].sort());
  assert.deepEqual(mergeSharedContactsFile(JSON.stringify(file)), { changedHere: false, serverIsBehind: false });
});

test("an edit after the deletion brings the entry back; a tombstone at the same second deletes it", () => {
  fresh();
  mergeSharedContactsFile(kapayFile({ entries: [row(ALICE, "2026-10-12T10:00:01Z", { name: "Back" })], deleted: [{ address: ALICE, deletedAt: "2026-10-12T10:00:00Z" }] }));
  assert.equal(addressBookEntry(ALICE).name, "Back");
  fresh();
  mergeSharedContactsFile(kapayFile({ entries: [row(ALICE, "2026-10-12T10:00:00Z")], deleted: [{ address: ALICE, deletedAt: "2026-10-12T10:00:00Z" }] }));
  assert.equal(addressBookEntry(ALICE), null);
  assert.deepEqual(archiveAddressBook().addressBook, []);
});

test("photos: the winning edit decides, as in a restore", () => {
  fresh();
  clock = Date.parse("2026-10-10T10:00:00Z");
  saveAddressBookEntry({ address: ALICE, name: "Alice", photo: "data:image/jpeg;base64,TE9DQUw=" });
  saveAddressBookEntry({ address: BOB, name: "Bob", photo: "data:image/jpeg;base64,TE9DQUw=" });
  // A newer edit with no photo removes ours; an older one leaves it.
  mergeSharedContactsFile(kapayFile({ entries: [row(ALICE, "2026-10-11T10:00:00Z"), row(BOB, "2026-10-09T10:00:00Z", { id: UUID_2 })] }));
  assert.equal(addressBookPhoto(ALICE), null);
  assert.equal(addressBookPhoto(BOB), "data:image/jpeg;base64,TE9DQUw=");
  // A deletion takes the photo with it.
  mergeSharedContactsFile(kapayFile({ deleted: [{ address: BOB, deletedAt: "2026-10-12T10:00:00Z" }] }));
  assert.equal(addressBookPhoto(BOB), null);
});

test("another account's file is left out, whatever it holds", () => {
  fresh();
  saveAddressBookEntry({ address: DAVE, name: "Mine" });
  let changes = 0;
  const off = onAddressBookChange(() => { changes += 1; });
  const result = mergeSharedContactsFile(kapayFile({ wallet: WALLET_B, entries: [row(ALICE, "2030-01-01T00:00:00Z")], deleted: [{ address: DAVE, deletedAt: "2030-01-01T00:00:00Z" }] }));
  off();
  assert.deepEqual(result, { changedHere: false, serverIsBehind: true }, "worth replacing: this account has contacts");
  assert.equal(changes, 0);
  assert.equal(addressBookEntry(ALICE), null);
  assert.equal(addressBookEntry(DAVE).name, "Mine");
  assert.deepEqual(JSON.parse(sharedContactsFileJson()).entries.map((e) => e.address), [DAVE]);
  assert.equal(JSON.parse(sharedContactsFileJson()).walletAddress, WALLET_A);

  fresh({ activeWallet: WALLET_B });
  assert.deepEqual(mergeSharedContactsFile(SWIFT_FILE), { changedHere: false, serverIsBehind: false }, "nothing here: left alone");
  assert.equal(addressBookHasBackupData(), false);
  assert.equal(addressBookEntry(ALICE), null);
});

test("a file naming no account merges, as on iOS; the owner compares normalized", () => {
  fresh();
  mergeSharedContactsFile(kapayFile({ wallet: null, entries: [row(ALICE, "2026-10-12T10:00:00Z")] }));
  assert.ok(addressBookEntry(ALICE));
  fresh();
  mergeSharedContactsFile(kapayFile({ wallet: `  ${WALLET_A.toUpperCase()} `, entries: [row(ALICE, "2026-10-12T10:00:00Z")] }));
  assert.ok(addressBookEntry(ALICE));
});

test("the other network's rows are skipped without refusing the file", () => {
  fresh();
  const result = mergeSharedContactsFile(kapayFile({ entries: [row(TESTNET_ERIN, "2026-10-12T10:00:00Z", { id: UUID_2 }), row(ALICE, "2026-10-12T10:00:00Z")] }));
  assert.equal(addressBookEntry(TESTNET_ERIN), null);
  assert.ok(addressBookEntry(ALICE));
  assert.equal(result.serverIsBehind, false);
});

test("repaints only on a real change, and never owes the backup through the edit path", () => {
  fresh();
  const kinds = [];
  const off = onAddressBookChange((kind) => kinds.push(kind));
  mergeSharedContactsFile(SWIFT_FILE);
  mergeSharedContactsFile(SWIFT_FILE);
  off();
  assert.deepEqual(kinds, ["restore"]);
});

test("a contact another tab just saved isn't overwritten by this tab's older copy", () => {
  fresh();
  clock = Date.parse("2026-10-10T10:00:00Z");
  saveAddressBookEntry({ address: DAVE, name: "Dave" });
  const key = scopedKey("kachat-address-book-v1");
  const stored = JSON.parse(local.getItem(key));
  stored.push({ ...stored[0], id: UUID_1.toLowerCase(), address: BOB, name: "Saved in the other tab" });
  local.setItem(key, JSON.stringify(stored));
  mergeSharedContactsFile(kapayFile({ entries: [row(ALICE, "2026-10-12T10:00:00Z", { id: UUID_2 })] }));
  assert.equal(addressBookEntry(BOB).name, "Saved in the other tab");
  assert.equal(JSON.parse(local.getItem(key)).length, 3);
});

test("the encrypted backup's contacts keep working: same book, no duplicates, tombstones respected", () => {
  fresh();
  importAddressBookArchive(
    [{ id: UUID_1, address: ALICE, name: "From the backup", note: "", createdAt: "2026-10-01T10:00:00Z", updatedAt: "2026-10-01T10:00:00Z" }],
    [{ address: CAROL, deletedAt: "2026-10-06T10:00:00Z" }],
  );
  const result = mergeSharedContactsFile(SWIFT_FILE);
  assert.equal(result.changedHere, true);
  assert.equal(addressBookEntries().filter((e) => e.address === ALICE).length, 1);
  assert.equal(addressBookEntry(ALICE).name, "Ünï / Alice", "KaPay's edit is newer");
  // What KaPay brought now rides in the chat backup, tombstones and all.
  const archive = archiveAddressBook();
  assert.deepEqual(archive.addressBook.map((e) => e.address).sort(), [ALICE, BOB].sort());
  assert.equal(archive.addressBook.find((e) => e.address === ALICE).photo, "/9j/4AAQ+SkZJRg==");
  assert.deepEqual(archive.addressBookDeleted, [{ address: CAROL, deletedAt: "2026-10-06T10:00:00Z" }], "the later of the two");
  // An older copy of the backup restored afterwards brings nothing back.
  importAddressBookArchive(
    [{ id: UUID_1, address: ALICE, name: "From the backup", note: "", createdAt: "2026-10-01T10:00:00Z", updatedAt: "2026-10-01T10:00:00Z" },
      { id: UUID_2, address: CAROL, name: "Carol", note: "", createdAt: "2026-10-01T10:00:00Z", updatedAt: "2026-10-01T10:00:00Z" }],
    [],
  );
  assert.equal(addressBookEntry(ALICE).name, "Ünï / Alice");
  assert.equal(addressBookEntry(CAROL), null);
});

// --- ui/nextcloud.js against the fake server ------------------------------------------------------

const logs = [];
let backupsSealed = 0;
let activeConversation = null;
const toFake = (activeWallet, fields) => {
  fresh({ activeWallet });
  dav.reset();
  logs.length = 0;
  storeAccount(activeWallet, fields);
};
let started = false;
function startModule() {
  if (started) { resetNextcloudForAccount(); return; }
  started = true;
  initNextcloud({
    accountScopedKey: (base, address = wallet) => scopedKey(base, address),
    escapeHtml: (s) => String(s), appendEngineLog: (line) => logs.push(line), showToast() {},
    getActiveConversationId: () => activeConversation,
    hasMessageActivitySignal: true,
    exportBackupPayload: async () => { backupsSealed += 1; return "{\"sealed\":true}"; },
    openBackupPayload: async (raw) => raw,
    importPhoneArchive: () => ({ messages: 0, conversations: 0 }),
  });
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function backUpNow() {
  const button = stubElement();
  await settingsListeners.get("click")({ target: { closest: (selector) => (selector === "[data-nc-backup-now]" ? button : null) } });
}

test("a first sync creates KaChat/KaPay Contacts.json and PUTs the file there", async () => {
  toFake(WALLET_A, { autoBackup: false });
  saveAddressBookEntry({ address: ALICE, name: "Alice" });
  startModule();
  assert.equal(await syncSharedContacts(), false);
  const reads = dav.log.filter((r) => r.method === "GET").map((r) => r.path);
  assert.deepEqual(reads, [FILE_PATH, "KaChat/KaPay Address Book.json", "KaChat/KaChat Wallet Address Book.json"]);
  const put = dav.writes(FILE_PATH)[0];
  assert.equal(put.rawPath, "KaChat/KaPay%20Contacts.json");
  assert.equal(put.contentType, "application/json");
  assert.equal(put.auth, `Basic ${btoa("sam:app-pass")}`);
  assert.equal(put.origin, "https://cloud.example.test");
  assert.equal(JSON.parse(dav.get("sam", FILE_PATH)).entries[0].address, ALICE);
  assert.ok(dav.folders.has("sam/KaChat"));
});

test("Build 259: a custom backup folder doesn't move the file; it stays where KaPay looks", async () => {
  for (const backupFolder of ["Apps/KaChat", "kachat"]) {
    toFake(WALLET_A, { autoBackup: false, backupFolder });
    saveAddressBookEntry({ address: ALICE, name: "Alice" });
    startModule();
    await syncSharedContacts();
    assert.deepEqual(dav.writes(FILE_PATH).length, 1, backupFolder);
    assert.equal([...dav.files.keys()].some((k) => k.includes("/kachat/") || k.includes("Apps/")), false);
    // The chat backup still goes where the setting says.
    dav.folders.add("sam/Apps");
    await backUpNow();
    const key = [...dav.files.keys()].find((k) => k.endsWith("/kachat-backup.json"));
    assert.equal(key, `sam/${backupFolder}/kachat-backup.json`);
  }
});

test("no file is created for an account with nothing to share", async () => {
  toFake(WALLET_A, { autoBackup: false });
  startModule();
  await syncSharedContacts();
  assert.equal(dav.log.some((r) => r.method === "PUT" || r.method === "MKCOL"), false);
});

test("nothing is written when the file already says what this book says", async () => {
  toFake(WALLET_A, { autoBackup: false });
  dav.put("sam", FILE_PATH, SWIFT_FILE);
  startModule();
  assert.equal(await syncSharedContacts(), true, "KaPay's contacts came in");
  assert.equal(dav.log.some((r) => r.method === "PUT"), false);
  assert.equal(addressBookEntry(ALICE).name, "Ünï / Alice");
  assert.equal(await syncSharedContacts(), false);
  assert.equal(dav.log.some((r) => r.method === "PUT"), false);
});

test("KaPay's earlier names are read; a write uses the current one", async () => {
  toFake(WALLET_A, { autoBackup: false });
  dav.put("sam", "KaChat/KaChat Wallet Address Book.json", kapayFile({ entries: [row(ALICE, "2026-10-12T10:00:00Z")] }));
  saveAddressBookEntry({ address: BOB, name: "Bob" });
  startModule();
  assert.equal(await syncSharedContacts(), true);
  assert.ok(addressBookEntry(ALICE));
  const file = JSON.parse(dav.get("sam", FILE_PATH));
  assert.deepEqual(file.entries.map((e) => e.address).sort(), [ALICE, BOB].sort());
  assert.ok(dav.get("sam", "KaChat/KaChat Wallet Address Book.json"), "the old file is left alone");
  assert.equal(dav.writes("KaChat/KaChat Wallet Address Book.json").length, 0);
});

test("two devices converge: an edit and a deletion on each side, through the file", async () => {
  toFake(WALLET_A, { autoBackup: false });
  dav.put("sam", FILE_PATH, SWIFT_FILE);
  startModule();
  await syncSharedContacts();
  // Desktop deletes Alice and adds Dave.
  clock = Date.parse("2026-11-01T12:00:00Z");
  removeAddressBookEntry(ALICE);
  saveAddressBookEntry({ address: DAVE, name: "Dave" });
  await syncSharedContacts();
  let file = JSON.parse(dav.get("sam", FILE_PATH));
  assert.deepEqual(file.entries.map((e) => e.address).sort(), [BOB, DAVE].sort());
  assert.deepEqual(file.deleted.map((t) => t.address).sort(), [ALICE, CAROL].sort());
  // KaPay, having merged that, deletes Dave and renames Bob.
  file.entries = file.entries.filter((e) => e.address !== DAVE).map((e) => ({ ...e, name: "Robert", updatedAt: "2026-11-01T13:00:00Z" }));
  file.deleted.push({ address: DAVE, deletedAt: "2026-11-01T13:00:00Z" });
  dav.put("sam", FILE_PATH, JSON.stringify(file));
  const writesBefore = dav.writes(FILE_PATH).length;
  assert.equal(await syncSharedContacts(), true);
  assert.equal(addressBookEntry(BOB).name, "Robert");
  assert.equal(addressBookEntry(DAVE), null);
  assert.equal(addressBookEntry(ALICE), null);
  assert.equal(dav.writes(FILE_PATH).length, writesBefore, "nothing new to tell the server");
});

test("two accounts on one login: each replaces the file, neither gets the other's contacts", async () => {
  toFake(WALLET_A, { autoBackup: false });
  saveAddressBookEntry({ address: ALICE, name: "A's Alice" });
  startModule();
  await syncSharedContacts();
  assert.equal(JSON.parse(dav.get("sam", FILE_PATH)).walletAddress, WALLET_A);

  wallet = WALLET_B;
  storeAccount(WALLET_B, { autoBackup: false });
  configureAddressBook({ wallet: () => wallet });
  resetNextcloudForAccount();
  // B has nothing: A's file is neither merged nor replaced.
  await syncSharedContacts();
  assert.equal(addressBookEntry(ALICE), null);
  assert.equal(JSON.parse(dav.get("sam", FILE_PATH)).walletAddress, WALLET_A);
  // B saves a contact: the file becomes B's, holding only B's.
  saveAddressBookEntry({ address: BOB, name: "B's Bob" });
  await syncSharedContacts();
  let file = JSON.parse(dav.get("sam", FILE_PATH));
  assert.equal(file.walletAddress, WALLET_B);
  assert.deepEqual(file.entries.map((e) => e.address), [BOB]);

  wallet = WALLET_A;
  configureAddressBook({ wallet: () => wallet });
  resetNextcloudForAccount();
  await syncSharedContacts();
  assert.equal(addressBookEntry(BOB), null, "A never gets B's");
  assert.equal(addressBookEntry(ALICE).name, "A's Alice");
  file = JSON.parse(dav.get("sam", FILE_PATH));
  assert.equal(file.walletAddress, WALLET_A);
  assert.deepEqual(file.entries.map((e) => e.address), [ALICE]);
});

test("a file that can't be read, or a failed read, is never overwritten", async () => {
  for (const body of ["<!doctype html><html>Maintenance</html>", "", "{\"type\":\"kachat-address-book\",\"entries\":["]) {
    toFake(WALLET_A, { autoBackup: false });
    dav.put("sam", FILE_PATH, body);
    saveAddressBookEntry({ address: ALICE, name: "Alice" });
    startModule();
    await assert.rejects(syncSharedContacts(), /isn't a KaChat contacts export/);
    assert.equal(dav.writes(FILE_PATH).length, 0);
    assert.equal(dav.get("sam", FILE_PATH), body);
  }
  for (const status of [401, 423, 500, 502]) {
    toFake(WALLET_A, { autoBackup: false });
    saveAddressBookEntry({ address: ALICE, name: "Alice" });
    startModule();
    dav.hook = ({ method }) => (method === "GET" ? new Response("", { status }) : undefined);
    await assert.rejects(syncSharedContacts());
    assert.equal(dav.log.some((r) => r.method === "PUT"), false, `HTTP ${status}`);
  }
  // A legacy name failing stops the search too: a 500 is not "there's no file".
  toFake(WALLET_A, { autoBackup: false });
  saveAddressBookEntry({ address: ALICE, name: "Alice" });
  startModule();
  dav.hook = ({ method, path }) => (method === "GET" && path !== FILE_PATH ? new Response("", { status: 500 }) : undefined);
  await assert.rejects(syncSharedContacts());
  assert.equal(dav.log.some((r) => r.method === "PUT"), false);
});

test("an account switch mid-read merges and writes nothing; mid-write never PUTs the old account's book", async () => {
  // During the GET.
  toFake(WALLET_A, { autoBackup: false });
  dav.put("sam", FILE_PATH, SWIFT_FILE);
  saveAddressBookEntry({ address: DAVE, name: "A's Dave" });
  startModule();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  dav.hook = async ({ method }) => { if (method === "GET") await gate; };
  let running = syncSharedContacts();
  await sleep(0);
  wallet = WALLET_B;
  storeAccount(WALLET_B, { autoBackup: false, username: "other", userId: "other" });
  resetNextcloudForAccount();
  release();
  assert.equal(await running, false);
  dav.hook = null;
  assert.equal(addressBookEntry(ALICE), null, "A's file didn't land in B's book");
  assert.equal(dav.log.some((r) => r.method === "PUT"), false);

  // During the folder creation, with the body already built.
  toFake(WALLET_A, { autoBackup: false });
  saveAddressBookEntry({ address: DAVE, name: "A's Dave" });
  startModule();
  let releaseFolder;
  const folderGate = new Promise((resolve) => { releaseFolder = resolve; });
  dav.hook = async ({ method }) => { if (method === "MKCOL") await folderGate; };
  running = syncSharedContacts();
  await sleep(0);
  await sleep(0);
  wallet = WALLET_B;
  storeAccount(WALLET_B, { autoBackup: false, username: "other", userId: "other" });
  resetNextcloudForAccount();
  releaseFolder();
  await assert.rejects(running, /account changed/);
  dav.hook = null;
  assert.equal(dav.log.some((r) => r.method === "PUT"), false, "A's contacts never reach B's login");
});

test("one at a time: a second sync during the first does nothing", async () => {
  toFake(WALLET_A, { autoBackup: false });
  saveAddressBookEntry({ address: ALICE, name: "Alice" });
  startModule();
  const first = syncSharedContacts();
  assert.equal(await syncSharedContacts(), false);
  await first;
  assert.equal(dav.writes(FILE_PATH).length, 1);
});

test("Back Up Now merges first, so the chat backup carries KaPay's contacts", async () => {
  toFake(WALLET_A, { autoBackup: false });
  dav.put("sam", FILE_PATH, SWIFT_FILE);
  startModule();
  let bookAtSeal = null;
  const sealsBefore = backupsSealed;
  const realHook = async ({ method, path }) => {
    if (method === "GET" && path === "KaChat/kachat-backup.json") bookAtSeal = addressBookEntries().map((e) => e.address).sort();
  };
  dav.hook = realHook;
  await backUpNow();
  assert.deepEqual(bookAtSeal, [ALICE, BOB].sort());
  assert.equal(backupsSealed, sealsBefore + 1);
  assert.ok(dav.get("sam", "KaChat/kachat-backup.json"));
  const order = dav.log.map((r) => `${r.method} ${r.path}`);
  assert.ok(order.indexOf(`GET ${FILE_PATH}`) < order.indexOf("GET KaChat/kachat-backup.json"));
});

test("a problem with the contacts file never stops the chat backup", async () => {
  toFake(WALLET_A, { autoBackup: false });
  dav.put("sam", FILE_PATH, "<html>not contacts</html>");
  saveAddressBookEntry({ address: ALICE, name: "Alice" });
  startModule();
  await backUpNow();
  assert.ok(dav.get("sam", "KaChat/kachat-backup.json"), "the chat backup went up");
  assert.equal(dav.get("sam", FILE_PATH), "<html>not contacts</html>", "the unreadable file is untouched");
  assert.ok(logs.some((line) => line.includes("Syncing contacts with KaPay failed")));
});

test("the app pulls changes on open, at most once a minute, only with Automatic Sync on", async () => {
  // Off: nothing runs by itself.
  toFake(WALLET_A, { autoBackup: false });
  dav.put("sam", FILE_PATH, SWIFT_FILE);
  startModule();
  await sleep(1150);
  assert.equal(dav.log.length, 0);

  // On: account activation.
  toFake(WALLET_A);
  dav.put("sam", FILE_PATH, SWIFT_FILE);
  startModule();
  assert.equal(addressBookEntry(ALICE), null);
  await sleep(1150);
  assert.equal(addressBookEntry(ALICE).name, "Ünï / Alice");
  const reads = () => dav.log.filter((r) => r.method === "GET" && r.path === FILE_PATH).length;
  assert.equal(reads(), 1);

  // What it brought is owed to the chat backup: leaving the app flushes it, which merges first.
  const sealsBefore = backupsSealed;
  document.visibilityState = "hidden";
  documentListeners.get("visibilitychange")();
  await sleep(50);
  assert.equal(backupsSealed, sealsBefore + 1);
  assert.equal(reads(), 2);
  assert.equal(dav.writes(FILE_PATH).length, 0, "and the merge alone never writes the file back");

  // Coming back within the minute doesn't look again.
  document.visibilityState = "visible";
  documentListeners.get("visibilitychange")();
  await sleep(1150);
  assert.equal(reads(), 2);

  // A minute on it does: KaPay's new contact comes in.
  const file = JSON.parse(SWIFT_FILE);
  file.entries.push({ ...row(DAVE, "2026-11-01T11:00:00Z"), id: "11111111-2222-4333-8444-555555555555" });
  dav.put("sam", FILE_PATH, JSON.stringify(file));
  nowOffset += 61_000;
  document.visibilityState = "hidden";
  documentListeners.get("visibilitychange")();
  document.visibilityState = "visible";
  documentListeners.get("visibilitychange")();
  await sleep(1150);
  assert.equal(reads(), 3);
  assert.ok(addressBookEntry(DAVE));

  // So does a change-watcher tick (opening a chat wakes the watcher), a minute on.
  nowOffset += 61_000;
  activeConversation = "chat";
  await sleep(1500);
  activeConversation = null;
  assert.equal(reads(), 4);

  // An account switch looks straight away, for the new account.
  fresh({ activeWallet: WALLET_B });
  storeAccount(WALLET_B);
  dav.log = [];
  resetNextcloudForAccount();
  await sleep(1150);
  assert.equal(reads(), 1);
  assert.equal(addressBookEntry(ALICE), null);
  // Quiet again before the next test: nothing automatic outlives it.
  storeAccount(WALLET_B, { autoBackup: false });
  resetNextcloudForAccount();
});

// --- Run ------------------------------------------------------------------------------------------

let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL - ${name}\n`, error);
  }
}
await vite.close();
if (failed) { console.error(`${failed} of ${tests.length} failed`); process.exit(1); }
console.log(`all ${tests.length} passed`);
process.exit(0);
