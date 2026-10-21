// Quantum-safe spending addresses (KIP-22). Port of iOS bba1b1e ("Quantum-safe addresses
// (KIP-22)") and e001786 (rows say "Address #n"), WalletManager+SpendingAddresses.swift and
// KaChatTransactionBuilder.swift; Android ff70d4c3 ported the same.
//
// Kaspa's KIP-0022 (draft): a P2SH address whose redeem script is `<x-only key> OP_CHECKSIG`,
// derived at m/22'/111111'/0'/0/<n> from the same seed. The chain shows only a hash of the key
// until the address spends, so a quantum attacker reading addresses learns nothing. The chatting
// address is unchanged by design (its key is published for encryption and it spends constantly).
//
// The quantum chain lives in the same index space as the legacy spending chain
// (m/44'/111111'/1'/0/<i>), offset by QUANTUM_INDEX_BASE: public index 1,000,000 + n is quantum
// chain index n. So every place that passes a spending index (send sources, coin control, labels,
// the hidden set, the primary pointer, the address memo) works for both chains unchanged.
//
// The P2SH script and address come from the .kachat registry's own helpers (codec p2pkScript /
// p2shScript, registry-state p2shAddress), the construction the registry spends on chain every day.
// Spending pushes the redeem script after the signature - the KNS reveal's proven P2SH pattern -
// and every estimator prices the bigger input.
//
// Pure value code (no DOM, no WASM): checked by tools/test-quantum-addresses.mjs.

import { schnorr } from "@noble/curves/secp256k1.js";
import { p2pkScript, p2shScript, pushData, concat, hex, unhex } from "./kachat-names/codec.js";
import { p2shAddress } from "./kachat-names/registry-state.js";
import { computeSighash } from "./payment-signatures.js";

/** Public index of quantum chain index 0 (iOS WalletManager.quantumIndexBase). */
export const QUANTUM_INDEX_BASE = 1_000_000;

/** How many quantum slots one step of the restore sweep looks at (iOS quantumScanFloor). The sweep
 *  keeps stepping while a window turns up any activity (iOS da2c8e2, IOS-101: a fixed 200 missed
 *  funds past slot 199), up to QUANTUM_SCAN_LIMIT. */
export const QUANTUM_SCAN_FLOOR = 200;
/** Where the quantum restore sweep stops at the latest (iOS quantumScanLimit). */
export const QUANTUM_SCAN_LIMIT = 10_000;
/** How many used slots verifiedFreshQuantumIndex skips at most before it takes one (iOS: 20). */
export const FRESH_QUANTUM_PROBE_LIMIT = 20;
/** What a quantum-source send says when its fresh change slot can't be prepared (iOS da2c8e2,
 *  IOS-104). */
export const QUANTUM_CHANGE_UNAVAILABLE = "Couldn't prepare the next address. Try again.";
/** The shield's spent-probe reads the history this many transactions a page, at most
 *  QUANTUM_SPENT_PROBE_PAGES pages (iOS da2c8e2, IOS-105: up to 10,000 transactions). */
export const QUANTUM_SPENT_PROBE_PAGE_SIZE = 200;
export const QUANTUM_SPENT_PROBE_PAGES = 50;

/** True for a public spending index on the quantum chain. */
export function isQuantumIndex(index) {
  return Number.isInteger(index) && index >= QUANTUM_INDEX_BASE;
}

/** The quantum chain index of a public index (`index - base`); the legacy index as is. */
export function chainLocalIndex(index) {
  return isQuantumIndex(index) ? index - QUANTUM_INDEX_BASE : index;
}

/** A spending row's name on its own chain, both chains "Address #n" (iOS e001786
 *  SpendingAddressEntry.displayTitle): quantum numbering starts at 0 again, the shield is what tells
 *  the chains apart. */
export function spendingIndexTitle(index) {
  return `Address #${chainLocalIndex(index)}`;
}

/** KIP-22 derivation path of quantum chain index `n`. */
export function quantumDerivationPath(n) {
  const i = Math.max(0, Math.floor(Number(n) || 0));
  return `m/22'/111111'/0'/0/${i}`;
}

