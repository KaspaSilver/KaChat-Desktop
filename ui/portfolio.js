// Portfolio tab — desktop port of iOS 4.0's single continuous portfolio page: Robinhood-style
// portfolio picker cards (multi-portfolio, per account, today's change per card), iOS summary
// card (Holdings / Current Value / Total Invested / Total P&L / Avg. Buy Price), scrubbable
// KAS price chart with range selector, ledger-replayed Value Over Time chart, and a full
// buy/sell transaction ledger with an edit sheet, CoinMarketCap-compatible CSV import/export,
// and on-chain Kaspa address import. Charts are hand-drawn SVG — no chart library, matching
// the app's zero-dependency approach.

import {
  fetchKasPrice,
  fetchKasPriceHistory,
  baseDaysFor,
  cutPoints,
  yearToDateDays,
  CHART_PAIRS,
  fetchMarketPairHistory,
  dividePoints,
  peekKasPrice,
  peekKasPriceHistory,
  peekDailyPrices,
  fetchKasMarketStats,
  peekKasMarketStats,
  resolveDailyPrices,
  resolveDailyPriceSingle,
  utcDayKey,
  PRICE_REQUEST_SPACING_MS,
} from "../engine/prices.js";
import { getEndpoint } from "../engine/endpoints.js";
import {
  fetchNetworkStats, peekNetworkStats, formatHashrate, estimateDailyKas,
} from "../engine/network-stats.js";
import { ADDRESS_PREFIX, ADDRESS_HRP, KAS_UNIT, isValidKaspaAddress } from "../engine/network.js";
import { resolveDomain } from "../engine/kns.js";
import { looksLikeName, resolveEverywhere, primary as primaryName, notFoundMessage } from "../engine/name-services.js";
import { closeActiveScanner, scanKaspaAddress } from "./qr-scan.js";
import { otherDomainsHtml, pickOtherDomain } from "./send-kaspa-components.js";
import { saveFile } from "./save-file.js";
import { transactionBelongsInHistory } from "../engine/sync.js";
import { isNextcloudConnected, uploadToKaChatFolder, downloadNextcloudText, openNextcloudFilePicker, noteMessageActivity } from "./nextcloud.js";
import {
  PORTFOLIO_SEED_NAME, isPortfolioUuid, newPortfolioUuid, stampPortfolioChanges, mergePortfolioTombstones,
  mergePortfolioSync, portfolioSyncFromDesktop, portfolioSyncToDesktop, portfolioSyncFromArchive,
  portfolioSyncToArchive, portfolioSyncForArchive, isPortfolioSyncEmpty,
} from "./portfolio-sync.js";
// Imported, not a string path: Vite only rewrites and emits assets it can SEE, and a path inside
// a template literal is invisible to it - which left this 404ing on the built site.
import kaspaLogoUrl from "./assets/kaspa-logo.png";

const PORTFOLIO_KEY = "kachat-portfolios-v1"; // account-scoped: { activeId, portfolios: [{id, name, transactions: [...] }] }
// Network fees the portfolios' imported addresses paid (iOS PortfolioFeeRecord), stored per
// account BESIDE the ledger: [{ txId, portfolioId, sourceAddress, amountSompi, timestamp,
// fiatValue }] - fiatValue null until that day's price is known (the backfill fills it in).
const FEES_KEY = "kachat-portfolio-fees-v1";
// Portfolios and rows deleted on this account, [{ kind: "portfolio" | "transaction", id, deletedAt }]
// (ms), carried in the Nextcloud backup so a merge or restore never brings them back (iOS 11f1548).
const TOMBSTONES_KEY = "kachat-portfolio-tombstones-v1";
const MAX_PORTFOLIOS = 5;
// Mirrors iOS PortfolioAddressImporter.priceUnavailableNote — rows the import couldn't price
// synchronously carry this note, show a warning icon, and are filled in by the background price
// backfill (the user can also set a price by hand via the edit sheet).
const PRICE_PENDING_NOTE = "Price loading, will fill in automatically";
// Sentinel written by builds before the background backfill existed. Still recognized so rows
// imported by an older version keep their warning icon and get backfilled too — same two-
// generation scheme as iOS's priceUnavailableNote / legacyPriceUnavailableNote.
const LEGACY_PRICE_UNAVAILABLE_NOTE = "Price unavailable — set manually";

/** True when `notes` marks a row whose price is still pending (either sentinel generation). */
function isPricePending(notes) {
  return notes === PRICE_PENDING_NOTE || notes === LEGACY_PRICE_UNAVAILABLE_NOTE;
}

// YTD is the days since 1 January, read when the buttons are drawn so it is right after midnight.
function ranges() {
  return [
    { days: 1, label: "1D" },
    { days: 7, label: "1W" },
    { days: 30, label: "1M" },
    { days: 90, label: "3M" },
    { days: yearToDateDays(), label: "YTD" },
    { days: 365, label: "1Y" },
    { days: 0, label: "All" },
  ];
}
// What a tap on the big number flips the chart to (iOS 39adefe): bitcoin by default, or VOO,
// gold or silver from the gear; null = the tap does nothing. Persisted on this device.
const CHART_PAIR_KEY = "kachat-portfolio-chart-pair";
let chartPair = (() => { try { const v = localStorage.getItem(CHART_PAIR_KEY); return v === null ? "bitcoin" : (v || null); } catch { return "bitcoin"; } })();
let pairActive = false;            // the big number is showing the pair right now
let pairSeries = null;             // { pair, baseDays, kas: [[ms, v]], latest } for the current base
let pairLoading = false;

let deps = null;
let rootEl = null;
let modalsEl = null;
let state = { activeId: null, portfolios: [] };
let fees = [];             // every portfolio's PortfolioFeeRecords for this account (FEES_KEY)
let tombstones = [];       // this account's deleted portfolios and rows (TOMBSTONES_KEY)
// The list as last saved (a deep copy: rows are edited in place), so a save can tell what changed
// (stamped) and what went (a tombstone) - iOS savedPortfolios / savedTransactions (11f1548).
let savedPortfolios = [];
let price = null;         // { price, change24h, currency, fetchedAt }
let history = [];          // [[ts, fiat]] for the selected range — resolved every render
let sevenDayHistory = [];  // fixed 7d window for per-card "today's change" (independent of range)
let valuePoints = [];      // ledger replay of `history` — rebuilt every render
// Session cache of fetched ranges for the CURRENT currency, so switching ranges (or coming back
// to one) repaints instantly instead of blanking while the network catches up. Cleared whenever
// the selected currency changes. Mirrors iOS PortfolioViewModel.priceHistoryCache.
let historyByRange = {};
let historyCurrency = null;
let rangeDays = 1; // iOS PortfolioViewModel.priceRangeDays starts on 1D
let loading = false;
let editingTx = null;      // null = closed; { id } editing; { id: null } adding
// null = closed; otherwise { busy, progress, input, resolving, resolvedAddress, resolvedDomain,
// notFound } — the KNS resolution state for the Add Kaspa Address sheet.
let addressImport = null;
let priceBackfillTimer = null; // non-null while the background price backfill loop is running
let view = "main";         // "main" | "price" | "value" | "hashrate" — which screen is showing
/// What the mining estimate has been typed into. Held here rather than in the DOM so the figure
/// survives the re-render each keystroke triggers.
let hashrateInput = "";

// Thousands grouping for a number being typed (iOS DecimalInputFormat): a six-figure hashrate
// arrives as "1200000" and has to be counted by eye. Regrouped after every keystroke, handed
// back ungrouped to whatever computes with it; the fraction is left exactly as typed.
const DECIMAL_SEPARATORS = (() => {
  try {
    const parts = new Intl.NumberFormat(undefined).formatToParts(1234.5);
    return {
      group: parts.find((p) => p.type === "group")?.value || ",",
      decimal: parts.find((p) => p.type === "decimal")?.value || ".",
    };
  } catch { return { group: ",", decimal: "." }; }
})();
function groupDecimalInput(text) {
  const { group, decimal } = DECIMAL_SEPARATORS;
  const normalized = String(text ?? "").split(group).join("");
  const idx = normalized.indexOf(decimal);
  const whole = idx >= 0 ? normalized.slice(0, idx) : normalized;
  const fraction = idx >= 0 ? normalized.slice(idx + 1) : null;
  const digits = whole.replace(/\D/g, "");
  if (!digits) return normalized;
  let formatted;
  try { formatted = BigInt(digits).toLocaleString(undefined); } catch { formatted = digits; }
  if (fraction !== null) return `${formatted}${decimal}${fraction}`;
  return normalized.endsWith(decimal) ? `${formatted}${decimal}` : formatted;
}
// A canonical "1234.5" (toFixed output) in the locale's grouped form.
function groupedFromCanonical(text) {
  return groupDecimalInput(String(text ?? "").replace(".", DECIMAL_SEPARATORS.decimal));
}
function decimalInputValue(text) {
  const { group, decimal } = DECIMAL_SEPARATORS;
  const bare = String(text ?? "").split(group).join("").replace(decimal, ".").replace(",", ".");
  const n = Number(bare);
  return Number.isFinite(n) ? n : null;
}
// Rewrites the field grouped while keeping the caret on the same digit.
function regroupField(input) {
  const before = input.value;
  const caret = input.selectionStart ?? before.length;
  const digitsBefore = before.slice(0, caret).replace(/[^\d]/g, "").length;
  const after = groupDecimalInput(before);
  if (after === before) return;
  input.value = after;
  let pos = 0, seen = 0;
  while (pos < after.length && seen < digitsBefore) { if (/\d/.test(after[pos])) seen += 1; pos += 1; }
  try { input.setSelectionRange(pos, pos); } catch {}
}
const HASHRATE_RANGES = [{ days: 30, label: "1M" }, { days: 90, label: "3M" }, { days: 365, label: "1Y" }, { days: 0, label: "All" }];
let hashrateRangeDays = 90;
/// The converter's two fields. Only the one being TYPED IN is authoritative - the other is
/// derived - so a rounded value can never be fed back through the rate and drift (iOS
/// KasConverterCard keeps the same rule).
/// The order being edited, which is NOT the live one until Done - the same reason Customize Dock
/// edits a draft: committing on every arrow press would re-render the cards underneath the sheet.
let reorderDraft = [];
/// The unit the mining estimate is entered in. A picker rather than parsing what someone types:
/// "120" alone is ambiguous, and guessing TH/s puts the answer out by three orders of magnitude
/// when they meant GH/s.
const HASHRATE_UNITS = [
  { key: "gh", label: "GH/s", scale: 1e9 },
  { key: "th", label: "TH/s", scale: 1e12 },
  { key: "ph", label: "PH/s", scale: 1e15 },
];
let hashrateUnit = "th";
/// Which card's settings overlay is open, and which step of it.
let cardModalId = null;
let cardModalMode = "menu"; // "menu" | "rename" | "delete"
/// Which of the two header overlays is open.
let actionSheetMode = "add"; // "add" | "io"
/// Multi-select over the transaction list (iOS's EditMode on PortfolioTransactionsView).
///
/// Deleting one transaction has always been a row-level x. Deleting the forty rows a bad CSV
/// import left behind was forty confirmations, which is why iOS grew a Select mode and why this
/// one exists.
let selecting = false;
let selectedTxIds = new Set();

function exitSelectMode() {
  selecting = false;
  selectedTxIds.clear();
}

/// Repaint just the two header controls that count. Toggling a row full-renders otherwise, which
/// throws away the scroll position on a long list - the exact list where this mode earns its keep.
function refreshSelectionUi() {
  const total = rootEl ? rootEl.querySelectorAll("[data-portfolio-tx-select]").length : 0;
  const all = rootEl?.querySelector("[data-portfolio-select-all]");
  const del = rootEl?.querySelector("[data-portfolio-delete-selected]");
  if (all) {
    const allPicked = total > 0 && selectedTxIds.size === total;
    all.innerHTML = allPicked ? CHECK_FILLED_SVG : CHECK_OUTLINE_SVG;
    all.setAttribute("aria-label", allPicked ? "Deselect all" : "Select all");
    all.title = allPicked ? "Deselect all" : "Select all";
  }
  if (del) {
    const count = del.querySelector("[data-portfolio-delete-count]");
    if (count) count.textContent = selectedTxIds.size ? String(selectedTxIds.size) : "";
    del.disabled = selectedTxIds.size === 0;
  }
}
let converterKas = "1";
let converterFiat = "";

// ---------------------------------------------------------------------------
// Selected currency
// ---------------------------------------------------------------------------
// The preference itself lives in ui/app.js (Settings > Customization > Currency), which owns the
// picker, persists the choice under this key and fires `kachat:currency-changed` on every change.
// Portfolio is handed `currencyCode`/`currencySymbol` accessors and prefers them; the direct
// key read and the symbol table below stay as the fallback for wiring that predates them
// (app.js's own CURRENCIES table is not exported).
const CURRENCY_PREF_KEY = "kachat-currency-v1";
const CURRENCY_SYMBOLS = {
  usd: "$", eur: "€", gbp: "£", jpy: "¥", cny: "CN¥", aud: "A$", cad: "C$", chf: "CHF ",
  hkd: "HK$", inr: "₹", krw: "₩", sgd: "S$", nzd: "NZ$", mxn: "MX$", brl: "R$", rub: "₽",
  try: "₺", zar: "R", idr: "Rp", btc: "₿",
};

function currencyCode() {
  const fromDeps = deps?.currencyCode?.();
  if (fromDeps && CURRENCY_SYMBOLS[String(fromDeps).toLowerCase()]) return String(fromDeps).toLowerCase();
  try {
    const stored = String(localStorage.getItem(CURRENCY_PREF_KEY) || "").toLowerCase();
    if (CURRENCY_SYMBOLS[stored]) return stored;
  } catch { /* private mode */ }
  return "usd";
}

function currencySymbol() {
  return deps?.currencySymbol?.() || CURRENCY_SYMBOLS[currencyCode()] || "$";
}


/** A new portfolio or row id: an uppercase UUID, as iOS writes them (the backup matches portfolio
 *  deletions by that string). */
function nowId() {
  return newPortfolioUuid();
}

// ---------------------------------------------------------------------------
// Persistence (per account)
// ---------------------------------------------------------------------------

function loadState() {
  loadFees();
  loadTombstones();
  state = { activeId: null, portfolios: [] };
  try {
    const parsed = JSON.parse(localStorage.getItem(deps.accountScopedKey(PORTFOLIO_KEY)) || "null");
    if (parsed?.portfolios?.length) state = parsed;
  } catch { /* fall through */ }
  if (migrateForSync()) writeState();
  savedPortfolios = snapshotPortfolios();
}

/** Once per stored list, before sync reads it (iOS 11f1548): every portfolio gets a createdAt and
 *  an uppercase UUID id (fees and the active id follow it), every row a UUID id. Not an edit, so
 *  nothing is stamped. True when anything changed. */
function migrateForSync() {
  let changed = false;
  const renamed = new Map();
  const now = Date.now();
  for (const portfolio of state.portfolios) {
    const raw = String(portfolio.id ?? "");
    const id = isPortfolioUuid(raw) ? raw.toUpperCase() : nowId();
    if (id !== raw) { renamed.set(raw, id); portfolio.id = id; changed = true; }
    if (!Number.isFinite(Number(portfolio.createdAt)) || Number(portfolio.createdAt) <= 0) { portfolio.createdAt = now; changed = true; }
    for (const tx of portfolio.transactions || []) {
      if (!isPortfolioUuid(tx.id)) { tx.id = nowId(); changed = true; }
    }
  }
  if (renamed.has(String(state.activeId ?? ""))) state.activeId = renamed.get(String(state.activeId));
  let feesChanged = false;
  for (const fee of fees) {
    const raw = String(fee.portfolioId ?? "");
    const id = renamed.get(raw) || (isPortfolioUuid(raw) ? raw.toUpperCase() : raw);
    if (id !== raw) { fee.portfolioId = id; feesChanged = true; }
  }
  if (feesChanged) { try { localStorage.setItem(deps.accountScopedKey(FEES_KEY), JSON.stringify(fees)); } catch { /* quota */ } }
  return changed;
}

function snapshotPortfolios() {
  return JSON.parse(JSON.stringify(state.portfolios));
}

function writeState() {
  localStorage.setItem(deps.accountScopedKey(PORTFOLIO_KEY), JSON.stringify(state));
}

/// Saves the list: anything added, renamed, moved or edited is stamped, anything gone is recorded
/// as deleted, and the Nextcloud backup is marked to upload (NEXTCLOUD_SYNC.md §5, iOS 11f1548
/// PortfolioManager/PortfolioViewModel.persist). Picking the active portfolio changes nothing here.
function saveState() {
  const now = Date.now();
  const result = stampPortfolioChanges(savedPortfolios, state.portfolios, now);
  if (result.tombstones.length) {
    tombstones = mergePortfolioTombstones([tombstones, result.tombstones]);
    saveTombstones();
  }
  writeState();
  savedPortfolios = snapshotPortfolios();
  if (result.changed) noteBackupActivity();
}

function noteBackupActivity() {
  try { noteMessageActivity(); } catch { /* Nextcloud not set up */ }
}

function loadTombstones() {
  try {
    const parsed = JSON.parse(localStorage.getItem(deps.accountScopedKey(TOMBSTONES_KEY)) || "null");
    tombstones = Array.isArray(parsed) ? parsed : [];
  } catch { tombstones = []; }
}

function saveTombstones() {
  try { localStorage.setItem(deps.accountScopedKey(TOMBSTONES_KEY), JSON.stringify(tombstones)); } catch { /* quota */ }
}

function loadFees() {
  try {
    const parsed = JSON.parse(localStorage.getItem(deps.accountScopedKey(FEES_KEY)) || "null");
    fees = Array.isArray(parsed) ? parsed : [];
  } catch { fees = []; }
}

function saveFees() {
  try { localStorage.setItem(deps.accountScopedKey(FEES_KEY), JSON.stringify(fees)); } catch { /* quota */ }
  noteBackupActivity(); // fees ride in the backup too (iOS persistFees)
}

/// A deleted portfolio's fees go with it (iOS forgetPortfolio). Its rows already do: they live
/// inside the portfolio object, which is dropped from `state` before it is saved.
function forgetPortfolioFees(portfolioId) {
  const before = fees.length;
  fees = fees.filter((fee) => fee.portfolioId !== portfolioId);
  if (fees.length !== before) saveFees();
}

function ensureDefaultPortfolio() {
  if (state.portfolios.length === 0) {
    // The seed is written as is, never stamped: untouched, it stays out of the backup and gives
    // way to the real list when one arrives (iOS 11f1548).
    const p = { id: nowId(), name: PORTFOLIO_SEED_NAME, createdAt: Date.now(), transactions: [] };
    state.portfolios.push(p);
    state.activeId = p.id;
    writeState();
    savedPortfolios = snapshotPortfolios();
  }
  if (!state.portfolios.some((p) => p.id === state.activeId)) {
    state.activeId = state.portfolios[0].id;
  }
}

function activePortfolio() {
  ensureDefaultPortfolio();
  return state.portfolios.find((p) => p.id === state.activeId);
}

// ---------------------------------------------------------------------------
// Pure math — direct ports of PortfolioViewModel's static functions
// ---------------------------------------------------------------------------

function computeSummary(transactions, priceUsd) {
  let holdingsKas = 0;
  let totalInvested = 0;
  let totalProceeds = 0;
  let totalBoughtKas = 0;
  for (const tx of transactions) {
    const amount = Number(tx.amountKas) || 0;
    const fiat = Number(tx.fiatValue) || 0;
    // A transfer is your own KAS changing address: a record only, counted nowhere (iOS 7423330).
    if (tx.type === "transfer") continue;
    if (tx.type === "sell") {
      holdingsKas -= amount;
      totalProceeds += fiat;
    } else {
      holdingsKas += amount;
      totalInvested += fiat;
      totalBoughtKas += amount;
    }
  }
  const currentValue = holdingsKas * (priceUsd || 0);
  const totalPL = (currentValue + totalProceeds) - totalInvested;
  const totalPLPercent = totalInvested > 0 ? (totalPL / totalInvested) * 100 : 0;
  const averageBuyPriceUsd = totalBoughtKas > 0 ? totalInvested / totalBoughtKas : null;
  return { holdingsKas, totalInvested, totalProceeds, currentValue, totalPL, totalPLPercent, averageBuyPriceUsd };
}

/** Replays the ledger against each price point to get holdings *as of that moment* — a
 *  buy/sell partway through the window changes the curve's shape from that point on, not
 *  retroactively. A transaction exactly at a point's timestamp counts as included. */
function computeValueHistory(transactions, pricePoints) {
  if (!pricePoints?.length) return [];
  const sorted = [...transactions].sort((a, b) => a.timestamp - b.timestamp);
  let holdings = 0;
  let txIndex = 0;
  return pricePoints.map(([ts, p]) => {
    while (txIndex < sorted.length && sorted[txIndex].timestamp <= ts) {
      const tx = sorted[txIndex];
      if (tx.type !== "transfer") holdings += (tx.type === "sell" ? -1 : 1) * (Number(tx.amountKas) || 0);
      txIndex += 1;
    }
    return [ts, holdings * p];
  });
}

/** Sompi as an integer, so FIFO lots subtract exactly rather than drifting in float KAS. */
function toSompi(amountKas) {
  return Math.round((Number(amountKas) || 0) * 1e8);
}

/** FIFO realized profit and loss for the sells dated in `year` (iOS computeRealizedPL). Every
 *  buy, from any year, is a lot; each sell, from any year, takes from the oldest lots first - so
 *  a sale this year is matched against whatever was still held - but only this year's sells add
 *  to the result. Same timestamp: the buy goes first. A sell larger than the lots left counts the
 *  rest at zero cost (`uncoveredKas`). Transfers are skipped: their cost stays with the KAS. */
