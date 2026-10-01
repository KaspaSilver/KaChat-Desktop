// The Kaspa name services besides KNS (which engine/kns.js covers for `.kas`), plus the
// priority resolution that asks every service at once. A port of iOS
// KaChat/Services/NameServices.swift (5.2):
//
// - `.k`      dotk (dotk.name). Read API https://api.dotk.name/v1, reference SDK `@dotk/sdk`.
//             GET /addresses/{kaspa address} lists every live name an owner holds.
// - `.kaspa`  Kaspa Names (kaspaname.com), covenant-backed names on L1. Read API
//             https://kaspaname.com/v1, reference SDK `@kronsdk/kaspa-names`.
//             GET /addresses/{owner identifier}/names lists an owner's names, where the
//             identifier is the 64-hex x-only public key inside a P2PK address - not the
//             `kaspa:` string itself.
// - `.kachat` KaChat's own names. Not live yet; listed so the app already has its place.
//
// Read-only: nothing here needs a wallet key or makes a transaction. No DOM, no storage.
// Uses the global fetch, so the app's relay wrapper (same-origin proxy for some hosts) applies.
//
// Name normalization is ADJUDICATION-CRITICAL: a normalizer that disagrees with a service's own
// on one byte can resolve a typed name to the wrong owner. Each rule below is a port of the
// iOS port, which was checked against the SDKs' published vectors
// (~/kns-sdk/vectors/normalization.json and ~/dotk-sdk/src/generated/*/vectors.json `normalize`).
// Re-check them whenever an SDK's vectors change.
//
// Swift -> JS notes (no observable difference for any input these rules accept):
// - Swift `String.precomposedStringWithCompatibilityMapping` -> `String.prototype.normalize("NFKC")`.
//   Same algorithm; the Unicode version is the platform's (ICU in both), so a code point added in
//   a newer Unicode than one platform knows could map differently. Such output is non-ASCII and
//   rejected either way unless NFKC maps it to ASCII.
// - Swift `.whitespacesAndNewlines` (Unicode Z* + U+0009..U+000D + U+0085) is spelled out below;
//   JS `trim()` differs (it strips U+FEFF and leaves U+0085), so it is not used.
// - Swift `Unicode.Scalar.Properties.isWhitespace` is the Unicode White_Space property ->
//   /\p{White_Space}/u.
// - Swift `lowercased()` does not apply the Greek final-sigma context rule, JS `toLowerCase()`
//   does. Here lowercasing only feeds an ending check or a letter-class check, which both
//   spellings of sigma pass identically.
// - Swift `hasSuffix` / `dropLast` work on grapheme clusters, JS on code units. They can only
//   disagree when a non-ASCII grapheme touches the ending, and every such label is rejected by
//   the ASCII charset rules that follow, or (splitTypedName) when the code points that lowercase
//   to an ending are all single code units (ASCII, or U+212A KELVIN SIGN -> "k"), which they are.
// - Sorting uses JS code-unit order; Swift compares Unicode scalars. Identical for the ASCII
//   names the services return.

const REQUEST_TIMEOUT_MS = 15000; // iOS: timeoutIntervalForRequest = 15

// --- TLDs ---------------------------------------------------------------------------------

/**
 * @typedef {"kachat"|"kas"|"k"|"kaspa"} NameServiceTLD
 */

/**
 * @typedef {Object} NameServiceInfo
 * @property {NameServiceTLD} tld        Raw value, e.g. "kas".
 * @property {string} suffix             The tab label and display ending, e.g. ".kas".
 * @property {string} serviceName        Who runs it ("KNS", "dotk", "Kaspa Names", "KaChat Names").
 * @property {string|null} websiteURL    Where a person gets one of these names; null for .kachat.
 * @property {string|null} websiteName   The site as people know it ("knsdomains.org"); null for .kachat.
 * @property {string|null} getDomainLabel "Get a .kas domain at knsdomains.org"; null for .kachat.
 * @property {boolean} isLive            Whether the app can read this service yet (.kachat: false).
 */

const SERVICE_TABLE = {
  kachat: { serviceName: "KaChat Names", websiteURL: null, websiteName: null, isLive: false },
  kas: { serviceName: "KNS", websiteURL: "https://app.knsdomains.org", websiteName: "knsdomains.org", isLive: true },
  k: { serviceName: "dotk", websiteURL: "https://dotk.name", websiteName: "dotk.name", isLive: true },
  kaspa: { serviceName: "Kaspa Names", websiteURL: "https://kaspaname.com", websiteName: "kaspaname.com", isLive: true },
};

