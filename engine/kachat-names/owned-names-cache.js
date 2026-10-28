// .kachat names: Your Domains' saved list (iOS f4f5c0f KachatOwnedNamesCache).
//
// Your Domains' .kachat names and offers, kept on this device per wallet address and network so
// the list shows at once instead of waiting on the registry every time. They rarely change, so
// the screen shows this copy first (minus any name that lapsed since) and the registry read runs
// behind it, replacing the copy only when it answers - a new name, a sale, a transfer or a lapse
// lands then; a failed read leaves the copy, and what is shown, as they were. The domain counts
// start from it too.
//
// Stored in localStorage (or the `storage` adapter given) under `ownedNamesStorageKey(address)`:
// "kachat-names-owned-<mainnet|testnet>-v1:<address>", the network from the address's prefix, as
// the own-profile records are (registry.js ownProfileStorageKey). The entry is JSON
// `{ v, names, offers, savedAt }`: bytes as hex, BigInt as decimal strings (the registry cache's
// convention, registry-state.js RegistryState.toJSON), `savedAt` unix ms. Pure: no DOM, no network.
// Checked by tools/test-kachat-owned-names-cache.mjs.

import { hex, unhex32 } from "./codec.js";
import { NameInfo, OfferInfo, Status, nowMs } from "./registry-state.js";
import { makeOutpoint } from "./transaction.js";

/** The entry's format; another one is ignored (the registry read then fills it again). */
export const ownedNamesFormatVersion = 1;

/** The storage key of `address`'s saved list, on the network its prefix names (`kaspa:` ->
 *  mainnet, anything else -> testnet): "kachat-names-owned-<network>-v1:<address>" (iOS f4f5c0f:
 *  per network and address). */
export function ownedNamesStorageKey(address) {
  const a = String(address ?? "").trim().toLowerCase();
  return `kachat-names-owned-${a.startsWith("kaspa:") ? "mainnet" : "testnet"}-v1:${a}`;
}

const str = (v) => (v == null ? null : String(v));
const big = (v) => (v == null ? null : BigInt(v));
const outpointToJSON = (o) => ({ txid: hex(o.txid), index: Number(o.index) });
const outpointFromJSON = (o) => {
  const index = Number(o?.index);
  if (!Number.isInteger(index) || index < 0) throw new Error("bad outpoint index");
  return makeOutpoint(unhex32(o.txid), index);
};

/** A NameInfo as a JSON-safe object. */
export function nameToJSON(n) {
  return {
    name: n.name, key: hex(n.key), owner: hex(n.owner), price: str(n.price), expiresAt: str(n.expiresAt),
    periodStart: str(n.periodStart), outpoint: outpointToJSON(n.outpoint), registeredAt: str(n.registeredAt),
    registeredTxId: n.registeredTxId ?? null, updatedAt: str(n.updatedAt),
  };
}

/** A NameInfo from `nameToJSON`'s object; throws on a malformed one. */
export function nameFromJSON(j) {
  if (!j || typeof j.name !== "string") throw new Error("bad name");
  return new NameInfo({
    name: j.name, key: unhex32(j.key), owner: unhex32(j.owner), price: BigInt(j.price ?? 0), expiresAt: BigInt(j.expiresAt),
    periodStart: big(j.periodStart), outpoint: outpointFromJSON(j.outpoint), registeredAt: big(j.registeredAt),
    registeredTxId: j.registeredTxId ?? null, updatedAt: big(j.updatedAt),
  });
}

/** An OfferInfo as a JSON-safe object. */
export function offerToJSON(o) {
  return {
    outpoint: outpointToJSON(o.outpoint), key: hex(o.key), name: o.name ?? null, buyer: hex(o.buyer), seller: hex(o.seller),
    amount: str(o.amount), refundAfter: str(o.refundAfter), createdAt: str(o.createdAt),
  };
}

/** An OfferInfo from `offerToJSON`'s object; throws on a malformed one. */
export function offerFromJSON(j) {
  if (!j) throw new Error("bad offer");
  return new OfferInfo({
    outpoint: outpointFromJSON(j.outpoint), key: unhex32(j.key), name: j.name ?? null, buyer: unhex32(j.buyer), seller: unhex32(j.seller),
    amount: BigInt(j.amount), refundAfter: BigInt(j.refundAfter), createdAt: big(j.createdAt),
  });
}

