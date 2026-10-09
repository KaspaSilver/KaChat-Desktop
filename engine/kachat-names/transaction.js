// .kachat names: the version-1 transaction model, its hashes and masses.
//
// Port of iOS KaChat/Services/KachatNames/KachatNamesTransaction.swift (rusty-kaspa a41a333,
// consensus/core/src/tx.rs, hashing/tx.rs, hashing/sighash.rs, mass/mod.rs). Pure functions over
// plain objects:
//
//   Outpoint      { txid: Uint8Array(32), index: number }
//   UtxoEntry     { amount: bigint, scriptVersion: number, script: Uint8Array, blockDaaScore: bigint,
//                   isCoinbase: boolean, covenantId: Uint8Array(32) | null }
//   Utxo          { outpoint: Outpoint, entry: UtxoEntry }
//   CovenantBinding { authorizingInput: number, covenantId: Uint8Array(32) }
//   TxInput       { outpoint, signatureScript: Uint8Array, sequence: bigint, computeBudget: number }
//   TxOutput      { value: bigint, scriptVersion: number, script: Uint8Array, covenant: CovenantBinding | null }
//   Tx            { version: number, inputs: TxInput[], outputs: TxOutput[], lockTime: bigint,
//                   subnetworkId: Uint8Array(20), gas: bigint, payload: Uint8Array, storageMass: bigint }

import {
  Failure, le16, le32, le64, concat, hex, bytesEqual, blake2bKeyed, blake3Keyed, sighashAll, safeFeerate,
} from "./codec.js";

const U64_MAX = 0xffff_ffff_ffff_ffffn;

// MARK: - Model constructors (Swift memberwise inits with their defaults)

/** Outpoint `{ txid, index }` (txid: 32 bytes in hashing order, the hex string as the node writes it). */
export function makeOutpoint(txid, index) { return { txid, index: Number(index) }; }

/** Outpoint equality. */
export function outpointEqual(a, b) { return a.index === b.index && bytesEqual(a.txid, b.txid); }

/** A string key for an outpoint (`<txid hex>:<index>`), for maps and sets. */
export function outpointKey(o) { return `${hex(o.txid)}:${o.index}`; }

/** UtxoEntry with defaults (scriptVersion 0, not coinbase, no covenant id). `covenantId` is the
 *  KIP-20 covenant id the UTXO carries (gaps and names: the registry id). */
export function makeUtxoEntry({ amount, scriptVersion = 0, script, blockDaaScore = 0n, isCoinbase = false, covenantId = null }) {
  return {
    amount: BigInt(amount), scriptVersion: Number(scriptVersion), script, blockDaaScore: BigInt(blockDaaScore),
    isCoinbase: !!isCoinbase, covenantId: covenantId ?? null,
  };
}

/** UtxoEntry equality (every field). */
export function utxoEntryEqual(a, b) {
  return a.amount === b.amount && a.scriptVersion === b.scriptVersion && bytesEqual(a.script, b.script)
    && a.blockDaaScore === b.blockDaaScore && a.isCoinbase === b.isCoinbase && bytesEqual(a.covenantId, b.covenantId);
}

/** Utxo `{ outpoint, entry }`. */
export function makeUtxo(outpoint, entry) { return { outpoint, entry }; }

/** CovenantBinding `{ authorizingInput, covenantId }`. */
export function makeCovenantBinding(authorizingInput, covenantId) {
  return { authorizingInput: Number(authorizingInput), covenantId };
}

/** TxInput. `computeBudget`: version-1 compute budget (1 unit = 10,000 script units; 9,999 free per input). */
export function makeTxInput({ outpoint, signatureScript, sequence = 0n, computeBudget = 0 }) {
  return { outpoint, signatureScript, sequence: BigInt(sequence), computeBudget: Number(computeBudget) };
}

/** TxOutput with defaults (scriptVersion 0, no covenant binding). */
export function makeTxOutput({ value, scriptVersion = 0, script, covenant = null }) {
  return { value: BigInt(value), scriptVersion: Number(scriptVersion), script, covenant: covenant ?? null };
}

/** A version-1 (Toccata) transaction: output covenant bindings, per-input compute budgets,
 *  native subnetwork, no gas, and the KIP-9 storage-mass commitment. */
export function makeTx({ version = 1, inputs, outputs, lockTime = 0n, subnetworkId = new Uint8Array(20), gas = 0n, payload = new Uint8Array(0), storageMass = 0n }) {
  return {
    version, inputs, outputs, lockTime: BigInt(lockTime), subnetworkId, gas: BigInt(gas), payload, storageMass: BigInt(storageMass),
  };
}

/** A copy of a Tx whose inputs can be changed without touching the original. */
export function cloneTx(tx) {
  return { ...tx, inputs: tx.inputs.map((i) => ({ ...i })), outputs: tx.outputs.map((o) => ({ ...o })) };
}

