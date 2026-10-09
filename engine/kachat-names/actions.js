// .kachat names: every operation the screens offer, and the resumable registration.
//
// Port of iOS KaChat/Services/KachatNames/KachatNamesActions.swift. Each operation is built with
// the pure builders (builder.js) over UTXOs re-read from a node (registry ones with the registry
// covenant id), at the fee the person chose - Normal / Fast / Priority (1x / 2x / 5x the network's
// Normal rate, never under the 100 sompi/gram floor) or a custom total turned into a rate from the
// transaction's mass; without a choice, max(100, the priority rate) - read from the node's
// GetFeeEstimate (the REST API only when no node answers; iOS e426432). It is signed with the
// wallet key and submitted (service.js); it returns the txid and `follow`s it on the node: its
// mempool, then its own output in the UTXO set (in a block), then the registry refreshes until it
// includes it (read-your-writes, iOS 32260ae). The stages (`txStage`, TxStage) drive the receipt.
// `plan(op, { fee })` builds the same transaction without sending it (the sheets).
// The registration is commit -> wait tCommit (+20) DAA -> register, driven automatically and
// resumable (records in localStorage, per wallet). Testnet-10 only (KachatNamesService.isLaunched),
// except the address profile record (`profileSigner`, `profileFee`, `saveProfile`), which works on
// every network (KachatNamesService.profilesEnabled, iOS d36fc42): it is a self-send, not registry
// data, so on mainnet the app builds these actions over an inert registry (isEnabled false) and
// only the profile methods are used.
//
// Owner actions on a name one of the wallet's SPENDING addresses holds (iOS 881ada6) sign - and pay
// their fee - with that address's derived key: the app passes `wallet` hooks (see the constructor)
// and `signer(op)` / `ownAddress(owner)` pick the address. A KasSigner (watch-only) address is
// recognised but never signed for.
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
//
// Registry v4: register, extend and renew pay the fixed prices baked into the pinned gap and name
// templates (the manifest's `registerPrices` / `renewPrices`; register charges the registration
// price for the first period and the renewal price for each further one, extend and renew the
// renewal price) - no price shard is read or spent; "years" are periods of the manifest's
// `periodMs` (a year on mainnet, 24 hours on testnet). Offers are made to the name's current owner (the seller), capped at `maxOfferDays`;
// only that owner accepts or declines them, and a transfer, release or accepted offer declines the
// rest (`declineOpenOffers`). Offers past their refund time go back to the buyer from whichever app
// sees them first (`returnExpiredOffers`), and a buyer's app pulls back its offers on a name that
// changed hands (`withdrawDeclinedOffers`).
//
// Nothing pays more than the price the person confirmed (iOS 4f5d95e, IOS-054; with v4's fixed
// prices a safeguard): a registration keeps the quoted price as its cap (`startRegistration({
// maxPrice })`) and fails with `ActionError.priceChanged` rather than pay more; an extend or renew
// sheet passes the price it showed (`perform(op, { maxPrice })`) and a higher one throws
// `ActionError.priceChanged`. Offers are made and accepted only on active names, and a renewal that
// would still end in the past is refused (iOS 71128c4, IOS-055/056).
//
// A name past its grace is free to claim (iOS eea52b2): the registration driver frees the old
// record itself (a reclaim: the bond goes back to the old owner, the freed deposit to the claimer)
// and then registers, so Claim is one step. Claims can run side by side (iOS b219bb0), and a
// commit a busy network dropped from its mempool is sent again (same salt, same script).

import { secp256k1 } from "@noble/curves/secp256k1.js";

