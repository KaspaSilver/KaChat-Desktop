// .kachat names: the deployment manifest and the compiled contract templates.
//
// Port of iOS KaChat/Services/KachatNames/KachatNamesManifest.swift. The manifest
// `kachat-names-<network>.json` is written by the kachat-domains CLI's `genesis` and served by
// the indexer at `GET /names/manifest`; the testnet-10 one is bundled next to this file
// (kachat-names-testnet-10.json, byte-identical to the iOS resource). `verifyManifest` must pass
// before anything trusts it. Registry v3 only (`registryVersion: 3`): an earlier manifest throws
// `Failure.outdatedRegistry()` (the screens say the registry is being set up).
//
//   Template { contract, prefix, suffix, stateLength, templateHash, dispatchTags: { entry: Uint8Array(4) } }
//   Params   { bond, gapValue, tCommit, maxYears, periodMs, graceMs, renewWindowMs: bigint,
//              genesisPrices[5]: bigint, priceShards: bigint, priceValue: bigint, offerMaxFee: bigint }
//   Manifest { network, status, params, price, gap, name, offer: Template, priceCovenantId, priceGenesisTxid,
//              priceGenesisOutpoint: Outpoint, genesisShards: [{ output: TxOutput, fields: PriceFields }],
//              registryCovenantId, genesisTxid, genesisOutpoint: Outpoint, genesisOutput: TxOutput,
//              genesisState: { lo, hi }, isDryRun }
//
// Prices are not in Params: registering and renewing pay what a price shard says (PriceFields,
// codec.js), which the authority can change; `genesisPrices` are only what the shards started with.

import {
  Failure, hex, unhex, unhex32, concat, bytesEqual, indexOfBytes, tier, templateHash as computeTemplateHash,
  p2shScript, gapState, covenantId, zero32, ff32, fromUtf8, yearMs, priceState, makePriceFields,
} from "./codec.js";
import { makeOutpoint, makeTxOutput } from "./transaction.js";

/** Only testnet-10 is enabled (mainnet waits for an audit). */
export const supportedNetwork = "testnet-10";
/** The bundled manifest's base name (engine/kachat-names/kachat-names-testnet-10.json). */
export const bundleResource = "kachat-names-testnet-10";

/** Template hashes of the pinned build - registry v3 (silverc v1.0.0 @ 3ed9733). The price
 *  template bakes no covenant id, so it is the same everywhere. The gap and the name bake the
 *  price covenant id, so their hashes exist only once the price genesis does: the deployment adds
 *  them here with the bundled manifest. Until they are pinned only a bundled manifest is trusted
 *  (`verifyManifest(m, { source })`), never one an indexer serves. The offer bakes the registry
 *  id, so it is checked against the id instead. */
export const pinnedTemplateHashes = {
  KachatPrice: "d225c3a302b91866a8a7cb09d513b3375715794adf4f1e05eec872b32cb781d3",
};
/** State lengths per contract (registry v3: price 87, gap 66, name 126, offer 108). */
export const stateLengths = { KachatPrice: 87, KachatGap: 66, KachatName: 126, KachatOffer: 108 };
/** The dispatch entries every contract must have. */
export const entries = {
  KachatPrice: ["use", "update", "follow"],
  KachatGap: ["register", "merge", "absorbed"],
  KachatName: ["transfer", "list", "buy", "extend", "renew", "release", "reclaim"],
  KachatOffer: ["accept", "decline", "withdraw", "refund"],
};
/** Where a manifest came from (Swift `Manifest.Source`): the app bundle or an indexer. */
export const ManifestSource = Object.freeze({ bundle: "bundle", indexer: "indexer" });

// MARK: - Template (a compiled contract: redeem = prefix || state || suffix)

/** `prefix || state || suffix`. */
export function templateRedeem(t, state) { return concat(t.prefix, state, t.suffix); }

/** The P2SH script of `prefix || state || suffix`. */
export function templateScript(t, state) { return p2shScript(templateRedeem(t, state)); }

/** The 4-byte dispatch tag of `entry`; throws when the template has none. */
export function templateTag(t, entry) {
  const tag = Object.prototype.hasOwnProperty.call(t.dispatchTags, entry) ? t.dispatchTags[entry] : undefined;
  if (!tag) throw new Failure(`${t.contract} has no entry ${entry}`);
  return tag;
}

