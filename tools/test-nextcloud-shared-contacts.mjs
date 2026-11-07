// node tools/test-nextcloud-shared-contacts.mjs - the contacts file shared with KaPay (iOS 6c80aea3,
// KaPay 99ab88a, NEXTCLOUD_SYNC.md §9) and the encrypted contacts backup (iOS 4314e17e,
// NEXTCLOUD_SYNC.md "Contacts only"). The first half drives the store's merge directly; the second
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
  revokes: [],
  hook: null,          // async ({ method, path }) => Response | undefined
  listings: false,
  modified: new Map(),
  reset() { this.files.clear(); this.folders.clear(); this.log = []; this.revokes = []; this.hook = null; this.listings = false; this.modified.clear(); },
  put(user, path, body) { this.files.set(`${user}/${path}`, body); },
  get(user, path) { return this.files.get(`${user}/${path}`); },
  writes(path) { return this.log.filter((r) => r.method === "PUT" && r.path === path); },
};
// Depth-1 listings for the tests that read a folder, and just enough of DOMParser to read them.
const listingOf = (user, folder) => [...dav.files.keys()]
  .filter((key) => key.startsWith(`${user}/${folder}/`) && !key.slice(`${user}/${folder}/`.length).includes("/"))
  .map((key) => `<response|${encodeURIComponent(key.slice(user.length + 1))}|${String(dav.files.get(key)).length}|${dav.modified.get(key) || "Thu, 05 Nov 2026 10:00:00 GMT"}>`)
  .join("\n");
globalThis.DOMParser = class {
  parseFromString(text) {
    const rows = String(text).split("\n").filter((line) => line.startsWith("<response|")).map((line) => line.slice(10, -1).split("|"));
    const element = (row) => ({
      getElementsByTagNameNS: (_ns, tag) => ({
        href: [{ textContent: `/remote.php/dav/files/sam/${row[0]}` }],
        collection: [],
        getcontenttype: [{ textContent: "application/json" }],
        getcontentlength: [{ textContent: row[1] }],
        getlastmodified: [{ textContent: row[2] }],
        displayname: [],
      }[tag] || []),
    });
    return { getElementsByTagNameNS: (_ns, tag) => (tag === "response" ? rows.map(element) : []) };
  }
};
const etagOf = (body) => `"etag-${String(body).length}"`;
globalThis.fetch = async (url, init = {}) => {
  const method = String(init.method || "GET").toUpperCase();
  if (String(url).includes("/ocs/v2.php/core/apppassword")) {
    dav.revokes.push({ method, ocs: new Headers(init.headers).get("OCS-APIRequest"), auth: new Headers(init.headers).get("Authorization") });
    return new Response(null, { status: 200 });
  }
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
      if (headers.get("depth") === "1" && dav.listings) return new Response(listingOf(user, path), { status: 207 });
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
    startFolder: null, backupFolder: null, autoBackup: true,
    lastAutoBackup: Date.now(), backupFolderScanned: 3, ...fields,
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
const { sealBackupEnvelope, openBackupEnvelope } = await vite.ssrLoadModule("/ui/backup-crypto.js");
const portfolioSync = await vite.ssrLoadModule("/ui/portfolio-sync.js");
const portfolios = { local: { portfolios: [], transactions: [], fees: [], tombstones: [] } };
const {
  configureAddressBook, addressBookEntries, addressBookEntry, addressBookPhoto, saveAddressBookEntry, removeAddressBookEntry,
  mergeSharedContactsFile, sharedContactsFileJson, addressBookHoldsWallet, addressBookHasBackupData, archiveAddressBook,
  importAddressBookArchive, importAddressBookExport, addressBookExportJson, onAddressBookChange,
} = store;
const { initNextcloud, resetNextcloudForAccount, runBackup, checkForRemoteChangeAndImport, deleteRemoteNextcloudBackup, runPortfolioBackup, notePortfolioChanged, revokeAppPassword, noteContactActivity } = nextcloud;

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
let backupKeyAvailable = true;
const BACKUP_KEY_HEX = "11".repeat(32);
const BACKUP_PATH = "KaChat/kachat-contacts.json";
const sealFor = (address, json) => sealBackupEnvelope(json, BACKUP_KEY_HEX, address);
const openFor = (address, raw) => openBackupEnvelope(raw, BACKUP_KEY_HEX, address);
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
    sealBackupPayload: async (json) => { backupsSealed += 1; return sealFor(wallet, json); },
    openBackupPayload: async (raw) => openFor(wallet, raw),
    backupKeyAvailable: () => backupKeyAvailable,
    portfolioBackupSync: () => portfolioSync.mergePortfolioSync([portfolios.local]),
    importPortfolioSync: (incoming) => {
      const before = JSON.stringify(portfolioSync.mergePortfolioSync([portfolios.local]));
      portfolios.local = portfolioSync.mergePortfolioSync([portfolios.local, incoming]);
      return JSON.stringify(portfolios.local) !== before;
    },
  });
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function backUpNow() {
  const button = stubElement();
  await settingsListeners.get("click")({ target: { closest: (selector) => (selector === "[data-nc-backup-now]" ? button : null) } });
}

