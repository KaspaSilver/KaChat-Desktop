// The live .kachat screens, TESTNET ONLY (iOS KachatNamesLiveViews.swift, 5df42b4): the hub's
// search, registrations in flight, Marketplace / My Names / Activity, the name detail with its
// actions, every transaction sheet, the Your Domains > .kachat tab, the address profile editor and
// the profile hero's .kachat pictures, bio and Linktree link (kachatHeroProfile), looked up from the
// profile's social links on this device (engine/kachat-names/social-image-resolver.js).
// On mainnet none of this is reached (`kachatNames()` is null) - kachat-market.js keeps its
// "Coming soon" mockups. Every spending or destructive action shows its cost first (built against
// live UTXOs, nothing sent), asks to confirm, then passes the device lock (deps.deviceLock) before
// anything is signed.
//
// The sheets and layers come from kachat-market.js through `initKachatLive(kit)` (no import cycle).
// Nothing runs at import.

import "./kachat-names-live.css";
import { KAS_UNIT, kasLabel } from "../engine/network.js";
import { kachatNames } from "./kachat-names-runtime.js";
import { userFacingError } from "./dialogs.js";
import { Operation, Stage, isOpen, needsDriving, validateKey } from "../engine/kachat-names/actions.js";
import {
  Status, Profile, SocialSource, SocialPlatform, SocialKind, addressOf, keyOf, shortAddress as registryShortAddress,
} from "../engine/kachat-names/registry-state.js";
import { KachatSocialImageResolver, socialFreshForMs } from "../engine/kachat-names/social-image-resolver.js";
import { isProxyAvailable, proxiedUrl } from "../engine/endpoints.js";
import { normalize, p2pkScript, bytesEqual, hex, utf8, unhex32, yearMs } from "../engine/kachat-names/codec.js";
import { paramsPrice, paramsRenewPrice } from "../engine/kachat-names/manifest.js";

/** { getDeps, esc, ICON, openLayer, closeLayer, navBar, sectionHeader, hubChanged(kind), openNameDetail(info) } */
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
const U64_MAX = (1n << 64n) - 1n;
const PRIVACY_SEEN_KEY = "kachat_profile_privacy_seen";

/** Whether the live screens apply here (testnet-10 with the runtime built). */
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

/** "12.5" or "12,5" -> sompi (BigInt); null for anything else or more than 8 decimals. */
export function parseSompi(text) {
  const t = String(text ?? "").trim().replace(/,/g, ".");
  if (!t) return null;
  const parts = t.split(".");
  if (parts.length > 2) return null;
  const whole = parts[0] === "" ? "0" : parts[0];
  if (!/^[0-9]+$/.test(whole)) return null;
  let frac = 0n;
  if (parts.length === 2) {
    const f = parts[1];
    if (f.length > 8 || !/^[0-9]*$/.test(f)) return null;
    frac = BigInt(f.padEnd(8, "0"));
  }
  const value = BigInt(whole) * SOMPI_PER_KAS + frac;
  return value > U64_MAX ? null : value;
}

/** A decimal amount field: digits and one point (a comma reads as the point), 8 decimals at most. */
function sanitizeAmountInput(input) {
  let value = input.value.replace(/,/g, ".").replace(/[^0-9.]/g, "");
  const dot = value.indexOf(".");
  if (dot !== -1) value = value.slice(0, dot + 1) + value.slice(dot + 1).replace(/\./g, "").slice(0, 8);
  if (value !== input.value) input.value = value;
  return value;
}

function dayText(ms) {
  if (ms == null) return "";
  const d = new Date(Number(ms));
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
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

const yearsLabel = (y) => (Number(y) === 1 ? "1 year" : `${Number(y)} years`);

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
function params() { return kachatNames()?.service.manifest?.params ?? null; }
function maxYears() { const m = params()?.maxYears; return m ? Number(m) : 2; }
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
  wifiExclaim: svg(`<path d="M2.8 9.2a13.3 13.3 0 0 1 14.6-2.6M5.9 12.6a8.8 8.8 0 0 1 8.4-2.1M9.1 15.9a4.3 4.3 0 0 1 3.4-1"/><path d="M12 19.4h.01"/><path d="M19.4 10.4v4.8M19.4 18.6h.01"/>`),
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
    case "renew": return LI.refresh;
    case "release": return LI.uturn;
    case "reclaim": return LI.reclaim;
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
    case "renew": return "Renewed";
    case "release": return "Released";
    case "reclaim": return "Reclaimed";
    case "offer": return "Offer made";
    case "offer_withdraw": return "Offer withdrawn";
    case "offer_refund": return "Offer refunded";
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
  const label = status === Status.active ? "Active" : status === Status.grace ? "Expired" : "Lapsed";
  return `<span class="kl-status kl-status-${esc(status)}">${esc(label)}</span>`;
}

function testnetBadge() { return `<span class="kl-testnet-badge">Testnet</span>`; }

/** One name in a list (KachatLiveNameRow): the name, a line about it, its price or status. */
function nameRowHtml(info, { showPrice = true } = {}) {
  rememberName(info);
  const status = info.status(graceMs());
  let who = "";
  if (isMine(info.owner)) who = "Yours";
  else { const a = addressOf(info.owner); if (a) who = shortAddr(a); }
  const right = showPrice && info.isListed && status === Status.active
    ? `<span class="kl-row-price">${esc(amountText(info.price))}</span>`
    : status !== Status.active ? statusPill(status) : "";
  return `
    <button class="kmkt-row kl-name-row" type="button" data-kl-open-name="${esc(info.name)}">
      <span class="kl-at-badge">${kit.ICON.at}</span>
      <span class="kl-row-text">
        <strong>${esc(info.display)}</strong>
        <small>${who ? `${esc(who)} · ` : ""}until ${esc(dayText(info.expiresAt))}</small>
      </span>
      ${right}
      <span class="kmkt-row-chevron">${kit.ICON.chevron}</span>
    </button>`;
}

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

