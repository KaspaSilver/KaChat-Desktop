// Cold Storage tab — desktop match of iOS's ColdStorageListView + ColdStorageDetailView:
// KasSigner kpub ACCOUNTS (extended public keys), not raw addresses. The list shows named
// accounts with their truncated kpub and a ⋯ menu (Copy kpub / Rename); "Paste kpub" and
// "Scan" live at the bottom exactly like iOS. Opening an account mirrors the iOS detail
// screen: Name / kpub / Total Balance summary, per-address rows (label, short address,
// balance, Used/Unused badge, ⋯ menu with Rename / Copy / QR / Hide), an "Address Actions"
// capsule (Generate More / Discover with the same gap-limit-20 scan as iOS), and a red
// trash to remove the account. Keys never enter the picture — signing (compound/withdraw)
// stays on the KasSigner device.

import { getEndpoint } from "../engine/endpoints.js";
import { NETWORK_ID, KAS_UNIT } from "../engine/network.js";
import { sompiFromUserText, kasToSompi, fiatTextFloorFromSompi, checkedUtxoAnswer } from "../engine/amounts.js";
import { kachatOwnersOfNames } from "./kachat-names-live.js";
import { renderAddressDomainsTab } from "./address-domains-tab.js";
import { userFacingError, alertDialog } from "./dialogs.js";
import { drawKasSignerFrame } from "../engine/qr.js";
import jsQR from "jsqr";
import {
  KSPT_MAX_INPUTS, MIN_RELAY_FEE_PER_GRAM, REFERENCE_MASS_FOR_FEE_EDITOR,
  looksLikeKspt, decodeKspt, chunkQrFrames, QrFrameAccumulator,
  calculateMass, calculateFee, fetchQuotedFeeRateSompiPerGram,
  buildUnsignedTransaction, previewAutomaticSelection, estimateMaxAmount,
  compoundInputs, unsignedToKsptBytes, broadcastSigned, isValidKaspaAddress,
  fetchSpendableUtxos, utxoKey,
} from "./kspt.js";
import { closeActiveScanner, scanKaspaAddress, scanQrCode } from "./qr-scan.js";
import {
  recipientCardHtml, recipientStatusHtml, amountEntryHtml, layoutAmountEntry, sanitizeAmountText,
  availablePillInnerHtml, infoPillHtml, feeControlsHtml, coinControlSummaryText, sendActionButtonHtml,
  shortSendAddress, refreshRecipientAddressBook, pickOtherDomain, nameNotFoundText,
} from "./send-kaspa-components.js";
import { listPortfolios, addTransactionToPortfolio, portfolioIdsContainingTx, historicalKasPrice, parsePortfolioNumber, formatPortfolioCurrency } from "./portfolio.js";

const COLD_ACCOUNTS_KEY = "kachat-cold-accounts-v1"; // account-scoped: [{ id, label, kpub, addedAt, maxIndex, labels, hidden }]
const COLD_UTXO_LABELS_KEY = "kachat-cold-utxo-labels-v1"; // account-scoped: { [address]: { [outpointKey]: label } }

let deps = null;
let rootEl = null;
let modalsEl = null;
let accounts = [];
let activeAccountId = null;   // null = list screen
// Address Visibility checklist sub-screen (paged whole-row toggles, same tool
// as Manage Spending Addresses) — replaced the old Hidden Addresses list.
let showingVisibility = false;
let visibilityPage = 0;
let visibilityToken = 0;
// Session cache (address → { sompi, used }) so paging back and forth is instant.
const visUsageCache = new Map();
let detailEntries = [];       // [{ index, address, balanceSompi?, everUsed? }] undefined = pending
let detailLoading = false;
let detailBusy = null;        // "generate" | "discover" | "refresh" | null
let detailToken = 0;
let balanceCache = new Map(); // address -> sompi, per opened account

// Per-address screen (iOS ColdStorageAddressTransactionHistoryView)
let activeAddressIndex = null; // non-null = address screen within the open account
let addressTab = "transactions";
let addrTxs = { state: "idle", txs: [], error: null };
let addrUtxos = { state: "idle", entries: [], error: null };
let addrToken = 0;
// Addresses of the open account that own at least one KNS domain (cached
// engine lookups) or a .kachat name (iOS 881ada6 ownersOfNames, where the
// registry is launched) — drives the "Contains domain" row tag and list ordering.
let detailDomainOwning = new Set();
/// What the last discover on this account turned up, shown in the Address Actions sheet.
let detailDiscoverySummary = null;
/// Live scan position while discovering (iOS DiscoveryProgress): `{ checkingIndex, foundCount }`.
let detailDiscoveryProgress = null;

function nowId() {
  return typeof crypto?.randomUUID === "function" ? crypto.randomUUID() : `c-${Date.now()}-${Math.random()}`;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function normalizeAccount(raw) {
  return {
    id: raw.id || nowId(),
    label: raw.label || "Cold Storage",
    kpub: raw.kpub,
    addedAt: raw.addedAt || 0,
    // Mirrors iOS ColdStorageAccount.maxAddressIndex: addresses 0...maxIndex exist.
    maxIndex: Number.isFinite(raw.maxIndex) ? Math.max(0, Math.floor(raw.maxIndex)) : 0,
    labels: raw.labels && typeof raw.labels === "object" ? raw.labels : {},
    hidden: Array.isArray(raw.hidden) ? raw.hidden : [],
    // Per-account receive notifications (iOS notifyOnReceive); older records read as on.
    receiveNotifications: raw.receiveNotifications !== false,
  };
}

function loadState() {
  try {
    const parsed = JSON.parse(localStorage.getItem(deps.accountScopedKey(COLD_ACCOUNTS_KEY)) || "[]") || [];
    accounts = parsed.filter((a) => a?.kpub).map(normalizeAccount);
  } catch { accounts = []; }
}

function saveState() {
  localStorage.setItem(deps.accountScopedKey(COLD_ACCOUNTS_KEY), JSON.stringify(accounts));
}

function activeAccount() {
  return accounts.find((a) => a.id === activeAccountId) || null;
}

// Per-UTXO labels, keyed "txid:index" and scoped per address — mirrors iOS's
// ColdStorageManager.setUtxoLabel / loadUtxoLabels.
function loadColdUtxoLabelsMap() {
  try { return JSON.parse(localStorage.getItem(deps.accountScopedKey(COLD_UTXO_LABELS_KEY)) || "{}") || {}; }
  catch { return {}; }
}

function coldUtxoLabels(address) {
  return loadColdUtxoLabelsMap()[address] || {};
}

function setColdUtxoLabel(address, outpointKey, label) {
  const map = loadColdUtxoLabelsMap();
  const forAddress = { ...(map[address] || {}) };
  const clean = String(label || "").trim();
  if (clean) forAddress[outpointKey] = clean;
  else delete forAddress[outpointKey];
  if (Object.keys(forAddress).length) map[address] = forAddress;
  else delete map[address];
  localStorage.setItem(deps.accountScopedKey(COLD_UTXO_LABELS_KEY), JSON.stringify(map));
}

function utxoOutpointKey(outpoint) {
  return `${outpoint?.transactionId || ""}:${outpoint?.index ?? ""}`;
}

// Persisted per-account balance/used cache — stale-while-revalidate: reopening an account
// renders the last-known numbers instantly while the batched refresh runs behind them.
const COLD_CACHE_KEY = "kachat-cold-cache-v1"; // account-scoped: { [accountId]: { balances, used, ts } }

function loadPersistedAccountCache(accountId) {
  try {
    const map = JSON.parse(localStorage.getItem(deps.accountScopedKey(COLD_CACHE_KEY)) || "{}") || {};
    return map[accountId] || null;
  } catch { return null; }
}

function persistAccountCache(accountId) {
  try {
    const map = JSON.parse(localStorage.getItem(deps.accountScopedKey(COLD_CACHE_KEY)) || "{}") || {};
    const balances = {};
    const used = {};
    for (const entry of detailEntries) {
      if (entry.balanceSompi !== undefined) balances[entry.address] = entry.balanceSompi;
      if (entry.everUsed !== undefined) used[entry.address] = entry.everUsed;
    }
    map[accountId] = { balances, used, ts: Date.now() };
    localStorage.setItem(deps.accountScopedKey(COLD_CACHE_KEY), JSON.stringify(map));
  } catch { /* cache is best-effort */ }
}

function dropPersistedAccountCache(accountId) {
  try {
    const map = JSON.parse(localStorage.getItem(deps.accountScopedKey(COLD_CACHE_KEY)) || "{}") || {};
    delete map[accountId];
    localStorage.setItem(deps.accountScopedKey(COLD_CACHE_KEY), JSON.stringify(map));
  } catch { /* cache is best-effort */ }
}

// Where-you-were persistence: refreshing the page reopens the same cold-storage account
// (and address screen) you were looking at, with its data freshly reloaded.
const COLD_SPOT_KEY = "kachat-cold-spot-v1"; // account-scoped: { accountId, addressIndex }

function saveColdSpot(spot) {
  try {
    if (!spot?.accountId) localStorage.removeItem(deps.accountScopedKey(COLD_SPOT_KEY));
    else localStorage.setItem(deps.accountScopedKey(COLD_SPOT_KEY), JSON.stringify(spot));
  } catch { /* best-effort */ }
}

async function restoreColdSpot() {
  let spot = null;
  try { spot = JSON.parse(localStorage.getItem(deps.accountScopedKey(COLD_SPOT_KEY)) || "null"); }
  catch { return; }
  if (!spot?.accountId || activeAccountId !== null) return;
  if (!accounts.some((a) => a.id === spot.accountId)) { saveColdSpot(null); return; }
  await openAccount(spot.accountId);
  if (spot.addressIndex != null && activeAccountId === spot.accountId) {
    const entry = detailEntries.find((e) => e.index === spot.addressIndex);
    if (entry) openAddressScreen(entry.index);
  }
}

// ---------------------------------------------------------------------------
// kpub helpers
// ---------------------------------------------------------------------------

function validateKpub(kpub) {
  const trimmed = String(kpub || "").trim();
  if (!trimmed) return null;
  try {
    const generator = deps.engine.kaspa.PublicKeyGenerator.fromXPub(trimmed);
    // Prove it derives before accepting it.
    generator.receiveAddressAsStrings(NETWORK_ID, 0, 1);
    return trimmed;
  } catch {
    return null;
  }
}

function deriveReceiveAddresses(kpub, start, end) {
  const generator = deps.engine.kaspa.PublicKeyGenerator.fromXPub(kpub);
  return generator.receiveAddressAsStrings(NETWORK_ID, start, end);
}

function truncateMiddle(value, keep = 14) {
  const text = String(value || "");
  return text.length <= keep * 2 + 3 ? text : `${text.slice(0, keep)}…${text.slice(-keep)}`;
}

// Same shape as iOS ColdStorageAddressEntry.shortAddress: prefix(14) + "..." + suffix(6).
function shortColdAddress(address) {
  const text = String(address || "");
  return text.length <= 20 ? text : `${text.slice(0, 14)}...${text.slice(-6)}`;
}

function displayLabelFor(account, index) {
  const custom = account.labels?.[index] ?? account.labels?.[String(index)];
  return custom || `Address #${index}`;
}

async function fetchBalance(address) {
  if (!String(address || "").trim()) return 0; // empty address would 404 as /addresses//…
  const base = String(getEndpoint("kaspaApi") || "https://api.kaspa.org").replace(/\/+$/, "");
  const response = await fetch(`${base}/addresses/${encodeURIComponent(address)}/balance`, {
    headers: { Accept: "application/json" }, cache: "no-store",
  });
  if (!response.ok) throw new Error(`Balance lookup failed (${response.status}).`);
  return Number((await response.json())?.balance) || 0;
}

/** All balances in ONE gRPC round trip (getUtxosByAddresses over the whole set) — the same
 *  batching that makes iOS's ColdStorageManager fast. Returns Map(address -> sompi), with 0
 *  for every queried address that holds nothing. */
async function fetchBalancesBatch(addresses) {
  await deps.engine.connect();
  const response = await deps.engine.withRpc(
    async (rpc) => checkedUtxoAnswer(await rpc.getUtxosByAddresses(addresses)),
    { retries: 1, label: "Cold storage balances" }
  );
  const byAddress = new Map(addresses.map((a) => [a, 0]));
  for (const entry of response?.entries || []) {
    const address = String(entry.address ?? entry.entry?.address ?? "");
    if (!byAddress.has(address)) continue;
    byAddress.set(address, byAddress.get(address) + Number(entry.amount ?? entry.entry?.amount ?? 0));
  }
  return byAddress;
}

/** True only when a live read says this address holds nothing. A network error is NOT an empty
 *  balance: hiding then fails closed (iOS ColdStorageManager.setAddressHidden). */
async function addressConfirmedEmpty(address) {
  if (!String(address || "").trim()) return false;
  try {
    const balances = await fetchBalancesBatch([address]);
    return (balances.get(address) || 0) === 0;
  } catch { return false; }
}

/** Bounded-concurrency map: REST endpoints tolerate a few parallel requests fine — it's
 *  full-blast parallelism that risks rate limiting, and strictly-sequential that made the
 *  Used/Unused backfill crawl. */
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  }));
  return results;
}

// An address counts as "used" if it holds a balance now or has any on-chain
// transaction history — mirrors iOS's everUsed || balance>0.
//
// Tri-state, like iOS ChatService.spendingAddressUsedState (the same `transactions-count` read):
// true / false only from a successful answer, null when the probe failed. A failed probe used to
// read as "never used", which let Generate More hand out an address that had been used and let a
// row claim "Unused" on a rate-limited request.
async function addressHasHistory(address) {
  if (!String(address || "").trim()) return null; // empty address would 404 as /addresses//…
  try {
    const base = String(getEndpoint("kaspaApi") || "https://api.kaspa.org").replace(/\/+$/, "");
    const url = `${base}/addresses/${encodeURIComponent(address)}/transactions-count`;
    const response = await fetch(url, { headers: { Accept: "application/json" }, cache: "no-store", signal: AbortSignal.timeout(8000) });
    if (!response.ok) return null;
    const total = Number((await response.json())?.total);
    return Number.isFinite(total) ? total > 0 : null;
  } catch { return null; }
}

