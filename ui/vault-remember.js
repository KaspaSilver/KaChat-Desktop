// Staying signed in across app launches, the way the iOS app does (owner, 2026-10-22): opening the
// home-screen app goes straight into the account that was open - no password, no Face ID - until
// you log out. The password (or Face ID) is asked to sign in to another saved account, and before
// a seed phrase or private key is shown, as on iOS.
//
// The key vault (ui/key-vault.js) holds an account's data key in the page's memory only, so every
// launch used to start locked. Here the open vaults' data keys are kept in IndexedDB, encrypted
// (AES-256-GCM) under a device key that is itself an IndexedDB CryptoKey created non-extractable:
// no script can read it out, it never leaves this browser profile, and a copy of the stored blob
// alone opens nothing. Log Out (the vault locks) erases the blob; so does a password change in
// another tab (that tab's keys are no longer current).
//
// Trade-off, stated plainly: like the iOS keychain, anyone who can open this browser profile on
// the unlocked device opens the account. Turning "Keep me signed in" off brings back a locked
// launch.

import { exportOpenVaultKeys, unlockWithVaultKeys, onKeyVaultStateChanged } from "./key-vault.js";

const DB_NAME = "kachat-vault-remember-v1";
const STORE = "remember";
const DEVICE_KEY_ID = "device-key";
const BLOB_ID = "open-vaults";

function openDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") { reject(new Error("No IndexedDB")); return; }
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => { request.result.createObjectStore(STORE); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
function idb(mode, run) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const store = tx.objectStore(STORE);
    let result;
    Promise.resolve(run(store, (value) => { result = value; })).catch(reject);
    tx.oncomplete = () => { db.close(); resolve(result); };
    tx.onerror = () => { db.close(); reject(tx.error); };
    tx.onabort = () => { db.close(); reject(tx.error); };
  }));
}
function get(id) {
  return idb("readonly", (store, done) => {
    const request = store.get(id);
    request.onsuccess = () => done(request.result ?? null);
  });
}
function put(id, value) { return idb("readwrite", (store) => { store.put(value, id); }); }
function remove(id) { return idb("readwrite", (store) => { store.delete(id); }); }

/** The device key: made once, non-extractable, kept as a CryptoKey object in IndexedDB. */
async function deviceKey({ create = false } = {}) {
  const existing = await get(DEVICE_KEY_ID);
  if (existing) return existing;
  if (!create) return null;
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  await put(DEVICE_KEY_ID, key);
  return key;
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const AAD = enc.encode("kachat-vault-remember-v1");

let enabled = () => true;
let writing = Promise.resolve();

/** Writes what is open now (or erases the blob when nothing is open / it is switched off). */
function saveNow() {
  writing = writing.then(async () => {
    const keys = enabled() ? exportOpenVaultKeys() : {};
    if (!Object.keys(keys).length) { await remove(BLOB_ID); return; }
    const key = await deviceKey({ create: true });
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: AAD }, key, enc.encode(JSON.stringify(keys)));
    await put(BLOB_ID, { v: 1, iv, ct: new Uint8Array(ct), savedAt: Date.now() });
  }).catch(() => { /* storage unavailable: the next launch simply asks */ });
  return writing;
}

/**
 * At launch: opens the vaults remembered from the last session, when "Keep me signed in" is on.
 * Resolves the number opened (0 when none, switched off, or anything does not check out - a key a
 * password change replaced is refused by the vault). Then keeps the remembered copy in step with
 * the vault: every unlock, lock and Log Out rewrites or erases it.
 */
export async function restoreRememberedVaults({ keepSignedIn = () => true } = {}) {
  enabled = keepSignedIn;
  let opened = 0;
  if (enabled()) {
    try {
      const [key, blob] = await Promise.all([deviceKey(), get(BLOB_ID)]);
      if (key && blob?.iv && blob?.ct) {
        const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: blob.iv, additionalData: AAD }, key, blob.ct);
        opened = unlockWithVaultKeys(JSON.parse(dec.decode(plain)));
      }
    } catch { opened = 0; }
  }
  onKeyVaultStateChanged(() => { saveNow(); });
  // Rewritten once now: drops keys that no longer open anything, or the blob when switched off.
  saveNow();
  return opened;
}

/** Erases the remembered copy at once (e.g. "Keep me signed in" switched off). */
export function forgetRememberedVaults() { return saveNow(); }
