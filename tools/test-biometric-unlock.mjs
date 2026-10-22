// node tools/test-biometric-unlock.mjs - Face ID / Touch ID unlock (ui/biometric-unlock.js and the
// biometric half of ui/key-vault.js). A fake navigator.credentials plays the platform authenticator:
// its PRF output is HMAC-SHA256(per-credential secret, salt), deterministic like the real one, and
// only given after "user verification". localStorage / sessionStorage are in-memory maps.
import assert from "node:assert/strict";
import { webcrypto, createHmac, randomBytes as nodeRandomBytes } from "node:crypto";

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const vault = await import("../ui/key-vault.js");
const bio = await import("../ui/biometric-unlock.js");
const {
  configureKeyVault, lockKeyVault, setAppPassword, unlockKeyVault, removeAppPassword, resetForgottenAppPassword,
  releaseAppPasswordIfUnused, readAccountRecords, writeAccountRecords, isAppLocked, isVaultUnlocked,
  appPasswordLockoutRemainingSeconds, writeKeyVaultHandoff, unlockKeyVaultFromSession, hasBiometricUnlock,
  loadBiometricRecord, biometricUnlockRetiredReason, enrolBiometricUnlock, unlockKeyVaultWithBiometric,
  removeBiometricUnlock, BIOMETRIC_UNLOCK_KEY, BIOMETRIC_HKDF_INFO, VAULT_HANDOFF_KEY, APP_PASSWORD_KEY,
  VAULT_PBKDF2_ITERATIONS,
} = vault;
const {
  configureBiometricUnlock, enrolBiometric, finishBiometricEnrolment, unlockWithBiometric, checkBiometricSupport,
  biometricEnvironmentProblem, turnOffBiometricUnlock, canOfferBiometricUnlock, biometricName, biometricRowLabel,
  base64UrlEncode, canAutoPromptBiometric, BIOMETRIC_UNSUPPORTED_MESSAGE,
} = bio;

class MemoryStorage {
  constructor() { this.map = new Map(); }
  getItem(key) { return this.map.has(key) ? this.map.get(key) : null; }
  setItem(key, value) { this.map.set(key, String(value)); }
  removeItem(key) { this.map.delete(key); }
  get length() { return this.map.size; }
  key(index) { return [...this.map.keys()][index] ?? null; }
  dump() { return [...this.map.values()].join("\n"); }
}

function domError(name) { return Object.assign(new Error(name), { name }); }
function bytes(value) { return value instanceof Uint8Array ? value : new Uint8Array(value.buffer ?? value, value.byteOffset ?? 0, value.byteLength); }
function b64u(value) { return Buffer.from(bytes(value)).toString("base64url"); }

/** A platform authenticator with PRF (hmac-secret): one secret per credential, resident keys
 *  replaced when the same rp + user handle is registered again (as iCloud Keychain / GPM do). */
