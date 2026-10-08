// node tools/test-key-vault.mjs - the saved-account key vault (ui/key-vault.js).
// Node's WebCrypto stands in for the browser's; localStorage / sessionStorage are in-memory maps.
import assert from "node:assert/strict";
import { webcrypto, createHash } from "node:crypto";
import {
  configureKeyVault, hasAppPassword, isVaultEnabled, isVaultUnlocked, isAppLocked,
  unlockKeyVault, unlockKeyVaultFromSession, lockKeyVault, setAppPassword, removeAppPassword,
  resetForgottenAppPassword, readAccountRecords, writeAccountRecords, persistedWalletRecordForStorage,
  readLegacyWalletKey, clearLegacyWalletKey, appPasswordLockoutRemainingSeconds,
  writeKeyVaultHandoff, clearKeyVaultHandoff, keyVaultStorageChanged, onKeyVaultLockedByAnotherTab,
  APP_PASSWORD_KEY, APP_PASSWORD_PENDING_KEY, SAVED_ACCOUNTS_KEY, PERSISTED_WALLET_KEY,
  LEGACY_PERSISTED_WALLET_KEY, VAULT_LEGACY_WALLET_KEY, VAULT_SESSION_KEY, VAULT_HANDOFF_KEY,
  VAULT_HANDOFF_TTL_MS, VAULT_PBKDF2_ITERATIONS,
  readNextcloudAccount, writeNextcloudAccount, onKeyVaultStateChanged, NEXTCLOUD_STORAGE_KEY,
} from "../ui/key-vault.js";
// A second tab: the same module loaded again is a separate vault (its own memory and
// sessionStorage) on the same localStorage.
const tabB = await import("../ui/key-vault.js?tab=b");

if (!globalThis.crypto) globalThis.crypto = webcrypto;

class MemoryStorage {
  constructor() { this.map = new Map(); }
  getItem(key) { return this.map.has(key) ? this.map.get(key) : null; }
  setItem(key, value) { this.map.set(key, String(value)); }
  removeItem(key) { this.map.delete(key); }
  get length() { return this.map.size; }
  key(index) { return [...this.map.keys()][index] ?? null; }
  dump() { return [...this.map.values()].join("\n"); }
}

const TEST_ITERATIONS = 2_000; // new records in most tests; one test runs the real 600k
let local;
let session;
let sessionB;
let clock = Date.now();
const canonicalize = (a) => String(a || "").trim().toLowerCase().replace(/^kaspatest:/, "kaspa:");
function fresh({ iterations = TEST_ITERATIONS } = {}) {
  local = new MemoryStorage();
  session = new MemoryStorage();
  sessionB = new MemoryStorage();
  clock = Date.now();
  lockKeyVault();
  configureKeyVault({ storage: local, session, iterations, canonicalize, now: () => clock });
  tabB.lockKeyVault();
  tabB.configureKeyVault({ storage: local, session: sessionB, iterations, canonicalize, now: () => clock });
}
/** A new page load in tab A: memory gone, the same storage. With `handoff` it is one of KaChat's
 *  own reloads (the hand-off is written just before); without, a manual refresh / restored tab. */
function reload({ handoff = false } = {}) {
  const saved = handoff && writeKeyVaultHandoff() ? session.getItem(VAULT_HANDOFF_KEY) : null;
  lockKeyVault();
  if (saved) session.setItem(VAULT_HANDOFF_KEY, saved);
}
/** The data key tab A holds, read through a hand-off (and the hand-off removed again). */
function currentDataKeyHex() {
  assert.equal(writeKeyVaultHandoff(), true);
  const key = JSON.parse(session.getItem(VAULT_HANDOFF_KEY)).key;
  clearKeyVaultHandoff();
  return key;
}

const MNEMONIC_A = "abandon ability able about above absent absorb abstract absurd abuse access accident";
const MNEMONIC_B = "zoo zone zero youth young yellow year wrong write worth world work";
const KEY_A = "11".repeat(32);
const KEY_B = "22".repeat(32);
const accountA = { version: 1, address: "kaspa:qpaaaaaaaaaaaa", privateKeyHex: KEY_A, mnemonic: MNEMONIC_A, passphrase: "tre-zor", name: "Alice", wordCount: 12, createdAt: "2026-01-01" };
const accountB = { version: 1, address: "kaspa:qpbbbbbbbbbbbb", privateKeyHex: KEY_B, mnemonic: MNEMONIC_B, passphrase: "", name: "Bob", wordCount: 12, createdAt: "2026-01-02" };

function storedText() { return local.dump() + session.dump() + sessionB.dump(); }
function assertNoPlaintextSecrets() {
  const text = local.dump();
  for (const secret of [KEY_A, KEY_B, MNEMONIC_A, MNEMONIC_B, "tre-zor"]) assert.ok(!text.includes(secret), `plaintext secret at rest: ${secret.slice(0, 12)}…`);
}
function byAddress(address) { return readAccountRecords().find((entry) => entry.address === address); }

const tests = [];
function test(name, fn) { tests.push([name, fn]); }

test("no password: plaintext, unchanged behaviour", async () => {
  fresh();
  assert.equal(hasAppPassword(), false);
  assert.equal(isAppLocked(), false);
  writeAccountRecords([accountA]);
  assert.ok(local.getItem(SAVED_ACCOUNTS_KEY).includes(KEY_A));
  assert.equal(byAddress(accountA.address).mnemonic, MNEMONIC_A);
  assert.equal(persistedWalletRecordForStorage({ address: "x", privateKeyHex: KEY_A }).privateKeyHex, KEY_A);
});

test("wrap / unwrap round trip at 600k iterations, record format", async () => {
  fresh({ iterations: VAULT_PBKDF2_ITERATIONS });
  writeAccountRecords([accountA]);
  await setAppPassword("correct horse");
  const record = JSON.parse(local.getItem(APP_PASSWORD_KEY));
  assert.equal(record.version, 2);
  assert.equal(record.kdf, "PBKDF2-SHA256");
  assert.ok(record.iterations >= 600_000);
  assert.match(record.salt, /^[0-9a-f]{32}$/);
  assert.match(record.hash, /^[0-9a-f]{64}$/);
  assert.match(record.wrappedKey.iv, /^[0-9a-f]{24}$/);
  assert.equal(record.wrappedKey.ct.length, (32 + 16) * 2);
  assertNoPlaintextSecrets();
  reload();
  assert.equal(isAppLocked(), true);
  assert.equal(byAddress(accountA.address).locked, true);
  assert.equal(byAddress(accountA.address).privateKeyHex, undefined);
  assert.equal(byAddress(accountA.address).name, "Alice", "public data stays readable while locked");
  assert.equal(await unlockKeyVault("correct horse"), true);
  const opened = byAddress(accountA.address);
  assert.equal(opened.privateKeyHex, KEY_A);
  assert.equal(opened.mnemonic, MNEMONIC_A);
  assert.equal(opened.passphrase, "tre-zor");
});

