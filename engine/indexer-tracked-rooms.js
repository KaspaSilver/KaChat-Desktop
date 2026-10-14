// The public chat rooms an indexer tracks beyond the curated ones (iOS 21c480d
// `IndexerTrackedRooms`), so a room the operator adds on the indexer gets everything a default
// room gets - its 30 days of history kept on this device, the closed-room sweep behind its bell,
// the "even when the app is closed" wording - with no app update. Learned two ways:
// - Reported: the app-wide indexer's `GET /broadcast-channels` (replaced on every answer).
// - Served: a room whose `/get-broadcasts` returned rows - an indexer stores only rooms it
//   tracks. Counts for 30 days after the last rows came back (the indexer's own window), so this
//   also works with an indexer that predates the endpoint, and with a room's own indexer.
// Per network, persisted. No imports: the caller hands in storage, the clock and the name rule,
// so the rule itself is testable in node (tools/test-indexer-tracked-rooms.mjs).

/** How long a room counts as tracked after its indexer last returned rows for it. */
export const TRACKED_SERVED_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
/** A served stamp is rewritten at most once an hour per room: every 8 s poll lands here. */
export const TRACKED_SERVED_WRITE_MS = 60 * 60 * 1000;
/** The app-wide indexer is asked which rooms it tracks at most once an hour. */
export const TRACKED_ASK_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Whether to ask `base`'s `/broadcast-channels` now, given the last ask `{ base, at }` (or null):
 * at most once an hour per indexer; a different indexer is asked at once.
 */
export function shouldAskTrackedRooms(last, base, nowMs) {
  const clean = String(base || "").trim();
  if (!clean) return false;
  if (!last || last.base !== clean) return true;
  return nowMs - Number(last.at || 0) >= TRACKED_ASK_INTERVAL_MS;
}

/** The room names out of a `/broadcast-channels` answer (`{ "channels": [...] }`), or null. */
export function parseTrackedChannelsResponse(json, normalize = (name) => String(name || "").trim().toLowerCase()) {
  if (!json || typeof json !== "object" || !Array.isArray(json.channels)) return null;
  return json.channels.filter((name) => typeof name === "string").map(normalize).filter(Boolean);
}

/**
 * The tracked-room set over a key-value `storage` (localStorage's getItem/setItem; a missing or
 * throwing one just means nothing persists). `onChange()` fires when the set changes, so the
 * caller's scanning, sweep and wording follow at once.
 */
export function createIndexerTrackedRooms({
  storage = null,
  reportedKey,
  servedKey,
  normalize = (name) => String(name || "").trim().toLowerCase(),
  now = () => Date.now(),
  onChange = () => {},
} = {}) {
  let loaded = false;
  let reported = new Set();
  let served = {}; // { [channel]: ms the indexer last returned rows for it }

  const read = (key, fallback) => {
    try {
      const raw = storage?.getItem?.(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch { return fallback; }
  };
  const write = (key, value) => {
    try { storage?.setItem?.(key, JSON.stringify(value)); } catch { /* kept in memory only */ }
  };
  const load = () => {
    if (loaded) return;
    loaded = true;
    const list = read(reportedKey, []);
    reported = new Set(Array.isArray(list) ? list.filter((name) => typeof name === "string") : []);
    const stamps = read(servedKey, {});
    served = {};
    if (stamps && typeof stamps === "object" && !Array.isArray(stamps)) {
      for (const [name, at] of Object.entries(stamps)) {
        if (Number.isFinite(Number(at))) served[name] = Number(at);
      }
    }
  };
  const servedRecently = (name, nowMs) => {
    const at = served[name];
    return at != null && nowMs - at < TRACKED_SERVED_WINDOW_MS;
  };

  return {
    /** True when the indexer tracks `name` (already normalized), as far as this device knows. */
    contains(name) {
      load();
      return reported.has(name) || servedRecently(name, now());
    },

    /** Every room `contains` says yes to. */
    all() {
      load();
      const nowMs = now();
      const out = new Set(reported);
      for (const name of Object.keys(served)) if (servedRecently(name, nowMs)) out.add(name);
      return out;
    },

    /** The app-wide indexer's list, as `/broadcast-channels` answered. True when it changed. */
    setReported(channels) {
      load();
      const names = new Set((Array.isArray(channels) ? channels : []).map(normalize).filter(Boolean));
      const changed = names.size !== reported.size || [...names].some((name) => !reported.has(name));
      if (!changed) return false;
      reported = names;
      write(reportedKey, [...names].sort());
      onChange();
      return true;
    },

    /** `channel`'s indexer just returned rows for it. True when that made it a tracked room. */
    markServed(channel) {
      const name = normalize(channel);
      if (!name) return false;
      load();
      const nowMs = now();
      const wasTracked = reported.has(name) || servedRecently(name, nowMs);
      const previous = served[name];
      if (previous == null || nowMs - previous > TRACKED_SERVED_WRITE_MS) {
        served[name] = nowMs;
        write(servedKey, served);
      }
      if (!wasTracked) onChange();
      return !wasTracked;
    },
  };
}
