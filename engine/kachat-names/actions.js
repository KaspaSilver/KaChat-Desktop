// .kachat names: every operation the screens offer, and the resumable registration.
//
// Port of iOS KaChat/Services/KachatNames/KachatNamesActions.swift. Each operation is built with
// the pure builders (builder.js) over UTXOs re-read from a node (registry ones with the registry
// covenant id), at max(100, the REST API's priority fee rate), signed with the wallet key and
// submitted (service.js); it returns the txid and refreshes the registry once the REST API reports
// the transaction accepted. `plan(op)` builds the same transaction without sending it (the sheets).
// The registration is commit -> wait tCommit (+20) DAA -> register, driven automatically and
// resumable (records in localStorage, per wallet). Testnet-10 only.
//
// Nothing runs at import. The app wires ONE shared registry (registry.js) and one service:
//
//   const service = new KachatNamesService(engine);
//   const registry = new KachatNamesRegistry({ ..., getUtxosByAddresses: (a) => engine.utxosForRegistry(a) });
//   const actions = new KachatNamesActions({ engine, service, registry });
//   actions.subscribe(({ pending, virtualDaa }) => render());
//   actions.resume();   // on show and when the app becomes active / the wallet changes
//
// Amounts, prices, DAA scores and years passed in are BigInt (Numbers are accepted and converted).
// Registration records are plain JSON-safe objects (see PendingRegistration below).

import { secp256k1 } from "@noble/curves/secp256k1.js";

import { getEndpoint } from "../endpoints.js";
import { enqueueSend, excludeReservedUtxos } from "../transactions.js";
import {
  Failure, minFeerate, minChange, commitValue, hex, unhex, unhex32, bytesEqual, concat, utf8, normalize, validate,
  gapState, nameState, offerState,
} from "./codec.js";
import { makeOutpoint, makeUtxo, makeUtxoEntry, outpointKey } from "./transaction.js";
import { templateScript, paramsPrice } from "./manifest.js";
import { registerNow, renewWindowOpen } from "./builder.js";
import { keyOf } from "./registry.js";
import { OfferInfo, Profile, Status } from "./registry-state.js";
import { KachatNamesService, xonlyKey, fundingUtxos, newSalt, profileRecordPayload } from "./service.js";

// MARK: - Registration records

/** Swift `KachatNames.PendingRegistration.Stage`. */
export const Stage = Object.freeze({
  /** the commit transaction was built and is being submitted */
  committing: "committing",
  /** the commit is on chain (or about to be); waiting until it is `tCommit` deep */
  waiting: "waiting",
  /** the registration was submitted */
  registering: "registering",
  registered: "registered",
  /** someone registered the name first; the commit can be cancelled */
  taken: "taken",
  failed: "failed",
  cancelling: "cancelling",
  cancelled: "cancelled",
});

/**
 * A registration in flight (Swift `PendingRegistration`), JSON-safe:
 * `{ id, name, years: Number, owner: x-only hex, commitTxId: hex, commitScript: hex (P2SH),
 *    commitDaa: Number|null (the commit UTXO's DAA score once seen), registerTxId: hex|null,
 *    cancelTxId: hex|null, stage: Stage, createdAt: Number (unix ms), updatedAt: Number,
 *    lastError: string|null }`.
 * The stored copy also carries `salt` (hex) - iOS keeps it in the Keychain; `pending` never
 * exposes it.
 */

/** Still shown on the hub. */
export function isOpen(p) { return p.stage !== Stage.cancelled; }
/** The driver has work to do. */
export function needsDriving(p) {
  return [Stage.committing, Stage.waiting, Stage.registering, Stage.cancelling].includes(p.stage);
}

/** The localStorage key of the registrations: `{ [wallet address]: PendingRegistration[] }` (with salts). */
export const registrationsStorageKey = "kachat-names-registrations-testnet-v1";

// MARK: - Errors

/** A unix-ms day ("Oct 12, 2027") in `locale` (default: the runtime's), Swift
 *  `KachatNamesActions.dayString` (DateFormatter, medium date style, no time). */
export function dayString(ms, locale = undefined) {
  const d = new Date(Number(ms));
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(d);
  } catch {
    return d.toDateString();
  }
}

/** Swift `KachatNamesActions.ActionError`; `code` is the case name. Extra fields per case:
 *  renewalNotOpen `{ opensMs }`, periodFull `{ renewalOpensMs }` (unix ms, BigInt). */
