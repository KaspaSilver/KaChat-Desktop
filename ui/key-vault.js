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
//   <account scope>:kachat-nextcloud-v1 - the Nextcloud connection keeps server, login and options
//     readable and carries the app password as appPasswordSealed: { v: 1, iv, ct } (AAD = storage
//     key + server + username). See "the Nextcloud app password" below.
//   kachat-shell-testing-wallet-v2 - the active-wallet record keeps public fields only.
//   kachat-vault-legacy-wallet-v1 - a sealed copy of the pre-v2 bare-hex wallet key, if any.
//   kachat-vault-handoff-v1 (sessionStorage) - a one-time hand-off { key: hex(32), expiresAt }
//     written only just before a reload KaChat itself starts (sign-in, account switch, network
//     switch), so those don't ask again. The next page load takes it once and deletes it at once;
//     it is refused when expired (15 s), malformed or not this vault's key (DSK-023). Nothing else
//     ever puts the key in browser storage, so closing the tab locks KaChat, and "Reopen closed
//     tab", session restore, Duplicate tab and a manual refresh all ask for the password.
//     (kachat-vault-session-v1, the pre-DSK-023 per-tab copy, is deleted and never honoured.)
//
// The data key is a random 256-bit key held in this page's memory only while unlocked. Every
// write checks it still matches the stored password record (or the pending one): a tab whose key
// was replaced by a password change in another tab is locked instead of sealing anything the new
// password cannot open (DSK-022). AES-GCM runs through
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
export const VAULT_SESSION_KEY = "kachat-vault-session-v1"; // pre-DSK-023: deleted, never read
export const VAULT_HANDOFF_KEY = "kachat-vault-handoff-v1";
export const VAULT_HANDOFF_TTL_MS = 15_000;
export const LOCKED_IN_ANOTHER_TAB_MESSAGE = "KaChat was locked in another tab. Enter your password to continue.";
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
  verifiedFor: null,      // the stored record + pending text the data key was last checked against
  lockListeners: new Set(), // told when another tab's password change locked this one
  stateListeners: new Set(), // told (after the call unwinds) whenever the vault locks or unlocks
  now: () => Date.now(),
};

/** Wires storage (tests pass in-memory stand-ins), the address canonicalizer and, for tests only,
 *  a lower iteration count for NEW records and a clock. */
