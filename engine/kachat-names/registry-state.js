// .kachat names: the registry as data.
//
// Port of iOS KaChat/Services/KachatNames/KachatNamesRegistryState.swift: what a name, gap or
// offer looks like to the screens, the status rule (KACHAT_NAMES_INDEXER.md B5), the label rule
// (KACHAT_NAMES.md section 7), the address profile record, the REST transaction parser, the
// indexer response shapes (Part D), and the chain walker's state with its transition decoder (a
// port of the kachat-domains CLI's `Registry::apply`, B3) and walk loop. Pure: no DOM, no
// network, no keys. Checked by tools/test-kachat-names-registry.mjs.
//
// Conventions as in the rest of engine/kachat-names: bytes are Uint8Array, Swift UInt64/Int64
// (amounts, prices, unix ms, DAA, years) are BigInt, small ints (output indexes) are Number,
// nil is null. The walker's state keeps hex strings (as Swift does) so its cache stays small.

import {
  Failure, hex, unhex, unhex32, bytesEqual, bytesLess, blake3, yearMs, zero32, ff32, utf8, fromUtf8,
  normalize, isValid, key as nameKey, padded, parsePushes, scriptNum, gapState, nameState, offerState,
  makeNameFields, makeOfferFields, nameFieldsWithOwner, nameFieldsWithPrice, nameFieldsWithExpiry, maxProfileJSONBytes,
} from "./codec.js";
import { makeOutpoint, makeTxOutput, makeCovenantBinding } from "./transaction.js";
import { templateRedeem, templateScript, templateStateOfRedeem } from "./manifest.js";

const I64_MAX = 0x7fff_ffff_ffff_ffffn;
const U64_MAX = 0xffff_ffff_ffff_ffffn;

/** Any integer-ish value (BigInt, Number, numeric string) as a BigInt; null stays null. */
function big(v) {
  if (v == null) return null;
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return BigInt(Math.trunc(v));
  return BigInt(v);
}

const bmax = (a, b) => (a > b ? a : b);

/** Unix ms now (BigInt). */
export function nowMs() { return BigInt(Date.now()); }

// MARK: - Status (KACHAT_NAMES_INDEXER.md B5)

/** A name's status. `Status.of(expiresAt, graceMs, nowMs)`; only `active` resolves. */
export const Status = Object.freeze({
  /** `now < expiresAt`: resolves, everything works. */
  active: "active",
  /** `expiresAt <= now < expiresAt + grace`: no longer resolves; only the owner sees it, as
   *  "renew to keep it". Nobody can take it. */
  grace: "grace",
  /** `now >= expiresAt + grace`, still unspent: anyone may reclaim it. */
  lapsed: "lapsed",
  of(expiresAt, graceMs, now = nowMs()) {
    const e = big(expiresAt), g = big(graceMs), n = big(now);
    if (n < e) return "active";
    if (n < e + g) return "grace";
    return "lapsed";
  },
  resolves(status) { return status === "active"; },
});

// MARK: - What the screens read

/** A registered name, from either source (indexer or chain walker).
 *  `{ name, key: bytes32, owner: bytes32 (x-only), price: bigint (0 = not listed), expiresAt: bigint,
 *     outpoint: {txid, index}, registeredAt: bigint|null, registeredTxId: string|null, updatedAt: bigint|null }` */
export class NameInfo {
  constructor({ name, key, owner, price = 0n, expiresAt, outpoint, registeredAt = null, registeredTxId = null, updatedAt = null }) {
    this.name = name;
    this.key = key;
    this.owner = owner;
    this.price = big(price);
    this.expiresAt = big(expiresAt);
    this.outpoint = outpoint;
    this.registeredAt = big(registeredAt);
    this.registeredTxId = registeredTxId ?? null;
    this.updatedAt = big(updatedAt);
  }
  get id() { return this.name; }
  get display() { return `${this.name}.kachat`; }
  get isListed() { return this.price > 0n; }
  /** The name's on-chain state fields (codec NameFields). */
  get fields() {
    return makeNameFields({ key: this.key, paddedName: padded(this.name), owner: this.owner, price: this.price, expiresAt: this.expiresAt });
  }
  status(graceMs, now = nowMs()) { return Status.of(this.expiresAt, graceMs, now); }
}

/** An unregistered interval `(lo, hi)` of the key space. */
export class GapInfo {
  constructor({ lo, hi, outpoint }) {
    this.lo = lo;
    this.hi = hi;
    this.outpoint = outpoint;
  }
  contains(key) { return bytesLess(this.lo, key) && bytesLess(key, this.hi); }
}

/** The answer for a typed name: `{ kind: "registered", name, info: NameInfo }` or
 *  `{ kind: "free", name, gap: GapInfo|null }` (gap null when the source knows it is free but
 *  not where). */
export const Lookup = Object.freeze({
  registered(info) { return { kind: "registered", name: info.name, info }; },
  free(name, gap = null) { return { kind: "free", name, gap: gap ?? null }; },
});

/** An open offer. `{ outpoint, key, name|null, buyer: bytes32, amount: bigint, refundAfter: bigint (DAA
 *  from which anyone may refund it), createdAt: bigint|null }` */
export class OfferInfo {
  constructor({ outpoint, key, name = null, buyer, amount, refundAfter, createdAt = null }) {
    this.outpoint = outpoint;
    this.key = key;
    this.name = name ?? null;
    this.buyer = buyer;
    this.amount = big(amount);
    this.refundAfter = big(refundAfter);
    this.createdAt = big(createdAt);
  }
  get id() { return `${hex(this.outpoint.txid)}:${this.outpoint.index}`; }
  /** The offer's on-chain state fields (codec OfferFields). */
  get fields() { return makeOfferFields({ key: this.key, buyer: this.buyer, refundAfter: this.refundAfter }); }
  refundable(atDaa) { return big(atDaa) > bmax(this.refundAfter, 0n); }
}

/** One registry event (history, activity). Parties are x-only keys (hex, walker) or addresses
 *  (indexer). `op`: register, transfer, list, delist, sale, renew, release, reclaim,
 *  offer_accepted, offer, offer_accept, offer_withdraw, offer_refund. */
export class Event {
  constructor({ txId, op, name = null, at = null, from = null, to = null, price = null, years = null }) {
    this.txId = txId;
    this.op = op;
    this.name = name ?? null;
    this.at = big(at);
    /** previous owner: an address (indexer) or x-only key hex (walker) */
    this.from = from ?? null;
    /** new owner / buyer */
    this.to = to ?? null;
    /** sompi: listing price, sale price, offer amount */
    this.price = big(price);
    this.years = big(years);
  }
  get id() { return `${this.txId}:${this.op}:${this.name ?? ""}`; }
  /** A plain object (BigInt as decimal strings); the cache uses the compact `eventToJSON`. */
  toJSON() {
    const s = (v) => (v == null ? null : String(v));
    return { txId: this.txId, op: this.op, name: this.name, at: s(this.at), from: this.from, to: this.to, price: s(this.price), years: s(this.years) };
  }
}

// MARK: - Label rule (KACHAT_NAMES.md section 7)

/** The label an address is shown with: its `primaryName` if it owns that name and it is active;
 *  otherwise its oldest active name; otherwise null (the caller shows the address). */
export function label(owned, primaryName, graceMs, now = nowMs()) {
  const active = owned.filter((n) => Status.of(n.expiresAt, graceMs, now) === Status.active);
  if (primaryName != null) {
    const p = normalize(primaryName);
    if (active.some((n) => n.name === p)) return p;
  }
  const oldest = [...active].sort(byRegistration);
  return oldest.length ? oldest[0].name : null;
}

