// node tools/test-key-vault.mjs - the saved-account key vault (ui/key-vault.js).
// Node's WebCrypto stands in for the browser's; localStorage / sessionStorage are in-memory maps.
import assert from "node:assert/strict";
import { webcrypto, createHash } from "node:crypto";
import {
  configureKeyVault, hasAppPassword, isVaultEnabled, isVaultUnlocked, isAppLocked,
  unlockKeyVault, unlockKeyVaultFromSession, lockKeyVault, setAppPassword, removeAppPassword,
  resetForgottenAppPassword, readAccountRecords, writeAccountRecords, persistedWalletRecordForStorage,
  readLegacyWalletKey, appPasswordLockoutRemainingSeconds,
  APP_PASSWORD_KEY, APP_PASSWORD_PENDING_KEY, SAVED_ACCOUNTS_KEY, PERSISTED_WALLET_KEY,
  LEGACY_PERSISTED_WALLET_KEY, VAULT_LEGACY_WALLET_KEY, VAULT_SESSION_KEY, VAULT_PBKDF2_ITERATIONS,
} from "../ui/key-vault.js";

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
function fresh({ iterations = TEST_ITERATIONS } = {}) {
  local = new MemoryStorage();
  session = new MemoryStorage();
  lockKeyVault();
  configureKeyVault({ storage: local, session, iterations, canonicalize: (a) => String(a || "").trim().toLowerCase().replace(/^kaspatest:/, "kaspa:") });
}
/** A new page load: memory gone, the same storage. */
function reload({ keepSession = true } = {}) {
  const saved = session.getItem(VAULT_SESSION_KEY);
  lockKeyVault();
  if (keepSession && saved) session.setItem(VAULT_SESSION_KEY, saved);
}

const MNEMONIC_A = "abandon ability able about above absent absorb abstract absurd abuse access accident";
const MNEMONIC_B = "zoo zone zero youth young yellow year wrong write worth world work";
const KEY_A = "11".repeat(32);
const KEY_B = "22".repeat(32);
const accountA = { version: 1, address: "kaspa:qpaaaaaaaaaaaa", privateKeyHex: KEY_A, mnemonic: MNEMONIC_A, passphrase: "tre-zor", name: "Alice", wordCount: 12, createdAt: "2026-01-01" };
const accountB = { version: 1, address: "kaspa:qpbbbbbbbbbbbb", privateKeyHex: KEY_B, mnemonic: MNEMONIC_B, passphrase: "", name: "Bob", wordCount: 12, createdAt: "2026-01-02" };

function storedText() { return local.dump() + session.dump(); }
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
  reload({ keepSession: false });
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
  const dataKey = Buffer.from(session.getItem(VAULT_SESSION_KEY), "hex");
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
  reload({ keepSession: false });
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
  reload({ keepSession: false });
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

test("session key survives a reload in the same tab, not a new tab", async () => {
  fresh();
  writeAccountRecords([accountA]);
  await setAppPassword("correct horse");
  reload({ keepSession: true });
  assert.equal(isAppLocked(), true);
  assert.equal(unlockKeyVaultFromSession(), true);
  assert.equal(byAddress(accountA.address).privateKeyHex, KEY_A);
  reload({ keepSession: false });
  assert.equal(unlockKeyVaultFromSession(), false);
  assert.equal(isAppLocked(), true);
  session.setItem(VAULT_SESSION_KEY, "ab".repeat(32));
  assert.equal(unlockKeyVaultFromSession(), false, "a key that is not this vault's is refused");
  assert.equal(session.getItem(VAULT_SESSION_KEY), null);
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
  reload({ keepSession: false });
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
  reload({ keepSession: false });
  assert.equal(await unlockKeyVault("correct horse"), true);
  assertNoPlaintextSecrets();
  assert.equal(byAddress(accountB.address).mnemonic, MNEMONIC_B);
});

test("password change re-encrypts everything under a new data key", async () => {
  fresh();
  writeAccountRecords([accountA, accountB]);
  await setAppPassword("correct horse");
  const oldRecord = JSON.parse(local.getItem(APP_PASSWORD_KEY));
  const oldKey = session.getItem(VAULT_SESSION_KEY);
  const oldStore = local.getItem(SAVED_ACCOUNTS_KEY);
  await setAppPassword("battery staple");
  const newRecord = JSON.parse(local.getItem(APP_PASSWORD_KEY));
  assert.notEqual(newRecord.salt, oldRecord.salt);
  assert.notEqual(session.getItem(VAULT_SESSION_KEY), oldKey, "fresh data key");
  assert.notEqual(local.getItem(SAVED_ACCOUNTS_KEY), oldStore);
  assert.equal(local.getItem(APP_PASSWORD_PENDING_KEY), null);
  assertNoPlaintextSecrets();
  reload({ keepSession: false });
  assert.equal(await unlockKeyVault("correct horse"), false, "old password no longer opens it");
  assert.equal(await unlockKeyVault("battery staple"), true);
  assert.equal(byAddress(accountB.address).mnemonic, MNEMONIC_B);
  // The old session key does not open the new vault.
  reload({ keepSession: false });
  session.setItem(VAULT_SESSION_KEY, oldKey);
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
  reload({ keepSession: false });
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
  reload({ keepSession: false });
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
  reload({ keepSession: false });
  assert.throws(() => removeAppPassword(), /password first/);
  assert.equal(await unlockKeyVault("correct horse"), true);
  removeAppPassword();
  assert.equal(hasAppPassword(), false);
  assert.equal(isVaultEnabled(), false);
  assert.equal(isAppLocked(), false);
  assert.equal(session.getItem(VAULT_SESSION_KEY), null);
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
  reload({ keepSession: true });
  assert.equal(unlockKeyVaultFromSession(), true);
  assert.equal(byAddress(accountA.address).locked, true, "flipped ciphertext bit: refused");
  assert.equal(byAddress(accountA.address).privateKeyHex, undefined);
  assert.equal(byAddress(accountB.address).privateKeyHex, KEY_B);

  const tamperedIv = JSON.parse(good);
  tamperedIv[1].sealed.iv = flip(tamperedIv[1].sealed.iv);
  local.setItem(SAVED_ACCOUNTS_KEY, JSON.stringify(tamperedIv));
  reload({ keepSession: true });
  unlockKeyVaultFromSession();
  assert.equal(byAddress(accountB.address).locked, true, "flipped IV: refused");

  const swapped = JSON.parse(good);
  [swapped[0].sealed, swapped[1].sealed] = [swapped[1].sealed, swapped[0].sealed];
  local.setItem(SAVED_ACCOUNTS_KEY, JSON.stringify(swapped));
  reload({ keepSession: true });
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
  reload({ keepSession: false });
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
  reload({ keepSession: false });
  assert.equal(resetForgottenAppPassword(), 2);
  assert.equal(hasAppPassword(), false);
  assert.equal(readAccountRecords().length, 0);
  assert.equal(isAppLocked(), false);
  assert.ok(!storedText().includes(KEY_A));
});

let failed = 0;
for (const [name, fn] of tests) {
  try { await fn(); console.log(`ok   ${name}`); }
  catch (error) { failed += 1; console.log(`FAIL ${name}\n     ${error.stack}`); }
}
console.log(failed ? `\n${failed} of ${tests.length} failed` : `\nall ${tests.length} passed`);
process.exit(failed ? 1 : 0);
