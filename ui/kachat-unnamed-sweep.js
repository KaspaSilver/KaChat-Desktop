// The unnamed-identity sweep's rules (iOS cbb8a83, IOS-087, KachatNamesRegistry
// refreshUnnamedIdentities). Pure (the pass takes its lookups and cache as arguments), so
// tools/test-kachat-unnamed-sweep.mjs can run them without the app; the sweep itself is
// kachat-names-live.js startKachatUnnamedIdentitySweep. Since iOS 710b78f a pass asks the indexer
// once for everyone due (`unnamedSweepPass`, POST /identity/batch), four at a time only without it.
//
// A contact with no name was asked again every minute, forever. Now: never asked, or the last
// lookup failed (the registry still loading at launch) - this pass. A "no name" answer is trusted
// for 1, then 5, 15 and 60 minutes as they repeat, and re-asked after a minute only once the
// registry's revision moved, since a name only appears through a registry transaction.

/** How long a "no name" answer is trusted by the sweep (ms), by how many came in a row. */
export const UNNAMED_BACKOFF_MS = Object.freeze([60_000, 300_000, 900_000, 3_600_000]);
/** A moved registry re-asks a "no name" answer at least this old. */
export const UNNAMED_REGISTRY_MOVED_MIN_AGE_MS = 60_000;

/** Whether the sweep asks for this address now. `entry`: the cached identity
 *  (`{ identity, revision, at, failed }`, null = never asked; a known name is never asked again
 *  here); `answers`: "no name" answers in a
 *  row; `revision`: the registry's revision now. */
export function unnamedSweepDue(entry, answers, revision, nowMs) {
  if (!entry) return true;
  if (entry.identity?.label) return false;
  if (entry.failed) return true;
  const age = nowMs - entry.at;
  const count = Math.max(0, Math.floor(Number(answers) || 0));
  const backoff = UNNAMED_BACKOFF_MS[Math.min(count, UNNAMED_BACKOFF_MS.length - 1)];
  const registryMoved = entry.revision !== revision && age > UNNAMED_REGISTRY_MOVED_MIN_AGE_MS;
  return !(age < backoff && !registryMoved);
}

/** "No name" answers in a row after a sweep lookup: one more for another "no name", none once a
 *  name came back (null = forget the address), unchanged when the lookup failed. */
export function nextUnnamedAnswers(answers, entry) {
  if (!entry || entry.failed) return answers ?? null;
  return entry.identity?.label ? null : (Number(answers) || 0) + 1;
}

/** Without the batch (the chain walker, or an indexer without `/identity/batch`), a pass asks at
 *  most this many, four at a time. */
export const UNNAMED_SWEEP_FALLBACK_MAX = 40;

/**
 * One sweep pass over `targets` (the addresses due, most recent chats first; iOS 710b78f
 * refreshUnnamedIdentities). Everyone due goes in one `batch(targets)` (the registry's
 * `identities`, POST /identity/batch), so a pass is a single request however many contacts are
 * unnamed and nobody waits behind the 40-cap: each answer is filed with `store(key, identity)`
 * (true when it changed what the app shows), an address the answer left out is `miss(key)` (asked
 * again in a minute), then `answered(key)` counts its "no name" for the backoff - and `notify()`
 * runs once for the whole pass, only if anything changed. A null batch (no registry here, the
 * chain walker, an indexer without the endpoint) falls back to `lookUp(key)` for the first
 * `UNNAMED_SWEEP_FALLBACK_MAX`, four at a time while `visible()`; `lookUp` -> false skips the
 * address (a lookup already in flight), a throw is asked again next minute.
 * -> "batch" | "each" | "none" (nothing due).
 */
export async function unnamedSweepPass(targets, { batch, store, miss, answered, notify, lookUp, visible = () => true }) {
  if (!targets?.length) return "none";
  let found = null;
  try { found = await batch(targets); } catch { found = null; }
  if (found) {
    let anyChanged = false;
    for (const key of targets) {
      const identity = found.get(key);
      if (!identity) {
        // not in the answer (the indexer skipped it): a miss, asked again in a minute
        miss(key);
      } else if (store(key, identity)) {
        anyChanged = true;
      }
      // one more "no name" in a row backs the next ask off further; a miss changes nothing
      answered(key);
    }
    if (anyChanged) notify();
    return "batch";
  }
  // four at a time, the people you talk to most recently first (iOS d23e6f7a refreshUnnamedIdentities)
  const due = targets.slice(0, UNNAMED_SWEEP_FALLBACK_MAX);
  for (let start = 0; start < due.length; start += IDENTITY_FALLBACK_PARALLEL) {
    if (!visible()) break;
    await Promise.all(due.slice(start, start + IDENTITY_FALLBACK_PARALLEL).map(async (key) => {
      try { if ((await lookUp(key)) === false) return; } catch { return; /* asked again next minute */ }
      answered(key);
    }));
  }
  return "each";
}

/** Lookups one at a time per address, side by side in groups of this many, when there is no batch
 *  answer (iOS 33095ac / d23e6f7a: four at a time). */
export const IDENTITY_FALLBACK_PARALLEL = 4;

/** Runs `task(item)` for every item, `size` at a time; a throw is that item's alone. */
async function inGroupsOf(items, size, task) {
  for (let start = 0; start < items.length; start += size) {
    await Promise.all(items.slice(start, start + size).map((item) => Promise.resolve().then(() => task(item)).catch(() => {})));
  }
}

/** What an address the render-time batch left out of its answer is stored as: no names and no
 *  profile (iOS e5a9b11 KachatNamesRegistry.scheduleIdentityBatch). */
export function emptyKachatIdentity(address) {
  return { address, label: null, names: [], profile: null };
}

/** How long the render-time queue collects addresses before one batched request: the rest of the
 *  screen asks in the same moment (iOS e5a9b11, 150 ms). */
export const IDENTITY_BATCH_DELAY_MS = 150;

/**
 * One flush of the render-time lookup queue (iOS e5a9b11): every address `kachatCachedIdentity`
 * found stale in the last `IDENTITY_BATCH_DELAY_MS`, in one `batch(keys)` (the registry's
 * `identities`). Each is filed with `store(key, identity)` (true when it changed what the app
 * shows) - an address the answer left out as `emptyKachatIdentity` - and `notify()` runs once, only
 * if anything changed. A null batch (the whole request failed, or no indexer to ask) falls back to
 * `lookUp(key)` for each, four at a time. -> "batch" | "each" | "none".
 */
export async function identityBatchFlush(keys, { batch, store, notify, lookUp }) {
  if (!keys?.length) return "none";
  let found = null;
  try { found = await batch(keys); } catch { found = null; }
  if (!found) {
    // four at a time, not a whole screen of authors at once (iOS 33095ac scheduleIdentityBatch)
    await inGroupsOf(keys, IDENTITY_FALLBACK_PARALLEL, (key) => lookUp(key));
    return "each";
  }
  let anyChanged = false;
  for (const key of keys) {
    try { if (await store(key, found.get(key) ?? emptyKachatIdentity(key))) anyChanged = true; } catch { /* the next render asks again */ }
  }
  if (anyChanged) notify();
  return "batch";
}