// Exact 8-decimal formatting like iOS's formatKasExact.
function fmtKasExact(sompi) {
  return (Number(sompi || 0) / 1e8).toFixed(8);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const LOCK_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.75" y="10.5" width="16.5" height="10" rx="2.4"/><path d="M7.5 10.5V7.125a4.5 4.5 0 0 1 9 0V10.5"/></svg>`;
const BELL_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4l2-2ZM10 21h4"/></svg>`;
const PENCIL_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L18.5 9.5a2.12 2.12 0 0 0-3-3L5 17v3z"/><path d="M13.5 6.5l3 3"/></svg>`;
const COPY_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg>`;
const QR_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3z"/></svg>`;
const TRASH_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13a1.5 1.5 0 0 0 1.5 1.4h7A1.5 1.5 0 0 0 17 20l1-13M9 7V5a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 15 5v2"/></svg>`;
const DOTS_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/></svg>`;
const MERGE_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 4v6a4 4 0 0 0 4 4v6M16 4v6a4 4 0 0 1-4 4"/><path d="m9 17 3 3 3-3"/></svg>`;
const PIE_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21.18 15.9A10 10 0 1 1 8.1 2.82"/><path d="M22 12A10 10 0 0 0 12 2v10Z"/></svg>`;
const EXTERNAL_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6"/><path d="M20 4 10.5 13.5"/><path d="M18 14v4.5A1.5 1.5 0 0 1 16.5 20h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10"/></svg>`;
const CHECK_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9.25"/><path d="M8 12.4l2.6 2.6L16 9.6"/></svg>`;
const CIRCLE_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9.25"/></svg>`;
const EYE_SLASH_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3l18 18"/><path d="M10.6 5.1A9.9 9.9 0 0 1 12 5c5 0 9 4.5 10 7a15.5 15.5 0 0 1-3.2 4.2"/><path d="M6.5 6.9C4.4 8.3 2.7 10.3 2 12c1 2.5 5 7 10 7a9.7 9.7 0 0 0 4.4-1.05"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>`;

const UTXO_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="7.5" cy="7.5" r="3.2"/><circle cx="16.5" cy="7.5" r="3.2"/><circle cx="7.5" cy="16.5" r="3.2"/><circle cx="16.5" cy="16.5" r="3.2"/></svg>`;
const CUBE_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.8 20.5 7.5v9L12 21.2 3.5 16.5v-9Z"/><path d="M3.5 7.5 12 12.2l8.5-4.7M12 12.2v9"/></svg>`;
const WARNING_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10.3 3.9 2.6 17.5A2 2 0 0 0 4.3 20.5h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4.5M12 17h.01"/></svg>`;
const REFRESH_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99"/></svg>`;
/// A list's loading state: a spinner, as iOS's ProgressView row, not a "Loading…" line.
const COLD_LIST_SPINNER = '<div class="cold-detail-spinner"><span class="initial-sync-spinner" aria-hidden="true"></span></div>';

const CHECKLIST_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m3 6 2 2 3-3"/><path d="M11 6h10"/><path d="m3 12.5 2 2 3-3"/><path d="M11 12.5h10"/><path d="m3 19 2 2 3-3"/><path d="M11 19h10"/></svg>`;

function render() {
  if (!rootEl) return;
  closeAllColdMenus();
  if (activeAccountId && activeAddressIndex !== null) renderAddressScreen();
  else if (activeAccountId && showingVisibility) renderVisibility();
  else if (activeAccountId) renderDetail();
  else renderList();
  // The Address Actions sheet shows the discover's progress, so it redraws with the screen.
  if (!modalsEl?.querySelector("[data-cold-actions-modal]")?.hidden) renderColdSheet();
}

function renderList() {
  rootEl.innerHTML = `
    <div class="kaposts-header">
      <h1 class="kaposts-title">Cold Storage</h1>
    </div>
    ${accounts.length === 0
      ? `<div class="cold-empty">
           <span class="cold-empty-icon">${LOCK_ICON}</span>
           <strong>No Cold Storage Accounts</strong>
           <p>Scan or paste a kpub exported from your KasSigner device to watch its balance.</p>
         </div>`
      : accounts.map((account) => `
          <div class="chat-row cold-account-row">
            <button class="cold-account-main" type="button" data-cold-open="${account.id}">
              <span class="cold-row-lock">${LOCK_ICON}</span>
              <span class="chat-meta">
                <strong>${deps.escapeHtml(account.label)}</strong>
                <span class="cold-kpub">${deps.escapeHtml(truncateMiddle(account.kpub))}</span>
              </span>
            </button>
            <div class="spending-address-row-menu-wrap cold-menu-wrap">
              <button type="button" class="spending-row-menu-btn" data-cold-menu-toggle="${account.id}" aria-haspopup="dialog" aria-label="Account options">${DOTS_ICON}</button>
            </div>
          </div>`).join("")}
    <div class="cold-bottom-actions">
      <button class="primary-button cold-capsule" type="button" data-cold-paste>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15.666 3.888A2.25 2.25 0 0 0 13.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 0 1-.75.75h-6a.75.75 0 0 1-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 0 1-2.25 2.25H6.75A2.25 2.25 0 0 1 4.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 0 1 1.927-.184"/></svg>
        Paste kpub
      </button>
      <button class="primary-button cold-capsule" type="button" data-cold-scan>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.75 4.875c0-.621.504-1.125 1.125-1.125h4.5c.621 0 1.125.504 1.125 1.125v4.5c0 .621-.504 1.125-1.125 1.125h-4.5A1.125 1.125 0 0 1 3.75 9.375v-4.5ZM3.75 14.625c0-.621.504-1.125 1.125-1.125h4.5c.621 0 1.125.504 1.125 1.125v4.5c0 .621-.504 1.125-1.125 1.125h-4.5a1.125 1.125 0 0 1-1.125-1.125v-4.5ZM13.5 4.875c0-.621.504-1.125 1.125-1.125h4.5c.621 0 1.125.504 1.125 1.125v4.5c0 .621-.504 1.125-1.125 1.125h-4.5A1.125 1.125 0 0 1 13.5 9.375v-4.5Z"/><path d="M6.75 6.75h.008v.008H6.75V6.75ZM6.75 16.5h.008v.008H6.75V16.5ZM16.5 6.75h.008v.008H16.5V6.75ZM13.5 13.5h.008v.008H13.5V13.5ZM13.5 19.5h.008v.008H13.5V19.5ZM19.5 13.5h.008v.008H19.5V13.5ZM19.5 19.5h.008v.008H19.5V19.5ZM16.5 16.5h.008v.008H16.5V16.5Z"/></svg>
        Scan
      </button>
    </div>`;
}

function addressRowHtml(account, entry) {
  const funded = (entry.balanceSompi || 0) > 0;
  const used = funded || entry.everUsed === true;
  const usageBadge = entry.balanceSompi === undefined
    ? ""
    : (!funded && entry.everUsed === undefined)
      ? '<span class="spending-address-usage checking" data-cold-usage-cell="' + entry.index + '">Checking</span>'
    : used
      ? '<span class="spending-address-usage used" data-cold-usage-cell="' + entry.index + '">Used</span>'
      : '<span class="spending-address-usage unused" data-cold-usage-cell="' + entry.index + '">Unused</span>';
  const balanceText = entry.balanceSompi === undefined ? `… ${KAS_UNIT}` : `${fmtKasExact(entry.balanceSompi)} ${KAS_UNIT}`;
  // iOS ColdStorageDetailView.addressRow: label, short address, balance, then the Used / Unused /
  // Checking badge with the Contains domain tag on their own line. No chevron.
  return `
    <div class="spending-address-row cold-address-row" data-cold-address-row="${entry.index}">
      <button type="button" class="spending-address-row-main" data-cold-addr-open="${entry.index}">
        <span class="spending-address-label cold-addr-label">${deps.escapeHtml(displayLabelFor(account, entry.index))}</span>
        <span class="spending-address-value">${deps.escapeHtml(shortColdAddress(entry.address))}</span>
        <span class="spending-address-balance" data-cold-balance-cell="${entry.index}">${deps.escapeHtml(balanceText)}</span>
        <span class="cold-address-badges" data-cold-badges="${entry.index}">${usageBadge}${detailDomainOwning.has(entry.address) ? '<span class="cold-address-domain-tag">Contains domain</span>' : ""}</span>
      </button>
      <div class="spending-address-row-menu-wrap">
        <button type="button" class="spending-row-menu-btn" data-cold-addr-menu-toggle="${entry.index}" aria-haspopup="dialog" aria-label="Address options">${DOTS_ICON}</button>
      </div>
    </div>`;
}

function renderDetail() {
  const account = activeAccount();
  if (!account) { activeAccountId = null; renderList(); return; }
  const hiddenSet = new Set(account.hidden.map(Number));
  const visible = detailEntries.filter((e) => !hiddenSet.has(e.index));
  const totalSompi = visible.reduce((sum, e) => sum + (e.balanceSompi || 0), 0);

  // Funded-or-domain-holding addresses first (the KNS tag promotes a row into
  // the active group), lowest index first within each group — same sort as the
  // spending-chain Manage Addresses list.
  const sorted = [...visible].sort((a, b) => {
    const aActive = (a.balanceSompi || 0) > 0 || detailDomainOwning.has(a.address);
    const bActive = (b.balanceSompi || 0) > 0 || detailDomainOwning.has(b.address);
    if (aActive !== bActive) return aActive ? -1 : 1;
    return b.index - a.index;
  });

  rootEl.innerHTML = `
    <div class="kaposts-thread-header cold-detail-header">
      <button class="kaposts-icon-button" type="button" data-cold-back aria-label="Back">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10.5 19.5 3 12m0 0 7.5-7.5M3 12h18"/></svg>
      </button>
      <strong>${deps.escapeHtml(account.label)}</strong>
      <button class="kaposts-icon-button cold-trash-button" type="button" data-cold-remove aria-label="Remove account">${TRASH_ICON}</button>
    </div>
    <div class="cold-summary">
      <div class="cold-summary-row">
        <div>
          <p class="cold-summary-label">Name</p>
          <p class="cold-summary-name">${deps.escapeHtml(account.label)}</p>
        </div>
        <button class="cold-inline-icon" type="button" data-cold-rename-account aria-label="Rename account">${PENCIL_ICON}</button>
      </div>
      <div>
        <p class="cold-summary-label">kpub</p>
        <p class="cold-summary-kpub">${deps.escapeHtml(account.kpub)}</p>
        <button class="cold-inline-link" type="button" data-cold-copy-kpub>${COPY_ICON}Copy kpub</button>
      </div>
      <div>
        <p class="cold-summary-label">Total Balance</p>
        <p class="cold-summary-balance">${fmtKasExact(totalSompi)} ${KAS_UNIT}</p>
      </div>
      <button class="primary-button cold-capsule cold-summary-actions" type="button" data-cold-actions-toggle ${detailBusy ? "disabled" : ""}${detailBusy ? ' aria-busy="true" aria-label="Address Actions"' : ""}>
        ${detailBusy ? '<span class="sk-spinner" aria-hidden="true"></span>' : "Address Actions"}
      </button>
    </div>
    <div class="cold-address-list">
      ${detailLoading && detailEntries.length === 0
        ? '<div class="cold-detail-spinner"><span class="initial-sync-spinner" aria-hidden="true"></span></div>'
        : sorted.length === 0
          ? '<p class="cold-detail-note">No addresses discovered yet.</p>'
          : sorted.map((e) => addressRowHtml(account, e)).join("")}
    </div>`;
}

/// The half sheet behind "Address Actions" (iOS `addressActionsSheet`).
///
/// A sheet of titled rows rather than the bare dropdown this replaces, because each of these does
/// something worth a sentence - and because Address Visibility now lives here. It used to be an
/// unlabelled checklist glyph in the header, which said nothing about what it did; it is one of
/// this account's address actions, so it belongs with the others where it has room to explain
/// itself.
///
/// Discovery reports into the sheet rather than dismissing it, and the scan belongs to the SCREEN,
/// not to the sheet - closing it does not stop the scan, which is what "Close and Keep Scanning"
/// says.
/// Which sheet is open: `{ kind: "actions" | "account" | "address", id?, index? }`, or null.
/// Held so `render()` can redraw the open sheet without clobbering a different one.
let coldSheet = null;

function coldSheetRow({ attr, title, subtitle, icon, warn = false, disabled = false }) {
  return `
    <button type="button" class="cold-action-row${warn ? " cold-action-row-warn" : ""}" ${attr} ${disabled ? "disabled" : ""}>
      <span class="cold-action-icon" aria-hidden="true">${icon}</span>
      <span class="cold-action-copy">
        <strong>${title}</strong>
        <small>${subtitle}</small>
      </span>
    </button>`;
}

function renderColdSheet() {
  if (!coldSheet) return;
  if (coldSheet.kind === "account") return renderColdAccountSheet();
  if (coldSheet.kind === "address") return renderColdAddressSheet();
  if (coldSheet.kind === "transaction") return renderColdTransactionSheet();
  if (coldSheet.kind === "portfolio-pick") return renderColdPortfolioPicker();
  if (coldSheet.kind === "portfolio-details") return renderColdPortfolioDetails();
  renderColdActionsSheet();
}

/// What to do with one transaction (iOS `TransactionActionsSheet`).
///
/// The row used to open the explorer on click, which is fine until there is a second thing you
/// might want to do with a transaction - and there is. Asking first is what gives Add to Portfolio
/// somewhere to live that is not a gesture nobody would guess at.
function renderColdTransactionSheet() {
  const body = modalsEl?.querySelector("[data-cold-actions-body]");
  const tx = coldSheet.tx;
  if (!body || !tx) return;
  const when = tx.blockTime ? new Date(Number(tx.blockTime)).toLocaleString() : null;
  const summary = tx.amountSompi != null
    ? `${tx.outgoing ? "Sent" : "Received"} ${fmtKasExact(tx.amountSompi)} ${KAS_UNIT}${when ? ` on ${when}` : ""}`
    : (when || "Transaction");
  body.innerHTML = `
    <div class="modal-head">
      <div><p class="modal-kicker">${deps.escapeHtml(summary)}</p><h2>Transaction</h2></div>
      <button class="modal-close" type="button" data-cold-actions-close aria-label="Close">×</button>
    </div>
    <p class="cold-sheet-txid">${deps.escapeHtml(tx.txId)}</p>
    <div class="cold-action-rows">
      ${coldSheetRow({ attr: 'data-cold-tx-explorer', title: "Open in Explorer",
        subtitle: "Opens this transaction on the block explorer.", icon: EXTERNAL_ICON })}
      ${tx.amountSompi != null
        ? coldSheetRow({ attr: 'data-cold-tx-portfolio', title: "Add to Portfolio",
            subtitle: "Records it as a buy or a sell in a portfolio of your choosing.", icon: PIE_ICON })
        : ""}
    </div>`;
}

/// Step 1 - which portfolio (iOS `AddToPortfolioSheet`, `.choosePortfolio`).
///
/// A portfolio that already holds this transaction is flagged HERE, while the choice is still
/// being made, rather than after picking - adding it twice double-counts it in every figure the
/// portfolio derives. The summary line under the rows says what is about to be recorded, so the
/// choice is made with the transaction in view.
function renderColdPortfolioPicker() {
  const body = modalsEl?.querySelector("[data-cold-actions-body]");
  if (!body) return;
  const duplicates = coldSheet.duplicates || new Set();
  body.innerHTML = `
    <div class="modal-head">
      <div><h2>Add to Portfolio</h2></div>
      <button class="modal-close" type="button" data-cold-actions-close aria-label="Close">×</button>
    </div>
    <p class="cold-sheet-section">Which portfolio?</p>
    <div class="cold-action-rows">
      ${coldSheet.portfolios.map((portfolio) => coldSheetRow({
        attr: `data-cold-portfolio-pick="${deps.escapeHtml(portfolio.id)}"`,
        title: deps.escapeHtml(portfolio.name),
        subtitle: duplicates.has(portfolio.id)
          ? `${WARNING_ICON}Already added`
          : (portfolio.isActive ? "Current" : ""),
        icon: PIE_ICON,
        warn: duplicates.has(portfolio.id),
      })).join("")}
    </div>
    <p class="field-hint cold-actions-summary">${deps.escapeHtml(coldTxSummaryLine(coldSheet.tx))}</p>`;
}

/// iOS AddToPortfolioSheet.summaryLine: "Sent 1,234.5 KAS on Oct 16, 2026, 3:04 PM".
function coldTxSummaryLine(tx) {
  const direction = tx.outgoing ? "Sent" : "Received";
  const when = new Date(tx.blockTime ? Number(tx.blockTime) : Date.now());
  const kas = (Number(tx.amountSompi) / 1e8).toLocaleString("en-US", { maximumFractionDigits: 4 });
  return `${direction} ${kas} ${KAS_UNIT} on ${when.toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })}`;
}

/// iOS AddToPortfolioSheet.trimmed: fixed decimals with trailing zeros dropped down to two.
function trimmedDecimal(value, maxDecimals = 8) {
  let text = Number(value || 0).toFixed(maxDecimals);
  while (text.endsWith("0") && (text.split(".")[1]?.length || 0) > 2) text = text.slice(0, -1);
  return text;
}

/// Amount and price as typed: either separator (the field is grouped as you type).
function coldPortfolioNumber(text) {
  const value = parsePortfolioNumber(String(text ?? ""));
  return Number.isFinite(value) ? value : null;
}

/// "Total" shows once both amount and price read as numbers (iOS totalValue).
function coldPortfolioTotal(d) {
  const amount = coldPortfolioNumber(d.amount);
  const priceValue = coldPortfolioNumber(d.price);
  return amount === null || priceValue === null ? null : amount * priceValue;
}

function toDatetimeLocalValue(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/// Step 2 - what actually gets recorded, editable first (iOS `.editDetails`).
///
/// Every field is prefilled and every field is editable, because only the reader knows what the
/// transaction really was: money leaving the address looks like a sale and money arriving like a
/// buy, but a transfer between your own addresses is neither.
function renderColdPortfolioDetails() {
  const body = modalsEl?.querySelector("[data-cold-actions-body]");
  if (!body) return;
  const d = coldSheet.details;
  const total = coldPortfolioTotal(d);
  const canConfirm = (coldPortfolioNumber(d.amount) || 0) > 0;
  body.innerHTML = `
    <div class="modal-head">
      <div><h2>Transaction Details</h2></div>
      <button class="modal-close" type="button" data-cold-actions-close aria-label="Close">×</button>
    </div>
    ${coldSheet.duplicates?.has(d.portfolioId)
      ? `<p class="field-hint cold-portfolio-warn">${WARNING_ICON}This transaction is already in ${deps.escapeHtml(d.portfolioName)}. Adding it again will double-count it.</p>`
      : ""}
    <div class="portfolio-editor-body cold-portfolio-form">
      <div class="settings-segmented full" role="group" aria-label="Type">
        ${["buy", "sell", "transfer"].map((kind) => `
          <button type="button" class="settings-segmented-option ${d.type === kind ? "active" : ""}" data-cold-pf-type="${kind}">
            ${kind === "buy" ? "Buy" : kind === "sell" ? "Sell" : "Transfer"}
          </button>`).join("")}
      </div>
      <label class="portfolio-editor-field">
        <span>Amount</span>
        <input type="text" inputmode="decimal" autocomplete="off" placeholder="0" data-cold-pf-amount value="${deps.escapeHtml(String(d.amount))}" />
      </label>
      <label class="portfolio-editor-field">
        <span>Price per KAS${d.priceLoading ? ' <span class="sk-spinner" aria-hidden="true"></span>' : ""}</span>
        <input type="text" inputmode="decimal" autocomplete="off" placeholder="0" data-cold-pf-price value="${deps.escapeHtml(String(d.price ?? ""))}" />
      </label>
      <div class="portfolio-editor-field cold-portfolio-total" ${total === null ? "hidden" : ""}><span>Total</span><span>${deps.escapeHtml(formatPortfolioCurrency(total || 0))}</span></div>
      <label class="portfolio-editor-field">
        <span>Date</span>
        <input type="datetime-local" data-cold-pf-date value="${deps.escapeHtml(d.dateLocal)}" />
      </label>
      <label class="portfolio-editor-field">
        <span>Note</span>
        <textarea rows="1" maxlength="120" placeholder="Optional" data-cold-pf-notes>${deps.escapeHtml(d.notes || "")}</textarea>
      </label>
      <p class="cold-sheet-section">Transaction</p>
      <p class="cold-sheet-txid">${deps.escapeHtml(coldSheet.tx.txId)}</p>
      <p class="field-hint">Recorded with the row, so this transaction is recognised if you add it again.</p>
    </div>
    <div class="modal-actions">
      <button class="secondary-button" type="button" data-cold-pf-back>Back</button>
      <button class="primary-button" type="button" data-cold-pf-confirm ${canConfirm ? "" : "disabled"}>Confirm</button>
    </div>`;
}

/// Moves to step 2 with everything prefilled, and starts the historical price lookup.
function openColdPortfolioDetails(portfolioId) {
  const portfolio = coldSheet.portfolios.find((p) => p.id === portfolioId);
  if (!portfolio) return;
  const tx = coldSheet.tx;
  const when = tx.blockTime ? Number(tx.blockTime) : Date.now();
  coldSheet = {
    ...coldSheet,
    kind: "portfolio-details",
    details: {
      portfolioId,
      portfolioName: portfolio.name,
      // Money leaving the address is a sale, money arriving a buy. Both editable.
      type: tx.outgoing ? "sell" : "buy",
      amount: trimmedDecimal(Number(tx.amountSompi) / 1e8),
      price: "",
      priceLoading: true,
      timestamp: when,
      dateLocal: toDatetimeLocalValue(when),
      notes: "",
    },
  };
  renderColdSheet();
  historicalKasPrice(when).then((price) => {
    // Never overwrite something already typed - the lookup can land late.
    if (coldSheet?.kind !== "portfolio-details" || coldSheet.details.price !== "") return;
    coldSheet.details.priceLoading = false;
    if (price != null) coldSheet.details.price = trimmedDecimal(Number(price), 6);
    renderColdSheet();
  }).catch(() => {
    if (coldSheet?.kind !== "portfolio-details") return;
    coldSheet.details.priceLoading = false;
    renderColdSheet();
  });
}

/// Records it, priced at what it was worth when it happened.
function confirmColdPortfolioAdd() {
  const d = coldSheet?.details;
  const tx = coldSheet?.tx;
  const amount = coldPortfolioNumber(d?.amount);
  if (!d || !tx || !(amount > 0)) return;
  addTransactionToPortfolio(d.portfolioId, {
    type: d.type,
    amountKas: amount,
    fiatValue: coldPortfolioTotal(d) ?? 0,
    timestamp: d.timestamp,
    notes: d.notes?.trim() ? d.notes.trim() : null,
    sourceTxId: tx.txId,
    sourceAddress: coldSheet.sourceAddress || detailEntries.find((e) => e.index === activeAddressIndex)?.address || null,
  });
  closeColdActionsSheet();
  // iOS PortfolioAddedCapsule: "Added to <portfolio>".
  deps.showToast?.(`Added to ${d.portfolioName}`);
}



/// The account row's ⋯ (iOS `ColdStorageAccountActionsSheet`).
function renderColdAccountSheet() {
  const body = modalsEl?.querySelector("[data-cold-actions-body]");
  const account = accounts.find((a) => a.id === coldSheet.id);
  if (!body || !account) return;
  body.innerHTML = `
    <div class="modal-head">
      <div><h2>${deps.escapeHtml(account.label)}</h2></div>
      <button class="modal-close" type="button" data-cold-actions-close aria-label="Close">×</button>
    </div>
    <div class="cold-action-rows">
      ${coldSheetRow({ attr: `data-cold-account-action="copy" data-id="${account.id}"`, title: "Copy kpub",
        subtitle: "Puts the extended public key on the clipboard.", icon: COPY_ICON })}
      ${coldSheetRow({ attr: `data-cold-account-action="qr" data-id="${account.id}"`, title: "Show kpub QR",
        subtitle: "Scan it into another device to watch this account there.", icon: QR_ICON })}
      ${coldSheetRow({ attr: `data-cold-account-action="rename" data-id="${account.id}"`, title: "Rename",
        subtitle: "Changes the name shown for this account.", icon: PENCIL_ICON })}
      ${coldSheetRow({ attr: `data-cold-account-action="notify" data-id="${account.id}"`,
        title: account.receiveNotifications === false ? "Turn On Receive Notifications" : "Turn Off Receive Notifications",
        subtitle: account.receiveNotifications === false ? "Notifies you when this account receives Kaspa." : "Stops notifying when this account receives Kaspa. Other accounts keep theirs.",
        icon: BELL_ICON })}
    </div>`;
}

/// One address row's ⋯ (iOS `addressActionsSheet` for an entry).
function renderColdAddressSheet() {
  const body = modalsEl?.querySelector("[data-cold-actions-body]");
  const account = activeAccount();
  const entry = detailEntries.find((e) => e.index === coldSheet.index);
  if (!body || !account || !entry) return;
  const i = entry.index;
  body.innerHTML = `
    <div class="modal-head">
      <div><h2>${deps.escapeHtml(displayLabelFor(account, i))}</h2><p class="cold-sheet-subtitle">${deps.escapeHtml(shortColdAddress(entry.address))}</p></div>
      <button class="modal-close" type="button" data-cold-actions-close aria-label="Close">×</button>
    </div>
    <div class="cold-action-rows">
      ${coldSheetRow({ attr: `data-cold-addr-action="rename" data-index="${i}"`, title: "Rename Address",
        subtitle: "Gives this address a label of your own.", icon: PENCIL_ICON })}
      ${coldSheetRow({ attr: `data-cold-addr-action="copy" data-index="${i}"`, title: "Copy Address",
        subtitle: "Puts the full address on the clipboard.", icon: COPY_ICON })}
      ${coldSheetRow({ attr: `data-cold-addr-action="qr" data-index="${i}"`, title: "Show QR Code",
        subtitle: "Full screen, for scanning with another device.", icon: QR_ICON })}
      ${(entry.balanceSompi || 0) === 0
        ? coldSheetRow({ attr: `data-cold-addr-action="hide" data-index="${i}"`, title: "Hide Address",
            subtitle: "Removes it from this list. Re-enable it in Address Visibility.", icon: EYE_SLASH_ICON, warn: true })
        : ""}
    </div>`;
}

function renderColdActionsSheet() {
  const body = modalsEl?.querySelector("[data-cold-actions-body]");
  if (!body) return;
  const discovering = detailBusy === "discover";
  const row = (action, title, subtitle, icon, disabled = false) =>
    coldSheetRow({ attr: `data-cold-${action}`, title, subtitle, icon, disabled });
  // iOS addressActionsSheet: while a discover runs the sheet counts up ("Checking address #N",
  // how many it has found so far) instead of the rows.
  const progress = detailDiscoveryProgress || { checkingIndex: 0, foundCount: 0 };
  body.innerHTML = `
    <div class="modal-head">
      <div><h2>Address Actions</h2></div>
      <button class="modal-close" type="button" data-cold-actions-close aria-label="Close">×</button>
    </div>
    ${discovering
      ? `<div class="cold-actions-busy">
           <span class="initial-sync-spinner" aria-hidden="true"></span>
           <strong>Checking address #${progress.checkingIndex}</strong>
           <span class="cold-actions-busy-count">${progress.foundCount === 0 ? "No used addresses yet" : `${progress.foundCount} found so far`}</span>
           <p>Checks the first thousand addresses whatever the gaps, then keeps going while it keeps finding.</p>
           <button type="button" class="cold-actions-keep-scanning" data-cold-actions-close>Close and Keep Scanning</button>
         </div>`
      : `<div class="cold-action-rows">
           ${row("generate", "Generate More Addresses", "Reveals the next unused address in this account.",
                 '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/></svg>')}
           ${row("discover", "Discover Addresses", "Finds addresses holding a balance or a domain.",
                 '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.35-4.35"/></svg>')}
           ${row("open-visibility", "Address Visibility", "Check off every address you want on the list, in one sitting.",
                 CHECKLIST_ICON)}
           ${row("refresh", "Refresh Balances", "Re-reads every address on this list from the chain.",
                 '<svg viewBox="0 0 24 24"><path d="M20 11a8 8 0 1 0-2.34 6.06M20 5v6h-6"/></svg>')}
         </div>
         ${detailDiscoverySummary ? `<p class="field-hint cold-actions-summary">${deps.escapeHtml(detailDiscoverySummary)}</p>` : ""}`}`;
}

function openColdSheet(spec) {
  const modal = modalsEl?.querySelector("[data-cold-actions-modal]");
  if (!modal) return;
  coldSheet = spec;
  renderColdSheet();
  modal.hidden = false;
}

function openColdActionsSheet() { openColdSheet({ kind: "actions" }); }

/// The transaction sheet for any address screen (chatting address, spending addresses): Open in
/// Explorer, and Add to Portfolio when the transaction moved money for `sourceAddress`. The
/// portfolio row records that address, so the cold-storage entry lookup is not used for it.
export function openTransactionActionsSheet({ txId, outgoing = false, amountSompi = null, blockTime = null, sourceAddress = null }) {
  if (!txId) return;
  openColdSheet({
    kind: "transaction",
    tx: { txId, outgoing: Boolean(outgoing), amountSompi: amountSompi != null ? Number(amountSompi) : null, blockTime: blockTime != null ? Number(blockTime) : null },
    sourceAddress: sourceAddress || null,
  });
}

function closeColdActionsSheet() {
  const modal = modalsEl?.querySelector("[data-cold-actions-modal]");
  if (modal) modal.hidden = true;
  // The discover summary belongs to the sheet it was shown in (iOS clears it on dismiss).
  if (coldSheet?.kind === "actions") detailDiscoverySummary = null;
  coldSheet = null;
}

// --- Address Visibility checklist (port of the spending-chain screen): a paged list of
// EVERY derivable address with a whole-row check toggle. Pages past maxIndex derive
// future indices on the fly — checking one reveals exactly it (intermediates stay
// hidden so the main list doesn't flood). Funded rows stay visible. ------------------

const COLD_VIS_PAGE_SIZE = 50;

/// Fills in a whole page's badges at once: one bulk activity call and one batched balance call
/// for fifty addresses, instead of a balance request and a history request EACH.
///
/// A failed probe caches nothing. The old version swallowed the error, treated the address as
/// having no balance and no history, and cached that - so one rate-limited request left a row
/// reading "Unused" for the rest of the session, which is worse than saying nothing: it is the
/// answer someone uses to decide an address is safe to hide. Unresolved rows keep the neutral "…"
/// and are asked again the next time the page is drawn.
async function coldVisUsageForPage(addresses, balanceByAddress) {
  const unknown = addresses.filter((a) => !visUsageCache.has(a));
  if (!unknown.length) return;

  // Balances first: an address holding something is "used" whatever its history says.
  const balances = new Map(unknown.map((a) => [a, balanceByAddress.get(a)]));
  const needBalance = unknown.filter((a) => balances.get(a) === undefined);
  if (needBalance.length) {
    try {
      const fetched = await fetchBalancesBatch(needBalance);
      for (const [address, sompi] of fetched) balances.set(address, sompi);
    } catch { /* leave them undefined - unresolved, not zero */ }
  }

  const activity = await fetchActiveAddresses(unknown).catch(() => null);
  for (const address of unknown) {
    const sompi = balances.get(address);
    if (sompi === undefined) continue;          // balance unknown - say nothing
    if (sompi > 0) { visUsageCache.set(address, { sompi, used: true }); continue; }
    if (!activity) continue;                    // usage unknown - say nothing
    visUsageCache.set(address, { sompi: 0, used: activity.has(address) });
  }
}

function renderVisibility() {
  const account = activeAccount();
  if (!account) { activeAccountId = null; renderList(); return; }
  const hiddenSet = new Set(account.hidden.map(Number));
  const start = visibilityPage * COLD_VIS_PAGE_SIZE;
  const end = start + COLD_VIS_PAGE_SIZE - 1;
  let addresses = [];
  try { addresses = deriveReceiveAddresses(account.kpub, start, end + 1); }
  catch { addresses = []; }
  const balanceByIndex = new Map(detailEntries.map((e) => [e.index, e.balanceSompi]));

  const rowsHtml = addresses.map((address, i) => {
    const index = start + i;
    const isVisible = index <= account.maxIndex && !hiddenSet.has(index);
    const customLabel = (account.labels?.[index] ?? account.labels?.[String(index)] ?? "").toString().trim();
    const checkSvg = isVisible
      ? '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="currentColor" stroke="none"/><path class="spending-vis-check" d="m7.5 12.5 3 3 6-6.5"/></svg>'
      : '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9.2"/></svg>';
    return `
      <div class="spending-visibility-row${isVisible ? "" : " off"}" data-cold-vis-row="${index}" data-address="${deps.escapeHtml(address)}">
        <button type="button" class="spending-visibility-toggle${isVisible ? " on" : ""}" aria-pressed="${isVisible}" aria-label="Toggle visibility of address #${index}">${checkSvg}</button>
        <div class="spending-visibility-info">
          <div class="spending-visibility-head">
            <span class="spending-address-index">#${index}</span>
            ${customLabel ? `<span class="spending-visibility-label">${deps.escapeHtml(customLabel)}</span>` : ""}
            <span class="spending-address-usage spending-visibility-usage" data-cold-vis-usage="${index}">…</span>
          </div>
          <span class="spending-address-value">${deps.escapeHtml(`${address.slice(0, 16)}…${address.slice(-6)}`)}</span>
        </div>
      </div>`;
  }).join("");

  rootEl.innerHTML = `
    <div class="kaposts-thread-header cold-detail-header">
      <button class="kaposts-icon-button" type="button" data-cold-vis-done aria-label="Back">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10.5 19.5 3 12m0 0 7.5-7.5M3 12h18"/></svg>
      </button>
      <strong>Address Visibility</strong>
      <button class="chatting-address-back spending-visibility-done" type="button" data-cold-vis-done>Done</button>
    </div>
    <div class="manage-address-list spending-visibility-list cold-visibility-list">
      ${rowsHtml || '<p class="cold-detail-note">Could not derive addresses for this kpub.</p>'}
    </div>
    <div class="manage-address-actions spending-visibility-pager">
      <button class="spending-visibility-page-btn" type="button" data-cold-vis-prev aria-label="Previous page" ${visibilityPage === 0 ? "disabled" : ""}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5 8 12l7 7"/></svg>
      </button>
      <span class="spending-visibility-range">#${start} - #${end}</span>
      <button class="spending-visibility-page-btn" type="button" data-cold-vis-next aria-label="Next page">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg>
      </button>
    </div>`;

  // Usage fill: funded rows show their balance, the rest Used/Unused. Two requests for the whole
  // page rather than two per address.
  const token = ++visibilityToken;
  (async () => {
    const balanceByAddress = new Map(addresses.map((address, i) => [address, balanceByIndex.get(start + i)]));
    await coldVisUsageForPage(addresses, balanceByAddress);
    if (token !== visibilityToken) return;
    addresses.forEach((address, i) => {
      const usage = visUsageCache.get(address);
      // No answer means no claim: the row keeps its "…" rather than asserting "Unused".
      if (!usage) return;
      const cell = rootEl?.querySelector(`[data-cold-vis-usage="${start + i}"]`);
      if (!cell) return;
      if (usage.sompi > 0) {
        cell.textContent = `${(usage.sompi / 1e8).toFixed(4)} ${KAS_UNIT}`;
        cell.classList.add("used");
      } else {
        cell.textContent = usage.used ? "Used" : "Unused";
        cell.classList.add(usage.used ? "used" : "unused");
      }
      // Funded rows cannot be hidden, so their toggle is dimmed - the same cue iOS gives, said
      // before the tap rather than by a toast after it.
      if (usage.sompi > 0) {
        rootEl?.querySelector(`[data-cold-vis-row="${start + i}"] .spending-visibility-toggle`)?.classList.add("locked");
      }
    });
  })();
}

async function toggleVisibilityRow(index, address) {
  const account = activeAccount();
  if (!account) return;
  // Funded rows don't toggle (iOS ColdStorageAddressVisibilityView.toggle) - the row says so by
  // its dimmed check, so a click on one simply does nothing.
  const knownSompi = detailEntries.find((e) => e.index === index)?.balanceSompi;
  const cachedSompi = visUsageCache.get(address)?.sompi;
  if ((knownSompi || 0) > 0 || (cachedSompi || 0) > 0) return;
  const hiddenSet = new Set(account.hidden.map(Number));
  const isVisible = index <= account.maxIndex && !hiddenSet.has(index);
  if (isVisible) {
    // Hiding is a display preference, never a way to lose sight of real funds: it needs a live
    // zero-balance answer (iOS ColdStorageManager.setAddressHidden), and fails closed.
    if (!(await addressConfirmedEmpty(address))) return;
    if (activeAccount() !== account || !showingVisibility) return;
    // Re-read: another row may have been toggled while the balance was being asked.
    const latest = new Set(account.hidden.map(Number));
    latest.add(index);
    account.hidden = [...latest];
    saveState();
    renderVisibility();
    return;
  } else if (index <= account.maxIndex) {
    hiddenSet.delete(index);
  } else {
    // Revealing a future index extends the chain to cover it, keeping the
    // intermediate indices hidden so they don't flood the main list.
    for (let i = account.maxIndex + 1; i < index; i++) hiddenSet.add(i);
    hiddenSet.delete(index);
    account.maxIndex = index;
  }
  account.hidden = [...hiddenSet];
  saveState();
  renderVisibility();
}

// --- Per-address screen (matches iOS ColdStorageAddressTransactionHistoryView:
// centered balance, "Transaction History | UTXOs" segmented tabs, Receive/Send
// capsules pinned at the bottom, globe -> explorer in the header). -------------

function addressTxRowsHtml(entry) {
  if (addrTxs.state === "loading" && !addrTxs.txs.length) return COLD_LIST_SPINNER;
  if (addrTxs.state === "error") return `<div class="manage-address-empty cold-txs-failed"><span>Could not load transactions.</span><button type="button" class="cold-inline-link" data-cold-txs-retry>Try Again</button></div>`;
  if (!addrTxs.txs.length) return '<div class="manage-address-empty">No transactions yet.</div>';
  return addrTxs.txs.map((tx) => {
    const info = deps.txDirectionForAddress(tx, entry.address);
    const outgoing = info?.isOutgoing === true;
    const dirClass = outgoing ? "outgoing" : "incoming";
    return `
      <button type="button" class="manage-address-row" data-cold-tx="${deps.escapeHtml(tx.transaction_id || "")}"
        data-cold-tx-out="${outgoing ? "1" : "0"}"${info ? ` data-cold-tx-amount="${Number(info.amountSompi)}"` : ""}${tx.block_time ? ` data-cold-tx-time="${Number(tx.block_time)}"` : ""}>
        <span class="manage-address-row-icon ${dirClass}">${outgoing ? "↑" : "↓"}</span>
        <span class="manage-address-row-meta">
          <strong>${info == null ? "Transaction" : outgoing ? "Sent" : "Received"}</strong>
          <span class="manage-address-row-txid">${deps.escapeHtml(tx.transaction_id || "")}</span>
          ${tx.block_time ? `<span class="manage-address-row-time">${deps.escapeHtml(new Date(Number(tx.block_time)).toLocaleString())}</span>` : ""}
        </span>
        <span class="manage-address-row-trailing">
          ${info ? `<span class="manage-address-row-amounts"><span class="manage-address-row-amount ${dirClass}">${outgoing ? "-" : "+"}${fmtKasExact(Number(info.amountSompi))} ${KAS_UNIT}</span>${deps.transactionFeeText?.(tx) ? `<span class="manage-address-row-fee">${deps.escapeHtml(deps.transactionFeeText(tx))}</span>` : ""}</span>` : ""}
          <span class="manage-address-row-open" aria-hidden="true">${EXTERNAL_ICON}</span>
        </span>
      </button>`;
  }).join("");
}

function addressUtxoRowsHtml(entry) {
  if (addrUtxos.state === "loading" && !addrUtxos.entries.length) return COLD_LIST_SPINNER;
  // An outage is not an empty address (iOS UtxoLoadFailureRow): the list keeps what it had, and
  // only an empty one says the coins could not be read.
  if (!addrUtxos.entries.length) {
    return addrUtxos.state === "error"
      ? utxoLoadFailureHtml(addrUtxos.error, "data-cold-utxos-retry")
      : '<div class="manage-address-empty">No UTXOs.</div>';
  }
  const labels = coldUtxoLabels(entry.address);
  // Compound row above the list when >1 UTXO, matching iOS's UTXOs-tab section.
  const compoundRow = addrUtxos.entries.length > 1
    ? `<button type="button" class="cold-compound-row" data-cold-compound>
         ${MERGE_ICON}
         Compound UTXOs
       </button>
       <p class="cold-compound-note">Combines all UTXOs at this address into a single one, to reduce the number of inputs a future send needs.</p>`
    : "";
  // iOS utxoRow: icon, then the label, the amount and the outpoint stacked; "Coinbase" and the
  // rename pencil at the end.
  return compoundRow + addrUtxos.entries.map((utxo) => {
    const key = utxoOutpointKey(utxo.outpoint || {});
    const label = labels[key];
    return `
      <div class="manage-address-utxo-row cold-utxo-row">
        <span class="cold-utxo-icon" aria-hidden="true">${utxo.isCoinbase ? CUBE_ICON : UTXO_ICON}</span>
        <div class="manage-address-utxo-meta">
          ${label ? `<span class="manage-address-utxo-label">${deps.escapeHtml(label)}</span>` : ""}
          <span class="cold-utxo-amount">${fmtKasExact(Number(utxo.amount || 0))} ${KAS_UNIT}</span>
          <span class="manage-address-utxo-outpoint">${deps.escapeHtml(key)}</span>
        </div>
        ${utxo.isCoinbase ? '<span class="cold-coinbase-tag">Coinbase</span>' : ""}
        <button type="button" class="cold-inline-icon" data-cold-utxo-rename="${deps.escapeHtml(key)}" aria-label="Rename UTXO">${PENCIL_ICON}</button>
      </div>`;
  }).join("");
}

/// iOS UtxoLoadFailureRow: the node could not be asked, said in place of "no coins".
function utxoLoadFailureHtml(detail, retryAttr) {
  return `
    <div class="cold-utxo-failure" role="alert">
      <strong>${WARNING_ICON}Couldn't load the coins at this address</strong>
      ${detail ? `<span>${deps.escapeHtml(detail)}</span>` : ""}
      <button type="button" class="cold-inline-link" ${retryAttr}>Try Again</button>
    </div>`;
}

function renderAddressScreen() {
  const account = activeAccount();
  const entry = detailEntries.find((e) => e.index === activeAddressIndex);
  if (!account || !entry) { activeAddressIndex = null; renderDetail(); return; }
  const balanceSompi = addrUtxos.state === "ready"
    ? addrUtxos.entries.reduce((sum, u) => sum + Number(u.amount || 0), 0)
    : (entry.balanceSompi || 0);
  rootEl.innerHTML = `
    <div class="kaposts-thread-header cold-detail-header">
      <button class="kaposts-icon-button" type="button" data-cold-addr-back aria-label="Back">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10.5 19.5 3 12m0 0 7.5-7.5M3 12h18"/></svg>
      </button>
      <strong>${deps.escapeHtml(displayLabelFor(account, entry.index))}</strong>
      <!-- Stands in for iOS's pull to refresh on the History and UTXOs lists. -->
      <button class="kaposts-icon-button cold-globe-link" type="button" data-cold-addr-refresh aria-label="Refresh" title="Refresh">${REFRESH_ICON}</button>
      <a class="kaposts-icon-button cold-globe-link" href="${deps.escapeHtml(deps.explorerAddressUrl(entry.address))}" target="_blank" rel="noopener" aria-label="View address in explorer">
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18"/></svg>
      </a>
    </div>
    <div class="spending-detail-balance">
      <span class="spending-detail-balance-label">Balance</span>
      <span class="spending-detail-balance-value">${fmtKasExact(balanceSompi)} ${KAS_UNIT}</span>
    </div>
    <!-- History / UTXOs / Domains on the app's underline tab bar (iOS b96d727, 718b88c, fe52376). -->
    <nav class="domains-tabs address-tabs" aria-label="Cold address view">
      <button type="button" class="domains-tab ${addressTab === "transactions" ? "active" : ""}" data-cold-tab="transactions">History</button>
      <button type="button" class="domains-tab ${addressTab === "utxos" ? "active" : ""}" data-cold-tab="utxos">UTXOs</button>
      <button type="button" class="domains-tab ${addressTab === "kachat" ? "active" : ""}" data-cold-tab="kachat">Domains</button>
    </nav>
    <div class="manage-address-list cold-address-panel">
      ${addressTab === "transactions" ? addressTxRowsHtml(entry) : addressTab === "utxos" ? addressUtxoRowsHtml(entry) : "<div data-cold-kachat-names></div>"}
    </div>
    <div class="cold-bottom-actions">
      <button class="primary-button cold-capsule" type="button" data-cold-addr-receive>
        <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM20 14v3M14 20h3M20 18v3"/></svg>
        Receive
      </button>
      <button class="primary-button cold-capsule" type="button" data-cold-addr-send ${balanceSompi === 0 ? "disabled" : ""}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 16V8M8 12l4-4 4 4"/></svg>
        Send
      </button>
    </div>`;
  // The Domains tab: a card per name service (iOS fe52376); .kachat opens this address's own names,
  // live where the registry is launched (iOS 881ada6). A name opens read-only here - a KasSigner
  // address signs on its device.
  if (addressTab === "kachat") {
    const namesEl = rootEl.querySelector("[data-cold-kachat-names]");
    if (namesEl) renderAddressDomainsTab(namesEl, entry.address);
  }
}

async function openAddressScreen(index) {
  const account = activeAccount();
  const entry = detailEntries.find((e) => e.index === index);
  if (!account || !entry) return;
  activeAddressIndex = index;
  saveColdSpot({ accountId: activeAccountId, addressIndex: index });
  addressTab = "transactions";
  addrTxs = { state: "loading", txs: [], error: null };
  addrUtxos = { state: "loading", entries: [], error: null };
  const token = ++addrToken;
  render();

  // Transactions and UTXOs load concurrently; each re-renders on arrival.
  loadAddrTxs(entry, token);
  loadAddrUtxos(entry, token);
}

/// The address screen's History (iOS loadTransactions). A refresh keeps the rows on screen while
/// it asks again.
async function loadAddrTxs(entry, token) {
  try {
    const base = String(getEndpoint("kaspaApi") || "https://api.kaspa.org").replace(/\/+$/, "");
    const url = `${base}/addresses/${encodeURIComponent(entry.address)}/full-transactions?limit=200&offset=0&resolve_previous_outpoints=light`;
    const response = await fetch(url, { headers: { Accept: "application/json" }, cache: "no-store" });
    if (!response.ok) throw new Error(`Kaspa API returned ${response.status}`);
    const txs = await response.json();
    if (addrToken !== token) return;
    addrTxs = { state: "ready", txs: Array.isArray(txs) ? txs : [], error: null };
  } catch (error) {
    if (addrToken !== token) return;
    addrTxs = { state: "error", txs: [], error: error.message };
  }
  render();
}

/// The address screen's UTXOs (iOS loadUtxos): a failure keeps what the list had.
async function loadAddrUtxos(entry, token) {
  try {
    const balance = await deps.engine.balanceForAddress(entry.address);
    if (addrToken !== token) return;
    addrUtxos = { state: "ready", entries: balance.entries || [], error: null };
    // Keep the account detail's cached balance in sync with what the node reports.
    const fresh = Number(balance.totalSompi ?? 0);
    entry.balanceSompi = fresh;
    balanceCache.set(entry.address, fresh);
  } catch (error) {
    if (addrToken !== token) return;
    addrUtxos = { state: "error", entries: addrUtxos.entries || [], error: userFacingError(error) };
  }
  render();
}

/// The refresh control on the address screen: both lists again, without blanking them first.
function refreshAddressScreen() {
  const entry = detailEntries.find((e) => e.index === activeAddressIndex);
  if (!entry) return;
  const token = ++addrToken;
  addrTxs = { ...addrTxs, state: addrTxs.txs.length ? addrTxs.state : "loading" };
  addrUtxos = { ...addrUtxos, state: addrUtxos.entries.length ? addrUtxos.state : "loading" };
  render();
  loadAddrTxs(entry, token);
  loadAddrUtxos(entry, token);
}

// ---------------------------------------------------------------------------
// KSPT send flow (iOS ColdSendFlowView): form -> build unsigned tx -> animated
// KSPT QR for the KasSigner device -> scan the signed response back with the
// webcam -> verify it matches what was sent for signing -> broadcast.
// ---------------------------------------------------------------------------

let send = null;              // null = closed; see openSendFlow for the state shape
let sendFrameTimer = null;    // animated-QR auto-advance
let sendScanStream = null;    // webcam MediaStream while scanning the signed response
let sendScanRunning = false;
let sendPreviewTimer = null;
let sendResolveToken = 0;

const TIER_MULTIPLIER = { normal: 1n, fast: 2n, priority: 5n };

function fmtKasBig(sompi) {
  const value = BigInt(sompi ?? 0);
  const s = value.toString().padStart(9, "0");
  return `${s.slice(0, -8) || "0"}.${s.slice(-8)}`;
}

/** The typed amount as KAS, converting from fiat when that's the active unit — null while
 *  empty/invalid, or (fiat mode) while there's no live price to convert with. */
function sendAmountKas() {
  const raw = Number.parseFloat(send?.amountText || "");
  if (!Number.isFinite(raw) || raw <= 0) return null;
  if (send.amountUnit === "fiat") {
    if (!send.price || send.price <= 0) return null;
    return raw / send.price;
  }
  return raw;
}

// KAS through the one exact parser (engine/amounts.js, iOS IOS-010): "1,5" is 1.5, never 1, and
// nothing past the supply. A currency amount is converted at the live price, to whole sompi.
function sendAmountSompi() {
  if (send?.amountUnit !== "fiat") {
    const sompi = sompiFromUserText(String(send?.amountText || ""));
    return sompi != null && sompi > 0n ? sompi : null;
  }
  const kas = sendAmountKas();
  const sompi = kas === null ? null : kasToSompi(kas);
  return sompi != null && sompi > 0n ? sompi : null;
}

/** Live value of whichever unit ISN'T being typed (iOS conversionLabelText):
 *  "≈ $1.23" while typing KAS, "≈ 12.34 KAS" while typing fiat. */
function sendConversionText() {
  const kas = sendAmountKas();
  if (kas === null) return null;
  if (send.amountUnit === "fiat") return `≈ ${kas.toLocaleString(undefined, { maximumFractionDigits: 8 })} ${KAS_UNIT}`;
  if (!send.price || send.price <= 0) return null;
  return `≈ ${deps.formatFiatValue(kas, send.price)}`;
}

function sendEffectiveAddress() {
  return send.resolvedAddress || send.toInput.trim();
}

function sendHasValidRecipient() {
  if (send.resolvedAddress) return true;
  return send.validAddress && !send.resolvingKns;
}

/** Reference mass: fixed 1-input/2-output guess until the input count is known; the
 *  compound flow's fixed UTXO set uses its exact count (iOS referenceMass). */
function sendReferenceMass() {
  if (send.manualUtxoKeys?.length) return calculateMass(send.manualUtxoKeys.length, [34, 34], 0);
  return REFERENCE_MASS_FOR_FEE_EDITOR;
}

function sendBaseFeeRate() {
  return send.liveFeeRate ?? MIN_RELAY_FEE_PER_GRAM;
}

function sendDefaultFee() {
  return calculateFee(sendReferenceMass(), sendBaseFeeRate());
}

function sendExtraFee() {
  if (send.customExtraFeeSompi !== null) return send.customExtraFeeSompi;
  return sendDefaultFee() * (TIER_MULTIPLIER[send.feeTier] - 1n);
}

/** The live preview (automatic selection only) takes priority over the reference-mass
 *  guess — it reflects the real input count this amount+fee needs. */
function sendEffectiveFee() {
  if (!send.manualUtxoKeys && send.preview) return send.preview.feeSompi;
  return sendDefaultFee() + sendExtraFee();
}

/** Always an explicit rate (never null) so the fee shown and the fee built with are the
 *  same number — iOS feeRateOverride. */
function sendFeeRateOverride() {
  if (send.feeTier === "normal" && send.customExtraFeeSompi === null) return sendBaseFeeRate();
  const mass = sendReferenceMass();
  const fee = sendDefaultFee() + sendExtraFee();
  return (fee + mass - 1n) / mass; // ceil division
}

async function openSendFlow({ compound = false } = {}) {
  const entry = detailEntries.find((e) => e.index === activeAddressIndex);
  if (!entry) return;
  send = {
    step: "form",
    isCompound: compound,
    fromAddress: entry.address,
    availableSompi: BigInt(entry.balanceSompi || 0),
    toInput: compound ? entry.address : "",
    resolvedAddress: null,
    resolvedDomain: null,
    knsError: null,
    resolvingKns: false,
    validAddress: compound,
    amountText: "",
    amountUnit: "kas", // "kas" | "fiat" — which unit the amount field is typed in
    price: null,       // live KAS price in the user's selected currency
    feeTier: "normal",
    customExtraFeeSompi: null,
    editingFee: false,
    liveFeeRate: null,
    preview: null,
    manualUtxoKeys: null,
    // Coin Control (iOS CoinControlView): the address's spendable set, loaded on demand when the
    // picker is opened, and the keys ticked in it. `manualUtxoKeys` stays the one thing the build
    // reads, so a manual selection and compound's fixed set travel the same path.
    coinControlUtxos: null,
    coinControlLoading: false,
    coinControlSelection: [],
    compoundHasMore: false,
    estimatingMax: false,
    error: null,
    unsigned: null,
    frames: [],
    frameIndex: 0,
    playing: true,
    scanProgress: null,
    txId: null,
  };
  const modal = modalsEl.querySelector("[data-cold-send-modal]");
  if (modal) modal.hidden = false;
  renderSendFlow();

  // Fetched once and reused everywhere the fee needs computing (form preview, QR screen,
  // real build) so all three show the same number — iOS liveFeeRateSompiPerGram.
  fetchQuotedFeeRateSompiPerGram().then((rate) => {
    if (!send) return;
    send.liveFeeRate = rate;
    scheduleSendPreview();
    renderSendFlow();
  });

  // Live KAS price for the fiat toggle + conversion hint (best-effort — the flow works
  // KAS-only without it, the toggle just explains the price is unavailable).
  deps.fetchKasPrice?.().then((price) => {
    if (!send) return;
    send.price = Number(price) || null;
    updateSendConversionHint();
  }).catch(() => { /* KAS-only is fine */ });

  if (compound) {
    try {
      const { utxoKeys, hasMore } = await compoundInputs({ engine: deps.engine, fromAddress: entry.address });
      if (!send) return;
      send.manualUtxoKeys = utxoKeys;
      send.compoundHasMore = hasMore;
      await sendSetMax();
    } catch (error) {
      if (!send) return;
      send.step = "failed";
      send.error = error.message;
      renderSendFlow();
    }
  }
}

function closeSendFlow() {
  stopSendFrameTimer();
  stopSendScan();
  closeActiveScanner(); // a recipient scan opened from this sheet must not outlive it
  if (sendPreviewTimer) { clearTimeout(sendPreviewTimer); sendPreviewTimer = null; }
  send = null;
  const modal = modalsEl?.querySelector("[data-cold-send-modal]");
  if (modal) modal.hidden = true;
}

function scheduleSendPreview() {
  if (sendPreviewTimer) clearTimeout(sendPreviewTimer);
  if (!send) return;
  send.preview = null;
  const amountSompi = sendAmountSompi();
  if (send.manualUtxoKeys || amountSompi === null) return;
  const rate = sendFeeRateOverride();
  sendPreviewTimer = window.setTimeout(async () => {
    if (!send) return;
    const preview = await previewAutomaticSelection({
      engine: deps.engine, fromAddress: send.fromAddress, amountSompi, feeRateSompiPerGram: rate,
    });
    if (!send || send.step !== "form") return;
    if (sendAmountSompi() !== amountSompi) return; // superseded by newer input
    send.preview = preview;
    renderSendFlow();
  }, 400);
}

function handleSendRecipientInput(raw) {
  if (!send) return;
  send.toInput = raw;
  send.resolvedAddress = null;
  send.resolvedDomain = null;
  send.knsError = null;
  send.resolvingKns = false;
  // Every service's answer for a typed name and the one in use: the rest go under Other domains
  // (iOS 6ac48a7 ColdSendFlowView).
  send.nameResolutions = [];
  send.selectedTld = null;
  const trimmed = raw.trim();
  const token = ++sendResolveToken;

  if (!trimmed) {
    send.validAddress = false;
    renderSendStatusOnly();
    return;
  }
  if (trimmed.startsWith("kaspa:") || trimmed.startsWith("kaspatest:")) {
    send.validAddress = isValidKaspaAddress(deps.engine, trimmed);
    renderSendStatusOnly();
    return;
  }
  send.validAddress = false;
  if (deps.engine.looksLikeName?.(trimmed)) {
    send.resolvingKns = true;
    renderSendStatusOnly();
    window.setTimeout(async () => {
      if (!send || token !== sendResolveToken) return;
      try {
        // Every name service, in priority: the ending typed, else .kachat, .kas, .k, .kaspa. The
        // resolved line names which one answered; the others are offered under Other domains.
        const { results, resolution } = await deps.engine.lookUpName(trimmed);
        if (!send || token !== sendResolveToken) return;
        send.nameResolutions = results || [];
        if (resolution) {
          send.resolvedAddress = resolution.ownerAddress;
          send.resolvedDomain = resolution.domain;
          send.selectedTld = resolution.tld || null;
        } else {
          send.knsError = nameNotFoundText(trimmed, results);
        }
      } catch {
        if (!send || token !== sendResolveToken) return;
        send.knsError = nameNotFoundText(trimmed);
      }
      send.resolvingKns = false;
      renderSendStatusOnly();
    }, 300);
  } else {
    renderSendStatusOnly();
  }
}

async function sendSetMax() {
  if (!send || !sendHasValidRecipient() || send.estimatingMax) return;
  send.estimatingMax = true;
  renderSendFlow();
  try {
    const maxSompi = await estimateMaxAmount({
      engine: deps.engine,
      fromAddress: send.fromAddress,
      feeRateOverride: sendFeeRateOverride(),
      manualUtxoKeys: send.manualUtxoKeys,
    });
    if (!send) return;
    const maxKas = Number(maxSompi) / 1e8;
    // Reflect Max into whichever unit is currently being typed (iOS setMaxKas). A currency amount
    // is rounded DOWN, so it never converts back to more than Max (audit DSK-042).
    send.amountText = send.amountUnit === "fiat" && send.price > 0
      ? fiatTextFloorFromSompi(maxSompi, send.price, (deps.currencyCode?.() || "") === "BTC" ? 8 : 2)
      : maxKas.toFixed(8);
  } catch { /* leave amount as-is */ }
  if (!send) return;
  send.estimatingMax = false;
  scheduleSendPreview();
  renderSendFlow();
}

/// Opens the picker, loading the address's spendable set on first use.
///
/// Seeded from whatever is already selected, so reopening it shows the current choice rather than
/// starting blank - and the set is re-fetched each time, because a UTXO spent elsewhere since the
/// last look must not still be tickable.
async function openCoinControl() {
  if (!send) return;
  send.step = "coincontrol";
  send.coinControlLoading = true;
  send.coinControlSelection = send.manualUtxoKeys ? [...send.manualUtxoKeys] : [];
  send.coinControlError = null;
  renderSendFlow();
  let utxos = [];
  try {
    utxos = await fetchSpendableUtxos(deps.engine, send.fromAddress);
  } catch (error) {
    if (!send) return;
    // Said in place of "no coins" (iOS CoinControlView.loadError): an outage must never read as
    // an empty address when the coins here are about to be spent.
    send.coinControlError = userFacingError(error);
  }
  if (!send || send.step !== "coincontrol") return;
  // In the node's order, as iOS lists them.
  send.coinControlUtxos = [...utxos];
  // Drop anything that has been spent since the selection was made, rather than carrying a key
  // the build would fail on.
  const live = new Set(send.coinControlUtxos.map(utxoKey));
  send.coinControlSelection = send.coinControlSelection.filter((k) => live.has(k));
  send.coinControlLoading = false;
  renderSendFlow();
}

/// Confirms the picker. An empty selection means AUTOMATIC, not "spend nothing" - the same
/// nil-means-automatic contract iOS passes back from CoinControlView.
function commitCoinControl() {
  if (!send) return;
  send.manualUtxoKeys = send.coinControlSelection.length ? [...send.coinControlSelection] : null;
  send.step = "form";
  // The fee depends on the input count, and the automatic preview is only meaningful without a
  // manual set, so both have to be recomputed rather than left showing the previous answer.
  scheduleSendPreview();
  renderSendFlow();
}

async function sendBuild() {
  const amountSompi = sendAmountSompi();
  if (!send || !sendHasValidRecipient() || amountSompi === null) return;
  send.step = "building";
  send.error = null;
  renderSendFlow();
  try {
    // Real coin control (compound's fixed set) wins; else a fresh automatic preview's
    // exact set passes through so the shown fee and the built fee are the same number.
    const unsigned = await buildUnsignedTransaction({
      engine: deps.engine,
      fromAddress: send.fromAddress,
      toAddress: sendEffectiveAddress(),
      amountSompi,
      feeRateOverride: sendFeeRateOverride(),
      manualUtxoKeys: send.manualUtxoKeys ?? send.preview?.utxoKeys ?? null,
    });
    if (!send) return;
    send.unsigned = unsigned;
    send.frames = chunkQrFrames(unsignedToKsptBytes(unsigned));
    send.frameIndex = 0;
    send.playing = true;
    send.step = "qr";
    renderSendFlow();
    startSendFrameTimer();
  } catch (error) {
    // A build that fails goes to the failed screen with Try Again (iOS buildTransaction).
    if (!send) return;
    send.step = "failed";
    send.error = error.message;
    renderSendFlow();
  }
}

// --- Animated QR display (iOS AnimatedQRDisplayView: 2.5s auto-advance, matching
// KasSee's own displayKsptQr — a scanning camera needs real time per frame) --------

function startSendFrameTimer() {
  stopSendFrameTimer();
  if (!send || send.frames.length <= 1) { drawSendFrame(); return; }
  drawSendFrame();
  sendFrameTimer = window.setInterval(() => {
    if (!send || send.step !== "qr" || !send.playing) return;
    send.frameIndex = (send.frameIndex + 1) % send.frames.length;
    drawSendFrame();
  }, 2500);
}

function stopSendFrameTimer() {
  if (sendFrameTimer) { clearInterval(sendFrameTimer); sendFrameTimer = null; }
}

async function drawSendFrame() {
  if (!send || send.step !== "qr") return;
  const canvas = modalsEl?.querySelector("[data-cold-send-qr-canvas]");
  if (!canvas) return;
  const frame = send.frames[send.frameIndex];
  if (!frame) return;
  try {
    // Error correction "L", version 1-6 only (iOS ByteModeQRCode) - what KasSigner reads.
    await drawKasSignerFrame(canvas, frame);
  } catch (error) {
    deps.appendEngineLog?.(`KSPT QR failed: ${error.message}`);
  }
  canvas.style.width = "280px";
  canvas.style.height = "280px";
  modalsEl.querySelectorAll("[data-cold-send-frame-dot]").forEach((dot, i) => {
    dot.classList.toggle("active", i === send.frameIndex);
  });
  const counter = modalsEl.querySelector("[data-cold-send-frame-counter]");
  if (counter) counter.textContent = `Frame ${send.frameIndex + 1} / ${send.frames.length}`;
  const playBtn = modalsEl.querySelector("[data-cold-send-frame-play]");
  if (playBtn) playBtn.textContent = send.playing ? "⏸" : "▶";
}

// --- Signed-response scanning: webcam + jsQR (BarcodeDetector only returns strings,
// which corrupts the binary signature bytes — jsQR's binaryData preserves them) -----

async function startSendScan() {
  if (!send) return;
  send.step = "scanning";
  send.scanProgress = null;
  send.cameraDenied = false;
  renderSendFlow();
  const video = modalsEl.querySelector("[data-cold-send-scan-video]");
  if (!video) return;
  try {
    sendScanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
  } catch {
    if (!send || send.step !== "scanning") return;
    send.cameraDenied = true;
    renderSendFlow();
    return;
  }
  video.srcObject = sendScanStream;
  sendScanRunning = true;

  const accumulator = new QrFrameAccumulator(looksLikeKspt);
  const grab = document.createElement("canvas");
  const ctx = grab.getContext("2d", { willReadFrequently: true });

  const tick = () => {
    if (!sendScanRunning || !send || send.step !== "scanning") return;
    if (video.readyState >= 2 && video.videoWidth > 0) {
      grab.width = video.videoWidth;
      grab.height = video.videoHeight;
      ctx.drawImage(video, 0, 0);
      const image = ctx.getImageData(0, 0, grab.width, grab.height);
      const code = jsQR(image.data, image.width, image.height, { inversionAttempts: "dontInvert" });
      if (code?.binaryData?.length) {
        const complete = accumulator.addFrame(new Uint8Array(code.binaryData));
        const progress = accumulator.progress;
        if (progress && (send.scanProgress?.received !== progress.received || send.scanProgress?.total !== progress.total)) {
          send.scanProgress = { ...progress, indices: accumulator.receivedFrameIndices };
          renderSendScanProgress();
        }
        if (complete) {
          stopSendScan();
          handleSignedResponse(complete);
          return;
        }
      }
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function stopSendScan() {
  sendScanRunning = false;
  sendScanStream?.getTracks().forEach((track) => track.stop());
  sendScanStream = null;
}

async function handleSignedResponse(bytes) {
  if (!send) return;
  send.step = "broadcasting";
  renderSendFlow();
  try {
    const decoded = decodeKspt(bytes);
    const txId = await broadcastSigned({ engine: deps.engine, unsigned: send.unsigned, decoded });
    if (!send) return;
    send.txId = txId;
    send.step = "success";
  } catch (error) {
    if (!send) return;
    send.step = "failed";
    send.error = error.message;
  }
  renderSendFlow();
}

// --- Send flow rendering ----------------------------------------------------

// The shared recipient card's status line (send-kaspa-components, iOS SendRecipientCard).
function sendRecipientStatusHtml() {
  return recipientStatusHtml({
    input: send.toInput,
    resolving: send.resolvingKns,
    error: send.knsError,
    resolvedAddress: send.resolvedAddress,
    resolvedName: send.resolvedDomain,
    valid: send.validAddress,
    nameResolutions: send.nameResolutions || [],
    selectedTld: send.selectedTld ?? null,
  });
}

/** Who the address resolves to (iOS ac0ef19): the create-chat card, in the recipient card. */
function sendRecipientCardHtml() {
  const trimmed = send.toInput.trim();
  if (!trimmed || send.resolvingKns || send.knsError) return "";
  const address = send.resolvedAddress || (send.validAddress ? trimmed : null);
  if (!address) return "";
  return deps.addressCardHtml?.(address, { domain: send.resolvedDomain, onLoaded: () => renderSendStatusOnly() }) || "";
}

/** The other unit's code while there's nothing to convert (iOS KaspaAmountEntry). */
function sendConversionLabel() {
  return sendConversionText() || (send.amountUnit === "fiat" ? KAS_UNIT : (deps.currencyCode?.() || "USD"));
}

/** In-place update of the amount entry's switch ("≈ …") and size — runs on every keystroke, so
 *  no full re-render (that would drop the input's focus/caret). */
function updateSendConversionHint() {
  if (!send) return;
  const toggle = modalsEl?.querySelector("[data-cold-send-unit]");
  if (toggle) toggle.hidden = !(send.price > 0);
  const hint = modalsEl?.querySelector("[data-cold-send-conversion]");
  if (hint) hint.textContent = sendConversionLabel();
  layoutAmountEntry(modalsEl?.querySelector("[data-cold-send-amount]"), modalsEl?.querySelector("[data-cold-send-unit-code]"));
}

function renderSendStatusOnly() {
  if (!send) return;
  const holder = modalsEl?.querySelector("[data-cold-send-status]");
  if (holder) holder.innerHTML = sendRecipientStatusHtml();
  const cardHost = modalsEl?.querySelector("[data-cold-send-resolution]");
  if (cardHost) cardHost.innerHTML = sendRecipientCardHtml();
  const check = modalsEl?.querySelector("[data-cold-send-check]");
  if (check) check.hidden = !(send.toInput.trim() && sendHasValidRecipient());
  // The saved Address Book name for what the recipient resolved to (iOS 00767a4).
  if (!send.isCompound) refreshRecipientAddressBook(modalsEl, "cold-send", send.resolvedAddress || send.toInput.trim());
  const buildBtn = modalsEl?.querySelector("[data-cold-send-build]");
  if (buildBtn && send.step === "form") buildBtn.disabled = !(sendHasValidRecipient() && sendAmountSompi() !== null);
  const maxBtn = modalsEl?.querySelector("[data-cold-send-max]");
  if (maxBtn && !send.estimatingMax) maxBtn.disabled = !(send.validAddress || send.resolvedAddress);
  updateSendConversionHint();
  scheduleSendPreview();
}

function renderSendScanProgress() {
  const el = modalsEl?.querySelector("[data-cold-send-scan-progress]");
  if (!el || !send) return;
  // iOS MultiFrameQRScannerView: one line until a frame lands, then the dots and "R / T frames".
  if (!send.scanProgress?.total) { el.innerHTML = `<p class="cold-send-scan-hint">Point camera at the KasSigner screen</p>`; return; }
  const { received, total, indices } = send.scanProgress;
  el.innerHTML = `<span class="cold-send-scan-dots">${Array.from({ length: total }, (_, i) =>
      `<span class="${indices?.has(i) ? "got" : ""}"></span>`).join("")}</span>
    <p class="cold-send-scan-count">${received} / ${total} frames</p>`;
}

function renderSendFlow() {
  const body = modalsEl?.querySelector("[data-cold-send-body]");
  if (!body || !send) return;
  // The signed-response scanner is its own screen on iOS (MultiFrameQRScannerView), titled for it.
  const title = send.step === "scanning" ? "Scan Signed Transaction" : send.isCompound ? "Compound UTXOs" : "Send from Cold Storage";
  const shortFrom = `${send.fromAddress.slice(0, 14)}...${send.fromAddress.slice(-6)}`;

  const header = `
    <div class="modal-header">
      <div><h2>${title}</h2></div>
      <button class="modal-close" type="button" data-cold-send-close aria-label="Close">×</button>
    </div>`;

  if (send.step === "form" || send.step === "building") {
    const building = send.step === "building";
    const canBuild = sendHasValidRecipient() && sendAmountSompi() !== null;
    const feeText = `~${fmtKasBig(sendEffectiveFee())} ${KAS_UNIT}`;
    // The same pieces as every Send Kaspa screen (send-kaspa-components.js, iOS 4d0324f): the
    // recipient card (locked to this address for Compound UTXOs), the amount entry, the
    // Available / From pills, the fee card with Coin Control, and - KasSigner signs, so nothing
    // moves here - a plain Build Unsigned Transaction button instead of slide to send.
    body.innerHTML = `
      ${header}
      <div class="sk-screen">
        <div class="sk-pills">
          ${infoPillHtml({ innerHtml: `From <code class="sk-pill-mono">${deps.escapeHtml(shortFrom)}</code>` })}
          ${infoPillHtml({ innerHtml: availablePillInnerHtml({ text: `Available ${fmtKasBig(send.availableSompi)} ${KAS_UNIT}` }) })}
        </div>
        ${recipientCardHtml({
          prefix: "cold-send",
          value: send.toInput,
          lockedAddress: send.isCompound ? send.fromAddress : null,
          valid: Boolean(send.toInput.trim()) && sendHasValidRecipient(),
          statusHtml: send.isCompound ? "" : sendRecipientStatusHtml(),
          cardHtml: send.isCompound ? "" : sendRecipientCardHtml(),
          savedNameAddress: send.resolvedAddress || send.toInput.trim(),
        })}
        ${send.isCompound ? `<p class="sk-caption">${send.compoundHasMore
          ? `This address has more than ${KSPT_MAX_INPUTS} UTXOs. KasSigner can sign at most ${KSPT_MAX_INPUTS} inputs per transaction, so this merges the largest ${KSPT_MAX_INPUTS} into one. Run Compound again afterward to keep combining the rest.`
          : "Merges all of this address's UTXOs into a single one, so future sends need fewer inputs."}</p>` : ""}
        ${amountEntryHtml({
          prefix: "cold-send",
          value: send.amountText,
          unitText: send.amountUnit === "kas" ? KAS_UNIT : (deps.currencyCode?.() || "USD"),
          conversionText: sendConversionLabel(),
          showToggle: send.price > 0,
          maxDisabled: !(send.validAddress || send.resolvedAddress),
          maxBusy: send.estimatingMax,
          ariaLabel: send.amountUnit === "kas" ? `Amount (${KAS_UNIT})` : `Amount (${deps.currencyCode?.() || "USD"})`,
        })}
        ${feeControlsHtml({
          prefix: "cold-send",
          feeText,
          editing: send.editingFee,
          customValue: fmtKasBig(sendEffectiveFee()),
          tier: send.customExtraFeeSompi !== null ? null : send.feeTier,
          showCoinControl: !send.isCompound,
          coinSummary: coinControlSummaryText(send.manualUtxoKeys?.length || 0),
        })}
        ${send.error ? `<p class="field-error sk-error">${deps.escapeHtml(send.error)}</p>` : ""}
        ${sendActionButtonHtml({
          attr: "cold-send-build",
          title: "Build Unsigned Transaction",
          requiresSlide: false,
          disabled: !canBuild,
          busy: building,
          busyLabel: "",
        })}
      </div>`;
    if (send.editingFee) {
      const feeInput = body.querySelector("[data-cold-send-fee-custom]");
      feeInput?.focus();
      feeInput?.select?.();
    }
    return;
  }

  if (send.step === "coincontrol") {
    const labels = coldUtxoLabels(send.fromAddress);
    const selected = new Set(send.coinControlSelection);
    const utxos = send.coinControlUtxos || [];
    const selectedTotal = utxos
      .filter((u) => selected.has(utxoKey(u)))
      .reduce((sum, u) => sum + BigInt(u.amountSompi), 0n);
    body.innerHTML = `
      <div class="modal-head">
        <div><h2>Coin Control</h2></div>
        <button class="modal-close" type="button" data-cold-coincontrol-cancel aria-label="Close">×</button>
      </div>
      ${send.coinControlLoading
        ? COLD_LIST_SPINNER
        : utxos.length === 0
          ? (send.coinControlError
            ? utxoLoadFailureHtml(send.coinControlError, "data-cold-coincontrol-retry")
            : `<p class="field-hint">No UTXOs found at this address.</p>`)
          : `
      <div class="cold-coincontrol-actions">
        <button type="button" class="cold-inline-link" data-cold-coincontrol-all>Select All</button>
        <button type="button" class="cold-inline-link" data-cold-coincontrol-none>Automatic (Clear Selection)</button>
      </div>
      <div class="cold-coincontrol-list">
        ${utxos.map((utxo) => {
          const key = utxoKey(utxo);
          const isOn = selected.has(key);
          const label = labels[key];
          return `
          <button type="button" class="cold-coincontrol-row${isOn ? " selected" : ""}" data-cold-coincontrol-toggle="${deps.escapeHtml(key)}">
            <span class="cold-coincontrol-check" aria-hidden="true">${isOn ? CHECK_ICON : CIRCLE_ICON}</span>
            <span class="cold-coincontrol-copy">
              ${label ? `<span class="cold-coincontrol-label">${deps.escapeHtml(label)}</span>` : ""}
              <span class="cold-coincontrol-amount">${fmtKasExact(utxo.amountSompi)} ${KAS_UNIT}</span>
              <span class="cold-coincontrol-outpoint">${deps.escapeHtml(String(utxo.transactionId).slice(0, 10))}...:${utxo.index}</span>
            </span>
          </button>`;
        }).join("")}
      </div>
      ${selected.size ? `<p class="field-hint cold-coincontrol-total">Selected: ${fmtKasExact(selectedTotal)} ${KAS_UNIT} (${selected.size} UTXO${selected.size === 1 ? "" : "s"})</p>` : ""}`}
      <div class="modal-actions">
        <button class="secondary-button" type="button" data-cold-coincontrol-cancel>Cancel</button>
        <button class="primary-button" type="button" data-cold-coincontrol-done ${send.coinControlLoading ? "disabled" : ""}>
          ${selected.size ? "Confirm Selection" : "Use Automatic Selection"}
        </button>
      </div>`;
    return;
  }

  if (send.step === "qr") {
    // iOS qrView: From / Available / Network Fee, the hint, the animated QR (dots, the frame
    // controls, then "Frame N / M"), and Scan Signed Transaction. Cancel is the only way back.
    body.innerHTML = `
      ${header}
      <div class="cold-send-qr-panel">
        <div class="cold-send-rows dark">
          <div class="cold-send-row"><span>From</span><code>${deps.escapeHtml(shortFrom)}</code></div>
          <div class="cold-send-row"><span>Available</span><span>${fmtKasBig(send.availableSompi)} ${KAS_UNIT}</span></div>
          <div class="cold-send-row"><span>Network Fee</span><span>${deps.escapeHtml(fmtKasBig(send.unsigned.feeSompi))} ${KAS_UNIT}</span></div>
        </div>
        <p class="cold-send-qr-hint">Scan this on your KasSigner device</p>
        <div class="cold-qr-frame"><canvas width="480" height="480" data-cold-send-qr-canvas></canvas></div>
        ${send.frames.length > 1 ? `
          <div class="cold-send-frame-dots">${send.frames.map((_, i) =>
            `<span data-cold-send-frame-dot class="${i === send.frameIndex ? "active" : ""}"></span>`).join("")}</div>
          <div class="cold-send-frame-controls">
            <button type="button" data-cold-send-frame-prev aria-label="Previous frame">⏮</button>
            <button type="button" data-cold-send-frame-play aria-label="Play/pause">${send.playing ? "⏸" : "▶"}</button>
            <button type="button" data-cold-send-frame-next aria-label="Next frame">⏭</button>
          </div>
          <p class="cold-send-frame-counter" data-cold-send-frame-counter>Frame ${send.frameIndex + 1} / ${send.frames.length}</p>` : ""}
        <button class="primary-button cold-capsule cold-send-start-scan" type="button" data-cold-send-start-scan>Scan Signed Transaction</button>
      </div>`;
    drawSendFrame();
    return;
  }

  if (send.step === "scanning") {
    // iOS MultiFrameQRScannerView. Without a camera it says so here, as iOS does, rather than
    // dropping back to the QR with a toast.
    body.innerHTML = send.cameraDenied
      ? `
      ${header}
      <div class="cold-send-camera-denied">
        <span class="cold-send-camera-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M4 8.5A1.5 1.5 0 0 1 5.5 7h2.1l1.3-2h6.2l1.3 2h2.1A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5Z"/><circle cx="12" cy="12.8" r="3.4"/></svg></span>
        <p class="cold-send-result-title">Camera Access Required</p>
        <p class="field-hint cold-send-fail-message">Please enable camera access in Settings to scan the signed transaction.</p>
      </div>
      <div class="modal-actions">
        <button class="secondary-button" type="button" data-cold-send-cancel-scan>Cancel</button>
      </div>`
      : `
      ${header}
      <div class="cold-send-scan-wrap">
        <div class="cold-send-scan-frame">
          <video data-cold-send-scan-video autoplay playsinline muted></video>
          <div class="cold-scan-target" aria-hidden="true">
            <span></span><span></span><span></span><span></span>
          </div>
        </div>
        <div class="cold-send-scan-progress" data-cold-send-scan-progress></div>
      </div>
      <div class="modal-actions">
        <button class="secondary-button" type="button" data-cold-send-cancel-scan>Cancel</button>
      </div>`;
    renderSendScanProgress();
    return;
  }

  if (send.step === "broadcasting") {
    body.innerHTML = `${header}
      <div class="cold-send-wait">
        <span class="initial-sync-spinner" aria-hidden="true"></span>
        <p>Broadcasting...</p>
      </div>`;
    return;
  }

  if (send.step === "success") {
    // iOS successView: the From card (full address and what was available), the check and
    // "Sent", the To card (what was typed), and the transaction ID opening the chosen explorer.
    const toText = send.isCompound ? send.fromAddress : send.toInput.trim();
    const explorerName = deps.explorerDisplayName?.() || "the explorer";
    body.innerHTML = `
      ${header}
      <div class="cold-send-card">
        <span class="cold-send-card-label">From</span>
        <code>${deps.escapeHtml(send.fromAddress)}</code>
        <span class="cold-send-card-sub">Available: ${fmtKasBig(send.availableSompi)} ${KAS_UNIT}</span>
      </div>
      <div class="cold-send-result-icon good">✓</div>
      <p class="cold-send-result-title">Sent</p>
      <div class="cold-send-card">
        <span class="cold-send-card-label">To</span>
        <code>${deps.escapeHtml(toText)}</code>
      </div>
      <a class="cold-send-txid" href="${deps.escapeHtml(deps.explorerTxUrl(send.txId))}" target="_blank" rel="noopener">
        <span>Transaction ID · tap to view in ${deps.escapeHtml(explorerName)} <span class="cold-send-txid-icon" aria-hidden="true">${EXTERNAL_ICON}</span></span><code>${deps.escapeHtml(send.txId)}</code>
      </a>
      <div class="modal-actions">
        <button class="primary-button" type="button" data-cold-send-done>Done</button>
      </div>`;
    return;
  }

  if (send.step === "failed") {
    body.innerHTML = `
      ${header}
      <div class="cold-send-result-icon bad">✕</div>
      <p class="cold-send-result-title">Something Went Wrong</p>
      <p class="field-hint cold-send-fail-message">${deps.escapeHtml(send.error || "")}</p>
      <div class="modal-actions">
        <button class="primary-button" type="button" data-cold-send-try-again>Try Again</button>
      </div>`;
  }
}

function commitCustomSendFee(text) {
  if (!send) return;
  send.editingFee = false;
  // The one exact parser (iOS IOS-010): parseFloat read "0,002" as 0.
  const totalSompi = sompiFromUserText(String(text ?? ""));
  if (totalSompi == null) { renderSendFlow(); return; }
  const base = sendDefaultFee();
  // Values below the tier-computed baseline clamp to zero extra, matching iOS.
  send.customExtraFeeSompi = totalSompi > base ? totalSompi - base : 0n;
  scheduleSendPreview();
  renderSendFlow();
}

function closeAllColdMenus() {
  if (!rootEl) return;
  rootEl.querySelectorAll(".spending-row-menu").forEach((m) => { m.hidden = true; });
  rootEl.querySelectorAll("[aria-haspopup]").forEach((b) => b.setAttribute("aria-expanded", "false"));
}

// ---------------------------------------------------------------------------
// Modals (persistent — live outside rootEl so re-renders can't destroy them)
// ---------------------------------------------------------------------------

let inputModalResolve = null;
let confirmModalResolve = null;

function buildModals() {
  modalsEl = document.createElement("div");
  modalsEl.innerHTML = `
    <div class="modal-backdrop" data-cold-input-modal hidden>
      <form class="contact-modal create-account-modal" data-cold-input-form>
        <div class="modal-header">
          <div><p class="modal-kicker" data-cold-input-kicker></p><h2 data-cold-input-title></h2></div>
          <button class="modal-close" type="button" data-cold-input-cancel aria-label="Close">×</button>
        </div>
        <p class="field-hint" data-cold-input-message hidden></p>
        <label class="field-label">
          <span data-cold-input-label></span>
          <input class="field-input" data-cold-input-field type="text" maxlength="200" autocomplete="off" spellcheck="false" />
        </label>
        <p class="field-hint" data-cold-input-footer hidden></p>
        <div class="modal-actions">
          <button class="secondary-button" type="button" data-cold-input-cancel>Cancel</button>
          <button class="primary-button" type="submit" data-cold-input-submit>Save</button>
        </div>
      </form>
    </div>
    <div class="modal-backdrop" data-cold-confirm-modal hidden>
      <form class="contact-modal create-account-modal" data-cold-confirm-form>
        <div class="modal-header">
          <div><h2 data-cold-confirm-title></h2></div>
          <button class="modal-close" type="button" data-cold-confirm-cancel aria-label="Close">×</button>
        </div>
        <p class="field-hint" data-cold-confirm-message></p>
        <div class="modal-actions">
          <button class="secondary-button" type="button" data-cold-confirm-cancel>Cancel</button>
          <button class="primary-button cold-danger-button" type="submit" data-cold-confirm-ok>Remove</button>
        </div>
      </form>
    </div>
    <div class="modal-backdrop" data-cold-qr-modal hidden>
      <div class="cold-qr-card" role="dialog" aria-modal="true">
        <div class="cold-qr-head">
          <strong data-cold-qr-title></strong>
          <button class="modal-close cold-qr-close" type="button" data-cold-qr-close aria-label="Close">×</button>
        </div>
        <div class="cold-qr-frame"><canvas width="480" height="480" data-cold-qr-canvas></canvas></div>
        <p class="cold-qr-address" data-cold-qr-address></p>
        <p class="cold-qr-note" data-cold-qr-note hidden></p>
        <p class="qr-tap-hint dark">Tap anywhere to copy</p>
      </div>
    </div>
    <div class="modal-backdrop" data-cold-actions-modal hidden>
      <div class="contact-modal cold-actions-modal" role="dialog" aria-modal="true" aria-label="Address Actions" data-cold-actions-body></div>
    </div>
    <div class="modal-backdrop" data-cold-send-modal hidden>
      <div class="contact-modal cold-send-modal" role="dialog" aria-modal="true" aria-label="Cold Storage send" data-cold-send-body></div>
    </div>
`;
  document.body.appendChild(modalsEl);

  const inputModal = modalsEl.querySelector("[data-cold-input-modal]");
  const inputForm = modalsEl.querySelector("[data-cold-input-form]");
  const inputField = modalsEl.querySelector("[data-cold-input-field]");
  inputForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const value = inputField.value;
    if (inputForm.dataset.required === "1" && !value.trim()) return;
    finishInputModal(value);
  });
  modalsEl.querySelectorAll("[data-cold-input-cancel]").forEach((b) => b.addEventListener("click", () => finishInputModal(null)));
  inputModal.addEventListener("mousedown", (event) => { if (event.target === inputModal) finishInputModal(null); });

  const confirmModal = modalsEl.querySelector("[data-cold-confirm-modal]");
  modalsEl.querySelector("[data-cold-confirm-form]").addEventListener("submit", (event) => {
    event.preventDefault();
    finishConfirmModal(true);
  });
  modalsEl.querySelectorAll("[data-cold-confirm-cancel]").forEach((b) => b.addEventListener("click", () => finishConfirmModal(false)));
  confirmModal.addEventListener("mousedown", (event) => { if (event.target === confirmModal) finishConfirmModal(false); });

  const actionsModal = modalsEl.querySelector("[data-cold-actions-modal]");
  actionsModal.addEventListener("mousedown", (event) => { if (event.target === actionsModal) closeColdActionsSheet(); });
  // Typed values live in `coldSheet.details`, not only in the DOM: switching Buy/Sell re-renders
  // the step, and anything held only in an input would be wiped by that.
  actionsModal.addEventListener("input", (event) => {
    if (coldSheet?.kind !== "portfolio-details") return;
    const target = event.target;
    if (target.matches("[data-cold-pf-amount]")) coldSheet.details.amount = target.value;
    else if (target.matches("[data-cold-pf-price]")) { coldSheet.details.price = target.value; coldSheet.details.priceLoading = false; }
    else if (target.matches("[data-cold-pf-notes]")) coldSheet.details.notes = target.value;
    else if (target.matches("[data-cold-pf-date]")) {
      const parsed = target.value ? new Date(target.value).getTime() : NaN;
      if (Number.isFinite(parsed)) { coldSheet.details.timestamp = parsed; coldSheet.details.dateLocal = target.value; }
      return;
    } else return;
    // Total and Confirm both follow amount and price, refreshed in place rather than by
    // re-rendering the field being typed into.
    const total = coldPortfolioTotal(coldSheet.details);
    const totalRow = actionsModal.querySelector(".cold-portfolio-total");
    if (totalRow) {
      totalRow.hidden = total === null;
      totalRow.querySelector("span:last-child").textContent = formatPortfolioCurrency(total || 0);
    }
    const confirm = actionsModal.querySelector("[data-cold-pf-confirm]");
    if (confirm) confirm.disabled = !((coldPortfolioNumber(coldSheet.details.amount) || 0) > 0);
  });

  actionsModal.addEventListener("click", (event) => {
    if (event.target.closest("[data-cold-actions-close]")) { closeColdActionsSheet(); return; }
    // The rows themselves are handled by the root delegate, which the modal is NOT inside - it
    // lives in modalsEl, on document.body - so forward them.
    if (event.target.closest("[data-cold-tx-explorer]")) {
      const txId = coldSheet?.tx?.txId;
      closeColdActionsSheet();
      if (txId) window.open(deps.explorerTxUrl(txId), "_blank", "noopener");
      return;
    }
    if (event.target.closest("[data-cold-tx-portfolio]")) {
      const portfolios = listPortfolios();
      if (!portfolios.length) { deps.showToast?.("No portfolio to add this to yet."); return; }
      const duplicates = portfolioIdsContainingTx(coldSheet.tx.txId);
      const tx = coldSheet.tx;
      // Always the choice first, even with one portfolio (iOS AddToPortfolioSheet .choosePortfolio).
      openColdSheet({ kind: "portfolio-pick", tx, portfolios, duplicates, sourceAddress: coldSheet.sourceAddress || null });
      return;
    }
    const portfolioPick = event.target.closest("[data-cold-portfolio-pick]");
    if (portfolioPick) { openColdPortfolioDetails(portfolioPick.dataset.coldPortfolioPick); return; }
    const pfType = event.target.closest("[data-cold-pf-type]");
    if (pfType) { coldSheet.details.type = pfType.dataset.coldPfType; renderColdSheet(); return; }
    if (event.target.closest("[data-cold-pf-back]")) { coldSheet.kind = "portfolio-pick"; renderColdSheet(); return; }
    if (event.target.closest("[data-cold-pf-confirm]")) { confirmColdPortfolioAdd(); return; }
    const accountAction = event.target.closest("[data-cold-account-action]");
    if (accountAction) {
      closeColdActionsSheet();
      handleAccountMenuAction(accountAction.dataset.coldAccountAction, accountAction.dataset.id);
      return;
    }
    const addrAction = event.target.closest("[data-cold-addr-action]");
    if (addrAction) {
      closeColdActionsSheet();
      handleAddressAction(addrAction.dataset.coldAddrAction, Number(addrAction.dataset.index));
      return;
    }
    const action = event.target.closest("[data-cold-generate], [data-cold-discover], [data-cold-refresh], [data-cold-open-visibility]");
    if (!action || action.disabled) return;
    if (action.matches("[data-cold-generate]")) { closeColdActionsSheet(); runAddressAction("generate"); }
    else if (action.matches("[data-cold-discover]")) { runAddressAction("discover"); }
    else if (action.matches("[data-cold-refresh]")) { closeColdActionsSheet(); runAddressAction("refresh"); }
    else { closeColdActionsSheet(); showingVisibility = true; visibilityPage = 0; visUsageCache.clear(); render(); }
  });

  const qrModal = modalsEl.querySelector("[data-cold-qr-modal]");
  modalsEl.querySelector("[data-cold-qr-close]").addEventListener("click", closeQrModal);
  qrModal.addEventListener("mousedown", (event) => { if (event.target === qrModal) closeQrModal(); });
  // Tap anywhere on the card, not only the button (iOS ColdStorageAddressQRView). The close
  // button keeps its own job.
  modalsEl.querySelector(".cold-qr-card")?.addEventListener("click", (event) => {
    if (event.target.closest("[data-cold-qr-close]")) return;
    const payload = qrModal.dataset.payload;
    if (!payload) return;
    navigator.clipboard?.writeText(payload);
    deps.showToast?.(qrModal.dataset.copyToast || "Copied to clipboard.");
  });

  // --- KSPT send flow (delegated — the body re-renders per step) ---
  const sendBody = modalsEl.querySelector("[data-cold-send-body]");
  sendBody.addEventListener("click", async (event) => {
    if (!send) return;
    if (event.target.closest("[data-cold-send-close]")) { closeSendFlow(); return; }
    // A pick under Other domains switches the recipient to that service's answer (iOS 6ac48a7).
    const otherDomain = pickOtherDomain(event, send.nameResolutions);
    if (otherDomain) {
      send.resolvedAddress = otherDomain.address;
      send.resolvedDomain = otherDomain.name;
      send.selectedTld = otherDomain.tld;
      send.knsError = null;
      renderSendStatusOnly();
      return;
    }
    if (event.target.closest("[data-cold-send-paste]")) {
      try {
        const text = (await navigator.clipboard.readText())?.trim();
        if (text && send) {
          const input = sendBody.querySelector("[data-cold-send-recipient]");
          if (input) input.value = text;
          handleSendRecipientInput(text);
        }
      } catch { deps.showToast?.("Clipboard unavailable. Paste into the field directly."); }
      return;
    }
    // Camera scan for the recipient, matching iOS ColdStorageView's "Scan QR" button. The
    // scanner strips a `kaspa:addr?amount=...` query, and the result goes through the same
    // handler the field and Paste use, so KNS resolution and validation still run.
    if (event.target.closest("[data-cold-send-scan]")) {
      let scanned = null;
      try {
        scanned = await scanKaspaAddress();
      } catch {
        deps.showToast?.("The QR scanner could not be opened. Paste or type the address instead.");
        return;
      }
      // The send sheet may have closed or moved on while the scanner was up.
      if (!scanned || !send || send.step !== "form") return;
      const input = sendBody.querySelector("[data-cold-send-recipient]");
      if (input) input.value = scanned;
      handleSendRecipientInput(scanned);
      return;
    }
    // The recipient card's Address Book button (iOS 00767a4): pick a saved address.
    if (event.target.closest("[data-cold-send-address-book]")) {
      const entry = await deps.pickAddressBookEntry?.();
      if (!entry?.address || !send || send.step !== "form" || send.isCompound) return;
      const input = sendBody.querySelector("[data-cold-send-recipient]");
      if (input) input.value = entry.address;
      handleSendRecipientInput(entry.address);
      return;
    }
    if (event.target.closest("[data-cold-send-max]")) { sendSetMax(); return; }

    // --- Coin Control -------------------------------------------------------
    if (event.target.closest("[data-cold-send-coin-toggle]")) { openCoinControl(); return; }
    if (event.target.closest("[data-cold-coincontrol-cancel]")) {
      // Cancel leaves the existing selection alone - it is a way out of the picker, not a reset.
      send.step = "form";
      renderSendFlow();
      return;
    }
    if (event.target.closest("[data-cold-coincontrol-all]")) {
      send.coinControlSelection = (send.coinControlUtxos || []).map(utxoKey);
      renderSendFlow();
      return;
    }
    if (event.target.closest("[data-cold-coincontrol-none]")) {
      send.coinControlSelection = [];
      renderSendFlow();
      return;
    }
    const ccToggle = event.target.closest("[data-cold-coincontrol-toggle]");
    if (ccToggle) {
      const key = ccToggle.dataset.coldCoincontrolToggle;
      send.coinControlSelection = send.coinControlSelection.includes(key)
        ? send.coinControlSelection.filter((k) => k !== key)
        : [...send.coinControlSelection, key];
      renderSendFlow();
      return;
    }
    if (event.target.closest("[data-cold-coincontrol-done]")) { commitCoinControl(); return; }
    if (event.target.closest("[data-cold-coincontrol-retry]")) { openCoinControl(); return; }
    if (event.target.closest("[data-cold-send-unit]")) {
      if (!send.price || send.price <= 0) { deps.showToast?.("KAS price unavailable right now."); return; }
      // Convert the currently-typed value into the new unit so it stays equivalent (iOS
      // toggleMode carries the number over instead of clearing the field).
      const kas = sendAmountKas();
      send.amountUnit = send.amountUnit === "kas" ? "fiat" : "kas";
      if (kas !== null) {
        send.amountText = send.amountUnit === "fiat"
          ? (kas * send.price).toFixed((deps.currencyCode?.() || "") === "BTC" ? 8 : 2)
          : kas.toFixed(8);
      }
      renderSendFlow();
      return;
    }
    const tier = event.target.closest("[data-cold-send-fee]");
    if (tier) {
      send.feeTier = tier.dataset.coldSendFee;
      send.customExtraFeeSompi = null;
      send.editingFee = false;
      scheduleSendPreview();
      renderSendFlow();
      return;
    }
    if (event.target.closest("[data-cold-send-fee-edit]")) { send.editingFee = true; renderSendFlow(); return; }
    if (event.target.closest("[data-cold-send-fee-commit]")) {
      commitCustomSendFee(sendBody.querySelector("[data-cold-send-fee-custom]")?.value || "");
      return;
    }
    if (event.target.closest("[data-cold-send-build]")) { sendBuild(); return; }
    if (event.target.closest("[data-cold-send-start-scan]")) { stopSendFrameTimer(); startSendScan(); return; }
    // Cancelling the scanner goes back to the form (iOS isScanningSignedResponse's setter).
    if (event.target.closest("[data-cold-send-cancel-scan]")) {
      stopSendScan();
      send.step = "form";
      send.cameraDenied = false;
      renderSendFlow();
      return;
    }
    if (event.target.closest("[data-cold-send-frame-prev]")) {
      send.frameIndex = (send.frameIndex - 1 + send.frames.length) % send.frames.length;
      drawSendFrame();
      return;
    }
    if (event.target.closest("[data-cold-send-frame-next]")) {
      send.frameIndex = (send.frameIndex + 1) % send.frames.length;
      drawSendFrame();
      return;
    }
    if (event.target.closest("[data-cold-send-frame-play]")) { send.playing = !send.playing; drawSendFrame(); return; }
    if (event.target.closest("[data-cold-send-try-again]")) { send.step = "form"; send.error = null; renderSendFlow(); return; }
    if (event.target.closest("[data-cold-send-done]")) {
      const reopenIndex = activeAddressIndex;
      closeSendFlow();
      if (reopenIndex !== null) openAddressScreen(reopenIndex); // refresh balance/txs/utxos
      return;
    }
  });
  sendBody.addEventListener("input", (event) => {
    if (!send) return;
    if (event.target.matches("[data-cold-send-recipient]")) handleSendRecipientInput(event.target.value);
    else if (event.target.matches("[data-cold-send-amount]")) {
      // Digits and one point: 8 decimals for KAS, 2 for a currency (8 for BTC) - the shared rule.
      const decimals = send.amountUnit === "fiat" && (deps.currencyCode?.() || "") !== "BTC" ? 2 : 8;
      const sanitized = sanitizeAmountText(event.target.value, decimals);
      if (sanitized !== event.target.value) event.target.value = sanitized;
      send.amountText = sanitized;
      renderSendStatusOnly();
    }
  });
  sendBody.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && event.target.matches("[data-cold-send-fee-custom]")) {
      event.preventDefault();
      commitCustomSendFee(event.target.value);
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (send) { closeSendFlow(); return; }
    if (!qrModal.hidden) { closeQrModal(); return; }
    if (!inputModal.hidden) { finishInputModal(null); return; }
    if (!confirmModal.hidden) { finishConfirmModal(false); return; }
    // The shared QR scanner handles its own Escape (in the capture phase, so this
    // listener never even sees it while the viewfinder is up).
  });
}

// Shows the shared one-field modal (import name / rename / kpub entry) and resolves
// with the entered string, or null on cancel.
function promptModal({ kicker, title, message, label, placeholder = "", initial = "", submitLabel = "Save", mono = false, required = true }) {
  finishInputModal(null); // close any stale instance first
  const modal = modalsEl.querySelector("[data-cold-input-modal]");
  const form = modalsEl.querySelector("[data-cold-input-form]");
  const field = modalsEl.querySelector("[data-cold-input-field]");
  // iOS sheets carry a title only; a kicker shows only where one is passed.
  const kickerEl = modalsEl.querySelector("[data-cold-input-kicker]");
  kickerEl.textContent = kicker || "";
  kickerEl.hidden = !kicker;
  modalsEl.querySelector("[data-cold-input-title]").textContent = title;
  const messageEl = modalsEl.querySelector("[data-cold-input-message]");
  messageEl.hidden = !message;
  messageEl.textContent = message || "";
  modalsEl.querySelector("[data-cold-input-label]").textContent = label;
  modalsEl.querySelector("[data-cold-input-submit]").textContent = submitLabel;
  field.placeholder = placeholder;
  field.value = initial;
  field.classList.toggle("cold-mono-input", mono);
  form.dataset.required = required ? "1" : "0";
  modal.hidden = false;
  field.focus();
  field.select();
  return new Promise((resolve) => { inputModalResolve = resolve; });
}

function finishInputModal(value) {
  const modal = modalsEl?.querySelector("[data-cold-input-modal]");
  if (modal) modal.hidden = true;
  const resolve = inputModalResolve;
  inputModalResolve = null;
  resolve?.(value);
}

function confirmModal({ title, message, okLabel = "Remove" }) {
  finishConfirmModal(false);
  modalsEl.querySelector("[data-cold-confirm-title]").textContent = title;
  modalsEl.querySelector("[data-cold-confirm-message]").textContent = message;
  modalsEl.querySelector("[data-cold-confirm-ok]").textContent = okLabel;
  modalsEl.querySelector("[data-cold-confirm-modal]").hidden = false;
  return new Promise((resolve) => { confirmModalResolve = resolve; });
}

function finishConfirmModal(value) {
  const modal = modalsEl?.querySelector("[data-cold-confirm-modal]");
  if (modal) modal.hidden = true;
  const resolve = confirmModalResolve;
  confirmModalResolve = null;
  resolve?.(value);
}

// White-background QR sheet for one address, matching iOS's ColdStorageAddressQRView.
function openQrModal(account, entry) {
  return presentQr({
    title: displayLabelFor(account, entry.index),
    payload: entry.address,
    copyToast: deps.addressCopiedToastText ? deps.addressCopiedToastText(entry.address) : "Address copied to clipboard.",
  });
}

/// The account's extended public key as a QR, so another device can watch this account by
/// scanning it (iOS ColdStorageKpubQRView). The warning is the one iOS prints under it: a kpub
/// cannot spend, but handing one over hands over every address the account will ever use.
function openKpubQrModal(account) {
  return presentQr({
    title: account.label,
    payload: account.kpub,
    copyToast: "kpub copied to clipboard.",
    note: "Watch-only. This cannot spend, but it reveals every address in this account.",
    // "L" where the address QR uses "M" (iOS ColdStorageKpubQRView.generateQR): a kpub is several
    // times longer, and "M" pushes it into a denser symbol that scans worse on screen.
    errorCorrectionLevel: "L",
  });
}

/// One presenter for both QRs, so the address QR and the kpub QR cannot drift apart.
async function presentQr({ title, payload, copyToast, note, errorCorrectionLevel = "M" }) {
  const modal = modalsEl.querySelector("[data-cold-qr-modal]");
  const canvas = modalsEl.querySelector("[data-cold-qr-canvas]");
  const noteEl = modalsEl.querySelector("[data-cold-qr-note]");
  modalsEl.querySelector("[data-cold-qr-title]").textContent = title;
  modalsEl.querySelector("[data-cold-qr-address]").textContent = payload;
  noteEl.textContent = note || "";
  noteEl.hidden = !note;
  modal.dataset.payload = payload;
  modal.dataset.copyToast = copyToast;
  modal.hidden = false;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  try { await deps.engine.drawQrFor(canvas, payload, { dark: "#06110f", light: "#ffffff", errorCorrectionLevel }); }
  catch (error) { deps.appendEngineLog?.(`Cold QR failed: ${error.message}`); }
  // QRCode.toCanvas writes an inline style sized to its render width (512px), which
  // overrides the stylesheet and overflows the card — pin the display size back down.
  canvas.style.width = "240px";
  canvas.style.height = "240px";
}

function closeQrModal() {
  const modal = modalsEl?.querySelector("[data-cold-qr-modal]");
  if (modal) modal.hidden = true;
}

// ---------------------------------------------------------------------------
// Detail loading
// ---------------------------------------------------------------------------

async function openAccount(id) {
  activeAccountId = id;
  detailDiscoverySummary = null;
  showingVisibility = false;
  visibilityPage = 0;
  detailEntries = [];
  balanceCache = new Map();
  saveColdSpot({ accountId: id, addressIndex: null });
  // No automatic discover on open: as on iOS, Discover Addresses is the reader's to run.
  await loadDetail();
}

async function loadDetail({ useCache = true } = {}) {
  const account = activeAccount();
  if (!account) return;
  const token = ++detailToken;
  if (!useCache) balanceCache = new Map();

  let derived = [];
  try { derived = deriveReceiveAddresses(account.kpub, 0, account.maxIndex + 1); }
  catch (error) { deps.showToast?.(userFacingError(error)); return; }

  // Seed from the session cache and the persisted per-account cache, so a reopened
  // account paints last-known balances/badges immediately instead of a wall of "…".
  const previous = new Map(detailEntries.map((e) => [e.address, e]));
  const persisted = useCache ? loadPersistedAccountCache(account.id) : null;
  detailEntries = derived.map((address, index) => ({
    index,
    address,
    balanceSompi: useCache ? (balanceCache.get(address) ?? persisted?.balances?.[address]) : undefined,
    everUsed: useCache ? (previous.get(address)?.everUsed ?? persisted?.used?.[address]) : undefined,
  }));
  detailLoading = true;
  render();

  // All balances in one batched gRPC call (the same thing that makes iOS fast). The old
  // per-address REST loop survives only as the fallback for when the node pool is down.
  try {
    const balances = await fetchBalancesBatch(derived);
    if (detailToken !== token) return;
    for (const entry of detailEntries) {
      entry.balanceSompi = balances.get(entry.address) ?? 0;
      balanceCache.set(entry.address, entry.balanceSompi);
    }
  } catch {
    for (const entry of detailEntries) {
      if (entry.balanceSompi !== undefined) continue;
      if (detailToken !== token) return;
      // A failed lookup keeps the last known figure (or the dash) rather than printing 0 KAS.
      try { entry.balanceSompi = await fetchBalance(entry.address); }
      catch { entry.balanceSompi = balanceCache.get(entry.address); }
      if (entry.balanceSompi === undefined) continue;
      balanceCache.set(entry.address, entry.balanceSompi);
      const cell = rootEl?.querySelector(`[data-cold-balance-cell="${entry.index}"]`);
      if (cell) cell.textContent = `${fmtKasExact(entry.balanceSompi)} ${KAS_UNIT}`;
    }
  }
  if (detailToken !== token) return;
  detailLoading = false;
  render(); // applies the funded-first sort + summary total now that balances are in
  persistAccountCache(account.id);

  // Contains-domain tags: batched, cached KNS assets-by-owner lookups (the
  // refresh is debounced inside engine/kns.js), applied after the rows are
  // already visible — a re-render then also promotes tagged rows in the sort.
  (async () => {
    try { await deps.engine.refreshKnsIfNeeded?.(derived); } catch { /* tags fall back to cache */ }
    if (detailToken !== token) return;
    const owning = new Set();
    for (const address of derived) {
      const info = deps.engine.peekKnsAddressInfo?.(address);
      if (info?.allDomains?.length) owning.add(address);
    }
    // .kachat names count too (iOS 881ada6; empty where the registry isn't launched).
    for (const address of await kachatOwnersOfNames(derived)) owning.add(address);
    if (detailToken !== token) return;
    const changed = owning.size !== detailDomainOwning.size || [...owning].some((a) => !detailDomainOwning.has(a));
    detailDomainOwning = owning;
    if (changed) render();
  })();

  // Used/Unused for the zero-balance addresses. ONE request for the whole list: that is what
  // `POST /addresses/active` answers, and it is the same question this used to ask one address at
  // a time through `full-transactions?limit=1` - four in flight at a time, which still crawled on
  // a big account. Falls back to the per-address requests only where the bulk route is absent.
  const pending = detailEntries.filter((e) => (e.balanceSompi || 0) === 0 && e.everUsed === undefined);
  // A failed probe (null) leaves the row's "Checking" up rather than claiming "Unused" (iOS
  // unknownUsedAddresses).
  const markUsed = (entry, used) => {
    if (used === null || used === undefined) return;
    entry.everUsed = used;
    const cell = rootEl?.querySelector(`[data-cold-usage-cell="${entry.index}"]`);
    if (cell) {
      cell.className = `spending-address-usage ${used ? "used" : "unused"}`;
      cell.textContent = used ? "Used" : "Unused";
    } else {
      rootEl?.querySelector(`[data-cold-badges="${entry.index}"]`)?.insertAdjacentHTML("afterbegin",
        `<span class="spending-address-usage ${used ? "used" : "unused"}" data-cold-usage-cell="${entry.index}">${used ? "Used" : "Unused"}</span>`);
    }
  };
  let bulkActive = null;
  if (pending.length) {
    try { bulkActive = await fetchActiveAddresses(pending.map((e) => e.address)); }
    catch { bulkActive = null; }
  }
  if (detailToken !== token) return;
  if (bulkActive) {
    for (const entry of pending) markUsed(entry, bulkActive.has(entry.address));
  } else {
    await mapWithConcurrency(pending, 4, async (entry) => {
      if (detailToken !== token) return;
      const used = await addressHasHistory(entry.address);
      if (detailToken !== token) return;
      markUsed(entry, used);
    });
  }
  if (detailToken === token) persistAccountCache(account.id);
}

/// How deep a discover looks. The whole window is asked about in ONE request, so depth costs
/// almost nothing - unlike the gap-limit walk this replaces, where every extra index was another
/// round trip and the scan therefore had to give up early.
const DISCOVER_DEPTH = 1000;
/// Addresses per `POST /addresses/active` request, and how many of those to have in flight.
///
/// Measured from the browser against api.kaspa.org: 250 answers in ~350ms and 300 in ~315ms, but
/// 500 in one body stalls past 25 seconds - so the ceiling is real and it is well under 500.
/// 250 x 2 in flight sweeps a 1000-address window in about 0.7 seconds, four requests total.
const ACTIVE_BATCH = 250;
const ACTIVE_CONCURRENCY = 2;
/// KNS has no bulk endpoint, so domain ownership is only probed this far in - and now only for
/// addresses the chain says were actually touched, which is a handful rather than all of them.
const KNS_PROBE_DEPTH = 200;
/// The fallback sweep (iOS ColdStorageManager): addresses per balance request, how many misses in a
/// row end it once past the floor, and the hard stop so it always terminates.
const SWEEP_BATCH = 100;
const SWEEP_GAP_LIMIT = 60;
const SWEEP_MAX_INDEX = 5000;

/// Which of these addresses the chain has ever seen, in one request per [ACTIVE_BATCH].
///
/// `POST /addresses/active` is the endpoint that makes a fast discover possible: it answers
/// "has this address ever been used, and when" for a whole list at once. Returns a Map of
/// address -> lastTxBlockTime (0 when active with no timestamp), or null if the configured REST
/// server does not serve the route, which is the signal to fall back to the old walk.
async function fetchActiveAddresses(addresses) {
  const base = String(getEndpoint("kaspaApi") || "https://api.kaspa.org").replace(/\/+$/, "");
  const slices = [];
  for (let i = 0; i < addresses.length; i += ACTIVE_BATCH) slices.push(addresses.slice(i, i + ACTIVE_BATCH));
  const active = new Map();
  let next = 0;
  let unavailable = false;
  await Promise.all(Array.from({ length: Math.min(ACTIVE_CONCURRENCY, slices.length) }, async () => {
    while (next < slices.length && !unavailable) {
      const slice = slices[next++];
      let rows;
      try {
        const response = await fetch(`${base}/addresses/active`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ addresses: slice }),
          cache: "no-store",
          // A stall here must not hang the whole discover; treat it as "route unavailable" and
          // let the caller fall back rather than leaving a spinner up indefinitely.
          signal: AbortSignal.timeout(20000),
        });
        if (!response.ok) { unavailable = true; return; }
        rows = await response.json();
      } catch { unavailable = true; return; }
      if (!Array.isArray(rows)) { unavailable = true; return; }
      for (const row of rows) {
        if (row?.active) active.set(String(row.address), Number(row.lastTxBlockTime) || 0);
      }
    }
  }));
  return unavailable ? null : active;
}

