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
//   kachat-biometric-unlock-v1 (localStorage, account-independent like the password record) -
//     Face ID / Touch ID unlock: the same data key, wrapped a second time under a key only a
//     WebAuthn passkey's PRF extension can produce (ui/biometric-unlock.js runs the ceremony):
//     { version: 1, credentialId: base64url, userId: base64url, rpId, salt: hex(32),
//       iv: hex(12), wrappedDataKey: hex(32 + 16), createdAt }
//     wrappedDataKey = AES-256-GCM(HKDF-SHA256(prfOutput, salt = empty,
//       info = "kachat-biometric-unlock-v1"), dataKey, AAD = "kachat-biometric-unlock-v1|" +
//       credentialId). The PRF output is never stored, so the record opens nothing by itself. A
//     password change makes a new data key, so it drops the wrapped key and keeps only
//     { version, userId, rpId, retired: "password-changed" } (turning it on again reuses the
//     passkey's user handle, so the OS replaces that passkey instead of adding another). Removing
//     the password, the forgotten-password reset and releasing an unused password delete it.
//   kachat-vault-handoff-v1 (sessionStorage) - a one-time hand-off { key: hex(32), expiresAt }
//     written only just before a reload KaChat itself starts (sign-in, account switch, network
//     switch), so those don't ask again. The next page load takes it once and deletes it at once;
//     it is refused when expired (15 s), malformed or not this vault's key (DSK-023). Nothing else
//     ever puts the key in browser storage, so closing the tab locks KaChat, and "Reopen closed
//     tab", session restore, Duplicate tab and a manual refresh all ask for the password.
//     (kachat-vault-session-v1, the pre-DSK-023 per-tab copy, is deleted and never honoured.)
//
// Each account its own password (owner, 2026-10-22). The records above are the SHARED vault:
// every account saved before per-account passwords is sealed in it, so they keep their one
// password until one of them sets its own. An account with its own password has its own vault -
// the same record format, its own data key - in one map:
//   kachat-account-passwords-v1 - { "<canonical address>": { record?, pending? } }
//   kachat-account-biometric-v1 - { "<canonical address>": <Face ID record> }
// An account's keys (its registry entry's `sealed`, its Nextcloud app password) are sealed under
// its own vault when it has one, else under the shared vault when there is one, else stored in
// plaintext. Setting or changing a password from an account moves only that account to (or
// re-keys) its own vault; a new account gets its own, so adding one never needs another
// account's password. Unlocking a vault unlocks the accounts in it. Without an account in
// question (no `address` argument and no target configured) every export means the shared vault,
// exactly as before.
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
export const BIOMETRIC_UNLOCK_KEY = "kachat-biometric-unlock-v1";
export const ACCOUNT_PASSWORDS_KEY = "kachat-account-passwords-v1";
export const ACCOUNT_BIOMETRIC_KEY = "kachat-account-biometric-v1";
export const BIOMETRIC_HKDF_INFO = "kachat-biometric-unlock-v1";
const BIOMETRIC_WRAP_AAD_PREFIX = "kachat-biometric-unlock-v1|";
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
  keys: new Map(),        // vault id ("" = shared, else a canonical address) -> Uint8Array(32) while unlocked
  target: null,           // () => the account the address-less exports are about (the app's active one)
  legacyVerified: false,  // pre-vault password verified, but the upgrade could not be written (shared vault)
  opened: new Map(),      // ct hex -> opened secrets (cleared on lock / key change)
  verifiedFor: null,      // the stored record + pending text the data key was last checked against
  lockListeners: new Set(), // told when another tab's password change locked this one
  stateListeners: new Set(), // told (after the call unwinds) whenever the vault locks or unlocks
  now: () => Date.now(),
};

/** Wires storage (tests pass in-memory stand-ins), the address canonicalizer, `target` (a function
 *  returning the account the address-less exports are about: the app's active or picked account)
 *  and, for tests only, a lower iteration count for NEW records and a clock. */
