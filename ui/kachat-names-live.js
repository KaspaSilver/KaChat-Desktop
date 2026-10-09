// The live .kachat screens (iOS KachatNamesLiveViews.swift, 5df42b4): the hub's
// search, the claims in progress (their progress sheet and the claims list), Marketplace / Available /
// Activity, the name detail with its
// actions, every transaction sheet, the Your Domains > .kachat tab, the address profile editor and
// the profile hero's .kachat pictures, bio and Linktree link (kachatHeroProfile), looked up from the
// profile's social links on this device (engine/kachat-names/social-image-resolver.js).
// The screens are on for EVERY network (iOS 7227d69, kachatNamesUiEnabled); the registry behind them
// is live only where it is launched (testnet-10, kachatNamesLaunched - the runtime `kachatNames()`
// exists only there). On mainnet the hub pages, Your Domains and each address's .kachat tab render
// empty under "Coming soon", and nothing reads or writes a registry. Address profiles are not
// registry data (iOS d36fc42, `kachatProfiles()`): Edit KaChat Profile saves on every network
// (the primary name shows "Coming soon" on mainnet), and the identity cache and the profile hero
// read profile-only identities there (no label; avatar, banner, bio and Linktree from the record).
// Every spending or destructive action shows its cost first (built against live UTXOs, nothing
// sent) in a Send-style sheet (iOS e426432: glass cards, the Send screens' fee card - Normal / Fast
// / Priority or a custom total, Fast first on a busy network - info pills and slide to confirm; the
// slide is the confirmation, no second prompt, iOS e67074c), then passes the device lock
// (deps.deviceLock) before anything is signed. Every transaction ends on a receipt that follows it
// on the node (actions.follow): Sent to the network / In a block / Updated in KaChat.
//
// The sheets and layers come from kachat-market.js through `initKachatLive(kit)` (no import cycle).
// Nothing runs at import.

import "./kachat-names-live.css";
import { KAS_UNIT, kasLabel, isNetworkAddress, NETWORK } from "../engine/network.js";
import { kachatNames, kachatNamesLaunched, kachatProfiles } from "./kachat-names-runtime.js";
import { profileMissPauseMs } from "../engine/kachat-names/registry.js";
import { userFacingError, chooseDialog } from "./dialogs.js";
import { Operation, Stage, isOpen, needsDriving, validateKey, maxOfferDays, FeeTier, FeeChoice, TxStage } from "../engine/kachat-names/actions.js";
import { paramsExpiresSoonMs } from "../engine/kachat-names/manifest.js";
import {
  Status, Profile, SocialSource, SocialPlatform, SocialKind, addressOf, keyOf, shortAddress as registryShortAddress, compactAddress,
} from "../engine/kachat-names/registry-state.js";
import { KachatSocialImageResolver, socialFreshForMs } from "../engine/kachat-names/social-image-resolver.js";
import { ProfileIdentityStore } from "../engine/kachat-names/profile-cache.js";
import { isProxyAvailable, proxiedUrl } from "../engine/endpoints.js";
import { normalize, p2pkScript, bytesEqual, hex, utf8, unhex32, yearMs, tier } from "../engine/kachat-names/codec.js";
import { isRegistryUpgrading, registryUpgradingMessage } from "../engine/kachat-names/service.js";
import {
  SEND_ICONS, feeControlsHtml, feeControls, sendActionButtonHtml, createSendActionButton, infoPillHtml,
  otherDomainsHtml, pickOtherDomain,
} from "./send-kaspa-components.js";
import { looksLikeName } from "../engine/name-services.js";
import { pickFromAddressBook } from "./address-book.js";
import { sompiFromUserText, sanitizeAmountInput } from "../engine/amounts.js";
import { addressBookEntry } from "./address-book-store.js";
import { scanKaspaAddress } from "./qr-scan.js";

/** { getDeps, esc, ICON, wordmark, openLayer, closeLayer, navBar, sectionHeader, hubChanged(kind), openNameDetail(info) } */
let kit = null;

/** Wires the live screens to the market's layers and icons. Called by initKachatMarket. */
export function initKachatLive(k) {
  kit = k;
  watchRegistrations();
}

const deps = () => kit?.getDeps?.() || {};
const esc = (v) => kit.esc(v);
const errorText = (e) => userFacingError(e);

/** What the device lock prompt says before any .kachat transaction is signed. */
const AUTH_REASON = "Confirm this .kachat transaction";
/** testnet-10 runs at 10 blocks per second */
const DAA_PER_SECOND = 10n;
const SOMPI_PER_KAS = 100_000_000n;
const PRIVACY_SEEN_KEY = "kachat_profile_privacy_seen";

/** Whether the registry is live here (testnet-10 with the runtime built): reads and actions run.
 *  The screens themselves render on every network (kachatNamesUiEnabled). */
export function liveEnabled() { return kachatNames() != null; }

// ---------------------------------------------------------------------------------------------
// Amounts, dates, parties
// ---------------------------------------------------------------------------------------------

/** "35", "0.2", "1.99831": exact, trailing zeros dropped (BigInt sompi). */
export function plainAmount(sompi) {
  let s = BigInt(sompi ?? 0n);
  const negative = s < 0n;
  if (negative) s = -s;
  const whole = s / SOMPI_PER_KAS;
  const frac = s % SOMPI_PER_KAS;
  let out = whole.toString();
  if (frac > 0n) out += `.${frac.toString().padStart(8, "0").replace(/0+$/, "")}`;
  return negative ? `-${out}` : out;
}

/** "35 TKAS". */
export function amountText(sompi) { return `${plainAmount(sompi)} ${KAS_UNIT}`; }

/** "+1.99 TKAS" / "-36.002 TKAS". */
function signedAmount(delta) { return delta >= 0n ? `+${amountText(delta)}` : `-${amountText(-delta)}`; }

/** Cleans a decimal amount field as it's typed, with the shared `sanitizeAmountInput` (digits and
 *  one point, a comma or the Arabic separator as the point, 8 decimals at most); the offer, price
 *  and custom fee fields are then read with the shared `sompiFromUserText` (iOS cee1966, IOS-062). */
function sanitizeAmountField(input) {
  const value = sanitizeAmountInput(input.value);
  if (value !== input.value) input.value = value;
  return value;
}

/** A unix-ms day ("Oct 12, 2027"), with the time when it is within two days (testnet's
 *  24-hour periods, or a renewal that opens tomorrow). */
function dayText(ms) {
  if (ms == null) return "";
  const d = new Date(Number(ms));
  if (Number.isNaN(d.getTime())) return "";
  const near = Math.abs(d.getTime() - Date.now()) < 2 * 86_400_000;
  return near
    ? d.toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
    : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/** A length of time: "10 min", "1 hr 30 min", "10 days" (iOS KachatLive.duration). */
function durationText(ms) {
  const seconds = Math.max(0, Number(ms) / 1000);
  if (seconds >= 86_400) {
    const days = Math.round(seconds / 86_400);
    return days === 1 ? "1 day" : `${days} days`;
  }
  if (seconds >= 3_600) {
    const h = Math.floor(seconds / 3_600);
    const m = Math.round((seconds % 3_600) / 60);
    return m ? `${h} hr ${m} min` : `${h} hr`;
  }
  return `${Math.round(seconds / 60)} min`;
}

/** Time left until a moment, for a live countdown (iOS KachatLive.countdown, cb3c27d): "2d 5h"
 *  while days remain, else "1:04:09" or "4:09" (hours, minutes, seconds); "0:00" once it passed. */
export function countdownText(ms) {
  const total = Math.max(0, Math.floor(Number(ms) / 1000));
  if (!Number.isFinite(total)) return "";
  if (total >= 86_400) {
    const days = Math.floor(total / 86_400);
    const hours = Math.floor((total % 86_400) / 3_600);
    return hours ? `${days}d ${hours}h` : `${days}d`;
  }
  const h = Math.floor(total / 3_600);
  const m = Math.floor((total % 3_600) / 60);
  const sec = total % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

// Live countdowns (iOS TimelineView, every second): each `[data-kl-countdown]` shows the time left
// until its unix-ms moment. One timer while any is on screen; it stops when none is visible and
// starts again with the next one rendered. One with `data-kl-countdown-reload` reloads the hub
// when it reaches zero - once - so a released name moves from Expired to Available (iOS cb3c27d).
let countdownTimer = null;
const countdownReloaded = new Set();

/** A live countdown to `atMs` (unix ms); `reloadKey`: reload the hub once when it reaches zero. */
function countdownHtml(atMs, { reloadKey = null } = {}) {
  ensureCountdownTicker();
  const at = Number(atMs);
  return `<span class="kl-countdown" data-kl-countdown="${esc(String(at))}"${reloadKey ? ` data-kl-countdown-reload="${esc(reloadKey)}"` : ""}>${esc(countdownText(at - Date.now()))}</span>`;
}

function ensureCountdownTicker() {
  if (countdownTimer != null || typeof setInterval !== "function") return;
  countdownTimer = setInterval(tickCountdowns, 1_000);
}

function tickCountdowns() {
  const all = typeof document === "undefined" ? [] : [...document.querySelectorAll("[data-kl-countdown]")];
  // a hidden screen (another tab) keeps its markup: only what is on screen counts
  const shown = all.filter((el) => el.getClientRects().length > 0);
  if (!shown.length) {
    clearInterval(countdownTimer);
    countdownTimer = null;
    return;
  }
  const now = Date.now();
  let released = false;
  for (const el of shown) {
    const left = Number(el.dataset.klCountdown) - now;
    const text = countdownText(left);
    if (el.textContent !== text) el.textContent = text;
    const key = el.dataset.klCountdownReload;
    if (key && left <= 0 && !countdownReloaded.has(key)) {
      countdownReloaded.add(key);
      released = true;
    }
  }
  if (released && liveHubIsLive()) hubReload();
}

function relativeText(ms) {
  if (ms == null) return "";
  const t = Number(ms);
  if (!Number.isFinite(t)) return "";
  const diff = (t - Date.now()) / 1000;
  const abs = Math.abs(diff);
  let rtf;
  try { rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }); } catch { return dayText(ms); }
  const units = [["year", 31_536_000], ["month", 2_592_000], ["week", 604_800], ["day", 86_400], ["hour", 3_600], ["minute", 60], ["second", 1]];
  for (const [unit, seconds] of units) {
    if (abs >= seconds || unit === "second") return rtf.format(Math.round(diff / seconds), unit);
  }
  return "";
}

/** `y` periods: "1 year" / "2 years", or on a short clock (testnet) "10 min" / "20 min". */
const yearsLabel = (y) => periodsText(y);

function shortAddr(address) {
  const fn = deps().shortAddress;
  return typeof fn === "function" ? fn(address) : registryShortAddress(address);
}

/** An event party: an address (indexer) or an x-only key in hex (walker), as a short address. */
function partyText(s) {
  if (!s) return null;
  const v = String(s);
  if (v.startsWith("kaspa")) return shortAddr(v);
  if (/^[0-9a-fA-F]{64}$/.test(v)) {
    try {
      const a = addressOf(unhex32(v.toLowerCase()));
      if (a) return shortAddr(a);
    } catch { /* not a key */ }
  }
  return v;
}

function graceMs() { return kachatNames()?.registry.graceMs ?? 864_000_000n; }
function params() {
  const rt = kachatNames();
  return rt?.service.manifest?.params ?? rt?.registry.manifest?.params ?? null;
}
function maxYears() { const m = params()?.maxYears; return m ? Number(m) : 2; }

// Registry v4: a period is `periodMs` long - a year on mainnet, 24 hours on the testnet clock.
/** Whether a period is a year (mainnet), not a short test clock. */
function yearlyPeriods() { return (params()?.periodMs ?? yearMs) === yearMs; }
/** `count` periods: "1 year" / "2 years", or on a short clock "10 min" / "20 min". */
function periodsText(count) {
  const n = Number(count);
  if (yearlyPeriods()) return n === 1 ? "1 year" : `${n} years`;
  return durationText(n * Number(params()?.periodMs ?? yearMs));
}
/** "Price per year", or on a short clock "Price per 10 min". */
function pricePerPeriodTitle() { return yearlyPeriods() ? "Price per year" : `Price per ${periodsText(1)}`; }
/** What registering `name` costs for its first period (sompi, BigInt; registry v4: fixed, baked
 *  into the pinned templates - the manifest's register table); null before any manifest. Each
 *  further period costs `renewPriceOf` (iOS c8f1086 KachatLive.price). */
function priceOf(name) {
  const prices = params()?.registerPrices;
  if (!Array.isArray(prices) || prices.length !== 5) return null;
  return prices[tier(utf8(name).length)];
}
/** What one more period of `name` costs: extend, renew, and registering past the first period
 *  (the manifest's renew table; iOS c8f1086 KachatLive.renewPrice). */
function renewPriceOf(name) {
  const prices = params()?.renewPrices;
  if (!Array.isArray(prices) || prices.length !== 5) return null;
  return prices[tier(utf8(name).length)];
}

// A name's paid period runs from periodStart to expiresAt and holds at most maxYears periods.
/** The years an extend can still add to `info`'s paid period (0n when full or unknown). */
function extendableYears(info, p = params()) {
  if (!p || info?.periodStart == null) return 0n;
  try { return info.extendableYears(p); } catch { return 0n; }
}
/** Whether `info`'s renewal window is open (renewWindowMs before the expiry, through grace and lapse). */
function renewalOpen(info, p = params()) {
  if (!p) return false;
  try { return info.renewOpen(p); } catch { return false; }
}
/** Whether extending `info` by `years` fills its period to exactly maxYears (iOS KachatExtendSheet.fillsPeriod). */
function fillsPeriod(info, years, p = params()) {
  if (!p || info?.periodStart == null) return false;
  return info.expiresAt + BigInt(years) * p.periodMs === info.periodStart + p.maxYears * p.periodMs;
}
/** "Renewal opens on Oct 2, 2027" (the day ActionError.renewalNotOpen names). */
function renewalOpensText(info, p = params()) {
  return p ? `Renewal opens on ${dayText(info.renewOpens(p))}` : "";
}

function myKey() { try { return kachatNames()?.actions.myKey ?? null; } catch { return null; } }
function isMine(key) { const me = myKey(); return !!(me && key && bytesEqual(me, key)); }
function isChainSource() { return kachatNames()?.registry.source?.kind === "chain"; }

/** Why a typed name is not a name (null when it is one). */
function invalidReason(name) {
  const b = utf8(name);
  if (b.length === 0 || b.length > 32) return "A name is 1 to 32 characters.";
  for (const c of b) {
    if (!((c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39) || c === 0x2d)) return "Use a-z, 0-9 and hyphens only.";
  }
  if (b[0] === 0x2d || b[b.length - 1] === 0x2d) return "A name can't start or end with a hyphen.";
  return null;
}

async function deviceLock() {
  const fn = deps().deviceLock;
  if (typeof fn !== "function") return true;
  try { return Boolean(await fn(AUTH_REASON)); } catch { return false; }
}

async function confirmAsk(options) {
  const fn = deps().confirmDialog;
  if (typeof fn !== "function") return true;
  return Boolean(await fn(options));
}

function identityChanged() {
  try { deps().onIdentityChanged?.(); } catch { /* not ready */ }
}

function readPrivacySeen() { try { return localStorage.getItem(PRIVACY_SEEN_KEY) === "1"; } catch { return false; } }
function writePrivacySeen() { try { localStorage.setItem(PRIVACY_SEEN_KEY, "1"); } catch { /* blocked */ } }

// ---------------------------------------------------------------------------------------------
// Icons (SF Symbol look-alikes, stroked in currentColor)
// ---------------------------------------------------------------------------------------------

const svg = (body, cls = "kmkt-ico") => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;
const LI = {
  refresh: svg(`<path d="M19.4 12.6A7.5 7.5 0 1 1 17 6.6"/><path d="M19.6 3.8v4.6H15"/>`),
  tagSlash: svg(`<path d="M3.5 12.2V4.6a1.1 1.1 0 0 1 1.1-1.1h7.6a1.1 1.1 0 0 1 .8.3l7.7 7.7a1.1 1.1 0 0 1 0 1.6l-7.6 7.6a1.1 1.1 0 0 1-1.6 0l-7.7-7.7a1.1 1.1 0 0 1-.3-.8Z"/><path d="M3 3l18 18"/>`),
  trash: svg(`<path d="M4.5 6.5h15M9.5 6.5V4.8a1.3 1.3 0 0 1 1.3-1.3h2.4a1.3 1.3 0 0 1 1.3 1.3v1.7M6.5 6.5l.9 12.6a1.6 1.6 0 0 0 1.6 1.4h6a1.6 1.6 0 0 0 1.6-1.4l.9-12.6"/>`),
  reclaim: svg(`<path d="M4.5 12a7.5 7.5 0 0 1 13-5.1M19.5 12a7.5 7.5 0 0 1-13 5.1"/><path d="M17.8 3.4v3.7h-3.7M6.2 20.6v-3.7h3.7"/>`),
  personCheck: svg(`<circle cx="10" cy="8" r="3.6"/><path d="M3.5 19.8a6.8 6.8 0 0 1 11.2-4.9"/><path d="m15.4 17.6 2.1 2.1 3.9-4.2"/>`),
  warning: svg(`<path d="M12 3.8 2.8 19.6h18.4Z"/><path d="M12 9.8v4.6M12 17.2h.01"/>`),
  exclamation: svg(`<circle cx="12" cy="12" r="9.2"/><path d="M12 7.4v5.6M12 16.4h.01"/>`),
  checkCircle: svg(`<circle cx="12" cy="12" r="9.2"/><path d="m8 12.3 2.7 2.7 5.3-5.6"/>`),
  uturn: svg(`<path d="M9 14.5 4 9.5l5-5"/><path d="M4 9.5h10a6 6 0 0 1 0 12h-3"/>`),
  external: svg(`<path d="M13.5 4.5h6v6M19.5 4.5l-8.5 8.5"/><path d="M17.5 13.5v4.6a1.4 1.4 0 0 1-1.4 1.4H5.9a1.4 1.4 0 0 1-1.4-1.4V7.9a1.4 1.4 0 0 1 1.4-1.4h4.6"/>`),
  card: svg(`<rect x="3" y="5" width="18" height="14" rx="2.4"/><circle cx="9" cy="11" r="2.3"/><path d="M5.8 16.4a3.6 3.6 0 0 1 6.4 0M14.5 10h4M14.5 13.5h3"/>`),
  person: svg(`<circle cx="12" cy="8.6" r="3.9"/><path d="M4.6 20.2a7.6 7.6 0 0 1 14.8 0"/>`),
  personExclaim: svg(`<circle cx="10" cy="8.4" r="3.7"/><path d="M3.4 19.8a6.8 6.8 0 0 1 10.4-5.4"/><path d="M18.6 13v3.6M18.6 19.6h.01"/>`),
  calendar: svg(`<rect x="3.5" y="5" width="17" height="15.5" rx="2.4"/><path d="M3.5 10h17M8 3v4M16 3v4"/>`),
  calendarPlus: svg(`<path d="M20.5 11.5V7.4A2.4 2.4 0 0 0 18.1 5H5.9a2.4 2.4 0 0 0-2.4 2.4v10.7a2.4 2.4 0 0 0 2.4 2.4h6.6"/><path d="M3.5 10h17M8 3v4M16 3v4M18 14.5v6M15 17.5h6"/>`),
  calendarClock: svg(`<path d="M20.5 11V7.4A2.4 2.4 0 0 0 18.1 5H5.9a2.4 2.4 0 0 0-2.4 2.4v10.7a2.4 2.4 0 0 0 2.4 2.4h5.6"/><path d="M3.5 10h17M8 3v4M16 3v4"/><circle cx="17.5" cy="17.5" r="4"/><path d="M17.5 15.6v2l1.3 1.2"/>`),
  hammer: svg(`<path d="m13.8 7.6-9.6 9.6a1.7 1.7 0 0 0 2.4 2.4l9.6-9.6"/><path d="M11.6 5.4 14 3l1.4.6 2.2-.4 3.4 3.4-2.4 2.4-1.4-1.4-2.4 2.4-3.2-3.2Z"/>`),
  sliders: svg(`<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2.2"/><circle cx="9" cy="17" r="2.2"/>`),
  copy: svg(`<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5V6.4a1.9 1.9 0 0 0-1.9-1.9H6.4a1.9 1.9 0 0 0-1.9 1.9v7.2a1.9 1.9 0 0 0 1.9 1.9h2.1"/>`),
  check: svg(`<path d="m5 12.5 4.3 4.3L19 7.2"/>`),
  hourglass: svg(`<path d="M6.5 3.5h11M6.5 20.5h11"/><path d="M7.5 3.5c0 4.2 4.5 5.6 4.5 8.5s-4.5 4.3-4.5 8.5M16.5 3.5c0 4.2-4.5 5.6-4.5 8.5s4.5 4.3 4.5 8.5"/>`),
  circle: svg(`<circle cx="12" cy="12" r="9.2"/>`),
  xCircle: svg(`<circle cx="12" cy="12" r="9.2"/><path d="m9 9 6 6M15 9l-6 6"/>`),
  wifiExclaim: svg(`<path d="M2.8 9.2a13.3 13.3 0 0 1 14.6-2.6M5.9 12.6a8.8 8.8 0 0 1 8.4-2.1M9.1 15.9a4.3 4.3 0 0 1 3.4-1"/><path d="M12 19.4h.01"/><path d="M19.4 10.4v4.8M19.4 18.6h.01"/>`),
  clock: svg(`<circle cx="12" cy="12" r="9.2"/><path d="M12 7v5.2l3.4 2"/>`),
  arrowDownDoc: svg(`<path d="M14 3.5H7.4A1.9 1.9 0 0 0 5.5 5.4v13.2a1.9 1.9 0 0 0 1.9 1.9h9.2a1.9 1.9 0 0 0 1.9-1.9V8Z"/><path d="M14 3.5V8h4.5"/><path d="M12 10.5v6.5M9.2 14.2 12 17l2.8-2.8"/>`),
};

const spinner = (cls = "") => `<span class="kl-spinner ${cls}" role="status" aria-label="Loading"></span>`;

function eventIcon(op) {
  const I = kit.ICON;
  switch (op) {
    case "register": return I.atPlus;
    case "transfer": return I.swap;
    case "list": return I.tag;
    case "delist": return LI.tagSlash;
    case "sale": case "offer_accepted": return I.cart;
    case "extend": return LI.calendarPlus;
    case "renew": return LI.refresh;
    case "release": return LI.uturn;
    case "reclaim": return LI.reclaim;
    case "import": return LI.arrowDownDoc;
    default: return I.hand;
  }
}

function eventTitle(op) {
  switch (op) {
    case "register": return "Registered";
    case "transfer": return "Transferred";
    case "list": return "Listed";
    case "delist": return "Delisted";
    case "sale": return "Sold";
    case "offer_accepted": case "offer_accept": return "Offer accepted";
    case "extend": return "Extended";
    case "renew": return "Renewed";
    case "release": return "Released";
    case "reclaim": return "Reclaimed";
    // registry v5: a name brought over from the old registry's snapshot (iOS dd836cb)
    case "import": return "Moved to the new registry";
    case "offer": return "Offer made";
    case "offer_withdraw": return "Offer withdrawn";
    case "offer_refund": return "Offer refunded";
    case "offer_decline": return "Offer declined";
    default: return "Activity";
  }
}

// ---------------------------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------------------------

/** Names and offers rendered in a list, so a click can find the record behind a row. */
const nameIndex = new Map();
const offerIndex = new Map();
const rememberName = (info) => { nameIndex.set(info.name, info); return info; };
const rememberOffer = (offer) => { offerIndex.set(offer.id, offer); return offer; };

function statusPill(status) {
  // past grace a name is free to claim (iOS eea52b2)
  const label = status === Status.active ? "Active" : status === Status.grace ? "Expired" : "Available";
  return `<span class="kl-status kl-status-${esc(status)}">${esc(label)}</span>`;
}

function testnetBadge() { return `<span class="kl-testnet-badge">Testnet</span>`; }

// (the marketplace's name rows became tiles - kachatNameTileHtml, iOS 27a4f39)

/** KachatEventRow. */
function eventRowHtml(event, { showName = false } = {}) {
  const to = event.op !== "offer" ? partyText(event.to) : null;
  const at = event.at != null ? relativeText(event.at) : "";
  const sub = [to ? `→ ${to}` : "", at].filter(Boolean).join(" ");
  const right = event.price != null
    ? `<span class="kl-row-value">${esc(amountText(event.price))}</span>`
    : event.years != null ? `<span class="kl-row-value kmkt-muted">+${esc(String(event.years))}</span>` : "";
  return `
    <div class="kmkt-row static compact kl-event-row">
      <span class="kmkt-row-icon w28">${eventIcon(event.op)}</span>
      <span class="kl-row-text">
        <strong>${esc(eventTitle(event.op))}${showName && event.name ? ` ${esc(`${event.name}.kachat`)}` : ""}</strong>
        ${sub ? `<small>${esc(sub)}</small>` : ""}
      </span>
      ${right}
    </div>`;
}

/** "2d 4h": the time until an offer becomes refundable (its refundAfter DAA score, 10 per second;
 *  at least a minute), or null once it is (iOS KachatOfferState.timeLeft). */
function offerTimeLeft(offer, daa) {
  if (daa == null || offer.refundable(daa)) return null;
  const left = offer.refundAfter > 0n ? offer.refundAfter : 0n;
  const seconds = Math.max(60, Number(left - BigInt(daa)) / Number(DAA_PER_SECOND));
  let text;
  if (seconds >= 86_400) text = `${Math.floor(seconds / 86_400)}d ${Math.floor((seconds % 86_400) / 3_600)}h`;
  else if (seconds >= 3_600) text = `${Math.floor(seconds / 3_600)}h ${Math.floor((seconds % 3_600) / 60)}m`;
  else text = `${Math.floor(seconds / 60)}m`;
  return text.replace(/ 0[hm]$/, "");
}

