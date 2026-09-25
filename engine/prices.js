// KAS price data via CoinGecko's public API, in the user's selected currency, with a
// localStorage cache per currency so the portfolio doesn't hammer the endpoint (10-minute
// refresh floor, mirroring the KNS cache policy).
//
// Ported from iOS CoinGeckoService + PortfolioAddressImporter's pricing pipeline:
//   * every call is currency-aware (`vs_currency` / `vs_currencies`) - CoinGecko's public API
//     natively serves any of its listed codes, so switching away from USD needs nothing more
//     than passing the selected code through;
//   * the keyless tier throttles bursts hard (429 for a stretch after a few rapid calls), so
//     every request inspects the response status and gives a 429/5xx exactly one retry that
//     honors `Retry-After` (capped at 10s) - matching CoinGeckoService.getPriceHistory;
//   * historical day prices come from ONE batched `market_chart` range call plus a persistent
//     forever-cache, not a request per day - matching PortfolioAddressImporter.resolveDailyPrices;
//   * nothing here ever throws. Every function degrades to its cached value (however stale) or
//     null/[], so callers can always keep painting their last known good state.

const BASE_URL = "https://api.coingecko.com/api/v3";

const PRICE_CACHE_KEY = "kachat-kas-price-cache-v2";            // { [currency]: { price, change24h, fetchedAt } }
const HISTORY_CACHE_KEY = "kachat-kas-price-history-cache-v2";  // { [currency]: { [days]: { points, fetchedAt } } }
const DAILY_CACHE_KEY = "kachat-kas-daily-price-v2";            // { [currency]: { "YYYY-MM-DD": price } }
// USD-only, "DD-MM-YYYY"-keyed daily cache written by the pre-currency portfolio build. A past
// day's price never changes, so it's worth migrating rather than dropping.
const LEGACY_DAILY_CACHE_KEY = "kachat-kas-daily-price-v1";

const MIN_REFRESH_MS = 10 * 60 * 1000;
const DEFAULT_RETRY_AFTER_MS = 2000;
const MAX_RETRY_AFTER_MS = 10_000;
/** CoinGecko's keyless tier serves at most the last 365 days of market_chart data. */
const KEYLESS_HISTORY_WINDOW_DAYS = 365;
/** Spacing between per-day `/history` fallback calls - only the backfill's fallback path pays
 *  this, since the main pricing path is a single batched range call. */
export const PRICE_REQUEST_SPACING_MS = 1200;
/** Currency-history buckets untouched for this long are pruned on the next write, so cycling
 *  through many currencies can't slowly fill the localStorage quota with dead range caches. */
const HISTORY_BUCKET_TTL_MS = 24 * 60 * 60 * 1000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readCache(key) {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || "null");
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch { return null; }
}

function writeCache(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* quota */ }
}

function normalizeCurrency(currency) {
  const code = String(currency || "usd").trim().toLowerCase();
  return /^[a-z]{2,5}$/.test(code) ? code : "usd";
}

// --- UTC day keys -----------------------------------------------------------
// CoinGecko's history endpoints are UTC-day granularity, so every day key in the pricing
// pipeline (candidate rows, cache keys, backfill matching) is a UTC start-of-day. "YYYY-MM-DD"
// is the internal form (it sorts lexicographically); the /history endpoint wants "DD-MM-YYYY".

const pad2 = (n) => String(n).padStart(2, "0");

