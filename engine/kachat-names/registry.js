// .kachat names: the registry for the screens.
//
// Port of iOS KaChat/Services/KachatNames/KachatNamesRegistry.swift. Lookups, an owner's names,
// listings, lapsed names, offers, history, activity, the gaps around a name and identities, from
// one of two sources:
//
// - the names indexer (KACHAT_NAMES_INDEXER.md Part D) at `indexerBase()`, used when that is set
//   and `GET /names/status` answers 200 for this manifest's registry id;
// - the chain walker otherwise: the registry's live UTXO set (gaps and names, plus the offers this
//   device made) kept from the manifest's genesis gap forward. A refresh asks a node which tracked
//   UTXOs are still unspent (`getUtxosByAddresses`), finds each spent one's spending transaction
//   through the Kaspa REST API (`GET /addresses/{p2sh}/full-transactions`), decodes the spend like
//   the indexer does (B3), verifies every new state against its output script and moves on.
//   Cached per network in `storage`.
//
// Records from either source are only read here; every action must re-read its UTXOs from a node
// before it builds anything. The registry is testnet-10 only. Every I/O dependency is injected (no
// app imports), and nothing runs at import.
//
// Where the network has no registry (`isEnabled()` false: mainnet, iOS d36fc42) the registry is
// inert - `prepare()` and every registry read refuse, refreshes are no-ops - and only the address
// profile side works: `identity(address)` answers a profile-only identity (no label, no names) from
// this device's own saved record, else the indexer's `GET /profiles/{address}`. A 503 there pauses
// all profile lookups for 10 minutes, any other failure that address for 5 minutes. Own profile
// records are stored per network (`ownProfileStorageKey`).
//
// The Swift file also holds KachatSocialImageResolver (a profile's avatar, banner and bio, looked
// up on the device from its social links). Here it lives in social-image-resolver.js and is
// re-exported below; the app keeps one instance with its own fetch and storage.

import { Failure, hex, normalize, validate, isValid, key as nameKey } from "./codec.js";
import {
  RegistryState, TxView, Lookup, IndexerAPI, Profile, Status, label as labelOf, makeIdentity, byRegistration,
  addressOf, keyOf, shortAddress, p2shAddress, step, decodeAddress,
} from "./registry-state.js";

export {
  KachatSocialImageResolver, socialImageCachePrefix, socialFreshForMs, socialLookupDeadlineMs, socialRequestTimeoutMs, socialRecentMs,
} from "./social-image-resolver.js";

/** The storage key of the walker's cache (testnet-10). */
export const registryCacheKey = "kachat-names-registry-testnet-v1";
/** The storage key prefix of this device's own profile records on testnet (`<prefix>:<address>`). */
export const ownProfileKeyPrefix = "kachat-names-profile-testnet-v1";
/** The own-profile storage key prefix of a network ("mainnet" | "testnet"): "kachat-names-profile-<network>-v1"
 *  (testnet's is `ownProfileKeyPrefix`, so records saved before mainnet profiles existed are found). */
export function ownProfileKeyPrefixFor(network) {
  return `kachat-names-profile-${network === "mainnet" ? "mainnet" : "testnet"}-v1`;
}
/** The storage key of this device's own profile record for `address`, on the network its prefix
 *  names (`kaspa:` -> mainnet, anything else -> testnet): `<ownProfileKeyPrefixFor(network)>:<address>`. */
export function ownProfileStorageKey(address) {
  const a = String(address ?? "").trim().toLowerCase();
  return `${ownProfileKeyPrefixFor(a.startsWith("kaspa:") ? "mainnet" : "testnet")}:${a}`;
}
/** A 503 from `GET /profiles/{address}` (an indexer without the profiles follower) pauses every
 *  profile-only lookup this long (10 minutes). */
export const profilesUnavailablePauseMs = 600_000;
/** Any other failed profile-only lookup pauses that address this long (5 minutes). */
export const profileMissPauseMs = 300_000;
const profileMissesMax = 2000;
/** Grace when no manifest is loaded yet (10 days). */
const defaultGraceMs = 864_000_000n;