import { getEndpoint } from "../endpoints.js";
import { ADDRESS_HRP, KAS_UNIT, isNetworkAddress } from "../network.js";
import { enqueueSend, excludeReservedUtxos } from "../transactions.js";
import {
  Failure, minFeerate, minChange, commitValue, hex, unhex, unhex32, bytesEqual, concat, utf8, normalize, validate,
  gapState, nameState, offerState,
} from "./codec.js";
import { makeOutpoint, makeUtxo, makeUtxoEntry, outpointKey } from "./transaction.js";
import { templateScript, paramsRegisterCost } from "./manifest.js";
import { registerNow, renewWindowOpen } from "./builder.js";
import { keyOf } from "./registry.js";
import { GapInfo, OfferInfo, Profile, Status, addressOf, p2shAddress } from "./registry-state.js";
import { KachatNamesService, ServiceError, xonlyKey, fundingUtxos, newSalt, profileRecordPayload } from "./service.js";

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
 *    reclaimTxId: hex|null (the reclaim this registration sent to free a lapsed old record of the
 *    name first, iOS eea52b2), reclaimLo / reclaimHi: hex|null (the gap that reclaim reopens -
 *    its output 0, the two gaps around the name merged - so the driver registers into it as soon
 *    as a node has it, iOS beb9c45), commitSentAt: Number|null (unix ms the current commit went out),
 *    commitResends: Number|null (how many times it was sent again after a node dropped it, iOS
 *    b219bb0), cancelTxId: hex|null, stage: Stage, createdAt: Number (unix ms), updatedAt: Number,
 *    lastError: string|null (an error, or while it still runs what the driver is doing),
 *    maxPrice: decimal sompi string|null (the price the person confirmed for the whole
 *    registration - it never pays more), feeTier: "normal" | "fast" | "priority" | null (the fee
 *    speed chosen when claiming, for the commit and - at the network's rate then - the register;
 *    null on claims from before iOS e426432: they keep the priority rate) }`.
 *    `recordPrice(p.maxPrice)` reads the price as BigInt.
 * The stored copy also carries `salt` (hex) - iOS keeps it in the Keychain; `pending` never
 * exposes it.
 */

/** A record's sompi string (`maxPrice`) as BigInt, or null. */
export function recordPrice(v) {
  if (v == null || v === "") return null;
  try { return BigInt(v); } catch { return null; }
}

/** Still shown on the hub. */
export function isOpen(p) { return p.stage !== Stage.cancelled; }
/** The driver has work to do. */
export function needsDriving(p) {
  return [Stage.committing, Stage.waiting, Stage.registering, Stage.cancelling].includes(p.stage);
}

/** The localStorage key of the registrations: `{ [wallet address]: PendingRegistration[] }` (with salts). */
export const registrationsStorageKey = "kachat-names-registrations-testnet-v1";

// MARK: - Errors

/** A unix-ms day ("Oct 12, 2027") in `locale` (default: the runtime's), with the time when it is
 *  within two days of now (testnet's 24-hour periods, or a renewal that opens tomorrow). Swift
 *  `KachatNamesActions.dayString` (DateFormatter, medium date style, short time near the deadline). */
export function dayString(ms, locale = undefined) {
  const d = new Date(Number(ms));
  const near = Math.abs(Number(ms) - nowMs()) < 2 * 86_400_000;
  try {
    return new Intl.DateTimeFormat(locale, near ? { dateStyle: "medium", timeStyle: "short" } : { dateStyle: "medium" }).format(d);
  } catch {
    return near ? d.toString() : d.toDateString();
  }
}

/** Longest an offer can run before its buyer may take it back (the app's cap, registry v3), days. */
export const maxOfferDays = 7n;
/** Kaspa's DAA scores per second (offer refund times are DAA scores). */
export const daaPerSecond = 10n;

/** The fee rate (sompi/gram) when the fee estimate can't be read: well above the floor, since the
 *  floor is exactly what a busy network drops (testnet-10 asked 115-894 sompi/gram on 2026-10-07).
 *  Still a tiny fee on these small transactions. Swift `unknownFeerate` (iOS b219bb0). */
export const unknownFeerate = minFeerate * 10;

// MARK: - Fees (iOS e426432)

/** The Send screens' fee speeds (iOS WithdrawFeeTier; the ids of send-kaspa-components'
 *  SEND_FEE_TIERS). */
export const FeeTier = Object.freeze({ normal: "normal", fast: "fast", priority: "priority" });
/** What each speed pays, as a multiple of the network's Normal rate (the Send screens' 1x/2x/5x). */
export const feeTierMultipliers = Object.freeze({ normal: 1, fast: 2, priority: 5 });

/** A fee speed from its id (any case: iOS stores "Normal" / "Fast" / "Priority"), else null. */
export function parseFeeTier(value) {
  const t = String(value ?? "").trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(feeTierMultipliers, t) ? t : null;
}

/** The fee a name transaction pays (iOS `FeeChoice`): a speed, or the whole network fee the
 *  person typed (sompi). `perform` / `plan` take one as `{ fee }`; a bare speed id ("fast") or
 *  `{ customTotal }` is read the same way, and null keeps the old default (the priority rate). */
export const FeeChoice = Object.freeze({
  tier: (tier) => ({ kind: "tier", tier: parseFeeTier(tier) ?? FeeTier.normal }),
  customTotal: (sompi) => ({ kind: "customTotal", total: BigInt(sompi) }),
});

/** `fee` as a FeeChoice, or null (none / unreadable). */
export function normalizeFeeChoice(fee) {
  if (fee == null) return null;
  if (typeof fee === "string") return parseFeeTier(fee) ? FeeChoice.tier(fee) : null;
  if (typeof fee !== "object") return null;
  if (fee.kind === "tier" || (fee.kind == null && fee.tier != null)) return parseFeeTier(fee.tier) ? FeeChoice.tier(fee.tier) : null;
  const total = fee.kind === "customTotal" ? fee.total : fee.customTotal;
  try {
    const t = BigInt(total);
    return t > 0n ? FeeChoice.customTotal(t) : null;
  } catch { return null; }
}

/** Busy (iOS FeeEstimate.isBusy): Normal costs above 1.5x the relay floor, or isn't expected in
 *  the next few blocks (over 10 s). A busy network starts the sheets on Fast. */
export function isBusyEstimate(e) {
  return !!e && (Number(e.normal) > minFeerate * 1.5 || Number(e.normalSeconds) > 10);
}

/** The network's fee picture (iOS `FeeEstimate`): `{ normal, normalSeconds, priority,
 *  prioritySeconds, isBusy }` - sompi per gram and the seconds each is expected to wait. */
export function makeFeeEstimate({ normal, normalSeconds = 0, priority, prioritySeconds = 0 }) {
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const e = { normal: n(normal), normalSeconds: n(normalSeconds), priority: n(priority), prioritySeconds: n(prioritySeconds) };
  return Object.freeze({ ...e, isBusy: isBusyEstimate(e) });
}

// MARK: - Following a sent transaction (node only; iOS e426432, 32260ae)

/** Where a sent name transaction is (iOS `TxStage`): sent, waiting in a node's mempool, in a block
 *  (its output is in the UTXO set), shown (the registry has it), or dropped (no node has it). */
export const TxStage = Object.freeze({
  sent: "sent", inMempool: "inMempool", accepted: "accepted", shown: "shown", dropped: "dropped",
});
/** The follower gives up (dropped) after this long. */
export const followGiveUpMs = 300_000;

/** The `kaspatest:` address of a Schnorr P2PK output script (`<32-byte key> OP_CHECKSIG`), or null. */
export function p2pkAddress(script) {
  const b = script;
  if (!(b instanceof Uint8Array) || b.length !== 34 || b[0] !== 0x20 || b[33] !== 0xac) return null;
  return addressOf(b.slice(1, 33));
}

/** Which output of `plan` tells that the transaction is in a block: the registry or offer output
 *  (P2SH) if there is one, else output 0 -> `{ index, address }` (address null without a plan: a
 *  transaction built elsewhere, like a profile save, which only the mempool and the REST API can
 *  tell about). */
export function followTarget(plan) {
  const outputs = plan?.unsignedTx?.outputs ?? [];
  let index = outputs.findIndex((o) => o?.script && p2shAddress(o.script) != null);
  if (index < 0) index = 0;
  const o = outputs[index];
  const address = o ? (p2shAddress(o.script) ?? p2pkAddress(o.script)) : null;
  return { index, address };
}

/** Swift `KachatNamesActions.ActionError`; `code` is the case name. Extra fields per case:
 *  renewalNotOpen `{ opensMs }`, periodFull `{ renewalOpensMs }` (unix ms, BigInt), priceChanged
 *  `{ price }` (sompi, BigInt). */
export class ActionError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = "ActionError";
    this.code = code;
    Object.assign(this, extra);
  }

  static noWallet() { return new ActionError("noWallet", "No testnet wallet is open."); }
  /** No wallet (address and key) is open at all - the profile signer, on any network. */
  static noOpenWallet() { return new ActionError("noWallet", "No wallet is open."); }
  static keyMismatch() { return new ActionError("keyMismatch", "This wallet's key does not match its address."); }
  static invalidKey(what) { return new ActionError("invalidKey", `${what} is not a valid key (not on the secp256k1 curve).`); }
  static noSalt() { return new ActionError("noSalt", "The secret for this registration is missing on this device."); }
  static notRegisterable(why) { return new ActionError("notRegisterable", why); }
  /** renew before its window: the network's time has not reached `expiresAt - renewWindowMs` */
  static renewalNotOpen(opensMs) {
    return new ActionError("renewalNotOpen", `Renewal opens on ${dayString(opensMs)}`, { opensMs: BigInt(opensMs) });
  }
  /** extend past `periodStart + maxYears` periods */
  static periodFull(renewalOpensMs) {
    return new ActionError(
      "periodFull",
      `This name is already paid up to its longest period. Renewal opens on ${dayString(renewalOpensMs)}.`,
      { renewalOpensMs: BigInt(renewalOpensMs) },
    );
  }
  /** the record has no periodStart (an indexer without the field), so its state is unknown */
  static periodUnknown() {
    return new ActionError("periodUnknown", "The names indexer didn't send this name's paid period. Pull to refresh and try again.");
  }
  /** accept on an offer past its refund time */
  static offerExpired() { return new ActionError("offerExpired", "This offer has expired. It's going back to the buyer."); }
  /** accept on an offer made to an earlier owner of the name */
  static offerDeclined() {
    return new ActionError("offerDeclined", "This offer was made before the name changed hands, so it's declined and going back to the buyer.");
  }
  static ownOffer() { return new ActionError("ownOffer", "You can't make an offer on your own name."); }
  /** the transaction would pay more than the price the person confirmed (iOS 4f5d95e, IOS-054) */
  static priceChanged(price) {
    const p = BigInt(price);
    return new ActionError(
      "priceChanged",
      `The price changed to ${kasText(p)} since you confirmed. Nothing was sent. Check the new price and confirm again.`,
      { price: p },
    );
  }
  /** an offer on a name that isn't active: anyone can reclaim an expired one soon (iOS 71128c4) */
  static offerNameNotActive() { return new ActionError("offerNameNotActive", "Offers can only be made on active names."); }
  /** accept while the name is expired: the buyer would get a name anyone can reclaim (iOS 71128c4) */
  static acceptNameNotActive() {
    return new ActionError("acceptNameNotActive", "This name has expired. Offers can only be accepted while the name is active. Renew it first.");
  }
  /** a renewal counts from the old expiry: one that would still end in the past (iOS 71128c4) */
  static expiredTooLong() {
    return new ActionError("expiredTooLong", "This name has been expired too long to renew. It can only be reclaimed and registered again.");
  }
  static offerTooLong() { return new ActionError("offerTooLong", "An offer can run for up to 7 days."); }
}

// MARK: - Operations

/** Swift `KachatNamesActions.Operation`: `{ kind, ... }`. `name` / `target` is a NameInfo, `offer`
 *  an OfferInfo (registry-state.js). "years" are periods of the manifest's `periodMs`. */
export const Operation = Object.freeze({
  /** add periods to the current paid period (anyone, any time, up to maxYears periods past periodStart) */
  extend: (name, years) => ({ kind: "extend", name, years: BigInt(years) }),
  /** start the next period at the current expiry (anyone, once the renewal window opened) */
  renew: (name, years) => ({ kind: "renew", name, years: BigInt(years) }),
  transfer: (name, to) => ({ kind: "transfer", name, to }),
  /** price 0 delists */
  list: (name, price) => ({ kind: "list", name, price: BigInt(price) }),
  buy: (name) => ({ kind: "buy", name }),
  /** made to `target`'s current owner (a NameInfo), the only one who can accept or decline it;
   *  `refundAfterDaa` at most `maxOfferDays` ahead */
  offer: (target, amount, refundAfterDaa) => ({ kind: "offer", target, amount: BigInt(amount), refundAfterDaa: BigInt(refundAfterDaa) }),
  withdraw: (offer) => ({ kind: "withdraw", offer }),
  refund: (offer) => ({ kind: "refund", offer }),
  accept: (offer, name) => ({ kind: "accept", offer, name }),
  /** the seller sends it back to the buyer (registry v3); the network fee comes out of the offer */
  decline: (offer) => ({ kind: "decline", offer }),
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
/** Sompi as "12.5 KAS" / "12.5 TKAS" (the network's unit), for error messages. */
function kasText(sompi) {
  const v = BigInt(sompi);
  const whole = v / 100_000_000n;
  const frac = (v % 100_000_000n).toString().padStart(8, "0").replace(/0+$/, "");
  return `${whole}${frac ? `.${frac}` : ""} ${KAS_UNIT}`;
}
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
   *  `storage`: `{ get(key) -> string|null, set(key, string) }` (default localStorage).
   *  `wallet` (optional, the wallet's other addresses - iOS 881ada6):
   *    `spendingAddresses()` -> [{ index, address }] (the revealed spending addresses),
   *    `spendingPrivateKey(index)` -> hex | null (that address's derived key),
   *    `kasSignerAddresses()` -> [{ account, index, address }] (watch-only, never signed for).
   *  `clock` (optional, tests): `{ now() -> unix ms, sleep(ms) -> Promise }` for the follower. */
  constructor({ engine, service = null, registry, storage = null, wallet = null, clock = null } = {}) {
    if (!registry) throw new Failure("KachatNamesActions needs the app's registry");
    this.engine = engine;
    this.clock = { now: clock?.now ?? nowMs, sleep: clock?.sleep ?? sleep };
    /** The last fee estimate read (`refreshFeeEstimate`, makeFeeEstimate shape), or null. */
    this.feeEstimate = null;
    /** txid -> TxStage of every transaction followed this session (`follow`) */
    this._txStages = new Map();
    /** txid -> the running follower's promise */
    this._follows = new Map();
    this.wallet = wallet ?? {};
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
    /** The registration whose progress sheet the app shows by itself (iOS b219bb0
     *  `autoPresentedRegistration`): set once per launch by `resume()` when a claim is still in
     *  progress, since it needs the app open to finish. The UI clears it when that sheet closes
     *  (`clearAutoPresented()`). */
    this.autoPresentedRegistration = null;
    this._autoPresentedThisLaunch = false;
    /** offer ids (txid:index) this app is sending back / withdrawing / declining this session */
    this.returningOffers = new Set();
    this.withdrawingOffers = new Set();
    this.decliningOffers = new Set();
    /** offer ids this person closed themselves (Withdraw, Refund) - not news when they disappear
     *  (the app's .kachat notifier, iOS 86471dd KachatNamesNotifier.selfClosedOffers) */
    this.selfClosedOffers = new Set();
  }

  // MARK: Observing (Swift @Published pending / virtualDaa)

  /** This wallet's registrations, newest last (copies, without salts). */
  get pending() { return this._pending.map(publicRecord); }

  /** The registrations still open (in progress, or finished and not yet dismissed): the .kachat
   *  screen's claims button lists them (iOS b219bb0 `openRegistrations`). */
  get openRegistrations() { return this.pending.filter(isOpen); }

  /** The auto-presented progress sheet went down (swiped away or closed): the claim keeps running. */
  clearAutoPresented() {
    if (this.autoPresentedRegistration == null) return;
    this.autoPresentedRegistration = null;
    this._emit();
  }

  /** `listener({ pending, virtualDaa, autoPresentedRegistration, txStages, feeEstimate })` after
   *  every change (a follower's stage and a new fee estimate included); returns an unsubscribe
   *  function. */
  subscribe(listener) {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  /** The stage of every transaction followed this session: `{ [txid]: TxStage }` (a copy). */
  get txStages() { return Object.fromEntries(this._txStages); }

  /** The stage of `txId` (TxStage), or null when it isn't followed. */
  txStage(txId) { return this._txStages.get(String(txId ?? "").trim().toLowerCase()) ?? null; }

  _setTxStage(id, stage) {
    if (this._txStages.get(id) === stage) return;
    this._txStages.delete(id);
    this._txStages.set(id, stage);
    // a session's worth; the oldest go first
    while (this._txStages.size > 500) this._txStages.delete(this._txStages.keys().next().value);
    this._emit();
  }

  _emit() {
    const snapshot = {
      pending: this.pending, virtualDaa: this.virtualDaa, autoPresentedRegistration: this.autoPresentedRegistration,
      txStages: this.txStages, feeEstimate: this.feeEstimate,
    };
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
    this.service.requireLaunched();
    const address = String(this.engine?.address ?? "").toLowerCase();
    const key = this.engine?.privateKeyHex;
    if (!address.startsWith("kaspatest:") || !key) throw ActionError.noWallet();
    const me = xonlyKey(key);
    if (!bytesEqual(keyOf(address), me)) throw ActionError.keyMismatch();
    return { address, privateKey: key, me };
  }

  /** The current wallet's chatting address and key on the network the app runs on - the profile
   *  record's signer (iOS d36fc42 profileSigner). Unlike `signer()` it isn't testnet-only: profiles
   *  work on mainnet before its registry launches (KachatNamesService.profilesEnabled).
   *  `{ address, privateKey: hex, me: Uint8Array(32) }`. */
  profileSigner() {
    if (!KachatNamesService.profilesEnabled) throw ServiceError.testnetOnly();
    const address = String(this.engine?.address ?? "").trim().toLowerCase();
    const key = this.engine?.privateKeyHex;
    if (!address || !key) throw ActionError.noOpenWallet();
    if (!isNetworkAddress(address)) throw ServiceError.wrongAddressNetwork();
    const me = xonlyKey(key);
    const own = keyOf(address, ADDRESS_HRP);
    if (!own || !bytesEqual(own, me)) throw ActionError.keyMismatch();
    return { address, privateKey: key, me };
  }

  /**
   * Which of this wallet's own addresses holds a name whose owner is `owner` (an x-only key), iOS
   * KachatNamesActions.ownAddress: `{ kind: "chatting", address }`, `{ kind: "spending", index,
   * address }` (the app derives its key, so owner actions sign with it) or `{ kind: "kasSigner",
   * account, index, address }` (watch-only: the device would have to sign). null = someone else's.
   */
  ownAddress(owner) {
    if (!(owner instanceof Uint8Array)) return null;
    const me = this.myKey;
    if (me && bytesEqual(me, owner)) return { kind: "chatting", address: this.myAddress };
    const list = (fn) => {
      try { const v = typeof fn === "function" ? fn() : null; return Array.isArray(v) ? v : []; } catch { return []; }
    };
    const spending = list(this.wallet.spendingAddresses)
      .filter((e) => e && Number.isInteger(e.index) && typeof e.address === "string")
      .sort((a, b) => a.index - b.index);
    for (const { index, address } of spending) {
      const key = keyOf(address);
      if (key && bytesEqual(key, owner)) return { kind: "spending", index, address: address.toLowerCase() };
    }
    for (const e of list(this.wallet.kasSignerAddresses)) {
      if (!e || typeof e.address !== "string") continue;
      const key = keyOf(e.address);
      if (key && bytesEqual(key, owner)) {
        return { kind: "kasSigner", account: String(e.account ?? ""), index: Number(e.index) || 0, address: e.address.toLowerCase() };
      }
    }
    return null;
  }

  /** The x-only key an owner-only `op` must be signed by: the name's owner for transfer,
   *  list/delist, accept and release; the offer's seller for decline. null for everything else. */
  static heldBy(op) {
    if (!op) return null;
    if (["transfer", "list", "release", "accept"].includes(op.kind)) return op.name?.owner ?? null;
    // the seller declines with the key the offer was made to
    if (op.kind === "decline") return op.offer?.seller ?? null;
    return null;
  }

  /** The spending address that signs and pays for `op` (iOS signer(for:)): owner-only actions
   *  (transfer, list/delist, accept, release, decline) on a name or offer one of the wallet's
   *  spending addresses holds. null = the chatting address (everything else, extend and renew
   *  included - anyone may pay those). */
  payerFor(op) {
    const held = KachatNamesActions.heldBy(op);
    if (!held) return null;
    const own = this.ownAddress(held);
    return own?.kind === "spending" ? own : null;
  }

  /** The signer for `op`: that spending address's derived key when `payerFor(op)` names one, else
   *  the chatting address (`signer()`). */
  signerFor(op) {
    const payer = this.payerFor(op);
    if (!payer) return this.signer();
    this.service.requireLaunched();
    // a testnet address on the network the app runs on (iOS d657ee3, IOS-058)
    if (!payer.address.startsWith("kaspatest:") || !isNetworkAddress(payer.address)) throw ServiceError.wrongAddressNetwork();
    let key = null;
    try { key = this.wallet.spendingPrivateKey?.(payer.index) ?? null; } catch { key = null; }
    if (!key) throw ActionError.noWallet();
    const me = xonlyKey(key);
    if (!bytesEqual(me, KachatNamesActions.heldBy(op)) || !bytesEqual(keyOf(payer.address), me)) throw ActionError.keyMismatch();
    return { address: payer.address, privateKey: key, me };
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

  // MARK: Fees (iOS e426432)

  /** Reads the network's fee picture and keeps it in `feeEstimate` (subscribers hear of it): the
   *  node's GetFeeEstimate (`engine.getFeeEstimate()`), else the REST API's `/info/fee-estimate`
   *  (read twice). -> makeFeeEstimate shape, or the last one read (null when nothing ever answered). */
  async refreshFeeEstimate() {
    const keep = (e) => {
      const changed = JSON.stringify(e) !== JSON.stringify(this.feeEstimate);
      this.feeEstimate = e;
      if (changed) this._emit();
      return e;
    };
    if (typeof this.engine?.getFeeEstimate === "function") {
      try {
        const e = await this.engine.getFeeEstimate();
        if (Number(e?.priority?.feerate) > 0) {
          return keep(makeFeeEstimate({
            normal: e.normal?.feerate ?? e.priority.feerate, normalSeconds: e.normal?.seconds ?? e.priority.seconds,
            priority: e.priority.feerate, prioritySeconds: e.priority.seconds,
          }));
        }
      } catch { /* no node answered: the REST API */ }
    }
    let base = "";
    try { base = trimSlash(getEndpoint("kaspaApi")); } catch { base = ""; }
    if (!base) return this.feeEstimate;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(`${base}/info/fee-estimate`, { headers: { Accept: "application/json" }, cache: "no-store" });
        if (res.status !== 200) continue;
        const j = await res.json();
        const priority = j?.priorityBucket;
        if (!priority || !Number.isFinite(Number(priority.feerate))) continue;
        const normal = (Array.isArray(j?.normalBuckets) ? j.normalBuckets[0] : null) ?? priority;
        return keep(makeFeeEstimate({
          normal: normal.feerate, normalSeconds: normal.estimatedSeconds, priority: priority.feerate, prioritySeconds: priority.estimatedSeconds,
        }));
      } catch { /* try again, then the last estimate */ }
    }
    return this.feeEstimate;
  }

  /** `max(100, the priority fee rate)` in sompi per gram (a Number) - the rate when no fee was
   *  chosen; `unknownFeerate` when no estimate can be read (iOS b219bb0). */
  async feerate() {
    const e = await this.refreshFeeEstimate();
    if (!e || !(e.priority > 0)) return unknownFeerate;
    return Math.max(minFeerate, e.priority);
  }

  /** The rate a speed pays (FeeTier): the network's Normal rate, never under the floor, times the
   *  speed's multiplier - the Send screens' 1x / 2x / 5x. `unknownFeerate` times it when no
   *  estimate can be read. */
  async feerateForTier(tier) {
    const e = await this.refreshFeeEstimate();
    const base = e ? Math.max(minFeerate, e.normal) : unknownFeerate;
    return base * feeTierMultipliers[parseFeeTier(tier) ?? FeeTier.normal];
  }

  /** The rate for a fee choice (`normalizeFeeChoice`); none keeps the old default (the priority
   *  rate). A typed total is turned into a rate by building the transaction once at the floor to
   *  learn its mass. */
  async _feerateFor(fee, op, s) {
    const choice = normalizeFeeChoice(fee);
    if (!choice) return this.feerate();
    if (choice.kind === "tier") return this.feerateForTier(choice.tier);
    const probe = (await this._build(op, s, minFeerate)).plan;
    const mass = Math.max(1, Number(probe.costs.minFee) / minFeerate);
    return Math.max(minFeerate, Number(choice.total) / mass);
  }

  /** The wallet's node UTXOs (with covenant ids), less coins a scheduled KaPost reserved. */
  async _walletUtxos(address) {
    return excludeReservedUtxos(await this.engine.getUtxosWithCovenants([address]));
  }

  /** Builder, environment and the wallet's funding UTXOs for one transaction, at `rate` (sompi per
   *  gram; default: the priority rate, `feerate()`). */
  async _context(s, rate = null) {
    const builder = await this.service.builder();
    const env = await this.service.environment({ privateKey: s.privateKey, feerate: rate ?? await this.feerate() });
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
   *  plan.networkFee, plan.outputs, plan.notes, plan.txid...). `fee` (optional): the fee choice
   *  (FeeChoice, a speed id, or `{ customTotal }`) - the plan is built at it, as `perform` sends it;
   *  none keeps the priority rate. */
  async plan(op, { fee = null } = {}) {
    const s = this.signerFor(op);
    return (await this._build(op, s, await this._feerateFor(fee, op, s))).plan;
  }

  async _build(op, s, rate = null) {
    const m = await this.registry.prepare();
    const { builder: b, env, wallet } = await this._context(s, rate);
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
        // A renewal counts from the old expiry, not from today: one that would still end in the
        // past is paid for nothing, and anyone could reclaim the name right after.
        if (!(BigInt(op.name.expiresAt) + BigInt(op.years) * m.params.periodMs > env.wallMs)) throw ActionError.expiredTooLong();
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
      case "offer": {
        validateKey(env.me, "Your key");
        if (op.target == null) throw new Failure("an offer is made on a registered name");
        // an expired name can be reclaimed by anyone soon: the buyer would pay for nothing
        if (op.target.status(m.params.graceMs, BigInt(nowMs())) !== Status.active) throw ActionError.offerNameNotActive();
        if (bytesEqual(op.target.owner, env.me)) throw ActionError.ownOffer();
        // the app's cap: the buyer's funds come back within a week at most
        const refundAfter = BigInt(op.refundAfterDaa);
        const cap = env.blockDaa + maxOfferDays * 86_400n * daaPerSecond;
        if (!(refundAfter > env.blockDaa && refundAfter <= cap)) throw ActionError.offerTooLong();
        plan = b.offer({ env, wallet, target: await this._liveName(op.target, m), amount: BigInt(op.amount), refundAfter });
        break;
      }
      case "withdraw":
        plan = b.withdrawOffer({ env, offer: await this._liveOffer(op.offer, m) });
        break;
      case "refund":
        plan = b.refundOffer({ env, offer: await this._liveOffer(op.offer, m) });
        break;
      case "accept":
        // The contract would still take an expired offer; the app doesn't - it goes back.
        if (op.offer.refundable(env.blockDaa)) throw ActionError.offerExpired();
        // The contract would hand over an expired name too; the buyer would get a name anyone can
        // reclaim. Only an active name is accepted.
        if (op.name.status(m.params.graceMs, BigInt(nowMs())) !== Status.active) throw ActionError.acceptNameNotActive();
        // Made to an earlier owner: the contract refuses it, and it goes back to the buyer.
        if (op.offer.isDeclined(op.name.owner)) throw ActionError.offerDeclined();
        validateKey(op.offer.buyer, "The buyer");
        plan = b.acceptOffer({ env, name: await this._liveName(op.name, m), offer: await this._liveOffer(op.offer, m) });
        break;
      case "decline":
        plan = b.declineOffer({ env, offer: await this._liveOffer(op.offer, m) });
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

  /** Builds, signs and submits `op`; returns the txid, then `follow`s it on the node (the receipt's
   *  stages, and the registry refreshed until it shows it). Runs in the engine's per-address send
   *  queue, so a chat message sent meanwhile cannot pick the same coin. A transfer, release or
   *  accepted offer then declines the name's other open offers made to this owner
   *  (`declineOpenOffers`).
   *  `maxPrice` (sompi, BigInt) is the price the person saw and confirmed (the shown plan's
   *  `priceFee`): an extend or renew never pays more - a higher price throws
   *  `ActionError.priceChanged(newPrice)` before anything is signed (iOS 4f5d95e, IOS-054).
   *  `fee` (optional): the fee choice the sheet showed (see `plan`); it is sent at that fee. */
  async perform(op, { maxPrice = null, fee = null } = {}) {
    const s = this.signerFor(op);
    const cap = maxPrice == null ? null : BigInt(maxPrice);
    const rate = await this._feerateFor(fee, op, s);
    const { plan, txId } = await enqueueSend(s.address, () => this._submit(op, s, cap, rate));
    // An offer you withdrew or refunded yourself isn't news; the ones this app returns on its own
    // (expired, made to an earlier owner) are (iOS 86471dd).
    if ((op.kind === "withdraw" && !this.withdrawingOffers.has(op.offer?.id))
      || (op.kind === "refund" && !this.returningOffers.has(op.offer?.id))) {
      if (op.offer?.id) this.selfClosedOffers.add(op.offer.id);
    }
    if (op.kind === "offer" && plan.newOffer) {
      const o = plan.newOffer;
      await this.registry.trackOffer(new OfferInfo({
        outpoint: o.utxo.outpoint, key: o.fields.key, name: o.name, buyer: o.fields.buyer, seller: o.fields.seller,
        amount: o.value, refundAfter: o.fields.refundAfter, createdAt: BigInt(nowMs()),
      }));
    }
    // A name that leaves this owner takes no offers with it: the ones made to this owner can never
    // be accepted any more, so they go straight back to their buyers.
    if (op.kind === "transfer" || op.kind === "release") this.declineOpenOffers(op.name, null);
    else if (op.kind === "accept") this.declineOpenOffers(op.name, op.offer);
    this.follow(txId, plan);
    return txId;
  }

  /** Builds, signs and submits `op` -> `{ plan, txId }`, rebuilt against live UTXOs at `rate`. It
   *  never pays more than `maxPrice`, the price the person confirmed. */
  async _submit(op, s, maxPrice = null, rate = null) {
    const { plan, env } = await this._build(op, s, rate);
    if (maxPrice != null && BigInt(plan.priceFee ?? 0n) > maxPrice) throw ActionError.priceChanged(plan.priceFee);
    return { plan, txId: await this.service.signAndSubmit(plan, { privateKey: s.privateKey, env }) };
  }

  // MARK: Following a sent transaction (node only; iOS e426432, 32260ae)

  /** Follows `txId` on a node until it is in a block, then refreshes the registry until it shows
   *  it, publishing each stage (`txStage`, subscribers): sent -> inMempool -> accepted ("in a
   *  block": the node's UTXO set holds the transaction's own output, `followTarget(plan)`) ->
   *  shown; dropped when no node has it after a minute (or after 5 minutes in all). The REST API is
   *  asked only when the output isn't found - spent again right away, or a transaction without a
   *  plan (`plan` null: a profile save), which only the mempool and the REST API can tell about.
   *  A transaction already being followed isn't followed twice. Returns the follower's promise,
   *  resolving to its last stage (callers need not await it). */
  follow(txId, plan = null) {
    const id = String(txId ?? "").trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(id)) return Promise.resolve(null);
    const running = this._follows.get(id);
    if (running) return running;
    this._setTxStage(id, TxStage.sent);
    const run = this._follow(id, followTarget(plan))
      .catch((e) => {
        this.engine?.log?.(`[KachatNames] following ${id} failed: ${errorMessage(e)}`);
        this._setTxStage(id, TxStage.dropped);
        return TxStage.dropped;
      })
      .finally(() => { if (this._follows.get(id) === run) this._follows.delete(id); });
    this._follows.set(id, run);
    return run;
  }

  async _follow(id, { index, address }) {
    const { now, sleep: wait } = this.clock;
    const started = now();
    let sawMempool = false;
    const landed = async (daa) => {
      this._setTxStage(id, TxStage.accepted);
      // until the registry (indexer or walk) has caught up with the block it landed in
      try { await this._catchUp(id, daa); } catch { /* it shows on the next refresh */ }
      this._setTxStage(id, TxStage.shown);
      return TxStage.shown;
    };
    while (now() - started < followGiveUpMs) {
      if (address) {
        let utxos = null;
        try { utxos = await this.engine.getUtxosWithCovenants([address]); } catch { utxos = null; }
        const hit = Array.isArray(utxos)
          ? utxos.find((u) => String(u?.outpoint?.transactionId ?? "").toLowerCase() === id && Number(u.outpoint.index) === index)
          : null;
        if (hit) return landed(hit.blockDaaScore != null ? BigInt(hit.blockDaaScore) : null);
      }
      if (await this._inMempool(id)) {
        sawMempool = true;
        if (this._txStages.get(id) === TxStage.sent) this._setTxStage(id, TxStage.inMempool);
      } else if (sawMempool || !address || now() - started > 20_000) {
        // Out of the mempool and not found by its output: in a block whose output was spent right
        // away, or dropped. The REST API settles the rare case.
        if (await this._restAccepted(id)) {
          let daa = null;
          try { daa = (await this.engine?.currentVirtualDaaScore?.()) ?? null; } catch { daa = null; }
          return landed(daa);
        }
        if (now() - started > 60_000) {
          this._setTxStage(id, TxStage.dropped);
          return TxStage.dropped;
        }
      }
      await wait(1_000);
    }
    this._setTxStage(id, TxStage.dropped);
    return TxStage.dropped;
  }

  /** Read-your-writes (iOS 32260ae): the registry refreshes until it includes `txId` (an indexer
   *  that has indexed up to `daa`, or a chain walk that applied it); a registry without
   *  `refreshUntilIncludes` just refreshes once. */
  async _catchUp(txId, daa) {
    const r = this.registry;
    if (typeof r?.refreshUntilIncludes === "function") return r.refreshUntilIncludes(txId, daa);
    return r?.refresh?.();
  }

  /** Whether the REST API has `txId` accepted: the registry's own check, or - where there is no
   *  registry (mainnet, an inert registry with no REST base) - the app's REST API directly. */
  async _restAccepted(txId) {
    try { if (await this.registry?.isAccepted?.(txId)) return true; } catch { /* not known */ }
    if (KachatNamesService.isLaunched) return false;
    let base = "";
    try { base = trimSlash(getEndpoint("kaspaApi")); } catch { base = ""; }
    if (!base) return false;
    try {
      const res = await fetch(`${base}/transactions/${txId}?inputs=false&outputs=false&resolve_previous_outpoints=no`, { headers: { Accept: "application/json" }, cache: "no-store" });
      if (res.status !== 200) return false;
      return (await res.json())?.is_accepted === true;
    } catch {
      return false;
    }
  }

  // MARK: Offers that go back to their buyers

  /** Sends expired offers (OfferInfo[]) back to their buyers. Past its refund time an offer can
   *  still be accepted on chain until someone refunds it, so it would otherwise hang on the name.
   *  The refund needs nobody's key and its network fee comes out of the offer itself, so whichever
   *  app sees one first - its buyer's, or the owner's of the name it's on - returns it, at no cost
   *  to either. Each offer is tried once per session; a refund someone else got in first just fails
   *  quietly. Returns once the refunds are started (they finish in the background). */
  async returnExpiredOffers(offers) {
    if (!KachatNamesService.isLaunched || !Array.isArray(offers) || offers.length === 0) return;
    let daa = null;
    try { daa = await this.refreshVirtualDaa(); } catch { daa = this.virtualDaa; }
    if (daa == null) return;
    for (const o of offers) {
      if (!o?.refundable?.(daa) || this.returningOffers.has(o.id)) continue;
      this.returningOffers.add(o.id);
      this._emit();
      this.perform(Operation.refund(o)).then(
        (txId) => this.engine?.log?.(`[KachatNames] returned expired offer ${o.id} to its buyer: ${txId}`),
        (e) => this.engine?.log?.(`[KachatNames] expired offer ${o.id} not returned: ${errorMessage(e)}`),
      );
    }
  }

  /** Sends back every open offer on `name` (a NameInfo) made to its owner, once the name leaves
   *  them (transfer, release, or an accepted offer - `except` is that one). Each is the seller's
   *  `decline`, so it costs the seller nothing: the network fee comes out of the offer. Runs in the
   *  background; returns its promise. */
  declineOpenOffers(name, except = null) {
    if (!KachatNamesService.isLaunched || !name) return Promise.resolve();
    return (async () => {
      let open = [];
      try { open = await this.registry.offersFor(name.name); } catch { open = []; }
      open = open.filter((o) => bytesEqual(o.seller, name.owner) && o.id !== except?.id && !this.decliningOffers.has(o.id));
      for (const o of open) {
        this.decliningOffers.add(o.id);
        this._emit();
        try {
          const txId = await this.perform(Operation.decline(o));
          this.engine?.log?.(`[KachatNames] declined offer ${o.id} on ${name.name} (the name left this owner): ${txId}`);
        } catch (e) {
          this.engine?.log?.(`[KachatNames] offer ${o.id} not declined: ${errorMessage(e)}`);
        }
      }
    })();
  }

  /** Pulls this wallet's declined offers (OfferInfo[]) back: those made to an earlier owner of the
   *  name (the contract refuses them now) or on a name since released. A withdraw, signed by the
   *  buyer - this wallet's chatting address - and paid back to it. Before its refund time only the
   *  buyer or the seller can return an offer, so the buyer's app does it as soon as it sees the name
   *  changed hands; after that, `returnExpiredOffers` covers it from any app. Each offer is tried
   *  once per session. Returns once the withdrawals are started. */
  async withdrawDeclinedOffers(offers) {
    const me = this.myKey;
    if (!KachatNamesService.isLaunched || !me || !Array.isArray(offers)) return;
    const mine = offers.filter((o) => o && bytesEqual(o.buyer, me) && !this.withdrawingOffers.has(o.id) && !this.returningOffers.has(o.id));
    if (mine.length === 0) return;
    /** name -> owner bytes | null (free); absent = lookup failed */
    const ownerByName = new Map();
    for (const o of mine) {
      if (!o.name) continue;
      if (!ownerByName.has(o.name)) {
        let r;
        try { r = await this.registry.lookup(o.name); } catch { continue; }
        ownerByName.set(o.name, r.kind === "registered" ? r.info.owner : null);
      }
      const current = ownerByName.get(o.name);
      // still made to the name's current owner: it stands
      if (current != null && !o.isDeclined(current)) continue;
      this.withdrawingOffers.add(o.id);
      this._emit();
      this.perform(Operation.withdraw(o)).then(
        (txId) => this.engine?.log?.(`[KachatNames] withdrew declined offer ${o.id} (the name changed hands): ${txId}`),
        (e) => this.engine?.log?.(`[KachatNames] declined offer ${o.id} not withdrawn: ${errorMessage(e)}`),
      );
    }
  }

  // MARK: Profile record (every network: profileSigner)

  /** What saving `profile` will cost (iOS profileFee): the profile record is a self-transfer from
   *  the chatting address, so the network fee is all it spends. Estimated the way the save builds
   *  it (plain coins only, same payload), never sent. BigInt sompi. */
  async profileFee(profile) {
    const s = this.profileSigner();
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

  /** Writes the address profile (`kchat:1:profile:`): a self-transfer, network fee only.
   *  `profile`: a Profile (registry-state.js) or its plain fields. Remembers it as this wallet's own
   *  profile (registry.noteOwnProfile, per network) and, where the registry is launched, refreshes
   *  it once accepted. Returns the txid. */
  async saveProfile(profile) {
    const s = this.profileSigner();
    const clean = (profile instanceof Profile ? profile : new Profile(profile ?? {})).sanitized();
    const json = clean.recordJSON();
    const txId = await this.service.submitProfileRecord({ address: s.address, json });
    await this.registry.noteOwnProfile(clean, s.address, txId);
    if (KachatNamesService.isLaunched) this.registry.refreshAfter(txId);
    return txId;
  }

  // MARK: Registration

  /** The cost of registering `name` for `years` periods inside `gap` (a GapInfo), estimated by
   *  building both transactions (nothing is signed or sent) at the fixed prices (registry v4).
   *  Amounts are BigInt sompi:
   *  `{ name, years, price (the registration price for the first period plus the renewal price for
   *  each further one, left to miners), bond (returned on release),
   *  gapDeposit (the extra gap the registration creates, returned on release), commit (the
   *  commit's value, returned into the registration), networkFee, total (what leaves the wallet in
   *  the end: price + bond + gap deposit + network fees), spendable, affordable }`.
   *  `feeTier` (FeeTier, default normal): the fee speed both transactions will use (iOS e426432). */
  async quote({ name, years, gap, feeTier = FeeTier.normal }) {
    const s = this.signer();
    years = BigInt(years);
    const m = await this.registry.prepare();
    const { builder: b, env, wallet } = await this._context(s, await this.feerateForTier(feeTier));
    const salt = newSalt();
    const spendable = wallet.reduce((a, u) => a + u.entry.amount, 0n);
    const price = paramsRegisterCost(m.params, utf8(name).length, years);
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
   *  txid. Progress arrives through `subscribe` (the record's `stage`). `maxPrice` (sompi, required)
   *  is the price the person confirmed (the quote's `price`): the registration never pays more
   *  (iOS 4f5d95e, IOS-054). Several claims can run side by side (iOS b219bb0). A name past its
   *  grace can be claimed: the driver frees the old record first (iOS eea52b2). `feeTier`
   *  (FeeTier, default normal): the fee speed of the commit now and - at the network's rate then -
   *  of the register (and a reclaim); kept on the record (iOS e426432). */
  async startRegistration({ name: raw, years, maxPrice, feeTier = FeeTier.normal }) {
    const s = this.signer();
    years = BigInt(years);
    if (maxPrice == null) throw new Failure("startRegistration needs the price the person confirmed (maxPrice)");
    const cap = BigInt(maxPrice);
    const tier = parseFeeTier(feeTier) ?? FeeTier.normal;
    const name = normalize(raw);
    validate(name);
    this._loadPending(s.address);
    await this.registry.refresh();
    const found = await this.registry.lookup(name);
    // Expired past grace: free to claim. The commit and the reclaim that frees the old record both
    // go out now; the driver registers once the commit has aged (iOS eea52b2, beb9c45).
    let lapsed = null;
    if (found.kind === "registered") {
      if (found.info.status(this.registry.graceMs, BigInt(nowMs())) !== Status.lapsed) {
        throw ActionError.notRegisterable(`${name}.kachat is already registered.`);
      }
      lapsed = found.info;
    }
    let record = null;
    try {
      const rate = await this.feerateForTier(tier);
      await enqueueSend(s.address, async () => {
        const { builder: b, env, wallet } = await this._context(s, rate);
        const salt = newSalt();
        const plan = b.commit({ env, wallet, name, salt });
        const commit = plan.newCommit;
        const script = commit?.utxo?.entry?.script;
        if (!commit || !script) throw new Failure("commit: no record");
        const now = nowMs();
        record = {
          id: newId(), name, years: Number(years), owner: hex(s.me), commitTxId: hex(plan.txid),
          commitScript: hex(script), commitDaa: null, registerTxId: null, reclaimTxId: null, reclaimLo: null, reclaimHi: null,
          commitSentAt: null, commitResends: null,
          cancelTxId: null, stage: Stage.committing, createdAt: now, updatedAt: now, lastError: null, salt: hex(salt),
          maxPrice: cap.toString(), feeTier: tier,
        };
        this._upsert(record);
        const txId = await this.service.signAndSubmit(plan, { privateKey: s.privateKey, env });
        record = { ...record, commitTxId: txId, commitSentAt: nowMs(), stage: Stage.waiting, updatedAt: nowMs() };
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
    // The reclaim needs nothing from the wallet (its fee comes out of the freed deposit), so it
    // runs while the commit ages instead of after. If it fails, the driver sends it (iOS beb9c45).
    if (lapsed) {
      try { await this._sendReclaim(lapsed, record); } catch (e) {
        this.engine?.log?.(`[KachatNames] reclaim of ${name} not sent yet: ${errorMessage(e)}`);
      }
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
    if (!KachatNamesService.isLaunched || !address) {
      this._stopDriver();
      this._pending = [];
      this._pendingWallet = null;
      this._emit();
      return;
    }
    this._loadPending(address);
    this._startDriver();
    // A claim still in progress when the app starts: its progress sheet comes back up once
    // (iOS b219bb0).
    if (!this._autoPresentedThisLaunch) {
      const open = this._pending.find(needsDriving);
      if (open) {
        this._autoPresentedThisLaunch = true;
        this.autoPresentedRegistration = open.id;
        this._emit();
      }
    }
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
          // the driver stops while the registry is being upgraded (an earlier registry's manifest)
          if (!KachatNamesService.isLaunched || !address || address !== this._pendingWallet || this.service.registryUpgrading
            || !this._pending.some(needsDriving)) break;
          for (const p of this._pending.filter(needsDriving)) {
            if (token.cancelled) break;
            try { await this._advance(p); } catch (e) { this.engine?.log?.("[KachatNames] driver step failed:", errorMessage(e)); }
          }
          // waiting for a registration's acceptance: check often, so the receipt shows within a
          // couple of seconds of it (iOS d65fd1a)
          await sleep(this._pending.some((x) => x.stage === Stage.registering) ? 2_000 : 5_000);
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
    const sinceUpdate = nowMs() - p.updatedAt;
    switch (p.stage) {
      case Stage.committing:
      case Stage.waiting: {
        const commit = await this._liveCommit(p);
        if (!commit) {
          if (p.commitDaa == null && await this._commitStillPending(p)) return;
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
        // In a block: no node holds the register in its mempool any more, and the commit it spends
        // is gone from the node's UTXO set (only this owner's register or cancel can spend it).
        // Node only (iOS e426432); a node that can't be asked never reads as "spent".
        const tx = p.registerTxId;
        if (tx && !(await this._inMempool(tx)) && (await this._commitSpent(p)) === true) {
          // Accepted is registered: the gap only accepts a register that mints this owner's name.
          // The receipt shows now; the registry catches up in the background instead of first (a
          // chain walk while the indexer follows another registry; iOS d65fd1a), until it includes
          // the register (iOS 32260ae).
          this._finishRegistered(p);
          (async () => {
            let daa = null;
            try { daa = (await this.engine?.currentVirtualDaaScore?.()) ?? null; } catch { daa = null; }
            await this._catchUp(tx, daa);
          })().catch(() => {});
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

  /** true: the node says the commit is no longer in the UTXO set; false: it still is; null: the
   *  node couldn't be asked - never read as "spent" (iOS e426432 commitSpent). */
  async _commitSpent(p) {
    let script;
    let outpoint;
    try { script = unhex(p.commitScript); outpoint = commitOutpoint(p); } catch { return null; }
    try {
      await this.service.liveUtxo({ script, outpoint });
      return false;
    } catch (e) {
      return e instanceof ServiceError && e.code === "notOnChain" ? true : null;
    }
  }

  /** The rate the registration's chosen speed pays now (its claim-time choice); a claim from
   *  before iOS e426432 (no feeTier) keeps the priority rate. */
  async _registrationFeerate(p) {
    const tier = parseFeeTier(p?.feeTier);
    return tier ? this.feerateForTier(tier) : this.feerate();
  }

  /** A commit not on chain yet: still waiting in a node's mempool (true), sent again because a
   *  node dropped it (true), or past saving (false: the caller fails it). On a busy network a
   *  low-fee transaction is evicted instead of mined, so silence must not mean "wait" (iOS
   *  b219bb0). */
  async _commitStillPending(p) {
    const sinceSent = nowMs() - (p.commitSentAt ?? p.createdAt);
    if (sinceSent < 30_000) return true; // just sent: give it time to show up
    if (await this._inMempool(p.commitTxId)) {
      if (sinceSent > 60_000 && p.lastError == null) {
        this._set(p, (q) => { q.lastError = "The network is busy. Your commit is waiting for a block."; });
      }
      return true;
    }
    if ((p.commitResends ?? 0) >= 3) return false;
    await this._resendCommit(p);
    return true;
  }

  /** Whether a node's mempool holds `txId` (the engine's `getMempoolEntry`, else its `withRpc`;
   *  false when neither answers). */
  async _inMempool(txId) {
    const id = String(txId ?? "").toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(id)) return false;
    try {
      if (typeof this.engine?.getMempoolEntry === "function") return (await this.engine.getMempoolEntry(id)) != null;
      if (typeof this.engine?.withRpc === "function") {
        const entry = await this.engine.withRpc(async (rpc) => {
          if (typeof rpc?.getMempoolEntry !== "function") return null;
          return rpc.getMempoolEntry({ transactionId: id, includeOrphanPool: true, filterTransactionPool: false });
        }, { retries: 0, label: "Mempool lookup" });
        return !!(entry?.mempoolEntry || entry?.entry);
      }
    } catch { /* not in this node's mempool (or no answer) */ }
    return false;
  }

  /** Sends the commit again - same name, owner and salt, so the same commit script - with the
   *  current fee, after a node dropped the first one (iOS b219bb0). */
  async _resendCommit(p) {
    try {
      const s = this.signer();
      if (hex(s.me) !== p.owner) return;
      const stored = this._find(p.id) ?? p;
      if (!stored.salt) throw ActionError.noSalt();
      const salt = unhex32(stored.salt);
      const rate = await this._registrationFeerate(stored);
      const txId = await enqueueSend(s.address, async () => {
        const { builder: b, env, wallet } = await this._context(s, rate);
        const plan = b.commit({ env, wallet, name: p.name, salt });
        const script = plan.newCommit?.utxo?.entry?.script;
        if (!script || hex(script) !== p.commitScript) throw new Failure("commit: a different script");
        return this.service.signAndSubmit(plan, { privateKey: s.privateKey, env });
      });
      this.engine?.log?.(`[KachatNames] commit for ${p.name} sent again: ${txId}`);
      this._set(p, (q) => {
        q.commitTxId = txId;
        q.commitSentAt = nowMs();
        q.commitResends = (q.commitResends ?? 0) + 1;
        q.lastError = "The network is busy, so the commit was sent again.";
      });
    } catch (error) {
      this.engine?.log?.(`[KachatNames] resending the commit for ${p.name} failed: ${errorMessage(error)}`);
      this._set(p, (q) => {
        q.commitSentAt = nowMs();
        q.commitResends = (q.commitResends ?? 0) + 1;
        q.lastError = errorMessage(error);
      });
    }
  }

  /** This wallet holds `name` as a live registration (a lapsed old record of it doesn't count:
   *  that is what claiming an expired name registers over; iOS eea52b2). */
  async _ownsName(name) {
    const me = this.myKey;
    if (!me) return false;
    try {
      const r = await this.registry.lookup(name);
      return r.kind === "registered" && bytesEqual(r.info.owner, me)
        && r.info.status(this.registry.graceMs, BigInt(nowMs())) !== Status.lapsed;
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
      let gap = null;
      if (found.kind === "registered" && found.info.status(this.registry.graceMs, BigInt(nowMs())) === Status.lapsed) {
        // An expired name is free to claim: this registration frees the old record first (anyone
        // may; its bond goes back to the old owner and the freed deposit comes to you), then
        // registers into the gap that reopens (iOS eea52b2). Only sending the reclaim touches the
        // record, so `updatedAt` is when it went out (iOS 4f0bd33).
        if (!p.reclaimTxId) {
          await this._sendReclaim(found.info, p);
          return;
        }
        // The freed gap is the reclaim's output 0: register into it as soon as a node has it,
        // without waiting for the registry (a chain walk, or the indexer) to notice (iOS beb9c45).
        const freed = freedGap(p);
        if (freed) {
          try {
            await this._liveGap(freed, m);
            gap = freed;
          } catch { /* not on a node yet */ }
        }
        if (!gap) {
          if (nowMs() - p.updatedAt > 120_000) {
            this._set(p, (q) => { q.reclaimTxId = null; q.reclaimLo = null; q.reclaimHi = null; }); // never accepted: send it again
          }
          return;
        }
      } else if (found.kind === "registered") {
        if (bytesEqual(found.info.owner, s.me)) this._finishRegistered(p);
        else this._set(p, (q) => { q.stage = Stage.taken; q.lastError = null; });
        return;
      } else {
        if (!found.gap) throw new Failure(`no gap for ${p.name} yet`);
        gap = found.gap;
      }
      const cap = recordPrice(p.maxPrice);
      const rate = await this._registrationFeerate(p);
      const txId = await enqueueSend(s.address, async () => {
        const { builder: b, env, wallet } = await this._context(s, rate);
        const plan = b.register({
          env, wallet, gap: await this._liveGap(gap, m),
          commit: { name: p.name, owner: s.me, salt, value: commit.entry.amount, utxo: commit },
          years: BigInt(p.years), now: registerNow(env),
        });
        // Never pay more than the person confirmed (the fixed prices make this a safeguard).
        if (cap != null && BigInt(plan.priceFee ?? 0n) > cap) throw ActionError.priceChanged(plan.priceFee);
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

  /** Frees a lapsed old record of `p`'s name (a reclaim) and notes the gap it reopens - the two
   *  gaps around the name, merged, which is the reclaim's output 0 (iOS beb9c45). */
  async _sendReclaim(n, p) {
    const gaps = await this.registry.exitGaps(n);
    // at the claim's fee speed (iOS e426432); a claim from before keeps the priority rate
    const tier = parseFeeTier(p?.feeTier);
    const txId = await this.perform(Operation.reclaim(n), { fee: tier ? FeeChoice.tier(tier) : null });
    this._set(p, (q) => {
      q.reclaimTxId = txId;
      q.reclaimLo = hex(gaps.below.lo);
      q.reclaimHi = hex(gaps.above.hi);
      q.lastError = `Freeing ${p.name}.kachat for you...`;
    });
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
    this._pending = Array.isArray(list) ? list.filter((r) => r && typeof r.id === "string" && typeof r.name === "string").map(migrateRecord) : [];
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

/** A stored record from before registry v4: the price-changed stage is gone (fixed prices can't
 *  change), so one stopped there is failed - Try Again or Cancel Commit. */
function migrateRecord(r) {
  if (r.stage !== "priceChanged") return r;
  const { priceChangedTo: _gone, ...rest } = r;
  return { ...rest, stage: Stage.failed, lastError: r.lastError ?? "The registration stopped." };
}

function newId() {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return hex(newSalt()).slice(0, 32);
}

/** The gap a registration's reclaim reopens (its output 0), as a GapInfo; null until the reclaim
 *  went out with its bounds noted (iOS beb9c45). */
export function freedGap(p) {
  if (!p?.reclaimTxId || !p.reclaimLo || !p.reclaimHi) return null;
  try {
    return new GapInfo({ lo: unhex32(p.reclaimLo), hi: unhex32(p.reclaimHi), outpoint: makeOutpoint(unhex32(p.reclaimTxId), 0) });
  } catch {
    return null;
  }
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