/// Finds every address in this account worth showing, and raises maxIndex to cover them.
///
/// ## Why this is not a gap-limit walk any more
///
/// It was: derive a window, check it, stop at the first window with nothing in it. Two problems,
/// and they pull in opposite directions. It was SLOW - the used/unused answer came from one
/// `full-transactions` request per address, so a 512-index scan was hundreds of round trips, tens
/// of seconds of them. And it was INCOMPLETE - stopping at the first empty window means a balance
/// sitting past a gap is unreachable, with nothing in the UI to say so. That was reported: a
/// funded address at index 291 that discovery would never find.
///
/// `POST /addresses/active` answers "was this address ever used" for a whole list at once, which
/// removes the reason to walk at all. The entire window goes out in two requests, the chain says
/// which handful of addresses were ever touched, and only those cost anything further: balances
/// come from one batched UTXO call, and KNS - the part that actually made this slow, one
/// sequential HTTP lookup per address - is asked only about addresses the chain already says are
/// real. A balance or a domain cannot exist on an address that has never been touched, so
/// nothing is lost by that filter.
async function discoverAddresses(account, onProgress = null) {
  const report = (checkingIndex, foundCount) => { try { onProgress?.({ checkingIndex, foundCount }); } catch { /* UI only */ } };
  let addresses;
  try { addresses = deriveReceiveAddresses(account.kpub, 0, DISCOVER_DEPTH); }
  catch { return 0; }
  if (activeAccountId !== account.id) return 0;
  report(0, 0);

  let active;
  try { active = await fetchActiveAddresses(addresses); }
  catch { active = null; }
  if (activeAccountId !== account.id) return 0;

  let lastMatchIndex = -1;
  const matchedIndices = new Set();

  if (active) {
    const touched = addresses
      .map((address, index) => ({ address, index }))
      .filter(({ address }) => active.has(address));

    // Balances for the touched addresses only - one batched call over a handful rather than over
    // the whole window. A balance that cannot be read is not evidence of an empty one.
    let funded = new Set();
    if (touched.length) {
      try {
        const balances = await fetchBalancesBatch(touched.map((t) => t.address));
        for (const [address, sompi] of balances) {
          balanceCache.set(address, sompi);
          if (sompi > 0) funded.add(address);
        }
      } catch { funded = new Set(); }
    }
    if (activeAccountId !== account.id) return 0;
    report(touched.length ? touched[touched.length - 1].index : 0, funded.size);

    // KNS, concurrently, and only for touched, unfunded addresses inside the probe depth. This is
    // the step that used to dominate the whole scan as 200 sequential lookups.
    const knsCandidates = touched.filter(({ index, address }) => index < KNS_PROBE_DEPTH && !funded.has(address));
    const ownsDomain = new Set();
    if (knsCandidates.length) {
      // Any name counts - .kas, .k or .kaspa (iOS NameServicesClient.ownsAnyName).
      try {
        const owners = await deps.engine.addressesOwningAnyName(knsCandidates.map((c) => c.address));
        for (const address of owners) ownsDomain.add(address);
      } catch { /* tags are a nicety; a balance is what actually matters here */ }
    }

    // An address is worth surfacing when it HOLDS something - a balance or a domain. Having merely
    // been used once and emptied is what the Used badge is for, not what this list is for.
    for (const { index, address } of touched) {
      if (funded.has(address) || ownsDomain.has(address)) {
        matchedIndices.add(index);
        lastMatchIndex = Math.max(lastMatchIndex, index);
      }
    }
  } else {
    // The configured REST server does not serve /addresses/active, or could not be reached: the
    // batched sweep iOS falls back to. A floor of DISCOVER_DEPTH whatever the gaps, then on while
    // it keeps finding (60 misses in a row stop it), never past SWEEP_MAX_INDEX.
    let consecutiveMisses = 0;
    let index = 0;
    while (index < SWEEP_MAX_INDEX) {
      if (index >= DISCOVER_DEPTH && consecutiveMisses >= SWEEP_GAP_LIMIT) break;
      if (activeAccountId !== account.id) return 0;
      const upper = Math.min(index + SWEEP_BATCH, SWEEP_MAX_INDEX);
      report(index, matchedIndices.size);
      let derived;
      try { derived = deriveReceiveAddresses(account.kpub, index, upper); }
      catch { break; }
      if (!derived.length) break;

      let balances;
      try { balances = await fetchBalancesBatch(derived); }
      catch { break; } // balances unavailable: stop rather than read an outage as empty
      if (activeAccountId !== account.id) return 0;
      for (const [address, sompi] of balances) balanceCache.set(address, sompi);

      // Domains only this far in (KNS has no bulk endpoint), for the unfunded ones.
      const knsCandidates = derived.filter((address, i) => index + i < KNS_PROBE_DEPTH && !((balances.get(address) || 0) > 0));
      let owners = new Set();
      if (knsCandidates.length) {
        try { owners = new Set(await deps.engine.addressesOwningAnyName(knsCandidates)); }
        catch { owners = new Set(); }
      }
      if (activeAccountId !== account.id) return 0;

      derived.forEach((address, i) => {
        if ((balances.get(address) || 0) > 0 || owners.has(address)) {
          lastMatchIndex = index + i;
          matchedIndices.add(index + i);
          consecutiveMisses = 0;
        } else {
          consecutiveMisses += 1;
        }
      });
      index += derived.length;
    }
  }

  // Raising the bound is not enough on its own. Rows default to VISIBLE unless explicitly hidden,
  // so a match at index 291 would raise the bound to 292 and fill this account's list with 291
  // empty rows. Anything the scan MATCHED is un-hidden instead: a previously-hidden address that
  // now holds a balance would otherwise be found and dropped straight back out of the list.
  //
  // Strict `>` against the STORED bound, and a half-open range - the shape iOS uses.
  const previousMax = account.maxIndex;
  const hiddenSet = new Set(account.hidden.map(Number));
  if (lastMatchIndex > previousMax) {
    for (let i = previousMax + 1; i < lastMatchIndex; i++) {
      if (!matchedIndices.has(i)) hiddenSet.add(i);
    }
    account.maxIndex = lastMatchIndex + 1;
  }
  for (const index of matchedIndices) hiddenSet.delete(index);
  account.hidden = [...hiddenSet];
  saveState();
  // The COUNT of addresses worth showing - not the bound.
  return matchedIndices.size;
}

