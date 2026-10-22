// Web Push, the parts with no browser in them: the signed-challenge auth the push service checks,
// the registration body, base64url / key conversions and the address helpers. ui/web-push.js does
// the browser half (service worker, PushManager, IndexedDB, fetch). Kept pure so
// tools/test-web-push.mjs can pin every byte of what is signed.
//
// The auth is a byte-for-byte port of iOS's PushNotificationManager.buildPushAuth /
// buildAuthPreimage / buildDeviceAuthPreimage and of what the push service verifies
// (kachat-indexer kasia-indexer/indexer/src/api/v1/push.rs build_auth_preimage,
// build_device_auth_preimage, select_auth_format):
//   * the wallet signs SHA-256(preimage) with BIP340 Schnorr, hex;
//   * register/update always send `watched_group_ids` (an array, possibly empty) and no
//     `auth_version`, so the service picks its "transitional groups" format: domain
//     kchat-push-auth:v1 WITH a watched_group_ids_hash line, no capabilities line;
//   * unregister is verified with empty lists and no group ids: the LegacyV1 format (no
//     watched_group_ids_hash line) over empty watched/aliases and an empty primary address;
//   * the device key (P-256) signs its own short preimage, so a registration can be removed or
//     moved to another wallet without that wallet's key.
import { sha256 } from "@noble/hashes/sha2.js";
import { schnorr, secp256k1 } from "@noble/curves/secp256k1.js";

export const PUSH_AUTH_DOMAIN_V1 = "kchat-push-auth:v1";
export const PUSH_DEVICE_AUTH_DOMAIN = "kchat-push-device-auth:v1";
export const PUSH_DEVICE_AUTH_SCHEME = "device_key_v1";
export const PUSH_PATHS = Object.freeze({
  challenge: "/v1/push/challenge",
  register: "/v1/push/register",
  update: "/v1/push/update",
  unregister: "/v1/push/unregister",
  webConfig: "/v1/push/web-config",
});
// The service's limits (push.rs MAX_WATCHED_ADDRESSES / MAX_WATCHED_GROUP_IDS / MAX_ALIASES /
// MAX_WATCH_ONLY_ADDRESSES / MAX_KAPOSTS_WATCH_AUTHORS). Over them a register is refused outright.
export const PUSH_LIMITS = Object.freeze({ watched: 256, groups: 256, aliases: 256, watchOnly: 200, watchAuthors: 500 });

// ---- bytes ----------------------------------------------------------------------------------
const UTF8 = new TextEncoder();
export function utf8(text) { return UTF8.encode(String(text)); }
export function bytesToHex(bytes) {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}
export function hexToBytes(hex) {
  const clean = String(hex || "").trim();
  if (clean.length % 2 || /[^0-9a-f]/i.test(clean)) throw new Error("Invalid hex");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}
export function sha256Hex(text) { return bytesToHex(sha256(utf8(text))); }

