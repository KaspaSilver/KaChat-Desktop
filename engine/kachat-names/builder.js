// .kachat names: the transaction builders, unsigned plans and signing.
//
// Port of iOS KaChat/Services/KachatNames/KachatNamesBuilder.swift (itself a one-to-one port of
// the kachat-domains CLI's tools/kachat-names-cli/src/ops.rs): same shapes, payloads, lock times,
// sequences, coin selection, change and fee rule. Pure: the builders read decoded registry
// records with their live UTXOs and the signer's spendable P2PK UTXOs, and never touch the network.
//
// Shapes (bigint = sompi / DAA / ms / Int64; see transaction.js for Utxo, Tx, ...):
//   Env          { me: Uint8Array(32) x-only key of the signer (owner, buyer and payer),
//                  blockDaa: bigint, blockTimeMs: bigint (virtual's past median time, unix ms),
//                  wallMs: bigint (wall clock), feerate: number (sompi/gram, default 100),
//                  budgets: { [role]: number } (default recommendedBudgets) }
//   GapRecord    { lo, hi, value: bigint, utxo }
//   NameRecord   { fields: NameFields, value: bigint, utxo }        (name = nameFieldsName(fields))
//   OfferRecord  { fields: OfferFields, value: bigint, utxo, name: string | null }
//   CommitRecord { name, owner, salt: Uint8Array(32), value: bigint, utxo: Utxo | null }
//   ExitParts    { below: GapRecord, name: NameRecord, above: GapRecord }
//   Arg          { kind: "bytes", data } | { kind: "int", value: bigint } | { kind: "signature" }
//   Unlock       { kind: "p2pk" } | { kind: "commit", redeem } | { kind: "contract", redeem, tag, args: Arg[] }
//   PlannedInput { utxo, sequence: bigint, unlock: Unlock, role: string, label: string }
//   PlannedOutput{ output: TxOutput, label: string }
//   Costs        { size, computeMass, transientMass, normalizedTransient, storageMass, minFee: bigint }
//   Plan         { op, inputs: PlannedInput[], outputs: PlannedOutput[], unsignedTx: Tx (placeholder
//                  signatures), entries: UtxoEntry[], costs, priceFee, networkFee, fee: bigint,
//                  txid: Uint8Array, notes: string[], newCommit: CommitRecord | null,
//                  newOffer: OfferRecord | null }
//
// Signing: the plan's transaction already carries 65-byte placeholder signatures (64 zero bytes +
// SIGHASH_ALL), so its size, masses, fee and txid are final (v1 txids and sighashes do not cover
// signature scripts). `planSigningRequests(plan)` lists `{ inputIndex, sighash }` for every input
// that needs `Env.me`'s signature; sign each 32-byte sighash with BIP-340 Schnorr, then
// `planSignedWithSignatures(plan, { [inputIndex]: sig64 + 0x01 })` (65 bytes each), or pass a
// signer callback returning the 64-byte signature to `planSignedBy` / `planSignedByAsync`.

import {
  Failure, sompiPerKas, lockTimeThreshold, commitValue, minChange, targetChange, minFeerate,
  maxInputsFeeEntry, maxInputs, maxListPrice, sighashAll, concat, bytesEqual, bytesLess, utf8,
  validate, key as nameKey, commitment, commitRedeem, pushData, pushInt, p2shScript, p2pkScript, gapState,
  namePayload, offerPayload, nameState, offerState, nameFieldsFor, nameFieldsName, nameFieldsWithOwner,
  nameFieldsWithPrice, nameFieldsExtended, nameFieldsRenewed, makeOfferFields, zero32,
} from "./codec.js";
import {
  makeTx, makeTxInput, makeTxOutput, makeUtxo, makeUtxoEntry, makeOutpoint, makeCovenantBinding, outpointKey,
  txId, txSighash, storageMass, computeMass, normalizedTransient, transientMass, massSize,
  networkFee as massNetworkFee, cloneTx,
} from "./transaction.js";
import {
  verifyManifest, templateRedeem, templateScript, templateTag, paramsExtendableYearsOf, paramsRenewOpens, paramsExpiresSoonMs,
  paramsRegisterCost, paramsRenewPrice,
} from "./manifest.js";

// MARK: - Compute budgets

/** Which budget an input commits, by what it runs (Swift `BudgetRole` raw values). */
export const BudgetRole = {
  p2pk: "p2pk",
  commit: "commit",
  gapRegister: "gap.register",
  gapMerge: "gap.merge",
  gapAbsorbed: "gap.absorbed",
  nameTransfer: "name.transfer",
  nameList: "name.list",
  nameBuy: "name.buy",
  nameExtend: "name.extend",
  nameRenew: "name.renew",
  nameRelease: "name.release",
  nameReclaim: "name.reclaim",
  offerAccept: "offer.accept",
  offerDecline: "offer.decline",
  offerWithdraw: "offer.withdraw",
  offerRefund: "offer.refund",
};

/** Per-input compute budgets by role. The CLI measures each input in the script engine; the app
 *  has no engine, so it commits a fixed budget per entry that covers every case (README "Cost per
 *  operation"; the vector generator checks every measured budget fits this table, the vectors'
 *  `recommendedBudgets`). An input that needs more than it committed fails, so these only ever err
 *  on the side of a slightly higher fee (100 grams per unit). Registry v4. */
export const recommendedBudgets = {
  "p2pk": 10, "commit": 10,
  "gap.register": 8, "gap.merge": 4, "gap.absorbed": 0,
  "name.transfer": 12, "name.list": 12, "name.buy": 2, "name.extend": 2, "name.renew": 2, "name.release": 10, "name.reclaim": 0,
  "offer.accept": 17, "offer.decline": 10, "offer.withdraw": 10, "offer.refund": 0,
};

