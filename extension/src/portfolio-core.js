// Portfolio data, math, formatting and the price pipeline - the non-UI half of the iOS port
// (PortfolioModels, PortfolioManager, PortfolioLedgerStore, PortfolioViewModel,
// PortfolioAddressImporter, CoinGeckoService / MarketPairService / KaspaNetworkStatsService).
//
// Everything is scoped per wallet account, as iOS scopes it per wallet: one chrome.storage.local
// key holds the account's portfolios (up to 5) with their buy/sell rows. Prices go through the
// desktop engine (CoinGecko, Gate.io behind it, Yahoo for VOO / gold / silver), which keeps its
// own localStorage caches - the extension page's localStorage is per extension, so the caches
// survive closing the popup.

import { getLocal, setLocal, ext } from "./browser.js";
import * as vault from "./vault.js";
import { settings } from "./ui.js";
import {
  fetchKasPrice, peekKasPrice, fetchKasPriceHistory, peekKasPriceHistory, fetchKasMarketStats,
  baseDaysFor, cutPoints, yearToDateDays, CHART_PAIRS, fetchMarketPairHistory, dividePoints,
  resolveDailyPrices, resolveDailyPriceSingle, peekDailyPrices, utcDayKey, PRICE_REQUEST_SPACING_MS,
} from "../../engine/prices.js";
import { fetchNetworkStats, peekNetworkStats } from "../../engine/network-stats.js";
import { getEndpoint } from "../../engine/endpoints.js";

export { yearToDateDays, CHART_PAIRS, utcDayKey };

