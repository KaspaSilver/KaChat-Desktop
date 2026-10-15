// .kachat (iOS KachatMarketView.swift, KachatSetupGuideView.swift, KaChatProfileEditorSheet;
// iOS b064468, cd9e10c, 6dd5578, b000310, 09e0403): Kaspa Hub > .kachat, the marketplace for
// KaChat's own names - claim one, list it, buy one, peer to peer and trustless.
//
// UI only, the same as iOS. Nothing is wired yet: search answers "Registration isn't open yet",
// listings and activity show redacted placeholder shapes (never an invented name or price), and
// every final action (Claim, List, Confirm Purchase, Send Offer, Message) is disabled until names
// launch. Buy Now and Make an Offer still open their sheets so the flow can be looked at, and the
// offer form can be filled in.
//
// Also here: "Edit .kachat Profile" (the profile editor's layout with nothing in it yet) and the
// .kachat Setup Guide it opens (claim, avatar, banner, details, done - each step Coming soon).
//
// Where the registry is launched (testnet-10, iOS 5df42b4; mainnet since 2026-10-09, iOS ef6b21e)
// it is live instead (ui/kachat-names-live.js): a Testnet badge on testnet, search with real availability and price, Claim (its progress as a half sheet, and every
// open claim behind the claims button), the registry's listings / expired names Available to anyone /
// activity, the live name detail with its transaction sheets, and the
// live address profile editor. This file keeps the layers and the mockups, and hands the live
// screens what they need through initKachatLive.
//
// On a network without a registry (iOS 7227d69: the .kachat UI is on everywhere, the registry only
// where launched) the pages are the live ones, empty, under "Coming soon"; search says registration
// isn't open; the profile editor is the live one with Save off. The placeholder pages remain only
// for a registry that is setting up.
//
// Buy From (iOS eb9b027): while the market is up, the top bar's balance is the marketplace's own
// pill - the balance and the address it buys with (actions.marketSource) - and clicking it opens Buy
// From. Leaving the market switches back to the chatting address.

import "./kachat-market.css";
import { KAS_UNIT, IS_TESTNET } from "../engine/network.js";
import { kachatNames, kachatNamesLaunched, kachatNamesUiEnabled } from "./kachat-names-runtime.js";
import { compactAddress } from "../engine/kachat-names/registry-state.js";
import { selectablePillHtml } from "./send-kaspa-components.js";
import { publicLaunchMs, isPubliclyOpen, launchString, networkNowMs, refreshChainTime } from "../engine/kachat-names/launch.js";
import {
  initKachatLive, liveEnabled, liveHubIsLive, liveHubShow, liveHubHide, liveHubRefresh, liveHubClick,
  liveHeroStatusHtml, liveRefreshButtonHtml, liveSearchInput, liveSearchResultHtml,
  livePageHtml, createNameDetail, openLiveProfileEditor, renderKachatLiveDomainsTab,
  kachatNameTileHtml, kachatNameGridHtml, liveClaimsButtonHtml, openClaimsList,
  addressBalanceSompi, openAddressFundSheet, plainAmount,
} from "./kachat-names-live.js";

/** Your Domains > .kachat and each address's .kachat tab (iOS KachatLiveDomainsTab, KachatAddressLiveNamesList); see kachat-names-live.js. */
export { renderKachatLiveDomainsTab };

let deps = null;
let marketEl = null;

// Market navigation. view: "home" | "listing" | "name" (a live name, testnet). page: "market" |
// "available" | "expired" | "activity". detail: the live name detail while view is "name".
const state = { view: "home", page: "market", search: "", homeScroll: 0, detail: null };

/** A listing as a real one will hand it in; no listing exists yet, so its seller is unknown and
 *  Message stays disabled. With a seller, Message opens a 1:1 chat through deps.openChat. */
const placeholderListing = { sellerAddress: null };

// Names for sale, expired names anyone may claim, names in their grace period (counting down to
// release), and everything that happens in the registry - in that order (iOS cb3c27d, 73128b3).
// Your own names (and the offers you made) live in Profile > Your Domains (iOS 0765ce0, eea52b2).
const PAGES = [
  { id: "market", title: "Marketplace" },
  { id: "available", title: "Available" },
  { id: "expired", title: "Expired" },
  { id: "activity", title: "Activity" },
];

const PROFILE_FIELDS = ["Bio", "X handle", "Website", "Telegram", "Discord user id", "Email", "GitHub", "Redirect URL"];
const GUIDE_STEPS = ["claim", "howItWorks", "useIt", "keepIt", "finished"];
const EXPIRY_OPTIONS = [
  { id: "1", title: "1 Day" },
  { id: "3", title: "3 Days" },
  // up to 7 days, the app's cap on offers (actions.js maxOfferDays)
  { id: "7", title: "7 Days" },
];

