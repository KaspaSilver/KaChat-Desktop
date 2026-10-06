// KaChat Stats (iOS 5.2 KaChatStatsView, f38cac2 + b8dd56f): Kaspa Hub > KaChat Stats - how many
// transactions KaChat has put on Kaspa, split by kind: direct messages, payments, group and
// public chat messages, KaPosts, chess moves and so on.
//
// The numbers are the indexers' (`GET /stats`, STATS_INDEXER.md), never this device's own
// traffic. Every configured KaChat indexer is asked (deduplicated - by default they are all the
// same server, so one request); each category comes from the first indexer, in settings order,
// that reports it. A category no indexer reports is left out rather than shown as zero; while
// loading, or when no indexer has stats yet, the rows keep their real names with the numbers
// redacted, so nothing invented is ever on screen. A snapshot younger than a minute is reused;
// the header's refresh button stands in for iOS's pull to refresh.

import "./kachat-stats.css";

const FRESH_FOR_MS = 60_000;
const TIMEOUT_MS = 15_000;

// Stroke glyphs standing in for the SF Symbols iOS uses (24-unit box, currentColor).
const svg = (body) => `<svg viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;
const ICONS = {
  chart: svg(`<path d="M4 3v17h17"/><path d="M8 16v-4M12 16V8M16 16v-6M20 16V5"/>`),
  question: svg(`<circle cx="12" cy="12" r="9"/><path d="M9.6 9.4a2.5 2.5 0 0 1 4.85.85c0 1.7-2.45 2.2-2.45 3.75"/><path d="M12 17.2h.01"/>`),
  refresh: svg(`<path d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99"/>`),
  bubbles: svg(`<path d="M3.5 5.5h10a1.5 1.5 0 0 1 1.5 1.5v5a1.5 1.5 0 0 1-1.5 1.5H8l-3.5 3v-3h-1A1.5 1.5 0 0 1 2 12V7a1.5 1.5 0 0 1 1.5-1.5Z"/><path d="M17.5 9.5h1A1.5 1.5 0 0 1 20 11v5a1.5 1.5 0 0 1-1.5 1.5h-1v3l-3.5-3h-3"/>`),
  wave: svg(`<path d="M7.5 12.5V6.8a1.4 1.4 0 0 1 2.8 0V11"/><path d="M10.3 11V5.2a1.4 1.4 0 0 1 2.8 0V11"/><path d="M13.1 11V6.2a1.4 1.4 0 0 1 2.8 0V12"/><path d="M15.9 12V9a1.4 1.4 0 0 1 2.8 0v4.5a7 7 0 0 1-7 7h-.6a6 6 0 0 1-4.9-2.6l-2.6-3.8a1.4 1.4 0 0 1 2.3-1.6l1.2 1.6"/>`),
  plane: svg(`<path d="M21 3 3 10.5l7 2.5 2.5 7L21 3Z"/><path d="m10 13 4.5-4.5"/>`),
  people3: svg(`<circle cx="12" cy="8" r="2.8"/><path d="M7 19c.5-3.2 2.4-5 5-5s4.5 1.8 5 5"/><circle cx="5.5" cy="9.5" r="2"/><path d="M2 18c.3-2.3 1.6-3.6 3.5-3.6"/><circle cx="18.5" cy="9.5" r="2"/><path d="M22 18c-.3-2.3-1.6-3.6-3.5-3.6"/>`),
  personPlus: svg(`<circle cx="10" cy="8" r="3.4"/><path d="M3.5 20c.6-4 3.1-6.2 6.5-6.2 1.6 0 3 .5 4.1 1.4"/><path d="M18.5 13v7M15 16.5h7"/>`),
  radio: svg(`<circle cx="12" cy="12" r="1.8"/><path d="M8.2 8.2a5.4 5.4 0 0 0 0 7.6M15.8 8.2a5.4 5.4 0 0 1 0 7.6"/><path d="M5.3 5.3a9.5 9.5 0 0 0 0 13.4M18.7 5.3a9.5 9.5 0 0 1 0 13.4"/>`),
  textBubble: svg(`<path d="M5 4h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-8l-5 4v-4H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z"/><path d="M7.5 8.5h9M7.5 12.5h6"/>`),
  thumbsUp: svg(`<path d="M7 10.5v9.5H4a1 1 0 0 1-1-1v-7.5a1 1 0 0 1 1-1h3Z"/><path d="M7 10.5 11 3a2.3 2.3 0 0 1 2.4 2.6l-.6 3.9h5.7a2 2 0 0 1 2 2.3l-1.2 6.5a2 2 0 0 1-2 1.7H7"/>`),
  board: svg(`<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9.3h18M3 14.7h18M9 4v16M15 4v16"/>`),
  trophy: svg(`<path d="M7 4h10v5a5 5 0 0 1-10 0V4Z"/><path d="M7 6H4a3 3 0 0 0 3 4M17 6h3a3 3 0 0 1-3 4M12 14v3M8 20h8M9 17h6"/>`),
  tray: svg(`<path d="M3 13.5 5.5 5h13l2.5 8.5V19a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-5.5Z"/><path d="M3 13.5h5l1 2.5h6l1-2.5h5"/><path d="M8 8.5h8M7.3 11h9.4"/>`),
  // .kachat names (iOS b2d108b: at.badge.plus, arrow.clockwise.circle, cart, hand.raised, tag)
  atPlus: svg(`<circle cx="10.6" cy="12.6" r="3"/><path d="M13.6 9.6v3.9a2 2 0 0 0 4 0v-.9a7 7 0 1 0-2.8 5.6"/><path d="M19 2.6v5M16.5 5.1h5"/>`),
  renew: svg(`<circle cx="12" cy="12" r="9"/><path d="M16 12a4 4 0 1 1-1.2-2.85"/><path d="M15.2 6.9v2.5h-2.5"/>`),
  cart: svg(`<path d="M2.5 3.5h2.6l2.4 11.2a1.5 1.5 0 0 0 1.5 1.2h8.5a1.5 1.5 0 0 0 1.5-1.2l1.4-7.2H6.2"/><circle cx="9.6" cy="20" r="1.3"/><circle cx="17.4" cy="20" r="1.3"/>`),
  handRaised: svg(`<path d="M8 13.2V5.6a1.5 1.5 0 0 1 3 0V11M11 10.6V4.1a1.5 1.5 0 0 1 3 0v6.5M14 10.6V5.6a1.5 1.5 0 0 1 3 0v7.2M17 9.6a1.5 1.5 0 0 1 3 0V14a7 7 0 0 1-7 7h-1.2a6 6 0 0 1-4.6-2.2L4 14.7a1.6 1.6 0 0 1 2.4-2.1L8 14.2"/>`),
  tag: svg(`<path d="M3.5 12.2V4.6a1.1 1.1 0 0 1 1.1-1.1h7.6a1.1 1.1 0 0 1 .8.3l7.7 7.7a1.1 1.1 0 0 1 0 1.6l-7.6 7.6a1.1 1.1 0 0 1-1.6 0l-7.7-7.7a1.1 1.1 0 0 1-.3-.8Z"/><circle cx="8" cy="8" r="1.4"/>`),
};

