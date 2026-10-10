// .kachat names: the app side of the transaction core.
//
// Port of iOS KaChat/Services/KachatNames/KachatNamesService.swift. The core (codec, transaction,
// manifest, builder) is pure and checked against the kachat-domains vectors; this service adds
// what needs the app: the network gate, loading and verifying the manifest, the node's DAG point,
// the wallet's and the registry's live UTXOs, BIP-340 Schnorr signing with the wallet key
// (SIGHASH_ALL over the version-1 sighash, @noble/curves), the conversion to the Kaspa WASM SDK's
// Transaction with the Toccata fields, and submission through the engine's RPC client.
//
// Names run on testnet-10 and, since the mainnet v1 launch on 2026-10-09, on mainnet (iOS ef6b21e):
// each network has its own bundled manifest (kachat-names-<network>.json), its own pinned templates
// and price tables (manifest.js), and its own address prefix (`addressPrefix`). The manifest in use
// always matches the network the app runs on (`networkName`, engine/network.js NETWORK_ID); every
// registry entry point refuses where the network has no registry (`isLaunched`). The .kachat UI
// and identity are on for every network (`isEnabled`, iOS 7227d69), and the address profile record
// is not registry data (`profilesEnabled`, iOS d36fc42): a `kchat:1:profile:` self-send from the
// wallet's address on the network the app runs on.
//
// Nothing runs at import. `new KachatNamesService(engine)` takes the KaspaEngine (engine/index.js);
// it uses engine.kaspa, engine.currentDagPoint(), engine.getUtxosWithCovenants(addresses),
// engine.submitRpcTransaction(wasmTx), engine.address / engine.privateKey for the profile record.
//
// A screen: `loadManifest()`, read the records it needs (registry.js), confirm them with
// `liveRegistryUtxo`, `environment(...)`, build with `builder()`, show the plan's fee, then
// `signAndSubmit`. KachatNamesActions (actions.js) does all of that per operation.

import { schnorr, secp256k1 } from "@noble/curves/secp256k1.js";
import testnetManifestJson from "./kachat-names-testnet-10.json" with { type: "json" };
import mainnetManifestJson from "./kachat-names-mainnet.json" with { type: "json" };

import { NETWORK_ID, ADDRESS_HRP, isNetworkAddress } from "../network.js";
import { getEndpoint } from "../endpoints.js";
import { sendKaspa, excludeReservedUtxos } from "../transactions.js";
import {
  Failure, minFeerate, maxProfileJSONBytes, hex, unhex, unhex32, bytesEqual, concat, utf8, fromUtf8,
  p2pkScript, profilePayload,
} from "./codec.js";
import { makeOutpoint, makeUtxo, makeUtxoEntry, txIdHex } from "./transaction.js";
import { decodeManifest, verifyManifest, ManifestSource, supportedNetworks } from "./manifest.js";
import { Builder, makeEnv, planSignedBy, recommendedBudgetsFor } from "./builder.js";
import { addressPrefix, addressOf, keyOf, p2shAddress } from "./registry-state.js";

// MARK: - Errors

/** Swift `KachatNamesService.ServiceError`; `code` is the case name. */
export class ServiceError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = "ServiceError";
    this.code = code;
    Object.assign(this, extra);
  }

  static testnetOnly() { return new ServiceError("testnetOnly", ".kachat names aren't live on this network yet"); }
  /** The address is not on the network the app runs on (iOS d36fc42). */
  static wrongAddressNetwork() { return new ServiceError("wrongAddressNetwork", "This address is on a different network than the app."); }
  static noManifest(why) { return new ServiceError("noManifest", `No .kachat registry manifest: ${why}`); }
  static dryRunManifest() { return new ServiceError("dryRunManifest", "The .kachat manifest is from a dry run; that registry does not exist"); }
  static wrongNodeNetwork(n) { return new ServiceError("wrongNodeNetwork", `The node is on ${n}, not ${KachatNamesService.networkName}`); }
  static keyMismatch() { return new ServiceError("keyMismatch", "The signing key is not the key the transaction was built for"); }
  static notOnChain(what) { return new ServiceError("notOnChain", `${what} is not on chain (or not with the registry covenant id)`); }
  static badProfile(why) { return new ServiceError("badProfile", `Profile: ${why}`); }
  static submitMismatch(expected, got) {
    return new ServiceError("submitMismatch", `The node accepted ${got}, expected ${expected}`, { expected, got });
  }
  /** The manifest is a registry version this app doesn't build for (v1 - v3, or later than v5);
   *  this app builds for v4 and v5. Not a failure to show as one: the screens say the registry is
   *  being set up. */
  static registryUpgrading() { return new ServiceError("registryUpgrading", registryUpgradingMessage); }
}