/** KachatOfferRow: withdraw / refund for the buyer, Accept for the owner (indexer only). */
function offerRowHtml(offer, { isBuyer, isOwner, nameInfo = null }) {
  rememberOffer(offer);
  if (nameInfo) rememberName(nameInfo);
  const daa = kachatNames()?.actions.virtualDaa ?? null;
  const refundable = daa != null && offer.refundable(daa);
  let who = "";
  if (isBuyer) who = "Your offer";
  else { const a = addressOf(offer.buyer); if (a) who = shortAddr(a); }
  const id = esc(offer.id);
  const nameAttr = nameInfo ? ` data-kl-offer-name="${esc(nameInfo.name)}"` : "";
  let buttons = "";
  if (isBuyer) {
    buttons = `<button class="secondary-button accent kmkt-small-button" type="button" data-kl-offer-act="withdraw" data-kl-offer-id="${id}">Withdraw</button>`
      + (refundable ? `<button class="secondary-button accent kmkt-small-button" type="button" data-kl-offer-act="refund" data-kl-offer-id="${id}">Refund</button>` : "");
  } else if (isOwner) {
    buttons = `<button class="primary-button kmkt-small-button" type="button" data-kl-offer-act="accept" data-kl-offer-id="${id}"${nameAttr}>Accept</button>`;
  } else if (refundable) {
    buttons = `<button class="secondary-button accent kmkt-small-button" type="button" data-kl-offer-act="refund" data-kl-offer-id="${id}">Refund</button>`;
  }
  return `
    <div class="kmkt-row static compact kl-offer-row">
      <span class="kmkt-row-icon w24">${kit.ICON.hand}</span>
      <span class="kl-row-text">
        ${offer.name ? `<strong>${esc(`${offer.name}.kachat`)}</strong>` : ""}
        ${who ? `<small>${esc(who)}</small>` : ""}
        ${refundable ? `<small class="kl-orange">Refundable now</small>` : ""}
      </span>
      <span class="kl-row-price">${esc(amountText(offer.amount))}</span>
      ${buttons ? `<span class="kl-row-buttons">${buttons}</span>` : ""}
    </div>`;
}

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

function explorerLink(txId) {
  const fn = deps().explorerTxUrl;
  if (typeof fn !== "function") return "";
  return `<a class="kl-link" href="${esc(fn(txId))}" target="_blank" rel="noopener noreferrer">${LI.external}<span>View in Explorer</span></a>`;
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
  search: { kind: "idle" },
  listings: [],
  lapsed: [],
  mine: [],
  myOffers: [],
  activity: [],
  loadError: null,
  loaded: false,
  refreshing: false,
};
let hubVisible = false;
let hubUnsubscribe = null;
let hubStarting = null;
let hubReloading = null;
let hubReloadAgain = false;
let lookupTimer = null;
let lookupSeq = 0;
/** Per registration: { working, error } (KachatRegistrationCard's own state). */
const registrationUi = new Map();

/** The hub is live: testnet with the manifest verified. */
export function liveHubIsLive() { return liveEnabled() && hub.ready === true; }

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
  hubStart();
}