class FakeAuthenticator {
  constructor({ prf = true, prfOnCreate = true, reportEnabledFalse = false, uv = true, getFailures = [] } = {}) {
    Object.assign(this, { prf, prfOnCreate, reportEnabledFalse, uv, getFailures: [...getFailures] });
    this.credentials = new Map(); // credentialId (b64url) -> { secret, rpId, userId }
    this.creates = [];
    this.gets = [];
  }
  prfFor(credentialId, salt, uv = this.uv) {
    const entry = this.credentials.get(credentialId);
    // hmac-secret keeps separate secrets for with / without UV: no UV, different output.
    return new Uint8Array(createHmac("sha256", Buffer.concat([entry.secret, Buffer.from(uv ? "uv" : "no-uv")])).update(bytes(salt)).digest());
  }
  async create({ publicKey }) {
    this.creates.push(publicKey);
    assert.equal(publicKey.authenticatorSelection.authenticatorAttachment, "platform");
    assert.equal(publicKey.authenticatorSelection.userVerification, "required");
    assert.equal(publicKey.authenticatorSelection.residentKey, "required");
    assert.equal(publicKey.user.name, "KaChat");
    assert.equal(bytes(publicKey.extensions.prf.eval.first).length, 32);
    const userId = b64u(publicKey.user.id);
    for (const [id, entry] of this.credentials) if (entry.rpId === publicKey.rp.id && entry.userId === userId) this.credentials.delete(id);
    const rawId = new Uint8Array(nodeRandomBytes(16));
    const credentialId = b64u(rawId);
    this.credentials.set(credentialId, { secret: nodeRandomBytes(32), rpId: publicKey.rp.id, userId });
    const salt = publicKey.extensions.prf.eval.first;
    const results = !this.prf ? {}
      : this.reportEnabledFalse ? { prf: { enabled: false } }
      : this.prfOnCreate ? { prf: { enabled: true, results: { first: this.prfFor(credentialId, salt).buffer } } }
      : { prf: { enabled: true } };
    return { rawId: rawId.buffer, id: credentialId, type: "public-key", response: {}, getClientExtensionResults: () => results };
  }
  async get({ publicKey }) {
    this.gets.push(publicKey);
    const failure = this.getFailures.shift();
    if (failure) throw domError(failure);
    assert.equal(publicKey.userVerification, "required");
    const id = b64u(publicKey.allowCredentials[0].id);
    if (!this.credentials.has(id) || this.credentials.get(id).rpId !== publicKey.rpId) throw domError("NotAllowedError"); // no such passkey here
    const authenticatorData = new Uint8Array(37);
    authenticatorData[32] = this.uv ? 0x05 : 0x01;
    const results = this.prf && !this.reportEnabledFalse ? { prf: { results: { first: this.prfFor(id, publicKey.extensions.prf.eval.first).buffer } } } : {};
    return { rawId: publicKey.allowCredentials[0].id, response: { authenticatorData: authenticatorData.buffer }, getClientExtensionResults: () => results };
  }
}
function fakePkc({ prfCapability } = {}) {
  return {
    isUserVerifyingPlatformAuthenticatorAvailable: async () => true,
    getClientCapabilities: prfCapability === undefined ? undefined : async () => ({ "extension:prf": prfCapability }),
    signaled: [],
    signalUnknownCredential(options) { this.signaled.push(options); return Promise.resolve(); },
  };
}

const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1";
let local;
let session;
let authenticator;
let pkc;
const canonicalize = (a) => String(a || "").trim().toLowerCase();
function fresh({ authenticatorOptions = {}, pkcOptions = {}, env = {} } = {}) {
  local = new MemoryStorage();
  session = new MemoryStorage();
  lockKeyVault();
  configureKeyVault({ storage: local, session, iterations: 2_000, canonicalize, now: () => Date.now() });
  authenticator = new FakeAuthenticator(authenticatorOptions);
  pkc = fakePkc(pkcOptions);
  configureBiometricUnlock({
    credentials: authenticator, PublicKeyCredential: pkc, location: { hostname: "desktop.kachat.app" },
    isSecureContext: true, userAgent: IPHONE_UA, maxTouchPoints: 5, ...env,
  });
}
function reload() { lockKeyVault(); }
function currentDataKeyHex() {
  assert.equal(writeKeyVaultHandoff(), true);
  const key = JSON.parse(session.getItem(VAULT_HANDOFF_KEY)).key;
  session.removeItem(VAULT_HANDOFF_KEY);
  return key;
}
function failedAttempts() { return local.getItem("kachat-app-password-failed-attempts"); }

const KEY_A = "11".repeat(32);
const MNEMONIC_A = "abandon ability able about above absent absorb abstract absurd abuse access accident";
const accountA = { version: 1, address: "kaspa:qpaaaaaaaaaaaa", privateKeyHex: KEY_A, mnemonic: MNEMONIC_A, passphrase: "tre-zor", name: "Alice" };
const byAddress = (address) => readAccountRecords().find((entry) => entry.address === address);
async function setUpVault() {
  writeAccountRecords([accountA]);
  await setAppPassword("correct horse");
}

const tests = [];
function test(name, fn) { tests.push([name, fn]); }