export class ActionError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = "ActionError";
    this.code = code;
    Object.assign(this, extra);
  }

  static noWallet() { return new ActionError("noWallet", "No testnet wallet is open."); }
  static keyMismatch() { return new ActionError("keyMismatch", "This wallet's key does not match its address."); }
  static invalidKey(what) { return new ActionError("invalidKey", `${what} is not a valid key (not on the secp256k1 curve).`); }
  static noSalt() { return new ActionError("noSalt", "The secret for this registration is missing on this device."); }
  static notRegisterable(why) { return new ActionError("notRegisterable", why); }
  /** renew before its window: the network's time has not reached `expiresAt - renewWindowMs` */
  static renewalNotOpen(opensMs) {
    return new ActionError("renewalNotOpen", `Renewal opens on ${dayString(opensMs)}`, { opensMs: BigInt(opensMs) });
  }
  /** extend past `periodStart + maxYears` */
  static periodFull(renewalOpensMs) {
    return new ActionError(
      "periodFull",
      `This name is already paid for 2 years from the start of its period. Renewal opens on ${dayString(renewalOpensMs)}.`,
      { renewalOpensMs: BigInt(renewalOpensMs) },
    );
  }
  /** the record has no periodStart (an indexer without the field), so its state is unknown */
  static periodUnknown() {
    return new ActionError("periodUnknown", "The names indexer didn't send this name's paid period. Pull to refresh and try again.");
  }
}

// MARK: - Operations

/** Swift `KachatNamesActions.Operation`: `{ kind, ... }`. `name` is a NameInfo, `offer` an
 *  OfferInfo (registry-state.js), except `offer`'s `name` (a plain string). */
export const Operation = Object.freeze({
  /** add years to the current paid period (anyone, any time, up to 2 years past periodStart) */
  extend: (name, years) => ({ kind: "extend", name, years: BigInt(years) }),
  /** start the next period at the current expiry (anyone, once the renewal window opened) */
  renew: (name, years) => ({ kind: "renew", name, years: BigInt(years) }),
  transfer: (name, to) => ({ kind: "transfer", name, to }),
  /** price 0 delists */
  list: (name, price) => ({ kind: "list", name, price: BigInt(price) }),
  buy: (name) => ({ kind: "buy", name }),
  offer: (name, amount, refundAfterDaa, target = null) => ({ kind: "offer", name, amount: BigInt(amount), refundAfterDaa: BigInt(refundAfterDaa), target }),
  withdraw: (offer) => ({ kind: "withdraw", offer }),
  refund: (offer) => ({ kind: "refund", offer }),
  accept: (offer, name) => ({ kind: "accept", offer, name }),
  release: (name) => ({ kind: "release", name }),
  reclaim: (name) => ({ kind: "reclaim", name }),
});

/** A key a name or an offer will be locked to must be a point on the curve: the contracts cannot
 *  check it, and an invalid owner locks a name until it lapses. */
export function validateKey(xonly, what) {
  if (!(xonly instanceof Uint8Array) || xonly.length !== 32 || xonly.every((b) => b === 0)) throw ActionError.invalidKey(what);
  try {
    secp256k1.Point.fromBytes(concat([0x02], xonly)).assertValidity();
  } catch {
    throw ActionError.invalidKey(what);
  }
}

const nowMs = () => Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errorMessage = (e) => (e && typeof e === "object" && "message" in e ? String(e.message) : String(e));

function trimSlash(s) {
  const t = String(s ?? "").trim();
  return t.endsWith("/") ? t.slice(0, -1) : t;
}

function publicRecord(r) {
  const { salt: _salt, ...rest } = r;
  return { ...rest };
}

// MARK: - Actions

export class KachatNamesActions {
  /** `engine`: the KaspaEngine; `service`: a KachatNamesService (made from the engine when
   *  omitted); `registry`: the app's shared KachatNamesRegistry (registry.js), required.
   *  `storage`: `{ get(key) -> string|null, set(key, string) }` (default localStorage). */
  constructor({ engine, service = null, registry, storage = null } = {}) {
    if (!registry) throw new Failure("KachatNamesActions needs the app's registry");
    this.engine = engine;
    this.service = service ?? new KachatNamesService(engine);
    this.registry = registry;
    this.storage = storage ?? defaultStorage();
    /** this wallet's registrations (no salts), in creation order */
    this._pending = [];
    /** the virtual DAA score (BigInt) the driver last saw, or null */
    this.virtualDaa = null;
    this._pendingWallet = null;
    this._driver = null;
    this._listeners = new Set();
  }

