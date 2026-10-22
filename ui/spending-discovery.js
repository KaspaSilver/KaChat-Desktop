// Discover Addresses for the spending chain (iOS WalletManager+SpendingAddresses.swift
// discoverSpendingAddresses). Pure: derivation, the activity lookup, balances and names are
// passed in, so the walk itself can be tested without a node, a REST server or the WASM SDK.
//
// An address is worth surfacing when it HOLDS SOMETHING - a balance, or a domain - not when it
// merely has history. The walk always starts at index 0 (an address that was empty last month can
// hold a balance today) and sweeps a floor of SPENDING_DEEP_SCAN_FLOOR indices whatever the gaps,
// so a run of empty addresses can never end the scan early. `POST /addresses/active` answers
// "was this address ever touched" for the whole window in a handful of requests, so balances and
// names are asked only about the touched ones. Where the REST server does not serve that route,
// the batched sweep runs instead: the floor first, then on while matches keep turning up (a gap of
// `gapLimit`), and never past MAX_SPENDING_SCAN_INDEX.

/** Swept whatever the gaps. */
export const SPENDING_DEEP_SCAN_FLOOR = 1000;
/** Hard stop, so the fallback sweep always terminates. */
export const MAX_SPENDING_SCAN_INDEX = 5000;
/** Addresses per bulk UTXO request in the fallback sweep. */
export const SPENDING_SCAN_BATCH_SIZE = 100;
/** Names have no bulk endpoint, so ownership is only probed this far in. */
export const SPENDING_KNS_PROBE_DEPTH = 200;
/** Past the floor, the fallback sweep stops after this many consecutive misses. */
export const SPENDING_DISCOVERY_GAP_LIMIT = 60;
/** iOS AddressActivityService: 250 addresses per request, two requests in flight. */
export const ACTIVITY_BATCH_SIZE = 250;
export const ACTIVITY_CONCURRENCY = 2;
const ACTIVITY_TIMEOUT_MS = 20_000;

/// The subset of `addresses` the chain has ever seen, as a Map of address -> last tx block time
/// (0 when the server gives none). Null when the route is missing or any batch failed: a request
/// that failed is not evidence that its addresses are unused (iOS AddressActivityService).
export async function fetchAddressActivity(addresses, { baseUrl, fetchImpl = globalThis.fetch, timeoutMs = ACTIVITY_TIMEOUT_MS } = {}) {
  const list = [...(addresses || [])];
  if (!list.length) return new Map();
  const base = String(baseUrl || "").replace(/\/+$/, "");
  const batches = [];
  for (let i = 0; i < list.length; i += ACTIVITY_BATCH_SIZE) batches.push(list.slice(i, i + ACTIVITY_BATCH_SIZE));
  const merged = new Map();
  for (let chunk = 0; chunk < batches.length; chunk += ACTIVITY_CONCURRENCY) {
    const results = await Promise.all(batches.slice(chunk, chunk + ACTIVITY_CONCURRENCY)
      .map((batch) => requestActivityBatch(batch, { base, fetchImpl, timeoutMs })));
    if (results.some((result) => result == null)) return null;
    for (const result of results) {
      for (const [address, time] of result) if (!merged.has(address)) merged.set(address, time);
    }
  }
  return merged;
}

async function requestActivityBatch(addresses, { base, fetchImpl, timeoutMs }) {
  try {
    const signal = timeoutMs > 0 && typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(timeoutMs) : undefined;
    const response = await fetchImpl(`${base}/addresses/active`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ addresses }),
      cache: "no-store",
      signal,
    });
    if (!response?.ok) return null;
    const rows = await response.json();
    if (!Array.isArray(rows)) return null;
    const result = new Map();
    for (const row of rows) {
      if (row?.active) result.set(String(row.address), Number(row.lastTxBlockTime) || 0);
    }
    return result;
  } catch {
    return null;
  }
}

