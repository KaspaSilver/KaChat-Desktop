// The unnamed-identity sweep backs off a "no name" answer (iOS cbb8a83, IOS-087): never asked or
// the last lookup failed = this pass; "no name" is trusted for 1, then 5, 15 and 60 minutes as they
// repeat, and re-asked after a minute only once the registry's revision moved.
import assert from "node:assert/strict";
import { UNNAMED_BACKOFF_MS, unnamedSweepDue, nextUnnamedAnswers } from "../ui/kachat-unnamed-sweep.js";

const min = 60_000;
const t0 = 1_800_000_000_000;
const noName = (at, revision = 7) => ({ identity: null, revision, at });
const named = (at) => ({ identity: { label: "alice", names: ["alice"] }, revision: 7, at });

assert.deepEqual([...UNNAMED_BACKOFF_MS], [1 * min, 5 * min, 15 * min, 60 * min]);

// never asked: this pass
assert.equal(unnamedSweepDue(null, 0, 7, t0), true);
// a known name is never asked again by the sweep
assert.equal(unnamedSweepDue(named(t0 - 120 * min), 0, 8, t0), false);
// the last lookup failed: this pass, whatever the count
assert.equal(unnamedSweepDue({ ...noName(t0), failed: true }, 3, 7, t0), true);

// the schedule: after n "no name" answers in a row, asked once the n-th wait is over
const waits = [1, 5, 15, 60, 60, 60];
for (let n = 0; n < waits.length; n += 1) {
  const wait = waits[n] * min;
  assert.equal(unnamedSweepDue(noName(t0 - wait + 1), n, 7, t0), false, `${n} in a row: not before ${waits[n]} min`);
  assert.equal(unnamedSweepDue(noName(t0 - wait), n, 7, t0), true, `${n} in a row: at ${waits[n]} min`);
}

// the registry moved: re-asked once the answer is over a minute old, however far backed off
assert.equal(unnamedSweepDue(noName(t0 - min - 1, 6), 3, 7, t0), true);
assert.equal(unnamedSweepDue(noName(t0 - min, 6), 3, 7, t0), false, "a minute exactly is not over a minute");
assert.equal(unnamedSweepDue(noName(t0 - 30_000, 6), 3, 7, t0), false);
// a copy loaded at launch (revision -1, at 0): this pass
assert.equal(unnamedSweepDue({ identity: null, revision: -1, at: 0 }, 0, 7, t0), true);

// counting: one more per "no name", none once a name came back, unchanged on a failure
assert.equal(nextUnnamedAnswers(null, noName(t0)), 1);
assert.equal(nextUnnamedAnswers(2, noName(t0)), 3);
assert.equal(nextUnnamedAnswers(3, named(t0)), null);
assert.equal(nextUnnamedAnswers(2, { ...noName(t0), failed: true }), 2);
assert.equal(nextUnnamedAnswers(null, { ...noName(t0), failed: true }), null);
assert.equal(nextUnnamedAnswers(2, null), 2);
// a profile without a name is still "no name"
assert.equal(nextUnnamedAnswers(0, { identity: { label: null, names: [], profile: {} }, revision: 7, at: t0 }), 1);

console.log("kachat unnamed sweep: ok");