/** The entry as JSON text. */
export function ownedNamesToJSON({ names = [], offers = [], savedAt }) {
  return JSON.stringify({
    v: ownedNamesFormatVersion, names: names.map(nameToJSON), offers: offers.map(offerToJSON), savedAt: Number(savedAt),
  });
}

/** `{ names: NameInfo[], offers: OfferInfo[], savedAt }` from `ownedNamesToJSON`'s text (or its
 *  object); throws on a malformed entry or another format. */
export function ownedNamesFromJSON(j) {
  if (typeof j === "string") j = JSON.parse(j);
  if (!j || typeof j !== "object" || j.v !== ownedNamesFormatVersion || !Array.isArray(j.names)) throw new Error("not a saved .kachat list");
  return {
    names: j.names.map(nameFromJSON),
    offers: (Array.isArray(j.offers) ? j.offers : []).map(offerFromJSON),
    savedAt: Number(j.savedAt) || 0,
  };
}

/** localStorage when the page has it, else memory (Node tests); as actions.js defaultStorage. */
function defaultStorage() {
  const memory = new Map();
  return {
    get(key) {
      try { if (globalThis.localStorage) return globalThis.localStorage.getItem(key); } catch { /* blocked */ }
      return memory.has(key) ? memory.get(key) : null;
    },
    set(key, value) {
      try { if (globalThis.localStorage) { globalThis.localStorage.setItem(key, value); return; } } catch { /* full or blocked */ }
      memory.set(key, value);
    },
  };
}

const notLapsed = (names, graceMs, now) => names.filter((n) => n.status(graceMs, now) !== Status.lapsed);

/**
 * The saved lists. `storage`: `{ get(key) -> string|null, set(key, string) }` (default
 * localStorage); `clock`: `{ now() -> unix ms Number }` (default Date.now).
 */
export class KachatOwnedNamesCache {
  constructor({ storage = null, clock = null } = {}) {
    this.storage = storage ?? defaultStorage();
    this.clock = clock ?? { now: () => Date.now() };
  }

  /** `address`'s saved entry `{ names, offers, savedAt }` as saved, or null (none, or unreadable). */
  load(address) {
    if (!address) return null;
    let text = null;
    try { text = this.storage.get(ownedNamesStorageKey(address)); } catch { text = null; }
    if (!text) return null;
    try { return ownedNamesFromJSON(text); } catch { return null; }
  }

  /** Saves `names` and `offers` as `address`'s list, stamped now. Storage full or blocked: not
   *  saved (the next read fills it again). Returns the entry. */
  save(address, names, offers) {
    const entry = { names: [...(names || [])], offers: [...(offers || [])], savedAt: this.clock.now() };
    if (!address) return entry;
    try { this.storage.set(ownedNamesStorageKey(address), ownedNamesToJSON(entry)); } catch { /* not saved */ }
    return entry;
  }

  /** What Your Domains shows straight away (iOS f4f5c0f showCachedIfNeeded): the saved names minus
   *  any that lapsed since, and the saved offers; null without a saved list. `graceMs` BigInt. */
  shown(address, graceMs, now = nowMs()) {
    const entry = this.load(address);
    if (!entry) return null;
    return { names: notLapsed(entry.names, graceMs, now), offers: entry.offers, savedAt: entry.savedAt };
  }

  /** How many names the saved list holds, for the domain counts before the registry answers (iOS
   *  f4f5c0f: `cached.names.count`); null without a saved list. */
  count(address) {
    const entry = this.load(address);
    return entry ? entry.names.length : null;
  }

  /**
   * What Your Domains shows after a registry read (iOS f4f5c0f load()). `answer`: the read's
   * `{ names, offers }`, or null when it failed. An answer replaces what is shown and the saved
   * copy; a failed read keeps `shown` (`{ names, offers }`, what is on screen) - minus any name
   * that lapsed meanwhile (iOS dropLapsed) - and leaves the saved copy as it was.
   * -> `{ names, offers, answered }`
   */
  afterRead(address, shown, answer, graceMs, now = nowMs()) {
    if (answer) {
      const names = [...(answer.names || [])];
      const offers = [...(answer.offers || [])];
      this.save(address, names, offers);
      return { names, offers, answered: true };
    }
    return { names: notLapsed(shown?.names || [], graceMs, now), offers: [...(shown?.offers || [])], answered: false };
  }
}
