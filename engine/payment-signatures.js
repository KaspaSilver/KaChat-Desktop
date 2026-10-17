// Received-payment signature check (iOS KasiaTransactionBuilder.verifyTransactionSignatures +
// computeSighash, ChatService.verifyIncomingPaymentSignatures).
//
// Payments read from the Kaspa REST API are only as honest as that API. Before one is shown, every
// standard Schnorr P2PK input's signature is checked against the transaction as the REST answer
// describes it, so an API (or anything between it and us) cannot invent a payment. Versions 0
// and 1 (rusty-kaspa consensus/core/src/hashing/sighash.rs, calc_schnorr_signature_hash): from
// version 1 the sig-op counts are left out, and each output adds whether it carries a covenant,
// then its authorizing input (u16) and covenant id (32 bytes) when it does.
//
// The answer is "valid", "invalid" (a signature is definitively wrong: drop the payment) or
// "unknown" (an input's spent output is not resolved, or the data is incomplete: hold it and ask
// again later - never show it unverified, never drop it on the first miss).
import { blake2b } from "@noble/hashes/blake2.js";
import { schnorr } from "@noble/curves/secp256k1.js";
import { decodeAddress, AddressVersion } from "./kachat-names/registry-state.js";
import { makeTx, makeTxInput, makeTxOutput, makeCovenantBinding, makeOutpoint, txIdHex } from "./kachat-names/transaction.js";

const SIGHASH_KEY = new TextEncoder().encode("TransactionSigningHash");
const hashKeyed = (bytes) => blake2b(bytes, { dkLen: 32, key: SIGHASH_KEY });

function hexToBytes(hex) {
  const clean = String(hex ?? "").trim();
  if (clean.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(clean)) return null;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

class Writer {
  constructor() { this.parts = []; this.length = 0; }
  bytes(b) { this.parts.push(b); this.length += b.length; return this; }
  u8(n) { return this.bytes(Uint8Array.of(n & 0xff)); }
  u16(n) { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, Number(n), true); return this.bytes(b); }
  u32(n) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, Number(n), true); return this.bytes(b); }
  u64(n) { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n), true); return this.bytes(b); }
  done() {
    const out = new Uint8Array(this.length);
    let at = 0;
    for (const p of this.parts) { out.set(p, at); at += p.length; }
    return out;
  }
}

/** The script a Schnorr/ECDSA P2PK or P2SH address pays to (iOS KaspaAddress.scriptPublicKey). */
export function scriptPublicKeyFromAddress(address) {
  const decoded = decodeAddress(String(address ?? "").toLowerCase());
  if (!decoded) return null;
  const key = decoded.payload;
  if (decoded.version === AddressVersion.pubKey && key.length === 32) return Uint8Array.of(0x20, ...key, 0xac);
  if (decoded.version === AddressVersion.pubKeyECDSA && key.length === 33) return Uint8Array.of(0x21, ...key, 0xab);
  if (decoded.version === AddressVersion.scriptHash && key.length === 32) return Uint8Array.of(0xaa, 0x20, ...key, 0x87);
  return null;
}

/**
 * The SIGHASH_ALL signature hash of input `inputIndex` (iOS computeSighash).
 * tx: { version, inputs: [{ txid, index, sequence, sigOpCount }], outputs: [{ amount, scriptVersion,
 * script: Uint8Array, covenant: { authorizingInput, id: Uint8Array } | null }], lockTime,
 * subnetworkId: Uint8Array(20), gas, payload: Uint8Array }.
 */
