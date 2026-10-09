// .kachat names: the deployment manifest and the compiled contract templates.
//
// Port of iOS KaChat/Services/KachatNames/KachatNamesManifest.swift. The manifest
// `kachat-names-<network>.json` is written by the kachat-domains CLI's `genesis` and served by
// the indexer at `GET /names/manifest`; the testnet-10 one is bundled next to this file
// (kachat-names-testnet-10.json, byte-identical to the iOS resource). `verifyManifest` must pass
// before anything trusts it. Registry v4 and v5 (`registryVersion: 4 | 5`; v5 adds `import` from a
// migration snapshot, iOS 6f18475): an earlier manifest throws `Failure.outdatedRegistry()`, a later
// one `Failure.newerRegistry()` (the screens say the registry is being set up).
//
//   Template { contract, prefix, suffix, stateLength, templateHash, dispatchTags: { entry: Uint8Array(4) } }
//   Params   { bond, gapValue, tCommit, maxYears, periodMs, graceMs, renewWindowMs: bigint,
//              registerPrices[5]: bigint, renewPrices[5]: bigint, offerMaxFee: bigint,
//              migration: Migration | null }
//   Migration { predecessorRegistryId, root, sponsor: Uint8Array(32), deadlineMs: bigint }   (v5)
//   Manifest { network, status, registryVersion: 4 | 5, params, gap, name, offer: Template, registryCovenantId, genesisTxid,
//              genesisOutpoint: Outpoint, genesisOutput: TxOutput, genesisState: { lo, hi }, isDryRun }
//
// The prices are fixed (registry v4): baked into the gap and name templates, whose hashes are
// pinned, so `registerPrices` / `renewPrices` are what the contracts charge (no price record).

import {
  Failure, hex, unhex, unhex32, concat, bytesEqual, indexOfBytes, tier, templateHash as computeTemplateHash,
  p2shScript, gapState, covenantId, zero32, ff32, fromUtf8, yearMs,
} from "./codec.js";
import { makeOutpoint, makeTxOutput } from "./transaction.js";

/** Only testnet-10 is enabled (mainnet waits for an audit). */
export const supportedNetwork = "testnet-10";
/** The bundled manifest's base name (engine/kachat-names/kachat-names-testnet-10.json). */
export const bundleResource = "kachat-names-testnet-10";

/** Registry versions this app builds for: v4, and v5 (v4 plus `import` from a migration snapshot,
 *  kachat-domains docs/REGISTRY_V5.md). Swift `Manifest.supportedVersions`. */
export const supportedVersions = Object.freeze([4, 5]);

/** Template hashes of the pinned build by registry version (silverc v1.0.0 @ 3ed9733), testnet-10
 *  params on the day clock: 24-hour periods, 6-hour grace, 2-hour renewal window (kachat-domains
 *  artifacts/testnet10/build-info.json; iOS 08107e1, 6f18475). The v4 gap and the name bake only
 *  the params - their fixed prices included - so they are pinned before any genesis. The v5 gap
 *  also bakes its migration (snapshot root, deadline, sponsor) and the offer the registry id, so
 *  their hashes exist per deployment: `deployedTemplateHashes`. A manifest with any template
 *  unpinned is trusted only from the bundle (`verifyManifest(m, { source })`), never from an
 *  indexer - an unpinned offer template could hold buyers' funds in a script the indexer controls
 *  (iOS 1d81a1a, IOS-059). */
export const pinnedTemplateHashes = {
  4: {
    KachatGap: "9f057f406361583eb2b94956825f86a2d8cc47d3c8800f05855a3e75b39d8bf5",
    KachatName: "c263a8c2cb4bdfac3234675114fc3ce4ba5a1d26c12e887c3d3b2ca89460b56b",
  },
  // the audited contracts (kachat-domains fbd9cf2, audit C2: no other covenant's input shares the
  // fee) - the name changed with them (iOS 427efd7)
  5: {
    KachatName: "9d4f91bfd7aea47f8529104d260dc7b80c673fe04e2595b21abe47209c39e0e8",
  },
};
/** The price tables the pinned gap and name bake (kachat-domains params/testnet10.json), sompi by
 *  name length 1, 2, 3, 4, 5+ bytes: a manifest whose params say otherwise would show and charge
 *  prices the contracts don't (Swift `Manifest.pinnedRegisterPrices` / `pinnedRenewPrices`). */