test("sealed records are standard AES-256-GCM (WebCrypto opens them)", async () => {
  fresh();
  writeAccountRecords([accountA]);
  await setAppPassword("correct horse");
  const dataKey = Buffer.from(currentDataKeyHex(), "hex");
  const entry = JSON.parse(local.getItem(SAVED_ACCOUNTS_KEY))[0];
  const key = await crypto.subtle.importKey("raw", dataKey, "AES-GCM", false, ["decrypt"]);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: Buffer.from(entry.sealed.iv, "hex"), additionalData: new TextEncoder().encode(`kachat-account-secrets-v1|${entry.address}`) },
    key, Buffer.from(entry.sealed.ct, "hex"));
  assert.equal(JSON.parse(new TextDecoder().decode(plain)).mnemonic, MNEMONIC_A);
});

test("fresh IV on every write", async () => {
  fresh();
  writeAccountRecords([accountA]);
  await setAppPassword("correct horse");
  const first = JSON.parse(local.getItem(SAVED_ACCOUNTS_KEY))[0].sealed;
  writeAccountRecords(readAccountRecords());
  const second = JSON.parse(local.getItem(SAVED_ACCOUNTS_KEY))[0].sealed;
  assert.notEqual(first.iv, second.iv);
  assert.notEqual(first.ct, second.ct);
});

test("wrong password fails, counts toward the lockout, right one still works after", async () => {
  fresh();
  writeAccountRecords([accountA]);
  await setAppPassword("correct horse");
  reload();
  for (let i = 0; i < 4; i += 1) assert.equal(await unlockKeyVault(`wrong ${i}`), false);
  assert.equal(appPasswordLockoutRemainingSeconds(), null, "four misses are free");
  assert.equal(isVaultUnlocked(), false);
  assert.equal(await unlockKeyVault("wrong 5"), false);
  assert.ok(appPasswordLockoutRemainingSeconds() >= 29, "the fifth miss locks for 30s");
  assert.equal(await unlockKeyVault("correct horse"), false, "locked out even with the right password");
  local.removeItem("kachat-app-password-locked-until");
  assert.equal(await unlockKeyVault("correct horse"), true);
  assert.equal(local.getItem("kachat-app-password-failed-attempts"), null, "success clears the counter");
});

test("minimum length 8 for new passwords", async () => {
  fresh();
  await assert.rejects(() => setAppPassword("short7c"), /at least 8/);
  assert.equal(hasAppPassword(), false);
});

test("locked: writes keep sealed blobs and refuse plaintext secrets", async () => {
  fresh();
  writeAccountRecords([accountA, accountB]);
  await setAppPassword("correct horse");
  reload();
  // Rename and remove from the sign-in screen while locked.
  const list = readAccountRecords().filter((entry) => entry.address !== accountB.address).map((entry) => ({ ...entry, name: "Alice 2" }));
  writeAccountRecords(list);
  assert.throws(() => writeAccountRecords([...readAccountRecords(), { ...accountB }]), /locked/i);
  assertNoPlaintextSecrets();
  assert.equal(await unlockKeyVault("correct horse"), true);
  assert.equal(readAccountRecords().length, 1);
  assert.equal(byAddress(accountA.address).name, "Alice 2");
  assert.equal(byAddress(accountA.address).mnemonic, MNEMONIC_A);
});

test("DSK-023: the data key is never in sessionStorage while the page runs", async () => {
  fresh();
  writeAccountRecords([accountA]);
  await setAppPassword("correct horse");
  assert.equal(isVaultUnlocked(), true);
  assert.equal(session.length, 0, "nothing in sessionStorage after setting a password");
  reload();
  assert.equal(await unlockKeyVault("correct horse"), true);
  readAccountRecords();
  assert.equal(session.length, 0, "nothing in sessionStorage after unlocking");
});

test("DSK-023: KaChat's own reload is handed the key once, within 15 s", async () => {
  fresh();
  writeAccountRecords([accountA]);
  await setAppPassword("correct horse");
  const before = clock;
  reload({ handoff: true });
  const handoff = JSON.parse(session.getItem(VAULT_HANDOFF_KEY));
  assert.match(handoff.key, /^[0-9a-f]{64}$/);
  assert.equal(handoff.expiresAt, before + VAULT_HANDOFF_TTL_MS);
  assert.equal(VAULT_HANDOFF_TTL_MS, 15_000);
  assert.equal(isAppLocked(), true);
  clock += 14_000;
  assert.equal(unlockKeyVaultFromSession(), true, "within 15 s: no password asked");
  assert.equal(session.getItem(VAULT_HANDOFF_KEY), null, "deleted on the first read");
  assert.equal(session.length, 0);
  assert.equal(byAddress(accountA.address).privateKeyHex, KEY_A);
  // A second page load (the user presses F5, or the tab is duplicated / restored) finds nothing.
  reload();
  assert.equal(unlockKeyVaultFromSession(), false);
  assert.equal(isAppLocked(), true, "a manual refresh asks for the password");
  // Re-using a copy of the consumed hand-off (e.g. a duplicate taken earlier) after it expired.
  session.setItem(VAULT_HANDOFF_KEY, JSON.stringify(handoff));
  clock = before + VAULT_HANDOFF_TTL_MS + 1;
  assert.equal(unlockKeyVaultFromSession(), false);
});