export function configureKeyVault({ storage, session, canonicalize, iterations, now } = {}) {
  if (storage !== undefined) vault.storage = storage;
  if (session !== undefined) vault.session = session;
  if (typeof canonicalize === "function") vault.canonicalize = canonicalize;
  if (Number.isInteger(iterations) && iterations > 0) vault.iterations = iterations;
  if (typeof now === "function") vault.now = now;
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
export function isVaultUnlocked() { checkKeyStillCurrent(); return !!vault.dataKey; }
/** A password exists and has not been entered in this page (or another tab changed it since):
 *  nothing may sign in. */
export function isAppLocked() { checkKeyStillCurrent(); return hasAppPassword() && !vault.dataKey && !vault.legacyVerified; }

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
/** `key` is the one the stored password record wraps (or the pending record of a password change
 *  that is being written). A record from before keyCheck existed is checked against the store. */
function keyIsCurrent(key) {
  if (!key || key.length !== 32) return false;
  const record = loadPasswordRecord();
  const pending = loadPendingRecord();
  if (isVaultRecord(record) && (record.keyCheck ? keyMatchesRecord(key, record) : keyOpensStore(key))) return true;
  return !!(pending?.keyCheck && keyMatchesRecord(key, pending));
}
function storedRecordsText() {
  return `${ls().getItem(APP_PASSWORD_KEY)}\u0000${ls().getItem(APP_PASSWORD_PENDING_KEY)}`;
}
function notifyStateListeners() {
  for (const listener of vault.stateListeners) {
    const call = () => { try { listener(); } catch { /* the listener's problem */ } };
    if (typeof queueMicrotask === "function") queueMicrotask(call); else setTimeout(call, 0);
  }
}
function setUnlocked(key) {
  vault.dataKey = key;
  vault.legacyVerified = false;
  vault.opened.clear();
  vault.verifiedFor = null;
  // Memory only (DSK-023): nothing here survives the page. See writeKeyVaultHandoff.
  notifyStateListeners();
}
function clearSessionCopies() {
  try { ss()?.removeItem(VAULT_HANDOFF_KEY); } catch { /* nothing stored */ }
  try { ss()?.removeItem(VAULT_SESSION_KEY); } catch { /* nothing stored */ }
}
/** Forgets the data key and every opened secret (Log Out, or locked by another tab). */
export function lockKeyVault() {
  const wasOpen = !!(vault.dataKey || vault.legacyVerified);
  vault.dataKey = null;
  vault.legacyVerified = false;
  vault.opened.clear();
  vault.verifiedFor = null;
  clearSessionCopies();
  if (wasOpen) notifyStateListeners();
}

/** Called when the data key turned out to be stale: lock, and tell the app (once the current
 *  call has unwound) so it can show the unlock prompt. */
function lockBecauseOfAnotherTab() {
  lockKeyVault();
  for (const listener of vault.lockListeners) {
    const call = () => { try { listener(); } catch { /* the app's problem */ } };
    if (typeof queueMicrotask === "function") queueMicrotask(call); else setTimeout(call, 0);
  }
}
/** True while the data key in memory still matches the stored password record (or the pending
 *  one). Otherwise another tab changed or removed the password: this tab is locked and false is
 *  returned (DSK-022). Cheap when nothing changed (the record text is compared first). */
function checkKeyStillCurrent() {
  if (!vault.dataKey) {
    // Pre-vault password verified in this tab: any change to the record elsewhere ends that.
    if (vault.legacyVerified && vault.verifiedFor !== storedRecordsText()) { lockBecauseOfAnotherTab(); return false; }
    return true;
  }
  const text = storedRecordsText();
  if (vault.verifiedFor === text) return true;
  if (keyIsCurrent(vault.dataKey)) { vault.verifiedFor = text; return true; }
  lockBecauseOfAnotherTab();
  return false;
}
/** Throws (and locks) unless `key` is this tab's data key and still the stored record's. */
function requireCurrentKey(key) {
  if (!key || key !== vault.dataKey) throw new Error("KaChat is locked. Enter your password first.");
  if (!checkKeyStillCurrent()) throw new Error(LOCKED_IN_ANOTHER_TAB_MESSAGE);
}

/** `listener()` runs when a write or read found this tab's data key replaced by another tab's
 *  password change and locked the vault. Returns an unsubscribe function. */
export function onKeyVaultLockedByAnotherTab(listener) {
  if (typeof listener !== "function") return () => {};
  vault.lockListeners.add(listener);
  return () => vault.lockListeners.delete(listener);
}
/** `listener()` runs (in a microtask) whenever this page's vault unlocks, locks (Log Out, another
 *  tab, a removed password) or is reset: anything holding an opened secret (the Nextcloud app
 *  password) reloads it then. Returns an unsubscribe function. */
export function onKeyVaultStateChanged(listener) {
  if (typeof listener !== "function") return () => {};
  vault.stateListeners.add(listener);
  return () => vault.stateListeners.delete(listener);
}
/**
 * For the `storage` event (fired only in OTHER tabs): when the password record or the pending
 * record changed elsewhere, this tab is locked at once, whatever the change was (a new password,
 * a removed one, a first one). `key` null means the other tab cleared storage. Returns true when
 * this tab held the key (or a verified pre-vault password) and is now locked. The caller shows the
 * lock: `isAppLocked()` says whether a password now has to be entered.
 */
export function keyVaultStorageChanged(key) {
  if (key != null && key !== APP_PASSWORD_KEY && key !== APP_PASSWORD_PENDING_KEY) return false;
  if (!vault.dataKey && !vault.legacyVerified) return false;
  lockKeyVault();
  return true;
}

/**
 * Just before a reload KaChat itself starts (sign-in, account switch, network switch): leaves the
 * data key for the next page load as a one-time hand-off that expires in 15 s. Also removed by a
 * timer after 15 s should the reload not happen. Returns whether one was written.
 */
export function writeKeyVaultHandoff() {
  if (!vault.dataKey || !checkKeyStillCurrent()) return false;
  const value = JSON.stringify({ key: bytesToHex(vault.dataKey), expiresAt: vault.now() + VAULT_HANDOFF_TTL_MS });
  try { ss()?.setItem(VAULT_HANDOFF_KEY, value); } catch { return false; }
  try {
    const timer = setTimeout(() => {
      try { if (ss()?.getItem(VAULT_HANDOFF_KEY) === value) ss()?.removeItem(VAULT_HANDOFF_KEY); } catch { /* gone */ }
    }, VAULT_HANDOFF_TTL_MS);
    timer?.unref?.();
  } catch { /* expiry is checked on read anyway */ }
  return true;
}
/** Removes an unused hand-off (e.g. the reload was cancelled). */
export function clearKeyVaultHandoff() {
  try { ss()?.removeItem(VAULT_HANDOFF_KEY); } catch { /* nothing stored */ }
}
/** Page load after one of KaChat's own reloads: takes the hand-off once (it is deleted before
 *  anything else), and unlocks only if it is well-formed, not expired and this vault's key.
 *  A reopened, restored or duplicated tab, or a manual refresh, has none and stays locked.
 *  Synchronous. */
export function unlockKeyVaultFromSession() {
  let raw = null;
  try { raw = ss()?.getItem(VAULT_HANDOFF_KEY) ?? null; } catch { raw = null; }
  clearSessionCopies(); // one read only; the pre-DSK-023 per-tab copy is never honoured
  if (vault.dataKey) return true;
  if (!raw || !isVaultEnabled()) return false;
  let handoff = null;
  try { handoff = JSON.parse(raw); } catch { return false; }
  if (!handoff || typeof handoff !== "object" || typeof handoff.key !== "string" || !/^[0-9a-f]{64}$/i.test(handoff.key)) return false;
  const left = Number(handoff.expiresAt) - vault.now();
  if (!Number.isFinite(left) || left < 0 || left > VAULT_HANDOFF_TTL_MS) return false;
  const key = hexToBytes(handoff.key);
  if (!keyIsCurrent(key)) return false;
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
  checkKeyStillCurrent(); // a key another tab's password change replaced opens nothing (DSK-022)
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
  // Another tab changed or removed the password: this tab's list was read under the old state
  // and its key would seal what the new password cannot open. Lock and write nothing (DSK-022).
  if ((vault.dataKey || vault.legacyVerified) && !checkKeyStillCurrent()) throw new Error(LOCKED_IN_ANOTHER_TAB_MESSAGE);
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
  if (!vault.dataKey || !checkKeyStillCurrent()) return "";
  try {
    const sealed = JSON.parse(ls().getItem(VAULT_LEGACY_WALLET_KEY) || "null");
    return sealed ? dec.decode(openBytes(vault.dataKey, sealed, LEGACY_WALLET_AAD)).trim() : "";
  } catch { return ""; }
}
/** Deletes the pre-v2 key once the caller has read it (and filed it). A sealed copy this tab
 *  cannot open (locked, or sealed under a key another tab made) was never read, so it stays
 *  (DSK-022). Returns whether no copy is left. */
export function clearLegacyWalletKey() {
  ls().removeItem(LEGACY_PERSISTED_WALLET_KEY);
  const raw = ls().getItem(VAULT_LEGACY_WALLET_KEY);
  if (raw == null) return true;
  if (!vault.dataKey || !checkKeyStillCurrent()) return false;
  try { openBytes(vault.dataKey, JSON.parse(raw), LEGACY_WALLET_AAD); } catch { return false; }
  ls().removeItem(VAULT_LEGACY_WALLET_KEY);
  return true;
}

// --- the Nextcloud app password ---------------------------------------------------------------
// ui/nextcloud.js keeps one connection per wallet under accountScopedKey("kachat-nextcloud-v1")
// (`kachat-account-data-v1:<address>:kachat-nextcloud-v1`; the bare key when no wallet is active).
// Without the vault: { server, username, appPassword, ... } in plaintext, as before. With it, the
// app password is the only secret and the only sealed field:
//   { server, username, userId, startFolder, backupFolder, autoBackup, ...,
//     appPasswordSealed: { v: 1, iv: hex(12), ct: hex } }
//   ct = AES-256-GCM(dataKey, UTF-8 app password, AAD = "kachat-nextcloud-app-password-v1|" +
//        JSON [storage key (names the wallet), server, username]); fresh IV on every write.
// So a sealed password cannot be moved to another wallet, server or login. The rest stays
// readable: Settings can show "Connected to <server> as <user>" while KaChat is locked.
export const NEXTCLOUD_STORAGE_KEY = "kachat-nextcloud-v1";
const NEXTCLOUD_AAD_PREFIX = "kachat-nextcloud-app-password-v1|";
const NEXTCLOUD_PRIVATE_FIELDS = ["appPassword", "appPasswordSealed", "locked", "unreadable"];

function isNextcloudStorageKey(key) {
  const name = String(key ?? "");
  return name === NEXTCLOUD_STORAGE_KEY || name.endsWith(`:${NEXTCLOUD_STORAGE_KEY}`);
}
function nextcloudStorageKeys() {
  const out = [];
  const store = ls();
  for (let i = 0; i < Number(store.length || 0); i += 1) {
    const key = store.key(i);
    if (key != null && isNextcloudStorageKey(key)) out.push(key);
  }
  return out;
}
function nextcloudPublicPart(record) {
  const out = { ...record };
  for (const field of NEXTCLOUD_PRIVATE_FIELDS) delete out[field];
  return out;
}
function nextcloudAad(storageKey, record) {
  return NEXTCLOUD_AAD_PREFIX + JSON.stringify([String(storageKey), String(record?.server || ""), String(record?.username || "")]);
}
function readRawNextcloud(storageKey) {
  try {
    const parsed = JSON.parse(ls().getItem(storageKey) || "null");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch { return null; }
}
function hasPlainNextcloudPassword(record) { return typeof record?.appPassword === "string" && record.appPassword !== ""; }
function hasSealedNextcloudPassword(record) { return !!(record?.appPasswordSealed?.iv && record?.appPasswordSealed?.ct); }
/** The stored record with its password sealed under `key` (checked to open again). */
function sealNextcloudWith(key, storageKey, record, password) {
  const value = String(password);
  const sealed = { v: 1, ...sealBytes(key, enc.encode(value), nextcloudAad(storageKey, record)) };
  if (openNextcloudWith(key, storageKey, record, sealed) !== value) throw new Error("Encrypted Nextcloud password failed verification.");
  return { ...nextcloudPublicPart(record), appPasswordSealed: sealed };
}
/** Throws when the key is wrong or the blob / server / login / wallet was altered. */
function openNextcloudWith(key, storageKey, record, sealed = record?.appPasswordSealed) {
  return dec.decode(openBytes(key, sealed, nextcloudAad(storageKey, record)));
}

/**
 * The Nextcloud connection stored under `storageKey`, or null when there is none. With the app
 * password in memory (`appPassword`) when it can be used: no app password set, or the vault is
 * unlocked and opens it. Otherwise public fields only, with `locked: true` (KaChat is locked) or
 * also `unreadable: true` (unlocked, but the sealed password does not open: reconnect). Never
 * returns an empty or made-up password. A plaintext password found while the vault is unlocked
 * is sealed on the spot.
 */
export function readNextcloudAccount(storageKey) {
  const record = readRawNextcloud(storageKey);
  if (!record || !record.server || !record.username) return null;
  checkKeyStillCurrent(); // a key another tab's password change replaced opens nothing (DSK-022)
  const pub = nextcloudPublicPart(record);
  if (isAppLocked()) return { ...pub, locked: true };
  if (hasPlainNextcloudPassword(record)) {
    const account = { ...pub, appPassword: record.appPassword };
    if (isVaultEnabled() && vault.dataKey) {
      try { writeNextcloudAccount(storageKey, account); } catch { /* sealed at the next write or unlock */ }
    }
    return account;
  }
  if (hasSealedNextcloudPassword(record) && vault.dataKey) {
    try {
      const appPassword = openNextcloudWith(vault.dataKey, storageKey, record);
      if (appPassword) return { ...pub, appPassword };
    } catch { /* wrong key or tampered */ }
  }
  return { ...pub, locked: true, unreadable: true };
}

/**
 * Writes the Nextcloud connection under `storageKey` (null removes it, allowed even while
 * locked: Disconnect). With the vault enabled the app password is sealed with a fresh IV and
 * checked to open; refuses while locked, or with a data key another tab's password change
 * replaced (DSK-022), rather than ever writing it in plaintext or under a stale key. Without the
 * vault: plaintext, as before. A record without a password in memory is refused, so a locked
 * copy can never overwrite the sealed one.
 */
export function writeNextcloudAccount(storageKey, account) {
  if ((vault.dataKey || vault.legacyVerified) && !checkKeyStillCurrent()) throw new Error(LOCKED_IN_ANOTHER_TAB_MESSAGE);
  if (!isNextcloudStorageKey(storageKey)) throw new Error("Not a Nextcloud connection key.");
  if (account == null) { ls().removeItem(storageKey); return; }
  if (!account.server || !account.username || !hasPlainNextcloudPassword(account)) throw new Error("The Nextcloud app password is not available. Nothing was saved.");
  if (!isVaultEnabled()) {
    ls().setItem(storageKey, JSON.stringify({ ...nextcloudPublicPart(account), appPassword: account.appPassword }));
    return;
  }
  if (!vault.dataKey) throw new Error("KaChat is locked. Enter your password before saving the Nextcloud connection.");
  requireCurrentKey(vault.dataKey);
  ls().setItem(storageKey, JSON.stringify(sealNextcloudWith(vault.dataKey, storageKey, account, account.appPassword)));
}

/** Every stored Nextcloud connection with its password in plaintext form (sealed ones opened
 *  with `key`). One that carries no password, or whose sealed password does not open with `key`
 *  (nobody can open it any more), comes back with `appPassword: null`: migrations delete it, so
 *  the user reconnects. */
function collectPlainNextcloud(key) {
  return nextcloudStorageKeys().map((storageKey) => {
    const raw = ls().getItem(storageKey);
    const record = readRawNextcloud(storageKey);
    if (!record) return null; // not JSON: not ours to touch
    let appPassword = null;
    if (hasPlainNextcloudPassword(record)) appPassword = record.appPassword;
    else if (hasSealedNextcloudPassword(record) && key) {
      try { appPassword = openNextcloudWith(key, storageKey, record) || null; } catch { appPassword = null; }
    }
    return { storageKey, raw, record: nextcloudPublicPart(record), appPassword };
  }).filter(Boolean);
}
function restoreNextcloud(items) {
  for (const item of items) {
    try { if (item.raw == null) ls().removeItem(item.storageKey); else ls().setItem(item.storageKey, item.raw); } catch { /* best effort */ }
  }
}
/** Writes every connection sealed under `key` (or in plaintext when `key` is null), reads each
 *  back and checks it, and restores all previous values if anything does not match. */
function writeNextcloudVerified(key, items) {
  try {
    for (const item of items) {
      if (!item.appPassword || !item.record.server || !item.record.username) { ls().removeItem(item.storageKey); continue; }
      const stored = key
        ? sealNextcloudWith(key, item.storageKey, item.record, item.appPassword)
        : { ...item.record, appPassword: item.appPassword };
      ls().setItem(item.storageKey, JSON.stringify(stored));
      const back = readRawNextcloud(item.storageKey);
      const opened = key ? openNextcloudWith(key, item.storageKey, back) : back?.appPassword;
      if (opened !== item.appPassword || (key && hasPlainNextcloudPassword(back))) throw new Error("mismatch");
    }
  } catch {
    restoreNextcloud(items);
    throw new Error("The Nextcloud connection could not be written back. Nothing was changed.");
  }
}
/** At unlock: seals any Nextcloud password still in plaintext (a connection made before the
 *  password, or by a build without this). Returns how many it sealed. */
function sealPlaintextNextcloud() {
  const key = vault.dataKey;
  if (!key) return 0;
  requireCurrentKey(key);
  const items = collectPlainNextcloud(null).filter((item) => item.appPassword);
  if (!items.length) return 0;
  writeNextcloudVerified(key, items);
  return items.length;
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
  requireCurrentKey(key);
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
  requireCurrentKey(key);
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
    catch {
      // Another tab upgraded the same record meanwhile: open what it wrote, with the same password.
      if (isVaultRecord(loadPasswordRecord()) || loadPendingRecord()) return unlockKeyVault(value);
      vault.legacyVerified = true; // stays plaintext; tried again at the next unlock
      vault.verifiedFor = storedRecordsText();
    }
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
  try { sealPlaintextNextcloud(); } catch { /* the plaintext Nextcloud password stays until the next write or unlock */ }
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
 *   2b. every Nextcloud app password sealed with the new key, read back and checked
 *   3. the record itself  4. pending removed  5. legacy key sealed, active-wallet record scrubbed.
 */
export async function setAppPassword(password) {
  const value = String(password ?? "");
  if (value.length < MIN_APP_PASSWORD_LENGTH) throw new Error(`Use at least ${MIN_APP_PASSWORD_LENGTH} characters.`);
  await writeNewVault(value);
}
async function writeNewVault(value) {
  if ((vault.dataKey || vault.legacyVerified) && !checkKeyStillCurrent()) throw new Error(LOCKED_IN_ANOTHER_TAB_MESSAGE);
  if (isVaultEnabled() && !vault.dataKey) throw new Error("Enter your current password first.");
  const oldKey = vault.dataKey;
  const recordsBefore = storedRecordsText();
  // Fail fast, before the slow key derivation, if something does not open.
  collectPlainAccounts(oldKey);
  plainLegacyWalletKey(oldKey);
  const dataKey = randomBytes(32);
  const record = await buildVaultRecord(value, dataKey);
  // The derivation took a while: another tab may have changed the password meanwhile (two tabs
  // upgrading a pre-vault record, or two password changes). Then this one stops (DSK-022).
  if (storedRecordsText() !== recordsBefore || vault.dataKey !== oldKey) {
    if (vault.dataKey === oldKey && oldKey) lockBecauseOfAnotherTab();
    throw new Error(LOCKED_IN_ANOTHER_TAB_MESSAGE);
  }
  // Collected again now, so accounts another tab saved during the derivation are not lost.
  const entries = collectPlainAccounts(oldKey);
  const legacyHex = plainLegacyWalletKey(oldKey);
  // The Nextcloud app passwords too (a sealed one that does not open with the old key is lost
  // already, and is deleted: that wallet reconnects Nextcloud).
  const nextcloud = collectPlainNextcloud(oldKey);
  const recordJson = JSON.stringify(record);
  const accountsBefore = ls().getItem(SAVED_ACCOUNTS_KEY);
  ls().setItem(APP_PASSWORD_PENDING_KEY, recordJson);
  try {
    writeSealedVerified(dataKey, entries);
    try {
      writeNextcloudVerified(dataKey, nextcloud);
    } catch (error) {
      if (accountsBefore == null) ls().removeItem(SAVED_ACCOUNTS_KEY); else ls().setItem(SAVED_ACCOUNTS_KEY, accountsBefore);
      throw error;
    }
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
 * written back as plaintext and checked (account keys, then the Nextcloud app passwords), and
 * only then is the password record deleted.
 */
export function removeAppPassword() {
  if (!hasAppPassword()) return;
  if ((vault.dataKey || vault.legacyVerified) && !checkKeyStillCurrent()) throw new Error(LOCKED_IN_ANOTHER_TAB_MESSAGE);
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
  // The Nextcloud app passwords back to plaintext too (checked), before the record goes.
  try {
    writeNextcloudVerified(null, collectPlainNextcloud(key));
  } catch {
    if (previous == null) ls().removeItem(SAVED_ACCOUNTS_KEY); else ls().setItem(SAVED_ACCOUNTS_KEY, previous);
    throw new Error("The Nextcloud connection could not be written back. The password was kept.");
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
 * Every Nextcloud connection with a sealed app password is removed too (the user reconnects).
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
  // A sealed Nextcloud app password cannot be opened either: the connection is removed, and the
  // user reconnects Nextcloud (a plaintext one, which needs no password, stays).
  for (const storageKey of nextcloudStorageKeys()) {
    const record = readRawNextcloud(storageKey);
    if (record && !hasPlainNextcloudPassword(record) && hasSealedNextcloudPassword(record)) ls().removeItem(storageKey);
  }
  ls().removeItem(APP_PASSWORD_KEY);
  ls().removeItem(APP_PASSWORD_PENDING_KEY);
  clearFailedAttempts();
  const wasOpen = !!(vault.dataKey || vault.legacyVerified);
  lockKeyVault();
  if (!wasOpen) notifyStateListeners(); // the Nextcloud connection is gone: let it reload
  return raw.length - kept.length;
}
