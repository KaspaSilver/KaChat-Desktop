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

import { verifiedFreshQuantumIndex, isQuantumIndex, chainLocalIndex } from "../engine/quantum.js";

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

// MARK: - The account a spending task belongs to (iOS e571f45 SpendingSweepAccount, IOS-107; 6891935 /
// fb2323e verifiedFreshQuantumSlot, IOS-109)
//
// The Discover sweep and the fresh quantum slot probe await the network between derivations, and the
// person can switch accounts meanwhile. Each takes its account when it starts - the wallet address
// and the seed material both chains derive from - and derives every address from THAT, whichever
// account is active by the time an await returns. The secrets stay in memory on this object only:
// never stored, never logged (they are not enumerable, and JSON.stringify gives the owner alone).

/// The captured account, or null when `record` (a saved-account record) has no readable recovery
/// phrase. `owner` defaults to the record's address; `passphraseForm` is the record's form
/// (engine/wallet.js passphraseFormForRecord, "nfkd" or "raw").
export function captureSpendingAccount(record, { owner = record?.address, passphraseForm = "nfkd" } = {}) {
  const wallet = String(owner || "").trim();
  const mnemonic = String(record?.mnemonic || "");
  if (!wallet || !mnemonic || record?.locked) return null;
  const account = {};
  Object.defineProperties(account, {
    owner: { value: wallet, enumerable: true },
    mnemonic: { value: mnemonic, enumerable: false },
    passphrase: { value: String(record?.passphrase || ""), enumerable: false },
    passphraseForm: { value: passphraseForm === "raw" ? "raw" : "nfkd", enumerable: false },
    toJSON: { value: () => ({ owner: wallet }), enumerable: false },
  });
  return Object.freeze(account);
}

/// One spending address (either chain: a public index from QUANTUM_INDEX_BASE up is the quantum one)
/// of the captured `account`, through `memo` keyed by that account ("owner:index"). Null when it
/// can't be derived. `log` gets the index only, never the seed.
export function deriveSpendingAddressForAccount(engine, account, index, { memo = null, log = null } = {}) {
  if (!account?.owner || !account.mnemonic || !engine?.kaspa) return null;
  const key = `${account.owner}:${index}`;
  const cached = memo?.get(key);
  if (cached) return cached;
  try {
    const address = engine.deriveSpendingWallet(account.mnemonic, index, account.passphrase, { passphraseForm: account.passphraseForm })?.address || null;
    if (address) memo?.set(key, address);
    return address;
  } catch (error) {
    try { log?.(`Spending derive #${index} failed: ${error?.message || error}`); } catch { /* the log never stops a derive */ }
    return null;
  }
}

/// The captured account's spending addresses start..<end as a Map(index -> address): memo first, the
/// misses through ONE seed derivation per chunk of 100 (iOS spendingAddresses(inRange:) /
/// sweepAddresses(inRange:account:)), pausing between chunks so a thousand-address window doesn't
/// freeze the page.
export async function deriveSpendingAddressesForAccount(engine, account, start, end, { memo = null, log = null, pause = () => new Promise((resolve) => setTimeout(resolve, 0)) } = {}) {
  const result = new Map();
  if (!account?.owner || !account.mnemonic || !engine?.kaspa) return result;
  const prefix = `${account.owner}:`;
  for (let base = start; base < end; base += 100) {
    const upper = Math.min(base + 100, end);
    let missing = false;
    for (let i = base; i < upper; i += 1) {
      const cached = memo?.get(`${prefix}${i}`);
      if (cached) result.set(i, cached); else missing = true;
    }
    if (!missing) continue;
    try {
      const derived = engine.deriveSpendingAddressRange(account.mnemonic, base, upper - base, account.passphrase, { passphraseForm: account.passphraseForm });
      for (const { index, address } of derived || []) {
        if (!address) continue;
        memo?.set(`${prefix}${index}`, address);
        result.set(index, address);
      }
    } catch (error) {
      try { log?.(`Spending derive #${base}-#${upper - 1} failed: ${error?.message || error}`); } catch { /* never stops the walk */ }
    }
    await pause?.();
  }
  return result;
}

