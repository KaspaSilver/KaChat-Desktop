// Discover Addresses for the spending chain (iOS discoverSpendingAddresses): the bulk-activity
// walk, the batched fallback sweep, and how the result lands in the stored state.
import assert from "node:assert/strict";
import {
  discoverSpendingMatches, applySpendingDiscovery, fetchAddressActivity,
  SPENDING_DEEP_SCAN_FLOOR, MAX_SPENDING_SCAN_INDEX,
} from "../ui/spending-discovery.js";

const addr = (i) => `kaspa:addr${i}`;
const indexOf = (address) => Number(address.slice("kaspa:addr".length));
const derive = async (start, end) => {
  const map = new Map();
  for (let i = start; i < end; i += 1) map.set(i, addr(i));
  return map;
};

// --- Bulk path: only touched addresses are asked about; funded or name-owning ones match. ---
{
  const touched = new Set([3, 291, 150, 700]);
  const fundedSet = new Set([291, 700]);
  const named = new Set([3, 150]); // 150 < 200 probe depth, 3 too
  const asked = { funded: [], names: [] };
  const progress = [];
  const result = await discoverSpendingMatches({
    derive,
    activity: async (list) => {
      assert.equal(list.length, SPENDING_DEEP_SCAN_FLOOR);
      return new Map(list.filter((a) => touched.has(indexOf(a))).map((a) => [a, 1]));
    },
    fundedAmong: async (list) => { asked.funded.push(...list); return new Set(list.filter((a) => fundedSet.has(indexOf(a)))); },
    ownersAmong: async (list) => { asked.names.push(...list); return new Set(list.filter((a) => named.has(indexOf(a)))); },
    onProgress: (p) => progress.push(p),
  });
  assert.deepEqual(asked.funded.map(indexOf).sort((a, b) => a - b), [3, 150, 291, 700]);
  // names only for touched, unfunded, under the probe depth
  assert.deepEqual(asked.names.map(indexOf).sort((a, b) => a - b), [3, 150]);
  assert.equal(result.matchCount, 4);
  assert.equal(result.lastMatchIndex, 700);
  assert.deepEqual([...result.matchedIndices].sort((a, b) => a - b), [3, 150, 291, 700]);
  assert.deepEqual(progress[0], { checkingIndex: 0, foundCount: 0 });
  assert.deepEqual(progress[1], { checkingIndex: 700, foundCount: 2 });
}

// --- Bulk path: a touched-but-emptied address is not a match; nothing touched finds nothing. ---
{
  const result = await discoverSpendingMatches({
    derive,
    activity: async () => new Map([[addr(5), 1]]),
    fundedAmong: async () => new Set(),
    ownersAmong: async () => new Set(),
  });
  assert.equal(result.matchCount, 0);
  assert.equal(result.lastMatchIndex, -1);
}

// --- Fallback: activity unavailable -> batched sweep of the floor, then on while it keeps finding. ---
{
  const fundedSet = new Set([12, 990, 1040]);
  let fundedCalls = 0;
  const result = await discoverSpendingMatches({
    derive,
    activity: async () => null,
    fundedAmong: async (list) => { fundedCalls += 1; return new Set(list.filter((a) => fundedSet.has(indexOf(a)))); },
    ownersAmong: async (list) => new Set(list.filter((a) => indexOf(a) === 199)),
    gapLimit: 60,
  });
  assert.deepEqual([...result.matchedIndices].sort((a, b) => a - b), [12, 199, 990, 1040]);
  assert.equal(result.matchCount, 4);
  assert.equal(result.lastMatchIndex, 1040);
  // floor (10 batches) + 1000-1099 (match at 1040) + 1100-1199 (misses reach 60+) -> stop
  assert.equal(fundedCalls, 12);
}

// --- Fallback: a balances failure stops the sweep; it never runs past the hard stop. ---
{
  let calls = 0;
  const result = await discoverSpendingMatches({
    derive,
    activity: async () => null,
    fundedAmong: async () => { calls += 1; if (calls === 3) throw new Error("node down"); return new Set(); },
    ownersAmong: async () => new Set(),
  });
  assert.equal(calls, 3);
  assert.equal(result.matchCount, 0);
}
{
  let maxSeen = 0;
  await discoverSpendingMatches({
    derive: async (start, end) => { maxSeen = Math.max(maxSeen, end); return derive(start, end); },
    activity: async () => null,
    fundedAmong: async (list) => new Set(list), // everything funded: the gap never opens
    ownersAmong: async () => new Set(),
  });
  assert.equal(maxSeen, MAX_SPENDING_SCAN_INDEX);
}

// --- Applying the result: matches un-hidden, the new range's empties hidden, bound only grows. ---
assert.deepEqual(
  applySpendingDiscovery({ maxIndex: 2, hidden: [1] }, { lastMatchIndex: 6, matchedIndices: new Set([1, 4, 6]) }),
  { maxIndex: 6, hidden: [3, 5] },
);
assert.deepEqual(
  applySpendingDiscovery({ maxIndex: 10, hidden: [2, 7] }, { lastMatchIndex: 7, matchedIndices: new Set([7]) }),
  { maxIndex: 10, hidden: [2] },
);
assert.deepEqual(
  applySpendingDiscovery({ maxIndex: 4, hidden: [] }, { lastMatchIndex: -1, matchedIndices: new Set() }),
  { maxIndex: 4, hidden: [] },
);

// --- The bulk activity request: 250 per request, null if any batch fails. ---
{
  const bodies = [];
  const ok = async (url, init) => {
    assert.equal(url, "https://api.example/addresses/active");
    assert.equal(init.method, "POST");
    const { addresses } = JSON.parse(init.body);
    bodies.push(addresses.length);
    return { ok: true, json: async () => addresses.map((a, i) => ({ address: a, active: i % 2 === 0, lastTxBlockTime: i % 4 === 0 ? 77 : null })) };
  };
  const list = Array.from({ length: 600 }, (_, i) => addr(i));
  const map = await fetchAddressActivity(list, { baseUrl: "https://api.example/", fetchImpl: ok, timeoutMs: 0 });
  assert.deepEqual(bodies, [250, 250, 100]);
  assert.equal(map.size, 300);
  assert.equal(map.get(addr(0)), 77);
  assert.equal(map.get(addr(2)), 0);
  assert.equal(map.has(addr(1)), false);

  let n = 0;
  const flaky = async (url, init) => { n += 1; if (n === 2) return { ok: false, json: async () => [] }; return ok(url, init); };
  assert.equal(await fetchAddressActivity(list, { baseUrl: "https://api.example", fetchImpl: flaky, timeoutMs: 0 }), null);
  assert.deepEqual(await fetchAddressActivity([], { baseUrl: "x", fetchImpl: ok }), new Map());
}

console.log("spending discovery ok");