test("DSK-023: an expired, malformed or foreign hand-off is refused and deleted", async () => {
  fresh();
  writeAccountRecords([accountA]);
  await setAppPassword("correct horse");
  const key = currentDataKeyHex();
  const attempts = [
    ["expired", JSON.stringify({ key, expiresAt: clock - 1 })],
    ["expiring too far ahead", JSON.stringify({ key, expiresAt: clock + VAULT_HANDOFF_TTL_MS + 60_000 })],
    ["no expiry", JSON.stringify({ key })],
    ["bare hex (the pre-DSK-023 format)", key],
    ["short key", JSON.stringify({ key: key.slice(2), expiresAt: clock + 5_000 })],
    ["not hex", JSON.stringify({ key: "zz".repeat(32), expiresAt: clock + 5_000 })],
    ["not JSON", "{"],
    ["another vault's key", JSON.stringify({ key: "ab".repeat(32), expiresAt: clock + 5_000 })],
  ];
  for (const [label, value] of attempts) {
    reload();
    session.setItem(VAULT_HANDOFF_KEY, value);
    assert.equal(unlockKeyVaultFromSession(), false, label);
    assert.equal(session.getItem(VAULT_HANDOFF_KEY), null, `${label}: deleted`);
    assert.equal(isAppLocked(), true, label);
  }
  // The pre-DSK-023 per-tab copy is deleted and never honoured.
  reload();
  session.setItem(VAULT_SESSION_KEY, key);
  assert.equal(unlockKeyVaultFromSession(), false);
  assert.equal(session.getItem(VAULT_SESSION_KEY), null);
  // No hand-off at all: it asks.
  reload();
  assert.equal(unlockKeyVaultFromSession(), false);
  assert.equal(isAppLocked(), true);
  // Locked, there is nothing to hand off.
  assert.equal(writeKeyVaultHandoff(), false);
  assert.equal(session.length, 0);
});

test("migration from plaintext: pre-vault SHA-256 password record, upgraded at first unlock", async () => {
  fresh();
  // What the previous release left behind: plaintext registry + active wallet + legacy key + v1 hash.
  writeAccountRecords([accountA]);
  local.setItem(PERSISTED_WALLET_KEY, JSON.stringify({ version: 3, address: "kaspatest:qpbbbbbbbbbbbb", privateKeyHex: KEY_B, mnemonic: MNEMONIC_B, passphrase: "", savedAt: "2026-02-02" }));
  const legacyKey = "33".repeat(32);
  local.setItem(LEGACY_PERSISTED_WALLET_KEY, legacyKey);
  const salt = "0123456789abcdef0123456789abcdef";
  local.setItem(APP_PASSWORD_KEY, JSON.stringify({ salt, hash: createHash("sha256").update(`${salt}:pw4u`).digest("hex") }));
  assert.equal(hasAppPassword(), true);
  assert.equal(isVaultEnabled(), false);
  assert.equal(isAppLocked(), true, "an existing password gates startup before the upgrade too");
  assert.equal(await unlockKeyVault("nope"), false);
  assert.equal(await unlockKeyVault("pw4u"), true, "the old (short) password keeps working");
  const record = JSON.parse(local.getItem(APP_PASSWORD_KEY));
  assert.equal(record.version, 2, "the SHA-256 record was replaced");
  assert.ok(record.wrappedKey);
  assertNoPlaintextSecrets();
  assert.ok(!local.dump().includes(legacyKey));
  assert.equal(local.getItem(LEGACY_PERSISTED_WALLET_KEY), null);
  assert.ok(local.getItem(VAULT_LEGACY_WALLET_KEY));
  const wallet = JSON.parse(local.getItem(PERSISTED_WALLET_KEY));
  assert.equal(wallet.privateKeyHex, undefined);
  assert.equal(wallet.address, "kaspa:qpbbbbbbbbbbbb", "active-wallet address stored canonical");
  assert.equal(byAddress(accountA.address).mnemonic, MNEMONIC_A);
  assert.equal(byAddress("kaspa:qpbbbbbbbbbbbb").privateKeyHex, KEY_B, "the active-wallet account was carried into the vault");
  assert.equal(readLegacyWalletKey(), legacyKey);
  reload();
  assert.equal(await unlockKeyVault("pw4u"), true);
  assert.equal(byAddress(accountA.address).passphrase, "tre-zor");
});

test("plaintext written alongside a vault record is sealed at the next unlock", async () => {
  fresh();
  writeAccountRecords([accountA]);
  await setAppPassword("correct horse");
  const sealed = local.getItem(SAVED_ACCOUNTS_KEY);
  // e.g. an older tab still running the previous release wrote plaintext back
  local.setItem(SAVED_ACCOUNTS_KEY, JSON.stringify([...JSON.parse(sealed), accountB]));
  local.setItem(PERSISTED_WALLET_KEY, JSON.stringify({ address: accountB.address, privateKeyHex: KEY_B, mnemonic: MNEMONIC_B }));
  reload();
  assert.equal(await unlockKeyVault("correct horse"), true);
  assertNoPlaintextSecrets();
  assert.equal(byAddress(accountB.address).mnemonic, MNEMONIC_B);
});

test("password change re-encrypts everything under a new data key", async () => {
  fresh();
  writeAccountRecords([accountA, accountB]);
  await setAppPassword("correct horse");
  const oldRecord = JSON.parse(local.getItem(APP_PASSWORD_KEY));
  const oldKey = currentDataKeyHex();
  const oldStore = local.getItem(SAVED_ACCOUNTS_KEY);
  await setAppPassword("battery staple");
  const newRecord = JSON.parse(local.getItem(APP_PASSWORD_KEY));
  assert.notEqual(newRecord.salt, oldRecord.salt);
  assert.notEqual(currentDataKeyHex(), oldKey, "fresh data key");
  assert.notEqual(local.getItem(SAVED_ACCOUNTS_KEY), oldStore);
  assert.equal(local.getItem(APP_PASSWORD_PENDING_KEY), null);
  assertNoPlaintextSecrets();
  reload();
  assert.equal(await unlockKeyVault("correct horse"), false, "old password no longer opens it");
  assert.equal(await unlockKeyVault("battery staple"), true);
  assert.equal(byAddress(accountB.address).mnemonic, MNEMONIC_B);
  // A hand-off with the old key does not open the new vault.
  reload();
  session.setItem(VAULT_HANDOFF_KEY, JSON.stringify({ key: oldKey, expiresAt: clock + 5_000 }));
  assert.equal(unlockKeyVaultFromSession(), false);
});