export function computeSighash(tx, inputIndex, utxoScript, utxoAmount) {
  const isV1 = Number(tx.version) >= 1;
  const w = new Writer();
  w.u16(tx.version);

  const prev = new Writer();
  for (const input of tx.inputs) prev.bytes(input.txid).u32(input.index);
  w.bytes(hashKeyed(prev.done()));

  const seqs = new Writer();
  for (const input of tx.inputs) seqs.u64(input.sequence);
  w.bytes(hashKeyed(seqs.done()));

  if (!isV1) {
    const sigOps = new Writer();
    for (const input of tx.inputs) sigOps.u8(input.sigOpCount);
    w.bytes(hashKeyed(sigOps.done()));
  }

  const input = tx.inputs[inputIndex];
  w.bytes(input.txid).u32(input.index);
  w.u16(0).u64(utxoScript.length).bytes(utxoScript);
  w.u64(utxoAmount);
  w.u64(input.sequence);
  if (!isV1) w.u8(input.sigOpCount);

  const outs = new Writer();
  for (const output of tx.outputs) {
    outs.u64(output.amount).u16(output.scriptVersion || 0).u64(output.script.length).bytes(output.script);
    if (isV1) {
      if (output.covenant) outs.u8(1).u16(output.covenant.authorizingInput).bytes(output.covenant.id);
      else outs.u8(0);
    }
  }
  w.bytes(hashKeyed(outs.done()));

  w.u64(tx.lockTime);
  w.bytes(tx.subnetworkId);
  w.u64(tx.gas);
  const native = tx.subnetworkId.every((b) => b === 0);
  if (native && tx.payload.length === 0) w.bytes(new Uint8Array(32));
  else w.bytes(hashKeyed(new Writer().u64(tx.payload.length).bytes(tx.payload).done()));
  w.u8(0x01); // SIGHASH_ALL
  return hashKeyed(w.done());
}

/// The id the transaction would have if the REST fields were the whole transaction (v0: keyed
/// BLAKE2b "TransactionID" without signature scripts; v1: the name core's TransactionV1Id). The
/// REST API does not carry every field - sequence and lock time come back missing - so for a
/// transaction that set one, the fields it does carry are not the transaction that was signed.
function restModelTxIdHex(model) {
  if (model.version >= 1) {
    const tx = makeTx({
      version: model.version,
      inputs: model.inputs.map((i) => makeTxInput({ outpoint: makeOutpoint(i.txid, i.index), signatureScript: new Uint8Array(0), sequence: i.sequence })),
      outputs: model.outputs.map((o) => makeTxOutput({ value: o.amount, scriptVersion: o.scriptVersion, script: o.script, covenant: o.covenant ? makeCovenantBinding(o.covenant.authorizingInput, o.covenant.id) : null })),
      lockTime: model.lockTime, subnetworkId: model.subnetworkId, gas: model.gas, payload: model.payload,
    });
    return txIdHex(tx);
  }
  const w = new Writer().u16(model.version).u64(model.inputs.length);
  for (const i of model.inputs) w.bytes(i.txid).u32(i.index).u64(0).u64(i.sequence);
  w.u64(model.outputs.length);
  for (const o of model.outputs) w.u64(o.amount).u16(o.scriptVersion || 0).u64(o.script.length).bytes(o.script);
  w.u64(model.lockTime).bytes(model.subnetworkId).u64(model.gas).u64(model.payload.length).bytes(model.payload);
  const id = blake2b(w.done(), { dkLen: 32, key: new TextEncoder().encode("TransactionID") });
  return Array.from(id, (b) => b.toString(16).padStart(2, "0")).join("");
}

// The REST API writes a missing covenant as the string "None".
const present = (value) => value != null && value !== "" && String(value) !== "None";

const num = (value, fallback = 0) => {
  if (value == null || value === "") return fallback;
  if (typeof value === "object" && value !== null && "value" in value) return num(value.value, fallback);
  try { return BigInt(value); } catch { return null; }
};

/**
 * Checks a REST transaction (snake_case or camelCase fields, `resolve_previous_outpoints=light`).
 * `resolveSpentOutput(txid, index)` (optional, async) supplies `{ address, amount }` for an input
 * the API left unresolved, from the previous transaction. Returns "valid" | "invalid" | "unknown".
 */