/** The state of a redeem script of this template (what a spend reveals). */
export function templateStateOfRedeem(t, redeem) {
  if (redeem.length !== t.prefix.length + t.stateLength + t.suffix.length
    || !bytesEqual(redeem.subarray(0, t.prefix.length), t.prefix)
    || !bytesEqual(redeem.subarray(redeem.length - t.suffix.length), t.suffix)) {
    throw new Failure(`not a ${t.contract} redeem script`);
  }
  const start = t.prefix.length;
  return redeem.slice(start, start + t.stateLength);
}

// MARK: - Params (kachat-domains params/<network>.json, registry v3)

/** A genesis price per period (sompi) for a name of `n` bytes: only what the price shards started
 *  with. What a name costs now is its live shard's `priceFieldsPrice` (codec.js). */
export function paramsGenesisPrice(p, n) { return p.genesisPrices[tier(n)]; }

// MARK: The paid period (KACHAT_NAMES.md 4.1; ops.rs)

/** The most periods `extend` can add now (BigInt): a name (from `periodStart`) holds at most
 *  `maxYears` periods of `periodMs` (ops.rs `extendable_years`).
 *  Swift `Params.extendableYears(periodStart:expiresAt:)`. */
export function paramsExtendableYears(p, periodStart, expiresAt) {
  const room = BigInt(periodStart) + p.maxYears * p.periodMs - BigInt(expiresAt);
  if (room < 0n) return 0n;
  const years = room / p.periodMs;
  return years < p.maxYears ? years : p.maxYears;
}

/** `paramsExtendableYears` of a NameFields. Swift `Params.extendableYears(_ f: NameFields)`. */
export function paramsExtendableYearsOf(p, f) { return paramsExtendableYears(p, f.periodStart, f.expiresAt); }

/** When `renew` becomes valid: `expiresAt - renewWindowMs` (unix ms, BigInt). The transaction is
 *  final once the network's past median time passes its lock time, which is at least this.
 *  Swift `Params.renewOpens(expiresAt:)`. */
export function paramsRenewOpens(p, expiresAt) { return BigInt(expiresAt) - p.renewWindowMs; }

// MARK: - Decoding

function str(v, what) {
  if (typeof v !== "string") throw new Failure(`manifest: ${what} missing`);
  return v;
}

function isNumber(v) { return (typeof v === "number" && Number.isFinite(v)) || typeof v === "bigint"; }

function u64(v, what) {
  if (typeof v === "bigint") {
    if (v < 0n) throw new Failure(`manifest: ${what} missing`);
    return v;
  }
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw new Failure(`manifest: ${what} missing`);
  if (!Number.isSafeInteger(v)) throw new Failure(`manifest: ${what} is not an exact integer`);
  return BigInt(v);
}

function intOf(v) { return typeof v === "bigint" ? Number(v) : Math.trunc(v); }

function tiers(v, what) {
  if (v == null || typeof v !== "object" || Array.isArray(v)) throw new Failure(`manifest: ${what} missing`);
  return ["len1", "len2", "len3", "len4", "len5plus"].map((k) => u64(v[k], `${what}.${k}`));
}

function template(artifacts, contract) {
  const a = artifacts[contract];
  if (a == null || typeof a !== "object" || Array.isArray(a)) throw new Failure(`manifest: ${contract} missing`);
  const prefix = unhex(str(a.prefixHex, `${contract}.prefixHex`));
  const suffix = unhex(str(a.suffixHex, `${contract}.suffixHex`));
  const hash = unhex32(str(a.templateHash, `${contract}.templateHash`));
  const tagsJSON = a.dispatchTags;
  if (tagsJSON == null || typeof tagsJSON !== "object" || Array.isArray(tagsJSON)) {
    throw new Failure(`manifest: ${contract}.dispatchTags missing`);
  }
  const tags = {};
  for (const [k, v] of Object.entries(tagsJSON)) {
    const t = unhex(str(v, `${contract}.dispatchTags.${k}`));
    if (t.length !== 4) throw new Failure(`manifest: ${contract} dispatch tag ${k} is not 4 bytes`);
    tags[k] = t;
  }
  const stateLength = stateLengths[contract] ?? 0;
  // the declared lengths and state span must agree with the bytes
  if (isNumber(a.prefixLen) && intOf(a.prefixLen) !== prefix.length) throw new Failure(`manifest: ${contract}.prefixLen`);
  if (isNumber(a.suffixLen) && intOf(a.suffixLen) !== suffix.length) throw new Failure(`manifest: ${contract}.suffixLen`);
  const span = a.stateSpan;
  if (span != null && typeof span === "object" && !Array.isArray(span)) {
    if (!isNumber(span.offset) || intOf(span.offset) !== prefix.length || !isNumber(span.len) || intOf(span.len) !== stateLength) {
      throw new Failure(`manifest: ${contract}.stateSpan`);
    }
  }
  if (isNumber(a.bytecodeLen) && intOf(a.bytecodeLen) !== prefix.length + stateLength + suffix.length) {
    throw new Failure(`manifest: ${contract}.bytecodeLen`);
  }
  return { contract, prefix, suffix, stateLength, templateHash: hash, dispatchTags: tags };
}