/** True on the native (all-zero) subnetwork. */
export function isNativeSubnetwork(tx) { return tx.subnetworkId.every((b) => b === 0); }

// MARK: Serialization (rusty-kaspa consensus/core/src/hashing/tx.rs `write_transaction`)

function appendOutput(o, parts) {
  parts.push(le64(o.value), le16(o.scriptVersion), le64(o.script.length), o.script);
  parts.push(Uint8Array.of(o.covenant == null ? 0 : 1));
  if (o.covenant != null) {
    parts.push(le16(o.covenant.authorizingInput), o.covenant.covenantId);
  }
}

function write(tx, excludeSignatureScripts, excludeMassCommit, excludePayload) {
  if (!(tx.version >= 1)) throw new Failure("the name core builds version-1 transactions only");
  const parts = [le16(tx.version), le64(tx.inputs.length)];
  for (const i of tx.inputs) {
    parts.push(i.outpoint.txid, le32(i.outpoint.index));
    if (excludeSignatureScripts) {
      parts.push(le64(0));
    } else {
      parts.push(le64(i.signatureScript.length), i.signatureScript);
    }
    parts.push(le64(i.sequence));
    if (!excludeMassCommit) parts.push(le16(i.computeBudget));
  }
  parts.push(le64(tx.outputs.length));
  for (const o of tx.outputs) appendOutput(o, parts);
  parts.push(le64(tx.lockTime), tx.subnetworkId, le64(tx.gas));
  if (excludePayload) {
    parts.push(le64(0));
  } else {
    parts.push(le64(tx.payload.length), tx.payload);
  }
  if (!excludeMassCommit) parts.push(le64(tx.storageMass));
  return concat(...parts);
}

/** The TransactionHash preimage (`write_transaction(tx, FULL)`). */
export function txFullPreimage(tx) { return write(tx, false, false, false); }

/** `transaction_v1_rest_preimage`: no payload, signature scripts or mass commitments. */
export function txRestPreimage(tx) { return write(tx, true, true, true); }

/** The v1 transaction id: `TransactionV1Id(PayloadDigest(payload) || TransactionRest(rest))`. */
export function txId(tx) {
  const d = concat(blake3Keyed("PayloadDigest", tx.payload), blake3Keyed("TransactionRest", txRestPreimage(tx)));
  return blake3Keyed("TransactionV1Id", d);
}

/** `txId` as hex. */
export function txIdHex(tx) { return hex(txId(tx)); }

/** The transaction hash (commits to signature scripts, budgets and the storage mass). */
export function txHash(tx) { return blake2bKeyed("TransactionHash", txFullPreimage(tx)); }

// MARK: Sighash (consensus/core/src/hashing/sighash.rs, SIGHASH_ALL, version >= 1)

/** The Schnorr signature hash of input `index` for SIGHASH_ALL. `entries` are the spent UTXO
 *  entries in input order. Version-1 sighashes cover no sig-op counts and no budgets, and no
 *  signature scripts, so placeholders do not change them. */
export function txSighash(tx, index, entries) {
  const domain = "TransactionSigningHash";
  const prev = [];
  const seqs = [];
  for (const i of tx.inputs) {
    prev.push(i.outpoint.txid, le32(i.outpoint.index));
    seqs.push(le64(i.sequence));
  }
  const outs = [];
  for (const o of tx.outputs) appendOutput(o, outs);
  const payloadHash = isNativeSubnetwork(tx) && tx.payload.length === 0
    ? new Uint8Array(32)
    : blake2bKeyed(domain, concat(le64(tx.payload.length), tx.payload));
  const input = tx.inputs[index];
  const entry = entries[index];
  if (!input || !entry) throw new Failure(`sighash: no input ${index}`);
  const d = concat(
    le16(tx.version),
    blake2bKeyed(domain, concat(...prev)),
    blake2bKeyed(domain, concat(...seqs)),
    input.outpoint.txid,
    le32(input.outpoint.index),
    le16(entry.scriptVersion),
    le64(entry.script.length),
    entry.script,
    le64(entry.amount),
    le64(input.sequence),
    blake2bKeyed(domain, concat(...outs)),
    le64(tx.lockTime),
    tx.subnetworkId,
    le64(tx.gas),
    payloadHash,
    Uint8Array.of(sighashAll),
  );
  return blake2bKeyed(domain, d);
}

// MARK: - Mass (consensus/core/src/mass/mod.rs) and fee

export const massPerTxByte = 1n;
export const massPerScriptPubKeyByte = 10n;
export const gramsPerComputeBudgetUnit = 100n;
export const transientByteToMassFactor = 4n;
/** KIP-9 `C` = SOMPI_PER_KASPA * 10,000. */
export const storageMassParameter = 1_000_000_000_000n;
/** Mempool block mass limits after Toccata (compute 500,000, transient 1,000,000):
 *  normalized transient = transient * 500,000 / 1,000,000. */