export async function verifyRestTransactionSignatures(tx, { resolveSpentOutput = null } = {}) {
  const rawInputs = Array.isArray(tx?.inputs) ? tx.inputs : [];
  if (!rawInputs.length) return "valid"; // a coinbase: no signatures to check

  const inputs = [];
  for (const raw of rawInputs) {
    const txidHex = raw?.previous_outpoint_hash ?? raw?.previousOutpointHash ?? raw?.previous_outpoint?.transaction_id;
    const indexRaw = raw?.previous_outpoint_index ?? raw?.previousOutpointIndex ?? raw?.previous_outpoint?.index;
    const txid = hexToBytes(txidHex);
    const index = Number(indexRaw);
    // The outpoint itself is part of every input's signature hash.
    if (!txid || txid.length !== 32 || indexRaw == null || !Number.isInteger(index) || index < 0) return "unknown";
    let address = raw?.previous_outpoint_address ?? raw?.previousOutpointAddress ?? null;
    let amount = raw?.previous_outpoint_amount ?? raw?.previousOutpointAmount ?? null;
    if ((address == null || amount == null) && typeof resolveSpentOutput === "function") {
      try {
        const spent = await resolveSpentOutput(String(txidHex).toLowerCase(), index);
        if (spent) { address = address ?? spent.address ?? null; amount = amount ?? spent.amount ?? null; }
      } catch { /* stays unresolved */ }
    }
    const sequence = num(raw?.sequence, 0n);
    const sigOpCount = Number(num(raw?.sig_op_count ?? raw?.sigOpCount, 1n));
    if (sequence == null || !Number.isFinite(sigOpCount)) return "unknown";
    inputs.push({ txid, index, sequence, sigOpCount, signatureScript: String(raw?.signature_script ?? raw?.signatureScript ?? ""), address, amount });
  }

  const outputs = [];
  for (const raw of Array.isArray(tx?.outputs) ? tx.outputs : []) {
    const script = hexToBytes(raw?.script_public_key ?? raw?.scriptPublicKey);
    if (!script || !script.length) return "unknown"; // cannot verify without script data
    const amount = num(raw?.amount ?? raw?.value, null);
    if (amount == null) return "unknown";
    const authorizing = raw?.covenant_authorizing_input ?? raw?.covenantAuthorizingInput;
    const idHex = raw?.covenant_id ?? raw?.covenantId;
    let covenant = null;
    if (present(authorizing) && present(idHex)) {
      const id = hexToBytes(idHex);
      if (!id || id.length !== 32) return "unknown";
      covenant = { authorizingInput: Number(authorizing), id };
    }
    outputs.push({ amount, scriptVersion: 0, script, covenant });
  }

  const subnetworkId = hexToBytes(tx?.subnetwork_id ?? tx?.subnetworkId ?? "") || new Uint8Array(20);
  const payload = hexToBytes(tx?.payload ?? "") || new Uint8Array(0);
  const version = Number(num(tx?.version, 0n));
  const lockTime = num(tx?.lock_time ?? tx?.lockTime, 0n);
  const gas = num(tx?.gas, 0n);
  if (lockTime == null || gas == null || !Number.isFinite(version)) return "unknown";
  const model = {
    version, lockTime, gas, payload,
    subnetworkId: subnetworkId.length === 20 ? subnetworkId : new Uint8Array(20),
    inputs: inputs.map(({ txid, index, sequence, sigOpCount }) => ({ txid, index, sequence, sigOpCount })),
    outputs,
  };

  for (let i = 0; i < inputs.length; i += 1) {
    const input = inputs[i];
    // 0x41 (push 65) + 64-byte Schnorr signature + 0x01 (SIGHASH_ALL); anything else (a covenant
    // spend, another sighash type) is not checked here.
    const sigScript = hexToBytes(input.signatureScript);
    if (!sigScript || sigScript.length !== 66 || sigScript[0] !== 0x41 || sigScript[65] !== 0x01) continue;
    if (input.address == null || input.amount == null) return "unknown";
    const utxoScript = scriptPublicKeyFromAddress(input.address);
    const amount = num(input.amount, null);
    if (!utxoScript || amount == null) return "unknown";
    // Schnorr P2PK only: <32> <x-only key> OP_CHECKSIG.
    if (utxoScript.length < 34 || utxoScript[0] !== 32 || utxoScript[utxoScript.length - 1] !== 0xac) continue;
    let sighash;
    try { sighash = computeSighash(model, i, utxoScript, amount); } catch { return "unknown"; }
    let ok;
    try { ok = schnorr.verify(sigScript.slice(1, 65), sighash, utxoScript.slice(1, 33)); } catch { return "unknown"; }
    if (!ok) {
      // A wrong signature only proves forgery when the REST fields ARE the transaction: when they
      // do not even reproduce its id, something the signature covers is missing from the answer
      // (a sequence or lock time the API drops), so it cannot be judged from here.
      const claimed = String(tx?.transaction_id ?? tx?.transactionId ?? "").toLowerCase();
      let reproduced = false;
      try { reproduced = Boolean(claimed) && restModelTxIdHex(model) === claimed; } catch { reproduced = false; }
      return reproduced ? "invalid" : "unknown";
    }
  }
  return "valid";
}