/** The budget `budgets` commits for `role`, falling back to the recommended table, then 0. */
export function budgetFor(budgets, role) {
  if (budgets && Object.prototype.hasOwnProperty.call(budgets, role)) return budgets[role];
  return recommendedBudgets[role] ?? 0;
}

// MARK: - Builder inputs

/** Env with defaults: feerate = minFeerate (100 sompi/gram), budgets = a copy of recommendedBudgets. */
export function makeEnv({ me, blockDaa, blockTimeMs, wallMs, feerate = minFeerate, budgets = null }) {
  return {
    me, blockDaa: BigInt(blockDaa), blockTimeMs: BigInt(blockTimeMs), wallMs: BigInt(wallMs),
    feerate: Number(feerate), budgets: budgets ?? { ...recommendedBudgets },
  };
}

// MARK: - Unsigned plan

/** Arg: pushed bytes. */
export function argBytes(data) { return { kind: "bytes", data }; }
/** Arg: a script integer. */
export function argInt(value) { return { kind: "int", value: BigInt(value) }; }
/** Arg: a SIGHASH_ALL Schnorr signature by `Env.me` over the input it sits in. */
export function argSignature() { return { kind: "signature" }; }

/** True when the unlock carries the signer's signature (p2pk, commit, or a contract call with a signature arg). */
export function unlockNeedsSignature(unlock) {
  switch (unlock.kind) {
    case "p2pk":
    case "commit":
      return true;
    case "contract":
      return unlock.args.some((a) => a.kind === "signature");
    default:
      throw new Failure(`unknown unlock ${unlock.kind}`);
  }
}

/** The signature script of an unlock with `signature` (65 bytes: 64-byte Schnorr + sighash type).
 *  p2pk: `push(sig)`; commit: `push(sig) push(redeem)`; contract: `<args> push(tag) push(redeem)`. */
export function unlockSignatureScript(unlock, signature) {
  switch (unlock.kind) {
    case "p2pk":
      return pushData(signature);
    case "commit":
      return concat(pushData(signature), pushData(unlock.redeem));
    case "contract": {
      const parts = [];
      for (const a of unlock.args) {
        if (a.kind === "bytes") parts.push(pushData(a.data));
        else if (a.kind === "int") parts.push(pushInt(a.value));
        else if (a.kind === "signature") parts.push(pushData(signature));
        else throw new Failure(`unknown arg ${a.kind}`);
      }
      parts.push(pushData(unlock.tag), pushData(unlock.redeem));
      return concat(...parts);
    }
    default:
      throw new Failure(`unknown unlock ${unlock.kind}`);
  }
}

function plannedInput({ utxo, sequence = 0n, unlock, role, label }) {
  return { utxo, sequence: BigInt(sequence), unlock, role, label };
}

/** Every input's SIGHASH_ALL Schnorr sighash, in input order (signature scripts do not enter it). */
export function planSighashes(plan) {
  return plan.inputs.map((_, i) => txSighash(plan.unsignedTx, i, plan.entries));
}

/** `{ inputIndex, sighash, label }` for every input that needs `Env.me`'s signature, in input order. */
export function planSigningRequests(plan) {
  const out = [];
  plan.inputs.forEach((input, i) => {
    if (unlockNeedsSignature(input.unlock)) {
      out.push({ inputIndex: i, sighash: txSighash(plan.unsignedTx, i, plan.entries), label: input.label });
    }
  });
  return out;
}

function sigFor(signatures, i) {
  if (signatures instanceof Map) return signatures.get(i);
  if (signatures == null) return undefined;
  return signatures[i];
}

/** The signed transaction from ready 65-byte signatures (64-byte Schnorr + sighash type 0x01) by
 *  input index: a Map<number, Uint8Array>, an array, or an object keyed by index (test vectors,
 *  external signers). Inputs that need no signature keep their script. Returns a new Tx. */
export function planSignedWithSignatures(plan, signatures) {
  const tx = cloneTx(plan.unsignedTx);
  plan.inputs.forEach((input, i) => {
    if (!unlockNeedsSignature(input.unlock)) return;
    const sig = sigFor(signatures, i);
    if (!(sig instanceof Uint8Array) || sig.length !== 65) throw new Failure(`no 65-byte signature for input ${i}`);
    tx.inputs[i].signatureScript = unlockSignatureScript(input.unlock, sig);
  });
  return tx;
}

/** The signed transaction. `sign(sighash32)` returns the 64-byte BIP-340 Schnorr signature of a
 *  32-byte sighash by `Env.me`'s key; it is called once per input that needs one. */
export function planSignedBy(plan, sign) {
  const tx = cloneTx(plan.unsignedTx);
  plan.inputs.forEach((input, i) => {
    if (!unlockNeedsSignature(input.unlock)) return;
    const sig = sign(txSighash(plan.unsignedTx, i, plan.entries), i);
    if (!(sig instanceof Uint8Array) || sig.length !== 64) throw new Failure("a Schnorr signature is 64 bytes");
    tx.inputs[i].signatureScript = unlockSignatureScript(input.unlock, concat(sig, [sighashAll]));
  });
  return tx;
}

/** `planSignedBy` with an async signer (`await sign(sighash32, inputIndex)` -> 64 bytes). */
export async function planSignedByAsync(plan, sign) {
  const tx = cloneTx(plan.unsignedTx);
  for (let i = 0; i < plan.inputs.length; i++) {
    const input = plan.inputs[i];
    if (!unlockNeedsSignature(input.unlock)) continue;
    const sig = await sign(txSighash(plan.unsignedTx, i, plan.entries), i);
    if (!(sig instanceof Uint8Array) || sig.length !== 64) throw new Failure("a Schnorr signature is 64 bytes");
    tx.inputs[i].signatureScript = unlockSignatureScript(input.unlock, concat(sig, [sighashAll]));
  }
  return tx;
}

// MARK: - Builder

/** The least a cancelled commit may return (its storage mass stays small: one 0.2 KAS input, one
 *  output just under it). */