function fallbackEscape(value) {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
const esc = (v) => (deps?.escapeHtml ? deps.escapeHtml(String(v ?? "")) : fallbackEscape(String(v ?? "")));

// ---------------------------------------------------------------------------------------------
// Icons (SF Symbol look-alikes, stroked in currentColor)
// ---------------------------------------------------------------------------------------------

const svg = (body, cls = "kmkt-ico") => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;
const ICON = {
  search: svg(`<circle cx="10.8" cy="10.8" r="6.3"/><path d="m20 20-4.7-4.7"/>`),
  question: svg(`<circle cx="12" cy="12" r="9.2"/><path d="M9.5 9.4a2.6 2.6 0 0 1 5.05.85c0 1.75-2.55 2.25-2.55 3.95"/><path d="M12 17.3h.01"/>`),
  tag: svg(`<path d="M3.5 12.2V4.6a1.1 1.1 0 0 1 1.1-1.1h7.6a1.1 1.1 0 0 1 .8.3l7.7 7.7a1.1 1.1 0 0 1 0 1.6l-7.6 7.6a1.1 1.1 0 0 1-1.6 0l-7.7-7.7a1.1 1.1 0 0 1-.3-.8Z"/><circle cx="8" cy="8" r="1.4"/>`),
  cart: svg(`<path d="M2.5 3.5h2.6l2.4 11.2a1.5 1.5 0 0 0 1.5 1.2h8.5a1.5 1.5 0 0 0 1.5-1.2l1.4-7.2H6.2"/><circle cx="9.6" cy="20" r="1.3"/><circle cx="17.4" cy="20" r="1.3"/>`),
  at: svg(`<circle cx="12" cy="12" r="3.6"/><path d="M15.6 8.4v4.7a2.4 2.4 0 0 0 4.8 0V12a8.4 8.4 0 1 0-3.3 6.7"/>`),
  atCircle: svg(`<circle cx="12" cy="12" r="9.4"/><circle cx="12" cy="12" r="2.5"/><path d="M14.5 9.5v3.3a1.6 1.6 0 0 0 3.2 0V12a5.7 5.7 0 1 0-2.3 4.6"/>`),
  atPlus: svg(`<circle cx="10.6" cy="12.6" r="3"/><path d="M13.6 9.6v3.9a2 2 0 0 0 4 0v-.9a7 7 0 1 0-2.8 5.6"/><path d="M19 2.6v5M16.5 5.1h5"/>`),
  swap: svg(`<path d="M7.5 3.5 3.5 7.5l4 4M3.5 7.5h14M16.5 12.5l4 4-4 4M20.5 16.5h-14"/>`),
  hand: svg(`<path d="M8 13.2V5.6a1.5 1.5 0 0 1 3 0V11M11 10.6V4.1a1.5 1.5 0 0 1 3 0v6.5M14 10.6V5.6a1.5 1.5 0 0 1 3 0v7.2M17 9.6a1.5 1.5 0 0 1 3 0V14a7 7 0 0 1-7 7h-1.2a6 6 0 0 1-4.6-2.2L4 14.7a1.6 1.6 0 0 1 2.4-2.1L8 14.2"/>`),
  shieldCheck: svg(`<path d="M12 3 4.6 6v5.4c0 4.6 3.2 8.5 7.4 9.6 4.2-1.1 7.4-5 7.4-9.6V6Z"/><path d="m8.8 12.1 2.3 2.3 4.2-4.6"/>`),
  lock: svg(`<rect x="5" y="10.5" width="14" height="10" rx="2.2"/><path d="M8 10.5V7.6a4 4 0 0 1 8 0v2.9"/>`),
  bubbles: svg(`<path d="M3.9 4h9.7a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H8.7L5.2 16v-3H3.9a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z"/><path d="M15.6 8.5h4.5a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-1.3v3l-3.5-3h-4.6a2 2 0 0 1-2-1.6"/>`),
  chevron: svg(`<path d="m9.5 6 6 6-6 6"/>`),
  chevronDown: svg(`<path d="m6 9.5 6 6 6-6"/>`, "kmkt-ico kmkt-ico-chevron-down"),
  copy: svg(`<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5V6.4a1.9 1.9 0 0 0-1.9-1.9H6.4a1.9 1.9 0 0 0-1.9 1.9v7.2a1.9 1.9 0 0 0 1.9 1.9h2.1"/>`),
  check: svg(`<path d="m5 12.5 4.3 4.3L19 7.2"/>`),
  qrcode: svg(`<rect x="3.5" y="3.5" width="6.5" height="6.5" rx="1"/><rect x="14" y="3.5" width="6.5" height="6.5" rx="1"/><rect x="3.5" y="14" width="6.5" height="6.5" rx="1"/><path d="M14 14h2.5v2.5H14zM18 18h2.5v2.5H18zM14 18.5v2M18.5 14h2"/>`),
  back: svg(`<path d="M10.5 19.5 3 12m0 0 7.5-7.5M3 12h18"/>`),
  personCircle: svg(`<circle cx="12" cy="12" r="9.4"/><circle cx="12" cy="10" r="3.2"/><path d="M5.9 18.5a7.3 7.3 0 0 1 12.2 0"/>`),
  personFill: svg(`<circle cx="12" cy="7.8" r="4.3"/><path d="M3.6 21c.5-4.6 4-7.3 8.4-7.3s7.9 2.7 8.4 7.3Z"/>`, "kmkt-ico kmkt-ico-fill"),
  photo: svg(`<rect x="3" y="4.5" width="18" height="15" rx="2.6"/><circle cx="8.6" cy="9.5" r="1.6"/><path d="m3.5 17.4 5-5 4 4 3-3 5 5"/>`),
  photoStack: svg(`<rect x="6.5" y="3.5" width="14.5" height="12" rx="2.2"/><path d="M3 7.5v10a2.2 2.2 0 0 0 2.2 2.2H17"/><path d="m7 13.4 3.4-3.4 3 3 2-2 5.1 5.1"/>`),
  textLeft: svg(`<path d="M4 6h16M4 10.2h11M4 14.4h16M4 18.6h9"/>`),
  sealCheck: `<svg class="kmkt-ico kmkt-ico-fill" viewBox="0 0 24 24" aria-hidden="true"><defs><mask id="kmkt-seal-mask"><rect width="24" height="24" fill="#fff"/><path d="m8.4 12.3 2.4 2.4 4.8-5" fill="none" stroke="#000" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></mask></defs><path mask="url(#kmkt-seal-mask)" d="M12 1.8l2.4 1.8 3-.2.9 2.9 2.5 1.7-1 2.8 1 2.8-2.5 1.7-.9 2.9-3-.2L12 22.2l-2.4-1.8-3 .2-.9-2.9-2.5-1.7 1-2.8-1-2.8 2.5-1.7.9-2.9 3 .2Z"/></svg>`,
};

/** The ".kachat" wordmark (iOS KachatTabIcon: heavy, rounded, tinted like any symbol). The word is
 *  wider than it is tall - the box is 54x24, so size it by height (e.g. height: 24px; width: auto). */
export const KACHAT_WORDMARK_SVG =
  `<svg class="kmkt-wordmark" viewBox="0 0 54 24" width="54" height="24" aria-hidden="true" focusable="false">` +
  `<text x="27" y="17.2" text-anchor="middle" textLength="51" lengthAdjust="spacingAndGlyphs" ` +
  `font-family="ui-rounded, 'SF Pro Rounded', 'Nunito', system-ui, -apple-system, 'Segoe UI', sans-serif" ` +
  `font-size="15" font-weight="800" fill="currentColor">.kachat</text></svg>`;

// ---------------------------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------------------------

/** A redacted text shape, as SwiftUI's `.redacted(reason: .placeholder)` draws one. */
const bar = (width, height = 12, extra = "") =>
  `<span class="kmkt-bar ${extra}" style="width:${Number(width)}px;height:${Number(height)}px" aria-hidden="true"></span>`;

const comingSoonPill = () => `<span class="kmkt-pill">Coming soon</span>`;

function sectionHeader(title, detail = "") {
  return `
    <div class="kmkt-section-header">
      <h3>${esc(title)}</h3>
      ${detail ? `<p>${esc(detail)}</p>` : ""}
    </div>`;
}

/** An iOS inline navigation bar for a sheet: leading button, centred title, trailing button. */
function navBar(title, { leading = null, trailing = null } = {}) {
  const button = (item, side) =>
    item
      ? `<button class="kmkt-nav-button ${side} ${item.bold ? "bold" : ""}" type="button" data-kmkt-close>${esc(item.label)}</button>`
      : `<span></span>`;
  return `
    <header class="kmkt-navbar">
      ${button(leading, "leading")}
      <h2 class="kmkt-navbar-title">${esc(title)}</h2>
      ${button(trailing, "trailing")}
    </header>`;
}

/** A grouped form section: optional header, rows, optional footer. */
function formSection(rowsHtml, { header = "", footer = "" } = {}) {
  return `
    <section class="kmkt-form-section">
      ${header ? `<h4 class="kmkt-form-header">${esc(header)}</h4>` : ""}
      <div class="kmkt-form-card">${rowsHtml}</div>
      ${footer ? `<p class="kmkt-form-footer">${esc(footer)}</p>` : ""}
    </section>`;
}

// ---------------------------------------------------------------------------------------------
// Layers: sheets and full overlays appended to <body>, closed by Escape (topmost first)
// ---------------------------------------------------------------------------------------------

const layers = [];
let escapeBound = false;

function bindEscape() {
  if (escapeBound) return;
  escapeBound = true;
  window.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !layers.length) return;
    // An app dialog or the password prompt over a sheet takes its own Escape first.
    // So does Choose an Address over Buy From (send-kaspa-components openOwnAddressPicker).
    if (document.querySelector(".app-dialog-backdrop:not([hidden]), [data-password-modal]:not([hidden]), [data-sk-source-picker]")) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const top = layers[layers.length - 1];
    // a sheet that can't be closed yet (a registration's progress, iOS interactiveDismissDisabled)
    if (typeof top.closable === "function" && !top.closable()) return;
    closeLayer(top);
  }, true);
}

/**
 * Presents `html` as a sheet. owner groups layers so the market can close its own on hide.
 * kind: "sheet" (centred card), "tall" (full-height card), "cover" (full-screen cover).
 * closable: () => bool - while false, Escape leaves the sheet up (closeLayer still closes it).
 */
