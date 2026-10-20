// The unnamed-identity sweep backs off a "no name" answer (iOS cbb8a83, IOS-087): never asked or
// the last lookup failed = this pass; "no name" is trusted for 1, then 5, 15 and 60 minutes as they
// repeat, and re-asked after a minute only once the registry's revision moved. Since iOS 710b78f a
// pass asks once for everyone due (the registry's `identities`, POST /identity/batch in chunks of
// 200; label null = no name, left out = a miss), and one at a time (at most 40) without it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { UNNAMED_BACKOFF_MS, UNNAMED_SWEEP_FALLBACK_MAX, unnamedSweepDue, nextUnnamedAnswers, unnamedSweepPass } from "../ui/kachat-unnamed-sweep.js";
import { KachatNamesRegistry } from "../engine/kachat-names/registry.js";
import { decodeManifest } from "../engine/kachat-names/manifest.js";
import { hex } from "../engine/kachat-names/codec.js";

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

// MARK: - One batch for everyone due (iOS 710b78f): POST /identity/batch, chunks of 200

const m = decodeManifest(readFileSync(new URL("../engine/kachat-names/kachat-names-mainnet.json", import.meta.url), "utf8"));
const addr = (i) => `kaspa:q${String(i).padStart(4, "0")}${"x".repeat(56)}`;
const named0 = addr(0);
const respond = (status, body) => ({ status, text: async () => JSON.stringify(body) });

/** A fake names indexer: `batch` = "live" (as the live server answers: an unnamed address is
 *  label null, one in `skip` is left out, past 200 is a 400), or the status an indexer without the
 *  endpoint answers (404, 405). */
function fakeIndexer({ batch = "live", skip = new Set() } = {}) {
  const calls = [];
  const fetch = async (url, opts = {}) => {
    const u = new URL(url);
    calls.push({ path: u.pathname, method: opts.method ?? "GET", headers: opts.headers ?? {}, body: opts.body ? JSON.parse(opts.body) : null });
    if (u.pathname === "/names/status") return respond(200, { network: "mainnet", registryCovenantId: hex(m.registryCovenantId), synced: true });
    if (u.pathname === "/identity/batch") {
      if (batch !== "live") return respond(batch, { error: "nope" });
      const { addresses } = JSON.parse(opts.body);
      if (addresses.length > 200) return respond(400, { error: "too_many", message: "at most 200 addresses" });
      const identities = {};
      for (const a of addresses) {
        if (skip.has(a)) continue;
        identities[a] = a === named0
          ? { address: a, label: "kasforge", names: ["kasforge"], profile: { v: 1, bio: " github.com/yo " } }
          : { address: a, label: null, names: [], profile: null };
      }
      return respond(200, { identities });
    }
    if (u.pathname.startsWith("/identity/")) {
      const a = u.pathname.slice("/identity/".length);
      return respond(200, { address: a, label: a === named0 ? "kasforge" : null, names: a === named0 ? ["kasforge"] : [], profile: null });
    }
    return respond(404, { error: "not_found" });
  };
  return { fetch, calls };
}
const registryOver = (fetch, extra = {}) => new KachatNamesRegistry({
  fetch, indexerBase: () => "https://idx.test/", restBase: () => "https://rest.test", manifest: m,
  getUtxosByAddresses: async () => [], log: () => {}, ...extra,
});
const batchCalls = (calls) => calls.filter((c) => c.path === "/identity/batch");