export const cancelFloorValue = 10_000_000n;

function placeholderSignature() {
  const s = new Uint8Array(65);
  s[64] = sighashAll;
  return s;
}

/** `"%llu.%08llu TKAS"`. */
function kas(sompi) {
  const v = BigInt(sompi);
  return `${v / sompiPerKas}.${String(v % sompiPerKas).padStart(8, "0")} TKAS`;
}

function sum(xs, f) { return xs.reduce((a, x) => a + f(x), 0n); }

function maxBig(a, b) { return a > b ? a : b; }

/** `now` for a registration: wall clock - 3 min (the median time lags ~2.2 min), never at or past
 *  the virtual's median time. */
export function registerNow(env) {
  const a = BigInt(env.wallMs) - 180_000n;
  const b = BigInt(env.blockTimeMs) - 1_000n;
  return a < b ? a : b;
}

/** The lock time of a renewal (ops.rs `renew_lock_time`): the registration-style `now`, but never
 *  before the window opens -
 *  `max(min(wall - 3 min, median time - 1 s), expiresAt - renewWindowMs)` (unix ms, BigInt).
 *  Final (and so valid) only while it is below the median time, i.e. once the window opened.
 *  Swift `Builder.renewLockTime(env:params:expiresAt:)`. */
export function renewLockTime(env, params, expiresAt) {
  return maxBig(registerNow(env), paramsRenewOpens(params, expiresAt));
}

/** Whether the renewal window is open at `env` (ops.rs `renew_window_open`): the virtual's past
 *  median time is past `expiresAt - renewWindowMs`. Before that no renewal is valid (the mempool
 *  keeps no future-dated transactions), so the app refuses to submit one.
 *  Swift `Builder.renewWindowOpen(env:params:expiresAt:)`. */
export function renewWindowOpen(env, params, expiresAt) {
  return BigInt(env.blockTimeMs) > paramsRenewOpens(params, expiresAt);
}

/** Sizes, masses and the 100 sompi/gram floor fee of a transaction. */
export function costs(tx) {
  const compute = computeMass(tx);
  const normalized = normalizedTransient(tx);
  return {
    size: massSize(tx), computeMass: compute, transientMass: transientMass(tx),
    normalizedTransient: normalized, storageMass: tx.storageMass,
    minFee: maxBig(compute, normalized) * 100n,
  };
}

/** Pick funding UTXOs (largest first, then lowest output index, skipping `used`) worth at least
 *  `target`, at most `slots` of them. Returns what it found even if short. */
function select(wallet, used, target, slots) {
  const pool = wallet.map((element, offset) => ({ element, offset })).filter((x) => !used.has(outpointKey(x.element.outpoint)));
  pool.sort((a, b) => {
    const aa = a.element.entry.amount, ba = b.element.entry.amount;
    if (aa !== ba) return aa > ba ? -1 : 1;
    if (a.element.outpoint.index !== b.element.outpoint.index) return a.element.outpoint.index - b.element.outpoint.index;
    return a.offset - b.offset;
  });
  const out = [];
  let s = 0n;
  for (const { element: u } of pool) {
    if (s >= target || out.length >= slots) break;
    s += u.entry.amount;
    out.push(u);
  }
  return out;
}

/** The .kachat transaction builders over a verified manifest. Every builder takes one object
 *  argument (the Swift labels) and returns a Plan, or throws a Failure. */
export class Builder {
  /** Only over a verified testnet-10 manifest (`verifyManifest`): the builders never run against
   *  an unverified registry or another network. */
  constructor(manifest) {
    verifyManifest(manifest);
    this.manifest = manifest;
  }

  get params() { return this.manifest.params; }
  get registryId() { return this.manifest.registryCovenantId; }

  /** See the module-level `registerNow`. */
  static registerNow(env) { return registerNow(env); }
  /** See the module-level `renewLockTime`. */
  static renewLockTime(env, params, expiresAt) { return renewLockTime(env, params, expiresAt); }
  /** See the module-level `renewWindowOpen`. */
  static renewWindowOpen(env, params, expiresAt) { return renewWindowOpen(env, params, expiresAt); }
  /** See the module-level `costs`. */
  static costs(tx) { return costs(tx); }
  static get cancelFloorValue() { return cancelFloorValue; }

  // MARK: Shared assembly

  _assemble(inputs, outputs, lockTime, payload, env) {
    const entries = inputs.map((i) => i.utxo.entry);
    const tx = makeTx({
      inputs: inputs.map((i) => makeTxInput({
        outpoint: i.utxo.outpoint,
        signatureScript: unlockSignatureScript(i.unlock, placeholderSignature()),
        sequence: i.sequence,
        computeBudget: budgetFor(env.budgets, i.role),
      })),
      outputs: outputs.map((o) => o.output),
      lockTime,
      payload,
    });
    // KIP-9 storage-mass commitment (independent of signature scripts)
    const m = storageMass(tx, entries);
    if (m != null) tx.storageMass = m;
    return { tx, entries };
  }