export const pinnedRegisterPrices = Object.freeze([4_000_000_000n, 2_000_000_000n, 1_000_000_000n, 250_000_000n, 35_000_000n]);
export const pinnedRenewPrices = Object.freeze([1_000_000_000n, 500_000_000n, 250_000_000n, 62_500_000n, 8_750_000n]);
/** The per-deployment builds (the offer; on v5 also the gap) each deployed registry was launched
 *  with, by registry covenant id (Swift `Manifest.deployedTemplateHashes`). A manifest for one of
 *  these registries must carry exactly this; any other registry (a dry run, the test vectors) has
 *  no such pin, so only a bundled manifest of it is trusted. */
export const deployedTemplateHashes = {
  // testnet-10 registry v5 on the audited contracts, 2026-10-09: genesis b6223f0f..e24f, imports
  // the drill registry fdc403f5..571d (snapshot of 6 names); offerMaxFee 0.1 KAS (iOS 427efd7).
  // The retired drill registry's pins are dropped.
  "1283f749506c454488a6b7264197658ed1c12051f1887905c4396243a89fbfa2": {
    KachatGap: "9fe90632a60e8771f2b8ac5e4368d5f4a2990fb9e5ad0fa6f3771b6287ee4242",
    KachatOffer: "7cb988f2b608aa5575bed8455b006f4ce11b8c2ac09aae377d41b1f94c935100",
  },
  // testnet-10 registry v4 on the day clock, 2026-10-07: genesis 5ffdd006..a777 (the
  // 10-minute deployment bff18554..0e2f before it is retired: its gap and name aren't pinned)
  "e6b7244831004e1db928458bce570347317b50ff124c010d342d73a6c2017f0d": {
    KachatOffer: "5a7e22af319bac406769563b6b4b39b05c3aac145375ccaaada4095960372a7a",
  },
};

/** Every pinned template hash for the registry `registryCovenantId` (Uint8Array or hex) of
 *  `registryVersion` (default 4): that version's `pinnedTemplateHashes` merged with the
 *  deployment's `deployedTemplateHashes` (the version pin wins on a clash, as Swift's
 *  `merging { pinned, _ in pinned }`). */
export function templatePinsFor(registryCovenantId, registryVersion = 4) {
  const id = typeof registryCovenantId === "string" ? registryCovenantId.toLowerCase() : hex(registryCovenantId);
  const deployed = Object.prototype.hasOwnProperty.call(deployedTemplateHashes, id) ? deployedTemplateHashes[id] : {};
  const v = Number(registryVersion);
  const pinned = Object.prototype.hasOwnProperty.call(pinnedTemplateHashes, v) ? pinnedTemplateHashes[v] : {};
  return { ...deployed, ...pinned };
}
/** State lengths per contract (registry v4: gap 66, name 126, offer 108). */
export const stateLengths = { KachatGap: 66, KachatName: 126, KachatOffer: 108 };
/** The dispatch entries a contract must have on `registryVersion` (the v5 gap adds `import`).
 *  Swift `Manifest.entries(_:version:)`. */
