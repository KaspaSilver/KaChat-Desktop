// ChangeNOW Swap - desktop port of iOS SwapView / SwapService / ChangeNowAPIClient.
//
// KAS is always one side of the pair; the other coin comes from a curated list of (ticker,
// network) pairs verified against ChangeNOW's live currency list. Neither side is sent
// automatically: whichever coin is given up, the user pays into the ChangeNOW deposit address
// (shown as a QR). Swapping INTO KAS pays out to a fresh, never-used spending address by default
// so exchange-received coins cannot be chain-linked to everyday spending.
//
// The ChangeNOW API key ships with the build, exactly like the iOS/Android apps: Vite inlines
// `VITE_CHANGENOW_API_KEY` from a gitignored `.env` at build time. A device-level localStorage
// override is still honored for forks that build without the .env.

import { listPortfolios, addTransactionToPortfolio, portfolioIdsContainingTx } from "./portfolio.js";
import { chooseDialog, confirmDialog } from "./dialogs.js";

const CN_BASE = "https://api.changenow.io";
const API_KEY_KEY = "kachat-changenow-api-key-v1";           // global (device-level) override
let BUILTIN_KEY = "";
try { BUILTIN_KEY = String(import.meta.env.VITE_CHANGENOW_API_KEY || "").trim(); } catch { BUILTIN_KEY = ""; }
const AGREED_KEY = "kachat-swap-disclaimer-agreed-v1";       // account-scoped
const HISTORY_KEY = "kachat-swap-history-v1";                // account-scoped

// ---------------------------------------------------------------------------
// Coins (iOS SwapModels.SwapCoin.curated)
// ---------------------------------------------------------------------------
const KAS = { ticker: "kas", network: "kas", displayName: "Kaspa" };
const CURATED_COINS = [
  { ticker: "btc", network: "btc", displayName: "Bitcoin" },
  { ticker: "eth", network: "eth", displayName: "Ethereum" },
  { ticker: "sol", network: "sol", displayName: "Solana" },
  { ticker: "xrp", network: "xrp", displayName: "XRP" },
  { ticker: "bnb", network: "bsc", displayName: "BNB (BNB Smart Chain)" },
  { ticker: "trx", network: "trx", displayName: "TRON" },
  { ticker: "hype", network: "hyperevm", displayName: "Hyperliquid" },
  { ticker: "doge", network: "doge", displayName: "Dogecoin" },
  { ticker: "ltc", network: "ltc", displayName: "Litecoin" },
  { ticker: "zec", network: "zec", displayName: "Zcash" },
  { ticker: "xmr", network: "xmr", displayName: "Monero" },
  { ticker: "ada", network: "ada", displayName: "Cardano" },
  { ticker: "bch", network: "bch", displayName: "Bitcoin Cash" },
  { ticker: "etc", network: "etc", displayName: "Ethereum Classic" },
  { ticker: "usdt", network: "eth", displayName: "Tether (ERC20)" },
  { ticker: "usdt", network: "trx", displayName: "Tether (TRC20)" },
  { ticker: "usdt", network: "bsc", displayName: "Tether (BNB Smart Chain)" },
  { ticker: "usdt", network: "sol", displayName: "Tether (Solana)" },
  { ticker: "usdt", network: "matic", displayName: "Tether (Polygon)" },
  { ticker: "usdt", network: "arbitrum", displayName: "Tether (Arbitrum)" },
  { ticker: "usdt", network: "op", displayName: "Tether (Optimism)" },
  { ticker: "usdc", network: "matic", displayName: "USDC Coin (Polygon)" },
  { ticker: "usdc", network: "eth", displayName: "USDC Coin (Ethereum)" },
  { ticker: "usdc", network: "sol", displayName: "USDC Coin (Solana)" },
  { ticker: "usdc", network: "bsc", displayName: "USDC Coin (BNB Smart Chain)" },
  { ticker: "usdc", network: "algo", displayName: "USDC Coin (Algorand)" },
  { ticker: "usdc", network: "op", displayName: "USDC Coin (Optimism)" },
  { ticker: "usdc", network: "arbitrum", displayName: "USDC Coin (Arbitrum)" },
  { ticker: "usdc", network: "base", displayName: "USDC Coin (Base)" },
  { ticker: "usdc", network: "sui", displayName: "USDC Coin (Sui)" },
];
const USDC_POLYGON = CURATED_COINS.find((c) => c.ticker === "usdc" && c.network === "matic");
// Tickers with more than one network collapse to one row that expands in place.
const GROUPED_TICKERS = { usdt: "Tether", usdc: "USD Coin" };
const PINNED_GROUPS = ["usdc", "usdt"];
// Brand colours for the ticker circle, since the desktop bundles no coin art.
const COIN_COLORS = { btc: "#f7931a", eth: "#627eea", sol: "#9945ff", xrp: "#23292f", bnb: "#f3ba2f", trx: "#ef0027", hype: "#50e3c2", doge: "#c2a633", ltc: "#345d9d", zec: "#f4b728", xmr: "#ff6600", ada: "#0033ad", bch: "#8dc351", etc: "#328332", usdt: "#26a17b", usdc: "#2775ca" };