/** The (English) message of `ServiceError.registryUpgrading()`. */
export const registryUpgradingMessage =
  "The .kachat registry is being upgraded. Names open here again once the new registry is live.";

/** Whether `error` means the registry is being upgraded (an earlier registry's manifest), not a failure (Swift
 *  `KachatNamesService.isRegistryUpgrading`): a `ServiceError` with code "registryUpgrading" or
 *  the core's `Failure.outdatedRegistry()`. */
export function isRegistryUpgrading(error) {
  if (error == null || typeof error !== "object") return false;
  if (error instanceof ServiceError && error.code === "registryUpgrading") return true;
  return error instanceof Failure && error.isOutdatedRegistry === true;
}

// MARK: - Addresses (the registry's pure Kaspa cashaddr codec)

/** The address prefix of the network the app runs on (registry-state.js `addressPrefix`). */
export { addressPrefix };
/** The old name of `addressPrefix` (kept for callers of the earlier API). */
export const testnetPrefix = addressPrefix;
/** The bundled manifest JSON of a manifest network ("testnet-10" | "mainnet"), or null for none
 *  (Swift `Manifest.bundleResource(network:)`, iOS ef6b21e). */
export function bundledManifestFor(network) {
  if (network === "mainnet") return mainnetManifestJson;
  if (network === "testnet-10") return testnetManifestJson;
  return null;
}
/** `p2shAddress(script)`: the P2SH address (this network's prefix) of a P2SH script, or null (Swift
 *  `KachatNamesService.p2shAddress`). `addressOf(xonly)` / `keyOf(address)`: Swift
 *  `KachatNamesRegistry.address(of:)` / `keyOf`. */
export { p2shAddress, addressOf, keyOf };

// MARK: - Keys

function keyBytes(privateKey) {
  if (privateKey instanceof Uint8Array) {
    if (privateKey.length !== 32) throw new Failure("a private key is 32 bytes");
    return Uint8Array.from(privateKey);
  }
  if (typeof privateKey === "string") return unhex32(privateKey.trim().toLowerCase().replace(/^0x/, ""));
  throw new Failure("no private key");
}

/** The signer's x-only key for a wallet private key (hex or 32 bytes). */
export function xonlyKey(privateKey) {
  const sk = keyBytes(privateKey);
  try {
    return schnorr.getPublicKey(sk);
  } finally {
    sk.fill(0);
  }
}

/** True when `xonly` is a non-zero 32-byte x coordinate of a point on secp256k1. */
export function isValidXonly(xonly) {
  if (!(xonly instanceof Uint8Array) || xonly.length !== 32 || xonly.every((b) => b === 0)) return false;
  try {
    secp256k1.Point.fromBytes(concat([0x02], xonly)).assertValidity();
    return true;
  } catch {
    return false;
  }
}

// MARK: - UTXOs

/** Coinbase outputs mature after this many DAA (iOS KasiaTransactionBuilder.coinbaseMaturity). */
export const coinbaseMaturity = 1000n;

/** A node UTXO as the engine returns it (engine.getUtxosWithCovenants):
 *  `{ outpoint: { transactionId, index }, amount: bigint, scriptPublicKey: hex, scriptVersion,
 *  blockDaaScore: bigint, isCoinbase, covenantId: hex | null }` -> the core's Utxo. */
export function convert(u) {
  return makeUtxo(
    makeOutpoint(unhex32(String(u.outpoint.transactionId).toLowerCase()), Number(u.outpoint.index)),
    makeUtxoEntry({
      amount: BigInt(u.amount),
      scriptVersion: Number(u.scriptVersion ?? 0),
      script: unhex(String(u.scriptPublicKey).toLowerCase()),
      blockDaaScore: BigInt(u.blockDaaScore ?? 0),
      isCoinbase: !!u.isCoinbase,
      covenantId: u.covenantId ? unhex32(String(u.covenantId).toLowerCase()) : null,
    }),
  );
}