/** (registeredAt ?? max, name) ascending: "oldest first". */
export function byRegistration(a, b) {
  const ra = a.registeredAt ?? I64_MAX;
  const rb = b.registeredAt ?? I64_MAX;
  if (ra !== rb) return ra < rb ? -1 : 1;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

// MARK: - Profile record (KACHAT_NAMES.md section 7, KACHAT_NAMES_INDEXER.md Part C)

/** Swift `Character` count (grapheme clusters) and prefix. */
function graphemes(s) {
  if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
    return Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(s), (x) => x.segment);
  }
  return Array.from(s);
}

function clean(s) {
  if (typeof s !== "string") return null;
  const t = s.trim();
  return t.length ? t : null;
}

const linkKeys = ["website", "x", "github", "telegram", "discord", "nostr"];

/** `{ website, x, github, telegram, discord, nostr }`, each a string or null. */
export class ProfileLinks {
  constructor(l = {}) {
    for (const k of linkKeys) this[k] = l[k] ?? null;
  }
  get isEmpty() { return linkKeys.every((k) => this[k] == null); }
}

/** The address profile record: `{ v: 1, avatar, banner, bio, links: ProfileLinks|null, primaryName }`. */
export class Profile {
  constructor({ v = 1, avatar = null, banner = null, bio = null, links = null, primaryName = null } = {}) {
    this.v = v;
    this.avatar = avatar ?? null;
    this.banner = banner ?? null;
    this.bio = bio ?? null;
    this.links = links == null ? null : (links instanceof ProfileLinks ? links : new ProfileLinks(links));
    this.primaryName = primaryName ?? null;
  }

  static get maxBio() { return 280; }

  /** Image URLs must be `https://` or `ipfs://`. */
  static isImageURL(s) {
    const l = String(s).toLowerCase();
    const n = graphemes(l).length;
    return (l.startsWith("https://") && n > 8) || (l.startsWith("ipfs://") && n > 7);
  }

  /** The record as the indexer accepts it: blanks dropped, image URLs of another scheme dropped,
   *  the bio cut to 280 characters, the primary name normalized. */
  sanitized() {
    const p = new Profile();
    const img = (s) => { const c = clean(s); return c != null && Profile.isImageURL(c) ? c : null; };
    p.avatar = img(this.avatar);
    p.banner = img(this.banner);
    const bio = clean(this.bio);
    p.bio = bio == null ? null : graphemes(bio).slice(0, Profile.maxBio).join("");
    if (this.links) {
      const c = new ProfileLinks(Object.fromEntries(linkKeys.map((k) => [k, clean(this.links[k])])));
      p.links = c.isEmpty ? null : c;
    }
    const pn = clean(this.primaryName);
    p.primaryName = pn == null ? null : (isValid(normalize(pn)) ? normalize(pn) : null);
    return p;
  }

  /** The record as a plain object: keys sorted, null fields left out (Swift JSONEncoder
   *  `.sortedKeys`). */
  toJSON() {
    const out = {};
    if (this.avatar != null) out.avatar = this.avatar;
    if (this.banner != null) out.banner = this.banner;
    if (this.bio != null) out.bio = this.bio;
    if (this.links != null) {
      const l = {};
      for (const k of [...linkKeys].sort()) if (this.links[k] != null) l[k] = this.links[k];
      out.links = l;
    }
    if (this.primaryName != null) out.primaryName = this.primaryName;
    out.v = this.v;
    return out;
  }

  /** The JSON of the sanitized record (a string): compact, keys sorted, null fields left out.
   *  Throws past 2 KB. */
  recordJSON() {
    const json = JSON.stringify(this.sanitized().toJSON());
    if (utf8(json).length > maxProfileJSONBytes) throw new Failure("the profile is over 2 KB");
    return json;
  }

  /** A record's JSON (string or UTF-8 bytes) as the indexer reads it: unknown fields dropped,
   *  then sanitized; null when it is not a v1 record. */
  static parse(data) {
    const bytes = typeof data === "string" ? utf8(data) : data;
    if (!(bytes instanceof Uint8Array) || bytes.length > maxProfileJSONBytes) return null;
    let j;
    try { j = JSON.parse(fromUtf8(bytes)); } catch { return null; }
    const p = Profile.fromJSONObject(j);
    return p == null || p.v !== 1 ? null : p.sanitized();
  }

  /** A Profile from a parsed JSON object, with Swift Decodable's strictness (`v` required, every
   *  field a string or null, `links` an object); null when it does not decode. Not sanitized. */
  static fromJSONObject(j) {
    if (j == null || typeof j !== "object" || Array.isArray(j)) return null;
    if (typeof j.v !== "number" || !Number.isInteger(j.v)) return null;
    const optStr = (v) => (v == null ? null : typeof v === "string" ? v : undefined);
    const fields = {};
    for (const k of ["avatar", "banner", "bio", "primaryName"]) {
      const v = optStr(j[k]);
      if (v === undefined) return null;
      fields[k] = v;
    }
    let links = null;
    if (j.links != null) {
      if (typeof j.links !== "object" || Array.isArray(j.links)) return null;
      const l = {};
      for (const k of linkKeys) {
        const v = optStr(j.links[k]);
        if (v === undefined) return null;
        l[k] = v;
      }
      links = new ProfileLinks(l);
    }
    return new Profile({ v: j.v, ...fields, links });
  }
}

/** Two profiles hold the same record. */
export function profileEqual(a, b) {
  if (a == null || b == null) return a == null && b == null;
  return JSON.stringify(a.toJSON()) === JSON.stringify(b.toJSON());
}

/** `{ address, label: string|null (bare name), names: string[], profile: Profile|null }` */
export function makeIdentity({ address, label: l = null, names = [], profile = null }) {
  return { address, label: l ?? null, names: names ?? [], profile: profile ?? null };
}

// MARK: - Addresses (Kaspa cashaddr, iOS Bech32.swift / KaspaAddress)

/** The network prefix of the only network .kachat runs on. */
export const addressPrefix = "kaspatest";
/** Address versions: Schnorr P2PK 0, ECDSA P2PK 1, P2SH 8. */
export const AddressVersion = Object.freeze({ pubKey: 0, pubKeyECDSA: 1, scriptHash: 8 });

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const GENERATORS = [0x98f2bc8e61n, 0x79b76d99e2n, 0xf33e5fb3c4n, 0xae2eabe2a8n, 0x1e4f43e470n];

function polymod(values) {
  let c = 1n;
  for (const d of values) {
    const c0 = c >> 35n;
    c = ((c & 0x07ffffffffn) << 5n) ^ BigInt(d);
    for (let i = 0; i < 5; i += 1) if ((c0 >> BigInt(i)) & 1n) c ^= GENERATORS[i];
  }
  return c ^ 1n;
}

function hrpValues(hrp) { return [...Array.from(hrp, (ch) => ch.charCodeAt(0) & 0x1f), 0]; }

function convertBits(data, from, to, pad) {
  let acc = 0, bits = 0;
  const out = [];
  const maxv = (1 << to) - 1;
  for (const v of data) {
    if (v >> from) return null;
    acc = (acc << from) | v;
    bits += from;
    while (bits >= to) { bits -= to; out.push((acc >> bits) & maxv); }
    acc &= (1 << bits) - 1;
  }
  if (pad) {
    if (bits > 0) out.push((acc << (to - bits)) & maxv);
  } else if (bits >= from || ((acc << (to - bits)) & maxv)) {
    return null;
  }
  return out;
}