/** Every TLD in declaration (= tab) order: KaChat's own names first. */
export const NAME_SERVICE_TLDS = Object.freeze(["kachat", "kas", "k", "kaspa"]);

/**
 * Per-TLD metadata, keyed by TLD.
 * @type {Readonly<Record<NameServiceTLD, Readonly<NameServiceInfo>>>}
 */
export const NAME_SERVICES = Object.freeze(Object.fromEntries(NAME_SERVICE_TLDS.map((tld) => {
  const row = SERVICE_TABLE[tld];
  const suffix = `.${tld}`;
  return [tld, Object.freeze({
    tld,
    suffix,
    serviceName: row.serviceName,
    websiteURL: row.websiteURL,
    websiteName: row.websiteName,
    getDomainLabel: row.websiteName ? `Get a ${suffix} domain at ${row.websiteName}` : null,
    isLive: row.isLive,
  })];
})));

/**
 * The order a bare name ("bob") is tried in: KaChat's own .kachat always first, then KNS, dotk
 * and Kaspa Names. The first that resolves is the answer; the rest are "Other domains".
 * @type {ReadonlyArray<NameServiceTLD>}
 */
export const RESOLUTION_ORDER = Object.freeze(["kachat", "kas", "k", "kaspa"]);

/**
 * The tab Your Domains opens on: `.kachat` once it is live, `.kas` until then.
 * @type {NameServiceTLD}
 */
export const DEFAULT_TAB = NAME_SERVICES.kachat.isLive ? "kachat" : "kas";

/**
 * The read API this app calls for a service, shown in Connection Settings > Domains.
 * null for `.kas` (KNS has its own setting) and `.kachat` (not live), and for `.kaspa` off
 * mainnet (Kaspa Names publishes no testnet deployment).
 * @param {NameServiceTLD} tld
 * @param {"mainnet"|"testnet"|string} [network="mainnet"] Anything but "mainnet" counts as testnet-10.
 * @returns {string|null} Base URL without a trailing slash, e.g. "https://api.dotk.name/v1".
 */
export function apiBaseURL(tld, network = "mainnet") {
  const mainnet = network === "mainnet";
  switch (tld) {
    case "k": return mainnet ? "https://api.dotk.name/v1" : "https://api-tn10.dotk.name/v1";
    case "kaspa": return mainnet ? "https://kaspaname.com/v1" : null;
    default: return null;
  }
}

// --- string helpers (Swift semantics) ------------------------------------------------------

// Foundation's CharacterSet.whitespacesAndNewlines.
const SWIFT_WS_NL = /[\p{Z}\u0009-\u000D\u0085]/u;
// Unicode White_Space (Swift `scalar.properties.isWhitespace`, Rust `str::trim`).
const UNICODE_WHITE_SPACE = /\p{White_Space}/u;

// Both sets are BMP-only, so a code-unit scan is a code-point scan here.
function trimWith(s, re) {
  let a = 0;
  let b = s.length;
  while (a < b && re.test(s[a])) a++;
  while (b > a && re.test(s[b - 1])) b--;
  return s.slice(a, b);
}

/** Swift `trimmingCharacters(in: .whitespacesAndNewlines)`. */
function swiftTrim(s) {
  return trimWith(String(s ?? ""), SWIFT_WS_NL);
}

const ASCII_LABEL = /^[a-z0-9-]*$/;

// --- NameNormalization --------------------------------------------------------------------

/**
 * `.k` (dotk, `@dotk/sdk` names.ts `normalize`): trim Unicode White_Space, lowercase A-Z only,
 * drop one trailing ".k". A spelling transform only - run `dotkInvalidReason` on the result.
 * @param {string} input
 * @returns {string}
 */
export function dotkNormalize(input) {
  const trimmed = trimWith(String(input ?? ""), UNICODE_WHITE_SPACE);
  const lowered = trimmed.replace(/[A-Z]/g, (c) => c.toLowerCase());
  return lowered.endsWith(".k") ? lowered.slice(0, -2) : lowered;
}