test("enrol wraps the data key; the same passkey unlocks the vault and opens the accounts", async () => {
  fresh();
  await setUpVault();
  const dataKey = currentDataKeyHex();
  assert.deepEqual(await enrolBiometric(), { status: "on" });
  assert.equal(hasBiometricUnlock(), true);
  const record = loadBiometricRecord();
  assert.equal(record.version, 1);
  assert.match(record.credentialId, /^[A-Za-z0-9_-]+$/);
  assert.match(record.salt, /^[0-9a-f]{64}$/);
  assert.match(record.iv, /^[0-9a-f]{24}$/);
  assert.equal(record.wrappedDataKey.length, (32 + 16) * 2);
  assert.equal(record.rpId, "desktop.kachat.app");
  assert.equal(authenticator.creates[0].rp.id, "desktop.kachat.app");
  assert.notEqual(authenticator.creates[0].user.name, accountA.address, "the user handle is not the address");
  // The record is standard AES-256-GCM under HKDF(prf output): WebCrypto opens it.
  const prf = authenticator.prfFor(record.credentialId, Buffer.from(record.salt, "hex"));
  const hkdfBase = await webcrypto.subtle.importKey("raw", prf, "HKDF", false, ["deriveKey"]);
  const wrapKey = await webcrypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: new TextEncoder().encode(BIOMETRIC_HKDF_INFO) }, hkdfBase, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
  const unwrapped = await webcrypto.subtle.decrypt({ name: "AES-GCM", iv: Buffer.from(record.iv, "hex"), additionalData: new TextEncoder().encode(`kachat-biometric-unlock-v1|${record.credentialId}`) }, wrapKey, Buffer.from(record.wrappedDataKey, "hex"));
  assert.equal(Buffer.from(unwrapped).toString("hex"), dataKey);

  reload();
  assert.equal(isAppLocked(), true);
  assert.equal(byAddress(accountA.address).locked, true);
  assert.equal(canOfferBiometricUnlock(), true);
  assert.deepEqual(await unlockWithBiometric(), { status: "unlocked" });
  assert.equal(isAppLocked(), false);
  assert.equal(currentDataKeyHex(), dataKey);
  const opened = byAddress(accountA.address);
  assert.equal(opened.privateKeyHex, KEY_A);
  assert.equal(opened.mnemonic, MNEMONIC_A);
  // The get() asked for this passkey only, with user verification and the stored salt.
  const get = authenticator.gets.at(-1);
  assert.equal(b64u(get.allowCredentials[0].id), record.credentialId);
  assert.equal(Buffer.from(bytes(get.extensions.prf.eval.first)).toString("hex"), record.salt);
  // Same unlocked state as the password: KaChat's own reload is handed the key.
  assert.equal(writeKeyVaultHandoff(), true);
  const saved = session.getItem(VAULT_HANDOFF_KEY);
  lockKeyVault();
  session.setItem(VAULT_HANDOFF_KEY, saved);
  assert.equal(unlockKeyVaultFromSession(), true);
  assert.equal(currentDataKeyHex(), dataKey);
});

test("the record never holds the raw data key, nothing secret in sessionStorage", async () => {
  fresh();
  await setUpVault();
  const dataKey = currentDataKeyHex();
  await enrolBiometric();
  const raw = local.getItem(BIOMETRIC_UNLOCK_KEY);
  assert.ok(!raw.includes(dataKey), "hex data key in the record");
  assert.ok(!raw.includes(Buffer.from(dataKey, "hex").toString("base64")), "base64 data key in the record");
  assert.ok(!raw.includes(Buffer.from(dataKey, "hex").toString("base64url")), "base64url data key in the record");
  assert.ok(!local.dump().includes(dataKey));
  assert.ok(!session.dump().includes(dataKey));
  // Nor the PRF output.
  const record = loadBiometricRecord();
  const prfHex = Buffer.from(authenticator.prfFor(record.credentialId, Buffer.from(record.salt, "hex"))).toString("hex");
  assert.ok(!local.dump().includes(prfHex));
});

test("a wrong PRF output fails cleanly and the vault stays locked", async () => {
  fresh();
  await setUpVault();
  await enrolBiometric();
  reload();
  assert.deepEqual(await unlockKeyVaultWithBiometric(new Uint8Array(32).fill(7)), { ok: false, reason: "wrong-key" });
  assert.deepEqual(await unlockKeyVaultWithBiometric(new Uint8Array(0)), { ok: false, reason: "wrong-key" });
  assert.deepEqual(await unlockKeyVaultWithBiometric(null), { ok: false, reason: "wrong-key" });
  assert.equal(isAppLocked(), true);
  assert.equal(byAddress(accountA.address).locked, true);
  // A different passkey with the same ID claim (deleted and re-made): its secret differs.
  const record = loadBiometricRecord();
  authenticator.credentials.get(record.credentialId).secret = nodeRandomBytes(32);
  assert.deepEqual(await unlockWithBiometric(), { status: "failed", reason: "wrong-key" });
  assert.equal(isAppLocked(), true);
  // A tampered record.
  fresh();
  await setUpVault();
  await enrolBiometric();
  reload();
  const tampered = loadBiometricRecord();
  tampered.wrappedDataKey = (tampered.wrappedDataKey[0] === "0" ? "1" : "0") + tampered.wrappedDataKey.slice(1);
  local.setItem(BIOMETRIC_UNLOCK_KEY, JSON.stringify(tampered));
  assert.deepEqual(await unlockWithBiometric(), { status: "failed", reason: "wrong-key" });
  assert.equal(isAppLocked(), true);
  // The password still works.
  assert.equal(await unlockKeyVault("correct horse"), true);
});

