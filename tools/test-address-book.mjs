// node tools/test-address-book.mjs - the Address Book store (ui/address-book-store.js).
// localStorage and the photo store are in-memory maps; the account-scoped key is the app's format.
import assert from "node:assert/strict";
import {
  configureAddressBook, addressBookEntries, addressBookEntry, addressBookName, searchAddressBook,
  saveAddressBookEntry, removeAddressBookEntry, addressBookPhoto, hasAddressBookPhoto,
  addressBookPhotoBytes, removeAllAddressBookPhotos, removeAddressBookForWallet,
  archiveAddressBook, importAddressBookArchive, mergeAddressBooks, mergeAddressBookArchives,
  normalizeAddressBookAddress, onAddressBookChange,
  addressBookExportJson, addressBookExportFileName, importAddressBookExport,
  ADDRESS_BOOK_ENTRIES_KEY, ADDRESS_BOOK_DELETED_KEY,
} from "../ui/address-book-store.js";
import { kaChatFolderFileName } from "../ui/nextcloud.js";

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
// A tiny JPEG-ish payload; the store only ever treats it as base64.
const PHOTO_B64 = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==";
const PHOTO = `data:image/jpeg;base64,${PHOTO_B64}`;

let local;
let photos;
let wallet;
let clock;
function fresh({ start = Date.parse("2026-10-08T12:00:00Z") } = {}) {
  local = new MemoryStorage();
  photos = new Map();
  wallet = WALLET_A;
  clock = start;
  configureAddressBook({
    storage: local,
    photoStorage: { get: (k) => photos.get(k) ?? null, set: (k, v) => photos.set(k, v), remove: (k) => photos.delete(k) },
    scopedKey: (base, w) => (String(w || "").trim() ? `${PREFIX}:${String(w).trim()}:${base}` : base),
    wallet: () => wallet,
    isValidAddress: (a) => /^kaspa(test)?:[a-z0-9]{20,}$/.test(a),
    now: () => clock,
  });
}
const tick = (ms = 1000) => { clock += ms; };
const iso = (ms) => `${new Date(ms).toISOString().slice(0, 19)}Z`;

const tests = [];
function test(name, fn) { tests.push([name, fn]); }

test("add, rename, note, search; entries sorted by name", () => {
  fresh();
  const saved = saveAddressBookEntry({ address: `  ${BOB.toUpperCase()}?amount=5 `, name: " Bob ", note: " work " });
  assert.equal(saved.address, BOB, "address normalised (trimmed, lowercased, no ?query)");
  assert.equal(saved.name, "Bob");
  assert.equal(saved.note, "work");
  assert.match(saved.id, /^[0-9a-f-]{36}$/);
  tick();
  saveAddressBookEntry({ address: ALICE, name: "alice" });
  assert.deepEqual(addressBookEntries().map((e) => e.name), ["alice", "Bob"], "case-insensitive name order");
  tick();
  const createdAt = addressBookEntry(BOB).createdAt;
  const renamed = saveAddressBookEntry({ address: BOB, name: "Robert", note: "" });
  assert.equal(renamed.id, saved.id, "a rename keeps the id");
  assert.equal(renamed.createdAt, createdAt, "and createdAt");
  assert.equal(renamed.updatedAt, clock, "and bumps updatedAt");
  assert.equal(addressBookName(BOB), "Robert");
  assert.equal(addressBookName(`${BOB}?amount=1`), "Robert", "lookups normalise too");
  assert.deepEqual(searchAddressBook("rob").map((e) => e.address), [BOB]);
  assert.deepEqual(searchAddressBook("qpalice").map((e) => e.address), [ALICE], "search matches addresses");
  saveAddressBookEntry({ address: ALICE, name: "alice", note: "Met at the meetup" });
  assert.deepEqual(searchAddressBook("MEETUP").map((e) => e.address), [ALICE], "and notes");
  assert.equal(searchAddressBook("").length, 2);
});