function openLayer({ owner, kind = "sheet", label, html, dismissOnBackdrop = true, closable = null, onClick, onInput, onClose }) {
  bindEscape();
  const backdrop = document.createElement("div");
  backdrop.className = `modal-backdrop kmkt-backdrop kmkt-backdrop-${kind}`;
  backdrop.innerHTML = `
    <div class="kmkt-sheet kmkt-sheet-${kind}" role="dialog" aria-modal="true" aria-label="${esc(label)}" tabindex="-1">
      ${html}
    </div>`;
  const layer = { owner, el: backdrop, onClose, closable, restoreFocus: document.activeElement };
  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop) {
      if (dismissOnBackdrop) closeLayer(layer);
      return;
    }
    if (event.target.closest("[data-kmkt-close]")) {
      closeLayer(layer);
      return;
    }
    onClick?.(event, layer);
  });
  if (onInput) backdrop.addEventListener("input", (event) => onInput(event, layer));
  document.body.appendChild(backdrop);
  layers.push(layer);
  backdrop.querySelector(".kmkt-sheet")?.focus({ preventScroll: true });
  return layer;
}

function closeLayer(layer) {
  const index = layers.indexOf(layer);
  if (index === -1) return;
  layers.splice(index, 1);
  layer.el.remove();
  layer.onClose?.();
  const focusTarget = layer.restoreFocus;
  if (focusTarget && focusTarget.isConnected && typeof focusTarget.focus === "function") {
    try { focusTarget.focus({ preventScroll: true }); } catch { /* fine */ }
  }
}

function closeLayersOwnedBy(owner) {
  for (const layer of layers.filter((l) => l.owner === owner).reverse()) closeLayer(layer);
}

// ---------------------------------------------------------------------------------------------
// Market: home (hero, search, tabs, page)
// ---------------------------------------------------------------------------------------------

/** The logo and the status (Testnet, Setting up, Coming soon): no title or description, so the
 *  search sits higher (iOS 27a4f39). */
function heroHtml() {
  return `
    <section class="kmkt-hero kmkt-hero-compact">
      <span class="kmkt-hero-mark">${KACHAT_WORDMARK_SVG}</span>
      <div class="kmkt-hero-status" data-kmkt-hero-status>${liveHeroStatusHtml(comingSoonPill())}</div>
    </section>`;
}

function searchResultHtml() {
  if (liveHubIsLive()) return liveSearchResultHtml(state.search);
  const typed = state.search.trim().toLowerCase();
  if (!typed) return "";
  return `
    <div class="kmkt-search-result">
      <div class="kmkt-search-result-copy">
        <strong>${esc(typed)}.kachat</strong>
        <small>Registration isn't open yet.</small>
      </div>
      <button class="primary-button kmkt-small-button" type="button" disabled>Claim</button>
    </div>`;
}

function searchCardHtml() {
  return `
    <section class="kmkt-search">
      <label class="kmkt-search-field">
        ${ICON.search}
        <input type="text" data-kmkt-search placeholder="Find a name" value="${esc(state.search)}"
          autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" aria-label="Find a name" />
        <span class="kmkt-search-suffix">.kachat</span>
      </label>
      <div data-kmkt-search-result>${searchResultHtml()}</div>
    </section>`;
}

function tabsHtml() {
  return `
    <div class="kmkt-tabs" role="tablist">
      ${PAGES.map((page) => `
        <button class="kmkt-tab ${page.id === state.page ? "active" : ""}" type="button" role="tab"
          aria-selected="${page.id === state.page}" data-kmkt-page="${page.id}">${esc(page.title)}</button>`).join("")}
    </div>`;
}

/** A name tile's shape, redacted: no invented name or price (iOS tilePlaceholder, 27a4f39 / c488d1d). */
function tilePlaceholderInner() {
  return kachatNameTileHtml(bar(78, 15), bar(58, 13));
}

function marketPageHtml() {
  const tiles = Array.from({ length: 4 }, () => `
    <button class="kmkt-card kl-tile" type="button" data-kmkt-open-listing aria-label="Listing">${tilePlaceholderInner()}</button>`).join("");
  return `
    <div class="kmkt-page">
      ${sectionHeader("For sale")}
      ${kachatNameGridHtml(tiles)}

      <button class="secondary-button accent kmkt-wide-button" type="button" disabled>${ICON.tag}<span>List a Name for Sale</span></button>
      <p class="kmkt-footnote">Listings appear here once .kachat names launch.</p>
    </div>`;
}

function availablePageHtml() {
  const tiles = Array.from({ length: 2 }, () => `<div class="kmkt-card kl-tile" aria-hidden="true">${tilePlaceholderInner()}</div>`).join("");
  return `
    <div class="kmkt-page">
      ${sectionHeader("Available")}
      ${kachatNameGridHtml(tiles)}
      <p class="kmkt-footnote">Expired names appear here once .kachat names launch.</p>
    </div>`;
}

/** Names in their grace period, redacted (iOS expiredPage, cb3c27d): two tile shapes with a
 *  "00:00" countdown footer. */
function expiredPageHtml() {
  const tiles = Array.from({ length: 2 }, () => `<div class="kmkt-card kl-tile" aria-hidden="true">${kachatNameTileHtml(bar(78, 15), `<span class="kmkt-muted">00:00</span>`)}</div>`).join("");
  return `
    <div class="kmkt-page">
      ${sectionHeader("Expired")}
      ${kachatNameGridHtml(tiles)}
      <p class="kmkt-footnote">Names in their grace period appear here once .kachat names launch.</p>
    </div>`;
}

function activityPageHtml() {
  const icons = [ICON.tag, ICON.cart, ICON.at, ICON.swap];
  const rows = icons.map((icon) => `
    <div class="kmkt-row static">
      <span class="kmkt-row-icon w28">${icon}</span>
      <span class="kmkt-row-main">${bar(132, 13)}${bar(40, 10)}</span>
      ${bar(58, 13)}
    </div>`).join("");
  return `
    <div class="kmkt-page">
      ${sectionHeader("Recent activity", "Every claim, renewal, listing, sale, offer, transfer and reclaim across the registry.")}
      <div class="kmkt-card kmkt-list kmkt-inset-56">${rows}</div>
      <p class="kmkt-footnote">Activity appears here once .kachat names launch.</p>
    </div>`;
}

function pageHtml() {
  // Live, or not launched here (mainnet): the same pages - empty on mainnet (iOS 7227d69).
  if (liveHubIsLive() || !kachatNamesLaunched()) return livePageHtml(state.page);
  if (state.page === "available") return availablePageHtml();
  if (state.page === "expired") return expiredPageHtml();
  if (state.page === "activity") return activityPageHtml();
  return marketPageHtml();
}

/** How it works, on testnet the refresh control (iOS pull to refresh), and the claims button with
 *  its count while names are being claimed (iOS b219bb0 KachatClaimsButton). */
function headerActionsHtml() {
  return `${liveRefreshButtonHtml()}${liveClaimsButtonHtml()}<button class="kaposts-icon-button" type="button" data-kmkt-how aria-label="How it works" title="How it works">${ICON.question}</button>`;
}

/** Mainnet's countdown to the public opening (iOS c6ebf74 KachatLaunchCountdown): days, hours,
 *  minutes and seconds, and the moment in the person's own time zone. */
