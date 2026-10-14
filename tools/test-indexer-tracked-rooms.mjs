// Rooms the indexer tracks beyond the curated ones (iOS 21c480d): the reported list from
// /broadcast-channels, the 30-day "served" window, the once-an-hour write and ask, and the change
// signal. Pure: storage and the clock are stubbed. Run from the repo root:
//
//   node tools/test-indexer-tracked-rooms.mjs

import {
  createIndexerTrackedRooms,
  parseTrackedChannelsResponse,
  shouldAskTrackedRooms,
  TRACKED_ASK_INTERVAL_MS,
  TRACKED_SERVED_WINDOW_MS,
  TRACKED_SERVED_WRITE_MS,
} from "../engine/indexer-tracked-rooms.js";

const r = {
  pass: 0, fail: 0, failures: [],
  check(ok, label) { if (ok) this.pass++; else { this.fail++; this.failures.push(label); } },
  eq(a, b, label) { this.check(a === b, `${label}: got ${String(a)}, expected ${String(b)}`); },
};

function memoryStorage(initial = {}) {
  const data = { ...initial };
  let writes = 0;
  return {
    data,
    get writes() { return writes; },
    getItem: (key) => (key in data ? data[key] : null),
    setItem: (key, value) => { writes += 1; data[key] = String(value); },
  };
}

const normalize = (name) => String(name || "").trim().toLowerCase().replace(/^#/, "");
const KEYS = { reportedKey: "reported", servedKey: "served" };
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// --- reported: replaced on every answer, change fires once ---------------------------------------
{
  let t = 1_000_000;
  let changes = 0;
  const storage = memoryStorage();
  const rooms = createIndexerTrackedRooms({ storage, ...KEYS, normalize, now: () => t, onChange: () => { changes += 1; } });
  r.eq(rooms.contains("my-new-room"), false, "unknown room is not tracked");
  r.eq(rooms.setReported(["kaspa", "#My-New-Room", "", "  "]), true, "first list is a change");
  r.eq(changes, 1, "one change signal");
  r.eq(rooms.contains("my-new-room"), true, "a listed room is tracked (names normalized)");
  r.eq(rooms.setReported(["my-new-room", "kaspa"]), false, "same set in another order is no change");
  r.eq(changes, 1, "no signal without a change");
  r.eq(JSON.parse(storage.data.reported).join(","), "kaspa,my-new-room", "persisted sorted");
  r.eq(rooms.setReported(["kaspa"]), true, "a dropped room is a change");
  r.eq(rooms.contains("my-new-room"), false, "a room no longer listed (and never served) is not tracked");
  r.eq(changes, 2, "dropping signals too");
  r.eq(rooms.setReported([]), true, "an empty list (broadcasts switched off) clears it");
  r.eq(rooms.all().size, 0, "nothing tracked");
}

// --- served: 30 days after the last rows, written at most hourly --------------------------------
{
  let t = 50 * DAY;
  let changes = 0;
  const storage = memoryStorage();
  const rooms = createIndexerTrackedRooms({ storage, ...KEYS, normalize, now: () => t, onChange: () => { changes += 1; } });
  r.eq(rooms.markServed("Own-Room"), true, "first rows make a room tracked");
  r.eq(changes, 1, "and signal");
  r.eq(rooms.contains("own-room"), true, "served room is tracked");
  const writesAfterFirst = storage.writes;
  t += 8_000;
  r.eq(rooms.markServed("own-room"), false, "a poll 8 s later is no news");
  r.eq(storage.writes, writesAfterFirst, "and is not written again within the hour");
  t += TRACKED_SERVED_WRITE_MS;
  rooms.markServed("own-room");
  r.eq(storage.writes, writesAfterFirst + 1, "rewritten once the stamp is over an hour old");
  r.eq(changes, 1, "still one change signal");
  const stampedAt = t;
  t = stampedAt + TRACKED_SERVED_WINDOW_MS - 1;
  r.eq(rooms.contains("own-room"), true, "still tracked just inside 30 days");
  t = stampedAt + TRACKED_SERVED_WINDOW_MS;
  r.eq(rooms.contains("own-room"), false, "no rows for 30 days: no longer tracked");
  r.eq(rooms.all().has("own-room"), false, "and gone from all()");
  r.eq(rooms.markServed("own-room"), true, "rows again make it tracked again");
  r.eq(changes, 2, "with a signal");
  r.eq(rooms.markServed(""), false, "an empty name is ignored");
}

// --- the two sources merge; persisted per key (per network) -------------------------------------
{
  let t = 10 * DAY;
  const storage = memoryStorage();
  const a = createIndexerTrackedRooms({ storage, ...KEYS, normalize, now: () => t });
  a.setReported(["listed"]);
  a.markServed("served");
  const merged = [...a.all()].sort().join(",");
  r.eq(merged, "listed,served", "all() is reported plus served");
  let changes = 0;
  const b = createIndexerTrackedRooms({ storage, ...KEYS, normalize, now: () => t, onChange: () => { changes += 1; } });
  r.eq(b.contains("listed") && b.contains("served"), true, "a fresh load reads both back");
  r.eq(b.markServed("listed"), false, "a listed room served is no news");
  r.eq(changes, 0, "no signal for it");
  const testnet = createIndexerTrackedRooms({ storage, reportedKey: "reported-testnet", servedKey: "served-testnet", normalize, now: () => t });
  r.eq(testnet.contains("listed") || testnet.contains("served"), false, "another network's keys hold nothing of this one");
}

// --- broken or missing storage never throws -----------------------------------------------------
{
  const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("quota"); } };
  const rooms = createIndexerTrackedRooms({ storage: broken, ...KEYS, normalize });
  r.eq(rooms.setReported(["x"]), true, "works in memory when storage throws");
  r.eq(rooms.contains("x"), true, "and answers from memory");
  const garbage = memoryStorage({ reported: "{not json", served: "[1,2]" });
  const rooms2 = createIndexerTrackedRooms({ storage: garbage, ...KEYS, normalize });
  r.eq(rooms2.all().size, 0, "garbage in storage reads as empty");
  const none = createIndexerTrackedRooms({ ...KEYS, normalize });
  r.eq(none.markServed("y"), true, "no storage at all is fine");
}