// --- The contacts backup (iOS 4314e17e) -----------------------------------------------------------

const contactsFile = (entries, { deleted = [], walletAddress = WALLET_A } = {}) => JSON.stringify({
  type: "kachat-address-book", version: 1, exportedAt: "2026-11-05T10:00:00Z", walletAddress, entries, deleted,
});
const contactRow = (address, name, updatedAt = "2026-11-01T10:00:00Z") => ({
  id: UUID_1, address, name, note: "", createdAt: "2026-10-01T10:00:00Z", updatedAt,
});
const writesTo = (path) => dav.log.filter((r) => (r.method === "PUT" && r.path === path)
  || (r.method === "MOVE" && r.path.startsWith(`KaChat/.${path.split("/").pop()}.upload-`)));


test("a backup is one encrypted kachat-contacts.json holding the Address Book, and never the chat backup", async () => {
  toFake(WALLET_A, { autoBackup: false });
  saveAddressBookEntry({ address: ALICE, name: "Alice" });
  dav.put("sam", "KaChat/kachat-backup.json", "{\"old\":true}");
  startModule();
  await runBackup();
  const raw = dav.get("sam", BACKUP_PATH);
  assert.ok(raw, "the file is there");
  assert.equal(JSON.parse(raw).kachatEncryptedBackup, 1);
  assert.ok(!raw.includes("Alice") && !raw.includes(ALICE), "nothing readable on the server");
  const inside = JSON.parse(await openFor(WALLET_A, raw));
  assert.equal(inside.type, "kachat-address-book");
  assert.equal(inside.walletAddress, WALLET_A);
  assert.deepEqual(inside.entries.map((e) => e.address), [ALICE]);
  assert.ok(Array.isArray(inside.deleted));
  assert.equal(dav.get("sam", "KaChat/kachat-backup.json"), "{\"old\":true}");
  assert.ok(!dav.log.some((r) => r.path === "KaChat/kachat-backup.json"), "the old file is never even read");
});

test("an account with no contacts writes no file", async () => {
  toFake(WALLET_A, { autoBackup: false });
  startModule();
  await runBackup();
  assert.equal(dav.get("sam", BACKUP_PATH), undefined);
  assert.equal(writesTo(BACKUP_PATH).length, 0);
});

test("a backup merges the file first and writes only what the file is missing", async () => {
  toFake(WALLET_A, { autoBackup: false });
  saveAddressBookEntry({ address: BOB, name: "Bob" });
  dav.put("sam", BACKUP_PATH, await sealFor(WALLET_A, contactsFile([contactRow(ALICE, "Alice")])));
  startModule();
  await runBackup();
  assert.equal(addressBookEntry(ALICE).name, "Alice", "the other device's contact came in");
  const inside = JSON.parse(await openFor(WALLET_A, dav.get("sam", BACKUP_PATH)));
  assert.deepEqual(inside.entries.map((e) => e.address).sort(), [ALICE, BOB].sort());
  // Nothing new: read and left alone.
  const before = writesTo(BACKUP_PATH).length;
  await runBackup();
  assert.equal(writesTo(BACKUP_PATH).length, before);
});