test("no user verification: refused (and the UV-less PRF output would not open it anyway)", async () => {
  fresh();
  await setUpVault();
  await enrolBiometric();
  reload();
  authenticator.uv = false;
  assert.deepEqual(await unlockWithBiometric(), { status: "failed", reason: "wrong-key" });
  const record = loadBiometricRecord();
  const noUv = authenticator.prfFor(record.credentialId, Buffer.from(record.salt, "hex"), false);
  assert.deepEqual(await unlockKeyVaultWithBiometric(noUv), { ok: false, reason: "wrong-key" });
  assert.equal(isAppLocked(), true);
});

test("no PRF support refuses enrolment and stores nothing", async () => {
  // The browser says so up front.
  fresh({ pkcOptions: { prfCapability: false } });
  assert.equal((await checkBiometricSupport()).supported, false);
  assert.equal((await checkBiometricSupport()).message, BIOMETRIC_UNSUPPORTED_MESSAGE);
  fresh({ pkcOptions: { prfCapability: true } });
  assert.equal((await checkBiometricSupport()).supported, true);
  // Found out by trying: no PRF result on create, none on get either.
  fresh({ authenticatorOptions: { prf: false } });
  await setUpVault();
  assert.deepEqual(await enrolBiometric(), { status: "unsupported", message: BIOMETRIC_UNSUPPORTED_MESSAGE });
  assert.equal(local.getItem(BIOMETRIC_UNLOCK_KEY), null);
  assert.equal(hasBiometricUnlock(), false);
  assert.equal(authenticator.gets.length, 1, "asked once more with get() before giving up");
  assert.equal(pkc.signaled.length, 1, "the useless passkey is reported as unknown where supported");
  // prf.enabled false on create: the get() is still tried, then refused.
  fresh({ authenticatorOptions: { reportEnabledFalse: true } });
  await setUpVault();
  assert.equal((await enrolBiometric()).status, "unsupported");
  assert.equal(local.getItem(BIOMETRIC_UNLOCK_KEY), null);
  // No WebAuthn at all / not a secure context / an IP origin.
  fresh({ env: { credentials: null } });
  assert.equal(biometricEnvironmentProblem(), BIOMETRIC_UNSUPPORTED_MESSAGE);
  assert.equal((await enrolBiometric()).status, "unsupported");
  fresh({ env: { isSecureContext: false } });
  assert.match(biometricEnvironmentProblem(), /secure/);
  fresh({ env: { location: { hostname: "192.168.1.20" } } });
  assert.match(biometricEnvironmentProblem(), /IP address/);
  fresh({ env: { location: { hostname: "[::1]" } } });
  assert.match(biometricEnvironmentProblem(), /IP address/);
  // The vault half never wraps without a usable output.
  fresh();
  await setUpVault();
  await assert.rejects(enrolBiometricUnlock({ credentialId: "abc", salt: "00".repeat(32), prfOutput: undefined }));
  await assert.rejects(enrolBiometricUnlock({ credentialId: "abc", salt: "00".repeat(32), prfOutput: new Uint8Array(16) }));
  assert.equal(local.getItem(BIOMETRIC_UNLOCK_KEY), null);
});

test("PRF only on get(): enrolment asks once more; outside a gesture it waits for another tap", async () => {
  fresh({ authenticatorOptions: { prfOnCreate: false } });
  await setUpVault();
  assert.deepEqual(await enrolBiometric(), { status: "on" });
  assert.equal(authenticator.gets.length, 1);
  // The second prompt refused (no user activation left): "needs-confirm", then a tap finishes it.
  fresh({ authenticatorOptions: { prfOnCreate: false, getFailures: ["NotAllowedError"] } });
  await setUpVault();
  const first = await enrolBiometric();
  assert.equal(first.status, "needs-confirm");
  assert.equal(local.getItem(BIOMETRIC_UNLOCK_KEY), null);
  assert.deepEqual(await finishBiometricEnrolment(first.pending), { status: "on" });
  reload();
  assert.deepEqual(await unlockWithBiometric(), { status: "unlocked" });
});