/// The walk. Dependencies:
/// - `derive(start, end)` -> Map(index -> address) for start..<end (async allowed; missing = not derivable)
/// - `activity(addresses)` -> Map(address -> time) of touched addresses, or null when unavailable
/// - `fundedAmong(addresses)` -> Set of addresses holding a balance; throws when balances are unavailable
/// - `ownersAmong(addresses)` -> Set of addresses owning a name on any service
/// - `onProgress({ checkingIndex, foundCount })`, optional
/// - `still()`, optional: false once the account the sweep started for is no longer active (iOS
///   2343e84, IOS-107) - checked before every derivation, which reads the CURRENT account's key, so
///   the walk stops there and reports `stopped`
/// Returns { matchCount, lastMatchIndex, matchedIndices, stopped } - every match, not only new ones.
export async function discoverSpendingMatches({ derive, activity, fundedAmong, ownersAmong, onProgress = null, gapLimit = SPENDING_DISCOVERY_GAP_LIMIT, still = null }) {
  let lastMatchIndex = -1;
  let matchCount = 0;
  const matchedIndices = new Set();
  const switched = () => typeof still === "function" && !still();
  const stoppedResult = () => ({ matchCount: 0, lastMatchIndex: -1, matchedIndices: new Set(), stopped: true });
  if (switched()) return stoppedResult();
  const report = (checkingIndex, foundCount) => { try { onProgress?.({ checkingIndex, foundCount }); } catch { /* the readout never stops the scan */ } };
  const owners = async (list) => {
    if (!list.length) return new Set();
    try { return (await ownersAmong(list)) || new Set(); } catch { return new Set(); }
  };

  const derivedWindow = (await derive(0, SPENDING_DEEP_SCAN_FLOOR)) || new Map();
  const orderedWindow = [];
  for (let i = 0; i < SPENDING_DEEP_SCAN_FLOOR; i += 1) {
    const address = derivedWindow.get(i);
    if (address) orderedWindow.push([i, address]);
  }
  report(0, 0);

  let touchedMap = null;
  if (orderedWindow.length) {
    try { touchedMap = await activity(orderedWindow.map(([, address]) => address)); } catch { touchedMap = null; }
  }

  if (orderedWindow.length && touchedMap) {
    const touched = orderedWindow.filter(([, address]) => touchedMap.has(address));
    let funded = new Set();
    if (touched.length) {
      try { funded = (await fundedAmong(touched.map(([, address]) => address))) || new Set(); } catch { funded = new Set(); }
    }
    report(touched.length ? touched[touched.length - 1][0] : 0, funded.size);
    const nameOwners = await owners(touched
      .filter(([i, address]) => i < SPENDING_KNS_PROBE_DEPTH && !funded.has(address))
      .map(([, address]) => address));
    for (const [i, address] of touched) {
      if (!funded.has(address) && !nameOwners.has(address)) continue;
      lastMatchIndex = Math.max(lastMatchIndex, i);
      matchCount += 1;
      matchedIndices.add(i);
    }
  } else {
    // Bulk activity unavailable: the batched sweep.
    let consecutiveMisses = 0;
    let index = 0;
    while (index < MAX_SPENDING_SCAN_INDEX) {
      if (index >= SPENDING_DEEP_SCAN_FLOOR && consecutiveMisses >= gapLimit) break;
      const upper = Math.min(index + SPENDING_SCAN_BATCH_SIZE, MAX_SPENDING_SCAN_INDEX);
      report(index, matchCount);
      if (switched()) return stoppedResult();
      const derived = (await derive(index, upper)) || new Map();
      if (!derived.size) break;
      const batch = [];
      for (let i = index; i < upper; i += 1) {
        const address = derived.get(i);
        if (address) batch.push([i, address]);
      }
      let funded;
      try { funded = (await fundedAmong(batch.map(([, address]) => address))) || new Set(); } catch { break; }
      const nameOwners = await owners(batch
        .filter(([i, address]) => i < SPENDING_KNS_PROBE_DEPTH && !funded.has(address))
        .map(([, address]) => address));
      for (let i = index; i < upper; i += 1) {
        const address = derived.get(i);
        if (!address) continue;
        if (funded.has(address) || nameOwners.has(address)) {
          lastMatchIndex = i;
          matchCount += 1;
          matchedIndices.add(i);
          consecutiveMisses = 0;
        } else {
          consecutiveMisses += 1;
        }
      }
      index = upper;
    }
  }
  if (switched()) return stoppedResult();
  return { matchCount, lastMatchIndex, matchedIndices, stopped: false };
}

/// The stored state after a scan: every match un-hidden (hiding is a tidying choice about empty
/// addresses, it must not outrank a balance), the bound raised to cover the highest match, and the
/// empty indices that raise sweeps in hidden so they do not flood the list. The bound only grows.
export function applySpendingDiscovery({ maxIndex, hidden }, { lastMatchIndex, matchedIndices }) {
  const previousMax = Math.floor(Number(maxIndex) || 0);
  const matched = new Set(matchedIndices || []);
  const next = new Set((hidden || []).map(Number));
  for (const i of matched) next.delete(i);
  if (lastMatchIndex > previousMax) {
    for (let i = previousMax + 1; i < lastMatchIndex; i += 1) if (!matched.has(i)) next.add(i);
  }
  return {
    maxIndex: Math.max(previousMax, lastMatchIndex),
    hidden: [...next].sort((a, b) => a - b),
  };
}

// MARK: - The quantum-safe chain (KIP-22, iOS bba1b1e discoverQuantumAddresses, da2c8e2)
//
// Restores scan both chains. The quantum sweep steps in `floor`-slot windows (QUANTUM_SCAN_FLOOR,
// from quantum index 0 = public QUANTUM_INDEX_BASE) while a window shows any activity, up to `limit`
// (QUANTUM_SCAN_LIMIT) - a fixed 200 missed funds past slot 199 (iOS IOS-101). Activity decides how
// far the chain reaches, funds decide what is shown: the chain's end goes past every slot that EVER
// saw activity, not only funded ones, so a restored wallet never hands out an already-used (possibly
// key-revealed) slot as fresh change or a fresh receive address. Names are never held by a quantum
// (P2SH) address, so there is no ownership probe. Without the bulk activity route only the first
// window's balances can be read, and the sweep stops there.