/** A plain Schnorr input's signature script: push 65 (64-byte signature + SIGHASH_ALL). */
export const SCHNORR_SIGNATURE_SCRIPT_SIZE = 66;
/** A KIP-22 input's signature script: the usual 66 bytes plus the pushed 34-byte redeem script
 *  (`0x22 <0x20 key OP_CHECKSIG>`), iOS kip22SignatureScriptSize = 66 + 35. */
export const KIP22_SIGNATURE_SCRIPT_SIZE = SCHNORR_SIGNATURE_SCRIPT_SIZE + 35;

/** The KIP-22 redeem script of an x-only key: `0x20 <key> OP_CHECKSIG` (iOS quantumRedeemScript). */
export function quantumRedeemScript(xOnlyKey) {
  const key = typeof xOnlyKey === "string" ? unhex(xOnlyKey) : xOnlyKey;
  if (!(key instanceof Uint8Array) || key.length !== 32) throw new Error("A quantum-safe address needs a 32-byte x-only key.");
  return p2pkScript(key);
}

/** The scriptPublicKey a quantum address pays to: `OP_BLAKE2B <blake2b(redeem)> OP_EQUAL`. */
export function quantumScriptPublicKey(redeemScript) {
  return p2shScript(redeemScript);
}

/** The quantum address of a redeem script (this network's prefix unless `hrp` is given). */
export function quantumAddressForRedeem(redeemScript, hrp = undefined) {
  return p2shAddress(p2shScript(redeemScript), hrp);
}

const scriptBytes = (script) => {
  if (script instanceof Uint8Array) return script;
  const text = typeof script === "string" ? script : (script?.script ?? "");
  try { return unhex(String(text)); } catch { return new Uint8Array(0); }
};

/** True for a P2SH scriptPublicKey (`aa 20 <32> 87`), as bytes, hex or an SDK ScriptPublicKey. */
export function isP2shScript(script) {
  const b = scriptBytes(script);
  return b.length === 35 && b[0] === 0xaa && b[1] === 0x20 && b[34] === 0x87;
}

/**
 * A KIP-22 input's signature script from the SDK's plain one. `createInputSignature` hands back the
 * P2PK signature script `0x41 <64-byte signature> 0x01` (push 65, SIGHASH_ALL), exactly what iOS
 * appends first (`sigScript.append(0x41); append(sig); append(0x01)`); iOS then appends
 * `buildCanonicalPushData(redeemScript)`. Throws on anything else, so a changed SDK answer can never
 * turn into a malformed spend.
 */
export function kip22SignatureScript(schnorrSignatureScript, redeemScript) {
  const sig = typeof schnorrSignatureScript === "string" ? unhex(schnorrSignatureScript) : schnorrSignatureScript;
  if (!(sig instanceof Uint8Array) || sig.length !== SCHNORR_SIGNATURE_SCRIPT_SIZE || sig[0] !== 0x41 || sig[65] !== 0x01) {
    throw new Error("Unexpected signature format for a quantum-safe input.");
  }
  const out = concat(sig, pushData(redeemScript));
  if (redeemScript.length === 34 && out.length !== KIP22_SIGNATURE_SCRIPT_SIZE) throw new Error("Unexpected quantum-safe signature script size.");
  return out;
}

// MARK: - Spending-state bounds (iOS WalletManager maxSpendingAddressIndex / maxQuantumAddressIndex)
//
// Per wallet the app keeps the legacy chain's bound (`maxIndex`, always >= 0), the quantum chain's
// own bound (`qMaxIndex`, -1 before its first slot), the primary pointer (`activeIndex`, a public
// index on either chain), the hidden set and the labels (both keyed by public index), and the
// quantum addresses known to have spent (`qSpent`). The stored record keeps a quantum primary in
// its own field (`qActive`) so a legacy `activeIndex` never holds a base-space value: a quantum
// primary must never widen the legacy chain (iOS: "a quantum primary must never widen the legacy
// chain"), and a build from before this port reading the record still finds a small legacy index.

const wholeOr = (value, fallback) => {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) ? n : fallback;
};