/** One kind of KaChat transaction. `key` is the key in the indexer's `GET /stats` response
 *  (STATS_INDEXER.md), so it is part of that contract. Order is the display order. */
const CATEGORIES = [
  { key: "messages", title: "Direct Messages", detail: "1:1 texts, voice notes, reactions and 1:1 chess", icon: "bubbles", color: "blue" },
  { key: "handshakes", title: "New Chats", detail: "Handshakes that start a 1:1 chat", icon: "wave", color: "cyan" },
  { key: "payments", title: "Payments", detail: "KAS sent in chats", icon: "plane", color: "green" },
  { key: "groupMessages", title: "Group Messages", detail: "Messages in group chats", icon: "people3", color: "indigo" },
  { key: "groupUpdates", title: "Group Updates", detail: "Creating groups, invites and other changes", icon: "personPlus", color: "teal" },
  { key: "publicChats", title: "Public Chats", detail: "Messages in public rooms", icon: "radio", color: "orange" },
  { key: "kaposts", title: "KaPosts", detail: "Posts, replies, quotes and polls", icon: "textBubble", color: "pink" },
  { key: "kapostActions", title: "KaPost Activity", detail: "Votes, follows, edits and deletes", icon: "thumbsUp", color: "purple" },
  { key: "chessMoves", title: "Chess Moves", detail: "Moves played in Chess Online", icon: "board", color: "brown" },
  { key: "chessGames", title: "Chess Games", detail: "Games started in Chess Online", icon: "trophy", color: "yellow" },
  // .kachat names (registry transactions, iOS b2d108b). An indexer reports them only where names
  // are live, so on a network without the registry yet (mainnet before launch) they stay hidden.
  { key: "kachatRegistrations", title: "Names Registered", detail: ".kachat names claimed", icon: "atPlus", color: "mint" },
  { key: "kachatRenewals", title: "Name Renewals", detail: ".kachat names extended or renewed", icon: "renew", color: "renewTeal" },
  { key: "kachatSales", title: "Name Sales", detail: ".kachat names bought from a listing or through an accepted offer", icon: "cart", color: "red" },
  { key: "kachatOffers", title: "Name Offers", detail: "Offers made on .kachat names", icon: "handRaised", color: "amber" },
  { key: "kachatActivity", title: "Name Activity", detail: "Listings, transfers, releases, reclaims and returned offers", icon: "tag", color: "slate" },
  { key: "selfStash", title: "Saved Records", detail: "Chat keys and contact notes saved to your own account", icon: "tray", color: "gray" },
];
const CATEGORY_KEYS = new Set(CATEGORIES.map((c) => c.key));