/// The walk: `derive(start, end)` -> Map(public index -> address); `activity(addresses)` -> Map of
/// touched addresses, or null; `fundedAmong(addresses)` -> Set of funded addresses (throws when
/// balances are unavailable: that window shows nothing). Returns { matchCount, matchedIndices
/// (public indices), highestUsed (quantum chain index of the deepest slot with activity, -1 for none),
/// stopped }. `still()`, optional: the same account rule as the legacy walk (iOS 2343e84, IOS-107),
/// checked before every window - so between windows too - and at the end.
export async function discoverQuantumMatches({ derive, activity, fundedAmong, base, floor, limit = 10_000, still = null }) {
  const matched = new Set();
  let highestUsed = -1;
  const switched = () => typeof still === "function" && !still();
  const stoppedResult = () => ({ matchCount: 0, matchedIndices: new Set(), highestUsed: -1, stopped: true });
  for (let start = 0; start < limit; start += floor) {
    if (switched()) return stoppedResult();
    const derived = (await derive(base + start, base + start + floor)) || new Map();
    const ordered = [];
    for (let i = base + start; i < base + start + floor; i += 1) {
      const address = derived.get(i);
      if (address) ordered.push([i, address]);
    }
    if (!ordered.length) break;
    let touchedMap = null;
    try { touchedMap = await activity(ordered.map(([, address]) => address)); } catch { touchedMap = null; }
    const touched = touchedMap ? ordered.filter(([, address]) => touchedMap.has(address)) : ordered;
    if (touchedMap && touched.length) highestUsed = Math.max(highestUsed, touched[touched.length - 1][0] - base);
    if (touched.length) {
      let funded = null;
      try { funded = (await fundedAmong(touched.map(([, address]) => address))) || new Set(); } catch { funded = null; }
      if (funded) for (const [i, address] of touched) if (funded.has(address)) matched.add(i);
    }
    if (!touchedMap || !touched.length) break;
  }
  if (switched()) return stoppedResult();
  if (matched.size) highestUsed = Math.max(highestUsed, Math.max(...matched) - base);
  return { matchCount: matched.size, matchedIndices: matched, highestUsed, stopped: false };
}

/// The whole Discover Addresses sweep - the legacy chain, then the quantum-safe one - tied to the
/// account it started for (iOS 2343e84 discoverSpendingAddresses / discoverQuantumAddresses(owner:),
/// IOS-107). `still()` (ui/account-guard.js accountGuard(...).still) is re-checked before every
/// write (the legacy bound + hidden set, then the quantum bound + hidden set) and between windows;
/// an account switch mid-sweep stops it, writing nothing more, and it returns 0. `readState()` /
/// `writeState(state)`: that account's stored spending state ({ maxIndex, qMaxIndex, hidden }).
/// Returns { matchCount, stopped }.
export async function runSpendingDiscovery({ still, derive, activity, fundedAmong, ownersAmong, onProgress = null, readState, writeState, base, floor, limit }) {
  const live = () => typeof still === "function" && still() === true;
  const stopped = { matchCount: 0, stopped: true };
  if (!live()) return stopped;
  const legacy = await discoverSpendingMatches({ derive, activity, fundedAmong, ownersAmong, onProgress, still: live });
  if (legacy.stopped || !live()) return stopped;
  writeState(applySpendingDiscovery(readState(), legacy));
  const quantum = await discoverQuantumMatches({ derive, activity, fundedAmong, base, floor, limit, still: live });
  if (quantum.stopped || !live()) return stopped;
  if (quantum.matchCount || quantum.highestUsed >= 0) writeState(applyQuantumDiscovery(readState(), quantum, base));
  return { matchCount: legacy.matchCount + quantum.matchCount, stopped: false };
}

/// The stored state after the quantum scan: matches un-hidden, the quantum bound raised past every
/// used slot (`qMaxIndex` is a quantum chain index, -1 before the first slot), the slots the raise
/// sweeps in hidden unless funded - a used-but-empty slot included. The bound only grows.
export function applyQuantumDiscovery({ qMaxIndex, hidden }, { matchedIndices, highestUsed = -1 }, base) {
  const matched = [...(matchedIndices || [])];
  const next = new Set((hidden || []).map(Number));
  for (const i of matched) next.delete(i);
  const previous = Number.isInteger(qMaxIndex) ? qMaxIndex : -1;
  const highest = Math.max(Number.isInteger(highestUsed) ? highestUsed : -1, matched.length ? Math.max(...matched) - base : -1);
  if (highest > previous) {
    const wanted = new Set(matched);
    for (let n = previous + 1; n <= highest; n += 1) if (!wanted.has(base + n)) next.add(base + n);
  }
  return { qMaxIndex: Math.max(previous, highest), hidden: [...next].sort((a, b) => a - b) };
}