/** `hrp:<base32(version || payload)><checksum>`. */
export function encodeAddress(hrp, version, payload) {
  const values = convertBits([version, ...payload], 8, 5, true);
  const chk = polymod([...hrpValues(hrp), ...values, 0, 0, 0, 0, 0, 0, 0, 0]);
  let out = `${hrp}:`;
  for (const v of values) out += CHARSET[v];
  for (let i = 7; i >= 0; i -= 1) out += CHARSET[Number((chk >> BigInt(i * 5)) & 31n)];
  return out;
}

/** `{ hrp, version, payload }` of a Kaspa address, or null (bad charset or checksum). */
export function decodeAddress(address) {
  const lower = String(address ?? "").toLowerCase();
  const parts = lower.split(":");
  if (parts.length !== 2 || !parts[0] || !/^[\x00-\x7f]+$/.test(parts[0])) return null;
  const [hrp, body] = parts;
  const values = [];
  for (const ch of body) {
    const i = CHARSET.indexOf(ch);
    if (i < 0) return null;
    values.push(i);
  }
  if (values.length < 8) return null;
  if (polymod([...hrpValues(hrp), ...values]) !== 0n) return null;
  const data = convertBits(values.slice(0, -8), 5, 8, false);
  if (!data || data.length === 0) return null;
  return { hrp, version: data[0], payload: Uint8Array.from(data.slice(1)) };
}

/** The `kaspatest:` Schnorr P2PK address of an x-only key (iOS `KachatNamesRegistry.address(of:)`). */
export function addressOf(xonly, hrp = addressPrefix) {
  if (!(xonly instanceof Uint8Array) || xonly.length !== 32) return null;
  return encodeAddress(hrp, AddressVersion.pubKey, xonly);
}

/** The x-only key of a `kaspatest:` Schnorr address, or null (iOS `keyOf`). */
export function keyOf(address, hrp = addressPrefix) {
  const a = decodeAddress(String(address ?? "").toLowerCase());
  if (!a || a.hrp !== hrp || a.version !== AddressVersion.pubKey || a.payload.length !== 32) return null;
  return a.payload;
}

/** The P2SH address of a `OP_BLAKE2B <32> OP_EQUAL` script (iOS `KachatNamesService.p2shAddress`). */
export function p2shAddress(script, hrp = addressPrefix) {
  const b = script;
  if (!b || b.length !== 35 || b[0] !== 0xaa || b[1] !== 0x20 || b[34] !== 0x87) return null;
  return encodeAddress(hrp, AddressVersion.scriptHash, b.slice(2, 34));
}

/** The address a P2PK (Schnorr or ECDSA) or P2SH script pays to (iOS
 *  `KaspaAddress.address(fromScriptPublicKey:hrp:)`). */
export function addressFromScriptPublicKey(script, hrp = addressPrefix) {
  if (!script || script.length < 2) return null;
  const op = script[script.length - 1];
  const len = script[0];
  if (op === 0xac || op === 0xab) {
    if (script.length !== 2 + len || (len !== 32 && len !== 33)) return null;
    return encodeAddress(hrp, op === 0xac ? AddressVersion.pubKey : AddressVersion.pubKeyECDSA, script.slice(1, 1 + len));
  }
  if (op === 0x87) {
    if (script.length < 3 || script[0] !== 0xaa) return null;
    const n = script[1];
    if (script.length !== 3 + n) return null;
    return encodeAddress(hrp, AddressVersion.scriptHash, script.slice(2, 2 + n));
  }
  return null;
}

/** `kaspatest:qr...xyz4`. */
export function shortAddress(address) {
  const a = String(address);
  if (a.length <= 20) return a;
  return `${a.slice(0, 14)}...${a.slice(-6)}`;
}

// MARK: - A transaction as the walker sees it

/** `{ id: bytes32, inputs: [{ outpoint, signatureScript }], outputs: TxOutput[], payload, at: bigint|null }`
 *  (`at`: unix ms of the accepting block, or the block, when known). */
export class TxView {
  constructor({ id, inputs, outputs, payload = new Uint8Array(0), at = null }) {
    this.id = id;
    this.inputs = inputs;
    this.outputs = outputs;
    this.payload = payload;
    this.at = big(at);
  }

  get idHex() { return hex(this.id); }

  /** A transaction from the Kaspa REST API (`GET /addresses/{a}/full-transactions` or
   *  `GET /transactions/{id}`, kaspa-rest-server): version-1 outputs carry `covenant_id` and
   *  `covenant_authorizing_input`. Returns null for one that is not accepted; throws a Failure on
   *  a malformed one. Amounts may be Numbers, BigInts or decimal strings (parse big ones exactly:
   *  see registry.js `parseJSONExact`). */
  static fromREST(j) {
    const str = (v) => (typeof v === "string" ? v : null);
    const num = (v) => {
      if (typeof v === "bigint") return v >= 0n && v <= U64_MAX ? v : null;
      if (typeof v === "number") return Number.isFinite(v) && v >= 0 ? BigInt(Math.trunc(v)) : null;
      if (typeof v === "string" && /^\+?[0-9]+$/.test(v)) { const b = BigInt(v); return b <= U64_MAX ? b : null; }
      return null;
    };
    if (j == null || typeof j !== "object") throw new Failure("REST transaction is not an object");
    if (j.is_accepted === false) return null;
    const idHex = str(j.transaction_id);
    if (idHex == null) throw new Failure("REST transaction without an id");
    const id = unhex32(idHex);
    const inputs = [];
    (Array.isArray(j.inputs) ? j.inputs : []).forEach((any, k) => {
      const prev = str(any?.previous_outpoint_hash);
      const idx = num(any?.previous_outpoint_index);
      if (prev == null || idx == null) throw new Failure(`${idHex}: input without its outpoint`);
      const sig = unhex(str(any.signature_script) ?? "");
      const order = num(any.index);
      inputs.push([order == null ? k : Number(order), { outpoint: makeOutpoint(unhex32(prev), Number(idx)), signatureScript: sig }]);
    });
    const outputs = [];
    (Array.isArray(j.outputs) ? j.outputs : []).forEach((any, k) => {
      const amount = num(any?.amount);
      const spk = str(any?.script_public_key);
      if (amount == null || spk == null) throw new Failure(`${idHex}: output without amount or script`);
      let covenant = null;
      const cid = str(any.covenant_id);
      if (cid != null && cid.length > 0) {
        const auth = num(any.covenant_authorizing_input);
        if (auth == null) throw new Failure(`${idHex}: covenant output without its authorizing input`);
        covenant = makeCovenantBinding(Number(auth), unhex32(cid));
      }
      const order = num(any.index);
      outputs.push([order == null ? k : Number(order), makeTxOutput({ value: amount, scriptVersion: 0, script: unhex(spk), covenant })]);
    });
    const payload = unhex(str(j.payload) ?? "");
    const time = (v) => (typeof v === "number" && Number.isFinite(v) ? BigInt(Math.trunc(v)) : typeof v === "bigint" ? v : null);
    const at = time(j.accepting_block_time) ?? time(j.block_time);
    const byOrder = (a, b) => a[0] - b[0];
    return new TxView({
      id,
      inputs: inputs.sort(byOrder).map((x) => x[1]),
      outputs: outputs.sort(byOrder).map((x) => x[1]),
      payload,
      at,
    });
  }
}

// MARK: - The walker's registry state (cached, per network)

const opKey = (txid, index) => `${txid}:${index}`;

function safeUnhex32(s, fallback) { try { return unhex32(s); } catch { return fallback(); } }