// (the offer rows became square tiles with a half sheet - offerTileHtml / openOfferDetailSheet, iOS 7f50e84)

/** KachatLiveEmpty: a text, or a spinner while loading (text null). */
function emptyCard(text) {
  return `<div class="kmkt-card kmkt-empty-card">${text ? esc(text) : spinner()}</div>`;
}

const chainNote = () => (isChainSource()
  ? `<p class="kl-note">Offers from others appear once a names indexer is connected.</p>` : "");

function segmentedHtml(group, options, value, label) {
  return `
    <div class="settings-segmented full kmkt-segmented" role="radiogroup" aria-label="${esc(label)}" data-kl-seg-group="${esc(group)}">
      ${options.map((o) => `
        <button class="settings-segmented-option ${String(o.id) === String(value) ? "active" : ""}" type="button" role="radio"
          aria-checked="${String(o.id) === String(value)}" data-kl-seg="${esc(String(o.id))}">${esc(o.title)}</button>`).join("")}
    </div>`;
}

function yearsOptions() {
  return Array.from({ length: Math.max(1, maxYears()) }, (_, i) => ({ id: i + 1, title: yearsLabel(i + 1) }));
}

/** Sets a segmented group's value from a click; returns the chosen id or null. */
function segmentedClick(event, root) {
  const option = event.target.closest("[data-kl-seg]");
  if (!option) return null;
  const group = option.closest("[data-kl-seg-group]");
  if (!group || !root.contains(group)) return null;
  const id = option.dataset.klSeg;
  group.querySelectorAll("[data-kl-seg]").forEach((b) => {
    const on = b.dataset.klSeg === id;
    b.classList.toggle("active", on);
    b.setAttribute("aria-checked", String(on));
  });
  return { group: group.dataset.klSegGroup, id };
}

function formRow(title, value, { bold = false, valueHtml = null } = {}) {
  return `
    <div class="kmkt-form-row kl-form-row ${bold ? "bold" : ""}">
      <span>${esc(title)}</span>
      ${valueHtml ?? `<span class="kl-form-value">${esc(value)}</span>`}
    </div>`;
}

function section(rowsHtml, { header = "", footerHtml = "" } = {}) {
  return `
    <section class="kmkt-form-section">
      ${header ? `<h4 class="kmkt-form-header">${esc(header)}</h4>` : ""}
      ${rowsHtml ? `<div class="kmkt-form-card">${rowsHtml}</div>` : ""}
      ${footerHtml}
    </section>`;
}

const footer = (text, cls = "") => (text ? `<p class="kmkt-form-footer ${cls}">${esc(text)}</p>` : "");

function navHtml(title, { leading = null, trailing = null } = {}) {
  return `<div class="kl-nav" data-kl-nav>${kit.navBar(title, { leading, trailing })}</div>`;
}

/** What the transaction does to the wallet: its outputs to the wallet minus its inputs from it. */
function balanceChange(plan, me) {
  const mine = p2pkScript(me);
  let received = 0n;
  for (const o of plan.unsignedTx?.outputs ?? []) if (o.script && bytesEqual(o.script, mine)) received += BigInt(o.value);
  let spent = 0n;
  for (const e of plan.entries ?? []) if (e.script && bytesEqual(e.script, mine)) spent += BigInt(e.amount);
  return received - spent;
}

// ---------------------------------------------------------------------------------------------
// Hub model (KachatHubModel)
// ---------------------------------------------------------------------------------------------

const hub = {
  /** null until the manifest is checked; false when it fails (the hub then stays a mockup) */
  ready: null,
  setupError: null,
  /** The manifest is a registry version this app doesn't build for (not v4 or v5): the hub says "Setting up", calmly. */
  upgrading: false,
  search: { kind: "idle" },
  listings: [],
  /** names expired past grace: back on the market, Available to anyone (iOS eea52b2) */
  lapsed: [],
  /** expired and still in grace: the Expired tab, each counting down to its release (iOS cb3c27d) */
  grace: [],
  mine: [],
  myOffers: [],
  activity: [],
  loadError: null,
  loaded: false,
  refreshing: false,
};
let hubVisible = false;
let hubUnsubscribe = null;
let hubServiceUnsubscribe = null;
let hubStarting = null;
let hubReloading = null;
let hubReloadAgain = false;
let lookupTimer = null;
let lookupSeq = 0;
/** Per registration: { working, error } (KachatRegistrationCard's own state). */
const registrationUi = new Map();

/** The hub is live: testnet with the manifest verified. */
export function liveHubIsLive() { return liveEnabled() && hub.ready === true; }

/** The pages have loaded - always so where the registry isn't launched (mainnet: the same pages,
 *  empty, under "Coming soon"; iOS 7227d69). */
function hubLoaded() { return hub.loaded || !kachatNames(); }

function hubChanged(kind) {
  if (hubVisible) {
    try { kit?.hubChanged?.(kind); } catch { /* screen gone */ }
  }
}

/** The .kachat screen came on: check the manifest and source, resume the registrations, load. */
export function liveHubShow() {
  hubVisible = true;
  const rt = kachatNames();
  if (!rt) return;
  watchRegistrations();
  if (!hubUnsubscribe) {
    hubUnsubscribe = rt.registry.onChange(() => { if (liveHubIsLive()) hubReload(); });
  }
  if (!hubServiceUnsubscribe) {
    // The registry upgrade starts or ends (service.registryUpgrading): "Setting up", or start again.
    hubServiceUnsubscribe = rt.service.onChange((service) => {
      if (hub.ready === true) return;
      hub.upgrading = Boolean(service.registryUpgrading);
      if (!hub.upgrading && hub.ready === false) hubStart();
      else hubChanged("ready");
    });
  }
  hubStart();
}

/** The .kachat screen went off. Registrations keep driving; the hub stops reloading. */
export function liveHubHide() {
  hubVisible = false;
  hubUnsubscribe?.();
  hubUnsubscribe = null;
  hubServiceUnsubscribe?.();
  hubServiceUnsubscribe = null;
}

function hubStart() {
  if (hubStarting) return hubStarting;
  hubStarting = (async () => {
    const rt = kachatNames();
    if (!rt) { hub.ready = null; return; }
    const before = hub.ready;
    try {
      await rt.registry.prepare({ forceSourceCheck: true });
      hub.ready = true;
      hub.setupError = null;
      hub.upgrading = false;
    } catch (error) {
      hub.ready = false;
      hub.upgrading = isRegistryUpgrading(error) || Boolean(rt.service.registryUpgrading);
      hub.setupError = errorText(error);
      hubChanged("ready");
      return;
    }
    if (before !== true) hubChanged("ready");
    try { rt.actions.resume(); } catch { /* no wallet yet */ }
    await rt.registry.refresh();
    await hubReload();
  })().finally(() => { hubStarting = null; });
  return hubStarting;
}

/** The refresh control (iOS pull to refresh). */
export async function liveHubRefresh() {
  const rt = kachatNames();
  if (!rt || !liveHubIsLive() || hub.refreshing) return;
  hub.refreshing = true;
  hubChanged("refresh");
  try {
    await rt.registry.refresh();
    await hubReload();
  } finally {
    hub.refreshing = false;
    hubChanged("refresh");
  }
}

function hubReload() {
  if (hubReloading) { hubReloadAgain = true; return hubReloading; }
  hubReloading = (async () => {
    do {
      hubReloadAgain = false;
      await hubReloadOnce();
    } while (hubReloadAgain);
  })().finally(() => { hubReloading = null; });
  return hubReloading;
}

async function hubReloadOnce() {
  const rt = kachatNames();
  if (!rt || !liveHubIsLive()) return;
  const { registry, actions } = rt;
  try {
    hub.listings = await registry.listings();
    hub.lapsed = await registry.lapsed();
    hub.grace = await registry.inGrace().catch(() => []);
    const me = myKey();
    if (me) {
      hub.mine = await registry.namesOf(me, { includeInactive: true });
      hub.myOffers = await registry.myOffers(me);
      if (hub.myOffers.length) {
        await actions.refreshVirtualDaa().catch(() => null);
        // Your own expired offers come back to you on their own, and so do the ones whose name
        // changed hands since you made them.
        await actions.returnExpiredOffers(hub.myOffers).catch(() => null);
        await actions.withdrawDeclinedOffers(hub.myOffers).catch(() => null);
      }
    } else {
      hub.mine = [];
      hub.myOffers = [];
    }
    hub.activity = await registry.activity();
    hub.loadError = null;
  } catch (error) {
    hub.loadError = errorText(error);
  }
  hub.loaded = true;
  hubChanged("data");
}

/** The search field changed (the lookup waits for typing to pause). */
export function liveSearchInput(text) {
  const typed = String(text ?? "").trim().toLowerCase();
  clearTimeout(lookupTimer);
  lookupSeq += 1;
  if (!typed) { hub.search = { kind: "idle" }; return; }
  lookupTimer = setTimeout(() => { hubLookup(typed); }, 350);
}

async function hubLookup(text) {
  const rt = kachatNames();
  if (!rt) return;
  const typed = normalize(text);
  const seq = ++lookupSeq;
  if (!typed) { hub.search = { kind: "idle" }; hubChanged("search"); return; }
  if (invalidReason(typed)) { hub.search = { kind: "invalid", name: typed }; hubChanged("search"); return; }
  hub.search = { kind: "checking", name: typed };
  hubChanged("search");
  try {
    // an expired name (past grace) searches as free to claim (iOS eea52b2 claimLookup)
    const r = await rt.registry.claimLookup(typed);
    if (seq !== lookupSeq) return;
    hub.search = r.kind === "registered"
      ? { kind: "registered", name: r.info.name, info: rememberName(r.info) }
      : { kind: "free", name: r.name, gap: r.gap ?? null };
  } catch (error) {
    if (seq !== lookupSeq) return;
    hub.search = { kind: "failed", name: typed, message: errorText(error) };
  }
  hubChanged("search");
}

function pricePerYear(name) { return priceOf(name); }

// ---------------------------------------------------------------------------------------------
// Hub: hero, header, search result
// ---------------------------------------------------------------------------------------------

/** "Setting up" (iOS KachatMarketView.settingUpPill). */
function settingUpPill() { return `<span class="kl-setting-up-pill">${LI.hammer}<span>Setting up</span></span>`; }

/** The hero's status line: the Testnet badge when live; "Setting up" while the registry is being
 *  upgraded (an earlier registry's manifest, iOS d2e0673 / e1e3455); else Coming soon (and why it
 *  isn't live). */
export function liveHeroStatusHtml(comingSoonHtml) {
  if (liveHubIsLive()) return testnetBadge();
  if (liveEnabled() && hub.upgrading) {
    return `
      <span class="kl-hero-badges">${testnetBadge()}${settingUpPill()}</span>
      <p class="kl-setup-error">${esc(registryUpgradingMessage)}</p>`;
  }
  const error = liveEnabled() && hub.ready === false && hub.setupError
    ? `<p class="kl-setup-error">${esc(hub.setupError)}</p>` : "";
  return comingSoonHtml + error;
}

/** The refresh control next to How it works (live only). */
export function liveRefreshButtonHtml() {
  if (!liveHubIsLive()) return "";
  return `<button class="kaposts-icon-button kl-refresh ${hub.refreshing ? "spinning" : ""}" type="button" data-kmkt-refresh
    aria-label="Refresh" title="Refresh" ${hub.refreshing ? "disabled" : ""}>${LI.refresh}</button>`;
}

/** KachatLiveSearchResult. */
export function liveSearchResultHtml(raw) {
  const typed = String(raw ?? "").trim().toLowerCase();
  if (!typed) return "";
  const name = normalize(typed);
  const s = hub.search;
  const row = (subtitle) => `
    <div class="kmkt-search-result">
      <div class="kmkt-search-result-copy">
        <strong>${esc(`${name}.kachat`)}</strong>
        <small>${esc(subtitle)}</small>
      </div>
    </div>`;
  if (s.kind === "registered" && s.info.name === name) {
    const n = s.info;
    let line;
    let cls = "";
    switch (n.status(graceMs())) {
      case Status.active:
        if (isMine(n.owner)) line = "Yours";
        else if (n.isListed) line = `Taken · for sale at ${amountText(n.price)}`;
        else line = "Taken";
        break;
      case Status.grace: line = "Expired - the owner can still renew it"; cls = "kl-orange"; break;
      // never reached: a lapsed name searches as free to claim (claimLookup)
      default: line = ""; break;
    }
    return `
      <button class="kmkt-search-result kl-search-link" type="button" data-kl-open-name="${esc(n.name)}">
        <div class="kmkt-search-result-copy">
          <strong>${esc(n.display)}</strong>
          ${line ? `<small class="${cls}">${esc(line)}</small>` : ""}
        </div>
        <span class="kmkt-row-chevron">${kit.ICON.chevron}</span>
      </button>`;
  }
  if (s.kind === "free" && s.name === name) {
    const price = pricePerYear(name);
    return `
      <div class="kmkt-search-result">
        <div class="kmkt-search-result-copy">
          <strong>${esc(`${name}.kachat`)}</strong>
          ${price != null ? `<small class="kl-green">${esc(yearlyPeriods() ? `Available · ${amountText(price)} a year` : `Available · ${amountText(price)} per ${periodsText(1)}`)}</small>` : ""}
        </div>
        <button class="primary-button kmkt-small-button" type="button" data-kl-claim="${esc(name)}" ${s.gap ? "" : "disabled"}>Claim</button>
      </div>`;
  }
  if (s.kind === "invalid" && s.name === name) return row(invalidReason(name) ?? "Not a valid name.");
  if (s.kind === "failed" && s.name === name) return row(s.message);
  return `
    <div class="kmkt-search-result">
      <div class="kmkt-search-result-copy"><strong>${esc(`${name}.kachat`)}</strong></div>
      ${spinner()}
    </div>`;
}

// ---------------------------------------------------------------------------------------------
// Hub: registrations in flight (KachatRegistrationCard)
// ---------------------------------------------------------------------------------------------

let registrationsUnsubscribe = null;
const registrationStages = new Map();

/** One subscription for the app's lifetime: the claim progress sheet, the claims list and the
 *  claims button follow it, and a registration that completes tells the app its identity may have
 *  changed (the profile hero). */
function watchRegistrations() {
  const rt = kachatNames();
  if (!rt || registrationsUnsubscribe) return;
  // My Offers follows what this app is sending back (expired, or made to an earlier owner)
  const offersSig = () => `${rt.actions.returningOffers?.size ?? 0}|${rt.actions.withdrawingOffers?.size ?? 0}`;
  let lastOffersSig = offersSig();
  // the registrations as last drawn: a follower's stage or a new fee estimate (iOS e426432) also
  // reach subscribers, and need no repaint here
  let lastDrawn = null;
  registrationsUnsubscribe = rt.actions.subscribe(({ pending, virtualDaa, autoPresentedRegistration }) => {
    const sig = offersSig();
    if (sig !== lastOffersSig) { lastOffersSig = sig; if (hub.myOffers.length) hubChanged("data"); }
    const drawn = JSON.stringify([pending, String(virtualDaa), autoPresentedRegistration ?? null]);
    if (drawn === lastDrawn) return;
    lastDrawn = drawn;
    let completed = false;
    for (const p of pending) {
      const before = registrationStages.get(p.id);
      if (before && before !== Stage.registered && p.stage === Stage.registered) {
        completed = true;
        // Pops up the moment the registration lands (iOS 0870fcc) - already known to be in a
        // block, so nothing to follow (iOS e426432 `accepted`).
        if (p.registerTxId) openTxDoneSheet({ txId: p.registerTxId, title: "Name registered", accepted: true });
      }
      registrationStages.set(p.id, p.stage);
    }
    if (completed) identityChanged();
    renderRegistrationProgress();
    renderClaimsList();
    // the claims button's count (iOS b219bb0 KachatClaimsButton)
    hubChanged("pending");
  });
  for (const p of rt.actions.pending) registrationStages.set(p.id, p.stage);
  // a claim still in progress when the app starts brings its progress sheet up once (resume()
  // sets actions.autoPresentedRegistration, iOS b219bb0)
  renderRegistrationProgress();
}

function registrationStageText(p) {
  switch (p.stage) {
    case Stage.committing: return "Sending the hidden commit...";
    case Stage.waiting:
      return p.commitDaa == null
        ? "Waiting for the commit to confirm..."
        : "The commit has to age for about a minute before the name can be registered. Keep KaChat open - it registers by itself, and picks up where it left off if you leave.";
    case Stage.registering: return "Registering...";
    case Stage.registered: return "Registered. It's yours.";
    case Stage.taken: return kasLabel("Someone registered this name first. Cancel the commit to get its 0.2 KAS back.");
    case Stage.failed: return "The registration stopped.";
    case Stage.cancelling: return "Cancelling the commit...";
    case Stage.cancelled: return "Cancelled.";
    default: return "";
  }
}

function registrationCardHtml(p) {
  const ui = registrationUi.get(p.id) || {};
  const id = esc(p.id);
  const icon = needsDriving(p) ? spinner()
    : p.stage === Stage.registered ? `<span class="kl-green">${kit.ICON.sealCheck}</span>`
      : `<span class="kl-orange">${LI.exclamation}</span>`;
  let progress = "";
  const daa = kachatNames()?.actions.virtualDaa ?? null;
  if (p.stage === Stage.waiting && p.commitDaa != null && daa != null) {
    const target = (params()?.tCommit ?? 600n) + 20n;
    const commitDaa = BigInt(p.commitDaa);
    let done = daa > commitDaa ? daa - commitDaa : 0n;
    if (done > target) done = target;
    const left = (target - done) / DAA_PER_SECOND;
    const percent = target > 0n ? Number((done * 1000n) / target) / 10 : 0;
    progress = `
      <div class="kl-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(percent)}">
        <span style="width:${percent}%"></span>
      </div>
      <small class="kmkt-muted">${esc(`About ${left} s to go`)}</small>`;
  }
  const message = ui.error || (p.stage === Stage.failed ? p.lastError : null);
  // what the driver is doing or waiting on (a busy network, freeing an expired name; iOS b219bb0)
  const note = !message && needsDriving(p) && p.lastError ? p.lastError : null;
  const cancel = `<button class="secondary-button kl-danger kmkt-small-button" type="button" data-kl-reg-cancel="${id}" ${ui.working ? "disabled" : ""}>Cancel Commit</button>`;
  let buttons = "";
  if (p.stage === Stage.registered) {
    buttons = (p.registerTxId ? `<button class="primary-button kmkt-small-button" type="button" data-kl-reg-view="${esc(p.registerTxId)}">View Transaction</button>` : "")
      + `<button class="secondary-button accent kmkt-small-button" type="button" data-kl-reg-done="${id}">Done</button>`;
  }
  else if (p.stage === Stage.taken) buttons = cancel;
  else if (p.stage === Stage.failed) {
    buttons = `<button class="primary-button kmkt-small-button" type="button" data-kl-reg-retry="${id}">Try Again</button>${cancel}`
      + `<button class="secondary-button accent kmkt-small-button" type="button" data-kl-reg-dismiss="${id}">Dismiss</button>`;
  }
  return `
    <section class="kmkt-card kl-reg-card">
      <div class="kl-reg-head">
        <strong>${esc(`${p.name}.kachat`)}</strong>
        ${icon}
      </div>
      <p class="kl-reg-text">${esc(registrationStageText(p))}</p>
      ${progress}
      ${message ? `<p class="kl-error">${esc(message)}</p>` : note ? `<p class="kl-reg-note">${esc(note)}</p>` : ""}
      ${buttons ? `<div class="kl-reg-buttons">${buttons}</div>` : ""}
    </section>`;
}

// A claim's progress as a half sheet (iOS b219bb0 KachatRegistrationProgressSheet +
// KachatRegistrationPresenter): it opens when a claim starts, and comes back up once on its own
// when the app starts with a claim still in progress (actions.autoPresentedRegistration, set by
// resume()) - claiming takes the app being open, the commit has to age about a minute before the
// name registers. Closing it (Close, Escape, the backdrop) leaves the claim running: the .kachat
// screen's claims button lists every open claim (`liveClaimsButtonHtml`, `openClaimsList`). It
// closes by itself once its registration is dismissed (Done) or its commit was cancelled. Owner
// "kachat-registration": leaving the .kachat screen doesn't close it.

const progressSheet = { layer: null, id: null };

function progressRegistration() {
  const id = progressSheet.id;
  return id ? kachatNames()?.actions.pending.find((p) => p.id === id) ?? null : null;
}

const KEEP_OPEN_NOTE = "Keep KaChat open: the name is registered about a minute after the hidden commit confirms. If you leave, it picks up where it left off when you come back.";

function progressBodyHtml(p) {
  return `
    <div class="kmkt-sheet-body kl-progress-sheet">
      <strong class="kl-progress-title">${esc(`Claiming ${p.name}.kachat`)}</strong>
      ${registrationCardHtml(p)}
      ${needsDriving(p) ? `<p class="kmkt-muted kl-progress-note">${esc(KEEP_OPEN_NOTE)}</p>` : ""}
      <button class="kl-done-close" type="button" data-kmkt-close>Close</button>
    </div>`;
}

/** The registration buttons inside the progress sheet and the claims list. */
function registrationActionClick(target) {
  const view = target.closest("[data-kl-reg-view]");
  if (view) { openTxDoneSheet({ txId: view.dataset.klRegView, title: "Name registered", owner: "kachat-registration", accepted: true }); return; }
  const done = target.closest("[data-kl-reg-done]");
  if (done) { kachatNames()?.actions.dismiss(done.dataset.klRegDone); return; }
  const dismiss = target.closest("[data-kl-reg-dismiss]");
  if (dismiss) { dismissFailedRegistration(dismiss.dataset.klRegDismiss); return; }
  const retry = target.closest("[data-kl-reg-retry]");
  if (retry) {
    registrationUi.delete(retry.dataset.klRegRetry);
    kachatNames()?.actions.retry(retry.dataset.klRegRetry);
    return;
  }
  const cancel = target.closest("[data-kl-reg-cancel]");
  if (cancel && !cancel.disabled) cancelRegistration(cancel.dataset.klRegCancel);
}

/** Opens the progress sheet of registration `id` (a claim that just started, or the one the app
 *  brings up by itself), replacing another one's. */
function openRegistrationProgress(id) {
  const p = kachatNames()?.actions.pending.find((x) => x.id === id) ?? null;
  if (!kit || !p || !isOpen(p)) return;
  if (progressSheet.layer) {
    if (progressSheet.id === id) { renderRegistrationProgress(); return; }
    const old = progressSheet.layer;
    progressSheet.layer = null;
    progressSheet.id = null;
    kit.closeLayer(old);
  }
  progressSheet.id = id;
  const layer = kit.openLayer({
    owner: "kachat-registration",
    kind: "sheet",
    label: `Claiming ${p.name}.kachat`,
    html: progressBodyHtml(p),
    onClick(event) { registrationActionClick(event.target); },
    onClose() {
      if (progressSheet.layer === layer) { progressSheet.layer = null; progressSheet.id = null; }
      // swiped away: the claim keeps running (iOS b219bb0)
      try { kachatNames()?.actions.clearAutoPresented?.(); } catch { /* fine */ }
    },
  });
  progressSheet.layer = layer;
}

/** Repaints the progress sheet and closes it once its registration is over; with none up, opens
 *  the one the app brings up by itself (once per launch). */
function renderRegistrationProgress() {
  if (!kit) return;
  const actions = kachatNames()?.actions;
  if (progressSheet.layer) {
    const p = progressRegistration();
    if (!p || !isOpen(p)) {
      const layer = progressSheet.layer;
      progressSheet.layer = null;
      progressSheet.id = null;
      kit.closeLayer(layer);
    } else {
      const sheetEl = progressSheet.layer.el.querySelector(".kmkt-sheet");
      if (sheetEl) sheetEl.innerHTML = progressBodyHtml(p);
    }
    return;
  }
  const auto = actions?.autoPresentedRegistration;
  if (!auto) return;
  const p = actions.pending.find((x) => x.id === auto);
  if (p && isOpen(p)) openRegistrationProgress(auto);
  else actions.clearAutoPresented?.();
}

/** The .kachat screen's claims button, next to How it works (iOS b219bb0 KachatClaimsButton): the
 *  names being claimed right now (and finished ones not yet dismissed), with a count. Hidden when
 *  there are none, and where the registry isn't launched (mainnet). */
export function liveClaimsButtonHtml() {
  const open = kachatNames()?.actions.openRegistrations ?? [];
  if (!open.length) return "";
  const count = String(open.length);
  return `<button class="kaposts-icon-button kl-claims-button" type="button" data-kl-claims aria-label="Names being claimed" title="Names being claimed">
    ${LI.hourglass}<span class="kl-claims-count">${esc(count)}</span></button>`;
}

const claimsList = { layer: null };

function claimsListBodyHtml() {
  const open = kachatNames()?.actions.openRegistrations ?? [];
  return `
    ${navHtml("Claiming", { trailing: { label: "Done", bold: true } })}
    <div class="kmkt-sheet-body kl-claims-body">
      ${open.map((p) => registrationCardHtml(p)).join("")}
      <p class="kmkt-muted kl-progress-note">${esc(KEEP_OPEN_NOTE)}</p>
    </div>`;
}

/** Every open claim with its progress: the list behind the claims button (iOS b219bb0
 *  KachatClaimsListSheet). It closes by itself once the last one is dismissed. */