  /** fee: { kind: "funded", maxInputs } adds the signer's funding inputs and a change output back
   *  to the signer; { kind: "fromOutput", index, cap, floor } takes the network fee out of output
   *  `index`, which must keep `floor` (default minChange). */
  _finish(draftIn, wallet, fee, env) {
    const d = {
      op: draftIn.op,
      inputs: [...draftIn.inputs],
      outputs: draftIn.outputs.map((o) => ({ ...o, output: { ...o.output } })),
      lockTime: draftIn.lockTime ?? 0n,
      priceFee: draftIn.priceFee ?? 0n,
      notes: [...(draftIn.notes ?? [])],
      payload: draftIn.payload ?? new Uint8Array(0),
    };
    let networkFee;
    if (fee.kind === "funded") {
      const fixedIn = sum(d.inputs, (i) => i.utxo.entry.amount);
      const fixedOut = sum(d.outputs, (o) => o.output.value);
      const used = new Set(d.inputs.map((i) => outpointKey(i.utxo.outpoint)));
      const slots = Math.max(0, fee.maxInputs - d.inputs.length);
      let est = 0n;
      let last = null;
      for (let round = 0; round < 5; round++) {
        const required = fixedOut + d.priceFee + est;
        const need = required > fixedIn ? required - fixedIn : 0n;
        let picked = select(wallet, used, need + targetChange, slots);
        let have = sum(picked, (u) => u.entry.amount);
        if (have < need + minChange && need > 0n) {
          picked = select(wallet, used, need + minChange, slots);
        }
        have = sum(picked, (u) => u.entry.amount);
        if (fixedIn + have < required) {
          const all = sum(wallet.filter((u) => !used.has(outpointKey(u.outpoint))), (u) => u.entry.amount);
          const bound = slots < wallet.length ? ` (at most ${slots} funding inputs fit)` : "";
          throw new Failure(
            `${d.op}: insufficient funds: need ${kas(required - fixedIn)} more (outputs ${kas(fixedOut)} + price `
              + `${kas(d.priceFee)} + network fee ~${kas(est)}), ${kas(all)} spendable${bound}`,
          );
        }
        const inputs = [...d.inputs];
        for (const u of picked) {
          inputs.push(plannedInput({ utxo: u, unlock: { kind: "p2pk" }, role: BudgetRole.p2pk, label: "funding (P2PK)" }));
        }
        const change = fixedIn + have - required;
        const outputs = [...d.outputs];
        const withChange = change >= minChange;
        if (withChange) {
          outputs.push({ output: makeTxOutput({ value: change, script: p2pkScript(env.me) }), label: "change" });
        }
        const { tx } = this._assemble(inputs, outputs, d.lockTime, d.payload, env);
        const feeNow = massNetworkFee(tx, env.feerate);
        if (feeNow <= est) {
          if (!withChange && change > 0n) {
            d.notes.push(`no change output: the ${kas(change)} left over goes to the miner`);
          }
          last = { inputs, outputs, change, withChange };
          break;
        }
        est = feeNow;
      }
      if (last == null) throw new Failure(`${d.op}: fee did not converge`);
      d.inputs = last.inputs;
      d.outputs = last.outputs;
      networkFee = last.withChange ? est : est + last.change;
    } else if (fee.kind === "fromOutput") {
      const index = fee.index;
      const cap = fee.cap ?? null;
      const floor = fee.floor ?? minChange;
      const totalIn = sum(d.inputs, (i) => i.utxo.entry.amount);
      const others = sum(d.outputs.filter((_, k) => k !== index), (o) => o.output.value);
      // provisional value (zero would break the KIP-9 storage-mass formula)
      const taken = others + d.priceFee;
      d.outputs[index].output.value = maxBig(totalIn > taken ? totalIn - taken : 0n, 1n);
      const { tx } = this._assemble(d.inputs, d.outputs.map((o) => ({ ...o, output: { ...o.output } })), d.lockTime, d.payload, env);
      const f = massNetworkFee(tx, env.feerate);
      if (cap != null && f > cap) {
        throw new Failure(`${d.op}: network fee ${kas(f)} exceeds the contract's maxFee ${kas(cap)}`);
      }
      if (!(totalIn >= taken + f)) throw new Failure(`${d.op}: inputs do not cover the outputs and the fee`);
      const v = totalIn - taken - f;
      if (!(v >= floor)) throw new Failure(`${d.op}: output ${index} would be only ${kas(v)}`);
      d.outputs[index].output.value = v;
      networkFee = f;
    } else {
      throw new Failure(`unknown fee mode ${fee.kind}`);
    }
    if (d.inputs.length > 255 || d.outputs.length > 255) throw new Failure("too many inputs/outputs");
    const { tx, entries } = this._assemble(d.inputs, d.outputs, d.lockTime, d.payload, env);
    const totalIn = sum(entries, (e) => e.amount);
    const totalOut = sum(tx.outputs, (o) => o.value);
    if (!(totalIn >= totalOut) || totalIn - totalOut !== d.priceFee + networkFee) {
      throw new Failure(`${d.op}: fee bookkeeping does not balance`);
    }
    return {
      op: d.op, inputs: d.inputs, outputs: d.outputs, unsignedTx: tx, entries,
      costs: costs(tx), priceFee: d.priceFee, networkFee, fee: d.priceFee + networkFee, txid: txId(tx),
      notes: d.notes, newCommit: null, newOffer: null,
    };
  }

  // MARK: Checks

  _checkLive(label, utxo, value, covenant) {
    if (utxo.entry.amount !== value) {
      throw new Failure(`${label}: live UTXO holds ${kas(utxo.entry.amount)}, not ${kas(value)}`);
    }
    if (!bytesEqual(utxo.entry.covenantId ?? null, covenant ?? null)) throw new Failure(`${label}: live UTXO has the wrong covenant id`);
  }

  _requireOwner(env, n) {
    if (!bytesEqual(n.fields.owner, env.me)) throw new Failure(`${nameFieldsName(n.fields)} is owned by another key`);
  }

  static _checkKey(k, what) {
    if (!(k instanceof Uint8Array) || k.length !== 32 || bytesEqual(k, zero32())) {
      throw new Failure(`${what} must be a non-zero 32-byte x-only key`);
    }
  }

  _registryOutput(value, script) {
    return makeTxOutput({ value, script, covenant: makeCovenantBinding(0, this.registryId) });
  }

  _gapOutput(lo, hi) {
    return this._registryOutput(this.params.gapValue, templateScript(this.manifest.gap, gapState(lo, hi)));
  }

  _nameOutput(f) {
    return this._registryOutput(this.params.bond, templateScript(this.manifest.name, nameState(f)));
  }