test("interrupted password change: the new password finishes it, the old one cannot strand it", async () => {
  fresh();
  writeAccountRecords([accountA]);
  await setAppPassword("correct horse");
  const before = { record: local.getItem(APP_PASSWORD_KEY), store: local.getItem(SAVED_ACCOUNTS_KEY) };
  await setAppPassword("battery staple");
  const after = { record: local.getItem(APP_PASSWORD_KEY), store: local.getItem(SAVED_ACCOUNTS_KEY) };
  // Crash between step 2 (store re-sealed) and step 3 (record replaced).
  local.setItem(APP_PASSWORD_KEY, before.record);
  local.setItem(APP_PASSWORD_PENDING_KEY, after.record);
  local.setItem(SAVED_ACCOUNTS_KEY, after.store);
  reload();
  assert.equal(await unlockKeyVault("correct horse"), false, "old key does not open the re-sealed store");
  assert.equal(await unlockKeyVault("battery staple"), true);
  assert.equal(local.getItem(APP_PASSWORD_KEY), after.record, "pending promoted");
  assert.equal(local.getItem(APP_PASSWORD_PENDING_KEY), null);
  assert.equal(byAddress(accountA.address).mnemonic, MNEMONIC_A);
  // Crash between step 1 (pending written) and step 2: the store is still under the old record.
  fresh();
  writeAccountRecords([accountA]);
  await setAppPassword("correct horse");
  const oldRecord = local.getItem(APP_PASSWORD_KEY);
  const oldStore = local.getItem(SAVED_ACCOUNTS_KEY);
  await setAppPassword("battery staple");
  local.setItem(APP_PASSWORD_PENDING_KEY, local.getItem(APP_PASSWORD_KEY));
  local.setItem(APP_PASSWORD_KEY, oldRecord);
  local.setItem(SAVED_ACCOUNTS_KEY, oldStore);
  reload();
  assert.equal(await unlockKeyVault("battery staple"), false, "pending must not take over a store it cannot open");
  assert.equal(await unlockKeyVault("correct horse"), true);
  assert.equal(local.getItem(APP_PASSWORD_PENDING_KEY), null);
  assert.equal(byAddress(accountA.address).privateKeyHex, KEY_A);
});

test("password removal decrypts back to plaintext, then deletes the record", async () => {
  fresh();
  writeAccountRecords([accountA, accountB]);
  local.setItem(LEGACY_PERSISTED_WALLET_KEY, "44".repeat(32));
  await setAppPassword("correct horse");
  reload();
  assert.throws(() => removeAppPassword(), /password first/);
  assert.equal(await unlockKeyVault("correct horse"), true);
  removeAppPassword();
  assert.equal(hasAppPassword(), false);
  assert.equal(isVaultEnabled(), false);
  assert.equal(isAppLocked(), false);
  assert.equal(session.length, 0);
  const stored = JSON.parse(local.getItem(SAVED_ACCOUNTS_KEY));
  assert.equal(stored[0].privateKeyHex, KEY_A);
  assert.equal(stored[1].mnemonic, MNEMONIC_B);
  assert.equal(stored[0].sealed, undefined);
  assert.equal(local.getItem(LEGACY_PERSISTED_WALLET_KEY), "44".repeat(32));
  assert.equal(local.getItem(VAULT_LEGACY_WALLET_KEY), null);
});

test("tampering is detected by GCM (ciphertext, IV, swapped records, wrapped key)", async () => {
  fresh();
  writeAccountRecords([accountA, accountB]);
  await setAppPassword("correct horse");
  const good = local.getItem(SAVED_ACCOUNTS_KEY);
  const flip = (hex) => (hex[0] === "0" ? "1" : "0") + hex.slice(1);

  const tamperedCt = JSON.parse(good);
  tamperedCt[0].sealed.ct = flip(tamperedCt[0].sealed.ct);
  local.setItem(SAVED_ACCOUNTS_KEY, JSON.stringify(tamperedCt));
  reload({ handoff: true });
  assert.equal(unlockKeyVaultFromSession(), true);
  assert.equal(byAddress(accountA.address).locked, true, "flipped ciphertext bit: refused");
  assert.equal(byAddress(accountA.address).privateKeyHex, undefined);
  assert.equal(byAddress(accountB.address).privateKeyHex, KEY_B);

  const tamperedIv = JSON.parse(good);
  tamperedIv[1].sealed.iv = flip(tamperedIv[1].sealed.iv);
  local.setItem(SAVED_ACCOUNTS_KEY, JSON.stringify(tamperedIv));
  reload({ handoff: true });
  unlockKeyVaultFromSession();
  assert.equal(byAddress(accountB.address).locked, true, "flipped IV: refused");

  const swapped = JSON.parse(good);
  [swapped[0].sealed, swapped[1].sealed] = [swapped[1].sealed, swapped[0].sealed];
  local.setItem(SAVED_ACCOUNTS_KEY, JSON.stringify(swapped));
  reload({ handoff: true });
  unlockKeyVaultFromSession();
  assert.equal(byAddress(accountA.address).locked, true, "a blob moved to another account: refused (AAD)");
  assert.equal(byAddress(accountB.address).locked, true);
  // A refused blob is kept as is, never dropped, when the list is written back.
  writeAccountRecords(readAccountRecords());
  assert.deepEqual(JSON.parse(local.getItem(SAVED_ACCOUNTS_KEY))[0].sealed, swapped[0].sealed);

  local.setItem(SAVED_ACCOUNTS_KEY, good);
  const record = JSON.parse(local.getItem(APP_PASSWORD_KEY));
  record.wrappedKey.ct = flip(record.wrappedKey.ct);
  local.setItem(APP_PASSWORD_KEY, JSON.stringify(record));
  reload();
  assert.equal(await unlockKeyVault("correct horse"), false, "tampered wrapped key: refused");
  assert.equal(isVaultUnlocked(), false);
});

test("password change refuses when a record does not decrypt (no seed is ever stranded)", async () => {
  fresh();
  writeAccountRecords([accountA, accountB]);
  await setAppPassword("correct horse");
  const store = JSON.parse(local.getItem(SAVED_ACCOUNTS_KEY));
  store[1].sealed.ct = (store[1].sealed.ct[0] === "0" ? "1" : "0") + store[1].sealed.ct.slice(1);
  local.setItem(SAVED_ACCOUNTS_KEY, JSON.stringify(store));
  const recordBefore = local.getItem(APP_PASSWORD_KEY);
  await assert.rejects(() => setAppPassword("battery staple"), /could not be decrypted/);
  assert.equal(local.getItem(APP_PASSWORD_KEY), recordBefore);
  assert.equal(local.getItem(APP_PASSWORD_PENDING_KEY), null);
  assert.throws(() => removeAppPassword(), /could not be decrypted/);
  assert.equal(local.getItem(APP_PASSWORD_KEY), recordBefore);
});