export function utcDayKey(ts) {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

function dayKeyToMs(key) {
  const [y, m, d] = String(key).split("-").map(Number);
  return Date.UTC(y, (m || 1) - 1, d || 1);
}

function dayKeyToCoinGecko(key) {
  const [y, m, d] = String(key).split("-");
  return `${d}-${m}-${y}`;
}

(function migrateLegacyDailyCache() {
  const legacy = readCache(LEGACY_DAILY_CACHE_KEY);
  if (!legacy) return;
  const all = readCache(DAILY_CACHE_KEY) || {};
  const usd = all.usd || {};
  for (const [key, value] of Object.entries(legacy)) {
    const match = /^(\d{2})-(\d{2})-(\d{4})$/.exec(key);
    if (!match || !Number.isFinite(Number(value))) continue;
    usd[`${match[3]}-${match[2]}-${match[1]}`] = Number(value);
  }
  all.usd = usd;
  writeCache(DAILY_CACHE_KEY, all);
  try { localStorage.removeItem(LEGACY_DAILY_CACHE_KEY); } catch { /* ignore */ }
})();

// --- low-level HTTP ---------------------------------------------------------

function retryDelayMs(response) {
  const seconds = Number(response.headers.get("Retry-After"));
  const ms = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : DEFAULT_RETRY_AFTER_MS;
  return Math.min(ms, MAX_RETRY_AFTER_MS);
}

/** One attempt, plus exactly one Retry-After-honoring retry when the first came back 429/5xx.
 *  Returns the decoded JSON, or null on any failure (network, non-2xx, unparseable body) -
 *  never throws, matching CoinGeckoService's return-nil-on-failure contract. */
async function fetchJsonWithRetry(url) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let response;
    try {
      response = await fetch(url, { headers: { Accept: "application/json" }, cache: "no-store" });
    } catch {
      return null; // offline / aborted - a retry would just fail the same way
    }
    if (response.ok) {
      try { return await response.json(); } catch { return null; }
    }
    const retryable = response.status === 429 || response.status >= 500;
    if (attempt > 0 || !retryable) return null;
    await sleep(retryDelayMs(response));
  }
  return null;
}

// --- current price ----------------------------------------------------------

/** Synchronous, no-fetch read of the cached current price for `currency` (or null). */
export function peekKasPrice(currency) {
  const entry = (readCache(PRICE_CACHE_KEY) || {})[normalizeCurrency(currency)];
  return Number.isFinite(entry?.price) ? entry : null;
}

/** Current KAS price in `currency`. Returns `{ price, change24h, currency, fetchedAt }`, cached
 *  for 10 minutes. On any failure returns the cached entry (however stale) or null - callers
 *  keep their last known good price rather than blanking. */
export async function fetchKasPrice({ force = false, currency = "usd" } = {}) {
  const code = normalizeCurrency(currency);
  const cached = peekKasPrice(code);
  if (!force && cached && Date.now() - cached.fetchedAt < MIN_REFRESH_MS) return cached;

  const url = `${BASE_URL}/simple/price?ids=kaspa&vs_currencies=${encodeURIComponent(code)}&include_24hr_change=true`;
  const json = await fetchJsonWithRetry(url);
  const raw = Number(json?.kaspa?.[code]);
  if (!Number.isFinite(raw) || raw <= 0) return cached;

  const result = {
    price: raw,
    change24h: Number(json.kaspa[`${code}_24h_change`]) || 0,
    currency: code,
    fetchedAt: Date.now(),
  };
  const all = readCache(PRICE_CACHE_KEY) || {};
  all[code] = result;
  writeCache(PRICE_CACHE_KEY, all);
  return result;
}

// --- price history ----------------------------------------------------------

/** Raw, uncached `market_chart` range call. `[[timestampMs, price], ...]`, oldest first;
 *  `[]` on any failure. */
async function fetchMarketChart(days, currency) {
  const url = `${BASE_URL}/coins/kaspa/market_chart?vs_currency=${encodeURIComponent(currency)}&days=${encodeURIComponent(String(days))}`;
  const json = await fetchJsonWithRetry(url);
  if (!Array.isArray(json?.prices)) return [];
  return json.prices
    .filter((point) => Array.isArray(point) && point.length >= 2 && Number.isFinite(point[0]) && Number.isFinite(point[1]))
    .map((point) => [point[0], point[1]]);
}

/** Synchronous, no-fetch read of the cached history for one (currency, days) pair:
 *  `{ points, fetchedAt }` or null. Lets the chart paint the right range's stale curve
 *  instantly instead of going blank while a refresh is in flight. */
export function peekKasPriceHistory(days, currency) {
  const entry = (readCache(HISTORY_CACHE_KEY) || {})[normalizeCurrency(currency)]?.[String(days)];
  return Array.isArray(entry?.points) && entry.points.length ? entry : null;
}

