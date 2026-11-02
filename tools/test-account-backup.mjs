// node tools/test-account-backup.mjs - who owes a backup, when Backup Hygiene comes due, the next free
// account name and the checks the backup steps run (ui/account-backup-status.js; iOS d063b897 /
// KaPay 99ab88a AccountBackupStatus, AccountBackupView, nextDefaultAccountName). No real seed anywhere:
// the "words" below are placeholders.
import assert from "node:assert/strict";
import {
  BACKUP_PENDING_KEY, BACKUP_CONFIRMED_KEY, BACKUP_WORDS_TO_CHECK, HYGIENE_WORDS_TO_CHECK,
  addCalendarMonths, createAccountBackupStatus, nextDefaultAccountName, accountHasFunds, backupStepsFor,
  wordPageCount, wordPageRange, randomWordPositions, backupCheckPositions, normalizedWord,
  wrongWordPositions, passphraseMatches,
} from "../ui/account-backup-status.js";

let pass = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const MAIN = "kaspa:qqexampleaccount";
const TEST = "kaspatest:qqexampleaccount";
const OTHER = "kaspa:qqsomeoneelse";

function memoryStorage() {
  const map = new Map();
  return { getItem: (key) => (map.has(key) ? map.get(key) : null), setItem: (key, value) => map.set(key, String(value)), removeItem: (key) => map.delete(key), map };
}
function makeStatus(storage = memoryStorage()) {
  const variants = (address) => [address.replace(/^kaspa(test)?:/, "kaspa:"), address.replace(/^kaspa(test)?:/, "kaspatest:")];
  return { storage, status: createAccountBackupStatus({ storage, variants }) };
}

test("an account from before this, or imported, is never owed a backup and has no timer", () => {
  const { status } = makeStatus();
  assert.equal(status.isPending(MAIN), false);
  assert.equal(status.isHygieneDue(MAIN, new Date(2099, 0, 1)), false);
  assert.equal(status.isPending(""), false);
  assert.equal(status.isHygieneDue(null), false);
});

test("a created account is owed one on both networks, and only that account", () => {
  const { status } = makeStatus();
  status.markPending(MAIN);
  assert.equal(status.isPending(MAIN), true);
  assert.equal(status.isPending(TEST), true, "a switch to testnet doesn't lose the card");
  assert.equal(status.isPending(OTHER), false);
});

test("re-importing the words clears what was owed, without starting a timer", () => {
  const { status } = makeStatus();
  status.markPending(MAIN);
  status.markDone(TEST);
  assert.equal(status.isPending(MAIN), false);
  assert.equal(status.isHygieneDue(MAIN, new Date(2099, 0, 1)), false);
});

test("finishing the steps ends what is owed and Backup Hygiene comes due six months on", () => {
  const { status } = makeStatus();
  status.markPending(MAIN);
  const finished = new Date(2026, 4, 10, 12);
  status.markConfirmed(MAIN, finished);
  assert.equal(status.isPending(MAIN), false);
  assert.equal(status.isHygieneDue(MAIN, new Date(2026, 10, 10, 11, 59)), false, "a minute early");
  assert.equal(status.isHygieneDue(MAIN, new Date(2026, 10, 10, 12)), true);
  assert.equal(status.isHygieneDue(TEST, new Date(2026, 10, 10, 12)), true, "on the other network too");
});

test("checking the words again starts the six months over", () => {
  const { status } = makeStatus();
  status.markConfirmed(MAIN, new Date(2026, 0, 15));
  assert.equal(status.isHygieneDue(MAIN, new Date(2026, 6, 15)), true);
  status.markConfirmed(MAIN, new Date(2026, 6, 15));
  assert.equal(status.isHygieneDue(MAIN, new Date(2026, 6, 16)), false);
  assert.equal(status.isHygieneDue(MAIN, new Date(2027, 0, 15)), true);
});

test("an account owed the backup steps isn't asked for Backup Hygiene as well", () => {
  const { status } = makeStatus();
  status.markConfirmed(MAIN, new Date(2020, 0, 1));
  status.markPending(MAIN);
  assert.equal(status.isHygieneDue(MAIN, new Date(2026, 0, 1)), false);
});

test("six months is calendar months: the end of August lands on the end of February", () => {
  const lastOfFeb = addCalendarMonths(new Date(2026, 7, 31, 9), 6);
  assert.deepEqual([lastOfFeb.getFullYear(), lastOfFeb.getMonth(), lastOfFeb.getDate(), lastOfFeb.getHours()], [2027, 1, 28, 9]);
  const leap = addCalendarMonths(new Date(2027, 7, 31), 6);
  assert.deepEqual([leap.getMonth(), leap.getDate()], [1, 29]);
  const plain = addCalendarMonths(new Date(2026, 0, 15), 6);
  assert.deepEqual([plain.getMonth(), plain.getDate()], [6, 15]);
});

test("forgetting an account clears both its entries on both networks, and only its own", () => {
  const { status, storage } = makeStatus();
  status.markPending(MAIN);
  status.markConfirmed(OTHER, new Date(2026, 0, 1));
  status.forget(TEST);
  assert.equal(status.isPending(MAIN), false);
  assert.equal(storage.getItem(BACKUP_PENDING_KEY).includes("qqexampleaccount"), false);
  status.markConfirmed(MAIN, new Date(2026, 0, 1));
  status.forget(MAIN);
  assert.equal(storage.getItem(BACKUP_CONFIRMED_KEY).includes("qqexampleaccount"), false);
  assert.equal(storage.getItem(BACKUP_CONFIRMED_KEY).includes("qqsomeoneelse"), true);
});