// ---------------------------------------------------------------------------
// Import flow
// ---------------------------------------------------------------------------

async function beginImport(kpubRaw) {
  const kpub = validateKpub(kpubRaw);
  if (!kpub) {
    // iOS ColdStorageListView: an "Import Failed" alert with ColdStorageError.invalidKpub's text.
    await alertDialog({ title: "Import Failed", message: "That doesn't look like a valid Kaspa extended public key (kpub)." });
    return;
  }
  // Always the naming step, defaulted to the next "Cold Storage N". A kpub already watched keeps
  // its account and takes the new name (iOS ColdStorageManager.importAccount).
  const label = await promptModal({
    title: "Name This Account",
    message: "Give this account a name so you can recognize it.",
    label: "Name",
    initial: `Cold Storage ${accounts.length + 1}`,
    submitLabel: "Import",
  });
  if (!label?.trim()) return;
  const existing = accounts.find((a) => a.kpub === kpub);
  if (existing) existing.label = label.trim();
  else accounts.push(normalizeAccount({ id: nowId(), label: label.trim(), kpub, addedAt: Date.now() }));
  saveState();
  render();
}

async function pasteImport() {
  let clip = "";
  try { clip = (await navigator.clipboard.readText())?.trim() || ""; } catch { /* permission */ }
  const input = await promptModal({
    title: "Enter kpub",
    message: "Paste the kpub exported from your KasSigner device. It contains no private key material.",
    label: "kpub",
    placeholder: "kpub...",
    initial: clip.startsWith("kpub") ? clip : "",
    submitLabel: "Next",
    mono: true,
  });
  if (input) beginImport(input);
}