export function openClaimsList(owner = "market") {
  if (!kit || claimsList.layer || !(kachatNames()?.actions.openRegistrations ?? []).length) return;
  const layer = kit.openLayer({
    owner,
    kind: "tall",
    label: "Claiming",
    html: claimsListBodyHtml(),
    onClick(event) { registrationActionClick(event.target); },
    onClose() { if (claimsList.layer === layer) claimsList.layer = null; },
  });
  claimsList.layer = layer;
}

function renderClaimsList() {
  if (!kit || !claimsList.layer) return;
  if (!(kachatNames()?.actions.openRegistrations ?? []).length) {
    const layer = claimsList.layer;
    claimsList.layer = null;
    kit.closeLayer(layer);
    return;
  }
  const sheetEl = claimsList.layer.el.querySelector(".kmkt-sheet");
  if (sheetEl) sheetEl.innerHTML = claimsListBodyHtml();
}

async function cancelRegistration(id) {
  const rt = kachatNames();
  if (!rt) return;
  const ok = await confirmAsk({
    title: "Cancel the commit?",
    message: kasLabel("The registration stops and the commit's 0.2 KAS comes back to you, less the network fee."),
    confirmLabel: "Cancel Commit",
    destructive: true,
  });
  if (!ok || !(await deviceLock())) return;
  registrationUi.set(id, { working: true, error: null });
  renderRegistrationProgress();
  renderClaimsList();
  try {
    const cancelTxId = await rt.actions.cancel(id);
    registrationUi.set(id, { working: false, error: null });
    if (cancelTxId) openTxDoneSheet({ txId: cancelTxId, title: "Commit cancelled" });
  } catch (error) {
    registrationUi.set(id, { working: false, error: errorText(error) });
  }
  renderRegistrationProgress();
  renderClaimsList();
}

/** Drops a failed registration from the list (desktop addition: a commit that never reached the
 *  chain can't be cancelled). Warns first, since the record holds the commit's secret. */
async function dismissFailedRegistration(id) {
  const rt = kachatNames();
  if (!rt) return;
  const ok = await confirmAsk({
    title: "Dismiss this registration?",
    message: kasLabel("If its commit is still on chain, dismissing it loses the commit's 0.2 KAS: cancel the commit first to get it back."),
    confirmLabel: "Dismiss",
    destructive: true,
  });
  if (!ok) return;
  registrationUi.delete(id);
  rt.actions.dismiss(id);
}

// ---------------------------------------------------------------------------------------------
// Hub: pages
// ---------------------------------------------------------------------------------------------

function listCard(rowsHtml, inset = 62) {
  return `<div class="kmkt-card kmkt-list kl-list" style="--kmkt-inset:${Number(inset)}px">${rowsHtml}</div>`;
}

function loadErrorHtml() {
  return hub.loadError ? `<p class="kl-note kl-red">${esc(hub.loadError)}</p>` : "";
}

/** A square tile for one name in the marketplace grids (iOS KachatNameTile, 27a4f39 / c488d1d):
 *  centered - the full name (it wraps and the tile grows, never truncated), ".kachat" under it,
 *  then the footer (the price asked, and any button). `nameHtml` is trusted markup (escaped). */
export function kachatNameTileHtml(nameHtml, footerHtml = "") {
  return `
    <span class="kl-tile-name">${nameHtml}</span>
    <span class="kl-tile-suffix">.kachat</span>
    ${footerHtml ? `<span class="kl-tile-footer">${footerHtml}</span>` : ""}`;
}

/** Two tiles per row (iOS KachatNameGrid). */
export function kachatNameGridHtml(tilesHtml) {
  return `<div class="kl-tile-grid">${tilesHtml}</div>`;
}

/** KachatLiveMarketPage: names for sale only (iOS 0765ce0), as tiles with the asking price and,
 *  under it, when the name expires - "Expires soon" when less than expiresSoonMs is left (30 days
 *  on mainnet, the renewal window on testnet), so a buyer sees what they get before opening it
 *  (iOS ad184c3). */
function marketPageHtml() {
  const p = params();
  const soonMs = p ? paramsExpiresSoonMs(p) : 30n * 86_400_000n;
  const now = BigInt(Date.now());
  const listings = hub.listings.length
    ? kachatNameGridHtml(hub.listings.map((n) => {
      rememberName(n);
      const soon = n.expiresAt - soonMs < now;
      return `
        <button class="kmkt-card kl-tile" type="button" data-kl-open-name="${esc(n.name)}" aria-label="${esc(n.display)}">
          ${kachatNameTileHtml(esc(n.name), `
            <span class="kl-tile-price">${esc(amountText(n.price))}</span>
            <span class="kl-tile-expiry">${esc(`Expires ${dayText(n.expiresAt)}`)}</span>
            ${soon ? `<span class="kl-tile-soon">Expires soon</span>` : ""}`)}
        </button>`;
    }).join(""))
    : emptyCard(hubLoaded() ? "No names are listed right now." : null);
  return `
    <div class="kmkt-page">
      ${loadErrorHtml()}
      ${kit.sectionHeader("For sale")}
      ${listings}
    </div>`;
}

/** KachatLiveAvailablePage (iOS eea52b2): names that expired and stayed unrenewed through the
 *  grace period - back on the market at the normal price. A tile opens the name; its Claim button
 *  keeps its own click and starts the claim (the driver frees the old record and registers it in
 *  one go, with the progress sheet). The price is the registration price for its length. */
function availablePageHtml() {
  const lapsed = hub.lapsed.length
    ? kachatNameGridHtml(hub.lapsed.map((n) => {
      rememberName(n);
      const price = priceOf(n.name);
      return `
        <div class="kmkt-card kl-tile kl-tile-split">
          <button class="kl-tile-open" type="button" data-kl-open-name="${esc(n.name)}" aria-label="${esc(n.display)}"></button>
          ${kachatNameTileHtml(esc(n.name), `
            ${price != null ? `<span class="kl-tile-price">${esc(amountText(price))}</span>` : ""}
            <button class="primary-button kmkt-small-button kl-tile-button" type="button" data-kl-claim-expired="${esc(n.name)}">Claim</button>`)}
        </div>`;
    }).join(""))
    : emptyCard(hubLoaded() ? "No expired names right now." : null);
  return `
    <div class="kmkt-page">
      ${loadErrorHtml()}
      ${kit.sectionHeader("Available")}
      ${lapsed}
    </div>`;
}

/** KachatLiveExpiredPage (iOS cb3c27d): names that expired and are still in their grace period -
 *  only their owner can renew them - soonest release first, each with a live countdown to the
 *  moment it is released to Available and its claim price. When one reaches zero the hub reloads
 *  and it moves to Available. A tile opens the name. */
function expiredPageHtml() {
  const grace = graceMs();
  const names = hub.grace.length
    ? kachatNameGridHtml(hub.grace.map((n) => {
      rememberName(n);
      const releaseAt = n.expiresAt + grace;
      const price = priceOf(n.name);
      return `
        <button class="kmkt-card kl-tile" type="button" data-kl-open-name="${esc(n.name)}" aria-label="${esc(n.display)}">
          ${kachatNameTileHtml(esc(n.name), `
            <span class="kl-tile-release">
              <small>Released in</small>
              ${countdownHtml(releaseAt, { reloadKey: `${n.name}:${releaseAt}` })}
            </span>
            ${price != null ? `<span class="kl-tile-expiry">${esc(amountText(price))}</span>` : ""}`)}
        </button>`;
    }).join(""))
    : emptyCard(hubLoaded() ? "No names are in their grace period right now." : null);
  return `
    <div class="kmkt-page">
      ${loadErrorHtml()}
      ${kit.sectionHeader("Expired")}
      ${names}
    </div>`;
}

/** Claim on an expired name (an Available tile, or the name's own page): the claim sheet on the
 *  gap its reclaim reopens (registry.claimGap); the driver frees the old record first. */
async function claimExpired(info, owner = "market") {
  const rt = kachatNames();
  if (!rt || !info) return;
  let gap = null;
  try { gap = await rt.registry.claimGap(info); } catch { gap = null; }
  if (gap) openClaimSheet({ name: info.name, gap, owner });
}

/** KachatLiveActivityPage: every registry event (iOS 0765ce0). */
function activityPageHtml() {
  const events = hub.activity.slice(0, 100);
  const list = events.length
    ? listCard(events.map((e) => eventRowHtml(e, { showName: true })).join(""), 56)
    : emptyCard(hubLoaded() ? "Nothing yet." : null);
  return `
    <div class="kmkt-page">
      ${loadErrorHtml()}
      ${kit.sectionHeader("Recent activity", "Every claim, renewal, listing, sale, offer, transfer and reclaim across the registry.")}
      ${list}
    </div>`;
}

/** The selected tab's live page: Marketplace, Available, Expired or Activity (iOS 73128b3). Your
 *  own names and the offers you made live in Profile > Your Domains (iOS 0765ce0). */
export function livePageHtml(page) {
  if (page === "available") return availablePageHtml();
  if (page === "expired") return expiredPageHtml();
  if (page === "activity") return activityPageHtml();
  return marketPageHtml();
}

/** Clicks on the live hub (search result, registrations, pages). True when handled. */
export function liveHubClick(event) {
  const target = event.target;
  // first: an Available tile's Claim button keeps its own click (the tile opens the name)
  const claimButton = target.closest("[data-kl-claim-expired]");
  if (claimButton) {
    const info = nameIndex.get(claimButton.dataset.klClaimExpired);
    if (info) claimExpired(info, "market");
    return true;
  }
  // the claims button next to How it works (iOS b219bb0)
  if (target.closest("[data-kl-claims]")) { openClaimsList("market"); return true; }
  const open = target.closest("[data-kl-open-name]");
  if (open) {
    const info = nameIndex.get(open.dataset.klOpenName);
    if (info) kit.openNameDetail(info);
    return true;
  }
  const claim = target.closest("[data-kl-claim]");
  if (claim) {
    const s = hub.search;
    if (!claim.disabled && s.kind === "free" && s.name === claim.dataset.klClaim && s.gap) {
      openClaimSheet({ name: s.name, gap: s.gap, owner: "market" });
    }
    return true;
  }
  // (a claim in flight shows in its own progress sheet and the claims list, not on the hub: iOS b219bb0)
  return false;
}

// ---------------------------------------------------------------------------------------------
// The transaction sheet (KachatTxSheet)
// ---------------------------------------------------------------------------------------------

/** "X · x.com/handle" for a stored social link, or "None" (iOS KachatProfileSaveSheet.source). */
function socialSourceText(link, kind) {
  const source = link ? SocialSource.fromLink(link, kind) : null;
  if (!source) return "None";
  return `${SocialPlatform.displayName(source.platform)} · ${SocialPlatform.prefix(source.platform)}${source.displayHandle}`;
}

/** Review before a profile record goes out (iOS 7e238e5 KachatProfileSaveSheet): what will be
 *  saved, the network fee - quoted by estimating the record the way the save builds it - and the
 *  chatting address's balance before and after; then the device lock, then the done sheet. Used by
 *  Edit KaChat Profile and Set as Primary. `makeProfile` builds the record when the sheet opens.
 *  Works on every network (kachatProfiles: a profile is a self-send, not registry data). */
function openProfileSaveSheet({ title, confirmTitle, doneTitle, makeProfile, onSaved = null, owner = "market" }) {
  const rt = kachatProfiles();
  if (!rt || !kit) return null;
  const st = { profile: null, fee: null, quoteError: null, sending: false, sendError: null, txId: null, closed: false, layer: null };
  const body = () => {
    const p = st.profile;
    const rows = p ? [
      formRow("Avatar", socialSourceText(p.avatar, SocialKind.avatar)),
      formRow("Banner", socialSourceText(p.banner, SocialKind.banner)),
      formRow("Bio", socialSourceText(p.bio, SocialKind.bio)),
      formRow("Linktree", p.linktree ? String(p.linktree).replace(/^https:\/\//, "") : "None"),
      formRow("Primary name", p.primaryName ? `${p.primaryName}.kachat` : "None"),
    ].join("") : formRow("Your Profile", "", { valueHtml: spinner() });
    let cost = "";
    if (st.fee != null) {
      cost += formRow("Network fee", amountText(st.fee));
      const balance = walletBalanceSompi();
      if (balance != null) {
        cost += formRow("Chatting address balance", amountText(balance));
        cost += formRow("Balance after", amountText(balance > st.fee ? balance - st.fee : 0n), { bold: true });
      }
    } else if (!st.quoteError) {
      cost += formRow("Network fee", "", { valueHtml: spinner() });
    }
    const costFoot = st.quoteError
      ? footer(st.quoteError, "kl-red")
      : footer(readPrivacySeen()
        ? "Saved on chain from your chatting address to itself."
        : "Profiles are public and on chain: anyone can read them, and earlier versions stay readable after you change them.");
    const disabled = st.fee == null || !st.profile || st.sending || st.txId;
    const button = `<button class="kmkt-form-button" type="button" data-kl-psave-confirm ${disabled ? "disabled" : ""}>${st.sending ? spinner() : esc(confirmTitle)}</button>`;
    return `
      ${navHtml(title, { leading: { label: "Cancel" } })}
      <div class="kmkt-sheet-body kmkt-form kl-tx-body">
        ${section(rows, { header: "Your Profile" })}
        ${section(cost, { footerHtml: costFoot })}
        ${section(button, { footerHtml: st.sendError ? footer(st.sendError, "kl-red") : "" })}
      </div>`;
  };
  const render = () => {
    if (st.closed || !st.layer) return;
    const sheetEl = st.layer.el.querySelector(".kmkt-sheet");
    if (sheetEl) sheetEl.innerHTML = body();
  };
  const confirm = async () => {
    if (st.fee == null || !st.profile || st.sending || st.txId) return;
    if (!(await deviceLock()) || st.closed) return;
    st.sending = true;
    st.sendError = null;
    render();
    try {
      const txId = await rt.actions.saveProfile(st.profile);
      st.txId = txId;
      writePrivacySeen();
      identityChanged();
      openTxDoneSheet({
        txId, title: doneTitle, owner,
        onClose: () => {
          if (st.layer && !st.closed) kit.closeLayer(st.layer);
          try { onSaved?.(txId); } catch { /* fine */ }
        },
      });
    } catch (error) {
      st.sendError = errorText(error);
    }
    st.sending = false;
    render();
  };
  st.layer = kit.openLayer({
    owner, kind: "tall", label: title, html: body(),
    onClick(event) {
      if (event.target.closest("[data-kl-psave-confirm]")) confirm();
    },
    onClose() { st.closed = true; },
  });
  (async () => {
    try {
      st.profile = await makeProfile();
      render();
      st.fee = await rt.actions.profileFee(st.profile);
    } catch (error) {
      st.quoteError = errorText(error);
    }
    render();
  })();
  return st.layer;
}

/** The chatting address's balance in sompi, or null while unknown. */
function walletBalanceSompi() {
  try {
    const value = deps().walletBalanceSompi?.();
    return typeof value === "bigint" ? value : null;
  } catch { return null; }
}

/** The headline each action's finished-transaction sheet shows (iOS doneTitle). */
const TX_DONE_TITLES = Object.freeze({
  "Buy Name": "Name bought",
  "Make an Offer": "Offer sent",
  "Extend": "Extended",
  "Renew": "Renewed",
  "List for Sale": "Listed for sale",
  "Change Price": "Price changed",
  "Delist": "Delisted",
  "Transfer": "Name transferred",
  "Release Name": "Name released",
  "Withdraw Offer": "Offer withdrawn",
  "Refund Offer": "Offer refunded",
  "Accept Offer": "Offer accepted",
  "Decline Offer": "Offer declined",
});

/** What the receipt says under its title for each stage (iOS KachatTxDoneSheet.stageText). */
function txStageText(stage) {
  switch (stage) {
    case TxStage.accepted: return "It's in a block. Updating KaChat...";
    case TxStage.shown: return "Done. It shows in KaChat now.";
    case TxStage.dropped: return "The network hasn't taken it. Nothing was spent if it never lands - try again with a faster fee.";
    default: return "Waiting for the network to put it in a block. Usually a few seconds; longer when it's busy.";
  }
}

/** One step of the receipt: done (a green check), active (a spinner) or still to come (a circle). */
function txStepHtml(title, { done = false, active = false } = {}) {
  const icon = done ? `<span class="kl-green">${LI.checkCircle}</span>` : active ? spinner("kl-step-spinner") : `<span class="kmkt-muted">${LI.circle}</span>`;
  return `<div class="kl-receipt-step${done || active ? " on" : ""}"><span class="kl-receipt-step-icon">${icon}</span><span>${esc(title)}</span></div>`;
}

/**
 * The receipt every name transaction ends on (iOS KachatTxDoneSheet, e426432), in the Send
 * receipt's style: what it does, its progress followed on a node (actions.follow) - a spinner
 * until it lands, then a check; steps Sent to the network / In a block / Updated in KaChat; dropped
 * says so and suggests a faster fee - and the transaction id as a link to the block explorer picked
 * in Settings (testnet-10's on testnet). Closing it early is fine: the change still lands.
 * `accepted`: already known to be in a block (a registration the driver saw land) - no progress to
 * follow. A transaction this sheet wasn't handed by `perform` (a profile save) is followed here.
 */
function openTxDoneSheet({ txId, title = "Transaction sent", owner = "market", onClose = null, accepted = false }) {
  if (!kit || !txId) return null;
  const explorer = typeof deps().explorerTxUrl === "function" ? deps().explorerTxUrl(txId) : "";
  // profiles save on every network (kachatProfiles), names only where the registry runs
  const actions = kachatNames()?.actions ?? kachatProfiles()?.actions ?? null;
  const stage = () => actions?.txStage?.(txId) ?? (accepted ? TxStage.shown : TxStage.sent);
  const body = () => {
    const st = stage();
    const inBlock = st === TxStage.accepted || st === TxStage.shown;
    const icon = st === TxStage.shown ? `<span class="kl-receipt-icon kl-green">${LI.checkCircle}</span>`
      : st === TxStage.dropped ? `<span class="kl-receipt-icon kl-orange">${LI.exclamation}</span>`
        : `<span class="kl-receipt-icon">${spinner("kl-receipt-spinner")}</span>`;
    const txid = `<span class="kl-mono">${esc(txId)}</span>${explorer ? LI.external : ""}`;
    return `
      <div class="kmkt-sheet-body kl-receipt">
        ${icon}
        <strong class="kl-receipt-title">${esc(title)}</strong>
        <p class="kmkt-muted kl-receipt-note">${esc(txStageText(st))}</p>
        <div class="sk-card kl-receipt-steps">
          ${txStepHtml("Sent to the network", { done: true })}
          ${txStepHtml("In a block", { done: inBlock, active: !inBlock && st !== TxStage.dropped })}
          ${txStepHtml("Updated in KaChat", { done: st === TxStage.shown, active: st === TxStage.accepted })}
        </div>
        ${explorer
          ? `<a class="sk-card kl-receipt-txid" href="${esc(explorer)}" target="_blank" rel="noopener noreferrer" title="Open in the explorer">${txid}</a>`
          : `<span class="sk-card kl-receipt-txid">${txid}</span>`}
        ${explorer ? `<p class="sk-caption kl-receipt-caption">Click the transaction to open it in the explorer.</p>` : ""}
        <button class="kl-receipt-done" type="button" data-kmkt-close>Done</button>
      </div>`;
  };
  let last = stage();
  let unsubscribe = null;
  const layer = kit.openLayer({
    owner,
    kind: "sheet",
    label: title,
    html: body(),
    onClose: () => {
      try { unsubscribe?.(); } catch { /* gone */ }
      try { onClose?.(); } catch { /* fine */ }
    },
  });
  const repaint = () => {
    const sheetEl = layer.el.querySelector(".kmkt-sheet");
    if (sheetEl) sheetEl.innerHTML = body();
  };
  if (actions?.subscribe) {
    unsubscribe = actions.subscribe(() => {
      const st = stage();
      if (st !== last) { last = st; repaint(); }
    });
  }
  // a transaction this sheet wasn't handed by `perform` (a profile save): follow it here
  if (actions && !accepted && actions.txStage?.(txId) == null) {
    try { actions.follow?.(txId, null); } catch { /* shows as sent */ }
  }
  return layer;
}

/** A glass card in the Send screens' style (iOS KachatCard / KachatInputCard, e426432): an optional
 *  small caption title, the content (trusted markup), an optional note under it (trusted markup). */
function cardHtml(contentHtml, { title = "", footerHtml = "", cls = "" } = {}) {
  return `
    <div class="sk-card kl-card ${cls}">
      ${title ? `<span class="sk-card-label">${esc(title)}</span>` : ""}
      ${contentHtml}
      ${footerHtml}
    </div>`;
}

/** A card's note (iOS KachatInputCard footer). */
const cardNote = (text, cls = "") => (text ? `<p class="sk-caption ${cls}">${esc(text)}</p>` : "");

/** Shown when the network is busy (iOS KachatBusyNetworkNotice): Normal may wait, a faster fee gets
 *  in sooner. */
function busyNoticeHtml() {
  return `
    <div class="kl-busy-notice" role="status">
      <span class="kl-orange">${LI.warning}</span>
      <span class="kl-busy-copy">
        <strong>The network is busy</strong>
        <small>At Normal this may wait a while. Fast or Priority pays a little more to get into a block sooner.</small>
      </span>
    </div>`;
}

/** A destructive action's warning, in red above the slider (iOS e426432 / e67074c). */
function warningCardHtml(text) {
  return `<div class="kl-warning-card" role="note">${LI.warning}<span>${esc(text)}</span></div>`;
}

/**
 * Every action's sheet, in the Send screens' style (iOS KachatTxSheet, e426432): what it does (a
 * card), its inputs (cards), the network fee with Normal / Fast / Priority or a custom amount (and a
 * notice when the network is busy - it then starts on Fast unless the person chose), the cost, and
 * slide to confirm - the destructive ones show their warning in red above it; the slide itself is
 * the confirmation (iOS e67074c) - then the device lock, then the transaction, sent at the fee shown.
 * Ends on a receipt that follows it into a block.
 *
 * cfg: { owner, title, confirmTitle, warning?, footer?: () => string|null, rows?: () => [{title, value}],
 *        inputsHtml?: string (cards), operation: () => op|null, operationKey: () => string, back?: () => void,
 *        onInput?(event, sheet), onClick?(event, sheet), onOpen?(sheet), onDone?(txId), onClose?(txId|null) }
 */
function openTxSheet(cfg) {
  const rt = kachatNames();
  if (!rt || !kit) return null;
  const sheet = {
    plan: null, op: null, planError: null, building: false, sending: false, txId: null, sendError: null,
    key: undefined, seq: 0, timer: null, layer: null, closed: false,
    /** the fee rate `plan` was built at: the send uses exactly this (iOS 7e2b6cd, IOS-061) */
    planFeerate: null,
    /** the spending address that signs and pays for the plan (iOS 881ada6), else null: the chatting address */
    payer: null,
    /** the fee (iOS e426432): a speed, or a typed total (sompi); `touched` once the person chose -
     *  a busy network no longer moves it for them */
    fee: { tier: FeeTier.normal, custom: null, touched: false },
    feeCtl: null,
    slide: null,
  };
  const feeChoice = () => (sheet.fee.custom != null ? FeeChoice.customTotal(sheet.fee.custom) : FeeChoice.tier(sheet.fee.tier));

  // a step of a flow (`cfg.back`, Renew after "How long?"; iOS 26bd5dc; an offer's action inside
  // its half sheet, iOS 7f50e84): Back, not Cancel, leads back until it's sent
  const navFor = () => {
    if (sheet.txId) return navHtml(cfg.title, { trailing: { label: "Done", bold: true } });
    if (cfg.back) {
      return `<div class="kl-nav" data-kl-nav>
        <header class="kmkt-navbar">
          <button class="kmkt-nav-button leading" type="button" data-kl-tx-back>Back</button>
          <h2 class="kmkt-navbar-title">${esc(cfg.title)}</h2>
          <span></span>
        </header>
      </div>`;
    }
    return navHtml(cfg.title, { leading: { label: "Cancel" } });
  };

  /** What it does: the rows, and the price when there is one (to miners). */
  const rowsHtml = () => {
    const rows = (cfg.rows?.() ?? []).map((r) => formRow(r.title, r.value)).join("");
    const price = sheet.plan && sheet.plan.priceFee > 0n ? formRow("Price (to miners)", amountText(sheet.plan.priceFee)) : "";
    if (!rows && !price) return "";
    return cardHtml(`${rows}${rows && price ? `<div class="sk-divider" aria-hidden="true"></div>` : ""}${price}`, { cls: "kl-rows-card" });
  };

  /** Names spend from, and pay back to, the chatting address (iOS 8ecc38c): its balance after; an
   *  owner action on a name a spending address holds is signed and paid by that address (iOS
   *  881ada6): which one, and what it changes there. */
  const pillsHtml = () => {
    if (!sheet.plan) return "";
    const pill = (text) => infoPillHtml({ innerHtml: `<span class="sk-pill-value">${esc(text)}</span>` });
    const payerKey = sheet.payer ? keyOf(sheet.payer.address) : null;
    if (payerKey) {
      return pill(`Paid from: Spending address #${sheet.payer.index}`)
        + pill(`Balance change: ${signedAmount(balanceChange(sheet.plan, payerKey))}`);
    }
    const me = myKey();
    if (!me) return "";
    const change = balanceChange(sheet.plan, me);
    const balance = walletBalanceSompi();
    if (balance != null) {
      const after = balance + change;
      return pill(`Balance after: ${amountText(after > 0n ? after : 0n)}`);
    }
    return pill(`Balance change: ${signedAmount(change)}`);
  };

  const notesHtml = () => {
    if (sheet.planError) return `<p class="kl-tx-note kl-red">${esc(sheet.planError)}</p>`;
    const text = cfg.footer?.() ?? null;
    return text ? `<p class="kl-tx-note kmkt-muted">${esc(text)}</p>` : "";
  };

  sheet.render = () => {
    if (sheet.closed || !sheet.layer) return;
    const el = sheet.layer.el;
    const q = (sel) => el.querySelector(sel);
    const nav = q("[data-kl-nav]");
    if (nav) nav.outerHTML = navFor();
    const rows = q("[data-kl-rows]");
    if (rows) rows.innerHTML = rowsHtml();
    const busy = q("[data-kl-busy]");
    if (busy) busy.innerHTML = rt.actions.feeEstimate?.isBusy && !sheet.txId ? busyNoticeHtml() : "";
    const pills = q("[data-kl-pills]");
    if (pills) pills.innerHTML = pillsHtml();
    const notes = q("[data-kl-notes]");
    if (notes) notes.innerHTML = notesHtml();
    const sendError = q("[data-kl-send-error]");
    if (sendError) sendError.innerHTML = sheet.sendError ? `<p class="kl-tx-note kl-red">${esc(sheet.sendError)}</p>` : "";
    const inputs = q("[data-kl-inputs]");
    if (inputs) inputs.disabled = Boolean(sheet.txId || sheet.sending);
    if (sheet.feeCtl && !sheet.feeCtl.editing) {
      sheet.feeCtl.setEstimating(sheet.building);
      sheet.feeCtl.setText(sheet.plan ? amountText(sheet.plan.networkFee) : "--");
    }
    const fee = q("[data-kl-fee-host]");
    if (fee) fee.inert = Boolean(sheet.txId || sheet.sending);
    const action = q("[data-kl-action]");
    if (action) action.hidden = Boolean(sheet.txId);
    sheet.slide?.setEnabled(Boolean(sheet.plan && !sheet.building && !sheet.txId));
  };

  /** Rebuilds the plan when the operation or the fee changed, 300 ms after the last change. */
  sheet.update = () => {
    if (sheet.txId) { sheet.render(); return; }
    const key = `${cfg.operationKey()}|${sheet.fee.tier}|${sheet.fee.custom ?? ""}`;
    if (key === sheet.key) { sheet.render(); return; }
    sheet.key = key;
    sheet.plan = null;
    sheet.planFeerate = null;
    sheet.op = null;
    sheet.payer = null;
    sheet.planError = null;
    clearTimeout(sheet.timer);
    const op = cfg.operation();
    const seq = ++sheet.seq;
    if (!op) { sheet.building = false; sheet.render(); return; }
    sheet.building = true;
    sheet.render();
    const fee = feeChoice();
    sheet.timer = setTimeout(async () => {
      try {
        // built at the fee shown (iOS e426432), and sent at exactly the rate it was built at
        // (iOS 7e2b6cd, IOS-061)
        const built = await rt.actions.planWithRate(op, { fee });
        if (seq !== sheet.seq || sheet.closed) return;
        sheet.plan = built.plan;
        sheet.planFeerate = built.feerate;
        sheet.op = op;
        try { sheet.payer = rt.actions.payerFor?.(op) ?? null; } catch { sheet.payer = null; }
      } catch (error) {
        if (seq !== sheet.seq || sheet.closed) return;
        sheet.planError = errorText(error);
      }
      sheet.building = false;
      sheet.render();
    }, 300);
  };

  /** A speed replaces a typed fee. */
  const chooseTier = (tier) => {
    if (sheet.sending || sheet.txId || !Object.values(FeeTier).includes(tier)) return;
    sheet.fee = { tier, custom: null, touched: true };
    sheet.feeCtl?.setTier(tier);
    sheet.update();
  };

  /** A typed total (the fee card's custom field) - more than zero, else the speed stays. */
  const commitCustomFee = () => {
    const input = sheet.layer?.el.querySelector("[data-kltx-fee-custom]");
    // the shared exact parser the Send screens use (iOS cee1966, IOS-062)
    const value = sompiFromUserText(input?.value ?? "");
    sheet.feeCtl?.setEditing(false);
    sheet.fee.touched = true;
    if (value != null && value > 0n) sheet.fee.custom = value;
    sheet.update();
  };

  const confirm = async () => {
    if (!sheet.plan || !sheet.op || sheet.sending || sheet.txId) return;
    const op = sheet.op;
    const key = sheet.key;
    const fee = feeChoice();
    // The slide is the confirmation: no second prompt, even for the destructive ones - their
    // warning is the red card above (iOS e67074c).
    if (!(await deviceLock())) return;
    if (sheet.closed || op !== sheet.op || key !== sheet.key) return;
    sheet.sending = true;
    sheet.sendError = null;
    sheet.slide?.setBusy(true);
    sheet.render();
    try {
      // never pays more than the price shown (iOS 4f5d95e; with v4's fixed prices a safeguard), and
      // sends at the fee rate shown - refused if the rebuilt fee is higher (iOS 7e2b6cd, IOS-061)
      const maxPrice = typeof sheet.plan?.priceFee === "bigint" ? sheet.plan.priceFee : null;
      const maxNetworkFee = typeof sheet.plan?.networkFee === "bigint" ? sheet.plan.networkFee : null;
      const txId = await rt.actions.perform(op, { maxPrice, fee, exactFeerate: sheet.planFeerate ?? null, maxNetworkFee });
      sheet.txId = txId;
      try { cfg.onDone?.(txId); } catch { /* the sheet still shows it */ }
      // Every name transaction ends on the receipt; closing it closes the action (iOS 0870fcc).
      openTxDoneSheet({
        txId,
        title: cfg.doneTitle || TX_DONE_TITLES[cfg.title] || "Transaction sent",
        owner: cfg.owner,
        onClose: () => { if (sheet.layer && !sheet.closed) kit.closeLayer(sheet.layer); },
      });
    } catch (error) {
      sheet.sendError = errorText(error);
      // the price or the fee moved: build the plan again so the person sees it and confirms it
      if ((error?.code === "priceChanged" || error?.code === "feeChanged") && !sheet.closed) {
        sheet.sending = false;
        sheet.slide?.setBusy(false);
        sheet.key = undefined;
        sheet.update();
        return;
      }
    }
    sheet.sending = false;
    sheet.slide?.setBusy(false);
    sheet.render();
  };

  sheet.layer = kit.openLayer({
    owner: cfg.owner || "market",
    kind: "tall",
    label: cfg.title,
    html: `
      ${navFor()}
      <div class="kmkt-sheet-body kl-tx-body kl-send-sheet">
        <div data-kl-rows></div>
        ${cfg.inputsHtml ? `<fieldset class="kl-fieldset kl-cards" data-kl-inputs>${cfg.inputsHtml}</fieldset>` : ""}
        <div data-kl-busy></div>
        <div data-kl-fee-host>${feeControlsHtml({ prefix: "kltx", estimating: true, tier: sheet.fee.tier, showCoinControl: false })}</div>
        <div class="sk-pills kl-pills" data-kl-pills></div>
        ${cfg.warning ? warningCardHtml(cfg.warning) : ""}
        <div data-kl-notes></div>
        <div class="kl-tx-action" data-kl-action>${sendActionButtonHtml({ attr: "kl-tx-slide", title: cfg.confirmTitle, disabled: true })}</div>
        <div data-kl-send-error></div>
      </div>`,
    onClick(event) {
      const tier = event.target.closest("[data-kltx-fee]");
      if (tier) { chooseTier(tier.getAttribute("data-kltx-fee")); return; }
      if (event.target.closest("[data-kltx-fee-edit]")) {
        if (!sheet.sending && !sheet.txId) sheet.feeCtl?.setEditing(true, sheet.plan ? plainAmount(sheet.plan.networkFee) : "");
        return;
      }
      if (event.target.closest("[data-kltx-fee-commit]")) { commitCustomFee(); return; }
      if (event.target.closest("[data-kl-tx-slide]")) return;
      if (event.target.closest("[data-kl-tx-back]")) {
        if (!sheet.sending && !sheet.txId) {
          kit.closeLayer(sheet.layer);
          try { cfg.back?.(); } catch { /* optional */ }
        }
        return;
      }
      cfg.onClick?.(event, sheet);
    },
    onInput: (event) => {
      const custom = event.target.closest("[data-kltx-fee-custom]");
      if (custom) { sanitizeAmountField(custom); return; }
      cfg.onInput?.(event, sheet);
    },
    onClose() {
      sheet.closed = true;
      clearTimeout(sheet.timer);
      // after the layer is gone: what comes next, if anything
      try { cfg.onClose?.(sheet.txId); } catch { /* optional */ }
    },
  });
  sheet.feeCtl = feeControls(sheet.layer.el, "kltx");
  sheet.slide = createSendActionButton(sheet.layer.el.querySelector("[data-kl-tx-slide]"), { onAction: () => { confirm(); }, busyLabel: "Sending…" });
  sheet.layer.el.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && event.target.closest?.("[data-kltx-fee-custom]")) { event.preventDefault(); commitCustomFee(); }
  });
  sheet.update();
  // A busy network starts on Fast unless the person already chose (iOS e426432).
  rt.actions.refreshFeeEstimate?.().then((estimate) => {
    if (sheet.closed || sheet.txId) return;
    if (estimate?.isBusy && !sheet.fee.touched && sheet.fee.custom == null && sheet.fee.tier === FeeTier.normal) {
      sheet.fee.tier = FeeTier.fast;
      sheet.feeCtl?.setTier(FeeTier.fast);
      sheet.update();
    } else {
      sheet.render();
    }
  }).catch(() => { /* the fee card still prices Normal */ });
  try { cfg.onOpen?.(sheet); } catch { /* optional */ }
  return sheet;
}