test("forgotten password reset removes the sealed keys and the password, keeps nothing secret", async () => {
  fresh();
  writeAccountRecords([accountA, accountB]);
  await setAppPassword("correct horse");
  reload();
  assert.equal(resetForgottenAppPassword(), 2);
  assert.equal(hasAppPassword(), false);
  assert.equal(readAccountRecords().length, 0);
  assert.equal(isAppLocked(), false);
  assert.ok(!storedText().includes(KEY_A));
});

// --- two tabs on one localStorage (DSK-022) -------------------------------------------------------
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("DSK-022 two tabs: a password change in tab B refuses tab A's writes, nothing is corrupted", async () => {
  fresh();
  const legacyKey = "55".repeat(32);
  writeAccountRecords([accountA, accountB]);
  local.setItem(LEGACY_PERSISTED_WALLET_KEY, legacyKey);
  await setAppPassword("correct horse");                         // tab A: unlocked
  assert.equal(await tabB.unlockKeyVault("correct horse"), true); // tab B: unlocked, same key
  let toldA = 0;
  const off = onKeyVaultLockedByAnotherTab(() => { toldA += 1; });
  await tabB.setAppPassword("battery staple");                   // B re-seals under a new key
  const after = { store: local.getItem(SAVED_ACCOUNTS_KEY), record: local.getItem(APP_PASSWORD_KEY), legacy: local.getItem(VAULT_LEGACY_WALLET_KEY) };
  // Tab A has not seen the storage event yet. Its hide/close save of the active account (with the
  // blank mnemonic / passphrase it would read back for a locked entry) is refused, and A locks.
  assert.throws(() => writeAccountRecords([{ ...accountA, mnemonic: "", passphrase: "" }, accountB]), /locked in another tab/);
  assert.equal(isVaultUnlocked(), false);
  assert.equal(isAppLocked(), true);
  await tick();
  assert.equal(toldA, 1, "the app is told, so it can show the unlock prompt");
  off();
  // Locked now: no secrets can be written, nothing can be handed off, the sealed legacy key it
  // cannot open is not deleted.
  assert.throws(() => writeAccountRecords([accountA]), /locked/i);
  assert.equal(writeKeyVaultHandoff(), false);
  assert.equal(clearLegacyWalletKey(), false);
  assert.equal(readLegacyWalletKey(), "");
  assert.ok(readAccountRecords().every((entry) => entry.locked && !entry.privateKeyHex && !entry.mnemonic));
  assert.deepEqual(
    { store: local.getItem(SAVED_ACCOUNTS_KEY), record: local.getItem(APP_PASSWORD_KEY), legacy: local.getItem(VAULT_LEGACY_WALLET_KEY) },
    after, "tab A changed nothing");
  assertNoPlaintextSecrets();
  // The old password no longer works anywhere; the new one opens everything, seeds intact.
  reload();
  assert.equal(await unlockKeyVault("correct horse"), false);
  assert.equal(await unlockKeyVault("battery staple"), true);
  assert.equal(byAddress(accountA.address).privateKeyHex, KEY_A);
  assert.equal(byAddress(accountA.address).mnemonic, MNEMONIC_A);
  assert.equal(byAddress(accountA.address).passphrase, "tre-zor");
  assert.equal(byAddress(accountB.address).mnemonic, MNEMONIC_B);
  assert.equal(readLegacyWalletKey(), legacyKey);
  // Both tabs on the same key again: what A writes, B reads.
  writeAccountRecords(readAccountRecords().map((entry) => ({ ...entry, name: `${entry.name}!` })));
  assert.equal(tabB.readAccountRecords().find((entry) => entry.address === accountA.address).mnemonic, MNEMONIC_A);
});

test("DSK-022 two tabs: the stale tab's next read already locks it (before any write)", async () => {
  fresh();
  writeAccountRecords([accountA]);
  await setAppPassword("correct horse");
  assert.equal(await tabB.unlockKeyVault("correct horse"), true);
  await tabB.setAppPassword("battery staple");
  assert.equal(byAddress(accountA.address).locked, true);
  assert.equal(isVaultUnlocked(), false, "the read found the key stale and dropped it");
  assert.equal(isAppLocked(), true);
});

test("DSK-022 two tabs: the storage event locks the other tab at once; it unlocks in place", async () => {
  fresh();
  writeAccountRecords([accountA]);
  await setAppPassword("correct horse");
  assert.equal(await tabB.unlockKeyVault("correct horse"), true);
  assert.equal(keyVaultStorageChanged("kachat-something-else"), false);
  assert.equal(keyVaultStorageChanged(SAVED_ACCOUNTS_KEY), false, "an account write elsewhere does not lock");
  assert.equal(isVaultUnlocked(), true);
  await tabB.setAppPassword("battery staple");
  assert.equal(keyVaultStorageChanged(APP_PASSWORD_PENDING_KEY), true, "locked by the record change");
  assert.equal(isVaultUnlocked(), false);
  assert.equal(isAppLocked(), true, "a password has to be entered");
  assert.equal(keyVaultStorageChanged(APP_PASSWORD_KEY), false, "already locked");
  assert.equal(await unlockKeyVault("battery staple"), true);
  assert.equal(byAddress(accountA.address).mnemonic, MNEMONIC_A);
  // localStorage.clear() in another tab arrives as key null.
  assert.equal(keyVaultStorageChanged(null), true);
  assert.equal(isVaultUnlocked(), false);
});

test("DSK-022 two tabs: removing the password in one tab while the other is unlocked", async () => {
  fresh();
  writeAccountRecords([accountA, accountB]);
  await setAppPassword("correct horse");
  assert.equal(await tabB.unlockKeyVault("correct horse"), true);
  tabB.removeAppPassword();
  const plainStore = local.getItem(SAVED_ACCOUNTS_KEY);
  // A has not seen the event: its write is refused and it drops the key; no password is left.
  assert.throws(() => writeAccountRecords([{ ...accountA, mnemonic: "", passphrase: "" }]), /locked in another tab/);
  assert.equal(local.getItem(SAVED_ACCOUNTS_KEY), plainStore, "nothing written");
  assert.equal(isVaultUnlocked(), false);
  assert.equal(hasAppPassword(), false);
  assert.equal(isAppLocked(), false, "no password to ask for");
  for (const entry of JSON.parse(plainStore)) assert.equal(entry.sealed, undefined, "no sealed records");
  assert.equal(byAddress(accountA.address).mnemonic, MNEMONIC_A);
  assert.equal(byAddress(accountB.address).privateKeyHex, KEY_B);
  writeAccountRecords(readAccountRecords()); // A carries on without a password
  assert.equal(byAddress(accountA.address).passphrase, "tre-zor");
  // The same through the storage event.
  fresh();
  writeAccountRecords([accountA]);
  await setAppPassword("correct horse");
  assert.equal(await tabB.unlockKeyVault("correct horse"), true);
  tabB.removeAppPassword();
  assert.equal(keyVaultStorageChanged(APP_PASSWORD_KEY), true);
  assert.equal(isAppLocked(), false);
  assert.equal(byAddress(accountA.address).privateKeyHex, KEY_A);
});

