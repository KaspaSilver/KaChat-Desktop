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
//
// The verdict rule, the same on every client (iOS 8116ab9, audits AND-042 and XP-033; MESSAGING.md
// "Checking a received payment read from the REST API"): a standard key-address (P2PK Schnorr)
// input must carry a well-formed signature script - a blank, short or wrongly pushed one cannot be
// on chain, so it is a failure, not a skip (a lying REST server could otherwise file a payment
// from any contact by blanking it). A failing (or malformed) signature makes the payment "invalid"
// only when the REST fields rebuild the claimed transaction id, i.e. the API described the
// transaction completely; otherwise a field the signature covers is missing (lock time,
// sequences) and the answer is "unknown". A sighash type other than SIGHASH_ALL is "unknown" too,
// never a silent pass.
//
// iOS 5a78d06 (IOS-094/097/106, owner's choices 2026-10-21): no inputs is "unknown" (the payment
// sync drops such a transaction before it gets here); a signature script of a shape no accepted
// transaction can carry (malformed P2PK, a P2SH script that isn't hex, a KIP-22 redeem that
// doesn't hash to its address) is "invalid" outright, without the id-rebuild excuse, which stays
// for a well-formed signature that fails to verify; every input is examined before any "can't
// decide" answer; and a payment where not one input's signature was actually checked (all ECDSA,
// or kinds this check doesn't model) is "unknown", never "valid".
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