/// The fresh quantum slot probe for a captured account (iOS 6891935 verifiedFreshQuantumIndex(owner:
/// chainKey:) and fb2323e verifiedFreshQuantumSlot, IOS-109, the sweep's rule from IOS-107): the
/// slots are derived from THAT account's seed (`deriveAt(account, publicIndex)`), and a used slot
/// raises THAT account's quantum chain end (`readQMaxIndex()` / `writeQMaxIndex(qMaxIndex)`, its
/// stored state), even if another account is active when a probe returns. Once `stillSaved()` is
/// false (the account was removed) nothing more is written and the probe ends past the used slot.
/// `usedState(address)` as engine/quantum.js verifiedFreshQuantumIndex. Returns { index, address }:
/// the slot and its address from the same account; `address` is null when it can't be derived.
export async function probeFreshQuantumSlot({ account, deriveAt, readQMaxIndex, writeQMaxIndex, usedState, stillSaved, onSkip = null }) {
  const index = await verifiedFreshQuantumIndex({
    qMaxIndex: readQMaxIndex(),
    addressAt: (publicIndex) => deriveAt(account, publicIndex),
    usedState,
    raiseBound: (qMaxIndex) => {
      if (!stillSaved()) return false;
      // the bound only grows
      writeQMaxIndex(Math.max(readQMaxIndex(), qMaxIndex));
      return true;
    },
    onSkip,
  });
  let address = null;
  try { address = deriveAt(account, index) || null; } catch { address = null; }
  return { index, address };
}

/// The Receive QR's fresh address (iOS freshReceiveAddress, quantum-safe since bba1b1e) for `owner`,
/// the account active when it was asked (iOS fb2323e, IOS-109): an answer that comes back after a
/// switch belongs to the other account and is dropped - null, nothing remembered or revealed.
///   1. the pointer from last time (`rememberedIndex`), while it is still `untouched(address)` and on
///      the quantum chain;
///   2. `lowestUnusedIndex()` (a hidden unused quantum slot, else a probed brand-new one; null when
///      no slot can be derived, which falls back like an underivable one).
/// `deriveAt(index)`, `fallbackAddress()` (no derivable slot: the primary), `remember(index)` (the
/// pointer for next time) and `reveal(index)` (onto the Manage Addresses list) are the caller's.
export async function chooseReceiveAddress({ owner, activeAddress, rememberedIndex, deriveAt, untouched, lowestUnusedIndex, fallbackAddress, remember, reveal }) {
  const switched = () => String(activeAddress() || "") !== String(owner || "") || !owner;
  if (switched()) return null;
  if (isQuantumIndex(rememberedIndex)) {
    const address = deriveAt(rememberedIndex);
    if (await untouched(address)) {
      if (switched()) return null;
      reveal(rememberedIndex);
      return address;
    }
  }
  const index = await lowestUnusedIndex();
  if (switched()) return null;
  const address = Number.isInteger(index) ? deriveAt(index) : null;
  if (!address) return fallbackAddress();
  remember(index);
  reveal(index);
  return address;
}

// MARK: - Writes after a send (iOS ca09dd0 revealSpendingAddress(at:owner:),
// setActiveSpendingAddress(_:owner:), markQuantumAddressSpent(_:owner:); IOS-109, last part)
//
// A send takes a second or more, and the person can switch accounts before the node answers. What
// the app saves once it has - the change slot revealed, the primary moved onto it, a quantum
// address marked spent - belongs to the account the send STARTED on (`owner`, taken at its start):
// that account's stored state gets the write even if another account is active by then, and once
// it has been removed (or its keys locked) nothing is written. The on-screen refresh (`notify`, the
// "primary changed" repaint) runs only while `owner` is the active account. An empty `owner` means
// the active account. `io`: { activeAddress(), stillSaved(owner), readState(owner),
// writeState(patch, owner) }, readState giving engine/quantum.js spendingStateFromRecord's shape.

/// Where a post-send write goes: { owner, active } (active: `owner` is the active account), or null
/// when there is no account or it was removed.
export function postSendTarget(owner, { activeAddress, stillSaved }) {
  const active = String((typeof activeAddress === "function" ? activeAddress() : "") || "").trim();
  const target = String(owner || "").trim() || active;
  if (!target || !stillSaved(target)) return null;
  return { owner: target, active: target === active };
}

/** The bound patch that reveals `index` on its own chain of `state` (a quantum index extends
 *  qMaxIndex; the legacy bound never sees quantum-space values). Bounds only grow. */
export function spendingBoundPatch(index, state) {
  if (isQuantumIndex(index)) return { qMaxIndex: Math.max(state.qMaxIndex, chainLocalIndex(index)) };
  return { maxIndex: Math.max(state.maxIndex, index) };
}