let deps = null;
let rootEl = null;
let history = [];
let agreed = false;
let termsChecked = false;
let tab = "swap";                 // "swap" | "history"
let kasIsSendSide = false;        // iOS default: most people open Swap to acquire KAS
let otherCoin = USDC_POLYGON;
let amountText = "";
let payoutAddressText = "";
let toAddressOverrideIndex = null;
let toAddress = "";
let estimateState = { status: "idle", toAmount: null, error: null };
let createState = { status: "idle", result: null, error: null };
let estimateTimer = null;
let estimateToken = 0;

function apiKey() {
  return String(localStorage.getItem(API_KEY_KEY) || "").trim() || BUILTIN_KEY;
}
function fromCoin() { return kasIsSendSide ? KAS : otherCoin; }
function toCoin() { return kasIsSendSide ? otherCoin : KAS; }
function sameCoin(a, b) { return a && b && a.ticker === b.ticker && a.network === b.network; }

function loadState() {
  agreed = localStorage.getItem(deps.accountScopedKey(AGREED_KEY)) === "1";
  try { history = JSON.parse(localStorage.getItem(deps.accountScopedKey(HISTORY_KEY)) || "[]") || []; }
  catch { history = []; }
  history.sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
}
function saveHistory() {
  history.sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
  localStorage.setItem(deps.accountScopedKey(HISTORY_KEY), JSON.stringify(history));
}

// ---------------------------------------------------------------------------
// ChangeNOW v2 (iOS ChangeNowAPIClient)
// ---------------------------------------------------------------------------
async function cnRequest(path, { query = null, method = "GET", body = null } = {}) {
  const url = new URL(`${CN_BASE}${path}`);
  if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(url.toString(), {
      method,
      headers: { Accept: "application/json", "x-changenow-api-key": apiKey(), ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      // ChangeNOW's 4xx responses carry the real reason in the JSON body.
      let reason = text.slice(0, 300);
      try { reason = JSON.parse(text)?.message || reason; } catch {}
      throw new Error(reason ? `ChangeNOW error (${response.status}): ${reason}` : `ChangeNOW error (${response.status}).`);
    }
    return text ? JSON.parse(text) : {};
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("ChangeNOW did not answer in time.");
    throw error;
  } finally {
    window.clearTimeout(timer);
  }
}
const cn = {
  estimate: (from, to, fromAmount) => cnRequest("/v2/exchange/estimated-amount", { query: {
    fromCurrency: from.ticker, fromNetwork: from.network, toCurrency: to.ticker, toNetwork: to.network, fromAmount, flow: "standard",
  } }),
  create: (from, to, fromAmount, address) => cnRequest("/v2/exchange", { method: "POST", body: {
    fromCurrency: from.ticker, fromNetwork: from.network, toCurrency: to.ticker, toNetwork: to.network, fromAmount, address, flow: "standard",
  } }),
  status: (id) => cnRequest("/v2/exchange/by-id", { query: { id } }),
};

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------
function fmt8(value) { const n = Number(value); return Number.isFinite(n) ? n.toFixed(8) : String(value ?? ""); }
function fmtTrimmed(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value ?? "");
  return n.toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
}
function statusColor(status) {
  if (status === "finished") return "ok";
  if (status === "failed" || status === "refunded") return "bad";
  return "warn";
}
function capitalize(s) { s = String(s || ""); return s.charAt(0).toUpperCase() + s.slice(1); }
function shortMiddle(text) { return text.length > 20 ? `${text.slice(0, 12)}...${text.slice(-6)}` : text; }

function coinIcon(coin) {
  if (coin.ticker === "kas") return `<img class="swap-coin-icon" src="./ui/assets/kaspa-logo.png" alt="" />`;
  const color = COIN_COLORS[coin.ticker] || "rgba(98,244,208,.35)";
  return `<span class="swap-coin-icon text" style="background:${color}">${deps.escapeHtml(coin.ticker.toUpperCase())}</span>`;
}