function countdownUnitsHtml(opensMs) {
  // the network's time (XP-020); the device's only to draw it before a node has answered
  const left = Math.max(0, Math.floor((opensMs - (networkNowMs() ?? Date.now())) / 1000));
  const unit = (value, label) => `<span class="kmkt-countdown-unit"><strong>${String(value).padStart(2, "0")}</strong><small>${label}</small></span>`;
  return unit(Math.floor(left / 86_400), "Days") + unit(Math.floor((left % 86_400) / 3_600), "Hours")
    + unit(Math.floor((left % 3_600) / 60), "Minutes") + unit(left % 60, "Seconds");
}
function countdownHtml(opensMs) {
  return `
    <section class="kmkt-countdown" aria-label="Names open in">
      <p class="kmkt-countdown-title">Names open in</p>
      <div class="kmkt-countdown-units" data-kmkt-countdown-units>${countdownUnitsHtml(opensMs)}</div>
      <p class="kmkt-countdown-when">${esc(launchString(opensMs))}</p>
      <p class="kmkt-countdown-note">Then anyone can search and claim a .kachat name here.</p>
    </section>`;
}

/** Ticks the countdown once a second while the screen is up; at the moment, the marketplace opens
 *  by itself (no reload). */
let countdownTimer = null;
function syncCountdownTimer() {
  const opens = publicLaunchMs();
  const counting = opens != null && !isPubliclyOpen() && state.view === "home" && Boolean(screen());
  if (!counting) { if (countdownTimer) { window.clearInterval(countdownTimer); countdownTimer = null; } return; }
  if (countdownTimer) return;
  void refreshChainTime();
  countdownTimer = window.setInterval(() => {
    const el = screen();
    if (!el) return;
    void refreshChainTime(); // a node read at most once a minute (every 5 s while none answers)
    if (isPubliclyOpen()) {
      window.clearInterval(countdownTimer); countdownTimer = null;
      const scroll = el.scrollTop; render(); el.scrollTop = scroll;
      return;
    }
    const units = el.querySelector("[data-kmkt-countdown-units]");
    if (units) units.innerHTML = countdownUnitsHtml(opens);
  }, 1000);
}

function homeHtml() {
  // Mainnet before its public opening: the countdown instead of search and the pages (iOS c6ebf74).
  const opens = publicLaunchMs();
  const counting = opens != null && !isPubliclyOpen();
  return `
    <div class="kmkt-root">
      <div class="kaposts-header kmkt-header">
        <h1 class="kaposts-title">.kachat</h1>
        <div class="kaposts-header-actions" data-kmkt-header-actions>${headerActionsHtml()}</div>
      </div>
      ${heroHtml()}
      ${counting ? countdownHtml(opens) : `
      ${searchCardHtml()}
      ${tabsHtml()}
      <div data-kmkt-page-body>${pageHtml()}</div>`}
    </div>`;
}

// ---------------------------------------------------------------------------------------------
// Market: listing detail
// ---------------------------------------------------------------------------------------------

function listingHtml() {
  const seller = placeholderListing.sellerAddress;
  const offerRows = Array.from({ length: 3 }, () => `
    <div class="kmkt-row static compact">
      <span class="kmkt-row-icon w24">${ICON.hand}</span>
      <span class="kmkt-row-main">${bar(120, 13)}${bar(66, 10)}</span>
      ${bar(58, 13)}
    </div>`).join("");
  const historyRows = [ICON.tag, ICON.swap, ICON.atPlus].map((icon) => `
    <div class="kmkt-row static compact">
      <span class="kmkt-row-icon w24">${icon}</span>
      <span class="kmkt-row-main">${bar(128, 13)}</span>
      ${bar(40, 10)}
    </div>`).join("");
  return `
    <div class="kmkt-root">
      <div class="kaposts-header kmkt-header with-back">
        <button class="kaposts-icon-button" type="button" data-kmkt-back aria-label="Back">${ICON.back}</button>
        <h1 class="kaposts-title">Listing</h1>
      </div>

      <section class="kmkt-card kmkt-name-card">
        <div class="kmkt-name-art">${bar(140, 20, "on-accent")}</div>
        <div class="kmkt-price-line">
          <div class="kmkt-price">
            <small>Price</small>
            ${bar(84, 18)}
          </div>
          ${bar(70, 10)}
        </div>
        ${comingSoonPill()}
      </section>

      <div class="kmkt-actions">
        <button class="primary-button kmkt-action" type="button" data-kmkt-buy>${ICON.cart}<span>Buy Now</span></button>
        <button class="secondary-button accent kmkt-action" type="button" data-kmkt-offer>${ICON.hand}<span>Make an Offer</span></button>
      </div>

      <section class="kmkt-block">
        ${sectionHeader("Seller")}
        <div class="kmkt-card kmkt-seller">
          <span class="kmkt-avatar-dot large"></span>
          <div class="kmkt-seller-copy">
            ${seller ? `<strong>${esc(seller)}</strong>` : bar(130, 13)}
            <small>Ask about the name, or agree on a price before you offer.</small>
          </div>
          <button class="secondary-button accent kmkt-small-button" type="button" data-kmkt-message ${seller ? "" : "disabled"}>${ICON.bubbles}<span>Message</span></button>
        </div>
      </section>

      <section class="kmkt-block">
        ${sectionHeader("Offers", "Open offers on this name, highest first. The seller can accept any of them.")}
        <div class="kmkt-card kmkt-list kmkt-inset-50">${offerRows}</div>
      </section>

      <section class="kmkt-block">
        ${sectionHeader("History")}
        <div class="kmkt-card kmkt-list kmkt-inset-50">${historyRows}</div>
      </section>

      <ul class="kmkt-notes">
        <li>${ICON.cart}<span>Buying pays the seller and moves the name to you in one transaction.</span></li>
        <li>${ICON.lock}<span>An offer locks your ${KAS_UNIT} on chain until the seller accepts it, you withdraw it, or it expires.</span></li>
        <li>${ICON.bubbles}<span>Messages go to the seller like any KaChat chat.</span></li>
      </ul>
    </div>`;
}

// ---------------------------------------------------------------------------------------------
// Market: sheets
// ---------------------------------------------------------------------------------------------

function openBuySheet() {
  const summaryRow = (title, width, bold = false) => `
    <div class="kmkt-form-row ${bold ? "bold" : ""}">
      <span>${esc(title)}</span>
      ${bar(width, 13)}
    </div>`;
  openLayer({
    owner: "market",
    kind: "tall",
    label: "Buy Name",
    html: `
      ${navBar("Buy Name", { leading: { label: "Cancel" } })}
      <div class="kmkt-sheet-body kmkt-form">
        ${formSection(
          summaryRow("Name", 92) + summaryRow("Price", 62) + summaryRow("Network fee", 84) + summaryRow("Total", 62, true),
          { footer: "The payment reaches the seller and the name reaches you in the same transaction - both happen, or neither does." },
        )}
        ${formSection(
          `<button class="kmkt-form-button" type="button" disabled>Confirm Purchase</button>`,
          { footer: "Buying opens when .kachat names launch." },
        )}
      </div>`,
  });
}