test("save refuses: no wallet, empty name, invalid address", () => {
  fresh();
  assert.throws(() => saveAddressBookEntry({ address: ALICE, name: "  " }), /Enter a name\./);
  assert.throws(() => saveAddressBookEntry({ address: "kaspa:nope", name: "X" }), /Enter a valid Kaspa address\./);
  wallet = "";
  assert.throws(() => saveAddressBookEntry({ address: ALICE, name: "Alice" }), /Open a wallet first\./);
  assert.equal(addressBookEntries().length, 0);
});

test("delete leaves a tombstone; re-adding lifts it", () => {
  fresh();
  saveAddressBookEntry({ address: ALICE, name: "Alice", photo: PHOTO });
  assert.ok(hasAddressBookPhoto(ALICE));
  tick();
  assert.equal(removeAddressBookEntry(ALICE), true);
  assert.equal(removeAddressBookEntry(ALICE), false, "a second delete is a no-op");
  assert.equal(addressBookEntry(ALICE), null);
  assert.equal(addressBookPhoto(ALICE), null, "the photo goes with its entry");
  const stored = JSON.parse(local.getItem(`${PREFIX}:${WALLET_A}:${ADDRESS_BOOK_DELETED_KEY}`));
  assert.deepEqual(stored, [{ address: ALICE, deletedAt: clock }]);
  assert.deepEqual(archiveAddressBook().addressBookDeleted, [{ address: ALICE, deletedAt: iso(clock) }]);
  tick();
  saveAddressBookEntry({ address: ALICE, name: "Alice again" });
  assert.deepEqual(archiveAddressBook().addressBookDeleted, [], "saving again removes the tombstone");
});

test("one book per wallet", () => {
  fresh();
  saveAddressBookEntry({ address: ALICE, name: "Alice (A)", photo: PHOTO });
  wallet = WALLET_B;
  assert.equal(addressBookEntry(ALICE), null, "wallet B never sees wallet A's book");
  assert.equal(addressBookPhoto(ALICE), null, "nor its photos");
  saveAddressBookEntry({ address: ALICE, name: "Alice (B)" });
  saveAddressBookEntry({ address: BOB, name: "Bob (B)" });
  wallet = WALLET_A;
  assert.deepEqual(addressBookEntries().map((e) => e.name), ["Alice (A)"]);
  assert.ok(hasAddressBookPhoto(ALICE));
  wallet = WALLET_B;
  assert.deepEqual(addressBookEntries().map((e) => e.name), ["Alice (B)", "Bob (B)"]);
  assert.equal(hasAddressBookPhoto(ALICE), false);
  // Removing wallet A's account takes its book, tombstones and photos, and nothing of B's.
  wallet = WALLET_A;
  removeAddressBookEntry(ALICE);
  saveAddressBookEntry({ address: CAROL, name: "Carol", photo: PHOTO });
  removeAddressBookForWallet(WALLET_A);
  assert.equal(addressBookEntries().length, 0);
  assert.equal(local.getItem(`${PREFIX}:${WALLET_A}:${ADDRESS_BOOK_ENTRIES_KEY}`), null);
  assert.equal(local.getItem(`${PREFIX}:${WALLET_A}:${ADDRESS_BOOK_DELETED_KEY}`), null);
  assert.equal([...photos.keys()].some((k) => k.includes(WALLET_A)), false, "wallet A's photos are gone");
  wallet = WALLET_B;
  assert.equal(addressBookEntries().length, 2, "wallet B untouched");
});