function outpointOf(v, what) {
  // Swift `split(separator: ":")` drops empty pieces; `UInt32(_:)` takes an optional sign
  const op = str(v, what).split(":").filter((s) => s.length > 0);
  if (op.length !== 2 || !/^\+?[0-9]+$/.test(op[1]) || BigInt(op[1]) > 0xffff_ffffn) throw new Failure(`manifest: ${what}`);
  return makeOutpoint(unhex32(op[0]), Number(BigInt(op[1])));
}

function isObject(v) { return v != null && typeof v === "object" && !Array.isArray(v); }

/** A Manifest from its parsed JSON object (no verification; call `verifyManifest`). Throws
 *  `Failure.outdatedRegistry()` for anything but `registryVersion: 3`. */
export function manifestFromJSON(root) {
  if (!isObject(root)) throw new Failure("manifest: not a JSON object");
  const network = str(root.network, "network");
  const status = typeof root.status === "string" ? root.status : "";
  // registry v1 / v2 manifests describe contracts this app no longer builds for: it waits for the
  // v3 geneses (Swift `(root["registryVersion"] as? NSNumber)?.intValue == 3`)
  const rv = root.registryVersion;
  if (!((typeof rv === "number" && Math.trunc(rv) === 3) || rv === 3n)) throw Failure.outdatedRegistry();
  const p = root.params;
  if (!isObject(p)) throw new Failure("manifest: params missing");
  const params = {
    bond: u64(p.bond, "bond"),
    gapValue: u64(p.gapValue, "gapValue"),
    tCommit: u64(p.tCommit, "tCommit"),
    /** most periods a name may be paid ahead */
    maxYears: u64(p.maxYears, "maxYears"),
    /** one paid period, ms: a year on mainnet, 10 minutes on the testnet-10 clock */
    periodMs: u64(p.periodMs, "periodMs"),
    graceMs: u64(p.graceMs, "graceMs"),
    /** `renew` is valid from `expiresAt - renewWindowMs` on */
    renewWindowMs: u64(p.renewWindowMs, "renewWindowMs"),
    /** the price shards' genesis prices, sompi per period for names of 1, 2, 3, 4, 5+ bytes */
    genesisPrices: tiers(p.prices, "prices"),
    priceShards: u64(p.priceShards, "priceShards"),
    /** exact value of every price shard */
    priceValue: u64(p.priceValue, "priceValue"),
    offerMaxFee: u64(p.offerMaxFee, "offerMaxFee"),
  };
  const artifacts = root.artifacts;
  if (!isObject(artifacts)) throw new Failure("manifest: artifacts missing");
  const price = template(artifacts, "KachatPrice");
  const gap = template(artifacts, "KachatGap");
  const name = template(artifacts, "KachatName");
  const offer = template(artifacts, "KachatOffer");
  const priceCovenantId = unhex32(str(root.priceCovenantId, "priceCovenantId"));
  const pg = root.priceGenesis;
  if (!isObject(pg)) throw new Failure("manifest: priceGenesis missing");
  if (!bytesEqual(unhex32(str(pg.priceCovenantId, "priceGenesis.priceCovenantId")), priceCovenantId)) {
    throw new Failure("manifest: priceGenesis is for another price covenant");
  }
  const priceGenesisTxid = unhex32(str(pg.txid, "priceGenesis.txid"));
  const priceGenesisOutpoint = outpointOf(pg.outpoint, "priceGenesis.outpoint");
  const authority = unhex32(str(pg.authority, "priceGenesis.authority"));
  if (!Array.isArray(pg.authorizedOutputs)) throw new Failure("manifest: priceGenesis outputs missing");
  const genesisShards = pg.authorizedOutputs.map((o, i) => {
    if (!isObject(o)) throw new Failure("manifest: priceGenesis outputs missing");
    if (!isNumber(o.index) || intOf(o.index) !== i) throw new Failure(`manifest: price shard ${i} is not output ${i}`);
    const st = o.state;
    if (!isObject(st) || !Array.isArray(st.prices) || st.prices.length !== 5 || !st.prices.every(isNumber)) {
      throw new Failure(`manifest: price shard ${i} state`);
    }
    const fields = makePriceFields({ shard: BigInt(i), authority, prices: st.prices.map((v) => u64(v, `price shard ${i} state`)) });
    const spkVersion = u64(o.scriptPublicKeyVersion, `price shard ${i} spk version`);
    if (spkVersion > 0xffffn) throw new Failure(`manifest: price shard ${i} spk version`);
    const output = makeTxOutput({
      value: u64(o.value, `price shard ${i} value`),
      scriptVersion: Number(spkVersion),
      script: unhex(str(o.scriptPublicKey, `price shard ${i} spk`)),
      covenant: null,
    });
    return { output, fields };
  });
  const registryCovenantId = unhex32(str(root.registryCovenantId, "registryCovenantId"));
  const g = root.genesis;
  if (!isObject(g)) throw new Failure("manifest: genesis missing");
  const genesisTxid = unhex32(str(g.txid, "genesis.txid"));
  const genesisOutpoint = outpointOf(g.outpoint, "genesis.outpoint");
  const outs = g.authorizedOutputs;
  if (!Array.isArray(outs) || outs.length !== 1 || outs[0] == null || typeof outs[0] !== "object") {
    throw new Failure("manifest: the genesis must authorize exactly one output");
  }
  const o = outs[0];
  if (!isNumber(o.index) || intOf(o.index) !== 0) throw new Failure("manifest: the genesis gap is not output 0");
  const spkVersion = u64(o.scriptPublicKeyVersion, "genesis spk version");
  if (spkVersion > 0xffffn) throw new Failure("manifest: genesis spk version");
  const genesisOutput = makeTxOutput({
    value: u64(o.value, "genesis value"),
    scriptVersion: Number(spkVersion),
    script: unhex(str(o.scriptPublicKey, "genesis spk")),
    covenant: null,
  });
  const st = o.state;
  if (st == null || typeof st !== "object" || Array.isArray(st)) throw new Failure("manifest: genesis state missing");
  const genesisState = { lo: unhex32(str(st.lo, "genesis lo")), hi: unhex32(str(st.hi, "genesis hi")) };
  return {
    network, status, params, price, gap, name, offer,
    priceCovenantId, priceGenesisTxid, priceGenesisOutpoint, genesisShards,
    registryCovenantId, genesisTxid, genesisOutpoint, genesisOutput, genesisState,
    /** A manifest from a dry run describes a registry that does not exist. */
    isDryRun: status.startsWith("dry run"),
  };
}

