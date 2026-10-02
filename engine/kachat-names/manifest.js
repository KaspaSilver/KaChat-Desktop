// .kachat names: the deployment manifest and the compiled contract templates.
//
// Port of iOS KaChat/Services/KachatNames/KachatNamesManifest.swift. The manifest
// `kachat-names-<network>.json` is written by the kachat-domains CLI's `genesis` and served by
// the indexer at `GET /names/manifest`; the testnet-10 one is bundled next to this file
// (kachat-names-testnet-10.json, byte-identical to the iOS resource). `verifyManifest` must pass
// before anything trusts it.
//
//   Template { contract, prefix, suffix, stateLength, templateHash, dispatchTags: { entry: Uint8Array(4) } }
//   Params   { bond, gapValue, tCommit, maxYears, graceMs: bigint, prices[5], renewPrices[5]: bigint, offerMaxFee: bigint }
//   Manifest { network, status, params, gap, name, offer: Template, registryCovenantId, genesisTxid,
//              genesisOutpoint: Outpoint, genesisOutput: TxOutput, genesisState: { lo, hi }, isDryRun }

import {
  Failure, hex, unhex, unhex32, concat, bytesEqual, indexOfBytes, tier, templateHash as computeTemplateHash,
  p2shScript, gapState, covenantId, zero32, ff32, fromUtf8,
} from "./codec.js";
import { makeOutpoint, makeTxOutput } from "./transaction.js";

/** Only testnet-10 is enabled (mainnet waits for an audit). */
export const supportedNetwork = "testnet-10";
/** The bundled manifest's base name (engine/kachat-names/kachat-names-testnet-10.json). */
export const bundleResource = "kachat-names-testnet-10";

/** Template hashes of the pinned build (silverc v1.0.0 @ 3ed9733), the same on every network
 *  (README "Sizes and template hashes"). The offer bakes the registry id, so it is checked
 *  against the id instead. */
export const pinnedTemplateHashes = {
  KachatGap: "a182d59bbf460baff5ec99ca850b990d45fbafee4dfbe9a3a7a1afe21e7ba8ca",
  KachatName: "42eddf19e7ea2bc78b9aa97937f21be0505ebcf964653508f74e179dd6c7e39d",
};
/** State lengths per contract (gap 66, name 117, offer 75). */
export const stateLengths = { KachatGap: 66, KachatName: 117, KachatOffer: 75 };
/** The dispatch entries every contract must have. */
export const entries = {
  KachatGap: ["register", "merge", "absorbed"],
  KachatName: ["transfer", "list", "buy", "renew", "release", "reclaim"],
  KachatOffer: ["accept", "withdraw", "refund"],
};

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

// MARK: - Params (params/testnet10.json, identical on testnet-10 and mainnet)

/** Registration price per year (sompi) for a name of `n` bytes. */
export function paramsPrice(p, n) { return p.prices[tier(n)]; }

/** Renewal price per year (sompi) for a name of `n` bytes. */
export function paramsRenewPrice(p, n) { return p.renewPrices[tier(n)]; }

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

/** A Manifest from its parsed JSON object (no verification; call `verifyManifest`). */
export function manifestFromJSON(root) {
  if (root == null || typeof root !== "object" || Array.isArray(root)) throw new Failure("manifest: not a JSON object");
  const network = str(root.network, "network");
  const status = typeof root.status === "string" ? root.status : "";
  const p = root.params;
  if (p == null || typeof p !== "object" || Array.isArray(p)) throw new Failure("manifest: params missing");
  const params = {
    bond: u64(p.bond, "bond"),
    gapValue: u64(p.gapValue, "gapValue"),
    tCommit: u64(p.tCommit, "tCommit"),
    maxYears: u64(p.maxYears, "maxYears"),
    graceMs: u64(p.graceMs, "graceMs"),
    prices: tiers(p.prices, "prices"),
    renewPrices: tiers(p.renewPrices, "renewPrices"),
    offerMaxFee: u64(p.offerMaxFee, "offerMaxFee"),
  };
  const artifacts = root.artifacts;
  if (artifacts == null || typeof artifacts !== "object" || Array.isArray(artifacts)) throw new Failure("manifest: artifacts missing");
  const gap = template(artifacts, "KachatGap");
  const name = template(artifacts, "KachatName");
  const offer = template(artifacts, "KachatOffer");
  const registryCovenantId = unhex32(str(root.registryCovenantId, "registryCovenantId"));
  const g = root.genesis;
  if (g == null || typeof g !== "object" || Array.isArray(g)) throw new Failure("manifest: genesis missing");
  const genesisTxid = unhex32(str(g.txid, "genesis.txid"));
  // Swift `split(separator: ":")` drops empty pieces; `UInt32(_:)` takes an optional sign
  const op = str(g.outpoint, "genesis.outpoint").split(":").filter((s) => s.length > 0);
  if (op.length !== 2 || !/^\+?[0-9]+$/.test(op[1]) || BigInt(op[1]) > 0xffff_ffffn) throw new Failure("manifest: genesis.outpoint");
  const genesisOutpoint = makeOutpoint(unhex32(op[0]), Number(BigInt(op[1])));
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
    network, status, params, gap, name, offer, registryCovenantId, genesisTxid, genesisOutpoint, genesisOutput, genesisState,
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
 *  suffix, the gap and name ones equal to the pinned build; every dispatch tag present; the offer
 *  baked for this registry id and name template; the genesis output is the genesis gap
 *  `(00..00, ff..ff)` worth `gapValue`; and
 *  `registryCovenantId == covenant_id(genesis outpoint, [(0, genesis gap)])`. Throws a Failure. */
export function verifyManifest(m) {
  if (m.network !== supportedNetwork) {
    throw new Failure(`manifest is for ${m.network}; only ${supportedNetwork} is enabled (mainnet waits for an audit)`);
  }
  for (const t of [m.gap, m.name, m.offer]) {
    if (!bytesEqual(computeTemplateHash(t.prefix, t.suffix), t.templateHash)) {
      throw new Failure(`manifest: ${t.contract} template hash does not match its prefix and suffix`);
    }
    const pinned = pinnedTemplateHashes[t.contract];
    if (pinned !== undefined && hex(t.templateHash) !== pinned) {
      throw new Failure(`manifest: ${t.contract} is not the pinned build`);
    }
    for (const e of entries[t.contract] ?? []) {
      if (!Object.prototype.hasOwnProperty.call(t.dispatchTags, e)) {
        throw new Failure(`manifest: ${t.contract} dispatch tag for ${e} missing`);
      }
    }
  }
  if (indexOfBytes(m.offer.suffix, m.registryCovenantId) < 0 || indexOfBytes(m.offer.suffix, m.name.templateHash) < 0) {
    throw new Failure("manifest: the offer is not built for this registry id and name template");
  }
  const p = m.params;
  if (p.prices.length !== 5 || p.renewPrices.length !== 5 || p.maxYears < 1n || p.maxYears > 31n) {
    throw new Failure("manifest: params out of range");
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