  _nameInput(n, entry, args, role, label) {
    const unlock = { kind: "contract", redeem: templateRedeem(this.manifest.name, nameState(n.fields)), tag: templateTag(this.manifest.name, entry), args };
    return plannedInput({ utxo: n.utxo, unlock, role, label });
  }

  _gapInput(g, entry, args, role, label) {
    const unlock = { kind: "contract", redeem: templateRedeem(this.manifest.gap, gapState(g.lo, g.hi)), tag: templateTag(this.manifest.gap, entry), args };
    return plannedInput({ utxo: g.utxo, unlock, role, label });
  }

  _offerInput(o, entry, args, role, label) {
    const unlock = { kind: "contract", redeem: templateRedeem(this.manifest.offer, offerState(o.fields)), tag: templateTag(this.manifest.offer, entry), args };
    return plannedInput({ utxo: o.utxo, unlock, role, label });
  }

  _checkYears(years) {
    if (years < 1n || years > this.params.maxYears) throw new Failure(`years must be 1..${this.params.maxYears}`);
  }

  // MARK: Commit / register

  /** A salted commit: `P2SH(0x20 c 0x75 0x20 ownerKey 0xac)` worth 0.2 KAS, no payload (a payload
   *  would reveal the name). Keep `plan.newCommit` (the salt!) until the registration. */
  commit({ env, wallet, name, salt }) {
    validate(name);
    if (!(salt instanceof Uint8Array) || salt.length !== 32) throw new Failure("the salt is 32 bytes");
    const c = commitment(name, env.me, salt);
    const redeem = commitRedeem(c, env.me);
    const out = makeTxOutput({ value: commitValue, script: p2shScript(redeem) });
    const d = { op: `commit ${name}`, inputs: [], outputs: [{ output: out, label: "commit P2SH" }] };
    const plan = this._finish(d, wallet, { kind: "funded", maxInputs }, env);
    const entry = makeUtxoEntry({ amount: commitValue, script: out.script, blockDaaScore: 0n, covenantId: null });
    plan.newCommit = {
      name, owner: env.me, salt, value: commitValue,
      utxo: makeUtxo(makeOutpoint(plan.txid, 0), entry),
    };
    return plan;
  }

  /** Register `commit.name` for `years` periods: [gap.register, commit, funding] -> [gap
   *  (lo,key), gap (key,hi), name (periodStart = now), change]; lock time `now`, commit sequence
   *  `tCommit`. The price is the baked one (registry v4): the registration price for the first
   *  period, the renewal price for each further one. `now` (unix ms, BigInt) normally comes from
   *  `registerNow(env)`. */
  register({ env, wallet, gap, commit, years, now }) {
    years = BigInt(years);
    now = BigInt(now);
    const name = commit.name;
    validate(name);
    if (!bytesEqual(commit.owner, env.me)) throw new Failure(`the commit for ${name} is for another owner`);
    const commitUtxo = commit.utxo;
    if (commitUtxo == null) throw new Failure(`the commit for ${name} is not on chain yet`);
    this._checkYears(years);
    const k = nameKey(name);
    if (!(bytesLess(gap.lo, k) && bytesLess(k, gap.hi))) throw new Failure(`${name} is not inside that gap`);
    this._checkLive("gap", gap.utxo, this.params.gapValue, this.registryId);
    const redeem = commitRedeem(commitment(name, env.me, commit.salt), env.me);
    if (!bytesEqual(commitUtxo.entry.script, p2shScript(redeem))) throw new Failure("commit UTXO script does not match the salt");
    if (!(now > 0n && now >= lockTimeThreshold)) throw new Failure("now must be a unix-ms timestamp");

    const nameLength = utf8(name).length;
    const price = paramsRegisterCost(this.params, nameLength, years);
    const expires = now + years * this.params.periodMs;
    const fields = nameFieldsFor(name, env.me, 0n, now, expires);
    const notes = [];
    const matureAt = commitUtxo.entry.blockDaaScore + this.params.tCommit;
    if (env.blockDaa < matureAt) {
      notes.push(`commit not mature yet: valid from DAA ${matureAt} (now ${env.blockDaa})`);
    }
    if (expires + this.params.graceMs < env.wallMs) {
      notes.push("backdated: this name is already past expiresAt + grace (reclaimable at once)");
    } else if (expires < env.wallMs) {
      notes.push("backdated: this name is already expired (in grace)");
    }
    const gapIn = this._gapInput(
      gap, "register",
      [argBytes(utf8(name)), argBytes(env.me), argBytes(commit.salt), argInt(now), argInt(years),
        argBytes(this.manifest.name.prefix), argBytes(this.manifest.name.suffix)],
      BudgetRole.gapRegister, "gap register",
    );
    const commitIn = plannedInput({
      utxo: commitUtxo, sequence: this.params.tCommit, unlock: { kind: "commit", redeem }, role: BudgetRole.commit, label: `commit for ${name}`,
    });
    const d = {
      op: `register ${name} (${years} period(s))`,
      inputs: [gapIn, commitIn],
      outputs: [
        { output: this._gapOutput(gap.lo, k), label: "gap (lo, key)" },
        { output: this._gapOutput(k, gap.hi), label: "gap (key, hi)" },
        { output: this._nameOutput(fields), label: `name ${name}` },
      ],
      lockTime: now,
      priceFee: price,
      notes,
      payload: namePayload("register", name),
    };
    return this._finish(d, wallet, { kind: "funded", maxInputs: maxInputsFeeEntry }, env);
  }

