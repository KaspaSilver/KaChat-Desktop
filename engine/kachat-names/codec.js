// .kachat names on Kaspa covenants: the transaction core, codecs.
//
// Port of iOS KaChat/Services/KachatNames/KachatNamesCodec.swift (design: KACHAT_NAMES.md,
// byte-level reference: kachat-domains/README.md, source of truth: the kachat-domains Rust
// harness and CLI). Everything in engine/kachat-names/ is pure value code over Uint8Array and
// BigInt (BLAKE3, BLAKE2b from @noble/hashes): no DOM, no Kaspa WASM, no network. It is checked
// byte for byte by tools/test-kachat-names-core.mjs against the kachat-domains vectors.
//
// Conventions: bytes are Uint8Array; Swift UInt64/Int64 values (amounts in sompi, DAA scores,
// timestamps, lock times, sequences, prices, years) are BigInt; small integers (UInt16/UInt32
// indexes, lengths, budgets) are Number.

import { blake3 as nobleBlake3 } from "@noble/hashes/blake3.js";
import { blake2b as nobleBlake2b } from "@noble/hashes/blake2.js";

/** Errors the core throws. Messages are for logs and developer UI; the screens map them. */
export class Failure extends Error {
  constructor(message) {
    super(message);
    this.name = "KachatNamesFailure";
  }

  /**
   * The manifest describes a registry this app doesn't build for: an earlier one (v1 - v3) or a
   * later one than v5 (`newerRegistry`). Not an error to show as one: the screens say the
   * registry is being set up. (Swift `Failure.outdatedRegistry` / `newerRegistry`, iOS 6f18475.)
   */
  static outdatedRegistry() { return new Failure(outdatedRegistryMessage); }
  static newerRegistry() { return new Failure(newerRegistryMessage); }
  /** Registry v5: `register` is refused until the migration deadline (unix ms).
   *  Swift `Failure.registrationNotOpen`. */
  static registrationNotOpen(deadlineMs) {
    return new Failure(`registration opens after the migration deadline (${BigInt(deadlineMs)})`);
  }

  /** Whether this is `Failure.outdatedRegistry()` or `Failure.newerRegistry()` (Swift
   *  `isOutdatedRegistry`). */
  get isOutdatedRegistry() { return this.message === outdatedRegistryMessage || this.message === newerRegistryMessage; }
  /** Whether this is `Failure.newerRegistry()`. */
  get isNewerRegistry() { return this.message === newerRegistryMessage; }
}

/** The message of `Failure.outdatedRegistry()`. */
export const outdatedRegistryMessage = "manifest: an earlier registry; this app needs a registry v4 or v5 manifest";
/** The message of `Failure.newerRegistry()`. */
export const newerRegistryMessage = "manifest: a later registry version than this app builds for; update KaChat";

// MARK: - Constants (rusty-kaspa a41a333, kachat-domains params)

export const sompiPerKas = 100_000_000n;
/** A mainnet period. Registry v3 reads the period from the manifest (`params.periodMs`):
 *  testnet-10 runs a 24-hour clock. */
export const yearMs = 31_536_000_000n;
/** rusty-kaspa `LOCK_TIME_THRESHOLD`: lock times below it are DAA scores, above unix ms. */
export const lockTimeThreshold = 500_000_000_000n;
/** Value of a commit UTXO (returned at registration). */
export const commitValue = 20_000_000n;
/** Change below this is not worth a UTXO (its storage mass alone would outweigh it). */
export const minChange = 20_000_000n;
/** The builders aim for at least this much change. */
export const targetChange = 100_000_000n;
/** Relay floor after Toccata: 100 sompi per gram of max(compute, normalized transient). */
export const minFeerate = 100.0;
/** The most any name transaction pays per gram: 1000x the floor (the busiest testnet-10 seen,
 *  2026-10-07, asked 894). A fee estimate above it is treated as unknown (iOS 7e2b6cd, IOS-061). */
export const maxFeerate = minFeerate * 1000;