function persistHistory(days, currency, points) {
  const all = readCache(HISTORY_CACHE_KEY) || {};
  const now = Date.now();
  // Prune currency buckets nothing has touched in a day (see HISTORY_BUCKET_TTL_MS).
  for (const [code, bucket] of Object.entries(all)) {
    if (code === currency) continue;
    const newest = Math.max(0, ...Object.values(bucket || {}).map((entry) => entry?.fetchedAt || 0));
    if (now - newest > HISTORY_BUCKET_TTL_MS) delete all[code];
  }
  const bucket = all[currency] || {};
  bucket[String(days)] = { points, fetchedAt: now };
  all[currency] = bucket;
  writeCache(HISTORY_CACHE_KEY, all);
}

/** Price history for `days` (1|7|30|90|365) in `currency`. Returns `[[timestampMs, price], ...]`.
 *  On failure returns this exact range's cached points (a stale copy of the range that was asked
 *  for beats showing a different range's curve), or `[]` when there's nothing cached. */
/// Market cap and rank, from CoinGecko's `/coins/markets` - the same keyless source everything
/// else here uses (iOS `CoinGeckoService.getMarketStats`).
///
/// CoinMarketCap's own API needs a key, and its rank agrees with CoinGecko's in all but the
/// occasional off-by-one around ties, so this is the figure people recognise without shipping a
/// second provider and a secret to reach it.
///
/// Cached for the same window as the price: these move slowly and the endpoint is rate limited.
let marketStatsCache = null;
export async function fetchKasMarketStats({ currency = "usd", force = false } = {}) {
  const code = normalizeCurrency(currency);
  if (!force && marketStatsCache?.currency === code
      && Date.now() - marketStatsCache.fetchedAt < MIN_REFRESH_MS) {
    return marketStatsCache;
  }
  try {
    const url = `${BASE_URL}/coins/markets?vs_currency=${encodeURIComponent(code)}&ids=kaspa`;
    const json = await fetchJsonWithRetry(url);
    const row = Array.isArray(json) ? json[0] : null;
    const marketCap = Number(row?.market_cap);
    if (!Number.isFinite(marketCap) || marketCap <= 0) return marketStatsCache;
    marketStatsCache = {
      marketCap,
      rank: Number.isFinite(Number(row?.market_cap_rank)) ? Number(row.market_cap_rank) : null,
      currency: code,
      fetchedAt: Date.now(),
    };
    return marketStatsCache;
  } catch {
    // A stat nobody asked for is not worth an error; the card just stays blank.
    return marketStatsCache;
  }
}

export function peekKasMarketStats(currency = "usd") {
  const code = normalizeCurrency(currency);
  return marketStatsCache?.currency === code ? marketStatsCache : null;
}

/** The base series a range is cut from (iOS 39adefe): a day of 5-minute points, 90 days of
 *  hourly points (1W, 1M and 3M are cuts of it), 365 days of daily points (YTD and 1Y). All
 *  (0) is its own build. Cuts are local, so range taps never touch the network. */
export function baseDaysFor(days) {
  if (days === 0) return 0;
  if (days <= 1) return 1;
  if (days <= 90) return 90;
  return 365;
}

/** The last `days` of a base series, with the one point before the edge kept so the line
 *  starts at the edge rather than a step inside it. Zero days is everything. */
export function cutPoints(base, days) {
  if (!days || !Array.isArray(base) || !base.length) return base || [];
  const cutoff = Date.now() - days * 86_400_000;
  const first = base.findIndex((p) => p[0] >= cutoff);
  if (first < 0) return base;
  return base.slice(Math.max(0, first - 1));
}

/** Days since 1 January, computed when read so it is right after midnight (at least 2). */
export function yearToDateDays() {
  const now = new Date();
  const start = new Date(now.getFullYear(), 0, 1);
  return Math.max(2, Math.round((now - start) / 86_400_000));
}

// --- Gate.io: public candles, no key, KAS/USDT trading since 2023-03-21 ---------------------