{
  // one request for many: the iOS body, JSON in and out, keyed back lowercased
  const idx = fakeIndexer();
  const reg = registryOver(idx.fetch);
  const keys = [addr(0), addr(1), addr(2)];
  const found = await reg.identities(keys.map((k, i) => (i === 1 ? ` ${k.toUpperCase()} ` : k)));
  const posts = batchCalls(idx.calls);
  assert.equal(posts.length, 1, "three addresses: one POST");
  assert.equal(posts[0].method, "POST");
  assert.equal(posts[0].headers["Content-Type"], "application/json");
  assert.deepEqual(posts[0].body, { addresses: keys }, "the body iOS sends: { addresses: [...] }, lowercased");
  assert.ok(!idx.calls.some((c) => c.path.startsWith("/identity/kaspa")), "no per-address GET");
  assert.deepEqual([...found.keys()], keys);
  assert.equal(found.get(addr(0)).label, "kasforge");
  assert.equal(found.get(addr(0)).profile?.bio, "https://github.com/yo", "a batch answer's profile is sanitized");
  // an unnamed address answers label null
  assert.deepEqual({ label: found.get(addr(1)).label, names: found.get(addr(1)).names }, { label: null, names: [] });
}
{
  // chunked at 200, the indexer's cap: 450 = 200 + 200 + 50
  const idx = fakeIndexer();
  const reg = registryOver(idx.fetch);
  const keys = Array.from({ length: 450 }, (_, i) => addr(i));
  const found = await reg.identities(keys);
  assert.equal(KachatNamesRegistry.identityBatchMax, 200);
  assert.deepEqual(batchCalls(idx.calls).map((c) => c.body.addresses.length), [200, 200, 50]);
  assert.deepEqual(batchCalls(idx.calls).flatMap((c) => c.body.addresses), keys, "every address once, in order");
  assert.equal(found.size, 450);
}
{
  // left out of the answer (the indexer skipped it): not in the Map
  const idx = fakeIndexer({ skip: new Set([addr(1)]) });
  const found = await registryOver(idx.fetch).identities([addr(0), addr(1)]);
  assert.deepEqual([...found.keys()], [addr(0)]);
}
// no batch: an indexer without the endpoint (404, or 405 as a server routing POST nowhere answers),
// the chain walker, no registry on this network (isEnabled false), nothing asked -> null, never throws
for (const status of [404, 405, 500]) {
  const idx = fakeIndexer({ batch: status });
  assert.equal(await registryOver(idx.fetch).identities([addr(0)]), null, `the batch answering ${status}: null`);
}
{
  // a chunk failing fails the whole batch (the caller asks one by one instead)
  let n = 0;
  const idx = fakeIndexer();
  const failSecond = async (url, opts) => (new URL(url).pathname === "/identity/batch" && ++n === 2 ? respond(503, {}) : idx.fetch(url, opts));
  assert.equal(await registryOver(failSecond).identities(Array.from({ length: 250 }, (_, i) => addr(i))), null);
  const bad = async (url, opts) => (new URL(url).pathname === "/identity/batch" ? respond(200, { identities: { [addr(0)]: { label: "x" } } }) : idx.fetch(url, opts));
  assert.equal(await registryOver(bad).identities([addr(0)]), null, "an unreadable entry fails the answer, as Swift's decode does");
}
{
  const idx = fakeIndexer();
  const chain = registryOver(idx.fetch, { indexerBase: () => "" });
  assert.equal(await chain.identities([addr(0)]), null, "the chain walker: null (each lookup is local)");
  assert.equal(chain.source?.kind, "chain");
  assert.equal(batchCalls(idx.calls).length, 0);
  assert.equal(await registryOver(idx.fetch, { isEnabled: () => false }).identities([addr(0)]), null, "no registry here: null");
  assert.equal(await registryOver(idx.fetch).identities([]), null, "nothing to ask: null");
  assert.equal(batchCalls(idx.calls).length, 0, "and nothing requested");
}

// MARK: - The pass: one batch, one cache update per answer, one notify; the per-address fallback

/** The sweep's cache and counters over a registry, as kachat-names-live.js wires them. */
function sweepOver(reg) {
  const cache = new Map();
  const answers = new Map();
  const log = { notify: 0, lookedUp: [] };
  const deps = {
    batch: (keys) => reg.identities(keys),
    store: (key, identity) => {
      const changed = (cache.get(key)?.identity?.label ?? null) !== identity.label || cache.get(key)?.failed;
      cache.set(key, { identity, revision: 7, at: t0 });
      return !!changed;
    },
    miss: (key) => cache.set(key, { identity: cache.get(key)?.identity ?? null, revision: 7, at: t0, failed: true }),
    notify: () => { log.notify += 1; },
    lookUp: async (key) => {
      log.lookedUp.push(key);
      const identity = await reg.identity(key);
      cache.set(key, { identity, revision: 7, at: t0 });
      return true;
    },
    answered: (key) => {
      const next = nextUnnamedAnswers(answers.get(key) ?? null, cache.get(key) ?? null);
      if (next == null) answers.delete(key); else answers.set(key, next);
    },
  };
  return { cache, answers, log, deps };
}