/** The registry without an indexer: the live gaps and names (and the offers this device made),
 *  decoded, moved forward one spending transaction at a time from the manifest's genesis gap.
 *  Hex strings throughout (as Swift) so the cache stays readable.
 *
 *  Gap   { txid, index, lo, hi, value: bigint }
 *  Name  { txid, index, name, key, owner, price: bigint, expiresAt: bigint, value: bigint,
 *          registeredAt: bigint|null, registeredTxId: string|null, updatedAt: bigint|null }
 *  Offer { txid, index, key, buyer, refundAfter: bigint, value: bigint, name: string|null, createdAt: bigint|null } */
export class RegistryState {
  static get formatVersion() { return 1; }
  static get appliedKeep() { return 4096; }
  static get eventsKeep() { return 1000; }

  constructor({ version = RegistryState.formatVersion, network, registryCovenantId, gaps = [], names = [], offers = [], applied = [], events = [], verifiedAt = null }) {
    this.version = version;
    this.network = network;
    this.registryCovenantId = registryCovenantId;
    this.gaps = gaps;
    this.names = names;
    this.offers = offers;
    /** transactions already applied (most recent last, bounded) */
    this.applied = applied;
    /** every registry event the walker has seen (most recent last, bounded) */
    this.events = events;
    /** when the live set was last confirmed against a node (unix ms) */
    this.verifiedAt = big(verifiedAt);
  }

  static atGenesis(m) {
    return new RegistryState({
      network: m.network,
      registryCovenantId: hex(m.registryCovenantId),
      gaps: [{ txid: hex(m.genesisTxid), index: 0, lo: hex(m.genesisState.lo), hi: hex(m.genesisState.hi), value: m.params.gapValue }],
      names: [], offers: [], applied: [hex(m.genesisTxid)], events: [], verifiedAt: null,
    });
  }

  /** Whether this cache belongs to `m`'s registry. */
  matches(m) {
    return this.version === RegistryState.formatVersion && this.network === m.network && this.registryCovenantId === hex(m.registryCovenantId);
  }

  /** A deep copy (Swift value semantics: walk a copy, keep it only when the walk succeeds). */
  clone() { return RegistryState.fromJSON(this.toJSON()); }

  /** Same state, field for field. */
  equals(other) { return other instanceof RegistryState && JSON.stringify(this.toJSON()) === JSON.stringify(other.toJSON()); }

  // MARK: Reading

  /** The gap whose open interval holds `key` (bytes), or null (Swift `gap(containing:)`). */
  gapContaining(key) {
    const k = hex(key);
    return this.gaps.find((g) => g.lo < k && k < g.hi) ?? null;
  }

  /** The walked record of a name (canonical, no `.kachat`), or null. */
  name(name) {
    const k = hex(nameKey(name));
    return this.names.find((n) => n.key === k) ?? null;
  }

  /** The gaps on either side of a registered key: `{ below: (lo, key), above: (key, hi) }`, or null. */
  neighbours(key) {
    const k = hex(key);
    const below = this.gaps.find((g) => g.hi === k);
    const above = this.gaps.find((g) => g.lo === k);
    return below && above ? { below, above } : null;
  }

  /** The gaps and names tile the key space exactly; throws a Failure otherwise. */
  checkInvariants() {
    const sorted = [...this.gaps].sort((a, b) => (a.lo < b.lo ? -1 : a.lo > b.lo ? 1 : 0));
    const keys = this.names.map((n) => n.key).sort();
    if (sorted.length !== keys.length + 1) throw new Failure(`${sorted.length} gaps for ${keys.length} names`);
    let cur = hex(zero32());
    sorted.forEach((g, i) => {
      if (g.lo !== cur) throw new Failure(`gap ${i} starts at ${g.lo.slice(0, 8)} instead of ${cur.slice(0, 8)}`);
      if (!(g.lo < g.hi)) throw new Failure(`gap ${i} is empty`);
      if (i < keys.length) {
        if (keys[i] !== g.hi) throw new Failure(`gap ${i} ends at ${g.hi.slice(0, 8)} but the next name is ${keys[i].slice(0, 8)}`);
        cur = keys[i];
      } else if (g.hi !== hex(ff32())) {
        throw new Failure(`the last gap ends at ${g.hi.slice(0, 8)}`);
      }
    });
  }

  static outpoint(txid, index) { return makeOutpoint(safeUnhex32(txid, zero32), index); }

  static nameInfo(n) {
    return new NameInfo({
      name: n.name, key: safeUnhex32(n.key, zero32), owner: safeUnhex32(n.owner, zero32),
      price: bmax(n.price, 0n), expiresAt: n.expiresAt, outpoint: RegistryState.outpoint(n.txid, n.index),
      registeredAt: n.registeredAt ?? null, registeredTxId: n.registeredTxId ?? null, updatedAt: n.updatedAt ?? null,
    });
  }

  static gapInfo(g) {
    return new GapInfo({ lo: safeUnhex32(g.lo, zero32), hi: safeUnhex32(g.hi, ff32), outpoint: RegistryState.outpoint(g.txid, g.index) });
  }

  static offerInfo(o) {
    return new OfferInfo({
      outpoint: RegistryState.outpoint(o.txid, o.index), key: safeUnhex32(o.key, zero32), name: o.name ?? null,
      buyer: safeUnhex32(o.buyer, zero32), amount: o.value, refundAfter: o.refundAfter, createdAt: o.createdAt ?? null,
    });
  }

  /** Swift's overloaded `info(_:)`: a walked Name, Gap or Offer record as the screens read it. */
  static info(x) {
    if ("buyer" in x) return RegistryState.offerInfo(x);
    if ("owner" in x) return RegistryState.nameInfo(x);
    return RegistryState.gapInfo(x);
  }

  /** Every UTXO the walker follows: `[{ outpoint: "txid:index", script, registry: bool }]`. */
  tracked(m) {
    const out = [];
    for (const g of this.gaps) {
      let lo, hi;
      try { lo = unhex32(g.lo); hi = unhex32(g.hi); } catch { continue; }
      out.push({ outpoint: opKey(g.txid, g.index), script: templateScript(m.gap, gapState(lo, hi)), registry: true });
    }
    for (const n of this.names) {
      out.push({ outpoint: opKey(n.txid, n.index), script: templateScript(m.name, nameState(RegistryState.nameInfo(n).fields)), registry: true });
    }
    for (const o of this.offers) {
      out.push({ outpoint: opKey(o.txid, o.index), script: templateScript(m.offer, offerState(RegistryState.offerInfo(o).fields)), registry: false });
    }
    return out;
  }

  // MARK: Offers this device made

  /** Start following an offer (an OfferInfo) this device made; `at` unix ms. */
  trackOffer(o, at) {
    const txid = hex(o.outpoint.txid);
    this.offers = this.offers.filter((x) => !(x.txid === txid && x.index === o.outpoint.index));
    this.offers.push({
      txid, index: o.outpoint.index, key: hex(o.key), buyer: hex(o.buyer), refundAfter: big(o.refundAfter),
      value: big(o.amount), name: o.name ?? null, createdAt: big(at),
    });
  }

  // MARK: Applying a transaction (registry.rs `Registry::apply`)

  static _decodeSpend(t, sigScript) {
    const pushes = parsePushes(sigScript);
    const redeem = pushes.pop();
    if (redeem === undefined) throw new Failure("empty signature script");
    const tag = pushes.pop();
    if (tag === undefined) throw new Failure("no dispatch tag");
    const entry = Object.keys(t.dispatchTags).find((k) => bytesEqual(t.dispatchTags[k], tag));
    if (entry === undefined) throw new Failure(`unknown ${t.contract} dispatch tag ${hex(tag)}`);
    return { args: pushes, entry, redeem };
  }

