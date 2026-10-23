// Face ID / Touch ID / Windows Hello / fingerprint unlock for the app password (ui/key-vault.js).
//
// A WebAuthn passkey on this device's platform authenticator, with the PRF extension: the
// authenticator turns a 32-byte salt into a 32-byte secret only after user verification (Face ID,
// Touch ID, Windows Hello, the fingerprint sensor or the device PIN), and only for this origin.
// key-vault.js wraps the vault's data key under HKDF(that secret), so the passkey UNLOCKS the vault:
// without the PRF output there is no data key, and no "biometric gate" that skips the password.
// Nothing here is sent to a server; the challenge is random and the assertion is never verified
// remotely (the PRF output is the proof).
//
// Browser rules this follows:
//  - secure context only (https or localhost), rp id = this hostname (never an IP address);
//  - the passkey is bound to this origin, so a self-hosted copy enrols separately;
//  - Safari (iOS and macOS) only allows WebAuthn inside a user gesture, so create() / get() are
//    always the FIRST await of a click handler here (nothing async before them), and the launch
//    auto-prompt is skipped on WebKit;
//  - PRF needs iOS 18+ / macOS 15+ (iCloud Keychain passkeys), Chrome 116+ (Android with Google
//    Password Manager, Windows Hello on Windows 11, macOS iCloud Keychain from Chrome 132+), and is
//    detected with PublicKeyCredential.getClientCapabilities() ("extension:prf") where it exists,
//    else by trying and handling a missing PRF result.

import {
  enrolBiometricUnlock, unlockKeyVaultWithBiometric, loadBiometricRecord, hasBiometricUnlock,
  removeBiometricUnlock, isVaultEnabled, isVaultUnlocked,
} from "./key-vault.js";

export const BIOMETRIC_UNSUPPORTED_MESSAGE = "Face ID / Touch ID unlock isn't supported on this browser or device yet. Your password still works.";
const WEBAUTHN_TIMEOUT_MS = 60_000;

// Injected for tests; the browser's globals otherwise.
const env = {
  credentials: undefined,
  PublicKeyCredential: undefined,
  location: undefined,
  isSecureContext: undefined,
  userAgent: undefined,
  maxTouchPoints: undefined,
};
export function configureBiometricUnlock(overrides = {}) {
  for (const key of Object.keys(env)) if (key in overrides) env[key] = overrides[key];
}
function nav() { try { return globalThis.navigator || {}; } catch { return {}; } }
function credentialsApi() { return env.credentials !== undefined ? env.credentials : nav().credentials; }
function pkc() { return env.PublicKeyCredential !== undefined ? env.PublicKeyCredential : globalThis.PublicKeyCredential; }
function hostname() { return String((env.location !== undefined ? env.location : globalThis.location)?.hostname || ""); }
function secureContext() { return env.isSecureContext !== undefined ? !!env.isSecureContext : !!globalThis.isSecureContext; }
function userAgent() { return String(env.userAgent !== undefined ? env.userAgent : nav().userAgent || ""); }
function touchPoints() { return Number(env.maxTouchPoints !== undefined ? env.maxTouchPoints : nav().maxTouchPoints || 0); }

// --- bytes ------------------------------------------------------------------------------------
function randomBytes(length) { return crypto.getRandomValues(new Uint8Array(length)); }
function toBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return null;
}
export function base64UrlEncode(bytes) {
  let binary = "";
  for (const byte of toBytes(bytes) || []) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function base64UrlDecode(text) {
  const clean = String(text || "").replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(clean + "=".repeat((4 - (clean.length % 4)) % 4));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}
function hexToBytes(hex) {
  const out = new Uint8Array(hex.length >> 1);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}
function bytesToHex(bytes) { return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(""); }

// --- platform -----------------------------------------------------------------------------------
function isIosLike() {
  const ua = userAgent();
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && touchPoints() > 1); // iPadOS asks for the Mac site
}
function isMac() { return /Macintosh|Mac OS X/.test(userAgent()) && !isIosLike(); }
/** Every browser on iOS is WebKit, and so is Safari on the Mac: WebAuthn needs a user gesture. */
function isWebKitGestureOnly() {
  const ua = userAgent();
  if (isIosLike()) return true;
  return /AppleWebKit/.test(ua) && /Safari/.test(ua) && !/Chrome|Chromium|CriOS|Edg|OPR|Firefox|FxiOS/.test(ua);
}
/** What the OS calls its unlock: "Face ID" on iPhone and iPad, "Touch ID" on a Mac, "Windows
 *  Hello" on Windows, "Fingerprint" on Android, else "Biometrics". */