  // MARK: Observing (Swift @Published pending / virtualDaa)

  /** This wallet's registrations, newest last (copies, without salts). */
  get pending() { return this._pending.map(publicRecord); }

  /** `listener({ pending, virtualDaa })` after every change; returns an unsubscribe function. */
  subscribe(listener) {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  _emit() {
    const snapshot = { pending: this.pending, virtualDaa: this.virtualDaa };
    for (const l of [...this._listeners]) {
      try { l(snapshot); } catch (e) { this.engine?.log?.("[KachatNames] listener failed:", errorMessage(e)); }
    }
  }

  _setVirtualDaa(daa) {
    if (daa == null) return;
    const v = BigInt(daa);
    if (this.virtualDaa === v) return;
    this.virtualDaa = v;
    this._emit();
  }

  // MARK: Wallet

  /** The current wallet's testnet address, key and x-only key (they must agree):
   *  `{ address, privateKey: hex, me: Uint8Array(32) }`. */
  signer() {
    this.service.requireTestnet();
    const address = String(this.engine?.address ?? "").toLowerCase();
    const key = this.engine?.privateKeyHex;
    if (!address.startsWith("kaspatest:") || !key) throw ActionError.noWallet();
    const me = xonlyKey(key);
    if (!bytesEqual(keyOf(address), me)) throw ActionError.keyMismatch();
    return { address, privateKey: key, me };
  }

  /** The current wallet's x-only key, without touching the private key (null when none). */
  get myKey() {
    const address = this.engine?.address;
    return address ? keyOf(address) : null;
  }

  get myAddress() {
    const a = this.engine?.address;
    return a ? String(a).toLowerCase() : null;
  }

  static validateKey(xonly, what) { return validateKey(xonly, what); }

  /** `max(100, the REST API's priority fee rate)` in sompi per gram (a Number). */
  async feerate() {
    try {
      const base = trimSlash(getEndpoint("kaspaApi"));
      const res = await fetch(`${base}/info/fee-estimate`, { headers: { Accept: "application/json" }, cache: "no-store" });
      if (res.status !== 200) return minFeerate;
      const j = await res.json();
      const rate = Number(j?.priorityBucket?.feerate);
      return Number.isFinite(rate) ? Math.max(minFeerate, rate) : minFeerate;
    } catch {
      return minFeerate;
    }
  }

  /** The wallet's node UTXOs (with covenant ids), less coins a scheduled KaPost reserved. */
  async _walletUtxos(address) {
    return excludeReservedUtxos(await this.engine.getUtxosWithCovenants([address]));
  }

  /** Builder, environment and the wallet's funding UTXOs for one transaction. */
  async _context(s) {
    const builder = await this.service.builder();
    const env = await this.service.environment({ privateKey: s.privateKey, feerate: await this.feerate() });
    this._setVirtualDaa(env.blockDaa);
    const utxos = await this._walletUtxos(s.address);
    const funding = fundingUtxos(utxos, { me: s.me, virtualDaaScore: env.blockDaa });
    return { builder, env, wallet: funding };
  }

  /** Reads the virtual DAA score (for "refundable now" on offers). */
  async refreshVirtualDaa() {
    const daa = await this.engine.currentVirtualDaaScore();
    if (daa != null) this._setVirtualDaa(daa);
    return this.virtualDaa;
  }

  /** What the wallet can spend on names right now (sompi, BigInt). */
  async spendable() {
    const s = this.signer();
    const utxos = await this._walletUtxos(s.address);
    const daa = (await this.engine.currentVirtualDaaScore()) ?? 0n;
    return fundingUtxos(utxos, { me: s.me, virtualDaaScore: daa }).reduce((a, u) => a + u.entry.amount, 0n);
  }

  // MARK: Live records

  async _liveName(n, m) {
    const fields = n.fields;
    if (fields == null) throw ActionError.periodUnknown();
    const u = await this.service.liveRegistryUtxo({ script: templateScript(m.name, nameState(fields)), outpoint: n.outpoint });
    return { fields, value: u.entry.amount, utxo: u };
  }

  async _liveGap(g, m) {
    const u = await this.service.liveRegistryUtxo({ script: templateScript(m.gap, gapState(g.lo, g.hi)), outpoint: g.outpoint });
    return { lo: g.lo, hi: g.hi, value: u.entry.amount, utxo: u };
  }

  async _liveOffer(o, m) {
    const u = await this.service.liveUtxo({ script: templateScript(m.offer, offerState(o.fields)), outpoint: o.outpoint });
    return { fields: o.fields, value: u.entry.amount, utxo: u, name: o.name ?? null };
  }

  // MARK: Operations

  /** Builds `op` against live UTXOs without submitting anything: the fee and outputs a sheet shows
   *  before the person confirms. Returns the builder's Plan (plan.fee, plan.priceFee,
   *  plan.networkFee, plan.outputs, plan.notes, plan.txid...). */
  async plan(op) {
    const s = this.signer();
    return (await this._build(op, s)).plan;
  }

  async _build(op, s) {
    const m = await this.registry.prepare();
    const { builder: b, env, wallet } = await this._context(s);
    let plan;
    switch (op.kind) {
      case "extend": {
        const years = BigInt(op.years);
        if (op.name.periodStart == null) throw ActionError.periodUnknown();
        if (years < 1n || years > op.name.extendableYears(m.params)) throw ActionError.periodFull(op.name.renewOpens(m.params));
        plan = b.extend({ env, wallet, name: await this._liveName(op.name, m), years });
        break;
      }
      case "renew":
        // Valid only once the network's median time passes the window opening (the mempool keeps
        // no future-dated transactions): refuse before, and say when it opens.
        if (!renewWindowOpen(env, m.params, op.name.expiresAt)) throw ActionError.renewalNotOpen(op.name.renewOpens(m.params));
        plan = b.renew({ env, wallet, name: await this._liveName(op.name, m), years: BigInt(op.years) });
        break;
      case "transfer":
        validateKey(op.to, "The new owner");
        plan = b.transfer({ env, wallet, name: await this._liveName(op.name, m), newOwner: op.to });
        break;
      case "list": {
        const price = BigInt(op.price);
        if (price > 0n && op.name.status(m.params.graceMs, BigInt(nowMs())) !== Status.active) {
          throw ActionError.notRegisterable("An expired name can't be listed. Renew it first.");
        }
        plan = b.list({ env, wallet, name: await this._liveName(op.name, m), price });
        break;
      }
      case "buy":
        validateKey(env.me, "Your key");
        plan = b.buy({ env, wallet, name: await this._liveName(op.name, m) });
        break;
      case "offer":
        validateKey(env.me, "Your key");
        // as Swift: the target only fed the builder's notes, and is not passed on
        plan = b.offer({ env, wallet, name: op.name, amount: BigInt(op.amount), refundAfter: BigInt(op.refundAfterDaa) });
        break;
      case "withdraw":
        plan = b.withdrawOffer({ env, offer: await this._liveOffer(op.offer, m) });
        break;
      case "refund":
        plan = b.refundOffer({ env, offer: await this._liveOffer(op.offer, m) });
        break;
      case "accept":
        validateKey(op.offer.buyer, "The buyer");
        plan = b.acceptOffer({ env, name: await this._liveName(op.name, m), offer: await this._liveOffer(op.offer, m) });
        break;
      case "release":
      case "reclaim": {
        const gaps = await this.registry.exitGaps(op.name);
        const parts = { below: await this._liveGap(gaps.below, m), name: await this._liveName(op.name, m), above: await this._liveGap(gaps.above, m) };
        plan = op.kind === "release" ? b.release({ env, parts }) : b.reclaim({ env, parts });
        break;
      }
      default:
        throw new Failure(`unknown operation ${op?.kind}`);
    }
    return { plan, env };
  }

  /** Builds, signs and submits `op`; returns the txid. The registry refreshes once the
   *  transaction is accepted. Runs in the engine's per-address send queue, so a chat message sent
   *  meanwhile cannot pick the same coin. */
  async perform(op) {
    const s = this.signer();
    const { plan, txId } = await enqueueSend(s.address, async () => {
      const { plan: p, env } = await this._build(op, s);
      return { plan: p, txId: await this.service.signAndSubmit(p, { privateKey: s.privateKey, env }) };
    });
    if (op.kind === "offer" && plan.newOffer) {
      const o = plan.newOffer;
      await this.registry.trackOffer(new OfferInfo({
        outpoint: o.utxo.outpoint, key: o.fields.key, name: o.name, buyer: o.fields.buyer,
        amount: o.value, refundAfter: o.fields.refundAfter, createdAt: BigInt(nowMs()),
      }));
    }
    this.registry.refreshAfter(txId);
    return txId;
  }

  // MARK: Profile record

  /** Writes the address profile (`kchat:1:profile:`): a self-transfer, network fee only.
   *  `profile`: a Profile (registry-state.js) or its plain fields. Returns the txid. */
  /** What saving `profile` will cost (iOS profileFee): the profile record is a self-transfer from
   *  the chatting address, so the network fee is all it spends. Estimated the way the save builds
   *  it (plain coins only, same payload), never sent. BigInt sompi. */
  async profileFee(profile) {
    const s = this.signer();
    const clean = (profile instanceof Profile ? profile : new Profile(profile ?? {})).sanitized();
    const payload = profileRecordPayload(clean.recordJSON());
    const utxos = await this.engine.getUtxosWithCovenants([s.address]);
    const plain = utxos.filter((u) => u.covenantId == null);
    if (!plain.length) throw new ActionError("noFunds", "No spendable coins without a covenant.");
    const selected = plain.length === utxos.length ? null : plain.map((u) => `${u.outpoint.transactionId}:${u.outpoint.index}`);
    const fee = await this.engine.estimatePayloadFeeSompi(payload.length, selected);
    if (fee == null) throw new ActionError("noQuote", "Couldn't estimate the network fee.");
    return BigInt(fee);
  }

  async saveProfile(profile) {
    const s = this.signer();
    const clean = (profile instanceof Profile ? profile : new Profile(profile ?? {})).sanitized();
    const json = clean.recordJSON();
    const txId = await this.service.submitProfileRecord({ address: s.address, json });
    await this.registry.noteOwnProfile(clean, s.address, txId);
    this.registry.refreshAfter(txId);
    return txId;
  }

  // MARK: Registration

  /** The cost of registering `name` for `years` inside `gap` (a GapInfo), estimated by building
   *  both transactions (nothing is signed or sent). Amounts are BigInt sompi:
   *  `{ name, years, price (price per year x years, left to miners), bond (returned on release),
   *  gapDeposit (the extra gap the registration creates, returned on release), commit (the
   *  commit's value, returned into the registration), networkFee, total (what leaves the wallet in
   *  the end: price + bond + gap deposit + network fees), spendable, affordable }`. */
  async quote({ name, years, gap }) {
    const s = this.signer();
    years = BigInt(years);
    const m = await this.registry.prepare();
    const { builder: b, env, wallet } = await this._context(s);
    const salt = newSalt();
    const spendable = wallet.reduce((a, u) => a + u.entry.amount, 0n);
    const price = paramsPrice(m.params, utf8(name).length) * years;
    let commitFee = 0n;
    let registerFee = 0n;
    try {
      const commitPlan = b.commit({ env, wallet, name, salt });
      commitFee = commitPlan.networkFee;
      // the registration, with the commit as if it were already mature and the gap as known
      const c = commitPlan.newCommit;
      if (c && c.utxo) {
        const matureDaa = env.blockDaa > m.params.tCommit ? env.blockDaa - m.params.tCommit : 0n;
        const commit = { ...c, utxo: makeUtxo(c.utxo.outpoint, { ...c.utxo.entry, blockDaaScore: matureDaa }) };
        const gapUtxo = makeUtxo(gap.outpoint, makeUtxoEntry({
          amount: m.params.gapValue, script: templateScript(m.gap, gapState(gap.lo, gap.hi)),
          blockDaaScore: env.blockDaa, covenantId: m.registryCovenantId,
        }));
        const used = new Set(commitPlan.inputs.map((i) => outpointKey(i.utxo.outpoint)));
        const rest = wallet.filter((u) => !used.has(outpointKey(u.outpoint)));
        try {
          const reg = b.register({
            env, wallet: rest, gap: { lo: gap.lo, hi: gap.hi, value: m.params.gapValue, utxo: gapUtxo },
            commit, years, now: registerNow(env),
          });
          registerFee = reg.networkFee;
        } catch { /* estimated below */ }
      }
    } catch { /* estimated below */ }
    if (registerFee === 0n) registerFee = 400_000n;
    if (commitFee === 0n) commitFee = 250_000n;
    const fee = commitFee + registerFee;
    const total = price + m.params.bond + m.params.gapValue + fee;
    return {
      name, years, price, bond: m.params.bond, gapDeposit: m.params.gapValue, commit: commitValue,
      networkFee: fee, total, spendable, affordable: spendable >= total + minChange,
    };
  }

  /** Starts registering `name`: a fresh salt (stored with the record), the salted commit
   *  (submitted), then the driver registers once the commit is `tCommit` deep. Returns the commit
   *  txid. Progress arrives through `subscribe` (the record's `stage`). */
  async startRegistration({ name: raw, years }) {
    const s = this.signer();
    years = BigInt(years);
    const name = normalize(raw);
    validate(name);
    await this.registry.refresh();
    const found = await this.registry.lookup(name);
    if (found.kind === "registered") throw ActionError.notRegisterable(`${name}.kachat is already registered.`);
    this._loadPending(s.address);
    let record = null;
    try {
      await enqueueSend(s.address, async () => {
        const { builder: b, env, wallet } = await this._context(s);
        const salt = newSalt();
        const plan = b.commit({ env, wallet, name, salt });
        const commit = plan.newCommit;
        const script = commit?.utxo?.entry?.script;
        if (!commit || !script) throw new Failure("commit: no record");
        const now = nowMs();
        record = {
          id: newId(), name, years: Number(years), owner: hex(s.me), commitTxId: hex(plan.txid),
          commitScript: hex(script), commitDaa: null, registerTxId: null, cancelTxId: null,
          stage: Stage.committing, createdAt: now, updatedAt: now, lastError: null, salt: hex(salt),
        };
        this._upsert(record);
        const txId = await this.service.signAndSubmit(plan, { privateKey: s.privateKey, env });
        record = { ...record, commitTxId: txId, stage: Stage.waiting, updatedAt: nowMs() };
        this._upsert(record);
      });
    } catch (error) {
      // The node may still have taken it: keep the record (and the salt) until the driver sees
      // the commit on chain or gives up on it.
      if (record) {
        this._upsert({ ...(this._find(record.id) ?? record), lastError: errorMessage(error), updatedAt: nowMs() });
        this._startDriver();
      }
      throw error;
    }
    this._startDriver();
    return record.commitTxId;
  }

  /** Spends the commit back (the name was taken, or the person changed their mind). `p` is a
   *  record from `pending` (or its id). Returns the cancel txid. */
  async cancel(p) {
    const s = this.signer();
    const stored = this._find(typeof p === "string" ? p : p.id);
    if (!stored) throw new Failure("no such registration");
    if (!stored.salt) throw ActionError.noSalt();
    const salt = unhex32(stored.salt);
    const txId = await enqueueSend(s.address, async () => {
      const b = await this.service.builder();
      const env = await this.service.environment({ privateKey: s.privateKey, feerate: await this.feerate() });
      const commitUtxo = await this.service.liveUtxo({ script: unhex(stored.commitScript), outpoint: commitOutpoint(stored) });
      const plan = b.cancelCommit({ env, commit: { name: stored.name, owner: s.me, salt, value: commitUtxo.entry.amount, utxo: commitUtxo } });
      return this.service.signAndSubmit(plan, { privateKey: s.privateKey, env });
    });
    this._set(stored, (q) => { q.cancelTxId = txId; q.stage = Stage.cancelling; });
    this._startDriver();
    return txId;
  }

  /** Try a failed registration again. */
  retry(p) {
    const stored = this._find(typeof p === "string" ? p : p.id);
    if (!stored) return;
    this._set(stored, (q) => { q.stage = Stage.waiting; q.lastError = null; });
    this._startDriver();
  }

  /** Drop a finished (registered or cancelled) registration from the list. */
  dismiss(p) {
    if (!this._pendingWallet) return;
    this._remove(typeof p === "string" ? p : p.id);
  }

  /** Loads the current wallet's registrations and drives the open ones. Call on appear, when the
   *  app becomes active and after a wallet switch. */
  resume() {
    const address = this.myAddress;
    if (!KachatNamesService.isEnabled || !address) {
      this._stopDriver();
      this._pending = [];
      this._pendingWallet = null;
      this._emit();
      return;
    }
    this._loadPending(address);
    this._startDriver();
  }

  /** Stops the driver (logout, network switch); `resume()` starts it again. */
  stop() { this._stopDriver(); }

  // MARK: Driver

  _stopDriver() {
    if (this._driver) this._driver.cancelled = true;
    this._driver = null;
  }

  _startDriver() {
    if (this._driver || !this._pending.some(needsDriving)) return;
    const token = { cancelled: false };
    this._driver = token;
    (async () => {
      try {
        while (!token.cancelled) {
          const address = this.myAddress;
          // the driver stops while the registry is being upgraded (a registry v1 manifest)
          if (!KachatNamesService.isEnabled || !address || address !== this._pendingWallet || this.service.registryUpgrading
            || !this._pending.some(needsDriving)) break;
          for (const p of this._pending.filter(needsDriving)) {
            if (token.cancelled) break;
            try { await this._advance(p); } catch (e) { this.engine?.log?.("[KachatNames] driver step failed:", errorMessage(e)); }
          }
          await sleep(5_000);
        }
      } finally {
        if (this._driver === token) this._driver = null;
      }
    })();
  }

  /** The commit UTXO when a node has it (null when spent or not yet accepted). */
  async _liveCommit(p) {
    try {
      return await this.service.liveUtxo({ script: unhex(p.commitScript), outpoint: commitOutpoint(p) });
    } catch {
      return null;
    }
  }

  /** One step of one registration. */
  async _advance(p) {
    const age = nowMs() - p.createdAt;
    const sinceUpdate = nowMs() - p.updatedAt;
    switch (p.stage) {
      case Stage.committing:
      case Stage.waiting: {
        const commit = await this._liveCommit(p);
        if (!commit) {
          if (p.commitDaa == null && age < 10 * 60_000) return;
          // the commit is gone: registered by us (another device?), or never confirmed
          if (await this._ownsName(p.name)) {
            this._finishRegistered(p);
          } else {
            const why = p.commitDaa == null ? "The commit never reached the chain." : "The commit is no longer on chain.";
            this._set(p, (q) => { q.stage = Stage.failed; q.lastError = why; });
          }
          return;
        }
        const commitDaa = Number(commit.entry.blockDaaScore);
        if (p.commitDaa !== commitDaa || p.stage === Stage.committing) {
          this._set(p, (q) => { q.commitDaa = commitDaa; q.stage = Stage.waiting; });
        }
        let m = this.service.manifest;
        if (!m) {
          try { m = await this.service.loadManifest(); } catch { return; }
        }
        let daa;
        try { daa = (await this.engine.currentDagPoint()).virtualDaaScore; } catch { return; }
        this._setVirtualDaa(daa);
        // a little past maturity, so the block that takes it is surely deep enough
        if (daa < commit.entry.blockDaaScore + m.params.tCommit + 20n) return;
        await this._register(this._find(p.id) ?? p, commit);
        return;
      }
      case Stage.registering: {
        if (p.registerTxId && await this.registry.isAccepted(p.registerTxId)) {
          await this.registry.refresh();
          if (await this._ownsName(p.name)) this._finishRegistered(p);
          return;
        }
        // not accepted after two minutes and the commit is still there: register again
        if (sinceUpdate > 120_000 && await this._liveCommit(p)) {
          this._set(p, (q) => { q.stage = Stage.waiting; q.registerTxId = null; });
        }
        return;
      }
      case Stage.cancelling: {
        if (p.cancelTxId && await this.registry.isAccepted(p.cancelTxId)) {
          this._finishCancelled(p);
        } else if (sinceUpdate > 120_000 && !(await this._liveCommit(p))) {
          this._finishCancelled(p);
        }
        return;
      }
      default:
        return;
    }
  }

  async _ownsName(name) {
    const me = this.myKey;
    if (!me) return false;
    try {
      const r = await this.registry.lookup(name);
      return r.kind === "registered" && bytesEqual(r.info.owner, me);
    } catch {
      return false;
    }
  }

  async _register(p, commit) {
    try {
      const s = this.signer();
      if (hex(s.me) !== p.owner) return;
      if (!p.salt) throw ActionError.noSalt();
      const salt = unhex32(p.salt);
      await this.registry.refresh();
      const m = await this.registry.prepare();
      const found = await this.registry.lookup(p.name);
      if (found.kind === "registered") {
        if (bytesEqual(found.info.owner, s.me)) this._finishRegistered(p);
        else this._set(p, (q) => { q.stage = Stage.taken; q.lastError = null; });
        return;
      }
      if (!found.gap) throw new Failure(`no gap for ${p.name} yet`);
      const gap = found.gap;
      const txId = await enqueueSend(s.address, async () => {
        const { builder: b, env, wallet } = await this._context(s);
        const plan = b.register({
          env, wallet, gap: await this._liveGap(gap, m),
          commit: { name: p.name, owner: s.me, salt, value: commit.entry.amount, utxo: commit },
          years: BigInt(p.years), now: registerNow(env),
        });
        return this.service.signAndSubmit(plan, { privateKey: s.privateKey, env });
      });
      this._set(p, (q) => { q.stage = Stage.registering; q.registerTxId = txId; q.lastError = null; });
      this.registry.refreshAfter(txId);
    } catch (error) {
      const message = errorMessage(error);
      this.engine?.log?.(`[KachatNames] register ${p.name} failed: ${message}`);
      // funds and a missing salt need the person; anything else (a gap that just moved, a node
      // hiccup) is retried on the next tick
      const fatal = message.includes("insufficient funds") || error instanceof ActionError;
      this._set(p, (q) => {
        q.lastError = message;
        if (fatal) q.stage = Stage.failed;
      });
    }
  }

  _finishRegistered(p) {
    // the salt is no longer needed once the name is ours (iOS deletes it from the Keychain)
    this._set(p, (q) => { q.stage = Stage.registered; q.lastError = null; q.salt = null; });
  }

  _finishCancelled(p) {
    this._set(p, (q) => { q.stage = Stage.cancelled; q.lastError = null; q.salt = null; });
    if (this._pendingWallet) this._remove(p.id);
  }

  // MARK: Persistence (localStorage "kachat-names-registrations-testnet-v1", per wallet)

  _find(id) { return this._pending.find((x) => x.id === id) ?? null; }

  _set(p, change) {
    const q = { ...(this._find(p.id) ?? p) };
    change(q);
    q.updatedAt = nowMs();
    this._upsert(q);
  }

  _readAll() {
    let text = null;
    try { text = this.storage.get(registrationsStorageKey); } catch { text = null; }
    if (!text) return {};
    try {
      const j = JSON.parse(text);
      return j && typeof j === "object" && !Array.isArray(j) ? j : {};
    } catch {
      return {};
    }
  }

  _loadPending(address) {
    const a = String(address).toLowerCase();
    if (this._pendingWallet === a) return;
    this._stopDriver();
    this._pendingWallet = a;
    const list = this._readAll()[a];
    this._pending = Array.isArray(list) ? list.filter((r) => r && typeof r.id === "string" && typeof r.name === "string") : [];
    this._emit();
  }

  _save() {
    const a = this._pendingWallet;
    if (!a) return;
    const all = this._readAll();
    if (this._pending.length) all[a] = this._pending;
    else delete all[a];
    try { this.storage.set(registrationsStorageKey, JSON.stringify(all)); } catch (e) {
      this.engine?.log?.("[KachatNames] could not save the registrations:", errorMessage(e));
    }
  }

  _upsert(p) {
    const i = this._pending.findIndex((x) => x.id === p.id);
    if (i >= 0) this._pending[i] = p;
    else this._pending.push(p);
    this._save();
    this._emit();
  }

  _remove(id) {
    this._pending = this._pending.filter((x) => x.id !== id);
    this._save();
    this._emit();
  }
}

function commitOutpoint(p) { return makeOutpoint(unhex32(p.commitTxId), 0); }

function newId() {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return hex(newSalt()).slice(0, 32);
}

/** localStorage when the page has it, else memory (Node tests). */
function defaultStorage() {
  const memory = new Map();
  return {
    get(key) {
      try { if (globalThis.localStorage) return globalThis.localStorage.getItem(key); } catch { /* blocked */ }
      return memory.get(key) ?? null;
    },
    set(key, value) {
      try { if (globalThis.localStorage) { globalThis.localStorage.setItem(key, value); return; } } catch { /* blocked */ }
      memory.set(key, value);
    },
  };
}