/**
 * Why a bare `.k` name is not one the covenant accepts, or null when it is: 1...32 bytes of
 * a-z, 0-9 and hyphen with no hyphen at either end. The charset rule runs first, as in the SDK.
 * @param {string} name
 * @returns {string|null}
 */
export function dotkInvalidReason(name) {
  const s = String(name ?? "");
  if (!ASCII_LABEL.test(s)) return "allowed characters: a-z, 0-9 and hyphen";
  const bytes = s.length; // pure ASCII here, so UTF-16 length = UTF-8 byte count
  if (bytes === 0 || bytes > 32) return "name must be 1..=32 bytes on-chain";
  if (s.startsWith("-") || s.endsWith("-")) return "name cannot start or end with a hyphen";
  return null;
}

/**
 * The canonical `.k` name for typed input, or null when it is not one.
 * @param {string} input e.g. " Bob.K "
 * @returns {string|null} e.g. "bob"
 */
export function dotkCanonical(input) {
  const n = dotkNormalize(input);
  return dotkInvalidReason(n) === null ? n : null;
}

/**
 * `.kaspa` (Kaspa Names, `@kronsdk/kaspa-names` normalize.ts): NFKC, printable ASCII only
 * (U+0021...U+007E, so no spaces), lowercase, drop one trailing ".kaspa"; valid when 1...32 of
 * a-z, 0-9 and hyphen with no hyphen at either end. Never trims.
 * @param {string} input e.g. "Shawn.kaspa", "ｋａｓｐａ"
 * @returns {string|null} e.g. "shawn", "kaspa"; null when rejected
 */
export function kaspaNamesCanonical(input) {
  let nfkc;
  try { nfkc = String(input ?? "").normalize("NFKC"); } catch { return null; }
  for (let i = 0; i < nfkc.length; i++) {
    const unit = nfkc.charCodeAt(i);
    if (unit > 0x7e || unit < 0x21) return null;
  }
  let s = nfkc.toLowerCase();
  if (s.endsWith(".kaspa")) s = s.slice(0, -6);
  if (s.length < 1 || s.length > 32) return null;
  if (!ASCII_LABEL.test(s)) return null;
  if (s.startsWith("-") || s.endsWith("-")) return null;
  return s;
}

/**
 * `.kas` (KNS): iOS `KNSService.normalizeDomainLabel`, with Swift's trim. Kept here rather than
 * reusing engine/kns.js `normalizeDomainLabel`, whose JS `trim()` also strips U+FEFF (iOS
 * rejects "﻿bob"; kns.js would look up "bob").
 * @param {string} input e.g. "Bob.kas"
 * @returns {string|null} e.g. "bob"
 */
export function kasCanonical(input) {
  let value = swiftTrim(input).toLowerCase();
  if (!value) return null;
  if (value.endsWith(".kas")) value = value.slice(0, -4);
  if (!value) return null;
  if (value.startsWith("-") || value.endsWith("-")) return null;
  if (!ASCII_LABEL.test(value)) return null;
  return value;
}

// --- typed input --------------------------------------------------------------------------

/**
 * Splits typed input into its label and the ending the person typed, if any. Trims
 * whitespace/newlines; the ending match is case-insensitive; the label keeps its case. Longest
 * endings first, so "bob.kaspa" is not read as "bob.kas" + "pa".
 * @param {string} input e.g. " Bob.KASPA "
 * @returns {{label: string, tld: NameServiceTLD|null}} e.g. { label: "Bob", tld: "kaspa" }
 */
export function splitTypedName(input) {
  const trimmed = swiftTrim(input);
  const lowered = trimmed.toLowerCase();
  for (const tld of ["kachat", "kaspa", "kas", "k"]) {
    const suffix = `.${tld}`;
    if (lowered.endsWith(suffix)) {
      return { label: trimmed.slice(0, trimmed.length - suffix.length), tld };
    }
  }
  return { label: trimmed, tld: null };
}

// Foundation's CharacterSet.alphanumerics (Unicode L*, M*, N*) plus "-" and "_".
const NAME_LIKE = /^[\p{L}\p{M}\p{N}_-]+$/u;

/**
 * Whether typed input could be a name on any service (and is not an address): a bare label,
 * or a label with one of the known endings. Letters/marks/numbers of any script, "-" and "_".
 * @param {string} input
 * @returns {boolean}
 */