export const MAX_PORTFOLIOS = 5;
export const MASKED = "••••••";
/** iOS PortfolioAddressImporter.priceUnavailableNote and the older build's sentinel. */
export const PRICE_PENDING_NOTE = "Price loading, will fill in automatically";
const LEGACY_PRICE_UNAVAILABLE_NOTE = "Price unavailable — set manually";
export function isPricePending(notes) {
  return notes === PRICE_PENDING_NOTE || notes === LEGACY_PRICE_UNAVAILABLE_NOTE;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const HIDDEN_KEY = "kachat.portfolio.valuesHidden";   // iOS kachat_portfolio_values_hidden
const PAIR_KEY = "kachat.portfolio.chartPair";        // iOS kachat_chart_pair (absent = bitcoin, "" = none)
const storeKey = (accountId) => `kachat.portfolios.${accountId}`;
/** The fee records, beside the ledger (iOS kachat_portfolio_fees_<wallet>). */
const feesKey = (accountId) => `kachat.portfolioFees.${accountId}`;

/** buy, sell, or transfer - KAS moved between your own addresses, a record only. */
export const TYPES = ["buy", "sell", "transfer"];
const normalType = (type) => (TYPES.includes(type) ? type : "buy");

function uuid() {
  return (crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`).toUpperCase();
}

// --- listeners: the screens repaint when data or prices change ----------------------------------

const listeners = new Set();
/** fn(kind) - kind is "data", "price", "history", "hashrate" or "pair". Returns an unsubscribe. */
export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit(kind) { for (const fn of [...listeners]) { try { fn(kind); } catch (error) { console.warn("[Portfolio]", error); } } }

// =================================================================================================
// Store (iOS PortfolioManager + PortfolioLedgerStore)
// =================================================================================================

export const store = {
  accountId: null,
  currency: "usd",
  data: { activeId: null, portfolios: [] },
  /** PortfolioFeeRecord: { txId, portfolioId, sourceAddress, amountSompi (string), timestamp, fiatValue|null } */
  fees: [],
  valuesHidden: false,
  chartPair: "bitcoin",
  loaded: false,
};

function normalizeData(raw) {
  const portfolios = Array.isArray(raw?.portfolios) ? raw.portfolios.filter((p) => p && p.id) : [];
  portfolios.forEach((p, i) => {
    p.name = String(p.name || `Portfolio ${i + 1}`);
    p.createdAt = Number(p.createdAt) || Date.now();
    p.transactions = Array.isArray(p.transactions) ? p.transactions.filter((t) => t && t.id) : [];
    for (const t of p.transactions) {
      t.type = normalType(t.type);
      t.amountSompi = String(t.amountSompi ?? "0");
      t.fiatValue = Number(t.fiatValue) || 0;
      t.timestamp = Number(t.timestamp) || Date.now();
      t.portfolioId = p.id;
    }
  });
  // Sorted by sortOrder, then createdAt; renumbered 0..n-1 (PortfolioManager.load).
  portfolios.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.createdAt - b.createdAt);
  portfolios.forEach((p, i) => { p.sortOrder = i; });
  return { activeId: raw?.activeId || null, portfolios };
}

/**
 * Loads (or reloads) the active account's portfolios, the currency and the two device-wide
 * switches. Seeds "Portfolio 1" the first time. Cheap enough to call on every tab visit; it
 * returns what changed so the price caches can be reset on a currency switch.
 */
export async function loadStore() {
  const accounts = await vault.readAccounts().catch(() => null);
  const accountId = accounts?.activeAccountId || accounts?.accounts?.[0]?.id || "default";
  const currency = String((await settings()).currency || "usd").toLowerCase();
  const accountChanged = accountId !== store.accountId;
  const currencyChanged = store.loaded && currency !== store.currency;
  if (accountChanged || !store.loaded) {
    store.data = normalizeData(await getLocal(storeKey(accountId)));
    store.fees = normalizeFees(await getLocal(feesKey(accountId)));
    store.accountId = accountId;
  }
  store.currency = currency;
  const hidden = await getLocal(HIDDEN_KEY);
  store.valuesHidden = hidden === true;
  const pair = await getLocal(PAIR_KEY);
  store.chartPair = pair === undefined || pair === null ? "bitcoin" : (CHART_PAIRS[pair] ? pair : null);
  if (!store.data.portfolios.length) {
    store.data.portfolios.push({ id: uuid(), name: "Portfolio 1", sortOrder: 0, createdAt: Date.now(), transactions: [] });
    await save();
  }
  if (!store.data.portfolios.some((p) => p.id === store.data.activeId)) store.data.activeId = store.data.portfolios[0].id;
  store.loaded = true;
  if (currencyChanged) onCurrencyChanged();
  if (accountChanged) {
    backfillRunning = null; // the old account's loop notices and stops
    startPriceBackfillIfNeeded();
  }
  return { accountChanged, currencyChanged };
}

function normalizeFees(raw) {
  return (Array.isArray(raw) ? raw : []).filter((f) => f && f.txId && f.portfolioId).map((f) => ({
    txId: String(f.txId), portfolioId: f.portfolioId, sourceAddress: String(f.sourceAddress || ""),
    amountSompi: String(f.amountSompi ?? "0"), timestamp: Number(f.timestamp) || 0,
    fiatValue: f.fiatValue == null || !Number.isFinite(Number(f.fiatValue)) ? null : Number(f.fiatValue),
  }));
}

let lastSavedFees = "";
async function saveFees() {
  if (!store.accountId) return;
  lastSavedFees = JSON.stringify(store.fees);
  await setLocal(feesKey(store.accountId), store.fees);
}

let lastSaved = "";
export async function save() {
  if (!store.accountId) return;
  store.data.portfolios.forEach((p, i) => { p.sortOrder = i; });
  lastSaved = JSON.stringify(store.data);
  await setLocal(storeKey(store.accountId), store.data);
}

// The popup and a tab can both be open: a change saved by one shows up in the other.
ext?.storage?.onChanged?.addListener((changes, area) => {
  if (area !== "local" || !store.accountId) return;
  const feeChange = changes[feesKey(store.accountId)];
  if (feeChange?.newValue && JSON.stringify(feeChange.newValue) !== lastSavedFees) {
    store.fees = normalizeFees(feeChange.newValue);
    emit("data");
  }
  const change = changes[storeKey(store.accountId)];
  if (!change?.newValue || JSON.stringify(change.newValue) === lastSaved) return;
  const activeBefore = store.data.activeId;
  store.data = normalizeData(change.newValue);
  if (!store.data.portfolios.some((p) => p.id === store.data.activeId)) store.data.activeId = activeBefore;
  if (!store.data.portfolios.some((p) => p.id === store.data.activeId)) store.data.activeId = store.data.portfolios[0]?.id || null;
  emit("data");
});

export async function setValuesHidden(hidden) {
  store.valuesHidden = Boolean(hidden);
  await setLocal(HIDDEN_KEY, store.valuesHidden);
  emit("data");
}

export const portfolios = () => store.data.portfolios;
export const activeId = () => store.data.activeId;
export function activePortfolio() {
  return store.data.portfolios.find((p) => p.id === store.data.activeId) || store.data.portfolios[0];
}
export function portfolioById(id) { return store.data.portfolios.find((p) => p.id === id) || null; }

export async function setActivePortfolio(id) {
  if (!portfolioById(id)) return;
  store.data.activeId = id;
  await save();
  emit("data");
}

/** PortfolioManager.addPortfolio: at most 5; appended; becomes active. */
export async function addPortfolio(name) {
  const list = store.data.portfolios;
  if (list.length >= MAX_PORTFOLIOS) return null;
  const trimmed = String(name || "").trim() || `Portfolio ${list.length + 1}`;
  const portfolio = { id: uuid(), name: trimmed, sortOrder: list.length, createdAt: Date.now(), transactions: [] };
  list.push(portfolio);
  store.data.activeId = portfolio.id;
  await save();
  emit("data");
  return portfolio;
}

export async function renamePortfolio(id, name) {
  const trimmed = String(name || "").trim();
  const portfolio = portfolioById(id);
  if (!trimmed || !portfolio) return;
  portfolio.name = trimmed;
  await save();
  emit("data");
}

/** Never the last one; its rows go with it; the first remaining becomes active if needed. */
export async function deletePortfolio(id) {
  const list = store.data.portfolios;
  if (list.length <= 1) return;
  const index = list.findIndex((p) => p.id === id);
  if (index < 0) return;
  list.splice(index, 1);
  if (store.data.activeId === id) store.data.activeId = list[0].id;
  // Its fee records go with it (iOS forgetPortfolio), or they would linger under no portfolio.
  const before = store.fees.length;
  store.fees = store.fees.filter((f) => f.portfolioId !== id);
  if (store.fees.length !== before) await saveFees();
  await save();
  emit("data");
}

/** A full permutation of the current ids. */
export async function reorderPortfolios(ids) {
  const list = store.data.portfolios;
  if (ids.length !== list.length || !list.every((p) => ids.includes(p.id))) return;
  store.data.portfolios = ids.map((id) => portfolioById(id));
  await save();
  emit("data");
}

// --- transactions -------------------------------------------------------------------------------

export const amountKasOf = (tx) => Number(tx.amountSompi) / 1e8;

/** round(kas x 1e8), refused when not finite or out of Int64 range (PortfolioViewModel.sompi). */
export function kasToSompiString(kas) {
  const value = Math.round(Number(kas) * 1e8);
  if (!Number.isFinite(value) || Math.abs(value) >= 9.2e18) return null;
  return BigInt(value).toString();
}

export function scopedTransactions(portfolioId = store.data.activeId) {
  return portfolioById(portfolioId)?.transactions || [];
}

/** Newest first (transactionsDescending). */
export function transactionsDescending() {
  return [...scopedTransactions()].sort((a, b) => b.timestamp - a.timestamp);
}

export function findTransaction(id) {
  for (const p of store.data.portfolios) {
    const tx = p.transactions.find((t) => t.id === id);
    if (tx) return tx;
  }
  return null;
}

export async function addTransaction({ type, amountKas, fiatValue, timestamp, notes = null, portfolioId = store.data.activeId, sourceAddress = null, sourceTxId = null }) {
  const portfolio = portfolioById(portfolioId);
  const amountSompi = kasToSompiString(amountKas);
  if (!portfolio || amountSompi == null) return null;
  const tx = {
    id: uuid(), type: normalType(type), amountSompi, fiatValue: Number(fiatValue) || 0,
    timestamp: Number(timestamp) || Date.now(), notes: notes || null, portfolioId: portfolio.id,
  };
  if (sourceAddress) tx.sourceAddress = sourceAddress;
  if (sourceTxId) tx.sourceTxId = sourceTxId;
  portfolio.transactions.push(tx);
  await save();
  emit("data");
  return tx;
}

/**
 * iOS updateTransaction: the edited fields, in the row's own portfolio - and its sourceAddress /
 * sourceTxId kept, since they are how a re-import of the address recognises it (dropping them
 * made the next import add the same transaction again, undoing a sell re-marked a transfer).
 */
export async function updateTransaction(id, { type, amountKas, fiatValue, timestamp, notes }) {
  for (const p of store.data.portfolios) {
    const index = p.transactions.findIndex((t) => t.id === id);
    if (index < 0) continue;
    const amountSompi = kasToSompiString(amountKas);
    if (amountSompi == null) return;
    const previous = p.transactions[index];
    p.transactions[index] = {
      id, type: normalType(type), amountSompi, fiatValue: Number(fiatValue) || 0,
      timestamp: Number(timestamp) || Date.now(), notes: notes || null, portfolioId: p.id,
    };
    if (previous.sourceAddress) p.transactions[index].sourceAddress = previous.sourceAddress;
    if (previous.sourceTxId) p.transactions[index].sourceTxId = previous.sourceTxId;
    await save();
    emit("data");
    return;
  }
}

export async function deleteTransactions(ids) {
  const set = new Set(ids);
  for (const p of store.data.portfolios) p.transactions = p.transactions.filter((t) => !set.has(t.id));
  await save();
  emit("data");
}

/** Same id, same source - so a later Add to Portfolio still recognises it. */
export async function moveTransaction(id, toPortfolioId) {
  const target = portfolioById(toPortfolioId);
  if (!target) return;
  for (const p of store.data.portfolios) {
    const index = p.transactions.findIndex((t) => t.id === id);
    if (index < 0 || p.id === target.id) continue;
    const [tx] = p.transactions.splice(index, 1);
    tx.portfolioId = target.id;
    target.transactions.push(tx);
    await save();
    emit("data");
    return;
  }
}

/** Portfolios already holding a row recorded from this on-chain transaction. */
export function portfolioIdsContaining(sourceTxId) {
  const ids = new Set();
  if (!sourceTxId) return ids;
  for (const p of store.data.portfolios) if (p.transactions.some((t) => t.sourceTxId === sourceTxId)) ids.add(p.id);
  return ids;
}

// =================================================================================================
// Math (PortfolioViewModel's static functions)
// =================================================================================================

export function computeSummary(transactions, currentPrice) {
  let holdingsSompi = 0n;
  let boughtSompi = 0n;
  let totalInvested = 0;
  let totalProceeds = 0;
  for (const tx of transactions) {
    const amount = BigInt(tx.amountSompi || "0");
    if (tx.type === "sell") { holdingsSompi -= amount; totalProceeds += tx.fiatValue; }
    else if (tx.type === "buy") { holdingsSompi += amount; totalInvested += tx.fiatValue; boughtSompi += amount; }
    // transfer: your own KAS changing address - no holdings, cost or profit move
  }
  const holdingsKas = Number(holdingsSompi) / 1e8;
  const totalBoughtKas = Number(boughtSompi) / 1e8;
  const currentValue = holdingsKas * (currentPrice || 0);
  const totalPL = (currentValue + totalProceeds) - totalInvested;
  return {
    holdingsKas, totalInvested, totalProceeds, currentValue, totalPL,
    totalPLPercent: totalInvested > 0 ? (totalPL / totalInvested) * 100 : 0,
    averageBuyPrice: totalBoughtKas > 0 ? totalInvested / totalBoughtKas : null,
  };
}

/** Holdings as of each price point (rows at or before it) times that point's price. */
export function valueHistory(transactions, points) {
  if (!points?.length) return [];
  const sorted = [...transactions].sort((a, b) => a.timestamp - b.timestamp);
  let holdings = 0n;
  let i = 0;
  return points.map(([ts, price]) => {
    while (i < sorted.length && sorted[i].timestamp <= ts) {
      const amount = BigInt(sorted[i].amountSompi || "0");
      if (sorted[i].type === "sell") holdings -= amount;
      else if (sorted[i].type === "buy") holdings += amount;
      i += 1;
    }
    return [ts, (Number(holdings) / 1e8) * price];
  });
}

/**
 * FIFO realized profit and loss for the sells dated in `year` (computeRealizedPL). Every buy, from
 * any year, is a lot; each sell, from any year, takes from the oldest lots first, but only this
 * year's sells add to the result. Same timestamp: the buy goes first. A sell larger than the lots
 * left counts the rest at zero cost (uncoveredKas). Transfers are skipped.
 */
export function computeRealizedPL(transactions, year) {
  const result = { year, proceeds: 0, costBasis: 0, sellCount: 0, uncoveredKas: 0, pendingPriceCount: 0, amount: 0 };
  const lots = [];
  let lotStart = 0;
  let uncovered = 0n;
  const ordered = [...transactions].sort((a, b) => (a.timestamp === b.timestamp
    ? (a.type === "buy" && b.type === "sell" ? -1 : b.type === "buy" && a.type === "sell" ? 1 : 0)
    : a.timestamp - b.timestamp));
  for (const tx of ordered) {
    const sompi = BigInt(tx.amountSompi || "0");
    if (tx.type === "buy") {
      if (sompi <= 0n) continue;
      lots.push({ sompi, costPerSompi: tx.fiatValue / Number(sompi) });
      if (isPricePending(tx.notes)) result.pendingPriceCount += 1;
    } else if (tx.type === "sell") {
      let remaining = sompi;
      let cost = 0;
      while (remaining > 0n && lotStart < lots.length) {
        const lot = lots[lotStart];
        const take = remaining < lot.sompi ? remaining : lot.sompi;
        cost += Number(take) * lot.costPerSompi;
        lot.sompi -= take;
        remaining -= take;
        if (lot.sompi === 0n) lotStart += 1;
      }
      if (new Date(tx.timestamp).getFullYear() !== year) continue;
      result.proceeds += tx.fiatValue;
      result.costBasis += cost;
      result.sellCount += 1;
      if (remaining > 0n) uncovered += remaining;
      if (isPricePending(tx.notes)) result.pendingPriceCount += 1;
    }
  }
  result.uncoveredKas = Number(uncovered) / 1e8;
  result.amount = result.proceeds - result.costBasis;
  return result;
}

export function realizedPLThisYear() {
  return computeRealizedPL(scopedTransactions(), new Date().getFullYear());
}

/** The Fees Spent card's numbers for the active portfolio. */
export function feeSummary(portfolioId = store.data.activeId) {
  const summary = { totalKas: 0, totalFiat: 0, count: 0, unpricedCount: 0 };
  for (const fee of store.fees) {
    if (fee.portfolioId !== portfolioId) continue;
    summary.totalKas += Number(fee.amountSompi) / 1e8;
    summary.count += 1;
    if (fee.fiatValue == null) summary.unpricedCount += 1; else summary.totalFiat += fee.fiatValue;
  }
  return summary;
}

/** Fees are fractions of a KAS: en_US grouping, 2 to 8 decimals. */
export function feeKas(value) {
  return `${Number(value || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 8 })} KAS`;
}

export function rangeChange(points) {
  if (!points || points.length < 2) return null;
  const first = points[0][1];
  const amount = points[points.length - 1][1] - first;
  return { amount, percent: first === 0 ? 0 : (amount / first) * 100 };
}

/** The last point vs the last point at least 24h before it; null without such a point. */
export function todayChangeOf(points) {
  if (!points?.length) return null;
  const [latestTs, latest] = points[points.length - 1];
  let base = null;
  for (const point of points) { if (point[0] <= latestTs - 86_400_000) base = point; else break; }
  if (!base) return null;
  const amount = latest - base[1];
  return { amount, percent: base[1] === 0 ? 0 : (amount / base[1]) * 100 };
}

/** Caps a series at 288 points: 144 buckets keeping each one's min and max, plus the true ends. */
export function downsample(points, maxPoints = 288) {
  if (!points || points.length <= maxPoints) return points || [];
  const buckets = maxPoints / 2;
  const size = (points.length - 2) / buckets;
  const out = [points[0]];
  for (let b = 0; b < buckets; b += 1) {
    const start = 1 + Math.floor(b * size);
    const end = Math.min(points.length - 1, 1 + Math.floor((b + 1) * size));
    if (end <= start) continue;
    let min = start; let max = start;
    for (let i = start; i < end; i += 1) {
      if (points[i][1] < points[min][1]) min = i;
      if (points[i][1] > points[max][1]) max = i;
    }
    if (min === max) out.push(points[min]);
    else if (min < max) out.push(points[min], points[max]);
    else out.push(points[max], points[min]);
  }
  out.push(points[points.length - 1]);
  return out;
}

// =================================================================================================
// Formatting (PortfolioFormat)
// =================================================================================================

const symbolCache = {};
export function currencySymbol(code = store.currency) {
  const cur = String(code || "usd").toLowerCase();
  if (cur === "btc") return "₿";
  if (symbolCache[cur]) return symbolCache[cur];
  let symbol = cur.toUpperCase();
  try {
    symbol = new Intl.NumberFormat(undefined, { style: "currency", currency: cur.toUpperCase() })
      .formatToParts(0).find((part) => part.type === "currency")?.value || symbol;
  } catch { /* unknown code: the code itself */ }
  symbolCache[cur] = symbol;
  return symbol;
}

const fixed = (value, decimals) => Number(value).toFixed(decimals);
const grouped2 = (value) => Math.abs(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function bitcoin(value) {
  const magnitude = Math.abs(value);
  let decimals = 8;
  if (magnitude > 0 && magnitude < 0.0001) decimals = Math.min(12, Math.max(8, Math.ceil(-Math.log10(magnitude)) + 3));
  return `${value < 0 ? "-" : ""}₿${fixed(magnitude, decimals)}`;
}

/** Sign, symbol, two grouped decimals: -$1,234.56 (bitcoin: eight decimals). */
export function currency(value, code = store.currency) {
  if (code === "btc") return bitcoin(value);
  return `${value < 0 ? "-" : ""}${currencySymbol(code)}${grouped2(value)}`;
}

/** Per-KAS price: five decimals under 1, else two, no grouping. */
export function price(value, code = store.currency) {
  if (code === "btc") return bitcoin(value);
  return `${currencySymbol(code)}${fixed(value, value < 1 ? 5 : 2)}`;
}

export function pairAmount(value, pair) {
  if (pair === "bitcoin") return bitcoin(value);
  const magnitude = Math.abs(value);
  let decimals = 4;
  if (magnitude > 0 && magnitude < 0.001) decimals = Math.min(12, Math.max(4, Math.ceil(-Math.log10(magnitude)) + 3));
  const suffix = pair === "voo" ? " VOO" : " oz";
  return `${value < 0 ? "-" : ""}${fixed(magnitude, decimals)}${suffix}`;
}

export function compactCurrency(value, code = store.currency) {
  const magnitude = Math.abs(value);
  const [scaled, suffix] = magnitude >= 1e12 ? [magnitude / 1e12, "T"] : magnitude >= 1e9 ? [magnitude / 1e9, "B"]
    : magnitude >= 1e6 ? [magnitude / 1e6, "M"] : magnitude >= 1e3 ? [magnitude / 1e3, "K"] : [magnitude, ""];
  const decimals = scaled < 10 ? 2 : scaled < 100 ? 1 : 0;
  return `${value < 0 ? "-" : ""}${currencySymbol(code)}${fixed(scaled, decimals)}${suffix}`;
}

/** en_US grouping, 0-4 decimals, " KAS". */
export function kas(value) {
  return `${Number(value || 0).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 4 })} KAS`;
}

/** A chart unit: { kind: "currency", code } or { kind: "pair", pair }. */
export function unitCode(unit) { return unit.kind === "currency" ? unit.code.toUpperCase() : CHART_PAIRS[unit.pair].code; }
export function priceIn(value, unit) { return unit.kind === "currency" ? price(value, unit.code) : pairAmount(value, unit.pair); }
export function amountIn(value, unit) { return unit.kind === "currency" ? currency(value, unit.code) : pairAmount(value, unit.pair); }

export function percentText(value) { return `${fixed(Math.abs(value), 2)}%`; }

/** "Mar 5, 2026 at 3:42 PM" - .abbreviated date, .shortened time. */
export function dateTimeText(ms) {
  const d = new Date(ms);
  return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })} at ${d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
}

/** "%.8f" (or maxDecimals) with trailing zeros trimmed down to two decimals. */
export function trimmedTwo(value, maxDecimals = 8) {
  let text = Number(value).toFixed(maxDecimals);
  while (text.endsWith("0") && (text.split(".")[1] || "").length > 2) text = text.slice(0, -1);
  return text;
}

/** "%.8f" with every trailing zero and a trailing "." trimmed (the editor's prefill). */
export function trimmedAll(value) {
  let text = Number(value).toFixed(8);
  while (text.endsWith("0")) text = text.slice(0, -1);
  if (text.endsWith(".")) text = text.slice(0, -1);
  return text;
}

// --- number input (PortfolioNumber.parse, DecimalInputFormat) -----------------------------------

export function parsePortfolioNumber(text) {
  let cleaned = String(text ?? "").replace(/[^0-9,.\-]/g, "");
  if (!cleaned) return null;
  const commas = (cleaned.match(/,/g) || []).length;
  const dots = (cleaned.match(/\./g) || []).length;
  if (commas > 0 && dots > 0) {
    if (cleaned.lastIndexOf(",") > cleaned.lastIndexOf(".")) cleaned = cleaned.replace(/\./g, "").replace(/,/g, ".");
    else cleaned = cleaned.replace(/,/g, "");
  } else if (commas > 0) {
    const parts = cleaned.split(",");
    cleaned = commas === 1 && parts.length === 2 && parts[1].length !== 3 ? cleaned.replace(",", ".") : cleaned.replace(/,/g, "");
  } else if (dots > 1) {
    cleaned = cleaned.replace(/\./g, "");
  }
  if (!/^-?(\d+\.?\d*|\.\d+)$/.test(cleaned)) return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

const SEPARATORS = (() => {
  try {
    const parts = new Intl.NumberFormat(undefined).formatToParts(1234.5);
    return { group: parts.find((p) => p.type === "group")?.value || ",", decimal: parts.find((p) => p.type === "decimal")?.value || "." };
  } catch { return { group: ",", decimal: "." }; }
})();

export function groupedInput(text) {
  const { group, decimal } = SEPARATORS;
  const normalized = String(text ?? "").split(group).join("");
  const index = normalized.indexOf(decimal);
  const whole = index >= 0 ? normalized.slice(0, index) : normalized;
  const fraction = index >= 0 ? normalized.slice(index + 1) : null;
  const digits = whole.replace(/\D/g, "");
  if (!digits) return normalized;
  let formatted;
  try { formatted = BigInt(digits).toLocaleString(undefined); } catch { formatted = digits; }
  if (fraction !== null) return `${formatted}${decimal}${fraction}`;
  return normalized.endsWith(decimal) ? `${formatted}${decimal}` : formatted;
}

export function groupedFromCanonical(text) {
  return groupedInput(String(text ?? "").replace(".", SEPARATORS.decimal));
}

export function inputValue(text) {
  const { group, decimal } = SEPARATORS;
  const bare = String(text ?? "").split(group).join("").replace(decimal, ".").replace(",", ".");
  if (!bare.trim()) return null;
  const value = Number(bare);
  return Number.isFinite(value) ? value : null;
}

/** Rewrites a field grouped while keeping the caret on the same digit. */
export function regroupField(input) {
  const before = input.value;
  const caret = input.selectionStart ?? before.length;
  const digitsBefore = before.slice(0, caret).replace(/\D/g, "").length;
  const after = groupedInput(before);
  if (after === before) return false;
  input.value = after;
  let pos = 0; let seen = 0;
  while (pos < after.length && seen < digitsBefore) { if (/\d/.test(after[pos])) seen += 1; pos += 1; }
  try { input.setSelectionRange(pos, pos); } catch { /* not a text field */ }
  return true;
}

// =================================================================================================
// Prices (PortfolioViewModel's price pipeline)
// =================================================================================================

export const market = {
  price: null,            // { price, change24h, fetchedAt } in store.currency
  marketCap: null,
  rank: null,
  rangeDays: 1,           // 1D by default, not persisted (quirk 7)
  baseCache: {},          // base days -> raw points, this session, this currency
  sevenDay: [],           // the cards' 7-day series (downsampled)
  flipped: false,
  altPrice: null,
  altCache: {},           // `${unitKey}:${base}` -> raw points
  altPriceAt: 0,
  epoch: 0,
};

const HISTORY_TTL = 10 * 60_000;
const SPOT_STALE = 5 * 60_000;

function onCurrencyChanged() {
  market.epoch += 1;
  market.flipped = false;
  market.price = peekKasPrice(store.currency);
  market.marketCap = null;
  market.rank = null;
  market.baseCache = {};
  market.sevenDay = [];
  market.altCache = {};
  market.altPrice = null;
  refreshPrice();
}

export const rangeLabel = (days) => {
  if (days === 0) return "All";
  if (days === 1) return "24h";
  const ytd = yearToDateDays();
  if (days === ytd) return "YTD";
  if (days === 7) return "1W";
  if (days === 30) return "1M";
  if (days === 90) return "3M";
  if (days === 365) return "1Y";
  return `${days}d`;
};

/** The price series the selected range draws (app currency), cut from its base and thinned. */
export function priceHistory(days = market.rangeDays) {
  const base = market.baseCache[baseDaysFor(days)];
  return base ? downsample(cutPoints(base, days)) : [];
}

/** Paints the persisted spot price first (iOS restores kachat_kas_price_<cur>), then refreshes. */
export function primeFromCache() {
  if (!market.price) market.price = peekKasPrice(store.currency);
}

let spotRetry = null;
let spotFetching = null;
/** The spot price, market stats, the selected range (forced), the 7-day series and the pair. */
export async function refreshPrice({ force = true } = {}) {
  const epoch = market.epoch;
  const cur = store.currency;
  if (!spotFetching) {
    spotFetching = (async () => {
      const result = await fetchKasPrice({ currency: cur, force: true });
      return result;
    })().finally(() => { spotFetching = null; });
  }
  const before = market.price?.fetchedAt || 0;
  const result = await spotFetching;
  if (epoch !== market.epoch) return;
  if (result && result.fetchedAt > before) {
    market.price = result;
    clearTimeout(spotRetry?.timer);
    spotRetry = null;
    emit("price");
  } else {
    scheduleSpotRetry();
  }
  fetchKasMarketStats({ currency: cur, force }).then((stats) => {
    if (epoch !== market.epoch || !stats) return;
    market.marketCap = stats.marketCap ?? null;
    market.rank = stats.rank ?? null;
    emit("price");
  });
  ensureHistory(market.rangeDays, { force });
  ensureSevenDay();
  if (market.flipped) ensureAltSeries({ force });
}

function scheduleSpotRetry() {
  const delays = [3, 8, 20, 45, 90, 180];
  const attempt = spotRetry ? spotRetry.attempt + 1 : 0;
  if (attempt >= delays.length) return;
  clearTimeout(spotRetry?.timer);
  spotRetry = { attempt, timer: setTimeout(() => { refreshSpotOnly(); }, delays[attempt] * 1000) };
}

async function refreshSpotOnly() {
  const epoch = market.epoch;
  const before = market.price?.fetchedAt || 0;
  const result = await fetchKasPrice({ currency: store.currency, force: true });
  if (epoch !== market.epoch) return;
  if (result && result.fetchedAt > before) { market.price = result; spotRetry = null; emit("price"); }
  else scheduleSpotRetry();
}

/** On appear / foreground: refetch when the price is missing or older than five minutes. */
export function refreshSpotPriceIfStale() {
  primeFromCache();
  if (!market.price || Date.now() - (market.price.fetchedAt || 0) > SPOT_STALE) refreshPrice({ force: false });
  else {
    // Still fresh: the ranges and cards may need their series (first visit this session).
    ensureHistory(market.rangeDays);
    ensureSevenDay();
    if (market.rank == null) fetchKasMarketStats({ currency: store.currency }).then((stats) => {
      if (!stats) return;
      market.marketCap = stats.marketCap ?? null; market.rank = stats.rank ?? null; emit("price");
    });
  }
}

/** Pull to refresh (refreshPriceAsync): every range cache dropped, then everything refetched. */
export async function pullRefresh() {
  market.baseCache = {};
  market.altCache = {};
  await refreshPrice({ force: true });
}

const inFlight = {};
/** Stale-while-refresh for the base a range is cut from (fetchPriceHistory). */
export function ensureHistory(days, { force = false } = {}) {
  const base = baseDaysFor(days);
  const cur = store.currency;
  const epoch = market.epoch;
  if (!force && market.baseCache[base]) return;
  const persisted = peekKasPriceHistory(base, cur);
  if (persisted && !market.baseCache[base]) {
    market.baseCache[base] = persisted.points;
    if (base === 90) deriveSevenDay();
    emit("history");
    if (!force && Date.now() - persisted.fetchedAt < HISTORY_TTL) return;
  }
  const key = `${cur}:${base}`;
  if (inFlight[key]) return;
  inFlight[key] = (async () => {
    for (const [attempt, delay] of [0, 4000, 12000, 30000].entries()) {
      if (delay) await sleep(delay);
      if (epoch !== market.epoch) return;
      // Retries continue only while that base is still the one on screen.
      if (attempt > 0 && baseDaysFor(market.rangeDays) !== base) return;
      const started = Date.now();
      const points = await fetchKasPriceHistory(base, { currency: cur, force: true });
      if (epoch !== market.epoch) return;
      const fresh = peekKasPriceHistory(base, cur);
      if (points.length && fresh && fresh.fetchedAt >= started) {
        market.baseCache[base] = points;
        if (base === 90) deriveSevenDay();
        emit("history");
        return;
      }
    }
  })().finally(() => { delete inFlight[key]; });
}

function deriveSevenDay() {
  const base = market.baseCache[90];
  if (!base?.length) return;
  market.sevenDay = downsample(cutPoints(base, 7));
}

let sevenDayInFlight = null;
/** The cards' 7-day series: the 90-day base when it is here, else days=7 (retries 1.5/6/15/40 s). */
export function ensureSevenDay() {
  if (market.baseCache[90]) { deriveSevenDay(); return; }
  const persisted = peekKasPriceHistory(7, store.currency);
  if (persisted && !market.sevenDay.length) {
    market.sevenDay = downsample(persisted.points);
    emit("history");
    if (Date.now() - persisted.fetchedAt < HISTORY_TTL) return;
  }
  if (sevenDayInFlight) return;
  const epoch = market.epoch;
  const cur = store.currency;
  sevenDayInFlight = (async () => {
    for (const delay of [0, 1500, 6000, 15000, 40000]) {
      if (delay) await sleep(delay);
      if (epoch !== market.epoch || market.baseCache[90]) return;
      const started = Date.now();
      const points = await fetchKasPriceHistory(7, { currency: cur, force: true });
      const fresh = peekKasPriceHistory(7, cur);
      if (epoch !== market.epoch) return;
      if (points.length && fresh && fresh.fetchedAt >= started) {
        market.sevenDay = downsample(points);
        emit("history");
        return;
      }
    }
  })().finally(() => { sevenDayInFlight = null; });
}

export function setRangeDays(days) {
  market.rangeDays = days;
  ensureHistory(days);
  if (market.flipped) ensureAltSeries();
  emit("history");
}

// --- chart pair flip --------------------------------------------------------------------------

/** What a flip shows: bitcoin (USD when the app counts in bitcoin), or VOO / gold / silver. */
export function alternateUnit() {
  const pair = store.chartPair;
  if (!pair) return null;
  if (pair === "bitcoin") return { kind: "currency", code: store.currency === "btc" ? "usd" : "btc" };
  return { kind: "pair", pair };
}
export const canFlip = () => alternateUnit() != null;
export function chartUnit() {
  return (market.flipped ? alternateUnit() : null) || { kind: "currency", code: store.currency };
}
const unitKey = (unit) => (unit.kind === "currency" ? `cur-${unit.code}` : `pair-${unit.pair}`);

export function chartPriceHistory(days = market.rangeDays) {
  if (market.flipped && canFlip()) {
    const raw = market.altCache[`${unitKey(alternateUnit())}:${baseDaysFor(days)}`];
    return raw ? downsample(cutPoints(raw, days)) : [];
  }
  return priceHistory(days);
}
export function chartCurrentPrice() {
  return market.flipped && canFlip() ? market.altPrice : market.price?.price ?? null;
}

export function flipChart() {
  if (!canFlip()) return;
  market.flipped = !market.flipped;
  if (market.flipped) ensureAltSeries();
  emit("pair");
}

export async function setChartPair(pair) {
  store.chartPair = pair && CHART_PAIRS[pair] ? pair : null;
  await setLocal(PAIR_KEY, store.chartPair || "");
  market.flipped = false;
  market.altPrice = null;
  emit("pair");
}

const altInFlight = {};
/** The flipped series and its latest price (iOS loadAlternateSeries). */
export function ensureAltSeries({ force = false } = {}) {
  const unit = alternateUnit();
  if (!unit) return;
  const base = baseDaysFor(market.rangeDays);
  const key = `${unitKey(unit)}:${base}`;
  const epoch = market.epoch;
  const needPrice = force || market.altPrice == null || Date.now() - market.altPriceAt > SPOT_STALE;
  if (!force && market.altCache[key] && !needPrice) return;
  if (altInFlight[key]) return;
  altInFlight[key] = (async () => {
    const delays = [0, 4000, 12000, 30000];
    for (const [attempt, delay] of delays.entries()) {
      if (delay) await sleep(delay);
      if (epoch !== market.epoch || unitKey(alternateUnit() || {}) !== unitKey(unit)) return;
      let points = [];
      let latest = null;
      if (unit.kind === "currency") {
        const [history, spot] = await Promise.all([
          !force && market.altCache[key] ? market.altCache[key] : fetchKasPriceHistory(base, { currency: unit.code }),
          fetchKasPrice({ currency: unit.code, force }),
        ]);
        points = history; latest = spot?.price ?? null;
      } else {
        const [kasUsd, pair, spotUsd] = await Promise.all([
          fetchKasPriceHistory(base, { currency: "usd" }),
          fetchMarketPairHistory(unit.pair, base),
          fetchKasPrice({ currency: "usd" }),
        ]);
        points = dividePoints(kasUsd, pair.points);
        latest = spotUsd?.price && pair.latest > 0 ? spotUsd.price / pair.latest : null;
      }
      if (epoch !== market.epoch) return;
      if (points.length) market.altCache[key] = points;
      if (latest != null) { market.altPrice = latest; market.altPriceAt = Date.now(); }
      // Every retry spent and still no spot price (CoinGecko rate limiting): the series' own
      // latest point stands in, rather than a dash beside a chart that has the figure.
      else if (attempt === delays.length - 1 && points.length && market.altPrice == null) market.altPrice = points[points.length - 1][1];
      emit("pair");
      if (points.length && latest != null) return;
    }
  })().finally(() => { delete altInFlight[key]; });
}

// --- per-portfolio derived numbers --------------------------------------------------------------

export function summaryFor(portfolioId = store.data.activeId) {
  return computeSummary(scopedTransactions(portfolioId), market.price?.price ?? 0);
}

export function todayChangeFor(portfolioId) {
  return todayChangeOf(valueHistory(scopedTransactions(portfolioId), market.sevenDay));
}

/** The Value Over Time series: drawn price series x the active ledger; All starts a day before
 *  the first transaction when at least two points remain. */
export function chartValueHistory() {
  const txs = scopedTransactions();
  let points = valueHistory(txs, chartPriceHistory());
  if (market.rangeDays === 0 && txs.length) {
    const first = Math.min(...txs.map((t) => t.timestamp)) - 86_400_000;
    const trimmed = points.filter((p) => p[0] >= first);
    if (trimmed.length >= 2) points = trimmed;
  }
  return points;
}
export function baseValueHistory() { return valueHistory(scopedTransactions(), priceHistory()); }

export function chartCurrentValue() {
  const summary = summaryFor();
  if (!(market.flipped && canFlip())) return summary.currentValue;
  return market.altPrice == null ? null : summary.holdingsKas * market.altPrice;
}

// =================================================================================================
// Network hashrate (KaspaNetworkStatsService)
// =================================================================================================

export const hashrate = { history: [], current: null, blockReward: null, nextReward: null, nextAt: null, fetchedAt: 0 };

function applyStats(stats) {
  if (!stats) return;
  hashrate.history = stats.history.map(([t, hs]) => [t, hs / 1e15]);
  hashrate.current = stats.currentHashrate / 1e15;
  hashrate.blockReward = stats.blockRewardKas ?? null;
  hashrate.nextReward = stats.nextHalving?.amountKas ?? null;
  hashrate.nextAt = stats.nextHalving?.at ?? null;
  hashrate.fetchedAt = stats.fetchedAt;
}
applyStats(peekNetworkStats());

let hashFetching = null;
/** Fifteen minutes between fetches unless forced. */
export async function refreshHashrateIfNeeded({ force = false } = {}) {
  if (!force && hashrate.fetchedAt && Date.now() - hashrate.fetchedAt < 15 * 60_000) return;
  if (hashFetching) return hashFetching;
  hashFetching = (async () => {
    applyStats(await fetchNetworkStats({ force }));
    emit("hashrate");
  })().finally(() => { hashFetching = null; });
  return hashFetching;
}

/** HashrateFormat.display, from PH/s. */
export function hashrateText(phs) {
  if (phs == null || !Number.isFinite(phs)) return "—";
  if (phs >= 1000) return `${fixed(phs / 1000, 2)} EH/s`;
  if (phs >= 1) return `${fixed(phs, 1)} PH/s`;
  if (phs >= 0.001) return `${fixed(phs * 1000, 1)} TH/s`;
  return `${fixed(phs * 1e6, 1)} GH/s`;
}

// =================================================================================================
// CSV (CoinMarketCap "Transaction History" format)
// =================================================================================================

const pad2 = (n) => String(n).padStart(2, "0");
/** Swift's Double description: integral values keep ".0", others print shortest round-trip. */
function swiftDouble(value) {
  const v = Number(value) || 0;
  if (Number.isInteger(v) && Math.abs(v) < 1e16) return `${v}.0`;
  return String(v);
}

/** { filename, csv } for the active portfolio, oldest first; null when it is empty. */
export function buildCsv() {
  const rows = [...scopedTransactions()].sort((a, b) => a.timestamp - b.timestamp);
  if (!rows.length) return null;
  let csv = "Date (UTC+0:00),Token,Type,Price (USD),Amount,Total value (USD),Fee,Fee Currency,Notes\n";
  for (const tx of rows) {
    const d = new Date(tx.timestamp);
    const date = `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
    const amount = amountKasOf(tx);
    const perKas = amount !== 0 ? tx.fiatValue / amount : 0;
    const notes = String(tx.notes || "").replace(/"/g, '""');
    csv += `"${date}","KAS","${tx.type}","${swiftDouble(perKas)}","${swiftDouble(amount)}","${swiftDouble(tx.fiatValue)}","0.00","USD","${notes}"\n`;
  }
  const stamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z").replace(/:/g, "-");
  return { filename: `kachat-portfolio-${stamp}.csv`, csv };
}

