// Key vault for saved accounts (audit DSK-006 / DSK-007 / DSK-010).
//
// Without an app password, saved accounts stay as they always were: plaintext JSON in
// localStorage (the Settings text says so). With an app password, every secret at rest is
// encrypted:
//
//   kachat-app-password-v1 (localStorage) - the password record, childmode.js's
//     { salt, hash, iterations } plus the wrapped data key:
//     { version: 2, kdf: "PBKDF2-SHA256", iterations: 600000,
//       salt: hex(16),                       PBKDF2 salt, fresh on every set/change
//       hash: hex(SHA-256(KEK)),             password check; never the KEK itself
//       wrappedKey: { iv: hex(12), ct: hex(32 + 16) },   AES-256-GCM(KEK, dataKey)
//       keyCheck:   { iv: hex(12), ct: hex } }           AES-256-GCM(dataKey, constant)
//     KEK = PBKDF2-HMAC-SHA256(password, salt, iterations, 256 bits) via WebCrypto.
//     Pre-vault records are { salt, hash } with hash = SHA-256(salt + ":" + password); they
//     verify the old way once and are replaced at that moment.
//
//   kachat-saved-accounts-v1 - each entry keeps its public fields (address, name, dates,
//     derivation details) readable for the sign-in screen, and carries the secrets as
//     sealed: { v: 1, iv: hex(12), ct: hex }   ct = AES-256-GCM(dataKey,
//       JSON { privateKeyHex, mnemonic, passphrase }, AAD = "kachat-account-secrets-v1|" +
//       canonical address). Fresh random IV on every write.
//
//   kachat-shell-testing-wallet-v2 - the active-wallet record keeps public fields only.
//   kachat-vault-legacy-wallet-v1 - a sealed copy of the pre-v2 bare-hex wallet key, if any.
//   kachat-vault-session-v1 (sessionStorage) - the data key for this tab session, so the
//     reloads KaChat does (account switch, network switch) don't ask again. Closing the tab
//     forgets it; Log Out removes it.
//
// The data key is a random 256-bit key held in memory while unlocked. AES-GCM runs through
// @noble/ciphers (standard AES-256-GCM, 12-byte IV, 16-byte tag; interoperable with WebCrypto),
// because the account store is read and written synchronously all over the app; the password KDF
// and all randomness are WebCrypto.

import { gcm } from "@noble/ciphers/aes.js";

export const APP_PASSWORD_KEY = "kachat-app-password-v1";
export const APP_PASSWORD_PENDING_KEY = "kachat-app-password-pending-v1";
export const SAVED_ACCOUNTS_KEY = "kachat-saved-accounts-v1";
export const PERSISTED_WALLET_KEY = "kachat-shell-testing-wallet-v2";
export const LEGACY_PERSISTED_WALLET_KEY = "kachat-shell-testing-wallet-private-key";
export const VAULT_LEGACY_WALLET_KEY = "kachat-vault-legacy-wallet-v1";
export const VAULT_SESSION_KEY = "kachat-vault-session-v1";
export const VAULT_PBKDF2_ITERATIONS = 600_000;
export const MIN_APP_PASSWORD_LENGTH = 8;
const FAILED_ATTEMPTS_KEY = "kachat-app-password-failed-attempts";
const LOCKED_UNTIL_KEY = "kachat-app-password-locked-until";
const FREE_ATTEMPTS = 5;
const SECRET_FIELDS = ["privateKeyHex", "mnemonic", "passphrase"];
const SECRETS_AAD_PREFIX = "kachat-account-secrets-v1|";
const LEGACY_WALLET_AAD = "kachat-legacy-wallet-key-v1";
const WRAP_AAD = "kachat-vault-data-key-v1";
const KEY_CHECK_TEXT = "kachat-vault-key-check-v1";

// One state object (no top-level let), so nothing depends on declaration order once bundled.
const vault = {
  storage: null,
  session: null,
  iterations: VAULT_PBKDF2_ITERATIONS,
  canonicalize: (address) => String(address || "").trim().toLowerCase(),
  dataKey: null,          // Uint8Array(32) while unlocked
  legacyVerified: false,  // pre-vault password verified, but the upgrade could not be written
  opened: new Map(),      // ct hex -> opened secrets (cleared on lock / key change)
};

/** Wires storage (tests pass in-memory stand-ins), the address canonicalizer and, for tests only,
 *  a lower iteration count for NEW records. */
