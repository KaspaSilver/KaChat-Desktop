// Kaspa Hub > ChangeNOW Swap: the desktop port of iOS SwapView / SwapService as they were just
// before iOS turned Swap off (f94db5a^, with 4b9da6a, 2eebb70 and 9df2847). Back by the owner's
// choice (2026-10-22): KaChat is Desktop/PWA only now, so the App Store rule behind f94db5a does not
// apply here.
//
// KAS is always one side of the pair; the other coin comes from a curated list (ui/swap-quote.js).
// Neither side is sent automatically: whichever coin is given up, the person pays it into the
// ChangeNOW deposit address themselves (shown as a QR). Swapping INTO KAS pays out to a fresh,
// never-used spending address by default, so exchange-received coins cannot be chain-linked to
// everyday spending.
//
// The ChangeNOW API key never ships in the page and the page never sends one: every call goes to
// the same-origin relay, which attaches the server's key (CHANGENOW_API_KEY) to the four swap calls
// only (tools/relay-guard.mjs). A site without a key shows "Swap is not available right now".
//
// Styles: ui/swaps.css.

import "./swaps.css";
import kaspaLogoUrl from "./assets/kaspa-logo.png";
import coinAda from "./assets/coins/coin_ada.png";
import coinBch from "./assets/coins/coin_bch.png";
import coinBnb from "./assets/coins/coin_bnb.png";
import coinBtc from "./assets/coins/coin_btc.png";
import coinDoge from "./assets/coins/coin_doge.png";
import coinEtc from "./assets/coins/coin_etc.png";
import coinEth from "./assets/coins/coin_eth.png";
import coinHype from "./assets/coins/coin_hype.png";
import coinLtc from "./assets/coins/coin_ltc.png";
import coinSol from "./assets/coins/coin_sol.png";
import coinTrx from "./assets/coins/coin_trx.png";
import coinUsdc from "./assets/coins/coin_usdc.png";
import coinUsdt from "./assets/coins/coin_usdt.png";
import coinXmr from "./assets/coins/coin_xmr.png";
import coinXrp from "./assets/coins/coin_xrp.png";
import coinZec from "./assets/coins/coin_zec.png";
import { listPortfolios, addTransactionToPortfolio, portfolioIdsContainingTx } from "./portfolio.js";
import { confirmDialog } from "./dialogs.js";
import { proxiedUrl } from "../engine/endpoints.js";
import {
  KAS, CURATED_COINS, USDC_POLYGON, GROUPED_TICKERS, PINNED_GROUP_TICKERS, SWAP_UNAVAILABLE_TITLE,
  sameCoin, formatQuotedAmount, createChangeNowClient, createSwapQuoter, rateLine, portfolioPrefill,
  swapSourceTxId,
} from "./swap-quote.js";

const AGREED_KEY = "kachat-swap-disclaimer-agreed-v1"; // account-scoped
const HISTORY_KEY = "kachat-swap-history-v1";          // account-scoped

/** Brand art for the coins that have it (iOS swapCoinLogoAssetNames, the same images). */
const COIN_LOGOS = {
  btc: coinBtc, eth: coinEth, sol: coinSol, xrp: coinXrp, bnb: coinBnb, trx: coinTrx, hype: coinHype,
  doge: coinDoge, ltc: coinLtc, ada: coinAda, bch: coinBch, etc: coinEtc, usdc: coinUsdc, usdt: coinUsdt,
  zec: coinZec, xmr: coinXmr,
};

// SF Symbols, drawn as strokes like the rest of the app's icons.
const svg = (paths, cls = "") => `<svg${cls ? ` class="${cls}"` : ""} viewBox="0 0 24 24" aria-hidden="true">${paths}</svg>`;
const ICONS = {
  swap: svg('<path d="M4 8h15M15 4l4 4-4 4"/><path d="M20 16H5M9 12l-4 4 4 4"/>'),           // arrow.left.arrow.right
  flip: svg('<path d="M8 20V4M4 8l4-4 4 4"/><path d="M16 4v16M12 16l4 4 4-4"/>'),              // arrow.up.arrow.down
  chevronDown: svg('<path d="m6 9 6 6 6-6"/>', "swap-chevron"),
  chevronRight: svg('<path d="m9 6 6 6-6 6"/>'),
  check: svg('<path d="m5 12 5 5L20 7"/>', "swap-check"),
  trash: svg('<path d="M3.5 6.5h17"/><path d="M18.5 6.5V19a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2V6.5"/><path d="M8.5 6.5V4.5a1.5 1.5 0 0 1 1.5-1.5h4a1.5 1.5 0 0 1 1.5 1.5v2"/>'),
  plusCircle: svg('<circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/>'),
  safari: svg('<circle cx="12" cy="12" r="9"/><path d="m15.5 8.5-2 5-5 2 2-5z"/>'),
  arrowDownCircle: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7.5v9M8.5 13 12 16.5 15.5 13"/>'),
  arrowRightCircle: svg('<circle cx="12" cy="12" r="9.5"/><path d="M7.5 12h9M13 8.5l3.5 3.5-3.5 3.5"/>'),
  chartPie: svg('<path d="M21.18 15.9A10 10 0 1 1 8.1 2.82"/><path d="M22 12A10 10 0 0 0 12 2v10Z"/>'),
  warning: svg('<path d="M12 3.5 2.5 20h19Z"/><path d="M12 10v4.5M12 17.2v.1"/>'),
};

let deps = null;
let rootEl = null;
let started = false;

// ---------------------------------------------------------------------------
// State (iOS SwapService)
// ---------------------------------------------------------------------------
let availability = "checking";    // "checking" | "on" | "off" | "needs-key": can this site swap?
// A KaChat someone runs for themselves (localhost, Kaspa Quick Start) whose relay has no key of its
// own takes the ChangeNOW API key they paste here ("bring-your-own" from the relay probe). The key
// stays in this browser only and rides on the four swap calls to this KaChat's own relay, which
// passes it to ChangeNOW. A site other people open never asks for one (its relay answers "off").
let ownKeyMode = false;
const PASTED_KEY_STORAGE = "kachat-changenow-own-key-v1";
const PASTED_KEY_HEADER = "x-kachat-changenow-key"; // tools/relay-guard.mjs CHANGENOW_CLIENT_KEY_HEADER
const PASTED_KEY_RE = /^[A-Za-z0-9_-]{16,128}$/;
let pastedKeyError = "";
function pastedKey() {
  try { return String(localStorage.getItem(PASTED_KEY_STORAGE) || "").trim(); } catch { return ""; }
}
function savePastedKey(key) {
  try {
    if (key) localStorage.setItem(PASTED_KEY_STORAGE, key);
    else localStorage.removeItem(PASTED_KEY_STORAGE);
  } catch { /* storage blocked: the key then lasts as long as the page */ }
}
let history = [];
let agreed = false;
let termsChecked = false;          // iOS hasReadChangeNowTerms
let tab = "swap";                  // "swap" | "history"
// True = KAS is what you send. iOS default false: most people open Swap to acquire KAS.
let kasIsSendSide = false;
let otherCoin = USDC_POLYGON;
let amountText = "";               // "You Send"
let receiveAmountText = "";        // "You Get"
let editedSide = "send";           // which card was typed last; the other is the quote's figure
let payoutAddressText = "";
let toAddressOverrideIndex = null;
let toAddress = "";
let estimateState = { status: "idle", fromAmount: null, toAmount: null, errorMessage: null };
let createState = { status: "idle", result: null, errorMessage: null };
let estimateTimer = null;
let estimateToken = 0;