function toBinaryString(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return out;
}
export function toBase64(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return btoa(toBinaryString(view));
}
/** base64url without padding (RFC 4648 §5), the form Web Push keys travel in. */
export function toBase64Url(bytes) {
  return toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
/** Either base64 alphabet, padded or not. */
export function fromBase64Url(text) {
  const clean = String(text || "").trim().replace(/-/g, "+").replace(/_/g, "/").replace(/\s+/g, "");
  if (/[^A-Za-z0-9+/=]/.test(clean)) throw new Error("Invalid base64");
  const padded = clean + "===".slice((clean.length + 3) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}
/** A VAPID public key from the server: base64url of an uncompressed P-256 point (65 bytes, 0x04). */
export function vapidKeyBytes(text) {
  const bytes = fromBase64Url(text);
  if (bytes.length !== 65 || bytes[0] !== 0x04) throw new Error("VAPID public key must be an uncompressed P-256 point");
  return bytes;
}
export function sameBytes(a, b) {
  if (!a || !b) return false;
  const x = a instanceof Uint8Array ? a : new Uint8Array(a);
  const y = b instanceof Uint8Array ? b : new Uint8Array(b);
  if (x.length !== y.length) return false;
  for (let i = 0; i < x.length; i += 1) if (x[i] !== y[i]) return false;
  return true;
}

// ---- canonical lists (push.rs canonicalize_*) ---------------------------------------------------
function canonicalSet(values, normalize) {
  const set = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const normalized = normalize(String(value ?? ""));
    if (normalized) set.add(normalized);
  }
  // Rust sorts Strings by bytes; for the ASCII these lists hold that is JS's default order.
  return [...set].sort();
}
export function canonicalWatchedAddresses(values) { return canonicalSet(values, (v) => v.trim().toLowerCase()); }
export function canonicalGroupIds(values) { return canonicalSet(values, (v) => v.trim().toLowerCase()); }
export function canonicalAliases(values) { return canonicalSet(values, (v) => v.trim()); }

/** A Web Push device token is the subscription endpoint URL, trimmed and otherwise verbatim (the
 *  service must store and hash it the same way - docs/WEB_PUSH_SERVER.md §2). */
export function normalizeWebDeviceToken(endpoint) {
  const token = String(endpoint || "").trim();
  if (!/^https:\/\/[^\s]+$/.test(token) || token.length > 2048) throw new Error("Push endpoint must be an https URL");
  return token;
}

// ---- preimages -------------------------------------------------------------------------------
/**
 * The wallet-auth preimage. `withGroupIds` true = the format register/update are verified in
 * (iOS buildAuthPreimage with includeWatchedGroupIds); false = LegacyV1 (unregister).
 */
export function buildAuthPreimage({
  nonce, method, path, deviceToken, watchedAddresses = [], watchedGroupIds = [], primaryAddress = "",
  aliases = [], walletPubkey, walletAddress, timestampMs, expiresAtMs, withGroupIds = true,
}) {
  const lines = [
    `domain=${PUSH_AUTH_DOMAIN_V1}`,
    `nonce=${String(nonce || "").trim()}`,
    `method=${method}`,
    `path=${path}`,
    `device_token_hash=${sha256Hex(deviceToken)}`,
    `watched_addresses_hash=${sha256Hex(canonicalWatchedAddresses(watchedAddresses).join("\n"))}`,
  ];
  if (withGroupIds) lines.push(`watched_group_ids_hash=${sha256Hex(canonicalGroupIds(watchedGroupIds).join("\n"))}`);
  lines.push(
    `primary_address=${primaryAddress || ""}`,
    `aliases_hash=${sha256Hex(canonicalAliases(aliases).join("\n"))}`,
    `wallet_pubkey=${walletPubkey}`,
    `wallet_address=${walletAddress}`,
    `timestamp_ms=${timestampMs}`,
    `expires_at_ms=${expiresAtMs}`,
  );
  return lines.join("\n");
}

export function buildDeviceAuthPreimage({ nonce, method, path, deviceToken, keyId, counter, timestampMs, expiresAtMs }) {
  return [
    `domain=${PUSH_DEVICE_AUTH_DOMAIN}`,
    `nonce=${String(nonce || "").trim()}`,
    `method=${method}`,
    `path=${path}`,
    `device_token_hash=${sha256Hex(deviceToken)}`,
    `key_id=${keyId}`,
    `counter=${counter}`,
    `timestamp_ms=${timestampMs}`,
    `expires_at_ms=${expiresAtMs}`,
  ].join("\n");
}

/** iOS: the signed time is the local clock clamped into the challenge's window. */
export function clampAuthTimestamp(nowMs, issuedAtMs, expiresAtMs) {
  return Math.min(Math.max(Math.floor(Number(nowMs) || 0), Number(issuedAtMs) || 0), Number(expiresAtMs) || 0);
}

// ---- keys ------------------------------------------------------------------------------------
/** The wallet's x-only (BIP340) public key, 64 lowercase hex - `wallet_pubkey`. */
export function walletPubkeyHex(privateKeyHex) { return bytesToHex(schnorr.getPublicKey(hexToBytes(privateKeyHex))); }
/** The 66-hex compressed key K (KaPosts) identifies the account by - `kaposts_pubkey`. */
export function compressedPubkeyHex(privateKeyHex) { return bytesToHex(secp256k1.getPublicKey(hexToBytes(privateKeyHex), true)); }
/** BIP340 signature over SHA-256(preimage), hex (iOS: P256K.Schnorr over the digest). */
export function signPreimage(preimage, privateKeyHex, auxRand) {
  const digest = sha256(utf8(preimage));
  return bytesToHex(auxRand ? schnorr.sign(digest, hexToBytes(privateKeyHex), auxRand) : schnorr.sign(digest, hexToBytes(privateKeyHex)));
}
export function verifyPreimageSignature(preimage, signatureHex, walletPubkey) {
  try { return schnorr.verify(hexToBytes(signatureHex), sha256(utf8(preimage)), hexToBytes(walletPubkey)); }
  catch { return false; }
}

/** `auth` for a register/update/unregister body. `deviceProof` is from the device key (optional). */
export function buildPushAuth({ privateKeyHex, walletAddress, challenge, method, path, deviceToken, watchedAddresses, watchedGroupIds, primaryAddress, aliases, withGroupIds = true, nowMs = Date.now(), auxRand }) {
  const walletPubkey = walletPubkeyHex(privateKeyHex);
  const timestampMs = clampAuthTimestamp(nowMs, challenge.issued_at_ms, challenge.expires_at_ms);
  const preimage = buildAuthPreimage({
    nonce: challenge.nonce, method, path, deviceToken, watchedAddresses, watchedGroupIds,
    primaryAddress, aliases, walletPubkey, walletAddress, timestampMs, expiresAtMs: challenge.expires_at_ms, withGroupIds,
  });
  return {
    preimage,
    auth: {
      wallet_pubkey: walletPubkey,
      wallet_address: walletAddress,
      nonce: String(challenge.nonce || "").trim(),
      timestamp_ms: timestampMs,
      expires_at_ms: challenge.expires_at_ms,
      signature: signPreimage(preimage, privateKeyHex, auxRand),
    },
  };
}

/** Next device-auth counter: strictly above the last one the service saw, never going backwards
 *  even if the stored counter is lost (time in ms is far above any count). */
export function nextDeviceCounter(lastCounter, nowMs = Date.now()) {
  return Math.max(Math.floor(Number(lastCounter) || 0) + 1, Math.floor(Number(nowMs) || 0));
}

// ---- Kaspa addresses (bech32 variant, CashAddr checksum) -------------------------------------
const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
function polymod(values) {
  const GEN = [0x98f2bc8e61n, 0x79b76d99e2n, 0xf33e5fb3c4n, 0xae2eabe2a8n, 0x1e4f43e470n];
  let c = 1n;
  for (const d of values) {
    const c0 = c >> 35n;
    c = ((c & 0x07ffffffffn) << 5n) ^ BigInt(d);
    for (let i = 0; i < 5; i += 1) if ((c0 >> BigInt(i)) & 1n) c ^= GEN[i];
  }
  return c ^ 1n;
}
function convertBits(data, from, to, pad) {
  let acc = 0; let bits = 0; const out = []; const maxv = (1 << to) - 1;
  for (const value of data) {
    acc = (acc << from) | value; bits += from;
    while (bits >= to) { bits -= to; out.push((acc >> bits) & maxv); }
  }
  if (pad && bits > 0) out.push((acc << (to - bits)) & maxv);
  return out;
}
export function encodeKaspaAddress(prefix, version, payload) {
  const data = convertBits([version, ...payload], 8, 5, true);
  const prefixBits = [...prefix].map((ch) => ch.charCodeAt(0) & 0x1f);
  const checksum = polymod([...prefixBits, 0, ...data, 0, 0, 0, 0, 0, 0, 0, 0]);
  const checksumData = [];
  for (let i = 7; i >= 0; i -= 1) checksumData.push(Number((checksum >> BigInt(5 * i)) & 0x1fn));
  return `${prefix}:${[...data, ...checksumData].map((v) => CHARSET[v]).join("")}`;
}
/** { prefix, version, payload } of a Kaspa address, or null when it is not one (checksum included). */
export function decodeKaspaAddress(address) {
  const text = String(address || "").trim().toLowerCase();
  const colon = text.indexOf(":");
  if (colon <= 0) return null;
  const prefix = text.slice(0, colon);
  const body = text.slice(colon + 1);
  if (body.length < 9) return null;
  const values = [];
  for (const ch of body) {
    const v = CHARSET.indexOf(ch);
    if (v < 0) return null;
    values.push(v);
  }
  const prefixBits = [...prefix].map((ch) => ch.charCodeAt(0) & 0x1f);
  if (polymod([...prefixBits, 0, ...values]) !== 0n) return null;
  const bytes = convertBits(values.slice(0, -8), 5, 8, false);
  if (!bytes.length) return null;
  return { prefix, version: bytes[0], payload: Uint8Array.from(bytes.slice(1)) };
}
/** The key K knows an author by, from their address: a Schnorr address (version 0) carries the
 *  x-only key (64 hex, which the service accepts as is); an ECDSA one (version 1) the compressed
 *  key (66 hex). Anything else (script hash) has no author key. */
export function authorKeyFromAddress(address) {
  const decoded = decodeKaspaAddress(address);
  if (!decoded) return null;
  if (decoded.version === 0 && decoded.payload.length === 32) return bytesToHex(decoded.payload);
  if (decoded.version === 1 && decoded.payload.length === 33) return bytesToHex(decoded.payload);
  return null;
}

// ---- the registration body -------------------------------------------------------------------
function cappedUnique(values, limit, normalize = (v) => String(v || "").trim()) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(values) ? values : []) {
    const value = normalize(raw);
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * The fields a Web Push registration sends, iOS PushRegistrationRequest's set plus `web_push`
 * (docs/WEB_PUSH_SERVER.md §3). `input.watchedAddresses` should come most-recent first: over the
 * service's limit the oldest chats are the ones left out. Everything but `auth` - the caller signs
 * over the returned lists so the signature and the body cannot disagree.
 */
export function buildRegistrationFields(input) {
  const watchedAddresses = cappedUnique(input.watchedAddresses, PUSH_LIMITS.watched, (v) => String(v || "").trim().toLowerCase());
  const watchedGroupIds = cappedUnique(input.watchedGroupIds, PUSH_LIMITS.groups, (v) => String(v || "").trim().toLowerCase());
  const aliases = cappedUnique(input.aliases, PUSH_LIMITS.aliases);
  const kaposts = input.kaposts || null;
  const hidden = {};
  for (const [channel, senders] of Object.entries(input.hiddenBroadcastSenders || {})) {
    const list = cappedUnique(senders, 500);
    if (list.length) hidden[String(channel).trim().toLowerCase()] = list.sort();
  }
  return {
    device_token: normalizeWebDeviceToken(input.endpoint),
    platform: "web",
    watched_addresses: watchedAddresses,
    watched_group_ids: watchedGroupIds,
    watched_broadcast_channels: cappedUnique(input.broadcastChannels, 64, (v) => String(v || "").trim().toLowerCase()).sort(),
    hidden_broadcast_senders: hidden,
    kaposts_pubkey: kaposts?.pubkey || null,
    kaposts_notify_likes: kaposts ? kaposts.likes !== false : true,
    kaposts_notify_dislikes: kaposts ? kaposts.dislikes !== false : true,
    kaposts_notify_comments: kaposts ? kaposts.comments !== false : true,
    kaposts_notify_reposts: kaposts ? kaposts.reposts !== false : true,
    kaposts_notify_follows: kaposts ? kaposts.follows !== false : true,
    kaposts_watch_authors: kaposts?.pubkey ? cappedUnique(input.kapostsWatchAuthors, PUSH_LIMITS.watchAuthors, (v) => String(v || "").trim().toLowerCase()).sort() : [],
    watch_only_addresses: cappedUnique(input.watchOnlyAddresses, PUSH_LIMITS.watchOnly),
    primary_address: input.primaryAddress || null,
    aliases,
    web_push: {
      endpoint: normalizeWebDeviceToken(input.endpoint),
      p256dh: String(input.p256dh || ""),
      auth: String(input.authSecret || ""),
    },
  };
}

/** What decides "the server already has this": everything sent except the auth, order-free. */
export function registrationFingerprint(fields, walletAddress) {
  const stable = (value) => {
    if (Array.isArray(value)) return [...value].map(stable).sort();
    if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((k) => [k, stable(value[k])]));
    return value;
  };
  return sha256Hex(JSON.stringify({ wallet: walletAddress || "", fields: stable(fields) }));
}