export function configureKeyVault({ storage, session, canonicalize, iterations } = {}) {
  if (storage !== undefined) vault.storage = storage;
  if (session !== undefined) vault.session = session;
  if (typeof canonicalize === "function") vault.canonicalize = canonicalize;
  if (Number.isInteger(iterations) && iterations > 0) vault.iterations = iterations;
}

function ls() { return vault.storage || globalThis.localStorage; }
function ss() {
  try { return vault.session || globalThis.sessionStorage || null; } catch { return null; }
}

// --- bytes ------------------------------------------------------------------------------------
const enc = new TextEncoder();
const dec = new TextDecoder();
function bytesToHex(bytes) { return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(""); }
function hexToBytes(hex) {
  const clean = String(hex || "");
  if (clean.length % 2 || /[^0-9a-f]/i.test(clean)) throw new Error("Invalid hex");
  const out = new Uint8Array(clean.length >> 1);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}
function randomBytes(length) { return crypto.getRandomValues(new Uint8Array(length)); }
function equalStrings(a, b) {
  const x = String(a);
  const y = String(b);
  if (x.length !== y.length) return false;
  let difference = 0;
  for (let i = 0; i < x.length; i += 1) difference |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return difference === 0;
}
async function sha256Hex(bytes) { return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))); }
async function deriveKek(password, saltBytes, iterations) {
  const material = await crypto.subtle.importKey("raw", enc.encode(String(password)), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: saltBytes, iterations, hash: "SHA-256" }, material, 256);
  return new Uint8Array(bits);
}

function sealBytes(key, plaintext, aad) {
  const iv = randomBytes(12);
  const ct = gcm(key, iv, enc.encode(aad)).encrypt(plaintext);
  return { iv: bytesToHex(iv), ct: bytesToHex(ct) };
}
/** Throws when the key is wrong or the ciphertext / IV / AAD was altered (GCM tag). */
function openBytes(key, sealed, aad) {
  return gcm(key, hexToBytes(sealed?.iv), enc.encode(aad)).decrypt(hexToBytes(sealed?.ct));
}

// --- password record --------------------------------------------------------------------------
function parseRecord(raw) {
  try {
    const parsed = JSON.parse(raw || "null");
    if (parsed && typeof parsed.salt === "string" && typeof parsed.hash === "string") return parsed;
  } catch { /* corrupted record = no record */ }
  return null;
}
function isVaultRecord(record) {
  return !!(record && Number(record.version) >= 2 && Number(record.iterations) > 0 && record.wrappedKey?.iv && record.wrappedKey?.ct);
}
export function loadPasswordRecord() { return parseRecord(ls().getItem(APP_PASSWORD_KEY)); }
function loadPendingRecord() {
  const record = parseRecord(ls().getItem(APP_PASSWORD_PENDING_KEY));
  return isVaultRecord(record) ? record : null;
}

/** A password exists (current record, or one a password change was in the middle of writing). */
export function hasAppPassword() { return !!(loadPasswordRecord() || loadPendingRecord()); }
/** Saved-account secrets are (or are to be) stored encrypted. */
export function isVaultEnabled() { return isVaultRecord(loadPasswordRecord()) || !!loadPendingRecord(); }
export function isVaultUnlocked() { return !!vault.dataKey; }
/** A password exists and has not been entered in this tab session: nothing may sign in. */
export function isAppLocked() { return hasAppPassword() && !vault.dataKey && !vault.legacyVerified; }

// --- lockout (childmode.js's escalating backoff) -----------------------------------------------
/** Seconds left before another attempt is accepted, null when attempts are open. Five wrong
 *  answers earn 30 seconds; each one after doubles it, up to an hour. */
export function appPasswordLockoutRemainingSeconds() {
  const until = Number(ls().getItem(LOCKED_UNTIL_KEY) || 0);
  const remaining = until - Date.now() / 1000;
  return remaining > 0 ? Math.ceil(remaining) : null;
}
function recordFailedAttempt() {
  const attempts = Number(ls().getItem(FAILED_ATTEMPTS_KEY) || 0) + 1;
  ls().setItem(FAILED_ATTEMPTS_KEY, String(attempts));
  if (attempts < FREE_ATTEMPTS) return;
  const penalty = Math.min(3600, 30 * 2 ** (attempts - FREE_ATTEMPTS));
  ls().setItem(LOCKED_UNTIL_KEY, String(Date.now() / 1000 + penalty));
}
function clearFailedAttempts() {
  ls().removeItem(FAILED_ATTEMPTS_KEY);
  ls().removeItem(LOCKED_UNTIL_KEY);
}
export function appPasswordLockoutMessage() {
  const seconds = appPasswordLockoutRemainingSeconds();
  return seconds == null ? null : `Too many wrong passwords. Try again in ${seconds}s.`;
}