/** The sanitized spending state of a stored record. */
export function spendingStateFromRecord(raw = {}) {
  // A legacy field holding a quantum-space value (>= 1,000,000) never counts toward the legacy
  // chain (iOS 28ecee0): clamping it to 999,999 would make every 0...maxIndex loop derive a million
  // addresses. A primary pointer stored there instead of in qActive is read as the quantum primary.
  const rawActive = Math.max(0, wholeOr(raw.activeIndex, 0));
  const legacyActive = rawActive < QUANTUM_INDEX_BASE ? rawActive : 0;
  const qActive = raw.qActive != null ? Math.max(0, wholeOr(raw.qActive, 0))
    : rawActive >= QUANTUM_INDEX_BASE ? rawActive - QUANTUM_INDEX_BASE : null;
  const activeIndex = qActive == null ? legacyActive : QUANTUM_INDEX_BASE + qActive;
  const rawMax = Math.max(0, wholeOr(raw.maxIndex, 0));
  const maxIndex = Math.max(legacyActive, rawMax < QUANTUM_INDEX_BASE ? rawMax : 0);
  const qMaxIndex = Math.max(qActive ?? -1, Math.max(-1, wholeOr(raw.qMaxIndex, -1)));
  const hidden = Array.isArray(raw.hidden)
    ? Array.from(new Set(raw.hidden.map(Number).filter((n) => Number.isInteger(n) && n >= 0)))
    : [];
  const labels = raw.labels && typeof raw.labels === "object" ? { ...raw.labels } : {};
  const qSpent = Array.isArray(raw.qSpent) ? Array.from(new Set(raw.qSpent.map((a) => String(a || "").toLowerCase()).filter(Boolean))) : [];
  return { activeIndex, maxIndex, qMaxIndex, hidden, labels, qSpent };
}

/** The record to store for a state (the inverse of spendingStateFromRecord). The quantum bound and
 *  spent marks only grow: a revealed slot or a revealed key cannot be unrevealed. */
export function spendingRecordFromState(state, previous = {}) {
  const prev = spendingStateFromRecord(previous);
  const active = wholeOr(state.activeIndex, prev.activeIndex);
  const quantumActive = isQuantumIndex(active);
  const record = {
    ...previous,
    activeIndex: quantumActive ? Math.min(prev.maxIndex, Math.max(0, wholeOr(previous.activeIndex, 0))) : Math.max(0, active),
    qActive: quantumActive ? active - QUANTUM_INDEX_BASE : null,
    maxIndex: Math.min(QUANTUM_INDEX_BASE - 1, Math.max(0, wholeOr(state.maxIndex, prev.maxIndex))),
    qMaxIndex: Math.max(prev.qMaxIndex, wholeOr(state.qMaxIndex, -1), quantumActive ? active - QUANTUM_INDEX_BASE : -1),
    hidden: Array.isArray(state.hidden) ? state.hidden : prev.hidden,
    labels: state.labels && typeof state.labels === "object" ? state.labels : prev.labels,
    qSpent: Array.from(new Set([...prev.qSpent, ...(state.qSpent || []).map((a) => String(a || "").toLowerCase())])).filter(Boolean),
  };
  if (!quantumActive) record.maxIndex = Math.max(record.maxIndex, record.activeIndex);
  if (record.qActive == null) delete record.qActive;
  return record;
}

/** Every revealed public index, legacy chain 0...maxIndex then quantum base...base+qMaxIndex (iOS
 *  allSpendingAddresses covers both chains). */
export function revealedSpendingIndices({ maxIndex = 0, qMaxIndex = -1 } = {}) {
  const out = [];
  for (let i = 0; i <= Math.max(0, maxIndex); i += 1) out.push(i);
  for (let n = 0; n <= qMaxIndex; n += 1) out.push(QUANTUM_INDEX_BASE + n);
  return out;
}

/** One past every quantum slot ever revealed, in public index space (iOS nextFreshQuantumIndex):
 *  where every spend's change goes, and what Generate / Receive / Fresh Address mint. */
export function nextFreshQuantumIndex(qMaxIndex) {
  return QUANTUM_INDEX_BASE + Math.max(-1, wholeOr(qMaxIndex, -1)) + 1;
}