/** Gate.io candle closes for a pair at an interval, oldest first, the newest `pointCount` of
 *  them, paged backwards 1000 at a time and stopping where the listing begins.
 *  Row shape: [time, quote volume, close, high, low, open, ...]. Returns [[ms, close]]. */
async function fetchGateCandles(pair, interval, intervalSeconds, pointCount) {
  const closes = new Map();
  let to = Math.floor(Date.now() / 1000);
  let remaining = pointCount;
  for (let page = 0; page < 8 && remaining > 0; page += 1) {
    const limit = Math.min(1000, remaining);
    const url = `https://api.gateio.ws/api/v4/spot/candlesticks?currency_pair=${encodeURIComponent(pair)}&interval=${interval}&limit=${limit}&to=${to}`;
    let rows;
    try {
      const response = await fetch(url, { headers: { Accept: "application/json" } });
      if (!response.ok) break;
      rows = await response.json();
    } catch { break; }
    if (!Array.isArray(rows) || !rows.length) break;
    let earliest = to;
    for (const row of rows) {
      if (!Array.isArray(row) || row.length < 3) continue;
      const time = Number(row[0]);
      const close = Number(row[2]);
      if (Number.isFinite(time) && Number.isFinite(close)) { closes.set(time, close); earliest = Math.min(earliest, time); }
    }
    remaining -= rows.length;
    if (rows.length < limit || earliest >= to) break;
    to = earliest - intervalSeconds;
  }
  return [...closes.keys()].sort((a, b) => a - b).map((t) => [t * 1000, closes.get(t)]);
}

function divideByTime(kas, pair) {
  const byTime = new Map(pair.map((p) => [p[0], p[1]]));
  const out = [];
  for (const [t, v] of kas) {
    const q = byTime.get(t);
    if (q > 0) out.push([t, v / q]);
  }
  return out;
}

/** The same range from Gate.io when CoinGecko will not serve it: 5-minute candles for a day,
 *  hourly for 90 days, daily beyond. Gate quotes USDT, which is the dollar series; bitcoin
 *  divides by BTC/USDT candle for candle; any other currency is scaled by the ratio of the
 *  latest known KAS price in it (`spotHint`) to Gate's latest close. */
async function fetchGateHistory(days, currency, spotHint) {
  const [interval, seconds, count] = days <= 1 ? ["5m", 300, 288] : days <= 90 ? ["1h", 3600, days * 24] : ["1d", 86_400, days];
  const [kas, bitcoin] = await Promise.all([
    fetchGateCandles("KAS_USDT", interval, seconds, count),
    currency === "btc" ? fetchGateCandles("BTC_USDT", interval, seconds, count) : Promise.resolve([]),
  ]);
  if (!kas.length) return [];
  if (currency === "usd") return kas;
  if (currency === "btc") return divideByTime(kas, bitcoin);
  const latest = kas[kas.length - 1][1];
  if (!(spotHint > 0) || !(latest > 0)) return [];
  const ratio = spotHint / latest;
  return kas.map(([t, v]) => [t, v * ratio]);
}

/** All-time (iOS be477d1): CoinGecko's public tier stops at 365 days, so the older part comes
 *  from Gate.io's daily KAS/USDT closes and CoinGecko's own last 365 days sit on top unchanged.
 *  The older points are scaled into the chosen currency by the ratio at the seam. */
async function fetchAllTimeHistory(currency) {
  const [recent, gate, bitcoin] = await Promise.all([
    fetchKasPriceHistory(365, { currency }),
    fetchGateCandles("KAS_USDT", "1d", 86_400, 6000),
    currency === "btc" ? fetchGateCandles("BTC_USDT", "1d", 86_400, 6000) : Promise.resolve([]),
  ]);
  if (!gate.length) return recent;
  if (currency === "btc") {
    const inBitcoin = divideByTime(gate, bitcoin);
    if (!recent.length) return inBitcoin;
    return [...inBitcoin.filter((p) => p[0] < recent[0][0]), ...recent];
  }
  if (!recent.length) return currency === "usd" ? gate : [];
  const firstRecent = recent[0];
  const anchor = [...gate].reverse().find((p) => p[0] <= firstRecent[0]) || gate[gate.length - 1];
  const ratio = anchor[1] > 0 ? firstRecent[1] / anchor[1] : 1;
  const older = gate.filter((p) => p[0] < firstRecent[0]).map(([t, v]) => [t, v * ratio]);
  return [...older, ...recent];
}