const RANGES = [
  { id: "day", title: "24 Hours", caption: "KaChat transactions in the last 24 hours", field: "last24h" },
  { id: "week", title: "7 Days", caption: "KaChat transactions in the last 7 days", field: "last7d" },
  { id: "all", title: "All Time", caption: "KaChat transactions on Kaspa, all time", field: "total" },
];

let deps = null;
let screenEl = null;
let active = false;
let range = "all";

// The model (iOS KaChatStatsModel): kept for the session so leaving and coming back doesn't refetch.
/** { counts: Map<key, {total, last24h, last7d}>, updatedAt: ms|null, indexedSince: ms|null, fetchedAt: ms } */
let snapshot = null;
/** null | "noIndexer" (no KaChat indexer set) | "unavailable" (none answered /stats with anything known) */
let failure = null;
let isLoading = false;
let sourceKey = "";

const esc = (v) => deps.escapeHtml(String(v ?? ""));
const numberFormat = new Intl.NumberFormat();
const percentFormat = new Intl.NumberFormat(undefined, { style: "percent", maximumFractionDigits: 1 });
const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
const relativeFormat = new Intl.RelativeTimeFormat(undefined, { numeric: "auto", style: "long" });

// ---------------------------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------------------------

/** Every KaChat indexer configured, trimmed and deduplicated (case-insensitively), in order. */
function indexerBases() {
  let list = [];
  try { list = deps.indexerUrls?.() || []; } catch { list = []; }
  const seen = new Set();
  const out = [];
  for (const url of Array.isArray(list) ? list : []) {
    let trimmed = String(url ?? "").trim();
    while (trimmed.endsWith("/")) trimmed = trimmed.slice(0, -1);
    if (!trimmed) continue;
    const id = trimmed.toLowerCase();
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(trimmed);
  }
  return out;
}

const countOrNull = (v) => (typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : null);