  /** Spend an unused commit back to its owner (the name was taken meanwhile, or the owner changed
   *  their mind): [commit (owner sig + redeem)] -> [P2PK(owner), the commit's value less the
   *  network fee]. No funding, no payload (the name stays hidden), sequence 0. */
  cancelCommit({ env, commit }) {
    if (!bytesEqual(commit.owner, env.me)) throw new Failure(`the commit for ${commit.name} is for another owner`);
    const u = commit.utxo;
    if (u == null) throw new Failure(`the commit for ${commit.name} is not on chain`);
    if (!(commit.salt instanceof Uint8Array) || commit.salt.length !== 32) throw new Failure("the salt is 32 bytes");
    const redeem = commitRedeem(commitment(commit.name, env.me, commit.salt), env.me);
    if (!bytesEqual(u.entry.script, p2shScript(redeem))) throw new Failure("commit UTXO script does not match the salt");
    if (u.entry.covenantId != null) throw new Failure("a commit carries no covenant id");
    const d = {
      op: `cancel commit ${commit.name}`,
      inputs: [plannedInput({ utxo: u, unlock: { kind: "commit", redeem }, role: BudgetRole.commit, label: `commit for ${commit.name} (owner sig)` })],
      outputs: [{ output: makeTxOutput({ value: 0n, script: p2pkScript(env.me) }), label: "back to the owner" }],
    };
    return this._finish(d, [], { kind: "fromOutput", index: 0, cap: null, floor: cancelFloorValue }, env);
  }

  // MARK: Name entries

  /** Anyone extends the current period (a gift needs no signature): [name.extend(years),
   *  funding] -> [continuation (periodStart kept, expiresAt + years periods), change]. Lock time
   *  0, every sequence 0. Valid any time while `expiresAt + years <= periodStart + maxYears` (in
   *  periods). Pays the renewal price per period (registry v4). */
  extend({ env, wallet, name: n, years }) {
    years = BigInt(years);
    this._checkYears(years);
    const nm = nameFieldsName(n.fields);
    this._checkLive(nm, n.utxo, this.params.bond, this.registryId);
    const f = n.fields;
    const room = paramsExtendableYearsOf(this.params, f);
    if (years > room) {
      throw new Failure(
        `extend ${nm} by ${years} period(s) refused: it may be paid at most ${this.params.maxYears} periods past ${f.periodStart} and it is `
          + `paid until ${f.expiresAt}, so ${room} can be added now; renew opens at ${paramsRenewOpens(this.params, f.expiresAt)}`,
      );
    }
    const price = paramsRenewPrice(this.params, utf8(nm).length) * years;
    const nf = nameFieldsExtended(f, years, this.params.periodMs);
    const d = {
      op: `extend ${nm} (${years} period(s))`,
      inputs: [this._nameInput(n, "extend", [argInt(years)], BudgetRole.nameExtend, `name extend(${years})`)],
      outputs: [{ output: this._nameOutput(nf), label: `name ${nm}` }],
      priceFee: price,
      notes: [
        `extension price ${kas(price)} left as miner fee`,
        `expiresAt ${f.expiresAt} -> ${nf.expiresAt}; periodStart ${f.periodStart} kept (at most ${this.params.maxYears} periods past it)`,
      ],
      payload: namePayload("extend", nm),
    };
    return this._finish(d, wallet, { kind: "funded", maxInputs: maxInputsFeeEntry }, env);
  }

  /** Anyone renews once the renewal window opened: [name.renew(years), funding] ->
   *  [continuation (periodStart = old expiresAt, expiresAt + years periods), change]. Pays the
   *  renewal price per period (registry v4). Lock time = `renewLockTime` (timestamp domain), every
   *  input sequence 0 (not final, as the CLTV needs). Before the window opens the plan is built
   *  but not valid (a note says so); the actions refuse to submit it. */
  renew({ env, wallet, name: n, years }) {
    years = BigInt(years);
    this._checkYears(years);
    const nm = nameFieldsName(n.fields);
    this._checkLive(nm, n.utxo, this.params.bond, this.registryId);
    const f = n.fields;
    const opens = paramsRenewOpens(this.params, f.expiresAt);
    if (!(opens >= 0n && opens >= lockTimeThreshold)) throw new Failure(`${nm}: expiresAt - renewWindowMs is not a timestamp`);
    const lock = renewLockTime(env, this.params, f.expiresAt);
    const price = paramsRenewPrice(this.params, utf8(nm).length) * years;
    const nf = nameFieldsRenewed(f, years, this.params.periodMs);
    const d = {
      op: `renew ${nm} (${years} period(s))`,
      inputs: [this._nameInput(n, "renew", [argInt(years)], BudgetRole.nameRenew, `name renew(${years})`)],
      outputs: [{ output: this._nameOutput(nf), label: `name ${nm}` }],
      lockTime: lock,
      priceFee: price,
      notes: [
        `renewal price ${kas(price)} left as miner fee`,
        `new period: periodStart ${f.periodStart} -> ${nf.periodStart} (the old expiry), expiresAt -> ${nf.expiresAt}`,
        `lock time ${lock} >= window opening expiresAt - renewWindowMs = ${opens}`,
      ],
      payload: namePayload("renew", nm),
    };
    if (!renewWindowOpen(env, this.params, f.expiresAt)) {
      d.notes.push(`renewal window not open: it opens at ${opens} (the network median time ${env.blockTimeMs} must pass it); use extend to add periods before`);
    }
    return this._finish(d, wallet, { kind: "funded", maxInputs: maxInputsFeeEntry }, env);
  }

  /** The owner transfers: new owner, listing cleared, period and expiry kept. */
  transfer({ env, wallet, name: n, newOwner }) {
    this._requireOwner(env, n);
    Builder._checkKey(newOwner, "the new owner");
    const nm = nameFieldsName(n.fields);
    this._checkLive(nm, n.utxo, this.params.bond, this.registryId);
    const d = {
      op: `transfer ${nm}`,
      inputs: [this._nameInput(n, "transfer", [argBytes(newOwner), argSignature()], BudgetRole.nameTransfer, "name transfer (owner sig)")],
      outputs: [{ output: this._nameOutput(nameFieldsWithOwner(n.fields, newOwner)), label: `name ${nm}` }],
      payload: namePayload("transfer", nm),
    };
    return this._finish(d, wallet, { kind: "funded", maxInputs }, env);
  }