test("enrolment needs a password and the vault unlocked", async () => {
  fresh();
  writeAccountRecords([accountA]);
  assert.equal((await enrolBiometric()).status, "failed");
  assert.equal(local.getItem(BIOMETRIC_UNLOCK_KEY), null);
  await setAppPassword("correct horse");
  reload();
  const result = await enrolBiometric();
  assert.equal(result.status, "failed");
  assert.equal(local.getItem(BIOMETRIC_UNLOCK_KEY), null);
  assert.equal(authenticator.creates.length, 0, "no passkey is made for nothing");
});

test("password change: the record drops the old key; turning it on again replaces the same passkey", async () => {
  fresh();
  await setUpVault();
  await enrolBiometric();
  const before = loadBiometricRecord();
  const oldRecordJson = local.getItem(BIOMETRIC_UNLOCK_KEY);
  await setAppPassword("battery staple");
  assert.equal(hasBiometricUnlock(), false);
  assert.equal(biometricUnlockRetiredReason(), "password-changed");
  const retired = loadBiometricRecord();
  assert.equal(retired.wrappedDataKey, undefined);
  assert.equal(retired.iv, undefined);
  assert.equal(retired.credentialId, undefined);
  assert.equal(retired.userId, before.userId);
  reload();
  assert.deepEqual(await unlockWithBiometric(), { status: "failed", reason: "no-record" });
  assert.equal(canOfferBiometricUnlock(), false);
  // The old record put back by hand (a backup, another tab): it opens to the OLD key, refused.
  local.setItem(BIOMETRIC_UNLOCK_KEY, oldRecordJson);
  assert.deepEqual(await unlockWithBiometric(), { status: "failed", reason: "stale" });
  assert.equal(isAppLocked(), true);
  assert.equal(await unlockKeyVault("battery staple"), true);
  // On again: same user handle, so the OS overwrites the passkey instead of adding one.
  local.setItem(BIOMETRIC_UNLOCK_KEY, JSON.stringify(retired));
  assert.deepEqual(await enrolBiometric(), { status: "on" });
  assert.equal(b64u(authenticator.creates.at(-1).user.id), before.userId);
  assert.equal(authenticator.credentials.size, 1);
  const newKey = currentDataKeyHex();
  reload();
  assert.deepEqual(await unlockWithBiometric(), { status: "unlocked" });
  assert.equal(currentDataKeyHex(), newKey);
  assert.equal(byAddress(accountA.address).privateKeyHex, KEY_A);
});

test("a work-factor upgrade at unlock keeps the data key, so the record stays valid", async () => {
  fresh();
  await setUpVault(); // 2,000 iterations
  await enrolBiometric();
  reload();
  configureKeyVault({ iterations: VAULT_PBKDF2_ITERATIONS });
  assert.equal(await unlockKeyVault("correct horse"), true);
  assert.equal(JSON.parse(local.getItem(APP_PASSWORD_KEY)).iterations, VAULT_PBKDF2_ITERATIONS);
  assert.equal(hasBiometricUnlock(), true);
  reload();
  assert.deepEqual(await unlockWithBiometric(), { status: "unlocked" });
});

test("removing the password, forgot-password and release-if-unused delete the record", async () => {
  fresh();
  await setUpVault();
  await enrolBiometric();
  removeAppPassword();
  assert.equal(local.getItem(BIOMETRIC_UNLOCK_KEY), null);

  fresh();
  await setUpVault();
  await enrolBiometric();
  reload();
  resetForgottenAppPassword();
  assert.equal(local.getItem(BIOMETRIC_UNLOCK_KEY), null);

  fresh();
  await setUpVault();
  await enrolBiometric();
  reload();
  writeAccountRecords([]); // the last account removed (public fields only, allowed while locked)
  assert.equal(releaseAppPasswordIfUnused(), true);
  assert.equal(local.getItem(BIOMETRIC_UNLOCK_KEY), null);

  // A retired record goes the same way.
  fresh();
  await setUpVault();
  await enrolBiometric();
  await setAppPassword("battery staple");
  assert.ok(local.getItem(BIOMETRIC_UNLOCK_KEY));
  removeAppPassword();
  assert.equal(local.getItem(BIOMETRIC_UNLOCK_KEY), null);
});