/** A Manifest from JSON text, its UTF-8 bytes, or an already parsed object (no verification). */
export function decodeManifest(data) {
  let root = data;
  if (data instanceof Uint8Array) root = JSON.parse(fromUtf8(data));
  else if (typeof data === "string") root = JSON.parse(data);
  return manifestFromJSON(root);
}

// MARK: - Verification

/** Checks everything the app relies on (KACHAT_NAMES_INDEXER.md B2, kachat-domains
 *  `manifest::load`): testnet-10 only; every template's hash recomputed from its prefix and
 *  suffix and equal to the pinned build where pinned (an indexer-served manifest needs every hash
 *  pinned but the offer's); every dispatch tag present; the gap and name baked for this price
 *  covenant and price template, the gap for this name template, the offer for this registry id
 *  and name template; the price genesis outputs are shards 0..K-1 of the price template worth
 *  `priceValue`, and `priceCovenantId == covenant_id(price genesis outpoint, [(i, shard_i)])`;
 *  the genesis output is the genesis gap `(00..00, ff..ff)` worth `gapValue`; and
 *  `registryCovenantId == covenant_id(genesis outpoint, [(0, genesis gap)])`. Throws a Failure.
 *  `source` is `ManifestSource.bundle` (default) or `ManifestSource.indexer`. */