/** `JSON.parse` that keeps integers past 2^53 exact (as BigInt), like Swift's JSONSerialization.
 *  Uses the reviver's source text where the engine has it (ES2025 JSON.parse source text access). */
export function parseJSONExact(text) {
  return JSON.parse(text, function reviver(_k, v, ctx) {
    if (typeof v === "number" && !Number.isSafeInteger(v) && ctx && typeof ctx.source === "string" && /^-?[0-9]+$/.test(ctx.source)) {
      return BigInt(ctx.source);
    }
    return v;
  });
}

function trimBase(raw) {
  const s = String(raw ?? "").trim();
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

function bigNow(v) { return typeof v === "bigint" ? v : BigInt(Math.trunc(Number(v))); }

function bytesOfHexOrBytes(v) {
  if (v instanceof Uint8Array) return v;
  if (typeof v === "string" && /^[0-9a-fA-F]{64}$/.test(v)) {
    const out = new Uint8Array(32);
    for (let i = 0; i < 32; i++) out[i] = parseInt(v.slice(2 * i, 2 * i + 2), 16);
    return out;
  }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Whether `error` means the registry is being upgraded (a registry v1 manifest), not a failure:
 *  service.js `ServiceError.registryUpgrading()` (code "registryUpgrading") or the core's
 *  `Failure.outdatedRegistry()`. (service.js `isRegistryUpgrading`, kept here by shape so this
 *  module needs no app imports.) */
function isUpgradingError(error) {
  if (error == null || typeof error !== "object") return false;
  return error.code === "registryUpgrading" || (error instanceof Failure && error.isOutdatedRegistry === true);
}

/**
 * The registry. One per network/session; `reset()` on a network switch or logout.
 *
 * deps:
 *  - `fetch`: WHATWG fetch (default globalThis.fetch)
 *  - `restBase()`: Kaspa REST API base URL (desktop: getEndpoint("kaspaApi"))
 *  - `indexerBase()`: names indexer base URL, "" for none (desktop: getEndpoint("kasiaIndexer"))
 *  - `getUtxosByAddresses(addresses: string[])` -> Promise<Array<{ outpoint: { transactionId: hex string,
 *      index: number }, covenantId: hex string | Uint8Array | null, ... }>>: a node's UTXOs at those
 *      addresses. Only `outpoint.transactionId`, `outpoint.index` and `covenantId` are read; the rest
 *      of the usual shape (amount: BigInt, scriptPublicKey, blockDaaScore: BigInt, isCoinbase) is
 *      ignored. `covenantId` null/absent = unknown (a REST fallback): accepted. Called with at most 50
 *      addresses at a time.
 *  - `storage`: `{ get(key) -> string|null, set(key, string) }`, sync or async (desktop: localStorage)
 *  - `manifest`: a verified Manifest (manifest.js), or a (sync/async) function returning one; called
 *      once and kept
 *  - `now()`: unix ms (Number or BigInt; default Date.now)
 *  - optional: `isEnabled()` (default true; false makes refresh a no-op, as iOS
 *      KachatNamesService.isLaunched - the app passes that gate), `log(...args)` (default console.log), `cacheKey`
 *      (default "kachat-names-registry-testnet-v1"), `sleep(ms)`.
 */
export class KachatNamesRegistry {
  constructor(deps = {}) {
    this.deps = {
      fetch: deps.fetch ?? ((...a) => globalThis.fetch(...a)),
      restBase: deps.restBase ?? (() => ""),
      indexerBase: deps.indexerBase ?? (() => ""),
      getUtxosByAddresses: deps.getUtxosByAddresses ?? null,
      storage: deps.storage ?? null,
      manifest: deps.manifest ?? null,
      now: deps.now ?? (() => Date.now()),
      isEnabled: deps.isEnabled ?? (() => true),
      log: deps.log ?? ((...a) => console.log(...a)),
      cacheKey: deps.cacheKey ?? registryCacheKey,
      sleep: deps.sleep ?? sleep,
    };
    /** `{ kind: "indexer", base }` | `{ kind: "chain" }` | null (not chosen yet) */
    this.source = null;
    /** the walker's RegistryState (chain source only) */
    this.chainState = null;
    this.isRefreshing = false;
    /** the last refresh's error message, or null */
    this.lastError = null;
    /** whether the last refresh failed because the registry is being upgraded (a registry v1
     *  manifest; service.registryUpgrading says the same): show "Setting up", not `lastError` */
    this.registryUpgrading = false;
    /** unix ms (Number) of the last refresh attempt, successful or not (a failed one counts too,
     *  so `refreshIfStale` waits before the next), or null */
    this.refreshedAt = null;
    /** bumped whenever registry data may have changed, so screens reload */
    this.revision = 0;
    /** the last chain walk's report `{ rounds, applied, events, unresolved }`, or null */
    this.lastWalk = null;
    /** the verified manifest once loaded */
    this.manifest = null;
    this._cacheNetwork = null;
    this._ownProfiles = new Map();
    this._listeners = new Set();
    this._refreshing = null;
    /** unix ms until which profile-only lookups are paused (the indexer answered 503) */
    this._profilesUnavailableUntil = 0;
    /** lowercased address -> unix ms of its last failed profile-only lookup */
    this._profileMisses = new Map();
  }

  // MARK: - Observing (Swift @Published)

  /** `listener(registry)` after every change of `revision`; returns an unsubscribe function. */
  onChange(listener) {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  _bump() {
    this.revision += 1;
    for (const l of [...this._listeners]) {
      try { l(this); } catch (e) { this.deps.log("[KachatNames] listener failed:", e?.message ?? e); }
    }
  }

  _nowMs() { return bigNow(this.deps.now()); }

  // MARK: - Setup

  async _loadManifest() {
    if (this.manifest) return this.manifest;
    const m = typeof this.deps.manifest === "function" ? await this.deps.manifest() : this.deps.manifest;
    if (!m) throw new Failure("the .kachat manifest is not loaded");
    this.manifest = m;
    return m;
  }

  /** The verified manifest, with the source picked and the walker's cache loaded. Refuses where
   *  the network has no registry (`isEnabled()` false), so no registry read runs there. */
  async prepare({ forceSourceCheck = false } = {}) {
    if (!this.deps.isEnabled()) throw new Failure("there is no .kachat registry on this network yet");
    const m = await this._loadManifest();
    if (this.source == null || forceSourceCheck) {
      this.source = await this._chooseSource(m);
    }
    if (this.source.kind === "chain" && (this.chainState == null || this._cacheNetwork !== m.network)) {
      this.chainState = (await this._loadCache(m)) ?? RegistryState.atGenesis(m);
      this._cacheNetwork = m.network;
    }
    return m;
  }

  /** Forget everything in memory (network switch, logout). */
  reset() {
    this.source = null;
    this.chainState = null;
    this._cacheNetwork = null;
    this._ownProfiles = new Map();
    this._profilesUnavailableUntil = 0;
    this._profileMisses = new Map();
    this.lastError = null;
    this.registryUpgrading = false;
    this.refreshedAt = null;
    this._bump();
  }

  /** Whether this network has a live registry (the `isEnabled()` dep): false = profiles only. */
  get isLaunched() { return !!this.deps.isEnabled(); }

  /** The manifest's grace period (ms, BigInt). */
  get graceMs() { return this.manifest?.params.graceMs ?? defaultGraceMs; }

  /** Whether the names indexer is the source. */
  get isIndexer() { return this.source?.kind === "indexer"; }

  async _chooseSource(m) {
    const base = this.indexerBase();
    if (!base) return { kind: "chain" };
    try {
      const status = IndexerAPI.status(await this._get(base, "/names/status"));
      if (status.registryCovenantId?.toLowerCase() === hex(m.registryCovenantId)) return { kind: "indexer", base };
    } catch { /* no indexer: walk the chain */ }
    return { kind: "chain" };
  }

  /** The names indexer base URL without a trailing slash, or null. */
  indexerBase() {
    const raw = String(this.deps.indexerBase() ?? "").trim();
    if (!raw) return null;
    return raw.endsWith("/") ? raw.slice(0, -1) : raw;
  }

  _restBase() { return trimBase(this.deps.restBase()); }

  // MARK: - Refresh

  /** Walks the chain forward (no indexer) or just marks fresh data (indexer). Safe to call often:
   *  a call while one runs returns the running one. Never throws (the error lands in `lastError`).
   *  A failed refresh counts as an attempt too (`refreshIfStale` waits `maxAge` before the next)
   *  and bumps `revision` only when the error changed, so screens that reload on `revision` (and
   *  refresh from there) can't turn a refusal into a refresh loop. */
  refresh({ forceSourceCheck = false } = {}) {
    if (!this.deps.isEnabled()) return Promise.resolve();
    if (this._refreshing) return this._refreshing;
    this.isRefreshing = true;
    this._refreshing = (async () => {
      const previousError = this.lastError;
      let changed = true;
      try {
        const m = await this.prepare({ forceSourceCheck });
        if (this.source.kind === "chain") await this._walk(m);
        this.lastError = null;
        this.registryUpgrading = false;
        this.refreshedAt = Number(this._nowMs());
      } catch (e) {
        const message = e?.message ?? String(e);
        const upgrading = isUpgradingError(e);
        this.lastError = message;
        this.registryUpgrading = upgrading;
        this.refreshedAt = Number(this._nowMs());
        changed = message !== previousError;
        if (changed && !upgrading) this.deps.log("[KachatNames] registry refresh failed:", message);
      } finally {
        this.isRefreshing = false;
        this._refreshing = null;
      }
      if (changed) this._bump();
    })();
    return this._refreshing;
  }

  /** `refresh()` unless the last one is younger than `maxAge` seconds (lookups from typed names). */
  async refreshIfStale({ maxAge = 60 } = {}) {
    const at = this.refreshedAt;
    if (at != null && Number(this._nowMs()) - at < maxAge * 1000) return;
    await this.refresh();
  }

  async _walk(m) {
    const state = (this.chainState ?? RegistryState.atGenesis(m)).clone();
    const registryId = hex(m.registryCovenantId);
    const report = await state.walk({
      manifest: m,
      address: (script) => p2shAddress(script),
      live: (addresses) => this._liveOutpoints(addresses, registryId),
      transactions: (address) => this.restTransactions(address),
    });
    state.verifiedAt = this._nowMs();
    if (report.applied.length) {
      this.deps.log(`[KachatNames] walked ${report.applied.length} registry transaction(s) in ${report.rounds} round(s)`);
    }
    if (report.unresolved.length) {
      this.deps.log(`[KachatNames] ${report.unresolved.length} spent registry UTXO(s) wait for the REST API to index their spend`);
    }
    this.chainState = state;
    this.lastWalk = report;
    await this._saveCache(state);
    return report;
  }

  /** The unspent "txid:index" outpoints at those addresses, from the node (50 addresses a call). */
  async _liveOutpoints(addresses, registryId) {
    if (typeof this.deps.getUtxosByAddresses !== "function") throw new Failure("no node to read the registry from");
    const out = new Set();
    for (let start = 0; start < addresses.length; start += 50) {
      const chunk = addresses.slice(start, start + 50);
      for (const u of (await this.deps.getUtxosByAddresses(chunk)) ?? []) {
        // A node reports the covenant id; the REST fallback cannot (null). A UTXO carrying
        // another id is not the registry's.
        const c = u.covenantId ?? null;
        const cs = c instanceof Uint8Array ? hex(c) : c;
        if (typeof cs === "string" && cs.length && cs.toLowerCase() !== registryId) continue;
        const op = u.outpoint ?? {};
        const txid = String(op.transactionId ?? op.txid ?? "").toLowerCase();
        out.add(`${txid}:${Number(op.index)}`);
      }
    }
    return out;
  }

  /** Accepted transactions touching `address`, newest first (kaspa-rest-server), as TxViews. */
  async restTransactions(address) {
    const base = this._restBase();
    if (!base) throw new Failure("bad Kaspa REST API URL");
    const url = `${base}/addresses/${address}/full-transactions?limit=50&offset=0&resolve_previous_outpoints=no`;
    const res = await this._fetch(url, 20_000);
    if (res.status !== 200) throw new Failure(`the Kaspa REST API answered ${res.status} for ${address}`);
    const list = parseJSONExact(await res.text());
    if (!Array.isArray(list)) return [];
    return list.map((j) => TxView.fromREST(j)).filter(Boolean);
  }

  /** Whether the REST API has seen `txId` accepted. */
  async isAccepted(txId) {
    try {
      const base = this._restBase();
      if (!base) return false;
      const res = await this._fetch(`${base}/transactions/${txId}?inputs=false&outputs=false&resolve_previous_outpoints=no`, 15_000);
      if (res.status !== 200) return false;
      const j = await res.json();
      return j?.is_accepted === true;
    } catch {
      return false;
    }
  }

  /** After a submit: wait (up to ~2 minutes) for the transaction to be accepted, then refresh.
   *  Returns the promise (callers need not await it). */
  refreshAfter(txId) {
    if (!this.deps.isEnabled()) return Promise.resolve();
    return (async () => {
      for (let attempt = 0; attempt < 40; attempt++) {
        await this.deps.sleep((attempt < 5 ? 2 : 3) * 1000);
        if (await this.isAccepted(txId)) break;
      }
      await this.refresh();
    })();
  }

  // MARK: - Reads

  /** A typed name (any case, `.kachat` optional): `{ kind: "registered", name, info: NameInfo }` or
   *  `{ kind: "free", name, gap: GapInfo|null }`. Throws on an invalid name. */
  async lookup(raw) {
    await this.prepare();
    const name = normalize(raw);
    validate(name);
    if (this.source.kind === "indexer") {
      const j = IndexerAPI.nameJSON(await this._get(this.source.base, `/names/${name}`));
      const info = IndexerAPI.nameInfo(j, keyOf);
      if (info) return Lookup.registered(info);
      return Lookup.free(name, j.gap);
    }
    const st = this.chainState;
    if (!st) throw new Failure("the registry is not loaded");
    const n = st.name(name);
    if (n) return Lookup.registered(RegistryState.nameInfo(n));
    const g = st.gapContaining(nameKey(name));
    return Lookup.free(name, g ? RegistryState.gapInfo(g) : null);
  }

  /** The names an owner (x-only key bytes or 64-hex) holds, oldest first; `includeInactive` adds
   *  grace and lapsed ones. Swift `names(owner:includeInactive:)`. The second argument is
   *  `{ includeInactive }` or a boolean. */
  async namesOf(owner, opts = {}) {
    const includeInactive = typeof opts === "boolean" ? opts : !!opts?.includeInactive;
    await this.prepare();
    const ownerBytes = bytesOfHexOrBytes(owner);
    if (!ownerBytes) return [];
    let all;
    if (this.source.kind === "indexer") {
      const address = addressOf(ownerBytes);
      if (!address) return [];
      all = IndexerAPI.names(await this._get(this.source.base, `/names/by-owner/${address}?includeInactive=${includeInactive}`), keyOf);
    } else {
      const ownerHex = hex(ownerBytes);
      all = (this.chainState?.names ?? []).filter((n) => n.owner === ownerHex).map((n) => RegistryState.nameInfo(n));
    }
    const grace = this.graceMs, now = this._nowMs();
    return all.filter((n) => includeInactive || n.status(grace, now) === Status.active).sort(byRegistration);
  }

  /** Which of `addresses` own at least one .kachat name - active, in grace or lapsed, the same set
   *  Your Domains lists (iOS ownersOfNames, 881ada6). Drives the "Contains domain" tag on Manage
   *  Addresses and KasSigner. Empty where the registry is off (`isEnabled()` false: mainnet); an
   *  address whose lookup fails just isn't tagged. -> Promise<Set<string>> (the addresses as given). */
  async ownersOfNames(addresses) {
    const list = Array.isArray(addresses) ? addresses.filter((a) => typeof a === "string" && a) : [];
    const owners = new Set();
    if (!this.deps.isEnabled() || list.length === 0) return owners;
    if (this.refreshedAt == null) await this.refresh();
    for (const address of list) {
      const key = keyOf(address);
      if (!key) continue;
      try {
        if ((await this.namesOf(key, { includeInactive: true })).length > 0) owners.add(address);
      } catch { /* not tagged */ }
    }
    return owners;
  }

  /** Active names listed for sale, most recently changed first. */
  async listings() {
    await this.prepare();
    if (this.source.kind === "indexer") {
      return IndexerAPI.listings(await this._get(this.source.base, "/market/listings?sort=recent"), keyOf).listings;
    }
    const grace = this.graceMs, now = this._nowMs();
    return (this.chainState?.names ?? []).map((n) => RegistryState.nameInfo(n))
      .filter((n) => n.isListed && n.status(grace, now) === Status.active)
      .sort((a, b) => { const x = a.updatedAt ?? 0n, y = b.updatedAt ?? 0n; return x > y ? -1 : x < y ? 1 : 0; });
  }

  /** Lapsed names anyone may reclaim, oldest expiry first. */
  async lapsed() {
    await this.prepare();
    if (this.source.kind === "indexer") {
      return IndexerAPI.names(await this._get(this.source.base, "/names/expiring"), keyOf);
    }
    const grace = this.graceMs, now = this._nowMs();
    return (this.chainState?.names ?? []).map((n) => RegistryState.nameInfo(n))
      .filter((n) => n.status(grace, now) === Status.lapsed)
      .sort((a, b) => (a.expiresAt < b.expiresAt ? -1 : a.expiresAt > b.expiresAt ? 1 : 0));
  }

  /** Open offers on a name, highest first. Without an indexer only the offers this device made
   *  are known. Swift `offers(for:)`. */
  async offersFor(name) {
    await this.prepare();
    const byAmount = (a, b) => (a.amount > b.amount ? -1 : a.amount < b.amount ? 1 : 0);
    if (this.source.kind === "indexer") {
      return IndexerAPI.offers(await this._get(this.source.base, `/names/${encodeURIComponent(name)}/offers`), name, keyOf).sort(byAmount);
    }
    const k = hex(nameKey(name));
    return (this.chainState?.offers ?? []).filter((o) => o.key === k).map((o) => RegistryState.offerInfo(o)).sort(byAmount);
  }

  /** Alias of `offersFor`. */
  offers(name) { return this.offersFor(name); }

  /** The offers `buyer` (x-only key bytes or 64-hex) made that are still open. */
  async myOffers(buyer) {
    await this.prepare();
    const buyerBytes = bytesOfHexOrBytes(buyer);
    if (!buyerBytes) return [];
    if (this.source.kind === "indexer") {
      const address = addressOf(buyerBytes);
      if (!address) return [];
      return IndexerAPI.offers(await this._get(this.source.base, `/offers/by-buyer/${address}`), null, keyOf);
    }
    const me = hex(buyerBytes);
    return (this.chainState?.offers ?? []).filter((o) => o.buyer === me).map((o) => RegistryState.offerInfo(o));
  }

  /** A name's history (Event[]), newest first. The walker knows every registry transition it walked. */
  async history(name) {
    await this.prepare();
    if (this.source.kind === "indexer") {
      return IndexerAPI.events(await this._get(this.source.base, `/names/${encodeURIComponent(name)}/history`)).events;
    }
    return (this.chainState?.events ?? []).filter((e) => e.name === name).reverse();
  }

  /** Recent registry activity (Event[]), newest first. */
  async activity() {
    await this.prepare();
    if (this.source.kind === "indexer") {
      return IndexerAPI.events(await this._get(this.source.base, "/market/activity")).events;
    }
    return [...(this.chainState?.events ?? [])].reverse().slice(0, 200);
  }

  /** The two gaps around a registered name (a NameInfo): `{ below: GapInfo, above: GapInfo }`, what
   *  release and reclaim spend. Swift `exitGaps(for:)`. */
  async exitGaps(n) {
    await this.prepare();
    if (this.source.kind === "indexer") {
      const down = step(n.key, -1), up = step(n.key, 1);
      if (!down || !up) throw new Failure(`no gaps around ${n.name}`);
      const below = IndexerAPI.gap(await this._get(this.source.base, `/names/gap/${hex(down)}`));
      const above = IndexerAPI.gap(await this._get(this.source.base, `/names/gap/${hex(up)}`));
      if (!below || !above || hex(below.hi) !== hex(n.key) || hex(above.lo) !== hex(n.key)) {
        throw new Failure(`the indexer has no gaps around ${n.name}`);
      }
      return { below, above };
    }
    const nb = this.chainState?.neighbours(n.key);
    if (!nb) throw new Failure(`no gaps around ${n.name} yet - refresh`);
    return { below: RegistryState.gapInfo(nb.below), above: RegistryState.gapInfo(nb.above) };
  }

  /** Alias of `exitGaps`. */
  exitGapsFor(n) { return this.exitGaps(n); }

  // MARK: - Resolution (iOS 25cc2c9, NameServicesClient.resolveKachat)

  /** The `kaspatest:` address an ACTIVE name resolves to, or null (not registered, in grace,
   *  lapsed, or not a valid name). Refreshes first when the data is older than a minute. Throws
   *  when the registry cannot be read (the caller shows the lookup as failed). */
  async resolveActive(raw) {
    const name = normalize(raw);
    if (!isValid(name)) return null;
    await this.refreshIfStale();
    const r = await this.lookup(name);
    if (r.kind !== "registered") return null;
    if (r.info.status(this.graceMs, this._nowMs()) !== Status.active) return null;
    return addressOf(r.info.owner);
  }

  // MARK: - Identity and profiles

  /** The label and profile of an address (KACHAT_NAMES.md section 7): `{ address, label, names,
   *  profile }`. Without an indexer the label comes from the walked names, and the profile is known
   *  only for this wallet's own address (the record it last wrote). Where the network has no
   *  registry (mainnet) it is `profileOnlyIdentity`. */
  async identity(rawAddress) {
    const address = String(rawAddress).trim().toLowerCase();
    if (!this.deps.isEnabled()) return this.profileOnlyIdentity(address);
    await this.prepare();
    if (this.source.kind === "indexer") {
      return IndexerAPI.identity(await this._get(this.source.base, `/identity/${address}`));
    }
    const k = keyOf(address);
    if (!k) return makeIdentity({ address });
    const owned = await this.namesOf(k, { includeInactive: false });
    const profile = (await this.ownProfile(address))?.profile ?? null;
    const lbl = labelOf(owned, profile?.primaryName ?? null, this.graceMs, this._nowMs());
    return makeIdentity({ address, label: lbl, names: owned.map((n) => n.name), profile });
  }

  /**
   * An address's identity where the network has no registry yet (mainnet, iOS d36fc42
   * profileOnlyIdentity): `{ address, label: null, names: [], profile: Profile|null }`. This
   * device's own saved record for the address wins; else the indexer's `GET /profiles/{address}`
   * (200 with `profile: null` = no profile). A 503 there (no profiles follower on this network)
   * pauses every lookup for `profilesUnavailablePauseMs` (10 min); any other failure pauses that
   * address for `profileMissPauseMs` (5 min). While paused, or with no indexer, it throws without
   * a request, so a render loop can't become a request loop. Works on either network (it reads no
   * registry data); `identity()` uses it where `isEnabled()` is false.
   */
  async profileOnlyIdentity(rawAddress) {
    const address = String(rawAddress ?? "").trim().toLowerCase();
    const own = (await this.ownProfile(address))?.profile ?? null;
    if (own) return makeIdentity({ address, profile: own.sanitized() });
    // not a Kaspa address: nothing to ask (and nothing unchecked goes into the URL)
    if (!decodeAddress(address)) return makeIdentity({ address });
    const now = Number(this._nowMs());
    const base = this.indexerBase();
    if (!base || now < this._profilesUnavailableUntil) throw new Failure("profiles are not indexed on this network yet");
    const missed = this._profileMisses.get(address);
    if (missed != null && now - missed < profileMissPauseMs) throw new Failure("this profile lookup failed recently");
    const miss = (message) => {
      this._profileMisses.delete(address);
      this._profileMisses.set(address, now);
      while (this._profileMisses.size > profileMissesMax) this._profileMisses.delete(this._profileMisses.keys().next().value);
      return new Failure(message);
    };
    let res;
    try {
      res = await this._fetch(`${base}/profiles/${address}`, 15_000);
    } catch (e) {
      throw miss(`the names indexer could not be reached (${e?.message ?? e})`);
    }
    if (res.status === 503) {
      this._profilesUnavailableUntil = now + profilesUnavailablePauseMs;
      throw miss("the names indexer answered 503");
    }
    if (res.status !== 200) throw miss(res.status === 404 ? "not found" : `the names indexer answered ${res.status}`);
    let record;
    try {
      record = IndexerAPI.profile(JSON.parse(await res.text()));
    } catch {
      throw miss("the names indexer sent an unreadable profile");
    }
    this._profileMisses.delete(address);
    return makeIdentity({ address, profile: record.profile?.sanitized() ?? null });
  }

  /** Unix ms until which profile-only lookups are paused after a 503 (0 = not paused). */
  get profilesPausedUntil() { return this._profilesUnavailableUntil; }

  /** The profile record this device last wrote for `address`: `{ address, profile: Profile, txId,
   *  at: Number }` or null. Swift `ownProfile(for:)`. Stored per network (`ownProfileStorageKey`). */
  async ownProfile(rawAddress) {
    const address = String(rawAddress).trim().toLowerCase();
    if (this._ownProfiles.has(address)) return this._ownProfiles.get(address);
    const text = await this._storageGet(ownProfileStorageKey(address));
    if (!text) return null;
    try {
      const j = JSON.parse(text);
      const profile = Profile.fromJSONObject(j.profile);
      if (!profile || typeof j.address !== "string" || typeof j.txId !== "string") return null;
      const p = { address: j.address, profile, txId: j.txId, at: Number(j.at) };
      this._ownProfiles.set(address, p);
      return p;
    } catch {
      return null;
    }
  }

  /** Remember the profile record this wallet just wrote (a Profile or its plain fields). */
  async noteOwnProfile(profile, rawAddress, txId) {
    const p = profile instanceof Profile ? profile : new Profile(profile ?? {});
    const record = { address: String(rawAddress).trim().toLowerCase(), profile: p.sanitized(), txId, at: Number(this._nowMs()) };
    this._ownProfiles.set(record.address, record);
    this._profileMisses.delete(record.address);
    await this._storageSet(ownProfileStorageKey(record.address), JSON.stringify({ ...record, profile: record.profile.toJSON() }));
    this._bump();
  }

  /** An offer (OfferInfo) this wallet just created: tracked by the walker from now on. */
  async trackOffer(offer) {
    const st = this.chainState;
    if (!st) return;
    const next = st.clone();
    next.trackOffer(offer, this._nowMs());
    this.chainState = next;
    await this._saveCache(next);
    this._bump();
  }

  // MARK: - Addresses

  /** The `kaspatest:` Schnorr address of an x-only key, or null. Swift `address(of:)`. */
  static addressOf(xonly) { return addressOf(xonly); }
  /** The x-only key of a `kaspatest:` Schnorr address, or null. */
  static keyOf(address) { return keyOf(address); }
  /** `kaspatest:qr...xyz4`. */
  static shortAddress(address) { return shortAddress(address); }

  // MARK: - HTTP

  async _fetch(url, timeoutMs) {
    const ctrl = typeof AbortController === "function" ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
    try {
      return await this.deps.fetch(url, { headers: { Accept: "application/json" }, cache: "no-store", ...(ctrl ? { signal: ctrl.signal } : {}) });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async _get(base, path) {
    const res = await this._fetch(base + path, 25_000);
    if (res.status !== 200) {
      if (res.status === 404) throw new Failure("not found");
      throw new Failure(`the names indexer answered ${res.status}`);
    }
    return JSON.parse(await res.text());
  }

  // MARK: - Cache

  async _storageGet(k) {
    try { return (await this.deps.storage?.get(k)) ?? null; } catch { return null; }
  }

  async _storageSet(k, v) {
    try { await this.deps.storage?.set(k, v); } catch (e) { this.deps.log("[KachatNames] could not save", k, e?.message ?? e); }
  }

  async _loadCache(m) {
    const text = await this._storageGet(this.deps.cacheKey);
    if (!text) return null;
    try {
      const st = RegistryState.fromJSON(text);
      if (!st.matches(m)) return null;
      st.checkInvariants();
      return st;
    } catch {
      return null;
    }
  }

  async _saveCache(st) {
    await this._storageSet(this.deps.cacheKey, JSON.stringify(st.toJSON()));
  }
}

export { addressOf, keyOf, shortAddress, p2shAddress };