/// The id the transaction would have if the REST fields were the whole transaction (iOS 8116ab9
/// restTransactionId; rusty-kaspa consensus/core/src/hashing/tx.rs): v0 = keyed BLAKE2b
/// "TransactionID" over the encoding with signature scripts (and mass commitments) excluded,
/// payload included; v1 = the name core's TransactionV1Id(PayloadDigest(payload) ||
/// TransactionRest(the same encoding, payload excluded too)), keyed BLAKE3. Output script version
/// 0. The REST API does not carry every field - sequence and lock time come back missing - so for
/// a transaction that set one, the fields it does carry are not the transaction that was signed
/// (the time-locked .kachat registration 690315d4 is such a case: unknown, not forged).
export function restModelTxIdHex(model) {
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

/// A u32 read strictly (iOS UInt32(_:) / UInt32(exactly:), IOS-092): a whole number in
/// [0, 2^32), as a JS number, a bigint or a plain decimal string; anything else is null.
export function parseU32(value) {
  let n;
  if (typeof value === "number") n = value;
  else if (typeof value === "bigint") n = value <= 0xffffffffn && value >= 0n ? Number(value) : -1;
  else if (typeof value === "string" && /^[0-9]{1,10}$/.test(value)) n = Number(value);
  else return null;
  return Number.isInteger(n) && n >= 0 && n <= 0xffffffff ? n : null;
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
export async function verifyRestTransactionSignatures(tx, options = {}) {
  return (await checkRestTransaction(tx, options)).check;
}

/**
 * verifyRestTransactionSignatures plus the payment's proven sender (iOS 5a78d06 + 2343e84
 * verifyIncomingPaymentSignatures, IOS-094 / DSK-056): the sender is the first input that isn't
 * `myAddress` (any case) AMONG THOSE WHOSE SIGNATURE VERIFIED - never just the first input: ECDSA
 * and covenant-shaped inputs are skipped unchecked, so their address is only the REST label, and a
 * forger could list one first and sign a second input of their own. `sender` is null on any other
 * verdict, or when no verified input names an address that isn't ours (the payment paths then send
 * it the unknown way - node + indexer - never file it under the label).
 */
export async function verifyRestTransactionSignaturesWithSender(tx, { resolveSpentOutput = null, myAddress = "" } = {}) {
  const { check, inputs, verifiedInputs } = await checkRestTransaction(tx, { resolveSpentOutput });
  if (check !== "valid") return { check, sender: null };
  const me = String(myAddress || "").trim().toLowerCase();
  const sender = (verifiedInputs || [])
    .map((index) => String(inputs?.[index]?.address ?? "").trim())
    .find((address) => address && address.toLowerCase() !== me) || null;
  return { check, sender };
}

async function checkRestTransaction(tx, { resolveSpentOutput = null } = {}) {
  const verdict = (check) => ({ check, inputs: null, verifiedInputs: null });
  const rawInputs = Array.isArray(tx?.inputs) ? tx.inputs : [];
  // No inputs (a coinbase): nothing was checked, so nothing is vouched for (IOS-094) - the
  // received-payment paths drop such a transaction before it gets here.
  if (!rawInputs.length) return verdict("unknown");

  const inputs = [];
  for (const raw of rawInputs) {
    const txidHex = raw?.previous_outpoint_hash ?? raw?.previousOutpointHash ?? raw?.previous_outpoint?.transaction_id;
    const indexRaw = raw?.previous_outpoint_index ?? raw?.previousOutpointIndex ?? raw?.previous_outpoint?.index;
    const txid = hexToBytes(txidHex);
    const index = parseU32(indexRaw);
    // The outpoint itself is part of every input's signature hash; a bad index is "unknown",
    // never a throw (iOS 8116ab9, IOS-092).
    if (!txid || txid.length !== 32 || index == null) return verdict("unknown");
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
    if (sequence == null || !Number.isFinite(sigOpCount)) return verdict("unknown");
    inputs.push({ txid, index, sequence, sigOpCount, signatureScript: String(raw?.signature_script ?? raw?.signatureScript ?? ""), address, amount });
  }

  const outputs = [];
  for (const raw of Array.isArray(tx?.outputs) ? tx.outputs : []) {
    const script = hexToBytes(raw?.script_public_key ?? raw?.scriptPublicKey);
    if (!script || !script.length) return verdict("unknown"); // cannot verify without script data
    const amount = num(raw?.amount ?? raw?.value, null);
    if (amount == null) return verdict("unknown");
    const authorizing = raw?.covenant_authorizing_input ?? raw?.covenantAuthorizingInput;
    const idHex = raw?.covenant_id ?? raw?.covenantId;
    let covenant = null;
    if (present(authorizing) && present(idHex)) {
      const id = hexToBytes(idHex);
      // the authorizing input is a u16 in both the signature hash and the id: read it strictly
      const authorizingInput = parseU32(typeof authorizing === "string" ? authorizing.trim() : authorizing);
      if (!id || id.length !== 32 || authorizingInput == null || authorizingInput > 0xffff) return verdict("unknown");
      covenant = { authorizingInput, id };
    }
    outputs.push({ amount, scriptVersion: 0, script, covenant });
  }

  const subnetworkId = hexToBytes(tx?.subnetwork_id ?? tx?.subnetworkId ?? "") || new Uint8Array(20);
  const payload = hexToBytes(tx?.payload ?? "") || new Uint8Array(0);
  const version = Number(num(tx?.version, 0n));
  const lockTime = num(tx?.lock_time ?? tx?.lockTime, 0n);
  const gas = num(tx?.gas, 0n);
  if (lockTime == null || gas == null || !Number.isFinite(version)) return verdict("unknown");
  const model = {
    version, lockTime, gas, payload,
    subnetworkId: subnetworkId.length === 20 ? subnetworkId : new Uint8Array(20),
    inputs: inputs.map(({ txid, index, sequence, sigOpCount }) => ({ txid, index, sequence, sigOpCount })),
    outputs,
  };

  // Whether the REST fields describe the transaction completely: they rebuild its claimed id.
  const restFieldsRebuildId = () => {
    const claimed = String(tx?.transaction_id ?? tx?.transactionId ?? "").toLowerCase();
    try { return Boolean(claimed) && restModelTxIdHex(model) === claimed; } catch { return false; }
  };
  // A signature that fails to verify is forged only when the REST fields rebuild the claimed id
  // (XP-033: else a field it covers is missing). A signature script of a shape no accepted
  // transaction can carry needs no such excuse - it is invalid outright (IOS-097). Every input is
  // looked at before any "can't decide" answer, so a malformed input later in the list is never
  // hidden behind an earlier unknown.
  let failedInput = null;
  let malformedInput = null;
  let undecided = false;
  // inputs whose signature was actually checked; a payment with none is not "valid" (IOS-106: an
  // all-ECDSA or otherwise unmodelled payment had zero checks and passed)
  let checkedInputs = 0;
  // the index of every input whose signature VERIFIED, in input order (iOS 2343e84 onVerifiedInput):
  // the only inputs a payment's sender may come from (IOS-094 / DSK-056)
  const verifiedInputs = [];

  // iOS 8116ab9's order: the spent script is worked out first, so only key-address and KIP-22
  // inputs need (and are held to) a well-formed signature script; P2SH covenant spends are skipped.
  for (let i = 0; i < inputs.length; i += 1) {
    const input = inputs[i];
    // 1. The spent UTXO's script and amount: without them this input can't be checked yet.
    if (input.address == null || input.amount == null) { undecided = true; continue; }
    const utxoScript = scriptPublicKeyFromAddress(input.address);
    const amount = num(input.amount, null);
    if (!utxoScript || amount == null) { undecided = true; continue; }

    // 2. The input's kind, from the spent UTXO's script (iOS 54265bf). Standard P2PK Schnorr
    // (<0x20> <32-byte key> OP_CHECKSIG) and KIP-22 quantum-address P2SH spends are both checked;
    // any other P2SH spend is a covenant, not checked here - since iOS 0b4e27e such a transaction is
    // a contract and never files as a payment, while a KIP-22 spend passes the contract filter, so
    // skipping it here would leave a forged all-quantum "payment" with no signature checked at all.
    let xOnlyKey;
    let schnorrSig;
    if (utxoScript.length === 34 && utxoScript[0] === 32 && utxoScript[33] === 0xac) {
      // 3. A P2PK input's signature script is 0x41 (push 65) + a 64-byte Schnorr signature + a
      // sighash type byte. Anything else (blank, short, another push) can't be on chain: malformed
      // (AND-042), invalid outright (IOS-097).
      const sigScript = hexToBytes(input.signatureScript);
      if (!sigScript || sigScript.length !== 66 || sigScript[0] !== 0x41) {
        if (malformedInput == null) malformedInput = i;
        continue;
      }
      // A sighash type this check doesn't hash (only SIGHASH_ALL is): can't be decided here.
      if (sigScript[65] !== 0x01) { undecided = true; continue; }
      xOnlyKey = utxoScript.slice(1, 33);
      schnorrSig = sigScript.slice(1, 65);
    } else if (utxoScript.length === 35 && utxoScript[0] === 0xaa && utxoScript[1] === 0x20 && utxoScript[34] === 0x87) {
      // 3b. P2SH. A KIP-22 spend's signature script is 0x41 <64-byte sig> <sighash byte> then the
      // canonical push 0x22 of the 34-byte redeem 0x20 <x-only key> 0xac (101 bytes); any other
      // shape is a covenant spend, skipped as before. A script that is not even hex can't be on
      // chain: malformed (IOS-097).
      const sb = hexToBytes(input.signatureScript);
      if (!sb) {
        if (malformedInput == null) malformedInput = i;
        continue;
      }
      if (sb.length !== 101 || sb[0] !== 0x41 || sb[66] !== 0x22 || sb[67] !== 0x20 || sb[100] !== 0xac) continue;
      // The key is bound to the address by the redeem's hash: a KIP-22-shaped script whose redeem
      // doesn't hash to this very address can't be on chain for it - malformed (IOS-097).
      const redeemHash = blake2b(sb.slice(67, 101), { dkLen: 32 });
      if (!redeemHash.every((byte, k) => byte === utxoScript[2 + k])) {
        if (malformedInput == null) malformedInput = i;
        continue;
      }
      if (sb[65] !== 0x01) { undecided = true; continue; }
      xOnlyKey = sb.slice(68, 100);
      schnorrSig = sb.slice(1, 65);
    } else {
      continue; // ECDSA and the like: not checked here (and not counted as checked, IOS-106)
    }

    // 4. The signature hash (v0 or v1), over the spent UTXO's own script (P2SH for a KIP-22
    // spend - the same the signer uses).
    let sighash;
    try { sighash = computeSighash(model, i, utxoScript, amount); } catch { undecided = true; continue; }

    // 5. The Schnorr signature.
    let ok;
    try { ok = schnorr.verify(schnorrSig, sighash, xOnlyKey); } catch { undecided = true; continue; }
    checkedInputs += 1;
    if (!ok) { if (failedInput == null) failedInput = i; }
    else verifiedInputs.push(i);
  }

  if (malformedInput != null) return verdict("invalid");
  // Forged only when the API described the whole transaction (XP-033); else something it left out
  // (that the signature covers) is the likelier reason.
  if (failedInput != null) return verdict(restFieldsRebuildId() ? "invalid" : "unknown");
  if (undecided || checkedInputs === 0) return verdict("unknown");
  return { check: "valid", inputs, verifiedInputs };
}
