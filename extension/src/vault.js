// The encrypted vault: every account's recovery phrase, sealed with the wallet password.
//
// This is the part the desktop web app does not have - it keeps seeds as readable JSON in
// localStorage and its password only gates the screen. Here nothing secret is ever written to
// disk in the clear:
//
//   password --PBKDF2-SHA256 (600,000 rounds, random 16-byte salt)--> AES-256-GCM key
//   { accounts, activeAccountId }  --AES-GCM (random 12-byte IV)-->  ciphertext in storage.local
//
// Unlocking derives the key once and keeps it (as raw bytes) in storage.session - memory only,
// wiped when the browser closes or the auto-lock fires (background.js), and never readable by
// web pages or content scripts. The phrase itself is decrypted on demand from the vault with
// that key, so storage.session never holds a phrase.
//
// All crypto is WebCrypto (crypto.subtle), available in every extension page and worker.

import { getLocal, setLocal, removeLocal, getSession, setSession, clearSession } from "./browser.js";

const VAULT_KEY = "kachat.vault.v1";
const SESSION_KEY = "kachat.unlockKey";
const PBKDF2_ITERATIONS = 600_000;
export const MIN_PASSWORD_LENGTH = 8;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toBase64(bytes) {
  let binary = "";
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < view.length; i += 1) binary += String.fromCharCode(view[i]);
  return btoa(binary);
}

function fromBase64(text) {
  const binary = atob(String(text || ""));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

async function deriveKeyBytes(password, salt, iterations) {
  const material = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    material,
    256,
  );
  return new Uint8Array(bits);
}

function importAesKey(rawBytes) {
  return crypto.subtle.importKey("raw", rawBytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function seal(payload, keyBytes, kdf) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await importAesKey(keyBytes);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(JSON.stringify(payload)));
  return {
    version: 1,
    kdf,
    cipher: { name: "AES-GCM", iv: toBase64(iv) },
    data: toBase64(new Uint8Array(ciphertext)),
  };
}

async function open(vault, keyBytes) {
  const key = await importAesKey(keyBytes);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(vault.cipher.iv) },
    key,
    fromBase64(vault.data),
  );
  return JSON.parse(decoder.decode(plaintext));
}

function newKdf() {
  return { name: "PBKDF2", hash: "SHA-256", iterations: PBKDF2_ITERATIONS, salt: toBase64(crypto.getRandomValues(new Uint8Array(16))) };
}

function newAccountId() {
  return toBase64(crypto.getRandomValues(new Uint8Array(9))).replace(/[+/=]/g, "");
}

/** Is there a vault at all (a wallet was set up in this browser)? */
export async function hasVault() {
  return Boolean(await getLocal(VAULT_KEY));
}

/** Is the vault unlocked right now (a key is held in session storage)? */
export async function isUnlocked() {
  return Boolean(await getSession(SESSION_KEY));
}

async function sessionKeyBytes() {
  const stored = await getSession(SESSION_KEY);
  if (!stored) throw new Error("The wallet is locked.");
  return fromBase64(stored);
}

/**
 * First-time setup: seals `account` (phrase, optional BIP39 passphrase, derivation family) with
 * a new password and leaves the wallet unlocked.
 */
export async function createVault(password, account) {
  if (String(password || "").length < MIN_PASSWORD_LENGTH) {
    throw new Error(`Use a password of at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  if (await hasVault()) throw new Error("A wallet already exists in this browser.");
  const kdf = newKdf();
  const keyBytes = await deriveKeyBytes(password, fromBase64(kdf.salt), kdf.iterations);
  const stored = { ...normalizeAccount(account), id: newAccountId(), createdAt: Date.now() };
  const payload = { accounts: [stored], activeAccountId: stored.id };
  await setLocal(VAULT_KEY, await seal(payload, keyBytes, kdf));
  await setSession(SESSION_KEY, toBase64(keyBytes));
  return publicView(payload);
}

/** Unlocks with the password. Throws "Wrong password." when it does not open the vault. */
export async function unlock(password) {
  const vault = await getLocal(VAULT_KEY);
  if (!vault) throw new Error("No wallet has been set up yet.");
  const keyBytes = await deriveKeyBytes(password, fromBase64(vault.kdf.salt), vault.kdf.iterations);
  let payload;
  try {
    payload = await open(vault, keyBytes);
  } catch {
    // AES-GCM authentication failure: the key (so the password) is wrong.
    throw new Error("Wrong password.");
  }
  await setSession(SESSION_KEY, toBase64(keyBytes));
  return publicView(payload);
}

export async function lock() {
  await clearSession();
}

/** The decrypted vault. Callers that only need names and ids should use `readAccounts`. */
async function readPayload() {
  const vault = await getLocal(VAULT_KEY);
  if (!vault) throw new Error("No wallet has been set up yet.");
  return open(vault, await sessionKeyBytes());
}

async function writePayload(payload) {
  const vault = await getLocal(VAULT_KEY);
  await setLocal(VAULT_KEY, await seal(payload, await sessionKeyBytes(), vault.kdf));
}

function normalizeAccount(account) {
  const mnemonic = String(account?.mnemonic || "").trim().toLowerCase().replace(/\s+/g, " ");
  if (!mnemonic) throw new Error("A recovery phrase is required.");
  return {
    name: String(account?.name || "").trim() || "Account 1",
    mnemonic,
    passphrase: String(account?.passphrase || ""),
    family: account?.family || "kaspaStandard",
    identityIndex: Math.max(0, Math.floor(Number(account?.identityIndex) || 0)),
  };
}

/** Names and ids only - never a phrase. What the UI lists. */
function publicView(payload) {
  return {
    activeAccountId: payload.activeAccountId,
    accounts: payload.accounts.map(({ id, name, family, identityIndex, createdAt, passphrase }) => ({
      id, name, family, identityIndex, createdAt, hasPassphrase: Boolean(passphrase),
    })),
  };
}

export async function readAccounts() {
  return publicView(await readPayload());
}

/** The active account including its secrets, for deriving keys. Keep the result short-lived. */
export async function activeAccountSecrets() {
  const payload = await readPayload();
  const account = payload.accounts.find((a) => a.id === payload.activeAccountId) || payload.accounts[0];
  if (!account) throw new Error("No account in this wallet.");
  return account;
}

export async function renameAccount(id, name) {
  const clean = String(name || "").trim();
  if (!clean) return readAccounts();
  const payload = await readPayload();
  const account = payload.accounts.find((a) => a.id === id);
  if (account) account.name = clean.slice(0, 40);
  await writePayload(payload);
  return publicView(payload);
}

/**
 * Wipes the wallet from this browser: the vault and the unlock key. The only way back is the
 * recovery phrase, which is why the UI makes this a deliberate, typed confirmation.
 */
export async function resetWallet() {
  await clearSession();
  await removeLocal([VAULT_KEY]);
}

/** Confirms a password against the vault without changing the unlock state. */
export async function verifyPassword(password) {
  const vault = await getLocal(VAULT_KEY);
  if (!vault) return false;
  try {
    const keyBytes = await deriveKeyBytes(password, fromBase64(vault.kdf.salt), vault.kdf.iterations);
    await open(vault, keyBytes);
    return true;
  } catch {
    return false;
  }
}