test("moving to another chatting address carries what is owed and the timer", () => {
  const { status } = makeStatus();
  const moved = "kaspa:qqnewchatting";
  status.markPending(MAIN);
  status.carry(MAIN, moved);
  assert.equal(status.isPending(MAIN), false);
  assert.equal(status.isPending(moved), true);
  status.markConfirmed(moved, new Date(2026, 0, 1));
  const again = "kaspa:qqthirdchatting";
  status.carry(moved, again);
  assert.equal(status.isHygieneDue(moved, new Date(2027, 0, 1)), false);
  assert.equal(status.isHygieneDue(again, new Date(2027, 0, 1)), true);
});

test("damaged stores read as nothing owed", () => {
  const storage = memoryStorage();
  storage.setItem(BACKUP_PENDING_KEY, "{not json");
  storage.setItem(BACKUP_CONFIRMED_KEY, "[1,2]");
  const { status } = makeStatus(storage);
  assert.equal(status.isPending(MAIN), false);
  assert.equal(status.isHygieneDue(MAIN), false);
  storage.setItem(BACKUP_CONFIRMED_KEY, JSON.stringify({ [MAIN]: "soon" }));
  assert.equal(status.isHygieneDue(MAIN), false);
});

test("the next free name: My Account, My Account 2 and on, skipping names in use", () => {
  assert.equal(nextDefaultAccountName([]), "My Account");
  assert.equal(nextDefaultAccountName(["Savings"]), "My Account");
  assert.equal(nextDefaultAccountName(["My Account"]), "My Account 2");
  assert.equal(nextDefaultAccountName(["  my account ", "MY ACCOUNT 2"]), "My Account 3");
  assert.equal(nextDefaultAccountName(["My Account", "My Account 3"]), "My Account 2", "a gap is reused");
});

test("funds: the total when known, else the chatting balance", () => {
  assert.equal(accountHasFunds(null, null), false);
  assert.equal(accountHasFunds(0n, 0n), false);
  assert.equal(accountHasFunds(1n, null), true);
  assert.equal(accountHasFunds(0n, 1n), true);
  assert.equal(accountHasFunds(null, 5n), true);
});

test("the passphrase's steps only for an account that has one", () => {
  assert.deepEqual(backupStepsFor(false), ["why", "prepare", "words", "wordCheck", "tips"]);
  assert.deepEqual(backupStepsFor(true), ["why", "prepare", "words", "wordCheck", "passphrase", "passphraseCheck", "tips"]);
});

test("the words go six to a page", () => {
  assert.equal(wordPageCount(24), 4);
  assert.equal(wordPageCount(12), 2);
  assert.equal(wordPageCount(13), 3);
  assert.equal(wordPageCount(0), 1);
  assert.deepEqual(wordPageRange(0, 24), [0, 6]);
  assert.deepEqual(wordPageRange(3, 24), [18, 24]);
  assert.deepEqual(wordPageRange(2, 13), [12, 13]);
});

test("the words asked are different ones, within the phrase", () => {
  for (let run = 0; run < 200; run += 1) {
    const hygiene = randomWordPositions(24, HYGIENE_WORDS_TO_CHECK);
    assert.equal(new Set(hygiene).size, HYGIENE_WORDS_TO_CHECK);
    assert.ok(hygiene.every((position) => Number.isInteger(position) && position >= 0 && position < 24));
  }
});

test("Backup Hygiene asks in random order, the backup steps in phrase order", () => {
  const first = (limit) => limit - 1; // swaps each position with itself: the list as it is
  assert.deepEqual(randomWordPositions(6, 3, first), [0, 1, 2]);
  const swapsWithFirst = () => 0;
  assert.deepEqual(randomWordPositions(3, 3, swapsWithFirst), [1, 2, 0]);
  let outOfOrder = 0;
  for (let run = 0; run < 50; run += 1) {
    const asked = randomWordPositions(24, HYGIENE_WORDS_TO_CHECK);
    if (asked.join() !== [...asked].sort((a, b) => a - b).join()) outOfOrder += 1;
  }
  assert.ok(outOfOrder > 0);
  for (let run = 0; run < 50; run += 1) {
    const asked = backupCheckPositions(24);
    assert.equal(asked.length, BACKUP_WORDS_TO_CHECK);
    assert.deepEqual(asked, [...asked].sort((a, b) => a - b));
  }
});

test("a word check ignores case and spaces, and names the ones that are wrong", () => {
  const words = ["alpha", "bravo", "charlie", "delta"];
  assert.equal(normalizedWord("  BraVo "), "bravo");
  assert.deepEqual(wrongWordPositions(words, [1, 3], { 1: " BRAVO", 3: "delta " }), []);
  assert.deepEqual(wrongWordPositions(words, [1, 3], { 1: "bravo", 3: "echo" }), [3]);
  assert.deepEqual(wrongWordPositions(words, [0, 2], {}), [0, 2], "an empty answer is wrong");
});

test("a passphrase matches exactly, in the form it was saved", () => {
  assert.equal(passphraseMatches("Apple Pie", "Apple Pie"), true);
  assert.equal(passphraseMatches("apple pie", "Apple Pie"), false, "capitals count");
  assert.equal(passphraseMatches("Apple Pie ", "Apple Pie"), false, "spaces count");
  const typed = "café";
  const stored = typed.normalize("NFKD");
  assert.equal(passphraseMatches(typed, stored, "nfkd"), true, "the same passphrase as a saved NFKD one");
  assert.equal(passphraseMatches(typed, stored, "raw"), false, "a raw one is compared as it stands");
  assert.equal(passphraseMatches(typed, typed, "raw"), true);
});

for (const [name, fn] of tests) {
  try { await fn(); pass += 1; }
  catch (error) { console.error(`FAIL ${name}\n  ${error?.message || error}`); process.exitCode = 1; }
}
console.log(`account-backup: ${pass}/${tests.length} passed`);