export function verifyManifest(m, { source = ManifestSource.bundle } = {}) {
  if (m.network !== supportedNetwork) {
    throw new Failure(`manifest is for ${m.network}; only ${supportedNetwork} is enabled (mainnet waits for an audit)`);
  }
  for (const t of [m.price, m.gap, m.name, m.offer]) {
    if (!bytesEqual(computeTemplateHash(t.prefix, t.suffix), t.templateHash)) {
      throw new Failure(`manifest: ${t.contract} template hash does not match its prefix and suffix`);
    }
    const pinned = pinnedTemplateHashes[t.contract];
    if (pinned !== undefined) {
      if (hex(t.templateHash) !== pinned) throw new Failure(`manifest: ${t.contract} is not the pinned build`);
    } else if (source === ManifestSource.indexer && t.contract !== "KachatOffer") {
      throw new Failure(`manifest: ${t.contract} is not pinned in this app; only a bundled manifest is trusted`);
    }
    for (const e of entries[t.contract] ?? []) {
      if (!Object.prototype.hasOwnProperty.call(t.dispatchTags, e)) {
        throw new Failure(`manifest: ${t.contract} dispatch tag for ${e} missing`);
      }
    }
  }
  for (const t of [m.gap, m.name]) {
    if (indexOfBytes(t.suffix, m.priceCovenantId) < 0 || indexOfBytes(t.suffix, m.price.templateHash) < 0) {
      throw new Failure(`manifest: the ${t.contract} is not built for this price covenant and price template`);
    }
  }
  if (indexOfBytes(m.gap.suffix, m.name.templateHash) < 0) throw new Failure("manifest: the gap is not built for this name template");
  if (indexOfBytes(m.offer.suffix, m.registryCovenantId) < 0 || indexOfBytes(m.offer.suffix, m.name.templateHash) < 0) {
    throw new Failure("manifest: the offer is not built for this registry id and name template");
  }
  const p = m.params;
  if (p.genesisPrices.length !== 5 || p.maxYears < 1n || p.maxYears > 31n
    || p.periodMs < 60_000n || p.periodMs > yearMs || !(p.maxYears * p.periodMs < 1_000_000_000_000n)
    || !(p.renewWindowMs > 0n) || !(p.renewWindowMs <= p.periodMs)
    || p.priceShards < 1n || p.priceShards > 8n) {
    throw new Failure("manifest: params out of range");
  }
  if (BigInt(m.genesisShards.length) !== p.priceShards) {
    throw new Failure(`manifest: ${m.genesisShards.length} price shards, params say ${p.priceShards}`);
  }
  m.genesisShards.forEach((s, i) => {
    if (s.output.value !== p.priceValue || s.output.scriptVersion !== 0
      || !bytesEqual(s.output.script, templateScript(m.price, priceState(s.fields))) || s.fields.shard !== BigInt(i)) {
      throw new Failure(`manifest: price genesis output ${i} is not shard ${i} of the price template`);
    }
  });
  const pid = covenantId(m.priceGenesisOutpoint, m.genesisShards.map((s, i) => ({ index: i, output: s.output })));
  if (!bytesEqual(pid, m.priceCovenantId)) {
    throw new Failure(`manifest: price covenant id ${hex(m.priceCovenantId)} != covenant_id(price genesis) ${hex(pid)}`);
  }
  if (!bytesEqual(m.genesisState.lo, zero32()) || !bytesEqual(m.genesisState.hi, ff32())) {
    throw new Failure("manifest: genesis gap is not (00..00, ff..ff)");
  }
  const gapScript = templateScript(m.gap, gapState(zero32(), ff32()));
  if (!bytesEqual(m.genesisOutput.script, gapScript) || m.genesisOutput.scriptVersion !== 0) {
    throw new Failure("manifest: genesis output is not the genesis gap of these templates");
  }
  if (m.genesisOutput.value !== p.gapValue) throw new Failure("manifest: genesis gap value");
  const id = covenantId(m.genesisOutpoint, [{ index: 0, output: m.genesisOutput }]);
  if (!bytesEqual(id, m.registryCovenantId)) {
    throw new Failure(`manifest: registry id ${hex(m.registryCovenantId)} != covenant_id(genesis) ${hex(id)}`);
  }
}