function openOfferSheet() {
  let expiry = "3";
  const segmented = () => EXPIRY_OPTIONS.map((option) => `
    <button class="settings-segmented-option ${option.id === expiry ? "active" : ""}" type="button" role="radio"
      aria-checked="${option.id === expiry}" data-kmkt-expiry="${option.id}">${esc(option.title)}</button>`).join("");
  openLayer({
    owner: "market",
    kind: "tall",
    label: "Make an Offer",
    html: `
      ${navBar("Make an Offer", { leading: { label: "Cancel" } })}
      <div class="kmkt-sheet-body kmkt-form">
        ${formSection(`
          <div class="kmkt-form-row"><span>Name</span>${bar(92, 13)}</div>
          <div class="kmkt-form-row"><span>Listed at</span>${bar(62, 13)}</div>`)}
        ${formSection(`
          <label class="kmkt-form-row kmkt-amount-row">
            <input class="kmkt-amount-input" type="text" inputmode="decimal" placeholder="0" autocomplete="off" data-kmkt-offer-amount aria-label="Your offer in ${KAS_UNIT}" />
            <span class="kmkt-muted">${KAS_UNIT}</span>
          </label>`, {
          header: "Your offer",
          footer: `Your ${KAS_UNIT} stays locked on chain until the owner accepts or declines, you withdraw the offer, or it expires - then anyone can send it back to you.`,
        })}
        ${formSection(`
          <div class="kmkt-form-row kmkt-segment-row">
            <div class="settings-segmented full kmkt-segmented" role="radiogroup" aria-label="Expires after" data-kmkt-expiry-group>${segmented()}</div>
          </div>`, { header: "Expires after" })}
        ${formSection(
          `<button class="kmkt-form-button" type="button" disabled>Send Offer</button>`,
          { footer: "Offers open when .kachat names launch." },
        )}
      </div>`,
    onClick(event, layer) {
      const option = event.target.closest("[data-kmkt-expiry]");
      if (!option) return;
      expiry = option.dataset.kmktExpiry;
      const group = layer.el.querySelector("[data-kmkt-expiry-group]");
      if (group) group.innerHTML = segmented();
      layer.el.querySelector(`[data-kmkt-expiry="${expiry}"]`)?.focus({ preventScroll: true });
    },
    onInput(event) {
      const input = event.target.closest("[data-kmkt-offer-amount]");
      if (!input) return;
      // A decimal amount: digits and one point (a comma reads as the point), 8 decimals at most.
      let value = input.value.replace(/,/g, ".").replace(/[^0-9.]/g, "");
      const dot = value.indexOf(".");
      if (dot !== -1) value = value.slice(0, dot + 1) + value.slice(dot + 1).replace(/\./g, "").slice(0, 8);
      if (value !== input.value) input.value = value;
    },
  });
}

function openHowItWorksSheet() {
  const rows = [
    [ICON.atPlus, "Claim", "Pick a free name and register it on Kaspa. It's yours: your name in chats, your profile, your link."],
    [ICON.tag, "List", "Set a price. The name waits in an on-chain covenant, not with KaChat or anyone else, until someone buys it or you take it back."],
    [ICON.cart, "Buy", "Pay the listed price. The payment reaches the seller and the name reaches you in the same transaction - both happen, or neither does."],
    [ICON.hand, "Offer", `Name your own price. Your ${KAS_UNIT} waits on chain until the seller accepts, you withdraw the offer, or it expires - and you can message the seller first.`],
    [ICON.shieldCheck, "Trustless", "No middleman and no escrow account: Kaspa's own rules enforce every sale."],
  ].map(([icon, title, detail]) => `
    <div class="kmkt-form-row kmkt-how-row">
      <span class="kmkt-how-icon">${icon}</span>
      <span class="kmkt-how-copy"><strong>${esc(title)}</strong><span>${esc(detail)}</span></span>
    </div>`).join("");
  openLayer({
    owner: "market",
    kind: "sheet",
    label: "How .kachat works",
    html: `
      ${navBar("How .kachat works", { trailing: { label: "Done", bold: true } })}
      <div class="kmkt-sheet-body kmkt-form">
        ${formSection(rows, {
          // per network since the mainnet launch (iOS ef6b21e)
          footer: liveHubIsLive() && !IS_TESTNET
            ? "Live on Mainnet: names, prices and payments here are real KAS."
            : liveHubIsLive()
              ? "Live on Testnet: names, prices and payments here use TKAS on testnet-10. Mainnet names are live on Mainnet."
              : "Nothing here is live yet.",
        })}
      </div>`,
  });
}

// ---------------------------------------------------------------------------------------------
// Buy From: the address the marketplace buys with (iOS eb9b027 KachatMarketSourcePill /
// KachatMarketSourceSheet / KachatAddressFundSheet)
// ---------------------------------------------------------------------------------------------

/** The marketplace's address (actions.marketSource) - `{ kind: "chatting" }` or a spending one -
 *  or null where the registry isn't launched (no pill there: the app's own balance shows). */
function marketSource() {
  try { return kachatNames()?.actions?.marketSource ?? null; } catch { return null; }
}

/** "Chatting Address", or the spending address's name ("Address #3"). */
function sourceTitle(source) {
  return source?.kind === "spending" ? source.label : "Chatting Address";
}

/** The source's address: the spending address, or the chatting address. */
function sourceAddress(source) {
  if (source?.kind === "spending") return source.address;
  return String(kachatNames()?.actions?.myAddress || deps?.walletAddress?.() || "").toLowerCase();
}

/** The chatting address's balance (sompi, BigInt) as the app knows it, or null. */
function chattingBalanceSompi() {
  try {
    const v = deps?.walletBalanceSompi?.();
    return typeof v === "bigint" ? v : null;
  } catch { return null; }
}

/** The last balance read for each spending address the pill or the sheet showed: address -> sompi. */
const sourceBalances = new Map();

/** What the pill and the sheet show for `source`: the app's chatting balance, else the address's last
 *  read balance (null while it loads). */
function shownSourceBalance(source) {
  if (source?.kind !== "spending") return chattingBalanceSompi();
  return sourceBalances.has(source.address) ? sourceBalances.get(source.address) : null;
}

/** Reads a spending source's balance; `then` runs when it changed. */
async function readSourceBalance(source, then) {
  if (source?.kind !== "spending") return;
  const sompi = await addressBalanceSompi(source.address);
  if (sompi == null) return;
  const before = sourceBalances.get(source.address);
  sourceBalances.set(source.address, sompi);
  if (before !== sompi) then?.();
}

/** "12.34567890 KAS" (iOS %.8f in the pill). */
function eightDecimals(sompi) {
  const v = BigInt(sompi ?? 0n);
  return `${v / 100_000_000n}.${(v % 100_000_000n).toString().padStart(8, "0")} ${KAS_UNIT}`;
}

let sourcePillEl = null;
let sourcePillTimer = null;
let sourcePillUnsubscribe = null;
let sourcePillShownFor = null;

/** The marketplace's balance pill (iOS KachatMarketSourcePill), in place of the chatting balance
 *  every other screen shows at the top: the balance of the address it buys with and which address
 *  that is. Clicking it opens Buy From. */
function sourcePillInnerHtml() {
  const source = marketSource();
  const balance = shownSourceBalance(source);
  // the logo sits right beside the balance, as on every other screen - not out at the side of the
  // wider address line under it (iOS dbb8b9b)
  return `
    <span class="kmkt-source-pill-copy">
      <span class="kmkt-source-pill-balance">
        ${sourcePillEl?.dataset.kmktLogo || ""}
        <span class="kmkt-source-pill-amount">${esc(eightDecimals(balance ?? 0n))}</span>
      </span>
      <small class="kmkt-source-pill-address">${esc(`${sourceTitle(source)} · ${compactAddress(sourceAddress(source))}`)}</small>
    </span>
    ${ICON.chevronDown}`;
}

function paintSourcePill() {
  if (sourcePillEl) sourcePillEl.innerHTML = sourcePillInnerHtml();
}