const client = createChangeNowClient({
  fetchImpl: (url, init) => {
    const key = ownKeyMode ? pastedKey() : "";
    return window.fetch(url, key ? { ...init, headers: { ...(init?.headers || {}), [PASTED_KEY_HEADER]: key } } : init);
  },
  urlFor: (url) => proxiedUrl(url),
});
const quoter = createSwapQuoter(client);

function fromCoin() { return kasIsSendSide ? KAS : otherCoin; }
function toCoin() { return kasIsSendSide ? otherCoin : KAS; }
const esc = (value) => deps.escapeHtml(String(value ?? ""));

// ---------------------------------------------------------------------------
// Availability: the relay answers /nc-proxy/__swap with "on" when the server has a key.
// ---------------------------------------------------------------------------
function relayRoot() {
  let base = "/";
  try { base = import.meta.env.BASE_URL || "/"; } catch { base = "/"; }
  return `${base}nc-proxy/`;
}
let probing = null;
function probeAvailability() {
  if (probing) return probing;
  probing = (async () => {
    try {
      const response = await window.fetch(`${relayRoot()}__swap`, { cache: "no-store" });
      const body = (await response.text()).trim();
      ownKeyMode = response.ok && body === "bring-your-own";
      availability = response.ok && body === "on" ? "on" : ownKeyMode ? (pastedKey() ? "on" : "needs-key") : "off";
    } catch {
      availability = "off";
    }
    probing = null;
    render();
  })();
  return probing;
}
/** A call came back "no key here": the screen says so instead of a failed quote. */
/** What a failed swap call says. On your own KaChat a refused key is named as such: the way out is
 *  "Use a different key" under the form. */