  static _arg32(a, i) {
    if (!(i < a.length) || a[i].length !== 32) throw new Failure(`argument ${i} is not 32 bytes`);
    return a[i];
  }

  static _argInt(a, i) {
    if (!(i < a.length)) throw new Failure(`missing argument ${i}`);
    return scriptNum(a[i]);
  }

  /** The offer a transaction announces with `kchat:1:offer:<key>:<buyer>:<refundAfter>`, if one
   *  of its outputs really is that offer (KACHAT_NAMES_INDEXER.md B4): `{ index, fields }` or null. */
  static offerFromMarker(tx, m) {
    let text;
    try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(tx.payload); } catch { return null; }
    const prefix = "kchat:1:offer:";
    if (!text.startsWith(prefix)) return null;
    const parts = text.slice(prefix.length).split(":");
    if (parts.length !== 3) return null;
    let k, buyer;
    try { k = unhex32(parts[0]); buyer = unhex32(parts[1]); } catch { return null; }
    if (!/^[+-]?[0-9]+$/.test(parts[2])) return null;
    const refundAfter = BigInt(parts[2]);
    if (refundAfter < 0n || refundAfter > I64_MAX) return null;
    const fields = makeOfferFields({ key: k, buyer, refundAfter });
    const script = templateScript(m.offer, offerState(fields));
    const index = tx.outputs.findIndex((o) => bytesEqual(o.script, script) && o.covenant == null);
    return index < 0 ? null : { index, fields };
  }

  /** Whether an input spends an offer through `accept` (tracked or not: the redeem script it
   *  reveals is recognised by the offer template). */
  static _isOfferAccept(input, m) {
    let pushes;
    try { pushes = parsePushes(input.signatureScript); } catch { return false; }
    if (pushes.length < 2) return false;
    try { templateStateOfRedeem(m.offer, pushes[pushes.length - 1]); } catch { return false; }
    return bytesEqual(pushes[pushes.length - 2], m.offer.dispatchTags.accept);
  }

  /** Applies one transaction (a TxView). Returns its registry events (Event[]); an unrelated
   *  transaction returns none. Every registry output must be predicted exactly from the tracked
   *  inputs it spends (and authorized by that input), or the transaction is refused (a Failure)
   *  and nothing changes. */
  apply(tx, m) {
    const id = tx.idHex;
    if (this.applied.includes(id)) return [];
    const registryId = unhex32(this.registryCovenantId);
    const regOuts = [];
    tx.outputs.forEach((o, j) => { if (o.covenant && bytesEqual(o.covenant.covenantId, registryId)) regOuts.push(j); });
    const insOf = (list) => {
      const out = [];
      tx.inputs.forEach((input, i) => {
        const t = hex(input.outpoint.txid), x = input.outpoint.index;
        const rec = list.find((r) => r.txid === t && r.index === x);
        if (rec) out.push([i, rec]);
      });
      return out;
    };
    const gapIns = insOf(this.gaps);
    const nameIns = insOf(this.names);
    const offerIns = insOf(this.offers);
    const newOffer = RegistryState.offerFromMarker(tx, m);
    if (regOuts.length === 0 && gapIns.length === 0 && nameIns.length === 0 && offerIns.length === 0 && newOffer == null) {
      return [];
    }
    const short = id.slice(0, 12);
    const events = [];
    /** [{ auth, p: { kind: "gap", lo, hi } | { kind: "name", f, name } }] */
    const predicted = [];
    const acceptsOffer = tx.inputs.some((input) => RegistryState._isOfferAccept(input, m));
    const decode = (t, i, what) => {
      try { return RegistryState._decodeSpend(t, tx.inputs[i].signatureScript); } catch (e) {
        throw new Failure(`${short}: ${what} input ${i}: ${e.message}`);
      }
    };

    for (const [i, g] of gapIns) {
      const sp = decode(m.gap, i, "gap");
      const lo = unhex32(g.lo), hi = unhex32(g.hi);
      if (!bytesEqual(sp.redeem, templateRedeem(m.gap, gapState(lo, hi)))) {
        throw new Failure(`${short}: gap input ${i} reveals a redeem script that is not the tracked gap state`);
      }
      switch (sp.entry) {
        case "register": {
          const nameBytes = sp.args[0];
          if (nameBytes === undefined) throw new Failure(`${short}: register without a name`);
          const owner = RegistryState._arg32(sp.args, 1);
          const now = RegistryState._argInt(sp.args, 3);
          const years = RegistryState._argInt(sp.args, 4);
          const name = fromUtf8(nameBytes);
          const k = blake3(nameBytes);
          const pad = new Uint8Array(32);
          pad.set(nameBytes.subarray(0, 32));
          const f = makeNameFields({ key: k, paddedName: pad, owner, price: 0n, expiresAt: now + years * yearMs });
          predicted.push({ auth: i, p: { kind: "gap", lo: g.lo, hi: hex(k) } });
          predicted.push({ auth: i, p: { kind: "gap", lo: hex(k), hi: g.hi } });
          predicted.push({ auth: i, p: { kind: "name", f, name } });
          events.push(new Event({ txId: id, op: "register", name, at: tx.at, to: hex(owner), years }));
          break;
        }
        case "merge": {
          const succ = gapIns.find(([j, x]) => j === 2 && x.lo === g.hi);
          if (!succ) throw new Failure(`${short}: merge without the tracked successor gap at input 2`);
          predicted.push({ auth: i, p: { kind: "gap", lo: g.lo, hi: succ[1].hi } });
          break;
        }
        case "absorbed":
          break;
        default:
          throw new Failure(`${short}: unexpected gap entry ${sp.entry}`);
      }
    }

    for (const [i, n] of nameIns) {
      const sp = decode(m.name, i, "name");
      const f = RegistryState.nameInfo(n).fields;
      if (!bytesEqual(sp.redeem, templateRedeem(m.name, nameState(f)))) {
        throw new Failure(`${short}: name input ${i} reveals a redeem script that is not the tracked name state`);
      }
      switch (sp.entry) {
        case "transfer": {
          const to = RegistryState._arg32(sp.args, 0);
          predicted.push({ auth: i, p: { kind: "name", f: nameFieldsWithOwner(f, to), name: n.name } });
          // with an offer accepted, the output right after the continuation pays the old owner
          events.push(new Event({ txId: id, op: acceptsOffer ? "offer_accepted" : "transfer", name: n.name, at: tx.at, from: n.owner, to: hex(to) }));
          break;
        }
        case "list": {
          const price = RegistryState._argInt(sp.args, 0);
          predicted.push({ auth: i, p: { kind: "name", f: nameFieldsWithPrice(f, price), name: n.name } });
          events.push(new Event({ txId: id, op: price === 0n ? "delist" : "list", name: n.name, at: tx.at, from: n.owner, price: price > 0n ? price : null }));
          break;
        }
        case "buy": {
          const to = RegistryState._arg32(sp.args, 0);
          predicted.push({ auth: i, p: { kind: "name", f: nameFieldsWithOwner(f, to), name: n.name } });
          events.push(new Event({ txId: id, op: "sale", name: n.name, at: tx.at, from: n.owner, to: hex(to), price: bmax(n.price, 0n) }));
          break;
        }
        case "renew": {
          const years = RegistryState._argInt(sp.args, 0);
          predicted.push({ auth: i, p: { kind: "name", f: nameFieldsWithExpiry(f, f.expiresAt + years * yearMs), name: n.name } });
          events.push(new Event({ txId: id, op: "renew", name: n.name, at: tx.at, years }));
          break;
        }
        case "release":
          events.push(new Event({ txId: id, op: "release", name: n.name, at: tx.at, from: n.owner }));
          break;
        case "reclaim":
          events.push(new Event({ txId: id, op: "reclaim", name: n.name, at: tx.at, from: n.owner }));
          break;
        default:
          throw new Failure(`${short}: unexpected name entry ${sp.entry}`);
      }
    }

    for (const [i, o] of offerIns) {
      const sp = decode(m.offer, i, "offer");
      if (!bytesEqual(sp.redeem, templateRedeem(m.offer, offerState(RegistryState.offerInfo(o).fields)))) {
        throw new Failure(`${short}: offer input ${i} reveals a redeem script that is not the tracked offer state`);
      }
      events.push(new Event({ txId: id, op: `offer_${sp.entry}`, name: o.name ?? null, at: tx.at, to: o.buyer, price: o.value }));
    }

    // Match the predictions to the registry outputs, one to one, each authorized by the input
    // that predicted it (the P2SH script commits to the whole state).
    const matched = new Map();
    for (const { auth, p } of predicted) {
      const script = p.kind === "gap"
        ? templateScript(m.gap, gapState(unhex32(p.lo), unhex32(p.hi)))
        : templateScript(m.name, nameState(p.f));
      const idx = regOuts.find((j) => !matched.has(j) && bytesEqual(tx.outputs[j].script, script) && tx.outputs[j].covenant?.authorizingInput === auth);
      if (idx === undefined) throw new Failure(`${short}: predicted registry output not found (authorized by input ${auth})`);
      matched.set(idx, p);
    }
    const extra = regOuts.find((j) => !matched.has(j));
    if (extra !== undefined) throw new Failure(`${short}: registry output ${extra} is not explained by any tracked registry input`);

    // Commit.
    const spent = new Set(tx.inputs.map((x) => opKey(hex(x.outpoint.txid), x.outpoint.index)));
    const carried = new Map();
    for (const [, n] of nameIns) if (!carried.has(n.key)) carried.set(n.key, n);
    const kept = (r) => !spent.has(opKey(r.txid, r.index));
    this.gaps = this.gaps.filter(kept);
    this.names = this.names.filter(kept);
    this.offers = this.offers.filter(kept);
    for (const idx of [...matched.keys()].sort((a, b) => a - b)) {
      const value = tx.outputs[idx].value;
      const p = matched.get(idx);
      if (p.kind === "gap") {
        this.gaps.push({ txid: id, index: idx, lo: p.lo, hi: p.hi, value });
      } else {
        const k = hex(p.f.key);
        const before = carried.get(k);
        this.names.push({
          txid: id, index: idx, name: p.name, key: k, owner: hex(p.f.owner), price: p.f.price, expiresAt: p.f.expiresAt, value,
          registeredAt: before?.registeredAt ?? tx.at ?? null, registeredTxId: before?.registeredTxId ?? id, updatedAt: tx.at ?? null,
        });
      }
    }
    if (newOffer) {
      const { index, fields } = newOffer;
      const known = this.names.find((n) => n.key === hex(fields.key))?.name ?? null;
      this.offers = this.offers.filter((o) => !(o.txid === id && o.index === index));
      this.offers.push({
        txid: id, index, key: hex(fields.key), buyer: hex(fields.buyer), refundAfter: fields.refundAfter,
        value: tx.outputs[index].value, name: known, createdAt: tx.at ?? null,
      });
      events.push(new Event({ txId: id, op: "offer", name: known, at: tx.at, to: hex(fields.buyer), price: tx.outputs[index].value }));
    }
    // an accepted offer's payout: the output right after the name continuation
    for (const e of events) {
      if (e.op !== "offer_accepted") continue;
      const cont = [...matched.entries()].find(([, p]) => p.kind === "name" && p.name === e.name)?.[0];
      if (cont !== undefined && cont + 1 < tx.outputs.length) e.price = tx.outputs[cont + 1].value;
    }
    this.applied.push(id);
    if (this.applied.length > RegistryState.appliedKeep) this.applied.splice(0, this.applied.length - RegistryState.appliedKeep);
    this.events.push(...events);
    if (this.events.length > RegistryState.eventsKeep) this.events.splice(0, this.events.length - RegistryState.eventsKeep);
    return events;
  }

  // MARK: The walk (no indexer)

  /** Moves the state forward to the chain's current registry (mutates this state; walk a
   *  `clone()` to keep the old one on failure). Each round: every tracked UTXO the node no longer
   *  has was spent; its spending transaction is found through its address and applied (`apply`,
   *  which decodes the spend and verifies every new state against its output's script); the new
   *  outputs are tracked next round. A transaction that needs a registry input not tracked yet
   *  waits for a later one in the same round.
   *
   *  - `address(script) -> string|null`: the P2SH address of a tracked script;
   *  - `live(addresses: string[]) -> Promise<Set<"txid:index">>`: which outpoints at those
   *    addresses are unspent (a node);
   *  - `transactions(address) -> Promise<TxView[]>`: accepted transactions touching an address.
   *
   *  Returns a WalkReport `{ rounds, applied: txid[], events: Event[], unresolved: "txid:index"[] }`
   *  (unresolved: tracked UTXOs the node no longer has but whose spending transaction was not
   *  found yet, an indexing delay of the REST API; the next refresh retries). */
  async walk({ manifest: m, maxRounds = 64, address, live, transactions }) {
    const report = { rounds: 0, applied: [], events: [], unresolved: [] };
    for (let round = 0; round < maxRounds; round++) {
      report.rounds += 1;
      const byAddress = new Map();
      for (const t of this.tracked(m)) {
        const a = address(t.script);
        if (!a) throw new Failure("no address for a tracked script");
        if (!byAddress.has(a)) byAddress.set(a, []);
        byAddress.get(a).push(t.outpoint);
      }
      const unspent = await live([...byAddress.keys()].sort());
      const isUnspent = (op) => (unspent instanceof Set ? unspent.has(op) : unspent.includes(op));
      const spent = [];
      for (const [a, ops] of byAddress) for (const op of ops) if (!isUnspent(op)) spent.push([a, op]);
      if (spent.length === 0) {
        report.unresolved = [];
        return report;
      }
      const candidates = new Map();
      const found = new Set();
      for (const a of [...new Set(spent.map((x) => x[0]))].sort()) {
        const wanted = new Set(spent.filter((x) => x[0] === a).map((x) => x[1]));
        for (const tx of await transactions(a)) {
          const spends = tx.inputs.map((i) => opKey(hex(i.outpoint.txid), i.outpoint.index)).filter((op) => wanted.has(op));
          if (spends.length) {
            candidates.set(tx.idHex, tx);
            for (const op of spends) found.add(op);
          }
        }
      }
      report.unresolved = spent.map((x) => x[1]).filter((op) => !found.has(op)).sort();
      if (candidates.size === 0) return report;
      let pending = [...candidates.values()].sort((a, b) => {
        const ta = a.at ?? 0n, tb = b.at ?? 0n;
        if (ta !== tb) return ta < tb ? -1 : 1;
        return a.idHex < b.idHex ? -1 : a.idHex > b.idHex ? 1 : 0;
      });
      let lastError = null;
      let progressed = true;
      let appliedThisRound = 0;
      while (progressed && pending.length) {
        progressed = false;
        const rest = [];
        for (const tx of pending) {
          try {
            const before = this.applied.length;
            const events = this.apply(tx, m);
            if (this.applied.length !== before || this.applied.includes(tx.idHex)) {
              report.applied.push(tx.idHex);
              report.events.push(...events);
            }
            progressed = true;
            appliedThisRound += 1;
          } catch (e) {
            lastError = e;
            rest.push(tx);
          }
        }
        pending = rest;
      }
      // nothing applied: the same spends would fail again next round
      if (appliedThisRound === 0 && lastError) throw lastError;
    }
    return report;
  }

  // MARK: Cache format (compact JSON: hex strings, BigInt as decimal strings)
  //
  // { v: 1, network, registryCovenantId, verifiedAt: "ms"|null,
  //   gaps:   [[txid, index, lo, hi, value]],
  //   names:  [[txid, index, name, key, owner, price, expiresAt, value, registeredAt|null, registeredTxId|null, updatedAt|null]],
  //   offers: [[txid, index, key, buyer, refundAfter, value, name|null, createdAt|null]],
  //   applied: [txid],
  //   events: [[txId, op, name|null, at|null, from|null, to|null, price|null, years|null]] }

  toJSON() {
    const s = (v) => (v == null ? null : String(v));
    return {
      v: this.version,
      network: this.network,
      registryCovenantId: this.registryCovenantId,
      verifiedAt: s(this.verifiedAt),
      gaps: this.gaps.map((g) => [g.txid, g.index, g.lo, g.hi, s(g.value)]),
      names: this.names.map((n) => [n.txid, n.index, n.name, n.key, n.owner, s(n.price), s(n.expiresAt), s(n.value), s(n.registeredAt), n.registeredTxId ?? null, s(n.updatedAt)]),
      offers: this.offers.map((o) => [o.txid, o.index, o.key, o.buyer, s(o.refundAfter), s(o.value), o.name ?? null, s(o.createdAt)]),
      applied: [...this.applied],
      events: this.events.map(eventToJSON),
    };
  }

  /** The state from `toJSON()`'s object (or its JSON text); throws on a malformed one. */
  static fromJSON(j) {
    if (typeof j === "string") j = JSON.parse(j);
    if (j == null || typeof j !== "object" || !Array.isArray(j.gaps) || !Array.isArray(j.names)) throw new Failure("not a registry cache");
    const b = (v) => (v == null ? null : BigInt(v));
    const idx = (v) => { const n = Number(v); if (!Number.isInteger(n) || n < 0) throw new Failure("bad index"); return n; };
    return new RegistryState({
      version: j.v,
      network: j.network,
      registryCovenantId: j.registryCovenantId,
      verifiedAt: b(j.verifiedAt),
      gaps: j.gaps.map((g) => ({ txid: g[0], index: idx(g[1]), lo: g[2], hi: g[3], value: BigInt(g[4]) })),
      names: j.names.map((n) => ({
        txid: n[0], index: idx(n[1]), name: n[2], key: n[3], owner: n[4], price: BigInt(n[5]), expiresAt: BigInt(n[6]), value: BigInt(n[7]),
        registeredAt: b(n[8]), registeredTxId: n[9] ?? null, updatedAt: b(n[10]),
      })),
      offers: (j.offers ?? []).map((o) => ({
        txid: o[0], index: idx(o[1]), key: o[2], buyer: o[3], refundAfter: BigInt(o[4]), value: BigInt(o[5]), name: o[6] ?? null, createdAt: b(o[7]),
      })),
      applied: Array.isArray(j.applied) ? [...j.applied] : [],
      events: (j.events ?? []).map(eventFromJSON),
    });
  }
}