/**
 * Where a spending-address send's change goes (iOS bba1b1e), as a public index, or null for "back to
 * the source":
 * - "withdraw" (Send Kaspa from a spending address, ChatService withdrawFromSpendingAddress): a fresh
 *   quantum slot when the source is quantum (change back would park funds on a revealed key) or the
 *   primary (which rotates as before); a self-send (Compound) consolidates into the address itself.
 * - "payment" (a chat payment or tip From a spending address, sendPaymentInternal): always a fresh
 *   quantum slot.
 * - "kns" (a KNS transfer funded by a spending address, KNSDomainTransferService): the primary only.
 */
export function spendingChangeIndex({ purpose, sourceIndex, primaryIndex, qMaxIndex, selfSend = false }) {
  const fresh = nextFreshQuantumIndex(qMaxIndex);
  if (purpose === "payment") return fresh;
  if (purpose === "kns") return sourceIndex != null && sourceIndex === primaryIndex ? fresh : null;
  if (selfSend || sourceIndex == null) return null;
  return isQuantumIndex(sourceIndex) || sourceIndex === primaryIndex ? fresh : null;
}

/**
 * Whether a send must stop when its fresh change slot can't be derived (iOS da2c8e2, IOS-104): a
 * quantum source's spend reveals its key, so change back to it would park funds on a revealed key -
 * the send throws QUANTUM_CHANGE_UNAVAILABLE instead. Only where the change rule asked for a fresh
 * slot (`freshIndex` from spendingChangeIndex) and only for a chat payment or a Manage Addresses send;
 * a legacy source keeps its fallback to itself, and a KNS transfer is unchanged.
 */
export function freshChangeRequired({ purpose, sourceIndex, freshIndex }) {
  return purpose !== "kns" && freshIndex != null && isQuantumIndex(sourceIndex);
}

/**
 * `nextFreshQuantumIndex`, checked on chain first (iOS da2c8e2 verifiedFreshQuantumIndex, IOS-101):
 * the chain's end on this device can sit below slots used elsewhere (another device, a restore that
 * ran before the sweep looked far enough). While `usedState(address)` says the slot has history it is
 * skipped and the end raised (`raiseBound(qMaxIndex)`), up to `limit` times; a check that can't be
 * answered (null, or a throw) takes the slot as is, so an unreachable server never blocks a send.
 * `addressAt(publicIndex)` derives an address (null when it can't). Returns the public index.
 */
export async function verifiedFreshQuantumIndex({ qMaxIndex, addressAt, usedState, raiseBound = () => {}, onSkip = null, limit = FRESH_QUANTUM_PROBE_LIMIT }) {
  let bound = Math.max(-1, wholeOr(qMaxIndex, -1));
  let index = nextFreshQuantumIndex(bound);
  for (let i = 0; i < limit; i += 1) {
    let address = null;
    try { address = await addressAt(index); } catch { address = null; }
    if (!address) return index;
    let used = null;
    try { used = await usedState(address); } catch { used = null; }
    if (used !== true) return index;
    try { onSkip?.(index); } catch { /* the log line never stops the check */ }
    bound = Math.max(bound, index - QUANTUM_INDEX_BASE);
    await raiseBound(bound);
    index = nextFreshQuantumIndex(bound);
  }
  return index;
}

/**
 * Whether a quantum-safe address has ever SPENT (iOS da2c8e2 quantumAddressSpentState, IOS-105): the
 * whole history, a page at a time, since a spend buried under later activity still revealed the key.
 * `fetchPage(offset, limit)` returns that page of full transactions (inputs carrying
 * `previous_outpoint_address`), or null when it can't be read. true on the first spend found; false
 * when the history ends without one; null when a page can't be read or the history goes deeper than
 * the walk - never "not spent" then.
 */