export function biometricName() {
  const ua = userAgent();
  if (isIosLike()) return "Face ID";
  if (isMac()) return "Touch ID";
  if (/Windows/.test(ua)) return "Windows Hello";
  if (/Android/.test(ua)) return "Fingerprint";
  return "Biometrics";
}
/** The Settings row: "Unlock with Face ID", "Unlock with Touch ID", ... */
export function biometricRowLabel() {
  const name = biometricName();
  return `Unlock with ${name === "Biometrics" ? "biometrics" : name}`;
}
/** The unlock button: "Use Face ID", ... */
export function biometricButtonLabel() {
  const name = biometricName();
  return `Use ${name === "Biometrics" ? "biometrics" : name}`;
}

function isIpAddress(host) {
  const h = String(host || "").replace(/^\[|\]$/g, "");
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(":");
}
/** Synchronous checks: null when WebAuthn can run here, else a short reason for the user. */
export function biometricEnvironmentProblem() {
  if (!secureContext()) return "Face ID / Touch ID unlock needs a secure (https) connection.";
  const host = hostname();
  if (!host || isIpAddress(host)) return "Face ID / Touch ID unlock doesn't work when KaChat is opened by IP address. Open it by its domain name.";
  const api = credentialsApi();
  if (!pkc() || !api || typeof api.create !== "function" || typeof api.get !== "function") return BIOMETRIC_UNSUPPORTED_MESSAGE;
  return null;
}
/** The unlock button is worth showing: a record is enrolled and this browser has WebAuthn. */
export function canOfferBiometricUnlock() { return hasBiometricUnlock() && !biometricEnvironmentProblem(); }

/**
 * Best guess before trying (no prompt is shown): { supported: true | false | null, message }.
 * null = can't tell (no getClientCapabilities), so enrolment tries and checks for a PRF result.
 */
export async function checkBiometricSupport() {
  const problem = biometricEnvironmentProblem();
  if (problem) return { supported: false, message: problem };
  const PKC = pkc();
  try {
    if (typeof PKC.isUserVerifyingPlatformAuthenticatorAvailable === "function" && !(await PKC.isUserVerifyingPlatformAuthenticatorAvailable())) {
      return { supported: false, message: BIOMETRIC_UNSUPPORTED_MESSAGE };
    }
  } catch { /* unknown */ }
  try {
    if (typeof PKC.getClientCapabilities === "function") {
      const caps = await PKC.getClientCapabilities();
      if (caps && caps["extension:prf"] === false) return { supported: false, message: BIOMETRIC_UNSUPPORTED_MESSAGE };
      if (caps && caps["extension:prf"] === true) return { supported: true, message: null };
    }
  } catch { /* unknown */ }
  return { supported: null, message: null };
}

/** Auto-prompting is allowed here (not WebKit, page visible and focused). */
export function canAutoPromptBiometric() {
  if (isWebKitGestureOnly()) return false;
  try {
    if (globalThis.document && (document.visibilityState !== "visible" || (typeof document.hasFocus === "function" && !document.hasFocus()))) return false;
  } catch { return false; }
  return true;
}