test("DSK-022 two tabs: a first password set elsewhere locks a signed-in tab, no plaintext written", async () => {
  fresh();
  writeAccountRecords([accountA]);
  await tabB.setAppPassword("correct horse");
  assert.equal(isAppLocked(), true);
  assert.throws(() => writeAccountRecords([accountA, accountB]), /locked/i);
  assertNoPlaintextSecrets();
  assert.equal(byAddress(accountA.address).locked, true);
});

test("DSK-022 two tabs: simultaneous password changes, one wins and its password opens everything", async () => {
  fresh();
  writeAccountRecords([accountA, accountB]);
  await setAppPassword("correct horse");
  assert.equal(await tabB.unlockKeyVault("correct horse"), true);
  const results = await Promise.allSettled([setAppPassword("password one"), tabB.setAppPassword("password two")]);
  const won = results.map((result) => result.status === "fulfilled");
  assert.equal(won.filter(Boolean).length, 1, "exactly one change goes through");
  const loser = results.find((result) => result.status === "rejected");
  assert.match(loser.reason.message, /locked in another tab/);
  const winner = won[0] ? "password one" : "password two";
  const loserPassword = won[0] ? "password two" : "password one";
  reload();
  tabB.lockKeyVault();
  assert.equal(await unlockKeyVault(loserPassword), false);
  assert.equal(await unlockKeyVault("correct horse"), false);
  assert.equal(await unlockKeyVault(winner), true);
  assert.equal(byAddress(accountA.address).mnemonic, MNEMONIC_A);
  assert.equal(byAddress(accountB.address).mnemonic, MNEMONIC_B);
});

test("DSK-022 two tabs: both upgrading one pre-vault record end on the same key", async () => {
  fresh();
  writeAccountRecords([accountA]);
  const salt = "0123456789abcdef0123456789abcdef";
  local.setItem(APP_PASSWORD_KEY, JSON.stringify({ salt, hash: createHash("sha256").update(`${salt}:pw4u`).digest("hex") }));
  const [a, b] = await Promise.all([unlockKeyVault("pw4u"), tabB.unlockKeyVault("pw4u")]);
  assert.equal(a, true);
  assert.equal(b, true);
  assert.equal(isVaultUnlocked(), true);
  assert.equal(tabB.isVaultUnlocked(), true);
  assertNoPlaintextSecrets();
  writeAccountRecords(readAccountRecords().map((entry) => ({ ...entry, name: "from A" })));
  const seenByB = tabB.readAccountRecords()[0];
  assert.equal(seenByB.name, "from A");
  assert.equal(seenByB.mnemonic, MNEMONIC_A, "B opens what A sealed: one data key");
});

// --- the Nextcloud app password (audit run 2: "still unencrypted even with an app password set") ---
const NC_SECRET = "ncapp-Xy7Q-secret-pw-9001";
const NC_SECRET_2 = "ncapp-other-wallet-pw-42";
const ncKeyA = `kachat-account-data-v1:${accountA.address}:${NEXTCLOUD_STORAGE_KEY}`;
const ncKeyB = `kachat-account-data-v1:${accountB.address}:${NEXTCLOUD_STORAGE_KEY}`;
const ncAccount = { server: "https://cloud.example", username: "alice", userId: "alice", appPassword: NC_SECRET, startFolder: null, backupFolder: "KaChat", autoBackup: true, lastAutoBackup: 0 };
const ncAccountB = { ...ncAccount, username: "bob", userId: "bob", appPassword: NC_SECRET_2 };
function rawNc(key = ncKeyA) { return JSON.parse(local.getItem(key) || "null"); }
function assertNoPlainNextcloud() {
  const text = local.dump() + session.dump() + sessionB.dump();
  for (const secret of [NC_SECRET, NC_SECRET_2]) assert.ok(!text.includes(secret), "plaintext Nextcloud app password at rest");
}
function nextcloudAadFor(key, record) { return "kachat-nextcloud-app-password-v1|" + JSON.stringify([key, record.server, record.username]); }

test("Nextcloud, no password: stored plaintext, unchanged", async () => {
  fresh();
  writeNextcloudAccount(ncKeyA, ncAccount);
  const raw = rawNc();
  assert.equal(raw.appPassword, NC_SECRET);
  assert.equal(raw.appPasswordSealed, undefined);
  assert.deepEqual(readNextcloudAccount(ncKeyA), ncAccount);
  assert.equal(readNextcloudAccount(`kachat-account-data-v1:kaspa:qpnone:${NEXTCLOUD_STORAGE_KEY}`), null);
  // Disconnect removes it.
  writeNextcloudAccount(ncKeyA, null);
  assert.equal(local.getItem(ncKeyA), null);
});