test("merge: newest edit or deletion wins per address", () => {
  const t = (s) => `2026-10-08T12:00:${String(s).padStart(2, "0")}Z`;
  const local = [
    { address: ALICE, name: "Alice local", updatedAt: t(10) },
    { address: BOB, name: "Bob local", updatedAt: t(10) },
    { address: CAROL, name: "Carol local", updatedAt: t(10) },
  ];
  const remote = [
    { address: ALICE.toUpperCase(), name: "Alice remote", updatedAt: t(20) },   // newer edit wins
    { address: BOB, name: "Bob remote", updatedAt: t(5) },                        // older loses
    { address: CAROL, name: "Carol remote", updatedAt: t(10) },                   // tie: earlier side (local)
  ];
  const merged = mergeAddressBooks([local, remote], [[], []]);
  const byAddress = Object.fromEntries(merged.entries.map((e) => [e.address, e.name]));
  assert.deepEqual(byAddress, { [ALICE]: "Alice remote", [BOB]: "Bob local", [CAROL]: "Carol local" });

  // A deletion at or after the last edit deletes; an edit after the deletion brings it back.
  const withTombs = mergeAddressBooks(
    [local, remote],
    [[{ address: BOB, deletedAt: t(10) }], [{ address: ALICE, deletedAt: t(15) }, { address: CAROL, deletedAt: t(30) }]],
  );
  assert.deepEqual(withTombs.entries.map((e) => e.address), [ALICE], "Bob deleted at its edit time, Carol deleted after");
  assert.deepEqual(withTombs.tombstones.map((x) => x.address).sort(), [BOB, CAROL].sort(), "Alice's older tombstone is dropped");
  // Tombstones are a union, the latest per address kept.
  const tombs = mergeAddressBooks([[]], [[{ address: BOB, deletedAt: t(1) }], [{ address: BOB, deletedAt: t(9) }]]).tombstones;
  assert.equal(tombs.length, 1);
  assert.equal(tombs[0].deletedAt, Date.parse(t(9)));
});

test("shared-file merge in the archive's shape, photo with the winner", () => {
  const t = (s) => `2026-10-08T12:00:${String(s).padStart(2, "0")}Z`;
  const local = {
    addressBook: [{ id: "6f1c1a4e-8a9e-4b0b-9a43-0d7f2c9e1a11", address: ALICE, name: "Alice", note: "", createdAt: t(1), updatedAt: t(30) }],
    addressBookDeleted: [{ address: CAROL, deletedAt: t(40) }],
  };
  const remote = {
    addressBook: [
      { id: "7a2b3c4d-1111-4222-8333-444455556666", address: ALICE, name: "Alice old", note: "", createdAt: t(1), updatedAt: t(20), photo: PHOTO_B64 },
      { id: "8b2b3c4d-1111-4222-8333-444455556666", address: BOB, name: "Bob", note: "n", createdAt: t(2), updatedAt: t(25), photo: PHOTO_B64 },
      { id: "9c2b3c4d-1111-4222-8333-444455556666", address: CAROL, name: "Carol", note: "", createdAt: t(2), updatedAt: t(35) },
    ],
  };
  const merged = mergeAddressBookArchives(local, remote);
  assert.deepEqual(merged.addressBook.map((e) => e.address), [ALICE, BOB]);
  const alice = merged.addressBook[0];
  assert.equal(alice.name, "Alice", "local's newer edit wins");
  assert.equal(alice.photo, undefined, "the winner had no photo, so none travels (the photo was removed there)");
  assert.equal(alice.updatedAt, t(30), "dates stay whole-second ISO 8601");
  assert.equal(alice.id, "6f1c1a4e-8a9e-4b0b-9a43-0d7f2c9e1a11");
  assert.equal(merged.addressBook[1].photo, PHOTO_B64, "Bob's photo rides with Bob");
  assert.deepEqual(merged.addressBookDeleted, [{ address: CAROL, deletedAt: t(40) }]);
  // Older archives have neither key.
  assert.deepEqual(mergeAddressBookArchives({}, null), { addressBook: [], addressBookDeleted: [] });
});