function prfFirst(credential) {
  let results = null;
  try { results = credential?.getClientExtensionResults?.() || null; } catch { results = null; }
  return { prf: results?.prf || null, first: toBytes(results?.prf?.results?.first) };
}
function errorName(error) { return String(error?.name || ""); }
function isCancel(error) { return errorName(error) === "NotAllowedError" || errorName(error) === "AbortError"; }
/** authenticatorData flags byte (offset 32): bit 2 = user verified. */
function userVerified(response) {
  const data = toBytes(response?.authenticatorData);
  if (!data) return true; // not exposed: the PRF output itself is UV-bound (hmac-secret CredRandomWithUV)
  return data.length > 32 && (data[32] & 0x04) !== 0;
}
function tidyUnknownCredential(rpId, credentialId) {
  try {
    const PKC = pkc();
    if (typeof PKC?.signalUnknownCredential === "function") PKC.signalUnknownCredential({ rpId, credentialId }).catch?.(() => {});
  } catch { /* best effort */ }
}

async function assertPrf({ rpId, credentialId, saltBytes }) {
  const assertion = await credentialsApi().get({
    publicKey: {
      challenge: randomBytes(32),
      rpId,
      allowCredentials: [{ type: "public-key", id: base64UrlDecode(credentialId), transports: ["internal"] }],
      userVerification: "required",
      timeout: WEBAUTHN_TIMEOUT_MS,
      extensions: { prf: { eval: { first: saltBytes } } },
    },
  });
  if (!assertion) throw Object.assign(new Error("cancelled"), { name: "NotAllowedError" });
  if (!userVerified(assertion.response)) return { first: null, unverified: true };
  return { first: prfFirst(assertion).first, unverified: false };
}

/**
 * Turns Face ID / Touch ID unlock on. Call it straight from a click (create() is its first await).
 * Needs the vault unlocked (the caller checked the password). Resolves:
 *   { status: "on" }                     enrolled
 *   { status: "needs-confirm", pending } the passkey exists but its PRF output needs one more
 *                                        prompt (a browser that gives none on create and refuses a
 *                                        second prompt outside a gesture): call
 *                                        finishBiometricEnrolment(pending) from another click
 *   { status: "unsupported", message }   no platform authenticator or no PRF: nothing stored
 *   { status: "cancelled" }              the user closed the prompt
 *   { status: "failed", message }
 */
// `accountLabel`: the account's name, so each account's passkey is told apart in the keychain
// ("KaChat (Alice)") now that every account has its own password and its own Face ID record.
function passkeyLabel(accountLabel) {
  const clean = String(accountLabel || "").replace(/\s+/g, " ").trim().slice(0, 40);
  return clean ? `KaChat (${clean})` : "KaChat";
}
export async function enrolBiometric({ accountLabel = "" } = {}) {
  const problem = biometricEnvironmentProblem();
  if (problem) return { status: "unsupported", message: problem };
  // Checked before any passkey is made (synchronous, so the tap still counts for create()).
  if (!isVaultEnabled()) return { status: "failed", message: "Set a password first." };
  if (!isVaultUnlocked()) return { status: "failed", message: "KaChat is locked. Enter your password first." };
  const rpId = hostname();
  // A previous enrolment's user handle (kept by a password change): the OS replaces that passkey
  // instead of adding a second "KaChat" one.
  const previous = loadBiometricRecord();
  let userId = null;
  try { userId = previous?.userId && previous.rpId === rpId ? base64UrlDecode(previous.userId) : null; } catch { userId = null; }
  if (!userId || userId.length < 16 || userId.length > 64) userId = randomBytes(16);
  const saltBytes = randomBytes(32);
  let credential;
  try {
    credential = await credentialsApi().create({
      publicKey: {
        rp: { id: rpId, name: "KaChat" },
        user: { id: userId, name: passkeyLabel(accountLabel), displayName: passkeyLabel(accountLabel) },
        challenge: randomBytes(32),
        pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
        authenticatorSelection: { authenticatorAttachment: "platform", userVerification: "required", residentKey: "required", requireResidentKey: true },
        attestation: "none",
        timeout: WEBAUTHN_TIMEOUT_MS,
        extensions: { prf: { eval: { first: saltBytes } } },
      },
    });
  } catch (error) {
    if (isCancel(error)) return { status: "cancelled" };
    if (errorName(error) === "NotSupportedError") return { status: "unsupported", message: BIOMETRIC_UNSUPPORTED_MESSAGE };
    return { status: "failed", message: "The passkey could not be created. Your password still works." };
  }
  const rawId = toBytes(credential?.rawId);
  if (!rawId || !rawId.length) return { status: "failed", message: "The passkey could not be created. Your password still works." };
  const pending = { rpId, credentialId: base64UrlEncode(rawId), userId: base64UrlEncode(userId), salt: bytesToHex(saltBytes) };
  const created = prfFirst(credential);
  if (created.first) return storeEnrolment(pending, created.first);
  // No PRF result on create (prf.enabled false, or a browser that only evaluates on get):
  // ask the passkey once more with the same salt.
  return finishBiometricEnrolment(pending, { firstTry: true });
}

