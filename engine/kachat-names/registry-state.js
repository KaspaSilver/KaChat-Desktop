// .kachat names: the registry as data.
//
// Port of iOS KaChat/Services/KachatNames/KachatNamesRegistryState.swift: what a name, gap or
// offer looks like to the screens, the status rule (KACHAT_NAMES_INDEXER.md B5), the label rule
// (KACHAT_NAMES.md section 7), the address profile record and its social sources (what a social
// profile link shows, read out of a platform's answer), the REST transaction parser, the
// indexer response shapes (Part D), and the chain walker's state with its transition decoder (a
// port of the kachat-domains CLI's `Registry::apply`, B3) and walk loop. Pure: no DOM, no
// network, no keys. Checked by tools/test-kachat-names-registry.mjs.
//
// Conventions as in the rest of engine/kachat-names: bytes are Uint8Array, Swift UInt64/Int64
// (amounts, prices, unix ms, DAA, years) are BigInt, small ints (output indexes) are Number,
// nil is null. The walker's state keeps hex strings (as Swift does) so its cache stays small.

import {
  Failure, hex, unhex, unhex32, bytesEqual, bytesLess, blake3, zero32, ff32, utf8, fromUtf8,
  normalize, isValid, key as nameKey, padded, parsePushes, scriptNum, gapState, nameState, offerState,
  makeNameFields, makeOfferFields, nameFieldsWithOwner, nameFieldsWithPrice, nameFieldsExtended, nameFieldsRenewed,
  maxProfileJSONBytes,
} from "./codec.js";
import { makeOutpoint, makeTxOutput, makeCovenantBinding } from "./transaction.js";
import { templateRedeem, templateScript, templateStateOfRedeem, paramsExtendableYears, paramsRenewOpens } from "./manifest.js";

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
 *     periodStart: bigint|null, outpoint: {txid, index}, registeredAt: bigint|null,
 *     registeredTxId: string|null, updatedAt: bigint|null }`
 *  `periodStart` (unix ms, registry v2) is the start of the current paid period; null when the
 *  source did not say (an indexer without the field): then the name can't be spent from this
 *  record (`fields` is null) and Extend isn't offered. */
export class NameInfo {
  constructor({ name, key, owner, price = 0n, expiresAt, periodStart = null, outpoint, registeredAt = null, registeredTxId = null, updatedAt = null }) {
    this.name = name;
    this.key = key;
    this.owner = owner;
    this.price = big(price);
    this.expiresAt = big(expiresAt);
    this.periodStart = big(periodStart);
    this.outpoint = outpoint;
    this.registeredAt = big(registeredAt);
    this.registeredTxId = registeredTxId ?? null;
    this.updatedAt = big(updatedAt);
  }
  get id() { return this.name; }
  get display() { return `${this.name}.kachat`; }
  get isListed() { return this.price > 0n; }
  /** The name's on-chain state fields (codec NameFields), when the period start is known; else null. */
  get fields() {
    if (this.periodStart == null) return null;
    return makeNameFields({
      key: this.key, paddedName: padded(this.name), owner: this.owner, price: this.price, periodStart: this.periodStart, expiresAt: this.expiresAt,
    });
  }
  status(graceMs, now = nowMs()) { return Status.of(this.expiresAt, graceMs, now); }

  // MARK: The paid period (registry v2, KACHAT_NAMES.md 4.1)

  /** Whole periods `extend` can add now (BigInt; 0n when the period start is unknown). `p`: the
   *  manifest's Params. */
  extendableYears(p) {
    return this.periodStart == null ? 0n : paramsExtendableYears(p, this.periodStart, this.expiresAt);
  }

  /** When the renewal window opens: `expiresAt - renewWindowMs` (unix ms, BigInt). */
  renewOpens(p) { return paramsRenewOpens(p, this.expiresAt); }

  /** The renewal window by the wall clock (what the screens show; the transaction itself waits
   *  for the network's median time, a couple of minutes behind). */
  renewOpen(p, now = nowMs()) { return big(now) >= this.renewOpens(p); }
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

/** An open offer. `{ outpoint, key, name|null, buyer: bytes32, seller: bytes32, amount: bigint,
 *  refundAfter: bigint (DAA from which anyone may refund it), createdAt: bigint|null }`.
 *  `seller` (registry v3) is the name's owner the offer was made to: only they can accept or
 *  decline it. */
export class OfferInfo {
  constructor({ outpoint, key, name = null, buyer, seller, amount, refundAfter, createdAt = null }) {
    this.outpoint = outpoint;
    this.key = key;
    this.name = name ?? null;
    this.buyer = buyer;
    this.seller = seller;
    this.amount = big(amount);
    this.refundAfter = big(refundAfter);
    this.createdAt = big(createdAt);
  }
  get id() { return `${hex(this.outpoint.txid)}:${this.outpoint.index}`; }
  /** The offer's on-chain state fields (codec OfferFields). */
  get fields() { return makeOfferFields({ key: this.key, buyer: this.buyer, seller: this.seller, refundAfter: this.refundAfter }); }
  refundable(atDaa) { return big(atDaa) > bmax(this.refundAfter, 0n); }
  /** Made to an earlier owner of the name (registry v3): it can never be accepted and goes back to
   *  the buyer (withdraw, decline, or a refund once it expires). `currentOwner`: x-only bytes. */
  isDeclined(currentOwner) { return !bytesEqual(this.seller, currentOwner); }
}

/** One registry event (history, activity). Parties are x-only keys (hex, walker) or addresses
 *  (indexer). `op`: register, transfer, list, delist, sale, extend, renew, release, reclaim,
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

/** The label an address is shown with: its `primaryName` if it still holds that name (active or
 *  in grace); otherwise its oldest held name; otherwise null (the caller shows the address). A
 *  name in grace keeps labelling its owner until it lapses and is back on the market (iOS f7c371a). */
export function label(owned, primaryName, graceMs, now = nowMs()) {
  const held = owned.filter((n) => Status.of(n.expiresAt, graceMs, now) !== Status.lapsed);
  if (primaryName != null) {
    const p = normalize(primaryName);
    if (held.some((n) => n.name === p)) return p;
  }
  const oldest = [...held].sort(byRegistration);
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

/** A pasted link as Swift URLComponents sees it: `https://` added when no scheme is given, the
 *  host lowercased, the path split into its non-empty, percent-decoded segments. Null when it does
 *  not parse. */