// --- the hourly ask gate --------------------------------------------------------------------------
{
  const base = "https://indexer.example";
  r.eq(shouldAskTrackedRooms(null, base, 0), true, "never asked: ask");
  r.eq(shouldAskTrackedRooms(null, "  ", 0), false, "no indexer: never ask");
  r.eq(shouldAskTrackedRooms({ base, at: 0 }, base, TRACKED_ASK_INTERVAL_MS - 1), false, "within the hour: no");
  r.eq(shouldAskTrackedRooms({ base, at: 0 }, base, TRACKED_ASK_INTERVAL_MS), true, "an hour later: yes");
  r.eq(shouldAskTrackedRooms({ base, at: 0 }, "https://other.example", 1), true, "another indexer: at once");
}

// --- the /broadcast-channels answer ---------------------------------------------------------------
{
  r.eq(parseTrackedChannelsResponse({ channels: ["kaspa", "#My-Room", 7, ""] }, normalize)?.join(","), "kaspa,my-room", "names out, junk dropped");
  r.eq(parseTrackedChannelsResponse({ channels: [] }, normalize)?.length, 0, "an empty list is an answer");
  r.eq(parseTrackedChannelsResponse({ error: "not found" }, normalize), null, "no channels array: no answer");
  r.eq(parseTrackedChannelsResponse(null, normalize), null, "null: no answer");
}

if (r.fail) {
  console.error(`indexer tracked rooms: ${r.fail} failed, ${r.pass} passed`);
  for (const line of r.failures) console.error(`  FAIL ${line}`);
  process.exit(1);
}
console.log(`indexer tracked rooms: all ${r.pass} checks passed`);