test("turn off deletes the record (also while locked) and tells the browser the passkey is unused", async () => {
  fresh();
  await setUpVault();
  await enrolBiometric();
  const { credentialId } = loadBiometricRecord();
  reload();
  turnOffBiometricUnlock();
  assert.equal(local.getItem(BIOMETRIC_UNLOCK_KEY), null);
  assert.deepEqual(pkc.signaled.at(-1), { rpId: "desktop.kachat.app", credentialId });
  assert.equal(hasBiometricUnlock(), false);
  assert.equal(await unlockKeyVault("correct horse"), true, "the password is untouched");
  removeBiometricUnlock(); // nothing left: no-op
});

test("failed or cancelled biometric attempts never touch the password lockout", async () => {
  fresh();
  await setUpVault();
  await enrolBiometric();
  reload();
  for (let i = 0; i < 4; i += 1) assert.equal(await unlockKeyVault("wrong"), false);
  assert.equal(failedAttempts(), "4");
  assert.equal(appPasswordLockoutRemainingSeconds(), null);
  for (let i = 0; i < 10; i += 1) assert.equal((await unlockKeyVaultWithBiometric(new Uint8Array(32).fill(i))).ok, false);
  authenticator.getFailures.push("NotAllowedError", "AbortError", "NotAllowedError");
  for (let i = 0; i < 3; i += 1) assert.deepEqual(await unlockWithBiometric(), { status: "cancelled" });
  assert.equal(failedAttempts(), "4", "biometric failures are not wrong passwords");
  assert.equal(appPasswordLockoutRemainingSeconds(), null);
  assert.equal(isAppLocked(), true);
  // The fifth wrong password locks out as before; Face ID still opens it (another factor) and,
  // like a correct password, resets the counter.
  assert.equal(await unlockKeyVault("wrong"), false);
  assert.ok(appPasswordLockoutRemainingSeconds() > 0);
  assert.deepEqual(await unlockWithBiometric(), { status: "unlocked" });
  assert.equal(failedAttempts(), null);
  assert.equal(appPasswordLockoutRemainingSeconds(), null);
});

test("a passkey deleted from the keychain: cancelled-like failure, password still works", async () => {
  fresh();
  await setUpVault();
  await enrolBiometric();
  reload();
  authenticator.credentials.clear();
  assert.deepEqual(await unlockWithBiometric(), { status: "cancelled" });
  assert.equal(isAppLocked(), true);
  assert.equal(await unlockKeyVault("correct horse"), true);
  assert.equal(isVaultUnlocked(), true);
});

test("labels and auto-prompt rules per platform", async () => {
  fresh();
  assert.equal(biometricName(), "Face ID");
  assert.equal(biometricRowLabel(), "Unlock with Face ID");
  assert.equal(canAutoPromptBiometric(), false, "WebKit needs a tap");
  configureBiometricUnlock({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15", maxTouchPoints: 0 });
  assert.equal(biometricName(), "Touch ID");
  assert.equal(canAutoPromptBiometric(), false);
  configureBiometricUnlock({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36" });
  assert.equal(biometricName(), "Touch ID");
  assert.equal(canAutoPromptBiometric(), true);
  configureBiometricUnlock({ userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36" });
  assert.equal(biometricName(), "Windows Hello");
  configureBiometricUnlock({ userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36", maxTouchPoints: 5 });
  assert.equal(biometricName(), "Fingerprint");
  configureBiometricUnlock({ userAgent: "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0", maxTouchPoints: 0 });
  assert.equal(biometricRowLabel(), "Unlock with biometrics");
  assert.equal(base64UrlEncode(new Uint8Array([251, 255])), "-_8");
});

let failed = 0;
for (const [name, fn] of tests) {
  try { await fn(); console.log(`ok   ${name}`); }
  catch (error) { failed += 1; console.log(`FAIL ${name}\n     ${error.stack}`); }
}
console.log(failed ? `\n${failed} of ${tests.length} failed` : `\nall ${tests.length} passed`);
process.exit(failed ? 1 : 0);