export const transientCofactor = 500_000.0 / 1_000_000.0;

/** `transaction_estimated_serialized_size`. */
export function massSize(tx) {
  let size = 2n + 8n;
  for (const i of tx.inputs) {
    size += 32n + 4n + 8n + BigInt(i.signatureScript.length) + 8n;
    if (tx.version >= 1) size += 2n;
  }
  size += 8n;
  for (const o of tx.outputs) {
    size += 8n + 2n + 8n + BigInt(o.script.length);
    if (o.covenant != null) size += 2n + 32n;
  }
  size += 8n + 20n + 8n + 32n + 8n + BigInt(tx.payload.length);
  return size;
}

/** Compute mass: size + 10 per script-public-key byte + 100 grams per compute-budget unit. */
export function computeMass(tx) {
  let spkBytes = 0n;
  for (const o of tx.outputs) spkBytes += 2n + BigInt(o.script.length);
  let budgets = 0n;
  for (const i of tx.inputs) budgets += BigInt(i.computeBudget);
  return massSize(tx) * massPerTxByte + spkBytes * massPerScriptPubKeyByte + gramsPerComputeBudgetUnit * budgets;
}

/** Transient mass: size * 4. */
export function transientMass(tx) { return massSize(tx) * transientByteToMassFactor; }

/** ceil(transient * 500,000 / 1,000,000), computed in doubles as Swift does. */
export function normalizedTransient(tx) {
  return BigInt(Math.ceil(Number(transientMass(tx)) * transientCofactor));
}

/** `utxo_plurality`: 100-byte storage units of a UTXO. */
export function utxoPlurality(scriptLength, hasCovenant) {
  const bytes = 63 + scriptLength + (hasCovenant ? 32 : 0);
  return BigInt(Math.floor((bytes + 99) / 100));
}

/** KIP-9 storage mass (`calc_storage_mass`), null when incomputable (too high). `entries` are the
 *  spent UTXO entries in input order. UInt64 overflow is reproduced (null or saturation, as Swift). */
export function storageMass(tx, entries) {
  const c = storageMassParameter;
  let outsPlurality = 0n;
  let harmonicOuts = 0n;
  for (const o of tx.outputs) {
    const p = utxoPlurality(o.script.length, o.covenant != null);
    if (!(o.value > 0n)) return null;
    outsPlurality += p;
    const cp = c * p;
    const cpp = cp * p;
    if (cp > U64_MAX || cpp > U64_MAX) return null;
    const sum = harmonicOuts + cpp / o.value;
    if (sum > U64_MAX) return null;
    harmonicOuts = sum;
  }
  const ins = entries.map((e) => ({ p: utxoPlurality(e.script.length, e.covenantId != null), amount: e.amount }));
  let relaxed;
  if (outsPlurality === 1n) {
    relaxed = true;
  } else if (ins.length > 2) {
    relaxed = false;
  } else {
    const insPlurality = ins.reduce((a, i) => a + i.p, 0n);
    relaxed = insPlurality === 1n || (outsPlurality === 2n && insPlurality === 2n);
  }
  if (relaxed) {
    let harmonicIns = 0n;
    for (const i of ins) {
      if (!(i.amount > 0n)) return null;
      const term = c * i.p * i.p / i.amount;
      const s = harmonicIns + term;
      harmonicIns = s > U64_MAX ? U64_MAX : s;
    }
    return harmonicOuts > harmonicIns ? harmonicOuts - harmonicIns : 0n;
  }
  const insPlurality = ins.reduce((a, i) => a + i.p, 0n);
  const sumIns = ins.reduce((a, i) => a + i.amount, 0n);
  if (insPlurality === 0n) throw new Failure("storage mass: no inputs");
  let meanIns = sumIns / insPlurality;
  if (meanIns < 1n) meanIns = 1n;
  const arith = insPlurality * (c / meanIns);
  const arithmeticIns = arith > U64_MAX ? U64_MAX : arith;
  return harmonicOuts > arithmeticIns ? harmonicOuts - arithmeticIns : 0n;
}

/** The relay fee the CLI pays: ceil(max(compute, normalized transient) * feerate). `feerate` is a
 *  Number (sompi per gram), made safe first (`safeFeerate`: within [minFeerate, maxFeerate], never
 *  NaN or infinite), so the product is always a small finite number - `BigInt()` never sees NaN or
 *  infinity (iOS 7e2b6cd, IOS-061). */
export function networkFee(tx, feerate) {
  const c = computeMass(tx);
  const n = normalizedTransient(tx);
  const feeMass = c > n ? c : n;
  const fee = Math.ceil(Number(feeMass) * safeFeerate(feerate));
  if (!Number.isFinite(fee) || fee < 0 || fee >= 9.0e18) return 9_000_000_000_000_000_000n;
  return BigInt(fee);
}