/** Mature for a build (iOS KasiaTransactionBuilder.spendableForBuild): every non-coinbase UTXO,
 *  and coinbase ones `coinbaseMaturity` DAA deep. */
export function spendableForBuild(utxos, virtualDaaScore) {
  return utxos.filter((u) => {
    if (!u.isCoinbase) return true;
    if (virtualDaaScore == null) return false;
    return BigInt(u.blockDaaScore ?? 0) + coinbaseMaturity < BigInt(virtualDaaScore);
  });
}

/** The wallet's spendable funding UTXOs for the builders: the signer's own Schnorr P2PK outputs
 *  only, mature, and never one carrying a covenant id (spending that would drag a covenant into
 *  the transaction and change its storage mass), nor one a scheduled KaPost will spend (iOS
 *  58a0b22, IOS-064: quotes, plans and submits all fund from here, so they see the same coins). */
export function fundingUtxos(utxos, { me, virtualDaaScore }) {
  const mine = hex(p2pkScript(me));
  const out = [];
  for (const u of spendableForBuild(excludeReservedUtxos(utxos), virtualDaaScore)) {
    if (u.covenantId != null || String(u.scriptPublicKey).toLowerCase() !== mine) continue;
    try { out.push(convert(u)); } catch { /* malformed: skip, as Swift's try? */ }
  }
  return out;
}

// MARK: - Salts

/** A fresh 32-byte commit salt. Keep it (with the name) until the registration: without it the
 *  commit cannot be registered. */
export function newSalt() {
  const c = globalThis.crypto;
  if (!c || typeof c.getRandomValues !== "function") throw new Failure("no randomness for the salt");
  return c.getRandomValues(new Uint8Array(32));
}

// MARK: - Signing

/** Signs every input that needs it with the wallet key: BIP-340 Schnorr over the version-1
 *  SIGHASH_ALL sighash (fresh aux randomness), each signature verified before it is used. `plan`
 *  must have been built for this key (`Env.me`). Returns the signed core Tx. */
export function sign(plan, { privateKey, me }) {
  const sk = keyBytes(privateKey);
  try {
    const xonly = schnorr.getPublicKey(sk);
    if (!bytesEqual(xonly, me)) throw ServiceError.keyMismatch();
    return planSignedBy(plan, (sighash) => {
      const message = Uint8Array.from(sighash);
      const signature = schnorr.sign(message, sk);
      const ok = schnorr.verify(signature, message, xonly);
      message.fill(0);
      if (!ok) throw new Failure("signature did not verify");
      return signature;
    });
  } finally {
    sk.fill(0);
  }
}

// MARK: - WASM SDK transaction

/** The Kaspa WASM SDK `Transaction` of a version-1 core Tx (Swift `rpcTransaction`, which builds
 *  the protowire form): `computeBudget` on every input (`sigOpCount` must stay 0 for version 1),
 *  covenant bindings on outputs, the storage mass. `kaspa` is the loaded SDK (engine.kaspa). */
export function rpcTransaction(kaspa, tx) {
  const inputs = tx.inputs.map((i) => new kaspa.TransactionInput({
    previousOutpoint: new kaspa.TransactionOutpoint(new kaspa.Hash(hex(i.outpoint.txid)), i.outpoint.index),
    signatureScript: hex(i.signatureScript),
    sequence: BigInt(i.sequence),
    sigOpCount: 0,
    computeBudget: Number(i.computeBudget),
  }));
  const outputs = tx.outputs.map((o) => new kaspa.TransactionOutput(
    BigInt(o.value),
    new kaspa.ScriptPublicKey(Number(o.scriptVersion), hex(o.script)),
    o.covenant != null
      ? new kaspa.CovenantBinding(Number(o.covenant.authorizingInput), new kaspa.Hash(hex(o.covenant.covenantId)))
      : undefined,
  ));
  return new kaspa.Transaction({
    version: Number(tx.version),
    inputs,
    outputs,
    lockTime: BigInt(tx.lockTime),
    subnetworkId: hex(tx.subnetworkId),
    gas: BigInt(tx.gas),
    payload: hex(tx.payload),
    storageMass: BigInt(tx.storageMass),
  });
}