/** An amount field in a card (iOS: title2, semibold, the unit beside it). */
function amountInputHtml(attr, label) {
  return `
    <label class="kl-amount-field">
      <input class="kl-amount-input" type="text" inputmode="decimal" placeholder="0" autocomplete="off" ${attr} aria-label="${esc(label)}" />
      <span class="kmkt-muted">${esc(KAS_UNIT)}</span>
    </label>`;
}

// ---------------------------------------------------------------------------------------------
// Sheets
// ---------------------------------------------------------------------------------------------

/** A name record's outpoint, so a sheet rebuilds when the record moved. */
function txKey(info) {
  try { return `${hex(info.outpoint.txid)}-${info.outpoint.index}`; } catch { return info.name; }
}

/** KachatLiveBuySheet. */
function openBuySheet(info, owner) {
  // 30 days on mainnet's yearly clock, the renewal window on testnet's 24-hour one (IOS-060)
  const p = params();
  const soonMs = p ? paramsExpiresSoonMs(p) : 30n * 86_400_000n;
  const soon = info.expiresAt - soonMs < BigInt(Date.now());
  openTxSheet({
    owner,
    title: "Buy Name",
    confirmTitle: "Confirm Purchase",
    footer: () => (soon
      ? `Less than ${durationText(Number(soonMs))} is left before this name expires. You'd have to renew it soon.`
      : "The payment reaches the seller and the name reaches you in the same transaction - both happen, or neither does."),
    rows: () => [
      { title: "Name", value: info.display },
      { title: "Price (to the seller)", value: amountText(info.price) },
      { title: "Expires", value: dayText(info.expiresAt) },
    ],
    operation: () => Operation.buy(info),
    operationKey: () => `buy-${txKey(info)}`,
  });
}

/** Up to 7 days: the app's cap on offers (actions.js maxOfferDays). */
const OFFER_DAYS = [
  { id: 1, title: "1 Day" },
  { id: 3, title: "3 Days" },
  { id: 7, title: "7 Days" },
];

/** KachatLiveOfferSheet: an amount, when it becomes refundable, and the cost. The offer is made to
 *  `info`'s current owner (registry v3), the only one who can accept or decline it. */
function openOfferSheet(info, owner) {
  const name = info.name;
  let amountRaw = "";
  let days = 3;
  let virtualDaa = null;
  const amount = () => { const a = sompiFromUserText(amountRaw); return a != null && a > 0n ? a : null; };
  const refundAfter = () => (virtualDaa == null ? null : virtualDaa + BigInt(Math.min(days, Number(maxOfferDays))) * 86_400n * DAA_PER_SECOND);
  openTxSheet({
    owner,
    title: "Make an Offer",
    confirmTitle: "Send Offer",
    inputsHtml: `
      ${cardHtml(amountInputHtml("data-kl-offer-amount", `Your offer in ${KAS_UNIT}`), {
        title: "Your offer",
        footerHtml: cardNote(kasLabel("Your KAS stays locked on chain until the owner accepts or declines, you withdraw the offer, or it expires - then anyone can send it back to you.")),
      })}
      ${cardHtml(segmentedHtml("days", OFFER_DAYS, days, "Refundable after"), { title: "Refundable after" })}`,
    footer: () => {
      const a = amount();
      return info.isListed && a != null && info.price < a
        ? "This name is listed for less than your offer. Consider buying it instead."
        : null;
    },
    rows: () => {
      const r = [{ title: "Name", value: `${name}.kachat` }];
      if (info.isListed) r.push({ title: "Listed at", value: amountText(info.price) });
      r.push({ title: "Expires", value: dayText(info.expiresAt) });
      const a = amount();
      if (a != null) r.push({ title: "Offer", value: amountText(a) });
      return r;
    },
    operation: () => {
      const a = amount();
      const after = refundAfter();
      return a != null && after != null ? Operation.offer(info, a, after) : null;
    },
    operationKey: () => `${amount() ?? 0n}-${days}-${virtualDaa ?? 0n}`,
    onInput(event, sheet) {
      const input = event.target.closest("[data-kl-offer-amount]");
      if (!input) return;
      amountRaw = sanitizeAmountField(input);
      sheet.update();
    },
    onClick(event, sheet) {
      const chosen = segmentedClick(event, sheet.layer.el);
      if (chosen?.group === "days") { days = Number(chosen.id); sheet.update(); }
    },
    onOpen(sheet) {
      kachatNames()?.actions.refreshVirtualDaa()
        .then((daa) => { if (daa != null) { virtualDaa = BigInt(daa); sheet.update(); } })
        .catch(() => { /* the offer stays unbuildable */ });
    },
  });
}

/** `extend` (KachatExtendSheet): periods added to the current paid period (periodStart kept), up to
 *  maxYears periods past its start - in practice a 1-period name extended to 2. Only the periods
 *  that still fit are offered. Each period costs the renewal price (registry v4, iOS c8f1086). */
function openExtendSheet(info, owner) {
  let years = 1;
  const p = params();
  const perYear = renewPriceOf(info.name) ?? 0n;
  const periodMs = p?.periodMs ?? yearMs;
  // the years that still fit in the period (in practice 1)
  const extendable = Number(extendableYears(info, p));
  const available = Math.max(1, extendable);
  const title = () => {
    if (!p || !fillsPeriod(info, years, p)) return "Extend";
    return yearlyPeriods() ? `Extend to ${p.maxYears} years` : `Extend to ${periodsText(p.maxYears)}`;
  };
  openTxSheet({
    owner,
    get title() { return title(); },
    confirmTitle: "Extend",
    doneTitle: "Extended",
    inputsHtml: available > 1
      ? cardHtml(segmentedHtml("years", Array.from({ length: available }, (_, i) => ({ id: i + 1, title: yearsLabel(i + 1) })), years, "Years"))
      : "",
    footer: () => (yearlyPeriods()
      ? "Extending adds years to the current paid period, which holds at most 2 years. The price goes to the miners."
      : `Extending adds time to the current paid period, which holds at most ${periodsText(maxYears())}. The price goes to the miners.`),
    rows: () => [
      { title: "Name", value: info.display },
      { title: pricePerPeriodTitle(), value: amountText(perYear) },
      { title: "Expires", value: dayText(info.expiresAt) },
      { title: "New expiry", value: dayText(info.expiresAt + BigInt(years) * periodMs) },
    ],
    // the engine refuses a period it can't extend (full, or periodStart unknown) and says why
    operation: () => Operation.extend(info, BigInt(Math.min(years, available))),
    operationKey: () => `extend-${years}`,
    onClick(event, sheet) {
      const chosen = segmentedClick(event, sheet.layer.el);
      if (chosen?.group === "years") { years = Number(chosen.id); sheet.update(); }
    },
  });
}

/** `renew` (KachatRenewSheet, iOS 26bd5dc): the next period, from the current expiry, for 1 or 2
 *  periods - only once the renewal window is open (renewWindowMs before the expiry). Two steps:
 *  "How long?" first (the periods as full-width choices - 1 day / 2 days on testnet's clock,
 *  1 / 2 years on mainnet's - with what each costs), then the review with the fee and Renew; its
 *  Back leads to "How long?" again. Each period costs the renewal price (registry v4, iOS c8f1086). */
async function openRenewSheet(info, owner) {
  const perYear = renewPriceOf(info.name) ?? 0n;
  const choice = await chooseDialog({
    kicker: "Renew",
    title: "How long?",
    message: "A renewal starts the next period at the current expiry, not from today.",
    options: Array.from({ length: Math.max(1, maxYears()) }, (_, i) => ({
      id: String(i + 1), title: yearsLabel(i + 1), subtitle: amountText(perYear * BigInt(i + 1)),
    })),
  });
  const years = Number(choice);
  if (!choice || !Number.isInteger(years) || years < 1) return;
  openRenewReview(info, owner, years);
}

/** Renew, step 2: what the chosen period costs, and Renew. Before the renewal window opens nothing
 *  is built: the sheet says when it opens. */
function openRenewReview(info, owner, years) {
  const p = params();
  const perYear = renewPriceOf(info.name) ?? 0n;
  const periodMs = p?.periodMs ?? yearMs;
  const open = () => !p || renewalOpen(info, p);
  openTxSheet({
    owner,
    title: "Renew",
    confirmTitle: "Renew",
    doneTitle: "Renewed",
    back: () => { openRenewSheet(info, owner); },
    footer: () => (open()
      ? "A renewal starts the next period at the current expiry, not from today, so a name that expired a while ago gets less time. The price goes to the miners."
      : renewalOpensText(info, p)),
    rows: () => [
      { title: "Name", value: info.display },
      { title: pricePerPeriodTitle(), value: amountText(perYear) },
      { title: "New period", value: `${dayText(info.expiresAt)} – ${dayText(info.expiresAt + BigInt(years) * periodMs)}` },
    ],
    operation: () => (open() ? Operation.renew(info, BigInt(years)) : null),
    operationKey: () => `renew-${years}-${open()}`,
  });
}

/** KachatListSheet: List for Sale / Change Price. */
function openListSheet(info, owner) {
  let priceRaw = "";
  const price = () => { const v = sompiFromUserText(priceRaw); return v != null && v > 0n ? v : null; };
  openTxSheet({
    owner,
    title: info.isListed ? "Change Price" : "List for Sale",
    confirmTitle: info.isListed ? "Change Price" : "List",
    inputsHtml: cardHtml(amountInputHtml("data-kl-list-price", `Price in ${KAS_UNIT}`), { title: "Price" }),
    footer: () => "Anyone can buy it at this price: the payment reaches you and the name reaches them in one transaction. Delist any time.",
    rows: () => (info.isListed ? [{ title: "Listed at", value: amountText(info.price) }] : []),
    operation: () => { const v = price(); return v != null ? Operation.list(info, v) : null; },
    operationKey: () => `list-${price() ?? 0n}`,
    onInput(event, sheet) {
      const input = event.target.closest("[data-kl-list-price]");
      if (!input) return;
      priceRaw = sanitizeAmountField(input);
      sheet.update();
    },
  });
}

function openDelistSheet(info, owner) {
  openTxSheet({
    owner,
    title: "Delist",
    confirmTitle: "Delist",
    rows: () => [{ title: "Name", value: info.display }, { title: "Listed at", value: amountText(info.price) }],
    operation: () => Operation.list(info, 0n),
    operationKey: () => `delist-${txKey(info)}`,
  });
}

/** KachatTransferSheet: to an address or a domain on any service, .kachat first (iOS 6ac48a7), the
 *  resolved address shown with Other domains under it. The "New owner"
 *  field has the Send screens' recipient buttons beside it - Paste, Scan QR (a ?query is dropped)
 *  and the full-screen Address Book picker - and the saved name under it when the address is in the
 *  Address Book (iOS bfe7ef9). */
function openTransferSheet(info, owner) {
  let input = "";
  let resolved = null; // { address, key }
  let resolveError = null;
  let resolving = false;
  let timer = null;
  let seq = 0;
  // A typed name: what it resolved as and every service's answer (iOS 6ac48a7).
  let resolvedName = null;
  let nameResolutions = [];
  let selectedTld = null;
  const statusHtml = () => {
    if (resolving) return spinner();
    const others = otherDomainsHtml({ resolutions: nameResolutions, selectedTld });
    if (resolved) {
      return `${resolvedName ? `<small class="kl-green">✓ Resolved: ${esc(resolvedName)}</small><br>` : ""}<span class="kl-mono">${esc(resolved.address)}</span>${others}`;
    }
    if (resolveError) return `<small class="kl-red">${esc(resolveError)}</small>${others}`;
    return others;
  };
  /** Takes one service's answer as the new owner: its address must be a Schnorr key, the only kind
   *  a name can be locked to. False when it isn't. */
  const use = (resolution) => {
    const address = String(resolution?.address || "").toLowerCase();
    const key = address ? keyOf(address) : null;
    if (!key) return false;
    try { validateKey(key, ""); } catch { return false; }
    resolved = { address, key };
    resolvedName = resolution.name || null;
    selectedTld = resolution.tld || null;
    resolveError = null;
    return true;
  };
  /** The saved name of the resolved address (else of what is typed), from the Address Book. */
  const savedName = () => {
    try { return addressBookEntry(resolved?.address ?? input.trim())?.name || null; } catch { return null; }
  };
  const showStatus = (sheet) => {
    const el = sheet.layer?.el.querySelector("[data-kl-transfer-status]");
    if (el) { el.innerHTML = statusHtml(); el.hidden = !el.innerHTML.trim(); }
    const saved = sheet.layer?.el.querySelector("[data-kl-transfer-saved]");
    if (saved) {
      const name = savedName();
      saved.innerHTML = name ? `${SEND_ICONS.bookFill}<span>${esc(name)}</span>` : "";
      saved.hidden = !name;
    }
  };
  const resolve = async (sheet) => {
    const mySeq = ++seq;
    resolved = null;
    resolveError = null;
    resolvedName = null;
    nameResolutions = [];
    selectedTld = null;
    const t = input.trim().toLowerCase();
    if (!t) { showStatus(sheet); sheet.update(); return; }
    if (t.startsWith("kaspatest:") || t.startsWith("kaspa:")) {
      const key = keyOf(t);
      if (!key) resolveError = "Not a testnet Schnorr address.";
      else {
        try { validateKey(key, ""); resolved = { address: t, key }; } catch { resolveError = "That address's key is not valid."; }
      }
      showStatus(sheet);
      sheet.update();
      return;
    }
    // a name on any service, .kachat first (the ending typed, else .kachat, .kas, .k, .kaspa) - a
    // .kachat name in grace still points to its owner, like everywhere else it resolves (f7c371a)
    if (!looksLikeName(t)) {
      resolveError = "Enter an address or a domain.";
      showStatus(sheet);
      sheet.update();
      return;
    }
    resolving = true;
    showStatus(sheet);
    sheet.update();
    try {
      const { results, resolution } = await kachatNames().engine.lookUpName(t);
      if (mySeq !== seq) return;
      nameResolutions = results || [];
      if (resolution) {
        if (!use({ address: resolution.ownerAddress, name: resolution.domain, tld: resolution.tld })) resolveError = "That name's address can't own a .kachat name.";
      } else {
        resolveError = "No domain found by that name.";
      }
    } catch {
      if (mySeq !== seq) return;
      resolveError = "Couldn't look that name up.";
    }
    resolving = false;
    showStatus(sheet);
    sheet.update();
  };
  /** What Paste, Scan QR or the Address Book put in the field: resolved at once. */
  const setInput = (sheet, value) => {
    const text = String(value ?? "").trim();
    if (!text || sheet.closed || sheet.sending || sheet.txId) return;
    const el = sheet.layer?.el.querySelector("[data-kl-transfer-input]");
    if (el) el.value = text;
    input = text;
    clearTimeout(timer);
    resolving = false;
    resolve(sheet);
  };
  const iconButton = (attr, label, icon) =>
    `<button type="button" class="sk-icon-button" ${attr} aria-label="${esc(label)}" title="${esc(label)}">${icon}</button>`;
  openTxSheet({
    owner,
    title: "Transfer",
    confirmTitle: "Transfer",
    warning: "A transfer can't be undone. The new owner gets the name with its current expiry; your profile stays with your address.",
    inputsHtml: cardHtml(`
      <div class="sk-recipient-row">
        <span class="sk-recipient-field">
          <input class="sk-recipient-input" type="text" placeholder="kaspatest:... or domain" autocomplete="off" autocapitalize="none"
            autocorrect="off" spellcheck="false" data-kl-transfer-input aria-label="New owner" />
        </span>
        ${iconButton("data-kl-transfer-paste", "Paste", SEND_ICONS.paste)}
        ${iconButton("data-kl-transfer-scan", "Scan QR", SEND_ICONS.scan)}
        ${iconButton("data-kl-transfer-book", "Address Book", SEND_ICONS.book)}
      </div>
      <p class="sk-saved-name" data-kl-transfer-saved hidden></p>
      <div class="kl-transfer-status" data-kl-transfer-status hidden></div>`, {
      title: "New owner",
      footerHtml: cardNote("An address or a domain - .kachat names are looked up first, and it's resolved to the address shown."),
    }),
    rows: () => [{ title: "Name", value: info.display }, ...(resolved ? [{ title: "To", value: resolved.address }] : [])],
    operation: () => (resolved ? Operation.transfer(info, resolved.key) : null),
    operationKey: () => resolved?.address ?? "-",
    onInput(event, sheet) {
      const el = event.target.closest("[data-kl-transfer-input]");
      if (!el) return;
      input = el.value;
      clearTimeout(timer);
      seq += 1;
      resolving = false;
      timer = setTimeout(() => resolve(sheet), 400);
    },
    async onClick(event, sheet) {
      // A pick under Other domains: that service's answer becomes the new owner (iOS 6ac48a7).
      const otherDomain = pickOtherDomain(event, nameResolutions);
      if (otherDomain) {
        if (!use(otherDomain)) resolveError = "That name's address can't own a .kachat name.";
        showStatus(sheet);
        sheet.update();
        return;
      }
      if (event.target.closest("[data-kl-transfer-paste]")) {
        let text = null;
        try { text = await navigator.clipboard?.readText?.(); } catch { text = null; }
        setInput(sheet, text);
        return;
      }
      if (event.target.closest("[data-kl-transfer-scan]")) {
        let scanned = null;
        try {
          scanned = await scanKaspaAddress({
            title: "Scan QR",
            hint: "Point the camera at the new owner's address QR code.",
            manualLabel: "Address or domain",
            manualPlaceholder: "kaspatest:... or domain",
          });
        } catch { scanned = null; }
        // normalizeScannedKaspaAddress already dropped a ?amount=... query
        if (scanned) setInput(sheet, String(scanned).split("?")[0]);
        return;
      }
      if (event.target.closest("[data-kl-transfer-book]")) {
        let entry = null;
        try { entry = await pickFromAddressBook(); } catch { entry = null; }
        if (entry?.address) setInput(sheet, entry.address);
      }
    },
  });
}

