// An import's search across wallet types and rediscovered groups (KaChat-iPhone da467165, 7916f5cd), and
// what Backup status does on an import. No network. Run from the repo root:
//
//   node tools/test-account-import.mjs

import assert from "node:assert/strict";
import { rankImportAccounts, importChoiceKey, visibleImportRows, importFundsHint, rediscoveredGroupIsRead, pastedWordsInvalidMessage } from "../ui/account-import.js";
import { WALLET_SOURCE_FAMILIES, sourceFamilyImportSearchDepth, sourceFamilyDisplayName, sourceFamilySupportsIndexScan } from "../engine/wallet.js";
import { createAccountBackupStatus, addCalendarMonths, HYGIENE_MONTHS } from "../ui/account-backup-status.js";

// Every wallet type, in iOS's order (WalletSourceFamily.allCases), and how deep each is searched.
assert.deepEqual(WALLET_SOURCE_FAMILIES, ["kaspaStandard", "kaspaLegacy972", "chainge", "oneKey"]);
assert.deepEqual(WALLET_SOURCE_FAMILIES.map(sourceFamilyImportSearchDepth), [50, 20, 1, 20]);
assert.deepEqual(WALLET_SOURCE_FAMILIES.map(sourceFamilyDisplayName), ["Standard Kaspa Wallet", "KDX / Kaspanet Web", "Chainge", "OneKey"]);
assert.deepEqual(WALLET_SOURCE_FAMILIES.map(sourceFamilySupportsIndexScan), [true, true, false, true]);

const candidates = [
  { family: "kaspaStandard", index: 0, address: "s0" }, { family: "kaspaStandard", index: 3, address: "s3" },
  { family: "kaspaStandard", index: 7, address: "s7" }, { family: "kaspaLegacy972", index: 0, address: "k0" },
  { family: "kaspaLegacy972", index: 2, address: "k2" }, { family: "chainge", index: 0, address: "c0" },
  { family: "oneKey", index: 0, address: "o0" },
];
const rank = (balances, history = []) => rankImportAccounts(candidates, new Map(balances), new Set(history), WALLET_SOURCE_FAMILIES);

// Nothing has funds or history: empty, and Import uses the standard wallet's #0.
assert.deepEqual(rank([]), []);

// Only addresses with funds or history are kept; the type holding the most comes first, each
// type's addresses in index order.
let found = rank([["s7", 100], ["k2", 500], ["k0", 1]]);
assert.deepEqual(found.map(importChoiceKey), ["kaspaLegacy972-0", "kaspaLegacy972-2", "kaspaStandard-7"]);
assert.equal(found[0].sompi, 1);

// History alone counts (an emptied wallet, a chat identity), shown without a balance.
found = rank([], ["o0"]);
assert.deepEqual(found, [{ family: "oneKey", index: 0, address: "o0", sompi: 0, hasHistory: true }]);

// A tie goes to the earlier type, so the standard wallet wins when nothing tells them apart.
found = rank([], ["c0", "s0"]);
assert.deepEqual(found.map(importChoiceKey), ["kaspaStandard-0", "chainge-0"]);
found = rank([["s3", 10], ["c0", 10]]);
assert.deepEqual(found.map(importChoiceKey), ["kaspaStandard-3", "chainge-0"]);

// See Every Wallet Type adds each type's #0 not already found, after what was found.
const every = WALLET_SOURCE_FAMILIES.map((family) => ({ family, index: 0, address: `${family}#0`, sompi: 0, hasHistory: false }));
found = rank([["s3", 10]]);
assert.deepEqual(visibleImportRows(found, every, false).map(importChoiceKey), ["kaspaStandard-3"]);
assert.deepEqual(visibleImportRows(found, every, true).map(importChoiceKey), ["kaspaStandard-3", "kaspaStandard-0", "kaspaLegacy972-0", "chainge-0", "oneKey-0"]);
assert.deepEqual(visibleImportRows(rank([], ["c0"]), every, true).map(importChoiceKey), ["chainge-0", "kaspaStandard-0", "kaspaLegacy972-0", "oneKey-0"]);
assert.equal(importChoiceKey({}), "kaspaStandard-0");

// The line under the balance (iOS fundsHint).
assert.equal(importFundsHint({ sompi: 5, hasHistory: false, passphrase: "" }).tone, "funds");
assert.match(importFundsHint({ sompi: 0, hasHistory: true, passphrase: "x" }).text, /has history, so this looks like the right account/);
assert.deepEqual(importFundsHint({ sompi: 0, hasHistory: false, passphrase: "" }), { tone: "muted", text: "No funds or history on this address." });
assert.equal(importFundsHint({ sompi: 0, hasHistory: false, passphrase: "x" }).tone, "warn");

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