// MARK: - Profile record

/** The checked payload of an address profile record (KACHAT_NAMES.md section 7):
 *  `kchat:1:profile:<json>`. `json` (string or UTF-8 bytes) is the whole profile, a JSON object
 *  with `"v": 1`, at most 2 KB. Throws ServiceError.badProfile. */
export function profileRecordPayload(json) {
  const bytes = typeof json === "string" ? utf8(json) : json;
  if (!(bytes instanceof Uint8Array)) throw ServiceError.badProfile("not JSON");
  if (bytes.length > maxProfileJSONBytes) throw ServiceError.badProfile("over 2 KB");
  let object;
  try { object = JSON.parse(fromUtf8(bytes)); } catch { object = null; }
  if (object == null || typeof object !== "object" || Array.isArray(object)) throw ServiceError.badProfile("not a JSON object");
  if (object.v !== 1) throw ServiceError.badProfile("\"v\" must be 1");
  return profilePayload(bytes);
}

// MARK: - Service

function trimSlash(s) {
  const t = String(s ?? "").trim();
  return t.endsWith("/") ? t.slice(0, -1) : t;
}

export class KachatNamesService {
  /** `engine`: the KaspaEngine. `options.bundledManifest`: the manifest JSON to use instead of the
   *  one bundled for the network the app runs on (tests; null forces the indexer path). */
  constructor(engine, { bundledManifest = undefined } = {}) {
    this.engine = engine;
    this.bundledManifest = bundledManifest === undefined ? bundledManifestFor(KachatNamesService.networkName) : bundledManifest;
    /** The verified manifest, once loaded. */
    this.manifest = null;
    /** Where the manifest came from: "bundle" or the indexer URL. */
    this.manifestSource = null;
    /** The manifest describes a registry this app doesn't build for (not v4 or v5): names wait.
     *  The screens show "Setting up" instead of an error. Changes are announced to `onChange`. */
    this.registryUpgrading = false;
    /** Why the bundled manifest was refused. The bundle can't change while the app runs, so it is
     *  not read and verified again on every call (until `resetManifest`). */
    this._bundleFailure = null;
    this._listeners = new Set();
    this._submitListeners = new Set();
  }

  // MARK: Observing (Swift @Published registryUpgrading)