/** An Event as a compact cache tuple. */
export function eventToJSON(e) {
  const s = (v) => (v == null ? null : String(v));
  return [e.txId, e.op, e.name ?? null, s(e.at), e.from ?? null, e.to ?? null, s(e.price), s(e.years)];
}

/** An Event from its cache tuple (or a `{ txId, op, ... }` object). */
export function eventFromJSON(t) {
  if (Array.isArray(t)) {
    return new Event({ txId: t[0], op: t[1], name: t[2], at: t[3] == null ? null : BigInt(t[3]), from: t[4], to: t[5], price: t[6] == null ? null : BigInt(t[6]), years: t[7] == null ? null : BigInt(t[7]) });
  }
  return new Event(t);
}

// MARK: - Indexer API shapes (KACHAT_NAMES_INDEXER.md Part D)
//
// Decoders for the indexer's JSON with Swift Decodable's strictness: a required field missing or
// of the wrong type throws a Failure (the whole response fails, as JSONDecoder does). Amounts are
// decimal strings, times numbers.

function decodeFail(what) { return new Failure(`the names indexer sent a malformed ${what}`); }

function reqString(o, k, what) {
  if (typeof o?.[k] !== "string") throw decodeFail(what);
  return o[k];
}
function optString(o, k, what) {
  const v = o?.[k];
  if (v == null) return null;
  if (typeof v !== "string") throw decodeFail(what);
  return v;
}
function intOf(v, what) {
  if (typeof v === "bigint") return v;
  if (typeof v !== "number" || !Number.isInteger(v)) throw decodeFail(what);
  return BigInt(v);
}
function optInt(o, k, what) {
  const v = o?.[k];
  return v == null ? null : intOf(v, what);
}
function optBool(o, k, what) {
  const v = o?.[k];
  if (v == null) return null;
  if (typeof v !== "boolean") throw decodeFail(what);
  return v;
}
function reqObject(o, k, what) {
  const v = o?.[k];
  if (v == null || typeof v !== "object" || Array.isArray(v)) throw decodeFail(what);
  return v;
}
function optObject(o, k, what) {
  const v = o?.[k];
  if (v == null) return null;
  if (typeof v !== "object" || Array.isArray(v)) throw decodeFail(what);
  return v;
}
function reqArray(o, k, what) {
  const v = o?.[k];
  if (!Array.isArray(v)) throw decodeFail(what);
  return v;
}