function parseLink(raw) {
  let t = String(raw ?? "").trim();
  if (!t) return null;
  const l = t.toLowerCase();
  if (!l.startsWith("http://") && !l.startsWith("https://")) t = `https://${t}`;
  let u;
  try { u = new URL(t); } catch { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const host = u.hostname.toLowerCase();
  if (!host) return null;
  const parts = [];
  for (const seg of u.pathname.split("/")) {
    if (!seg) continue;
    try { parts.push(decodeURIComponent(seg)); } catch { return null; }
  }
  return { host, parts };
}

/** Every character a letter or a number (Swift Character.isLetter / isNumber), or one of `extra`. */
function handleChars(s, extra) {
  for (const g of graphemes(s)) {
    if (extra.includes(g)) continue;
    if (!/^[\p{L}\p{N}]\p{M}*$/u.test(g)) return false;
  }
  return true;
}

/** The address profile record: `{ v: 1, avatar, banner, bio, linktree, primaryName }`.
 *
 *  `avatar`, `banner` and `bio` say where each piece comes from: a profile link on a social
 *  platform (SocialSource) - they may be three different accounts. KaChat shows that profile's
 *  avatar, banner or bio, looked up on each device (social-image-resolver.js), so the platform's
 *  moderation applies. No picture or free text is ever written to the chain. `linktree` is a
 *  Linktree page (`https://linktr.ee/<name>`): the one way to link anything else. */
export class Profile {
  constructor({ v = 1, avatar = null, banner = null, bio = null, linktree = null, primaryName = null } = {}) {
    this.v = v;
    this.avatar = avatar ?? null;
    this.banner = banner ?? null;
    this.bio = bio ?? null;
    this.linktree = linktree ?? null;
    this.primaryName = primaryName ?? null;
  }

  /** The longest bio KaChat shows (characters), as the platform supplies it. */
  static get maxBio() { return 280; }

  /** The Linktree username in a stored link (`https://linktr.ee/<name>` -> `<name>`); "" for none. */
  static linktreeUsername(link) {
    const l = Profile.linktreeLink(link);
    return l == null ? "" : l.slice("https://linktr.ee/".length);
  }

  /** What the Linktree field holds - a bare username (with or without `@`), or a pasted link - as
   *  a stored link; null when it is not one. Swift `linktreeLink(username:)`. */
  static linktreeLinkFromUsername(raw) {
    const t = String(raw ?? "").trim();
    if (!t) return null;
    if (t.toLowerCase().includes("linktr.ee")) return Profile.linktreeLink(t);
    const name = t.startsWith("@") ? t.slice(1) : t;
    return Profile.linktreeLink(`https://linktr.ee/${name}`);
  }

  /** A pasted Linktree link, normalized to `https://linktr.ee/<name>`; null for anything else. */
  static linktreeLink(raw) {
    const c = clean(raw);
    if (c == null) return null;
    const u = parseLink(c);
    if (!u) return null;
    const host = u.host.startsWith("www.") ? u.host.slice(4) : u.host;
    if (host !== "linktr.ee" || u.parts.length !== 1) return null;
    const handle = u.parts[0];
    if (graphemes(handle).length > 60 || !handleChars(handle, "._-")) return null;
    return `https://linktr.ee/${handle}`;
  }

  /** The record as the indexer accepts it: a supported social link per field and a Linktree link,
   *  normalized, anything else dropped; the primary name normalized. */
  sanitized() {
    const p = new Profile();
    const src = (s, kind) => { const c = clean(s); return c == null ? null : (SocialSource.fromLink(c, kind)?.link ?? null); };
    p.avatar = src(this.avatar, SocialKind.avatar);
    p.banner = src(this.banner, SocialKind.banner);
    p.bio = src(this.bio, SocialKind.bio);
    p.linktree = Profile.linktreeLink(this.linktree);
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
    if (this.linktree != null) out.linktree = this.linktree;
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
   *  known field a string or null; unknown fields - the old `links` too - ignored); null when it
   *  does not decode. Not sanitized. */
  static fromJSONObject(j) {
    if (j == null || typeof j !== "object" || Array.isArray(j)) return null;
    if (typeof j.v !== "number" || !Number.isInteger(j.v)) return null;
    const fields = {};
    for (const k of ["avatar", "banner", "bio", "linktree", "primaryName"]) {
      const v = j[k];
      if (v != null && typeof v !== "string") return null;
      fields[k] = v ?? null;
    }
    return new Profile({ v: j.v, ...fields });
  }
}

// MARK: - Social sources (where a profile's avatar, banner and bio come from)

/** Which piece of the profile a social link fills. */
export const SocialKind = Object.freeze({ avatar: "avatar", banner: "banner", bio: "bio" });

const PLATFORM_INFO = Object.freeze({
  x: { name: "X", prefix: "x.com/" },
  youtube: { name: "YouTube", prefix: "youtube.com/@" },
  facebook: { name: "Facebook", prefix: "facebook.com/" },
  instagram: { name: "Instagram", prefix: "instagram.com/" },
  tiktok: { name: "TikTok", prefix: "tiktok.com/@" },
  twitch: { name: "Twitch", prefix: "twitch.tv/" },
  kick: { name: "Kick", prefix: "kick.com/" },
  github: { name: "GitHub", prefix: "github.com/" },
  telegram: { name: "Telegram", prefix: "t.me/" },
  linkedin: { name: "LinkedIn", prefix: "linkedin.com/in/" },
  discord: { name: "Discord", prefix: "discord.gg/" },
});

const PLATFORM_CHOICES = Object.freeze({
  avatar: Object.freeze(["x", "youtube", "instagram", "tiktok", "facebook", "twitch", "kick", "github", "telegram", "linkedin", "discord"]),
  banner: Object.freeze(["x", "youtube", "discord"]),
  bio: Object.freeze(["x", "youtube", "telegram", "twitch", "kick", "github", "discord"]),
});

/** The platforms a profile can point at (Swift `SocialSource.Platform`), by raw value. */
export const SocialPlatform = Object.freeze({
  x: "x", youtube: "youtube", facebook: "facebook", instagram: "instagram", tiktok: "tiktok", twitch: "twitch",
  kick: "kick", github: "github", telegram: "telegram", linkedin: "linkedin", discord: "discord",
  /** Every platform (Swift `allCases`). */
  all: Object.freeze(Object.keys(PLATFORM_INFO)),
  isPlatform(p) { return typeof p === "string" && Object.hasOwn(PLATFORM_INFO, p); },
  /** Platforms whose banner can be read without signing in. */
  hasBanner(p) { return PLATFORM_CHOICES.banner.includes(p); },
  /** Platforms whose preview carries the person's own bio (see `SocialSource.bio`). */
  hasBio(p) { return PLATFORM_CHOICES.bio.includes(p); },
  /** What the handle field shows in front of the handle. */
  prefix(p) { return PLATFORM_INFO[p]?.prefix ?? ""; },
  displayName(p) { return PLATFORM_INFO[p]?.name ?? String(p ?? ""); },
  /** The platforms that can fill a field (SocialKind), in picker order. */
  choices(kind) { return PLATFORM_CHOICES[kind] ?? []; },
});

/** A handle segment: 1 to 100 characters, letters, numbers, `.`, `_`, `-`, `@`. */
const okHandle = (s) => typeof s === "string" && s.length > 0 && graphemes(s).length <= 100 && handleChars(s, "._-@");

/** What a social profile link shows right now: avatar, banner (X, YouTube, Discord) and bio.
 *  `{ avatar: string|null, banner: string|null, bio: string|null }` */
export class SocialProfile {
  constructor({ avatar = null, banner = null, bio = null } = {}) {
    this.avatar = typeof avatar === "string" ? avatar : null;
    this.banner = typeof banner === "string" ? banner : null;
    this.bio = typeof bio === "string" ? bio : null;
  }
  get isEmpty() { return this.avatar == null && this.banner == null && this.bio == null; }
  /** The piece a field shows (SocialKind). */
  piece(kind) { return kind === SocialKind.avatar ? this.avatar : kind === SocialKind.banner ? this.banner : kind === SocialKind.bio ? this.bio : null; }
  toJSON() { return { avatar: this.avatar, banner: this.banner, bio: this.bio }; }
}

/** A JSON answer (text or an already parsed value) as an object, or null. */
function jsonObject(data) {
  let j = data;
  if (typeof data === "string") { try { j = JSON.parse(data); } catch { return null; } }
  return j != null && typeof j === "object" && !Array.isArray(j) ? j : null;
}

const META_TAG_MAX = 8192;
const META_TAGS_MAX = 400;

/** The page's `<meta ...>` tags in order (each up to its first `>`; at most 400, each at most
 *  8 KB). One linear pass: a hostile page can't make it backtrack. */
function metaTags(html) {
  const s = String(html ?? "");
  const out = [];
  const re = /<meta/gi;
  let m;
  while (out.length < META_TAGS_MAX && (m = re.exec(s)) != null) {
    const end = s.indexOf(">", m.index + 5);
    if (end < 0) break;
    if (end - m.index <= META_TAG_MAX) out.push(s.slice(m.index, end + 1));
    re.lastIndex = end + 1;
  }
  return out;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The first meta tag naming `key` (`property=` or `name=`, any case), or null. */
function metaTagFor(tags, key) {
  const re = new RegExp(`(?:property|name)=["']${escapeRe(key)}["']`, "i");
  return tags.find((t) => re.test(t)) ?? null;
}

/**
 * Where a profile's avatar, banner or bio comes from: a profile link on a platform that moderates
 * what it shows (X, YouTube, Facebook, ...). The record stores only the link; each device looks
 * the current picture or bio up and caches it (social-image-resolver.js), so something the
 * platform takes down disappears here too. Nothing is ever uploaded.
 *
 * `{ platform: SocialPlatform value, link: the normalized profile link (e.g. "https://x.com/name"),
 *    handle: the handle, channel path or invite code inside it }`. Build one with
 * `SocialSource.fromLink(raw, kind)` (Swift `init?(link:for:)`) or `SocialSource.from(platform,
 * handle, kind)`.
 */
export class SocialSource {
  constructor({ platform, link, handle }) {
    this.platform = platform;
    this.link = link;
    this.handle = handle;
  }

  /** A pasted profile link (with or without `https://`, `www.`, `m.`, trailing slash or query).
   *  Null for an unsupported site, a post rather than a profile, or a field (SocialKind) the
   *  platform can't fill. */
  static fromLink(raw, kind) {
    const u = parseLink(raw);
    if (!u) return null;
    let host = u.host;
    for (const prefix of ["www.", "m.", "mobile."]) if (host.startsWith(prefix)) host = host.slice(prefix.length);
    const parts = u.parts;
    const p0 = parts[0] ?? "";
    const lower0 = p0.toLowerCase();
    let platform = null;
    let handle = "";
    let link = "";
    switch (host) {
      case "x.com": case "twitter.com":
        if (parts.length === 1 && okHandle(p0) && !["home", "explore", "search", "i", "settings"].includes(lower0)) {
          platform = "x"; handle = p0; link = `https://x.com/${handle}`;
        }
        break;
      case "youtube.com":
        if (parts.length >= 1 && p0.startsWith("@") && okHandle(p0)) {
          platform = "youtube"; handle = p0; link = `https://www.youtube.com/${handle}`;
        } else if (parts.length >= 2 && ["channel", "c", "user"].includes(p0) && okHandle(parts[1])) {
          platform = "youtube"; handle = `${p0}/${parts[1]}`; link = `https://www.youtube.com/${handle}`;
        }
        break;
      case "facebook.com": case "fb.com":
        if (parts.length === 1 && okHandle(p0) && !["profile.php", "groups", "watch", "events"].includes(lower0)) {
          platform = "facebook"; handle = p0; link = `https://www.facebook.com/${handle}`;
        }
        break;
      case "instagram.com":
        if (parts.length === 1 && okHandle(p0) && !["p", "reel", "reels", "explore", "stories"].includes(lower0)) {
          platform = "instagram"; handle = p0; link = `https://www.instagram.com/${handle}/`;
        }
        break;
      case "tiktok.com":
        if (parts.length === 1 && p0.startsWith("@") && okHandle(p0)) {
          platform = "tiktok"; handle = p0; link = `https://www.tiktok.com/${handle}`;
        }
        break;
      case "twitch.tv":
        if (parts.length === 1 && okHandle(p0)) { platform = "twitch"; handle = p0; link = `https://www.twitch.tv/${handle}`; }
        break;
      case "kick.com":
        if (parts.length === 1 && okHandle(p0)) { platform = "kick"; handle = p0; link = `https://kick.com/${handle}`; }
        break;
      case "github.com":
        if (parts.length === 1 && okHandle(p0)) { platform = "github"; handle = p0; link = `https://github.com/${handle}`; }
        break;
      case "t.me": case "telegram.me":
        if (parts.length === 1 && okHandle(p0) && !p0.startsWith("+")) {
          platform = "telegram"; handle = p0; link = `https://t.me/${handle}`;
        }
        break;
      case "linkedin.com":
        if (parts.length >= 2 && ["in", "company"].includes(p0) && okHandle(parts[1])) {
          platform = "linkedin"; handle = `${p0}/${parts[1]}`; link = `https://www.linkedin.com/${handle}`;
        }
        break;
      case "discord.gg":
        if (parts.length === 1 && okHandle(p0)) { platform = "discord"; handle = p0; link = `https://discord.gg/${handle}`; }
        break;
      case "discord.com": case "discordapp.com":
        if (parts.length === 2 && p0 === "invite" && okHandle(parts[1])) {
          platform = "discord"; handle = parts[1]; link = `https://discord.gg/${handle}`;
        }
        break;
      default:
        break;
    }
    if (platform == null) return null;
    if (kind === SocialKind.banner && !SocialPlatform.hasBanner(platform)) return null;
    if (kind === SocialKind.bio && !SocialPlatform.hasBio(platform)) return null;
    return new SocialSource({ platform, link, handle });
  }

  /** A handle typed for `platform` (with or without `@`), or a whole pasted profile link - which
   *  may name another platform: the caller switches its picker to the result's `platform`. */
  static from(platform, rawHandle, kind) {
    let h = String(rawHandle ?? "").trim();
    if (!h) return null;
    if (h.toLowerCase().startsWith("http") || (h.includes(".") && h.includes("/"))) {
      return SocialSource.fromLink(h, kind);
    }
    if (!SocialPlatform.isPlatform(platform)) return null;
    if (h.startsWith("@")) h = h.slice(1);
    let link;
    if (platform === "linkedin") {
      link = h.startsWith("in/") || h.startsWith("company/") ? `linkedin.com/${h}` : SocialPlatform.prefix(platform) + h;
    } else if (platform === "youtube" && /^(channel|c|user)\//.test(h)) {
      // a stored channel path shown back in the field (`displayHandle`) maps to itself
      link = `youtube.com/${h}`;
    } else {
      link = SocialPlatform.prefix(platform) + h;
    }
    return SocialSource.fromLink(link, kind);
  }

  /** The handle as the field shows it after `SocialPlatform.prefix(platform)`. */
  get displayHandle() {
    switch (this.platform) {
      case "youtube": case "tiktok": return this.handle.startsWith("@") ? this.handle.slice(1) : this.handle;
      case "linkedin": return this.handle.startsWith("in/") ? this.handle.slice(3) : this.handle;
      default: return this.handle;
    }
  }

  // MARK: Reading the picture out of what the platform serves (pure, testable)

  /** The `og:image` (or `og:image:secure_url`, `twitter:image`) of an HTML page, entities decoded;
   *  `https://` only. */
  static openGraphImage(html) {
    const tags = metaTags(html);
    for (const key of ["og:image", "og:image:secure_url", "twitter:image"]) {
      const tag = metaTagFor(tags, key);
      if (!tag) continue;
      const c = /content=["']([^"']+)["']/.exec(tag);
      if (!c) continue;
      const value = SocialSource.decodeEntities(c[1]);
      if (value.toLowerCase().startsWith("https://")) return value;
    }
    return null;
  }

  /** The page's `og:description` (or `description`, `twitter:description`), entities decoded. */
  static openGraphDescription(html) {
    const tags = metaTags(html);
    for (const key of ["og:description", "description", "twitter:description"]) {
      const tag = metaTagFor(tags, key);
      if (!tag) continue;
      const c = /content="([^"]*)"/.exec(tag) ?? /content='([^']*)'/.exec(tag);
      if (!c) continue;
      const value = SocialSource.decodeEntities(c[1]).trim();
      if (value) return value;
    }
    return null;
  }

  /** The bio a platform shows in its preview, where that text really is the person's own (X,
   *  YouTube, Telegram, Kick, and Twitch without its boilerplate). Instagram, TikTok, Facebook and
   *  LinkedIn only put follower counts or site text there: no bio from them. GitHub and Discord
   *  come from their APIs instead. */
  static bio(platform, description) {
    if (typeof description !== "string" || !description) return null;
    let text;
    switch (platform) {
      case "x": case "youtube": case "telegram": case "kick":
        text = description;
        break;
      case "twitch":
        // "<description> — Twitch streams live on Twitch! Check out their videos ..."
        text = description.split(" — ")[0];
        break;
      default:
        return null;
    }
    return SocialSource.trimmedBio(text);
  }

  /** Trimmed and cut to `Profile.maxBio` characters; null when blank. */
  static trimmedBio(s) {
    if (typeof s !== "string") return null;
    const t = s.trim();
    return t ? graphemes(t).slice(0, Profile.maxBio).join("") : null;
  }

  /** GitHub's public user API (`api.github.com/users/<name>`, JSON text or parsed): `{ avatar, bio }`. */
  static githubProfile(json) {
    const root = jsonObject(json);
    if (!root) return { avatar: null, bio: null };
    return { avatar: typeof root.avatar_url === "string" ? root.avatar_url : null, bio: SocialSource.trimmedBio(root.bio) };
  }

  /** FxTwitter's user API (`api.fxtwitter.com/<handle>`, JSON text or parsed): X's avatar (400 px),
   *  banner and bio in one small answer - X's own data, so X's moderation still applies. An empty
   *  SocialProfile for an unknown or suspended account (`code` 404); null when the answer isn't a
   *  user (fall back to X's page). */
  static fxTwitterProfile(json) {
    const root = jsonObject(json);
    if (!root) return null;
    const user = root.user;
    if (root.code !== 200 || user == null || typeof user !== "object" || Array.isArray(user)) {
      return root.code === 404 ? new SocialProfile() : null;
    }
    const p = new SocialProfile();
    if (typeof user.avatar_url === "string" && user.avatar_url.startsWith("https://")) {
      p.avatar = user.avatar_url.replaceAll("_normal.", "_400x400.");
    }
    if (typeof user.banner_url === "string" && user.banner_url.startsWith("https://")) {
      p.banner = user.banner_url.endsWith("/1500x500") ? user.banner_url : `${user.banner_url}/1500x500`;
    }
    p.bio = SocialSource.trimmedBio(user.description);
    return p;
  }

  /** A Discord invite's server description (`/api/v10/invites/{code}`, JSON text or parsed). */
  static discordDescription(json) {
    const guild = jsonObject(json)?.guild;
    if (guild == null || typeof guild !== "object") return null;
    return SocialSource.trimmedBio(guild.description);
  }

  /** HTML entities as they appear in meta tags: named basics plus decimal and hex numbers. */
  static decodeEntities(s) {
    let out = String(s ?? "");
    if (!out.includes("&")) return out;
    for (const [k, v] of [["&quot;", "\""], ["&apos;", "'"], ["&lt;", "<"], ["&gt;", ">"], ["&nbsp;", " "]]) out = out.replaceAll(k, v);
    const re = /&#(x[0-9a-fA-F]+|[0-9]+);/;
    for (let guard = 0; guard < 10_000; guard++) {
      const m = re.exec(out);
      if (!m) break;
      const body = m[1];
      const code = body.length > 12 ? NaN : (body[0] === "x" ? parseInt(body.slice(1), 16) : parseInt(body, 10));
      const ok = Number.isInteger(code) && code >= 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff);
      out = out.slice(0, m.index) + (ok ? String.fromCodePoint(code) : "") + out.slice(m.index + m[0].length);
    }
    // last, so "&amp;#39;" (double-encoded, as LinkedIn sends) decodes one level only
    return out.replaceAll("&amp;", "&");
  }

  /** X's avatar from its page, upgraded from the 200px thumbnail to 400px. */
  static xAvatar(url) { return String(url).replaceAll("_200x200.", "_400x400."); }

  /** X's banner: the page names it as `profile_banners/<user id>/<version>`. */
  static xBanner(html) {
    const m = /profile_banners\/[0-9]+\/[0-9]+/.exec(String(html ?? ""));
    return m ? `https://pbs.twimg.com/${m[0]}/1500x500` : null;
  }

  /** YouTube's channel banner from the page's embedded data, when the channel has one. */
  static youtubeBanner(html) {
    const s = String(html ?? "");
    // The object itself (the bare name also appears earlier, in a list of renderer types).
    const marker = "\"imageBannerViewModel\":{";
    const start = s.indexOf(marker);
    if (start < 0) return null;
    const win = s.slice(start + marker.length, start + marker.length + 4000);
    const m = /https:\/\/yt3\.googleusercontent\.com\/[^"\\]+/.exec(win);
    return m ? m[0] : null;
  }

  /** Discord invite (JSON text or parsed) -> the server's icon (avatar) or banner. */
  static discordImage(json, kind) {
    const guild = jsonObject(json)?.guild;
    if (guild == null || typeof guild !== "object" || typeof guild.id !== "string") return null;
    if (!/^[0-9]{1,25}$/.test(guild.id)) return null;
    const hash = (v) => (typeof v === "string" && /^[A-Za-z0-9_]{1,80}$/.test(v) ? v : null);
    switch (kind) {
      case SocialKind.avatar: {
        const icon = hash(guild.icon);
        return icon ? `https://cdn.discordapp.com/icons/${guild.id}/${icon}.png?size=256` : null;
      }
      case SocialKind.banner: {
        const banner = hash(guild.banner);
        return banner ? `https://cdn.discordapp.com/banners/${guild.id}/${banner}.png?size=1024` : null;
      }
      default:
        return null; // the server's description: `discordDescription`
    }
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

/** The network prefix plus both ends of the address on one line: `kaspatest:qr4x7k...a9z2pq`
 *  (6 characters each side). Where the full address doesn't fit (the Owner card). An address
 *  without a prefix, or whose body is 14 characters or fewer, comes back unchanged. */
export function compactAddress(address) {
  const a = String(address ?? "");
  const colon = a.indexOf(":");
  if (colon < 0) return a;
  const prefix = a.slice(0, colon + 1);
  const body = [...a.slice(colon + 1)];
  if (body.length <= 14) return a;
  return `${prefix}${body.slice(0, 6).join("")}...${body.slice(-6).join("")}`;
}

/** `kaspatest:qr...xyz4`. */
export function shortAddress(address) {
  const a = String(address);
  if (a.length <= 20) return a;
  return `${a.slice(0, 14)}...${a.slice(-6)}`;
}

// MARK: - A transaction as the walker sees it

/** `{ id: bytes32, inputs: [{ outpoint, signatureScript }], outputs: TxOutput[], payload, at: bigint|null,
 *  blueScore: bigint|null }` (`at`: unix ms of the accepting block, or the block, when known;
 *  `blueScore`: the accepting block's blue score, when known - the walk's tie-break for
 *  transactions that do not spend each other). */
export class TxView {
  constructor({ id, inputs, outputs, payload = new Uint8Array(0), at = null, blueScore = null }) {
    this.id = id;
    this.inputs = inputs;
    this.outputs = outputs;
    this.payload = payload;
    this.at = big(at);
    this.blueScore = big(blueScore);
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
    const blueScore = num(j.accepting_block_blue_score);
    const byOrder = (a, b) => a[0] - b[0];
    return new TxView({
      id,
      inputs: inputs.sort(byOrder).map((x) => x[1]),
      outputs: outputs.sort(byOrder).map((x) => x[1]),
      payload,
      at,
      blueScore,
    });
  }
}

// MARK: - The walker's registry state (cached, per network)

const opKey = (txid, index) => `${txid}:${index}`;

function safeUnhex32(s, fallback) { try { return unhex32(s); } catch { return fallback(); } }

/** The registry without an indexer: the live gaps and names (and the offers this device made),
 *  decoded, moved forward one spending transaction at a time from the manifest's genesis (the
 *  genesis gap; registry v4 has no price record). Hex strings throughout (as Swift) so the cache
 *  stays readable.
 *
 *  Gap   { txid, index, lo, hi, value: bigint }
 *  Name  { txid, index, name, key, owner, price: bigint, periodStart: bigint (registry v2),
 *          expiresAt: bigint, value: bigint, registeredAt: bigint|null, registeredTxId: string|null,
 *          updatedAt: bigint|null }
 *  Offer { txid, index, key, buyer, seller, refundAfter: bigint, value: bigint, name: string|null, createdAt: bigint|null } */
export class RegistryState {
  /** 4: registry v4 (fixed prices: no price shards); an older cache is dropped and walked again. */
  static get formatVersion() { return 4; }
  static get appliedKeep() { return 4096; }
  static get eventsKeep() { return 1000; }

  constructor({
    version = RegistryState.formatVersion, network, registryCovenantId, gaps = [], names = [], offers = [],
    applied = [], events = [], verifiedAt = null,
  }) {
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

  /** The genesis: the lone genesis gap. */
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
      price: bmax(n.price, 0n), expiresAt: n.expiresAt, periodStart: n.periodStart, outpoint: RegistryState.outpoint(n.txid, n.index),
      registeredAt: n.registeredAt ?? null, registeredTxId: n.registeredTxId ?? null, updatedAt: n.updatedAt ?? null,
    });
  }

  /** A tracked name's on-chain state (Swift `RegistryState.fields(_ n: Name)`). */
  static nameFields(n) {
    return makeNameFields({
      key: safeUnhex32(n.key, zero32), paddedName: padded(n.name), owner: safeUnhex32(n.owner, zero32),
      price: n.price, periodStart: n.periodStart, expiresAt: n.expiresAt,
    });
  }

  static gapInfo(g) {
    return new GapInfo({ lo: safeUnhex32(g.lo, zero32), hi: safeUnhex32(g.hi, ff32), outpoint: RegistryState.outpoint(g.txid, g.index) });
  }

  static offerInfo(o) {
    return new OfferInfo({
      outpoint: RegistryState.outpoint(o.txid, o.index), key: safeUnhex32(o.key, zero32), name: o.name ?? null,
      buyer: safeUnhex32(o.buyer, zero32), seller: safeUnhex32(o.seller, zero32), amount: o.value, refundAfter: o.refundAfter,
      createdAt: o.createdAt ?? null,
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
      out.push({ outpoint: opKey(n.txid, n.index), script: templateScript(m.name, nameState(RegistryState.nameFields(n))), registry: true });
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
      txid, index: o.outpoint.index, key: hex(o.key), buyer: hex(o.buyer), seller: hex(o.seller), refundAfter: big(o.refundAfter),
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

  /** The offer a transaction announces with the registry v3 marker
   *  `kchat:1:offer:<key>:<buyer>:<seller>:<refundAfter>`, if one of its outputs really is that offer
   *  (KACHAT_NAMES_INDEXER.md B4): `{ index, fields }` or null. */
  static offerFromMarker(tx, m) {
    let text;
    try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(tx.payload); } catch { return null; }
    const prefix = "kchat:1:offer:";
    if (!text.startsWith(prefix)) return null;
    const parts = text.slice(prefix.length).split(":");
    if (parts.length !== 4) return null;
    let k, buyer, seller;
    try { k = unhex32(parts[0]); buyer = unhex32(parts[1]); seller = unhex32(parts[2]); } catch { return null; }
    if (!/^[+-]?[0-9]+$/.test(parts[3])) return null;
    const refundAfter = BigInt(parts[3]);
    if (refundAfter < 0n || refundAfter > I64_MAX) return null;
    const fields = makeOfferFields({ key: k, buyer, seller, refundAfter });
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

  /** Which registry template (`"gap"`, `"name"`) an input's revealed redeem script is, or null (a
   *  P2PK input, an offer, a commit, anything else). Registry v4 has no price shards. */
  static _registryTemplateOf(input, m) {
    let pushes;
    try { pushes = parsePushes(input.signatureScript); } catch { return null; }
    const redeem = pushes[pushes.length - 1];
    if (redeem === undefined) return null;
    for (const [what, t] of [["gap", m.gap], ["name", m.name]]) {
      try { templateStateOfRedeem(t, redeem); return what; } catch { /* not this one */ }
    }
    return null;
  }

  /** Applies one transaction (a TxView). Returns its registry events (Event[]); an unrelated
   *  transaction returns none. Every registry output must be predicted exactly from the tracked
   *  inputs it spends (and authorized by that input), or the transaction is refused (a Failure)
   *  and nothing changes. A transaction that spends a registry UTXO (gap or name)
   *  this state does not track yet is refused with `waiting: true`: an earlier transaction on
   *  that record has not been applied yet, so applying this one now would lose that record's
   *  spend (a reclaimed name kept). The walk applies it once the record catches up. */
  apply(tx, m) {
    const id = tx.idHex;
    if (this.applied.includes(id)) return [];
    const registryId = unhex32(this.registryCovenantId);
    const regOuts = [];
    tx.outputs.forEach((o, j) => {
      if (o.covenant && bytesEqual(o.covenant.covenantId, registryId)) regOuts.push(j);
    });
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
    // every registry UTXO it spends must be tracked (order-independence: see above)
    const trackedInputs = new Set([...gapIns, ...nameIns, ...offerIns].map(([i]) => i));
    tx.inputs.forEach((input, i) => {
      if (trackedInputs.has(i)) return;
      const what = RegistryState._registryTemplateOf(input, m);
      if (what == null) return;
      const f = new Failure(`${short}: ${what} input ${i} spends ${hex(input.outpoint.txid).slice(0, 12)}:${input.outpoint.index}, a registry UTXO not tracked yet`);
      f.waiting = true;
      throw f;
    });
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
          const f = makeNameFields({ key: k, paddedName: pad, owner, price: 0n, periodStart: now, expiresAt: now + years * m.params.periodMs });
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
      const f = RegistryState.nameFields(n);
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
        case "extend": {
          // periodStart kept, expiresAt + years (the contract checked the 2-year cap)
          const years = RegistryState._argInt(sp.args, 0);
          predicted.push({ auth: i, p: { kind: "name", f: nameFieldsExtended(f, years, m.params.periodMs), name: n.name } });
          events.push(new Event({ txId: id, op: "extend", name: n.name, at: tx.at, years }));
          break;
        }
        case "renew": {
          // a new period from the old expiry
          const years = RegistryState._argInt(sp.args, 0);
          predicted.push({ auth: i, p: { kind: "name", f: nameFieldsRenewed(f, years, m.params.periodMs), name: n.name } });
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
      let script, cov;
      if (p.kind === "gap") { script = templateScript(m.gap, gapState(unhex32(p.lo), unhex32(p.hi))); cov = registryId; }
      else { script = templateScript(m.name, nameState(p.f)); cov = registryId; }
      const idx = regOuts.find((j) => !matched.has(j) && bytesEqual(tx.outputs[j].script, script)
        && tx.outputs[j].covenant?.authorizingInput === auth && bytesEqual(tx.outputs[j].covenant?.covenantId, cov));
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
          txid: id, index: idx, name: p.name, key: k, owner: hex(p.f.owner), price: p.f.price,
          periodStart: p.f.periodStart, expiresAt: p.f.expiresAt, value,
          registeredAt: before?.registeredAt ?? tx.at ?? null, registeredTxId: before?.registeredTxId ?? id, updatedAt: tx.at ?? null,
        });
      }
    }
    if (newOffer) {
      const { index, fields } = newOffer;
      const known = this.names.find((n) => n.key === hex(fields.key))?.name ?? null;
      this.offers = this.offers.filter((o) => !(o.txid === id && o.index === index));
      this.offers.push({
        txid: id, index, key: hex(fields.key), buyer: hex(fields.buyer), seller: hex(fields.seller), refundAfter: fields.refundAfter,
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
   *  outputs are tracked next round. A round's transactions are applied in chain order
   *  (`_chainOrder`: after the ones they spend from, then by accepting blue score / time), and one
   *  that spends a registry UTXO not tracked yet (`apply` refuses it as `waiting`) waits for a
   *  later pass or round - so the result does not depend on the order the REST API lists them,
   *  nor on how many rounds each record's chain of spends takes. Throws a Failure with `stale`
   *  when a tracked UTXO turns out spent by a transaction already applied (an out-of-date cache).
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
        return this._walked(report);
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
      if (candidates.size === 0) return this._walked(report);
      // A tracked UTXO spent by a transaction this state already applied: the state is out of
      // date with the chain (a cache walked out of order by an earlier version). `stale`: the
      // caller walks again from the genesis.
      const again = [...candidates.values()].find((tx) => this.applied.includes(tx.idHex));
      if (again) {
        const f = new Failure(`${again.idHex.slice(0, 12)} was applied but a UTXO it spends is still tracked`);
        f.stale = true;
        throw f;
      }
      // chain order: after every candidate it spends from, else by accepting blue score / time
      let pending = RegistryState._chainOrder([...candidates.values()]);
      let lastError = null;
      let progressed = true;
      let appliedThisRound = 0;
      while (progressed && pending.length) {
        progressed = false;
        const rest = [];
        for (const tx of pending) {
          try {
            const events = this.apply(tx, m);
            report.applied.push(tx.idHex);
            report.events.push(...events);
            progressed = true;
            appliedThisRound += 1;
          } catch (e) {
            // `waiting`: it spends a registry UTXO an earlier transaction (not applied yet) makes
            if (!e?.waiting) lastError = e;
            rest.push(tx);
          }
        }
        pending = rest;
      }
      if (appliedThisRound === 0) {
        // nothing applied: the same spends would fail again next round
        if (lastError) throw lastError;
        // only waiting ones: the transaction they wait for is not visible yet (an indexing delay
        // of the REST API); their spends count as unresolved, the next refresh retries
        const waits = new Set(report.unresolved);
        const spentOps = new Set(spent.map((x) => x[1]));
        for (const tx of pending) for (const i of tx.inputs) {
          const op = opKey(hex(i.outpoint.txid), i.outpoint.index);
          if (spentOps.has(op)) waits.add(op);
        }
        report.unresolved = [...waits].sort();
        return this._walked(report);
      }
    }
    return this._walked(report);
  }

  /** The walk's end: events (the state's and the report's) in chain time order. Rounds follow
   *  each record's spends, so a round can apply a later transaction of one record before an
   *  earlier one of another; a stable sort by `at` puts them back in the chain's order (a
   *  transaction's own events, and transactions at the same time, keep the applied order). */
  _walked(report) {
    this.events = RegistryState._chronological(this.events);
    report.events = RegistryState._chronological(report.events);
    return report;
  }

  /** Events stably sorted by `at`; one without a time keeps the time of the event before it. */
  static _chronological(events) {
    let last = -1n;
    const keyed = events.map((e, i) => {
      if (e.at != null) last = e.at;
      return { e, k: e.at ?? last, i };
    });
    keyed.sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : a.i - b.i));
    return keyed.map((x) => x.e);
  }

  /** Transactions in chain order: each after every one in the list whose output it spends
   *  (topological); otherwise by accepting blue score (when every one has it), then accepting
   *  time, then id. */
  static _chainOrder(txs) {
    const useScore = txs.every((t) => t.blueScore != null);
    const cmp = (a, b) => {
      if (useScore && a.blueScore !== b.blueScore) return a.blueScore < b.blueScore ? -1 : 1;
      const ta = a.at ?? 0n, tb = b.at ?? 0n;
      if (ta !== tb) return ta < tb ? -1 : 1;
      return a.idHex < b.idHex ? -1 : a.idHex > b.idHex ? 1 : 0;
    };
    const ids = new Set(txs.map((t) => t.idHex));
    const parents = new Map(txs.map((t) => [
      t.idHex, new Set(t.inputs.map((i) => hex(i.outpoint.txid)).filter((p) => p !== t.idHex && ids.has(p))),
    ]));
    let rest = [...txs].sort(cmp);
    const out = [];
    const placed = new Set();
    while (rest.length) {
      // the earliest whose parents are all placed (a cycle cannot happen; if it did, the earliest)
      let k = rest.findIndex((t) => [...parents.get(t.idHex)].every((p) => placed.has(p)));
      if (k < 0) k = 0;
      const [t] = rest.splice(k, 1);
      out.push(t);
      placed.add(t.idHex);
    }
    return out;
  }

  // MARK: Cache format (compact JSON: hex strings, BigInt as decimal strings)
  //
  // { v: 4, network, registryCovenantId, verifiedAt: "ms"|null,
  //   gaps:   [[txid, index, lo, hi, value]],
  //   names:  [[txid, index, name, key, owner, price, periodStart, expiresAt, value, registeredAt|null, registeredTxId|null, updatedAt|null]],
  //   offers: [[txid, index, key, buyer, seller, refundAfter, value, name|null, createdAt|null]],
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
      names: this.names.map((n) => [
        n.txid, n.index, n.name, n.key, n.owner, s(n.price), s(n.periodStart), s(n.expiresAt), s(n.value), s(n.registeredAt),
        n.registeredTxId ?? null, s(n.updatedAt),
      ]),
      offers: this.offers.map((o) => [o.txid, o.index, o.key, o.buyer, o.seller, s(o.refundAfter), s(o.value), o.name ?? null, s(o.createdAt)]),
      applied: [...this.applied],
      events: this.events.map(eventToJSON),
    };
  }

  /** The state from `toJSON()`'s object (or its JSON text); throws on a malformed one, and on a
   *  cache of another format (an earlier registry's cache, format 1 - 3, is walked again). */
  static fromJSON(j) {
    if (typeof j === "string") j = JSON.parse(j);
    if (j == null || typeof j !== "object" || !Array.isArray(j.gaps) || !Array.isArray(j.names)) throw new Failure("not a registry cache");
    if (j.v !== RegistryState.formatVersion) throw new Failure(`registry cache format ${j.v}, not ${RegistryState.formatVersion}`);
    const b = (v) => (v == null ? null : BigInt(v));
    const idx = (v) => { const n = Number(v); if (!Number.isInteger(n) || n < 0) throw new Failure("bad index"); return n; };
    return new RegistryState({
      version: j.v,
      network: j.network,
      registryCovenantId: j.registryCovenantId,
      verifiedAt: b(j.verifiedAt),
      gaps: j.gaps.map((g) => ({ txid: g[0], index: idx(g[1]), lo: g[2], hi: g[3], value: BigInt(g[4]) })),
      names: j.names.map((n) => ({
        txid: n[0], index: idx(n[1]), name: n[2], key: n[3], owner: n[4], price: BigInt(n[5]), periodStart: BigInt(n[6]),
        expiresAt: BigInt(n[7]), value: BigInt(n[8]), registeredAt: b(n[9]), registeredTxId: n[10] ?? null, updatedAt: b(n[11]),
      })),
      offers: (j.offers ?? []).map((o) => ({
        txid: o[0], index: idx(o[1]), key: o[2], buyer: o[3], seller: o[4], refundAfter: BigInt(o[5]), value: BigInt(o[6]), name: o[7] ?? null,
        createdAt: b(o[8]),
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
   *  `{ name, key, registered, status, owner, ownerKey, price, periodStart, expiresAt, outpoint,
   *     registeredAt, registeredTxId, updatedAt, gap }` (`periodStart`: registry v2, the start of
   *  the current paid period in unix ms; optional). Throws when the shape is wrong. */
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
      periodStart: optInt(j, "periodStart", w),
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
      periodStart: d.periodStart ?? null, outpoint: d.outpoint, registeredAt: d.registeredAt, registeredTxId: d.registeredTxId, updatedAt: d.updatedAt,
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

  /** An offer object -> OfferInfo|null (`name` falls back to `fallbackName`; the buyer and seller
   *  addresses must decode to x-only keys). An indexer without the seller (registry v2) gives
   *  null: a v3 offer can't be accepted or declined without it. */
  offerInfo(j, fallbackName = null, keyOfFn = keyOf) {
    const w = "offer";
    if (j == null || typeof j !== "object") throw decodeFail(w);
    const op = IndexerAPI.outpoint(reqObject(j, "outpoint", w));
    const buyer = reqString(j, "buyer", w);
    const seller = optString(j, "seller", w);
    const amountS = reqString(j, "amount", w);
    const refundAfter = intOf(j.refundAfter, w);
    const createdAt = optInt(j, "createdAt", w);
    optBool(j, "refundable", w);
    const name = optString(j, "name", w);
    const buyerKey = keyOfFn(buyer);
    const sellerKey = seller == null ? null : keyOfFn(seller);
    const amount = parseU64(amountS);
    if (!op || !buyerKey || !sellerKey || amount == null) return null;
    const raw = name ?? fallbackName;
    if (raw == null) return null;
    const n = normalize(raw);
    if (!isValid(n)) return null;
    return new OfferInfo({ outpoint: op, key: nameKey(n), name: n, buyer: buyerKey, seller: sellerKey, amount, refundAfter, createdAt });
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

  /** `GET /names/status` -> `{ network, registryCovenantId, genesisTxId, indexedDaa, synced }`
   *  (registry v4: the indexer is matched on the registry id alone). */
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
