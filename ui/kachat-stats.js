// KaChat Stats (iOS 5.2 KaChatStatsView, f38cac2 + b8dd56f): Kaspa Hub > KaChat Stats - how many
// transactions KaChat has put on Kaspa, split by kind: direct messages, payments, group and
// public chat messages, KaPosts, chess moves and so on.
//
// Two tabs (iOS 4924787): Transactions, a card per kind - its icon, name and what it counts, then
// its 24 Hours / 7 Days / All Time figures side by side (a dash where the indexer keeps all-time
// only), the five .kachat kinds being the one .kachat Domains card - and Fees, what .kachat
// registrations and renewals paid. The top number is every KaChat transaction, all time. Every
// number has commas whatever the language, and from a million on reads 1M, 1.01M, 2.5B, rounded
// down (iOS b6f55a5, 1df1bcb).
//
// The numbers are the indexers' (`GET /stats`, STATS_INDEXER.md), never this device's own
// traffic. Every configured KaChat indexer is asked (deduplicated - by default they are all the
// same server, so one request); each category comes from the first indexer, in settings order,
// that reports it. A category no indexer reports is left out rather than shown as zero; while
// loading, or when no indexer has stats yet, the rows keep their real names with the numbers
// redacted, so nothing invented is ever on screen. A snapshot younger than a minute is reused;
// the header's refresh button stands in for iOS's pull to refresh.

import "./kachat-stats.css";
import { statsCountText, statsKasText } from "../engine/amounts.js";
import { KAS_UNIT } from "../engine/network.js";

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
  // .kachat Domains card (iOS f5d34f4: "at")
  at: svg(`<circle cx="12" cy="12" r="3.6"/><path d="M15.6 8.6v4.6a2.4 2.4 0 0 0 4.8 0V12a8.4 8.4 0 1 0-3.3 6.7"/>`),
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
/** One of the .kachat registry kinds - shown together as the .kachat Domains card (iOS isKachat). */
const isKachat = (category) => category.key.startsWith("kachat");
/** The kinds with a card of their own. .kachat's five are one card, .kachat Domains. */
const CHAT_CATEGORIES = CATEGORIES.filter((c) => !isKachat(c));

/** A card's three figures, side by side, in this order. */
const RANGES = [
  { id: "day", title: "24 Hours", field: "last24h" },
  { id: "week", title: "7 Days", field: "last7d" },
  { id: "all", title: "All Time", field: "total" },
];

const PAGES = [
  { id: "transactions", title: "Transactions" },
  { id: "fees", title: "Fees" },
];

let deps = null;
let screenEl = null;
let active = false;
let page = "transactions";

// The model (iOS KaChatStatsModel): kept for the session so leaving and coming back doesn't refetch.
/** { counts: Map<key, {total, last24h, last7d}>, updatedAt: ms|null, indexedSince: ms|null, fetchedAt: ms } */
let snapshot = null;
/** null | "noIndexer" (no KaChat indexer set) | "unavailable" (none answered /stats with anything known) */
let failure = null;
let isLoading = false;
let sourceKey = "";
/** .kachat registry transactions and what they paid (sompi), over 24 hours, 7 days and all time
 *  (iOS f5d34f4, 4924787) - from the registry itself (its indexer, or the chain), so it shows
 *  wherever names are live. `{ last24h, last7d, total }` (BigInt), or null where names aren't live
 *  (fees: or where they can't be worked out). */
let kachatTransactions = null;
let kachatFees = null;
/** The first .kachat read has finished: the Fees tab says it has none instead of a placeholder. */
let kachatLoaded = false;

const esc = (v) => deps.escapeHtml(String(v ?? ""));
const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
// iOS RelativeDateTimeFormatter (.full, numeric): always a number ("1 day ago", never "yesterday").
const relativeFormat = new Intl.RelativeTimeFormat(undefined, { numeric: "always", style: "long" });

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

/** The .kachat Domains card's numbers and fees (iOS 4924787 loadKachat): null where names aren't
 *  live; a failed read keeps the last ones. */
async function loadKachat() {
  try {
    const totals = await deps.kachatTotals?.();
    kachatTransactions = totals?.transactions ?? null;
    kachatFees = totals?.fees ?? null;
  } catch { /* keeps the last */ }
  kachatLoaded = true;
  render();
}