test("archive round-trip, photo included", () => {
  fresh();
  saveAddressBookEntry({ address: ALICE, name: "Alice", note: "friend", photo: PHOTO });
  tick(1500);
  saveAddressBookEntry({ address: BOB, name: "Bob" });
  tick();
  saveAddressBookEntry({ address: CAROL, name: "Carol" });
  tick();
  removeAddressBookEntry(CAROL);
  const archive = JSON.parse(JSON.stringify(archiveAddressBook()));
  assert.deepEqual(archive.addressBook.map((e) => e.address), [ALICE, BOB]);
  const alice = archive.addressBook[0];
  assert.deepEqual(Object.keys(alice).sort(), ["address", "createdAt", "id", "name", "note", "photo", "updatedAt"]);
  assert.equal(alice.photo, PHOTO_B64, "raw base64, no data: prefix");
  assert.match(alice.updatedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/, "whole-second ISO 8601 (Swift .iso8601)");
  assert.equal(archive.addressBook[1].photo, undefined, "no photo key when none is assigned");
  assert.deepEqual(archive.addressBookDeleted.map((t) => t.address), [CAROL]);

  // Restored into the same wallet on a fresh device.
  fresh({ start: Date.parse("2026-10-09T00:00:00Z") });
  assert.equal(importAddressBookArchive(archive.addressBook, archive.addressBookDeleted), true);
  assert.deepEqual(addressBookEntries().map((e) => [e.name, e.note]), [["Alice", "friend"], ["Bob", ""]]);
  assert.equal(addressBookEntry(ALICE).id, alice.id, "ids survive");
  assert.equal(addressBookPhoto(ALICE), PHOTO, "the photo comes back as a data URL");
  assert.equal(hasAddressBookPhoto(BOB), false);
  const again = JSON.parse(JSON.stringify(archiveAddressBook()));
  assert.deepEqual(again, archive, "export after restore is the same archive");
});

test("restore: the winning entry decides the photo; deletions and newer local edits hold", () => {
  fresh();
  saveAddressBookEntry({ address: ALICE, name: "Alice", photo: PHOTO });
  saveAddressBookEntry({ address: BOB, name: "Bob", photo: PHOTO });
  saveAddressBookEntry({ address: CAROL, name: "Carol" });
  const t0 = clock;
  tick(10_000);
  saveAddressBookEntry({ address: CAROL, name: "Carol (newer here)" });
  const incoming = [
    // Edited elsewhere later, photo removed there: ours goes.
    { id: "6f1c1a4e-8a9e-4b0b-9a43-0d7f2c9e1a11", address: ALICE, name: "Alice B", note: "", createdAt: iso(t0), updatedAt: iso(t0 + 5000) },
    // Older than ours: ignored, photo kept.
    { id: "7f1c1a4e-8a9e-4b0b-9a43-0d7f2c9e1a11", address: CAROL, name: "Carol old", note: "", createdAt: iso(t0), updatedAt: iso(t0), photo: PHOTO_B64 },
  ];
  const tombs = [{ address: BOB, deletedAt: iso(t0 + 3000) }];
  importAddressBookArchive(incoming, tombs);
  assert.equal(addressBookEntry(ALICE).name, "Alice B");
  assert.equal(hasAddressBookPhoto(ALICE), false, "an incoming winner without a photo removes ours");
  assert.equal(addressBookEntry(BOB), null, "deleted after its last edit: stays deleted");
  assert.equal(hasAddressBookPhoto(BOB), false);
  assert.equal(addressBookEntry(CAROL).name, "Carol (newer here)", "our newer edit wins");
  assert.equal(hasAddressBookPhoto(CAROL), false, "and the loser's photo is not taken");
  assert.deepEqual(archiveAddressBook().addressBookDeleted.map((t) => t.address), [BOB]);
  // An empty archive changes nothing.
  assert.equal(importAddressBookArchive([], []), false);
});