function openReleaseSheet(info, owner) {
  openTxSheet({
    owner,
    title: "Release Name",
    confirmTitle: "Release",
    warning: "Releasing gives the name up for good: it becomes free for anyone to register, and the time you paid for is lost. You get the bond and the registry deposit back.",
    rows: () => [{ title: "Name", value: info.display }],
    operation: () => Operation.release(info),
    operationKey: () => `release-${txKey(info)}`,
  });
}

/** KachatOfferAction: withdraw, refund, accept or decline an offer. `embedded` (iOS 7f50e84
 *  form(embedded:)): opened from the offer's half sheet - Back, not Cancel, leads back to it;
 *  `onSent(txId)` once it was sent and its sheet (and receipt) closed. */
function openOfferActionSheet(kind, offer, nameInfo, owner, { embedded = false, onSent = null } = {}) {
  const flow = {
    ...(embedded ? { back: () => {} } : {}),
    onClose: (txId) => { if (txId) { try { onSent?.(txId); } catch { /* fine */ } } },
  };
  if (kind === "decline") {
    const buyer = addressOf(offer.buyer);
    openTxSheet({
      ...flow,
      owner, title: "Decline Offer", confirmTitle: "Decline", doneTitle: "Offer declined",
      footer: () => "The offer goes back to the buyer. Its network fee comes out of the offer, so declining costs you nothing.",
      rows: () => [{ title: "Offer", value: amountText(offer.amount) }, { title: "Buyer", value: buyer ? shortAddr(buyer) : "" }],
      operation: () => Operation.decline(offer), operationKey: () => `decline-${offer.id}`,
    });
    return;
  }
  if (kind === "withdraw") {
    openTxSheet({
      ...flow,
      owner, title: "Withdraw Offer", confirmTitle: "Withdraw",
      rows: () => [{ title: "Offer", value: amountText(offer.amount) }],
      operation: () => Operation.withdraw(offer), operationKey: () => offer.id,
    });
  } else if (kind === "refund") {
    openTxSheet({
      ...flow,
      owner, title: "Refund Offer", confirmTitle: "Refund",
      rows: () => [{ title: "Offer", value: amountText(offer.amount) }],
      operation: () => Operation.refund(offer), operationKey: () => offer.id,
    });
  } else if (kind === "accept" && nameInfo) {
    const buyer = addressOf(offer.buyer);
    openTxSheet({
      ...flow,
      owner, title: "Accept Offer", confirmTitle: "Accept and Transfer",
      warning: "The name goes to the buyer and the offer's amount comes to you, in one transaction. This can't be undone.",
      rows: () => [
        { title: "Name", value: nameInfo.display },
        { title: "Offer", value: amountText(offer.amount) },
        { title: "Buyer", value: buyer ? shortAddr(buyer) : "" },
      ],
      operation: () => Operation.accept(offer, nameInfo), operationKey: () => offer.id,
    });
  }
}

// ---------------------------------------------------------------------------------------------
// Offers: square tiles and their accept / decline half sheet (iOS 7f50e84)
// ---------------------------------------------------------------------------------------------

/**
 * What an offer is and what this wallet can do with it - shared by its tile and its half sheet
 * (iOS KachatOfferState). `args`: `{ offer, isBuyer, isOwner, nameInfo, declined }` - `declined`:
 * made before the name changed hands (registry v3), never acceptable, on its way back to the buyer.
 */
function offerState({ offer, isBuyer = false, isOwner = false, nameInfo = null, declined = false }) {
  const actions = kachatNames()?.actions;
  const daa = actions?.virtualDaa ?? null;
  const refundable = daa != null && offer.refundable(daa);
  const returning = Boolean(actions?.returningOffers?.has(offer.id));
  /** declined and being pulled back by this app (the buyer's) */
  const withdrawing = Boolean(actions?.withdrawingOffers?.has(offer.id));
  // ...and the name itself still active: an expired name would reach the buyer only to be
  // reclaimed (iOS 71128c4, IOS-055)
  const nameActive = Boolean(nameInfo && nameInfo.status(graceMs()) === Status.active);
  let statusText = null;
  if (declined || withdrawing) {
    statusText = isBuyer ? "Declined - the name changed hands, returning to you" : "Declined - made to an earlier owner";
  } else if (refundable) {
    statusText = returning || isOwner ? (isBuyer ? "Expired - returning to you" : "Expired - returning to the buyer") : "Expired - refundable now";
  }
  return {
    offer, isBuyer, isOwner, nameInfo, declined, refundable, returning, withdrawing,
    /** the owner can take it: still inside its time (an expired one is on its way back), and the name still active */
    acceptable: isOwner && !refundable && !declined && nameActive,
    dimmed: refundable || declined || withdrawing,
    /** anyone may send an expired offer back; this app does it on its own for its own offers */
    canRefund: refundable && !returning,
    buyerAddress: addressOf(offer.buyer),
    /** "2d 21h" until it can be refunded, null once it can */
    timeLeft: offerTimeLeft(offer, daa),
    statusText,
  };
}

/** One offer as a square tile (iOS KachatOfferTile): the amount, who made it ("Your offer" or the
 *  buyer), the name on tiles shown away from its page (My Offers), and "Expires in ..." or its
 *  expired / declined state in orange. A click opens its half sheet. */
function offerTileHtml(state, { showsName = false } = {}) {
  const { offer } = state;
  rememberOffer(offer);
  if (state.nameInfo) rememberName(state.nameInfo);
  const who = state.isBuyer ? "Your offer" : state.buyerAddress ? shortAddr(state.buyerAddress) : "";
  const line = state.statusText
    ? `<small class="kl-offer-tile-status kl-orange">${esc(state.statusText)}</small>`
    : state.timeLeft ? `<small class="kl-offer-tile-left kmkt-muted">${esc(`Expires in ${state.timeLeft}`)}</small>` : "";
  return `
    <button class="kmkt-card kl-tile kl-offer-tile${state.dimmed ? " kl-offer-dim" : ""}" type="button" data-kl-offer-open="${esc(offer.id)}"
      aria-label="${esc(`${amountText(offer.amount)}${who ? `, ${who}` : ""}`)}">
      <span class="kl-offer-tile-icon">${kit.ICON.hand}</span>
      <strong class="kl-offer-tile-amount">${esc(amountText(offer.amount))}</strong>
      ${showsName && offer.name ? `<span class="kl-offer-tile-name">${esc(`${offer.name}.kachat`)}</span>` : ""}
      ${who ? `<small class="kl-offer-tile-who">${esc(who)}</small>` : ""}
      ${line}
    </button>`;
}

/**
 * An offer's half sheet (iOS KachatOfferDetailSheet): the amount, who made it (click to copy), the
 * time left, and what this wallet can do - Accept or Decline (the name's owner), Withdraw or Refund
 * (the buyer), Refund (anyone, once expired). Each opens its transaction over this sheet (Back
 * returns here); once it is sent and its receipt closes, this sheet closes too. `args` as
 * `offerState`; the state is read again on every repaint (the DAA score, offers going back).
 */
function openOfferDetailSheet(args, owner = "market") {
  if (!kit) return null;
  let copied = false;
  let copiedTimer = null;
  let unsubscribe = null;
  const actionButton = (kind, title, icon, { prominent = false, danger = false } = {}) => `
    <button class="kl-offer-action${prominent ? " prominent" : ""}${danger ? " danger" : ""}" type="button" data-kl-offer-do="${esc(kind)}">
      ${icon}<span>${esc(title)}</span>
    </button>`;
  const actionsHtml = (st) => {
    if (st.acceptable) {
      return actionButton("accept", "Accept", LI.checkCircle, { prominent: true })
        + actionButton("decline", "Decline", LI.xCircle, { danger: true });
    }
    if (st.isBuyer) {
      return actionButton("withdraw", "Withdraw", LI.uturn, { prominent: !st.canRefund })
        + (st.canRefund ? actionButton("refund", "Refund", LI.reclaim, { prominent: true }) : "");
    }
    if (st.canRefund) return actionButton("refund", "Refund", LI.reclaim, { prominent: true });
    return `<p class="kl-tx-note kmkt-muted">${esc(st.isOwner ? "This offer can't be accepted any more." : "Only the name's owner can accept or decline this offer.")}</p>`;
  };
  const body = () => {
    const st = offerState(args);
    const name = st.offer.name ?? st.nameInfo?.name ?? null;
    let from = "";
    if (st.isBuyer) from = `<strong>You</strong>`;
    else if (st.buyerAddress) {
      from = `<button class="kl-offer-from" type="button" data-kl-offer-copy title="${esc(st.buyerAddress)}" aria-label="${esc(st.buyerAddress)}"
          aria-description="Copies the address">
          <span class="kl-mono">${esc(shortAddr(st.buyerAddress))}</span><span class="kl-owner-copy-icon">${copied ? LI.check : LI.copy}</span>
        </button>`;
    }
    return `
      ${navHtml("Offer", { leading: { label: "Close" } })}
      <div class="kmkt-sheet-body kl-offer-sheet">
        <div class="kl-offer-head">
          <span class="kl-offer-head-icon">${kit.ICON.hand}</span>
          <strong class="kl-offer-head-amount">${esc(amountText(st.offer.amount))}</strong>
          ${name ? `<span class="kl-offer-head-name">${esc(`${name}.kachat`)}</span>` : ""}
        </div>
        ${cardHtml(`
          ${formRow("From", "", { valueHtml: `<span class="kl-form-value">${from}</span>` })}
          ${st.timeLeft ? formRow("Expires in", st.timeLeft) : ""}
          ${st.statusText ? `<p class="kl-tx-note kl-orange">${esc(st.statusText)}</p>` : ""}`)}
        <div class="kl-offer-actions">${actionsHtml(st)}</div>
      </div>`;
  };
  const layer = kit.openLayer({
    owner,
    kind: "sheet",
    label: "Offer",
    html: body(),
    onClick(event, l) {
      if (event.target.closest("[data-kl-offer-copy]")) {
        const address = addressOf(args.offer.buyer);
        if (address) {
          try { navigator.clipboard?.writeText(address); } catch { /* clipboard blocked */ }
          copied = true;
          repaint();
          clearTimeout(copiedTimer);
          copiedTimer = setTimeout(() => { copied = false; repaint(); }, 1500);
        }
        return;
      }
      const act = event.target.closest("[data-kl-offer-do]");
      if (act) {
        // the transaction over this sheet; once sent (and its receipt closed) the offer is settled
        openOfferActionSheet(act.dataset.klOfferDo, args.offer, args.nameInfo, owner, {
          embedded: true,
          onSent: () => { if (layer.el.isConnected) kit.closeLayer(l); },
        });
      }
    },
    onClose() {
      clearTimeout(copiedTimer);
      try { unsubscribe?.(); } catch { /* gone */ }
    },
  });
  function repaint() {
    const sheetEl = layer.el.querySelector(".kmkt-sheet");
    if (sheetEl && layer.el.isConnected) sheetEl.innerHTML = body();
  }
  // the time left and what this app is sending back move on their own
  const a = kachatNames()?.actions;
  if (a?.subscribe) {
    const sig = () => `${a.virtualDaa}|${a.returningOffers?.size ?? 0}|${a.withdrawingOffers?.size ?? 0}`;
    let last = sig();
    unsubscribe = a.subscribe(() => { const now = sig(); if (now !== last) { last = now; repaint(); } });
  }
  return layer;
}

// ---------------------------------------------------------------------------------------------
// Claim (KachatClaimSheet)
// ---------------------------------------------------------------------------------------------

/** The claim sheet, in the Send screens' style (iOS KachatClaimSheet, e426432): the name and its
 *  years, the cost, a fee speed for both transactions (the commit now, the register about a minute
 *  later; a busy network starts on Fast unless the person chose), what's available, how claiming
 *  works, and slide to claim - then the device lock. */
function openClaimSheet({ name, gap, owner = "market" }) {
  const rt = kachatNames();
  if (!rt || !kit) return;
  let years = 1;
  let feeTier = FeeTier.normal;
  /** the person picked a speed: a busy network no longer moves it for them */
  let feeTouched = false;
  let quote = null;
  /** the speed `quote` was priced at */
  let quoteTier = null;
  let quoteError = null;
  /** registry v5 before its migration deadline: why claiming waits, and until when (iOS dd836cb) */
  let notOpen = null;
  let starting = false;
  let startError = null;
  let seq = 0;
  let closed = false;
  let slide = null;

  const costHtml = () => {
    let rows;
    if (quote) {
      // the first period at the registration price, any further one at the renewal price (registry v4)
      rows = formRow("Price (to miners)", amountText(quote.price))
        + formRow("Bond (returned on release)", amountText(quote.bond))
        + formRow("Registry deposit (returned on release)", amountText(quote.gapDeposit))
        + formRow("Commit (returned at registration)", amountText(quote.commit))
        + formRow("Network fees", amountText(quote.networkFee))
        + `<div class="sk-divider" aria-hidden="true"></div>`
        + formRow("Total", amountText(quote.total), { bold: true });
    } else if (quoteError) {
      rows = `<p class="kl-tx-note kl-red">${esc(quoteError)}</p>`;
    } else if (notOpen) {
      rows = formRow("Total", "", { valueHtml: `<span class="kl-form-value kmkt-muted">-</span>` });
    } else {
      rows = formRow("Total", "", { valueHtml: spinner() });
    }
    return cardHtml(rows, { cls: "kl-rows-card" });
  };

  const notOpenHtml = () => (notOpen
    ? cardHtml(`
        <div class="kl-notopen-row"><span class="kl-orange">${LI.clock}</span><span>${esc(notOpen)}</span></div>
        ${cardNote("Every name from the old registry comes over with the same owner and expiry first.")}`)
    : "");

  const footHtml = () => (quote && !quote.affordable
    ? `<p class="kl-tx-note kl-red">${esc(kasLabel("Not enough KAS on your chatting address for this name."))}</p>`
    : `<p class="kl-tx-note kmkt-muted">The price goes to the miners - KaChat takes nothing. The bond and the deposit come back when you release the name.</p>`);

  const step = (n, text) => `
    <div class="kl-step-row kl-card-step">
      <span class="kl-step-num">${n}</span>
      <span class="kl-label-text">${esc(text)}</span>
    </div>`;

  let layer = null;
  const render = () => {
    if (closed || !layer) return;
    const q = (sel) => layer.el.querySelector(sel);
    const waiting = q("[data-kl-claim-notopen]");
    if (waiting) waiting.innerHTML = notOpenHtml();
    const cost = q("[data-kl-claim-cost]");
    if (cost) cost.innerHTML = costHtml();
    const busy = q("[data-kl-claim-busy]");
    if (busy) busy.innerHTML = rt.actions.feeEstimate?.isBusy ? busyNoticeHtml() : "";
    const pills = q("[data-kl-claim-pills]");
    if (pills) pills.innerHTML = quote ? infoPillHtml({ innerHtml: `<span class="sk-pill-value">${esc(`Available: ${amountText(quote.spendable)}`)}</span>` }) : "";
    const foot = q("[data-kl-claim-foot]");
    if (foot) foot.innerHTML = footHtml();
    const error = q("[data-kl-claim-error]");
    if (error) error.innerHTML = startError ? `<p class="kl-tx-note kl-red">${esc(startError)}</p>` : "";
    const inputs = q("[data-kl-claim-inputs]");
    if (inputs) inputs.disabled = starting;
    slide?.setEnabled(quote?.affordable === true && quoteTier === feeTier && !starting);
  };

  const loadQuote = async () => {
    const mySeq = ++seq;
    quote = null;
    quoteTier = null;
    quoteError = null;
    notOpen = null;
    render();
    const tier = feeTier;
    try {
      const q = await rt.actions.quote({ name, years: BigInt(years), gap, feeTier: tier });
      if (mySeq !== seq || closed) return;
      quote = q;
      quoteTier = tier;
    } catch (error) {
      if (mySeq !== seq || closed) return;
      if (error?.code === "registrationNotOpen") notOpen = errorText(error);
      else quoteError = errorText(error);
    }
    render();
  };

  const start = async () => {
    if (starting || quote?.affordable !== true) return;
    // the price shown is the most the registration will ever pay (iOS 4f5d95e, IOS-054), at the
    // speed it was quoted at
    const q = quote;
    const tier = quoteTier;
    if (q.years !== BigInt(years) || tier !== feeTier) return;
    if (!(await deviceLock())) return;
    if (closed || quote !== q) return;
    starting = true;
    startError = null;
    slide?.setBusy(true);
    render();
    try {
      const commitTxId = await rt.actions.startRegistration({ name, years: q.years, maxPrice: q.price, feeTier: tier });
      starting = false;
      slide?.setBusy(false);
      // the claim becomes its progress half sheet; closing that leaves the claim running (iOS b219bb0)
      const started = rt.actions.pending.find((x) => x.commitTxId === commitTxId)
        ?? [...rt.actions.pending].reverse().find((x) => x.name === name && isOpen(x));
      kit.closeLayer(layer);
      if (started) openRegistrationProgress(started.id);
      return;
    } catch (error) {
      startError = errorText(error);
    }
    starting = false;
    slide?.setBusy(false);
    render();
  };

  const tierOptions = [
    { id: FeeTier.normal, title: "Normal" },
    { id: FeeTier.fast, title: "Fast" },
    { id: FeeTier.priority, title: "Priority" },
  ];

  layer = kit.openLayer({
    owner,
    kind: "tall",
    label: "Claim Name",
    html: `
      ${navHtml("Claim Name", { leading: { label: "Cancel" } })}
      <div class="kmkt-sheet-body kl-tx-body kl-send-sheet">
        <fieldset class="kl-fieldset kl-cards" data-kl-claim-inputs>
          ${cardHtml(`
            ${formRow("Name", `${name}.kachat`, { bold: true })}
            ${segmentedHtml("years", yearsOptions(), years, "Years")}`)}
        </fieldset>
        <div data-kl-claim-notopen></div>
        <div data-kl-claim-cost></div>
        <div data-kl-claim-busy></div>
        ${cardHtml(`
          <span class="sk-fee-title">Network Fee</span>
          ${segmentedHtml("fee", tierOptions, feeTier, "Network fee speed")}
          ${cardNote("Claiming sends two transactions: the commit now, the registration about a minute later. Both use this speed.")}`)}
        <div class="sk-pills kl-pills" data-kl-claim-pills></div>
        ${cardHtml(
          step(1, "A hidden commit goes on chain first. Nobody can see which name it is for.")
          + step(2, "About a minute later KaChat registers the name by itself. Keep the app open; if you leave, it continues next time.")
          + step(3, yearlyPeriods()
            ? "The name is yours for the years you paid, at most 2 ahead. A 1-year name can be extended to 2 years; from 10 days before it expires you can renew it."
            : `The name is yours for the time you paid, at most ${periodsText(maxYears())} ahead. From ${durationText(Number(params()?.renewWindowMs ?? 0n))} before it expires you can renew it.`),
          { title: "How claiming works" },
        )}
        <div data-kl-claim-foot></div>
        <div class="kl-tx-action">${sendActionButtonHtml({ attr: "kl-claim-slide", title: `Claim ${name}.kachat`, disabled: true })}</div>
        <div data-kl-claim-error></div>
      </div>`,
    onClick(event, l) {
      if (event.target.closest("[data-kl-claim-slide]")) return;
      const chosen = segmentedClick(event, l.el);
      if (!chosen || starting) return;
      if (chosen.group === "years" && Number(chosen.id) !== years) { years = Number(chosen.id); loadQuote(); }
      if (chosen.group === "fee") {
        feeTouched = true;
        if (chosen.id !== feeTier) { feeTier = chosen.id; loadQuote(); }
      }
    },
    onClose() { closed = true; },
  });
  slide = createSendActionButton(layer.el.querySelector("[data-kl-claim-slide]"), { onAction: () => { start(); }, busyLabel: "Claiming…" });
  render();
  loadQuote();
  // A busy network starts on Fast unless the person already chose (iOS e426432).
  rt.actions.refreshFeeEstimate?.().then((estimate) => {
    if (closed) return;
    if (estimate?.isBusy && !feeTouched && feeTier === FeeTier.normal) {
      feeTier = FeeTier.fast;
      layer.el.querySelectorAll('[data-kl-seg-group="fee"] [data-kl-seg]').forEach((b) => {
        const on = b.dataset.klSeg === feeTier;
        b.classList.toggle("active", on);
        b.setAttribute("aria-checked", String(on));
      });
      loadQuote();
    } else {
      render();
    }
  }).catch(() => { /* priced at Normal */ });
}

// ---------------------------------------------------------------------------------------------
// Name detail (KachatLiveNameDetail)
// ---------------------------------------------------------------------------------------------

/**
 * A registered name, live: who owns it, its status and expiry, its price, and what the person can
 * do with it. mode "market": the .kachat screen's own page (host = the screen, header with Back);
 * mode "layer": a full sheet (host = the sheet element, Close). Call attach() once it is on screen,
 * detach() when it goes off, destroy() when it is gone for good.
 */