// --- unlocked state ---------------------------------------------------------------------------
function keyMatchesRecord(key, record) {
  if (!record?.keyCheck) return true;
  try { return dec.decode(openBytes(key, record.keyCheck, KEY_CHECK_TEXT)) === KEY_CHECK_TEXT; } catch { return false; }
}
function setUnlocked(key) {
  vault.dataKey = key;
  vault.legacyVerified = false;
  vault.opened.clear();
  try { ss()?.setItem(VAULT_SESSION_KEY, bytesToHex(key)); } catch { /* reloads will ask again */ }
}
/** Forgets the data key and every opened secret (Log Out). */
export function lockKeyVault() {
  vault.dataKey = null;
  vault.legacyVerified = false;
  vault.opened.clear();
  try { ss()?.removeItem(VAULT_SESSION_KEY); } catch { /* nothing stored */ }
}
/** Same tab session as an earlier unlock (KaChat reloads itself on account and network
 *  switches): take the data key back from sessionStorage. Synchronous. */
export function unlockKeyVaultFromSession() {
  if (vault.dataKey) return true;
  if (!isVaultEnabled()) return false;
  let key = null;
  try { key = hexToBytes(ss()?.getItem(VAULT_SESSION_KEY) || ""); } catch { key = null; }
  if (!key || key.length !== 32) return false;
  const record = loadPasswordRecord();
  const pending = loadPendingRecord();
  if (!(isVaultRecord(record) && keyMatchesRecord(key, record)) && !(pending && keyMatchesRecord(key, pending))) {
    try { ss()?.removeItem(VAULT_SESSION_KEY); } catch { /* stale */ }
    return false;
  }
  setUnlocked(key);
  return true;
}

// --- sealing account secrets ------------------------------------------------------------------
function secretsAad(address) { return SECRETS_AAD_PREFIX + vault.canonicalize(address); }
function pickSecrets(entry) {
  return { privateKeyHex: String(entry?.privateKeyHex || "").trim(), mnemonic: String(entry?.mnemonic || ""), passphrase: String(entry?.passphrase || "") };
}
function hasSecrets(entry) { return SECRET_FIELDS.some((field) => entry?.[field]); }
function publicPart(entry) {
  const out = { ...entry };
  for (const field of SECRET_FIELDS) delete out[field];
  delete out.sealed;
  delete out.locked;
  return out;
}
function sealSecretsWith(key, address, secrets) {
  return { v: 1, ...sealBytes(key, enc.encode(JSON.stringify(pickSecrets(secrets))), secretsAad(address)) };
}
function openSecretsWith(key, address, sealed) {
  const parsed = JSON.parse(dec.decode(openBytes(key, sealed, secretsAad(address))));
  return pickSecrets(parsed);
}
function openCached(address, sealed) {
  const cacheKey = `${vault.canonicalize(address)}|${sealed?.ct}`;
  if (vault.opened.has(cacheKey)) return vault.opened.get(cacheKey);
  const secrets = openSecretsWith(vault.dataKey, address, sealed);
  vault.opened.set(cacheKey, secrets);
  return secrets;
}
function sameSecrets(a, b) {
  return SECRET_FIELDS.every((field) => String(a?.[field] || "") === String(b?.[field] || ""));
}