  /** The owner lists at `price` sompi (0 = delist). */
  list({ env, wallet, name: n, price }) {
    price = BigInt(price);
    this._requireOwner(env, n);
    const nm = nameFieldsName(n.fields);
    this._checkLive(nm, n.utxo, this.params.bond, this.registryId);
    if (price < 0n || price > maxListPrice) throw new Failure("price above the supply");
    const d = {
      op: price === 0n ? `delist ${nm}` : `list ${nm} at ${kas(price)}`,
      inputs: [this._nameInput(n, "list", [argInt(price), argSignature()], BudgetRole.nameList, "name list (owner sig)")],
      outputs: [{ output: this._nameOutput(nameFieldsWithPrice(n.fields, price)), label: `name ${nm}` }],
      notes: [],
      payload: namePayload("list", nm),
    };
    if (n.fields.expiresAt <= env.wallMs) {
      d.notes.push("the name is expired: the app refuses to list a name in grace");
    }
    return this._finish(d, wallet, { kind: "funded", maxInputs }, env);
  }

  /** The signer buys a listed name: [name.buy(me), funding] -> [continuation, payout of the price
   *  to P2PK(owner) right after it, change]. */
  buy({ env, wallet, name: n }) {
    const nm = nameFieldsName(n.fields);
    this._checkLive(nm, n.utxo, this.params.bond, this.registryId);
    if (!(n.fields.price > 0n)) throw new Failure(`${nm} is not listed`);
    const d = {
      op: `buy ${nm} for ${kas(n.fields.price)}`,
      inputs: [this._nameInput(n, "buy", [argBytes(env.me)], BudgetRole.nameBuy, "name buy(me)")],
      outputs: [
        { output: this._nameOutput(nameFieldsWithOwner(n.fields, env.me)), label: `name ${nm}` },
        { output: makeTxOutput({ value: n.fields.price, script: p2pkScript(n.fields.owner) }), label: "payout to the seller" },
      ],
      notes: [],
      payload: namePayload("buy", nm),
    };
    // 30 days on a yearly clock, the renewal window on a short one (iOS 24d673a, IOS-060)
    if (n.fields.expiresAt - paramsExpiresSoonMs(this.params) < env.wallMs) {
      d.notes.push("expires soon: the buyer will have to renew it");
    }
    return this._finish(d, wallet, { kind: "funded", maxInputs }, env);
  }

  // MARK: Offers

  /** Lock `amount` sompi for the registered name `target` (a NameRecord), made to its current
   *  owner (registry v3: only that owner can accept or decline it, so a change of owner ends it),
   *  refundable by anyone from DAA `refundAfter`; the transaction carries the `kchat:1:offer:`
   *  marker (with the seller). Sets `plan.newOffer` (the offer to track once accepted). */
  offer({ env, wallet, target, amount, refundAfter }) {
    amount = BigInt(amount);
    refundAfter = BigInt(refundAfter);
    if (target == null || target.fields == null) throw new Failure("an offer is made on a registered name");
    const name = nameFieldsName(target.fields);
    validate(name);
    if (!(amount > this.params.offerMaxFee + minChange)) throw new Failure("offer too small");
    if (!(refundAfter < lockTimeThreshold)) throw new Failure("refundAfter is a DAA score");
    const fields = makeOfferFields({ key: nameKey(name), buyer: env.me, seller: target.fields.owner, refundAfter });
    const out = makeTxOutput({ value: amount, script: templateScript(this.manifest.offer, offerState(fields)) });
    const d = { op: `offer ${kas(amount)} on ${name}`, inputs: [], outputs: [{ output: out, label: "offer P2SH" }], notes: [] };
    if (target.fields.price > 0n && target.fields.price <= amount) {
      d.notes.push(`${name} is listed at or below this offer: buying it may be cheaper`);
    }
    d.payload = offerPayload(fields);
    const plan = this._finish(d, wallet, { kind: "funded", maxInputs }, env);
    const entry = makeUtxoEntry({ amount, script: out.script, blockDaaScore: 0n, covenantId: null });
    plan.newOffer = { fields, value: amount, utxo: makeUtxo(makeOutpoint(plan.txid, 0), entry), name };
    return plan;
  }

  /** The owner accepts: [name.transfer(buyer, sig), offer.accept(0, sellerSig)] -> [continuation
   *  to the buyer, payout to the owner = offer - fee (fee <= maxFee)]. Only an offer made to this
   *  owner (registry v3). */
  acceptOffer({ env, name: n, offer: o }) {
    this._requireOwner(env, n);
    const nm = nameFieldsName(n.fields);
    if (!bytesEqual(o.fields.seller, env.me)) throw new Failure(`that offer was made to an earlier owner of ${nm}`);
    this._checkLive(nm, n.utxo, this.params.bond, this.registryId);
    this._checkLive("offer", o.utxo, o.value, null);
    if (!bytesEqual(o.fields.key, n.fields.key)) throw new Failure("that offer is for another name");
    const d = {
      op: `accept offer ${kas(o.value)} on ${nm}`,
      inputs: [
        this._nameInput(n, "transfer", [argBytes(o.fields.buyer), argSignature()], BudgetRole.nameTransfer, "name transfer(buyer) (owner sig)"),
        this._offerInput(o, "accept", [argInt(0n), argSignature()], BudgetRole.offerAccept, "offer accept(0) (seller sig)"),
      ],
      outputs: [
        { output: this._nameOutput(nameFieldsWithOwner(n.fields, o.fields.buyer)), label: `name ${nm} -> buyer` },
        { output: makeTxOutput({ value: 0n, script: p2pkScript(n.fields.owner) }), label: "payout to the owner" },
      ],
      payload: namePayload("accept", nm),
    };
    return this._finish(d, [], { kind: "fromOutput", index: 1, cap: this.params.offerMaxFee }, env);
  }