test("Nextcloud, password set: sealed round trip, format, AAD binds wallet + server + login", async () => {
  fresh();
  writeAccountRecords([accountA]);
  await setAppPassword("correct horse");
  writeNextcloudAccount(ncKeyA, ncAccount);
  assertNoPlainNextcloud();
  const raw = rawNc();
  assert.equal(raw.appPassword, undefined);
  assert.equal(raw.server, ncAccount.server, "server stays readable");
  assert.equal(raw.username, "alice", "username stays readable");
  assert.equal(raw.backupFolder, "KaChat", "options stay readable");
  assert.equal(raw.appPasswordSealed.v, 1);
  assert.match(raw.appPasswordSealed.iv, /^[0-9a-f]{24}$/);
  assert.match(raw.appPasswordSealed.ct, /^[0-9a-f]+$/);
  assert.deepEqual(readNextcloudAccount(ncKeyA), ncAccount, "opens back to the same account");
  // Standard AES-256-GCM: WebCrypto opens it with the same AAD.
  const dataKey = await crypto.subtle.importKey("raw", Buffer.from(currentDataKeyHex(), "hex"), "AES-GCM", false, ["decrypt"]);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: Buffer.from(raw.appPasswordSealed.iv, "hex"), additionalData: new TextEncoder().encode(nextcloudAadFor(ncKeyA, raw)) }, dataKey, Buffer.from(raw.appPasswordSealed.ct, "hex"));
  assert.equal(new TextDecoder().decode(plain), NC_SECRET);
  // Fresh IV on every write.
  writeNextcloudAccount(ncKeyA, { ...ncAccount, lastAutoBackup: 1 });
  assert.notEqual(rawNc().appPasswordSealed.iv, raw.appPasswordSealed.iv);
  // Moved to another wallet, or relabelled to another server / login: does not open.
  local.setItem(ncKeyB, JSON.stringify(raw));
  assert.equal(readNextcloudAccount(ncKeyB).appPassword, undefined);
  assert.equal(readNextcloudAccount(ncKeyB).unreadable, true);
  local.setItem(ncKeyA, JSON.stringify({ ...raw, server: "https://evil.example" }));
  assert.equal(readNextcloudAccount(ncKeyA).appPassword, undefined);
  local.setItem(ncKeyA, JSON.stringify({ ...raw, username: "mallory" }));
  assert.equal(readNextcloudAccount(ncKeyA).appPassword, undefined);
  // A record without a password in memory is never written (it would drop the sealed one).
  local.setItem(ncKeyA, JSON.stringify(raw));
  assert.throws(() => writeNextcloudAccount(ncKeyA, { ...ncAccount, appPassword: "" }), /not available/);
  assert.throws(() => writeNextcloudAccount(ncKeyA, readNextcloudAccount(ncKeyB)), /not available/);
  assert.deepEqual(rawNc(), raw);
});

test("Nextcloud, locked: unreadable, nothing written, Disconnect still works", async () => {
  fresh();
  writeAccountRecords([accountA]);
  await setAppPassword("correct horse");
  writeNextcloudAccount(ncKeyA, ncAccount);
  const before = local.getItem(ncKeyA);
  reload();
  assert.equal(isAppLocked(), true);
  const locked = readNextcloudAccount(ncKeyA);
  assert.equal(locked.locked, true);
  assert.equal(locked.unreadable, undefined, "locked, not broken");
  assert.equal(locked.appPassword, undefined, "no password while locked");
  assert.equal(locked.appPasswordSealed, undefined, "not even the blob is handed out");
  assert.equal(locked.server, ncAccount.server, "Connected to <server> as <user> still shows");
  assert.equal(locked.username, "alice");
  // Writes refused while locked (even one carrying the password): never plaintext, never unsealed.
  assert.throws(() => writeNextcloudAccount(ncKeyA, { ...ncAccount, lastAutoBackup: 5 }), /locked/i);
  assert.equal(local.getItem(ncKeyA), before);
  // A plaintext copy (e.g. written by an older build) is not used while locked either.
  local.setItem(ncKeyB, JSON.stringify(ncAccountB));
  assert.equal(readNextcloudAccount(ncKeyB).appPassword, undefined);
  assert.equal(readNextcloudAccount(ncKeyB).locked, true);
  // Unlocking opens it; it is sealed at that unlock.
  assert.equal(await unlockKeyVault("correct horse"), true);
  assert.equal(readNextcloudAccount(ncKeyA).appPassword, NC_SECRET);
  assert.equal(readNextcloudAccount(ncKeyB).appPassword, NC_SECRET_2);
  assertNoPlainNextcloud();
  // Disconnect while locked.
  reload();
  writeNextcloudAccount(ncKeyA, null);
  assert.equal(local.getItem(ncKeyA), null);
});

test("Nextcloud migration: setting a password seals every plaintext app password", async () => {
  fresh();
  writeAccountRecords([accountA, accountB]);
  writeNextcloudAccount(ncKeyA, ncAccount);
  writeNextcloudAccount(ncKeyB, ncAccountB);
  writeNextcloudAccount(NEXTCLOUD_STORAGE_KEY, ncAccount); // the unscoped key (no wallet active)
  local.setItem("kachat-unrelated-nextcloud-v1-ish", "not touched");
  await setAppPassword("correct horse");
  assertNoPlainNextcloud();
  assertNoPlaintextSecrets();
  for (const key of [ncKeyA, ncKeyB, NEXTCLOUD_STORAGE_KEY]) assert.ok(rawNc(key).appPasswordSealed && rawNc(key).appPassword === undefined);
  assert.equal(local.getItem("kachat-unrelated-nextcloud-v1-ish"), "not touched");
  reload();
  assert.equal(await unlockKeyVault("correct horse"), true);
  assert.equal(readNextcloudAccount(ncKeyA).appPassword, NC_SECRET);
  assert.equal(readNextcloudAccount(ncKeyB).appPassword, NC_SECRET_2);
  assert.equal(readNextcloudAccount(NEXTCLOUD_STORAGE_KEY).appPassword, NC_SECRET);
});

test("Nextcloud migration: a password already set before this update seals it at the next unlock", async () => {
  fresh();
  writeAccountRecords([accountA]);
  await setAppPassword("correct horse");
  local.setItem(ncKeyA, JSON.stringify(ncAccount)); // what the previous release stored
  reload();
  assert.equal(await unlockKeyVault("correct horse"), true);
  assertNoPlainNextcloud();
  assert.equal(readNextcloudAccount(ncKeyA).appPassword, NC_SECRET);
});

test("Nextcloud migration: changing the password re-seals it under the new key", async () => {
  fresh();
  writeAccountRecords([accountA]);
  await setAppPassword("correct horse");
  writeNextcloudAccount(ncKeyA, ncAccount);
  const oldRaw = rawNc();
  const oldKey = currentDataKeyHex();
  await setAppPassword("battery staple");
  const newRaw = rawNc();
  assert.notEqual(currentDataKeyHex(), oldKey);
  assert.notEqual(newRaw.appPasswordSealed.ct, oldRaw.appPasswordSealed.ct);
  assertNoPlainNextcloud();
  // The old data key no longer opens it; the new one does.
  const old = await crypto.subtle.importKey("raw", Buffer.from(oldKey, "hex"), "AES-GCM", false, ["decrypt"]);
  await assert.rejects(crypto.subtle.decrypt({ name: "AES-GCM", iv: Buffer.from(newRaw.appPasswordSealed.iv, "hex"), additionalData: new TextEncoder().encode(nextcloudAadFor(ncKeyA, newRaw)) }, old, Buffer.from(newRaw.appPasswordSealed.ct, "hex")));
  reload();
  assert.equal(await unlockKeyVault("correct horse"), false);
  assert.equal(await unlockKeyVault("battery staple"), true);
  assert.deepEqual(readNextcloudAccount(ncKeyA), ncAccount);
});