export async function quantumSpentFromHistory(address, fetchPage, { pageSize = QUANTUM_SPENT_PROBE_PAGE_SIZE, maxPages = QUANTUM_SPENT_PROBE_PAGES } = {}) {
  const lowered = String(address || "").toLowerCase();
  if (!lowered) return null;
  for (let offset = 0; offset < maxPages * pageSize; offset += pageSize) {
    let txs = null;
    try { txs = await fetchPage(offset, pageSize); } catch { txs = null; }
    if (!Array.isArray(txs)) return null;
    const spent = txs.some((tx) => (tx?.inputs || []).some((input) => String(input?.previous_outpoint_address || "").toLowerCase() === lowered));
    if (spent) return true;
    if (txs.length < pageSize) return false;
  }
  // deeper than the walk goes: say so rather than claim the key is hidden
  return null;
}

// MARK: - Mass (iOS KasiaTransactionBuilder.estimateFee, signatureScriptSize)
//
// Fee mass is max(compute mass, normalized transient mass), where post-Toccata transient mass
// normalizes to 2 grams per estimated transaction byte (the same rule ui/kspt.js calculateMass
// ports). Compute mass = size + 10 per output-script byte (incl. its 2-byte version) + 1000 per sig op.

/** `transaction_estimated_serialized_size` of a version-0 transaction shape:
 *  { inputSigScriptLens: number[], outputScriptLens: number[], payloadLength }. */
export function estimatedTxSize({ inputSigScriptLens = [], outputScriptLens = [], payloadLength = 0 }) {
  let size = 2 + 8; // version + input count
  for (const len of inputSigScriptLens) size += 36 + 8 + len + 8; // outpoint, script length, script, sequence
  size += 8; // output count
  for (const len of outputScriptLens) size += 8 + 2 + 8 + len; // value, script version, length, script
  size += 8 + 20 + 8 + 32 + 8 + payloadLength; // lock time, subnetwork, gas, payload hash, payload length, payload
  return BigInt(size);
}

/** Compute mass of a shape (`sigOpCounts` per input, 1 when absent). */
export function txComputeMass(shape) {
  const size = estimatedTxSize(shape);
  let spk = 0n;
  for (const len of shape.outputScriptLens || []) spk += 2n + BigInt(len);
  let sigOps = 0n;
  const counts = shape.sigOpCounts || [];
  for (let i = 0; i < (shape.inputSigScriptLens || []).length; i += 1) sigOps += BigInt(counts[i] ?? 1);
  return size + spk * 10n + sigOps * 1000n;
}

/** Fee mass: max(compute mass, 2 grams per byte). */
export function txFeeMass(shape) {
  const compute = txComputeMass(shape);
  const doubled = estimatedTxSize(shape) * 2n;
  return compute > doubled ? compute : doubled;
}

/** How much more fee mass `quantumInputs` of the shape's inputs cost signed as KIP-22 rather than
 *  as plain Schnorr inputs: what every estimator adds for a quantum source (35 grams an input while
 *  compute mass leads, which it does for every plain transfer). */
export function kip22ExtraFeeMass(shape, quantumInputs) {
  const count = (shape.inputSigScriptLens || []).length;
  const q = Math.max(0, Math.min(count, Number(quantumInputs) || 0));
  if (!q) return 0n;
  const plain = { ...shape, inputSigScriptLens: Array(count).fill(SCHNORR_SIGNATURE_SCRIPT_SIZE) };
  const kip22 = { ...shape, inputSigScriptLens: Array(count).fill(SCHNORR_SIGNATURE_SCRIPT_SIZE).fill(KIP22_SIGNATURE_SCRIPT_SIZE, 0, q) };
  return txFeeMass(kip22) - txFeeMass(plain);
}

/** The shape of an SDK Transaction as it will be once signed: every input with a P2SH UTXO priced
 *  as KIP-22, every other as plain Schnorr. Returns { shape, quantumInputs }. */
export function signedShapeOfSdkTransaction(tx) {
  const inputs = [...(tx?.inputs || [])];
  let quantumInputs = 0;
  const sigOpCounts = [];
  for (const input of inputs) {
    if (isP2shScript(input?.utxo?.scriptPublicKey)) quantumInputs += 1;
    sigOpCounts.push(Number(input?.sigOpCount ?? 1));
  }
  const outputScriptLens = [...(tx?.outputs || [])].map((o) => scriptBytes(o?.scriptPublicKey).length);
  const payloadLength = scriptBytes(tx?.payload ?? "").length;
  return {
    shape: { inputSigScriptLens: Array(inputs.length).fill(SCHNORR_SIGNATURE_SCRIPT_SIZE), outputScriptLens, payloadLength, sigOpCounts },
    quantumInputs,
  };
}