// ---------------------------------------------------------------------------
// Payout address (iOS refreshToAddress)
// ---------------------------------------------------------------------------
function refreshToAddress() {
  const index = toAddressOverrideIndex ?? deps.nextFreshSpendingIndex();
  toAddress = deps.spendingAddressAt(index) || "";
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function render() {
  if (!rootEl) return;
  const header = `<div class="kaposts-header"><h1 class="kaposts-title">ChangeNOW Swap</h1></div>`;
  if (!apiKey()) {
    rootEl.innerHTML = `${header}
      <div class="profile-card">
        <p class="profile-card-label">ChangeNOW API Key</p>
        <p class="swap-disclaimer-text">Desktop stores your ChangeNOW API key locally on this device (it's never committed to the app). Paste yours to enable swaps — get one free at changenow.io/api.</p>
        <form class="broadcast-join-row" data-swap-key-form>
          <input class="kaposts-reply-input" type="password" data-swap-key-input placeholder="ChangeNOW API key" required />
          <button class="primary-button" type="submit">Save</button>
        </form>
      </div>`;
    return;
  }
  const tabs = `<nav class="chats-tab-bar swap-tab-bar" aria-label="Swap sections">
    <button type="button" class="chats-tab-button ${tab === "swap" ? "active" : ""}" data-swap-tab="swap"><span class="chats-tab-label-row">Swap</span></button>
    <button type="button" class="chats-tab-button ${tab === "history" ? "active" : ""}" data-swap-tab="history"><span class="chats-tab-label-row">Swap History</span></button>
  </nav>`;
  rootEl.innerHTML = `${header}${tabs}<div class="swap-page">${tab === "swap" ? renderSwapForm() : renderHistory()}</div>${agreed ? "" : renderDisclaimer()}`;
  const qr = rootEl.querySelector("[data-swap-qr]");
  if (qr && qr.dataset.swapQr) deps.engine.drawQrFor(qr, qr.dataset.swapQr, { dark: "#06110f", light: "#ffffff" }).catch(() => {});
}

function renderDisclaimer() {
  return `<div class="swap-disclaimer-overlay">
    <div class="swap-disclaimer-card">
      <strong>Before You Swap</strong>
      <p class="swap-disclaimer-text">Swaps are processed by ChangeNOW, a third-party exchange. KaChat only submits your swap request and displays its status; KaChat is not responsible for failed, delayed, or lost swaps. If a swap doesn't go through, contact ChangeNOW support directly.</p>
      <a class="kaposts-view-link" href="https://changenow.io/terms-of-use" target="_blank" rel="noopener">Read ChangeNOW's Terms of Use</a>
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

function amountCard(label, coin, value, editable) {
  const badge = coin.ticker === "kas"
    ? `<span class="swap-coin-badge">${coinIcon(coin)}<span>${deps.escapeHtml(coin.displayName)}</span></span>`
    : `<button type="button" class="swap-coin-badge pickable" data-swap-pick-coin>${coinIcon(coin)}<span>${deps.escapeHtml(coin.displayName)}</span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></button>`;
  const field = editable
    ? `<input class="swap-amount-input" type="text" inputmode="decimal" placeholder="0.00" data-swap-amount value="${deps.escapeHtml(value)}" />`
    : `<span class="swap-amount-static">${deps.escapeHtml(value || "0.00")}</span>`;
  return `<div class="profile-card swap-card"><p class="profile-card-label">${label}</p><div class="swap-card-row">${field}${badge}</div></div>`;
}

function rateText() {
  if (estimateState.status === "success") {
    const fromAmount = Number(amountText) || 0;
    const to = Number(estimateState.toAmount) || 0;
    if (!(fromAmount > 0)) return "N/A";
    const fromLabel = kasIsSendSide ? "KAS" : otherCoin.displayName;
    const toLabel = kasIsSendSide ? otherCoin.displayName : "KAS";
    return `1 ${fromLabel} ≈ ${(to / fromAmount).toFixed(8)} ${toLabel}`;
  }
  if (estimateState.status === "failed") return estimateState.error || "Unavailable";
  return "N/A";
}

function renderSwapForm() {
  const busy = createState.status === "creating";
  const canSwap = estimateState.status === "success" && !busy;
  const estimated = estimateState.status === "success" ? fmtTrimmed(estimateState.toAmount) : estimateState.status === "loading" ? "..." : "";
  const needsPayout = toCoin().ticker !== "kas";
  const result = createState.result;
  return `
    ${amountCard("You Send", fromCoin(), amountText, true)}
    <div class="swap-action-row">
      <button type="button" class="swap-flip" data-swap-flip aria-label="Switch direction" title="Switch direction"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4v16m0 0-3-3m3 3 3-3M17 20V4m0 0-3 3m3-3 3 3"/></svg></button>
      <button type="button" class="swap-go ${canSwap ? "" : "disabled"}" data-swap-create ${canSwap ? "" : "disabled"}>${busy ? "Creating…" : "Get Deposit Address"}</button>
    </div>
    ${amountCard("You Get", toCoin(), estimated, false)}
    ${needsPayout ? `<input class="field-input swap-payout-input" type="text" data-swap-payout placeholder="Receive ${deps.escapeHtml(toCoin().displayName)} at" value="${deps.escapeHtml(payoutAddressText)}" autocomplete="off" spellcheck="false" />` : ""}
    ${!kasIsSendSide ? `<div class="profile-card swap-address-row">
      <span class="swap-address-copy"><small>Receiving KAS At</small><strong>${deps.escapeHtml(shortMiddle(toAddress))}</strong></span>
      <button type="button" class="kaposts-view-link" data-swap-change-address>Change</button>
    </div>` : ""}
    <div class="profile-card swap-rate-card"><small>Rate</small><span class="${estimateState.status === "failed" ? "bad" : ""}">${deps.escapeHtml(rateText())}</span></div>
    ${createState.status === "failed" && createState.error ? `<p class="field-error">${deps.escapeHtml(createState.error)}</p>` : ""}
    ${result ? renderResultCard(result) : ""}
    <a class="swap-powered" href="https://changenow.io/terms-of-use/changenow-terms" target="_blank" rel="noopener">Powered by ChangeNOW</a>`;
}

function renderResultCard(result) {
  const payin = result.payinAddress || "";
  return `<div class="profile-card swap-result-card">
    ${kasIsSendSide ? `<button type="button" class="swap-result-link" data-swap-open-spending>→ Go to Spending Addresses <span>›</span></button>` : ""}
    <strong>Send ${deps.escapeHtml(fromCoin().displayName)} to this address</strong>
    ${payin ? `<canvas class="swap-qr" data-swap-qr="${deps.escapeHtml(payin)}" data-swap-copy="${deps.escapeHtml(payin)}" width="180" height="180" title="Tap to copy"></canvas>` : ""}
    <button type="button" class="swap-mono-button" data-swap-copy="${deps.escapeHtml(payin)}">${deps.escapeHtml(payin)}</button>
    <small>Status: ${deps.escapeHtml(result.status || "new")}</small>
    <small>ChangeNOW Exchange ID</small>
    <button type="button" class="swap-mono-button light" data-swap-copy-id="${deps.escapeHtml(result.id)}">${deps.escapeHtml(result.id)}</button>
    <div class="swap-result-actions">
      <button type="button" class="kaposts-view-link" data-swap-refresh="${deps.escapeHtml(result.id)}" data-swap-refresh-result>Refresh Status</button>
      <a class="kaposts-view-link" href="https://changenow.io/exchange/txs/${encodeURIComponent(result.id)}" target="_blank" rel="noopener">View on ChangeNOW</a>
    </div>
  </div>`;
}

function renderHistory() {
  if (!history.length) return `<div class="portfolio-chart-empty swap-history-empty">No swaps yet.</div>`;
  return `<div class="swap-history-list">${history.map((swap) => `
    <div class="swap-history-item">
      <button type="button" class="profile-card swap-history-row" data-swap-open="${deps.escapeHtml(swap.id)}">
        <span class="swap-history-copy">
          <strong>${deps.escapeHtml(String(swap.fromAmount))} ${deps.escapeHtml(String(swap.fromTicker).toUpperCase())} → ${deps.escapeHtml(fmt8(swap.toAmount))} ${deps.escapeHtml(String(swap.toTicker).toUpperCase())}</strong>
          <small>${deps.escapeHtml(new Date(Number(swap.createdAt) || Date.now()).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }))}</small>
        </span>
        <span class="swap-status ${statusColor(swap.status)}">${deps.escapeHtml(capitalize(swap.status))}</span>
      </button>
      <button type="button" class="swap-history-delete" data-swap-delete="${deps.escapeHtml(swap.id)}" aria-label="Delete swap"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5"/></svg></button>
    </div>`).join("")}</div>`;
}

// ---------------------------------------------------------------------------
// Estimate / create / status (iOS SwapService)
// ---------------------------------------------------------------------------
function rescheduleEstimate() {
  if (estimateTimer) clearTimeout(estimateTimer);
  const amount = Number(amountText);
  if (!Number.isFinite(amount) || amount <= 0) { estimateState = { status: "idle", toAmount: null, error: null }; renderFormLight(); return; }
  const token = ++estimateToken;
  const from = fromCoin(), to = toCoin(), amountStr = amountText;
  estimateTimer = window.setTimeout(async () => {
    if (token !== estimateToken) return;
    estimateState = { status: "loading", toAmount: null, error: null };
    renderFormLight();
    try {
      const response = await cn.estimate(from, to, amountStr);
      if (token !== estimateToken) return;
      estimateState = { status: "success", toAmount: Number(response?.toAmount) || 0, error: null };
    } catch (error) {
      if (token !== estimateToken) return;
      estimateState = { status: "failed", toAmount: null, error: error?.message || "Unavailable" };
    }
    renderFormLight();
  }, 500);
}

// Re-render without dropping what is being typed: the amount and payout fields keep their
// value, focus and caret.
function renderFormLight() {
  const active = document.activeElement;
  const wasAmount = active?.matches?.("[data-swap-amount]");
  const wasPayout = active?.matches?.("[data-swap-payout]");
  const caret = active?.selectionStart ?? null;
  render();
  const target = wasAmount ? rootEl.querySelector("[data-swap-amount]") : wasPayout ? rootEl.querySelector("[data-swap-payout]") : null;
  if (target) { target.focus(); if (caret != null) { try { target.setSelectionRange(caret, caret); } catch {} } }
}

async function executeSwap() {
  const amount = Number(amountText);
  if (!Number.isFinite(amount) || amount <= 0) return;
  const from = fromCoin(), to = toCoin(), amountStr = amountText;
  createState = { status: "creating", result: null, error: null };
  render();
  try {
    let payoutAddress = "";
    if (to.ticker === "kas") {
      if (toAddressOverrideIndex != null) {
        payoutAddress = deps.spendingAddressAt(toAddressOverrideIndex) || "";
      } else {
        // A fresh, never-used spending address, reserved now that the swap is real.
        const freshIndex = await deps.revealNextSpendingAddress();
        payoutAddress = freshIndex != null ? (deps.spendingAddressAt(freshIndex) || "") : toAddress;
      }
    } else {
      payoutAddress = payoutAddressText.trim();
    }
    if (!payoutAddress) {
      createState = { status: "failed", result: null, error: `Enter an address to receive the ${to.displayName}` };
      render();
      deps.showToast?.(createState.error);
      return;
    }
    const response = await cn.create(from, to, amountStr, payoutAddress);
    if (!response?.payinAddress) throw new Error("ChangeNOW didn't return a deposit address");
    history.unshift({
      id: response.id,
      fromTicker: from.ticker, fromNetwork: from.network,
      toTicker: to.ticker, toNetwork: to.network,
      fromAmount: amountStr,
      toAmount: response.toAmount != null ? String(response.toAmount) : "",
      payinAddress: response.payinAddress,
      payoutAddress,
      status: response.status || "new",
      createdAt: Date.now(),
      addedToPortfolio: false,
    });
    saveHistory();
    createState = { status: "success", result: response, error: null };
    amountText = "";
    estimateState = { status: "idle", toAmount: null, error: null };
    toAddressOverrideIndex = null;
    refreshToAddress();
    deps.showToast?.("Swap started");
  } catch (error) {
    createState = { status: "failed", result: null, error: error?.message || "Swap failed" };
    deps.showToast?.(createState.error);
  }
  render();
}

async function refreshSwapStatus(id) {
  try {
    const response = await cn.status(id);
    const status = response?.status || null;
    if (status) {
      const swap = history.find((s) => s.id === id);
      if (swap) {
        swap.status = status;
        if (response.toAmount != null) swap.toAmount = String(response.toAmount);
        saveHistory();
      }
      if (createState.result?.id === id) createState.result = { ...createState.result, status };
    }
    return status;
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// Sheets: coin picker, payout address picker, swap details
// ---------------------------------------------------------------------------
let sheetEl = null;
function openSheet(html) {
  if (!sheetEl) {
    sheetEl = document.createElement("div");
    sheetEl.className = "modal-backdrop swap-sheet-backdrop";
    sheetEl.innerHTML = `<section class="contact-modal swap-sheet" role="dialog" aria-modal="true" data-swap-sheet-body></section>`;
    document.body.appendChild(sheetEl);
    sheetEl.addEventListener("click", (event) => { if (event.target === sheetEl) closeSheet(); });
  }
  sheetEl.querySelector("[data-swap-sheet-body]").innerHTML = html;
  sheetEl.hidden = false;
  const qr = sheetEl.querySelector("[data-swap-qr]");
  if (qr && qr.dataset.swapQr) deps.engine.drawQrFor(qr, qr.dataset.swapQr, { dark: "#06110f", light: "#ffffff" }).catch(() => {});
}
function closeSheet() { if (sheetEl) sheetEl.hidden = true; sheet = null; }
let sheet = null; // { kind, ... }

function sheetHeader(title, { cancelLabel = "Cancel" } = {}) {
  return `<div class="modal-header swap-sheet-header"><button type="button" class="linklike-button" data-swap-sheet-close>${cancelLabel}</button><h2>${deps.escapeHtml(title)}</h2><span class="kns-wizard-close-spacer" aria-hidden="true"></span></div>`;
}

function renderCoinPicker() {
  const query = String(sheet.query || "").trim().toLowerCase();
  const rows = [];
  for (const ticker of PINNED_GROUPS) {
    rows.push({ kind: "group", ticker, displayName: GROUPED_TICKERS[ticker] });
    if (sheet.expanded.has(ticker)) for (const coin of CURATED_COINS) if (coin.ticker === ticker) rows.push({ kind: "network", coin });
  }
  for (const coin of CURATED_COINS) if (!GROUPED_TICKERS[coin.ticker]) rows.push({ kind: "coin", coin });
  const filtered = query ? rows.filter((row) => {
    const name = row.kind === "group" ? row.displayName : row.coin.displayName;
    const ticker = row.kind === "group" ? row.ticker : row.coin.ticker;
    return name.toLowerCase().includes(query) || ticker.toLowerCase().includes(query);
  }) : rows;
  const check = `<svg class="swap-check" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 5 5L20 7"/></svg>`;
  const list = filtered.map((row) => {
    if (row.kind === "group") {
      const representative = CURATED_COINS.find((c) => c.ticker === row.ticker);
      const expanded = sheet.expanded.has(row.ticker);
      return `<button type="button" class="swap-picker-row" data-swap-group="${row.ticker}">${coinIcon(representative)}<span>${deps.escapeHtml(row.displayName)}</span>${otherCoin.ticker === row.ticker ? check : ""}<svg class="swap-chevron ${expanded ? "open" : ""}" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></button>`;
    }
    const coin = row.coin;
    return `<button type="button" class="swap-picker-row ${row.kind === "network" ? "indented" : ""}" data-swap-coin="${coin.ticker}:${coin.network}">${coinIcon(coin)}<span>${deps.escapeHtml(coin.displayName)}</span>${sameCoin(coin, otherCoin) ? check : ""}</button>`;
  }).join("");
  openSheet(`${sheetHeader("Choose Coin")}
    <input class="field-input" type="search" data-swap-coin-search placeholder="Search coins" value="${deps.escapeHtml(sheet.query || "")}" autocomplete="off" />
    <div class="swap-picker-list">${list || `<p class="field-hint">No coins match.</p>`}</div>`);
  if (sheet.query) { const input = sheetEl.querySelector("[data-swap-coin-search]"); input?.focus(); try { input.setSelectionRange(input.value.length, input.value.length); } catch {} }
}

async function openAddressPicker() {
  sheet = { kind: "address", entries: [], loading: true, generating: false };
  renderAddressPicker();
  sheet.entries = await deps.listSpendingAddresses();
  if (sheet?.kind !== "address") return;
  sheet.loading = false;
  renderAddressPicker();
}
function renderAddressPicker() {
  if (sheet?.kind !== "address") return;
  const selectable = sheet.entries.filter((e) => !e.hidden && !e.used);
  const rows = selectable.map((e) => `<button type="button" class="swap-picker-row address" data-swap-address="${e.index}">
      <span class="swap-address-copy"><small>${deps.escapeHtml(e.label)} <b class="${e.used ? "used" : "unused"}">${e.used ? "Used" : "Unused"}</b></small><strong>${deps.escapeHtml(deps.shortAddress(e.address))}</strong></span>
      <span class="swap-address-kas">${deps.escapeHtml(fmtTrimmed(e.kas))} KAS</span>
    </button>`).join("");
  openSheet(`${sheetHeader("Choose Address")}
    ${sheet.loading && !sheet.entries.length ? `<p class="field-hint"><span class="kaposts-spinner small" aria-hidden="true"></span> Loading…</p>` : `
    <button type="button" class="swap-picker-row generate" data-swap-generate-address ${sheet.generating ? "disabled" : ""}>＋ ${sheet.generating ? "Generating…" : "Generate New Address"}</button>
    <p class="settings-group-footer">A swap pays out to an address you have not used before, so the payout cannot be tied to your earlier activity. Generate one if none are free.</p>
    <p class="settings-group-label">Unused Addresses</p>
    <div class="swap-picker-list">${rows || `<p class="field-hint">Every address here has been used. Generate a new one above.</p>`}</div>`}`);
}

function renderSwapDetails(id) {
  const swap = history.find((s) => s.id === id);
  if (!swap) { closeSheet(); return; }
  sheet = { kind: "details", id, refreshing: sheet?.refreshing || false };
  openSheet(`${sheetHeader("Swap Details", { cancelLabel: "Done" })}
    <div class="swap-details">
      <div class="swap-details-head">
        <strong>${deps.escapeHtml(String(swap.fromAmount))} ${deps.escapeHtml(String(swap.fromTicker).toUpperCase())} → ${deps.escapeHtml(fmt8(swap.toAmount))} ${deps.escapeHtml(String(swap.toTicker).toUpperCase())}</strong>
        <small>${deps.escapeHtml(new Date(Number(swap.createdAt) || Date.now()).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }))}</small>
      </div>
      <canvas class="swap-qr" data-swap-qr="${deps.escapeHtml(swap.payinAddress)}" data-swap-copy="${deps.escapeHtml(swap.payinAddress)}" width="180" height="180" title="Tap to copy"></canvas>
      <p class="settings-group-label">Deposit Address</p>
      <button type="button" class="swap-mono-button" data-swap-copy="${deps.escapeHtml(swap.payinAddress)}">${deps.escapeHtml(swap.payinAddress)}</button>
      <p class="settings-group-label">Status</p>
      <div class="swap-details-status"><strong class="swap-status ${statusColor(swap.status)}">${deps.escapeHtml(capitalize(swap.status))}</strong>${swap.status === "finished" ? `<button type="button" class="kaposts-view-link" data-swap-add-portfolio="${deps.escapeHtml(swap.id)}">Add to Portfolio</button>` : ""}</div>
      <p class="settings-group-label">ChangeNOW Exchange ID</p>
      <button type="button" class="swap-mono-button light" data-swap-copy-id="${deps.escapeHtml(swap.id)}">${deps.escapeHtml(swap.id)}</button>
      <div class="swap-details-actions">
        <button type="button" class="kaposts-view-link" data-swap-refresh="${deps.escapeHtml(swap.id)}" ${sheet.refreshing ? "disabled" : ""}>Refresh Status${sheet.refreshing ? " …" : ""}</button>
        <a class="kaposts-view-link" href="https://changenow.io/exchange/txs/${encodeURIComponent(swap.id)}" target="_blank" rel="noopener">View on ChangeNOW</a>
      </div>
    </div>`);
}

// ---------------------------------------------------------------------------
// Add to Portfolio (iOS portfolioPrefill / confirmAddToPortfolio)
// ---------------------------------------------------------------------------
function portfolioPrefill(swap) {
  const kasReceived = swap.toTicker === "kas";
  const amountKas = Number(kasReceived ? swap.toAmount : swap.fromAmount);
  const fiatValue = Number(kasReceived ? swap.fromAmount : swap.toAmount);
  if (!Number.isFinite(amountKas) || !Number.isFinite(fiatValue)) return null;
  return { type: kasReceived ? "buy" : "sell", amountKas, fiatValue, timestamp: Number(swap.createdAt) || Date.now(), notes: `ChangeNOW swap ${swap.id}` };
}
async function addSwapToPortfolio(swap) {
  const prefill = portfolioPrefill(swap);
  if (!prefill) { deps.showToast?.("Couldn't read this swap's amounts"); return; }
  const sourceTxId = `swap:${swap.id}`;
  const duplicates = portfolioIdsContainingTx(sourceTxId);
  const portfolios = listPortfolios();
  if (!portfolios.length) { deps.showToast?.("No portfolio to add this to yet."); return; }
  const duplicateNames = portfolios.filter((p) => duplicates.has(p.id)).map((p) => p.name).join(" and ");
  const line = `${prefill.type === "buy" ? "Buy" : "Sell"} ${fmt8(prefill.amountKas)} KAS at ${deps.currencySymbol()}${prefill.fiatValue.toFixed(2)} - choose which portfolio to add it to.`;
  const targetId = await chooseDialog({
    title: "Add to Portfolio",
    message: duplicateNames ? `${line}\n\nThis swap is already in ${duplicateNames}. Adding it again will double-count it.` : line,
    options: portfolios.map((p) => ({ id: p.id, title: duplicates.has(p.id) ? `${p.name} (already added)` : p.name, subtitle: p.isActive ? "Current" : "" })),
  });
  if (!targetId) return;
  addTransactionToPortfolio(targetId, { ...prefill, sourceTxId });
  swap.addedToPortfolio = true;
  saveHistory();
  deps.showToast?.(`Added to ${portfolios.find((p) => p.id === targetId)?.name || "portfolio"}`);
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
export function refreshSwaps() {
  refreshToAddress();
  render();
}

export function resetSwapsForAccount() {
  loadState();
  termsChecked = false;
  createState = { status: "idle", result: null, error: null };
  toAddressOverrideIndex = null;
  refreshToAddress();
  render();
}

export function initSwaps(dependencies) {
  deps = dependencies;
  rootEl = document.querySelector("[data-swaps-root]");
  loadState();
  refreshToAddress();

  rootEl?.addEventListener("input", (event) => {
    const amount = event.target.closest("[data-swap-amount]");
    if (amount) { amountText = amount.value.trim().replace(",", "."); rescheduleEstimate(); return; }
    const payout = event.target.closest("[data-swap-payout]");
    if (payout) payoutAddressText = payout.value;
  });
  rootEl?.addEventListener("change", (event) => {
    if (event.target.closest("[data-swap-terms]")) { termsChecked = event.target.checked; render(); }
  });
  rootEl?.addEventListener("submit", (event) => {
    const keyForm = event.target.closest("[data-swap-key-form]");
    if (keyForm) {
      event.preventDefault();
      const value = String(rootEl.querySelector("[data-swap-key-input]")?.value || "").trim();
      if (value) { localStorage.setItem(API_KEY_KEY, value); render(); }
    }
  });
  rootEl?.addEventListener("click", async (event) => {
    const tabButton = event.target.closest("[data-swap-tab]");
    if (tabButton) { tab = tabButton.dataset.swapTab; render(); return; }
    if (event.target.closest("[data-swap-agree]")) {
      if (!termsChecked) return;
      agreed = true;
      localStorage.setItem(deps.accountScopedKey(AGREED_KEY), "1");
      render();
      return;
    }
    if (event.target.closest("[data-swap-not-now]")) { tab = "swap"; render(); return; }
    if (event.target.closest("[data-swap-flip]")) { kasIsSendSide = !kasIsSendSide; rescheduleEstimate(); render(); return; }
    if (event.target.closest("[data-swap-create]")) { executeSwap(); return; }
    if (event.target.closest("[data-swap-pick-coin]")) { sheet = { kind: "coin", query: "", expanded: new Set() }; renderCoinPicker(); return; }
    if (event.target.closest("[data-swap-change-address]")) { openAddressPicker(); return; }
    if (event.target.closest("[data-swap-open-spending]")) { deps.openSpendingAddresses?.(); return; }
    const copy = event.target.closest("[data-swap-copy]");
    if (copy) { try { await deps.copyTextToClipboard(copy.dataset.swapCopy); deps.showToast?.(deps.addressCopiedToastText(copy.dataset.swapCopy)); } catch {} return; }
    const copyId = event.target.closest("[data-swap-copy-id]");
    if (copyId) { try { await deps.copyTextToClipboard(copyId.dataset.swapCopyId); deps.showToast?.("Exchange ID copied"); } catch {} return; }
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
      const ok = await confirmDialog({ title: "Delete this swap?", message: "This only removes it from your local history - it doesn't affect the actual exchange.", confirmLabel: "Delete", destructive: true });
      if (!ok) return;
      history = history.filter((s) => s.id !== del.dataset.swapDelete);
      saveHistory();
      render();
    }
  });

  document.addEventListener("click", async (event) => {
    if (!sheetEl || sheetEl.hidden || !sheetEl.contains(event.target)) return;
    if (event.target.closest("[data-swap-sheet-close]")) { closeSheet(); return; }
    const group = event.target.closest("[data-swap-group]");
    if (group && sheet?.kind === "coin") {
      const ticker = group.dataset.swapGroup;
      if (sheet.expanded.has(ticker)) sheet.expanded.delete(ticker); else sheet.expanded.add(ticker);
      renderCoinPicker();
      return;
    }
    const coin = event.target.closest("[data-swap-coin]");
    if (coin && sheet?.kind === "coin") {
      const [ticker, network] = coin.dataset.swapCoin.split(":");
      const picked = CURATED_COINS.find((c) => c.ticker === ticker && c.network === network);
      if (picked) { otherCoin = picked; closeSheet(); rescheduleEstimate(); render(); }
      return;
    }
    if (event.target.closest("[data-swap-generate-address]") && sheet?.kind === "address") {
      sheet.generating = true;
      renderAddressPicker();
      await deps.revealNextSpendingAddress();
      if (sheet?.kind !== "address") return;
      sheet.entries = await deps.listSpendingAddresses();
      if (sheet?.kind !== "address") return;
      sheet.generating = false;
      renderAddressPicker();
      return;
    }
    const addressRow = event.target.closest("[data-swap-address]");
    if (addressRow && sheet?.kind === "address") {
      const index = Number(addressRow.dataset.swapAddress);
      const entry = sheet.entries.find((e) => e.index === index);
      if (!entry) return;
      // Look at it first, or take it (iOS addressActionsSheet).
      const choice = await chooseDialog({
        title: entry.label,
        message: deps.shortAddress(entry.address),
        options: [
          { id: "explorer", title: "View in Explorer", subtitle: "Check its history before you send a swap to it." },
          { id: "use", title: "Use for This Swap", subtitle: "ChangeNOW pays the swapped KAS out to this address." },
        ],
      });
      if (choice === "explorer") window.open(deps.explorerAddressUrl(entry.address), "_blank", "noopener,noreferrer");
      else if (choice === "use") { toAddressOverrideIndex = index; refreshToAddress(); closeSheet(); render(); }
      return;
    }
    const copy = event.target.closest("[data-swap-copy]");
    if (copy) { try { await deps.copyTextToClipboard(copy.dataset.swapCopy); deps.showToast?.(deps.addressCopiedToastText(copy.dataset.swapCopy)); } catch {} return; }
    const copyId = event.target.closest("[data-swap-copy-id]");
    if (copyId) { try { await deps.copyTextToClipboard(copyId.dataset.swapCopyId); deps.showToast?.("Exchange ID copied"); } catch {} return; }
    const refresh = event.target.closest("[data-swap-refresh]");
    if (refresh && sheet?.kind === "details") {
      if (sheet.refreshing) return;
      sheet.refreshing = true;
      renderSwapDetails(sheet.id);
      const status = await refreshSwapStatus(refresh.dataset.swapRefresh);
      if (sheet?.kind !== "details") return;
      sheet.refreshing = false;
      renderSwapDetails(sheet.id);
      deps.showToast?.(status ? `Status: ${capitalize(status)}` : "Couldn't reach ChangeNOW - try again");
      render();
      return;
    }
    const addTo = event.target.closest("[data-swap-add-portfolio]");
    if (addTo) {
      const swap = history.find((s) => s.id === addTo.dataset.swapAddPortfolio);
      closeSheet();
      if (swap) addSwapToPortfolio(swap);
    }
  });
  document.addEventListener("input", (event) => {
    if (!sheetEl || sheetEl.hidden) return;
    const search = event.target.closest("[data-swap-coin-search]");
    if (search && sheet?.kind === "coin") { sheet.query = search.value; renderCoinPicker(); }
  });

  render();
}