function swapErrorText(error, fallback) {
  if (ownKeyMode && (error?.status === 401 || error?.status === 403)) return "ChangeNOW didn't accept your API key. Use a different key below.";
  return error?.message || fallback;
}
function noteUnavailable(error) {
  if (!error?.unavailable) return false;
  // On your own KaChat the relay had no usable key from this page: ask for it again.
  availability = ownKeyMode ? "needs-key" : "off";
  render();
  return true;
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------
function loadState() {
  try { agreed = localStorage.getItem(deps.accountScopedKey(AGREED_KEY)) === "1"; } catch { agreed = false; }
  try { history = JSON.parse(localStorage.getItem(deps.accountScopedKey(HISTORY_KEY)) || "[]") || []; }
  catch { history = []; }
  if (!Array.isArray(history)) history = [];
  history.sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
}
function saveHistory() {
  history.sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
  try { localStorage.setItem(deps.accountScopedKey(HISTORY_KEY), JSON.stringify(history)); } catch { /* storage full or blocked */ }
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------
function fmt8(text) {
  if (text === "" || text == null) return String(text ?? "");
  const n = Number(text);
  return Number.isFinite(n) ? n.toFixed(8) : String(text);
}
function capitalize(text) {
  return String(text || "").toLowerCase().replace(/(^|[\s-])(\p{L})/gu, (m, sep, ch) => sep + ch.toUpperCase());
}
/** iOS statusColor: finished green, failed/refunded red, everything in between orange. */
function statusClass(status) {
  if (status === "finished") return "ok";
  if (status === "failed" || status === "refunded") return "bad";
  return "warn";
}
/** iOS Text(date, style: .date): "October 22, 2026". */
function dateText(ms) {
  return new Date(Number(ms) || Date.now()).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
}
function shortMiddle(text) {
  const value = String(text || "");
  return value.length > 20 ? `${value.slice(0, 12)}...${value.slice(-6)}` : value;
}

function coinIcon(coin) {
  if (coin.ticker === "kas") return `<img class="swap-coin-icon" src="${kaspaLogoUrl}" alt="" />`;
  const logo = COIN_LOGOS[coin.ticker];
  if (logo) return `<img class="swap-coin-icon round" src="${logo}" alt="" />`;
  return `<span class="swap-coin-icon text">${esc(coin.ticker.toUpperCase())}</span>`;
}

// ---------------------------------------------------------------------------
// Payout address (iOS refreshToAddress): a preview of the next legacy slot until the swap is real.
// ---------------------------------------------------------------------------
function refreshToAddress() {
  try {
    const index = toAddressOverrideIndex ?? deps.nextFreshSpendingIndex();
    toAddress = index == null ? "" : (deps.spendingAddressAt(index) || "");
  } catch { toAddress = ""; }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function render() {
  if (!rootEl || !deps) return;
  const header = `<div class="kaposts-header"><h1 class="kaposts-title">ChangeNOW Swap</h1></div>`;
  if (availability === "needs-key") {
    rootEl.innerHTML = `<div class="swap-root">${header}<div class="hub-empty swap-unavailable swap-own-key">
      <span class="swap-unavailable-icon" aria-hidden="true">${ICONS.swap}</span>
      <h3>Add Your ChangeNOW API Key</h3>
      <p>This KaChat runs on your own computer, so swaps use your own ChangeNOW API key. Create a free ChangeNOW partner account, copy its API key and paste it here. It stays in this browser and goes only to ChangeNOW, through this KaChat.</p>
      <input class="field-input swap-own-key-input" type="password" data-swap-own-key placeholder="ChangeNOW API key" autocomplete="off" autocapitalize="none" spellcheck="false" />
      ${pastedKeyError ? `<p class="field-error">${esc(pastedKeyError)}</p>` : ""}
      <button type="button" class="primary-button" data-swap-own-key-save>Save Key</button>
      <a class="swap-link" href="https://changenow.io/affiliate" target="_blank" rel="noopener noreferrer">Get a ChangeNOW API key</a>
    </div></div>`;
    return;
  }
  if (availability !== "on") {
    rootEl.innerHTML = `<div class="swap-root">${header}${availability === "checking"
      ? `<div class="swap-checking"><span class="kaposts-spinner" aria-hidden="true"></span></div>`
      : `<div class="hub-empty swap-unavailable">
          <span class="swap-unavailable-icon" aria-hidden="true">${ICONS.swap}</span>
          <h3>${esc(SWAP_UNAVAILABLE_TITLE)}</h3>
          <p>This site is not connected to ChangeNOW at the moment. Please try again later.</p>
          <button type="button" class="secondary-button" data-swap-retry>Try Again</button>
        </div>`}</div>`;
    return;
  }
  // Same underline tabs as Public Chats' Channels/Popular (iOS swapTabBar).
  const tabs = `<nav class="chats-tab-bar swap-tab-bar" aria-label="Swap sections">
    <button type="button" class="chats-tab-button ${tab === "swap" ? "active" : ""}" data-swap-tab="swap"><span class="chats-tab-label-row">Swap</span></button>
    <button type="button" class="chats-tab-button ${tab === "history" ? "active" : ""}" data-swap-tab="history"><span class="chats-tab-label-row">Swap History</span></button>
  </nav>`;
  rootEl.innerHTML = `<div class="swap-root">${header}${tabs}<div class="swap-page">${tab === "swap" ? renderSwapForm() : renderHistory()}</div>${agreed ? "" : renderDisclaimer()}</div>`;
  const qr = rootEl.querySelector("[data-swap-qr]");
  if (qr?.dataset.swapQr) deps.engine.drawQrFor(qr, qr.dataset.swapQr, { dark: "#06110f", light: "#ffffff" }).catch(() => {});
}

/** iOS swapDisclaimerOverlay: agreeing is gated on ticking that the terms were read. */
function renderDisclaimer() {
  return `<div class="swap-disclaimer-overlay">
    <div class="swap-disclaimer-card" role="dialog" aria-modal="true" aria-labelledby="swap-disclaimer-title">
      <strong id="swap-disclaimer-title">Before You Swap</strong>
      <p class="swap-disclaimer-text">Swaps are processed by ChangeNOW, a third-party exchange. KaChat only submits your swap request and displays its status; KaChat is not responsible for failed, delayed, or lost swaps. If a swap doesn't go through, contact ChangeNOW support directly.</p>
      <a class="swap-link strong" href="https://changenow.io/terms-of-use" target="_blank" rel="noopener noreferrer">Read ChangeNOW's Terms of Use</a>
      <label class="swap-terms-check">
        <input type="checkbox" data-swap-terms ${termsChecked ? "checked" : ""} />
        <span>I have read and agree to ChangeNOW's Terms of Use</span>
      </label>
      <div class="swap-disclaimer-actions">
        <button type="button" class="linklike-button muted" data-swap-not-now>Not Now</button>
        <button type="button" class="linklike-button strong" data-swap-agree ${termsChecked ? "" : "disabled"}>I Agree</button>
      </div>
    </div>
  </div>`;
}

/** One amount card (iOS swapAmountCard). `quoting` marks the card whose figure is being fetched
 *  for the other card's input: a spinner where the number will land, not an empty field. */
function amountCard({ label, coin, value, field, quoting }) {
  const badge = coin.ticker === "kas"
    ? `<span class="swap-coin-badge">${coinIcon(coin)}<span>${esc(coin.displayName)}</span></span>`
    : `<button type="button" class="swap-coin-badge pickable" data-swap-pick-coin>${coinIcon(coin)}<span>${esc(coin.displayName)}</span>${ICONS.chevronDown}</button>`;
  const input = quoting
    ? `<span class="swap-amount-quoting"><span class="kaposts-spinner small" aria-hidden="true"></span></span>`
    : `<input class="swap-amount-input" type="text" inputmode="decimal" autocomplete="transaction-amount" placeholder="0.00" aria-label="${esc(label)}" data-swap-field="${field}" value="${esc(value)}" />`;
  return `<div class="profile-card swap-card"><p class="profile-card-label">${esc(label)}</p><div class="swap-card-row">${input}${badge}</div></div>`;
}

function rateText() {
  if (estimateState.status === "success") {
    return rateLine({
      fromAmount: estimateState.fromAmount,
      toAmount: estimateState.toAmount,
      fromLabel: kasIsSendSide ? "KAS" : otherCoin.displayName,
      toLabel: kasIsSendSide ? otherCoin.displayName : "KAS",
    });
  }
  if (estimateState.status === "failed") return estimateState.errorMessage || "Unavailable";
  return "N/A";
}

function renderSwapForm() {
  const busy = createState.status === "creating";
  const canSwap = estimateState.status === "success" && !busy;
  const loading = estimateState.status === "loading";
  const needsPayout = toCoin().ticker !== "kas";
  const result = createState.result;
  return `
    ${amountCard({ label: "You Send", coin: fromCoin(), value: amountText, field: "send", quoting: editedSide === "get" && loading })}
    <div class="swap-action-row">
      <button type="button" class="swap-flip" data-swap-flip aria-label="Switch direction" title="Switch direction">${ICONS.flip}</button>
      <button type="button" class="swap-go${canSwap ? "" : " disabled"}" data-swap-create ${canSwap ? "" : "disabled"}>${busy ? `<span class="kaposts-spinner small" aria-hidden="true"></span>` : "Get Deposit Address"}</button>
    </div>
    ${amountCard({ label: "You Get", coin: toCoin(), value: receiveAmountText, field: "get", quoting: editedSide === "send" && loading })}
    ${needsPayout ? `<input class="field-input swap-payout-input" type="text" data-swap-payout placeholder="Receive ${esc(toCoin().displayName)} at" value="${esc(payoutAddressText)}" autocomplete="off" autocapitalize="none" spellcheck="false" />` : ""}
    ${!kasIsSendSide ? `<div class="profile-card swap-address-row">
      <span class="swap-address-copy"><small>Receiving KAS At</small><strong>${esc(shortMiddle(toAddress))}</strong></span>
      <button type="button" class="swap-link strong" data-swap-change-address>Change</button>
    </div>` : ""}
    <div class="profile-card swap-rate-card"><small>Rate</small><span class="${estimateState.status === "failed" ? "bad" : ""}">${esc(rateText())}</span></div>
    ${result ? renderResultCard(result) : ""}
    <a class="swap-powered" href="https://changenow.io/terms-of-use/changenow-terms" target="_blank" rel="noopener noreferrer">Powered by ChangeNOW</a>
    ${ownKeyMode ? `<button type="button" class="swap-link swap-own-key-change" data-swap-own-key-change>Using your own API key · Use a different key</button>` : ""}`;
}

function renderResultCard(result) {
  const payin = String(result.payinAddress || "");
  return `<div class="profile-card swap-result-card">
    ${kasIsSendSide ? `<button type="button" class="swap-result-link" data-swap-open-spending>${ICONS.arrowRightCircle}<span>Go to Spending Addresses</span>${ICONS.chevronRight}</button>` : ""}
    <strong>Send ${esc(fromCoin().displayName)} to this address</strong>
    ${payin ? `<button type="button" class="swap-qr-button" data-swap-copy="${esc(payin)}" aria-label="Copy deposit address"><canvas class="swap-qr" data-swap-qr="${esc(payin)}" width="180" height="180"></canvas></button>` : ""}
    <button type="button" class="swap-mono-button" data-swap-copy="${esc(payin)}">${esc(payin)}</button>
    <small>Status: ${esc(result.status || "new")}</small>
    <div class="swap-result-id">
      <small>ChangeNOW Exchange ID</small>
      <button type="button" class="swap-mono-button light" data-swap-copy-id="${esc(result.id)}">${esc(result.id)}</button>
    </div>
    <div class="swap-result-actions">
      <button type="button" class="swap-link strong" data-swap-refresh="${esc(result.id)}">Refresh Status</button>
      <a class="swap-link strong" href="https://changenow.io/exchange/txs/${encodeURIComponent(result.id)}" target="_blank" rel="noopener noreferrer">View on ChangeNOW</a>
    </div>
  </div>`;
}

function historyLine(swap) {
  return `${esc(swap.fromAmount)} ${esc(String(swap.fromTicker || "").toUpperCase())} → ${esc(fmt8(swap.toAmount))} ${esc(String(swap.toTicker || "").toUpperCase())}`;
}

function renderHistory() {
  if (!history.length) return `<div class="swap-history-empty">No swaps yet.</div>`;
  return `<div class="swap-history-list">${history.map((swap) => `
    <div class="swap-history-item">
      <button type="button" class="profile-card swap-history-row" data-swap-open="${esc(swap.id)}">
        <span class="swap-history-copy">
          <strong>${historyLine(swap)}</strong>
          <small>${esc(dateText(swap.createdAt))}</small>
        </span>
        <span class="swap-status ${statusClass(swap.status)}">${esc(capitalize(swap.status))}</span>
      </button>
      <button type="button" class="swap-history-delete" data-swap-delete="${esc(swap.id)}" aria-label="Delete swap">${ICONS.trash}</button>
    </div>`).join("")}</div>`;
}

/** Redraws without touching what is being typed in: the screen is drawn off-page and swapped in
 *  around the focused field, which stays the same element (value, caret, keyboard). Rebuilding
 *  it on every keystroke - and focusing the new copy - made the page jump on phones each time
 *  Safari scrolled the new field into view. */
function renderFormLight() {
  const active = document.activeElement;
  const field = rootEl?.contains(active) ? active.dataset?.swapField || (active.matches?.("[data-swap-payout]") ? "payout" : null) : null;
  if (!field) { render(); return; }
  const live = rootEl;
  const draft = document.createElement("div");
  rootEl = draft;
  try { render(); } finally { rootEl = live; }
  const twin = field === "payout" ? draft.querySelector("[data-swap-payout]") : draft.querySelector(`[data-swap-field="${field}"]`);
  if (!twin) { render(); return; }
  patchAround(live, draft, active, twin, { root: true });
}
/** Makes `oldNode` match `newNode` except along the path to `keep`, which stays in the page. The
 *  screen root keeps its own attributes: the draft is a bare <div>. */
function patchAround(oldNode, newNode, keep, newKeep, { root = false } = {}) {
  if (!root) syncAttributes(oldNode, newNode, oldNode === keep);
  if (oldNode === keep) return;
  const oldPath = [...oldNode.childNodes].find((n) => n === keep || n.contains?.(keep));
  const newKids = [...newNode.childNodes];
  const newPath = newKids.find((n) => n === newKeep || n.contains?.(newKeep));
  if (!oldPath || !newPath) { oldNode.replaceChildren(...newKids); return; }
  for (const n of [...oldNode.childNodes]) if (n !== oldPath) n.remove();
  const at = newKids.indexOf(newPath);
  for (const n of newKids.slice(0, at)) oldNode.insertBefore(n, oldPath);
  for (const n of newKids.slice(at + 1)) oldNode.appendChild(n);
  patchAround(oldPath, newPath, keep, newKeep);
}
function syncAttributes(oldEl, newEl, isKept) {
  if (oldEl.nodeType !== 1) return;
  for (const { name } of [...oldEl.attributes]) if (!newEl.hasAttribute(name)) oldEl.removeAttribute(name);
  for (const { name, value } of [...newEl.attributes]) {
    if (isKept && name === "value") continue; // the typed text is the field's own
    if (oldEl.getAttribute(name) !== value) oldEl.setAttribute(name, value);
  }
}

// ---------------------------------------------------------------------------
// Live quote (iOS rescheduleEstimate): debounced, re-fires on every relevant change.
// ---------------------------------------------------------------------------
/** The pair changed, so the quoted side's figure is for a different pair: blank it until the new
 *  quote lands; the typed side stays as the input. */
function clearQuotedAmount() {
  if (editedSide === "send") receiveAmountText = "";
  else amountText = "";
}

function rescheduleEstimate() {
  if (estimateTimer) window.clearTimeout(estimateTimer);
  const token = ++estimateToken;
  const typed = editedSide === "send" ? amountText : receiveAmountText;
  const amount = Number(typed);
  if (!String(typed).trim() || !Number.isFinite(amount) || amount <= 0) {
    estimateState = { status: "idle", fromAmount: null, toAmount: null, errorMessage: null };
    renderFormLight();
    return;
  }
  const from = fromCoin();
  const to = toCoin();
  const side = editedSide;
  renderFormLight();
  estimateTimer = window.setTimeout(async () => {
    if (token !== estimateToken) return;
    estimateState = { status: "loading", fromAmount: null, toAmount: null, errorMessage: null };
    renderFormLight();
    try {
      const quote = await quoter.quote({ side, from, to, amountText: typed });
      if (token !== estimateToken) return;
      // Both figures are ChangeNOW's; only the quoted card's text is replaced.
      if (side === "send") receiveAmountText = quote.getText;
      else amountText = quote.sendText;
      estimateState = { status: "success", fromAmount: quote.fromAmount, toAmount: quote.toAmount, errorMessage: null };
    } catch (error) {
      if (token !== estimateToken) return;
      if (noteUnavailable(error)) return;
      estimateState = { status: "failed", fromAmount: null, toAmount: null, errorMessage: swapErrorText(error, "Unavailable") };
    }
    renderFormLight();
  }, 500);
}

// ---------------------------------------------------------------------------
// Create / status (iOS executeSwap, refreshSwapStatusAsync)
// ---------------------------------------------------------------------------
async function executeSwap() {
  // `amountText` is what was typed under You Send, or the quote's answer for a typed You Get: the
  // exchange is always created from the send amount (standard flow), so for a You Get target the
  // deposit is the quoted figure and the payout floats with the rate, like any typed send.
  const amount = Number(amountText);
  if (!Number.isFinite(amount) || amount <= 0) return;
  const from = fromCoin();
  const to = toCoin();
  const amountStr = amountText;
  createState = { status: "creating", result: null, errorMessage: null };
  render();
  try {
    let payoutAddress = "";
    if (to.ticker === "kas") {
      // A fresh, never-used spending address (the next legacy slot, iOS 28ecee0), reserved now that
      // the swap is real - unless one was picked to reuse.
      if (toAddressOverrideIndex != null) {
        payoutAddress = deps.spendingAddressAt(toAddressOverrideIndex) || "";
      } else {
        const freshIndex = await deps.revealNextSwapAddress();
        payoutAddress = freshIndex != null ? (deps.spendingAddressAt(freshIndex) || "") : "";
      }
    } else {
      payoutAddress = payoutAddressText.trim();
    }
    if (!payoutAddress) {
      createState = { status: "failed", result: null, errorMessage: `Enter an address to receive the ${to.displayName}` };
      deps.showToast?.(createState.errorMessage);
      render();
      return;
    }
    const response = await client.create(from, to, amountStr, payoutAddress);
    if (!response?.payinAddress) {
      createState = { status: "failed", result: null, errorMessage: "ChangeNOW didn't return a deposit address" };
      deps.showToast?.(createState.errorMessage);
      render();
      return;
    }
    history.unshift({
      id: String(response.id),
      fromTicker: from.ticker, fromNetwork: from.network,
      toTicker: to.ticker, toNetwork: to.network,
      fromAmount: amountStr,
      toAmount: response.toAmount != null ? String(response.toAmount) : "",
      payinAddress: String(response.payinAddress),
      payoutAddress,
      status: response.status || "new",
      createdAt: Date.now(),
      kasSendTxId: null,
      addedToPortfolio: false,
    });
    saveHistory();
    createState = { status: "success", result: response, errorMessage: null };
    amountText = "";
    receiveAmountText = "";
    editedSide = "send";
    estimateState = { status: "idle", fromAmount: null, toAmount: null, errorMessage: null };
    toAddressOverrideIndex = null;
    refreshToAddress();
    deps.showToast?.("Swap started");
  } catch (error) {
    if (noteUnavailable(error)) { createState = { status: "idle", result: null, errorMessage: null }; return; }
    createState = { status: "failed", result: null, errorMessage: swapErrorText(error, "Swap failed") };
    deps.showToast?.(createState.errorMessage);
  }
  render();
}

/** Fresh status from ChangeNOW (history updated either way); null when it could not be reached. */
async function refreshSwapStatus(id) {
  try {
    const response = await client.status(id);
    const status = response?.status || null;
    if (!status) return null;
    const swap = history.find((s) => s.id === id);
    if (swap) { swap.status = status; saveHistory(); }
    if (createState.result?.id === id) createState.result = { ...createState.result, status };
    return status;
  } catch (error) {
    noteUnavailable(error);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Sheets: coin picker, address picker (+ its actions), swap details, Add to Portfolio.
// Each is a `.modal-backdrop` with its card as the only child, so on a phone it rises from the
// bottom like every other sheet in the app; `data-close` is the control a drag-down presses.
// ---------------------------------------------------------------------------
const sheetEls = new Map();   // name -> backdrop element
const sheetState = {};        // name -> that sheet's state
function openSheet(name, html, extraClass = "") {
  let el = sheetEls.get(name);
  if (!el) {
    el = document.createElement("div");
    el.className = "modal-backdrop swap-sheet-backdrop";
    el.dataset.swapSheet = name;
    el.innerHTML = `<section class="contact-modal swap-sheet" role="dialog" aria-modal="true" data-swap-sheet-body></section>`;
    el.addEventListener("click", (event) => { if (event.target === el) closeSheet(name); });
    sheetEls.set(name, el);
  }
  // Always the topmost: a sheet opened from another sheet sits above it.
  document.body.appendChild(el);
  const body = el.querySelector("[data-swap-sheet-body]");
  body.className = `contact-modal swap-sheet${extraClass ? ` ${extraClass}` : ""}`;
  body.innerHTML = html;
  el.hidden = false;
  el.querySelectorAll("[data-swap-qr]").forEach((qr) => {
    if (qr.dataset.swapQr) deps.engine.drawQrFor(qr, qr.dataset.swapQr, { dark: "#06110f", light: "#ffffff" }).catch(() => {});
  });
  return el;
}
function isSheetOpen(name) {
  const el = sheetEls.get(name);
  return Boolean(el && !el.hidden && el.isConnected);
}
function closeSheet(name) {
  const el = sheetEls.get(name);
  if (el) el.hidden = true;
  delete sheetState[name];
}
function closeAllSheets() {
  for (const name of [...sheetEls.keys()]) closeSheet(name);
}

function sheetHeader(title, { closeLabel = "Cancel" } = {}) {
  return `<div class="swap-sheet-header">
    <button type="button" class="swap-link" data-swap-sheet-close data-close>${esc(closeLabel)}</button>
    <h2>${esc(title)}</h2>
    <span class="swap-sheet-spacer" aria-hidden="true"></span>
  </div>`;
}

// --- Coin picker (iOS SwapCoinPickerView) ----------------------------------------------------
function coinPickerRows() {
  const rows = [];
  const st = sheetState.coin;
  for (const ticker of PINNED_GROUP_TICKERS) {
    const displayName = GROUPED_TICKERS[ticker];
    if (!displayName) continue;
    rows.push({ kind: "group", ticker, displayName });
    if (st.expanded.has(ticker)) for (const coin of CURATED_COINS) if (coin.ticker === ticker) rows.push({ kind: "network", coin });
  }
  for (const coin of CURATED_COINS) if (!GROUPED_TICKERS[coin.ticker]) rows.push({ kind: "coin", coin });
  const query = String(st.query || "").trim().toLowerCase();
  if (!query) return rows;
  return rows.filter((row) => {
    const name = row.kind === "group" ? row.displayName : row.coin.displayName;
    const ticker = row.kind === "group" ? row.ticker : row.coin.ticker;
    return name.toLowerCase().includes(query) || ticker.toLowerCase().includes(query);
  });
}
function renderCoinPicker({ keepSearchFocus = false } = {}) {
  const st = sheetState.coin;
  if (!st) return;
  const list = coinPickerRows().map((row) => {
    if (row.kind === "group") {
      const representative = CURATED_COINS.find((c) => c.ticker === row.ticker);
      const expanded = st.expanded.has(row.ticker);
      return `<button type="button" class="swap-picker-row" data-swap-group="${esc(row.ticker)}" aria-expanded="${expanded}">${coinIcon(representative)}<span class="swap-picker-name">${esc(row.displayName)}</span>${otherCoin.ticker === row.ticker ? ICONS.check : ""}<span class="swap-picker-chevron${expanded ? " open" : ""}">${ICONS.chevronDown}</span></button>`;
    }
    const coin = row.coin;
    return `<button type="button" class="swap-picker-row${row.kind === "network" ? " indented" : ""}" data-swap-coin="${esc(`${coin.ticker}:${coin.network}`)}">${coinIcon(coin)}<span class="swap-picker-name">${esc(coin.displayName)}</span>${sameCoin(coin, otherCoin) ? ICONS.check : ""}</button>`;
  }).join("");
  const el = openSheet("coin", `${sheetHeader("Choose Coin")}
    <input class="field-input swap-search" type="search" data-swap-coin-search placeholder="Search coins" value="${esc(st.query || "")}" autocomplete="off" />
    <div class="swap-picker-list">${list}</div>`, "swap-sheet-tall");
  if (keepSearchFocus) {
    const input = el.querySelector("[data-swap-coin-search]");
    input?.focus();
    try { input.setSelectionRange(input.value.length, input.value.length); } catch { /* not supported */ }
  }
}

// --- Address picker (iOS SwapAddressPickerView) ----------------------------------------------
async function openAddressPicker() {
  sheetState.address = { entries: [], loading: true, generating: false };
  renderAddressPicker();
  const entries = await deps.listSpendingAddresses().catch(() => []);
  if (!sheetState.address) return;
  sheetState.address.entries = entries;
  sheetState.address.loading = false;
  renderAddressPicker();
}
function renderAddressPicker() {
  const st = sheetState.address;
  if (!st) return;
  // A swap payout goes to a FRESH address - reusing one publishes the link between this swap and
  // everything that address has done - so used ones are filtered out, not merely marked. The
  // badge stays on each row: "used" comes from a network check that can fail.
  const selectable = st.entries.filter((e) => !e.hidden && !e.used);
  const rows = selectable.map((e) => `<button type="button" class="swap-picker-row address" data-swap-address="${e.index}">
      <span class="swap-address-copy"><small>${esc(e.label)} <b class="${e.used ? "used" : "unused"}">${e.used ? "Used" : "Unused"}</b></small><strong>${esc(e.shortAddress)}</strong></span>
      <span class="swap-address-kas">${esc(formatQuotedAmount(e.kas))} KAS</span>
    </button>`).join("");
  openSheet("address", `${sheetHeader("Choose Address")}
    ${st.loading && !st.entries.length
      ? `<div class="swap-checking"><span class="kaposts-spinner" aria-hidden="true"></span></div>`
      : `<div class="swap-picker-section">
          <button type="button" class="swap-picker-row generate" data-swap-generate-address ${st.generating ? "disabled" : ""}>${ICONS.plusCircle}<span class="swap-picker-name">Generate New Address</span>${st.generating ? `<span class="kaposts-spinner small" aria-hidden="true"></span>` : ""}</button>
        </div>
        <p class="swap-picker-footer">A swap pays out to an address you have not used before, so the payout cannot be tied to your earlier activity. Generate one if none are free.</p>
        <p class="swap-picker-header">Unused Addresses</p>
        <div class="swap-picker-list">${selectable.length ? rows : `<p class="swap-picker-empty">Every address here has been used. Generate a new one above.</p>`}</div>`}`, "swap-sheet-tall");
}
/** Tap an address: look at it first, or take it (iOS addressActionsSheet). */
function openAddressActions(entry) {
  sheetState["address-actions"] = { entry };
  openSheet("address-actions", `<div class="swap-actions-head">
      <strong>${esc(entry.label)}</strong>
      <small>${esc(entry.shortAddress)}</small>
      <button type="button" class="modal-close swap-actions-close" data-swap-sheet-close data-close aria-label="Close">×</button>
    </div>
    <div class="cold-action-rows">
      ${actionRow({ attr: "data-swap-address-explorer", title: "View in Explorer", subtitle: "Check its history before you send a swap to it.", icon: ICONS.safari })}
      ${actionRow({ attr: "data-swap-address-use", title: "Use for This Swap", subtitle: "ChangeNOW pays the swapped KAS out to this address.", icon: ICONS.arrowDownCircle })}
    </div>`);
}
function actionRow({ attr, title, subtitle, icon, warn = false }) {
  return `<button type="button" class="cold-action-row${warn ? " cold-action-row-warn" : ""}" ${attr}>
      <span class="cold-action-icon" aria-hidden="true">${icon}</span>
      <span class="cold-action-copy"><strong>${esc(title)}</strong><small>${esc(subtitle)}</small></span>
    </button>`;
}

// --- Swap details (iOS SwapDetailView) -------------------------------------------------------
function renderSwapDetails(id) {
  const swap = history.find((s) => s.id === id);
  if (!swap) { closeSheet("details"); return; }
  const refreshing = Boolean(sheetState.details?.id === id && sheetState.details.refreshing);
  sheetState.details = { id, refreshing };
  openSheet("details", `${sheetHeader("Swap Details", { closeLabel: "Done" })}
    <div class="swap-details">
      <div class="swap-details-group">
        <div class="swap-details-head">
          <strong>${historyLine(swap)}</strong>
          <small>${esc(dateText(swap.createdAt))}</small>
        </div>
        <canvas class="swap-qr" data-swap-qr="${esc(swap.payinAddress)}" width="180" height="180"></canvas>
      </div>
      <p class="swap-details-label">Deposit Address</p>
      <div class="swap-details-group"><button type="button" class="swap-mono-button light" data-swap-copy="${esc(swap.payinAddress)}">${esc(swap.payinAddress)}</button></div>
      <p class="swap-details-label">Status</p>
      <div class="swap-details-group swap-details-status"><strong class="swap-status ${statusClass(swap.status)}">${esc(capitalize(swap.status))}</strong>${swap.status === "finished" ? `<button type="button" class="swap-link strong" data-swap-add-portfolio="${esc(swap.id)}">Add to Portfolio</button>` : ""}</div>
      <p class="swap-details-label">ChangeNOW Exchange ID</p>
      <div class="swap-details-group"><button type="button" class="swap-mono-button light" data-swap-copy-id="${esc(swap.id)}">${esc(swap.id)}</button></div>
      <div class="swap-details-group swap-details-actions">
        <button type="button" class="swap-details-action" data-swap-refresh="${esc(swap.id)}" ${refreshing ? "disabled" : ""}><span>Refresh Status</span>${refreshing ? `<span class="kaposts-spinner small" aria-hidden="true"></span>` : ""}</button>
        <a class="swap-details-action" href="https://changenow.io/exchange/txs/${encodeURIComponent(swap.id)}" target="_blank" rel="noopener noreferrer">View on ChangeNOW</a>
      </div>
    </div>`, "swap-sheet-tall");
}

// --- Add to Portfolio (iOS 9df2847: chooses the portfolio on a half sheet) --------------------
function openAddToPortfolio(swap) {
  const prefill = portfolioPrefill(swap);
  if (!prefill) { deps.showToast?.("Couldn't read this swap's amounts"); return; }
  const sourceTxId = swapSourceTxId(swap.id);
  // Portfolios that already hold this swap are flagged while the choice is being made, rather than
  // the ledger quietly counting it twice.
  const duplicates = portfolioIdsContainingTx(sourceTxId);
  const portfolios = listPortfolios();
  sheetState.portfolio = { swapId: swap.id, prefill, sourceTxId, portfolios };
  const line = `${prefill.type === "buy" ? "Buy" : "Sell"} ${prefill.amountKas.toFixed(8)} KAS at ${deps.currencySymbol()}${prefill.fiatValue.toFixed(2)} - choose which portfolio to add it to.`;
  openSheet("portfolio", `<div class="swap-actions-head">
      <strong>Add to Portfolio</strong>
      <small>${esc(line)}</small>
      <button type="button" class="modal-close swap-actions-close" data-swap-sheet-close data-close aria-label="Close">×</button>
    </div>
    <div class="cold-action-rows swap-portfolio-rows">
      ${portfolios.map((p) => {
        const duplicate = duplicates.has(p.id);
        return actionRow({
          attr: `data-swap-portfolio-pick="${esc(p.id)}"`,
          title: p.name,
          subtitle: duplicate ? "Already holds this swap - adding it again double-counts it." : "The swap lands in this portfolio.",
          icon: duplicate ? ICONS.warning : ICONS.chartPie,
          warn: duplicate,
        });
      }).join("")}
    </div>`);
}
function confirmAddToPortfolio(portfolioId) {
  const st = sheetState.portfolio;
  if (!st) return;
  addTransactionToPortfolio(portfolioId, { ...st.prefill, sourceTxId: st.sourceTxId });
  const swap = history.find((s) => s.id === st.swapId);
  if (swap) { swap.addedToPortfolio = true; saveHistory(); }
  const name = st.portfolios.find((p) => p.id === portfolioId)?.name || "portfolio";
  closeSheet("portfolio");
  deps.showToast?.(`Added to ${name}`);
}

// ---------------------------------------------------------------------------
// Shared actions
// ---------------------------------------------------------------------------
async function copyAddress(value) {
  try { await deps.copyTextToClipboard(value); deps.showToast?.(deps.addressCopiedToastText(value)); } catch { /* clipboard refused */ }
}
async function copyExchangeId(value) {
  try { await deps.copyTextToClipboard(value); deps.showToast?.("Exchange ID copied"); } catch { /* clipboard refused */ }
}

// ---------------------------------------------------------------------------
// Public API (ui/app.js)
// ---------------------------------------------------------------------------
/** The screen came up: the payout preview is re-derived, and a site that had no key is asked again. */
export function refreshSwaps() {
  if (!started) return;
  refreshToAddress();
  if (availability !== "on") probeAvailability();
  render();
}

/** Another account: its own consent and history, a clean form. */
export function resetSwapsForAccount() {
  if (!started) return;
  closeAllSheets();
  loadState();
  termsChecked = false;
  createState = { status: "idle", result: null, errorMessage: null };
  amountText = "";
  receiveAmountText = "";
  editedSide = "send";
  payoutAddressText = "";
  estimateState = { status: "idle", fromAmount: null, toAmount: null, errorMessage: null };
  estimateToken += 1;
  toAddressOverrideIndex = null;
  refreshToAddress();
  render();
}

export function initSwaps(dependencies) {
  deps = dependencies;
  rootEl = document.querySelector("[data-swaps-root]");
  if (!rootEl) return;
  started = true;
  loadState();
  refreshToAddress();
  probeAvailability();

  rootEl.addEventListener("input", (event) => {
    const field = event.target.closest("[data-swap-field]");
    if (field) {
      const value = field.value.trim().replace(",", ".");
      if (field.dataset.swapField === "send") {
        // "You Send" typed: the You Get figure is stale until the quote lands.
        amountText = value;
        editedSide = "send";
        receiveAmountText = "";
      } else {
        // "You Get" typed: the quote fills You Send with what that costs.
        receiveAmountText = value;
        editedSide = "get";
        amountText = "";
      }
      rescheduleEstimate();
      return;
    }
    const payout = event.target.closest("[data-swap-payout]");
    if (payout) payoutAddressText = payout.value;
  });
  rootEl.addEventListener("change", (event) => {
    if (event.target.closest("[data-swap-terms]")) { termsChecked = event.target.checked; render(); }
  });
  rootEl.addEventListener("click", async (event) => {
    if (event.target.closest("[data-swap-retry]")) { availability = "checking"; render(); probeAvailability(); return; }
    if (event.target.closest("[data-swap-own-key-save]")) {
      const key = String(rootEl.querySelector("[data-swap-own-key]")?.value || "").trim();
      if (!PASTED_KEY_RE.test(key)) { pastedKeyError = "That doesn't look like a ChangeNOW API key - copy it again from your ChangeNOW account."; render(); return; }
      pastedKeyError = "";
      savePastedKey(key);
      availability = "on";
      render();
      rescheduleEstimate();
      return;
    }
    if (event.target.closest("[data-swap-own-key-change]")) {
      savePastedKey("");
      pastedKeyError = "";
      availability = "needs-key";
      render();
      return;
    }
    const tabButton = event.target.closest("[data-swap-tab]");
    if (tabButton) { tab = tabButton.dataset.swapTab; render(); return; }
    if (event.target.closest("[data-swap-agree]")) {
      if (!termsChecked) return;
      agreed = true;
      try { localStorage.setItem(deps.accountScopedKey(AGREED_KEY), "1"); } catch { /* storage blocked */ }
      render();
      return;
    }
    if (event.target.closest("[data-swap-not-now]")) { tab = "swap"; render(); return; }
    if (event.target.closest("[data-swap-flip]")) {
      kasIsSendSide = !kasIsSendSide;
      clearQuotedAmount();
      rescheduleEstimate();
      return;
    }
    if (event.target.closest("[data-swap-create]")) { executeSwap(); return; }
    if (event.target.closest("[data-swap-pick-coin]")) {
      sheetState.coin = { query: "", expanded: new Set() };
      renderCoinPicker();
      return;
    }
    if (event.target.closest("[data-swap-change-address]")) { openAddressPicker(); return; }
    if (event.target.closest("[data-swap-open-spending]")) { deps.openSpendingAddresses?.(); return; }
    const copy = event.target.closest("[data-swap-copy]");
    if (copy) { copyAddress(copy.dataset.swapCopy); return; }
    const copyId = event.target.closest("[data-swap-copy-id]");
    if (copyId) { copyExchangeId(copyId.dataset.swapCopyId); return; }
    const refresh = event.target.closest("[data-swap-refresh]");
    if (refresh) {
      const status = await refreshSwapStatus(refresh.dataset.swapRefresh);
      deps.showToast?.(status ? `Status: ${capitalize(status)}` : "Couldn't reach ChangeNOW - try again");
      render();
      return;
    }
    const open = event.target.closest("[data-swap-open]");
    if (open) { renderSwapDetails(open.dataset.swapOpen); return; }
    const del = event.target.closest("[data-swap-delete]");
    if (del) {
      const ok = await confirmDialog({
        title: "Delete this swap?",
        message: "This only removes it from your local history - it doesn't affect the actual exchange.",
        confirmLabel: "Delete",
        destructive: true,
      });
      if (!ok) return;
      history = history.filter((s) => s.id !== del.dataset.swapDelete);
      saveHistory();
      render();
    }
  });

  document.addEventListener("click", async (event) => {
    const backdrop = event.target.closest?.("[data-swap-sheet]");
    if (!backdrop || backdrop.hidden) return;
    const name = backdrop.dataset.swapSheet;
    if (event.target.closest("[data-swap-sheet-close]")) { closeSheet(name); return; }

    if (name === "coin") {
      const group = event.target.closest("[data-swap-group]");
      if (group && sheetState.coin) {
        const ticker = group.dataset.swapGroup;
        if (sheetState.coin.expanded.has(ticker)) sheetState.coin.expanded.delete(ticker);
        else sheetState.coin.expanded.add(ticker);
        renderCoinPicker();
        return;
      }
      const coinRow = event.target.closest("[data-swap-coin]");
      if (coinRow) {
        const [ticker, network] = coinRow.dataset.swapCoin.split(":");
        const picked = CURATED_COINS.find((c) => c.ticker === ticker && c.network === network);
        closeSheet("coin");
        if (picked) {
          otherCoin = picked;
          clearQuotedAmount();
          rescheduleEstimate();
        }
      }
      return;
    }

    if (name === "address") {
      const st = sheetState.address;
      if (!st) return;
      if (event.target.closest("[data-swap-generate-address]")) {
        if (st.generating) return;
        st.generating = true;
        renderAddressPicker();
        try { await deps.revealNextSwapAddress(); } catch { /* the toast came from the reveal */ }
        const entries = await deps.listSpendingAddresses().catch(() => st.entries);
        if (sheetState.address !== st) return;
        st.entries = entries;
        st.generating = false;
        renderAddressPicker();
        return;
      }
      const row = event.target.closest("[data-swap-address]");
      if (row) {
        const entry = st.entries.find((e) => e.index === Number(row.dataset.swapAddress));
        if (entry) openAddressActions(entry);
      }
      return;
    }

    if (name === "address-actions") {
      const entry = sheetState["address-actions"]?.entry;
      if (!entry) return;
      if (event.target.closest("[data-swap-address-explorer]")) {
        closeSheet("address-actions");
        window.open(deps.explorerAddressUrl(entry.address), "_blank", "noopener,noreferrer");
        return;
      }
      if (event.target.closest("[data-swap-address-use]")) {
        closeSheet("address-actions");
        closeSheet("address");
        toAddressOverrideIndex = entry.index;
        refreshToAddress();
        render();
      }
      return;
    }

    if (name === "details") {
      const copy = event.target.closest("[data-swap-copy]");
      if (copy) { copyAddress(copy.dataset.swapCopy); return; }
      const copyId = event.target.closest("[data-swap-copy-id]");
      if (copyId) { copyExchangeId(copyId.dataset.swapCopyId); return; }
      const refresh = event.target.closest("[data-swap-refresh]");
      if (refresh) {
        const st = sheetState.details;
        if (!st || st.refreshing) return;
        st.refreshing = true;
        renderSwapDetails(st.id);
        const status = await refreshSwapStatus(refresh.dataset.swapRefresh);
        if (sheetState.details?.id === st.id && isSheetOpen("details")) {
          sheetState.details.refreshing = false;
          renderSwapDetails(st.id);
        }
        deps.showToast?.(status ? `Status: ${capitalize(status)}` : "Couldn't reach ChangeNOW - try again");
        render();
        return;
      }
      const addTo = event.target.closest("[data-swap-add-portfolio]");
      if (addTo) {
        const swap = history.find((s) => s.id === addTo.dataset.swapAddPortfolio);
        closeSheet("details");
        if (swap) openAddToPortfolio(swap);
      }
      return;
    }

    if (name === "portfolio") {
      const pick = event.target.closest("[data-swap-portfolio-pick]");
      if (pick) confirmAddToPortfolio(pick.dataset.swapPortfolioPick);
    }
  });
  document.addEventListener("input", (event) => {
    const search = event.target.closest?.("[data-swap-coin-search]");
    if (search && sheetState.coin) { sheetState.coin.query = search.value; renderCoinPicker({ keepSearchFocus: true }); }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    const open = [...sheetEls.entries()].filter(([, el]) => !el.hidden && el.isConnected);
    if (!open.length) return;
    // The topmost one: the last in the page.
    open.sort(([, a], [, b]) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
    closeSheet(open[open.length - 1][0]);
  });

  render();
}