/**
 * A CSV document as records of fields (RFC 4180): commas and line breaks inside double quotes
 * belong to the field, "" inside quotes is one quote, LF / CRLF / CR outside quotes end the
 * record, and blank lines yield none - so a note with line breaks survives a round trip.
 */
export function parseCsvRecords(content) {
  const records = [];
  let fields = [];
  let current = "";
  let quoted = false;
  const endRecord = () => {
    fields.push(current);
    if (!(fields.length === 1 && !fields[0].trim())) records.push(fields);
    fields = [];
    current = "";
  };
  const text = String(content || "");
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { current += '"'; i += 1; } else quoted = false;
      } else current += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { fields.push(current); current = ""; }
    else if (c === "\r" || c === "\n") {
      if (c === "\r" && text[i + 1] === "\n") i += 1;
      endRecord();
    } else current += c;
  }
  if (current || fields.length) endRecord();
  return records;
}

const lenient = (raw) => {
  const text = String(raw ?? "").trim().replace(/,/g, "");
  if (!text) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
};

/** "Date (UTC-4:00)" -> -240 minutes; UTC when it can't be read. */
function headerOffsetMinutes(header) {
  const match = /UTC\s*([+-]?)(\d{1,2})(?::(\d{2}))?\)/i.exec(header || "");
  if (!match) return 0;
  const minutes = Number(match[2]) * 60 + Number(match[3] || 0);
  return match[1] === "-" ? -minutes : minutes;
}