export function createNameDetail(initial, { mode = "market", owner = "market", host, layer = null } = {}) {
  const d = {
    info: rememberName(initial),
    ownerLabel: null,
    offers: [],
    history: [],
    gone: false,
    primaryWorking: false,
    primaryMessage: null,
    refreshing: false,
    /** the Owner card's address was just copied (a checkmark for 1.5 s) */
    ownerCopied: false,
    ownerCopiedTimer: null,
    /** the Manage Name sheet is up (one at a time) */
    managing: false,
    active: true,
    layer,
    unsubscribe: [],
    /** Which of this wallet's addresses holds the name (iOS 881ada6 heldBy): `{ kind: "chatting" }`,
     *  `{ kind: "spending", index, address }`, `{ kind: "kasSigner", account, index, address }`, or
     *  null for someone else's. Resolved again on every reload (the name may move). */
    heldBy: null,
    /** The free gap the name sits in once it's gone (released or reclaimed; iOS f420343), or the
     *  one claiming an expired name reopens (registry.claimGap, iOS eea52b2): Claim uses it. */
    freeGap: null,
  };
  const rt = () => kachatNames();
  const resolveHeldBy = () => {
    try { d.heldBy = rt()?.actions.ownAddress?.(d.info.owner) ?? null; } catch { d.heldBy = null; }
  };
  resolveHeldBy();
  /** Held by the chatting address: the identity, so "Set as Primary" applies. */
  const mine = () => d.heldBy?.kind === "chatting" || (d.heldBy == null && isMine(d.info.owner));
  /** Held by an address this app can sign for (chatting or spending): every owner action. */
  const canActAsOwner = () => mine() || d.heldBy?.kind === "spending";
  /** Held by any of this wallet's addresses - never offered Buy / Make an Offer. */
  const ownedByWallet = () => d.heldBy != null || mine();
  const status = () => d.info.status(graceMs());
  /** Free to claim: released or reclaimed, or expired past grace - claiming frees the old record
   *  first (iOS eea52b2). */
  const isFree = () => d.gone || status() === Status.lapsed;
  const ownerAddress = () => addressOf(d.info.owner);

  /** The name's art and, under it, what it is now: free to claim once it's gone (released or
   *  reclaimed) or expired past grace - the old record (its expiry, period, listing) is history;
   *  iOS f420343 / eea52b2, with b799091's price line - else the live record. */
  const nameCard = () => {
    if (isFree()) {
      const price = priceOf(d.info.name);
      const priceLine = price == null ? ""
        : yearlyPeriods() ? `Available · ${amountText(price)} a year` : `Available · ${amountText(price)} per ${periodsText(1)}`;
      return `
        <section class="kmkt-card kmkt-name-card">
          <div class="kmkt-name-art"><span class="kl-name-art-text">${esc(d.info.display)}</span></div>
          <div class="kl-free-line">
            <span class="kmkt-muted">Free to claim</span>
            <span class="kl-available-pill">Available</span>
          </div>
          ${priceLine ? `<small class="kmkt-muted kl-free-price">${esc(priceLine)}</small>` : ""}
        </section>`;
    }
    return recordCard();
  };

  /** The live record: price, status, expiry, paid period, and what expiry means. */
  const recordCard = () => {
    const s = status();
    // A listing only stands while the name is active: an expired name's old asking price is
    // never shown - it can't be bought, only renewed (or, past grace, claimed; iOS ba1a734).
    const forSale = d.info.isListed && s === Status.active;
    let note = "";
    if (s === Status.grace && ownedByWallet()) note = `<p class="kl-note-inline kl-orange">Expired - renew to keep it. Until the grace period ends it still resolves to you and nobody else can take it.</p>`;
    else if (s === Status.grace) note = `<p class="kl-note-inline kl-orange">Expired. It still resolves to its owner until the grace period ends, and the owner can still renew it.</p>`;
    // the paid period, from its start to the expiry (at most maxYears periods)
    const period = d.info.periodStart != null
      ? `<p class="kl-period">${LI.calendar}<span>${esc(`Paid from ${dayText(d.info.periodStart)} to ${dayText(d.info.expiresAt)}`)}</span></p>`
      : "";
    // in grace: when it ends, and a live countdown to it - then anyone can claim it (iOS fde757f)
    const graceEnds = s === Status.grace ? d.info.expiresAt + graceMs() : null;
    const graceLine = graceEnds != null
      ? `<p class="kl-grace-line kl-orange">${LI.hourglass}<span class="kl-grace-copy">
          <span>${esc(`Grace period ends ${dayText(graceEnds)}`)}</span>
          <span>Released in ${countdownHtml(graceEnds)}</span>
        </span></p>`
      : "";
    return `
      <section class="kmkt-card kmkt-name-card">
        <div class="kmkt-name-art"><span class="kl-name-art-text">${esc(d.info.display)}</span></div>
        <div class="kmkt-price-line">
          <div class="kmkt-price">
            <small>${forSale ? "Price" : "Not for sale"}</small>
            ${forSale ? `<strong class="kl-price">${esc(amountText(d.info.price))}</strong>` : ""}
          </div>
          <div class="kl-expiry">
            ${statusPill(s)}
            <small class="kmkt-muted">${esc(`Expires ${dayText(d.info.expiresAt)}`)}</small>
          </div>
        </div>
        ${period}
        ${graceLine}
        ${note}
      </section>`;
  };

  const actionButton = (title, icon, act, { prominent = false, disabled = false, danger = false } = {}) => `
    <button class="${prominent ? "primary-button" : danger ? "secondary-button kl-danger" : "secondary-button accent"} kmkt-action" type="button"
      data-kl-act="${esc(act)}" ${disabled ? "disabled" : ""}>${icon}<span>${esc(title)}</span></button>`;

  /** The owner's actions, as tiles in the Manage Name sheet (iOS manageItems): "Extend" while the
   *  paid period holds less than maxYears periods ("Extend to 2 years" when that fills it), "Renew"
   *  once the renewal window is open - otherwise the sheet says when it opens -, List for Sale or
   *  Change Price and Delist, Transfer, Set as Primary (the chatting address's names only), Release. */
  const manageItems = () => {
    const s = status();
    const I = kit.ICON;
    const items = [];
    const p = params();
    if (p) {
      const extendable = extendableYears(d.info, p);
      if (extendable > 0n) {
        const fills = fillsPeriod(d.info, extendable, p);
        const title = !fills ? "Extend" : yearlyPeriods() ? `Extend to ${p.maxYears} years` : `Extend to ${periodsText(p.maxYears)}`;
        const subtitle = yearlyPeriods() ? "Pays for more years now, up to the 2-year limit."
          : `Pays for more time now, up to the ${periodsText(p.maxYears)} limit.`;
        items.push({ id: "extend", title, subtitle, icon: LI.calendarPlus });
      }
      if (renewalOpen(d.info, p)) {
        items.push({ id: "renew", title: "Renew", subtitle: "Starts a new paid period from the expiry date.", icon: LI.refresh });
      }
    }
    if (d.info.isListed) {
      items.push({ id: "list", title: "Change Price", subtitle: "Changes the asking price.", icon: I.tag, disabled: s !== Status.active });
      items.push({ id: "delist", title: "Delist", subtitle: "Takes the name off the market.", icon: LI.tagSlash });
    } else {
      items.push({ id: "list", title: "List for Sale", subtitle: "Puts the name up for sale at your price.", icon: I.tag, disabled: s !== Status.active });
    }
    items.push({ id: "transfer", title: "Transfer", subtitle: "Sends the name to another address.", icon: I.swap });
    // The primary name is the chatting address's identity: a name on a spending address can't be it.
    if (mine()) {
      items.push({
        id: "primary", title: "Set as Primary", subtitle: "Shows you by this name across KaChat.", icon: LI.personCheck,
        disabled: s !== Status.active || d.primaryWorking,
      });
    }
    items.push({ id: "release", title: "Release Name", subtitle: "Gives the name up and returns its deposit.", icon: LI.trash, destructive: true });
    return items;
  };

  /** The Manage Name half sheet (iOS manageSheet): the name, "Renewal opens on <date>" while it
   *  hasn't, and the owner's actions as tiles; the picked one opens once the sheet has gone. */
  const openManage = async () => {
    if (d.managing) return;
    const p = params();
    const note = p && !renewalOpen(d.info, p) ? renewalOpensText(d.info, p) : "";
    d.managing = true;
    let choice = null;
    try {
      choice = await chooseDialog({ title: d.info.display, message: note, layout: "tiles", options: manageItems() });
    } finally {
      d.managing = false;
    }
    if (!choice || !d.active) return;
    runAction(choice);
  };

  const actionButtons = () => {
    const s = status();
    const I = kit.ICON;
    if (canActAsOwner()) {
      const p = params();
      // Expired (in grace) and renewable: the one thing that matters now stays on the page instead
      // of inside the menu. (A name past grace shows as free to claim, iOS eea52b2.)
      let first = "";
      if (s !== Status.active && p && renewalOpen(d.info, p)) first = actionButton("Renew", LI.refresh, "renew", { prominent: true });
      // Every owner action lives in one half sheet of tiles.
      return `
        <div class="kl-action-grid">
          ${first ? `<div class="kmkt-actions">${first}</div>` : ""}
          <div class="kmkt-actions">${actionButton("Manage Name", LI.sliders, "manage", { prominent: s === Status.active })}</div>
        </div>`;
    }
    // A KasSigner address holds it: read-only here (the Owner card says which); acting on it is the
    // device's job.
    if (d.heldBy?.kind === "kasSigner") return "";
    // an expired name is free to claim soon: no offers on it
    return `
      <div class="kl-action-grid">
        <div class="kmkt-actions">
          ${d.info.isListed && s === Status.active ? actionButton("Buy Now", I.cart, "buy", { prominent: true }) : ""}
          ${s === Status.active ? actionButton("Make an Offer", I.hand, "offer") : ""}
        </div>
      </div>`;
  };

  const ownerCard = () => {
    const address = ownerAddress();
    const held = d.heldBy;
    let label = "";
    if (mine()) label = "You";
    else if (held?.kind === "spending") label = `Your spending address #${held.index}`;
    else if (held?.kind === "kasSigner") label = held.account ? `Your KasSigner address (${held.account} #${held.index})` : `Your KasSigner address #${held.index}`;
    else if (d.ownerLabel) label = `${d.ownerLabel}.kachat`;
    return `
      <section class="kmkt-block">
        ${kit.sectionHeader("Owner")}
        <div class="kmkt-card kmkt-seller kl-owner">
          <span class="kl-owner-icon">${kit.ICON.personCircle}</span>
          <div class="kmkt-seller-copy">
            ${label ? `<strong>${esc(label)}</strong>` : ""}
            ${address ? `
              <button class="kl-owner-address" type="button" data-kl-copy-owner title="${esc(address)}" aria-label="${esc(address)}"
                aria-description="Copies the address">
                <span class="kl-mono">${esc(compactAddress(address))}</span>
                <span class="kl-owner-copy-icon">${d.ownerCopied ? LI.check : LI.copy}</span>
              </button>` : ""}
          </div>
          ${!ownedByWallet() && address
            // a fixed round button: as a bordered "Message" label it was squeezed by the address
            // beside it into a tall, empty capsule (iOS 395863e)
            ? `<button class="kl-owner-message" type="button" data-kl-message aria-label="Message" title="Message">${kit.ICON.bubbles}</button>` : ""}
        </div>
      </section>`;
  };

  /** One offer on this name, as this wallet sees it (iOS offerState): the owner acts on it only
   *  with an indexer; one made to an earlier owner (registry v3) is never acceptable. */
  const offerArgs = (o) => ({
    offer: o, isBuyer: isMine(o.buyer), isOwner: canActAsOwner() && !!rt()?.registry.isIndexer, nameInfo: d.info,
    declined: o.isDeclined(d.info.owner),
  });

  const offersSection = () => {
    // square tiles, two a row; a click opens the offer's half sheet (iOS 7f50e84)
    const list = d.offers.length
      ? kachatNameGridHtml(d.offers.map((o) => offerTileHtml(offerState(offerArgs(o)))).join(""))
      : `<div class="kmkt-card kmkt-empty-card">No open offers.</div>`;
    return `
      <section class="kmkt-block">
        ${kit.sectionHeader("Offers", canActAsOwner() ? "Click an offer to accept or decline it. Expired offers go back to their buyers." : "")}
        ${list}
        ${chainNote()}
      </section>`;
  };

  const historySection = () => {
    const events = d.history.slice(0, 50);
    return `
      <section class="kmkt-block">
        ${kit.sectionHeader("History")}
        ${events.length ? listCard(events.map((e) => eventRowHtml(e)).join(""), 56) : `<div class="kmkt-card kmkt-empty-card">No history yet.</div>`}
      </section>`;
  };

  const contentHtml = () => `
    ${nameCard()}
    ${isFree()
      ? `${d.freeGap ? `<div class="kl-action-grid"><div class="kmkt-actions">${actionButton("Claim", kit.ICON.atPlus, "claim", { prominent: true })}</div></div>` : ""}
         <p class="kl-note">${esc(d.gone
          ? "This name was released or reclaimed. It's free to claim again."
          : "This name expired and wasn't renewed, so anyone can claim it at the normal price. The old owner's bond goes back to them.")}</p>`
      : `${actionButtons()}
         ${d.primaryMessage ? `<p class="kl-note">${esc(d.primaryMessage)}</p>` : ""}
         ${ownerCard()}
         ${offersSection()}`}
    ${historySection()}`;

  const refreshButton = (cls) => `
    <button class="${cls} kl-refresh ${d.refreshing ? "spinning" : ""}" type="button" data-kl-detail-refresh aria-label="Refresh" title="Refresh"
      ${d.refreshing ? "disabled" : ""}>${LI.refresh}</button>`;

  d.html = () => {
    if (mode === "layer") {
      return `
        <header class="kmkt-navbar">
          <button class="kmkt-nav-button leading" type="button" data-kmkt-close>Close</button>
          <h2 class="kmkt-navbar-title">${esc(d.info.display)}</h2>
          <span class="kl-nav-trailing">${refreshButton("kl-nav-icon")}</span>
        </header>
        <div class="kmkt-sheet-body"><div class="kl-detail-body">${contentHtml()}</div></div>`;
    }
    return `
      <div class="kmkt-root kl-detail">
        <div class="kaposts-header kmkt-header with-back">
          <button class="kaposts-icon-button" type="button" data-kmkt-back aria-label="Back">${kit.ICON.back}</button>
          <h1 class="kaposts-title">${esc(d.info.display)}</h1>
          ${refreshButton("kaposts-icon-button")}
        </div>
        ${contentHtml()}
      </div>`;
  };

  d.render = () => {
    if (!d.active) return;
    const el = host?.();
    if (!el || !el.isConnected) return;
    const scroller = () => (mode === "layer" ? el.querySelector(".kmkt-sheet-body") : el);
    const top = scroller()?.scrollTop ?? 0;
    el.innerHTML = d.html();
    const s = scroller();
    if (s) s.scrollTop = top;
  };

  d.reload = async () => {
    const r = rt();
    if (!r || !d.active) return;
    const { registry, actions } = r;
    try {
      const found = await registry.lookup(d.info.name);
      if (found.kind === "registered") {
        d.info = rememberName(found.info);
        d.gone = false;
        // lapsed: free to claim, in the gap claiming it reopens (iOS eea52b2; an if, not a
        // ternary, as iOS 5a4ea36)
        if (found.info.status(graceMs()) === Status.lapsed) {
          try { d.freeGap = await registry.claimGap(found.info); } catch { d.freeGap = null; }
        } else {
          d.freeGap = null;
        }
      } else {
        d.gone = true;
        d.freeGap = found.gap ?? null;
      }
    } catch { /* keep what we have */ }
    resolveHeldBy();
    const address = ownerAddress();
    if (!ownedByWallet() && address) {
      try { d.ownerLabel = (await registry.identity(address))?.label ?? null; } catch { /* no label */ }
    }
    try { d.offers = await registry.offersFor(d.info.name); } catch { d.offers = []; }
    try { d.history = await registry.history(d.info.name); } catch { d.history = []; }
    if (d.offers.length) {
      await actions.refreshVirtualDaa().catch(() => null);
      // Expired offers don't stay on your name: the owner's app (and the buyer's) send them back.
      const expiredToReturn = canActAsOwner() ? d.offers : d.offers.filter((o) => isMine(o.buyer));
      await actions.returnExpiredOffers(expiredToReturn).catch(() => null);
      // Your offers made to an earlier owner of this name: pulled back.
      await actions.withdrawDeclinedOffers(d.offers).catch(() => null);
    }
    d.render();
  };

  d.attach = () => {
    const r = rt();
    if (!r || !d.active) return;
    d.detach();
    d.unsubscribe.push(r.registry.onChange(() => { d.reload(); }));
    // the offer rows follow the DAA score (expiry) and what this app is sending back
    const offerSig = () => {
      const a = r.actions;
      return `${a.virtualDaa}|${a.returningOffers?.size ?? 0}|${a.withdrawingOffers?.size ?? 0}|${a.decliningOffers?.size ?? 0}`;
    };
    let lastSig = offerSig();
    d.unsubscribe.push(r.actions.subscribe(() => {
      const sig = offerSig();
      if (sig !== lastSig) { lastSig = sig; if (d.offers.length) d.render(); }
    }));
    d.reload();
  };

  d.detach = () => {
    for (const u of d.unsubscribe.splice(0)) { try { u(); } catch { /* gone */ } }
  };

  d.destroy = () => {
    d.detach();
    clearTimeout(d.ownerCopiedTimer);
    d.active = false;
  };

  // Set as Primary rewrites the profile record: the same review sheet as saving the profile.
  const setPrimary = async () => {
    const r = rt();
    if (!r || d.primaryWorking) return;
    openProfileSaveSheet({
      title: "Set as Primary", confirmTitle: "Set as Primary", doneTitle: "Primary name set",
      makeProfile: async () => {
        const { registry, actions } = r;
        let base = null;
        const address = actions.myAddress;
        if (address) {
          // the newest profile, wherever it was saved, so the new primary keeps its pictures and bio
          try { await registry.syncOwnProfile?.(address); } catch { /* the device copy stays */ }
          base = (await registry.ownProfile(address))?.profile ?? null;
          if (!base) { try { base = (await registry.identity(address))?.profile ?? null; } catch { base = null; } }
        }
        return new Profile({
          avatar: base?.avatar ?? null, banner: base?.banner ?? null, bio: base?.bio ?? null,
          linktree: base?.linktree ?? null, primaryName: d.info.name,
        });
      },
    });
  };

  /** Opens what an action button or a Manage Name tile names. */
  const runAction = (id) => {
    const info = d.info;
    switch (id) {
      // free (released or reclaimed, or expired past grace): claim it on the gap it sits in, or the
      // one its reclaim reopens - the driver frees the old record first (iOS f420343 / eea52b2)
      case "claim": if (isFree() && d.freeGap) openClaimSheet({ name: info.name, gap: d.freeGap, owner }); break;
      case "buy": openBuySheet(info, owner); break;
      // an expired name is free to claim soon: no offers on it (iOS 71128c4 / eea52b2)
      case "offer": if (info.status(graceMs()) === Status.active) openOfferSheet(info, owner); break;
      case "manage": openManage(); break;
      case "extend": openExtendSheet(info, owner); break;
      case "renew": openRenewSheet(info, owner); break;
      case "list": openListSheet(info, owner); break;
      case "delist": openDelistSheet(info, owner); break;
      case "transfer": openTransferSheet(info, owner); break;
      case "release": openReleaseSheet(info, owner); break;
      case "primary": setPrimary(); break;
      default: break;
    }
  };

  /** Clicks inside the detail. True when handled. */
  d.onClick = (event) => {
    const target = event.target;
    if (target.closest("[data-kl-detail-refresh]")) {
      const r = rt();
      if (!r || d.refreshing) return true;
      d.refreshing = true;
      d.render();
      r.registry.refresh().finally(() => { d.refreshing = false; d.render(); });
      return true;
    }
    const act = target.closest("[data-kl-act]");
    if (act) {
      if (act.disabled) return true;
      runAction(act.dataset.klAct);
      return true;
    }
    if (target.closest("[data-kl-copy-owner]")) {
      const address = ownerAddress();
      if (address) {
        try { navigator.clipboard?.writeText(address); } catch { /* clipboard blocked */ }
        d.ownerCopied = true;
        d.render();
        clearTimeout(d.ownerCopiedTimer);
        d.ownerCopiedTimer = setTimeout(() => { d.ownerCopied = false; d.render(); }, 1500);
      }
      return true;
    }
    if (target.closest("[data-kl-message]")) {
      const address = ownerAddress();
      if (address) {
        if (d.layer) kit.closeLayer(d.layer);
        deps().openChat?.(address);
      }
      return true;
    }
    const offerOpen = target.closest("[data-kl-offer-open]");
    if (offerOpen) {
      const offer = d.offers.find((o) => o.id === offerOpen.dataset.klOfferOpen) ?? offerIndex.get(offerOpen.dataset.klOfferOpen);
      if (offer) openOfferDetailSheet(offerArgs(offer), owner);
      return true;
    }
    return false;
  };

  return d;
}

/** The name detail as a full sheet over whatever screen asked (Your Domains). */
export function openNameDetailLayer(info, owner = "domains") {
  if (!kit || !kachatNames()) return null;
  let detail = null;
  let sheetEl = null;
  const layer = kit.openLayer({
    owner,
    kind: "cover",
    label: info.display,
    html: "",
    onClick(event) { detail?.onClick(event); },
    onClose() { detail?.destroy(); },
  });
  sheetEl = layer.el.querySelector(".kmkt-sheet");
  detail = createNameDetail(info, { mode: "layer", owner, host: () => sheetEl, layer });
  detail.render();
  detail.attach();
  return detail;
}

// ---------------------------------------------------------------------------------------------
// Your Domains > .kachat (KachatLiveDomainsTab)
// ---------------------------------------------------------------------------------------------

let domainsSeq = 0;
/** container -> { token, address, load } of the render in it, so a repeat call only reloads. */
const domainsRenders = new WeakMap();
/** lowercased address -> the names last shown for it, so a re-rendered tab (Cold Storage repaints
 *  its whole screen) shows them at once and reloads behind them instead of flashing a spinner. */
const domainsShown = new Map();

/** The card badge for a name: Listed, or Expired (in grace) (iOS KachatLiveDomainsTab.badge). Your
 *  Domains and the per-address lists show only held names (`heldNames`), so "Available" (past
 *  grace, iOS eea52b2) is never on a card. */
function domainBadge(n) {
  switch (n.status(graceMs())) {
    case Status.active: return n.isListed ? "Listed" : "";
    case Status.grace: return "Expired";
    default: return "Available";
  }
}

function domainCardsHtml(names) {
  return names.map((n) => {
    rememberName(n);
    const b = domainBadge(n);
    return `<button type="button" class="kns-domain-card" data-kl-domain-open="${esc(n.name)}">${esc(n.display)}${b ? `<span class="kns-domain-primary">${esc(b)}</span>` : ""}</button>`;
  }).join("");
}

/** "No .kachat names yet" (Your Domains) or, for one address's tab, iOS KachatAddressLiveNamesList's
 *  "No .kachat names on this address". */
function domainsEmptyHtml(variant) {
  if (variant === "address") {
    return `
      <div class="kachat-address-domains">
        <span class="kachat-address-domains-mark" aria-hidden="true">${kit.wordmark || kit.ICON.atCircle}</span>
        <strong>No .kachat names on this address</strong>
        <p>Names this address owns show here.</p>
      </div>`;
  }
  return `
    <div class="kl-domains-empty">
      <span class="kmkt-empty-icon">${kit.ICON.atCircle}</span>
      <strong>No .kachat names yet</strong>
    </div>`;
}

/**
 * Renders an address's .kachat names into `containerEl` (iOS KachatLiveDomainsTab and, with
 * `variant: "address"`, KachatAddressLiveNamesList - the .kachat tab of Manage Addresses, the
 * chatting address and KasSigner, 881ada6): a spinner, then the address's names as domain cards, or
 * the empty note - Your Domains and an address's tab list the names still held (active, and expired
 * in grace; one past grace is no longer theirs - it's Available to anyone in the marketplace, iOS
 * e26562e / eea52b2), Your Domains with My Offers under them (iOS 0765ce0). A card opens the name's live detail as a sheet,
 * which knows which of your addresses holds it (owner actions, or read-only for KasSigner). It
 * reloads by itself when the registry changes, for as long as this render is the one in the
 * container. Where the registry isn't launched (mainnet) it renders the empty note and reads
 * nothing (iOS 7227d69). Returns false (container untouched) only before the market is wired.
 */
/** key -> the timer that fires when the next of a shown set of names lapses (iOS dropLapsed). */
const lapseTimers = new Map();

/** Calls `fn` once the next of `names` lapses (its expiry plus the grace period, half a second
 *  late), replacing the timer `key` had. A lapse is just the clock running out, so no registry
 *  change announces it (iOS aa36d2a dropLapsed). Nothing is scheduled when none is left to lapse. */
function scheduleLapse(key, names, fn) {
  clearTimeout(lapseTimers.get(key));
  lapseTimers.delete(key);
  if (typeof fn !== "function" || !names?.length) return;
  const now = BigInt(Date.now());
  const grace = graceMs();
  let next = null;
  for (const n of names) {
    const at = BigInt(n.expiresAt) + grace;
    if (at > now && (next == null || at < next)) next = at;
  }
  if (next == null) return;
  // setTimeout's own ceiling is ~24.8 days: a longer wait fires early and simply schedules again
  const wait = Math.min(Number(next - now) + 500, 2_000_000_000);
  lapseTimers.set(key, setTimeout(() => { lapseTimers.delete(key); fn(); }, wait));
}

/** How many .kachat names `walletAddress` still holds - the set Your Domains lists: active ones and
 *  expired ones in grace, never lapsed ones (iOS heldNames, e26562e / aa36d2a) - for the Profile's
 *  Your Domains count (iOS 10e4a1a). `onLapse` (optional) is called once the next of them lapses,
 *  so the count can drop right then. 0 where the registry isn't launched; throws when the registry
 *  can't be read (callers keep the last count). */
export async function kachatOwnedNameCount(walletAddress, { onLapse = null } = {}) {
  const rt = kachatNames();
  const address = String(walletAddress || "").toLowerCase();
  const key = rt ? keyOf(address) : null;
  if (!key) return 0;
  await rt.registry.refreshIfStale({ maxAge: 300 });
  const held = await rt.registry.heldNames(key);
  scheduleLapse(`count:${address}`, held, onLapse);
  return held.length;
}

/** This wallet's .kachat names that have expired and sit in their grace period, soonest first, for
 *  Profile's banner (iOS 6ac48a7 KachatExpiredNamesModel): renew before grace ends, or anyone can
 *  claim them. Each is { name, display, expiresAt, graceEndsText }. [] where the registry isn't
 *  launched (mainnet); throws when the registry can't be read. */
export async function kachatExpiredNames(walletAddress) {
  const rt = kachatNames();
  const key = rt ? keyOf(String(walletAddress || "").toLowerCase()) : null;
  if (!key) return [];
  await rt.registry.refreshIfStale();
  const grace = graceMs();
  const owned = await rt.registry.namesOf(key, { includeInactive: true });
  return owned
    .filter((n) => n.status(grace) === Status.grace)
    .sort((a, b) => (a.expiresAt < b.expiresAt ? -1 : a.expiresAt > b.expiresAt ? 1 : 0))
    .map((n) => ({ name: n.name, display: n.display, expiresAt: String(n.expiresAt), graceEndsText: dayText(BigInt(n.expiresAt) + BigInt(grace)) }));
}

/** `listener()` whenever the .kachat registry moves (a registration, sale or transfer lands);
 *  returns an unsubscribe function. A no-op where the registry isn't launched. */
export function onKachatRegistryChange(listener) {
  return kachatNames()?.registry?.onChange?.(() => listener()) || (() => {});
}