test("a deletion on another device stays deleted here", async () => {
  toFake(WALLET_A, { autoBackup: false });
  saveAddressBookEntry({ address: ALICE, name: "Alice" });
  dav.put("sam", BACKUP_PATH, await sealFor(WALLET_A, contactsFile([], { deleted: [{ address: ALICE, deletedAt: "2099-01-01T00:00:00Z" }] })));
  startModule();
  await runBackup();
  assert.equal(addressBookEntry(ALICE), null);
});

test("a file that can't be read as this account's contacts is never overwritten", async () => {
  const cases = [
    ["a plain file", contactsFile([contactRow(ALICE, "Alice")]), /isn't encrypted by KaChat/],
    ["another wallet's file", await sealFor(WALLET_B, contactsFile([contactRow(ALICE, "Alice")], { walletAddress: WALLET_B })), /./],
    ["a chat archive in the envelope", await sealFor(WALLET_A, JSON.stringify({ schemaVersion: 1, conversations: [] })), /./],
    ["a file cut off on the way", `{"kachatEncryptedBackup":1,"cipher":"aes-256-gcm","nonce":"AAAA`, /arrived incomplete/],
    ["a sign-in page", "<!doctype html><html></html>", /web page/],
  ];
  for (const [name, body, message] of cases) {
    toFake(WALLET_A, { autoBackup: false });
    saveAddressBookEntry({ address: BOB, name: "Bob" });
    dav.put("sam", BACKUP_PATH, body);
    startModule();
    await assert.rejects(runBackup(), message, name);
    assert.equal(dav.get("sam", BACKUP_PATH), body, name);
    assert.equal(writesTo(BACKUP_PATH).length, 0, name);
  }
});

test("this account's own file that won't decrypt is replaced in place", async () => {
  toFake(WALLET_A, { autoBackup: false });
  saveAddressBookEntry({ address: BOB, name: "Bob" });
  const sealed = JSON.parse(await sealFor(WALLET_A, contactsFile([])));
  sealed.ciphertext = Buffer.from("damaged").toString("base64");
  dav.put("sam", BACKUP_PATH, JSON.stringify(sealed));
  startModule();
  await runBackup();
  const inside = JSON.parse(await openFor(WALLET_A, dav.get("sam", BACKUP_PATH)));
  assert.deepEqual(inside.entries.map((e) => e.address), [BOB]);
  assert.ok(logs.some((line) => line.includes("replacing it in place")));
});

test("the watcher's poll brings a new device its contacts, once, and owes back what the file lacks", async () => {
  toFake(WALLET_A, { autoBackup: false });
  dav.put("sam", BACKUP_PATH, await sealFor(WALLET_A, contactsFile([contactRow(ALICE, "Alice")])));
  startModule();
  await checkForRemoteChangeAndImport();
  assert.equal(addressBookEntry(ALICE).name, "Alice");
  const reads = () => dav.log.filter((r) => r.method === "GET" && r.path === BACKUP_PATH).length;
  assert.equal(reads(), 1);
  await checkForRemoteChangeAndImport();
  assert.equal(reads(), 1, "the same ETag isn't downloaded again");
  // Our own upload isn't read back either.
  saveAddressBookEntry({ address: BOB, name: "Bob" });
  await runBackup();
  const afterBackup = reads();
  await checkForRemoteChangeAndImport();
  assert.equal(reads(), afterBackup);
  // No file yet: nothing happens, and it isn't an error.
  toFake(WALLET_A, { autoBackup: false });
  startModule();
  await checkForRemoteChangeAndImport();
  assert.equal(addressBookEntries().length, 0);
});

test("a file the watcher can't read is skipped, changes nothing, and isn't downloaded every poll", async () => {
  toFake(WALLET_A, { autoBackup: false });
  saveAddressBookEntry({ address: BOB, name: "Bob" });
  const body = contactsFile([contactRow(ALICE, "Alice")]);
  dav.put("sam", BACKUP_PATH, body);
  startModule();
  await checkForRemoteChangeAndImport();
  await checkForRemoteChangeAndImport();
  assert.equal(addressBookEntry(ALICE), null);
  assert.equal(dav.get("sam", BACKUP_PATH), body);
  assert.equal(dav.log.filter((r) => r.method === "GET" && r.path === BACKUP_PATH).length, 1);
  assert.ok(logs.some((line) => line.includes("skipped an unreadable contacts file")));
});

test("switching account mid-backup writes nothing", async () => {
  toFake(WALLET_A, { autoBackup: false });
  saveAddressBookEntry({ address: ALICE, name: "Alice" });
  startModule();
  dav.hook = async ({ method, path }) => {
    if (method === "GET" && path === BACKUP_PATH) {
      fresh({ activeWallet: WALLET_B });
      storeAccount(WALLET_B, { autoBackup: false });
      resetNextcloudForAccount();
    }
  };
  await assert.rejects(runBackup(), /account changed/);
  assert.equal(writesTo(BACKUP_PATH).length, 0);
  dav.hook = null;
});

// --- Portfolio files (KaPay 953b255) --------------------------------------------------------------

const PF_LONG = "AAAAAAAA-0000-4000-8000-000000000001";
const PF_SHORT = "AAAAAAAA-0000-4000-8000-000000000002";
const pfRow = (id, name, createdAt = 1_780_000_000_000, updatedAt = 1_780_000_000_000) => ({ id, name, sortOrder: 0, createdAt, updatedAt });
const pfTx = (id, portfolioId) => ({ id, type: "buy", amountSompi: 100_000_000, fiatValue: 12.5, timestamp: 1_780_000_000_000, notes: null, portfolioId, sourceAddress: null, sourceTxId: null, updatedAt: 1_780_000_000_000 });
const pfState = (rows, transactions = [], tombstones = []) => ({ portfolios: rows, transactions, fees: [], tombstones });
function pfFake(walletAddress = WALLET_A, fields = { autoBackup: false }) {
  toFake(walletAddress, { backupFolder: "KaChat", singlePortfolioMerged: true, ...fields });
  dav.listings = true;
  dav.folders.add("sam/KaChat");
  dav.files.set("sam/KaChat/.keep.txt", "");
  backupKeyAvailable = true;
  startModule();
}
const pfFile = async (name) => JSON.parse(await openFor(WALLET_A, dav.get("sam", `KaChat/${name}`)));
const pfJson = (rows, transactions = [], walletAddress = WALLET_A) => portfolioSync.portfolioBackupFileJson(pfState(rows, transactions), walletAddress);
const pfPuts = () => dav.log.filter((r) => r.method === "PUT").map((r) => r.path);
// Another account's file: its own key, its own wallet's hint.
const pfForeign = async (name, walletAddress) => dav.put("sam", `KaChat/${name}`,
  await sealBackupEnvelope(pfJson([pfRow(PF_SHORT, name)], [], walletAddress), "22".repeat(32), walletAddress));

test("portfolio: each gets its own encrypted file named after it, with its owner and only its rows", async () => {
  pfFake();
  portfolios.local = pfState([pfRow(PF_LONG, "Long Term"), pfRow(PF_SHORT, "Short")], [pfTx("t1", PF_LONG), pfTx("t2", PF_SHORT)]);
  await runPortfolioBackup();
  const long = await pfFile("Long Term.json");
  assert.equal(long.type, "kapay-portfolio");
  assert.equal(long.version, 2);
  assert.equal(long.walletAddress, WALLET_A);
  assert.deepEqual(long.portfolios.map((p) => p.name), ["Long Term"]);
  assert.deepEqual(long.transactions.map((t) => t.id), ["t1"]);
  assert.deepEqual((await pfFile("Short.json")).transactions.map((t) => t.id), ["t2"]);
  assert.equal(typeof long.portfolios[0].createdAt, "number", "KaPay's decoder takes seconds since 2001");
  assert.ok(long.portfolios[0].createdAt < 1e9);
});

test("portfolio: a second backup writes nothing, and an unchanged file isn't downloaded again", async () => {
  pfFake();
  portfolios.local = pfState([pfRow(PF_LONG, "Long Term")], [pfTx("t1", PF_LONG)]);
  await runPortfolioBackup();
  dav.log = [];
  await runPortfolioBackup();
  assert.deepEqual(pfPuts(), []);
  dav.log = [];
  await runPortfolioBackup();
  assert.deepEqual(dav.log.filter((r) => r.method === "GET").map((r) => r.path), [], "same size and time: the cached read");
});

test("portfolio: another account's file or any other file is never written over", async () => {
  pfFake();
  await pfForeign("Long Term.json", WALLET_B);
  dav.put("sam", "KaChat/Short.json", JSON.stringify({ mine: "not a portfolio" }));
  const foreign = dav.get("sam", "KaChat/Long Term.json");
  portfolios.local = pfState([pfRow(PF_LONG, "Long Term"), pfRow(PF_SHORT, "Short")]);
  await runPortfolioBackup();
  assert.equal(dav.get("sam", "KaChat/Long Term.json"), foreign);
  assert.deepEqual(JSON.parse(dav.get("sam", "KaChat/Short.json")), { mine: "not a portfolio" });
  assert.equal((await pfFile("Long Term 2.json")).walletAddress, WALLET_A);
  assert.equal((await pfFile("Short 2.json")).walletAddress, WALLET_A);
  assert.equal(portfolios.local.portfolios.length, 2, "another account's isn't merged in");
});

test("portfolio: another device's edits and deletions come in, and a renamed portfolio's old file goes", async () => {
  pfFake();
  portfolios.local = pfState([pfRow(PF_LONG, "Long Term")]);
  await runPortfolioBackup();
  portfolios.local = pfState([pfRow(PF_LONG, "Renamed", 1_780_000_000_000, 1_790_000_000_000)]);
  dav.put("sam", "KaChat/Other.json", await sealFor(WALLET_A, pfJson([pfRow(PF_SHORT, "Other")], [pfTx("t9", PF_SHORT)])));
  await runPortfolioBackup();
  assert.equal(dav.get("sam", "KaChat/Long Term.json"), undefined);
  assert.equal((await pfFile("Renamed.json")).portfolios[0].name, "Renamed");
  assert.deepEqual(portfolios.local.portfolios.map((p) => p.name).sort(), ["Other", "Renamed"]);
  assert.deepEqual(portfolios.local.transactions.map((t) => t.id), ["t9"]);
});

test("portfolio: a deleted one's file goes, and one this device doesn't know of stays", async () => {
  pfFake();
  portfolios.local = pfState([pfRow(PF_LONG, "Long Term"), pfRow(PF_SHORT, "Short")]);
  await runPortfolioBackup();
  portfolios.local = pfState([pfRow(PF_LONG, "Long Term")], [], [{ kind: "portfolio", id: PF_SHORT, deletedAt: 1_790_000_000_000 }]);
  await runPortfolioBackup();
  assert.equal(dav.get("sam", "KaChat/Short.json"), undefined);
  assert.deepEqual((await pfFile("Long Term.json")).tombstones.map((t) => t.id), [PF_SHORT], "the other files carry the deletion");
});

test("portfolio: the file is the contacts' envelope, with a fresh nonce on every write", async () => {
  pfFake();
  portfolios.local = pfState([pfRow(PF_LONG, "Long Term")], [pfTx("t1", PF_LONG)]);
  await runPortfolioBackup();
  const first = JSON.parse(dav.get("sam", "KaChat/Long Term.json"));
  assert.equal(first.kachatEncryptedBackup, 1);
  assert.equal(first.cipher, "aes-256-gcm");
  assert.equal(first.walletAddress, undefined, "nothing readable outside the envelope");
  assert.ok(!dav.get("sam", "KaChat/Long Term.json").includes("Long Term\""), "the name is only in the file name");
  portfolios.local = pfState([pfRow(PF_LONG, "Long Term")], [pfTx("t1", PF_LONG), pfTx("t2", PF_LONG)]);
  await runPortfolioBackup();
  const second = JSON.parse(dav.get("sam", "KaChat/Long Term.json"));
  assert.notEqual(second.nonce, first.nonce);
  assert.deepEqual((await pfFile("Long Term.json")).transactions.map((t) => t.id), ["t1", "t2"]);
});

test("portfolio: an earlier plain file of this account's is read, then written encrypted though unchanged", async () => {
  pfFake();
  dav.put("sam", "KaChat/Long Term.json", pfJson([pfRow(PF_LONG, "Long Term")], [pfTx("t1", PF_LONG)]));
  portfolios.local = pfState([]);
  await runPortfolioBackup();
  assert.deepEqual(portfolios.local.transactions.map((t) => t.id), ["t1"]);
  assert.equal(JSON.parse(dav.get("sam", "KaChat/Long Term.json")).kachatEncryptedBackup, 1);
  assert.equal(dav.get("sam", "KaChat/Long Term 2.json"), undefined);
  dav.log = [];
  await runPortfolioBackup();
  assert.deepEqual(pfPuts(), [], "encrypted now: nothing more to write");
});

test("portfolio: this account's damaged file is written over; an envelope naming no account is left alone", async () => {
  pfFake();
  const damaged = await sealBackupEnvelope(pfJson([pfRow(PF_LONG, "Long Term")]), "33".repeat(32), WALLET_A);
  dav.put("sam", "KaChat/Long Term.json", damaged);
  const anonymous = JSON.parse(await sealBackupEnvelope(pfJson([pfRow(PF_SHORT, "Short")]), "33".repeat(32), WALLET_A));
  delete anonymous.walletHint;
  dav.put("sam", "KaChat/Short.json", JSON.stringify(anonymous));
  portfolios.local = pfState([pfRow(PF_LONG, "Long Term"), pfRow(PF_SHORT, "Short")]);
  await runPortfolioBackup();
  assert.notEqual(dav.get("sam", "KaChat/Long Term.json"), damaged);
  assert.equal((await pfFile("Long Term.json")).portfolios[0].name, "Long Term");
  assert.equal(dav.get("sam", "KaChat/Long Term 2.json"), undefined);
  assert.equal(dav.get("sam", "KaChat/Short.json"), JSON.stringify(anonymous));
  assert.equal((await pfFile("Short 2.json")).portfolios[0].name, "Short");
});

test("portfolio: without the key nothing is read or written", async () => {
  pfFake();
  dav.put("sam", "KaChat/Long Term.json", pfJson([pfRow(PF_LONG, "Long Term")], [pfTx("t1", PF_LONG)]));
  portfolios.local = pfState([pfRow(PF_SHORT, "Short")]);
  backupKeyAvailable = false;
  dav.log = [];
  await assert.rejects(runPortfolioBackup(), /wallet key is unavailable/);
  assert.deepEqual(pfPuts(), []);
  assert.deepEqual(dav.log.filter((r) => r.method === "GET"), []);
  assert.deepEqual(portfolios.local.transactions, []);
});

test("portfolio: the earlier single file is merged once and never written", async () => {
  pfFake(WALLET_A, { autoBackup: false, singlePortfolioMerged: false });
  const single = JSON.stringify({ version: 1, exportedAt: 700000000, portfolios: [{ id: PF_LONG, name: "Old", sortOrder: 0, createdAt: 700000000, updatedAt: 700000000 }], transactions: [], fees: [], tombstones: [] });
  dav.put("sam", "KaChat/KaPay Portfolio.json", single);
  portfolios.local = pfState([]);
  await runPortfolioBackup();
  assert.deepEqual(portfolios.local.portfolios.map((p) => p.name), ["Old"]);
  assert.equal((await pfFile("Old.json")).portfolios[0].name, "Old");
  assert.equal(dav.get("sam", "KaChat/KaPay Portfolio.json"), single, "stays where it is");
  dav.log = [];
  await runPortfolioBackup();
  assert.deepEqual(dav.log.filter((r) => r.method === "GET" && r.path.includes("KaPay Portfolio")), [], "not read again");
});

test("portfolio: a file that can't be read means nothing is written or deleted", async () => {
  pfFake();
  portfolios.local = pfState([pfRow(PF_LONG, "Long Term")]);
  await runPortfolioBackup();
  portfolios.local = pfState([pfRow(PF_LONG, "Renamed", 1_780_000_000_000, 1_790_000_000_000)]);
  dav.put("sam", "KaChat/Broken.json", "{}");
  dav.hook = ({ method, path }) => (method === "GET" && path === "KaChat/Broken.json" ? new Response("", { status: 500 }) : undefined);
  dav.log = [];
  await assert.rejects(runPortfolioBackup());
  assert.deepEqual(pfPuts(), []);
  assert.ok(dav.get("sam", "KaChat/Long Term.json"));
});

test("portfolio: with Automatic Sync on a change uploads after the quiet time; a 401 stops automatic work", async () => {
  pfFake(WALLET_A, { autoBackup: true, lastAutoBackup: Date.now() });
  portfolios.local = pfState([pfRow(PF_LONG, "Long Term")]);
  await sleep(1200);
  dav.log = [];
  notePortfolioChanged();
  assert.deepEqual(pfPuts(), [], "not yet: a burst of edits is one upload");
  await sleep(5300);
  assert.deepEqual(pfPuts(), ["KaChat/Long Term.json"]);
  dav.hook = () => new Response("", { status: 401 });
  portfolios.local = pfState([pfRow(PF_LONG, "Renamed", 1_780_000_000_000, 1_790_000_000_000)]);
  notePortfolioChanged();
  await sleep(5300);
  assert.ok(logs.some((line) => line.includes("automatic sync stops")), "said once, in the log");
  dav.log = [];
  dav.hook = null;
  notePortfolioChanged();
  noteContactActivity();
  await sleep(5300);
  assert.deepEqual(dav.log, [], "nothing asks a server that refused this login");
  storeAccount(WALLET_A, { autoBackup: false });
  resetNextcloudForAccount();
});

test("disconnecting revokes the app password on the server, and a failure there changes nothing", async () => {
  toFake(WALLET_A, { autoBackup: false });
  dav.revokes = [];
  await revokeAppPassword({ server: "https://cloud.example.test", username: "sam", appPassword: "app-pass" });
  assert.deepEqual(dav.revokes, [{ method: "DELETE", ocs: "true", auth: `Basic ${btoa("sam:app-pass")}` }]);
  await revokeAppPassword(null);
  assert.equal(dav.revokes.length, 1);
});

test("a contacts file from a newer version of the app is refused, never merged or written over", async () => {
  fresh();
  assert.throws(() => mergeSharedContactsFile(JSON.stringify({ type: "kachat-address-book", version: 2, exportedAt: "2026-11-01T20:00:00Z", walletAddress: WALLET_A, entries: [], deleted: [] })));
});

test("deleting the backup with the account takes the contacts file and the old chat backups", async () => {
  toFake(WALLET_A, { autoBackup: false });
  dav.put("sam", BACKUP_PATH, "{}");
  dav.put("sam", "KaChat/kachat-backup.json", "{}");
  dav.put("sam", "KaChat/kachat-backup-desktop.json", "{}");
  startModule();
  await deleteRemoteNextcloudBackup();
  assert.equal(dav.get("sam", BACKUP_PATH), undefined);
  assert.equal(dav.get("sam", "KaChat/kachat-backup.json"), undefined);
  assert.equal(dav.get("sam", "KaChat/kachat-backup-desktop.json"), undefined);
  // Nothing there is the state asked for.
  await deleteRemoteNextcloudBackup();
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