/** Swift `UInt64(String)`: decimal digits with an optional sign, in range; else null. */
export function parseU64(s) {
  if (typeof s !== "string" || !/^[+-]?[0-9]+$/.test(s)) return null;
  const v = BigInt(s);
  return v >= 0n && v <= U64_MAX ? v : null;
}

/** Marks a name object already decoded by `IndexerAPI.nameJSON`. */
const decoded = Symbol("decoded");

/** Swift `try? unhex32`. */
function tryUnhex32(s) { try { return unhex32(s); } catch { return null; } }

export const IndexerAPI = Object.freeze({
  /** `{ txId, index }` -> Outpoint|null. Throws when the shape is wrong. */
  outpoint(j) {
    if (j == null || typeof j !== "object") throw decodeFail("outpoint");
    const txId = reqString(j, "txId", "outpoint");
    const index = intOf(j.index, "outpoint");
    if (index < 0n || index > 0xffff_ffffn) throw decodeFail("outpoint");
    const txid = tryUnhex32(txId);
    return txid ? makeOutpoint(txid, Number(index)) : null;
  },

  /** `{ lo, hi, outpoint }` -> GapInfo|null. */
  gap(j) {
    if (j == null || typeof j !== "object") throw decodeFail("gap");
    const lo = tryUnhex32(reqString(j, "lo", "gap"));
    const hi = tryUnhex32(reqString(j, "hi", "gap"));
    const op = IndexerAPI.outpoint(reqObject(j, "outpoint", "gap"));
    return lo && hi && op ? new GapInfo({ lo, hi, outpoint: op }) : null;
  },

  /** A name object (`GET /names/{name}` and every name in lists), decoded:
   *  `{ name, key, registered, status, owner, ownerKey, price, expiresAt, outpoint, registeredAt,
   *     registeredTxId, updatedAt, gap }`. Throws when the shape is wrong. */
  nameJSON(j) {
    const w = "name";
    if (j == null || typeof j !== "object") throw decodeFail(w);
    const outpointJ = optObject(j, "outpoint", w);
    const gapJ = optObject(j, "gap", w);
    return {
      [decoded]: true,
      name: reqString(j, "name", w),
      key: optString(j, "key", w),
      registered: optBool(j, "registered", w),
      status: optString(j, "status", w),
      owner: optString(j, "owner", w),
      ownerKey: optString(j, "ownerKey", w),
      price: optString(j, "price", w),
      expiresAt: optInt(j, "expiresAt", w),
      outpoint: outpointJ == null ? null : IndexerAPI.outpoint(outpointJ),
      registeredAt: optInt(j, "registeredAt", w),
      registeredTxId: optString(j, "registeredTxId", w),
      updatedAt: optInt(j, "updatedAt", w),
      gap: gapJ == null ? null : IndexerAPI.gap(gapJ),
    };
  },

  /** A decoded name object's record, when registered and complete; `ownerKey` falls back to
   *  `keyOf(owner)`. NameInfo|null. Accepts the raw JSON too. */
  nameInfo(j, keyOfFn = keyOf) {
    const d = j?.[decoded] ? j : IndexerAPI.nameJSON(j);
    if (d.registered === false || d.expiresAt == null || d.outpoint == null) return null;
    const n = normalize(d.name);
    if (!isValid(n)) return null;
    const owner = (d.ownerKey != null ? tryUnhex32(d.ownerKey) : null) ?? (d.owner != null ? keyOfFn(d.owner) : null);
    if (!owner || owner.length !== 32) return null;
    return new NameInfo({
      name: n, key: nameKey(n), owner, price: (d.price != null ? parseU64(d.price) : null) ?? 0n, expiresAt: d.expiresAt,
      outpoint: d.outpoint, registeredAt: d.registeredAt, registeredTxId: d.registeredTxId, updatedAt: d.updatedAt,
    });
  },

  /** `{ names: [...] }` -> NameInfo[] (incomplete records dropped). */
  names(j, keyOfFn = keyOf) {
    return reqArray(j, "names", "name list").map((x) => IndexerAPI.nameInfo(IndexerAPI.nameJSON(x), keyOfFn)).filter(Boolean);
  },

  /** `{ listings: [...], next }` -> `{ listings: NameInfo[], next: string|null }`. */
  listings(j, keyOfFn = keyOf) {
    const listings = reqArray(j, "listings", "listings").map((x) => IndexerAPI.nameInfo(IndexerAPI.nameJSON(x), keyOfFn)).filter(Boolean);
    return { listings, next: optString(j, "next", "listings") };
  },

  /** `{ txId, op, name, at, from, to, price, years }` -> Event. */
  event(j) {
    const w = "event";
    if (j == null || typeof j !== "object") throw decodeFail(w);
    const price = optString(j, "price", w);
    return new Event({
      txId: reqString(j, "txId", w), op: reqString(j, "op", w), name: optString(j, "name", w), at: optInt(j, "at", w),
      from: optString(j, "from", w), to: optString(j, "to", w), price: price == null ? null : parseU64(price), years: optInt(j, "years", w),
    });
  },

  /** `{ events: [...], next }` -> `{ events: Event[], next: string|null }`. */
  events(j) {
    return { events: reqArray(j, "events", "events").map((x) => IndexerAPI.event(x)), next: optString(j, "next", "events") };
  },

  /** An offer object -> OfferInfo|null (`name` falls back to `fallbackName`; the buyer address
   *  must decode to an x-only key). */
  offerInfo(j, fallbackName = null, keyOfFn = keyOf) {
    const w = "offer";
    if (j == null || typeof j !== "object") throw decodeFail(w);
    const op = IndexerAPI.outpoint(reqObject(j, "outpoint", w));
    const buyer = reqString(j, "buyer", w);
    const amountS = reqString(j, "amount", w);
    const refundAfter = intOf(j.refundAfter, w);
    const createdAt = optInt(j, "createdAt", w);
    optBool(j, "refundable", w);
    const name = optString(j, "name", w);
    const buyerKey = keyOfFn(buyer);
    const amount = parseU64(amountS);
    if (!op || !buyerKey || amount == null) return null;
    const raw = name ?? fallbackName;
    if (raw == null) return null;
    const n = normalize(raw);
    if (!isValid(n)) return null;
    return new OfferInfo({ outpoint: op, key: nameKey(n), name: n, buyer: buyerKey, amount, refundAfter, createdAt });
  },

  /** `{ offers: [...] }` -> OfferInfo[]. */
  offers(j, fallbackName = null, keyOfFn = keyOf) {
    return reqArray(j, "offers", "offers").map((x) => IndexerAPI.offerInfo(x, fallbackName, keyOfFn)).filter(Boolean);
  },

  /** `GET /profiles/{address}` -> `{ address, profile: Profile|null, updatedAt, txId }`. */
  profile(j) {
    const w = "profile";
    const pj = optObject(j, "profile", w);
    let profile = null;
    if (pj != null) {
      profile = Profile.fromJSONObject(pj);
      if (profile == null) throw decodeFail(w);
    }
    return { address: reqString(j, "address", w), profile, updatedAt: optInt(j, "updatedAt", w), txId: optString(j, "txId", w) };
  },

  /** `GET /identity/{address}` -> Identity (profile sanitized). */
  identity(j) {
    const w = "identity";
    if (j == null || typeof j !== "object") throw decodeFail(w);
    const pj = optObject(j, "profile", w);
    let profile = null;
    if (pj != null) {
      profile = Profile.fromJSONObject(pj);
      if (profile == null) throw decodeFail(w);
      profile = profile.sanitized();
    }
    const names = j.names == null ? [] : reqArray(j, "names", w);
    if (!names.every((x) => typeof x === "string")) throw decodeFail(w);
    return makeIdentity({ address: reqString(j, "address", w), label: optString(j, "label", w), names, profile });
  },

  /** `GET /names/status` -> `{ network, registryCovenantId, genesisTxId, indexedDaa, synced }`. */
  status(j) {
    const w = "status";
    if (j == null || typeof j !== "object") throw decodeFail(w);
    return {
      network: optString(j, "network", w), registryCovenantId: optString(j, "registryCovenantId", w),
      genesisTxId: optString(j, "genesisTxId", w), indexedDaa: optInt(j, "indexedDaa", w), synced: optBool(j, "synced", w),
    };
  },
});

// MARK: - Key arithmetic for the indexer's gap lookups

/** `key ± 1` as a 32-byte big-endian number (null past either end). The gap containing `key - 1`
 *  is `(lo, key)` and the one containing `key + 1` is `(key, hi)`: the neighbours an exit
 *  (release, reclaim) spends. */
export function step(key, delta) {
  if (!(key instanceof Uint8Array) || key.length !== 32 || (delta !== 1 && delta !== -1)) return null;
  const b = Uint8Array.from(key);
  for (let i = 31; i >= 0; i--) {
    if (delta === 1) {
      if (b[i] === 0xff) b[i] = 0; else { b[i] += 1; return b; }
    } else if (b[i] === 0) b[i] = 0xff; else { b[i] -= 1; return b; }
  }
  return null;
}