export function renderKachatLiveDomainsTab(containerEl, walletAddress, { variant = "domains" } = {}) {
  if (!containerEl || !kit) return false;
  const rt = kachatNames();
  const address = String(walletAddress || "").toLowerCase();
  // The same address's tab is already there (the caller re-rendered its list): reload in place,
  // without flashing the spinner.
  const previous = domainsRenders.get(containerEl);
  if (previous && previous.address === address && previous.variant === variant
    && containerEl.querySelector(`[data-kl-domains="${previous.token}"]`)) {
    previous.load();
    return true;
  }
  const token = String(++domainsSeq);
  if (!rt) {
    // Not launched here: the same tab, empty.
    containerEl.innerHTML = `<div class="kl-domains" data-kl-domains="${token}">${domainsEmptyHtml(variant)}</div>`;
    domainsRenders.set(containerEl, { token, address, variant, load: () => {} });
    return true;
  }
  const shown = domainsShown.get(address);
  containerEl.innerHTML = `<div class="kl-domains" data-kl-domains="${token}">${shown?.length
    ? domainCardsHtml(shown)
    : `<div class="kl-domains-loading">${spinner()}</div>`}</div>`;
  if (!containerEl.dataset.klDomainsBound) {
    containerEl.dataset.klDomainsBound = "1";
    containerEl.addEventListener("click", (event) => {
      // My Offers (Your Domains only): a tile opens the offer's half sheet - Withdraw, or Refund
      // once expired (iOS 7f50e84)
      const offerOpen = event.target.closest("[data-kl-offer-open]");
      if (offerOpen && containerEl.contains(offerOpen)) {
        const offer = offerIndex.get(offerOpen.dataset.klOfferOpen);
        if (offer) openOfferDetailSheet({ offer, isBuyer: true, isOwner: false }, "domains");
        return;
      }
      const open = event.target.closest("[data-kl-domain-open]");
      if (!open || !containerEl.contains(open)) return;
      const info = nameIndex.get(open.dataset.klDomainOpen);
      if (info) openNameDetailLayer(info, "domains");
    });
  }
  const current = () => containerEl.isConnected && containerEl.querySelector(`[data-kl-domains="${token}"]`);
  let loading = false;
  let again = false;
  /** what this render shows, for repaints that don't reload (an offer going back to you) */
  let shownNames = shown ?? [];
  let shownOffers = [];
  const paint = (root) => {
    const cards = shownNames.length ? domainCardsHtml(shownNames) : domainsEmptyHtml(variant);
    // The offers this wallet made, under its names (iOS 0765ce0: moved here from the
    // marketplace's former My Names tab), as square tiles with the name (iOS 7f50e84); each opens
    // its half sheet - Withdraw, and Refund once expired.
    const offers = variant === "domains" && shownOffers.length ? `
      <div class="kl-domains-offers">
        ${kit.sectionHeader("My Offers", "Offers you made. Withdraw one any time; once it expires it comes back to you on its own.")}
        ${kachatNameGridHtml(shownOffers.map((o) => offerTileHtml(offerState({ offer: o, isBuyer: true, isOwner: false }), { showsName: true })).join(""))}
      </div>` : "";
    root.innerHTML = cards + offers;
  };

  const load = async () => {
    if (loading) { again = true; return; }
    loading = true;
    try {
      do {
        again = false;
        let names = [];
        let offers = [];
        const key = keyOf(address);
        if (key) {
          try {
            if (rt.registry.refreshedAt == null) await rt.registry.refresh();
            // A name past grace is no longer theirs - it's Available to anyone in the marketplace
            // (and the bell says so); expired names in grace stay, to be renewed. Your Domains and
            // each address's tab alike (iOS e26562e / aa36d2a / eea52b2).
            names = await rt.registry.heldNames(key);
          } catch { names = []; }
          if (variant === "domains") {
            try { offers = await rt.registry.myOffers(key); } catch { offers = []; }
            if (offers.length) {
              // expired offers, and ones made to an earlier owner, come back on their own
              await rt.actions.refreshVirtualDaa().catch(() => null);
              await rt.actions.returnExpiredOffers(offers).catch(() => null);
              await rt.actions.withdrawDeclinedOffers(offers).catch(() => null);
            }
          }
        }
        const root = current();
        if (!root) return;
        // The manifest is for the previous registry (v1): calm, no error (iOS d2e0673).
        if (rt.service.registryUpgrading || rt.registry.registryUpgrading) {
          root.innerHTML = `
            <div class="kl-domains-empty kl-domains-upgrading">
              <span class="kl-accent">${LI.hammer}</span>
              <strong>Setting up</strong>
              <p>${esc(registryUpgradingMessage)}</p>
            </div>`;
          continue;
        }
        domainsShown.delete(address);
        domainsShown.set(address, names);
        trimMap(domainsShown, 200);
        shownNames = names;
        shownOffers = offers;
        paint(root);
        // a name that lapses while this is open leaves right then (iOS aa36d2a)
        scheduleLapse(`tab:${token}`, names, () => { if (current()) load(); });
      } while (again);
    } finally {
      loading = false;
    }
  };

  domainsRenders.set(containerEl, { token, address, variant, load });
  // This render's own subscriptions; each drops itself once its render is gone.
  const subs = [];
  const unsubscribeAll = () => { for (const u of subs.splice(0)) { try { u(); } catch { /* gone */ } } };
  const onSourceChange = () => { if (!current()) { unsubscribeAll(); return; } load(); };
  subs.push(rt.registry.onChange(onSourceChange));
  subs.push(rt.service.onChange(onSourceChange));
  if (variant === "domains") {
    // My Offers follows the DAA score (expiry) and what this app is sending back
    const offerSig = () => {
      const a = rt.actions;
      return `${a.virtualDaa}|${a.returningOffers?.size ?? 0}|${a.withdrawingOffers?.size ?? 0}`;
    };
    let lastSig = offerSig();
    subs.push(rt.actions.subscribe(() => {
      const root = current();
      if (!root) { unsubscribeAll(); return; }
      const sig = offerSig();
      if (sig === lastSig) return;
      lastSig = sig;
      if (shownOffers.length && !loading) paint(root);
    }));
  }
  load();
  return true;
}

/** Which of `addresses` own a .kachat name (iOS KachatNamesRegistry.ownersOfNames, 881ada6): the
 *  "Contains domain" tag and funded-first sort on Manage Addresses and KasSigner. An empty Set where
 *  the registry isn't launched (mainnet) - nothing is read there. -> Promise<Set<string>> */
export async function kachatOwnersOfNames(addresses) {
  const rt = kachatNames();
  if (!rt || !Array.isArray(addresses) || addresses.length === 0) return new Set();
  try { return await rt.registry.ownersOfNames(addresses); } catch { return new Set(); }
}

// ---------------------------------------------------------------------------------------------
// The social profile: avatar, banner and bio looked up on this device (KachatSocialImageResolver)
// ---------------------------------------------------------------------------------------------

// A web page can't read another site's pages or most APIs (CORS), so the resolver's requests go
// through the app's same-origin relay (/nc-proxy, vite.config.mjs). The three JSON APIs that answer
// a page directly (FxTwitter, GitHub, Discord's invite API) are asked directly first, so X, GitHub
// and Discord profiles also resolve on a plain static host without the relay. Everything else
// without the relay is "couldn't reach", with Retry.
const SOCIAL_DIRECT_HOST_RE = /^(api\.fxtwitter\.com|api\.github\.com|discord\.com)$/i;
const SOCIAL_STORAGE = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* full or blocked: memory only */ } },
  remove(key) { try { localStorage.removeItem(key); } catch { /* blocked */ } },
};

/** A response body as text, at most `maxBytes` bytes of it; the rest is never read. */
async function readCappedText(res, maxBytes) {
  const reader = res.body?.getReader?.();
  if (!reader) return (await res.text()).slice(0, maxBytes);
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  try {
    while (bytes < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = bytes + value.byteLength > maxBytes ? value.subarray(0, maxBytes - bytes) : value;
      bytes += chunk.byteLength;
      text += decoder.decode(chunk, { stream: true });
    }
    text += decoder.decode();
  } finally {
    try { await reader.cancel(); } catch { /* done already */ }
  }
  return text;
}

async function socialFetchOnce(url, { accept, timeoutMs = 8000, agent, maxBytes = 3_000_000, signal } = {}, viaRelay) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener?.("abort", onAbort, { once: true });
  try {
    const headers = {};
    if (accept) headers.Accept = accept;
    let target = url;
    if (viaRelay) {
      target = proxiedUrl(url);
      // the relay's link-preview mode: a crawler User-Agent, so pages emit their Open Graph tags
      if (agent === "crawler") headers["x-preview"] = "1";
    }
    const fetchFn = window.__kasiaNativeFetch || window.fetch.bind(window);
    const res = await fetchFn(target, {
      headers, signal: controller.signal, credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer",
    });
    const text = await readCappedText(res, maxBytes);
    return { status: res.status, contentType: res.headers.get("content-type") || "", text };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.("abort", onAbort);
  }
}

/** The resolver's `fetchText` (social-image-resolver.js contract) for this web app. */
async function socialFetchText(url, options = {}) {
  let host = "";
  try { host = new URL(url).hostname; } catch { return null; }
  if (SOCIAL_DIRECT_HOST_RE.test(host)) {
    const direct = await socialFetchOnce(url, options, false);
    if (direct) return direct;
  }
  if (!(await isProxyAvailable())) return null;
  return socialFetchOnce(url, options, true);
}

let socialResolver = null;
/** The one resolver of this app (iOS KachatSocialImageResolver.shared), made on first use. */
function socialImages() {
  if (!socialResolver) {
    socialResolver = new KachatSocialImageResolver({ fetchText: socialFetchText, storage: SOCIAL_STORAGE, now: () => Date.now() });
  }
  return socialResolver;
}

/** Image hosts that refuse a page's hotlink: their pictures come through the relay. Facebook's
 *  `lookaside.fbsbx.com` answers anything but its own crawler with an HTML page. */
const SOCIAL_RELAY_IMAGE_HOST_RE = /(^|\.)(fbsbx\.com|fbcdn\.net)$/i;
const SOCIAL_IMAGE_MAX_BYTES = 10_000_000;
const socialImageBlobs = new Map(); // `${mode}|${url}` -> Promise<string|null> (blob: URL)

