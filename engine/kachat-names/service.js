// .kachat names: the app side of the transaction core.
//
// Port of iOS KaChat/Services/KachatNames/KachatNamesService.swift. The core (codec, transaction,
// manifest, builder) is pure and checked against the kachat-domains vectors; this service adds
// what needs the app: the testnet gate, loading and verifying the manifest, the node's DAG point,
// the wallet's and the registry's live UTXOs, BIP-340 Schnorr signing with the wallet key
// (SIGHASH_ALL over the version-1 sighash, @noble/curves), the conversion to the Kaspa WASM SDK's
// Transaction with the Toccata fields, and submission through the engine's RPC client.
//
// Transactions are testnet-10 only: every entry point refuses unless engine/network.js IS_TESTNET
// (`isLaunched`), and the manifest itself must be for testnet-10 (verifyManifest). The mainnet
// registry stays off until the contracts are audited - but the .kachat UI and identity are on for
// every network (`isEnabled`, iOS 7227d69).
//
// Nothing runs at import. `new KachatNamesService(engine)` takes the KaspaEngine (engine/index.js);
// it uses engine.kaspa, engine.currentDagPoint(), engine.getUtxosWithCovenants(addresses),
// engine.submitRpcTransaction(wasmTx), engine.address / engine.privateKey for the profile record.
//
// A screen: `loadManifest()`, read the records it needs (registry.js), confirm them with
// `liveRegistryUtxo`, `environment(...)`, build with `builder()`, show the plan's fee, then
// `signAndSubmit`. KachatNamesActions (actions.js) does all of that per operation.

import { schnorr, secp256k1 } from "@noble/curves/secp256k1.js";
import bundledManifestJson from "./kachat-names-testnet-10.json" with { type: "json" };

import { IS_TESTNET } from "../network.js";
import { getEndpoint } from "../endpoints.js";
import { sendKaspa } from "../transactions.js";
import {
  Failure, minFeerate, maxProfileJSONBytes, hex, unhex, unhex32, bytesEqual, concat, utf8, fromUtf8,
  p2pkScript, profilePayload,
} from "./codec.js";
import { makeOutpoint, makeUtxo, makeUtxoEntry, txIdHex } from "./transaction.js";
import { decodeManifest, verifyManifest } from "./manifest.js";
import { Builder, makeEnv, planSignedBy } from "./builder.js";
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

  static testnetOnly() { return new ServiceError("testnetOnly", ".kachat names run on Testnet only for now"); }
  static noManifest(why) { return new ServiceError("noManifest", `No .kachat registry manifest: ${why}`); }
  static dryRunManifest() { return new ServiceError("dryRunManifest", "The .kachat manifest is from a dry run; that registry does not exist"); }
  static wrongNodeNetwork(n) { return new ServiceError("wrongNodeNetwork", `The node is on ${n}, not testnet-10`); }
  static keyMismatch() { return new ServiceError("keyMismatch", "The signing key is not the key the transaction was built for"); }
  static notOnChain(what) { return new ServiceError("notOnChain", `${what} is not on chain (or not with the registry covenant id)`); }
  static badProfile(why) { return new ServiceError("badProfile", `Profile: ${why}`); }
  static submitMismatch(expected, got) {
    return new ServiceError("submitMismatch", `The node accepted ${got}, expected ${expected}`, { expected, got });
  }
  /** The manifest is for registry v1; this app builds for v2 and waits for its genesis. Not a
   *  failure to show as one: the screens say the registry is being set up. */
  static registryUpgrading() { return new ServiceError("registryUpgrading", registryUpgradingMessage); }
}

/** The (English) message of `ServiceError.registryUpgrading()`. */
export const registryUpgradingMessage =
  "The .kachat registry on Testnet is being upgraded. Names open here again once the new registry is live.";

/** Whether `error` means the registry is being upgraded (a v1 manifest), not a failure (Swift
 *  `KachatNamesService.isRegistryUpgrading`): a `ServiceError` with code "registryUpgrading" or
 *  the core's `Failure.outdatedRegistry()`. */
export function isRegistryUpgrading(error) {
  if (error == null || typeof error !== "object") return false;
  if (error instanceof ServiceError && error.code === "registryUpgrading") return true;
  return error instanceof Failure && error.isOutdatedRegistry === true;
}

// MARK: - Addresses (the registry's pure Kaspa cashaddr codec)

/** The testnet address prefix (names run on testnet-10 only). */
export const testnetPrefix = addressPrefix;
/** `p2shAddress(script)`: the `kaspatest:` P2SH address of a P2SH script, or null (Swift
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
 *  the transaction and change its storage mass). */