/** The second half of enrolBiometric, also called from a click when it said "needs-confirm". */
export async function finishBiometricEnrolment(pending, { firstTry = false } = {}) {
  let result;
  try {
    result = await assertPrf({ rpId: pending.rpId, credentialId: pending.credentialId, saltBytes: hexToBytes(pending.salt) });
  } catch (error) {
    if (isCancel(error) && firstTry) return { status: "needs-confirm", pending };
    if (isCancel(error)) return { status: "cancelled" };
    tidyUnknownCredential(pending.rpId, pending.credentialId);
    return { status: "unsupported", message: BIOMETRIC_UNSUPPORTED_MESSAGE };
  }
  if (!result.first) {
    tidyUnknownCredential(pending.rpId, pending.credentialId);
    return { status: "unsupported", message: BIOMETRIC_UNSUPPORTED_MESSAGE };
  }
  return storeEnrolment(pending, result.first);
}

async function storeEnrolment(pending, prfOutput) {
  try {
    await enrolBiometricUnlock({ ...pending, prfOutput });
    return { status: "on" };
  } catch (error) {
    return { status: "failed", message: `${error?.message || "Face ID unlock could not be turned on."} Your password still works.` };
  }
}

/**
 * Unlocks KaChat with the enrolled passkey. Call it straight from a click (get() is its first
 * await), or from the launch auto-prompt where canAutoPromptBiometric() allows. Never touches the
 * password lockout. Resolves:
 *   { status: "unlocked" }
 *   { status: "cancelled" }   closed, timed out, or no matching passkey on this device
 *   { status: "failed", reason: "wrong-key" | "stale" | "no-prf" | "no-record" | "error" }
 */
export async function unlockWithBiometric() {
  const record = loadBiometricRecord();
  if (!hasBiometricUnlock() || biometricEnvironmentProblem()) return { status: "failed", reason: "no-record" };
  let result;
  try {
    result = await assertPrf({ rpId: record.rpId || hostname(), credentialId: record.credentialId, saltBytes: hexToBytes(record.salt) });
  } catch (error) {
    if (isCancel(error)) return { status: "cancelled" };
    return { status: "failed", reason: "error" };
  }
  if (result.unverified) return { status: "failed", reason: "wrong-key" };
  if (!result.first) return { status: "failed", reason: "no-prf" };
  const opened = await unlockKeyVaultWithBiometric(result.first);
  return opened.ok ? { status: "unlocked" } : { status: "failed", reason: opened.reason };
}

/** Turns it off. The passkey stays in the OS keychain (the user can delete it there); browsers that
 *  support it are told the passkey is no longer used, so they can hide or remove it. */
export function turnOffBiometricUnlock() {
  const record = loadBiometricRecord();
  removeBiometricUnlock();
  if (record?.credentialId && (record.rpId || hostname())) tidyUnknownCredential(record.rpId || hostname(), record.credentialId);
}