/** Both: the indexers' stats and the .kachat card's (iOS .task / .refreshable). */
function refreshAll(force) {
  return Promise.all([refresh(force).catch(() => {}), loadKachat()]);
}

// ---------------------------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------------------------

/** The .kachat Domains counts (iOS 4924787 kachatTotals): the registry's own, else the indexer's
 *  five .kachat kinds added up. `{ last24h, last7d, total }` (BigInt) or null. */
function kachatTotals() {
  if (kachatTransactions) return kachatTransactions;
  if (!snapshot) return null;
  const counts = CATEGORIES.filter(isKachat).map((c) => snapshot.counts.get(c.key)).filter(Boolean);
  if (!counts.length) return null;
  const sum = (field) => counts.reduce((acc, c) => acc + BigInt(Math.max(c[field] ?? 0, 0)), 0n);
  return { last24h: sum("last24h"), last7d: sum("last7d"), total: sum("total") };
}

/** Every KaChat transaction, all time: each kind's all-time count plus .kachat's (BigInt), or
 *  null when nothing is known yet. */
function allTimeTotal() {
  let sum = 0n;
  let any = false;
  if (snapshot) {
    for (const category of CHAT_CATEGORIES) {
      const value = snapshot.counts.get(category.key)?.total;
      if (value !== null && value !== undefined) { sum += BigInt(value); any = true; }
    }
  }
  const kachat = kachatTotals();
  if (kachat) { sum += kachat.total ?? 0n; any = true; }
  return any ? sum : null;
}

// The largest whole unit, weeks included, as iOS RelativeDateTimeFormatter picks it.
function relative(ms) {
  const abs = Math.max(0, Math.round((Date.now() - Math.min(ms, Date.now())) / 1000));
  const ago = (n, unit) => relativeFormat.format(-Math.floor(n), unit);
  if (abs < 60) return ago(abs, "second");
  if (abs < 3600) return ago(abs / 60, "minute");
  if (abs < 86400) return ago(abs / 3600, "hour");
  if (abs < 86400 * 7) return ago(abs / 86400, "day");
  if (abs < 86400 * 30) return ago(abs / (86400 * 7), "week");
  if (abs < 86400 * 365) return ago(abs / (86400 * 30), "month");
  return ago(abs / (86400 * 365), "year");
}

// ---------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------

function heroHtml() {
  const sum = allTimeTotal();
  let number;
  if (sum !== null) number = `<span>${esc(statsCountText(sum))}</span>`;
  else if (snapshot || failure) number = `<span>--</span>`;
  else number = `<span class="kstats-redacted" aria-hidden="true">000,000</span>`;
  return `
    <div class="kstats-hero">
      <span class="kstats-hero-icon">${ICONS.chart}</span>
      <div class="kstats-hero-total">${number}</div>
      <p class="kstats-hero-caption">KaChat transactions on Kaspa, all time</p>
    </div>`;
}

/** Transactions | Fees on the app's underline tab bar (iOS UnderlineTabBar). */
function tabsHtml() {
  return `
    <nav class="domains-tabs kstats-tabs" role="tablist" aria-label="KaChat Stats">
      ${PAGES.map((p) => `<button type="button" role="tab" aria-selected="${p.id === page}" class="domains-tab${p.id === page ? " active" : ""}" data-kstats-page="${p.id}">${esc(p.title)}</button>`).join("")}
    </nav>`;
}

/** One kind (iOS 4924787 statCard): its icon, name and what it counts, then its 24 Hours, 7 Days
 *  and All Time figures side by side. A figure the indexer doesn't keep (null) shows a dash;
 *  `redacted` shows the figures' shape only. `values` is already formatted text. */
function statCardHtml({ icon, color, title, detail }, values, redacted = false) {
  const columns = RANGES.map((r, index) => {
    const value = values[index] ?? null;
    let figure;
    if (redacted) figure = `<strong class="kstats-redacted" aria-hidden="true">0,000</strong>`;
    else if (value !== null) figure = `<strong>${esc(value)}</strong>`;
    else figure = `<strong class="kstats-dash">--</strong>`;
    return `
        <div class="kstats-column">
          ${figure}
          <small>${esc(r.title)}</small>
        </div>`;
  }).join("");
  return `
    <div class="profile-card kstats-card"${redacted ? ` aria-busy="${isLoading || !kachatLoaded}"` : ""}>
      <div class="kstats-row">
        <span class="kstats-row-icon" style="background: var(--kstats-${color})">${ICONS[icon]}</span>
        <span class="kstats-row-main">
          <strong>${esc(title)}</strong>
          <small>${esc(detail)}</small>
        </span>
      </div>
      <div class="kstats-columns">${columns}
      </div>
    </div>`;
}