test("Remove Address Book Photos: every wallet, entries marked edited", () => {
  fresh();
  saveAddressBookEntry({ address: ALICE, name: "Alice", photo: PHOTO });
  saveAddressBookEntry({ address: BOB, name: "Bob" });
  wallet = WALLET_B;
  saveAddressBookEntry({ address: CAROL, name: "Carol", photo: PHOTO });
  wallet = WALLET_A;
  const decoded = Buffer.from(PHOTO_B64, "base64").length;
  assert.equal(addressBookPhotoBytes(), decoded * 2, "counts both wallets' photos");
  const bobBefore = addressBookEntry(BOB).updatedAt;
  tick(5000);
  let events = 0;
  const off = onAddressBookChange(() => { events += 1; });
  assert.equal(removeAllAddressBookPhotos(), 2);
  off();
  assert.equal(events, 1);
  assert.equal(addressBookPhotoBytes(), 0);
  assert.equal(addressBookEntry(ALICE).updatedAt, clock, "an entry that lost its photo counts as edited");
  assert.equal(addressBookEntry(BOB).updatedAt, bobBefore, "one without a photo is untouched");
  wallet = WALLET_B;
  assert.equal(addressBookEntry(CAROL).updatedAt, clock, "in the other wallet too");
  assert.equal(addressBookPhoto(CAROL), null);
  // ...so the shared-file merge drops the remote copy's photo instead of bringing it back.
  const remote = { addressBook: [{ address: CAROL, name: "Carol", note: "", createdAt: iso(clock - 5000), updatedAt: iso(clock - 5000), photo: PHOTO_B64 }] };
  const merged = mergeAddressBookArchives(archiveAddressBook(), remote);
  assert.equal(merged.addressBook[0].photo, undefined);
});

test("export file: name, format, photo attached", () => {
  fresh({ start: Date.parse("2026-10-08T18:37:50.123Z") });
  assert.equal(addressBookExportFileName(), "KaChat Address Book 2026-10-08T18-37-50Z.json", "iOS's ISO8601DateFormatter time, \":\" made \"-\"");
  assert.equal(addressBookExportFileName(Date.parse("2026-01-02T03:04:05Z")), "KaChat Address Book 2026-01-02T03-04-05Z.json");
  saveAddressBookEntry({ address: BOB, name: "Bob", note: "work" });
  saveAddressBookEntry({ address: ALICE, name: "Alice", photo: PHOTO });
  const text = addressBookExportJson();
  const file = JSON.parse(text);
  assert.deepEqual(Object.keys(file), ["entries", "exportedAt", "type", "version", "walletAddress"], "sorted keys, like iOS");
  assert.equal(file.type, "kachat-address-book");
  assert.equal(file.version, 1);
  assert.equal(file.exportedAt, "2026-10-08T18:37:50Z", "whole-second ISO 8601");
  assert.equal(file.walletAddress, WALLET_A);
  assert.deepEqual(file.entries.map((e) => e.address), [ALICE, BOB], "sorted by name");
  assert.deepEqual(Object.keys(file.entries[0]), ["address", "createdAt", "id", "name", "note", "photo", "updatedAt"]);
  assert.equal(file.entries[0].photo, PHOTO_B64, "the photo rides with its entry as raw base64");
  assert.equal(file.entries[1].photo, undefined, "no photo key without one");
  assert.equal(file.entries[1].note, "work");
  assert.match(text, /\n {2}"entries"/, "pretty-printed");
  wallet = "";
  assert.equal(JSON.parse(addressBookExportJson()).walletAddress, undefined, "no wallet: left out, like iOS's nil");
});

