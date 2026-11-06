// An import's funded-address search and rediscovered groups (KaChat-iPhone 836b62bc, 7916f5cd), and
// what Backup status does on an import. No network. Run from the repo root:
//
//   node tools/test-account-import.mjs

import assert from "node:assert/strict";
import { IMPORT_ADDRESS_SEARCH_DEPTH, foundChattingAddresses, firstFundedAddress, rediscoveredGroupIsRead, pastedWordsInvalidMessage } from "../ui/account-import.js";
import { createAccountBackupStatus, addCalendarMonths, HYGIENE_MONTHS } from "../ui/account-backup-status.js";

assert.equal(IMPORT_ADDRESS_SEARCH_DEPTH, 50);

const derived = [{ index: 7, address: "g" }, { index: 0, address: "a" }, { index: 3, address: "d" }, { index: 1, address: "b" }];

// Nothing funded: only #0, which is what gets imported.
let found = foundChattingAddresses(derived, new Map());
assert.deepEqual(found, [{ index: 0, address: "a", sompi: 0 }]);
assert.equal(firstFundedAddress(found).index, 0);

// #0 is always listed, then the funded ones in index order; the first with funds is picked.
found = foundChattingAddresses(derived, new Map([["g", 700], ["d", 300]]));
assert.deepEqual(found.map((entry) => entry.index), [0, 3, 7]);
assert.equal(firstFundedAddress(found).index, 3);

// #0 holding funds wins, even with others.
found = foundChattingAddresses(derived, new Map([["a", 5], ["g", 700]]));
assert.equal(firstFundedAddress(found).index, 0);

assert.equal(firstFundedAddress([]), null);

// Before the import: history. After: news. Unknown times change nothing.
assert.equal(rediscoveredGroupIsRead({ inviteAtMs: 100, importedAtMs: 200 }), true);
assert.equal(rediscoveredGroupIsRead({ inviteAtMs: 300, importedAtMs: 200 }), false);
assert.equal(rediscoveredGroupIsRead({ inviteAtMs: 200, importedAtMs: 200 }), false);
assert.equal(rediscoveredGroupIsRead({ inviteAtMs: 0, importedAtMs: 200 }), false);
assert.equal(rediscoveredGroupIsRead({ inviteAtMs: 100, importedAtMs: 0 }), false);
assert.equal(rediscoveredGroupIsRead({ inviteAtMs: null, importedAtMs: undefined }), false);

// An import owes no backup and starts the six months, which move with the chatting address.
const memory = new Map();
const storage = { getItem: (key) => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, value) };
const status = createAccountBackupStatus({ storage });
const importedAt = new Date("2026-11-03T12:00:00Z");
status.markPending("addr");
status.markConfirmed("addr", importedAt);
assert.equal(status.isPending("addr"), false);
assert.equal(status.isHygieneDue("addr", importedAt), false);
const due = addCalendarMonths(importedAt, HYGIENE_MONTHS);
assert.equal(status.isHygieneDue("addr", due), true);
status.carry("addr", "other");
assert.equal(status.isHygieneDue("addr", due), false);
assert.equal(status.isHygieneDue("other", due), true);

// Paste's error says how many pasted words aren't recovery words, never which (iOS 3942a5b7).
assert.equal(pastedWordsInvalidMessage(1), "One of the pasted words isn't a valid word. Check your copy and try again.");
assert.equal(pastedWordsInvalidMessage(3), "3 of the pasted words aren't valid words. Check your copy and try again.");
for (const count of [1, 2, 24]) assert.ok(!/zoo|abandon/.test(pastedWordsInvalidMessage(count)));

// A create whose save failed owes nothing (iOS 3942a5b7): marked before the save, unmarked after.
status.markPending("new");
assert.equal(status.isPending("new"), true);
status.markDone("new");
assert.equal(status.isPending("new"), false);
assert.equal(status.isHygieneDue("new", due), false, "never confirmed, so no hygiene timer either");

console.log("test-account-import: all passed");