export function looksLikeName(input) {
  const trimmed = swiftTrim(input).toLowerCase();
  if (trimmed.startsWith("kaspa:") || trimmed.startsWith("kaspatest:")) return false;
  const { label } = splitTypedName(trimmed);
  return label.length > 0 && NAME_LIKE.test(label);
}

// --- HTTP ---------------------------------------------------------------------------------

function timeoutSignal(ms) {
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    return AbortSignal.timeout(ms);
  }
  return undefined;
}

/**
 * GET JSON. Resolves to { status: "found", body } for 2xx with a JSON body, { status: "missing" }
 * for 404 (body not read), and { status: "failed" } for everything else (network error,
 * timeout, other status, unparsable body).
 */
async function getJSON(url) {
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store", // iOS: reloadIgnoringLocalCacheData
      signal: timeoutSignal(REQUEST_TIMEOUT_MS),
    });
    if (response.status === 404) return { status: "missing" };
    if (response.status < 200 || response.status >= 300) {
      console.warn(`[NameServices] ${hostOf(url)} answered ${response.status}`);
      return { status: "failed" };
    }
    return { status: "found", body: await response.json() };
  } catch (error) {
    console.warn(`[NameServices] ${hostOf(url)} lookup failed: ${error?.message || error}`);
    return { status: "failed" };
  }
}

function hostOf(url) {
  try { return new URL(url).host; } catch { return "?"; }
}