/** One indexer's `/stats`, or null on any failure (non-2xx, 404 included, bad JSON, timeout). */
async function fetchOne(base) {
  try {
    const response = await fetch(`${base}/stats`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const json = await response.json();
    if (!json || typeof json !== "object" || !json.categories || typeof json.categories !== "object" || Array.isArray(json.categories)) return null;
    const categories = new Map();
    for (const [key, value] of Object.entries(json.categories)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      categories.set(key, {
        total: countOrNull(value.total),
        last24h: countOrNull(value.last24h),
        last7d: countOrNull(value.last7d),
      });
    }
    return { updatedAt: countOrNull(json.updatedAt), indexedSince: countOrNull(json.indexedSince), categories };
  } catch {
    return null;
  }
}

/** Asks each indexer and merges: a category comes from the first indexer (in settings order)
 *  that reports it. Null when none of them reports a single category this app knows. */
async function fetchFrom(bases) {
  const responses = (await Promise.all(bases.map(fetchOne))).filter(Boolean);
  const counts = new Map();
  for (const response of responses) {
    for (const [key, value] of response.categories) {
      if (!CATEGORY_KEYS.has(key) || counts.has(key)) continue;
      counts.set(key, value);
    }
  }
  if (!counts.size) return null;
  const updated = responses.map((r) => r.updatedAt).filter((v) => v !== null);
  const since = responses.map((r) => r.indexedSince).filter((v) => v !== null);
  return {
    counts,
    updatedAt: updated.length ? Math.max(...updated) : null,
    indexedSince: since.length ? Math.min(...since) : null,
    fetchedAt: Date.now(),
  };
}

async function refresh(force) {
  const bases = indexerBases();
  const key = bases.join("|");
  if (key !== sourceKey) {
    // Another network or indexer: the old numbers aren't this server's.
    sourceKey = key;
    snapshot = null;
    failure = null;
  }
  if (!bases.length) {
    failure = "noIndexer";
    render();
    return;
  }
  if (!force && snapshot && Date.now() - snapshot.fetchedAt < FRESH_FOR_MS) { render(); return; }
  if (isLoading) return;
  isLoading = true;
  render();
  let fetched = null;
  try {
    fetched = await fetchFrom(bases);
  } finally {
    isLoading = false;
  }
  if (key !== sourceKey) { render(); return; }
  if (fetched) {
    snapshot = fetched;
    failure = null;
  } else {
    // Keep showing the last numbers, if there are any; the footer says they're stale.
    failure = "unavailable";
  }
  render();
}

// ---------------------------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------------------------

const currentRange = () => RANGES.find((r) => r.id === range) || RANGES[2];

/** The categories the indexers report, in display order; `value` null when reported without
 *  this range. */
function reported() {
  if (!snapshot) return [];
  const field = currentRange().field;
  return CATEGORIES.filter((c) => snapshot.counts.has(c.key)).map((category) => ({
    category,
    value: snapshot.counts.get(category.key)[field],
  }));
}

function total(rows) {
  const values = rows.map((r) => r.value).filter((v) => v !== null);
  return values.length ? values.reduce((a, b) => a + b, 0) : null;
}

function relative(ms) {
  const seconds = Math.round((Math.min(ms, Date.now()) - Date.now()) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 60) return relativeFormat.format(seconds, "second");
  if (abs < 3600) return relativeFormat.format(Math.round(seconds / 60), "minute");
  if (abs < 86400) return relativeFormat.format(Math.round(seconds / 3600), "hour");
  if (abs < 86400 * 30) return relativeFormat.format(Math.round(seconds / 86400), "day");
  if (abs < 86400 * 365) return relativeFormat.format(Math.round(seconds / (86400 * 30)), "month");
  return relativeFormat.format(Math.round(seconds / (86400 * 365)), "year");
}

// ---------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------

const iconCircle = (category) =>
  `<span class="kstats-row-icon" style="background: var(--kstats-${category.color})">${ICONS[category.icon]}</span>`;

function categoryRowHtml(category, valueHtml) {
  return `
    <div class="kstats-row">
      ${iconCircle(category)}
      <span class="kstats-row-main">
        <strong>${esc(category.title)}</strong>
        <small>${esc(category.detail)}</small>
      </span>
      <span class="kstats-row-value">${valueHtml}</span>
    </div>`;
}

function heroHtml(rows) {
  const r = currentRange();
  const sum = snapshot ? total(rows) : null;
  let number;
  if (snapshot && sum !== null) number = `<span>${esc(numberFormat.format(sum))}</span>`;
  else if (snapshot) number = `<span>—</span>`;
  else number = `<span class="kstats-redacted" aria-hidden="true">000,000</span>`;
  // A kind counted all time only has no number for 24 Hours / 7 Days, so the total leaves it
  // out - say so rather than let the total look complete.
  const allTimeNote = r.id !== "all" && snapshot && rows.some((row) => row.value === null)
    ? `<p class="kstats-hero-note">Kinds marked "All-time only" aren't in this total yet.</p>`
    : "";
  return `
    <div class="kstats-hero">
      <span class="kstats-hero-icon">${ICONS.chart}</span>
      <div class="kstats-hero-total">${number}</div>
      <p class="kstats-hero-caption">${esc(r.caption)}</p>
      ${allTimeNote}
    </div>`;
}

function pickerHtml() {
  return `
    <div class="settings-segmented full kstats-picker" role="tablist" aria-label="Range">
      ${RANGES.map((r) => `<button type="button" role="tab" aria-selected="${r.id === range}" class="settings-segmented-option${r.id === range ? " active" : ""}" data-kstats-range="${r.id}">${esc(r.title)}</button>`).join("")}
    </div>`;
}

/** Each category's share of the range's total as one segmented bar. */
function shareBarHtml(rows) {
  const parts = rows.filter((r) => (r.value ?? 0) > 0);
  const sum = parts.reduce((a, r) => a + r.value, 0);
  const inner = sum > 0
    ? parts.map((p) => `<span class="kstats-share-part" style="flex-grow: ${p.value / sum}; background: var(--kstats-${p.category.color})"></span>`).join("")
    : `<span class="kstats-share-part kstats-share-empty"></span>`;
  return `<div class="kstats-share" aria-hidden="true">${inner}</div>`;
}

function categoryListHtml(rows) {
  const sum = total(rows) ?? 0;
  const allRange = range === "all";
  return `
    <div class="profile-card kstats-card">
      ${rows.map(({ category, value }) => {
        let valueHtml;
        if (value !== null) {
          valueHtml = `<strong>${esc(numberFormat.format(value))}</strong>`
            + (sum > 0 ? `<small>${esc(percentFormat.format(value / sum))}</small>` : "");
        } else {
          // Reported, but without this range - the indexer keeps an all-time counter only.
          valueHtml = `<strong class="kstats-dash">—</strong>` + (allRange ? "" : `<small>All-time only</small>`);
        }
        return categoryRowHtml(category, valueHtml);
      }).join("")}
    </div>`;
}

/** Real category names with the numbers redacted - while loading, or when no stats yet. */
function placeholderListHtml() {
  return `
    <div class="profile-card kstats-card" aria-busy="${isLoading}">
      ${CATEGORIES.map((category) => categoryRowHtml(category, `<strong class="kstats-redacted" aria-hidden="true">00,000</strong>`)).join("")}
    </div>`;
}

function unavailableHtml() {
  const body = failure === "noIndexer"
    ? `<strong>No indexer is set for this network</strong>
       <p>Add one in Settings &gt; Connection Settings to see KaChat stats.</p>`
    : `<strong>Stats aren't available yet</strong>
       <p>Your indexer doesn't report KaChat stats yet. They'll show here once it does.</p>
       <button type="button" class="kstats-retry" data-kstats-retry>Try Again</button>`;
  return `
    <div class="profile-card kstats-unavailable">
      <span class="kstats-unavailable-icon">${ICONS.chart}</span>
      ${body}
    </div>`;
}

function footerHtml() {
  if (!snapshot) return "";
  const lines = [];
  if (failure === "unavailable") lines.push("Couldn't refresh. Showing the last numbers.");
  lines.push(`Updated ${relative(snapshot.updatedAt ?? snapshot.fetchedAt)}`);
  if (snapshot.indexedSince !== null) lines.push(`Counting since ${dateFormat.format(new Date(snapshot.indexedSince))}`);
  return `<div class="kstats-footer">${lines.map((l) => `<p>${esc(l)}</p>`).join("")}</div>`;
}

function render() {
  if (!screenEl || !active) return;
  const rows = reported();
  const scrollTop = screenEl.scrollTop;
  let content;
  if (snapshot) {
    content = shareBarHtml(rows) + categoryListHtml(rows);
  } else {
    content = (failure && !isLoading ? unavailableHtml() : "") + placeholderListHtml();
  }
  screenEl.innerHTML = `
    <div class="kaposts-header kstats-header">
      <h1 class="kaposts-title">KaChat Stats</h1>
      <div class="kaposts-header-actions">
        <button class="kaposts-icon-button kstats-refresh${isLoading ? " is-loading" : ""}" type="button" data-kstats-refresh aria-label="Refresh" title="Refresh"${isLoading ? " disabled" : ""}>${ICONS.refresh}</button>
        <button class="kaposts-icon-button" type="button" data-kstats-info aria-label="What counts" title="What counts">${ICONS.question}</button>
      </div>
    </div>
    <div class="kstats-body">
      ${heroHtml(rows)}
      ${pickerHtml()}
      ${content}
      ${footerHtml()}
    </div>`;
  screenEl.scrollTop = scrollTop;
}

function infoSheetHtml() {
  return `
    <div class="kstats-info">
      <p class="kstats-info-header">Every KaChat action is its own Kaspa transaction. These totals come from KaChat's indexer, counting what it has seen on chain - nothing is read from your device.</p>
      <div class="kstats-info-list">
        ${CATEGORIES.map((category) => `
          <div class="kstats-info-row">
            <span class="kstats-info-icon" style="color: var(--kstats-${category.color})">${ICONS[category.icon]}</span>
            <span class="kstats-info-copy">
              <strong>${esc(category.title)}</strong>
              <span>${esc(category.detail)}</span>
            </span>
          </div>`).join("")}
      </div>
      <p class="kstats-info-footer">1:1 messages are encrypted, so voice notes, reactions and 1:1 chess moves count as direct messages: nobody, the indexer included, can tell them apart.</p>
    </div>`;
}

function onClick(event) {
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;
  const rangeButton = target.closest("[data-kstats-range]");
  if (rangeButton) {
    const next = rangeButton.getAttribute("data-kstats-range");
    if (next && next !== range && RANGES.some((r) => r.id === next)) { range = next; render(); }
    return;
  }
  if (target.closest("[data-kstats-refresh]") || target.closest("[data-kstats-retry]")) {
    refresh(true).catch(() => {});
    return;
  }
  if (target.closest("[data-kstats-info]")) {
    Promise.resolve(deps.infoSheet?.({ title: "What counts", html: infoSheetHtml() })).catch(() => {});
  }
}

// ---------------------------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------------------------

/** deps: { escapeHtml, indexerUrls: () => string[], infoSheet: ({ title, html }) => Promise } */
export function initKachatStats(dependencies) {
  deps = dependencies;
  screenEl = document.querySelector("[data-kachat-stats]");
  if (!screenEl) return;
  screenEl.classList.add("kstats-screen");
  screenEl.addEventListener("click", onClick);
}

/** The screen came on: render what is held and fetch if it is older than a minute. */
export function showKachatStats() {
  if (!deps) return;
  if (!screenEl) {
    screenEl = document.querySelector("[data-kachat-stats]");
    if (!screenEl) return;
    screenEl.classList.add("kstats-screen");
    screenEl.addEventListener("click", onClick);
  }
  active = true;
  render();
  refresh(false).catch(() => {});
}

export function hideKachatStats() {
  active = false;
}