/// A send's change slot onto `owner`'s list (iOS revealSpendingAddress(at:owner:)): its chain's
/// bound raised to cover it. Returns the target, or null when nothing was written.
export function revealSpendingIndexFor(index, owner, io, notify = null) {
  if (!Number.isInteger(index) || index < 0) return null;
  const target = postSendTarget(owner, io);
  if (!target) return null;
  io.writeState(spendingBoundPatch(index, io.readState(target.owner)), target.owner);
  if (target.active) { try { notify?.(); } catch { /* repaints on the next open */ } }
  return target;
}

/// `owner`'s primary moved onto `index`, its chain's bound raised to cover it (iOS
/// setActiveSpendingAddress(_:owner:)). Another account's primary moves without the on-screen notice.
export function setPrimarySpendingIndexFor(index, owner, io, notify = null) {
  if (!Number.isInteger(index) || index < 0) return null;
  const target = postSendTarget(owner, io);
  if (!target) return null;
  io.writeState({ activeIndex: index, ...spendingBoundPatch(index, io.readState(target.owner)) }, target.owner);
  if (target.active) { try { notify?.(); } catch { /* repaints on the next open */ } }
  return target;
}

/// A quantum address `owner` spent from, marked for good (iOS markQuantumAddressSpent(_:owner:)):
/// the spend put its key on chain. Returns the target, or null when nothing was written (no address,
/// a removed owner).
export function markQuantumSpentFor(address, owner, io, notify = null) {
  const lowered = String(address || "").trim().toLowerCase();
  if (!lowered) return null;
  const target = postSendTarget(owner, io);
  if (!target) return null;
  const spent = io.readState(target.owner).qSpent || [];
  if (!spent.includes(lowered)) io.writeState({ qSpent: [...spent, lowered] }, target.owner);
  if (target.active) { try { notify?.(); } catch { /* repaints on the next open */ } }
  return target;
}

/// The walk. Dependencies:
/// - `derive(start, end)` -> Map(index -> address) for start..<end (async allowed; missing = not derivable)
/// - `activity(addresses)` -> Map(address -> time) of touched addresses, or null when unavailable
/// - `fundedAmong(addresses)` -> Set of addresses holding a balance; throws when balances are unavailable
/// - `ownersAmong(addresses)` -> Set of addresses owning a name on any service
/// - `onProgress({ checkingIndex, foundCount })`, optional
/// - `still()`, optional: false once the account the sweep started for was removed from the device
///   (iOS e571f45 sweepAccountStillSaved, IOS-107; a mere switch is not a reason - `derive` reads the
///   captured account's seed) - checked at the start, before every fallback batch and at the end, and
///   the walk then reports `stopped`
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
/// stopped }. `still()`, optional: the same account rule as the legacy walk (iOS e571f45, IOS-107:
/// false once the account was removed), checked before every window - so between windows too - and
/// at the end.
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

/// The whole Discover Addresses sweep - the legacy chain, then the quantum-safe one - for the
/// account it started for (iOS e571f45 discoverSpendingAddresses / discoverQuantumAddresses(account:),
/// IOS-107, the owner's Go Fix choice). The caller captures that account at the start
/// (captureSpendingAccount): `derive` derives from ITS seed, and `readState()` / `writeState(state)`
/// read and write ITS stored spending state ({ maxIndex, qMaxIndex, hidden }), even if another
/// account is active by the time an await returns. `stillSaved()` (ui/account-guard.js
/// accountStillSaved) is false once that account was removed from the device: re-checked between
/// fallback batches and quantum windows and before each write (the legacy bound + hidden set, then
/// the quantum bound + hidden set), so a removed account gets nothing more written. As on iOS, a
/// removal after the legacy write keeps that write and its count (the quantum part adds 0).
/// Returns { matchCount, removed }.
export async function runSpendingDiscovery({ stillSaved, derive, activity, fundedAmong, ownersAmong, onProgress = null, readState, writeState, base, floor, limit }) {
  const saved = () => typeof stillSaved === "function" && stillSaved() === true;
  if (!saved()) return { matchCount: 0, removed: true };
  const legacy = await discoverSpendingMatches({ derive, activity, fundedAmong, ownersAmong, onProgress, still: saved });
  if (legacy.stopped || !saved()) return { matchCount: 0, removed: true };
  writeState(applySpendingDiscovery(readState(), legacy));
  const quantum = await discoverQuantumMatches({ derive, activity, fundedAmong, base, floor, limit, still: saved });
  if (quantum.stopped || !saved()) return { matchCount: legacy.matchCount, removed: true };
  if (quantum.matchCount || quantum.highestUsed >= 0) writeState(applyQuantumDiscovery(readState(), quantum, base));
  return { matchCount: legacy.matchCount + quantum.matchCount, removed: false };
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