function showSourcePill() {
  const rt = kachatNames();
  const original = document.querySelector("[data-toolbar-balance]");
  if (!rt || !original) return;
  if (!sourcePillEl) {
    sourcePillEl = document.createElement("button");
    sourcePillEl.type = "button";
    sourcePillEl.className = "toolbar-balance kmkt-source-pill";
    sourcePillEl.dataset.kmktSourcePill = "";
    sourcePillEl.title = "Choose the address the marketplace buys with";
    sourcePillEl.setAttribute("aria-label", "Choose the address the marketplace buys with");
    // the app's own Kaspa logo (its built URL), as the balance it stands in for
    const logo = original.querySelector("img");
    sourcePillEl.dataset.kmktLogo = logo ? logo.outerHTML : "";
    sourcePillEl.addEventListener("click", () => openBuyFromSheet());
  }
  if (!sourcePillEl.isConnected) original.after(sourcePillEl);
  original.hidden = true;
  paintSourcePill();
  sourcePillUnsubscribe ??= rt.actions.subscribe(() => {
    const source = marketSource();
    const key = `${source?.kind}|${source?.address ?? ""}`;
    if (key !== sourcePillShownFor) {
      sourcePillShownFor = key;
      readSourceBalance(source, paintSourcePill);
    }
    paintSourcePill();
  });
  // every 15 seconds while the marketplace is up (iOS KachatMarketSourcePill's task)
  if (!sourcePillTimer) {
    const tick = () => { readSourceBalance(marketSource(), paintSourcePill); paintSourcePill(); };
    tick();
    sourcePillTimer = window.setInterval(tick, 15_000);
  }
}

function hideSourcePill() {
  if (sourcePillTimer) { window.clearInterval(sourcePillTimer); sourcePillTimer = null; }
  sourcePillUnsubscribe?.();
  sourcePillUnsubscribe = null;
  sourcePillShownFor = null;
  sourcePillEl?.remove();
  const original = document.querySelector("[data-toolbar-balance]");
  if (original) original.hidden = false;
}

/** Buy From (iOS KachatMarketSourceSheet): which address the marketplace pays with - claims,
 *  purchases and offers - and so which address a new name lands on. Chatting Address (the
 *  default) or Choose an Address (any of yours, each Used / Unused; iOS ca39de7), with that
 *  address's balance, a copy button and, when it is empty, Fund: its QR code and a copy button. */
function openBuyFromSheet() {
  const rt = kachatNames();
  if (!rt || layers.some((l) => l.owner === "market" && l.buyFrom)) return;
  const actions = rt.actions;
  let copied = false;
  let copiedTimer = null;
  let timer = null;
  let unsubscribe = null;
  let shownFor = null;

  const isSpending = () => marketSource()?.kind === "spending";
  const pillsHtml = () => {
    const spending = isSpending();
    return selectablePillHtml({ attr: "kmkt-source", value: "chatting", title: "Chatting Address", selected: !spending })
      + selectablePillHtml({ attr: "kmkt-source", value: "choose", title: "Choose an Address", selected: spending });
  };
  const cardHtml = () => {
    const source = marketSource();
    const address = sourceAddress(source);
    const balance = shownSourceBalance(source);
    const spinnerHtml = `<span class="sk-spinner" aria-hidden="true"></span>`;
    const balanceHtml = balance == null ? spinnerHtml : esc(`${plainAmount(balance)} ${KAS_UNIT}`);
    return `
      <div class="sk-from-card kmkt-source-card">
        <span class="sk-from-copy">
          <span class="sk-from-title">${esc(sourceTitle(source))}</span>
          ${address ? `<code class="sk-from-address" title="${esc(address)}">${esc(compactAddress(address))}</code>` : ""}
        </span>
        <span class="sk-from-balance">${balanceHtml}</span>
        ${address ? `<button class="kmkt-source-copy" type="button" data-kmkt-source-copy aria-label="Copy address" title="Copy address">${copied ? ICON.check : ICON.copy}</button>` : ""}
      </div>`;
  };
  const fundHtml = () => {
    const balance = shownSourceBalance(marketSource());
    return balance === 0n
      ? `<button class="kmkt-source-fund" type="button" data-kmkt-source-fund>${ICON.qrcode}<span>Fund</span></button>`
      : "";
  };
  const render = () => {
    const q = (sel) => layer.el.querySelector(sel);
    const pills = q("[data-kmkt-source-pills]");
    if (pills) pills.innerHTML = pillsHtml();
    const card = q("[data-kmkt-source-card]");
    if (card) card.innerHTML = cardHtml();
    const fund = q("[data-kmkt-source-fund-host]");
    if (fund) fund.innerHTML = fundHtml();
  };

  const copy = async () => {
    const address = sourceAddress(marketSource());
    if (!address) return;
    try { await navigator.clipboard?.writeText(address); } catch { return; }
    copied = true;
    render();
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => { copied = false; if (layer.el.isConnected) render(); }, 1500);
  };

  const layer = openLayer({
    owner: "market",
    kind: "sheet",
    label: "Buy From",
    html: `
      ${navBar("Buy From", { trailing: { label: "Done", bold: true } })}
      <div class="kmkt-sheet-body kmkt-buyfrom">
        <div class="sk-select-pills kmkt-source-pills" data-kmkt-source-pills>${pillsHtml()}</div>
        <div data-kmkt-source-card>${cardHtml()}</div>
        <div data-kmkt-source-fund-host>${fundHtml()}</div>
      </div>`,
    onClick(event) {
      const pill = event.target.closest("[data-kmkt-source]");
      if (pill) {
        const choice = pill.getAttribute("data-kmkt-source");
        if (choice === "chatting") actions.setMarketSource(null);
        else {
          deps?.openOwnAddressPicker?.({
            title: "Buy From",
            selectedAddress: sourceAddress(marketSource()),
            onPick: (picked) => actions.setMarketSource(picked?.kind === "spending" ? picked : null),
          });
        }
        return;
      }
      if (event.target.closest("[data-kmkt-source-copy]")) { copy(); return; }
      if (event.target.closest("[data-kmkt-source-fund]")) {
        const address = sourceAddress(marketSource());
        if (!address) return;
        openAddressFundSheet({
          address, title: "Send KAS to this address to buy with it.", owner: "market",
          onClose: () => { readSourceBalance(marketSource(), () => { render(); paintSourcePill(); }); },
        });
      }
    },
    onClose() {
      clearInterval(timer);
      clearTimeout(copiedTimer);
      unsubscribe?.();
    },
  });
  layer.buyFrom = true;
  unsubscribe = actions.subscribe(() => {
    const source = marketSource();
    const key = `${source?.kind}|${source?.address ?? ""}`;
    if (key !== shownFor) {
      shownFor = key;
      readSourceBalance(source, render);
    }
    render();
  });
  shownFor = `${marketSource()?.kind}|${marketSource()?.address ?? ""}`;
  // every 10 seconds while it is up (iOS KachatMarketSourceSheet's task)
  const tick = () => { readSourceBalance(marketSource(), render); render(); };
  tick();
  timer = setInterval(tick, 10_000);
}

// ---------------------------------------------------------------------------------------------
// Market: rendering and events
// ---------------------------------------------------------------------------------------------

function screen() {
  if (!marketEl || !marketEl.isConnected) {
    marketEl = document.querySelector("[data-kachat-market]");
    if (marketEl && !marketEl.dataset.kmktBound) {
      marketEl.dataset.kmktBound = "1";
      marketEl.addEventListener("click", onMarketClick);
      marketEl.addEventListener("input", onMarketInput);
    }
  }
  return marketEl;
}

