// The unnamed-identity sweep's rules (iOS cbb8a83, IOS-087, KachatNamesRegistry
// refreshUnnamedIdentities). Pure, so tools/test-kachat-unnamed-sweep.mjs can run them without the
// app; the sweep itself is kachat-names-live.js startKachatUnnamedIdentitySweep.
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