/** Imports into the active portfolio; a row with an exactly equal timestamp is replaced in place
 *  (keeping its id). Returns imported + replaced. */
export async function importCsv(text) {
  const records = parseCsvRecords(text);
  if (!records.length) return 0;
  const offset = headerOffsetMinutes(records.shift().join(","));
  const portfolio = activePortfolio();
  let count = 0;
  for (const f of records) {
    if (f.length < 6) continue;
    if (String(f[1]).trim().toUpperCase() !== "KAS") continue;
    const typeRaw = String(f[2]).trim().toLowerCase();
    // CoinMarketCap writes "Transfer In" / "Transfer Out"; both are a transfer here.
    const type = TYPES.includes(typeRaw) ? typeRaw : typeRaw.startsWith("transfer") ? "transfer" : null;
    if (!type) continue;
    const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(String(f[0]).trim());
    if (!m) continue;
    const timestamp = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) - offset * 60_000;
    const amount = lenient(f[4]);
    let total = lenient(f[5]);
    if (amount == null || total == null) continue;
    if (f.length > 7 && String(f[7]).trim().toUpperCase() === "USD") {
      const fee = lenient(f[6]) || 0;
      if (type === "buy") total += fee;
      else if (type === "sell") total = Math.max(total - fee, 0);
    }
    const notes = f.length > 8 && f[8] ? f[8] : null;
    const amountSompi = kasToSompiString(amount);
    if (amountSompi == null) continue;
    const existing = portfolio.transactions.findIndex((t) => t.timestamp === timestamp);
    const row = { type, amountSompi, fiatValue: total, timestamp, notes, portfolioId: portfolio.id };
    if (existing >= 0) portfolio.transactions[existing] = { ...row, id: portfolio.transactions[existing].id };
    else portfolio.transactions.push({ ...row, id: uuid() });
    count += 1;
  }
  if (count) {
    await save();
    emit("data");
    // A re-imported export can carry rows whose price was still loading: price them by date.
    startPriceBackfillIfNeeded();
  }
  return count;
}