const KACHAT_CARD = { icon: "at", color: "mint", title: ".kachat Domains" };
const countText = (value) => (value === null || value === undefined ? null : statsCountText(value));
const kasText = (sompi) => statsKasText(sompi, KAS_UNIT);

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

/** Every reported kind's card, else the unavailable card and every kind redacted; then .kachat
 *  Domains wherever its counts are known (iOS 4924787 transactionsPage). */
function transactionsPageHtml() {
  let html;
  if (snapshot) {
    html = CHAT_CATEGORIES.filter((c) => snapshot.counts.has(c.key)).map((category) => {
      const counts = snapshot.counts.get(category.key);
      return statCardHtml(category, RANGES.map((r) => countText(counts[r.field])));
    }).join("");
  } else {
    html = (failure && !isLoading ? unavailableHtml() : "")
      + CHAT_CATEGORIES.map((category) => statCardHtml(category, [], true)).join("");
  }
  const kachat = kachatTotals();
  if (kachat) {
    html += statCardHtml({ ...KACHAT_CARD, detail: "Transactions on the .kachat registry" }, RANGES.map((r) => countText(kachat[r.field] ?? 0n)));
  }
  return html;
}

/** .kachat Domains fees, or a note that the indexer has none (iOS 4924787 feesPage). */
function feesPageHtml() {
  const card = { ...KACHAT_CARD, detail: "Paid for registrations and renewals" };
  if (kachatFees) return statCardHtml(card, RANGES.map((r) => kasText(kachatFees[r.field] ?? 0n)));
  if (kachatLoaded) {
    return `
    <div class="profile-card kstats-unavailable">
      <strong>Fees aren't available yet</strong>
      <p>Your indexer doesn't report them yet. They'll show here once it does.</p>
    </div>`;
  }
  return statCardHtml(card, [], true);
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
  const scrollTop = screenEl.scrollTop;
  screenEl.innerHTML = `
    <div class="kaposts-header kstats-header">
      <h1 class="kaposts-title">KaChat Stats</h1>
      <div class="kaposts-header-actions">
        <button class="kaposts-icon-button kstats-refresh${isLoading ? " is-loading" : ""}" type="button" data-kstats-refresh aria-label="Refresh" title="Refresh"${isLoading ? " disabled" : ""}>${ICONS.refresh}</button>
        <button class="kaposts-icon-button" type="button" data-kstats-info aria-label="What counts" title="What counts">${ICONS.question}</button>
      </div>
    </div>
    <div class="kstats-body">
      ${heroHtml()}
      ${tabsHtml()}
      ${page === "fees" ? feesPageHtml() : transactionsPageHtml()}
      ${footerHtml()}
    </div>`;
  screenEl.scrollTop = scrollTop;
}

function infoSheetHtml() {
  return `
    <div class="kstats-info">
      <p class="kstats-info-header">Every KaChat action is its own Kaspa transaction. These totals come from KaChat's indexer, counting what it has seen on chain - nothing is read from your phone.</p>
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
  const pageButton = target.closest("[data-kstats-page]");
  if (pageButton) {
    const next = pageButton.getAttribute("data-kstats-page");
    if (next && next !== page && PAGES.some((p) => p.id === next)) { page = next; render(); }
    return;
  }
  if (target.closest("[data-kstats-refresh]") || target.closest("[data-kstats-retry]")) {
    refreshAll(true).catch(() => {});
    return;
  }
  if (target.closest("[data-kstats-info]")) {
    Promise.resolve(deps.infoSheet?.({ title: "What counts", html: infoSheetHtml() })).catch(() => {});
  }
}

// ---------------------------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------------------------

/** deps: { escapeHtml, indexerUrls: () => string[], infoSheet: ({ title, html }) => Promise,
 *  kachatTotals: () => Promise<{ transactions, fees }|null> (null where names aren't live) } */
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
  refreshAll(false).catch(() => {});
}

export function hideKachatStats() {
  active = false;
}