function computeRealizedPL(transactions, year) {
  const result = { year, proceeds: 0, costBasis: 0, sellCount: 0, uncoveredKas: 0, pendingPriceCount: 0, amount: 0 };
  const lots = [];
  let lotStart = 0;
  let uncoveredSompi = 0;
  const ordered = [...transactions].sort((a, b) => {
    if (a.timestamp === b.timestamp) return (a.type === "buy" && b.type === "sell") ? -1 : (a.type === "sell" && b.type === "buy") ? 1 : 0;
    return a.timestamp - b.timestamp;
  });
  for (const tx of ordered) {
    const sompi = toSompi(tx.amountKas);
    const fiat = Number(tx.fiatValue) || 0;
    if (tx.type === "buy") {
      if (sompi <= 0) continue;
      lots.push({ sompi, costPerSompi: fiat / sompi });
      if (isPricePending(tx.notes)) result.pendingPriceCount += 1;
    } else if (tx.type === "sell") {
      let remaining = sompi;
      let cost = 0;
      while (remaining > 0 && lotStart < lots.length) {
        const take = Math.min(remaining, lots[lotStart].sompi);
        cost += take * lots[lotStart].costPerSompi;
        lots[lotStart].sompi -= take;
        remaining -= take;
        if (lots[lotStart].sompi === 0) lotStart += 1;
      }
      if (new Date(tx.timestamp).getFullYear() !== year) continue;
      result.proceeds += fiat;
      result.costBasis += cost;
      result.sellCount += 1;
      uncoveredSompi += Math.max(remaining, 0);
      if (isPricePending(tx.notes)) result.pendingPriceCount += 1;
    }
    // transfer: your own KAS changing address - not a sale, and its cost stays with it.
  }
  result.uncoveredKas = uncoveredSompi / 1e8;
  result.amount = result.proceeds - result.costBasis;
  return result;
}

/** The Fees Spent card's numbers for one portfolio (iOS feeSummary). */
function computeFeeSummary(portfolioId) {
  const summary = { totalKas: 0, totalFiat: 0, count: 0, unpricedCount: 0 };
  for (const fee of fees) {
    if (fee.portfolioId !== portfolioId) continue;
    summary.totalKas += (Number(fee.amountSompi) || 0) / 1e8;
    summary.count += 1;
    if (Number.isFinite(fee.fiatValue)) summary.totalFiat += fee.fiatValue;
    else summary.unpricedCount += 1;
  }
  return summary;
}

/** Real today-only $ and % change: latest value sample minus the sample closest to (but not
 *  after) 24h before it. Null when no sample exists that far back (e.g. created today). */
function computeTodayChange(points) {
  if (!points?.length) return null;
  const [latestTs, latestValue] = points[points.length - 1];
  const dayAgo = latestTs - 86_400_000;
  let base = null;
  for (const point of points) {
    if (point[0] <= dayAgo) base = point;
    else break;
  }
  if (!base) return null;
  const amount = latestValue - base[1];
  const percent = base[1] === 0 ? 0 : (amount / base[1]) * 100;
  return { amount, percent };
}

// ---------------------------------------------------------------------------
// Formatting — in the selected currency (iOS PortfolioFormat)
// ---------------------------------------------------------------------------

// iOS PortfolioFormat.currency: symbol prefix (built by hand rather than via an ISO-4217 currency
// formatter, whose behavior for a non-ISO code like BTC isn't worth relying on), 2 decimals.
// The eye in the header masks every amount on the Portfolio - picker cards, the Value square,
// transaction rows, the Value Over Time screen and its readouts - as dots; the KAS price and
// percentages stay. Persisted on this device (iOS 9aa23bb).
const HIDE_AMOUNTS_KEY = "kachat-portfolio-hide-amounts";
let amountsHidden = false;
try { amountsHidden = localStorage.getItem(HIDE_AMOUNTS_KEY) === "1"; } catch { amountsHidden = false; }
function setAmountsHidden(hidden) {
  amountsHidden = Boolean(hidden);
  try { localStorage.setItem(HIDE_AMOUNTS_KEY, amountsHidden ? "1" : "0"); } catch { /* fine */ }
  // The toolbar balance above Portfolio masks with it (app.js renderToolbarBalance).
  try { document.dispatchEvent(new CustomEvent("kachat:portfolio-amounts-hidden")); } catch { /* fine */ }
}
/** Whether Portfolio's eye is on - the toolbar balance over Portfolio masks with it. */
export function portfolioAmountsHidden() {
  return amountsHidden;
}
const MASKED_AMOUNT = "••••••";

/** The symbol for a currency code; the app's own accessor for the selected one. */
function symbolFor(code) {
  if (code === "btc") return "₿";
  if (code === currencyCode()) return currencySymbol();
  return CURRENCY_SYMBOLS[code] || `${String(code || "").toUpperCase()} `;
}

/// iOS PortfolioFormat.bitcoin: a bitcoin amount in full - eight decimals at the least (a satoshi
/// is the smallest unit), and more for a figure as small as one KAS in bitcoin, so at least four
/// digits of it show rather than a row of zeros. Rounded to two places it read ₿0.00 for everything.
function fmtBitcoin(value) {
  const v = Number(value) || 0;
  const sign = v < 0 ? "-" : "";
  const magnitude = Math.abs(v);
  let decimals = 8;
  if (magnitude > 0 && magnitude < 0.0001) decimals = Math.min(12, Math.max(8, Math.ceil(-Math.log10(magnitude)) + 3));
  return `${sign}₿${magnitude.toFixed(decimals)}`;
}