function render() {
  const el = screen();
  if (!el) return;
  if (state.view === "name" && state.detail) el.innerHTML = state.detail.html();
  else el.innerHTML = state.view === "listing" ? listingHtml() : homeHtml();
  syncCountdownTimer();
}

/** The live hub changed (kachat-names-live.js): re-render the parts that show it. */
function onLiveChanged(kind) {
  const el = screen();
  if (!el || state.view !== "home") return;
  if (kind === "ready") {
    const scroll = el.scrollTop;
    render();
    el.scrollTop = scroll;
    return;
  }
  const set = (selector, html) => { const part = el.querySelector(selector); if (part) part.innerHTML = html; };
  if (kind === "search") { set("[data-kmkt-search-result]", searchResultHtml()); return; }
  // a claim in flight shows in its own progress sheet and the claims list (iOS b219bb0), not on
  // this page: only the claims button's count follows it
  if (kind === "pending") { set("[data-kmkt-header-actions]", headerActionsHtml()); return; }
  set("[data-kmkt-header-actions]", headerActionsHtml());
  set("[data-kmkt-hero-status]", liveHeroStatusHtml(comingSoonPill()));
  if (kind !== "refresh") {
    set("[data-kmkt-search-result]", searchResultHtml());
    set("[data-kmkt-page-body]", pageHtml());
  }
}

/** A live name (testnet): its detail replaces the home page, Back returns to it. */
function openNameDetail(info) {
  const el = screen();
  if (!el) return;
  if (state.view === "home") state.homeScroll = el.scrollTop;
  state.detail?.destroy();
  state.detail = createNameDetail(info, { mode: "market", owner: "market", host: () => screen() });
  state.view = "name";
  render();
  el.scrollTop = 0;
  state.detail.attach();
}

function goHome() {
  state.detail?.destroy();
  state.detail = null;
  state.view = "home";
  render();
  if (marketEl) marketEl.scrollTop = state.homeScroll;
}

function onMarketClick(event) {
  const target = event.target;
  if (target.closest("[data-kmkt-back]")) { goHome(); return; }
  if (state.view === "name") { state.detail?.onClick(event); return; }
  if (target.closest("[data-kmkt-how]")) { openHowItWorksSheet(); return; }
  if (target.closest("[data-kmkt-refresh]")) { liveHubRefresh(); return; }
  if (target.closest("[data-kl-claims]")) { openClaimsList("market"); return; }

  const tab = target.closest("[data-kmkt-page]");
  if (tab) {
    const page = tab.dataset.kmktPage;
    if (page === state.page) return;
    state.page = page;
    marketEl.querySelectorAll("[data-kmkt-page]").forEach((button) => {
      const on = button.dataset.kmktPage === page;
      button.classList.toggle("active", on);
      button.setAttribute("aria-selected", String(on));
    });
    const body = marketEl.querySelector("[data-kmkt-page-body]");
    if (body) body.innerHTML = pageHtml();
    return;
  }

  if (liveHubIsLive() && liveHubClick(event)) return;

  if (target.closest("[data-kmkt-open-listing]")) {
    state.homeScroll = marketEl.scrollTop;
    state.view = "listing";
    render();
    marketEl.scrollTop = 0;
    return;
  }

  if (target.closest("[data-kmkt-buy]")) { openBuySheet(); return; }
  if (target.closest("[data-kmkt-offer]")) { openOfferSheet(); return; }

  const message = target.closest("[data-kmkt-message]");
  if (message && !message.disabled && placeholderListing.sellerAddress) {
    deps?.openChat?.(placeholderListing.sellerAddress);
  }
}

function onMarketInput(event) {
  const input = event.target.closest("[data-kmkt-search]");
  if (!input) return;
  state.search = input.value;
  if (liveEnabled()) liveSearchInput(state.search);
  const result = marketEl.querySelector("[data-kmkt-search-result]");
  if (result) result.innerHTML = searchResultHtml();
}

// ---------------------------------------------------------------------------------------------
// Edit KaChat Profile
// ---------------------------------------------------------------------------------------------

export function openKachatProfileEditor() {
  if (layers.some((layer) => layer.owner === "profile")) return;
  // The live address profile editor (iOS KachatLiveProfileEditor) on every network; it saves on
  // mainnet too, with the primary name "Coming soon" there (iOS d36fc42).
  if (kachatNamesUiEnabled() && openLiveProfileEditor("profile")) return;
  const fieldRows = PROFILE_FIELDS.map((field) => `<div class="kmkt-form-row kmkt-muted">${esc(field)}</div>`).join("");
  openLayer({
    owner: "profile",
    kind: "tall",
    label: "Edit KaChat Profile",
    html: `
      ${navBar("Edit KaChat Profile", { trailing: { label: "Done", bold: true } })}
      <div class="kmkt-sheet-body kmkt-form">
        ${formSection(
          `<button class="kmkt-form-row kmkt-link-row" type="button" data-kmkt-open-guide>Setup Guide</button>`,
          { footer: "Walk through claiming your .kachat name and making it yours." },
        )}
        ${formSection(`
          <div class="kmkt-form-row kmkt-label-row">
            <span class="kmkt-label-icon">${ICON.atCircle}</span>
            <span class="kmkt-label-text">.kachat names are coming. Once you claim one, your avatar, banner, bio and links are set here - and they're what KaChat shows for you everywhere.</span>
          </div>`)}
        ${formSection(`<div class="kmkt-form-row kmkt-label-row kmkt-muted"><span class="kmkt-label-icon">${ICON.photo}</span><span>Choose Avatar</span></div>`, { header: "Avatar" })}
        ${formSection(`<div class="kmkt-form-row kmkt-label-row kmkt-muted"><span class="kmkt-label-icon">${ICON.photoStack}</span><span>Choose Banner</span></div>`, { header: "Banner" })}
        ${formSection(fieldRows, { header: "Profile" })}
        ${formSection(`<div class="kmkt-form-row"><span>Name</span><span class="kmkt-muted">None yet</span></div>`, { header: ".kachat Name" })}
      </div>`,
    onClick(event) {
      if (event.target.closest("[data-kmkt-open-guide]")) openKachatSetupGuide();
    },
  });
}

// ---------------------------------------------------------------------------------------------
// .kachat Setup Guide
// ---------------------------------------------------------------------------------------------

function guideStepHeader(title, subtitle, icon) {
  return `
    <div class="kmkt-guide-header">
      <span class="kmkt-guide-icon">${icon}</span>
      <h2>${esc(title)}</h2>
      <p>${esc(subtitle)}</p>
    </div>`;
}