// --- kpub QR scanning -------------------------------------------------------
// Runs on the shared scanner in ui/qr-scan.js (jsQR frame decode, so it works in
// every browser, and it degrades to a typed kpub where the camera is unavailable).
// Any code closes the scanner, and one that isn't a kpub gets the same "Import Failed" as a
// pasted one (iOS QRScannerView -> beginImport).

async function startScan() {
  const value = await scanQrCode({
    title: "Scan a kpub",
    hint: "Line the kpub QR code up inside the square",
    manualTitle: "Enter the kpub",
    manualLabel: "kpub",
    manualPlaceholder: "kpub...",
    manualHint: "Paste the kpub exported from your KasSigner device. It contains no private key material.",
    mono: true,
  });
  if (value) beginImport(value);
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function handleAccountMenuAction(action, id) {
  const account = accounts.find((a) => a.id === id);
  if (!account) return;
  if (action === "copy") {
    navigator.clipboard?.writeText(account.kpub);
    deps.showToast?.("kpub copied to clipboard.");
  } else if (action === "qr") {
    await openKpubQrModal(account);
  } else if (action === "notify") {
    // Stored with the account, per wallet; older records read as on (iOS ba352a2).
    account.receiveNotifications = account.receiveNotifications === false;
    saveState();
    coldWatchedCache.fingerprint = "";
    render();
  } else if (action === "rename") {
    await renameAccountPrompt(account);
  }
}

/// iOS RenameSheet "Rename Account", with the current name under the title.
async function renameAccountPrompt(account) {
  const name = await promptModal({
    title: "Rename Account",
    message: account.label,
    label: "Name",
    initial: account.label,
  });
  if (name?.trim()) { account.label = name.trim(); saveState(); render(); }
}

async function handleAddressAction(action, index) {
  const account = activeAccount();
  const entry = detailEntries.find((e) => e.index === index);
  if (!account || !entry) return;
  if (action === "copy") {
    navigator.clipboard?.writeText(entry.address);
    deps.showToast?.(deps.addressCopiedToastText ? deps.addressCopiedToastText(entry.address) : "Address copied to clipboard.");
  } else if (action === "qr") {
    openQrModal(account, entry);
  } else if (action === "hide") {
    // The row's balance may be stale, so hiding asks the node again and fails closed: an error
    // or a balance refuses it (iOS ColdStorageDetailView.hideAddress / setAddressHidden).
    if ((entry.balanceSompi || 0) > 0 || !(await addressConfirmedEmpty(entry.address))) {
      deps.showToast?.("This address can't be hidden.");
      return;
    }
    if (activeAccount() !== account) return;
    if (!account.hidden.includes(index)) account.hidden.push(index);
    saveState();
    // Updated in place - the row just leaves the list; nothing else needs fetching again.
    render();
    deps.showToast?.("Address hidden. Re-enable it in Address Visibility.");
  } else if (action === "rename") {
    const custom = account.labels?.[index] ?? account.labels?.[String(index)] ?? "";
    // iOS "Rename Address" alert: a Label field, and an empty one goes back to the default name.
    const label = await promptModal({
      title: "Rename Address",
      label: "Label",
      initial: custom,
      required: false,
    });
    if (label === null) return;
    const trimmed = label.trim();
    if (trimmed) account.labels[index] = trimmed;
    else { delete account.labels[index]; delete account.labels[String(index)]; }
    saveState();
    render();
  }
}

async function runAddressAction(kind) {
  const account = activeAccount();
  if (!account || detailBusy) return;
  detailBusy = kind;
  render();
  try {
    if (kind === "generate") {
      // Recycling-aware, mirroring the spending chain's Generate: pick the LOWEST index
      // that is truly unused (zero balance, no on-chain history), un-hiding it if the
      // checklist had hidden it — only when every index is spoken for does the chain
      // extend by one.
      // The candidate must be HIDDEN as well as unused. Without that check the lowest unused
      // index, once revealed, satisfies every test again on the next press - so Generate kept
      // picking the same row that was already on the list and appeared to do nothing at all.
      // `detailEntries` only holds the VISIBLE rows, so the hidden ones have to be derived here.
      const hiddenSet = new Set(account.hidden.map(Number));
      let pick = null;
      const hiddenIndices = [...hiddenSet].filter((i) => i <= account.maxIndex).sort((a, b) => a - b);
      for (const index of hiddenIndices) {
        let address;
        try { address = deriveReceiveAddresses(account.kpub, index, index + 1)[0]; }
        catch { continue; }
        if (!address) continue;
        // Recycle only on a CONFIRMED-unused answer: a failed probe skips the index, because
        // extending the chain is always safe and recycling an unknown one is not.
        let balance = balanceCache.get(address);
        if (balance === undefined) {
          try { balance = await fetchBalance(address); }
          catch { continue; }
          balanceCache.set(address, balance);
        }
        if (activeAccountId !== account.id) return;
        if ((balance || 0) > 0) continue;
        // Recycle only on a CONFIRMED-unused probe (iOS lowestUnusedAddress): true is used, and
        // null - the probe failed - skips the index too.
        const used = await addressHasHistory(address);
        if (activeAccountId !== account.id) return;
        if (used !== false) continue;
        pick = index;
        break;
      }
      if (pick === null) {
        account.maxIndex += 1;
        pick = account.maxIndex;
      }
      hiddenSet.delete(pick);
      account.hidden = [...hiddenSet];
      saveState();
      await loadDetail();
      deps.showToast?.(`Address #${pick} is ready.`);
    } else if (kind === "discover") {
      detailDiscoverySummary = null;
      detailDiscoveryProgress = { checkingIndex: 0, foundCount: 0 };
      renderColdSheet();
      const found = await discoverAddresses(account, (progress) => {
        if (activeAccountId !== account.id) return;
        detailDiscoveryProgress = progress;
        if (coldSheet?.kind === "actions") renderColdSheet();
      });
      detailDiscoveryProgress = null;
      if (activeAccountId !== account.id) return;
      await loadDetail();
      // The COUNT of addresses holding a balance or a domain (iOS discoverAddresses' summary).
      const summary = found === 0
        ? "No addresses with a balance or domain found."
        : `Found ${found} address${found === 1 ? "" : "es"} with a balance or domain.`;
      const sheetOpen = coldSheet?.kind === "actions" && !modalsEl?.querySelector("[data-cold-actions-modal]")?.hidden;
      // In the sheet when it is still up; closed and carried on, the summary has nowhere to
      // render, so it is a toast instead.
      if (sheetOpen) detailDiscoverySummary = summary;
      else deps.showToast?.(summary);
    } else if (kind === "refresh") {
      await loadDetail({ useCache: false });
    }
  } finally {
    if (activeAccountId === account.id) {
      detailBusy = null;
      render();
    }
  }
}

async function removeActiveAccount() {
  const account = activeAccount();
  if (!account) return;
  const confirmed = await confirmModal({
    title: "Remove Cold Storage Account",
    message: "This only removes it from KaChat's watch list. It has no effect on the KasSigner device or any funds it holds.",
    okLabel: "Remove",
  });
  if (!confirmed) return;
  accounts = accounts.filter((a) => a.id !== account.id);
  saveState();
  dropPersistedAccountCache(account.id);
  saveColdSpot(null);
  activeAccountId = null;
  render();
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

// Every address (0..maxIndex) of every imported cold-storage account for the
// active wallet, with its owning account's label — consumed by app.js's
// Address Activity notifier (watched set + notification wording). Reads
// persisted state directly so it works even before the Cold Storage tab has
// been opened. Cached by account fingerprint (kpub derivation isn't free).
const coldWatchedCache = { fingerprint: "", list: [] };
/// Opens the Cold Storage account that owns `address`, for a notification click to land
/// somewhere useful. Returns false when no account owns it, so the caller can fall back.
export function openColdAccountForAddress(address) {
  if (!deps) return false;
  loadState();
  const target = String(address || "").trim();
  if (!target) return false;
  for (const account of accounts) {
    try {
      const derived = deriveReceiveAddresses(account.kpub, 0, account.maxIndex + 1);
      if (!derived.includes(target)) continue;
      openAccount(account.id);
      return true;
    } catch { /* a bad kpub owns nothing */ }
  }
  return false;
}

/// Opens a watched Cold Storage address on its History tab (iOS 13046ad
/// ColdStorageAddressTransactionHistoryView, for a tapped "Received" notification). The caller
/// puts the Cold Storage tab up first. Resolves false when no account owns the address.
export async function openColdAddressHistory(address) {
  if (!deps) return false;
  loadState();
  const target = String(address || "").trim();
  if (!target) return false;
  for (const account of accounts) {
    let derived = [];
    try { derived = deriveReceiveAddresses(account.kpub, 0, account.maxIndex + 1); } catch { continue; }
    const index = derived.indexOf(target);
    if (index < 0) continue;
    // A screen left open on another address must not repaint as this account's address.
    activeAddressIndex = null;
    const opening = openAccount(account.id);
    // loadDetail fills detailEntries before its first await, so the address screen opens now
    // rather than after every balance lands; an account still being discovered gets it after.
    if (!detailEntries.some((e) => e.index === index)) await opening;
    if (activeAccountId !== account.id || activeAddressIndex !== null) return true; // moved on meanwhile
    await openAddressScreen(index);
    return true;
  }
  return false;
}

export function listColdWatchedAddresses() {
  if (!deps) return [];
  loadState();
  const fingerprint = `${deps.engine?.address || ""}|${accounts.map((a) => `${a.id}:${a.maxIndex}`).join(",")}`;
  if (coldWatchedCache.fingerprint === fingerprint) return coldWatchedCache.list;
  const list = [];
  for (const account of accounts) {
    try {
      const addresses = deriveReceiveAddresses(account.kpub, 0, account.maxIndex + 1);
      addresses.forEach((address, index) => list.push({ address, index, label: account.label, notify: account.receiveNotifications !== false }));
    } catch { /* a bad kpub just contributes nothing */ }
  }
  coldWatchedCache.fingerprint = fingerprint;
  coldWatchedCache.list = list;
  return list;
}

export function refreshColdStorage() {
  if (activeAccountId && detailEntries.length === 0) loadDetail();
  else render();
}

/// An own address's balance moved (iOS .ownAddressActivity / .ownAddressUtxoActivity, which the
/// detail screen listens to): the open account reloads its balances, so funds show without a
/// manual refresh. Cached figures paint first, so the list does not blank.
export function refreshColdStorageOnActivity() {
  if (!deps || !activeAccountId || showingVisibility || detailBusy) return;
  loadDetail();
}

export function resetColdStorageForAccount() {
  closeActiveScanner();
  closeSendFlow();
  finishInputModal(null);
  finishConfirmModal(false);
  closeQrModal();
  activeAccountId = null;
  activeAddressIndex = null;
  showingVisibility = false;
  detailEntries = [];
  detailBusy = null;
  detailToken += 1;
  addrToken += 1;
  loadState();
  render();
}

export function initColdStorage(dependencies) {
  deps = dependencies;
  rootEl = document.querySelector("[data-cold-root]");
  loadState();
  buildModals();

  rootEl?.addEventListener("click", async (event) => {
    // --- shared menu toggles (account rows, address rows, Address Actions) ---
    const accountToggle = event.target.closest("[data-cold-menu-toggle]");
    if (accountToggle) { openColdSheet({ kind: "account", id: accountToggle.dataset.coldMenuToggle }); return; }
    const addrToggle = event.target.closest("[data-cold-addr-menu-toggle]");
    if (addrToggle) { openColdSheet({ kind: "address", index: Number(addrToggle.dataset.coldAddrMenuToggle) }); return; }
    if (event.target.closest("[data-cold-actions-toggle]")) { openColdActionsSheet(); return; }

    // --- menu items ---
    const accountAction = event.target.closest("[data-cold-account-action]");
    if (accountAction) {
      closeAllColdMenus();
      handleAccountMenuAction(accountAction.dataset.coldAccountAction, accountAction.dataset.id);
      return;
    }
    const addrAction = event.target.closest("[data-cold-addr-action]");
    if (addrAction) {
      closeAllColdMenus();
      handleAddressAction(addrAction.dataset.coldAddrAction, Number(addrAction.dataset.index));
      return;
    }
    if (event.target.closest("[data-cold-generate]")) { closeColdActionsSheet(); runAddressAction("generate"); return; }
    // Discover leaves the sheet UP: it reports its progress there, and closing on an unmoving
    // spinner would say nothing about whether it was working.
    if (event.target.closest("[data-cold-discover]")) { runAddressAction("discover"); return; }
    if (event.target.closest("[data-cold-refresh]")) { closeColdActionsSheet(); runAddressAction("refresh"); return; }

    // --- navigation + simple buttons ---
    const open = event.target.closest("[data-cold-open]");
    if (open) { openAccount(open.dataset.coldOpen); return; }
    if (event.target.closest("[data-cold-back]")) {
      detailToken += 1;
      addrToken += 1;
      activeAccountId = null;
      activeAddressIndex = null;
      showingVisibility = false;
      detailEntries = [];
      detailBusy = null;
      saveColdSpot(null);
      render();
      return;
    }
    if (event.target.closest("[data-cold-open-visibility]")) {
      closeColdActionsSheet();
      showingVisibility = true;
      visibilityPage = 0;
      // Every open starts from live data: any action since the last visit (generate,
      // discover, a send landing, a compound) may have changed balances/usage.
      visUsageCache.clear();
      render();
      return;
    }
    if (event.target.closest("[data-cold-vis-done]")) {
      showingVisibility = false;
      // loadDetail re-renders instantly from cached balances, so the edits (including a
      // maxIndex the pager may have extended) show the moment Done is clicked.
      loadDetail();
      return;
    }
    if (event.target.closest("[data-cold-vis-prev]")) {
      if (visibilityPage > 0) { visibilityPage -= 1; renderVisibility(); }
      return;
    }
    if (event.target.closest("[data-cold-vis-next]")) {
      visibilityPage += 1;
      renderVisibility();
      return;
    }
    const visRow = event.target.closest("[data-cold-vis-row]");
    if (visRow) {
      toggleVisibilityRow(Number(visRow.dataset.coldVisRow), visRow.dataset.address || "");
      return;
    }
    if (event.target.closest("[data-cold-txs-retry]") || event.target.closest("[data-cold-utxos-retry]") || event.target.closest("[data-cold-addr-refresh]")) {
      if (activeAddressIndex !== null) refreshAddressScreen();
      return;
    }
    if (event.target.closest("[data-cold-paste]")) { pasteImport(); return; }
    if (event.target.closest("[data-cold-scan]")) { startScan(); return; }
    if (event.target.closest("[data-cold-remove]")) { removeActiveAccount(); return; }
    if (event.target.closest("[data-cold-copy-kpub]")) {
      const account = activeAccount();
      if (account) {
        navigator.clipboard?.writeText(account.kpub);
        deps.showToast?.("kpub copied to clipboard.");
      }
      return;
    }
    if (event.target.closest("[data-cold-rename-account]")) {
      const account = activeAccount();
      if (account) await renameAccountPrompt(account);
      return;
    }
    const addrOpen = event.target.closest("[data-cold-addr-open]");
    if (addrOpen) { openAddressScreen(Number(addrOpen.dataset.coldAddrOpen)); return; }

    // --- per-address screen ---
    if (event.target.closest("[data-cold-addr-back]")) {
      addrToken += 1;
      activeAddressIndex = null;
      saveColdSpot({ accountId: activeAccountId, addressIndex: null });
      render();
      return;
    }
    const tab = event.target.closest("[data-cold-tab]");
    if (tab) { addressTab = tab.dataset.coldTab; render(); return; }
    if (event.target.closest("[data-cold-addr-receive]")) {
      const account = activeAccount();
      const entry = detailEntries.find((e) => e.index === activeAddressIndex);
      if (account && entry) openQrModal(account, entry);
      return;
    }
    if (event.target.closest("[data-cold-addr-send]:not([disabled])")) { openSendFlow({ compound: false }); return; }
    if (event.target.closest("[data-cold-compound]")) { openSendFlow({ compound: true }); return; }
    const txRow = event.target.closest("[data-cold-tx]");
    if (txRow) {
      const txId = txRow.dataset.coldTx;
      if (!txId) return;
      openColdSheet({
        kind: "transaction",
        tx: {
          txId,
          outgoing: txRow.dataset.coldTxOut === "1",
          amountSompi: txRow.dataset.coldTxAmount ? Number(txRow.dataset.coldTxAmount) : null,
          blockTime: txRow.dataset.coldTxTime ? Number(txRow.dataset.coldTxTime) : null,
        },
      });
      return;
    }
    const utxoRename = event.target.closest("[data-cold-utxo-rename]");
    if (utxoRename) {
      const entry = detailEntries.find((e) => e.index === activeAddressIndex);
      if (!entry) return;
      const key = utxoRename.dataset.coldUtxoRename;
      const current = coldUtxoLabels(entry.address)[key] || "";
      // iOS RenameSheet: "Rename UTXO" over the outpoint, a Name that cannot be saved blank.
      const label = await promptModal({
        title: "Rename UTXO",
        message: key,
        label: "Name",
        initial: current,
      });
      if (label === null) return;
      setColdUtxoLabel(entry.address, key, label);
      render();
    }
  });

  // Click anywhere outside an open menu closes it.
  document.addEventListener("click", (event) => {
    if (!event.target.closest(".spending-address-row-menu-wrap") && !event.target.closest(".cold-actions-wrap")) {
      closeAllColdMenus();
    }
  });

  render();
  // After a refresh, reopen the account/address screen that was on-screen before it —
  // openAccount/openAddressScreen refetch everything, so the restored spot is fresh.
  restoreColdSpot();
}