test("Nextcloud migration: a sealed password that no longer opens is dropped by a change, accounts kept", async () => {
  fresh();
  writeAccountRecords([accountA]);
  await setAppPassword("correct horse");
  writeNextcloudAccount(ncKeyA, ncAccount);
  const raw = rawNc();
  local.setItem(ncKeyA, JSON.stringify({ ...raw, appPasswordSealed: { ...raw.appPasswordSealed, ct: (raw.appPasswordSealed.ct[0] === "0" ? "1" : "0") + raw.appPasswordSealed.ct.slice(1) } }));
  await setAppPassword("battery staple");
  assert.equal(local.getItem(ncKeyA), null, "nobody could open it: removed, the user reconnects");
  assert.equal(byAddress(accountA.address).mnemonic, MNEMONIC_A);
});

test("Nextcloud migration: removing the password writes it back plaintext", async () => {
  fresh();
  writeAccountRecords([accountA]);
  await setAppPassword("correct horse");
  writeNextcloudAccount(ncKeyA, ncAccount);
  writeNextcloudAccount(ncKeyB, ncAccountB);
  reload();
  assert.equal(await unlockKeyVault("correct horse"), true);
  removeAppPassword();
  assert.equal(hasAppPassword(), false);
  for (const [key, secret] of [[ncKeyA, NC_SECRET], [ncKeyB, NC_SECRET_2]]) {
    assert.equal(rawNc(key).appPassword, secret);
    assert.equal(rawNc(key).appPasswordSealed, undefined);
  }
  assert.deepEqual(readNextcloudAccount(ncKeyA), ncAccount);
  // And plaintext from here on, as without a password.
  writeNextcloudAccount(ncKeyA, { ...ncAccount, lastAutoBackup: 9 });
  assert.equal(rawNc().appPassword, NC_SECRET);
});

test("Nextcloud migration: removing the password needs it unlocked (nothing written while locked)", async () => {
  fresh();
  await setAppPassword("correct horse");
  writeNextcloudAccount(ncKeyA, ncAccount);
  const before = local.getItem(ncKeyA);
  reload();
  assert.throws(() => removeAppPassword(), /password/i);
  assert.equal(local.getItem(ncKeyA), before);
  assert.equal(hasAppPassword(), true);
});

test("Nextcloud: forgotten-password reset clears the sealed app password (user reconnects)", async () => {
  fresh();
  writeAccountRecords([accountA]);
  await setAppPassword("correct horse");
  writeNextcloudAccount(ncKeyA, ncAccount);
  writeNextcloudAccount(ncKeyB, ncAccountB);
  reload();
  let told = 0;
  const off = onKeyVaultStateChanged(() => { told += 1; });
  resetForgottenAppPassword();
  await tick();
  off();
  assert.equal(told, 1, "the Nextcloud module is told to reload");
  assert.equal(local.getItem(ncKeyA), null);
  assert.equal(local.getItem(ncKeyB), null);
  assert.equal(readNextcloudAccount(ncKeyA), null);
  assert.equal(hasAppPassword(), false);
  assertNoPlainNextcloud();
  // Reconnecting afterwards stores it plaintext (no password now), as before.
  writeNextcloudAccount(ncKeyA, ncAccount);
  assert.equal(rawNc().appPassword, NC_SECRET);
});

test("Nextcloud: lock / unlock tell listeners (the module reloads the connection)", async () => {
  fresh();
  await setAppPassword("correct horse");
  await tick();
  let told = 0;
  const off = onKeyVaultStateChanged(() => { told += 1; });
  lockKeyVault();
  await tick();
  assert.equal(told, 1, "lock");
  lockKeyVault();
  await tick();
  assert.equal(told, 1, "already locked: no news");
  assert.equal(await unlockKeyVault("correct horse"), true);
  await tick();
  assert.equal(told, 2, "unlock");
  off();
});

test("Nextcloud DSK-022: a stale tab cannot write it after another tab changed the password", async () => {
  fresh();
  writeAccountRecords([accountA]);
  await setAppPassword("correct horse");
  writeNextcloudAccount(ncKeyA, ncAccount);
  assert.equal(await tabB.unlockKeyVault("correct horse"), true);
  assert.equal(tabB.readNextcloudAccount(ncKeyA).appPassword, NC_SECRET, "one data key: B opens what A sealed");
  await tabB.setAppPassword("battery staple");
  const after = local.getItem(ncKeyA);
  // Tab A (old key, no storage event yet): its periodic save is refused and A locks.
  assert.throws(() => writeNextcloudAccount(ncKeyA, { ...ncAccount, lastAutoBackup: 7 }), /locked in another tab/);
  assert.equal(isVaultUnlocked(), false);
  assert.equal(local.getItem(ncKeyA), after, "nothing written under the stale key");
  assert.equal(readNextcloudAccount(ncKeyA).appPassword, undefined, "and the stale tab reads nothing");
  assert.throws(() => writeNextcloudAccount(ncKeyA, ncAccount), /locked/i);
  assertNoPlainNextcloud();
  // The new password opens it, intact.
  reload();
  assert.equal(await unlockKeyVault("battery staple"), true);
  assert.deepEqual(readNextcloudAccount(ncKeyA), ncAccount);
});

test("Nextcloud DSK-022: a stale tab cannot write it after another tab removed the password", async () => {
  fresh();
  await setAppPassword("correct horse");
  writeNextcloudAccount(ncKeyA, ncAccount);
  assert.equal(await tabB.unlockKeyVault("correct horse"), true);
  tabB.removeAppPassword();
  const plain = local.getItem(ncKeyA);
  assert.throws(() => writeNextcloudAccount(ncKeyA, { ...ncAccount, appPassword: "changed-in-A" }), /locked in another tab/);
  assert.equal(local.getItem(ncKeyA), plain);
  assert.equal(rawNc().appPassword, NC_SECRET);
});

let failed = 0;
for (const [name, fn] of tests) {
  try { await fn(); console.log(`ok   ${name}`); }
  catch (error) { failed += 1; console.log(`FAIL ${name}\n     ${error.stack}`); }
}
console.log(failed ? `\n${failed} of ${tests.length} failed` : `\nall ${tests.length} passed`);
process.exit(failed ? 1 : 0);