function readRawAccounts() {
  try {
    const parsed = JSON.parse(ls().getItem(SAVED_ACCOUNTS_KEY) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

/**
 * The stored account registry (addresses as stored). Sealed entries come back with their
 * secrets merged in while unlocked; while locked (or if one does not open) they come back with
 * public fields only and `locked: true`. Either way `sealed` rides along, so writing the list
 * back keeps a blob it could not open.
 */
export function readAccountRecords() {
  return readRawAccounts().map((entry) => {
    if (!entry || typeof entry !== "object" || !entry.sealed) return entry;
    if (vault.dataKey) {
      try { return { ...publicPart(entry), ...openCached(entry.address, entry.sealed), sealed: entry.sealed }; }
      catch { /* wrong key or tampered: leave it sealed */ }
    }
    return { ...publicPart(entry), sealed: entry.sealed, locked: true };
  });
}

function sealEntries(key, entries) {
  return entries.map((entry) => {
    if (!entry || typeof entry !== "object") return entry;
    if (hasSecrets(entry)) {
      const sealed = sealSecretsWith(key, entry.address, entry);
      // Never store what does not open again.
      if (!sameSecrets(openSecretsWith(key, entry.address, sealed), entry)) throw new Error("Encrypted account record failed verification.");
      return { ...publicPart(entry), sealed };
    }
    if (entry.sealed) return { ...publicPart(entry), sealed: entry.sealed };
    return publicPart(entry);
  });
}

/**
 * Writes the account registry. With the vault enabled every entry that carries secrets is
 * sealed with a fresh IV (and checked to decrypt) before anything is written; refuses while
 * locked rather than ever writing a secret in plaintext. Without the vault: plaintext, as before.
 */
export function writeAccountRecords(entries) {
  const list = Array.isArray(entries) ? entries : [];
  if (!isVaultEnabled()) {
    ls().setItem(SAVED_ACCOUNTS_KEY, JSON.stringify(list.map((entry) => {
      if (!entry || typeof entry !== "object") return entry;
      const out = { ...entry };
      delete out.locked;
      if (hasSecrets(entry)) delete out.sealed;
      return out;
    })));
    return;
  }
  if (!vault.dataKey && list.some(hasSecrets)) {
    throw new Error("KaChat is locked. Enter your password before saving an account on this device.");
  }
  ls().setItem(SAVED_ACCOUNTS_KEY, JSON.stringify(sealEntries(vault.dataKey, list)));
}

/** The record for the active-wallet key: secrets stripped while the vault is on. */
export function persistedWalletRecordForStorage(payload) {
  return isVaultEnabled() ? publicPart(payload) : { ...payload };
}

/** The pre-v2 bare-hex wallet key: plaintext without the vault, sealed with it. */
export function readLegacyWalletKey() {
  const plain = String(ls().getItem(LEGACY_PERSISTED_WALLET_KEY) || "").trim();
  if (plain) return plain;
  if (!vault.dataKey) return "";
  try {
    const sealed = JSON.parse(ls().getItem(VAULT_LEGACY_WALLET_KEY) || "null");
    return sealed ? dec.decode(openBytes(vault.dataKey, sealed, LEGACY_WALLET_AAD)).trim() : "";
  } catch { return ""; }
}
export function clearLegacyWalletKey() {
  ls().removeItem(LEGACY_PERSISTED_WALLET_KEY);
  ls().removeItem(VAULT_LEGACY_WALLET_KEY);
}

// --- migration ------------------------------------------------------------------------------
/** Everything the vault must hold, in plaintext form: the registry (sealed entries opened with
 *  `key`; throws if one does not open), plus a pre-registry active-wallet record not yet in it. */
function collectPlainAccounts(key) {
  const entries = readRawAccounts().map((entry) => {
    if (!entry || typeof entry !== "object" || !entry.sealed || hasSecrets(entry)) return entry;
    if (!key) throw new Error("KaChat is locked.");
    try { return { ...publicPart(entry), ...openSecretsWith(key, entry.address, entry.sealed) }; }
    catch { throw new Error(`A saved account (${String(entry.address || "").slice(-8)}) could not be decrypted. Nothing was changed.`); }
  });
  let wallet = null;
  try { wallet = JSON.parse(ls().getItem(PERSISTED_WALLET_KEY) || "null"); } catch { wallet = null; }
  return collectPlainAccountsFrom(entries, wallet);
}
function plainLegacyWalletKey(key) {
  const plain = String(ls().getItem(LEGACY_PERSISTED_WALLET_KEY) || "").trim();
  if (plain) return plain;
  const raw = ls().getItem(VAULT_LEGACY_WALLET_KEY);
  if (!raw) return "";
  if (!key) throw new Error("KaChat is locked.");
  return dec.decode(openBytes(key, JSON.parse(raw), LEGACY_WALLET_AAD)).trim();
}

/** Writes `entries` sealed with `key`, reads them back and checks every secret, and restores
 *  the previous value if anything does not match. */
function writeSealedVerified(key, entries) {
  const previous = ls().getItem(SAVED_ACCOUNTS_KEY);
  const sealed = sealEntries(key, entries);
  ls().setItem(SAVED_ACCOUNTS_KEY, JSON.stringify(sealed));
  try {
    const back = readRawAccounts();
    entries.forEach((entry, index) => {
      if (!entry || typeof entry !== "object" || !hasSecrets(entry)) return;
      if (!sameSecrets(openSecretsWith(key, back[index]?.address, back[index]?.sealed), entry)) throw new Error("mismatch");
    });
  } catch {
    if (previous == null) ls().removeItem(SAVED_ACCOUNTS_KEY); else ls().setItem(SAVED_ACCOUNTS_KEY, previous);
    throw new Error("Encrypted accounts could not be verified. Nothing was changed.");
  }
}
/** Seals the legacy key (verified) and only then deletes the plaintext copy. */
function sealLegacyWalletKey(key, hex) {
  if (!hex) { ls().removeItem(VAULT_LEGACY_WALLET_KEY); return; }
  const sealed = sealBytes(key, enc.encode(hex), LEGACY_WALLET_AAD);
  if (dec.decode(openBytes(key, sealed, LEGACY_WALLET_AAD)) !== hex) throw new Error("Legacy wallet key failed verification.");
  ls().setItem(VAULT_LEGACY_WALLET_KEY, JSON.stringify(sealed));
  ls().removeItem(LEGACY_PERSISTED_WALLET_KEY);
}
/** The active-wallet record without its secrets (they are in the sealed registry now). */
function scrubPersistedWallet() {
  try {
    const wallet = JSON.parse(ls().getItem(PERSISTED_WALLET_KEY) || "null");
    if (!wallet || !hasSecrets(wallet)) return;
    const out = publicPart(wallet);
    if (out.address) out.address = vault.canonicalize(out.address);
    ls().setItem(PERSISTED_WALLET_KEY, JSON.stringify(out));
  } catch { ls().removeItem(PERSISTED_WALLET_KEY); }
}

/** First unlock after the update (or a record written while something was plaintext): seal
 *  every plaintext secret, verify, then delete the plaintext copies. Returns what it sealed. */
function migratePlaintextIntoVault() {
  const key = vault.dataKey;
  if (!key) return 0;
  const raw = readRawAccounts();
  let wallet = null;
  try { wallet = JSON.parse(ls().getItem(PERSISTED_WALLET_KEY) || "null"); } catch { wallet = null; }
  const plainLegacy = String(ls().getItem(LEGACY_PERSISTED_WALLET_KEY) || "").trim();
  const plainCount = raw.filter(hasSecrets).length;
  if (!plainCount && !hasSecrets(wallet) && !plainLegacy) return 0;
  // Sealed entries that do not open with this key are kept as they are (never dropped).
  const entries = raw.map((entry) => {
    if (!entry || typeof entry !== "object" || !entry.sealed || hasSecrets(entry)) return entry;
    try { return { ...publicPart(entry), ...openSecretsWith(key, entry.address, entry.sealed) }; } catch { return entry; }
  });
  const merged = collectPlainAccountsFrom(entries, wallet);
  writeSealedVerified(key, merged);
  if (plainLegacy) sealLegacyWalletKey(key, plainLegacy);
  scrubPersistedWallet();
  vault.opened.clear();
  return plainCount;
}
function collectPlainAccountsFrom(entries, wallet) {
  const address = String(wallet?.address || "").trim();
  if (!address || !wallet?.privateKeyHex) return entries;
  if (entries.some((entry) => entry?.address && vault.canonicalize(entry.address) === vault.canonicalize(address))) return entries;
  return [...entries, {
    version: 1,
    address: vault.canonicalize(address),
    privateKeyHex: String(wallet.privateKeyHex).trim(),
    mnemonic: String(wallet.mnemonic || ""),
    passphrase: String(wallet.passphrase || ""),
    derivationPath: String(wallet.derivationPath || ""),
    wordCount: Number(wallet.wordCount || 0),
    sourceFamily: String(wallet.sourceFamily || "kaspaStandard"),
    chattingIndex: Number(wallet.chattingIndex || 0),
    name: `Account ${address.slice(-6)}`,
    createdAt: wallet.savedAt || new Date().toISOString(),
    savedAt: wallet.savedAt || new Date().toISOString(),
  }];
}

async function buildVaultRecord(password, dataKey) {
  const salt = randomBytes(16);
  const iterations = vault.iterations;
  const kek = await deriveKek(password, salt, iterations);
  const wrappedKey = sealBytes(kek, dataKey, WRAP_AAD);
  const unwrapped = openBytes(kek, wrappedKey, WRAP_AAD);
  if (bytesToHex(unwrapped) !== bytesToHex(dataKey)) throw new Error("Data key wrap failed verification.");
  return {
    version: 2,
    kdf: "PBKDF2-SHA256",
    iterations,
    salt: bytesToHex(salt),
    hash: await sha256Hex(kek),
    wrappedKey,
    keyCheck: sealBytes(dataKey, enc.encode(KEY_CHECK_TEXT), KEY_CHECK_TEXT),
  };
}

/** Opens `record` with `password`: the data key, or null when the password is wrong. */
async function openVaultRecord(record, password) {
  const kek = await deriveKek(password, hexToBytes(record.salt), Number(record.iterations));
  if (!equalStrings(await sha256Hex(kek), record.hash)) return null;
  try {
    const key = openBytes(kek, record.wrappedKey, WRAP_AAD);
    return key.length === 32 ? key : null;
  } catch { return null; }
}
async function legacyPasswordMatches(record, password) {
  const candidate = await sha256Hex(enc.encode(`${record.salt}:${password}`));
  return equalStrings(candidate, record.hash);
}
function firstSealedEntry() { return readRawAccounts().find((entry) => entry?.sealed && !hasSecrets(entry)) || null; }
function keyOpensStore(key) {
  const probe = firstSealedEntry();
  if (!probe) return true;
  try { openSecretsWith(key, probe.address, probe.sealed); return true; } catch { return false; }
}

/**
 * Checks `password` and unlocks the vault. Counts wrong answers toward the lockout. A pre-vault
 * record is verified the old way, then replaced by a vault record with every plaintext secret
 * sealed. An interrupted password change is finished here. Never throws for a wrong password.
 */
export async function unlockKeyVault(password) {
  if (appPasswordLockoutRemainingSeconds() != null) return false;
  const value = String(password ?? "");
  const record = loadPasswordRecord();
  const pending = loadPendingRecord();
  if (!record && !pending) return false;

  let key = null;
  let fromPending = false;
  if (isVaultRecord(record)) {
    key = await openVaultRecord(record, value);
    if (key && pending && !keyOpensStore(key)) key = null; // the store was re-sealed with the pending key
  }
  if (!key && pending) {
    // Only a pending record whose key opens what is stored may take over; otherwise the store is
    // still under the current record and promoting would strand it.
    const candidate = await openVaultRecord(pending, value);
    if (candidate && keyOpensStore(candidate)) { key = candidate; fromPending = true; }
  }
  if (!key && record && !isVaultRecord(record)) {
    // Pre-vault record: a single SHA-256. Verified the old way once, then replaced (with the
    // same password, whatever its length) by a vault record with every plaintext secret sealed.
    if (!(await legacyPasswordMatches(record, value))) { recordFailedAttempt(); return false; }
    clearFailedAttempts();
    try { await writeNewVault(value); }
    catch { vault.legacyVerified = true; /* stays plaintext; tried again at the next unlock */ }
    return true;
  }
  if (!key) { recordFailedAttempt(); return false; }
  clearFailedAttempts();
  if (fromPending) {
    ls().setItem(APP_PASSWORD_KEY, ls().getItem(APP_PASSWORD_PENDING_KEY));
  }
  if (pending && keyOpensStore(key)) ls().removeItem(APP_PASSWORD_PENDING_KEY);
  setUnlocked(key);
  try { migratePlaintextIntoVault(); } catch { /* plaintext copies stay until the next unlock */ }
  // A record from a weaker work factor: the password is known good right now, so re-wrap.
  const current = loadPasswordRecord();
  if (isVaultRecord(current) && Number(current.iterations) < VAULT_PBKDF2_ITERATIONS && vault.iterations >= VAULT_PBKDF2_ITERATIONS) {
    try {
      const upgraded = await buildVaultRecord(value, key);
      ls().setItem(APP_PASSWORD_KEY, JSON.stringify(upgraded));
    } catch { /* next time */ }
  }
  return true;
}

/**
 * Sets a first password or replaces the current one (the caller has verified the old one, which
 * unlocked the vault). A fresh data key and salt are made and every secret is re-encrypted.
 * Order, so a crash at any point leaves something the user's password opens:
 *   1. pending record (new password)  2. registry sealed with the new key, read back and checked
 *   3. the record itself  4. pending removed  5. legacy key sealed, active-wallet record scrubbed.
 */
export async function setAppPassword(password) {
  const value = String(password ?? "");
  if (value.length < MIN_APP_PASSWORD_LENGTH) throw new Error(`Use at least ${MIN_APP_PASSWORD_LENGTH} characters.`);
  await writeNewVault(value);
}
async function writeNewVault(value) {
  if (isVaultEnabled() && !vault.dataKey) throw new Error("Enter your current password first.");
  const oldKey = vault.dataKey;
  const entries = collectPlainAccounts(oldKey);
  const legacyHex = plainLegacyWalletKey(oldKey);
  const dataKey = randomBytes(32);
  const record = await buildVaultRecord(value, dataKey);
  const recordJson = JSON.stringify(record);
  ls().setItem(APP_PASSWORD_PENDING_KEY, recordJson);
  try {
    writeSealedVerified(dataKey, entries);
  } catch (error) {
    ls().removeItem(APP_PASSWORD_PENDING_KEY);
    throw error;
  }
  ls().setItem(APP_PASSWORD_KEY, recordJson);
  ls().removeItem(APP_PASSWORD_PENDING_KEY);
  clearFailedAttempts();
  setUnlocked(dataKey);
  try { sealLegacyWalletKey(dataKey, legacyHex); } catch { /* the plaintext copy stays until it can be sealed */ }
  scrubPersistedWallet();
}

/**
 * Removes the password (the caller has verified it, which unlocked the vault): every secret is
 * written back as plaintext and checked, and only then is the password record deleted.
 */
export function removeAppPassword() {
  if (!hasAppPassword()) return;
  if (isVaultEnabled() && !vault.dataKey) throw new Error("Enter your password first.");
  const key = vault.dataKey;
  const entries = collectPlainAccounts(key).map((entry) => {
    if (!entry || typeof entry !== "object") return entry;
    const out = { ...entry };
    delete out.sealed;
    delete out.locked;
    return out;
  });
  const legacyHex = plainLegacyWalletKey(key);
  const previous = ls().getItem(SAVED_ACCOUNTS_KEY);
  ls().setItem(SAVED_ACCOUNTS_KEY, JSON.stringify(entries));
  const back = readRawAccounts();
  const ok = entries.every((entry, index) => !entry || typeof entry !== "object" || !hasSecrets(entry) || sameSecrets(back[index], entry));
  if (!ok) {
    if (previous == null) ls().removeItem(SAVED_ACCOUNTS_KEY); else ls().setItem(SAVED_ACCOUNTS_KEY, previous);
    throw new Error("Accounts could not be written back. The password was kept.");
  }
  if (legacyHex) ls().setItem(LEGACY_PERSISTED_WALLET_KEY, legacyHex);
  ls().removeItem(VAULT_LEGACY_WALLET_KEY);
  ls().removeItem(APP_PASSWORD_KEY);
  ls().removeItem(APP_PASSWORD_PENDING_KEY);
  clearFailedAttempts();
  lockKeyVault();
}

/**
 * Forgotten password: the encrypted keys cannot be opened by anyone, so this deletes the
 * password record and every saved account's sealed keys from this device (their public entries,
 * chats and settings stay). The user imports each account again with its recovery phrase.
 * Returns the number of accounts whose keys were removed.
 */
export function resetForgottenAppPassword() {
  const raw = readRawAccounts();
  const kept = raw.filter((entry) => !(entry?.sealed && !hasSecrets(entry)));
  ls().setItem(SAVED_ACCOUNTS_KEY, JSON.stringify(kept.map((entry) => {
    if (!entry || typeof entry !== "object") return entry;
    const out = { ...entry };
    delete out.sealed;
    return out;
  })));
  ls().removeItem(VAULT_LEGACY_WALLET_KEY);
  ls().removeItem(APP_PASSWORD_KEY);
  ls().removeItem(APP_PASSWORD_PENDING_KEY);
  clearFailedAttempts();
  lockKeyVault();
  return raw.length - kept.length;
}