// =================================================================================================
// "Add Kaspa Address" import (PortfolioAddressImporter) and the background price backfill
// =================================================================================================

function restBase() {
  return String(getEndpoint("kaspaApi") || "https://api.kaspa.org").replace(/\/+$/, "");
}

/** Up to 500 transactions, 50 a page; a failing page retries the same offset (0/1/3/8 s), then
 *  the import goes ahead with what it has, marked incomplete. */
async function fetchHistoryResumable(address, onProgress) {
  const all = [];
  let offset = 0;
  while (all.length < 500) {
    const url = `${restBase()}/addresses/${encodeURIComponent(address)}/full-transactions?limit=50&offset=${offset}&resolve_previous_outpoints=light`;
    let page = null;
    for (const delay of [0, 1000, 3000, 8000]) {
      if (delay) await sleep(delay);
      try {
        const response = await fetch(url, { headers: { Accept: "application/json" }, cache: "no-store", signal: AbortSignal.timeout(20_000) });
        if (!response.ok) continue;
        const json = await response.json();
        if (Array.isArray(json)) { page = json; break; }
      } catch { /* the next attempt waits longer */ }
    }
    if (page === null) return { transactions: all, complete: false };
    if (!page.length) break;
    all.push(...page);
    onProgress(`Fetching transactions… (${all.length})`);
    if (page.length < 50) break;
    offset += 50;
  }
  return { transactions: all.slice(0, 500), complete: true };
}