{
  // 300 due, one skipped by the indexer: two requests (200 + 100), no GETs, one notify
  const idx = fakeIndexer({ skip: new Set([addr(2)]) });
  const reg = registryOver(idx.fetch);
  const sw = sweepOver(reg);
  sw.answers.set(addr(0), 2);
  sw.answers.set(addr(2), 1);
  const targets = Array.from({ length: 300 }, (_, i) => addr(i));
  assert.equal(await unnamedSweepPass(targets, sw.deps), "batch");
  assert.deepEqual(batchCalls(idx.calls).map((c) => c.body.addresses.length), [200, 100], "everyone due, past the old 40-cap");
  assert.ok(!idx.calls.some((c) => c.path.startsWith("/identity/kaspa")), "no per-address GET");
  assert.equal(sw.log.lookedUp.length, 0);
  assert.equal(sw.log.notify, 1, "one notify for the whole pass");
  // a name came back: forgotten by the backoff; "no name": one more in a row
  assert.equal(sw.answers.has(addr(0)), false);
  assert.equal(sw.cache.get(addr(0)).identity.label, "kasforge");
  assert.equal(sw.answers.get(addr(1)), 1);
  assert.equal(sw.cache.get(addr(1)).identity.label, null);
  // left out: a miss (asked again next pass), its count unchanged
  assert.equal(sw.cache.get(addr(2)).failed, true);
  assert.equal(sw.answers.get(addr(2)), 1);
  assert.equal(unnamedSweepDue(sw.cache.get(addr(2)), 1, 7, t0), true, "a miss is due on the next pass");

  // the same answers again: nothing changed, no notify
  sw.cache.delete(addr(2));
  const again = sweepOver(reg);
  for (const [k, v] of sw.cache) again.cache.set(k, v);
  await unnamedSweepPass(targets.filter((k) => k !== addr(2)), again.deps);
  assert.equal(again.log.notify, 0, "unchanged answers: no notify");
}
for (const [what, extra, batch] of [
  ["an indexer without the endpoint", {}, 404],
  ["the chain walker", { indexerBase: () => "" }, "live"],
]) {
  // no batch: one at a time, most recent first, at most 40 a pass
  const idx = fakeIndexer({ batch });
  const reg = registryOver(idx.fetch, extra);
  // the chain walker's identity() reads the walked names; stub it to the per-address answer
  if (extra.indexerBase) reg.identity = async (a) => ({ address: a, label: null, names: [], profile: null });
  const sw = sweepOver(reg);
  const targets = Array.from({ length: 60 }, (_, i) => addr(i));
  assert.equal(await unnamedSweepPass(targets, sw.deps), "each", what);
  assert.equal(UNNAMED_SWEEP_FALLBACK_MAX, 40);
  assert.deepEqual(sw.log.lookedUp, targets.slice(0, 40), `${what}: the first 40, in order`);
  assert.equal(sw.answers.get(addr(1)), 1, `${what}: the backoff counts per answer`);
  assert.equal(sw.log.notify, 0, `${what}: each lookup tells the listeners itself`);
}
{
  // the fallback: a lookup in flight is skipped, a throw is asked again next minute, hidden stops
  const sw = sweepOver(null);
  const seen = [];
  let visible = true;
  sw.deps.batch = async () => null;
  sw.deps.lookUp = async (key) => {
    seen.push(key);
    if (key === addr(1)) return false;
    if (key === addr(2)) throw new Error("offline");
    if (key === addr(3)) visible = false;
    sw.cache.set(key, { identity: null, revision: 7, at: t0 });
    return true;
  };
  sw.deps.visible = () => visible;
  await unnamedSweepPass([addr(0), addr(1), addr(2), addr(3), addr(4)], sw.deps);
  assert.deepEqual(seen, [addr(0), addr(1), addr(2), addr(3)], "hidden: the pass stops");
  assert.deepEqual([...sw.answers.keys()], [addr(0), addr(3)], "skipped and failed lookups count nothing");
  // a batch that throws counts as none
  sw.deps.batch = async () => { throw new Error("boom"); };
  visible = true;
  assert.equal(await unnamedSweepPass([addr(5)], sw.deps), "each");
  assert.equal(await unnamedSweepPass([], sw.deps), "none");
}

console.log("kachat unnamed sweep: ok");