/** Extra fee mass an SDK Transaction's P2SH inputs add over the plain-Schnorr estimate the SDK
 *  priced it with (0 when none are P2SH). */
export function sdkTransactionKip22ExtraMass(tx) {
  const { shape, quantumInputs } = signedShapeOfSdkTransaction(tx);
  return kip22ExtraFeeMass(shape, quantumInputs);
}

/** The compute mass of a SIGNED SDK Transaction, from its real signature scripts (the SDK's own
 *  calculateTransactionMass adds a per-input signature estimate on top, even when signed). */
export function signedSdkTransactionComputeMass(tx) {
  const inputs = [...(tx?.inputs || [])];
  return txComputeMass({
    inputSigScriptLens: inputs.map((i) => scriptBytes(i?.signatureScript ?? "").length),
    outputScriptLens: [...(tx?.outputs || [])].map((o) => scriptBytes(o?.scriptPublicKey).length),
    payloadLength: scriptBytes(tx?.payload ?? "").length,
    sigOpCounts: inputs.map((i) => Number(i?.sigOpCount ?? 1)),
  });
}

// MARK: - Offline check of a signed KIP-22 spend

const bigintOf = (v) => (typeof v === "bigint" ? v : BigInt(v ?? 0));

/** The sighash model (engine/payment-signatures.js computeSighash) of an SDK Transaction. */
export function sighashModelOfSdkTransaction(tx) {
  return {
    version: Number(tx.version ?? 0),
    inputs: [...tx.inputs].map((i) => ({
      txid: unhex(String(i.previousOutpoint.transactionId)),
      index: Number(i.previousOutpoint.index),
      sequence: bigintOf(i.sequence),
      sigOpCount: Number(i.sigOpCount ?? 1),
    })),
    outputs: [...tx.outputs].map((o) => ({
      amount: bigintOf(o.value),
      scriptVersion: Number(o.scriptPublicKey?.version ?? 0),
      script: scriptBytes(o.scriptPublicKey),
      covenant: null,
    })),
    lockTime: bigintOf(tx.lockTime),
    subnetworkId: unhex(String(tx.subnetworkId || "00".repeat(20))),
    gas: bigintOf(tx.gas),
    payload: scriptBytes(tx.payload ?? ""),
  };
}

/**
 * Checks a signed transaction's KIP-22 inputs before anything is submitted: each spends the P2SH of
 * `redeemScript`, carries exactly `<push 65: sig + SIGHASH_ALL> <push redeem>`, and its Schnorr
 * signature verifies under the redeem script's key over the sighash computed independently here -
 * with the spent UTXO's P2SH scriptPublicKey, never the redeem script. Throws on the first mismatch.
 */
export function verifyKip22Spend(tx, redeemScript) {
  const expectedSpk = p2shScript(redeemScript);
  const xOnly = redeemScript.slice(1, 33);
  const tail = pushData(redeemScript);
  const model = sighashModelOfSdkTransaction(tx);
  const inputs = [...tx.inputs];
  inputs.forEach((input, i) => {
    const utxoScript = scriptBytes(input?.utxo?.scriptPublicKey);
    if (hex(utxoScript) !== hex(expectedSpk)) throw new Error(`Input ${i} is not this quantum-safe address's coin.`);
    const sigScript = scriptBytes(input.signatureScript);
    if (sigScript.length !== SCHNORR_SIGNATURE_SCRIPT_SIZE + tail.length || sigScript[0] !== 0x41 || sigScript[65] !== 0x01
      || hex(sigScript.slice(66)) !== hex(tail)) {
      throw new Error(`Input ${i} has a malformed quantum-safe signature script.`);
    }
    const sighash = computeSighash(model, i, utxoScript, bigintOf(input.utxo.amount));
    if (!schnorr.verify(sigScript.slice(1, 65), sighash, xOnly)) throw new Error(`Input ${i}'s quantum-safe signature does not verify.`);
  });
  return true;
}