/** Price history for `days` (0 = all-time) in `currency`. CoinGecko first, Gate.io when it
 *  refuses. Returns `[[timestampMs, price], ...]`; on failure this exact range's cached points. */
export async function fetchKasPriceHistory(days = 7, { currency = "usd", force = false } = {}) {
  const code = normalizeCurrency(currency);
  const cached = peekKasPriceHistory(days, code);
  if (!force && cached && Date.now() - cached.fetchedAt < MIN_REFRESH_MS) return cached.points;

  let points = [];
  if (days === 0) {
    points = await fetchAllTimeHistory(code).catch(() => []);
  } else {
    points = await fetchMarketChart(days, code).catch(() => []);
    if (!points.length) points = await fetchGateHistory(days, code, peekKasPrice(code)?.price).catch(() => []);
  }
  if (!points.length) return cached?.points || [];
  persistHistory(days, code, points);
  return points;
}

// --- Market pairs (iOS MarketPairService): VOO, gold and silver from Yahoo's chart endpoint ---

export const CHART_PAIRS = Object.freeze({
  bitcoin: { code: "BTC", title: "Bitcoin", subtitle: "Kaspa priced in bitcoin", symbol: null },
  voo: { code: "VOO", title: "VOO", subtitle: "Shares of Vanguard's S&P 500 ETF", symbol: "VOO" },
  gold: { code: "XAU", title: "Gold", subtitle: "Troy ounces of gold", symbol: "GC=F" },
  silver: { code: "XAG", title: "Silver", subtitle: "Troy ounces of silver", symbol: "SI=F" },
});