export function configureKeyVault({ storage, session, canonicalize, iterations, now, target } = {}) {
  if (storage !== undefined) vault.storage = storage;
  if (target !== undefined) vault.target = typeof target === "function" ? target : null;
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

// --- password records: the shared vault and one per account ----------------------------------
function parseRecordValue(value) {
  return value && typeof value === "object" && typeof value.salt === "string" && typeof value.hash === "string" ? value : null;
}
function parseRecord(raw) {
  try { return parseRecordValue(JSON.parse(raw || "null")); } catch { return null; } // corrupted = none
}
function isVaultRecord(record) {
  return !!(record && Number(record.version) >= 2 && Number(record.iterations) > 0 && record.wrappedKey?.iv && record.wrappedKey?.ct);
}
const SHARED = "";
function canon(address) { return address ? String(vault.canonicalize(address) || "") : ""; }
function readAccountPasswordMap() {
  try {
    const parsed = JSON.parse(ls().getItem(ACCOUNT_PASSWORDS_KEY) || "null");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}
function writeAccountPasswordSlot(id, field, json) {
  const map = readAccountPasswordMap();
  const slot = { ...(map[id] && typeof map[id] === "object" ? map[id] : {}) };
  if (json == null) delete slot[field]; else slot[field] = JSON.parse(json);
  if (Object.keys(slot).length) map[id] = slot; else delete map[id];
  if (Object.keys(map).length) ls().setItem(ACCOUNT_PASSWORDS_KEY, JSON.stringify(map));
  else ls().removeItem(ACCOUNT_PASSWORDS_KEY);
}
/** The stored record text of vault `id` (null when none): the shared keys, or the account map. */
function recordRaw(id) {
  if (!id) return ls().getItem(APP_PASSWORD_KEY);
  const value = readAccountPasswordMap()[id]?.record;
  return value == null ? null : JSON.stringify(value);
}
function pendingRaw(id) {
  if (!id) return ls().getItem(APP_PASSWORD_PENDING_KEY);
  const value = readAccountPasswordMap()[id]?.pending;
  return value == null ? null : JSON.stringify(value);
}
function setRecordRaw(id, json) {
  if (!id) { if (json == null) ls().removeItem(APP_PASSWORD_KEY); else ls().setItem(APP_PASSWORD_KEY, json); return; }
  writeAccountPasswordSlot(id, "record", json);
}
function setPendingRaw(id, json) {
  if (!id) { if (json == null) ls().removeItem(APP_PASSWORD_PENDING_KEY); else ls().setItem(APP_PASSWORD_PENDING_KEY, json); return; }
  writeAccountPasswordSlot(id, "pending", json);
}
function recordFor(id) { return parseRecord(recordRaw(id)); }
function pendingFor(id) {
  const record = parseRecord(pendingRaw(id));
  return isVaultRecord(record) ? record : null;
}
function vaultExists(id) { return !!(recordFor(id) || pendingFor(id)); }
function vaultEnabled(id) { return id != null && (isVaultRecord(recordFor(id)) || !!pendingFor(id)); }
/** Accounts with their own vault (a record, or the pending record of one being set). */
function ownVaultIds() {
  return Object.keys(readAccountPasswordMap()).filter((id) => id && vaultExists(id));
}
function hasOwnVault(address) { const id = canon(address); return !!id && vaultExists(id); }
/** The vault `address`'s keys are sealed in: its own, else the shared one, else null (none). */
function vaultIdOf(address) {
  if (hasOwnVault(address)) return canon(address);
  return vaultExists(SHARED) ? SHARED : null;
}
/** The account an address-less call is about: the configured target (the app's active or picked
 *  account), else none - the shared vault, as before per-account passwords. */
function targetAddress(address) {
  if (address !== undefined && address !== null) return String(address);
  try { return String(vault.target?.() || ""); } catch { return ""; }
}
/** `address` is an account this device knows: in the registry, or the pre-registry active wallet. */
function knownAccount(address) {
  const id = canon(address);
  if (!id) return false;
  if (readRawAccounts().some((entry) => entry?.address && canon(entry.address) === id)) return true;
  try { return canon(JSON.parse(ls().getItem(PERSISTED_WALLET_KEY) || "null")?.address) === id; } catch { return false; }
}
function heldKey(id) { return id == null ? null : vault.keys.get(id) || null; }
/** True for the storage keys that hold password records (the `storage` event's filter). */
export function isPasswordStorageKey(key) {
  return key === APP_PASSWORD_KEY || key === APP_PASSWORD_PENDING_KEY || key === ACCOUNT_PASSWORDS_KEY;
}
/** True for the storage keys that hold Face ID records. */
export function isBiometricStorageKey(key) { return key === BIOMETRIC_UNLOCK_KEY || key === ACCOUNT_BIOMETRIC_KEY; }

/** The shared vault's stored record (what `kachat-app-password-v1` holds), or null. */
export function loadPasswordRecord() { return recordFor(SHARED); }
function loadPendingRecord() { return pendingFor(SHARED); }

/** `address` (default: the target account) has a password: its own, or the shared one it was saved
 *  under. With no account in question: whether any password exists on this device. A new account
 *  (not saved yet, no password of its own) has none - the shared password is not asked for it. */
export function hasAppPassword(address) {
  const target = targetAddress(address);
  if (!target) return vaultExists(SHARED) || ownVaultIds().length > 0;
  if (hasOwnVault(target)) return true;
  return vaultExists(SHARED) && knownAccount(target);
}
/** `address`'s secrets are (or are to be) stored encrypted. */
export function isVaultEnabled(address) {
  const target = targetAddress(address);
  if (!target) return vaultEnabled(SHARED);
  return hasAppPassword(target) && vaultEnabled(vaultIdOf(target));
}
export function isVaultUnlocked(address) {
  checkKeyStillCurrent();
  const target = targetAddress(address);
  return !!heldKey(target ? vaultIdOf(target) : SHARED);
}
/** `address` has a password that has not been entered in this page (or another tab changed it
 *  since): it may not sign in. */
export function isAppLocked(address) {
  checkKeyStillCurrent();
  const target = targetAddress(address);
  const id = target ? (hasAppPassword(target) ? vaultIdOf(target) : null) : (vaultExists(SHARED) ? SHARED : null);
  if (id == null) return false;
  if (id === SHARED) return !heldKey(SHARED) && !vault.legacyVerified;
  return !heldKey(id);
}

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
/** `key` is the one vault `id`'s stored record wraps (or the pending record of a password change
 *  that is being written). A record from before keyCheck existed is checked against the store. */
function keyIsCurrent(key, id = SHARED) {
  if (!key || key.length !== 32) return false;
  const record = recordFor(id);
  const pending = pendingFor(id);
  if (isVaultRecord(record) && (record.keyCheck ? keyMatchesRecord(key, record) : keyOpensStore(key, id))) return true;
  return !!(pending?.keyCheck && keyMatchesRecord(key, pending));
}
function storedRecordsText() {
  return `${ls().getItem(APP_PASSWORD_KEY)}\u0000${ls().getItem(APP_PASSWORD_PENDING_KEY)}\u0000${ls().getItem(ACCOUNT_PASSWORDS_KEY)}`;
}
function notifyStateListeners() {
  for (const listener of vault.stateListeners) {
    const call = () => { try { listener(); } catch { /* the listener's problem */ } };
    if (typeof queueMicrotask === "function") queueMicrotask(call); else setTimeout(call, 0);
  }
}
function setUnlocked(key, id = SHARED) {
  vault.keys.set(id, key);
  if (id === SHARED) vault.legacyVerified = false;
  vault.opened.clear();
  vault.verifiedFor = null;
  // Memory only (DSK-023): nothing here survives the page. See writeKeyVaultHandoff.
  notifyStateListeners();
}
function clearSessionCopies() {
  try { ss()?.removeItem(VAULT_HANDOFF_KEY); } catch { /* nothing stored */ }
  try { ss()?.removeItem(VAULT_SESSION_KEY); } catch { /* nothing stored */ }
}
/** Forgets every data key and opened secret (Log Out, or locked by another tab). */
export function lockKeyVault() {
  const wasOpen = !!(vault.keys.size || vault.legacyVerified);
  vault.keys.clear();
  vault.legacyVerified = false;
  vault.opened.clear();
  vault.verifiedFor = null;
  clearSessionCopies();
  if (wasOpen) notifyStateListeners();
}
/** Forgets one vault's key (its password was removed or reset); the others stay open. */
function forgetVaultKey(id) {
  if (!vault.keys.has(id) && !(id === SHARED && vault.legacyVerified)) return;
  vault.keys.delete(id);
  if (id === SHARED) vault.legacyVerified = false;
  vault.opened.clear();
  vault.verifiedFor = null;
  notifyStateListeners();
}

/** Called when a data key turned out to be stale: lock, and tell the app (once the current
 *  call has unwound) so it can show the unlock prompt. */
function lockBecauseOfAnotherTab() {
  lockKeyVault();
  for (const listener of vault.lockListeners) {
    const call = () => { try { listener(); } catch { /* the app's problem */ } };
    if (typeof queueMicrotask === "function") queueMicrotask(call); else setTimeout(call, 0);
  }
}
/** True while every data key in memory still matches its stored password record (or pending
 *  one). Otherwise another tab changed or removed a password: this tab is locked and false is
 *  returned (DSK-022). Cheap when nothing changed (the record text is compared first). Another
 *  account setting its own password elsewhere changes the text but leaves every key current. */
function checkKeyStillCurrent() {
  if (!vault.keys.size) {
    // Pre-vault password verified in this tab: any change to the record elsewhere ends that.
    if (vault.legacyVerified && vault.verifiedFor !== storedRecordsText()) { lockBecauseOfAnotherTab(); return false; }
    return true;
  }
  const text = storedRecordsText();
  if (vault.verifiedFor === text) return true;
  for (const [id, key] of vault.keys) {
    if (!keyIsCurrent(key, id)) { lockBecauseOfAnotherTab(); return false; }
  }
  vault.verifiedFor = text;
  return true;
}
/** Throws (and locks) unless `key` is this tab's key for vault `id` and still its stored record's. */
function requireCurrentKey(key, id = SHARED) {
  if (!key || key !== heldKey(id)) throw new Error("KaChat is locked. Enter your password first.");
  if (!checkKeyStillCurrent()) throw new Error(LOCKED_IN_ANOTHER_TAB_MESSAGE);
}

/** `listener()` runs when a write or read found one of this tab's data keys replaced by another
 *  tab's password change and locked the vault. Returns an unsubscribe function. */
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
 * For the `storage` event (fired only in OTHER tabs). The shared record or its pending record
 * changed elsewhere: this tab is locked at once, whatever the change was (a new password, a removed
 * one, a first one). The per-account map changed: this tab is locked only when a key it holds is
 * no longer its account's (another account setting its own password changes nothing here). `key`
 * null means the other tab cleared storage. Returns true when this tab held a key (or a verified
 * pre-vault password) and is now locked. The caller shows the lock: `isAppLocked()` says whether
 * a password now has to be entered.
 */
export function keyVaultStorageChanged(key) {
  if (key != null && !isPasswordStorageKey(key)) return false;
  if (!vault.keys.size && !vault.legacyVerified) return false;
  if (key === ACCOUNT_PASSWORDS_KEY) {
    vault.verifiedFor = null;
    return !checkKeyStillCurrent();
  }
  lockKeyVault();
  return true;
}

/**
 * Just before a reload KaChat itself starts (sign-in, account switch, network switch): leaves the
 * data keys for the next page load as a one-time hand-off that expires in 15 s. Also removed by a
 * timer after 15 s should the reload not happen. Returns whether one was written.
 */
export function writeKeyVaultHandoff() {
  if (!vault.keys.size || !checkKeyStillCurrent()) return false;
  const keys = {};
  for (const [id, key] of vault.keys) keys[id] = bytesToHex(key);
  const payload = { keys, expiresAt: vault.now() + VAULT_HANDOFF_TTL_MS };
  if (vault.keys.has(SHARED)) payload.key = keys[SHARED];
  const value = JSON.stringify(payload);
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
 *  anything else), and unlocks each vault whose key in it is well-formed, not expired and that
 *  vault's key. A reopened, restored or duplicated tab, or a manual refresh, has none and stays
 *  locked. Synchronous. True when anything was unlocked. */
export function unlockKeyVaultFromSession() {
  let raw = null;
  try { raw = ss()?.getItem(VAULT_HANDOFF_KEY) ?? null; } catch { raw = null; }
  clearSessionCopies(); // one read only; the pre-DSK-023 per-tab copy is never honoured
  if (vault.keys.size) return true;
  if (!raw) return false;
  let handoff = null;
  try { handoff = JSON.parse(raw); } catch { return false; }
  if (!handoff || typeof handoff !== "object") return false;
  const left = Number(handoff.expiresAt) - vault.now();
  if (!Number.isFinite(left) || left < 0 || left > VAULT_HANDOFF_TTL_MS) return false;
  const offered = handoff.keys && typeof handoff.keys === "object" && !Array.isArray(handoff.keys)
    ? Object.entries(handoff.keys)
    : (typeof handoff.key === "string" ? [[SHARED, handoff.key]] : []);
  let opened = false;
  for (const [id, hex] of offered) {
    if (typeof hex !== "string" || !/^[0-9a-f]{64}$/i.test(hex) || !vaultEnabled(id)) continue;
    const key = hexToBytes(hex);
    if (!keyIsCurrent(key, id)) continue;
    setUnlocked(key, id);
    opened = true;
  }
  return opened;
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
function openCached(key, address, sealed) {
  const cacheKey = `${vault.canonicalize(address)}|${sealed?.ct}`;
  if (vault.opened.has(cacheKey)) return vault.opened.get(cacheKey);
  const secrets = openSecretsWith(key, address, sealed);
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
 * secrets merged in while their vault is unlocked; while it is locked (or if one does not open)
 * they come back with public fields only and `locked: true`. Either way `sealed` rides along, so
 * writing the list back keeps a blob it could not open.
 */
export function readAccountRecords() {
  checkKeyStillCurrent(); // a key another tab's password change replaced opens nothing (DSK-022)
  return readRawAccounts().map((entry) => {
    if (!entry || typeof entry !== "object" || !entry.sealed) return entry;
    const key = heldKey(vaultIdOf(entry.address));
    if (key) {
      try { return { ...publicPart(entry), ...openCached(key, entry.address, entry.sealed), sealed: entry.sealed }; }
      catch { /* wrong key or tampered: leave it sealed */ }
    }
    return { ...publicPart(entry), sealed: entry.sealed, locked: true };
  });
}

/** One registry entry as stored: its secrets sealed under `key` (checked to open again), a blob it
 *  could not open kept as it is, never a `locked` marker. */
function sealEntry(key, entry) {
  if (!entry || typeof entry !== "object") return entry;
  if (hasSecrets(entry)) {
    const sealed = sealSecretsWith(key, entry.address, entry);
    // Never store what does not open again.
    if (!sameSecrets(openSecretsWith(key, entry.address, sealed), entry)) throw new Error("Encrypted account record failed verification.");
    return { ...publicPart(entry), sealed };
  }
  if (entry.sealed) return { ...publicPart(entry), sealed: entry.sealed };
  return publicPart(entry);
}
/** One registry entry stored in plaintext (an account with no password). */
function plainEntry(entry) {
  if (!entry || typeof entry !== "object") return entry;
  const out = { ...entry };
  delete out.locked;
  if (hasSecrets(entry)) delete out.sealed;
  return out;
}

/**
 * Writes the account registry. Every entry that carries secrets is sealed under its account's
 * vault (its own, else the shared one) with a fresh IV, and checked to decrypt, before anything is
 * written; refuses while that vault is locked rather than ever writing a secret in plaintext. An
 * account with no password at all (no vault of its own and none shared): plaintext, as before.
 */
export function writeAccountRecords(entries) {
  const list = Array.isArray(entries) ? entries : [];
  // Another tab changed or removed a password: this tab's list was read under the old state and
  // its key would seal what the new password cannot open. Lock and write nothing (DSK-022).
  if ((vault.keys.size || vault.legacyVerified) && !checkKeyStillCurrent()) throw new Error(LOCKED_IN_ANOTHER_TAB_MESSAGE);
  const out = list.map((entry) => {
    if (!entry || typeof entry !== "object") return entry;
    const id = vaultIdOf(entry.address);
    if (!vaultEnabled(id)) return plainEntry(entry);
    if (!hasSecrets(entry)) return sealEntry(null, entry);
    const key = heldKey(id);
    if (!key) throw new Error("KaChat is locked. Enter your password before saving an account on this device.");
    return sealEntry(key, entry);
  });
  ls().setItem(SAVED_ACCOUNTS_KEY, JSON.stringify(out));
}

/** The record for the active-wallet key: secrets stripped while its account's vault is on. */
export function persistedWalletRecordForStorage(payload) {
  return vaultEnabled(vaultIdOf(payload?.address)) ? publicPart(payload) : { ...payload };
}

/** The pre-v2 bare-hex wallet key: plaintext without the shared vault, sealed with it. */
export function readLegacyWalletKey() {
  const plain = String(ls().getItem(LEGACY_PERSISTED_WALLET_KEY) || "").trim();
  if (plain) return plain;
  const key = heldKey(SHARED);
  if (!key || !checkKeyStillCurrent()) return "";
  try {
    const sealed = JSON.parse(ls().getItem(VAULT_LEGACY_WALLET_KEY) || "null");
    return sealed ? dec.decode(openBytes(key, sealed, LEGACY_WALLET_AAD)).trim() : "";
  } catch { return ""; }
}
/** Deletes the pre-v2 key once the caller has read it (and filed it). A sealed copy this tab
 *  cannot open (locked, or sealed under a key another tab made) was never read, so it stays
 *  (DSK-022). Returns whether no copy is left. */
export function clearLegacyWalletKey() {
  ls().removeItem(LEGACY_PERSISTED_WALLET_KEY);
  const raw = ls().getItem(VAULT_LEGACY_WALLET_KEY);
  if (raw == null) return true;
  const key = heldKey(SHARED);
  if (!key || !checkKeyStillCurrent()) return false;
  try { openBytes(key, JSON.parse(raw), LEGACY_WALLET_AAD); } catch { return false; }
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
const NEXTCLOUD_SCOPE_PREFIX = "kachat-account-data-v1:";
/** The account a Nextcloud storage key belongs to ("" for the bare, wallet-less key). */
function nextcloudAccountOf(storageKey) {
  const name = String(storageKey ?? "");
  const tail = `:${NEXTCLOUD_STORAGE_KEY}`;
  if (!name.startsWith(NEXTCLOUD_SCOPE_PREFIX) || !name.endsWith(tail)) return "";
  return name.slice(NEXTCLOUD_SCOPE_PREFIX.length, name.length - tail.length);
}
/** The vault a Nextcloud connection is sealed in: its account's (the shared one for the bare key). */
function nextcloudVaultId(storageKey) { return vaultIdOf(nextcloudAccountOf(storageKey)); }
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
  const id = nextcloudVaultId(storageKey);
  const key = heldKey(id);
  if (id != null && !key && !(id === SHARED && vault.legacyVerified)) return { ...pub, locked: true };
  if (hasPlainNextcloudPassword(record)) {
    const account = { ...pub, appPassword: record.appPassword };
    if (vaultEnabled(id) && key) {
      try { writeNextcloudAccount(storageKey, account); } catch { /* sealed at the next write or unlock */ }
    }
    return account;
  }
  if (hasSealedNextcloudPassword(record) && key) {
    try {
      const appPassword = openNextcloudWith(key, storageKey, record);
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
  if ((vault.keys.size || vault.legacyVerified) && !checkKeyStillCurrent()) throw new Error(LOCKED_IN_ANOTHER_TAB_MESSAGE);
  if (!isNextcloudStorageKey(storageKey)) throw new Error("Not a Nextcloud connection key.");
  if (account == null) { ls().removeItem(storageKey); return; }
  if (!account.server || !account.username || !hasPlainNextcloudPassword(account)) throw new Error("The Nextcloud app password is not available. Nothing was saved.");
  const id = nextcloudVaultId(storageKey);
  if (!vaultEnabled(id)) {
    ls().setItem(storageKey, JSON.stringify({ ...nextcloudPublicPart(account), appPassword: account.appPassword }));
    return;
  }
  const key = heldKey(id);
  if (!key) throw new Error("KaChat is locked. Enter your password before saving the Nextcloud connection.");
  requireCurrentKey(key, id);
  ls().setItem(storageKey, JSON.stringify(sealNextcloudWith(key, storageKey, account, account.appPassword)));
}

/** Every stored Nextcloud connection with its password in plaintext form (sealed ones opened
 *  with `key`). One that carries no password, or whose sealed password does not open with `key`
 *  (nobody can open it any more), comes back with `appPassword: null`: migrations delete it, so
 *  the user reconnects. */
function collectPlainNextcloud(key, include = () => true) {
  return nextcloudStorageKeys().filter((storageKey) => include(storageKey)).map((storageKey) => {
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
/** At unlock of vault `id`: seals any of its accounts' Nextcloud passwords still in plaintext (a
 *  connection made before the password, or by a build without this). Returns how many it sealed. */
function sealPlaintextNextcloud(id = SHARED) {
  const key = heldKey(id);
  if (!key) return 0;
  requireCurrentKey(key, id);
  const items = collectPlainNextcloud(null, (storageKey) => nextcloudVaultId(storageKey) === id).filter((item) => item.appPassword);
  if (!items.length) return 0;
  writeNextcloudVerified(key, items);
  return items.length;
}

// --- which entries a step works on ----------------------------------------------------------
/** The vault an address-less or account call is about: the target account's (none for an account
 *  without a password), or the shared vault when there is no account in question. */
function vaultForTarget(address) {
  const target = targetAddress(address);
  if (target) return hasAppPassword(target) ? vaultIdOf(target) : null;
  return vaultExists(SHARED) ? SHARED : null;
}
/** Registry entries (and storage) of one account. */
function ofAccount(address) {
  const id = canon(address);
  return (entry) => !!id && !!entry && typeof entry === "object" && canon(entry.address) === id;
}
/** Entries the shared vault holds: every account without a vault of its own. */
function notOwn(entry) { return !!entry && typeof entry === "object" && !hasOwnVault(entry.address); }

// --- migration ------------------------------------------------------------------------------
/** Everything the vault must hold, in plaintext form: the registry with the entries `mine` picks
 *  opened with `key` (throws if one does not open; the others as stored), plus a pre-registry
 *  active-wallet record not yet in it when it is `mine`. */
function collectPlainAccounts(key, mine = () => true) {
  const entries = readRawAccounts().map((entry) => {
    if (!entry || typeof entry !== "object" || !entry.sealed || hasSecrets(entry) || !mine(entry)) return entry;
    if (!key) throw new Error("KaChat is locked.");
    try { return { ...publicPart(entry), ...openSecretsWith(key, entry.address, entry.sealed) }; }
    catch { throw new Error(`A saved account (${String(entry.address || "").slice(-8)}) could not be decrypted. Nothing was changed.`); }
  });
  let wallet = null;
  try { wallet = JSON.parse(ls().getItem(PERSISTED_WALLET_KEY) || "null"); } catch { wallet = null; }
  return collectPlainAccountsFrom(entries, wallet, mine);
}
function plainLegacyWalletKey(key) {
  const plain = String(ls().getItem(LEGACY_PERSISTED_WALLET_KEY) || "").trim();
  if (plain) return plain;
  const raw = ls().getItem(VAULT_LEGACY_WALLET_KEY);
  if (!raw) return "";
  if (!key) throw new Error("KaChat is locked.");
  return dec.decode(openBytes(key, JSON.parse(raw), LEGACY_WALLET_AAD)).trim();
}

/** Writes `entries` with the ones `mine` picks sealed with `key` (the rest as they are), reads
 *  them back and checks every sealed secret, and restores the previous value if anything does not
 *  match. */
function writeSealedVerified(key, entries, mine = () => true) {
  const previous = ls().getItem(SAVED_ACCOUNTS_KEY);
  const stored = entries.map((entry) => (mine(entry) ? sealEntry(key, entry) : entry));
  ls().setItem(SAVED_ACCOUNTS_KEY, JSON.stringify(stored));
  try {
    const back = readRawAccounts();
    entries.forEach((entry, index) => {
      if (!entry || typeof entry !== "object" || !hasSecrets(entry) || !mine(entry)) return;
      if (!sameSecrets(openSecretsWith(key, back[index]?.address, back[index]?.sealed), entry)) throw new Error("mismatch");
    });
  } catch {
    if (previous == null) ls().removeItem(SAVED_ACCOUNTS_KEY); else ls().setItem(SAVED_ACCOUNTS_KEY, previous);
    throw new Error("Encrypted accounts could not be verified. Nothing was changed.");
  }
}
/** Seals the legacy key under the shared vault (verified) and only then deletes the plaintext copy. */
function sealLegacyWalletKey(key, hex) {
  requireCurrentKey(key, SHARED);
  if (!hex) { ls().removeItem(VAULT_LEGACY_WALLET_KEY); return; }
  const sealed = sealBytes(key, enc.encode(hex), LEGACY_WALLET_AAD);
  if (dec.decode(openBytes(key, sealed, LEGACY_WALLET_AAD)) !== hex) throw new Error("Legacy wallet key failed verification.");
  ls().setItem(VAULT_LEGACY_WALLET_KEY, JSON.stringify(sealed));
  ls().removeItem(LEGACY_PERSISTED_WALLET_KEY);
}
/** The active-wallet record without its secrets (they are in the sealed registry now), when it is
 *  `mine`. */
function scrubPersistedWallet(mine = () => true) {
  try {
    const wallet = JSON.parse(ls().getItem(PERSISTED_WALLET_KEY) || "null");
    if (!wallet || !hasSecrets(wallet) || !mine(wallet)) return;
    const out = publicPart(wallet);
    if (out.address) out.address = vault.canonicalize(out.address);
    ls().setItem(PERSISTED_WALLET_KEY, JSON.stringify(out));
  } catch { ls().removeItem(PERSISTED_WALLET_KEY); }
}

/** First unlock of vault `id` after the update (or a record written while something was
 *  plaintext): seal every plaintext secret of its accounts, verify, then delete the plaintext
 *  copies. Returns what it sealed. */
function migratePlaintextIntoVault(id = SHARED) {
  const key = heldKey(id);
  if (!key) return 0;
  requireCurrentKey(key, id);
  const mine = id === SHARED ? notOwn : ofAccount(id);
  const raw = readRawAccounts();
  let wallet = null;
  try { wallet = JSON.parse(ls().getItem(PERSISTED_WALLET_KEY) || "null"); } catch { wallet = null; }
  const plainLegacy = id === SHARED ? String(ls().getItem(LEGACY_PERSISTED_WALLET_KEY) || "").trim() : "";
  const plainCount = raw.filter((entry) => hasSecrets(entry) && mine(entry)).length;
  if (!plainCount && !(hasSecrets(wallet) && mine(wallet)) && !plainLegacy) return 0;
  // Sealed entries that do not open with this key are kept as they are (never dropped).
  const entries = raw.map((entry) => {
    if (!entry || typeof entry !== "object" || !entry.sealed || hasSecrets(entry) || !mine(entry)) return entry;
    try { return { ...publicPart(entry), ...openSecretsWith(key, entry.address, entry.sealed) }; } catch { return entry; }
  });
  const merged = collectPlainAccountsFrom(entries, wallet, mine);
  writeSealedVerified(key, merged, (entry) => mine(entry) && hasSecrets(entry));
  if (plainLegacy) sealLegacyWalletKey(key, plainLegacy);
  scrubPersistedWallet(mine);
  vault.opened.clear();
  return plainCount;
}
function collectPlainAccountsFrom(entries, wallet, mine = () => true) {
  const address = String(wallet?.address || "").trim();
  if (!address || !wallet?.privateKeyHex || !mine(wallet)) return entries;
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
function firstSealedEntry(id = SHARED) {
  return readRawAccounts().find((entry) => entry?.sealed && !hasSecrets(entry) && vaultIdOf(entry.address) === id) || null;
}
function keyOpensStore(key, id = SHARED) {
  const probe = firstSealedEntry(id);
  if (!probe) return true;
  try { openSecretsWith(key, probe.address, probe.sealed); return true; } catch { return false; }
}

/**
 * The one "unlocked" step both the password and Face ID / Touch ID take once they hold vault
 * `id`'s data key (already checked to be its stored record's, or the pending record's when
 * `fromPending`): lockout reset, an interrupted password change finished, the key in memory
 * (listeners told; the session hand-off reads it from there), then any plaintext left over sealed.
 */
function openVaultWithDataKey(key, { id = SHARED, pending = pendingFor(id), fromPending = false } = {}) {
  clearFailedAttempts();
  if (fromPending) setRecordRaw(id, pendingRaw(id));
  if (pending && keyOpensStore(key, id)) setPendingRaw(id, null);
  setUnlocked(key, id);
  try { migratePlaintextIntoVault(id); } catch { /* plaintext copies stay until the next unlock */ }
  try { sealPlaintextNextcloud(id); } catch { /* the plaintext Nextcloud password stays until the next write or unlock */ }
}

/**
 * Checks `password` against `address`'s vault (default: the target account; none = the shared
 * vault) and unlocks it - with the shared vault, every account still in it. Counts wrong answers
 * toward the lockout. A pre-vault (shared) record is verified the old way, then replaced by a
 * vault record with every plaintext secret sealed. An interrupted password change is finished
 * here. Never throws for a wrong password.
 */
export async function unlockKeyVault(password, address) {
  if (appPasswordLockoutRemainingSeconds() != null) return false;
  const value = String(password ?? "");
  const id = vaultForTarget(address);
  if (id == null) return false;
  const record = recordFor(id);
  const pending = pendingFor(id);
  if (!record && !pending) return false;

  let key = null;
  let fromPending = false;
  if (isVaultRecord(record)) {
    key = await openVaultRecord(record, value);
    if (key && pending && !keyOpensStore(key, id)) key = null; // the store was re-sealed with the pending key
  }
  if (!key && pending) {
    // Only a pending record whose key opens what is stored may take over; otherwise the store is
    // still under the current record and promoting would strand it.
    const candidate = await openVaultRecord(pending, value);
    if (candidate && keyOpensStore(candidate, id)) { key = candidate; fromPending = true; }
  }
  if (!key && id === SHARED && record && !isVaultRecord(record)) {
    // Pre-vault record: a single SHA-256. Verified the old way once, then replaced (with the
    // same password, whatever its length) by a vault record with every plaintext secret sealed.
    if (!(await legacyPasswordMatches(record, value))) { recordFailedAttempt(); return false; }
    clearFailedAttempts();
    try { await writeNewVault(value); }
    catch {
      // Another tab upgraded the same record meanwhile: open what it wrote, with the same password.
      if (isVaultRecord(loadPasswordRecord()) || loadPendingRecord()) return unlockKeyVault(value, "");
      vault.legacyVerified = true; // stays plaintext; tried again at the next unlock
      vault.verifiedFor = storedRecordsText();
    }
    return true;
  }
  if (!key) { recordFailedAttempt(); return false; }
  openVaultWithDataKey(key, { id, pending, fromPending });
  // A record from a weaker work factor: the password is known good right now, so re-wrap.
  const current = recordFor(id);
  if (isVaultRecord(current) && Number(current.iterations) < VAULT_PBKDF2_ITERATIONS && vault.iterations >= VAULT_PBKDF2_ITERATIONS) {
    try {
      const upgraded = await buildVaultRecord(value, key);
      setRecordRaw(id, JSON.stringify(upgraded));
    } catch { /* next time */ }
  }
  return true;
}

/**
 * Sets a password. For an account (`address`, default: the target account) it is that account's
 * own: a first password, a change of its own, or moving it out of the shared vault - only its keys
 * are re-encrypted, every other account keeps its password. With no account in question it is the
 * shared vault's (the caller has verified the old one, which unlocked it). A fresh data key and
 * salt are made every time. Order, so a crash at any point leaves something the user's password
 * opens:
 *   1. pending record (new password)  2. its entries sealed with the new key, read back and checked
 *   2b. its Nextcloud app passwords sealed with the new key, read back and checked
 *   3. the record itself  4. pending removed  5. legacy key sealed, active-wallet record scrubbed.
 */
export async function setAppPassword(password, address) {
  const value = String(password ?? "");
  if (value.length < MIN_APP_PASSWORD_LENGTH) throw new Error(`Use at least ${MIN_APP_PASSWORD_LENGTH} characters.`);
  const target = targetAddress(address);
  await writeNewVault(value, target ? { ownAddress: target } : {});
}
async function writeNewVault(value, { ownAddress = "" } = {}) {
  const id = ownAddress ? canon(ownAddress) : SHARED;
  if (ownAddress && !id) throw new Error("No account to set a password for.");
  if ((vault.keys.size || vault.legacyVerified) && !checkKeyStillCurrent()) throw new Error(LOCKED_IN_ANOTHER_TAB_MESSAGE);
  // Where these keys are sealed now: the account's vault (its own or the shared one), or the
  // shared vault itself; null when they are plaintext.
  const fromId = ownAddress ? (hasAppPassword(ownAddress) ? vaultIdOf(ownAddress) : null) : (vaultExists(SHARED) ? SHARED : null);
  const oldKey = vaultEnabled(fromId) ? heldKey(fromId) : null;
  if (vaultEnabled(fromId) && !oldKey) throw new Error("Enter your current password first.");
  const mine = ownAddress ? ofAccount(ownAddress) : notOwn;
  const ncMine = ownAddress
    ? (storageKey) => !!id && canon(nextcloudAccountOf(storageKey)) === id
    : (storageKey) => !hasOwnVault(nextcloudAccountOf(storageKey));
  const recordsBefore = storedRecordsText();
  // Fail fast, before the slow key derivation, if something does not open.
  collectPlainAccounts(oldKey, mine);
  if (!ownAddress) plainLegacyWalletKey(oldKey);
  const dataKey = randomBytes(32);
  const record = await buildVaultRecord(value, dataKey);
  // The derivation took a while: another tab may have changed the password meanwhile (two tabs
  // upgrading a pre-vault record, or two password changes). Then this one stops (DSK-022).
  if (storedRecordsText() !== recordsBefore || heldKey(fromId) !== oldKey) {
    if (oldKey && heldKey(fromId) === oldKey) lockBecauseOfAnotherTab();
    throw new Error(LOCKED_IN_ANOTHER_TAB_MESSAGE);
  }
  // Collected again now, so accounts another tab saved during the derivation are not lost.
  const entries = collectPlainAccounts(oldKey, mine);
  const legacyHex = ownAddress ? "" : plainLegacyWalletKey(oldKey);
  // The Nextcloud app passwords too (a sealed one that does not open with the old key is lost
  // already, and is deleted: that wallet reconnects Nextcloud).
  const nextcloud = collectPlainNextcloud(oldKey, ncMine);
  const recordJson = JSON.stringify(record);
  const accountsBefore = ls().getItem(SAVED_ACCOUNTS_KEY);
  // Face ID / Touch ID wraps the old data key: it goes before anything is sealed under the new
  // one, so no crash can leave it holding a key the store no longer opens. Put back if the
  // change is undone (the old key then stays the store's).
  const biometricBefore = biometricRaw(id);
  retireBiometricUnlock("password-changed", id);
  setPendingRaw(id, recordJson);
  try {
    writeSealedVerified(dataKey, entries, mine);
    try {
      writeNextcloudVerified(dataKey, nextcloud);
    } catch (error) {
      if (accountsBefore == null) ls().removeItem(SAVED_ACCOUNTS_KEY); else ls().setItem(SAVED_ACCOUNTS_KEY, accountsBefore);
      throw error;
    }
  } catch (error) {
    setPendingRaw(id, null);
    try { if (biometricBefore != null) setBiometricRaw(id, biometricBefore); } catch { /* it stays off */ }
    throw error;
  }
  setRecordRaw(id, recordJson);
  setPendingRaw(id, null);
  clearFailedAttempts();
  setUnlocked(dataKey, id);
  if (!ownAddress) { try { sealLegacyWalletKey(dataKey, legacyHex); } catch { /* the plaintext copy stays until it can be sealed */ } }
  scrubPersistedWallet(mine);
  // The account left the shared vault: the shared password goes once no account is left in it.
  if (ownAddress && fromId === SHARED) releaseSharedVaultIfUnused();
}

/**
 * Removes a password (the caller has verified it, which unlocked the vault): `address`'s own
 * (default: the target account's), or with no account in question the shared one. Every secret
 * in that vault is written back as plaintext and checked (account keys, then the Nextcloud app
 * passwords), and only then is the password record deleted.
 */
export function removeAppPassword(address) {
  const id = vaultForTarget(address);
  if (id == null) return;
  if ((vault.keys.size || vault.legacyVerified) && !checkKeyStillCurrent()) throw new Error(LOCKED_IN_ANOTHER_TAB_MESSAGE);
  const key = heldKey(id);
  if (vaultEnabled(id) && !key) throw new Error("Enter your password first.");
  const mine = id === SHARED ? notOwn : ofAccount(id);
  const ncMine = id === SHARED
    ? (storageKey) => !hasOwnVault(nextcloudAccountOf(storageKey))
    : (storageKey) => canon(nextcloudAccountOf(storageKey)) === id;
  const entries = collectPlainAccounts(key, mine).map((entry) => {
    if (!entry || typeof entry !== "object" || !mine(entry)) return entry;
    const out = { ...entry };
    delete out.sealed;
    delete out.locked;
    return out;
  });
  const legacyHex = id === SHARED ? plainLegacyWalletKey(key) : "";
  const previous = ls().getItem(SAVED_ACCOUNTS_KEY);
  ls().setItem(SAVED_ACCOUNTS_KEY, JSON.stringify(entries));
  const back = readRawAccounts();
  const ok = entries.every((entry, index) => !entry || typeof entry !== "object" || !hasSecrets(entry) || !mine(entry) || sameSecrets(back[index], entry));
  if (!ok) {
    if (previous == null) ls().removeItem(SAVED_ACCOUNTS_KEY); else ls().setItem(SAVED_ACCOUNTS_KEY, previous);
    throw new Error("Accounts could not be written back. The password was kept.");
  }
  // The Nextcloud app passwords back to plaintext too (checked), before the record goes.
  try {
    writeNextcloudVerified(null, collectPlainNextcloud(key, ncMine));
  } catch {
    if (previous == null) ls().removeItem(SAVED_ACCOUNTS_KEY); else ls().setItem(SAVED_ACCOUNTS_KEY, previous);
    throw new Error("The Nextcloud connection could not be written back. The password was kept.");
  }
  if (id === SHARED) {
    if (legacyHex) ls().setItem(LEGACY_PERSISTED_WALLET_KEY, legacyHex);
    ls().removeItem(VAULT_LEGACY_WALLET_KEY);
  }
  setBiometricRaw(id, null);
  setRecordRaw(id, null);
  setPendingRaw(id, null);
  clearFailedAttempts();
  if (id === SHARED) lockKeyVault(); else forgetVaultKey(id);
}

/** The shared vault still holds something: an account without a vault of its own, or the
 *  pre-v2 wallet key. */
function sharedVaultHasMembers() {
  if (ls().getItem(VAULT_LEGACY_WALLET_KEY)) return true;
  return readRawAccounts().some((entry) => notOwn(entry));
}
/** Removes the shared password and what only it can open (sealed Nextcloud passwords filed under
 *  it, the Face ID record) once no account is left in it. True when it was removed. */
function releaseSharedVaultIfUnused() {
  if (!vaultExists(SHARED) || sharedVaultHasMembers()) return false;
  for (const storageKey of nextcloudStorageKeys()) {
    if (nextcloudVaultId(storageKey) !== SHARED) continue;
    const record = readRawNextcloud(storageKey);
    if (record && !hasPlainNextcloudPassword(record) && hasSealedNextcloudPassword(record)) ls().removeItem(storageKey);
  }
  setBiometricRaw(SHARED, null);
  setRecordRaw(SHARED, null);
  setPendingRaw(SHARED, null);
  if (vault.keys.has(SHARED) || vault.legacyVerified) forgetVaultKey(SHARED);
  return true;
}
/** Removes an account's own vault (its account is gone from this device). */
function releaseOwnVault(id) {
  for (const storageKey of nextcloudStorageKeys()) {
    if (canon(nextcloudAccountOf(storageKey)) !== id) continue;
    const record = readRawNextcloud(storageKey);
    if (record && !hasPlainNextcloudPassword(record) && hasSealedNextcloudPassword(record)) ls().removeItem(storageKey);
  }
  setBiometricRaw(id, null);
  setRecordRaw(id, null);
  setPendingRaw(id, null);
  forgetVaultKey(id);
}

/**
 * A password that protects nothing any more - every key it sealed went with its account - is
 * removed: an account's own once that account is gone from this device, the shared one once no
 * account is left in it (and no pre-v2 wallet key). Otherwise it stood in front of Create and
 * Import as "Unlock KaChat". A sealed Nextcloud app password left behind by a deleted account goes
 * with it (that connection is set up again). True when anything was removed.
 */
export function releaseAppPasswordIfUnused() {
  let released = false;
  for (const id of ownVaultIds()) {
    // Still here, or being set up in this tab right now (its key is held before it is saved).
    if (knownAccount(id) || heldKey(id)) continue;
    releaseOwnVault(id);
    released = true;
  }
  const sharedWasOpen = vault.keys.has(SHARED) || vault.legacyVerified;
  if (releaseSharedVaultIfUnused()) {
    released = true;
    if (!sharedWasOpen) notifyStateListeners();
  }
  if (released) clearFailedAttempts();
  return released;
}

/**
 * Forgotten password: the encrypted keys cannot be opened by anyone, so this deletes the
 * password and the sealed keys of the accounts it protected (`address`'s own vault - only that
 * account - or, for an account in the shared vault or with no account in question, every account
 * still in the shared vault). Their public entries, chats and settings stay; the user imports each
 * account again with its recovery phrase. Their Nextcloud connections with a sealed app password
 * are removed too (the user reconnects). Returns the number of accounts whose keys were removed.
 */
export function resetForgottenAppPassword(address) {
  const target = targetAddress(address);
  const id = target && hasOwnVault(target) ? canon(target) : SHARED;
  const mine = id === SHARED ? notOwn : ofAccount(id);
  const ncMine = id === SHARED
    ? (storageKey) => !hasOwnVault(nextcloudAccountOf(storageKey))
    : (storageKey) => canon(nextcloudAccountOf(storageKey)) === id;
  const nextcloudKeys = nextcloudStorageKeys().filter(ncMine);
  const raw = readRawAccounts();
  const kept = raw.filter((entry) => !(entry?.sealed && !hasSecrets(entry) && mine(entry)));
  ls().setItem(SAVED_ACCOUNTS_KEY, JSON.stringify(kept.map((entry) => {
    if (!entry || typeof entry !== "object" || !mine(entry)) return entry;
    const out = { ...entry };
    delete out.sealed;
    return out;
  })));
  if (id === SHARED) ls().removeItem(VAULT_LEGACY_WALLET_KEY);
  // A sealed Nextcloud app password cannot be opened either: the connection is removed, and the
  // user reconnects Nextcloud (a plaintext one, which needs no password, stays).
  for (const storageKey of nextcloudKeys) {
    const record = readRawNextcloud(storageKey);
    if (record && !hasPlainNextcloudPassword(record) && hasSealedNextcloudPassword(record)) ls().removeItem(storageKey);
  }
  setBiometricRaw(id, null);
  setRecordRaw(id, null);
  setPendingRaw(id, null);
  clearFailedAttempts();
  if (id === SHARED) {
    const wasOpen = !!(vault.keys.size || vault.legacyVerified);
    lockKeyVault();
    if (!wasOpen) notifyStateListeners(); // the Nextcloud connection is gone: let it reload
  } else {
    const wasOpen = vault.keys.has(id);
    forgetVaultKey(id);
    if (!wasOpen) notifyStateListeners();
  }
  return raw.length - kept.length;
}

// --- Face ID / Touch ID unlock ------------------------------------------------------------------
// The WebAuthn ceremony lives in ui/biometric-unlock.js; this half only ever sees the passkey's
// PRF output (32 bytes the authenticator computes from a secret that never leaves it, after user
// verification) and turns it into a wrapping key. It unlocks the vault cryptographically: the data
// key comes out of the record or nothing does. Record format: see the top of this file.
const BIOMETRIC_ID_PATTERN = /^[A-Za-z0-9_-]{1,1400}$/;

function parseBiometricRecord(raw) {
  try {
    const parsed = JSON.parse(raw || "null");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && Number(parsed.version) === 1) return parsed;
  } catch { /* corrupted record = no record */ }
  return null;
}
function isEnrolledBiometricRecord(record) {
  return !!(record
    && typeof record.credentialId === "string" && BIOMETRIC_ID_PATTERN.test(record.credentialId)
    && typeof record.salt === "string" && /^[0-9a-f]{64}$/i.test(record.salt)
    && typeof record.iv === "string" && /^[0-9a-f]{24}$/i.test(record.iv)
    && typeof record.wrappedDataKey === "string" && /^[0-9a-f]{96}$/i.test(record.wrappedDataKey));
}
// One record per vault: the shared vault's under BIOMETRIC_UNLOCK_KEY, an account's own vault's
// in the ACCOUNT_BIOMETRIC_KEY map. Each wraps that vault's data key only.
function readBiometricMap() {
  try {
    const parsed = JSON.parse(ls().getItem(ACCOUNT_BIOMETRIC_KEY) || "null");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}
function biometricRaw(id) {
  if (!id) return ls().getItem(BIOMETRIC_UNLOCK_KEY);
  const value = readBiometricMap()[id];
  return value == null ? null : JSON.stringify(value);
}
function setBiometricRaw(id, json) {
  if (!id) { if (json == null) ls().removeItem(BIOMETRIC_UNLOCK_KEY); else ls().setItem(BIOMETRIC_UNLOCK_KEY, json); return; }
  const map = readBiometricMap();
  if (json == null) delete map[id]; else map[id] = JSON.parse(json);
  if (Object.keys(map).length) ls().setItem(ACCOUNT_BIOMETRIC_KEY, JSON.stringify(map));
  else ls().removeItem(ACCOUNT_BIOMETRIC_KEY);
}
/** The stored Face ID / Touch ID record of `address`'s vault (default: the target account's;
 *  none = the shared vault's) as it is (enrolled, retired by a password change, or null). Holds
 *  nothing secret: the wrapped key opens only with the passkey's PRF output. */
export function loadBiometricRecord(address) {
  const id = vaultForTarget(address);
  return id == null ? null : parseBiometricRecord(biometricRaw(id));
}
/** Face ID / Touch ID unlock is on for `address`: an enrolled record and a password it belongs to. */
export function hasBiometricUnlock(address) {
  const id = vaultForTarget(address);
  return vaultEnabled(id) && isEnrolledBiometricRecord(parseBiometricRecord(biometricRaw(id)));
}
/** Why it is off, when a password change turned it off ("password-changed"), else null. */
export function biometricUnlockRetiredReason(address) {
  const record = loadBiometricRecord(address);
  return record && !isEnrolledBiometricRecord(record) && typeof record.retired === "string" ? record.retired : null;
}
/** A password change of vault `id`: the wrapped (old) data key goes, the passkey's user handle stays. */
function retireBiometricUnlock(reason, id = SHARED) {
  const record = parseBiometricRecord(biometricRaw(id));
  if (!record) return;
  if (!isEnrolledBiometricRecord(record)) return; // already off
  const kept = { version: 1, retired: String(reason || "off") };
  if (typeof record.userId === "string" && BIOMETRIC_ID_PATTERN.test(record.userId)) kept.userId = record.userId;
  if (typeof record.rpId === "string") kept.rpId = record.rpId;
  setBiometricRaw(id, JSON.stringify(kept));
}
/** Turns Face ID / Touch ID unlock off for `address`'s vault (the record goes; the passkey stays in
 *  the OS keychain). Allowed while locked: dropping a second way in never weakens anything. */
export function removeBiometricUnlock(address) {
  const id = vaultForTarget(address);
  if (id != null) setBiometricRaw(id, null);
}

function prfBytes(prfOutput) {
  if (prfOutput instanceof Uint8Array) return prfOutput;
  if (prfOutput instanceof ArrayBuffer) return new Uint8Array(prfOutput);
  if (ArrayBuffer.isView(prfOutput)) return new Uint8Array(prfOutput.buffer, prfOutput.byteOffset, prfOutput.byteLength);
  return null;
}
async function biometricWrappingKey(prfOutput) {
  const material = prfBytes(prfOutput);
  // WebAuthn PRF outputs are 32 bytes; anything shorter is not one.
  if (!material || material.length < 32) throw new Error("No usable PRF output.");
  const base = await crypto.subtle.importKey("raw", material, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: enc.encode(BIOMETRIC_HKDF_INFO) }, base, 256);
  return new Uint8Array(bits);
}

/**
 * Turns Face ID / Touch ID unlock on: wraps this page's data key under HKDF(`prfOutput`) and
 * stores the record (checked to unwrap again first). Needs a password and the vault unlocked with
 * the current key. `credentialId` / `userId` are base64url, `salt` the 32-byte PRF input (hex or
 * bytes) the passkey evaluated. Throws when anything is missing; nothing is written then.
 */
export async function enrolBiometricUnlock({ credentialId, userId, rpId, salt, prfOutput, address } = {}) {
  const vid = vaultForTarget(address);
  if (!vaultEnabled(vid)) throw new Error("Set a password first.");
  const key = heldKey(vid);
  if (!key) throw new Error("KaChat is locked. Enter your password first.");
  requireCurrentKey(key, vid);
  const id = String(credentialId || "");
  if (!BIOMETRIC_ID_PATTERN.test(id)) throw new Error("The passkey has no usable ID.");
  const saltHex = typeof salt === "string" ? salt.toLowerCase() : bytesToHex(prfBytes(salt) || []);
  if (!/^[0-9a-f]{64}$/.test(saltHex)) throw new Error("The passkey salt must be 32 bytes.");
  const wrappingKey = await biometricWrappingKey(prfOutput);
  // The derivation awaited: another tab may have changed the password meanwhile.
  if (heldKey(vid) !== key) throw new Error("KaChat is locked. Enter your password first.");
  requireCurrentKey(key, vid);
  const aad = BIOMETRIC_WRAP_AAD_PREFIX + id;
  const sealed = sealBytes(wrappingKey, key, aad);
  if (bytesToHex(openBytes(wrappingKey, sealed, aad)) !== bytesToHex(key)) throw new Error("Face ID key wrap failed verification.");
  const record = {
    version: 1,
    credentialId: id,
    salt: saltHex,
    iv: sealed.iv,
    wrappedDataKey: sealed.ct,
    createdAt: new Date(vault.now()).toISOString(),
  };
  if (typeof userId === "string" && BIOMETRIC_ID_PATTERN.test(userId)) record.userId = userId;
  if (typeof rpId === "string" && rpId) record.rpId = rpId;
  setBiometricRaw(vid, JSON.stringify(record));
  return record;
}

/**
 * Unlocks the vault with a passkey's PRF output: unwraps the data key, checks it is the stored
 * password record's key (and opens what is stored), then takes exactly the step a correct password
 * takes. Never counts toward the password lockout and never throws for a wrong output.
 * Resolves { ok: true } or { ok: false, reason }:
 *   "no-record"  nothing enrolled (or no password)
 *   "wrong-key"  the output does not open the record (another passkey, a deleted and re-made one,
 *                a tampered record, or no user verification)
 *   "stale"      it opened, but to a key the password record no longer uses
 */
export async function unlockKeyVaultWithBiometric(prfOutput, address) {
  const id = vaultForTarget(address);
  const record = id == null ? null : parseBiometricRecord(biometricRaw(id));
  if (!vaultEnabled(id) || !isEnrolledBiometricRecord(record)) return { ok: false, reason: "no-record" };
  let key = null;
  try {
    const wrappingKey = await biometricWrappingKey(prfOutput);
    key = openBytes(wrappingKey, { iv: record.iv, ct: record.wrappedDataKey }, BIOMETRIC_WRAP_AAD_PREFIX + record.credentialId);
  } catch { return { ok: false, reason: "wrong-key" }; }
  if (!key || key.length !== 32) return { ok: false, reason: "wrong-key" };
  const held = heldKey(id);
  if (held && bytesToHex(held) === bytesToHex(key) && checkKeyStillCurrent()) return { ok: true };
  const current = recordFor(id);
  const pending = pendingFor(id);
  let fromPending = false;
  const matchesCurrent = isVaultRecord(current) && (current.keyCheck ? keyMatchesRecord(key, current) : keyOpensStore(key, id));
  if (matchesCurrent) {
    // The store was already re-sealed under an interrupted change's new key: this one is stale.
    if (pending && !keyOpensStore(key, id)) return { ok: false, reason: "stale" };
  } else if (pending?.keyCheck && keyMatchesRecord(key, pending) && keyOpensStore(key, id)) {
    fromPending = true;
  } else {
    return { ok: false, reason: "stale" };
  }
  openVaultWithDataKey(key, { id, pending, fromPending });
  return { ok: true };
}