// Foundation's CharacterSet.urlPathAllowed: ASCII alphanumerics and !$&'()*+,-./:=@_~
function encodeURLPath(s) {
  let out = "";
  for (const ch of s) {
    if (/^[A-Za-z0-9!$&'()*+,\-./:=@_~]$/.test(ch)) out += ch;
    else out += encodeURIComponent(ch);
  }
  return out;
}

// Mirrors Swift JSONDecoder: a missing/null optional is fine, a present value of the wrong
// type fails the whole decode.
const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const optionalOf = (v, type) => v === undefined || v === null || typeof v === type;

// --- owned names (read-only) --------------------------------------------------------------

/**
 * @typedef {Object} OwnedServiceName
 * @property {string} name      The bare canonical name, without the ending ("shawn").
 * @property {string} display   The display form ("shawn.kaspa"; for .kaspa the service's own `display` when given).
 * @property {boolean} settling A `.kaspa` name still inside its settling window (~1 h after
 *   registration), when an earlier hidden commit could still outrank it - show it, badged
 *   "Settling" (not final yet). Always false on `.k`.
 */

/**
 * @typedef {Object} OwnedNamesResult
 * @property {"ok"|"unreachable"} state "unreachable": the lookup failed (network, non-2xx, or an
 *   unexpected body) - say "Couldn't reach {serviceName}" rather than "No names yet", and keep
 *   whatever the service last answered.
 * @property {OwnedServiceName[]} names Sorted by name; empty when unreachable.
 */

/**
 * `.k` names an address owns: GET {dotk}/addresses/{address}.
 * @param {string} address A kaspa:/kaspatest: address (trimmed and lowercased here).
 * @param {{network?: string}} [options]
 * @returns {Promise<OwnedNamesResult>}
 */
export async function fetchDotkOwnedNames(address, { network = "mainnet" } = {}) {
  const owner = swiftTrim(address).toLowerCase();
  const base = apiBaseURL("k", network);
  if (!owner || !base) return { state: "unreachable", names: [] };
  const result = await getJSON(`${base}/addresses/${encodeURLPath(owner)}`);
  // An unknown owner is a 404 on some deployments: iOS treats every non-2xx as a failure.
  if (result.status !== "found") return { state: "unreachable", names: [] };
  const body = result.body;
  if (!isPlainObject(body) || !Array.isArray(body.names) || !body.names.every((n) => typeof n === "string")) {
    console.warn("[NameServices] api.dotk.name: unexpected /addresses body");
    return { state: "unreachable", names: [] };
  }
  const names = body.names
    .map((n) => n.toLowerCase())
    .sort(compareCodeUnits)
    .map((name) => ({ name, display: `${name}.k`, settling: false }));
  return { state: "ok", names };
}

/**
 * `.kaspa` names an owner holds: GET {kaspaname}/addresses/{x-only key}/names. Keeps winning
 * lineages only (an entry with `isWinner: false` was outranked - not this owner's name) and
 * flags unsettled ones (`settled: false` or `status: "pending"`).
 *
 * Mainnet only (no testnet deployment): any other network answers ok/empty. A missing or
 * malformed key (not 64 hex - i.e. the address is not P2PK/Schnorr, which cannot own a name
 * through this lookup) also answers ok/empty, as on iOS.
 * @param {string|null|undefined} xOnlyPubKeyHex The 32-byte x-only public key inside the
 *   user's P2PK address, as 64 hex chars. Supplied by the caller; not derived here.
 * @param {{network?: string}} [options]
 * @returns {Promise<OwnedNamesResult>}
 */
export async function fetchKaspaNamesOwnedNames(xOnlyPubKeyHex, { network = "mainnet" } = {}) {
  if (network !== "mainnet") return { state: "ok", names: [] };
  const key = String(xOnlyPubKeyHex ?? "").trim();
  if (!/^[0-9a-fA-F]{64}$/.test(key)) return { state: "ok", names: [] };
  const base = apiBaseURL("kaspa", network);
  if (!base) return { state: "unreachable", names: [] };
  const result = await getJSON(`${base}/addresses/${key.toLowerCase()}/names`);
  if (result.status !== "found") return { state: "unreachable", names: [] };
  const body = result.body;
  const entryOK = (e) => isPlainObject(e)
    && typeof e.name === "string"
    && optionalOf(e.display, "string")
    && optionalOf(e.status, "string")
    && optionalOf(e.settled, "boolean")
    && optionalOf(e.isWinner, "boolean");
  if (!isPlainObject(body) || !Array.isArray(body.names) || !body.names.every(entryOK)) {
    console.warn("[NameServices] kaspaname.com: unexpected /addresses/{key}/names body");
    return { state: "unreachable", names: [] };
  }
  const names = body.names
    .filter((e) => e.isWinner !== false)
    .map((e) => {
      const bare = e.name.toLowerCase();
      return {
        name: bare,
        display: e.display ?? `${bare}.kaspa`,
        settling: e.settled === false || e.status === "pending",
      };
    })
    .sort((a, b) => compareCodeUnits(a.name, b.name));
  return { state: "ok", names };
}

function compareCodeUnits(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Every name an address owns on `.k` and `.kaspa`, asked in parallel (KNS `.kas` names come
 * from engine/kns.js; `.kachat` is not live). Read-only.
 * @param {Object} params
 * @param {string} params.address          The owner's kaspa: address (for `.k`).
 * @param {string|null} [params.xOnlyPubKeyHex] 64-hex x-only key of that address (for `.kaspa`);
 *   null/absent for a non-P2PK address, which then owns no `.kaspa` names via this lookup.
 * @param {string} [params.network="mainnet"]
 * @returns {Promise<{k: OwnedNamesResult, kaspa: OwnedNamesResult} | null>} null when `address`
 *   is empty (iOS does nothing then).
 */
export async function listOwnedNames({ address, xOnlyPubKeyHex = null, network = "mainnet" } = {}) {
  if (!swiftTrim(address)) return null;
  const [k, kaspa] = await Promise.all([
    fetchDotkOwnedNames(address, { network }),
    fetchKaspaNamesOwnedNames(xOnlyPubKeyHex, { network }),
  ]);
  return { k, kaspa };
}

// --- forward resolution (typed name -> address) -------------------------------------------

/**
 * @typedef {Object} NameResolution
 * @property {NameServiceTLD} tld
 * @property {string} name   The canonical name with its ending, e.g. "bob.k" (iOS `display`).
 * @property {string|null} address Where it points; null when not registered there, when the
 *   service has no address to pay for it, or when the lookup failed.
 * @property {"resolved"|"notRegistered"|"failed"|"notLive"} state
 *   resolved      - address is set.
 *   notRegistered - the service answered: no such name (404), or the name has no address.
 *                   iOS shows "Not registered".
 *   failed        - the service could not be asked (network, timeout, non-2xx/404, bad body),
 *                   so "not registered" is unknown. iOS shows "Couldn't check".
 *   notLive       - `.kachat`, which is not live yet. NOT in the iOS list (iOS leaves `.kachat`
 *                   out entirely); filter these out of an "Other domains" list for parity.
 */

/**
 * What typed input points to on every service, in RESOLUTION_ORDER. The label is taken from
 * `splitTypedName(input)` (any typed ending is dropped - every service is asked) and each service
 * canonicalizes it with its own rule; a service whose rule rejects the label is LEFT OUT of the
 * result (as on iOS). `.kas`, `.k` and `.kaspa` are asked in parallel.
 *
 * @param {string} input What the person typed: "bob", "Bob.k", "bob.kaspa" ...
 * @param {Object} deps
 * @param {(name: string) => Promise<string|null>} [deps.resolveKas] The app's KNS lookup. Called
 *   with "label.kas" (canonical, e.g. "bob.kas"); returns the owner address or null. If absent,
 *   `.kas` is left out. A throw counts as "failed" (iOS's KNS lookup cannot fail visibly: it
 *   folds failures into "not registered").
 * @param {string} [deps.network="mainnet"] `.kaspa` is left out off mainnet.
 * @returns {Promise<NameResolution[]>} [] when the label is empty.
 */
export async function resolveEverywhere(input, { resolveKas, network = "mainnet" } = {}) {
  const { label } = splitTypedName(input);
  if (!label) return [];
  const settled = await Promise.all([
    resolveKachatEntry(label),
    typeof resolveKas === "function" ? resolveKasEntry(label, resolveKas) : null,
    resolveDotkEntry(label, network),
    resolveKaspaNamesEntry(label, network),
  ]);
  const byTLD = new Map(settled.filter(Boolean).map((r) => [r.tld, r]));
  return RESOLUTION_ORDER.filter((tld) => byTLD.has(tld)).map((tld) => byTLD.get(tld));
}

/**
 * The answer a typed name gets: the service the person named if they typed an ending (and only
 * if that one resolved), else the first in RESOLUTION_ORDER that resolves.
 * @param {NameResolution[]} results From resolveEverywhere.
 * @param {string} typedInput The same typed input.
 * @returns {NameResolution|null}
 */
export function primary(results, typedInput) {
  const list = Array.isArray(results) ? results : [];
  const explicit = splitTypedName(typedInput).tld;
  if (explicit) return list.find((r) => r.tld === explicit && r.address != null) ?? null;
  return list.find((r) => r.address != null) ?? null;
}

function entry(tld, canonical, address, failed) {
  const state = failed ? "failed" : address != null ? "resolved" : "notRegistered";
  return { tld, name: `${canonical}.${tld}`, address: failed ? null : (address ?? null), state };
}

// `.kachat` is not live: no rule, no lookup. iOS omits it; this reports it as notLive.
async function resolveKachatEntry(label) {
  if (NAME_SERVICES.kachat.isLive) return null; // nothing to ask yet once live - port then
  return { tld: "kachat", name: `${label.toLowerCase()}.kachat`, address: null, state: "notLive" };
}

async function resolveKasEntry(label, resolveKas) {
  const canonical = kasCanonical(label);
  if (canonical === null) return null;
  try {
    const address = await resolveKas(`${canonical}.kas`);
    return entry("kas", canonical, typeof address === "string" ? address : null, false);
  } catch (error) {
    console.warn(`[NameServices] KNS lookup failed: ${error?.message || error}`);
    return entry("kas", canonical, null, true);
  }
}

// GET {dotk}/names/{name} -> { address?: string, ... }; 404 = not registered.
async function resolveDotkEntry(label, network) {
  const canonical = dotkCanonical(label);
  const base = apiBaseURL("k", network);
  if (canonical === null || !base) return null;
  const result = await getJSON(`${base}/names/${canonical}`);
  if (result.status === "missing") return entry("k", canonical, null, false);
  if (result.status === "found" && isPlainObject(result.body) && optionalOf(result.body.address, "string")) {
    return entry("k", canonical, result.body.address ?? null, false);
  }
  return entry("k", canonical, null, true);
}

// GET {kaspaname}/resolve/{name} -> { name, address, covid }: `address` is the name's payout
// (`kas`) record. 404 = unregistered, or no payout record published.
async function resolveKaspaNamesEntry(label, network) {
  const canonical = kaspaNamesCanonical(label);
  const base = apiBaseURL("kaspa", network);
  if (canonical === null || !base) return null;
  const result = await getJSON(`${base}/resolve/${canonical}`);
  if (result.status === "missing") return entry("kaspa", canonical, null, false);
  if (result.status === "found" && isPlainObject(result.body) && optionalOf(result.body.address, "string")) {
    return entry("kaspa", canonical, result.body.address ?? null, false);
  }
  return entry("kaspa", canonical, null, true);
}