/** A pair's price series in dollars for a base range: { points: [[ms, close]], latest }. */
export async function fetchMarketPairHistory(pair, baseDays) {
  const symbol = CHART_PAIRS[pair]?.symbol;
  if (!symbol) return { points: [], latest: null };
  const [range, interval] = baseDays === 0 ? ["max", "1d"] : baseDays <= 1 ? ["5d", "5m"] : baseDays <= 90 ? ["3mo", "1h"] : ["2y", "1d"];
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}&includePrePost=false`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { Accept: "application/json" } });
      if (response.status === 200) {
        const json = await response.json();
        const result = json?.chart?.result?.[0];
        if (!result) return { points: [], latest: null };
        const stamps = result.timestamp || [];
        const closes = result.indicators?.quote?.[0]?.close || [];
        const points = [];
        stamps.forEach((stamp, i) => { const close = closes[i]; if (close > 0) points.push([stamp * 1000, close]); });
        return { points, latest: result.meta?.regularMarketPrice ?? points[points.length - 1]?.[1] ?? null };
      }
      if (attempt > 0 || !(response.status === 429 || response.status >= 500)) return { points: [], latest: null };
      await new Promise((resolve) => setTimeout(resolve, 2000));
    } catch { return { points: [], latest: null }; }
  }
  return { points: [], latest: null };
}

/** KAS divided by the pair's last price at each point. */
export function dividePoints(kas, pair) {
  if (!pair?.length) return [];
  const out = [];
  let i = 0;
  for (const [t, v] of kas) {
    while (i + 1 < pair.length && pair[i + 1][0] <= t) i += 1;
    if (pair[i][0] <= t && pair[i][1] > 0) out.push([t, v / pair[i][1]]);
  }
  return out;
}

// --- historical day prices --------------------------------------------------

/** Cached-only read for a set of "YYYY-MM-DD" UTC day keys: `{ [dayKey]: price }`. */
export function peekDailyPrices(dayKeys, currency) {
  const bucket = (readCache(DAILY_CACHE_KEY) || {})[normalizeCurrency(currency)] || {};
  const result = {};
  for (const key of dayKeys || []) {
    if (Number.isFinite(bucket[key])) result[key] = bucket[key];
  }
  return result;
}

/** A past day's historical price never changes, so resolved days are cached forever (per
 *  currency) - re-imports and backfill passes never re-pay a network call for a day any earlier
 *  import already priced. Today's "price" is still moving, so it's never frozen into the cache. */
function storeDailyPrices(prices, currency) {
  const todayKey = utcDayKey(Date.now()); // "YYYY-MM-DD" sorts lexicographically
  const entries = Object.entries(prices || {}).filter(([key, value]) => key < todayKey && Number.isFinite(value));
  if (!entries.length) return;
  const all = readCache(DAILY_CACHE_KEY) || {};
  const bucket = all[currency] || {};
  for (const [key, value] of entries) bucket[key] = value;
  all[currency] = bucket;
  writeCache(DAILY_CACHE_KEY, all);
}

/** Resolves historical prices for a set of UTC day keys: persistent cache first, then ONE
 *  `market_chart` range call covering every still-unpriced day inside CoinGecko's keyless
 *  365-day window - replacing the one-request-per-day burst that tripped the rate limit on any
 *  import with more than a handful of trading days. Days it can't cover (older than a year, or
 *  the range call failed) are simply absent from the result, for the per-day fallback to pick up.
 *  Port of PortfolioAddressImporter.resolveDailyPrices. */
export async function resolveDailyPrices(dayKeys, currency) {
  const code = normalizeCurrency(currency);
  const unique = [...new Set(dayKeys || [])].sort();
  if (!unique.length) return {};

  const resolved = peekDailyPrices(unique, code);
  const missing = unique.filter((key) => resolved[key] === undefined);
  const oldestMissing = missing[0];
  if (!oldestMissing) return resolved;

  const daysBack = Math.max(1, Math.ceil((Date.now() - dayKeyToMs(oldestMissing)) / 86_400_000) + 1);
  const points = await fetchMarketChart(Math.min(daysBack, KEYLESS_HISTORY_WINDOW_DAYS), code);
  if (!points.length) return resolved;

  // Last sample per UTC day = that day's close (daily-granularity ranges have exactly one sample
  // per day; shorter ranges arrive hourly and collapse the same way, since points are ordered
  // oldest-first and each write overwrites the previous one for that day).
  const byDay = {};
  for (const [ts, value] of points) byDay[utcDayKey(ts)] = value;
  // Cache the WHOLE fetched range, not just the days asked for - future imports and backfill
  // passes for other addresses then price those days with no network call at all.
  storeDailyPrices(byDay, code);
  for (const key of missing) {
    if (byDay[key] !== undefined) resolved[key] = byDay[key];
  }
  return resolved;
}

/** Per-day fallback through `/coins/kaspa/history` for days the batched range couldn't cover.
 *  Cache-first; one paced retry on failure (on top of the 429 Retry-After retry inside
 *  fetchJsonWithRetry); successful lookups join the forever-cache. Returns null when CoinGecko
 *  simply has no snapshot for that date, which callers must treat like any other "couldn't
 *  price this" case. Port of PortfolioAddressImporter.resolveDailyPriceSingle. */
export async function resolveDailyPriceSingle(dayKey, currency) {
  const code = normalizeCurrency(currency);
  const cached = peekDailyPrices([dayKey], code)[dayKey];
  if (cached !== undefined) return cached;

  const lookup = async () => {
    const url = `${BASE_URL}/coins/kaspa/history?date=${encodeURIComponent(dayKeyToCoinGecko(dayKey))}&localization=false`;
    const json = await fetchJsonWithRetry(url);
    const value = Number(json?.market_data?.current_price?.[code]);
    return Number.isFinite(value) && value > 0 ? value : null;
  };

  let value = await lookup();
  if (value === null) {
    await sleep(PRICE_REQUEST_SPACING_MS);
    value = await lookup();
  }
  if (value !== null) storeDailyPrices({ [dayKey]: value }, code);
  return value;
}