test("import: adds, updates only from a newer edit, lifts a tombstone, brings the photo", () => {
  fresh();
  saveAddressBookEntry({ address: ALICE, name: "Alice here", photo: PHOTO });
  saveAddressBookEntry({ address: BOB, name: "Bob here", note: "keep" });
  saveAddressBookEntry({ address: CAROL, name: "Carol" });
  const t0 = clock;
  tick(10_000);
  removeAddressBookEntry(CAROL);
  const deletedAt = clock;
  tick(10_000);
  const DAVE = "kaspa:qpdave0000000000000000000000000000000000000000000000000000";
  const file = {
    type: "kachat-address-book", version: 1, exportedAt: iso(clock), walletAddress: WALLET_B,
    entries: [
      // Newer than ours: name, note and photo (none - removed there) taken.
      { id: "6f1c1a4e-8a9e-4b0b-9a43-0d7f2c9e1a11", address: ALICE, name: "Alice there", note: "n", createdAt: iso(t0), updatedAt: iso(t0 + 5000) },
      // Older than ours: ignored.
      { id: "7f1c1a4e-8a9e-4b0b-9a43-0d7f2c9e1a11", address: BOB.toUpperCase(), name: "Bob old", note: "", createdAt: iso(t0 - 9000), updatedAt: iso(t0 - 9000), photo: PHOTO_B64 },
      // Deleted here after this edit: imported anyway (asking for it back), tombstone lifted.
      { id: "8f1c1a4e-8a9e-4b0b-9a43-0d7f2c9e1a11", address: CAROL, name: "Carol back", note: "", createdAt: iso(t0), updatedAt: iso(t0), photo: PHOTO_B64 },
      // New: added with its own id, times and photo.
      { id: "9f1c1a4e-8a9e-4b0b-9a43-0d7f2c9e1a11", address: DAVE, name: "Dave", note: "x", createdAt: iso(t0 - 1000), updatedAt: iso(t0 - 1000), photo: PHOTO_B64 },
      // Unusable rows are skipped, not fatal.
      { address: "kaspa:nope", name: "Bad" },
      { address: DAVE, name: "  " },
    ],
  };
  let events = 0;
  const off = onAddressBookChange((kind) => { events += 1; assert.equal(kind, "import"); });
  assert.deepEqual(importAddressBookExport(JSON.stringify(file)), { added: 2, updated: 1, skipped: 0 });
  off();
  assert.equal(events, 1);
  assert.equal(addressBookEntry(ALICE).name, "Alice there");
  assert.equal(addressBookEntry(ALICE).note, "n");
  assert.equal(addressBookEntry(ALICE).updatedAt, t0 + 5000);
  assert.equal(hasAddressBookPhoto(ALICE), false, "a newer edit without a photo removes ours");
  assert.equal(addressBookEntry(BOB).name, "Bob here", "an older edit never overwrites");
  assert.equal(hasAddressBookPhoto(BOB), false, "nor brings its photo");
  assert.equal(addressBookEntry(CAROL).name, "Carol back", "a deleted address comes back");
  assert.ok(deletedAt > t0, "even though it was deleted after the file's edit");
  assert.deepEqual(archiveAddressBook().addressBookDeleted, [], "its tombstone is lifted");
  assert.equal(addressBookPhoto(CAROL), PHOTO);
  const dave = addressBookEntry(DAVE);
  assert.deepEqual([dave.id, dave.name, dave.note, dave.createdAt], ["9f1c1a4e-8a9e-4b0b-9a43-0d7f2c9e1a11", "Dave", "x", t0 - 1000]);
  assert.equal(addressBookPhoto(DAVE), PHOTO, "the photo comes with its entry");
  // Persisted, and a second import of the same file changes nothing.
  configureAddressBook({});
  assert.equal(addressBookEntry(DAVE).name, "Dave");
  assert.deepEqual(importAddressBookExport(file), { added: 0, updated: 0, skipped: 0 });
  // An id already used by another entry gets a fresh one.
  const EVE = "kaspa:qpeve00000000000000000000000000000000000000000000000000000";
  importAddressBookExport({ ...file, entries: [{ id: dave.id, address: EVE, name: "Eve", note: "", createdAt: iso(clock), updatedAt: iso(clock) }] });
  assert.notEqual(addressBookEntry(EVE).id, dave.id);
  // Round trip: our own export imports into another wallet.
  const exported = addressBookExportJson();
  wallet = WALLET_B;
  assert.deepEqual(importAddressBookExport(exported), { added: 5, updated: 0, skipped: 0 });
  assert.equal(addressBookPhoto(DAVE), PHOTO);
});