export function fundingUtxos(utxos, { me, virtualDaaScore }) {
  const mine = hex(p2pkScript(me));
  const out = [];
  for (const u of spendableForBuild(utxos, virtualDaaScore)) {
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
   *  bundled one (tests; null forces the indexer path). */
  constructor(engine, { bundledManifest = bundledManifestJson } = {}) {
    this.engine = engine;
    this.bundledManifest = bundledManifest;
    /** The verified manifest, once loaded. */
    this.manifest = null;
    /** Where the manifest came from: "bundle" or the indexer URL. */
    this.manifestSource = null;
    /** The manifest describes the previous registry (v1): names wait for the v2 genesis manifest.
     *  The screens show "Setting up" instead of an error. Changes are announced to `onChange`. */
    this.registryUpgrading = false;
    /** Why the bundled manifest was refused. The bundle can't change while the app runs, so it is
     *  not read and verified again on every call (until `resetManifest`). */
    this._bundleFailure = null;
    this._listeners = new Set();
  }

  // MARK: Observing (Swift @Published registryUpgrading)

  /** `listener(service)` whenever `registryUpgrading` changes; returns an unsubscribe function. */
  onChange(listener) {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
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
   *  screens as testnet (and people by their .kachat name, not KNS), in a "Coming soon" state until
   *  its registry launches. */
  static get isEnabled() { return true; }
  get isEnabled() { return KachatNamesService.isEnabled; }
  /** Whether this network has a live registry the app reads and transacts with (lookups, listings,
   *  registrations, profile saves, resolving typed names): testnet-10 only until an audit. */
  static get isLaunched() { return IS_TESTNET; }
  get isLaunched() { return KachatNamesService.isLaunched; }

  requireTestnet() {
    if (!KachatNamesService.isLaunched) throw ServiceError.testnetOnly();
  }

  // MARK: Manifest

  /** The verified registry manifest: kachat-names-testnet-10.json bundled with the app, else the
   *  indexer's `GET /names/manifest`. Cached once verified. A registry v1 manifest throws
   *  `ServiceError.registryUpgrading()` (code "registryUpgrading") and sets `registryUpgrading`;
   *  a refused bundled manifest is remembered and thrown again without re-reading it. */
  async loadManifest({ allowDryRun = false } = {}) {
    this.requireTestnet();
    if (this.manifest && (allowDryRun || !this.manifest.isDryRun)) return this.manifest;
    if (this._bundleFailure) throw this._bundleFailure;
    const [data, source] = await this._manifestData();
    let m;
    try {
      m = decodeManifest(data);
      verifyManifest(m);
    } catch (error) {
      // A registry v1 manifest is expected, not an error: say "being upgraded", once, and stop
      // re-reading the bundle.
      const upgrading = isRegistryUpgrading(error);
      const refused = upgrading ? ServiceError.registryUpgrading() : error;
      if (upgrading) {
        if (!this.registryUpgrading) this._log(`[KachatNames] the ${source} manifest is registry v1; .kachat waits for the v2 genesis manifest`);
        this._setRegistryUpgrading(true);
      }
      if (source === "bundle") this._bundleFailure = refused;
      throw refused;
    }
    if (m.isDryRun && !allowDryRun) throw ServiceError.dryRunManifest();
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
    if (!base) throw ServiceError.noManifest("none in the app and no indexer is configured for Testnet");
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
   *  testnet-10 node, the wall clock, the signer's key. `feerate` in sompi/gram (min 100). */
  async environment({ privateKey, feerate = minFeerate }) {
    this.requireTestnet();
    const dag = await this.engine.currentDagPoint();
    const network = String(dag.networkId ?? "");
    if (!network.endsWith("testnet-10")) throw ServiceError.wrongNodeNetwork(network || "an unknown network");
    return makeEnv({
      me: xonlyKey(privateKey),
      blockDaa: dag.virtualDaaScore,
      blockTimeMs: dag.pastMedianTime,
      wallMs: BigInt(Date.now()),
      feerate: Math.max(Number(feerate), minFeerate),
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
    this.requireTestnet();
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
   *  (35-8,000 TKAS) as fee on purpose - there is no high-fee guard on this path. */
  async submit(tx) {
    this.requireTestnet();
    const expected = txIdHex(tx);
    const kaspa = this.engine.kaspa;
    if (!kaspa) throw new Failure("Load Rusty Kaspa WASM first.");
    const wasmTx = rpcTransaction(kaspa, tx);
    // the SDK's own v1 id must be the core's: anything else is a conversion bug, caught before
    // the transaction leaves the app
    const sdkId = String(wasmTx.id ?? "").toLowerCase();
    if (sdkId && sdkId !== expected) throw ServiceError.submitMismatch(expected, `${sdkId} (SDK conversion)`);
    const txId = String(await this.engine.submitRpcTransaction(wasmTx) ?? "").toLowerCase();
    this.engine.log?.(`[KachatNames] submitted ${txId}`);
    if (txId !== expected) throw ServiceError.submitMismatch(expected, txId);
    return txId;
  }

  /** Sign with the wallet key and submit; returns the txid. */
  async signAndSubmit(plan, { privateKey, env }) {
    this.requireTestnet();
    const tx = sign(plan, { privateKey, me: env.me });
    return this.submit(tx);
  }

  // MARK: Profile record

  /** Writes the address profile record (KACHAT_NAMES.md section 7): a self-transfer with payload
   *  `kchat:1:profile:<json>` through the engine's existing version-0 payload send path (the WASM
   *  SDK's generator, signed with the wallet key, in the per-address send queue). Only UTXOs
   *  without a covenant id are spent. `json` (string or UTF-8 bytes) is the whole profile (records
   *  replace, never patch), a JSON object with `"v": 1` of at most 2 KB. Returns the txid. */
  async submitProfileRecord({ json, address = this.engine?.address }) {
    this.requireTestnet();
    const engine = this.engine;
    if (!address || !String(address).toLowerCase().startsWith(`${testnetPrefix}:`)) throw ServiceError.testnetOnly();
    if (!engine?.kaspa || !engine.privateKey || String(engine.address).toLowerCase() !== String(address).toLowerCase()) {
      throw new Failure("Load the wallet first.");
    }
    const payload = profileRecordPayload(json);
    await engine.connect();
    // plain coins only: a coin carrying a covenant id is never spent by the v0 path
    const utxos = await engine.getUtxosWithCovenants([engine.address]);
    const plain = utxos.filter((u) => u.covenantId == null);
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