/** direction(for:) - sell = smallest output to someone else; buy = everything paid to us. */
function directionFor(tx, address) {
  const weAreSender = (tx.inputs || []).some((input) => input.previous_outpoint_address === address);
  let toUs = 0n; let toOthers = 0n; let recipient = null;
  for (const output of tx.outputs || []) {
    const to = output.script_public_key_address;
    if (!to) continue;
    const amount = BigInt(output.amount || 0);
    if (to === address) toUs += amount;
    else { toOthers += amount; if (recipient === null || amount < recipient) recipient = amount; }
  }
  if (weAreSender && toOthers > 0n) return { isOutgoing: true, amountSompi: recipient };
  if (!weAreSender && toUs > 0n) return { isOutgoing: false, amountSompi: toUs };
  return null;
}

export class ImportError extends Error {
  constructor(code) {
    super({
      invalidAddress: "That doesn't look like a valid Kaspa address.",
      noTransactions: "No new transactions found for this address.",
      noActivePortfolio: "No active portfolio to import into.",
      historyFetchFailed: "Couldn't fetch this address's transactions. Check your connection and try again.",
    }[code] || "Import failed.");
    this.code = code;
  }
}

/** Every received transaction a buy, every sent one a sell, at that UTC day's price. Rows are
 *  saved before anything else can fail; unpriced ones get the sentinel note and the backfill. */