// Icons for the names guide (iOS person.text.rectangle, arrow.triangle.2.circlepath, checkmark).
const GUIDE_ICON = {
  personCard: svg(`<rect x="2.8" y="4.5" width="18.4" height="15" rx="2.4"/><circle cx="8.6" cy="10.4" r="2.3"/><path d="M5.2 16.4a3.8 3.8 0 0 1 6.8 0M14 9.2h4.4M14 12.6h4.4"/>`),
  renew: svg(`<path d="M4.5 10.5a7.6 7.6 0 0 1 13-3.6l1.9 1.9M19.4 4.6v4.2h-4.2"/><path d="M19.5 13.5a7.6 7.6 0 0 1-13 3.6l-1.9-1.9M4.6 19.4v-4.2h4.2"/>`),
  check: `<svg class="kmkt-guide-check" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="currentColor"/><path d="m7.6 12.4 3 3 5.8-6.3" fill="none" stroke="#000" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
};

const guideBullets = (lines) => `
  <div class="kmkt-guide-bullets">${lines.map((line) => `<div class="kmkt-guide-bullet">${GUIDE_ICON.check}<span>${esc(line)}</span></div>`).join("")}</div>`;

// The .kachat names guide (iOS cdc5611 KachatSetupGuideView): claim a name, how a name works, make
// it your name, keep it. About the name only - an avatar, banner and bio are the address's profile,
// set in Edit KaChat Profile, not part of a name.
function guideStepHtml(step) {
  switch (step) {
    case "claim": {
      const opens = publicLaunchMs();
      const countdown = opens != null && !isPubliclyOpen()
        ? `<small class="kmkt-guide-opens">${esc(`.kachat names open to everyone on ${launchString(opens)}.`)}</small>` : "";
      return `
        ${guideStepHeader("Claim your .kachat name", "It's the name people see you as across KaChat - in chats, on posts and on your profile link. Without one, people see your address.", `<span class="kmkt-guide-mark">${KACHAT_WORDMARK_SVG}</span>`)}
        <div class="kmkt-guide-claim">
          <div class="kmkt-guide-field"><span class="kmkt-placeholder-text">yourname</span><span class="kmkt-search-suffix">.kachat</span></div>
          <small class="kmkt-muted">Search for the name you want in Kaspa Hub &gt; .kachat, then claim it.</small>
          ${countdown}
        </div>`;
    }
    case "howItWorks":
      return `
        ${guideStepHeader("How a name works", "Your name lives on the Kaspa network, held by your chatting address. Nobody can take it or change it while it's yours.", ICON.sealCheck)}
        ${guideBullets([
          "Claiming takes two quick transactions: the first keeps your pick secret, the second registers it.",
          "You pay for one period at a time. Shorter names cost more.",
          "The price goes to the network's miners, not to KaChat.",
        ])}`;
    case "useIt":
      return `
        ${guideStepHeader("Make it your name", "Set it as your primary name and it's how you appear everywhere in KaChat.", GUIDE_ICON.personCard)}
        ${guideBullets([
          "People can find you and message you by typing your name.",
          "They can send you Kaspa to yourname.kachat instead of a long address.",
          "Your profile link shows your name.",
        ])}`;
    case "keepIt":
      return `
        ${guideStepHeader("Keep it", "Your names are in Profile > Your Domains > .kachat.", GUIDE_ICON.renew)}
        ${guideBullets([
          "Renew before it expires. It shows when, on each name.",
          "After it expires there's a grace period to renew it before anyone else can claim it.",
          "You can transfer it, list it for sale, or accept an offer for it.",
        ])}`;
    default:
      return guideStepHeader("You're all set", "Claim your name in Kaspa Hub > .kachat whenever you're ready.", ICON.sealCheck);
  }
}

function guideBodyHtml(index) {
  const step = GUIDE_STEPS[index];
  const dots = GUIDE_STEPS.slice(0, -1).map((_, i) =>
    `<span class="kmkt-dot ${i <= index ? "on" : ""} ${i === index ? "current" : ""}"></span>`).join("");
  return `
    <div class="kmkt-guide-scroll">
      <div class="kmkt-guide-content">
        <div class="kmkt-dots" aria-hidden="true">${dots}</div>
        ${guideStepHtml(step)}
      </div>
    </div>
    <div class="kmkt-guide-bar">
      <button class="kmkt-guide-prev" type="button" data-kmkt-guide-prev ${index === 0 ? "disabled" : ""}>Previous</button>
      <button class="kmkt-guide-next" type="button" data-kmkt-guide-next>${index === GUIDE_STEPS.length - 1 ? "Done" : "Next"}</button>
    </div>`;
}

export function openKachatSetupGuide() {
  if (layers.some((layer) => layer.owner === "guide")) return;
  let index = 0;
  const show = (layer) => {
    const body = layer.el.querySelector("[data-kmkt-guide-body]");
    if (body) body.innerHTML = guideBodyHtml(index);
    layer.el.querySelector(".kmkt-guide-scroll")?.scrollTo(0, 0);
  };
  openLayer({
    owner: "guide",
    kind: "cover",
    label: ".kachat Names",
    dismissOnBackdrop: false,
    html: `
      ${navBar(".kachat Names", { leading: { label: "Close" } })}
      <div class="kmkt-guide" data-kmkt-guide-body>${guideBodyHtml(index)}</div>`,
    onClick(event, layer) {
      if (event.target.closest("[data-kmkt-guide-prev]")) {
        if (index > 0) { index -= 1; show(layer); }
        return;
      }
      if (event.target.closest("[data-kmkt-guide-next]")) {
        if (index < GUIDE_STEPS.length - 1) { index += 1; show(layer); } else closeLayer(layer);
      }
    },
  });
}

// ---------------------------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------------------------

/** deps: { escapeHtml, showToast, confirmDialog, chooseDialog, alertDialog, promptDialog, infoSheet,
 *  openChat(address), deviceLock(reason) -> Promise<bool>, walletAddress(), walletBalanceSompi(),
 *  contactNameFor(address), explorerTxUrl(txid), explorerAddressUrl(address), shortAddress(address),
 *  onIdentityChanged(),
 *  Buy From (iOS eb9b027): addressBalanceSompi(address) -> Promise<bigint>, drawQr(canvas, text),
 *  openOwnAddressPicker({ title, selectedAddress, onPick({ kind, index?, address, label? })) } */
export function initKachatMarket(dependencies) {
  deps = dependencies || {};
  initKachatLive({
    getDeps: () => deps,
    esc,
    ICON,
    wordmark: KACHAT_WORDMARK_SVG,
    openLayer,
    closeLayer,
    navBar,
    sectionHeader,
    hubChanged: onLiveChanged,
    openNameDetail,
  });
  screen();
}

/** The .kachat screen came on (the app has un-hidden [data-kachat-market]). */
export function showKachatMarket() {
  const el = screen();
  if (!el) return;
  const scroll = el.scrollTop;
  render();
  el.scrollTop = scroll;
  liveHubShow();
  // the address the marketplace buys with, and its balance, at the top (iOS eb9b027)
  showSourcePill();
  // A name typed before the screen went off is looked up again (the registry may have moved).
  if (liveEnabled() && state.search.trim()) liveSearchInput(state.search);
  if (state.view === "name") state.detail?.attach();
}

/** The .kachat screen went off: its own sheets close with it (the profile editor and the setup
 *  guide are not the market's and stay). Where you were - tab, listing, search - is kept. */
export function hideKachatMarket() {
  if (countdownTimer) { window.clearInterval(countdownTimer); countdownTimer = null; }
  closeLayersOwnedBy("market");
  liveHubHide();
  state.detail?.detach();
  // Only the marketplace buys from another address: leaving it, everything else (Your Domains'
  // renew and extend, the profile) pays from the chatting address again (iOS eb9b027).
  hideSourcePill();
  try { kachatNames()?.actions?.setMarketSource?.(null); } catch { /* no runtime */ }
}

/** The ".kachat" tab's static note (iOS KachatAddressDomainsList's "coming" note): what the tab
 *  holds before an address is known. With an address, the tab is the live list of that address's
 *  names on every network (renderKachatLiveDomainsTab(el, address, { variant: "address" }),
 *  iOS 881ada6 / 7227d69) - empty on mainnet. */
export function kachatAddressDomainsHtml() {
  return `<div class="kachat-address-domains">
    <span class="kachat-address-domains-mark" aria-hidden="true">${KACHAT_WORDMARK_SVG}</span>
    <strong>No .kachat names on this address</strong>
    <p>Names this address claims or buys show here once .kachat names launch.</p>
  </div>`;
}