test("import refuses: not an export, wrong type or version, no addresses, no wallet", () => {
  fresh();
  const NOT = /: That file isn't a KaChat Address Book export\.$/;
  const ok = { type: "kachat-address-book", version: 1, exportedAt: iso(clock), entries: [{ address: ALICE, name: "Alice", createdAt: iso(clock), updatedAt: iso(clock) }] };
  assert.throws(() => importAddressBookExport("not json"), NOT);
  assert.throws(() => importAddressBookExport("[]"), NOT);
  assert.throws(() => importAddressBookExport(JSON.stringify({ ...ok, type: "kachat-backup" })), NOT);
  assert.throws(() => importAddressBookExport(JSON.stringify({ ...ok, type: undefined })), NOT);
  assert.throws(() => importAddressBookExport(JSON.stringify({ ...ok, version: 2 })), NOT, "an unsupported version");
  assert.throws(() => importAddressBookExport(JSON.stringify({ ...ok, version: "1" })), NOT);
  assert.throws(() => importAddressBookExport(JSON.stringify({ ...ok, version: undefined })), NOT);
  assert.throws(() => importAddressBookExport(JSON.stringify({ ...ok, entries: {} })), NOT);
  // A chat backup carries addressBook, not an Address Book export.
  assert.throws(() => importAddressBookExport(JSON.stringify(archiveAddressBook())), NOT);
  assert.throws(() => importAddressBookExport(JSON.stringify({ ...ok, entries: [] })), /: That Address Book export has no addresses\.$/);
  assert.throws(() => importAddressBookExport(JSON.stringify({ ...ok, entries: [{ address: "kaspa:nope", name: "X" }] })), /no addresses/);
  assert.equal(addressBookEntries().length, 0, "nothing imported by a refused file");
  wallet = "";
  assert.throws(() => importAddressBookExport(JSON.stringify(ok)), /: Open a wallet first\.$/);
  wallet = WALLET_A;
  assert.deepEqual(importAddressBookExport(`﻿${JSON.stringify(ok)}`), { added: 1, updated: 0, skipped: 0 }, "a byte-order mark is fine");
});

test("Nextcloud: manual exports keep their spaces in the KaChat folder", () => {
  assert.equal(kaChatFolderFileName("KaChat Address Book 2026-10-08T18-37-50Z.json", { keepSpaces: true }), "KaChat Address Book 2026-10-08T18-37-50Z.json");
  assert.equal(kaChatFolderFileName("Long Term 2026-10-08T18-37-50Z.csv", { keepSpaces: true }), "Long Term 2026-10-08T18-37-50Z.csv");
  assert.equal(kaChatFolderFileName("Größe: 1/2.csv", { keepSpaces: true }), "Größe_ 1_2.csv", "letters survive; each other character becomes _");
  assert.equal(kaChatFolderFileName("Long Term.csv"), "Long_Term.csv", "other uploads unchanged");
});

test("other network (IOS-063): save refuses it, import skips and counts it, all-other-network is refused", () => {
  fresh();
  const reason = (a) => (a.startsWith("kaspatest:") ? "This is a Testnet address. KaChat is on Mainnet." : null);
  configureAddressBook({ otherNetworkReason: reason });
  const TN = "kaspatest:qptestnet0000000000000000000000000000000000000000000000000";
  assert.throws(() => saveAddressBookEntry({ address: TN, name: "Testy" }), /This is a Testnet address\. KaChat is on Mainnet\./);
  assert.equal(addressBookEntry(TN), null);
  const file = (entries) => ({ type: "kachat-address-book", version: 1, exportedAt: iso(clock), walletAddress: WALLET_A, entries });
  const row = (address, name) => ({ id: crypto.randomUUID(), address, name, note: "", createdAt: iso(clock), updatedAt: iso(clock) });
  assert.deepEqual(importAddressBookExport(file([row(ALICE, "Alice"), row(TN, "Testy")])), { added: 1, updated: 0, skipped: 1 });
  assert.equal(addressBookEntry(TN), null);
  assert.throws(() => importAddressBookExport(file([row(TN, "Testy")])), /Every address in that file is a Testnet address\. KaChat is on Mainnet\./);
  configureAddressBook({ otherNetworkReason: () => null });
});

test("normalise", () => {
  assert.equal(normalizeAddressBookAddress("  KASPA:QPABC?amount=1&label=x "), "kaspa:qpabc");
  assert.equal(normalizeAddressBookAddress(null), "");
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL - ${name}\n${error?.stack || error}`);
  }
}
if (failed) {
  console.error(`${failed} of ${tests.length} failed`);
  process.exit(1);
}
console.log(`all ${tests.length} passed`);