  /** `listener(service)` whenever `registryUpgrading` changes; returns an unsubscribe function. */
  onChange(listener) {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  /** Optional: `listener(txId)` after every transaction `submit` sends and the node accepts (each
   *  registry operation and a registration's commit; not the profile record, a plain self-send),
   *  and after a coin combine (`noteSubmitted`).
   *  The app uses it to keep name transactions out of its payment chats (iOS 32fdaa4); nothing
   *  here depends on anyone listening. Returns an unsubscribe function. */
  onSubmitted(listener) {
    if (typeof listener !== "function") return () => {};
    this._submitListeners.add(listener);
    return () => this._submitListeners.delete(listener);
  }

  _setRegistryUpgrading(value) {
    if (this.registryUpgrading === value) return;
    this.registryUpgrading = value;
    for (const l of [...this._listeners]) {
      try { l(this); } catch (e) { this._log("[KachatNames] listener failed:", e?.message ?? e); }
    }
  }

  _log(...args) {
    if (typeof this.engine?.log === "function") this.engine.log(args.join(" "));
    else console.log(...args);
  }

  /** See the module-level `isRegistryUpgrading`. */
  static isRegistryUpgrading(error) { return isRegistryUpgrading(error); }

  // MARK: Gate

  /** The .kachat UI and identity: on every network since iOS 7227d69 - mainnet shows the same
   *  screens as testnet (and people by their .kachat name, not KNS). */
  static get isEnabled() { return true; }
  get isEnabled() { return KachatNamesService.isEnabled; }
  /** Whether this network has a live registry the app reads and transacts with (lookups, listings,
   *  registrations, resolving typed names): testnet-10, and mainnet since 2026-10-09 (iOS ef6b21e). */
  static get isLaunched() { return supportedNetworks.includes(KachatNamesService.networkName); }
  get isLaunched() { return KachatNamesService.isLaunched; }
  /** The manifest network name of the network the app runs on: "mainnet" | "testnet-10" (Swift
   *  `KachatNamesService.networkName`). It drives the node check, the bundled manifest and the cache. */
  static get networkName() { return NETWORK_ID; }
  /** The address prefix of the network the app runs on ("kaspa" | "kaspatest"): names, owners and
   *  registry outputs are shown and parsed with it (Swift `KachatNamesService.addressPrefix`). */
  static get addressPrefix() { return ADDRESS_HRP; }
  /** Address profiles (`kchat:1:profile:`) work on every network (iOS d36fc42): a profile is a
   *  plain self-send from the chatting address with no registry behind it, so mainnet saves and
   *  reads them before its registry launches. Only the primary name needs the registry. */
  static get profilesEnabled() { return KachatNamesService.isEnabled; }
  get profilesEnabled() { return KachatNamesService.profilesEnabled; }

  /** The gate on every registry read and write: the network the app runs on has a live registry
   *  (`isLaunched`). `isEnabled` only turns the UI on. Swift `requireLaunched()`
   *  (iOS d657ee3, IOS-058). */
  requireLaunched() {
    if (!KachatNamesService.isLaunched) throw ServiceError.testnetOnly();
  }

  /** The old name of `requireLaunched()` (kept for callers of the earlier API). */
  requireTestnet() { this.requireLaunched(); }

  // MARK: Manifest

  /** The verified registry manifest: kachat-names-<network>.json bundled with the app for the
   *  network it runs on, else the indexer's `GET /names/manifest`. Cached once verified. An indexer-served manifest is trusted
   *  only when every template is pinned in the app (`verifyManifest(m, { source: "indexer" })`).
   *  A registry version this app doesn't build for (not v4 or v5) throws `ServiceError.registryUpgrading()`
   *  (code "registryUpgrading") and sets `registryUpgrading`; a refused bundled manifest is
   *  remembered and thrown again without re-reading it. */
  async loadManifest({ allowDryRun = false } = {}) {
    this.requireLaunched();
    // the other network's manifest never serves this one (iOS ef6b21e; the network is fixed per page
    // load here, so this only guards a manifest an indexer served for the wrong network)
    if (this.manifest && this.manifest.network !== KachatNamesService.networkName) this.resetManifest();
    if (this.manifest && (allowDryRun || !this.manifest.isDryRun)) return this.manifest;
    if (this._bundleFailure) throw this._bundleFailure;
    const [data, source] = await this._manifestData();
    let m;
    try {
      m = decodeManifest(data);
      // an indexer-served manifest is trusted only when every template is pinned in the app
      verifyManifest(m, { source: source === "bundle" ? ManifestSource.bundle : ManifestSource.indexer });
    } catch (error) {
      // A registry version this app doesn't build for (an earlier or a later one) is expected, not
      // an error: say "being upgraded", once, and stop re-reading the bundle.
      const upgrading = isRegistryUpgrading(error);
      const refused = upgrading ? ServiceError.registryUpgrading() : error;
      if (upgrading) {
        if (!this.registryUpgrading) this._log(`[KachatNames] the ${source} manifest is an earlier registry; .kachat waits for a registry v4 or v5 manifest`);
        this._setRegistryUpgrading(true);
      }
      if (source === "bundle") this._bundleFailure = refused;
      throw refused;
    }
    if (m.isDryRun && !allowDryRun) throw ServiceError.dryRunManifest();
    // a manifest for the other network (one an indexer of that network served) is never this one's
    if (!m.isDryRun && m.network !== KachatNamesService.networkName) {
      throw ServiceError.noManifest(`the ${source} manifest is for ${m.network}, not ${KachatNamesService.networkName}`);
    }
    this._setRegistryUpgrading(false);
    this.manifest = m;
    this.manifestSource = source;
    return m;
  }

  /** Forget the cached manifest (network switch, indexer change). */
  resetManifest() {
    this.manifest = null;
    this.manifestSource = null;
    this._bundleFailure = null;
    this._setRegistryUpgrading(false);
  }

  async _manifestData() {
    if (this.bundledManifest != null) return [this.bundledManifest, "bundle"];
    const base = trimSlash(getEndpoint("kasiaIndexer"));
    if (!base) throw ServiceError.noManifest("none in the app and no indexer is configured");
    const url = `${base}/names/manifest`;
    let response;
    try {
      response = await fetch(url, { headers: { Accept: "application/json" }, cache: "no-store" });
    } catch {
      throw ServiceError.noManifest("bad indexer URL");
    }
    if (response.status !== 200) throw ServiceError.noManifest(`the indexer answered ${response.status}`);
    return [new Uint8Array(await response.arrayBuffer()), url];
  }

  /** The pure builders over the verified manifest. */
  async builder() {
    return new Builder(await this.loadManifest());
  }

  // MARK: Environment

  /** See the module-level `xonlyKey`. */
  static xonlyKey(privateKey) { return xonlyKey(privateKey); }

  /** Where the next transaction is judged: the virtual's DAA score and past median time from a
   *  node on the app's network (`networkName`), the wall clock, the signer's key. `feerate` in
   *  sompi/gram (min 100). */
  async environment({ privateKey, feerate = minFeerate }) {
    this.requireLaunched();
    const dag = await this.engine.currentDagPoint();
    const network = String(dag.networkId ?? "");
    if (!network.endsWith(KachatNamesService.networkName)) throw ServiceError.wrongNodeNetwork(network || "an unknown network");
    return makeEnv({
      me: xonlyKey(privateKey),
      blockDaa: dag.virtualDaaScore,
      blockTimeMs: dag.pastMedianTime,
      wallMs: BigInt(Date.now()),
      feerate: Math.max(Number(feerate), minFeerate),
      // the v5 gap is bigger and costs more script units per spend (iOS 6f18475)
      budgets: { ...recommendedBudgetsFor(await this.loadManifest().then((m) => m.registryVersion, () => 4)) },
    });
  }

  // MARK: UTXOs

  static fundingUtxos(utxos, opts) { return fundingUtxos(utxos, opts); }
  static convert(u) { return convert(u); }
  static p2shAddress(script) { return p2shAddress(script); }

  /** The live UTXO at `outpoint` holding `script` (a gap, name or offer), read from a node with
   *  its covenant id. A registry record from the indexer is trusted only once this confirms it:
   *  the P2SH address commits to the whole state, and the covenant id to the registry lineage. */
  async liveUtxo({ script, outpoint }) {
    this.requireLaunched();
    const address = p2shAddress(script);
    if (!address) throw ServiceError.notOnChain("a non-P2SH script");
    const utxos = await this.engine.getUtxosWithCovenants([address]);
    const txidHex = hex(outpoint.txid);
    const u = utxos.find((x) => String(x.outpoint.transactionId).toLowerCase() === txidHex && Number(x.outpoint.index) === outpoint.index);
    if (!u) throw ServiceError.notOnChain(`${txidHex}:${outpoint.index}`);
    const live = convert(u);
    if (!bytesEqual(live.entry.script, script)) throw ServiceError.notOnChain(`${txidHex}:${outpoint.index} with that state`);
    return live;
  }

  /** `liveUtxo` for a gap or name, which must also carry the registry covenant id. */
  async liveRegistryUtxo({ script, outpoint }) {
    const m = await this.loadManifest();
    const u = await this.liveUtxo({ script, outpoint });
    if (!bytesEqual(u.entry.covenantId, m.registryCovenantId)) throw ServiceError.notOnChain("a registry UTXO");
    return u;
  }

  // MARK: Salts, signing, conversion

  static newSalt() { return newSalt(); }
  static sign(plan, opts) { return sign(plan, opts); }
  static rpcTransaction(kaspa, tx) { return rpcTransaction(kaspa, tx); }

  // MARK: Submit

  /** Submits a signed version-1 core Tx; returns its id. Register, extend and renew carry the price
   *  (fixed tables, registry v4) as fee on purpose - there is no high-fee guard on this path. */
  async submit(tx) {
    this.requireLaunched();
    const expected = txIdHex(tx);
    const kaspa = this.engine.kaspa;
    if (!kaspa) throw new Failure("Load Rusty Kaspa WASM first.");
    const wasmTx = rpcTransaction(kaspa, tx);
    // the SDK's own v1 id must be the core's: anything else is a conversion bug, caught before
    // the transaction leaves the app
    const sdkId = String(wasmTx.id ?? "").toLowerCase();
    if (sdkId && sdkId !== expected) throw ServiceError.submitMismatch(expected, `${sdkId} (SDK conversion)`);
    // a node can accept it while its answer is lost and a raced node rejects it: looked up by its
    // locally computed id before failing, so a retry never pays a price twice (iOS 9139e88, IOS-014)
    const txId = String(await this.engine.submitRpcTransaction(wasmTx, { expectedTxId: expected }) ?? "").toLowerCase();
    this.engine.log?.(`[KachatNames] submitted ${txId}`);
    if (txId !== expected) throw ServiceError.submitMismatch(expected, txId);
    this.noteSubmitted(txId);
    return txId;
  }

  /** Tells the `onSubmitted` listeners about `txId`: every transaction `submit` sends, and the
   *  self-send that combines many small coins before a name transaction (actions.js `combineCoins`,
   *  iOS f1c16ec: a move between your own coins, kept out of the chats like the rest). */
  noteSubmitted(txId) {
    const id = String(txId ?? "").toLowerCase();
    if (!id) return;
    for (const l of [...this._submitListeners]) {
      try { l(id); } catch (e) { this._log("[KachatNames] submit listener failed:", e?.message ?? e); }
    }
  }

  /** Sign with the wallet key and submit; returns the txid. */
  async signAndSubmit(plan, { privateKey, env }) {
    this.requireLaunched();
    const tx = sign(plan, { privateKey, me: env.me });
    return this.submit(tx);
  }

  // MARK: Profile record

  /** Writes the address profile record (KACHAT_NAMES.md section 7) on any network (`profilesEnabled`;
   *  `address` must be on the app's network): a self-transfer with payload
   *  `kchat:1:profile:<json>` through the engine's existing version-0 payload send path (the WASM
   *  SDK's generator, signed with the wallet key, in the per-address send queue). Only UTXOs
   *  without a covenant id are spent. `json` (string or UTF-8 bytes) is the whole profile (records
   *  replace, never patch), a JSON object with `"v": 1` of at most 2 KB. Returns the txid. */
  async submitProfileRecord({ json, address = this.engine?.address }) {
    if (!KachatNamesService.profilesEnabled) throw ServiceError.testnetOnly();
    const engine = this.engine;
    // The record is written from the wallet's address on the network the app runs on.
    if (!address || !isNetworkAddress(address)) throw ServiceError.wrongAddressNetwork();
    if (!engine?.kaspa || !engine.privateKey || String(engine.address).toLowerCase() !== String(address).toLowerCase()) {
      throw new Failure("Load the wallet first.");
    }
    const payload = profileRecordPayload(json);
    await engine.connect();
    // plain coins only: a coin carrying a covenant id is never spent by the v0 path
    const utxos = await engine.getUtxosWithCovenants([engine.address]);
    // never a coin a scheduled KaPost will spend (iOS 58a0b22, IOS-064)
    const plain = excludeReservedUtxos(utxos).filter((u) => u.covenantId == null);
    if (!plain.length) throw new Failure("No spendable coins without a covenant.");
    const selectedOutpoints = plain.length === utxos.length
      ? null
      : plain.map((u) => `${u.outpoint.transactionId}:${u.outpoint.index}`);
    const result = await sendKaspa({
      kaspa: engine.kaspa,
      rpc: engine.rpc,
      withRpc: engine.withRpc.bind(engine),
      privateKey: engine.privateKey,
      sourceAddress: engine.address,
      destinationAddress: engine.address,
      amountKas: "0.2",
      feeKas: "0",
      payload,
      selectedOutpoints,
      log: engine.log,
    });
    const txId = result?.txids?.[0];
    if (!txId) throw new Failure("The profile record was not broadcast.");
    return String(txId);
  }
}