export async function importAddress(addressInput, onProgress = () => {}) {
  const address = String(addressInput || "").trim();
  if (!/^kaspa(test)?:[a-z0-9]{50,90}$/.test(address)) throw new ImportError("invalidAddress");
  const portfolio = activePortfolio();
  if (!portfolio) throw new ImportError("noActivePortfolio");
  const accountId = store.accountId;
  const existing = new Set();
  for (const p of store.data.portfolios) for (const t of p.transactions) if (t.sourceAddress === address && t.sourceTxId) existing.add(t.sourceTxId);
  // Fees dedupe per portfolio: the same fee may be counted once in each portfolio.
  const existingFees = new Set(store.fees.filter((f) => f.portfolioId === portfolio.id).map((f) => f.txId));

  onProgress("Fetching transactions…");
  const history = await fetchHistoryResumable(address, onProgress);
  const candidates = [];
  const feeCandidates = [];
  for (const tx of history.transactions) {
    const txId = tx.transaction_id;
    const time = Number(tx.block_time);
    const dated = Number.isFinite(time) && time > 0;
    // Fees first and on their own terms: a message to yourself has no buy or sell in it, but it
    // still paid a fee.
    if (txId && dated && !existingFees.has(txId)) {
      const fee = feeSompiOf(tx, address);
      if (fee != null) { existingFees.add(txId); feeCandidates.push({ txId, sompi: fee, timestamp: time, day: utcDayKey(time) }); }
    }
    if (!txId || existing.has(txId) || !dated) continue;
    const direction = directionFor(tx, address);
    if (!direction) continue;
    existing.add(txId);
    candidates.push({ txId, ...direction, timestamp: time, day: utcDayKey(time) });
  }
  if (!candidates.length && !feeCandidates.length) throw new ImportError(history.complete ? "noTransactions" : "historyFetchFailed");

  onProgress("Fetching prices…");
  const cur = store.currency;
  let prices = {};
  const days = [...candidates.map((c) => c.day), ...feeCandidates.map((c) => c.day)];
  try { prices = await resolveDailyPrices(days, cur); } catch { prices = peekDailyPrices(days, cur); }
  if (store.accountId !== accountId) throw new ImportError("noActivePortfolio");

  let missing = 0;
  for (const c of candidates) {
    const dayPrice = prices[c.day];
    const priced = Number.isFinite(dayPrice);
    if (!priced) missing += 1;
    const amountKas = Number(c.amountSompi) / 1e8;
    portfolio.transactions.push({
      id: uuid(), type: c.isOutgoing ? "sell" : "buy", amountSompi: c.amountSompi.toString(),
      fiatValue: amountKas * (priced ? dayPrice : 0), timestamp: c.timestamp,
      notes: priced ? null : PRICE_PENDING_NOTE, portfolioId: portfolio.id,
      sourceAddress: address, sourceTxId: c.txId,
    });
  }
  const fees = feeCandidates.map((c) => ({
    txId: c.txId, portfolioId: portfolio.id, sourceAddress: address, amountSompi: c.sompi.toString(), timestamp: c.timestamp,
    fiatValue: Number.isFinite(prices[c.day]) ? (Number(c.sompi) / 1e8) * prices[c.day] : null,
  }));
  await save();
  if (fees.length) { store.fees.push(...fees); await saveFees(); }
  emit("data");
  startPriceBackfillIfNeeded();
  return { imported: candidates.length, feeCount: fees.length, missingPriceCount: missing, incomplete: !history.complete };
}

