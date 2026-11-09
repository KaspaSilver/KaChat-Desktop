// Whether the KaChat indexer is answering (iOS 4f8e14bb IndexerHealth, KaPost ee5ec98). It counts as
// down only after several failures in a row, so one timeout never moves the app off it, and failures
// within a few seconds of each other count once: a dropped connection fails everything in flight
// together. While it's down, one cheap request a minute checks whether it's back.
//
// This sees failures only. An indexer that answers 200 with old data looks healthy here, on iOS too.

export const INDEXER_FAILURE_SPACING_MS = 5_000;
export const INDEXER_FAILURES_TO_GO_DOWN = 3;
/** Failures further apart than this aren't a run. */
export const INDEXER_FAILURE_WINDOW_MS = 120_000;
export const INDEXER_RETRY_INTERVAL_MS = 60_000;
/** An aborted request this old was a timeout, not someone moving on (Desktop's timeouts are aborts). */
export const INDEXER_TIMEOUT_ABORT_MS = 10_000;
/** On recovery the sync cursors go back to the outage's start minus this (iOS catchUpAfterIndexerOutage). */
export const INDEXER_RECOVERY_MARGIN_MS = 10 * 60 * 1000;

const OUTAGE_KEY = "kachat_indexer_down_since";

/** The origin an indexer URL is tracked under, or "" for no URL. */
export function indexerKey(url) {
  try { return new URL(String(url || "")).origin.toLowerCase(); } catch { return ""; }
}

function readStoredOutages(storage) {
  try {
    const parsed = JSON.parse(storage?.getItem(OUTAGE_KEY) || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch { return {}; }
}

/** The detector, per indexer origin. `storage` keeps an outage across a reload, so the first answer
 *  after it still closes it and the window read from the chain is read again from the indexer. */
export function createIndexerHealth({ now = () => Date.now(), storage = globalThis.localStorage ?? null } = {}) {
  const entries = new Map();
  const listeners = new Set();
  const entry = (key) => {
    let found = entries.get(key);
    if (!found) {
      const unfinished = Number(readStoredOutages(storage)[key]) || null;
      found = { downSince: null, unfinished, failures: 0, lastFailureAt: -Infinity, retryAt: -Infinity };
      entries.set(key, found);
    }
    return found;
  };
  const store = () => {
    try {
      const all = {};
      for (const [key, value] of entries) {
        const since = value.downSince ?? value.unfinished;
        if (since != null) all[key] = since;
      }
      if (Object.keys(all).length) storage?.setItem(OUTAGE_KEY, JSON.stringify(all));
      else storage?.removeItem(OUTAGE_KEY);
    } catch { /* kept for this page */ }
  };
  const announce = (change) => {
    for (const listener of listeners) { try { listener(change); } catch { /* the others still hear */ } }
  };
  return {
    isDown: (url) => entry(indexerKey(url)).downSince != null,
    /** When the current outage began (ms), or null. */
    downSince: (url) => entry(indexerKey(url)).downSince,
    /** True at most once a minute, while it's down. */
    claimRecoveryCheck(url) {
      const found = entry(indexerKey(url));
      const at = now();
      if (found.downSince == null || at < found.retryAt) return false;
      found.retryAt = at + INDEXER_RETRY_INTERVAL_MS;
      return true;
    },
    recordFailure(url) {
      const key = indexerKey(url);
      if (!key) return;
      const found = entry(key);
      const at = now();
      const sinceLast = at - found.lastFailureAt;
      if (sinceLast > INDEXER_FAILURE_WINDOW_MS) found.failures = 0;
      if (found.failures === 0 || sinceLast >= INDEXER_FAILURE_SPACING_MS) {
        found.lastFailureAt = at;
        found.failures += 1;
      }
      if (found.downSince != null || found.failures < INDEXER_FAILURES_TO_GO_DOWN) return;
      // still the outage the page was closed during: it began back then
      found.downSince = found.unfinished ?? at;
      found.unfinished = null;
      found.retryAt = at + INDEXER_RETRY_INTERVAL_MS;
      store();
      announce({ key, down: true, downSinceMs: found.downSince });
    },
    recordAnswer(url) {
      const key = indexerKey(url);
      if (!key) return;
      const found = entry(key);
      found.failures = 0;
      const wentDownAt = found.downSince ?? found.unfinished;
      if (wentDownAt == null) return;
      found.downSince = null;
      found.unfinished = null;
      store();
      announce({ key, down: false, downSinceMs: wentDownAt });
    },
    /** `listener({ key, down, downSinceMs })`; returns the unsubscribe. */
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    reset() { entries.clear(); store(); },
  };
}

export const indexerHealth = createIndexerHealth();
export const onIndexerAvailabilityChange = (listener) => indexerHealth.subscribe(listener);
export const isIndexerDown = (url) => indexerHealth.isDown(url);

const browserIsOffline = () => globalThis.navigator?.onLine === false;

/** What one finished fetch says about the indexer: "answered", "down" or "inconclusive".
 *  `relayLimited`: a 429 from the app's own relay, which says nothing about the indexer. */
export function indexerFetchOutcome({ response = null, error = null, elapsedMs = 0, relayLimited = false, offline = browserIsOffline() } = {}) {
  if (offline || relayLimited) return "inconclusive";
  if (error) {
    if (error?.name === "AbortError") return elapsedMs >= INDEXER_TIMEOUT_ABORT_MS ? "down" : "inconclusive";
    return "down";
  }
  const status = Number(response?.status) || 0;
  if (status === 429 || status >= 500) return "down";
  // A CDN's or proxy's HTML page is not the indexer answering; a body it can't decode still is.
  if (status === 200 && /text\/html/i.test(response?.headers?.get?.("content-type") || "")) return "down";
  return "answered";
}

/** Runs one indexer fetch and reports how it went, before the caller sees the result. */
export async function watchIndexerFetch(url, run, { isRelayLimit = async () => false, health = indexerHealth } = {}) {
  const startedAt = Date.now();
  let response;
  try {
    response = await run();
  } catch (error) {
    const outcome = indexerFetchOutcome({ error, elapsedMs: Date.now() - startedAt });
    if (outcome === "down") health.recordFailure(url);
    throw error;
  }
  const relayLimited = response?.status === 429 ? await isRelayLimit(response) : false;
  const outcome = indexerFetchOutcome({ response, relayLimited });
  if (outcome === "down") health.recordFailure(url);
  else if (outcome === "answered") health.recordAnswer(url);
  return response;
}

/** For a caller about to read the indexer: true while it's down. Once a minute a single cheap
 *  request goes out to find out whether it's back. */
export function shouldSkipIndexer(baseUrl, { health = indexerHealth, probe = null } = {}) {
  if (!health.isDown(baseUrl)) return false;
  if (health.claimRecoveryCheck(baseUrl)) {
    const check = probe ?? (() => fetch(`${String(baseUrl).replace(/\/+$/, "")}/metrics`, { headers: { Accept: "application/json" }, cache: "no-store" }));
    Promise.resolve().then(check).catch(() => {});
  }
  return true;
}

/** The indexer's answer or, once it's confirmed down, the same thing read from the chain, so callers
 *  work the same either way. A one-off failure with the indexer up is thrown as it always was, for
 *  the caller's own retry. */
export async function fromIndexerOrChain(baseUrl, indexer, chain, options = {}) {
  if (shouldSkipIndexer(baseUrl, options)) return chain();
  try {
    return await indexer();
  } catch (error) {
    if (!(options.health ?? indexerHealth).isDown(baseUrl)) throw error;
    return chain();
  }
}