/** A fee rate that is always safe to multiply: never NaN, infinite or negative, and within
 *  [minFeerate, maxFeerate] - so a bad value from a node can neither crash nor drain (Swift
 *  `KachatNames.safeFeerate`, IOS-061). */
export function safeFeerate(rate) {
  const r = Number(rate);
  if (!Number.isFinite(r) || !(r > 0)) return minFeerate;
  return Math.min(Math.max(r, minFeerate), maxFeerate);
}
/** register, extend and renew sum at most 8 inputs and 8 outputs (the contracts' bounded loops). */
export const maxInputsFeeEntry = 8;
/** Every other operation: keep transactions small anyway. */
export const maxInputs = 24;
/** The highest listing price the name contract accepts. */
export const maxListPrice = 2_900_000_000_000_000_000n;
export const sighashAll = 0x01;
export const maxProfileJSONBytes = 2048;

const U16_MAX = 0xffffn;
const U32_MAX = 0xffff_ffffn;
const U64_MAX = 0xffff_ffff_ffff_ffffn;
const I64_MAX = 0x7fff_ffff_ffff_ffffn;
const I64_MIN = -0x8000_0000_0000_0000n;

/** 32 zero bytes (a fresh copy). */
export function zero32() { return new Uint8Array(32); }
/** 32 0xff bytes (a fresh copy). */
export function ff32() { return new Uint8Array(32).fill(0xff); }

// MARK: - Bytes

/** UTF-8 bytes of a string. */
export function utf8(s) { return new TextEncoder().encode(s); }

/** Lossy UTF-8 decoding (Swift `String(decoding:as:UTF8.self)`). */
export function fromUtf8(b) { return new TextDecoder().decode(b); }

/** `"kachat-commit:v1"`, the commit hash domain. */
export function commitDomain() { return utf8("kachat-commit:v1"); }