/**
 * The network fee `address` paid on `tx` (feeSompi(of:paidBy:)): inputs spent minus outputs paid
 * out, only for a transaction it sent and only when every input's amount is known. Null when
 * nothing was paid.
 */
function feeSompiOf(tx, address) {
  const inputs = tx.inputs || [];
  if (!inputs.some((input) => input.previous_outpoint_address === address)) return null;
  let spent = 0n;
  for (const input of inputs) {
    if (input.previous_outpoint_amount == null) return null;
    spent += BigInt(input.previous_outpoint_amount);
  }
  const paidOut = (tx.outputs || []).reduce((sum, o) => sum + BigInt(o.amount || 0), 0n);
  return spent > paidOut ? spent - paidOut : null;
}

function pendingRows() {
  const rows = [];
  for (const p of store.data.portfolios) for (const t of p.transactions) if (isPricePending(t.notes)) rows.push(t);
  return rows;
}

// Any row still waiting on its price - from an address import or a CSV re-import of one (which
// carries the marker but no on-chain source) - and any fee not priced yet. Only the date is needed.
const pendingFees = () => store.fees.filter((f) => f.fiatValue == null);
const hasPending = () => pendingRows().length > 0 || pendingFees().length > 0;

let backfillRunning = null;
/** Passes at 0 s, 30 s, 2 min and 5 min while rows are pending (restarted on wallet load). */
export function startPriceBackfillIfNeeded() {
  if (backfillRunning || !store.loaded || !hasPending()) return;
  const accountId = store.accountId;
  const token = {};
  backfillRunning = token;
  (async () => {
    for (const delay of [0, 30_000, 120_000, 300_000]) {
      if (delay) await sleep(delay);
      if (backfillRunning !== token || store.accountId !== accountId || !hasPending()) break;
      await backfillPass(accountId, token);
    }
    if (backfillRunning === token) backfillRunning = null;
  })();
}

async function backfillPass(accountId, token) {
  const cur = store.currency;
  const days = [...new Set([...pendingRows(), ...pendingFees()].map((t) => utcDayKey(t.timestamp)))];
  if (!days.length) return;
  const prices = await resolveDailyPrices(days, cur).catch(() => ({}));
  const missing = days.filter((d) => prices[d] === undefined).sort().reverse().slice(0, 30);
  for (const day of missing) {
    if (backfillRunning !== token || store.accountId !== accountId) return;
    const value = await resolveDailyPriceSingle(day, cur).catch(() => null);
    if (value != null) prices[day] = value;
    await sleep(PRICE_REQUEST_SPACING_MS);
  }
  if (store.accountId !== accountId || store.currency !== cur) return;
  let changed = false;
  for (const tx of pendingRows()) {
    const dayPrice = prices[utcDayKey(tx.timestamp)];
    if (!Number.isFinite(dayPrice)) continue;
    tx.fiatValue = amountKasOf(tx) * dayPrice;
    tx.notes = null;
    changed = true;
  }
  if (changed) await save();
  let feesChanged = false;
  for (const fee of pendingFees()) {
    const dayPrice = prices[utcDayKey(fee.timestamp)];
    if (!Number.isFinite(dayPrice)) continue;
    fee.fiatValue = (Number(fee.amountSompi) / 1e8) * dayPrice;
    feesChanged = true;
  }
  if (feesChanged) await saveFees();
  if (changed || feesChanged) emit("data");
}

/** CoinGecko's /coins/kaspa/history for one UTC day (AddToPortfolioSheet's price lookup). */
export async function historicalPrice(ms) {
  try { return await resolveDailyPriceSingle(utcDayKey(ms), store.currency); } catch { return null; }
}