function httpsImageUrl(url) {
  if (typeof url !== "string" || url.length > 2048 || !/^https:\/\/[^\s"'<>\\]+$/i.test(url)) return null;
  try { return new URL(url).protocol === "https:" ? url : null; } catch { return null; }
}

async function relayImage(url, modes, referer) {
  if (!(await isProxyAvailable())) return null;
  const fetchFn = window.__kasiaNativeFetch || window.fetch.bind(window);
  for (const mode of modes) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const headers = { "x-preview-image": mode };
      if (mode === "1" && referer) headers["x-preview-referer"] = referer;
      const res = await fetchFn(proxiedUrl(url), { headers, signal: controller.signal, credentials: "omit", cache: "no-store" });
      if (!res.ok) continue;
      const blob = await res.blob();
      if (!blob.size || blob.size > SOCIAL_IMAGE_MAX_BYTES || !/^image\//i.test(blob.type || "") || /svg/i.test(blob.type)) continue;
      return URL.createObjectURL(blob);
    } catch {
      /* next mode */
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

/**
 * A `src` that loads `url` (a resolved .kachat avatar or banner) in this page: the URL itself for
 * hosts that serve a page's <img> (render it with referrerpolicy="no-referrer"), or a blob: URL
 * fetched through the relay for hosts that refuse hotlinks (Facebook). `viaRelay: true` forces the
 * relay - the retry for an <img> that failed to load. `referer`: the profile link, for hosts that
 * check it. Null when it can't be loaded (not https, or the relay is needed and missing).
 */
export async function kachatImageSrc(url, { viaRelay = false, referer = null } = {}) {
  const safe = httpsImageUrl(url);
  if (!safe) return null;
  let host = "";
  try { host = new URL(safe).hostname; } catch { return null; }
  const needsRelay = SOCIAL_RELAY_IMAGE_HOST_RE.test(host);
  if (!viaRelay && !needsRelay) return safe;
  const modes = needsRelay ? ["crawler", "1"] : ["1", "crawler"];
  const key = `${modes[0]}|${safe}`;
  if (!socialImageBlobs.has(key)) {
    const pending = relayImage(safe, modes, referer).then((src) => {
      if (!src) socialImageBlobs.delete(key); // a later retry may work
      return src;
    });
    socialImageBlobs.set(key, pending);
    if (socialImageBlobs.size > 100) {
      const [oldKey, oldPending] = socialImageBlobs.entries().next().value;
      socialImageBlobs.delete(oldKey);
      oldPending.then((src) => { if (src) { try { URL.revokeObjectURL(src); } catch { /* fine */ } } });
    }
  }
  return socialImageBlobs.get(key);
}

/** Calls `listener(link, SocialProfile)` whenever a lookup lands a new answer (e.g. a stale
 *  hero picture refreshed in the background). Returns the unsubscribe function. */
export function onKachatSocialChange(listener) {
  return socialImages().onChange(listener);
}

/**
 * The KaChat profile of `address` for the profile hero (iOS ContactsView, every network): the
 * avatar, banner and bio its social links show right now, looked up on this device (cached 24 h;
 * a stale answer is returned at once and refreshed in the background - see onKachatSocialChange),
 * and its Linktree link. The address's own record on this device comes first (the one it wrote,
 * or the newer one registry.syncOwnProfile adopted from the chain - the app syncs before this), then the
 * registry's identity (on mainnet the profile-only identity: GET /profiles/{address}). `avatarUrl` / `bannerUrl` are ready for <img src> (kachatImageSrc: render
 * with referrerpolicy="no-referrer"; on an <img> error, retry with kachatImageSrc(url, { viaRelay:
 * true })). `bio` is plain text (escape it). Any piece may be null.
 * -> Promise<{ avatarUrl: string|null, bannerUrl: string|null, bio: string|null, linktreeUrl: string|null } | null>
 *    null before the runtime exists, or when the address has no profile record.
 */
export async function kachatHeroProfile(address) {
  const rt = kachatProfiles();
  if (!rt || !address) return null;
  const { registry } = rt;
  try { await registry.refreshIfStale({ maxAge: 300 }); } catch { /* use what we have */ }
  let own = null;
  try { own = (await registry.ownProfile(address))?.profile ?? null; } catch { own = null; }
  let raw = own;
  if (!raw) { try { raw = (await registry.identity(address))?.profile ?? null; } catch { raw = null; } }
  if (!raw) return null;
  const p = (raw instanceof Profile ? raw : new Profile(raw)).sanitized();
  const resolver = socialImages();
  const look = async (link, kind) => {
    if (!link) return null;
    const cached = await resolver.profile(link); // a stale answer now; looked up again behind it
    if (cached) return cached.piece(kind);
    const result = await resolver.resolve(link, { maxAgeMs: socialFreshForMs }); // joins that lookup
    return result.profile?.piece(kind) ?? null;
  };
  const [avatar, banner, bio] = await Promise.all([
    look(p.avatar, SocialKind.avatar), look(p.banner, SocialKind.banner), look(p.bio, SocialKind.bio),
  ]);
  const [avatarUrl, bannerUrl] = await Promise.all([
    avatar ? kachatImageSrc(avatar, { referer: p.avatar }) : null,
    banner ? kachatImageSrc(banner, { referer: p.banner }) : null,
  ]);
  return { avatarUrl: avatarUrl ?? null, bannerUrl: bannerUrl ?? null, bio: bio ?? null, linktreeUrl: p.linktree ?? null };
}

// ---------------------------------------------------------------------------------------------
// Cached identities: who an address is, readable from any render (iOS e52357d,
// KachatNamesRegistry.cachedIdentity(for:)). Every network, addresses of the app's network only; on
// mainnet the identities are profile-only (no label or names, iOS d36fc42).
// ---------------------------------------------------------------------------------------------

/** An answer is re-asked after this long, or as soon as the registry's revision moved. */
const IDENTITY_MAX_AGE_MS = 300_000;
/** A lookup that failed is tried again after this long (unless the registry moves first). Where
 *  identities are profile-only (mainnet) a failed address waits `profileMissPauseMs` (5 minutes),
 *  as the engine does (registry.profileOnlyIdentity). */
const IDENTITY_RETRY_MS = 60_000;
/** Listeners hear about a batch of answers at most this often. */
const IDENTITY_NOTIFY_MS = 200;
const IDENTITY_CACHE_MAX = 2000;
const SOCIAL_CACHE_MAX = 500;
const IMAGE_CACHE_MAX = 300;

/** lowercased address -> { identity: {address,label,names,profile}|null, sig, revision, at,
 *  confirmedAt (unix ms of the last lookup that answered; 0 = never), fromDisk (loaded at launch
 *  and not looked up since) } */
const cachedIdentities = new Map();
/** The identities kept across launches (profile-cache.js, iOS 5e408f7 KachatProfileCache): this
 *  network's only, at most 1000, loaded once marked stale and written 2 s after a change. */
let identityStore = null;
/** addresses with a lookup in flight (one each) */
const identityLookups = new Set();
const identityListeners = new Set();
let identityNotifyTimer = null;
let identityWatching = null;
/** a social link (as the resolver keys it) -> { profile: SocialProfile|null, loading, at } */
const cachedSocial = new Map();
/** a resolved image URL -> { src: string|null, state: "ready"|"loading"|"retrying"|"relayed"|"failed", referer } */
const cachedImages = new Map();

function scheduleIdentityNotify() {
  if (identityNotifyTimer != null || identityListeners.size === 0) return;
  identityNotifyTimer = setTimeout(() => {
    identityNotifyTimer = null;
    for (const fn of [...identityListeners]) { try { fn(); } catch { /* a listener's own problem */ } }
  }, IDENTITY_NOTIFY_MS);
}

function trimMap(map, max) {
  while (map.size > max) map.delete(map.keys().next().value);
}

const socialSig = (p) => (p ? JSON.stringify([p.avatar ?? null, p.banner ?? null, p.bio ?? null]) : "");

/** The identity store, made on first use: what the last run knew is loaded into the cache marked
 *  stale (revision -1), so avatars and bios show at once and each is looked up again the first
 *  time it is read - under the registry's pauses (a 503 pauses profile lookups for 10 minutes, a
 *  failed address for 5), and a failed lookup keeps the loaded identity. */
function profileIdentityStore() {
  if (identityStore) return identityStore;
  identityStore = new ProfileIdentityStore({
    storage: SOCIAL_STORAGE,
    network: NETWORK,
    entries: () => {
      const out = [];
      for (const [key, e] of cachedIdentities) if (e.identity && e.confirmedAt > 0) out.push([key, { identity: e.identity, at: e.confirmedAt }]);
      return out;
    },
  });
  try {
    for (const [key, saved] of identityStore.load()) {
      if (cachedIdentities.has(key) || !isNetworkAddress(key)) continue;
      const identity = normalizedIdentity(key, saved.identity, null);
      if (!identity) continue;
      cachedIdentities.set(key, { identity, sig: identitySig(identity), revision: -1, at: 0, confirmedAt: saved.at, fromDisk: true });
    }
    trimMap(cachedIdentities, IDENTITY_CACHE_MAX);
  } catch { /* an unreadable store: start empty */ }
  try {
    const flush = () => { try { identityStore?.flush(); } catch { /* fine */ } };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flush(); });
  } catch { /* no window (tests) */ }
  return identityStore;
}

/** Watches the registry (a new revision may change any label) and the social resolver (a lookup
 *  landing changes a picture or a bio) once per registry. */
function watchIdentitySources(registry) {
  if (identityWatching === registry) return;
  identityWatching = registry;
  try { registry.onChange?.(() => scheduleIdentityNotify()); } catch { /* fine */ }
  try {
    socialImages().onChange((link, profile) => {
      const entry = cachedSocial.get(link);
      if (!entry) return;
      entry.at = Date.now();
      if (socialSig(entry.profile) === socialSig(profile)) return;
      entry.profile = profile ?? null;
      scheduleIdentityNotify();
    });
  } catch { /* fine */ }
}

/** The identity as the app shows it: the label, the active names and the profile record (this
 *  wallet's own saved one first). Null when nothing is known. */
function normalizedIdentity(key, identity, ownProfile) {
  const raw = ownProfile ?? identity?.profile ?? null;
  let profile = null;
  if (raw) {
    try { profile = (raw instanceof Profile ? raw : new Profile(raw)).sanitized(); } catch { profile = null; }
  }
  const label = typeof identity?.label === "string" && identity.label ? identity.label : null;
  const names = Array.isArray(identity?.names) ? identity.names.filter((n) => typeof n === "string" && n) : [];
  if (!label && names.length === 0 && !profile) return null;
  return { address: key, label, names, profile };
}

function identitySig(identity) {
  if (!identity) return "";
  let profile = null;
  try { profile = identity.profile?.toJSON?.() ?? identity.profile ?? null; } catch { profile = null; }
  return JSON.stringify([identity.label, identity.names, profile]);
}

/** One background lookup for `key`; listeners hear about it only when the answer changed. */
async function lookUpIdentity(registry, key) {
  identityLookups.add(key);
  try {
    try { await registry.refreshIfStale({ maxAge: IDENTITY_MAX_AGE_MS / 1000 }); } catch { /* use what we have */ }
    let identity = null;
    let failed = false;
    try { identity = await registry.identity(key); } catch { failed = true; }
    let own = null;
    try { own = (await registry.ownProfile(key))?.profile ?? null; } catch { own = null; }
    const prev = cachedIdentities.get(key) ?? null;
    if (failed && !own) {
      // Keep what we had (the copy loaded at launch too); ask again in a minute rather than on
      // every render.
      const retryMs = registry.isLaunched === false ? profileMissPauseMs : IDENTITY_RETRY_MS;
      cachedIdentities.set(key, {
        identity: prev?.identity ?? null, sig: prev?.sig ?? "", revision: registry.revision,
        at: Date.now() - IDENTITY_MAX_AGE_MS + retryMs,
        confirmedAt: prev?.confirmedAt ?? 0, fromDisk: prev?.fromDisk === true,
      });
      return;
    }
    const next = normalizedIdentity(key, failed ? prev?.identity : identity, own);
    const sig = identitySig(next);
    const now = Date.now();
    cachedIdentities.delete(key);
    cachedIdentities.set(key, { identity: next, sig, revision: registry.revision, at: now, confirmedAt: now, fromDisk: false });
    trimMap(cachedIdentities, IDENTITY_CACHE_MAX);
    // kept across launches: written when it changed, or when a copy from the last run was confirmed
    if (sig !== (prev?.sig ?? "") || prev?.fromDisk) { try { profileIdentityStore().schedule(); } catch { /* memory only */ } }
    if (sig !== (prev?.sig ?? "")) scheduleIdentityNotify();
  } finally {
    identityLookups.delete(key);
  }
}

/**
 * The `.kachat` identity of `address` - `{ address, label, names, profile }` - from a cache that
 * fills in the background, so any render can call it (iOS KachatNamesRegistry.cachedIdentity).
 * An answer is re-asked once the registry's revision moved or after five minutes (one lookup in
 * flight per address); this wallet's own saved profile always wins for its own address. Listeners
 * of onKachatIdentityChange hear when an answer lands. On mainnet the identity is profile-only
 * (label null, names []). Null before the runtime exists, for an address not on the app's network,
 * or while nothing is known.
 */
export function kachatCachedIdentity(address) {
  const rt = kachatProfiles();
  if (!rt || !address) return null;
  const key = String(address).trim().toLowerCase();
  if (!isNetworkAddress(key)) return null;
  const { registry } = rt;
  watchIdentitySources(registry);
  profileIdentityStore();
  const entry = cachedIdentities.get(key);
  const stale = !entry || entry.revision !== registry.revision || Date.now() - entry.at > IDENTITY_MAX_AGE_MS;
  if (stale && !identityLookups.has(key)) lookUpIdentity(registry, key);
  return entry?.identity ?? null;
}

/** The address's `.kachat` name ("alice.kachat"), or null. */
export function kachatCachedLabel(address) {
  const label = kachatCachedIdentity(address)?.label;
  return label ? `${label}.kachat` : null;
}

/** The social profile a link shows, as far as this device knows it right now (sync); asks the
 *  resolver behind it (cached 24 h there) when there is no answer here or it is old. */
function cachedSocialProfile(link) {
  if (!link) return null;
  let key = null;
  try { key = SocialSource.fromLink(String(link), SocialKind.avatar)?.link ?? null; } catch { key = null; }
  if (!key) return null;
  let entry = cachedSocial.get(key);
  if (!entry || (!entry.loading && Date.now() - entry.at > IDENTITY_MAX_AGE_MS)) {
    if (!entry) {
      entry = { profile: null, loading: false, at: 0 };
      cachedSocial.set(key, entry);
      trimMap(cachedSocial, SOCIAL_CACHE_MAX);
    }
    const target = entry;
    target.loading = true;
    target.at = Date.now();
    socialImages().profile(key).then((p) => {
      target.loading = false;
      target.at = Date.now();
      if (p && socialSig(target.profile) !== socialSig(p)) {
        target.profile = p;
        scheduleIdentityNotify();
      }
    }, () => { target.loading = false; target.at = Date.now(); });
  }
  return entry.profile;
}

/** A src for a resolved picture right now (sync), or null until it can be loaded. Hosts that
 *  serve a page's <img> load directly; the others (Facebook) through the relay, in the background. */
function cachedImageSrc(url, referer) {
  const safe = httpsImageUrl(url);
  if (!safe) return null;
  let entry = cachedImages.get(safe);
  if (!entry) {
    let host = "";
    try { host = new URL(safe).hostname; } catch { return null; }
    if (!SOCIAL_RELAY_IMAGE_HOST_RE.test(host)) {
      entry = { src: safe, state: "ready", referer: referer ?? null };
      cachedImages.set(safe, entry);
    } else {
      entry = { src: null, state: "loading", referer: referer ?? null };
      cachedImages.set(safe, entry);
      const target = entry;
      kachatImageSrc(safe, { referer }).then((src) => {
        target.src = src ?? null;
        target.state = src ? "relayed" : "failed";
        if (src) scheduleIdentityNotify();
      }, () => { target.state = "failed"; });
    }
    trimMap(cachedImages, IMAGE_CACHE_MAX);
  }
  return entry.src;
}

/**
 * For an <img> showing a src from kachatCachedAvatarUrl / kachatCachedProfilePieces that failed
 * to load: one retry through the relay. -> Promise<string|null>, the src to try next, or null
 * (show the glyph). Later reads of the cache return the same answer, so a re-render never asks
 * again.
 */
export async function kachatRetryImage(src) {
  if (!src) return null;
  let url = null;
  let entry = null;
  for (const [u, e] of cachedImages) {
    if (e.src === src) { url = u; entry = e; break; }
  }
  if (!entry) return null;
  if (entry.state !== "ready") {
    if (entry.state === "relayed" || entry.state === "retrying") { entry.src = null; entry.state = "failed"; }
    return null;
  }
  entry.state = "retrying";
  let next = null;
  try { next = await kachatImageSrc(url, { viaRelay: true, referer: entry.referer }); } catch { next = null; }
  entry.src = next && next !== src ? next : null;
  entry.state = entry.src ? "relayed" : "failed";
  scheduleIdentityNotify();
  return entry.src;
}

/** The address's `.kachat` avatar, ready for <img src> (render with referrerpolicy="no-referrer";
 *  on an error, kachatRetryImage). Null until its profile and its picture are resolved - reading it
 *  starts that in the background. */
export function kachatCachedAvatarUrl(address) {
  const link = kachatCachedIdentity(address)?.profile?.avatar;
  if (!link) return null;
  const url = cachedSocialProfile(link)?.piece(SocialKind.avatar) ?? null;
  return url ? cachedImageSrc(url, link) : null;
}

/** The address's KaChat profile as User Info shows it, best effort and sync: `{ avatarUrl,
 *  bannerUrl, bio, linktreeUrl }` (any piece may be null), on every network. Null before the
 *  runtime exists. */
export function kachatCachedProfilePieces(address) {
  if (!kachatProfiles()) return null;
  const profile = kachatCachedIdentity(address)?.profile ?? null;
  const pieces = { avatarUrl: null, bannerUrl: null, bio: null, linktreeUrl: null };
  if (!profile) return pieces;
  if (profile.avatar) {
    const url = cachedSocialProfile(profile.avatar)?.piece(SocialKind.avatar) ?? null;
    pieces.avatarUrl = url ? cachedImageSrc(url, profile.avatar) : null;
  }
  if (profile.banner) {
    const url = cachedSocialProfile(profile.banner)?.piece(SocialKind.banner) ?? null;
    pieces.bannerUrl = url ? cachedImageSrc(url, profile.banner) : null;
  }
  if (profile.bio) pieces.bio = cachedSocialProfile(profile.bio)?.piece(SocialKind.bio) ?? null;
  pieces.linktreeUrl = Profile.linktreeLink(profile.linktree) ?? null;
  return pieces;
}

/**
 * Settings > Storage > Cache > Profiles (iOS 5e408f7 CacheManager.resetProfilesInMemory): forgets
 * every cached identity, social lookup (avatar, banner and bio from each link) and profile picture,
 * in memory and in storage, and repaints; views look them up again as they need them. Only this
 * network's stored identities are known here - the caller also removes every key under
 * `profileCachePrefix` (the other network's too). This device's own saved profile record
 * (`ownProfileStorageKey`) is not cache and stays. -> Promise (never rejects)
 */
export async function kachatClearProfileCache() {
  try { profileIdentityStore().clear(); } catch { /* fine */ }
  cachedIdentities.clear();
  cachedSocial.clear();
  for (const entry of cachedImages.values()) {
    if (entry.state === "relayed" && entry.src?.startsWith("blob:")) { try { URL.revokeObjectURL(entry.src); } catch { /* fine */ } }
  }
  cachedImages.clear();
  const blobs = [...socialImageBlobs.values()];
  socialImageBlobs.clear();
  for (const pending of blobs) pending.then((src) => { if (src) { try { URL.revokeObjectURL(src); } catch { /* fine */ } } }, () => {});
  scheduleIdentityNotify();
  try { await socialImages().clearAll(); } catch { /* storage blocked: memory is clear */ }
  scheduleIdentityNotify();
}

/** Calls `fn()` (debounced) whenever a cached identity, profile piece or picture changed, or the
 *  registry moved on. Returns the unsubscribe function. */
export function onKachatIdentityChange(fn) {
  if (typeof fn !== "function") return () => {};
  identityListeners.add(fn);
  return () => identityListeners.delete(fn);
}

/** An <img> for a resolved picture, filled in by hydrateSocialImages (never a fetched page's HTML). */
function socialImgHtml(url, cls, referer) {
  const safe = httpsImageUrl(url);
  if (!safe) return "";
  return `<img class="${cls}" alt="" decoding="async" referrerpolicy="no-referrer" data-kl-social-img="${esc(safe)}" data-kl-social-ref="${esc(referer ?? "")}" />`;
}

/** Points each new social <img> under `root` at a loadable src; one retry through the relay when
 *  the host refuses it, then hidden. */
function hydrateSocialImages(root) {
  root.querySelectorAll("img[data-kl-social-img]:not([data-kl-hydrated])").forEach((img) => {
    img.dataset.klHydrated = "1";
    const url = img.dataset.klSocialImg;
    const referer = img.dataset.klSocialRef || null;
    let retried = false;
    img.addEventListener("error", async () => {
      if (retried) { img.hidden = true; return; }
      retried = true;
      const src = await kachatImageSrc(url, { viaRelay: true, referer });
      if (!img.isConnected) return;
      if (src) img.src = src;
      else img.hidden = true;
    });
    kachatImageSrc(url, { referer }).then((src) => {
      if (!img.isConnected) return;
      if (src) img.src = src;
      else img.hidden = true;
    });
  });
}

// ---------------------------------------------------------------------------------------------
// Edit KaChat Profile (KachatLiveProfileEditor, KachatSourceInput, KachatSocialPreview)
// ---------------------------------------------------------------------------------------------

const SOCIAL_KINDS = [SocialKind.avatar, SocialKind.banner, SocialKind.bio];
const KIND_TITLE = { avatar: "Avatar", banner: "Banner", bio: "Bio" };

function missingText(kind, platformName) {
  return `No ${kind} on this ${platformName} profile.`;
}

/**
 * The address profile (KACHAT_NAMES.md section 7): where the avatar, banner and bio come from (a
 * social profile link each - a platform from the picker plus the handle after its prefix; they can
 * be different accounts), a Linktree link, and which of your names labels you - written as a
 * `kchat:1:profile:` self-transfer. No free text and no uploads: what shows comes from a platform
 * that moderates it. A review card laid out like the profile header shows what others will see;
 * only a malformed handle or Linktree username disables Save; links that couldn't be checked are
 * saved as entered, with a note saying so (iOS 5cac6af).
 * `owner` groups the layer (default "profile"). Saves on every network (iOS d36fc42): a profile is
 * a self-send with no registry behind it. Where the registry isn't launched (mainnet) the primary
 * name shows "Coming soon" and the profile saves without one; nothing reads the registry there.
 */
export function openLiveProfileEditor(owner = "profile") {
  if (!kit) return null;
  /** the profile runtime (every network; null only before init) */
  const rt = kachatProfiles();
  /** a live registry here (testnet): the primary name can be picked */
  const launched = rt != null && kachatNames() != null && kachatNamesLaunched();
  const resolver = socialImages();
  /** per field: the platform picked, the handle typed, and where its lookup stands
   *  (none | looking | found | empty | unreachable) */
  const fields = Object.fromEntries(SOCIAL_KINDS.map((k) => [k, {
    platform: SocialPlatform.x, handle: "", lookup: "none", resolved: null, attempt: 0, key: "", timer: null,
  }]));
  const form = { linktree: "", primary: "" };
  let activeNames = [];
  let loaded = false;
  let saving = false;
  let savedTx = null;
  let error = null;
  let layer = null;
  let closed = false;
  const rendered = new Map(); // container selector -> last html, so unchanged parts (images) stay

  const isEmpty = (kind) => !fields[kind].handle.trim();
  const sourceOf = (kind) => SocialSource.from(fields[kind].platform, fields[kind].handle, kind);
  const isBad = (kind) => !isEmpty(kind) && sourceOf(kind) == null;
  /** The source when the handle field holds a whole pasted link (rather than a handle). */
  const pastedSource = (kind) => {
    const t = fields[kind].handle.trim();
    if (!(t.toLowerCase().startsWith("http") || (t.includes(".") && t.includes("/")))) return null;
    return sourceOf(kind);
  };
  /** A filled-in field whose lookup hasn't found what it shows (still looking, unreachable, or
   *  nothing there). It doesn't block saving (iOS 5cac6af): a social site being slow or unreachable
   *  from here must never stop a profile (or a primary name) from saving; the link is saved as
   *  entered and every viewer's app looks it up itself. The editor just says so. */
  const notReviewed = (kind) => !isEmpty(kind) && fields[kind].lookup !== "found";
  const hasUncheckedLinks = () => SOCIAL_KINDS.some((k) => !isBad(k) && notReviewed(k));
  /** The Linktree field holds just the username (`linktr.ee/` is shown in front of it). */
  const badLinktree = () => {
    const t = form.linktree.trim();
    return t.length > 0 && Profile.linktreeLinkFromUsername(t) == null;
  };
  /** Only a malformed handle or Linktree username stops a save. */
  const blocked = () => SOCIAL_KINDS.some((k) => isBad(k)) || badLinktree();

  const profile = () => new Profile({
    avatar: sourceOf(SocialKind.avatar)?.link ?? null,
    banner: sourceOf(SocialKind.banner)?.link ?? null,
    bio: sourceOf(SocialKind.bio)?.link ?? null,
    linktree: Profile.linktreeLinkFromUsername(form.linktree),
    // the primary name needs the registry: none where it isn't launched (mainnet)
    primaryName: launched ? form.primary || null : null,
  }).sanitized();

  const navFor = () => (savedTx
    ? navHtml("Edit KaChat Profile", { leading: { label: "Done", bold: true } })
    : navHtml("Edit KaChat Profile", { leading: { label: "Cancel" } }));

  // MARK: pieces

  const piece = (kind) => (fields[kind].lookup === "found" ? fields[kind].resolved?.piece(kind) ?? null : null);

  /** One line per piece for the review card: where it came from, or why it is missing. */
  const reviewNote = (kind) => {
    const f = fields[kind];
    const source = sourceOf(kind);
    if (source) {
      const name = SocialPlatform.displayName(source.platform);
      switch (f.lookup) {
        case "found": return { text: `${KIND_TITLE[kind]} from ${name}`, from: true };
        case "empty": return { text: missingText(kind, name) };
        case "unreachable": return { text: `${KIND_TITLE[kind]}: couldn't reach ${name}.` };
        default: return { text: `${KIND_TITLE[kind]}: looking up ${name}...` };
      }
    }
    if (!isEmpty(kind)) return null; // an invalid handle: its field says so
    // an empty field the account used elsewhere can't fill: the platform never shares it
    const other = SOCIAL_KINDS.map((k) => sourceOf(k)).find(Boolean);
    if (other && !SocialPlatform.choices(kind).includes(other.platform)) {
      return { text: `${SocialPlatform.displayName(other.platform)} doesn't share ${kind === SocialKind.banner ? "banners" : "bios"}.` };
    }
    return null;
  };

  /** The review card, laid out like the profile header: banner, avatar, bio. */
  const reviewHtml = () => {
    if (!SOCIAL_KINDS.some((k) => sourceOf(k))) return "";
    const banner = piece(SocialKind.banner);
    const avatar = piece(SocialKind.avatar);
    const bio = piece(SocialKind.bio);
    const notes = SOCIAL_KINDS.map(reviewNote).filter(Boolean);
    return section(`
      <div class="kl-review">
        <div class="kl-review-banner">${banner ? socialImgHtml(banner, "kl-review-banner-img", sourceOf(SocialKind.banner)?.link) : ""}</div>
        <div class="kl-review-avatar">${LI.person}${avatar ? socialImgHtml(avatar, "kl-review-avatar-img", sourceOf(SocialKind.avatar)?.link) : ""}</div>
        <div class="kl-review-body">
          ${bio ? `<p class="kl-review-bio">${esc(bio)}</p>` : ""}
          ${notes.length ? `<ul class="kl-review-notes">${notes.map((n) => `<li class="${n.from ? "kl-review-from" : ""}">${esc(n.text)}</li>`).join("")}</ul>` : ""}
        </div>
      </div>`, { header: "Preview", footerHtml: footer("What others see: each device looks it up from the platform.") });
  };

  /** Where one field's lookup stands (iOS KachatSocialPreview). */
  const statusHtml = (kind) => {
    const source = sourceOf(kind);
    if (!source) return "";
    const name = SocialPlatform.displayName(source.platform);
    switch (fields[kind].lookup) {
      case "found":
        return `<div class="kmkt-form-row kl-src-status"><span class="kl-green">${LI.checkCircle}</span><span>${esc(`From ${name}`)}</span></div>`;
      case "empty":
        return `<div class="kmkt-form-row kl-src-status">${LI.personExclaim}<span>${esc(missingText(kind, name))}</span></div>`;
      case "unreachable":
        return `<div class="kmkt-form-row kl-src-status">${LI.wifiExclaim}<span>${esc(`Couldn't reach ${name}.`)}</span>
          <button type="button" class="kl-src-retry" data-kl-src-retry="${kind}">Retry</button></div>`;
      default:
        return `<div class="kmkt-form-row kl-src-status">${spinner()}<span>Looking up the profile...</span></div>`;
    }
  };

  const fieldFooter = (kind) => (isBad(kind) ? footer("That doesn't look like a handle on this platform.", "kl-red") : "");
  const linktreeFooter = () => (badLinktree()
    ? footer("Enter your Linktree username: letters, numbers, dots, dashes or underscores.", "kl-red")
    : footer("Add your Linktree to point people to your other accounts and websites."));
  const placeholderFor = (platform) => (platform === SocialPlatform.discord ? "invite" : "handle");

  const saveHtml = () => {
    let foot;
    if (savedTx) foot = footer(`Saved. Transaction ${String(savedTx).slice(0, 16)}...`, "kl-green");
    else if (error) foot = footer(error, "kl-red");
    else {
      foot = footer("Saving writes your profile to the chain from your address to itself, for a network fee. Profiles are public.");
      if (hasUncheckedLinks()) {
        foot = footer("Some links couldn't be checked from this device right now. They're saved as entered, and people's apps load them when they can.") + foot;
      }
    }
    // Saves on every network: a profile is a self-send, with no registry behind it.
    return section(
      `<button class="kmkt-form-button" type="button" data-kl-profile-save ${saving || !loaded || blocked() || !rt ? "disabled" : ""}>
        ${saving ? spinner() : "Save Profile"}
      </button>`,
      { footerHtml: foot },
    );
  };

  /** Platform picker, the handle after the platform's prefix, and where its lookup stands. */
  const fieldHtml = (kind) => {
    const f = fields[kind];
    const options = SocialPlatform.choices(kind)
      .map((p) => `<option value="${esc(p)}" ${p === f.platform ? "selected" : ""}>${esc(SocialPlatform.displayName(p))}</option>`).join("");
    return section(`
      <label class="kmkt-form-row kl-link-field">
        <span>Account on</span>
        <select class="kl-select" data-kl-src-platform="${kind}" aria-label="${esc(`${KIND_TITLE[kind]}: account on`)}">${options}</select>
      </label>
      <label class="kmkt-form-row kl-src-handle-row">
        <span class="kl-src-prefix" data-kl-src-prefix="${kind}">${esc(SocialPlatform.prefix(f.platform))}</span>
        <input class="kl-input" type="text" value="${esc(f.handle)}" placeholder="${esc(placeholderFor(f.platform))}" autocomplete="off"
          autocapitalize="none" autocorrect="off" spellcheck="false" data-kl-src-handle="${kind}" aria-label="${esc(`${KIND_TITLE[kind]}: handle`)}" />
      </label>
      <div class="kl-src-status-wrap" data-kl-src-status="${kind}">${statusHtml(kind)}</div>`, {
      header: KIND_TITLE[kind],
      footerHtml: `<div data-kl-src-foot="${kind}">${fieldFooter(kind)}</div>`,
    });
  };

  const formHtml = () => `
    ${section(`
      <div class="kmkt-form-row kmkt-label-row">
        <span class="kmkt-label-icon">${LI.card}</span>
        <span class="kmkt-label-text">Your profile belongs to your address, not to a name: it stays the same when you buy, sell or let a name go.</span>
      </div>`, {
      footerHtml: footer("Each piece comes from a social profile you link, exactly as that platform shows it, so its moderation applies here too. You can use one account for all three, or mix them."),
    })}
    <div data-kl-review-wrap>${reviewHtml()}</div>
    ${SOCIAL_KINDS.map(fieldHtml).join("")}
    ${section(`
      <label class="kmkt-form-row kl-src-handle-row">
        <span class="kl-src-prefix">linktr.ee/</span>
        <input class="kl-input" type="text" value="${esc(form.linktree)}" placeholder="username" autocomplete="off" autocapitalize="none"
          autocorrect="off" spellcheck="false" data-kl-profile-linktree aria-label="Linktree username" />
      </label>`, { header: "Links", footerHtml: `<div data-kl-linktree-foot>${linktreeFooter()}</div>` })}
    ${launched ? section(`
      <label class="kmkt-form-row kl-link-field">
        <span>Primary name</span>
        <select class="kl-select" data-kl-profile-primary aria-label="Primary name">
          <option value="" ${form.primary ? "" : "selected"}>None</option>
          ${activeNames.map((n) => `<option value="${esc(n)}" ${n === form.primary ? "selected" : ""}>${esc(`${n}.kachat`)}</option>`).join("")}
        </select>
      </label>`, {
      header: ".kachat Name",
      footerHtml: footer("KaChat shows you by your primary name while you own it and it's active; otherwise by your oldest active name, or your address."),
    }) : section(`
      <div class="kmkt-form-row">
        <span>Primary name</span>
        <span class="kmkt-muted">Coming soon</span>
      </div>`, {
      header: ".kachat Name",
      footerHtml: footer(".kachat names aren't on mainnet yet. Your avatar, banner, bio and links save now; you can pick a primary name once names launch."),
    })}
    <div data-kl-profile-save-wrap>${saveHtml()}</div>`;

  // MARK: rendering

  /** Replaces a container's html only when it changed (an unchanged <img> keeps loading). */
  const put = (selector, html) => {
    const el = layer?.el.querySelector(selector);
    if (!el || rendered.get(selector) === html) return;
    rendered.set(selector, html);
    el.innerHTML = html;
  };

  const renderBody = () => {
    if (closed || !layer) return;
    const body = layer.el.querySelector("[data-kl-profile-body]");
    if (!body) return;
    rendered.clear();
    body.innerHTML = loaded ? formHtml() : `<div class="kl-domains-loading">${spinner()}</div>`;
    hydrateSocialImages(body);
  };

  /** Everything but the inputs: lookups, footers, the review card, Save. */
  const renderLive = () => {
    if (closed || !layer || !loaded) return;
    for (const k of SOCIAL_KINDS) {
      put(`[data-kl-src-status="${k}"]`, statusHtml(k));
      put(`[data-kl-src-foot="${k}"]`, fieldFooter(k));
    }
    put("[data-kl-review-wrap]", reviewHtml());
    put("[data-kl-linktree-foot]", linktreeFooter());
    put("[data-kl-profile-save-wrap]", saveHtml());
    hydrateSocialImages(layer.el);
  };

  const renderChrome = () => {
    if (closed || !layer) return;
    const nav = layer.el.querySelector("[data-kl-nav]");
    if (nav) nav.outerHTML = navFor();
    renderLive();
    layer.el.querySelectorAll("[data-kl-profile-body] input, [data-kl-profile-body] select")
      .forEach((el) => { el.disabled = saving; });
  };

  /** Puts a field's platform and handle back into its inputs (a pasted link, a filled field). */
  const syncInputs = (kind) => {
    const el = layer?.el;
    if (!el) return;
    const f = fields[kind];
    const select = el.querySelector(`[data-kl-src-platform="${kind}"]`);
    if (select && select.value !== f.platform) select.value = f.platform;
    const prefix = el.querySelector(`[data-kl-src-prefix="${kind}"]`);
    if (prefix) prefix.textContent = SocialPlatform.prefix(f.platform);
    const input = el.querySelector(`[data-kl-src-handle="${kind}"]`);
    if (input) {
      if (input.value !== f.handle) input.value = f.handle;
      input.placeholder = placeholderFor(f.platform);
    }
  };

  // MARK: lookups

  /** Once one field's account is found, the empty fields take the same account where its
   *  platform can fill them - one handle sets up the whole profile, and each stays editable. */
  const fillEmpty = (fromKind) => {
    const from = fields[fromKind];
    for (const k of SOCIAL_KINDS) {
      if (k === fromKind || !isEmpty(k) || !SocialPlatform.choices(k).includes(from.platform)) continue;
      fields[k].platform = from.platform;
      fields[k].handle = from.handle;
      syncInputs(k);
      lookUp(k);
    }
  };

  /** Debounced: one lookup once typing pauses; `attempt` reruns it for Retry. Only the latest
   *  lookup of a field may land, and whatever happens the state ends somewhere final. */
  const lookUp = (kind) => {
    const f = fields[kind];
    const source = sourceOf(kind);
    const key = `${source?.link ?? ""}#${f.attempt}`;
    if (key === f.key) return;
    f.key = key;
    clearTimeout(f.timer);
    f.timer = null;
    if (!source) {
      f.lookup = "none";
      f.resolved = null;
      renderLive();
      return;
    }
    f.lookup = "looking";
    renderLive();
    f.timer = setTimeout(async () => {
      f.timer = null;
      if (closed || f.key !== key) return;
      const result = await resolver.resolve(source);
      if (closed || f.key !== key) return;
      f.resolved = result.profile ?? null;
      const found = result.profile?.piece(kind) != null;
      f.lookup = found ? "found" : (result.kind === "answered" ? "empty" : "unreachable");
      renderLive();
      if (found) fillEmpty(kind);
    }, 500);
  };

  const load = async () => {
    const address = rt ? rt.actions.myAddress : null;
    if (rt && address) {
      const { registry } = rt;
      if (launched) { try { await registry.refreshIfStale(); } catch { /* use what we have */ } }
      // Start from the newest profile, wherever it was saved (another device included; iOS
      // 5d4ce87), so a save here never overwrites it with an older one.
      try { await registry.syncOwnProfile?.(address); } catch { /* the device copy stays */ }
      let p = null;
      try { p = (await registry.ownProfile(address))?.profile ?? null; } catch { p = null; }
      if (!p) { try { p = (await registry.identity(address))?.profile ?? null; } catch { p = null; } }
      if (p && !closed) {
        for (const k of SOCIAL_KINDS) {
          const s = SocialSource.fromLink(p[k] ?? "", k);
          fields[k].platform = s ? s.platform : SocialPlatform.x;
          fields[k].handle = s ? s.displayHandle : "";
        }
        form.linktree = Profile.linktreeUsername(p.linktree);
      }
      const key = launched ? keyOf(address) : null;
      if (key) {
        try { activeNames = (await registry.namesOf(key, { includeInactive: false })).map((n) => n.name); } catch { activeNames = []; }
      }
      if (p?.primaryName && activeNames.includes(p.primaryName)) form.primary = p.primaryName;
    }
    if (closed) return;
    loaded = true;
    renderBody();
    for (const k of SOCIAL_KINDS) lookUp(k);
  };

  // Review before the record goes out: what will be saved, the network fee, the balance before and
  // after (iOS 7e238e5 KachatProfileSaveSheet). Closing its done sheet closes the editor too.
  const save = async () => {
    if (!rt || saving || !loaded || blocked()) return;
    const record = profile();
    openProfileSaveSheet({
      title: "Save Profile", confirmTitle: "Save Profile", doneTitle: "Profile saved",
      makeProfile: async () => record,
      onSaved: (txId) => { savedTx = txId; if (layer) kit.closeLayer(layer); },
    });
  };

  const onPlatform = (select) => {
    const kind = select.dataset.klSrcPlatform;
    if (!fields[kind] || !SocialPlatform.choices(kind).includes(select.value)) return;
    if (fields[kind].platform === select.value) return;
    fields[kind].platform = select.value;
    syncInputs(kind);
    lookUp(kind);
    renderLive();
  };

  layer = kit.openLayer({
    owner,
    kind: "tall",
    label: "Edit KaChat Profile",
    html: `
      ${navFor()}
      <div class="kmkt-sheet-body kmkt-form" data-kl-profile-body></div>`,
    onClick(event) {
      if (event.target.closest("[data-kl-profile-save]")) { save(); return; }
      const retry = event.target.closest("[data-kl-src-retry]");
      if (retry && fields[retry.dataset.klSrcRetry]) {
        const f = fields[retry.dataset.klSrcRetry];
        f.attempt += 1;
        lookUp(retry.dataset.klSrcRetry);
      }
    },
    onInput(event) {
      const handle = event.target.closest("[data-kl-src-handle]");
      if (handle) {
        const kind = handle.dataset.klSrcHandle;
        const f = fields[kind];
        if (!f) return;
        f.handle = handle.value;
        // A whole pasted link: switch the picker to its platform, keep the handle.
        const pasted = pastedSource(kind);
        if (pasted && SocialPlatform.choices(kind).includes(pasted.platform)) {
          f.platform = pasted.platform;
          f.handle = pasted.displayHandle;
          syncInputs(kind);
        }
        lookUp(kind);
        renderLive();
        return;
      }
      const platform = event.target.closest("[data-kl-src-platform]");
      if (platform) { onPlatform(platform); return; }
      if (event.target.closest("[data-kl-profile-linktree]")) {
        form.linktree = event.target.value;
        renderLive();
        return;
      }
      const primary = event.target.closest("[data-kl-profile-primary]");
      if (primary) form.primary = primary.value;
    },
    onClose() {
      closed = true;
      for (const k of SOCIAL_KINDS) { clearTimeout(fields[k].timer); fields[k].timer = null; }
    },
  });
  // A <select> reports its choice through "change" as well as "input".
  layer.el.addEventListener("change", (event) => {
    const platform = event.target.closest("[data-kl-src-platform]");
    if (platform) { onPlatform(platform); return; }
    const primary = event.target.closest("[data-kl-profile-primary]");
    if (primary) form.primary = primary.value;
  });
  renderBody();
  load();
  return layer;
}