/** Concatenate byte arrays (and plain number arrays). */
export function concat(...parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** Byte-wise equality. Null/undefined equal only each other. */
export function bytesEqual(a, b) {
  if (a == null || b == null) return a == null && b == null;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Swift `lexicographicallyPrecedes` over bytes: a < b. */
export function bytesLess(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] < b[i];
  return a.length < b.length;
}

/** First index of `needle` inside `hay`, or -1 (Swift `Data.range(of:)`). */
export function indexOfBytes(hay, needle) {
  if (needle.length === 0) return 0;
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

// MARK: - Hex

/** Lowercase hex of bytes. */
export function hex(data) {
  let out = "";
  for (const b of data) out += (b < 16 ? "0" : "") + b.toString(16);
  return out;
}

/** Hex (either case) to bytes; throws on odd length or a bad digit. */
export function unhex(string) {
  if (typeof string !== "string") throw new Failure("bad hex digit");
  if (string.length % 2 !== 0) throw new Failure("odd-length hex");
  const nibble = (c) => {
    if (c >= 0x30 && c <= 0x39) return c - 0x30;
    if (c >= 0x61 && c <= 0x66) return c - 0x61 + 10;
    if (c >= 0x41 && c <= 0x46) return c - 0x41 + 10;
    throw new Failure("bad hex digit");
  };
  const out = new Uint8Array(string.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = (nibble(string.charCodeAt(2 * i)) << 4) | nibble(string.charCodeAt(2 * i + 1));
  }
  return out;
}

/** Hex of exactly 32 bytes. */
export function unhex32(string) {
  const d = unhex(string);
  if (d.length !== 32) throw new Failure("expected 32 hex bytes");
  return d;
}

// MARK: - Little-endian helpers

function leN(v, n, max) {
  let x = BigInt(v);
  if (x < 0n || x > max) throw new Failure(`le${n * 8}: ${v} out of range`);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) { out[i] = Number(x & 0xffn); x >>= 8n; }
  return out;
}

/** 2-byte little-endian (UInt16). */
export function le16(v) { return leN(v, 2, U16_MAX); }
/** 4-byte little-endian (UInt32). */
export function le32(v) { return leN(v, 4, U32_MAX); }
/** 8-byte little-endian (UInt64). */
export function le64(v) { return leN(v, 8, U64_MAX); }

// MARK: - Hashes

/** Unkeyed BLAKE3-256. */
export function blake3(data) { return nobleBlake3(data); }

/** Unkeyed BLAKE2b-256 (the P2SH script hash). */
export function blake2b256(data) { return nobleBlake2b(data, { dkLen: 32 }); }

/** rusty-kaspa `blake2b_hasher!` (keyed BLAKE2b-256, the domain string as the key). */
export function blake2bKeyed(domain, data) {
  return nobleBlake2b(data, { key: utf8(domain), dkLen: 32 });
}

/** rusty-kaspa `blake3_hasher!` (keyed BLAKE3, the domain string zero padded to 32 bytes). */
export function blake3Keyed(domain, data) {
  const k = utf8(domain);
  if (k.length > 32) throw new Failure("BLAKE3 domain longer than its key");
  const key = new Uint8Array(32);
  key.set(k);
  return nobleBlake3(data, { key });
}

// MARK: - Names

/** What a person types, made canonical: trimmed, lowercased, `.kachat` dropped. */
export function normalize(raw) {
  let s = String(raw).trim().toLowerCase();
  if (s.endsWith(".kachat")) s = s.slice(0, -".kachat".length);
  return s;
}

/** The gap's rule: `a-z 0-9 -`, 1..32 bytes, no hyphen at either end. Throws a Failure. */
export function validate(name) {
  const b = utf8(name);
  if (b.length === 0 || b.length > 32) throw new Failure("a name is 1..32 characters");
  for (const c of b) {
    const ok = (c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39) || c === 0x2d;
    if (!ok) throw new Failure("a name is a-z, 0-9 and '-' only");
  }
  if (b[0] === 0x2d || b[b.length - 1] === 0x2d) throw new Failure("a name cannot start or end with '-'");
}

/** `validate` as a boolean. */
export function isValid(name) {
  try { validate(name); return true; } catch { return false; }
}

/** `key = blake3(name)`. */
export function key(name) { return blake3(utf8(name)); }

/** The name zero padded to 32 bytes (the name state field). */
export function padded(name) {
  const d = new Uint8Array(32);
  d.set(utf8(name).subarray(0, 32));
  return d;
}

/** The name in a padded field (bytes up to the first zero). */
export function unpadded(field) {
  let n = field.indexOf(0);
  if (n < 0) n = field.length;
  return fromUtf8(field.subarray(0, n));
}

/** Price tier index for a name of `length` bytes: 1, 2, 3, 4, 5+ -> 0..4. */
export function tier(length) { return Math.min(Math.max(length, 1), 5) - 1; }

// MARK: Commit

/** `blake3("kachat-commit:v1" || name || ownerKey || salt)`. */
export function commitment(name, owner, salt) {
  return nobleBlake3.create().update(commitDomain()).update(utf8(name)).update(owner).update(salt).digest();
}

/** `0x20 <c> OP_DROP 0x20 <ownerKey> OP_CHECKSIG` (68 bytes). */
export function commitRedeem(c, owner) {
  return concat([0x20], c, [0x75, 0x20], owner, [0xac]);
}

// MARK: Integers

function checkI64(v, what) {
  const x = BigInt(v);
  if (x < I64_MIN || x > I64_MAX) throw new Failure(`${what}: ${v} is not an Int64`);
  if (x === I64_MIN) throw new Failure(`${what} of Int64.min`);
  return x;
}

/** 8-byte little-endian sign-magnitude (state ints, template part lengths). */
export function num8(v) {
  const x = checkI64(v, "num8");
  const out = le64(x < 0n ? -x : x);
  if (x < 0n) out[7] |= 0x80;
  return out;
}

/** 8 bytes of sign-magnitude -> BigInt. */
export function decodeNum8(d) {
  if (d.length !== 8) throw new Failure("state int must be 8 bytes");
  return scriptNum(d);
}

/** Minimal script number bytes (rusty-kaspa `serialize_i64(v, None)`); empty for 0. */
export function minimalNumber(v) {
  const x = checkI64(v, "minimalNumber");
  let magnitude = x < 0n ? -x : x;
  const out = [];
  while (magnitude > 0n) {
    out.push(Number(magnitude & 0xffn));
    magnitude >>= 8n;
  }
  if (out.length > 0 && (out[out.length - 1] & 0x80) !== 0) {
    out.push(x < 0n ? 0x80 : 0x00);
  } else if (x < 0n) {
    out[out.length - 1] |= 0x80;
  }
  return Uint8Array.from(out);
}

/** Little-endian sign-magnitude bytes -> BigInt (Int64). */
export function scriptNum(b) {
  if (b.length === 0) return 0n;
  if (b.length > 8) throw new Failure("script number longer than 8 bytes");
  let v = 0n;
  for (let k = 0; k < b.length; k++) {
    const x = k === b.length - 1 ? b[k] & 0x7f : b[k];
    v |= BigInt(x) << BigInt(8 * k);
  }
  const negative = (b[b.length - 1] & 0x80) !== 0;
  return negative ? -v : v;
}

// MARK: States

/** Gap state, 66 bytes: `0x20 lo 0x20 hi`. */
export function gapState(lo, hi) { return concat([0x20], lo, [0x20], hi); }

/**
 * Name state (registry v2 and v3, unchanged), 126 bytes:
 * `0x20 key 0x20 name 0x20 owner 0x08 price 0x08 periodStart 0x08 expiresAt`
 * (price at bytes 100..108, periodStart 109..117, expiresAt 118..126).
 */
export function nameState(f) {
  return concat([0x20], f.key, [0x20], f.paddedName, [0x20], f.owner, [0x08], num8(f.price), [0x08], num8(f.periodStart),
    [0x08], num8(f.expiresAt));
}

/** Offer state (registry v3), 108 bytes: `0x20 key 0x20 buyer 0x20 seller 0x08 refundAfter`. */
export function offerState(f) {
  return concat([0x20], f.key, [0x20], f.buyer, [0x20], f.seller, [0x08], num8(f.refundAfter));
}

/** A gap state -> `{ lo, hi }`. */
export function decodeGapState(s) {
  if (s.length !== 66 || s[0] !== 0x20 || s[33] !== 0x20) throw new Failure("not a gap state");
  return { lo: s.slice(1, 33), hi: s.slice(34, 66) };
}

/** A name state -> NameFields. */
export function decodeNameState(s) {
  if (s.length !== 126 || s[0] !== 0x20 || s[33] !== 0x20 || s[66] !== 0x20 || s[99] !== 0x08 || s[108] !== 0x08 || s[117] !== 0x08) {
    throw new Failure("not a name state");
  }
  return makeNameFields({
    key: s.slice(1, 33), paddedName: s.slice(34, 66), owner: s.slice(67, 99),
    price: decodeNum8(s.subarray(100, 108)), periodStart: decodeNum8(s.subarray(109, 117)),
    expiresAt: decodeNum8(s.subarray(118, 126)),
  });
}

/** An offer state -> OfferFields. */
export function decodeOfferState(s) {
  if (s.length !== 108 || s[0] !== 0x20 || s[33] !== 0x20 || s[66] !== 0x20 || s[99] !== 0x08) throw new Failure("not an offer state");
  return makeOfferFields({
    key: s.slice(1, 33), buyer: s.slice(34, 66), seller: s.slice(67, 99), refundAfter: decodeNum8(s.subarray(100, 108)),
  });
}

// MARK: Scripts

/** `OP_BLAKE2B <blake2b-256(redeem)> OP_EQUAL` (rusty-kaspa `pay_to_script_hash_script`). */
export function p2shScript(redeem) { return concat([0xaa, 0x20], blake2b256(redeem), [0x87]); }

/** Schnorr P2PK: `0x20 <x-only key> OP_CHECKSIG`. */
export function p2pkScript(xonly) { return concat([0x20], xonly, [0xac]); }

/** The x-only key of a Schnorr P2PK script, null for anything else. */
export function p2pkKey(script) {
  if (script.length !== 34 || script[0] !== 0x20 || script[33] !== 0xac) return null;
  return script.slice(1, 33);
}

/** Canonical minimal push (rusty-kaspa `ScriptBuilder::add_data`). */
export function pushData(data) {
  const n = data.length;
  if (n === 0) return Uint8Array.of(0x00);
  if (n === 1) {
    const v = data[0];
    if (v >= 1 && v <= 16) return Uint8Array.of(0x50 + v);
    if (v === 0x81) return Uint8Array.of(0x4f);
  }
  let head;
  if (n <= 75) head = [n];
  else if (n <= 0xff) head = [0x4c, n];
  else if (n <= 0xffff) head = concat([0x4d], le16(n));
  else head = concat([0x4e], le32(n));
  return concat(head, data);
}

/** A script integer (rusty-kaspa `ScriptBuilder::add_i64`): OP_0, OP_1NEGATE, OP_1..OP_16,
 *  else a minimal sign-magnitude push. */
export function pushInt(v) {
  const x = BigInt(v);
  if (x === 0n) return Uint8Array.of(0x00);
  if (x === -1n) return Uint8Array.of(0x4f);
  if (x >= 1n && x <= 16n) return Uint8Array.of(0x50 + Number(x));
  return pushData(minimalNumber(x));
}

/** Every push of a push-only script, as bytes (OP_0 -> [], OP_n -> [n], OP_1NEGATE -> [0x81]). */
export function parsePushes(script) {
  const s = script;
  const out = [];
  let i = 0;
  const take = (n) => {
    if (i + n > s.length) throw new Failure("truncated push");
    const d = s.slice(i, i + n);
    i += n;
    return d;
  };
  while (i < s.length) {
    const op = s[i];
    i += 1;
    if (op === 0x00) out.push(new Uint8Array(0));
    else if (op >= 0x01 && op <= 0x4b) out.push(take(op));
    else if (op === 0x4c) { const n = take(1)[0]; out.push(take(n)); }
    else if (op === 0x4d) { const l = take(2); out.push(take(l[0] | (l[1] << 8))); }
    else if (op === 0x4e) {
      const l = take(4);
      const n = (l[0] | (l[1] << 8) | (l[2] << 16)) + l[3] * 0x1000000;
      out.push(take(n));
    } else if (op === 0x4f) out.push(Uint8Array.of(0x81));
    else if (op >= 0x51 && op <= 0x60) out.push(Uint8Array.of(op - 0x50));
    else throw new Failure(`not a push-only script (opcode 0x${op.toString(16).padStart(2, "0")})`);
  }
  return out;
}

// MARK: Templates and covenant ids

/** silverscript `template_hash`: `blake3(num8(|prefix|) || prefix || num8(|suffix|) || suffix)`. */
export function templateHash(prefix, suffix) {
  return nobleBlake3.create()
    .update(num8(prefix.length)).update(prefix)
    .update(num8(suffix.length)).update(suffix)
    .digest();
}

/** rusty-kaspa `covenant_id(outpoint, authorized outputs)` (KIP-20).
 *  `outpoint` = { txid, index }; `authorized` = [{ index, output: TxOutput }]. */
export function covenantId(outpoint, authorized) {
  const parts = [outpoint.txid, le32(outpoint.index), le64(authorized.length)];
  for (const { index, output: o } of authorized) {
    parts.push(le32(index), le64(o.value), le16(o.scriptVersion ?? 0), le64(o.script.length), o.script);
  }
  return blake2bKeyed("CovenantID", concat(...parts));
}

// MARK: Payload markers (KACHAT_NAMES_INDEXER.md B4)

/** `kchat:1:name:<op>:<name>`: informational, on every name transaction except commits. */
export function namePayload(op, name) { return utf8(`kchat:1:name:${op}:${name}`); }

/** `kchat:1:offer:<keyHex>:<buyerXonlyHex>:<sellerXonlyHex>:<refundAfterDaa>` (registry v3):
 *  how an indexer finds offers. */
export function offerPayload(f) {
  return utf8(`kchat:1:offer:${hex(f.key)}:${hex(f.buyer)}:${hex(f.seller)}:${BigInt(f.refundAfter)}`);
}

/** `kchat:1:profile:<json>`: an address profile record (KACHAT_NAMES.md section 7). */
export function profilePayload(json) {
  return concat(utf8("kchat:1:profile:"), typeof json === "string" ? utf8(json) : json);
}

// MARK: - Typed states

/**
 * NameFields `{ key, paddedName, owner, price: BigInt, periodStart: BigInt, expiresAt: BigInt }`.
 * `periodStart` (unix ms, registry v2) is the start of the current paid period: register sets it
 * to `now`, `renew` to the old expiry; every other entry keeps it.
 */
export function makeNameFields({ key: k, paddedName, owner, price, periodStart, expiresAt }) {
  if (periodStart == null) throw new Failure("name fields need periodStart (registry v2)");
  return { key: k, paddedName, owner, price: BigInt(price), periodStart: BigInt(periodStart), expiresAt: BigInt(expiresAt) };
}

/** NameFields for a plain name (key and padded field derived from it). */
export function nameFieldsFor(name, owner, price, periodStart, expiresAt) {
  return makeNameFields({ key: key(name), paddedName: padded(name), owner, price, periodStart, expiresAt });
}

/** The name a NameFields holds. */
export function nameFieldsName(f) { return unpadded(f.paddedName); }

/** transfer / buy / offer accept: new owner, listing cleared, period and expiry kept. */
export function nameFieldsWithOwner(f, owner) { return makeNameFields({ ...f, owner, price: 0n }); }

/** list: the price, period and expiry kept. */
export function nameFieldsWithPrice(f, price) { return makeNameFields({ ...f, price }); }

function periodOf(periodMs) {
  if (periodMs == null) throw new Failure("periodMs is required (registry v3: manifest params.periodMs)");
  return BigInt(periodMs);
}

/** What `extend(years)` leaves: the same period start, the expiry `years` periods later
 *  (`periodMs` = manifest `params.periodMs`). */
export function nameFieldsExtended(f, years, periodMs) {
  return makeNameFields({ ...f, expiresAt: f.expiresAt + BigInt(years) * periodOf(periodMs) });
}

/** What `renew(years)` leaves: a new period from the old expiry, so no time is lost or gained. */
export function nameFieldsRenewed(f, years, periodMs) {
  return makeNameFields({ ...f, periodStart: f.expiresAt, expiresAt: f.expiresAt + BigInt(years) * periodOf(periodMs) });
}

/** NameFields equality. */
export function nameFieldsEqual(a, b) {
  return bytesEqual(a.key, b.key) && bytesEqual(a.paddedName, b.paddedName) && bytesEqual(a.owner, b.owner)
    && a.price === b.price && a.periodStart === b.periodStart && a.expiresAt === b.expiresAt;
}

/** OfferFields `{ key, buyer, seller, refundAfter: BigInt }`. `seller` (registry v3) is the name's
 *  owner the offer was made to: only they can accept or decline it. */
export function makeOfferFields({ key: k, buyer, seller, refundAfter }) {
  if (seller == null) throw new Failure("offer fields need a seller (registry v3)");
  return { key: k, buyer, seller, refundAfter: BigInt(refundAfter) };
}

/** OfferFields equality. */
export function offerFieldsEqual(a, b) {
  return bytesEqual(a.key, b.key) && bytesEqual(a.buyer, b.buyer) && bytesEqual(a.seller, b.seller)
    && a.refundAfter === b.refundAfter;
}