  /** The seller turns an offer down (registry v3): [offer.decline(sellerSig)] alone -> [back to
   *  the buyer, the offer less the network fee (<= maxFee)]. */
  declineOffer({ env, offer: o }) {
    if (!bytesEqual(o.fields.seller, env.me)) throw new Failure("only the seller can decline this offer");
    this._checkLive("offer", o.utxo, o.value, null);
    const d = {
      op: `decline offer ${kas(o.value)}`,
      inputs: [this._offerInput(o, "decline", [argSignature()], BudgetRole.offerDecline, "offer decline (seller sig)")],
      outputs: [{ output: makeTxOutput({ value: 0n, script: p2pkScript(o.fields.buyer) }), label: "back to the buyer" }],
    };
    return this._finish(d, [], { kind: "fromOutput", index: 0, cap: this.params.offerMaxFee }, env);
  }

  /** The buyer takes the offer back. */
  withdrawOffer({ env, offer: o }) {
    if (!bytesEqual(o.fields.buyer, env.me)) throw new Failure("only the buyer can withdraw this offer");
    this._checkLive("offer", o.utxo, o.value, null);
    const d = {
      op: `withdraw offer ${kas(o.value)}`,
      inputs: [this._offerInput(o, "withdraw", [argSignature()], BudgetRole.offerWithdraw, "offer withdraw (buyer sig)")],
      outputs: [{ output: makeTxOutput({ value: 0n, script: p2pkScript(o.fields.buyer) }), label: "back to the buyer" }],
    };
    return this._finish(d, [], { kind: "fromOutput", index: 0, cap: null }, env);
  }

  /** Anyone refunds once DAA > refundAfter: 1 input, 1 output, lock time = refundAfter. */
  refundOffer({ env, offer: o }) {
    this._checkLive("offer", o.utxo, o.value, null);
    const d = {
      op: `refund offer ${kas(o.value)}`,
      inputs: [this._offerInput(o, "refund", [], BudgetRole.offerRefund, "offer refund()")],
      outputs: [{ output: makeTxOutput({ value: 0n, script: p2pkScript(o.fields.buyer) }), label: "refund to the buyer" }],
      lockTime: o.fields.refundAfter,
      notes: [],
    };
    if (env.blockDaa <= o.fields.refundAfter) {
      d.notes.push(`not refundable yet: the virtual DAA must pass ${o.fields.refundAfter} (now ${env.blockDaa})`);
    }
    return this._finish(d, [], { kind: "fromOutput", index: 0, cap: this.params.offerMaxFee }, env);
  }

  // MARK: The exit

  _exitChecks(x) {
    const k = x.name.fields.key;
    const nm = nameFieldsName(x.name.fields);
    if (!bytesEqual(x.below.hi, k) || !bytesEqual(x.above.lo, k)) throw new Failure(`the gaps do not sit on ${nm}`);
    this._checkLive("lower gap", x.below.utxo, this.params.gapValue, this.registryId);
    this._checkLive(nm, x.name.utxo, this.params.bond, this.registryId);
    this._checkLive("upper gap", x.above.utxo, this.params.gapValue, this.registryId);
  }

  /** The owner releases: [merge, release(sig), absorbed] -> [merged gap, bond + gap value - fee]. */
  release({ env, parts: x }) {
    this._requireOwner(env, x.name);
    this._exitChecks(x);
    const nm = nameFieldsName(x.name.fields);
    const d = {
      op: `release ${nm}`,
      inputs: [
        this._gapInput(x.below, "merge", [], BudgetRole.gapMerge, "gap merge"),
        this._nameInput(x.name, "release", [argSignature()], BudgetRole.nameRelease, "name release (owner sig)"),
        this._gapInput(x.above, "absorbed", [], BudgetRole.gapAbsorbed, "gap absorbed"),
      ],
      outputs: [
        { output: this._gapOutput(x.below.lo, x.above.hi), label: "merged gap" },
        { output: makeTxOutput({ value: 0n, script: p2pkScript(env.me) }), label: "bond + freed gap value - fee" },
      ],
      payload: namePayload("release", nm),
    };
    return this._finish(d, [], { kind: "fromOutput", index: 1, cap: null }, env);
  }

  /** Anyone reclaims a lapsed name: [merge, reclaim(), absorbed] -> [merged gap, the bond to the
   *  last owner, the caller's bounty]; lock time = expiresAt + grace (unix ms). */
  reclaim({ env, parts: x }) {
    this._exitChecks(x);
    const nm = nameFieldsName(x.name.fields);
    const unlock = x.name.fields.expiresAt + this.params.graceMs;
    if (!(unlock > 0n && unlock >= lockTimeThreshold)) throw new Failure("expiresAt + grace is not a timestamp");
    const d = {
      op: `reclaim ${nm}`,
      inputs: [
        this._gapInput(x.below, "merge", [], BudgetRole.gapMerge, "gap merge"),
        this._nameInput(x.name, "reclaim", [], BudgetRole.nameReclaim, "name reclaim()"),
        this._gapInput(x.above, "absorbed", [], BudgetRole.gapAbsorbed, "gap absorbed"),
      ],
      outputs: [
        { output: this._gapOutput(x.below.lo, x.above.hi), label: "merged gap" },
        { output: makeTxOutput({ value: this.params.bond, script: p2pkScript(x.name.fields.owner) }), label: "bond to the last owner" },
        { output: makeTxOutput({ value: 0n, script: p2pkScript(env.me) }), label: "bounty (caller)" },
      ],
      lockTime: unlock,
      notes: [],
      payload: namePayload("reclaim", nm),
    };
    if (env.blockTimeMs <= unlock) {
      d.notes.push("not reclaimable yet: the virtual median time must pass expiresAt + grace");
    }
    return this._finish(d, [], { kind: "fromOutput", index: 2, cap: null }, env);
  }
}