/// iOS PortfolioFormat.currency: symbol prefix, 2 grouped decimals - bitcoin in full.
function currencyText(value, code = currencyCode()) {
  if (code === "btc") return fmtBitcoin(value);
  const v = Number(value) || 0;
  const sign = v < 0 ? "-" : "";
  const magnitude = Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${sign}${symbolFor(code)}${magnitude}`;
}

function fmtFiat(value) {
  if (amountsHidden) return MASKED_AMOUNT;
  return currencyText(value);
}

/** An amount in the selected currency, never masked - for screens outside Portfolio (Add to
 *  Portfolio's Total), which iOS formats with the same PortfolioFormat.currency. */
export function formatPortfolioCurrency(value) {
  return currencyText(value);
}

// iOS PortfolioFormat.compactCurrency: $2.4B rather than every digit of a market cap - two
// decimals under 10, one under 100, none above. Never masked: it is Kaspa's figure, not yours.
function fmtCompactFiat(value) {
  const v = Number(value) || 0;
  const magnitude = Math.abs(v);
  const units = [[1e12, "T"], [1e9, "B"], [1e6, "M"], [1e3, "K"]];
  let scaled = magnitude;
  let suffix = "";
  for (const [size, unit] of units) {
    if (magnitude >= size) { scaled = magnitude / size; suffix = unit; break; }
  }
  const decimals = scaled < 10 ? 2 : scaled < 100 ? 1 : 0;
  return `${v < 0 ? "-" : ""}${symbolFor(currencyCode())}${scaled.toFixed(decimals)}${suffix}`;
}

// iOS PortfolioFormat.price: 5 decimals under a unit, else 2 - bitcoin in full.
function fmtPrice(value, code = currencyCode()) {
  if (code === "btc") return fmtBitcoin(value);
  const v = Number(value) || 0;
  return `${symbolFor(code)}${v.toFixed(v < 1 ? 5 : 2)}`;
}

function fmtKas(value) {
  if (amountsHidden) return `${MASKED_AMOUNT} ${KAS_UNIT}`;
  return `${Number(value || 0).toLocaleString(undefined, { maximumFractionDigits: 4 })} ${KAS_UNIT}`;
}

function fmtDate(ts) {
  return new Date(ts).toLocaleString(undefined, {
    month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit",
  });
}

// ---------------------------------------------------------------------------
// Charts (plain SVG polyline + HTML crosshair overlay for scrubbing)
// ---------------------------------------------------------------------------

/** yFractions[i] = distance from the wrapper's top as a 0..1 fraction, for the crosshair dot.
 *  Uses the same 10px top/bottom padding as bigChartSvg so the dot tracks the drawn line. */
function chartGeometry(points, height) {
  const values = points.map((p) => p[1]);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pad = 10;
  const usable = height - pad * 2;
  return values.map((v) => (pad + (1 - (v - min) / span) * usable) / height);
}

/** Full-screen chart (area fill + horizontal gridlines + polyline) plus an HTML x-axis label
 *  row - reads like a real price/value graph rather than a bare sparkline. Scrub overlay + the
 *  data-portfolio-chart hook are shared with attachScrub(). Intraday spans (<= ~2d) label the
 *  x-axis with hours; longer spans with month/day, so 1D labels don't crowd. */
function bigChartSvg(points, { height = 240, stroke = "var(--kaspa)", chart = null, lineWidth = 2, hideValues = false } = {}) {
  if (!points || points.length < 2) return `<div class="portfolio-chart-empty">No data yet</div>`;
  const width = 560;
  const values = points.map((p) => p[1]);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pad = 10;
  const usable = height - pad * 2;
  const step = width / (points.length - 1);
  const yFor = (v) => pad + (1 - (v - min) / span) * usable;
  const coords = points.map((p, i) => `${(i * step).toFixed(1)},${yFor(p[1]).toFixed(1)}`);
  const area = `0,${height} ${coords.join(" ")} ${width},${height}`;
  const gridCount = 4;
  const gridLines = Array.from({ length: gridCount + 1 }, (_, i) => {
    const y = (pad + (usable * i) / gridCount).toFixed(1);
    return `<line class="portfolio-grid-line" x1="0" y1="${y}" x2="${width}" y2="${y}"/>`;
  }).join("");
  const scrubAttr = chart ? ` data-portfolio-chart="${chart}"` : "";
  const intraday = (points[points.length - 1][0] - points[0][0]) <= 2 * 86_400_000;
  const labelCount = 4;
  const xLabels = Array.from({ length: labelCount }, (_, i) => {
    const idx = Math.round((i / (labelCount - 1)) * (points.length - 1));
    const ts = points[idx][0];
    const text = intraday
      ? new Date(ts).toLocaleTimeString(undefined, { hour: "numeric" })
      : new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    return `<span>${text}</span>`;
  }).join("");
  // Value labels down the leading edge at the gridlines (iOS chartYAxis, four-ish ticks): three
  // significant digits, so a bitcoin-scale series does not round every tick to the same figure.
  // None with the eye on.
  const yLabels = hideValues ? "" : Array.from({ length: gridCount + 1 }, (_, i) => {
    const value = max - (span * i) / gridCount;
    const top = ((pad + (usable * i) / gridCount) / height) * 100;
    return `<span style="top:${top.toFixed(2)}%">${value.toLocaleString(undefined, { maximumSignificantDigits: 3 })}</span>`;
  }).join("");
  return `
    <div class="portfolio-bigchart">
      <div class="portfolio-chart-wrap portfolio-chart-wrap-big"${scrubAttr} style="height:${height}px">
        ${yLabels ? `<div class="portfolio-yaxis" aria-hidden="true">${yLabels}</div>` : ""}
        <svg class="portfolio-chart" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">
          ${gridLines}
          <polygon class="portfolio-chart-area" points="${area}" fill="${stroke}"/>
          <polyline points="${coords.join(" ")}" fill="none" stroke="${stroke}" stroke-width="${lineWidth}" stroke-linejoin="round" stroke-linecap="round"/>
        </svg>
        ${chart ? `<div class="portfolio-scrub-line" hidden></div><div class="portfolio-scrub-dot" hidden style="background:${stroke}"></div>` : ""}
      </div>
      <div class="portfolio-xaxis">${xLabels}</div>
    </div>`;
}

function sparklineSvg(points, { height = 130, width = 560, stroke = "var(--kaspa)", chart = null, lineWidth = 2 } = {}) {
  if (!points || points.length < 2) return `<div class="portfolio-chart-empty">No data yet</div>`;
  const values = points.map((p) => p[1]);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const step = width / (points.length - 1);
  const coords = points.map((p, i) => {
    const x = (i * step).toFixed(1);
    const y = (height - 8 - ((p[1] - min) / span) * (height - 16)).toFixed(1);
    return `${x},${y}`;
  });
  const scrubAttr = chart ? ` data-portfolio-chart="${chart}"` : "";
  return `
    <div class="portfolio-chart-wrap"${scrubAttr} style="height:${height}px">
      <svg class="portfolio-chart" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">
        <polyline points="${coords.join(" ")}" fill="none" stroke="${stroke}" stroke-width="${lineWidth}" stroke-linejoin="round" stroke-linecap="round"/>
      </svg>
      ${chart ? `<div class="portfolio-scrub-line" hidden></div><div class="portfolio-scrub-dot" hidden style="background:${stroke}"></div>` : ""}
    </div>`;
}

/** Hover-to-scrub, matching iOS SparklineChart's drag crosshair: a vertical line + dot track
 *  the pointer, and the associated readout labels update live. Direct DOM updates only — no
 *  re-render per pointer event. */
function attachScrub(wrap, points, onScrub, onEnd, onSpan = null) {
  if (!wrap || !points || points.length < 2) return;
  const line = wrap.querySelector(".portfolio-scrub-line");
  const dot = wrap.querySelector(".portfolio-scrub-dot");
  const fractions = chartGeometry(points, wrap.clientHeight || 130);
  // A span (the stretch shaded green or red, both ends marked, the header reading the dates and
  // the return across it): with a mouse, press and drag along the line, and it stays until the
  // pointer leaves the chart. On a touch screen it is two fingers, the span between them, as on
  // iOS; one finger only ever scrubs, and lifting every finger ends the readout.
  let span = null;
  if (onSpan) {
    span = document.createElement("div");
    span.className = "portfolio-scrub-span";
    span.hidden = true;
    wrap.append(span);
  }
  let anchor = null;   // index where the press began
  let frozen = false;  // the button came up: keep the span until the pointer leaves

  const touches = new Map(); // pointerId -> clientX of each finger on the chart
  const indexAt = (event) => {
    const rect = wrap.getBoundingClientRect();
    const x = Math.min(Math.max(event.clientX - rect.left, 0), rect.width);
    const index = Math.round((x / (rect.width || 1)) * (points.length - 1));
    return { rect, clamped: Math.min(Math.max(index, 0), points.length - 1) };
  };
  const showSpan = (a, b, rect) => {
    if (!span) return;
    const from = Math.min(a, b), to = Math.max(a, b);
    const left = (from / (points.length - 1)) * rect.width;
    const right = (to / (points.length - 1)) * rect.width;
    const gain = points[to][1] >= points[from][1];
    span.hidden = false;
    span.style.left = `${left}px`;
    span.style.width = `${Math.max(2, right - left)}px`;
    span.classList.toggle("loss", !gain);
    if (line) line.hidden = true;
    if (dot) { dot.hidden = false; dot.style.left = `${right}px`; dot.style.top = `${fractions[to] * rect.height}px`; }
    onSpan(points[from], points[to]);
  };
  // Two fingers down: the span between them (the first two, whichever lifted last stays).
  const touchSpan = () => {
    const [x1, x2] = [...touches.values()];
    const a = indexAt({ clientX: x1 });
    const b = indexAt({ clientX: x2 });
    if (onSpan && a.clamped !== b.clamped) { showSpan(a.clamped, b.clamped, a.rect); return true; }
    return false;
  };
  const move = (event) => {
    if (event.pointerType === "touch") {
      if (!touches.has(event.pointerId)) return;
      touches.set(event.pointerId, event.clientX);
      if (touches.size >= 2 && touchSpan()) return;
      if (touches.size >= 2) event = { clientX: [...touches.values()][0] };
      // One finger: plain scrubbing, never a span.
      const { rect, clamped } = indexAt(event);
      const px = (clamped / (points.length - 1)) * rect.width;
      const py = fractions[clamped] * rect.height;
      if (span) span.hidden = true;
      if (line) { line.hidden = false; line.style.left = `${px}px`; }
      if (dot) { dot.hidden = false; dot.style.left = `${px}px`; dot.style.top = `${py}px`; }
      onScrub(points[clamped]);
      return;
    }
    if (frozen) return;
    const { rect, clamped } = indexAt(event);
    if (anchor != null && onSpan && (event.buttons & 1) && clamped !== anchor) { showSpan(anchor, clamped, rect); return; }
    const px = (clamped / (points.length - 1)) * rect.width;
    const py = fractions[clamped] * rect.height;
    if (span) span.hidden = true;
    if (line) { line.hidden = false; line.style.left = `${px}px`; }
    if (dot) { dot.hidden = false; dot.style.left = `${px}px`; dot.style.top = `${py}px`; }
    onScrub(points[clamped]);
  };
  const down = (event) => {
    if (event.pointerType === "touch") {
      touches.set(event.pointerId, event.clientX);
      move(event);
      return;
    }
    frozen = false;
    anchor = indexAt(event).clamped;
    move(event);
  };
  const up = (event) => {
    if (event?.pointerType === "touch") {
      touches.delete(event.pointerId);
      // A finger lifted off a two-finger span: back to scrubbing under the one left.
      if (touches.size) { const [[id, x]] = [...touches]; move({ pointerType: "touch", pointerId: id, clientX: x }); }
      else leave();
      return;
    }
    if (span && !span.hidden) frozen = true;
    anchor = null;
  };
  const leave = (event) => {
    // A finger's pointerleave follows its own pointerup (handled there); one still down keeps going.
    if (event?.pointerType === "touch") return;
    touches.clear();
    frozen = false;
    anchor = null;
    if (span) span.hidden = true;
    if (line) line.hidden = true;
    if (dot) dot.hidden = true;
    onEnd();
  };
  wrap.addEventListener("pointermove", move);
  wrap.addEventListener("pointerdown", down);
  wrap.addEventListener("pointerup", up);
  wrap.addEventListener("pointercancel", up);
  wrap.addEventListener("pointerleave", leave);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function pickerCard(portfolio) {
  const isActive = portfolio.id === state.activeId;
  const summary = computeSummary(portfolio.transactions || [], price?.price || 0);
  const change = computeTodayChange(computeValueHistory(portfolio.transactions || [], sevenDayHistory));
  const positive = (change?.amount ?? 0) >= 0;
  return `
    <div class="portfolio-card${isActive ? " active" : ""}" data-portfolio-select="${portfolio.id}" role="button" tabindex="0">
      <div class="portfolio-card-top">
        <span class="portfolio-card-name">${deps.escapeHtml(portfolio.name)}</span>
        <button class="portfolio-card-menu-btn" type="button" data-portfolio-card-menu="${portfolio.id}" aria-label="Edit ${deps.escapeHtml(portfolio.name)}" title="Edit ${deps.escapeHtml(portfolio.name)}"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg></button>
      </div>
      <div class="portfolio-card-value">${price ? fmtFiat(summary.currentValue) : "--"}</div>
      ${change
        ? `<div class="portfolio-card-change ${positive ? "gain" : "loss"}">${positive ? "↑" : "↓"} ${Math.abs(change.percent).toFixed(2)}%</div>`
        : `<div class="portfolio-card-change muted">--</div>`}

    </div>`;
}

function summaryCardHtml(summary) {
  const change = price?.change24h ?? null;
  const positive = (change ?? 0) >= 0;
  return `
    <div class="profile-card portfolio-summary">
      <div class="portfolio-summary-head">
        <div>
          <p class="profile-card-label" data-portfolio-price-label>KAS Price</p>
          <div class="portfolio-summary-price" data-portfolio-price-value>${price ? fmtPrice(price.price) : "--"}</div>
        </div>
        ${change !== null ? `
          <div class="portfolio-summary-24h ${positive ? "gain" : "loss"}" data-portfolio-price-24h>
            ${positive ? "↑" : "↓"} ${Math.abs(change).toFixed(2)}%<span class="muted"> 24h</span>
          </div>` : ""}
      </div>
      <div class="portfolio-summary-grid">
        <div class="portfolio-stat">
          <span class="portfolio-stat-label">Holdings</span>
          <span class="portfolio-stat-value">${fmtKas(summary.holdingsKas)}</span>
        </div>
        <div class="portfolio-stat right">
          <span class="portfolio-stat-label">Current Value</span>
          <span class="portfolio-stat-value">${fmtFiat(summary.currentValue)}</span>
        </div>
      </div>
      <div class="portfolio-summary-divider"></div>
      <div class="portfolio-summary-grid">
        <div class="portfolio-stat">
          <span class="portfolio-stat-label">Total Invested</span>
          <span class="portfolio-stat-value">${fmtFiat(summary.totalInvested)}</span>
        </div>
        <div class="portfolio-stat right">
          <span class="portfolio-stat-label">Total P&amp;L</span>
          <span class="portfolio-stat-value ${summary.totalPL >= 0 ? "gain" : "loss"}">
            ${summary.totalPL >= 0 ? "↗" : "↘"} ${fmtFiat(summary.totalPL)} (${summary.totalPLPercent.toFixed(1)}%)
          </span>
        </div>
      </div>
      ${summary.averageBuyPriceUsd !== null ? `
        <div class="portfolio-summary-divider"></div>
        <div class="portfolio-summary-grid">
          <div class="portfolio-stat">
            <span class="portfolio-stat-label">Avg. Buy Price</span>
            <span class="portfolio-stat-value">${fmtPrice(summary.averageBuyPriceUsd)}</span>
          </div>
        </div>` : ""}
    </div>`;
}

/** "buy" | "sell" | "transfer" - anything unrecognised reads as a buy, as it always has. */
function txKind(tx) {
  return tx?.type === "sell" || tx?.type === "transfer" ? tx.type : "buy";
}
// Icon, colour class and title per type (iOS icon/color/title(for:)): a transfer is a two-way
// arrow in the accent colour.
const TX_KIND_ICON = { buy: "↓", sell: "↑", transfer: "⇄" };
const TX_KIND_TITLE = { buy: "Buy", sell: "Sell", transfer: "Transfer" };

/** `preview`: the row as the move sheet shows it - no click target, no delete, no selection. */
function transactionRowHtml(tx, { preview = false } = {}) {
  const kind = txKind(tx);
  const needsPrice = isPricePending(tx.notes);
  const selectingRow = selecting && !preview;
  const picked = selectingRow && selectedTxIds.has(tx.id);
  // In select mode the row toggles instead of opening the editor, and the row-level delete goes
  // away: two ways to delete on one row, one of them ignoring the selection, is a trap.
  const attr = preview ? "" : selecting ? `data-portfolio-tx-select="${tx.id}"` : `data-portfolio-tx-edit="${tx.id}"`;
  return `
    <div class="portfolio-tx-row${selectingRow ? " selecting" : ""}${picked ? " picked" : ""}" ${attr} ${preview ? "" : `role="button" tabindex="0"`} ${selectingRow ? `aria-pressed="${picked}"` : ""}>
      ${selectingRow ? `<span class="portfolio-tx-check${picked ? " on" : ""}" aria-hidden="true">${picked ? "✓" : ""}</span>` : ""}
      <span class="portfolio-tx-icon ${kind}">${TX_KIND_ICON[kind]}</span>
      <div class="portfolio-tx-main">
        <span class="portfolio-tx-type ${kind}">${TX_KIND_TITLE[kind]}${needsPrice ? ' <span class="portfolio-tx-warn" title="Price still loading, tap to set manually" aria-label="Price still loading, tap to set manually">⚠</span>' : ""}</span>
        <span class="portfolio-tx-date">${fmtDate(tx.timestamp)}</span>
        ${tx.notes ? `<span class="portfolio-tx-notes">${deps.escapeHtml(tx.notes)}</span>` : ""}
      </div>
      <div class="portfolio-tx-amounts">
        <span class="portfolio-tx-amount">${fmtKas(tx.amountKas)}</span>
        <span class="portfolio-tx-fiat">${fmtFiat(tx.fiatValue || 0)}</span>
      </div>
      ${selecting || preview ? "" : `<button class="portfolio-tx-delete" type="button" data-portfolio-tx-delete="${tx.id}" aria-label="Delete transaction">×</button>`}
    </div>`;
}

// Two tappable squares (KAS price | portfolio value) that open the full-screen chart screens.
function todayChange(transactions) {
  const series = computeValueHistory(transactions, sevenDayHistory);
  if (!series.length) return null;
  const [latestTs, latestValue] = series[series.length - 1];
  const dayAgo = latestTs - 86_400_000;
  let base = null;
  for (let i = series.length - 1; i >= 0; i -= 1) { if (series[i][0] <= dayAgo) { base = series[i]; break; } }
  if (!base) return null;
  const amount = latestValue - base[1];
  return { amount, percent: base[1] === 0 ? 0 : (amount / base[1]) * 100 };
}

function squaresHtml(summary) {
  const change = price?.change24h ?? null;
  const pPos = (change ?? 0) >= 0;
  // The last 24 hours, not all-time P&L: a number that only grows over the life of the
  // portfolio says nothing about today, and it sat next to the Kaspa card's 24h figure.
  const today = todayChange(activePortfolio().transactions || []);
  const plPos = (today?.amount ?? 0) >= 0;
  return `
    <div class="portfolio-squares">
      <button class="portfolio-square" type="button" data-portfolio-open="price">
        <div class="portfolio-square-head">
          <img src="${kaspaLogoUrl}" alt="" class="portfolio-square-logo"/>
          <span class="portfolio-square-title">Kaspa</span>
          <span class="portfolio-square-chev">›</span>
        </div>
        <div class="portfolio-square-value">${price ? fmtPrice(price.price) : "--"}</div>
        ${change !== null ? `<div class="portfolio-square-change ${pPos ? "gain" : "loss"}">${pPos ? "↑" : "↓"} ${Math.abs(change).toFixed(2)}%</div>` : `<div class="portfolio-square-change muted">--</div>`}
      </button>
      <button class="portfolio-square" type="button" data-portfolio-open="value">
        <div class="portfolio-square-head">
          <svg class="portfolio-square-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 17 9 11 13 15 21 7"/><polyline points="16 7 21 7 21 12"/></svg>
          <span class="portfolio-square-title">Value</span>
          <span class="portfolio-square-chev">›</span>
        </div>
        <div class="portfolio-square-value">${fmtFiat(summary.currentValue)}</div>
        ${today
          ? `<div class="portfolio-square-change ${plPos ? "gain" : "loss"}">${plPos ? "↑" : "↓"} ${Math.abs(today.percent).toFixed(2)}%</div>`
          : `<div class="portfolio-square-change muted">24h change not available yet</div>`}
      </button>
    </div>`;
}

/// The card settings overlay: rename, reorder and delete all happen HERE rather than each opening
/// its own thing (iOS `PressedPortfolio`).
///
/// It replaces a dropdown that lived INSIDE the card, which the card then clipped - the menu came
/// out looking broken because half of it was behind the card's own edge. An overlay has no such
/// box to escape from. Rename is a step of it too, rather than a `window.prompt`: a browser dialog
/// looks like the website is asking, not the app.
function renderCardModal() {
  const body = modalsEl?.querySelector("[data-portfolio-card-body]");
  const portfolio = state.portfolios.find((p) => p.id === cardModalId);
  if (!body || !portfolio) return;
  const hasOthers = state.portfolios.length > 1;
  const head = (title) => `
    <div class="modal-header">
      <div><h2>${deps.escapeHtml(title)}</h2></div>
      <button class="modal-close" type="button" data-portfolio-card-close aria-label="Close">×</button>
    </div>`;

  if (cardModalMode === "rename") {
    // iOS PortfolioActionsSheet .rename: "Rename", a Portfolio Name field, Save off while blank.
    body.innerHTML = `
      ${head("Rename")}
      <div class="portfolio-editor-body">
        <input class="field-input" type="text" maxlength="40" placeholder="Portfolio Name" aria-label="Portfolio Name" data-portfolio-card-name value="${deps.escapeHtml(portfolio.name)}" />
        <p class="field-hint">Only the name changes. Transactions stay where they are.</p>
      </div>
      <div class="modal-actions">
        <button class="secondary-button" type="button" data-portfolio-card-back>Back</button>
        <button class="primary-button" type="button" data-portfolio-card-rename-save ${portfolio.name.trim() ? "" : "disabled"}>Save</button>
      </div>`;
    body.querySelector("[data-portfolio-card-name]")?.focus();
    return;
  }

  if (cardModalMode === "delete") {
    // iOS .confirmDelete: "Delete Portfolio", one destructive "Delete 'Name'", the footer below.
    body.innerHTML = `
      ${head("Delete Portfolio")}
      <div class="cold-action-rows">
        <button type="button" class="cold-action-row cold-action-row-danger" data-portfolio-card-delete-confirm>
          <span class="cold-action-copy"><strong>Delete '${deps.escapeHtml(portfolio.name)}'</strong></span>
        </button>
      </div>
      <p class="field-hint">'${deps.escapeHtml(portfolio.name)}' and its transactions will be deleted. This can't be undone.</p>
      <div class="modal-actions">
        <button class="secondary-button" type="button" data-portfolio-card-back>Back</button>
      </div>`;
    return;
  }

  body.innerHTML = `
    ${head(portfolio.name)}
    <div class="cold-action-rows">
      <button type="button" class="cold-action-row" data-portfolio-card-mode="rename">
        <span class="cold-action-copy"><strong>Rename</strong></span>
      </button>
      ${hasOthers ? `
      <button type="button" class="cold-action-row" data-portfolio-card-mode="reorder">
        <span class="cold-action-copy"><strong>Reorder Portfolios</strong></span>
      </button>
      <button type="button" class="cold-action-row cold-action-row-danger" data-portfolio-card-mode="delete">
        <span class="cold-action-copy"><strong>Delete '${deps.escapeHtml(portfolio.name)}'</strong></span>
      </button>` : ""}
    </div>
    ${hasOthers ? "" : `<p class="field-hint">This is your only portfolio, so it can't be deleted or reordered.</p>`}`;
}

/// Hold a transaction (or right-click it): move it to another portfolio (iOS b438f2d). The row
/// itself sits on top, on a frosted card, so it's clear what is moving; a portfolio that already
/// holds the same on-chain transaction is offered but disabled, since moving it there would
/// count it twice. The record moves as-is - same id, same source - so a later "Add to Portfolio"
/// of the same transaction still recognises it wherever it now lives.
let movingTxId = null;
function openMoveSheet(txId) {
  const tx = (activePortfolio().transactions || []).find((t) => t.id === txId);
  if (!tx || !modalsEl) return;
  movingTxId = txId;
  renderMoveSheet();
  modalsEl.querySelector("[data-portfolio-move-modal]").hidden = false;
}

function closeMoveSheet() {
  movingTxId = null;
  const modal = modalsEl?.querySelector("[data-portfolio-move-modal]");
  if (modal) modal.hidden = true;
}

function renderMoveSheet() {
  const body = modalsEl?.querySelector("[data-portfolio-move-body]");
  const source = activePortfolio();
  const tx = (source.transactions || []).find((t) => t.id === movingTxId);
  if (!body || !tx) return;
  const others = state.portfolios.filter((p) => p.id !== source.id);
  const alreadyHolding = portfolioIdsContainingTx(tx.sourceTxId || "");
  body.innerHTML = `
    <div class="modal-header">
      <div><p class="modal-kicker">Portfolio</p><h2>Move to Portfolio</h2></div>
      <button class="modal-close" type="button" data-portfolio-move-close aria-label="Close">×</button>
    </div>
    <div class="portfolio-move-card">${transactionRowHtml(tx, { preview: true })}</div>
    ${others.length === 0
      ? `<p class="field-hint portfolio-move-empty">Create another portfolio first, then you can move transactions into it.</p>`
      : `<div class="cold-action-rows">
          ${others.map((p) => {
            const duplicate = alreadyHolding.has(p.id);
            return `
              <button type="button" class="cold-action-row" data-portfolio-move-to="${p.id}" ${duplicate ? "disabled" : ""}>
                <span class="cold-action-copy"><strong>${deps.escapeHtml(p.name)}</strong><small>${duplicate ? "Already has this transaction." : "Move this transaction here."}</small></span>
              </button>`;
          }).join("")}
        </div>`}`;
}

function moveTransaction(txId, destinationId) {
  const source = activePortfolio();
  const destination = state.portfolios.find((p) => p.id === destinationId);
  const index = (source.transactions || []).findIndex((t) => t.id === txId);
  if (!destination || destination.id === source.id || index < 0) return;
  const [tx] = source.transactions.splice(index, 1);
  (destination.transactions ||= []).push(tx);
  selectedTxIds.delete(txId);
  saveState();
  closeMoveSheet();
  render();
  deps.showToast?.(`Moved to ${destination.name}.`);
}

/// An in-app confirm. Every native `window.confirm` reads as "localhost says", which is the
/// BROWSER asking rather than the app - and on a page people are trusting with money that is
/// exactly the wrong voice. Resolves true when the destructive button is pressed.
let confirmResolve = null;
function confirmOverlay({ title, message, confirmLabel = "Delete", destructive = true }) {
  return new Promise((resolve) => {
    const body = modalsEl?.querySelector("[data-portfolio-confirm-body]");
    if (!body) { resolve(false); return; }
    confirmResolve = resolve;
    body.innerHTML = `
      <div class="modal-header">
        <div><p class="modal-kicker">Portfolio</p><h2>${deps.escapeHtml(title)}</h2></div>
        <button class="modal-close" type="button" data-portfolio-confirm-cancel aria-label="Close">×</button>
      </div>
      <p class="field-hint">${deps.escapeHtml(message)}</p>
      <div class="modal-actions">
        <button class="secondary-button" type="button" data-portfolio-confirm-cancel>Cancel</button>
        <button class="primary-button${destructive ? " danger" : ""}" type="button" data-portfolio-confirm-ok>${deps.escapeHtml(confirmLabel)}</button>
      </div>`;
    modalsEl.querySelector("[data-portfolio-confirm-modal]").hidden = false;
  });
}

function settleConfirm(result) {
  const modal = modalsEl?.querySelector("[data-portfolio-confirm-modal]");
  if (modal) modal.hidden = true;
  const resolve = confirmResolve;
  confirmResolve = null;
  resolve?.(result);
}

/// Naming a new portfolio, in the app rather than in a browser prompt.
let namePromptResolve = null;
/// iOS portfolioNameSheet: one "Portfolio Name" field, and the confirm button stays off while it
/// is blank.
function namePromptOverlay({ title, placeholder = "Portfolio Name", initial = "", confirmLabel = "Create" }) {
  return new Promise((resolve) => {
    const body = modalsEl?.querySelector("[data-portfolio-name-body]");
    if (!body) { resolve(null); return; }
    namePromptResolve = resolve;
    body.innerHTML = `
      <div class="modal-header">
        <div><h2>${deps.escapeHtml(title)}</h2></div>
        <button class="modal-close" type="button" data-portfolio-name-cancel aria-label="Close">×</button>
      </div>
      <div class="portfolio-editor-body">
        <input class="field-input" type="text" maxlength="40" placeholder="${deps.escapeHtml(placeholder)}" aria-label="${deps.escapeHtml(placeholder)}" data-portfolio-name-input data-portfolio-name-required value="${deps.escapeHtml(initial)}" />
      </div>
      <div class="modal-actions">
        <button class="secondary-button" type="button" data-portfolio-name-cancel>Cancel</button>
        <button class="primary-button" type="button" data-portfolio-name-ok ${String(initial).trim() ? "" : "disabled"}>${deps.escapeHtml(confirmLabel)}</button>
      </div>`;
    modalsEl.querySelector("[data-portfolio-name-modal]").hidden = false;
    const input = body.querySelector("[data-portfolio-name-input]");
    input?.focus();
    input?.select();
  });
}

function settleNamePrompt(value) {
  const modal = modalsEl?.querySelector("[data-portfolio-name-modal]");
  if (modal) modal.hidden = true;
  const resolve = namePromptResolve;
  namePromptResolve = null;
  resolve?.(value);
}

/** The wallet's own chatting address, when one is loaded. */
function chattingAddress() {
  const address = String(deps?.engine?.address || "").trim();
  return address.startsWith(ADDRESS_PREFIX) ? address : null;
}

/// `presetAddress` is "Add Chatting Address": no field to fill - the import of that address
/// starts as the sheet opens, and the sheet shows only its progress (iOS 61eff0f).
function openAddressImport(presetAddress = null) {
  addressImport = {
    busy: false, progress: "", input: "",
    resolving: false, resolvedAddress: null, resolvedDomain: null, notFound: false,
    preset: presetAddress || null,
  };
  knsResolveSeq += 1; // abandon any lookup left over from a previous open
  modalsEl.querySelector("[data-portfolio-import-address]").value = "";
  const preset = Boolean(presetAddress);
  const title = modalsEl.querySelector("[data-portfolio-import-title]");
  if (title) title.textContent = preset ? "Add Chatting Address" : "Add Kaspa Address";
  modalsEl.querySelectorAll("[data-portfolio-import-manual]").forEach((el) => { el.hidden = preset; });
  setImportProgress("");
  syncImportModal();
  modalsEl.querySelector("[data-portfolio-import-modal]").hidden = false;
  if (preset) runAddressImport(presetAddress);
}

/// The two header buttons open overlays rather than dropdowns.
///
/// Add offers both ways of getting a transaction in - typing one, or importing an address's whole
/// history - because those are the same intent and hiding one of them under Import/Export meant
/// looking for it in the wrong place. Import/Export is then exactly what its name says.
function renderPortfolioActionSheet() {
  const body = modalsEl?.querySelector("[data-portfolio-action-body]");
  if (!body) return;
  const rows = actionSheetMode === "add"
    ? [
        { action: "tx", title: "Add Transaction", subtitle: "Record a buy or a sell by hand." },
        { action: "address", title: "Add Kaspa Address", subtitle: "Track an address's balance as part of this portfolio." },
        // One click for the address KaChat itself spends from: its buys and sells, and every
        // network fee it paid (messages, handshakes, payments) for the Fees Spent card.
        ...(chattingAddress() ? [
          { action: "chatting", title: "Add Chatting Address", subtitle: "Your chatting address's buys and sells, and every network fee it has paid." },
        ] : []),
      ]
    : [
        { action: "import", title: "Import CSV", subtitle: "Read transactions in from a file." },
        { action: "export", title: "Export CSV", subtitle: "Write this portfolio's transactions out to a file." },
        // With a Nextcloud account connected (iOS aa5d783).
        ...(isNextcloudConnected() ? [
          { action: "nc-import", title: "Import from Nextcloud", subtitle: "Pick a CSV file from your Nextcloud." },
          { action: "nc-export", title: "Export to Nextcloud", subtitle: "Save the CSV to the KaChat folder in your Nextcloud." },
        ] : []),
      ];
  body.innerHTML = `
    <div class="modal-header">
      <div><h2>${actionSheetMode === "add" ? "Add to Portfolio" : "Import or Export"}</h2></div>
      <button class="modal-close" type="button" data-portfolio-action-close aria-label="Close">×</button>
    </div>
    <div class="cold-action-rows">
      ${rows.map((row) => `
        <button type="button" class="cold-action-row" data-portfolio-action="${row.action}">
          <span class="cold-action-copy"><strong>${row.title}</strong><small>${row.subtitle}</small></span>
        </button>`).join("")}
    </div>`;
}

/// What was typed, in H/s, using the unit the picker has selected.
function typedHashrateHs() {
  const amount = decimalInputValue(hashrateInput);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return amount * (HASHRATE_UNITS.find((u) => u.key === hashrateUnit)?.scale ?? 1e12);
}

/// One payout period: what it pays in KAS, with the fiat value beneath it (iOS `payoutRow`).
///
/// Stacked rather than side by side because the two numbers answer the same question in two
/// currencies - putting them in separate columns invites reading them as separate figures.
function payoutRowHtml(label, kas) {
  // Never masked: an estimate of the network's payout, not your holdings (iOS payoutRow).
  const fiat = price && price.price > 0 ? currencyText(kas * price.price) : "";
  return `
    <div class="portfolio-payout-row">
      <span class="portfolio-payout-label">${label}</span>
      <span class="portfolio-payout-values">
        <span class="portfolio-payout-kas">${kasPlain(kas)}</span>
        ${fiat ? `<span class="portfolio-payout-fiat">${fiat}</span>` : ""}
      </span>
    </div>`;
}

/// Day, week and month, from the one daily figure (iOS's three `payoutRow` calls).
///
/// A day is the unit the arithmetic produces, but nobody buys a rig to earn a day's worth. The
/// week and month are the horizons people actually compare against an electricity bill, and
/// making the reader do the multiplication is the kind of small friction that stops them looking.
function payoutBlockHtml(daily) {
  if (daily === null) {
    return `<p class="field-hint">Enter your hashrate to estimate earnings.</p>`;
  }
  const stats = peekNetworkStats();
  // 30 days, not a calendar month: the reward steps down monthly anyway, so precision past
  // "about a month" would be false. iOS makes the same call for the same reason.
  return `
    <div class="portfolio-payout-rows">
      ${payoutRowHtml("Per day", daily)}
      ${payoutRowHtml("Per week", daily * 7)}
      ${payoutRowHtml("Per month", daily * 30)}
    </div>
    ${stats?.blockRewardKas ? `<p class="field-hint">At ${formatHashrate(stats.currentHashrate)} network hashrate and a ${stats.blockRewardKas.toFixed(4)} ${KAS_UNIT} block reward. Before pool fees, power and luck, and both figures move.</p>` : ""}`;
}

/// One stat: label on the left, value on the right, with a divider between rows (iOS `statRow`).
/// A two-column grid squeezed four figures into two lines and left the reader matching labels to
/// values by position.
function statRowHtml(label, value, valueClass = "") {
  return `
    <div class="portfolio-stat-row">
      <span class="portfolio-stat-label">${label}</span>
      <span class="portfolio-stat-value ${valueClass}">${value}</span>
    </div>`;
}

/// The change over the SELECTED range, not always 24h (iOS `priceRangeChange`): the badge beside
/// the price has to answer the question the chart under it is asking. A 1Y chart with a 24h badge
/// invites reading the year's move as a day's.
/** Reads a number the way a person pasted or typed it (iOS 266131a): "1,234.56" (grouping
 *  commas), "1.234,56" or "1,5" (decimal-comma locales), "$ 9.60", " 12 ". Null when empty. */
export function parsePortfolioNumber(text) {
  let cleaned = String(text ?? "").replace(/[^0-9,.\-]/g, "");
  if (!cleaned) return null;
  const commas = (cleaned.match(/,/g) || []).length;
  const dots = (cleaned.match(/\./g) || []).length;
  if (commas > 0 && dots > 0) {
    // Both present: whichever comes last is the decimal mark, the other is grouping.
    if (cleaned.lastIndexOf(",") > cleaned.lastIndexOf(".")) cleaned = cleaned.replace(/\./g, "").replace(",", ".");
    else cleaned = cleaned.replace(/,/g, "");
  } else if (commas > 0) {
    // One comma followed by anything but exactly three digits is a decimal comma ("1,5").
    const parts = cleaned.split(",");
    // "0,123" and "1,5" are decimals; so is any lone comma for a decimal-comma locale. Only
    // "1,234" from a decimal-point locale reads as grouping.
    const decimalComma = parts[1].length !== 3 || DECIMAL_SEPARATORS.decimal === "," || /^-?0*$/.test(parts[0]);
    if (commas === 1 && parts.length === 2 && decimalComma) cleaned = cleaned.replace(",", ".");
    else cleaned = cleaned.replace(/,/g, "");
  } else if (dots > 1) {
    cleaned = cleaned.replace(/\./g, ""); // "1.234.567" - dots as grouping
  }
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

function rangeChange(series) {
  if (!series || series.length < 2) return null;
  const first = series[0][1];
  const last = series[series.length - 1][1];
  if (!Number.isFinite(first) || !Number.isFinite(last)) return null;
  const amount = last - first;
  return { amount, percent: first === 0 ? 0 : (amount / first) * 100 };
}

/// How the selected range is named beside that figure (iOS `priceRangeLabel`).
function rangeLabel() {
  if (rangeDays === 1) return "24h";
  return ranges().find((r) => r.days === rangeDays)?.label || `${rangeDays}d`;
}
/** KAS in the pair for the current base: bitcoin from CoinGecko's own series, VOO / gold /
 *  silver by dividing KAS by the pair's price at each point (Yahoo, in dollars). */
let pairLoadToken = 0;
async function loadPairSeries() {
  const unit = pairUnit();
  if (!unit) return;
  const base = baseDaysFor(rangeDays);
  const pair = unit.kind === "currency" ? `currency:${unit.code}` : unit.pair;
  if (pairSeries?.pair === pair && pairSeries.baseDays === base) return;
  // A newer request (range or pair changed while this one was in flight) wins.
  const token = ++pairLoadToken;
  pairLoading = true;
  try {
    let kas = [];
    let latest = null;
    if (unit.kind === "currency") {
      // Bitcoin from CoinGecko's own series - or dollars, when the app counts in bitcoin.
      kas = await fetchKasPriceHistory(base, { currency: unit.code });
      latest = kas.length ? kas[kas.length - 1][1] : null;
    } else {
      // Yahoo quotes the pair in dollars, so KAS is taken in dollars too (iOS PortfolioViewModel).
      const [pairResult, kasBase] = await Promise.all([fetchMarketPairHistory(unit.pair, base), fetchKasPriceHistory(base, { currency: "usd" })]);
      kas = dividePoints(kasBase, pairResult.points);
      const kasUsd = kasBase.length ? kasBase[kasBase.length - 1][1] : null;
      latest = pairResult.latest && kasUsd > 0 ? kasUsd / pairResult.latest : (kas.length ? kas[kas.length - 1][1] : null);
    }
    if (token !== pairLoadToken) return;
    pairSeries = { pair, baseDays: base, kas, latest };
  } catch { if (token === pairLoadToken) pairSeries = null; }
  finally { if (token === pairLoadToken) pairLoading = false; }
}
function pairHistory() {
  if (!pairActive || !pairSeries?.kas?.length) return null;
  const unit = pairUnit();
  const pair = unit?.kind === "currency" ? `currency:${unit.code}` : unit?.pair;
  if (!unit || pairSeries.pair !== pair || pairSeries.baseDays !== baseDaysFor(rangeDays)) return null;
  return rangeDays === 0 ? pairSeries.kas : cutPoints(pairSeries.kas, rangeDays);
}
/// What a flip shows (iOS PortfolioViewModel.alternateUnit): the pair picked under the gear -
/// bitcoin, or US dollars when the app already counts in bitcoin - VOO, gold or silver.
function pairUnit() {
  if (!chartPair) return null;
  if (chartPair === "bitcoin") return { kind: "currency", code: currencyCode() === "btc" ? "usd" : "btc" };
  return { kind: "pair", pair: chartPair };
}
/** The code the chart counts in (iOS ChartUnit.code), for the chip beside the big number. */
function chartUnitCode() {
  const unit = pairActive ? pairUnit() : null;
  if (!unit) return currencyCode().toUpperCase();
  return unit.kind === "currency" ? unit.code.toUpperCase() : CHART_PAIRS[unit.pair].code;
}
/// iOS PortfolioFormat.price(_:unit:) / amount(_:unit:) for the flipped chart: a currency (bitcoin
/// in full) or shares / ounces with at least four decimals, more for a tiny figure.
function fmtPairAmount(value, { perKas = false } = {}) {
  if (amountsHidden && !perKas) return MASKED_AMOUNT;
  const unit = pairUnit();
  if (!unit) return perKas ? fmtPrice(value) : currencyText(value);
  if (unit.kind === "currency") return perKas ? fmtPrice(value, unit.code) : currencyText(value, unit.code);
  const v = Number(value) || 0;
  const magnitude = Math.abs(v);
  let decimals = 4;
  if (magnitude > 0 && magnitude < 0.001) decimals = Math.min(12, Math.max(4, Math.ceil(-Math.log10(magnitude)) + 3));
  const suffix = unit.pair === "voo" ? " VOO" : " oz";
  return `${v < 0 ? "-" : ""}${magnitude.toFixed(decimals)}${suffix}`;
}
function pairGearHtml() {
  return `<button class="kaposts-icon-button portfolio-pair-gear" type="button" data-portfolio-pair-gear aria-label="Chart settings" title="Chart settings"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg></button>`;
}
/// The gear: what a click on the big number flips to (iOS ChartPairSettingsSheet "Compare
/// Against") - bitcoin, VOO, gold or silver, one at a time; turning one on turns the others off,
/// and with none on the number is just a number.
function openPairPicker() {
  renderPairSheet();
  const modal = modalsEl?.querySelector("[data-portfolio-pair-modal]");
  if (modal) modal.hidden = false;
}

function renderPairSheet() {
  const body = modalsEl?.querySelector("[data-portfolio-pair-body]");
  if (!body) return;
  body.innerHTML = `
    <div class="modal-header">
      <div><h2>Compare Against</h2></div>
      <button class="modal-close" type="button" data-portfolio-pair-close aria-label="Close">×</button>
    </div>
    <p class="field-hint portfolio-pair-intro">Tap the price or your value to see it in the pair you pick here. One at a time.</p>
    <div class="portfolio-pair-rows">
      ${Object.entries(CHART_PAIRS).map(([id, pair]) => `
        <div class="settings-toggle-row portfolio-pair-row">
          <span><strong>${deps.escapeHtml(pair.title)}</strong><small>${deps.escapeHtml(pair.subtitle)}</small></span>
          <label class="switch-control"><input type="checkbox" data-portfolio-pair-toggle="${id}" ${chartPair === id ? "checked" : ""} aria-label="${deps.escapeHtml(pair.title)}"><span></span></label>
        </div>`).join("")}
    </div>`;
}

/// iOS PortfolioViewModel.setChartPair: a new pick drops the old pair's series, and the flip stays
/// on only while there is a pair to flip to.
function setChartPair(pair) {
  if (pair === chartPair) return;
  chartPair = pair;
  try { localStorage.setItem(CHART_PAIR_KEY, chartPair || ""); } catch { /* fine */ }
  pairSeries = null;
  if (!chartPair) pairActive = false;
  else if (pairActive) loadPairSeries().then(() => render()).catch(() => {});
  render();
}

/** The converter opens reading "1 KAS = …" with the fiat side filled (iOS recomputes on appear). */
function converterFiatOnOpen() {
  if (converterFiat) return converterFiat;
  const amount = decimalInputValue(converterKas);
  const rate = price?.price;
  if (!Number.isFinite(amount) || amount <= 0 || !(rate > 0)) return "";
  converterFiat = converterFormat(amount * rate);
  return converterFiat;
}

function rangeButtonsHtml() {
  return ranges().map((r) => `<button class="portfolio-range${r.days === rangeDays ? " active" : ""}" type="button" data-portfolio-range="${r.days}">${r.label}</button>`).join("");
}

/// Reordering, offered from a card's own menu the way iOS offers it - one screen where the order
/// is edited and committed, rather than dragging the cards themselves.
///
/// Dragging the cards in place would fight the tap that SELECTS a portfolio, which is the thing
/// people do with them constantly. Moving the job into a list makes both gestures unambiguous.
function renderReorderModal() {
  const body = modalsEl?.querySelector("[data-portfolio-reorder-body]");
  if (!body) return;
  body.innerHTML = `
    <div class="modal-header">
      <div><h2>Reorder</h2></div>
      <button class="modal-close" type="button" data-portfolio-reorder-close aria-label="Close">×</button>
    </div>
    <div class="portfolio-reorder-list">
      ${reorderDraft.map((p, i) => `
        <div class="portfolio-reorder-row">
          <span class="portfolio-reorder-name">${deps.escapeHtml(p.name)}</span>
          <span class="portfolio-reorder-value">${deps.escapeHtml(reorderValueText(p.id))}</span>
          <span class="portfolio-reorder-buttons">
            <button type="button" data-portfolio-move="up" data-index="${i}" ${i === 0 ? "disabled" : ""} aria-label="Move up">↑</button>
            <button type="button" data-portfolio-move="down" data-index="${i}" ${i === reorderDraft.length - 1 ? "disabled" : ""} aria-label="Move down">↓</button>
          </span>
        </div>`).join("")}
    </div>
    <p class="field-hint">Move a portfolio up or down to change the order its card appears in.</p>
    <div class="modal-actions">
      <button class="secondary-button" type="button" data-portfolio-reorder-close>Cancel</button>
      <button class="primary-button" type="button" data-portfolio-reorder-save>Done</button>
    </div>`;
}

/// What each row of the reorder list shows beside the name (iOS reorderList: the card's value).
function reorderValueText(id) {
  const portfolio = state.portfolios.find((p) => p.id === id);
  if (!portfolio || !price) return "--";
  return fmtFiat(computeSummary(portfolio.transactions || [], price.price || 0).currentValue);
}

/// Rank and market cap (iOS `marketStatsCard`), from the same keyless CoinGecko source the price
/// already comes from. Absent until the call lands, rather than showing a placeholder figure.
function marketStatsHtml() {
  const stats = peekKasMarketStats(deps.currencyCode?.().toLowerCase() || "usd");
  if (!stats) return "";
  return `
    <div class="profile-card portfolio-summary">
      ${stats.rank ? statRowHtml("Rank", `#${stats.rank}`) : ""}
      ${statRowHtml("Market Cap", fmtCompactFiat(stats.marketCap))}
    </div>`;
}

// A proper pickaxe (iOS 62288c2): a filled bowed head over a tapered handle, rotated to the
// diagonal like the old strokes were.
const PICKAXE_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true"><g transform="rotate(-40 12 12)"><path d="M1.2 9.6C6 1 18 1 22.8 9.6C18 6.6 6 6.6 1.2 9.6Z" fill="currentColor" stroke="none"/><path d="M10.5 5.4h3l-.4 16a1.1 1.1 0 0 1-2.2 0Z" fill="currentColor" stroke="none"/></g></svg>`;

/** The points the hashrate chart draws for the selected range; a short window with nothing in
 *  it would draw an empty chart, so it falls back to the whole series (iOS visiblePoints). */
function hashrateVisiblePoints(stats) {
  const all = stats?.history || [];
  const cutoff = hashrateRangeDays > 0 ? Date.now() - hashrateRangeDays * 86_400_000 : 0;
  const ranged = cutoff ? all.filter((pt) => pt[0] >= cutoff) : all;
  return ranged.length >= 2 ? ranged : all;
}

/// Network hashrate, full width under the two squares (iOS `hashrateCard`).
///
/// Full width rather than a third square: it is one series with a long history, and it reads far
/// better wide than squeezed into a third of a row. The sparkline says which way it is going
/// without anyone having to open it.
function hashrateCardHtml() {
  const stats = peekNetworkStats();
  const spark = stats && stats.history.length >= 2
    ? sparklineSvg(stats.history.slice(-90), { width: 96, height: 34 })
    : "";
  return `
    <button class="portfolio-hashrate-card" type="button" data-portfolio-open="hashrate">
      <span class="portfolio-hashrate-ico" aria-hidden="true">${PICKAXE_SVG}</span>
      <span class="portfolio-hashrate-copy">
        <span class="portfolio-hashrate-label">Network Hashrate</span>
        <span class="portfolio-hashrate-value">${stats ? formatHashrate(stats.currentHashrate) : "--"}</span>
      </span>
      ${spark}
      <span class="portfolio-square-chev">›</span>
    </button>`;
}

const CHECK_OUTLINE_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9.25"/><path d="m8 12.4 2.6 2.6L16 9.6"/></svg>`;
const CHECK_FILLED_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="currentColor" stroke="none"/><path d="m8 12.4 2.6 2.6L16 9.6" stroke="var(--on-accent, #000)"/></svg>`;
const TRASH_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13a1.5 1.5 0 0 0 1.5 1.4h7A1.5 1.5 0 0 0 17 20l1-13M9 7V5a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 15 5v2"/></svg>`;
const PLUS_FILLED_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="currentColor" stroke="none"/><path d="M12 7.5v9M7.5 12h9" stroke="var(--on-accent, #000)"/></svg>`;
const IMPORT_EXPORT_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="8" width="13" height="12.5" rx="2"/><path d="M8 4.5h10.5a2 2 0 0 1 2 2V17"/><path d="M10 11V3.5m0 0L7.5 6M10 3.5 12.5 6"/></svg>`;
const REALIZED_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z"/><path d="m9 12 2 2 4-4"/></svg>`;
const FUEL_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 22h12"/><path d="M4 9h10"/><path d="M14 22V4a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v18"/><path d="M14 13h2a2 2 0 0 1 2 2v2a2 2 0 0 0 4 0V9.83a2 2 0 0 0-.59-1.42L18 5"/></svg>`;

/** Fees are fractions of a KAS - up to eight places, so a month of messages doesn't read 0. */
function fmtFeeKas(value) {
  return `${(Number(value) || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 8 })} ${KAS_UNIT}`;
}

/// Two cards under Network Hashrate, for the active portfolio (iOS 61eff0f):
/// - Realized P&L <year>: this calendar year's sells against the cost of the KAS they sold,
///   oldest buys first (FIFO, computeRealizedPL). Masked with the eye.
/// - Fees Spent: network fees the portfolio's imported addresses paid, in KAS and in the app
///   currency at each day's price. Fed by Add Chatting Address (and Add Kaspa Address).
function insightCardsHtml(portfolio) {
  const pl = computeRealizedPL(portfolio.transactions || [], new Date().getFullYear());
  const notes = [];
  if (pl.sellCount === 0) {
    notes.push("No sells yet this year.");
  } else {
    notes.push(`Sells: ${pl.sellCount}. Oldest buys first (FIFO).`);
    if (pl.uncoveredKas > 0) {
      notes.push(`${amountsHidden ? MASKED_AMOUNT : fmtKas(pl.uncoveredKas)} sold with no buy on record, counted at zero cost.`);
    }
  }
  if (pl.pendingPriceCount > 0) notes.push("Some prices are still loading.");
  const plText = amountsHidden ? MASKED_AMOUNT : `${pl.amount > 0 ? "+" : ""}${fmtFiat(pl.amount)}`;
  const plClass = amountsHidden || pl.sellCount === 0 ? "" : (pl.amount >= 0 ? "gain" : "loss");

  const fee = computeFeeSummary(portfolio.id);
  const feeBody = fee.count === 0
    ? `<span class="portfolio-hashrate-value">--</span>
       <span class="portfolio-insight-note">Add your chatting address with + to count the network fees it has paid.</span>`
    : `<span class="portfolio-hashrate-value">${amountsHidden ? MASKED_AMOUNT : fmtFeeKas(fee.totalKas)}</span>
       <span class="portfolio-insight-sub">${fmtFiat(fee.totalFiat)}</span>
       <span class="portfolio-insight-note">${fee.unpricedCount > 0
         ? `Transactions: ${fee.count}. Some prices are still loading.`
         : `Transactions: ${fee.count}, at each day's price.`}</span>`;

  return `
    <div class="portfolio-insights">
      <div class="portfolio-hashrate-card portfolio-insight-card">
        <span class="portfolio-hashrate-ico" aria-hidden="true">${REALIZED_SVG}</span>
        <span class="portfolio-hashrate-copy">
          <span class="portfolio-hashrate-label">Realized P&amp;L ${pl.year}</span>
          <span class="portfolio-hashrate-value ${plClass}">${plText}</span>
          <span class="portfolio-insight-note">${notes.map((n) => deps.escapeHtml(n)).join(" ")}</span>
        </span>
      </div>
      <div class="portfolio-hashrate-card portfolio-insight-card">
        <span class="portfolio-hashrate-ico" aria-hidden="true">${FUEL_SVG}</span>
        <span class="portfolio-hashrate-copy">
          <span class="portfolio-hashrate-label">Fees Spent</span>
          ${feeBody}
        </span>
      </div>
    </div>`;
}

/// A chart screen's top bar: back, the screen's title (iOS navigationTitle) and, on the two
/// price-driven charts, the gear.
function screenHeaderHtml(title, { gear = false } = {}) {
  return `
    <div class="portfolio-screen-header">
      <button class="portfolio-back-btn" type="button" data-portfolio-back aria-label="Back">‹ Portfolio</button>
      <strong class="portfolio-screen-title">${deps.escapeHtml(title)}</strong>
      ${gear ? pairGearHtml() : '<span class="portfolio-screen-header-spacer" aria-hidden="true"></span>'}
    </div>`;
}

/// iOS ChartCurrencyChip: beside the big number, what it and the chart count in, and that a click
/// flips it. Lit up while flipped to the pair; absent when no pair is picked.
function chartChipHtml() {
  if (!pairUnit()) return "";
  return `<span class="portfolio-unit-chip${pairActive ? " flipped" : ""}">${deps.escapeHtml(chartUnitCode())}<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7h12m0 0-3.5-3.5M19 7l-3.5 3.5M17 17H5m0 0 3.5-3.5M5 17l3.5 3.5"/></svg></span>`;
}

/// The two lines a selected span reads above the big number (iOS ChartRangeSummary): the dates,
/// then the return across it. Hidden until a span is dragged out.
function rangeSummarySlotHtml() {
  return `<div class="portfolio-range-summary" data-portfolio-range-summary hidden></div>`;
}

/// While a chart is loading its series (iOS ProgressView), rather than an empty frame.
function chartSpinnerHtml(height) {
  return `<div class="portfolio-chart-loading" style="height:${height}px"><span class="initial-sync-spinner" aria-hidden="true"></span></div>`;
}

/// iOS PortfolioFormat.kas: up to four decimals, grouped, never masked (network figures).
function kasPlain(value) {
  return `${(Number(value) || 0).toLocaleString("en-US", { maximumFractionDigits: 4 })} ${KAS_UNIT}`;
}

/// Full-screen network hashrate screen (iOS HashrateChartScreen): the chart, what a block pays
/// now and after the next step down, an estimate of what a given hashrate earns, and what the
/// number actually means.
function hashrateViewHtml() {
  const stats = peekNetworkStats();
  const daily = estimateDailyKas({
    yourHashrateHs: typedHashrateHs(),
    networkHashrateHs: stats?.currentHashrate,
    blockRewardKas: stats?.blockRewardKas,
  });
  const halvingDate = stats?.nextHalving
    ? new Date(stats.nextHalving.at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
    : null;
  const ranged = hashrateVisiblePoints(stats);
  return `
    ${screenHeaderHtml("Network Hashrate")}
    <div class="profile-card">
      <div class="portfolio-detail-head">
        <span class="portfolio-hashrate-ico" aria-hidden="true">${PICKAXE_SVG}</span>
        <span class="portfolio-detail-name">Kaspa Network</span>
      </div>
      <div class="portfolio-detail-date" data-portfolio-hashrate-date hidden></div>
      ${rangeSummarySlotHtml()}
      <div class="portfolio-detail-price-row">
        <span class="portfolio-detail-price" data-portfolio-hashrate-value>${stats ? formatHashrate(stats.currentHashrate) : "--"}</span>
      </div>
      ${ranged.length >= 2 ? bigChartSvg(ranged, { height: 240, chart: "hashrate" }) : chartSpinnerHtml(240)}
      <div class="portfolio-ranges portfolio-ranges-wide">
        ${HASHRATE_RANGES.map((r) => `<button class="portfolio-range${r.days === hashrateRangeDays ? " active" : ""}" type="button" data-portfolio-hashrate-range="${r.days}">${r.label}</button>`).join("")}
      </div>
    </div>

    <div class="profile-card portfolio-summary">
      ${statRowHtml("Block Reward", stats?.blockRewardKas ? kasPlain(stats.blockRewardKas) : "--")}
      ${statRowHtml("Next Block Reward", stats?.nextHalving ? kasPlain(stats.nextHalving.amountKas) : "--")}
      ${statRowHtml("Next Block Reward Reduction", halvingDate ? deps.escapeHtml(halvingDate) : "--")}
    </div>

    <div class="profile-card">
      <p class="portfolio-card-heading">Mining Estimate</p>
      <div class="portfolio-hashrate-entry">
        <input class="field-input portfolio-hashrate-field" type="text" inputmode="decimal" placeholder="0" aria-label="Your hashrate" data-portfolio-hashrate-input value="${deps.escapeHtml(hashrateInput)}" />
        <div class="settings-segmented" role="group" aria-label="Hashrate unit">
          ${HASHRATE_UNITS.map((unit) => `
            <button type="button" class="settings-segmented-option ${hashrateUnit === unit.key ? "active" : ""}" data-portfolio-hashrate-unit="${unit.key}">${unit.label}</button>`).join("")}
        </div>
      </div>
      <div data-portfolio-payouts>${payoutBlockHtml(daily)}</div>
    </div>

    <div class="profile-card portfolio-about">
      <p class="portfolio-card-heading">About Hashrate</p>
      <p class="portfolio-about-text">Hashrate is how much computing power miners are pointing at Kaspa. A higher hashrate means more work securing the chain, and it moves with mining profitability rather than with the price directly. Figures come from the Kaspa REST API set in Connection Settings, at one sample per day.</p>
    </div>`;
}

/// iOS KasConverterCard.format: eight decimals - Kaspa's own precision - with the trailing zeros
/// dropped down to two, grouped.
function converterFormat(value) {
  let text = (Number(value) || 0).toFixed(8);
  while (text.endsWith("0") && (text.split(".")[1]?.length || 0) > 2) text = text.slice(0, -1);
  return groupedFromCanonical(text);
}

/// The price screen's big number: the chart's own latest point, in whatever the chart counts in.
function priceBigNumber(inPair) {
  if (pairActive && pairUnit()) return inPair ? fmtPairAmount(pairSeries.latest ?? inPair[inPair.length - 1][1], { perKas: true }) : "--";
  return price ? fmtPrice(price.price) : "--";
}

// Full-screen KAS price chart screen (iOS KasPriceChartScreen).
function priceViewHtml() {
  const inPair = pairHistory();
  const series = pairActive && pairUnit() ? (inPair || []) : history;
  // Read off the series the chart is drawing, for whichever range button is selected (iOS
  // chartPriceRangeChange). Percent only.
  const ranged = rangeChange(series);
  const pPos = (ranged?.amount ?? 0) >= 0;
  const symbol = currencyCode() === "btc" ? "₿" : currencySymbol();
  return `
    ${screenHeaderHtml("KAS Price", { gear: true })}
    <div class="profile-card">
      <div class="portfolio-detail-head">
        <img src="${kaspaLogoUrl}" alt="" class="portfolio-detail-logo"/>
        <span class="portfolio-detail-name">Kaspa</span>
      </div>
      <div class="portfolio-detail-date" data-portfolio-price-date hidden></div>
      ${rangeSummarySlotHtml()}
      <div class="portfolio-detail-price-row${pairUnit() ? " portfolio-pair-flip" : ""}" ${pairUnit() ? 'data-portfolio-pair-flip role="button" tabindex="0"' : ""}>
        <span class="portfolio-detail-price" data-portfolio-price-value>${deps.escapeHtml(priceBigNumber(inPair))}</span>
        ${chartChipHtml()}
      </div>
      ${ranged ? `<div class="portfolio-detail-change ${pPos ? "gain" : "loss"}" data-portfolio-price-24h>
          <span>${pPos ? "↑" : "↓"} ${Math.abs(ranged.percent).toFixed(2)}%</span>
          <span class="portfolio-detail-change-range">${deps.escapeHtml(rangeLabel())}</span>
        </div>` : ""}
      ${series.length >= 2 ? bigChartSvg(series, { height: 260, chart: "price" }) : chartSpinnerHtml(260)}
      <div class="portfolio-ranges portfolio-ranges-wide">
        ${rangeButtonsHtml()}
      </div>
    </div>
    <div class="profile-card">
      <p class="portfolio-card-heading">Converter</p>
      <div class="portfolio-converter">
        <label class="portfolio-converter-row">
          <span>KAS</span>
          <input type="text" inputmode="decimal" placeholder="0" data-portfolio-conv-kas value="${deps.escapeHtml(converterKas)}" />
          <em>KAS</em>
        </label>
        <label class="portfolio-converter-row">
          <span>${deps.escapeHtml(currencyCode().toUpperCase())}</span>
          <input type="text" inputmode="decimal" placeholder="0" data-portfolio-conv-fiat value="${deps.escapeHtml(converterFiatOnOpen())}" />
          <em>${deps.escapeHtml(symbol)}</em>
        </label>
      </div>
      <p class="field-hint">${price?.price > 0 ? `1 KAS = ${deps.escapeHtml(symbol)}${deps.escapeHtml(converterFormat(price.price))}` : "Waiting for a price..."}</p>
    </div>

    ${marketStatsHtml()}`;
}

// Value-over-time stats (iOS statsCard): in the app currency, every amount masked by the eye.
function valueStatsHtml(summary) {
  const plText = amountsHidden
    ? `${summary.totalPLPercent.toFixed(1)}%`
    : `${currencyText(summary.totalPL)} (${summary.totalPLPercent.toFixed(1)}%)`;
  return `
    <div class="profile-card portfolio-summary">
      ${statRowHtml("Holdings", fmtKas(summary.holdingsKas))}
      ${statRowHtml("Current Value", fmtFiat(summary.currentValue))}
      ${statRowHtml("Total Invested", fmtFiat(summary.totalInvested))}
      ${statRowHtml("Total P&amp;L", plText, summary.totalPL >= 0 ? "gain" : "loss")}
      ${summary.averageBuyPriceUsd !== null ? statRowHtml("Avg. Buy Price", fmtPrice(summary.averageBuyPriceUsd)) : ""}
    </div>`;
}

/** All runs from the first transaction to today (iOS 00a2b88), not from Gate's listing. */
function cutValueToFirstTransaction(points, scoped) {
  if (rangeDays !== 0 || !scoped.length) return points;
  const firstTx = Math.min(...scoped.map((t) => Number(t.timestamp) || Infinity)) - 86_400_000;
  return Number.isFinite(firstTx) ? points.filter((p) => p[0] >= firstTx) : points;
}

/// The value screen's amounts in whatever the chart counts in (iOS chartMoney), masked by the eye.
function chartMoney(value) {
  if (amountsHidden) return MASKED_AMOUNT;
  return pairActive && pairUnit() ? fmtPairAmount(value) : currencyText(value);
}

// Full-screen Value Over Time chart screen (iOS PortfolioValueChartScreen).
function valueViewHtml(summary) {
  // In a pair, the value is replayed over KAS-in-the-pair, so the amount reads in bitcoin,
  // shares or ounces and the percent is the move against the pair across the range.
  const flipped = pairActive && pairUnit();
  const baseValuePoints = valuePoints;
  if (flipped) {
    const scoped = activePortfolio().transactions || [];
    const inPair = pairHistory();
    valuePoints = inPair ? cutValueToFirstTransaction(computeValueHistory(scoped, inPair), scoped) : [];
  }
  const latest = flipped
    ? (pairSeries?.latest != null && pairHistory() ? summary.holdingsKas * pairSeries.latest : null)
    : summary.currentValue;
  // The move across the SELECTED range: the amount and the percent (only the percent with the
  // eye on).
  const ranged = rangeChange(valuePoints);
  const up = ranged ? ranged.amount >= 0 : true;
  return `
    ${screenHeaderHtml("Value Over Time", { gear: true })}
    <div class="profile-card">
      <p class="portfolio-detail-name portfolio-value-title">Portfolio Value</p>
      <div class="portfolio-detail-date" data-portfolio-value-date hidden></div>
      ${rangeSummarySlotHtml()}
      <div class="portfolio-detail-price-row${pairUnit() ? " portfolio-pair-flip" : ""}" ${pairUnit() ? 'data-portfolio-pair-flip role="button" tabindex="0"' : ""}>
        <span class="portfolio-detail-price" data-portfolio-value-readout>${latest === null ? "--" : deps.escapeHtml(chartMoney(latest))}</span>
        ${chartChipHtml()}
      </div>
      ${ranged ? `
        <div class="portfolio-detail-change ${up ? "gain" : "loss"}" data-portfolio-value-change>
          <span>${up ? "↗" : "↘"} ${amountsHidden
            ? `${Math.abs(ranged.percent).toFixed(2)}%`
            : `${deps.escapeHtml(chartMoney(Math.abs(ranged.amount)))} (${Math.abs(ranged.percent).toFixed(2)}%)`}</span>
          <span class="portfolio-detail-change-range">${deps.escapeHtml(rangeLabel())}</span>
        </div>` : ""}
      ${valuePoints.length >= 2
        ? bigChartSvg(valuePoints, { height: 240, stroke: "var(--kaspa-ink)", chart: "value", lineWidth: 3, hideValues: amountsHidden })
        : flipped && baseValuePoints.length >= 2
          ? chartSpinnerHtml(240)
          : `<div class="portfolio-chart-empty" style="height:240px">Not enough history yet - check back after a few days of activity.</div>`}
      <div class="portfolio-ranges portfolio-ranges-wide">
        ${rangeButtonsHtml()}
      </div>
    </div>
    ${valueStatsHtml(summary)}`;
}

function render() {
  if (!rootEl) return;
  const portfolio = activePortfolio();
  const scoped = portfolio.transactions || [];
  // Resolved per render (session cache, else the persisted copy for this exact range) so a
  // refresh in flight never blanks the chart and a range switch repaints instantly.
  history = historyForRange(rangeDays);
  sevenDayHistory = historyForRange(7);
  const summary = computeSummary(scoped, price?.price || 0);
  valuePoints = cutValueToFirstTransaction(computeValueHistory(scoped, history), scoped);

  if (view === "price") {
    rootEl.innerHTML = priceViewHtml();
    wireScrubbing();
    return;
  }
  if (view === "value") {
    rootEl.innerHTML = valueViewHtml(summary);
    wireScrubbing();
    return;
  }
  if (view === "hashrate") {
    rootEl.innerHTML = hashrateViewHtml();
    wireScrubbing();
    return;
  }

  const transactions = [...scoped].sort((a, b) => b.timestamp - a.timestamp);
  const allPicked = transactions.length > 0 && selectedTxIds.size === transactions.length;
  rootEl.innerHTML = `
    <div class="kaposts-header">
      <h1 class="kaposts-title">Portfolio</h1>
      <div class="kaposts-header-actions">
        <button class="kaposts-icon-button${amountsHidden ? " active" : ""}" type="button" data-portfolio-eye title="${amountsHidden ? "Show amounts" : "Hide amounts"}" aria-label="${amountsHidden ? "Show amounts" : "Hide amounts"}">
          ${amountsHidden
            ? `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3l18 18M10.6 10.6a2 2 0 0 0 2.8 2.8M9.9 5.1A10.9 10.9 0 0 1 12 5c5 0 9 4 10 7a11.8 11.8 0 0 1-2.6 3.9M6.6 6.6C4.4 8 2.9 10 2 12c1 3 5 7 10 7a9.7 9.7 0 0 0 3.4-.6"/></svg>`
            : `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12c1-3 5-7 10-7s9 4 10 7c-1 3-5 7-10 7S3 15 2 12z"/><circle cx="12" cy="12" r="3"/></svg>`}
        </button>
        <button class="kaposts-icon-button" type="button" data-portfolio-refresh title="Refresh">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99"/></svg>
        </button>
      </div>
    </div>

    <div class="portfolio-cards">
      ${state.portfolios.map(pickerCard).join("")}
      ${state.portfolios.length < MAX_PORTFOLIOS ? `
        <button class="portfolio-card portfolio-card-add" type="button" data-portfolio-add>
          <span class="portfolio-card-add-plus">+</span>
          <span>Add</span>
        </button>` : ""}
    </div>

    ${squaresHtml(summary)}

    ${hashrateCardHtml()}

    ${insightCardsHtml(portfolio)}

    <div class="profile-card">
      <!-- iOS PortfolioTransactionsView's section header: Select, + and import/export, or while
           selecting the select-all check, the trash with its count, and Done. -->
      <div class="portfolio-tx-header">
        <p class="portfolio-card-heading">Transactions</p>
        <div class="portfolio-tx-header-actions">
          ${selecting ? `
            <button class="portfolio-tx-icon-btn" type="button" data-portfolio-select-all aria-label="${allPicked ? "Deselect all" : "Select all"}" title="${allPicked ? "Deselect all" : "Select all"}">${allPicked ? CHECK_FILLED_SVG : CHECK_OUTLINE_SVG}</button>
            <button class="portfolio-tx-icon-btn portfolio-select-delete" type="button" data-portfolio-delete-selected aria-label="Delete selected" title="Delete selected" ${selectedTxIds.size === 0 ? "disabled" : ""}>${TRASH_SVG}<span data-portfolio-delete-count>${selectedTxIds.size || ""}</span></button>
            <button class="cold-inline-link" type="button" data-portfolio-select-toggle>Done</button>` : `
            <button class="cold-inline-link" type="button" data-portfolio-select-toggle ${transactions.length === 0 ? "disabled" : ""}>Select</button>
            <button class="portfolio-tx-icon-btn" type="button" data-portfolio-add-menu aria-label="Add to this portfolio" title="Add to this portfolio">${PLUS_FILLED_SVG}</button>
            <button class="portfolio-tx-icon-btn" type="button" data-portfolio-io-menu aria-label="Import or export" title="Import or export">${IMPORT_EXPORT_SVG}</button>`}
        </div>
      </div>
      ${transactions.length === 0
        ? `<div class="portfolio-chart-empty portfolio-empty-state"><strong>No Transactions Yet</strong><span>Add a buy or sell to start tracking your portfolio</span></div>`
        : transactions.map(transactionRowHtml).join("")}
    </div>
    ${loading ? `<div class="portfolio-chart-empty">Refreshing…</div>` : ""}`;
}

/// iOS ChartRangeSummary: the span's two dates ("Oct 1, 2026 → Oct 9, 2026", times when both
/// ends are the same day), then the return across it.
function rangeSummaryHtml(a, b, valueText) {
  const sameDay = new Date(a[0]).toDateString() === new Date(b[0]).toDateString();
  const dateOf = (ts) => new Date(ts).toLocaleString(undefined, sameDay
    ? { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }
    : { month: "short", day: "numeric", year: "numeric" });
  const delta = b[1] - a[1];
  const up = delta >= 0;
  const percent = a[1] !== 0 ? (delta / Math.abs(a[1])) * 100 : null;
  return `
    <div class="portfolio-range-dates">${deps.escapeHtml(dateOf(a[0]))} → ${deps.escapeHtml(dateOf(b[0]))}</div>
    <div class="portfolio-range-change ${up ? "gain" : "loss"}">${up ? "↗" : "↘"}${percent !== null ? ` <strong>${Math.abs(percent).toFixed(2)}%</strong>` : ""} (${up ? "+" : "-"}${deps.escapeHtml(valueText(Math.abs(delta)))})</div>`;
}

/// One chart screen's live readout: a scrubbed point puts its date and value up and hides the
/// range's change; a dragged span shows its summary above the big number instead (iOS
/// KasPriceChartScreen / PortfolioValueChartScreen / HashrateChartScreen headers).
function wireChartReadout({ chart, points, dateAttr, valueAttr, changeAttr, current, valueText, dateOptions }) {
  const wrap = rootEl.querySelector(`[data-portfolio-chart="${chart}"]`);
  const el = (attr) => (attr ? rootEl.querySelector(`[${attr}]`) : null);
  const summary = () => rootEl.querySelector("[data-portfolio-range-summary]");
  const reset = () => {
    const date = el(dateAttr), value = el(valueAttr), change = el(changeAttr), span = summary();
    if (date) date.hidden = true;
    if (span) span.hidden = true;
    if (value) value.textContent = current();
    if (change) change.style.visibility = "";
  };
  attachScrub(wrap, points, ([ts, v]) => {
    const date = el(dateAttr), value = el(valueAttr), change = el(changeAttr), span = summary();
    if (span) span.hidden = true;
    if (date) { date.hidden = false; date.textContent = new Date(ts).toLocaleString(undefined, dateOptions); }
    if (value) value.textContent = valueText(v);
    // Hidden rather than removed: the range's change under a past value would read as that
    // point's own move, and collapsing the row would shift the chart under the pointer.
    if (change) change.style.visibility = "hidden";
  }, reset, (a, b) => {
    const date = el(dateAttr), value = el(valueAttr), change = el(changeAttr), span = summary();
    if (date) date.hidden = true;
    if (value) value.textContent = current();
    if (change) change.style.visibility = "hidden";
    if (span) { span.hidden = false; span.innerHTML = rangeSummaryHtml(a, b, valueText); }
  });
}

function wireScrubbing() {
  const withTime = { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" };
  const dateOnly = { month: "short", day: "numeric", year: "numeric" };
  if (view === "price") {
    // The chart, the big number and the scrub read the same series, so they can never disagree.
    const inPair = pairHistory();
    const flipped = pairActive && pairUnit();
    wireChartReadout({
      chart: "price",
      points: flipped ? (inPair || []) : history,
      dateAttr: "data-portfolio-price-date",
      valueAttr: "data-portfolio-price-value",
      changeAttr: "data-portfolio-price-24h",
      current: () => priceBigNumber(inPair),
      valueText: (v) => (flipped ? fmtPairAmount(v, { perKas: true }) : fmtPrice(v)),
      dateOptions: withTime,
    });
    return;
  }
  if (view === "hashrate") {
    const stats = peekNetworkStats();
    wireChartReadout({
      chart: "hashrate",
      points: hashrateVisiblePoints(stats),
      dateAttr: "data-portfolio-hashrate-date",
      valueAttr: "data-portfolio-hashrate-value",
      current: () => (stats ? formatHashrate(stats.currentHashrate) : "--"),
      valueText: (v) => formatHashrate(v),
      dateOptions: dateOnly,
    });
    return;
  }
  if (view === "value") {
    const readout = rootEl.querySelector("[data-portfolio-value-readout]");
    const shown = readout?.textContent || "--";
    wireChartReadout({
      chart: "value",
      points: valuePoints,
      dateAttr: "data-portfolio-value-date",
      valueAttr: "data-portfolio-value-readout",
      changeAttr: "data-portfolio-value-change",
      current: () => shown,
      valueText: chartMoney,
      dateOptions: dateOnly,
    });
  }
}

// ---------------------------------------------------------------------------
// Transaction editor modal (iOS PortfolioTransactionEditor)
// ---------------------------------------------------------------------------

function toDatetimeLocal(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function trimmedNumber(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "";
  return n.toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
}
function setEditorType(type) {
  modalsEl.querySelector("[data-portfolio-editor-type]").value = type;
  modalsEl.querySelectorAll("[data-portfolio-editor-type-option]").forEach((b) => b.classList.toggle("active", b.dataset.portfolioEditorTypeOption === type));
  // A transfer needs only its amount: no fee, and a footer saying what it means (iOS 7423330).
  const isTransfer = type === "transfer";
  const feeField = modalsEl.querySelector("[data-portfolio-editor-fee-field]");
  if (feeField) feeField.hidden = isTransfer;
  const note = modalsEl.querySelector("[data-portfolio-editor-transfer-note]");
  if (note) note.hidden = !isTransfer;
  updateEditorHint();
}
function openTxEditor(txId) {
  const portfolio = activePortfolio();
  const tx = txId ? (portfolio.transactions || []).find((t) => t.id === txId) : null;
  editingTx = { id: tx?.id || null };
  const backdrop = modalsEl.querySelector("[data-portfolio-editor-modal]");
  modalsEl.querySelector("[data-portfolio-editor-title]").textContent = tx ? "Edit Transaction" : "Add Transaction";
  modalsEl.querySelector("[data-portfolio-editor-amount]").value = tx && tx.amountKas > 0 ? trimmedNumber(tx.amountKas) : "";
  // A new transaction is prefilled with the live price - recording a trade that just happened
  // needs no lookup - and stays editable for backdated entries (iOS).
  modalsEl.querySelector("[data-portfolio-editor-price]").value = tx && tx.amountKas > 0
    ? trimmedNumber((Number(tx.fiatValue) || 0) / tx.amountKas)
    : (price?.price > 0 ? trimmedNumber(price.price) : "");
  modalsEl.querySelector("[data-portfolio-editor-fee]").value = "";
  modalsEl.querySelector("[data-portfolio-editor-date]").value = toDatetimeLocal(tx?.timestamp ?? Date.now());
  const notes = isPricePending(tx?.notes) ? "" : (tx?.notes || "");
  modalsEl.querySelector("[data-portfolio-editor-notes]").value = notes;
  modalsEl.querySelectorAll("[data-portfolio-editor-symbol]").forEach((el) => { el.textContent = symbolFor(currencyCode()); });
  modalsEl.querySelector("[data-portfolio-editor-delete]").hidden = !tx;
  modalsEl.querySelector("[data-portfolio-editor-save]").textContent = tx ? "Save" : "Add";
  setEditorType(tx ? txKind(tx) : "buy");
  backdrop.hidden = false;
}

function closeTxEditor() {
  editingTx = null;
  modalsEl.querySelector("[data-portfolio-editor-modal]").hidden = true;
}

/** Quantity, price per coin and fee, as iOS records them; the ledger stores the total. */
function editorValues() {
  const num = (sel) => parsePortfolioNumber(modalsEl.querySelector(sel)?.value) ?? 0;
  const quantity = num("[data-portfolio-editor-amount]");
  const pricePerCoin = num("[data-portfolio-editor-price]");
  const fee = num("[data-portfolio-editor-fee]") || 0;
  const rawType = modalsEl.querySelector("[data-portfolio-editor-type]")?.value;
  const type = rawType === "sell" || rawType === "transfer" ? rawType : "buy";
  // A transfer only needs its amount: it has no price that counts for anything.
  const valid = quantity > 0 && (type === "transfer" || pricePerCoin > 0);
  const base = quantity > 0 && pricePerCoin > 0 ? quantity * pricePerCoin : null;
  // A transfer's total is what the KAS was worth when it moved - a note on the row, counted nowhere.
  const total = base === null ? null : type === "buy" ? base + fee : type === "sell" ? base - fee : base;
  return { quantity, pricePerCoin, fee, type, valid, total };
}
function updateEditorHint() {
  const v = editorValues();
  const label = modalsEl.querySelector("[data-portfolio-editor-total-label]");
  const total = modalsEl.querySelector("[data-portfolio-editor-total]");
  const save = modalsEl.querySelector("[data-portfolio-editor-save]");
  if (label) label.textContent = v.type === "buy" ? "Total Spent" : v.type === "sell" ? "Total Received" : "Value at the Time";
  // Not masked by the eye - it is the figure being typed (iOS editor's Total).
  if (total) total.textContent = currencyText(v.total ?? 0);
  if (save) save.disabled = !v.valid;
}

function saveTxEditor() {
  const v = editorValues();
  if (!v.valid) return;
  const amount = v.quantity;
  const type = v.type;
  // A transfer with no price is still a complete record.
  const fiatValue = v.total ?? 0;
  const dateRaw = modalsEl.querySelector("[data-portfolio-editor-date]")?.value;
  const timestamp = dateRaw ? new Date(dateRaw).getTime() : Date.now();
  const notes = modalsEl.querySelector("[data-portfolio-editor-notes]")?.value?.trim() || null;

  const portfolio = activePortfolio();
  portfolio.transactions ||= [];
  if (editingTx?.id) {
    const index = portfolio.transactions.findIndex((t) => t.id === editingTx.id);
    if (index >= 0) {
      // Preserve on-chain provenance fields; a manual edit clears the needs-price warning.
      const existing = portfolio.transactions[index];
      portfolio.transactions[index] = { ...existing, type, amountKas: amount, fiatValue, timestamp, notes };
    }
  } else {
    portfolio.transactions.push({ id: nowId(), type, amountKas: amount, fiatValue, timestamp, notes });
  }
  saveState();
  closeTxEditor();
  render();
}

// ---------------------------------------------------------------------------
// CSV import/export (CoinMarketCap "Transaction History" format — matches iOS)
// ---------------------------------------------------------------------------

/** Splits a CSV document into records of fields (RFC 4180, iOS parseCsvRecords): commas and
 *  line breaks inside double quotes belong to the field, "" inside quotes is one literal quote,
 *  and a line break outside quotes - LF, CRLF or CR - ends the record. Blank lines yield no
 *  record. Whole records rather than lines, because a note can hold line breaks, which the
 *  export writes inside its quotes - splitting the file on every newline first cut such a row
 *  in two. */
function parseCsvRecords(content) {
  const text = String(content ?? "");
  const records = [];
  let fields = [];
  let current = "";
  let inQuotes = false;
  const endRecord = () => {
    fields.push(current);
    if (!(fields.length === 1 && !fields[0].trim())) records.push(fields);
    fields = [];
    current = "";
  };
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { current += '"'; i += 1; }
        else inQuotes = false;
      } else {
        current += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      fields.push(current);
      current = "";
    } else if (c === "\r" || c === "\n") {
      if (c === "\r" && text[i + 1] === "\n") i += 1; // CRLF is one line ending
      endRecord();
    } else {
      current += c;
    }
  }
  if (current || fields.length) endRecord();
  return records;
}

function parseLenientDouble(raw) {
  const value = Number(String(raw ?? "").trim().replace(/,/g, ""));
  return Number.isFinite(value) ? value : null;
}

/** CoinMarketCap bakes the exporter's UTC offset into the date column header, e.g.
 *  "Date (UTC-4:00)" — parsed once so every row's timestamp is interpreted correctly. */
function parseHeaderUtcOffsetMinutes(header) {
  const match = /UTC([+-]?\d+):(\d+)/i.exec(header || "");
  if (!match) return 0;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const sign = hours < 0 || match[1].startsWith("-") ? -1 : 1;
  return sign * (Math.abs(hours) * 60 + minutes);
}

/** The export as { filename, csv }, or null (with the toast said) when there is nothing to export. */
function buildCsvExport() {
  const portfolio = activePortfolio();
  const rows = [...(portfolio.transactions || [])].sort((a, b) => a.timestamp - b.timestamp);
  if (!rows.length) { deps.showToast?.("Nothing to export yet. Add a transaction first"); return null; }
  const pad = (n) => String(n).padStart(2, "0");
  let csv = "Date (UTC+0:00),Token,Type,Price (USD),Amount,Total value (USD),Fee,Fee Currency,Notes\n";
  for (const tx of rows) {
    const d = new Date(tx.timestamp);
    const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
    const amount = Number(tx.amountKas) || 0;
    const fiat = Number(tx.fiatValue) || 0;
    const perKas = amount !== 0 ? fiat / amount : 0;
    const notes = String(tx.notes || "").replace(/"/g, '""');
    csv += `"${date}","KAS","${txKind(tx)}","${perKas}","${amount}","${fiat}","0.00","USD","${notes}"\n`;
  }
  // iOS's file-name time: ISO 8601 in UTC, whole seconds, "Z", with ":" made "-".
  const stamp = `${new Date().toISOString().slice(0, 19)}Z`.replace(/:/g, "-");
  return { filename: `${portfolioExportBaseName(portfolio)} ${stamp}.csv`, csv };
}

/** The export's file name: the name the portfolio has in the app ("Long Term 2026-10-08T...Z.csv"),
 *  so it is recognizable in Downloads and Nextcloud; "KaChat Portfolio" when it has none.
 *  Characters a file name can't hold are dropped, and it stops at 60 characters (iOS 87b2a0b). */
function portfolioExportBaseName(portfolio) {
  // eslint-disable-next-line no-control-regex
  const cleaned = String(portfolio?.name ?? "").replace(/[/\\:?*"<>|\u0000-\u001f\u007f-\u009f]/g, "").trim();
  return cleaned ? Array.from(cleaned).slice(0, 60).join("") : "KaChat Portfolio";
}

async function exportCsv() {
  const built = buildCsvExport();
  if (!built) return;
  try {
    await saveFile(built.filename, "text/csv", built.csv);
  } catch {
    deps.showToast?.("Export failed. Couldn't write the CSV file");
  }
}

/** Same CSV as Export CSV, uploaded into the KaChat folder of the connected Nextcloud. */
async function exportToNextcloud() {
  const built = buildCsvExport();
  if (!built) return;
  try {
    const path = await uploadToKaChatFolder(new Blob([built.csv], { type: "text/csv" }), built.filename, "text/csv", { keepSpaces: true });
    deps.showToast?.(`Saved to ${path} in Nextcloud.`);
  } catch (error) {
    deps.showToast?.(`Export to Nextcloud failed: ${error?.message || "unknown error"}`);
  }
}

/** The picked file goes through the same import as a file from disk. */
function importFromNextcloud() {
  openNextcloudFilePicker({
    allowedExtensions: ["csv", "txt"],
    onPicked: async (file) => {
      let imported = 0;
      try { imported = importCsvText(await downloadNextcloudText(file.path)); }
      catch (error) { deps.showToast?.(`Import from Nextcloud failed: ${error?.message || "unknown error"}`); return; }
      deps.showToast?.(imported > 0 ? `Imported ${imported} transaction${imported === 1 ? "" : "s"}` : "Import failed. Check the CSV format");
    },
  });
}

/** Same replace-by-timestamp dedup as iOS: a row whose timestamp exactly matches an existing
 *  transaction in the active portfolio replaces it in place rather than piling up copies. */
function importCsvText(content) {
  const records = parseCsvRecords(content);
  if (!records.length) return 0;
  const header = records.shift().join(",");
  const offsetMinutes = parseHeaderUtcOffsetMinutes(header);

  const portfolio = activePortfolio();
  portfolio.transactions ||= [];
  const indexByTimestamp = new Map();
  portfolio.transactions.forEach((tx, index) => indexByTimestamp.set(tx.timestamp, index));

  let imported = 0;
  for (const fields of records) {
    if (fields.length < 6) continue;
    if (String(fields[1]).trim().toUpperCase() !== "KAS") continue;
    const typeRaw = String(fields[2]).trim().toLowerCase();
    // CoinMarketCap writes "Transfer In" / "Transfer Out"; both are a transfer here.
    const type = typeRaw === "buy" || typeRaw === "sell" ? typeRaw : typeRaw.startsWith("transfer") ? "transfer" : null;
    if (!type) continue;
    const dateMatch = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(String(fields[0]).trim());
    if (!dateMatch) continue;
    const [, y, mo, d, h, mi, s] = dateMatch.map(Number);
    const timestamp = Date.UTC(y, mo - 1, d, h, mi, s) - offsetMinutes * 60_000;
    const kas = parseLenientDouble(fields[4]);
    const totalValue = parseLenientDouble(fields[5]);
    if (kas === null || totalValue === null) continue;

    // Fee folded into total when USD-denominated: added for buys, subtracted for sells.
    let fiatValue = totalValue;
    if (fields.length > 7 && String(fields[7]).trim().toUpperCase() === "USD") {
      const fee = parseLenientDouble(fields[6]);
      if (fee !== null) {
        if (type === "buy") fiatValue += fee;
        else if (type === "sell") fiatValue = Math.max(fiatValue - fee, 0);
        // transfer: no fee - it counts for nothing anyway.
      }
    }
    const notes = fields.length > 8 && fields[8] ? fields[8] : null;

    const existingIndex = indexByTimestamp.get(timestamp);
    if (existingIndex !== undefined) {
      const existing = portfolio.transactions[existingIndex];
      portfolio.transactions[existingIndex] = { ...existing, type, amountKas: kas, fiatValue, timestamp, notes };
    } else {
      portfolio.transactions.push({ id: nowId(), type, amountKas: kas, fiatValue, timestamp, notes });
      indexByTimestamp.set(timestamp, portfolio.transactions.length - 1);
    }
    imported += 1;
  }

  if (imported > 0) {
    saveState();
    render();
    // A re-imported export can carry rows whose price was still loading when it was written -
    // price them by their date like any other.
    startPriceBackfillIfNeeded();
  }
  return imported;
}

// ---------------------------------------------------------------------------
// On-chain address import (iOS PortfolioAddressImporter): every received tx becomes a buy,
// every sent tx a sell, priced at that day's historical KAS price.
// ---------------------------------------------------------------------------

const IMPORT_MAX_TRANSACTIONS = 500;

function txDirectionForAddress(tx, address) {
  const inputs = tx.inputs || [];
  const outputs = tx.outputs || [];
  const weAreSender = inputs.some((input) => input.previous_outpoint_address === address);
  let totalToUs = 0n;
  let totalToOthers = 0n;
  let recipientAmount = 0n;
  let haveRecipient = false;
  for (const output of outputs) {
    const outAddress = output.script_public_key_address;
    const amount = BigInt(output.amount || 0);
    if (!outAddress) continue;
    if (outAddress === address) {
      totalToUs += amount;
    } else {
      totalToOthers += amount;
      if (!haveRecipient || amount < recipientAmount) { recipientAmount = amount; haveRecipient = true; }
    }
  }
  if (weAreSender && totalToOthers > 0n) return { isOutgoing: true, amountSompi: haveRecipient ? recipientAmount : totalToOthers };
  if (!weAreSender && totalToUs > 0n) return { isOutgoing: false, amountSompi: totalToUs };
  return null;
}

/** The network fee `address` paid on `tx`, in sompi (iOS feeSompi(of:paidBy:)): everything its
 *  inputs spent minus everything its outputs paid out. Only for a transaction `address` sent -
 *  one of its coins is an input - and only when every input's amount is known (the REST API
 *  resolves them with resolve_previous_outpoints), since a missing amount would make any
 *  difference a guess. Null otherwise, or when nothing was paid. The whole fee goes to
 *  `address`: KaChat's sends spend one address's coins. */
function feeSompiPaidBy(tx, address) {
  const inputs = tx.inputs || [];
  if (!inputs.some((input) => input.previous_outpoint_address === address)) return null;
  let spent = 0n;
  for (const input of inputs) {
    const amount = input.previous_outpoint_amount;
    if (amount === null || amount === undefined || amount === "") return null;
    try { spent += BigInt(amount); } catch { return null; }
  }
  let paidOut = 0n;
  for (const output of tx.outputs || []) {
    try { paidOut += BigInt(output.amount || 0); } catch { return null; }
  }
  if (spent <= paidOut) return null;
  return Number(spent - paidOut);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function setImportProgress(text) {
  if (addressImport) addressImport.progress = text;
  const el = modalsEl.querySelector("[data-portfolio-import-progress]");
  if (el) el.textContent = text || "";
}

// --- address field: raw address or a domain, .kachat first (iOS PortfolioAddAddressView, 6ac48a7) ---

function looksLikeRawAddress(input) {
  const lower = String(input || "").toLowerCase();
  return lower.startsWith("kaspa:") || lower.startsWith("kaspatest:");
}

/// A checksum-valid address of the running network (iOS KaspaAddress.isValid).
function isValidRawAddress(input) {
  const text = String(input || "").trim();
  return text.toLowerCase().startsWith(`${ADDRESS_HRP}:`) && isValidKaspaAddress(text);
}

function shortenAddress(address) {
  return address.length > 26 ? `${address.slice(0, 16)}...${address.slice(-8)}` : address;
}

/** What Import actually runs against: the resolved owner of a typed domain, else the raw input. */
function importEffectiveAddress() {
  return addressImport?.resolvedAddress || addressImport?.input || "";
}

function canImportAddress() {
  if (!addressImport || addressImport.busy) return false;
  if (addressImport.resolvedAddress) return true;
  return isValidRawAddress(addressImport.input);
}

/** Under-field status line + button states — port of iOS's `validationStatus`: nothing while
 *  empty or mid-resolution, "Resolves to ..." for a resolved domain, a quiet "Domain not found",
 *  or the raw address's valid/invalid affordance. */
function syncImportModal() {
  if (!modalsEl) return;
  const startBtn = modalsEl.querySelector("[data-portfolio-import-start]");
  const pasteBtn = modalsEl.querySelector("[data-portfolio-import-paste]");
  const scanBtn = modalsEl.querySelector("[data-portfolio-import-scan]");
  const status = modalsEl.querySelector("[data-portfolio-import-status]");
  if (startBtn) startBtn.disabled = !canImportAddress();
  if (pasteBtn) pasteBtn.disabled = Boolean(addressImport?.busy);
  if (scanBtn) scanBtn.disabled = Boolean(addressImport?.busy);
  if (!status) return;

  const input = addressImport?.input || "";
  status.style.color = "";
  // Who the address resolves to (iOS ac0ef19): the create-chat card under the status.
  let cardHost = modalsEl.querySelector("[data-portfolio-import-card]");
  // iOS order: the field, who it resolves to, the status line, then Other domains.
  if (!cardHost) { cardHost = document.createElement("div"); cardHost.dataset.portfolioImportCard = ""; status.insertAdjacentElement("beforebegin", cardHost); }
  const showCard = (address, domain) => { cardHost.innerHTML = address ? (deps.addressCardHtml?.(address, { domain, onLoaded: () => syncImportModal() }) || "") : ""; };
  showCard(null);
  // Other domains under the resolved name (iOS 6ac48a7): the same name on the other services.
  let othersHost = modalsEl.querySelector("[data-portfolio-import-other-domains]");
  if (!othersHost) { othersHost = document.createElement("div"); othersHost.dataset.portfolioImportOtherDomains = ""; status.insertAdjacentElement("afterend", othersHost); }
  othersHost.innerHTML = addressImport && !addressImport.resolving && input
    ? otherDomainsHtml({ resolutions: addressImport.nameResolutions || [], selectedTld: addressImport.selectedTld ?? null })
    : "";
  if (addressImport?.resolving) { status.textContent = "Looking up domain..."; return; }
  if (!input) { status.textContent = ""; return; }
  if (addressImport.resolvedAddress) {
    status.textContent = `Resolved: ${addressImport.resolvedDomain || ""} ${shortenAddress(addressImport.resolvedAddress)}`;
    status.style.color = "var(--ios-green)";
    showCard(addressImport.resolvedAddress, addressImport.resolvedDomain);
    return;
  }
  if (addressImport.notFound) { status.textContent = notFoundMessage(input, addressImport.nameResolutions || []); return; }
  if (looksLikeRawAddress(input)) {
    const valid = isValidRawAddress(input);
    status.textContent = valid ? "Valid address" : "Invalid address format";
    status.style.color = valid ? "var(--ios-green)" : "var(--ios-red)";
    if (valid) showCard(input, null);
    return;
  }
  status.textContent = "";
}

// Bumped on every keystroke so an in-flight lookup for older input can't land on newer input.
let knsResolveSeq = 0;

function handleImportInputChange(raw) {
  if (!addressImport || addressImport.busy) return;
  const trimmed = String(raw || "").trim();
  addressImport.input = trimmed;
  addressImport.resolvedAddress = null;
  addressImport.resolvedDomain = null;
  addressImport.notFound = false;
  addressImport.resolving = false;
  addressImport.nameResolutions = [];
  addressImport.selectedTld = null;
  const seq = (knsResolveSeq += 1);

  if (trimmed && !looksLikeRawAddress(trimmed) && looksLikeName(trimmed)) {
    addressImport.resolving = true;
    resolveImportDomain(trimmed, seq);
  }
  syncImportModal();
}

/** Clipboard fill for the address field — the desktop equivalent of iOS's Paste button. Setting
 *  the field's value programmatically fires no `input` event, so the change is fed through by
 *  hand (mirroring iOS, where assigning `addressText` triggers `handleInputChange`). */
async function pasteIntoImportField() {
  if (!addressImport || addressImport.busy) return;
  let text = "";
  try {
    text = String((await navigator.clipboard.readText()) || "").trim();
  } catch {
    setImportProgress("Couldn't read the clipboard. Paste into the field with Cmd+V instead.");
    return;
  }
  if (!text) return;
  // Strip URI query params (kaspa:addr?amount=...) so only the address itself lands in the
  // field — same normalization iOS's scan/paste handler applies.
  if (looksLikeRawAddress(text)) text = text.split("?")[0];
  fillImportField(text);
}

/** Camera scan for the address field, the desktop equivalent of iOS's Scan button
 *  (PortfolioTransactionsView's `showQRScanner` / `handleScannedQRCode`). The scanner
 *  already strips a `kaspa:addr?amount=...` query, and the result is fed through the
 *  SAME path the Paste button uses, so KNS resolution and validation still run. */
async function scanIntoImportField() {
  if (!addressImport || addressImport.busy) return;
  let scanned = null;
  try {
    scanned = await scanKaspaAddress();
  } catch {
    setImportProgress("The QR scanner could not be opened. Paste or type the address instead.");
    return;
  }
  // The sheet may have been closed while the scanner was up.
  if (!scanned || !addressImport || addressImport.busy) return;
  fillImportField(scanned);
}

/** Programmatic field fill: setting `value` fires no `input` event, so the change is fed
 *  through by hand (mirroring iOS, where assigning `addressText` triggers `handleInputChange`). */
function fillImportField(text) {
  const field = modalsEl.querySelector("[data-portfolio-import-address]");
  if (field) field.value = text;
  setImportProgress("");
  handleImportInputChange(text);
}

/** Debounced forward resolution — the same 300ms wait-then-check-input-unchanged pattern iOS
 *  uses, so mid-typing keystrokes never each fire a KNS request. */
async function resolveImportDomain(domain, seq) {
  await sleep(300);
  if (seq !== knsResolveSeq || addressImport?.input !== domain) return;

  // Every name service in priority order (iOS 79b6ac8): the typed ending's, else .kachat, .kas,
  // .k, .kaspa - the same resolution as sends and new chats (the engine's, so .kachat resolves
  // where its registry is live). Every answer is kept for Other domains (iOS 6ac48a7).
  let resolution = null;
  let results = [];
  try {
    if (deps.engine?.lookUpName) {
      ({ results, resolution } = await deps.engine.lookUpName(domain));
    } else {
      results = await resolveEverywhere(domain, {
        resolveKas: async (name) => {
          try { return (await resolveDomain(name, { baseUrl: getEndpoint("knsApi") }))?.ownerAddress || null; } catch { return null; }
        },
      });
      const winner = primaryName(results, domain);
      resolution = winner?.address ? { ownerAddress: winner.address, domain: winner.name, tld: winner.tld } : null;
    }
  } catch { resolution = null; }

  // Input may have moved on while the lookup was in flight — a stale answer must not overwrite
  // the state for what's in the field now.
  if (seq !== knsResolveSeq || addressImport?.input !== domain) return;
  addressImport.nameResolutions = results || [];
  addressImport.selectedTld = resolution?.tld || null;
  addressImport.resolvedAddress = resolution?.ownerAddress || null;
  addressImport.resolvedDomain = resolution?.domain || null;
  addressImport.notFound = !resolution;
  addressImport.resolving = false;
  syncImportModal();
}

/** Backoff schedule for a failing history page: retry the SAME offset with growing pauses before
 *  declaring the fetch incomplete, instead of aborting the whole import on the first hiccup.
 *  Port of PortfolioAddressImporter.pageRetryDelaysSeconds. */
const PAGE_RETRY_DELAYS_MS = [0, 1000, 3000, 8000];
const IMPORT_PAGE_SIZE = 50;

/** Same endpoint and paging as before, but a failing page retries the SAME offset on a growing
 *  backoff — and when the retries are exhausted, whatever was fetched so far is returned (marked
 *  incomplete) so the import can still save the rows it has. A 429 on page 4 used to discard
 *  pages 1 through 3 entirely. Port of PortfolioAddressImporter.fetchTransactionsResumable. */
async function fetchTransactionsResumable(address, onProgress) {
  const base = String(getEndpoint("kaspaApi") || "https://api.kaspa.org").replace(/\/+$/, "");
  const all = [];
  let offset = 0;

  while (all.length < IMPORT_MAX_TRANSACTIONS) {
    const url = `${base}/addresses/${encodeURIComponent(address)}/full-transactions`
      + `?limit=${IMPORT_PAGE_SIZE}&offset=${offset}&resolve_previous_outpoints=light`;

    let page = null;
    for (let attempt = 0; attempt < PAGE_RETRY_DELAYS_MS.length; attempt += 1) {
      if (PAGE_RETRY_DELAYS_MS[attempt] > 0) await sleep(PAGE_RETRY_DELAYS_MS[attempt]);
      try {
        const response = await fetch(url, { headers: { Accept: "application/json" }, cache: "no-store" });
        if (!response.ok) continue;
        const json = await response.json();
        if (!Array.isArray(json)) continue;
        page = json;
        break;
      } catch { /* network hiccup — the next attempt waits longer */ }
    }

    if (page === null) return { transactions: all, complete: false };
    if (!page.length) break;
    // a block reward the chain never accepted paid nothing: not a ledger row (the page's full
    // count still decides whether there is another page) - iOS d194a38
    all.push(...page.filter(transactionBelongsInHistory));
    onProgress(`Fetching transactions… (${all.length})`);
    if (page.length < IMPORT_PAGE_SIZE) break;
    offset += IMPORT_PAGE_SIZE;
  }

  return { transactions: all.slice(0, IMPORT_MAX_TRANSACTIONS), complete: true };
}

/** Imports `address`'s on-chain history into the active portfolio. The rows are SAVED FIRST —
 *  with whatever prices the persistent day cache already knows — and everything still unpriced
 *  is handed to the background backfill, so a CoinGecko rate limit can never cost the user the
 *  ledger data itself. Mirrors iOS: PortfolioAddressImporter.importAddress returns rows and
 *  PortfolioViewModel.importAddress persists them before kicking off startPriceBackfillIfNeeded. */
/// Ends an address import the way iOS does (AddPortfolioAddressSheet.startImport): the sheet
/// closes, then one toast says how it went.
function finishAddressImport(message) {
  if (addressImport) addressImport.busy = false;
  closeAddressImportSheet();
  if (message) deps.showToast?.(message);
}

function closeAddressImportSheet() {
  addressImport = null;
  knsResolveSeq += 1; // any in-flight KNS lookup belongs to a sheet that's gone
  closeActiveScanner(); // and so does any camera it opened
  const modal = modalsEl?.querySelector("[data-portfolio-import-modal]");
  if (modal) modal.hidden = true;
}

async function runAddressImport(addressRaw) {
  const address = String(addressRaw || "").trim();
  // KNS domains never reach this check: the field resolves them to an address before Import is
  // enabled.
  if (!isValidRawAddress(address)) {
    finishAddressImport("That doesn't look like a valid Kaspa address.");
    return;
  }
  addressImport.busy = true;
  syncImportModal();

  try {
    // Re-importing the same address only adds transactions not already present anywhere in
    // this account's ledgers (deduped by on-chain tx id, matching iOS's whole-wallet dedup).
    const existingTxIds = new Set();
    for (const p of state.portfolios) {
      for (const tx of p.transactions || []) {
        if (tx.sourceAddress === address && tx.sourceTxId) existingTxIds.add(tx.sourceTxId);
      }
    }
    // Fees are deduped per portfolio by txid (iOS existingFeeTxIds): the portfolio the import
    // started in, which is also where its rows and fees land.
    const targetPortfolioId = activePortfolio().id;
    const existingFeeTxIds = new Set(fees.filter((f) => f.portfolioId === targetPortfolioId).map((f) => f.txId));

    setImportProgress("Fetching transactions…");
    const historyResult = await fetchTransactionsResumable(address, setImportProgress);

    const candidates = [];
    const feeCandidates = [];
    for (const tx of historyResult.transactions) {
      const txId = tx.transaction_id;
      const blockTime = Number(tx.block_time);
      // Fees first and on their own terms: a message to yourself has no buy or sell in it
      // (no direction) but it still paid a fee.
      if (txId && !existingFeeTxIds.has(txId) && Number.isFinite(blockTime) && blockTime > 0) {
        const feeSompi = feeSompiPaidBy(tx, address);
        if (feeSompi !== null) {
          feeCandidates.push({ txId, sompi: feeSompi, timestamp: blockTime, day: utcDayKey(blockTime) });
          existingFeeTxIds.add(txId);
        }
      }
      if (!txId || existingTxIds.has(txId) || !Number.isFinite(blockTime) || blockTime <= 0) continue;
      const direction = txDirectionForAddress(tx, address);
      if (!direction) continue;
      candidates.push({
        txId,
        isOutgoing: direction.isOutgoing,
        amountKas: Number(direction.amountSompi) / 1e8,
        timestamp: blockTime,
        day: utcDayKey(blockTime),
      });
    }
    if (!candidates.length && !feeCandidates.length) {
      finishAddressImport(historyResult.complete
        ? "No new transactions found for this address."
        : "Couldn't fetch this address's transactions. Check your connection and try again.");
      return;
    }

    // Prices the day cache already holds are applied for free (no network call at all); every
    // other row lands with the pending sentinel and is filled in by the backfill below. Fees are
    // priced in the same batch as the rows.
    const currency = currencyCode();
    const uniqueDays = [...new Set([...candidates.map((c) => c.day), ...feeCandidates.map((c) => c.day)])];
    const priceByDay = peekDailyPrices(uniqueDays, currency);

    // The portfolio the import started in - unless it was deleted meanwhile.
    const portfolio = state.portfolios.find((p) => p.id === targetPortfolioId) || activePortfolio();
    portfolio.transactions ||= [];
    let missingPriceCount = 0;
    for (const c of candidates) {
      const dayPrice = priceByDay[c.day];
      const priced = Number.isFinite(dayPrice);
      if (!priced) missingPriceCount += 1;
      portfolio.transactions.push({
        id: nowId(),
        type: c.isOutgoing ? "sell" : "buy",
        amountKas: c.amountKas,
        fiatValue: priced ? c.amountKas * dayPrice : 0,
        timestamp: c.timestamp,
        notes: priced ? null : PRICE_PENDING_NOTE,
        sourceAddress: address,
        sourceTxId: c.txId,
      });
    }
    for (const c of feeCandidates) {
      const dayPrice = priceByDay[c.day];
      fees.push({
        txId: c.txId,
        portfolioId: portfolio.id,
        sourceAddress: address,
        amountSompi: c.sompi,
        timestamp: c.timestamp,
        fiatValue: Number.isFinite(dayPrice) ? (c.sompi / 1e8) * dayPrice : null,
      });
    }
    // Saved BEFORE any pricing network call — this is the whole point: the ledger survives a
    // mid-import rate limit, whatever CoinGecko does next.
    saveState();
    if (feeCandidates.length) saveFees();
    render();

    // iOS PortfolioTransactionsView's import toast, in its order.
    finishAddressImport(
      `Imported ${candidates.length} transaction${candidates.length === 1 ? "" : "s"}`
      + (feeCandidates.length ? `. Network fees counted: ${feeCandidates.length}` : "")
      + (missingPriceCount ? `. Prices for ${missingPriceCount} are still loading and will fill in automatically` : "")
      + (historyResult.complete ? "" : ". Some history couldn't be fetched, re-add this address later to import the rest"),
    );
    startPriceBackfillIfNeeded();
  } catch {
    finishAddressImport("Import failed.");
  } finally {
    if (addressImport) { addressImport.busy = false; syncImportModal(); }
  }
}

// ---------------------------------------------------------------------------
// Background price backfill (iOS PortfolioViewModel.startPriceBackfillIfNeeded)
// ---------------------------------------------------------------------------

/** Any row still waiting on its price - from an address import, or a CSV re-import of one (which
 *  carries the marker but not the on-chain source). Only the date is needed (iOS 98f5009). */
function pendingPriceRows() {
  const rows = [];
  for (const p of state.portfolios) {
    for (const tx of p.transactions || []) {
      if (isPricePending(tx.notes)) rows.push(tx);
    }
  }
  return rows;
}

/** Fee records whose day's price is not known yet. */
function pendingPriceFees() {
  return fees.filter((fee) => !Number.isFinite(fee.fiatValue));
}

function hasPendingPrices() {
  return pendingPriceRows().length > 0 || pendingPriceFees().length > 0;
}

/** Prices auto-imported rows the import itself couldn't price. Runs a few passes on a growing
 *  backoff — each pass retries the batched range call first (cheap: cache + at most one request)
 *  and then walks the leftover days through the paced per-day fallback, saving every price the
 *  moment it lands so rows fill in incrementally rather than all-or-nothing. One loop at a time;
 *  re-triggering while it runs is a no-op (the running loop picks up any newly imported rows on
 *  its next pass). */
function startPriceBackfillIfNeeded() {
  if (priceBackfillTimer || !hasPendingPrices()) return;
  const accountKey = deps.accountScopedKey(PORTFOLIO_KEY);
  priceBackfillTimer = (async () => {
    for (const delay of [0, 30_000, 120_000, 300_000]) {
      if (delay > 0) await sleep(delay);
      // An account switch reloaded `state` out from under this loop — its rows are gone.
      if (deps.accountScopedKey(PORTFOLIO_KEY) !== accountKey || !hasPendingPrices()) break;
      await runPriceBackfillPass(accountKey);
    }
    priceBackfillTimer = null;
  })();
}

async function runPriceBackfillPass(accountKey) {
  const currency = currencyCode();
  const pending = pendingPriceRows();
  const pendingFees = pendingPriceFees();
  if (!pending.length && !pendingFees.length) return;
  const days = [...new Set([
    ...pending.map((tx) => utcDayKey(tx.timestamp)),
    ...pendingFees.map((fee) => utcDayKey(fee.timestamp)),
  ])];

  const prices = await resolveDailyPrices(days, currency);
  // Days the batched range couldn't cover (older than CoinGecko's keyless 365-day window, or
  // the range call failed): paced per-day fallback, newest first, capped per pass so one pass
  // stays bounded — the rest wait for the next pass.
  const missing = days.filter((day) => prices[day] === undefined).sort().reverse().slice(0, 30);
  for (const day of missing) {
    if (deps.accountScopedKey(PORTFOLIO_KEY) !== accountKey) return;
    const value = await resolveDailyPriceSingle(day, currency);
    if (value !== null) prices[day] = value;
    await sleep(PRICE_REQUEST_SPACING_MS);
  }

  if (deps.accountScopedKey(PORTFOLIO_KEY) !== accountKey) return;
  let changed = false;
  for (const p of state.portfolios) {
    for (const tx of p.transactions || []) {
      if (!isPricePending(tx.notes)) continue;
      const dayPrice = prices[utcDayKey(tx.timestamp)];
      if (!Number.isFinite(dayPrice)) continue;
      tx.fiatValue = (Number(tx.amountKas) || 0) * dayPrice;
      tx.notes = null;
      changed = true;
    }
  }
  if (changed) saveState();
  let feesChanged = false;
  for (const fee of fees) {
    if (Number.isFinite(fee.fiatValue)) continue;
    const dayPrice = prices[utcDayKey(fee.timestamp)];
    if (!Number.isFinite(dayPrice)) continue;
    fee.fiatValue = ((Number(fee.amountSompi) || 0) / 1e8) * dayPrice;
    feesChanged = true;
  }
  if (feesChanged) saveFees();
  if (changed || feesChanged) render();
}

// ---------------------------------------------------------------------------
// Modals (transaction editor + address import) — live outside rootEl so render() can't wipe them
// ---------------------------------------------------------------------------

function buildModals() {
  modalsEl = document.createElement("div");
  modalsEl.innerHTML = `
    <div class="modal-backdrop" data-portfolio-editor-modal hidden>
      <div class="contact-modal portfolio-editor-modal" role="dialog" aria-modal="true" aria-label="Transaction">
        <div class="modal-header">
          <div><p class="modal-kicker">Portfolio</p><h2 data-portfolio-editor-title>Add Transaction</h2></div>
          <button class="modal-close" type="button" data-portfolio-editor-close aria-label="Close">×</button>
        </div>
        <div class="portfolio-editor-body">
          <div class="settings-segmented full" role="group" aria-label="Type">
            <button type="button" class="settings-segmented-option active" data-portfolio-editor-type-option="buy">Buy</button>
            <button type="button" class="settings-segmented-option" data-portfolio-editor-type-option="sell">Sell</button>
            <button type="button" class="settings-segmented-option" data-portfolio-editor-type-option="transfer">Transfer</button>
          </div>
          <p class="field-hint" data-portfolio-editor-transfer-note hidden>KAS moved between your own addresses - sent away and brought back, or wallet to wallet. It doesn't change your holdings, cost or profit.</p>
          <input type="hidden" data-portfolio-editor-type value="buy" />
          <label class="portfolio-editor-field">
            <span>Quantity</span>
            <span class="portfolio-editor-unit-row"><input type="text" inputmode="decimal" placeholder="0.00" data-portfolio-editor-amount /><em>${KAS_UNIT}</em></span>
          </label>
          <label class="portfolio-editor-field">
            <span>Price Per Coin</span>
            <span class="portfolio-editor-unit-row"><em data-portfolio-editor-symbol>$</em><input type="text" inputmode="decimal" placeholder="0.00" data-portfolio-editor-price /></span>
          </label>
          <label class="portfolio-editor-field" data-portfolio-editor-fee-field>
            <span>Fee (optional)</span>
            <span class="portfolio-editor-unit-row"><em data-portfolio-editor-symbol>$</em><input type="text" inputmode="decimal" placeholder="0.00" data-portfolio-editor-fee /></span>
          </label>
          <label class="portfolio-editor-field">
            <span>Date</span>
            <input type="datetime-local" data-portfolio-editor-date />
          </label>
          <label class="portfolio-editor-field">
            <span>Notes (optional)</span>
            <textarea rows="2" maxlength="120" placeholder="Notes (optional)" data-portfolio-editor-notes></textarea>
          </label>
          <div class="portfolio-editor-field portfolio-editor-total"><span data-portfolio-editor-total-label>Total Spent</span><strong data-portfolio-editor-total>$0.00</strong></div>
          <button class="danger-button subtle full" type="button" data-portfolio-editor-delete hidden>Delete Transaction</button>
        </div>
        <div class="modal-actions portfolio-editor-actions">
          <button class="secondary-button" type="button" data-portfolio-editor-close>Cancel</button>
          <button class="primary-button" type="button" data-portfolio-editor-save disabled>Add</button>
        </div>
      </div>
    </div>

    <div class="modal-backdrop" data-portfolio-confirm-modal hidden>
      <div class="contact-modal portfolio-editor-modal" role="dialog" aria-modal="true" aria-label="Confirm" data-portfolio-confirm-body></div>
    </div>

    <div class="modal-backdrop" data-portfolio-name-modal hidden>
      <div class="contact-modal portfolio-editor-modal" role="dialog" aria-modal="true" aria-label="Name" data-portfolio-name-body></div>
    </div>

    <div class="modal-backdrop" data-portfolio-action-modal hidden>
      <div class="contact-modal portfolio-editor-modal" role="dialog" aria-modal="true" aria-label="Portfolio actions" data-portfolio-action-body></div>
    </div>

    <div class="modal-backdrop" data-portfolio-card-modal hidden>
      <div class="contact-modal portfolio-editor-modal" role="dialog" aria-modal="true" aria-label="Portfolio options" data-portfolio-card-body></div>
    </div>

    <div class="modal-backdrop" data-portfolio-move-modal hidden>
      <div class="contact-modal portfolio-editor-modal" role="dialog" aria-modal="true" aria-label="Move to Portfolio" data-portfolio-move-body></div>
    </div>

    <div class="modal-backdrop" data-portfolio-pair-modal hidden>
      <div class="contact-modal portfolio-editor-modal" role="dialog" aria-modal="true" aria-label="Compare Against" data-portfolio-pair-body></div>
    </div>

    <div class="modal-backdrop" data-portfolio-reorder-modal hidden>
      <div class="contact-modal portfolio-editor-modal" role="dialog" aria-modal="true" aria-label="Reorder Portfolios" data-portfolio-reorder-body></div>
    </div>

    <div class="modal-backdrop" data-portfolio-import-modal hidden>
      <div class="contact-modal portfolio-editor-modal" role="dialog" aria-modal="true" aria-label="Add Kaspa Address">
        <div class="modal-header">
          <div><h2 data-portfolio-import-title>Add Kaspa Address</h2></div>
          <button class="modal-close" type="button" data-portfolio-import-close aria-label="Close">×</button>
        </div>
        <div class="portfolio-editor-body">
          <input class="field-input portfolio-import-address" type="text" placeholder="kaspa:qr... or domain" aria-label="Kaspa address or domain" data-portfolio-import-address data-portfolio-import-manual spellcheck="false" autocomplete="off" autocapitalize="off" />
          <p class="portfolio-editor-hint" data-portfolio-import-status data-portfolio-import-manual></p>
          <div class="portfolio-import-buttons" data-portfolio-import-manual>
            <button class="cold-inline-link" type="button" data-portfolio-import-paste>Paste</button>
            <button class="cold-inline-link" type="button" data-portfolio-import-scan>Scan QR</button>
          </div>
          <p class="portfolio-import-note" data-portfolio-import-manual>Enter a Kaspa address or a domain like name.kachat (.kachat names are looked up first). Every received transaction on this address becomes a buy, every sent transaction becomes a sell, priced at that day's historical KAS price. Re-adding the same address later only imports transactions found since the last import.</p>
          <p class="portfolio-import-progress" data-portfolio-import-progress></p>
        </div>
        <div class="modal-actions" data-portfolio-import-manual>
          <button class="primary-button" type="button" data-portfolio-import-start>Import</button>
        </div>
      </div>
    </div>

    <input type="file" accept=".csv,.txt,text/csv,text/plain" data-portfolio-csv-input hidden />`;
  document.body.appendChild(modalsEl);

  modalsEl.addEventListener("click", async (event) => {
    if (event.target.closest("[data-portfolio-confirm-cancel]")) { settleConfirm(false); return; }
    if (event.target.closest("[data-portfolio-confirm-ok]")) { settleConfirm(true); return; }
    if (event.target.closest("[data-portfolio-name-cancel]")) { settleNamePrompt(null); return; }
    if (event.target.closest("[data-portfolio-name-ok]")) {
      settleNamePrompt(String(modalsEl.querySelector("[data-portfolio-name-input]")?.value || ""));
      return;
    }

    // --- Add and Import / Export sheet ---
    // These route into the same actions the old dropdown items ran. They belong here rather than
    // on the pane's own listener: modalsEl is appended to document.body, so a click inside the
    // sheet never bubbles through [data-portfolio-root] and nothing in it can be reached from there.
    if (event.target.closest("[data-portfolio-action-close]")) {
      modalsEl.querySelector("[data-portfolio-action-modal]").hidden = true;
      return;
    }
    const portfolioAction = event.target.closest("[data-portfolio-action]");
    if (portfolioAction) {
      modalsEl.querySelector("[data-portfolio-action-modal]").hidden = true;
      const which = portfolioAction.dataset.portfolioAction;
      if (which === "tx") openTxEditor(null);
      else if (which === "address") openAddressImport();
      else if (which === "chatting") { const own = chattingAddress(); if (own) openAddressImport(own); }
      else if (which === "export") exportCsv();
      else if (which === "import") modalsEl.querySelector("[data-portfolio-csv-input]")?.click();
      else if (which === "nc-export") exportToNextcloud();
      else if (which === "nc-import") importFromNextcloud();
      return;
    }

    // --- Compare Against sheet ---
    if (event.target.closest("[data-portfolio-pair-close]")) {
      modalsEl.querySelector("[data-portfolio-pair-modal]").hidden = true;
      return;
    }

    // --- Move to Portfolio sheet ---
    if (event.target.closest("[data-portfolio-move-close]")) { closeMoveSheet(); return; }
    const moveTo = event.target.closest("[data-portfolio-move-to]");
    if (moveTo) {
      if (!moveTo.disabled && movingTxId) moveTransaction(movingTxId, moveTo.dataset.portfolioMoveTo);
      return;
    }

    // --- Card settings overlay ---
    if (event.target.closest("[data-portfolio-card-close]")) {
      modalsEl.querySelector("[data-portfolio-card-modal]").hidden = true;
      cardModalId = null;
      return;
    }
    if (event.target.closest("[data-portfolio-card-back]")) { cardModalMode = "menu"; renderCardModal(); return; }
    const cardMode = event.target.closest("[data-portfolio-card-mode]");
    if (cardMode) {
      const mode = cardMode.dataset.portfolioCardMode;
      if (mode === "reorder") {
        // Reordering is about the whole set rather than this one card, so it hands over to its
        // own sheet instead of living as a step here.
        modalsEl.querySelector("[data-portfolio-card-modal]").hidden = true;
        reorderDraft = state.portfolios.map((p) => ({ id: p.id, name: p.name }));
        renderReorderModal();
        modalsEl.querySelector("[data-portfolio-reorder-modal]").hidden = false;
        return;
      }
      cardModalMode = mode;
      renderCardModal();
      return;
    }
    if (event.target.closest("[data-portfolio-card-rename-save]")) {
      const input = modalsEl.querySelector("[data-portfolio-card-name]");
      const name = String(input?.value || "").trim();
      const portfolio = state.portfolios.find((p) => p.id === cardModalId);
      if (portfolio && name) { portfolio.name = name; saveState(); }
      modalsEl.querySelector("[data-portfolio-card-modal]").hidden = true;
      cardModalId = null;
      render();
      return;
    }
    if (event.target.closest("[data-portfolio-card-delete-confirm]")) {
      const portfolio = state.portfolios.find((p) => p.id === cardModalId);
      if (portfolio && state.portfolios.length > 1) {
        state.portfolios = state.portfolios.filter((p) => p.id !== portfolio.id);
        if (state.activeId === portfolio.id) state.activeId = state.portfolios[0].id;
        saveState();
        forgetPortfolioFees(portfolio.id);
      }
      modalsEl.querySelector("[data-portfolio-card-modal]").hidden = true;
      cardModalId = null;
      render();
      return;
    }

    // --- Reorder ---
    if (event.target.closest("[data-portfolio-reorder-close]")) {
      modalsEl.querySelector("[data-portfolio-reorder-modal]").hidden = true;
      return;
    }
    const move = event.target.closest("[data-portfolio-move]");
    if (move) {
      const from = Number(move.dataset.index);
      const to = move.dataset.portfolioMove === "up" ? from - 1 : from + 1;
      if (to < 0 || to >= reorderDraft.length) return;
      [reorderDraft[from], reorderDraft[to]] = [reorderDraft[to], reorderDraft[from]];
      renderReorderModal();
      return;
    }
    if (event.target.closest("[data-portfolio-reorder-save]")) {
      // Reordered by id, so a portfolio added or removed while the sheet was open cannot be
      // dropped: anything not named in the draft keeps its place at the end.
      const order = reorderDraft.map((p) => p.id);
      const byId = new Map(state.portfolios.map((p) => [p.id, p]));
      const reordered = order.map((id) => byId.get(id)).filter(Boolean);
      for (const portfolio of state.portfolios) if (!order.includes(portfolio.id)) reordered.push(portfolio);
      state.portfolios = reordered;
      saveState();
      modalsEl.querySelector("[data-portfolio-reorder-modal]").hidden = true;
      render();
      return;
    }
    if (event.target.closest("[data-portfolio-editor-close]")) { closeTxEditor(); return; }
    if (event.target.closest("[data-portfolio-editor-save]")) { saveTxEditor(); return; }
    const typeOption = event.target.closest("[data-portfolio-editor-type-option]");
    if (typeOption) { setEditorType(typeOption.dataset.portfolioEditorTypeOption); return; }
    if (event.target.closest("[data-portfolio-editor-delete]")) {
      if (editingTx?.id && await confirmOverlay({ title: "Delete Transaction?", message: "This can't be undone." })) {
        const portfolio = activePortfolio();
        portfolio.transactions = (portfolio.transactions || []).filter((t) => t.id !== editingTx.id);
        saveState();
        closeTxEditor();
        render();
      }
      return;
    }
    if (event.target.closest("[data-portfolio-import-close]")) {
      if (!addressImport?.busy) closeAddressImportSheet();
      return;
    }
    // A pick under Other domains imports that service's address instead (iOS 6ac48a7).
    if (event.target.closest("[data-portfolio-import-other-domains]") && addressImport && !addressImport.busy) {
      const entry = pickOtherDomain(event, addressImport.nameResolutions);
      if (entry) {
        addressImport.resolvedAddress = entry.address;
        addressImport.resolvedDomain = entry.name;
        addressImport.selectedTld = entry.tld;
        addressImport.notFound = false;
        syncImportModal();
        return;
      }
    }
    if (event.target.closest("[data-portfolio-import-paste]")) {
      pasteIntoImportField();
      return;
    }
    if (event.target.closest("[data-portfolio-import-scan]")) {
      scanIntoImportField();
      return;
    }
    if (event.target.closest("[data-portfolio-import-start]")) {
      // Runs against the RESOLVED address when a KNS domain was typed, not the domain text.
      if (canImportAddress()) runAddressImport(importEffectiveAddress());
    }
  });

  modalsEl.addEventListener("change", (event) => {
    const toggle = event.target.closest("[data-portfolio-pair-toggle]");
    if (!toggle) return;
    setChartPair(toggle.checked ? toggle.dataset.portfolioPairToggle : null);
    renderPairSheet();
  });

  modalsEl.addEventListener("input", (event) => {
    // A name can't be saved blank (iOS disables Create / Save while the field is empty).
    if (event.target.matches("[data-portfolio-name-input]")) {
      const ok = modalsEl.querySelector("[data-portfolio-name-ok]");
      if (ok) ok.disabled = !event.target.value.trim();
    }
    if (event.target.matches("[data-portfolio-card-name]")) {
      const save = modalsEl.querySelector("[data-portfolio-card-rename-save]");
      if (save) save.disabled = !event.target.value.trim();
    }
    if (event.target.closest("[data-portfolio-editor-amount], [data-portfolio-editor-price], [data-portfolio-editor-fee]")) updateEditorHint();
    if (event.target.closest("[data-portfolio-import-address]")) handleImportInputChange(event.target.value);
  });

  modalsEl.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && event.target.closest("[data-portfolio-import-address]")) {
      event.preventDefault();
      if (canImportAddress()) runAddressImport(importEffectiveAddress());
    }
  });

  modalsEl.querySelector("[data-portfolio-csv-input]").addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    let imported = 0;
    try { imported = importCsvText(await file.text()); }
    catch { deps.showToast?.("Import failed. Check the CSV format"); return; }
    deps.showToast?.(imported > 0 ? `Imported ${imported} transaction${imported === 1 ? "" : "s"}` : "Import failed. Check the CSV format");
  });
}

// ---------------------------------------------------------------------------
// Data refresh
// ---------------------------------------------------------------------------

/** Best data already on hand for a range, so every render paints something instead of blanking:
 *  this session's fetch first, else the persisted copy for THAT range (even past its 10-minute
 *  TTL — a 3-month curve from an hour ago is still the right shape, and it beats showing another
 *  range's curve). Port of iOS's stale-while-refresh per-range painting. */
const SEVEN_DAY_RETRY_MS = [1500, 6000, 15000, 40000];
// The spot price used to be fetched once, with nothing persisted and no retry, and CoinGecko's
// keyless tier throttles the launch burst often enough that the Portfolio showed a dash until a
// manual refresh. The last price paints from disk (peekKasPrice); a failed fetch retries here.
let spotPriceRetryTimer = null;
function scheduleSpotPriceRetry(currency, attempt) {
  if (spotPriceRetryTimer || attempt >= SEVEN_DAY_RETRY_MS.length) return;
  spotPriceRetryTimer = window.setTimeout(async () => {
    spotPriceRetryTimer = null;
    if (currencyCode() !== currency || price) return;
    try {
      const result = await fetchKasPrice({ force: true, currency });
      if (currencyCode() !== currency) return;
      if (result) { price = result; render(); return; }
    } catch { /* still throttled */ }
    scheduleSpotPriceRetry(currency, attempt + 1);
  }, SEVEN_DAY_RETRY_MS[attempt]);
}
let sevenDayRetryTimer = null;
function scheduleSevenDayRetry(currency, attempt) {
  if (sevenDayRetryTimer || attempt >= SEVEN_DAY_RETRY_MS.length) return;
  sevenDayRetryTimer = window.setTimeout(async () => {
    sevenDayRetryTimer = null;
    if (currencyCode() !== currency || historyForRange(7).length) return;
    try {
      const points = await fetchKasPriceHistory(7, { currency, force: true });
      if (currencyCode() !== currency) return;
      if (points?.length) { historyByRange[7] = points; if (view === "main") render(); return; }
    } catch { /* still throttled */ }
    scheduleSevenDayRetry(currency, attempt + 1);
  }, SEVEN_DAY_RETRY_MS[attempt]);
}

function historyForRange(days) {
  const session = historyByRange[days];
  if (session?.length) return session;
  const base = baseDaysFor(days);
  if (base !== days && historyByRange[base]?.length) return cutPoints(historyByRange[base], days);
  const persisted = peekKasPriceHistory(days, currencyCode())?.points;
  if (persisted?.length) return persisted;
  const persistedBase = base !== days ? peekKasPriceHistory(base, currencyCode())?.points : null;
  return persistedBase?.length ? cutPoints(persistedBase, days) : [];
}

/** Drops every cached curve when the selected currency changes — EUR numbers must never be
 *  painted from the USD cache. Mirrors iOS handleSettingsChanged -> refreshPrice(). */
function syncCurrencyState() {
  const currency = currencyCode();
  if (historyCurrency === currency) return false;
  historyCurrency = currency;
  historyByRange = {};
  attemptedRanges = new Set();
  price = peekKasPrice(currency);
  return true;
}

// Ranges this session has already tried to fetch for the current currency — stops the
// "range changed while we were fetching" catch-up below from looping forever on a range whose
// fetch keeps failing.
let attemptedRanges = new Set();

async function refreshData({ force = false } = {}) {
  if (loading) return;
  // The hashrate card sits on the main screen, so its series is pulled with everything else -
  // best-effort, and it repaints itself when it lands rather than holding up the price refresh.
  fetchNetworkStats({ force }).then((stats) => { if (stats && view === "main") render(); }).catch(() => {});
  syncCurrencyState();
  if (force) attemptedRanges = new Set();
  const currency = historyCurrency;
  // Capture the range this refresh is fetching — a range tap mid-refresh must not mis-key the
  // cache write or repaint the new range with the old range's data.
  const days = rangeDays;
  attemptedRanges.add(days);
  loading = true;
  render(); // paints from cache immediately; the fetch below only ever upgrades it
  try {
    // Three base fetches cover every button (iOS 39adefe): the range is a local cut of its base.
    const base = baseDaysFor(days);
    const [priceResult, historyResult, ninetyResult] = await Promise.all([
      fetchKasPrice({ force, currency }),
      fetchKasPriceHistory(base, { currency, force }),
      base === 90 ? null : fetchKasPriceHistory(90, { currency, force }),
    ]);
    // A currency switch while this was in flight makes every result stale — drop it.
    if (currencyCode() !== currency) return;
    if (priceResult) price = priceResult;
    if (historyResult?.length) { historyByRange[base] = historyResult; if (base !== days) historyByRange[days] = cutPoints(historyResult, days); }
    if (base !== 90 && ninetyResult?.length) historyByRange[90] = ninetyResult;
    // The cards' seven-day window comes out of the 90-day base.
    if (historyByRange[90]?.length) historyByRange[7] = cutPoints(historyByRange[90], 7);
    if (pairActive) await loadPairSeries();
    // The Value card's 24h figure comes from the fixed 7-day curve. When that curve is still
    // empty - the launch burst tripped CoinGecko's keyless 429 and nothing is persisted yet -
    // the card said "not available yet" until the next launch. Retry it on a growing backoff
    // (iOS fa55d76): 1.5s, 6s, 15s, 40s, one in flight, dropped if the currency moves.
    if (!historyForRange(7).length) scheduleSevenDayRetry(currency, 0);
    if (!price) scheduleSpotPriceRetry(currency, 0);
  } finally {
    loading = false;
    render();
    // The user switched range or currency while this fetch was in flight, which made that tap's
    // own refreshData a no-op — go fetch what they're actually looking at now. Converges: a
    // currency switch resets attemptedRanges, and every pass records the range it tried.
    const currencyMoved = currencyCode() !== currency;
    const rangeUnfetched = rangeDays !== days && !historyByRange[rangeDays]?.length && !attemptedRanges.has(rangeDays);
    if (currencyMoved || rangeUnfetched) refreshData({ force: currencyMoved });
  }
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Nextcloud backup (NEXTCLOUD_SYNC.md §5 "Portfolios", iOS 11f1548)
// ---------------------------------------------------------------------------

/** This account's portfolios as the sync model sees them. */
function currentPortfolioSync() {
  return portfolioSyncFromDesktop(state.portfolios, fees, tombstones);
}

/** What the backup carries for this account: the archive's optional `portfolios`,
 *  `portfolioTransactions`, `portfolioFees` and `portfolioDeleted` keys, empty ones left out.
 *  An untouched "Portfolio 1" seed is never uploaded. */
export function portfolioArchive() {
  if (!deps) return {};
  return portfolioSyncToArchive(portfolioSyncForArchive(currentPortfolioSync()));
}

/** A restore: merges the archive's portfolios into this account's (per item the newest edit or
 *  deletion wins) and reloads. The caller has already refused a foreign wallet's archive. The
 *  active portfolio is this device's own and stays put when it survives. True when applied. */
export function importPortfolioArchive(archive) {
  if (!deps) return false;
  const incoming = portfolioSyncFromArchive(archive);
  if (isPortfolioSyncEmpty(incoming)) return false;
  const local = currentPortfolioSync();
  const merged = mergePortfolioSync([local, incoming]);
  // Compared in the merge's own order, so an archive that adds nothing writes nothing.
  if (!merged.portfolios.length || JSON.stringify(merged) === JSON.stringify(mergePortfolioSync([local]))) return false;
  const next = portfolioSyncToDesktop(merged);
  state.portfolios = next.portfolios;
  if (!state.portfolios.some((p) => p.id === state.activeId)) state.activeId = state.portfolios[0].id;
  fees = next.fees;
  tombstones = next.tombstones;
  // Written as is: a restore came FROM the backup, so nothing is stamped or marked to upload.
  writeState();
  try { localStorage.setItem(deps.accountScopedKey(FEES_KEY), JSON.stringify(fees)); } catch { /* quota */ }
  saveTombstones();
  savedPortfolios = snapshotPortfolios();
  render();
  startPriceBackfillIfNeeded();
  return true;
}

/** For a chooser's "Add to Portfolio" (Cold Storage): the available portfolios (id + name). */
export function listPortfolios() {
  ensureDefaultPortfolio();
  return state.portfolios.map((p) => ({ id: p.id, name: p.name, isActive: p.id === state.activeId }));
}

/// Which portfolios already hold this on-chain transaction, so a chooser can flag a duplicate
/// while the choice is still being made rather than silently double-counting it (iOS
/// `portfolioIdsContaining(sourceTxId:)`).
export function portfolioIdsContainingTx(sourceTxId) {
  ensureDefaultPortfolio();
  const target = String(sourceTxId || "").trim();
  if (!target) return new Set();
  const ids = new Set();
  for (const portfolio of state.portfolios) {
    if ((portfolio.transactions || []).some((tx) => tx.sourceTxId === target)) ids.add(portfolio.id);
  }
  return ids;
}

/// The KAS price on a given day in the reader's currency, for pricing a transaction at what it
/// was worth WHEN IT HAPPENED. Today's number on a transaction from last year silently misstates
/// every figure the portfolio derives from it.
export async function historicalKasPrice(timestamp) {
  try { return await resolveDailyPriceSingle(utcDayKey(timestamp), currencyCode()); }
  catch { return null; }
}

/** Appends a transaction to a specific portfolio (used by Cold Storage's Add to Portfolio). */
export function addTransactionToPortfolio(portfolioId, {
  type, amountKas, fiatValue = null, notes = null,
  timestamp = null, sourceTxId = null, sourceAddress = null,
} = {}) {
  const portfolio = state.portfolios.find((p) => p.id === portfolioId) || activePortfolio();
  (portfolio.transactions ||= []).push({
    id: nowId(),
    type: type === "sell" || type === "transfer" ? type : "buy",
    amountKas: Number(amountKas) || 0,
    fiatValue: Number(fiatValue) || 0,
    notes: notes || null,
    // The time it HAPPENED, not the time it was recorded - a chart replayed over the ledger puts
    // the transaction on the wrong day otherwise.
    timestamp: Number(timestamp) || Date.now(),
    // Recorded so a later add of the same transaction is recognised rather than double-counted.
    sourceTxId: sourceTxId || null,
    sourceAddress: sourceAddress || null,
  });
  saveState();
  render();
}

export function refreshPortfolio() {
  ensureDefaultPortfolio();
  view = "main"; // always land on the main portfolio screen when the tab is (re)opened
  render();
  refreshData();
  // Rows left unpriced by an import the browser was closed during (or by an older build with no
  // backfill at all) resume pricing here — same trigger point as iOS's setCurrentWallet.
  startPriceBackfillIfNeeded();
}

export function resetPortfolioForAccount() {
  closeActiveScanner(); // an account switch must never leave a camera running
  closeMoveSheet();     // its row belonged to the previous account
  loadState();
  ensureDefaultPortfolio();
  render();
  startPriceBackfillIfNeeded();
}

function closeCardMenus(except = null) {
  rootEl.querySelectorAll("[data-portfolio-card-actions]").forEach((el) => {
    if (el.dataset.portfolioCardActions !== except) el.hidden = true;
  });
  const io = rootEl.querySelector("[data-portfolio-io-dropdown]");
  if (io && except !== "io") io.hidden = true;
}

export function initPortfolio(dependencies) {
  deps = dependencies;
  rootEl = document.querySelector("[data-portfolio-root]");
  loadState();
  ensureDefaultPortfolio();
  buildModals();
  historyCurrency = currencyCode();
  const initialFiatLabel = modalsEl?.querySelector("[data-portfolio-editor-fiat-label]");
  if (initialFiatLabel) initialFiatLabel.textContent = `Total Value (${historyCurrency.toUpperCase()})`;

  // The converter's numbers sit at the right of wide fields, so a click usually lands left of the
  // text and the caret started before the number ("|1"). Editing starts at the end instead (iOS
  // c130dc1 KasConverterCard). After the click has placed its caret, and only if the field still
  // has focus.
  rootEl?.addEventListener("focusin", (event) => {
    const target = event.target;
    if (!target?.matches?.("[data-portfolio-conv-kas], [data-portfolio-conv-fiat]")) return;
    window.setTimeout(() => {
      if (document.activeElement !== target) return;
      const end = String(target.value || "").length;
      try { target.setSelectionRange(end, end); } catch { /* not a text field */ }
    }, 0);
  });

  // The converter and the mining estimate write into module state and refresh only the DERIVED
  // figure. Re-rendering the whole screen on each keystroke would take the caret with it.
  rootEl?.addEventListener("input", (event) => {
    const target = event.target;
    if (target.matches("[data-portfolio-conv-kas]") || target.matches("[data-portfolio-conv-fiat]")) {
      const typingKas = target.matches("[data-portfolio-conv-kas]");
      const rate = price?.price;
      regroupField(target);
      const amount = decimalInputValue(target.value);
      const other = rootEl.querySelector(typingKas ? "[data-portfolio-conv-fiat]" : "[data-portfolio-conv-kas]");
      if (typingKas) converterKas = target.value; else converterFiat = target.value;
      // Only the field being typed in is authoritative; the other is derived. Writing a rounded
      // value back through the rate is how a converter drifts.
      if (!Number.isFinite(amount) || amount <= 0 || !rate || rate <= 0) {
        if (other) other.value = "";
        if (typingKas) converterFiat = ""; else converterKas = "";
        return;
      }
      const derived = typingKas ? amount * rate : amount / rate;
      const text = converterFormat(derived);
      if (other) other.value = text;
      if (typingKas) converterFiat = text; else converterKas = text;
      return;
    }
    if (target.matches("[data-portfolio-hashrate-input]")) {
      regroupField(target);
      hashrateInput = target.value;
      const stats = peekNetworkStats();
      const daily = estimateDailyKas({
        yourHashrateHs: typedHashrateHs(),
        networkHashrateHs: stats?.currentHashrate,
        blockRewardKas: stats?.blockRewardKas,
      });
      // The block is replaced wholesale rather than patched cell by cell: an empty field shows a
      // prompt where the three rows would be, so there is not always a cell to write into.
      const block = rootEl.querySelector("[data-portfolio-payouts]");
      if (block) block.innerHTML = payoutBlockHtml(daily);
    }
  });

  document.addEventListener("click", (event) => {
    // Any click outside the portfolio pane's menus closes them.
    if (!rootEl || rootEl.contains(event.target)) return;
    closeCardMenus();
  });

  // Settings > Customization > Currency lives in ui/app.js, which fires this after persisting
  // the new choice. A currency switch while Portfolio is open must not merely reformat the
  // existing (wrong-currency) numbers, so every cached curve is dropped and refetched — iOS
  // does exactly this in PortfolioViewModel.handleSettingsChanged.
  document.addEventListener("kachat:currency-changed", () => {
    syncCurrencyState();
    // Bitcoin flips to dollars when the app itself counts in bitcoin (iOS alternateUnit), so the
    // pair's series has to follow the currency too.
    pairSeries = null;
    if (pairActive && pairUnit()) loadPairSeries().then(() => render()).catch(() => {});
    const fiatLabel = modalsEl?.querySelector("[data-portfolio-editor-fiat-label]");
    if (fiatLabel) fiatLabel.textContent = `Total Value (${currencyCode().toUpperCase()})`;
    render();
    refreshData({ force: true });
  });

  rootEl?.addEventListener("click", async (event) => {
    const cardMenu = event.target.closest("[data-portfolio-card-menu]");
    if (cardMenu) {
      cardModalId = cardMenu.dataset.portfolioCardMenu;
      cardModalMode = "menu";
      renderCardModal();
      modalsEl.querySelector("[data-portfolio-card-modal]").hidden = false;
      return;
    }

    if (event.target.closest("[data-portfolio-reorder]")) {
      closeCardMenus();
      reorderDraft = state.portfolios.map((p) => ({ id: p.id, name: p.name }));
      renderReorderModal();
      modalsEl.querySelector("[data-portfolio-reorder-modal]").hidden = false;
      return;
    }
    if (event.target.closest("[data-portfolio-add]")) {
      if (state.portfolios.length >= MAX_PORTFOLIOS) return;
      const name = await namePromptOverlay({ title: "New Portfolio", confirmLabel: "Create" });
      if (name?.trim()) {
        const p = { id: nowId(), name: name.trim(), createdAt: Date.now(), transactions: [] };
        state.portfolios.push(p);
        state.activeId = p.id;
        saveState(); render();
      }
      return;
    }

    const select = event.target.closest("[data-portfolio-select]");
    if (select) { state.activeId = select.dataset.portfolioSelect; exitSelectMode(); saveState(); render(); return; }

    const openSquare = event.target.closest("[data-portfolio-open]");
    if (openSquare) {
      exitSelectMode();
      view = openSquare.dataset.portfolioOpen;
      render();
      // Each screen pulls only what it needs, and repaints when it lands. Both are best-effort:
      // the screen stands without them rather than showing an error for a figure nobody asked for.
      if (view === "hashrate") fetchNetworkStats().then(() => { if (view === "hashrate") render(); }).catch(() => {});
      if (view === "price") {
        fetchKasMarketStats({ currency: deps.currencyCode?.().toLowerCase() || "usd" })
          .then(() => { if (view === "price") render(); }).catch(() => {});
      }
      return;
    }

    if (event.target.closest("[data-portfolio-back]")) { view = "main"; render(); return; }


    const unit = event.target.closest("[data-portfolio-hashrate-unit]");
    if (unit) { hashrateUnit = unit.dataset.portfolioHashrateUnit; render(); return; }

    const hashrateRange = event.target.closest("[data-portfolio-hashrate-range]");
    if (hashrateRange) { hashrateRangeDays = Number(hashrateRange.dataset.portfolioHashrateRange) || 0; render(); return; }
    const gear = event.target.closest("[data-portfolio-pair-gear]");
    if (gear) { openPairPicker(); return; }
    const flip = event.target.closest("[data-portfolio-pair-flip]");
    if (flip && pairUnit()) {
      pairActive = !pairActive;
      if (pairActive) loadPairSeries().then(() => render()).catch(() => {});
      render();
      return;
    }
    const range = event.target.closest("[data-portfolio-range]");
    if (range) {
      rangeDays = Number(range.dataset.portfolioRange) || 0;
      render();       // repaints the tapped range from cache right away, even mid-refresh
      refreshData();  // no-op while a refresh is in flight; that one finishes into its own range
      if (pairActive && pairUnit()) loadPairSeries().then(() => render()).catch(() => {});
      return;
    }

    if (event.target.closest("[data-portfolio-refresh]")) { refreshData({ force: true }); return; }

    if (event.target.closest("[data-portfolio-eye]")) {
      setAmountsHidden(!amountsHidden);
      render();
      return;
    }
    if (event.target.closest("[data-portfolio-select-toggle]")) {
      if (selecting) exitSelectMode(); else selecting = true;
      render();
      return;
    }
    if (event.target.closest("[data-portfolio-select-all]")) {
      const ids = [...rootEl.querySelectorAll("[data-portfolio-tx-select]")].map((el) => el.dataset.portfolioTxSelect);
      // One button for both directions, like iOS: when everything is already picked the only
      // thing left to want is to unpick it.
      if (selectedTxIds.size === ids.length) selectedTxIds.clear();
      else selectedTxIds = new Set(ids);
      render();
      return;
    }
    if (event.target.closest("[data-portfolio-delete-selected]")) {
      const count = selectedTxIds.size;
      if (count === 0) return;
      if (await confirmOverlay({
        title: `Delete ${count} Transaction${count === 1 ? "" : "s"}?`,
        message: "This can't be undone.",
      })) {
        const portfolio = activePortfolio();
        portfolio.transactions = (portfolio.transactions || []).filter((t) => !selectedTxIds.has(t.id));
        exitSelectMode();
        saveState(); render();
      }
      return;
    }
    const txSelect = event.target.closest("[data-portfolio-tx-select]");
    if (txSelect) {
      const id = txSelect.dataset.portfolioTxSelect;
      const on = !selectedTxIds.has(id);
      if (on) selectedTxIds.add(id); else selectedTxIds.delete(id);
      txSelect.classList.toggle("picked", on);
      txSelect.setAttribute("aria-pressed", String(on));
      const box = txSelect.querySelector(".portfolio-tx-check");
      if (box) { box.classList.toggle("on", on); box.textContent = on ? "\u2713" : ""; }
      refreshSelectionUi();
      return;
    }

    if (event.target.closest("[data-portfolio-add-menu]")) {
      actionSheetMode = "add";
      renderPortfolioActionSheet();
      modalsEl.querySelector("[data-portfolio-action-modal]").hidden = false;
      return;
    }

    if (event.target.closest("[data-portfolio-io-menu]")) {
      actionSheetMode = "io";
      renderPortfolioActionSheet();
      modalsEl.querySelector("[data-portfolio-action-modal]").hidden = false;
      return;
    }
    if (event.target.closest("[data-portfolio-export-csv]")) { closeCardMenus(); exportCsv(); return; }
    if (event.target.closest("[data-portfolio-import-csv]")) {
      closeCardMenus();
      modalsEl.querySelector("[data-portfolio-csv-input]")?.click();
      return;
    }
    if (event.target.closest("[data-portfolio-io-address]")) {
      closeCardMenus();
      openAddressImport();
      return;
    }
    const txDelete = event.target.closest("[data-portfolio-tx-delete]");
    if (txDelete) {
      if (await confirmOverlay({ title: "Delete Transaction?", message: "This can't be undone." })) {
        const portfolio = activePortfolio();
        portfolio.transactions = (portfolio.transactions || []).filter((t) => t.id !== txDelete.dataset.portfolioTxDelete);
        saveState(); render();
      }
      return;
    }

    const txEdit = event.target.closest("[data-portfolio-tx-edit]");
    if (txEdit) {
      // The click that ends a long press already opened the move sheet - it must not also open
      // the editor underneath it.
      if (suppressTxClick) { suppressTxClick = false; return; }
      openTxEditor(txEdit.dataset.portfolioTxEdit);
      return;
    }

    closeCardMenus();
  });

  // Hold a transaction row (~0.45s, iOS's minimumDuration) or right-click it: move it to another
  // portfolio. Only on rows that open the editor - in Select mode the row belongs to selection,
  // and neither gesture is attached (iOS TapToEdit). A press that drifts is a scroll, not a hold.
  let holdTimer = 0;
  let holdStart = null;
  let suppressTxClick = false;
  const cancelHold = () => { if (holdTimer) { window.clearTimeout(holdTimer); holdTimer = 0; } holdStart = null; };
  rootEl?.addEventListener("pointerdown", (event) => {
    cancelHold();
    suppressTxClick = false;
    if (event.button !== 0) return;
    const row = event.target.closest("[data-portfolio-tx-edit]");
    if (!row || event.target.closest("[data-portfolio-tx-delete]")) return;
    const txId = row.dataset.portfolioTxEdit;
    holdStart = { x: event.clientX, y: event.clientY };
    holdTimer = window.setTimeout(() => {
      holdTimer = 0;
      holdStart = null;
      suppressTxClick = true;
      openMoveSheet(txId);
    }, 450);
  });
  rootEl?.addEventListener("pointermove", (event) => {
    if (!holdStart) return;
    if (Math.abs(event.clientX - holdStart.x) > 8 || Math.abs(event.clientY - holdStart.y) > 8) cancelHold();
  });
  ["pointerup", "pointercancel", "pointerleave"].forEach((type) => rootEl?.addEventListener(type, cancelHold));
  rootEl?.addEventListener("contextmenu", (event) => {
    const row = event.target.closest("[data-portfolio-tx-edit]");
    if (!row) return;
    event.preventDefault();
    cancelHold();
    openMoveSheet(row.dataset.portfolioTxEdit);
  });

  render();
}