export function entriesFor(contract, registryVersion) {
  if (contract === "KachatGap" && Number(registryVersion) >= 5) return ["register", "merge", "absorbed", "import"];
  return entries[contract] ?? [];
}
/** The dispatch entries every contract must have (registry v4). */
export const entries = {
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

// MARK: - Params (kachat-domains params/<network>.json, registry v4)

// MARK: Prices (registry v4: KachatGap.priceFor, KachatName.renewPrice)

/** `register` is refused while `now < migration.deadlineMs` (registry v5): the sponsor imports
 *  every snapshot name first. Swift `Params.registerOpen(atMs:)`. */
export function paramsRegisterOpen(p, now) { return BigInt(now) >= (p.migration?.deadlineMs ?? 0n); }

/** What a name of `n` bytes costs for its first period (sompi, BigInt).
 *  Swift `Params.registerPrice(forLength:)`. */
export function paramsRegisterPrice(p, n) { return p.registerPrices[tier(n)]; }

/** What every further period of a name of `n` bytes costs (extend, renew, registering past one
 *  period), sompi BigInt. Swift `Params.renewPrice(forLength:)`. */
export function paramsRenewPrice(p, n) { return p.renewPrices[tier(n)]; }

/** What `register` charges for `years` periods (BigInt): the first at the registration price,
 *  every further one at the renewal price. Swift `Params.registerCost(forLength:years:)`. */
export function paramsRegisterCost(p, n, years) {
  const y = BigInt(years);
  return paramsRegisterPrice(p, n) + paramsRenewPrice(p, n) * (y - 1n > 0n ? y - 1n : 0n);
}

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

/** How close to expiry a name counts as "expires soon" (a buyer would have to renew it), unix ms
 *  (BigInt): 30 days on a yearly clock, the renewal window on a short one (testnet's 2 hours),
 *  where 30 days would cover every name. Swift `Params.expiresSoonMs` (iOS 24d673a, IOS-060). */
export function paramsExpiresSoonMs(p) {
  const month = 30n * 86_400_000n;
  const twelfth = p.periodMs / 12n;
  const capped = twelfth < month ? twelfth : month;
  return p.renewWindowMs > capped ? p.renewWindowMs : capped;
}

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
 *  `Failure.outdatedRegistry()` for a registry before v4, `Failure.newerRegistry()` after v5. */
export function manifestFromJSON(root) {
  if (!isObject(root)) throw new Failure("manifest: not a JSON object");
  const network = str(root.network, "network");
  const status = typeof root.status === "string" ? root.status : "";
  // registry v1 - v3 manifests describe contracts this app no longer builds for; a later version
  // needs a newer app (Swift `(root["registryVersion"] as? NSNumber)?.intValue ?? 0`)
  const rv = root.registryVersion;
  const version = typeof rv === "bigint" ? Number(rv) : (typeof rv === "number" && Number.isFinite(rv) ? Math.trunc(rv) : 0);
  if (!supportedVersions.includes(version)) {
    throw version > Math.max(...supportedVersions) ? Failure.newerRegistry() : Failure.outdatedRegistry();
  }
  const p = root.params;
  if (!isObject(p)) throw new Failure("manifest: params missing");
  let migration = null;
  if (version >= 5) {
    const mj = p.migration;
    if (!isObject(mj)) throw new Failure("manifest: params.migration missing (registry v5)");
    const mig = {
      predecessorRegistryId: unhex32(str(mj.predecessorRegistryId, "migration.predecessorRegistryId")),
      root: unhex32(str(mj.root, "migration.root")),
      deadlineMs: u64(mj.deadlineMs, "migration.deadlineMs"),
      /** x-only key that may import for the snapshot owners (zero: owners only) */
      sponsor: unhex32(str(mj.sponsor, "migration.sponsor")),
    };
    // root 0 and deadline 0: a v5 registry with no predecessor (register works as on v4)
    migration = (bytesEqual(mig.root, zero32()) && mig.deadlineMs === 0n) ? null : mig;
  }
  const params = {
    bond: u64(p.bond, "bond"),
    gapValue: u64(p.gapValue, "gapValue"),
    tCommit: u64(p.tCommit, "tCommit"),
    /** most periods a name may be paid ahead */
    maxYears: u64(p.maxYears, "maxYears"),
    /** one paid period, ms: a year on mainnet, 24 hours on the testnet-10 clock */
    periodMs: u64(p.periodMs, "periodMs"),
    graceMs: u64(p.graceMs, "graceMs"),
    /** `renew` is valid from `expiresAt - renewWindowMs` on */
    renewWindowMs: u64(p.renewWindowMs, "renewWindowMs"),
    /** sompi for a name's first period, by length 1, 2, 3, 4, 5+ bytes */
    registerPrices: tiers(isObject(p.prices) ? p.prices.register : undefined, "prices.register"),
    /** sompi for every further period (extend, renew, registering past one period) */
    renewPrices: tiers(isObject(p.prices) ? p.prices.renew : undefined, "prices.renew"),
    offerMaxFee: u64(p.offerMaxFee, "offerMaxFee"),
    /** registry v5: the predecessor snapshot this registry imports (kachat-domains
     *  docs/REGISTRY_V5.md section 4), baked into the v5 gap; null on v4 and on a v5 registry with
     *  no predecessor */
    migration,
  };
  const artifacts = root.artifacts;
  if (!isObject(artifacts)) throw new Failure("manifest: artifacts missing");
  const gap = template(artifacts, "KachatGap");
  const name = template(artifacts, "KachatName");
  const offer = template(artifacts, "KachatOffer");
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
    network, status, registryVersion: version, params, gap, name, offer,
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
 *  suffix and equal to the pinned build where pinned (`templatePinsFor`: the gap and name
 *  everywhere, the offer per deployed registry id; an indexer-served manifest needs every hash
 *  pinned, the offer's too - IOS-059); every dispatch tag present; the gap baked for this name
 *  template, the offer for this registry id and name template; both price tables complete, in
 *  range and equal to the ones the pinned gap and name bake (`pinnedRegisterPrices` /
 *  `pinnedRenewPrices`); the genesis output is the genesis gap `(00..00, ff..ff)` worth `gapValue`; and
 *  `registryCovenantId == covenant_id(genesis outpoint, [(0, genesis gap)])`. Throws a Failure.
 *  `source` is `ManifestSource.bundle` (default) or `ManifestSource.indexer`. */
export function verifyManifest(m, { source = ManifestSource.bundle } = {}) {
  if (m.network !== supportedNetwork) {
    throw new Failure(`manifest is for ${m.network}; only ${supportedNetwork} is enabled (mainnet waits for an audit)`);
  }
  const pins = templatePinsFor(m.registryCovenantId, m.registryVersion);
  for (const t of [m.gap, m.name, m.offer]) {
    if (!bytesEqual(computeTemplateHash(t.prefix, t.suffix), t.templateHash)) {
      throw new Failure(`manifest: ${t.contract} template hash does not match its prefix and suffix`);
    }
    const pinned = Object.prototype.hasOwnProperty.call(pins, t.contract) ? pins[t.contract] : undefined;
    if (pinned !== undefined) {
      if (hex(t.templateHash) !== pinned) throw new Failure(`manifest: ${t.contract} is not the pinned build`);
    } else if (source === ManifestSource.indexer) {
      throw new Failure(`manifest: ${t.contract} is not pinned in this app; only a bundled manifest is trusted`);
    }
    for (const e of entriesFor(t.contract, m.registryVersion)) {
      if (!Object.prototype.hasOwnProperty.call(t.dispatchTags, e)) {
        throw new Failure(`manifest: ${t.contract} dispatch tag for ${e} missing`);
      }
    }
  }
  if (indexOfBytes(m.gap.suffix, m.name.templateHash) < 0) throw new Failure("manifest: the gap is not built for this name template");
  const mig = m.params.migration;
  if (mig) {
    // the v5 gap bakes its snapshot root and sponsor (the deadline is a number)
    if (indexOfBytes(m.gap.suffix, mig.root) < 0 || !(bytesEqual(mig.sponsor, zero32()) || indexOfBytes(m.gap.suffix, mig.sponsor) >= 0)) {
      throw new Failure("manifest: the gap is not built for this migration snapshot");
    }
    if (bytesEqual(mig.predecessorRegistryId, m.registryCovenantId)) throw new Failure("manifest: a registry can't import itself");
  }
  if (indexOfBytes(m.offer.suffix, m.registryCovenantId) < 0 || indexOfBytes(m.offer.suffix, m.name.templateHash) < 0) {
    throw new Failure("manifest: the offer is not built for this registry id and name template");
  }
  const p = m.params;
  const priceCap = 100_000_000_000_000_000n; // scripts/build.py
  if (p.registerPrices.length !== 5 || p.renewPrices.length !== 5
    || ![...p.registerPrices, ...p.renewPrices].every((v) => v <= priceCap)
    || p.maxYears < 1n || p.maxYears > 31n
    || p.periodMs < 60_000n || p.periodMs > yearMs || !(p.maxYears * p.periodMs < 1_000_000_000_000n)
    || !(p.renewWindowMs > 0n) || !(p.renewWindowMs <= p.periodMs)) {
    throw new Failure("manifest: params out of range");
  }
  const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
  if (!same(p.registerPrices, pinnedRegisterPrices) || !same(p.renewPrices, pinnedRenewPrices)) {
    throw new Failure("manifest: the price tables are not the ones the pinned gap and name bake");
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