/** The .kachat screen went off. Registrations keep driving; the hub stops reloading. */
export function liveHubHide() {
  hubVisible = false;
  hubUnsubscribe?.();
  hubUnsubscribe = null;
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
    } catch (error) {
      hub.ready = false;
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
    const me = myKey();
    if (me) {
      hub.mine = await registry.namesOf(me, { includeInactive: true });
      hub.myOffers = await registry.myOffers(me);
      if (hub.myOffers.length) await actions.refreshVirtualDaa().catch(() => null);
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
    const r = await rt.registry.lookup(typed);
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

function pricePerYear(name) {
  const p = params();
  return p ? paramsPrice(p, utf8(name).length) : null;
}

// ---------------------------------------------------------------------------------------------
// Hub: hero, header, search result
// ---------------------------------------------------------------------------------------------

/** The hero's status line: the Testnet badge when live, else Coming soon (and why it isn't live). */
export function liveHeroStatusHtml(comingSoonHtml) {
  if (liveHubIsLive()) return testnetBadge();
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
      default: line = "Lapsed - reclaim it, then claim it"; cls = "kl-red"; break;
    }
    return `
      <button class="kmkt-search-result kl-search-link" type="button" data-kl-open-name="${esc(n.name)}">
        <div class="kmkt-search-result-copy">
          <strong>${esc(n.display)}</strong>
          <small class="${cls}">${esc(line)}</small>
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
          ${price != null ? `<small class="kl-green">${esc(`Available · ${amountText(price)} a year`)}</small>` : ""}
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

/** One subscription for the app's lifetime: the hub's cards follow it, and a registration that
 *  completes tells the app its identity may have changed (the profile hero). */
function watchRegistrations() {
  const rt = kachatNames();
  if (!rt || registrationsUnsubscribe) return;
  registrationsUnsubscribe = rt.actions.subscribe(({ pending }) => {
    let completed = false;
    for (const p of pending) {
      const before = registrationStages.get(p.id);
      if (before && before !== Stage.registered && p.stage === Stage.registered) completed = true;
      registrationStages.set(p.id, p.stage);
    }
    if (completed) identityChanged();
    hubChanged("pending");
  });
  for (const p of rt.actions.pending) registrationStages.set(p.id, p.stage);
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
  const cancel = `<button class="secondary-button kl-danger kmkt-small-button" type="button" data-kl-reg-cancel="${id}" ${ui.working ? "disabled" : ""}>Cancel Commit</button>`;
  let buttons = "";
  if (p.stage === Stage.registered) buttons = `<button class="secondary-button accent kmkt-small-button" type="button" data-kl-reg-done="${id}">Done</button>`;
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
      ${message ? `<p class="kl-error">${esc(message)}</p>` : ""}
      ${buttons ? `<div class="kl-reg-buttons">${buttons}</div>` : ""}
    </section>`;
}

/** The registrations in flight, between the search and the tabs (live only). */
export function liveRegistrationsHtml() {
  const rt = kachatNames();
  if (!rt || !liveHubIsLive()) return "";
  return rt.actions.pending.filter(isOpen).map(registrationCardHtml).join("");
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
  hubChanged("pending");
  try {
    await rt.actions.cancel(id);
    registrationUi.set(id, { working: false, error: null });
  } catch (error) {
    registrationUi.set(id, { working: false, error: errorText(error) });
  }
  hubChanged("pending");
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

/** KachatLiveMarketPage. */
function marketPageHtml() {
  const listings = hub.listings.length
    ? listCard(hub.listings.map((n) => nameRowHtml(n)).join(""))
    : emptyCard(hub.loaded ? "No names are listed right now." : null);
  const lapsed = hub.lapsed.length
    ? listCard(hub.lapsed.map((n) => `
        <div class="kl-split">
          ${nameRowHtml(n, { showPrice: false })}
          <button class="secondary-button accent kmkt-small-button" type="button" data-kl-reclaim="${esc(n.name)}">Reclaim</button>
        </div>`).join(""))
    : emptyCard(hub.loaded ? "Nothing to reclaim." : null);
  return `
    <div class="kmkt-page">
      ${loadErrorHtml()}
      ${kit.sectionHeader("For sale", "Names their owners have listed. Buying pays the owner and moves the name to you in one transaction.")}
      ${listings}
      ${kit.sectionHeader("Reclaimable", "Names whose owners let them lapse. Anyone may reclaim one: the bond goes back to its last owner, you keep the freed deposit as a bounty, and the name is free to claim.")}
      ${lapsed}
    </div>`;
}

/** KachatLiveMyNamesPage. */
function myNamesPageHtml() {
  const names = hub.mine.length
    ? listCard(hub.mine.map((n) => nameRowHtml(n)).join(""))
    : `
      <div class="kmkt-empty kl-empty">
        <span class="kmkt-empty-icon">${kit.ICON.atCircle}</span>
        <h3>No .kachat names yet</h3>
        <p>Search for a name above and claim it.</p>
      </div>`;
  const offers = hub.myOffers.length
    ? listCard(hub.myOffers.map((o) => offerRowHtml(o, { isBuyer: true, isOwner: false })).join(""), 50)
    : emptyCard(hub.loaded ? "No open offers." : null);
  return `
    <div class="kmkt-page">
      ${loadErrorHtml()}
      ${kit.sectionHeader("My Names", "Renew, list, transfer or release them, and pick the one KaChat shows for you.")}
      ${names}
      ${kit.sectionHeader("My Offers", "Offers you made. Withdraw one any time; once it passes its refund time anyone can return it to you.")}
      ${offers}
      ${chainNote()}
    </div>`;
}

/** KachatLiveActivityPage. */
function activityPageHtml() {
  const events = hub.activity.slice(0, 100);
  const list = events.length
    ? listCard(events.map((e) => eventRowHtml(e, { showName: true })).join(""), 56)
    : emptyCard(hub.loaded ? "Nothing yet." : null);
  return `
    <div class="kmkt-page">
      ${loadErrorHtml()}
      ${kit.sectionHeader("Recent activity", "Claims, renewals, listings, sales and transfers across the registry.")}
      ${list}
    </div>`;
}

/** The selected tab's live page. */
export function livePageHtml(page) {
  if (page === "myNames") return myNamesPageHtml();
  if (page === "activity") return activityPageHtml();
  return marketPageHtml();
}

/** Clicks on the live hub (search result, registrations, pages). True when handled. */
export function liveHubClick(event) {
  const target = event.target;
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
  const done = target.closest("[data-kl-reg-done]");
  if (done) { kachatNames()?.actions.dismiss(done.dataset.klRegDone); return true; }
  const dismiss = target.closest("[data-kl-reg-dismiss]");
  if (dismiss) { dismissFailedRegistration(dismiss.dataset.klRegDismiss); return true; }
  const retry = target.closest("[data-kl-reg-retry]");
  if (retry) {
    registrationUi.delete(retry.dataset.klRegRetry);
    kachatNames()?.actions.retry(retry.dataset.klRegRetry);
    return true;
  }
  const cancel = target.closest("[data-kl-reg-cancel]");
  if (cancel) { if (!cancel.disabled) cancelRegistration(cancel.dataset.klRegCancel); return true; }
  const reclaim = target.closest("[data-kl-reclaim]");
  if (reclaim) {
    const info = nameIndex.get(reclaim.dataset.klReclaim);
    if (info) openReclaimSheet(info, "market");
    return true;
  }
  const offerAct = target.closest("[data-kl-offer-act]");
  if (offerAct) {
    const offer = offerIndex.get(offerAct.dataset.klOfferId);
    const name = offerAct.dataset.klOfferName ? nameIndex.get(offerAct.dataset.klOfferName) : null;
    if (offer) openOfferActionSheet(offerAct.dataset.klOfferAct, offer, name, "market");
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// The transaction sheet (KachatTxSheet)
// ---------------------------------------------------------------------------------------------

/**
 * Every action's sheet: its inputs, what it costs (built against live UTXOs, nothing sent), one
 * Confirm - an extra warning for the destructive ones - then the device lock, then the
 * transaction. Shows the txid when it is sent.
 *
 * cfg: { owner, title, confirmTitle, warning?, footer?: () => string|null, rows?: () => [{title, value}],
 *        inputsHtml?: string, operation: () => op|null, operationKey: () => string,
 *        onInput?(event, sheet), onClick?(event, sheet), onOpen?(sheet), onDone?(txId) }
 */
function openTxSheet(cfg) {
  const rt = kachatNames();
  if (!rt || !kit) return null;
  const sheet = {
    plan: null, op: null, planError: null, building: false, sending: false, txId: null, sendError: null,
    key: undefined, seq: 0, timer: null, layer: null, closed: false,
  };

  const navFor = () => (sheet.txId
    ? navHtml(cfg.title, { trailing: { label: "Done", bold: true } })
    : navHtml(cfg.title, { leading: { label: "Cancel" } }));

  const summaryHtml = () => {
    let rows = (cfg.rows?.() ?? []).map((r) => formRow(r.title, r.value)).join("");
    if (sheet.plan) {
      if (sheet.plan.priceFee > 0n) rows += formRow("Price (to miners)", amountText(sheet.plan.priceFee));
      rows += formRow("Network fee", amountText(sheet.plan.networkFee));
      const me = myKey();
      if (me) rows += formRow("Your balance", signedAmount(balanceChange(sheet.plan, me)), { bold: true });
    } else if (sheet.building) {
      rows += formRow("Network fee", "", { valueHtml: spinner() });
    }
    const foot = sheet.planError ? footer(sheet.planError, "kl-red") : footer(cfg.footer?.() ?? null);
    const warning = cfg.warning ? `
      <section class="kmkt-form-section">
        <div class="kmkt-form-card"><div class="kmkt-form-row kl-warning">${LI.warning}<span>${esc(cfg.warning)}</span></div></div>
      </section>` : "";
    const action = sheet.txId
      ? `<div class="kmkt-form-row kl-sent">
          <span class="kl-sent-title kl-green">${LI.checkCircle}<span>Sent</span></span>
          <span class="kl-mono">${esc(sheet.txId)}</span>
          ${explorerLink(sheet.txId)}
          <small class="kmkt-muted">It shows here once the network accepts it, usually within seconds.</small>
        </div>`
      : `<button class="kmkt-form-button ${cfg.warning ? "kl-destructive" : ""}" type="button" data-kl-tx-confirm ${!sheet.plan || sheet.sending ? "disabled" : ""}>
          ${sheet.sending ? spinner() : esc(cfg.confirmTitle)}
        </button>`;
    return `
      ${section(rows, { footerHtml: foot })}
      ${warning}
      ${section(action, { footerHtml: sheet.sendError ? footer(sheet.sendError, "kl-red") : "" })}`;
  };

  sheet.render = () => {
    if (sheet.closed || !sheet.layer) return;
    const el = sheet.layer.el;
    const nav = el.querySelector("[data-kl-nav]");
    if (nav) nav.outerHTML = navFor();
    const summary = el.querySelector("[data-kl-summary]");
    if (summary) summary.innerHTML = summaryHtml();
    const inputs = el.querySelector("[data-kl-inputs]");
    if (inputs) inputs.disabled = Boolean(sheet.txId || sheet.sending);
  };

  /** Rebuilds the plan when the operation changed (inputs), 300 ms after the last change. */
  sheet.update = () => {
    if (sheet.txId) { sheet.render(); return; }
    const key = cfg.operationKey();
    if (key === sheet.key) { sheet.render(); return; }
    sheet.key = key;
    sheet.plan = null;
    sheet.op = null;
    sheet.planError = null;
    clearTimeout(sheet.timer);
    const op = cfg.operation();
    const seq = ++sheet.seq;
    if (!op) { sheet.building = false; sheet.render(); return; }
    sheet.building = true;
    sheet.render();
    sheet.timer = setTimeout(async () => {
      try {
        const plan = await rt.actions.plan(op);
        if (seq !== sheet.seq || sheet.closed) return;
        sheet.plan = plan;
        sheet.op = op;
      } catch (error) {
        if (seq !== sheet.seq || sheet.closed) return;
        sheet.planError = errorText(error);
      }
      sheet.building = false;
      sheet.render();
    }, 300);
  };

  const confirm = async () => {
    if (!sheet.plan || !sheet.op || sheet.sending || sheet.txId) return;
    const op = sheet.op;
    if (cfg.warning) {
      const ok = await confirmAsk({ title: cfg.title, message: cfg.warning, confirmLabel: cfg.confirmTitle, destructive: true });
      if (!ok) return;
    }
    if (!(await deviceLock())) return;
    if (sheet.closed || op !== sheet.op) return;
    sheet.sending = true;
    sheet.sendError = null;
    sheet.render();
    try {
      const txId = await rt.actions.perform(op);
      sheet.txId = txId;
      try { cfg.onDone?.(txId); } catch { /* the sheet still shows it */ }
    } catch (error) {
      sheet.sendError = errorText(error);
    }
    sheet.sending = false;
    sheet.render();
  };

  sheet.layer = kit.openLayer({
    owner: cfg.owner || "market",
    kind: "tall",
    label: cfg.title,
    html: `
      ${navFor()}
      <div class="kmkt-sheet-body kmkt-form kl-tx-body">
        ${cfg.inputsHtml ? `<fieldset class="kl-fieldset" data-kl-inputs>${cfg.inputsHtml}</fieldset>` : ""}
        <div class="kl-summary" data-kl-summary></div>
      </div>`,
    onClick(event) {
      if (event.target.closest("[data-kl-tx-confirm]")) { confirm(); return; }
      cfg.onClick?.(event, sheet);
    },
    onInput: (event) => cfg.onInput?.(event, sheet),
    onClose() { sheet.closed = true; clearTimeout(sheet.timer); },
  });
  sheet.update();
  try { cfg.onOpen?.(sheet); } catch { /* optional */ }
  return sheet;
}

function amountInputHtml(attr, label) {
  return `
    <label class="kmkt-form-row kmkt-amount-row">
      <input class="kmkt-amount-input" type="text" inputmode="decimal" placeholder="0" autocomplete="off" ${attr} aria-label="${esc(label)}" />
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
  const soon = info.expiresAt - 30n * 86_400_000n < BigInt(Date.now());
  openTxSheet({
    owner,
    title: "Buy Name",
    confirmTitle: "Confirm Purchase",
    footer: () => (soon
      ? "Less than 30 days are left before this name expires. You'd have to renew it soon."
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

const OFFER_DAYS = [
  { id: 1, title: "1 Day" },
  { id: 3, title: "3 Days" },
  { id: 7, title: "7 Days" },
  { id: 30, title: "30 Days" },
];

/** KachatLiveOfferSheet: an amount, when it becomes refundable, and the cost. */
function openOfferSheet(info, owner) {
  const name = info.name;
  let amountRaw = "";
  let days = 3;
  let virtualDaa = null;
  const amount = () => { const a = parseSompi(amountRaw); return a != null && a > 0n ? a : null; };
  const refundAfter = () => (virtualDaa == null ? null : virtualDaa + BigInt(days) * 86_400n * DAA_PER_SECOND);
  openTxSheet({
    owner,
    title: "Make an Offer",
    confirmTitle: "Send Offer",
    inputsHtml: `
      ${section(amountInputHtml("data-kl-offer-amount", `Your offer in ${KAS_UNIT}`), {
        header: "Your offer",
        footerHtml: footer(kasLabel("Your KAS stays locked on chain until the owner accepts, you withdraw the offer, or it expires - then anyone can send it back to you.")),
      })}
      ${section(`<div class="kmkt-form-row kmkt-segment-row">${segmentedHtml("days", OFFER_DAYS, days, "Refundable after")}</div>`, { header: "Refundable after" })}`,
    footer: () => {
      const a = amount();
      return info.isListed && a != null && info.price < a
        ? "This name is listed for less than your offer. Anyone could buy the listing with your offer, so consider buying it instead."
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
      return a != null && after != null ? Operation.offer(name, a, after, info) : null;
    },
    operationKey: () => `${amount() ?? 0n}-${days}-${virtualDaa ?? 0n}`,
    onInput(event, sheet) {
      const input = event.target.closest("[data-kl-offer-amount]");
      if (!input) return;
      amountRaw = sanitizeAmountInput(input);
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

/** KachatRenewSheet. */
function openRenewSheet(info, owner) {
  let years = 1;
  const p = params();
  const perYear = p ? paramsRenewPrice(p, utf8(info.name).length) : 0n;
  openTxSheet({
    owner,
    title: "Renew",
    confirmTitle: "Renew",
    inputsHtml: section(`<div class="kmkt-form-row kmkt-segment-row">${segmentedHtml("years", yearsOptions(), years, "Years")}</div>`),
    footer: () => "A renewal adds to the current expiry, even after it passed. The price goes to the miners.",
    rows: () => [
      { title: "Name", value: info.display },
      { title: "Price per year", value: amountText(perYear) },
      { title: "New expiry", value: dayText(info.expiresAt + BigInt(years) * yearMs) },
    ],
    operation: () => Operation.renew(info, BigInt(years)),
    operationKey: () => `renew-${years}`,
    onClick(event, sheet) {
      const chosen = segmentedClick(event, sheet.layer.el);
      if (chosen?.group === "years") { years = Number(chosen.id); sheet.update(); }
    },
  });
}

/** KachatListSheet: List for Sale / Change Price. */
function openListSheet(info, owner) {
  let priceRaw = "";
  const price = () => { const v = parseSompi(priceRaw); return v != null && v > 0n ? v : null; };
  openTxSheet({
    owner,
    title: info.isListed ? "Change Price" : "List for Sale",
    confirmTitle: info.isListed ? "Change Price" : "List",
    inputsHtml: section(amountInputHtml("data-kl-list-price", `Price in ${KAS_UNIT}`), { header: "Price" }),
    footer: () => "Anyone can buy it at this price: the payment reaches you and the name reaches them in one transaction. Delist any time.",
    rows: () => (info.isListed ? [{ title: "Listed at", value: amountText(info.price) }] : []),
    operation: () => { const v = price(); return v != null ? Operation.list(info, v) : null; },
    operationKey: () => `list-${price() ?? 0n}`,
    onInput(event, sheet) {
      const input = event.target.closest("[data-kl-list-price]");
      if (!input) return;
      priceRaw = sanitizeAmountInput(input);
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

/** KachatTransferSheet: to an address or a .kachat name, the resolved address shown. */
function openTransferSheet(info, owner) {
  let input = "";
  let resolved = null; // { address, key }
  let resolveError = null;
  let resolving = false;
  let timer = null;
  let seq = 0;
  const statusHtml = () => {
    if (resolving) return spinner();
    if (resolved) return `<span class="kl-mono">${esc(resolved.address)}</span>`;
    if (resolveError) return `<small class="kl-red">${esc(resolveError)}</small>`;
    return "";
  };
  const showStatus = (sheet) => {
    const el = sheet.layer?.el.querySelector("[data-kl-transfer-status]");
    if (el) { el.innerHTML = statusHtml(); el.hidden = !el.innerHTML.trim(); }
  };
  const resolve = async (sheet) => {
    const mySeq = ++seq;
    resolved = null;
    resolveError = null;
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
    const name = normalize(t);
    if (invalidReason(name)) {
      resolveError = "Enter an address or a .kachat name.";
      showStatus(sheet);
      sheet.update();
      return;
    }
    resolving = true;
    showStatus(sheet);
    sheet.update();
    try {
      const rt = kachatNames();
      const r = await rt.registry.lookup(name);
      if (mySeq !== seq) return;
      if (r.kind === "registered" && r.info.status(graceMs()) === Status.active) {
        const a = addressOf(r.info.owner);
        if (a) resolved = { address: a, key: r.info.owner };
      } else {
        resolveError = "No active .kachat name by that name.";
      }
    } catch {
      if (mySeq !== seq) return;
      resolveError = "Couldn't look that name up.";
    }
    resolving = false;
    showStatus(sheet);
    sheet.update();
  };
  openTxSheet({
    owner,
    title: "Transfer",
    confirmTitle: "Transfer",
    warning: "A transfer can't be undone. The new owner gets the name with its current expiry; your profile stays with your address.",
    inputsHtml: section(`
      <label class="kmkt-form-row">
        <input class="kl-input" type="text" placeholder="kaspatest:... or name.kachat" autocomplete="off" autocapitalize="none"
          autocorrect="off" spellcheck="false" data-kl-transfer-input aria-label="New owner" />
      </label>
      <div class="kmkt-form-row kl-status-row" data-kl-transfer-status hidden></div>`, {
      header: "New owner",
      footerHtml: footer("A testnet address, or a .kachat name - it's resolved to the address shown."),
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

/** KachatReclaimSheet. */
function openReclaimSheet(info, owner) {
  openTxSheet({
    owner,
    title: "Reclaim",
    confirmTitle: "Reclaim",
    footer: () => "The name's bond goes back to its last owner, you keep the freed registry deposit (less the fee) as a bounty, and the name is free. To own it, claim it afterwards.",
    rows: () => [
      { title: "Name", value: info.display },
      { title: "Bond to the last owner", value: amountText(params()?.bond ?? 0n) },
    ],
    operation: () => Operation.reclaim(info),
    operationKey: () => `reclaim-${txKey(info)}`,
  });
}

/** KachatOfferAction: withdraw, refund or accept an offer. */
function openOfferActionSheet(kind, offer, nameInfo, owner) {
  if (kind === "withdraw") {
    openTxSheet({
      owner, title: "Withdraw Offer", confirmTitle: "Withdraw",
      rows: () => [{ title: "Offer", value: amountText(offer.amount) }],
      operation: () => Operation.withdraw(offer), operationKey: () => offer.id,
    });
  } else if (kind === "refund") {
    openTxSheet({
      owner, title: "Refund Offer", confirmTitle: "Refund",
      rows: () => [{ title: "Offer", value: amountText(offer.amount) }],
      operation: () => Operation.refund(offer), operationKey: () => offer.id,
    });
  } else if (kind === "accept" && nameInfo) {
    const buyer = addressOf(offer.buyer);
    openTxSheet({
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
// Claim (KachatClaimSheet)
// ---------------------------------------------------------------------------------------------

function openClaimSheet({ name, gap, owner = "market" }) {
  const rt = kachatNames();
  if (!rt || !kit) return;
  let years = 1;
  let quote = null;
  let quoteError = null;
  let starting = false;
  let startError = null;
  let seq = 0;
  let closed = false;

  const costHtml = () => {
    let rows;
    if (quote) {
      const y = quote.years > 0n ? quote.years : 1n;
      rows = formRow("Price (to miners)", `${amountText(quote.price / y)} × ${quote.years}`)
        + formRow("Bond (returned on release)", amountText(quote.bond))
        + formRow("Registry deposit (returned on release)", amountText(quote.gapDeposit))
        + formRow("Commit (returned at registration)", amountText(quote.commit))
        + formRow("Network fees", amountText(quote.networkFee))
        + formRow("Total", amountText(quote.total), { bold: true })
        + formRow("Available", amountText(quote.spendable));
    } else if (quoteError) {
      rows = `<div class="kmkt-form-row"><span class="kl-red">${esc(quoteError)}</span></div>`;
    } else {
      rows = formRow("Total", "", { valueHtml: spinner() });
    }
    const foot = quote && !quote.affordable
      ? footer(kasLabel("Not enough KAS on your chatting address for this name."), "kl-red")
      : footer("The price goes to the miners - KaChat takes nothing. The bond and the deposit come back when you release the name.");
    return section(rows, { header: "Cost", footerHtml: foot });
  };

  const actionHtml = () => section(
    `<button class="kmkt-form-button" type="button" data-kl-claim-start ${quote?.affordable !== true || starting ? "disabled" : ""}>
      ${starting ? spinner() : esc(`Claim ${name}.kachat`)}
    </button>`,
    { footerHtml: startError ? footer(startError, "kl-red") : "" },
  );

  const step = (n, text) => `
    <div class="kmkt-form-row kl-step-row">
      <span class="kl-step-num">${n}</span>
      <span class="kl-label-text">${esc(text)}</span>
    </div>`;

  let layer = null;
  const render = () => {
    if (closed || !layer) return;
    const cost = layer.el.querySelector("[data-kl-claim-cost]");
    if (cost) cost.innerHTML = costHtml();
    const action = layer.el.querySelector("[data-kl-claim-action]");
    if (action) action.innerHTML = actionHtml();
  };

  const loadQuote = async () => {
    const mySeq = ++seq;
    quote = null;
    quoteError = null;
    render();
    try {
      const q = await rt.actions.quote({ name, years: BigInt(years), gap });
      if (mySeq !== seq || closed) return;
      quote = q;
    } catch (error) {
      if (mySeq !== seq || closed) return;
      quoteError = errorText(error);
    }
    render();
  };

  const start = async () => {
    if (starting || quote?.affordable !== true) return;
    if (!(await deviceLock())) return;
    if (closed) return;
    starting = true;
    startError = null;
    render();
    try {
      await rt.actions.startRegistration({ name, years: BigInt(years) });
      starting = false;
      kit.closeLayer(layer);
      hubChanged("pending");
      return;
    } catch (error) {
      startError = errorText(error);
    }
    starting = false;
    render();
  };

  layer = kit.openLayer({
    owner,
    kind: "tall",
    label: "Claim Name",
    html: `
      ${navHtml("Claim Name", { leading: { label: "Cancel" } })}
      <div class="kmkt-sheet-body kmkt-form">
        ${section(`
          ${formRow("Name", `${name}.kachat`, { bold: false })}
          <div class="kmkt-form-row kmkt-segment-row">${segmentedHtml("years", yearsOptions(), years, "Years")}</div>`)}
        <div data-kl-claim-cost></div>
        ${section(
          step(1, "A hidden commit goes on chain first. Nobody can see which name it is for.")
          + step(2, "About a minute later KaChat registers the name by itself. Keep the app open; if you leave, it continues next time.")
          + step(3, "The name is yours for the years you paid. Renew it any time before it expires."),
          { header: "How claiming works" },
        )}
        <div data-kl-claim-action></div>
      </div>`,
    onClick(event, l) {
      if (event.target.closest("[data-kl-claim-start]")) { start(); return; }
      const chosen = segmentedClick(event, l.el);
      if (chosen?.group === "years" && Number(chosen.id) !== years) { years = Number(chosen.id); loadQuote(); }
    },
    onClose() { closed = true; },
  });
  render();
  loadQuote();
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
    active: true,
    layer,
    unsubscribe: [],
  };
  const rt = () => kachatNames();
  const mine = () => isMine(d.info.owner);
  const status = () => d.info.status(graceMs());
  const ownerAddress = () => addressOf(d.info.owner);

  const nameCard = () => {
    const s = status();
    let note = "";
    if (s === Status.grace && mine()) note = `<p class="kl-note-inline kl-orange">Expired - renew to keep it. Until the grace period ends nobody else can take it.</p>`;
    else if (s === Status.grace) note = `<p class="kl-note-inline kl-orange">Expired. It no longer resolves; the owner can still renew it.</p>`;
    else if (s === Status.lapsed) note = `<p class="kl-note-inline kl-red">Lapsed: anyone may reclaim it, and then claim it again.</p>`;
    return `
      <section class="kmkt-card kmkt-name-card">
        <div class="kmkt-name-art"><span class="kl-name-art-text">${esc(d.info.display)}</span></div>
        <div class="kmkt-price-line">
          <div class="kmkt-price">
            <small>${d.info.isListed ? "Price" : "Not for sale"}</small>
            ${d.info.isListed ? `<strong class="kl-price">${esc(amountText(d.info.price))}</strong>` : ""}
          </div>
          <div class="kl-expiry">
            ${statusPill(s)}
            <small class="kmkt-muted">${esc(`Expires ${dayText(d.info.expiresAt)}`)}</small>
          </div>
        </div>
        ${note}
      </section>`;
  };

  const actionButton = (title, icon, act, { prominent = false, disabled = false, danger = false } = {}) => `
    <button class="${prominent ? "primary-button" : danger ? "secondary-button kl-danger" : "secondary-button accent"} kmkt-action" type="button"
      data-kl-act="${esc(act)}" ${disabled ? "disabled" : ""}>${icon}<span>${esc(title)}</span></button>`;

  const actionButtons = () => {
    const s = status();
    const I = kit.ICON;
    if (mine()) {
      const primary = actionButton("Set as Primary", LI.personCheck, "primary", { disabled: s !== Status.active || d.primaryWorking });
      return `
        <div class="kl-action-grid">
          <div class="kmkt-actions">
            ${actionButton("Renew", LI.refresh, "renew", { prominent: s !== Status.active })}
            ${actionButton(d.info.isListed ? "Change Price" : "List for Sale", I.tag, "list", { disabled: s !== Status.active })}
          </div>
          <div class="kmkt-actions">
            ${actionButton("Transfer", I.swap, "transfer")}
            ${d.info.isListed ? actionButton("Delist", LI.tagSlash, "delist") : primary}
          </div>
          ${d.info.isListed ? `<div class="kmkt-actions">${primary}</div>` : ""}
          <div class="kmkt-actions">${actionButton("Release Name", LI.trash, "release", { danger: true })}</div>
        </div>`;
    }
    if (s === Status.lapsed) {
      return `<div class="kl-action-grid"><div class="kmkt-actions">${actionButton("Reclaim", LI.reclaim, "reclaim", { prominent: true })}</div></div>`;
    }
    return `
      <div class="kl-action-grid">
        <div class="kmkt-actions">
          ${d.info.isListed && s === Status.active ? actionButton("Buy Now", I.cart, "buy", { prominent: true }) : ""}
          ${actionButton("Make an Offer", I.hand, "offer")}
        </div>
      </div>`;
  };

  const ownerCard = () => {
    const address = ownerAddress();
    const label = mine() ? "You" : d.ownerLabel ? `${d.ownerLabel}.kachat` : "";
    return `
      <section class="kmkt-block">
        ${kit.sectionHeader("Owner")}
        <div class="kmkt-card kmkt-seller kl-owner">
          <span class="kl-owner-icon">${kit.ICON.personCircle}</span>
          <div class="kmkt-seller-copy">
            ${label ? `<strong>${esc(label)}</strong>` : ""}
            ${address ? `<span class="kl-mono">${esc(address)}</span>` : ""}
          </div>
          ${!mine() && address ? `<button class="secondary-button accent kmkt-small-button" type="button" data-kl-message>${kit.ICON.bubbles}<span>Message</span></button>` : ""}
        </div>
      </section>`;
  };

  const offersSection = () => {
    const isOwnerIndexer = mine() && !!rt()?.registry.isIndexer;
    const list = d.offers.length
      ? listCard(d.offers.map((o) => offerRowHtml(o, { isBuyer: isMine(o.buyer), isOwner: isOwnerIndexer, nameInfo: d.info })).join(""), 50)
      : `<div class="kmkt-card kmkt-empty-card">No open offers.</div>`;
    return `
      <section class="kmkt-block">
        ${kit.sectionHeader("Offers", mine() ? "Accept one to sell the name for it." : "")}
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
    ${d.gone
      ? `<p class="kl-note">This name was released or reclaimed. It's free to claim again.</p>`
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
      if (found.kind === "registered") { d.info = rememberName(found.info); d.gone = false; } else { d.gone = true; }
    } catch { /* keep what we have */ }
    const address = ownerAddress();
    if (!mine() && address) {
      try { d.ownerLabel = (await registry.identity(address))?.label ?? null; } catch { /* no label */ }
    }
    try { d.offers = await registry.offersFor(d.info.name); } catch { d.offers = []; }
    try { d.history = await registry.history(d.info.name); } catch { d.history = []; }
    if (d.offers.length) await actions.refreshVirtualDaa().catch(() => null);
    d.render();
  };

  d.attach = () => {
    const r = rt();
    if (!r || !d.active) return;
    d.detach();
    d.unsubscribe.push(r.registry.onChange(() => { d.reload(); }));
    let lastDaa = r.actions.virtualDaa;
    d.unsubscribe.push(r.actions.subscribe(({ virtualDaa }) => {
      if (virtualDaa !== lastDaa) { lastDaa = virtualDaa; if (d.offers.length) d.render(); }
    }));
    d.reload();
  };

  d.detach = () => {
    for (const u of d.unsubscribe.splice(0)) { try { u(); } catch { /* gone */ } }
  };

  d.destroy = () => {
    d.detach();
    d.active = false;
  };

  const setPrimary = async () => {
    const r = rt();
    if (!r || d.primaryWorking) return;
    const ok = await confirmAsk({
      title: `Make ${d.info.display} your primary name?`,
      message: "KaChat shows it as your name. It's saved in your profile record on chain, for a network fee.",
      confirmLabel: "Set as Primary",
    });
    if (!ok || !(await deviceLock())) return;
    d.primaryWorking = true;
    d.primaryMessage = null;
    d.render();
    try {
      const { registry, actions } = r;
      let base = null;
      const address = actions.myAddress;
      if (address) {
        base = (await registry.ownProfile(address))?.profile ?? null;
        if (!base) { try { base = (await registry.identity(address))?.profile ?? null; } catch { base = null; } }
      }
      const profile = new Profile({
        avatar: base?.avatar ?? null,
        banner: base?.banner ?? null,
        bio: base?.bio ?? null,
        linktree: base?.linktree ?? null,
        primaryName: d.info.name,
      });
      const txId = await actions.saveProfile(profile);
      d.primaryMessage = `Saved. Transaction ${String(txId).slice(0, 16)}...`;
      identityChanged();
    } catch (error) {
      d.primaryMessage = errorText(error);
    }
    d.primaryWorking = false;
    d.render();
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
      const info = d.info;
      switch (act.dataset.klAct) {
        case "buy": openBuySheet(info, owner); break;
        case "offer": openOfferSheet(info, owner); break;
        case "renew": openRenewSheet(info, owner); break;
        case "list": openListSheet(info, owner); break;
        case "delist": openDelistSheet(info, owner); break;
        case "transfer": openTransferSheet(info, owner); break;
        case "release": openReleaseSheet(info, owner); break;
        case "reclaim": openReclaimSheet(info, owner); break;
        case "primary": setPrimary(); break;
        default: break;
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
    const offerAct = target.closest("[data-kl-offer-act]");
    if (offerAct) {
      const offer = offerIndex.get(offerAct.dataset.klOfferId);
      if (offer) openOfferActionSheet(offerAct.dataset.klOfferAct, offer, d.info, owner);
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
let domainsUnsubscribe = null;
/** container -> { token, address, load } of the render in it, so a repeat call only reloads. */
const domainsRenders = new WeakMap();

/**
 * Renders the .kachat tab of Your Domains into `containerEl` for `walletAddress` (testnet only):
 * a spinner, then the address's names (active, expired and lapsed) as domain cards, or "No .kachat
 * names yet". A card opens the name's live detail as a sheet. It reloads by itself when the
 * registry changes, for as long as this render is the one in the container. Returns false (and
 * leaves the container alone) on mainnet, where the caller keeps its placeholder.
 */
export function renderKachatLiveDomainsTab(containerEl, walletAddress) {
  const rt = kachatNames();
  if (!rt || !containerEl || !kit) return false;
  const address = String(walletAddress || "").toLowerCase();
  // The same address's tab is already there (the caller re-rendered its list): reload in place,
  // without flashing the spinner.
  const previous = domainsRenders.get(containerEl);
  if (previous && previous.address === address && containerEl.querySelector(`[data-kl-domains="${previous.token}"]`)) {
    previous.load();
    return true;
  }
  const token = String(++domainsSeq);
  containerEl.innerHTML = `<div class="kl-domains" data-kl-domains="${token}"><div class="kl-domains-loading">${spinner()}</div></div>`;
  if (!containerEl.dataset.klDomainsBound) {
    containerEl.dataset.klDomainsBound = "1";
    containerEl.addEventListener("click", (event) => {
      const open = event.target.closest("[data-kl-domain-open]");
      if (!open || !containerEl.contains(open)) return;
      const info = nameIndex.get(open.dataset.klDomainOpen);
      if (info) openNameDetailLayer(info, "domains");
    });
  }
  const current = () => containerEl.isConnected && containerEl.querySelector(`[data-kl-domains="${token}"]`);
  let loading = false;
  let again = false;

  const badge = (n) => {
    switch (n.status(graceMs())) {
      case Status.active: return n.isListed ? "Listed" : "";
      case Status.grace: return "Expired";
      default: return "Lapsed";
    }
  };

  const load = async () => {
    if (loading) { again = true; return; }
    loading = true;
    try {
      do {
        again = false;
        let names = [];
        const key = keyOf(address);
        if (key) {
          try {
            if (rt.registry.refreshedAt == null) await rt.registry.refresh();
            names = await rt.registry.namesOf(key, { includeInactive: true });
          } catch { names = []; }
        }
        const root = current();
        if (!root) return;
        root.innerHTML = names.length
          ? names.map((n) => {
            rememberName(n);
            const b = badge(n);
            return `<button type="button" class="kns-domain-card" data-kl-domain-open="${esc(n.name)}">${esc(n.display)}${b ? `<span class="kns-domain-primary">${esc(b)}</span>` : ""}</button>`;
          }).join("")
          : `
            <div class="kl-domains-empty">
              <span class="kmkt-empty-icon">${kit.ICON.atCircle}</span>
              <strong>No .kachat names yet</strong>
              <p>Claim one in Kaspa Hub &gt; .kachat.</p>
            </div>`;
      } while (again);
    } finally {
      loading = false;
    }
  };

  domainsRenders.set(containerEl, { token, address, load });
  domainsUnsubscribe?.();
  domainsUnsubscribe = rt.registry.onChange(() => {
    if (!current()) { domainsUnsubscribe?.(); domainsUnsubscribe = null; return; }
    load();
  });
  load();
  return true;
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
 * The .kachat profile of `address` for the profile hero (iOS ContactsView, testnet only): the
 * avatar, banner and bio its social links show right now, looked up on this device (cached 24 h;
 * a stale answer is returned at once and refreshed in the background - see onKachatSocialChange),
 * and its Linktree link. The address's own record this device wrote comes first, then the
 * registry's identity. `avatarUrl` / `bannerUrl` are ready for <img src> (kachatImageSrc: render
 * with referrerpolicy="no-referrer"; on an <img> error, retry with kachatImageSrc(url, { viaRelay:
 * true })). `bio` is plain text (escape it). Any piece may be null.
 * -> Promise<{ avatarUrl: string|null, bannerUrl: string|null, bio: string|null, linktreeUrl: string|null } | null>
 *    null on mainnet, before the runtime exists, or when the address has no profile record.
 */
export async function kachatHeroProfile(address) {
  const rt = kachatNames();
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
// Edit .kachat Profile (KachatLiveProfileEditor, KachatSourceInput, KachatSocialPreview)
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
 * Save stays disabled until every filled field's lookup has finished and found its piece.
 * `owner` groups the layer (default "profile").
 */
export function openLiveProfileEditor(owner = "profile") {
  const rt = kachatNames();
  if (!rt || !kit) return null;
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
  /** A field is saved only once its lookup found what it shows - what you reviewed. */
  const notReviewed = (kind) => !isEmpty(kind) && fields[kind].lookup !== "found";
  /** The Linktree field holds just the username (`linktr.ee/` is shown in front of it). */
  const badLinktree = () => {
    const t = form.linktree.trim();
    return t.length > 0 && Profile.linktreeLinkFromUsername(t) == null;
  };
  const blocked = () => SOCIAL_KINDS.some((k) => isBad(k) || notReviewed(k)) || badLinktree();

  const profile = () => new Profile({
    avatar: sourceOf(SocialKind.avatar)?.link ?? null,
    banner: sourceOf(SocialKind.banner)?.link ?? null,
    bio: sourceOf(SocialKind.bio)?.link ?? null,
    linktree: Profile.linktreeLinkFromUsername(form.linktree),
    primaryName: form.primary || null,
  }).sanitized();

  const navFor = () => (savedTx
    ? navHtml("Edit .kachat Profile", { leading: { label: "Done", bold: true } })
    : navHtml("Edit .kachat Profile", { leading: { label: "Cancel" } }));

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
    else foot = footer("Saving writes your profile to the chain from your address to itself, for a network fee. Profiles are public.");
    return section(
      `<button class="kmkt-form-button" type="button" data-kl-profile-save ${saving || !loaded || blocked() ? "disabled" : ""}>
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
    ${section(`
      <label class="kmkt-form-row kl-link-field">
        <span>Primary name</span>
        <select class="kl-select" data-kl-profile-primary aria-label="Primary name">
          <option value="" ${form.primary ? "" : "selected"}>None</option>
          ${activeNames.map((n) => `<option value="${esc(n)}" ${n === form.primary ? "selected" : ""}>${esc(`${n}.kachat`)}</option>`).join("")}
        </select>
      </label>`, {
      header: ".kachat Name",
      footerHtml: footer("KaChat shows you by your primary name while you own it and it's active; otherwise by your oldest active name, or your address."),
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
    const { registry, actions } = rt;
    const address = actions.myAddress;
    if (address) {
      try { await registry.refreshIfStale(); } catch { /* use what we have */ }
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
      const key = keyOf(address);
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

  const save = async () => {
    if (saving || !loaded || blocked()) return;
    const seen = readPrivacySeen();
    const ok = await confirmAsk({
      title: "Save your profile?",
      message: seen
        ? "It's written to the chain for a network fee."
        : "Profiles are public and on chain: anyone can read them, and earlier versions stay readable after you change them. It's written for a network fee.",
      confirmLabel: "Save",
    });
    if (!ok) return;
    writePrivacySeen();
    if (!(await deviceLock()) || closed || blocked()) return;
    saving = true;
    error = null;
    renderChrome();
    try {
      savedTx = await rt.actions.saveProfile(profile());
      identityChanged();
    } catch (e) {
      error = errorText(e);
    }
    saving = false;
    renderChrome();
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
    label: "Edit .kachat Profile",
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
