// The .kachat names service and actions (engine/kachat-names/service.js, actions.js) without a
// node: signing every vector plan with the vectors' deployer key, the conversion to the Kaspa WASM
// SDK's Transaction (when the WASM loads in Node), submit through a fake engine, the live-UTXO and
// funding filters, the profile record checks, key validation and the registration records.
// Run from the repo root:
//
//   node tools/test-kachat-names-service.mjs [path/to/KachatNamesVectors.json]
//
// The vectors' signatures were made with random aux randomness ("Signatures are random per run"),
// so they cannot be reproduced byte for byte: the test verifies the recorded signatures over the
// port's sighashes and its own signatures over the same sighashes, and checks the signed txids.

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { schnorr } from "@noble/curves/secp256k1.js";
import { execFileSync } from "node:child_process";

// engine/network.js reads the network once, at import: open the testnet gate first
const store = new Map([["kachat-network-v1", "testnet"]]);
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
};

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");
const C = await import("../engine/kachat-names/codec.js");
const T = await import("../engine/kachat-names/transaction.js");
const M = await import("../engine/kachat-names/manifest.js");
const B = await import("../engine/kachat-names/builder.js");
const S = await import("../engine/kachat-names/service.js");
const A = await import("../engine/kachat-names/actions.js");
const RS = await import("../engine/kachat-names/registry-state.js");

class Report {
  constructor() { this.pass = 0; this.fail = 0; this.failures = []; this.skipped = []; }
  check(ok, what) {
    if (ok) this.pass += 1;
    else { this.fail += 1; this.failures.push(typeof what === "function" ? what() : what); }
  }
  eq(a, b, what) { this.check(a === b, () => `${what}: got ${a} expected ${b}`); }
  async throws(f, test, what) {
    try { await f(); this.check(false, `${what}: did not throw`); } catch (e) { this.check(test(e), () => `${what}: threw ${e?.stack || e}`); }
  }
}

const u64 = (v) => BigInt(v);
const num = (v) => Number(v);
const s = (v) => { if (typeof v !== "string") throw new Error(`expected a string, got ${v}`); return v; };
const hx = (v) => C.unhex(s(v));

function utxo(u) {
  return T.makeUtxo(
    T.makeOutpoint(hx(u.txid), num(u.index)),
    T.makeUtxoEntry({
      amount: u64(u.amount), scriptVersion: num(u.scriptVersion), script: hx(u.script),
      blockDaaScore: u64(u.blockDaaScore), isCoinbase: u.isCoinbase === true,
      covenantId: u.covenantId == null ? null : hx(u.covenantId),
    }),
  );
}
const gapRec = (g) => ({ lo: hx(g.lo), hi: hx(g.hi), value: u64(g.value), utxo: utxo(g.utxo) });
function nameRec(n) {
  const name = s(n.name);
  const fields = C.makeNameFields({ key: hx(n.key), paddedName: C.padded(name), owner: hx(n.owner), price: u64(n.price),
    periodStart: u64(n.periodStart), expiresAt: u64(n.expiresAt) });
  return { fields, value: u64(n.value), utxo: utxo(n.utxo) };
}
function offerRec(o) {
  const fields = C.makeOfferFields({ key: hx(o.key), buyer: hx(o.buyer), seller: hx(o.seller), refundAfter: u64(o.refundAfter) });
  return { fields, value: u64(o.value), utxo: utxo(o.utxo), name: typeof o.name === "string" ? o.name : null };
}
/** The steps the app builds: every one (registry v4 has no price changes). */
const appSteps = (v) => v.steps;
const commitRec = (c) => ({ name: s(c.name), owner: hx(c.owner), salt: hx(c.salt), value: u64(c.value), utxo: utxo(c.utxo) });

function build(b, op, env, wallet, args, rec) {
  switch (op) {
    case "commit": return b.commit({ env, wallet, name: s(args.name), salt: hx(args.salt) });
    case "register": return b.register({ env, wallet, gap: gapRec(rec.gap), commit: commitRec(rec.commit), years: u64(args.years), now: u64(args.now) });
    case "extend": return b.extend({ env, wallet, name: nameRec(rec.name), years: u64(args.years) });
    case "renew": return b.renew({ env, wallet, name: nameRec(rec.name), years: u64(args.years) });
    case "transfer": return b.transfer({ env, wallet, name: nameRec(rec.name), newOwner: hx(args.newOwner) });
    case "list": return b.list({ env, wallet, name: nameRec(rec.name), price: u64(args.price) });
    case "buy": return b.buy({ env, wallet, name: nameRec(rec.name) });
    case "offer": return b.offer({ env, wallet, target: nameRec(rec.target), amount: u64(args.amount), refundAfter: u64(args.refundAfter) });
    case "acceptOffer": return b.acceptOffer({ env, name: nameRec(rec.name), offer: offerRec(rec.offer) });
    case "declineOffer": return b.declineOffer({ env, offer: offerRec(rec.offer) });
    case "withdrawOffer": return b.withdrawOffer({ env, offer: offerRec(rec.offer) });
    case "refundOffer": return b.refundOffer({ env, offer: offerRec(rec.offer) });
    case "release": return b.release({ env, parts: { below: gapRec(rec.below), name: nameRec(rec.name), above: gapRec(rec.above) } });
    case "reclaim": return b.reclaim({ env, parts: { below: gapRec(rec.below), name: nameRec(rec.name), above: gapRec(rec.above) } });
    case "cancelCommit": return b.cancelCommit({ env, commit: commitRec(rec.commit) });
    default: throw new Error(`unknown op ${op}`);
  }
}

/** The vectors' deployer key (kachat-domains harness `keypair(77)`: 0x5a, 0..., 77). */
function deployerKey() {
  const sk = new Uint8Array(32);
  sk[0] = 0x5a;
  sk[31] = 77;
  return sk;
}

/** The 64-byte signature inside a 65-byte push (`0x41 sig64 0x01`) of a signature script, or null. */
function sigOf(script) {
  for (let at = 0; at + 66 <= script.length; at++) {
    if (script[at] === 0x41 && script[at + 65] === 0x01) return script.slice(at + 1, at + 65);
  }
  return null;
}

async function loadWasm() {
  try {
    const mod = await import("../kaspa/kaspa.js");
    await mod.default({ module_or_path: readFileSync(join(repo, "kaspa/kaspa_bg.wasm")) });
    return mod;
  } catch (e) {
    return { error: e?.message ?? String(e) };
  }
}

/** A KaspaEngine stand-in: the DAG point, a UTXO set and a submit that answers the SDK's id. */
function fakeEngine({ kaspa = null, utxos = [], dag = { networkId: "testnet-10", virtualDaaScore: 590_000_100n, pastMedianTime: 2_105_359_869_000n } } = {}) {
  return {
    kaspa,
    submitted: [],
    log: () => {},
    async currentDagPoint() { return dag; },
    async currentVirtualDaaScore() { return dag.virtualDaaScore; },
    async getUtxosWithCovenants(addresses) { return utxos.filter((u) => addresses.includes(u.address)); },
    async submitRpcTransaction(tx, opts) { this.submitted.push(tx); this.submitOpts = opts; return tx.id; },
  };
}

/** A core Utxo as the engine's plain node UTXO at `address`. */
function plainOf(u, address) {
  return {
    address,
    outpoint: { transactionId: C.hex(u.outpoint.txid), index: u.outpoint.index },
    amount: u.entry.amount, scriptPublicKey: C.hex(u.entry.script), scriptVersion: u.entry.scriptVersion,
    blockDaaScore: u.entry.blockDaaScore, isCoinbase: u.entry.isCoinbase,
    covenantId: u.entry.covenantId ? C.hex(u.entry.covenantId) : null,
  };
}

async function main() {
  const path = process.argv[2] ?? join(repo, "tools/fixtures/kachat-names-vectors.json");
  if (!existsSync(path)) { console.error(`no vectors at ${path}`); process.exit(2); }
  const v = JSON.parse(readFileSync(path, "utf8"));
  const r = new Report();

  // MARK: keys and addresses
  const sk = deployerKey();
  const me = S.xonlyKey(sk);
  r.eq(C.hex(me), s(v.deployer.xonly), "xonlyKey(deployer) is the vectors' deployer");
  r.eq(C.hex(S.xonlyKey(C.hex(sk))), s(v.deployer.xonly), "xonlyKey(hex)");
  r.eq(S.addressOf(me), s(v.deployer.address), "addressOf(deployer)");
  r.eq(C.hex(S.keyOf(s(v.deployer.address)) ?? new Uint8Array(0)), s(v.deployer.xonly), "keyOf(deployer address)");
  r.check(S.isValidXonly(me), "deployer key is on the curve");
  r.check(!S.isValidXonly(new Uint8Array(32)), "zero key refused");
  // x = 5 has no point on secp256k1 (5^3 + 7 = 132 is not a square mod p)
  const offCurve = new Uint8Array(32); offCurve[31] = 5;
  r.check(!S.isValidXonly(offCurve), "off-curve key refused");
  r.check((() => { try { A.validateKey(offCurve, "The new owner"); return false; } catch (e) { return e instanceof A.ActionError && e.code === "invalidKey"; } })(), "validateKey refuses an off-curve owner");
  r.check((() => { try { A.validateKey(me, "Your key"); return true; } catch { return false; } })(), "validateKey takes a real key");
  const salt = S.newSalt();
  r.check(salt instanceof Uint8Array && salt.length === 32 && !salt.every((b) => b === 0), "newSalt: 32 random bytes");

  // MARK: manifest and gate
  r.check(S.KachatNamesService.isEnabled, "testnet gate open under kachat-network-v1=testnet");
  // the bundled testnet manifest is the live testnet-10 registry v5, the migration drill that
  // imported the day-clock v4 registry (iOS fbfa5a6): it verifies, so testnet leaves "Setting up"
  // (registryUpgrading stays false)
  const BUNDLED_REGISTRY = "1283f749506c454488a6b7264197658ed1c12051f1887905c4396243a89fbfa2";
  const bundled = new S.KachatNamesService(fakeEngine());
  let bundledEvents = 0;
  bundled.onChange((x) => { if (x === bundled) bundledEvents += 1; });
  try {
    const bm = await bundled.loadManifest();
    r.eq(bundled.manifestSource, "bundle", "manifest from the bundle");
    r.eq(bm.network, "testnet-10", "bundled manifest network");
    r.check(!bm.isDryRun, "bundled manifest is not a dry run");
    r.eq(C.hex(bm.registryCovenantId), BUNDLED_REGISTRY, "bundled manifest: registry covenant id");
    r.check(bm.priceCovenantId === undefined && bm.genesisShards === undefined, "bundled manifest: no price record (registry v4)");
    r.eq(bm.params.registerPrices.join(","), M.pinnedRegisterPrices.join(","), "bundled manifest: the pinned register table");
    r.eq(bundled.registryUpgrading, false, "bundled v5 manifest: registryUpgrading stays false (no Setting up)");
    r.eq(bundledEvents, 0, "bundled v5 manifest: no registryUpgrading change announced");
    r.check((await bundled.loadManifest()) === bm, "the verified bundled manifest is cached");
    r.check((await bundled.builder()) instanceof B.Builder, "builder() over the bundled manifest");
    r.eq(bm.registryVersion, 5, "bundled manifest: registry v5");
    console.log("bundled manifest: registry v5, verified");
  } catch (e) {
    r.check(false, `the bundled v5 manifest is refused: ${e.code ?? ""} ${e.message}`);
  }
  // the same manifest served by an indexer verifies too: every template is pinned for its registry
  const bundledBytes = readFileSync(join(repo, "engine/kachat-names/kachat-names-testnet-10.json"));
  const realFromIndexer = new S.KachatNamesService(fakeEngine(), { bundledManifest: null });
  realFromIndexer._manifestData = async () => [new Uint8Array(bundledBytes), "https://idx.test/names/manifest"];
  try {
    const im = await realFromIndexer.loadManifest();
    r.eq(C.hex(im.registryCovenantId), BUNDLED_REGISTRY, "indexer-served v4 manifest verifies (every template pinned)");
    r.eq(realFromIndexer.manifestSource, "https://idx.test/names/manifest", "indexer-served manifest source");
  } catch (e) {
    r.check(false, `the indexer-served v4 manifest is refused: ${e.message}`);
  }
  // a synthetic registryVersion 3 copy of the bundled manifest: the outdated path, "Setting up"
  const realV2 = JSON.parse(bundledBytes.toString("utf8"));
  realV2.registryVersion = 3;
  const realV2Svc = new S.KachatNamesService(fakeEngine(), { bundledManifest: realV2 });
  await r.throws(() => realV2Svc.loadManifest(), (e) => e.code === "registryUpgrading" && realV2Svc.registryUpgrading,
    "a registryVersion 3 bundled manifest is registryUpgrading (Setting up)");
  const dry = new S.KachatNamesService(fakeEngine(), { bundledManifest: v.manifest });
  await r.throws(() => dry.loadManifest(), (e) => e.code === "dryRunManifest", "a dry-run manifest is refused");
  const m = await dry.loadManifest({ allowDryRun: true });
  r.check(m.isDryRun, "allowDryRun loads the vectors' manifest");

  // an indexer-served manifest must have every template pinned (the vectors' registry has no
  // deployment pins)
  const fromIndexer = new S.KachatNamesService(fakeEngine(), { bundledManifest: null });
  fromIndexer._manifestData = async () => [new TextEncoder().encode(JSON.stringify(v.manifest)), "https://idx.test/names/manifest"];
  await r.throws(() => fromIndexer.loadManifest({ allowDryRun: true }),
    (e) => e instanceof C.Failure && /not pinned/.test(e.message) && !fromIndexer.registryUpgrading, "an indexer-served manifest with unpinned templates is refused");

  // MARK: an earlier registry's manifest -> registryUpgrading (Swift d2e0673)
  const v1Manifest = structuredClone(v.manifest);
  delete v1Manifest.registryVersion;
  const upgradingSvc = new S.KachatNamesService(fakeEngine(), { bundledManifest: v1Manifest });
  let upgradingEvents = 0;
  upgradingSvc.onChange((x) => { if (x === upgradingSvc) upgradingEvents += 1; });
  r.eq(upgradingSvc.registryUpgrading, false, "registryUpgrading starts false");
  let firstRefusal = null;
  await r.throws(() => upgradingSvc.loadManifest({ allowDryRun: true }), (e) => {
    firstRefusal = e;
    return e instanceof S.ServiceError && e.code === "registryUpgrading" && e.message === S.registryUpgradingMessage;
  }, "a manifest without registryVersion 4 is refused as registryUpgrading");
  r.eq(upgradingSvc.registryUpgrading, true, "registryUpgrading set");
  r.eq(upgradingEvents, 1, "onChange announces registryUpgrading");
  r.check(S.isRegistryUpgrading(firstRefusal) && S.KachatNamesService.isRegistryUpgrading(firstRefusal), "isRegistryUpgrading(ServiceError.registryUpgrading)");
  r.check(S.isRegistryUpgrading(C.Failure.outdatedRegistry()), "isRegistryUpgrading(Failure.outdatedRegistry)");
  r.check(!S.isRegistryUpgrading(new C.Failure("manifest: params missing")) && !S.isRegistryUpgrading(S.ServiceError.dryRunManifest()), "isRegistryUpgrading: other errors are failures");
  // the bundle can't change while the app runs: the refusal is remembered, not re-read
  upgradingSvc.bundledManifest = v.manifest;
  await r.throws(() => upgradingSvc.loadManifest({ allowDryRun: true }), (e) => e === firstRefusal, "the refused bundle is not read again");
  r.eq(upgradingEvents, 1, "registryUpgrading announced once");
  upgradingSvc.resetManifest();
  r.eq(upgradingSvc.registryUpgrading, false, "resetManifest clears registryUpgrading");
  r.check((await upgradingSvc.loadManifest({ allowDryRun: true })).isDryRun && !upgradingSvc.registryUpgrading, "after resetManifest the (new) bundle loads");
  const v2Manifest = structuredClone(v.manifest);
  v2Manifest.registryVersion = 2;
  await r.throws(() => new S.KachatNamesService(fakeEngine(), { bundledManifest: v2Manifest }).loadManifest({ allowDryRun: true }),
    (e) => e.code === "registryUpgrading", "a registryVersion 2 manifest is registryUpgrading");
  const badManifest = structuredClone(v.manifest);
  badManifest.network = "mainnet";
  const badSvc = new S.KachatNamesService(fakeEngine(), { bundledManifest: badManifest });
  await r.throws(() => badSvc.loadManifest({ allowDryRun: true }), (e) => e instanceof C.Failure && !S.isRegistryUpgrading(e), "another manifest failure stays a failure");
  r.eq(badSvc.registryUpgrading, false, "another manifest failure is not registryUpgrading");

  // MARK: environment
  const env0 = await dry.environment({ privateKey: sk, feerate: 50 });
  r.eq(C.hex(env0.me), s(v.deployer.xonly), "environment: me");
  r.eq(env0.feerate, 100, "environment: feerate floor 100");
  r.eq(env0.blockDaa, 590_000_100n, "environment: virtual DAA");
  // the budgets follow the registry version (iOS 6f18475): v4 without a usable manifest (a dry run),
  // the v5 table over the bundled v5 manifest
  r.eq(env0.budgets["gap.register"], B.recommendedBudgets["gap.register"], "environment: v4 budgets without a usable manifest");
  const envV5 = await bundled.environment({ privateKey: sk });
  r.eq(JSON.stringify(envV5.budgets), JSON.stringify(B.recommendedBudgetsV5), "environment: the v5 budgets over the bundled v5 manifest");
  const wrongNet = new S.KachatNamesService(fakeEngine({ dag: { networkId: "mainnet", virtualDaaScore: 1n, pastMedianTime: 1n } }), { bundledManifest: v.manifest });
  await r.throws(() => wrongNet.environment({ privateKey: sk }), (e) => e.code === "wrongNodeNetwork", "environment refuses a mainnet node");

  // MARK: signing every vector plan
  const wasm = await loadWasm();
  const kaspa = wasm.error ? null : wasm;
  if (!kaspa) r.skipped.push(`WASM conversion: the Kaspa WASM did not load in Node (${wasm.error})`);
  const b = new B.Builder(m);
  let signedSteps = 0, wasmSteps = 0;
  const signedByLabel = new Map();
  for (const st of appSteps(v)) {
    const label = s(st.label);
    const exp = st.expected;
    const budgets = { ...B.recommendedBudgets };
    for (const i of exp.inputs) budgets[s(i.role)] = num(i.computeBudget);
    const env = B.makeEnv({ me: hx(st.env.me), blockDaa: u64(st.env.blockDaa), blockTimeMs: u64(st.env.blockTimeMs), wallMs: u64(st.env.wallMs), feerate: Number(st.env.feerate), budgets });
    let plan;
    try { plan = build(b, s(st.op), env, st.wallet.map(utxo), st.args, st.records); } catch (e) { r.check(false, `${label}: build threw ${e.message}`); continue; }
    r.eq(T.txIdHex(plan.unsignedTx), s(exp.txid), `${label}: unsigned txid`);
    const reqs = B.planSigningRequests(plan);
    let signed;
    try { signed = S.sign(plan, { privateKey: sk, me: env.me }); } catch (e) { r.check(false, `${label}: sign threw ${e.stack || e}`); continue; }
    signedSteps += 1;
    signedByLabel.set(label, { plan, signed, env });
    r.eq(T.txIdHex(signed), s(exp.txid), `${label}: signed txid`);
    // BIP-340 with fresh aux randomness: our signature differs from the recorded one, but both verify
    for (const q of reqs) {
      const i = q.inputIndex;
      const ours = sigOf(signed.inputs[i].signatureScript);
      const theirs = sigOf(hx(exp.inputs[i].signatureScript));
      r.check(ours != null && schnorr.verify(ours, q.sighash, me), `${label}: input ${i}: our signature verifies`);
      r.check(theirs != null && schnorr.verify(theirs, q.sighash, me), `${label}: input ${i}: the recorded signature verifies over the port's sighash`);
      r.eq(signed.inputs[i].signatureScript.length, hx(exp.inputs[i].signatureScript).length, `${label}: input ${i}: signature script length`);
      // the script is the recorded one with the signature swapped in
      const recorded = hx(exp.inputs[i].signatureScript);
      const swapped = Uint8Array.from(recorded);
      const at = C.indexOfBytes(recorded, theirs);
      swapped.set(ours, at);
      r.check(C.bytesEqual(swapped, signed.inputs[i].signatureScript), `${label}: input ${i}: signature script = recorded with our signature`);
    }
    // inputs that need no signature keep the recorded script exactly
    plan.inputs.forEach((pi, i) => {
      if (!B.unlockNeedsSignature(pi.unlock)) r.eq(C.hex(signed.inputs[i].signatureScript), s(exp.inputs[i].signatureScript), `${label}: input ${i}: unsigned script`);
    });
    // zero aux randomness is deterministic (BIP-340)
    if (reqs.length) {
      const z = new Uint8Array(32);
      r.eq(C.hex(schnorr.sign(reqs[0].sighash, sk, z)), C.hex(schnorr.sign(reqs[0].sighash, sk, z)), `${label}: zero-aux signature deterministic`);
    }
    // the WASM SDK Transaction
    if (kaspa) {
      try {
        const tx = S.rpcTransaction(kaspa, signed);
        r.eq(String(tx.id), s(exp.txid), `${label}: WASM Transaction id`);
        r.eq(Number(tx.version), 1, `${label}: WASM version`);
        r.eq(BigInt(tx.storageMass), u64(exp.storageMass), `${label}: WASM storage mass`);
        r.eq(BigInt(tx.lockTime), u64(exp.lockTime), `${label}: WASM lock time`);
        r.eq(String(tx.payload), s(exp.payload), `${label}: WASM payload`);
        const ins = tx.inputs;
        ins.forEach((wi, i) => {
          r.eq(Number(wi.computeBudget), num(exp.inputs[i].computeBudget), `${label}: WASM input ${i} compute budget`);
          r.eq(Number(wi.sigOpCount), 0, `${label}: WASM input ${i} sigOpCount`);
          r.eq(BigInt(wi.sequence), u64(exp.inputs[i].sequence), `${label}: WASM input ${i} sequence`);
          r.eq(String(wi.signatureScript), C.hex(signed.inputs[i].signatureScript), `${label}: WASM input ${i} signature script`);
          r.eq(String(wi.previousOutpoint.transactionId), s(exp.inputs[i].txid), `${label}: WASM input ${i} outpoint`);
        });
        tx.outputs.forEach((wo, k) => {
          const eo = exp.outputs[k];
          r.eq(BigInt(wo.value), u64(eo.value), `${label}: WASM output ${k} value`);
          r.eq(String(wo.scriptPublicKey.script), s(eo.script), `${label}: WASM output ${k} script`);
          const cov = wo.covenant;
          if (eo.covenant == null) r.check(cov == null, `${label}: WASM output ${k} has no covenant`);
          else {
            r.eq(Number(cov?.authorizingInput), num(eo.covenant.authorizingInput), `${label}: WASM output ${k} authorizing input`);
            r.eq(String(cov?.covenantId), s(eo.covenant.covenantId), `${label}: WASM output ${k} covenant id`);
          }
        });
        wasmSteps += 1;
      } catch (e) {
        r.check(false, `${label}: WASM conversion threw ${e.stack || e}`);
      }
    }
  }
  const appCount = appSteps(v).length;
  r.eq(signedSteps, appCount, "every vector step the app builds signed");
  if (kaspa) r.eq(wasmSteps, appCount, "every vector step the app builds converted");

  // a plan signed with another key is refused
  const first = signedByLabel.values().next().value;
  const other = deployerKey(); other[31] = 78;
  r.check((() => { try { S.sign(first.plan, { privateKey: other, me: first.env.me }); return false; } catch (e) { return e.code === "keyMismatch"; } })(), "sign refuses another key");

  // MARK: submit through a fake engine
  if (kaspa) {
    const engine = fakeEngine({ kaspa });
    const svc = new S.KachatNamesService(engine, { bundledManifest: v.manifest });
    const txId = await svc.submit(first.signed);
    r.eq(txId, T.txIdHex(first.signed), "submit returns the plan's txid");
    r.eq(engine.submitted.length, 1, "submit hands one WASM Transaction to the engine");
    // IOS-014: a failed submit is looked up by the core's own id before it fails (iOS 9139e88)
    r.eq(engine.submitOpts?.expectedTxId, T.txIdHex(first.signed), "submit passes the locally computed txid for the acceptance lookup");
    const lying = fakeEngine({ kaspa });
    lying.submitRpcTransaction = async () => "00".repeat(32);
    await r.throws(() => new S.KachatNamesService(lying, { bundledManifest: v.manifest }).submit(first.signed), (e) => e.code === "submitMismatch", "submit refuses another txid");
    const viaSign = fakeEngine({ kaspa });
    const id2 = await new S.KachatNamesService(viaSign, { bundledManifest: v.manifest }).signAndSubmit(first.plan, { privateKey: sk, env: first.env });
    r.eq(id2, T.txIdHex(first.plan.unsignedTx), "signAndSubmit returns the txid");
  }

  // MARK: live UTXOs and funding
  const reg = v.steps.find((x) => x.op === "renew");
  if (reg) {
    const n = nameRec(reg.records.name);
    const addr = S.p2shAddress(n.utxo.entry.script);
    r.check(typeof addr === "string" && addr.startsWith("kaspatest:"), "p2shAddress of a name script");
    const engine = fakeEngine({ utxos: [plainOf(n.utxo, addr)] });
    const svc = new S.KachatNamesService(engine, { bundledManifest: v.manifest });
    // the vectors' registry is a dry run, which the service refuses to act on: use it here anyway
    svc.loadManifest = async () => m;
    const live = await svc.liveRegistryUtxo({ script: n.utxo.entry.script, outpoint: n.utxo.outpoint });
    r.check(T.utxoEntryEqual(live.entry, n.utxo.entry), "liveRegistryUtxo reads the name UTXO back");
    const wrongOp = T.makeOutpoint(n.utxo.outpoint.txid, n.utxo.outpoint.index + 1);
    await r.throws(() => svc.liveUtxo({ script: n.utxo.entry.script, outpoint: wrongOp }), (e) => e.code === "notOnChain", "liveUtxo: missing outpoint");
    const noCov = { ...plainOf(n.utxo, addr), covenantId: null };
    const svc2 = new S.KachatNamesService(fakeEngine({ utxos: [noCov] }), { bundledManifest: v.manifest });
    svc2.loadManifest = async () => m;
    await r.throws(() => svc2.liveRegistryUtxo({ script: n.utxo.entry.script, outpoint: n.utxo.outpoint }), (e) => e.code === "notOnChain", "liveRegistryUtxo: no registry covenant id");
    // registry v4: no price shard to read (livePriceUtxo is gone), and no step carries a shard
    r.eq(typeof svc.livePriceUtxo, "undefined", "registry v4: service.livePriceUtxo is gone");
    r.check(v.steps.every((x) => x.records.shard === undefined && x.records.shards === undefined), "registry v4: no vector step carries a price shard");
  }
  const wallet = v.steps[0].wallet.map(utxo);
  const plain = wallet.map((u) => plainOf(u, s(v.deployer.address)));
  const daa = 590_000_100n;
  const withExtras = [
    ...plain,
    { ...plain[0], outpoint: { transactionId: "ab".repeat(32), index: 7 }, covenantId: "cd".repeat(32) },
    { ...plain[0], outpoint: { transactionId: "ab".repeat(32), index: 8 }, isCoinbase: true, blockDaaScore: daa - 10n },
    { ...plain[0], outpoint: { transactionId: "ab".repeat(32), index: 9 }, scriptPublicKey: C.hex(C.p2pkScript(offCurve)) },
  ];
  const funding = S.fundingUtxos(withExtras, { me, virtualDaaScore: daa });
  r.eq(funding.length, plain.length, "fundingUtxos: only own mature P2PK coins without a covenant");
  r.check(funding.every((u, i) => T.utxoEntryEqual(u.entry, wallet[i].entry) && T.outpointEqual(u.outpoint, wallet[i].outpoint)), "fundingUtxos converts to the core shape");
  // IOS-064: a coin a scheduled KaPost will spend never funds a name transaction (iOS 58a0b22)
  {
    const Tx = await import("../engine/transactions.js");
    const held = plain[0].outpoint;
    Tx.setReservedOutpoints([`${held.transactionId}:${held.index}`]);
    try {
      const free = S.fundingUtxos(withExtras, { me, virtualDaaScore: daa });
      r.eq(free.length, plain.length - 1, "fundingUtxos: a scheduled KaPost's coin is left out");
      r.check(!free.some((u) => C.hex(u.outpoint.txid) === held.transactionId && u.outpoint.index === Number(held.index)), "fundingUtxos: never the reserved outpoint");
    } finally {
      Tx.setReservedOutpoints([]);
    }
  }

  // MARK: profile record payload
  const okJson = new RS.Profile({ bio: "hi", links: { x: "@me" } }).recordJSON();
  r.eq(C.fromUtf8(S.profileRecordPayload(okJson)), `kchat:1:profile:${okJson}`, "profile payload");
  r.check((() => { try { S.profileRecordPayload("[1]"); return false; } catch (e) { return e.code === "badProfile"; } })(), "profile: not an object");
  r.check((() => { try { S.profileRecordPayload("{\"v\":2}"); return false; } catch (e) { return e.code === "badProfile"; } })(), "profile: v must be 1");
  r.check((() => { try { S.profileRecordPayload(`{"v":1,"bio":"${"x".repeat(2100)}"}`); return false; } catch (e) { return e.code === "badProfile"; } })(), "profile: over 2 KB");

  // MARK: actions: wallet, operations, registration records
  const mem = new Map();
  const storage = { get: (k) => mem.get(k) ?? null, set: (k, val) => { mem.set(k, val); } };
  const actEngine = { ...fakeEngine(), address: s(v.deployer.address), privateKeyHex: C.hex(sk) };
  const registryStub = {
    prepare: async () => m, refresh: async () => {}, lookup: async (name) => ({ kind: "free", name, gap: null }),
    isAccepted: async () => false, refreshAfter: () => {}, trackOffer: async () => {}, exitGaps: async () => { throw new Error("no gaps"); },
    noteOwnProfile: async () => {}, graceMs: m.params.graceMs,
  };
  const actions = new A.KachatNamesActions({ engine: actEngine, service: dry, registry: registryStub, storage });
  const sg = actions.signer();
  r.eq(C.hex(sg.me), s(v.deployer.xonly), "actions.signer: x-only key");
  r.eq(sg.address, s(v.deployer.address), "actions.signer: address");
  r.eq(C.hex(actions.myKey), s(v.deployer.xonly), "actions.myKey");
  const badEngine = { ...actEngine, privateKeyHex: C.hex(other) };
  r.check((() => { try { new A.KachatNamesActions({ engine: badEngine, service: dry, registry: registryStub, storage }).signer(); return false; } catch (e) { return e.code === "keyMismatch"; } })(), "signer refuses a key that is not the address's");
  r.eq(A.Operation.list({ name: "x" }, 5).price, 5n, "Operation.list price is BigInt");
  r.eq(A.Operation.offer({ name: "alice" }, 10, 20).refundAfterDaa, 20n, "Operation.offer refundAfterDaa");
  r.eq(A.Operation.offer({ name: "alice" }, 10, 20).target.name, "alice", "Operation.offer carries its target");
  r.eq(A.Operation.decline({ id: "x" }).kind, "decline", "Operation.decline");
  let events = 0;
  const unsub = actions.subscribe(() => { events += 1; });
  actions._loadPending(sg.address);
  const rec = {
    id: "r1", name: "alice", years: 1, owner: C.hex(me), commitTxId: "11".repeat(32), commitScript: "aa20" + "22".repeat(32) + "87",
    commitDaa: null, registerTxId: null, cancelTxId: null, stage: A.Stage.taken, createdAt: 1, updatedAt: 1, lastError: null, salt: "33".repeat(32),
  };
  actions._upsert(rec);
  const saved = JSON.parse(mem.get(A.registrationsStorageKey));
  r.eq(saved[sg.address]?.[0]?.salt, "33".repeat(32), "registration stored per wallet with its salt");
  r.check(actions.pending.length === 1 && !("salt" in actions.pending[0]), "pending hides the salt");
  r.check(events >= 2, "subscribe sees changes");
  const reloaded = new A.KachatNamesActions({ engine: actEngine, service: dry, registry: registryStub, storage });
  reloaded.resume();
  r.eq(reloaded.pending[0]?.stage, A.Stage.taken, "resume reloads the wallet's registrations");
  r.check(!A.needsDriving(rec) && A.isOpen(rec), "taken: open, not driven");
  actions.dismiss("r1");
  r.eq(actions.pending.length, 0, "dismiss removes it");
  r.check(!(sg.address in JSON.parse(mem.get(A.registrationsStorageKey))), "an empty wallet list is dropped from storage");
  unsub();
  reloaded.stop();

  // MARK: actions: extend and renew (Swift 5766c00)
  r.eq(A.Operation.extend({ name: "x" }, 1).kind, "extend", "Operation.extend kind");
  r.eq(A.Operation.extend({ name: "x" }, 1).years, 1n, "Operation.extend years is BigInt");
  r.check(/^Renewal opens on .+/.test(A.ActionError.renewalNotOpen(1_822_000_000_000n).message), "renewalNotOpen message");
  r.eq(A.ActionError.periodFull(1_822_000_000_000n).renewalOpensMs, 1_822_000_000_000n, "periodFull carries renewalOpensMs");
  // local time zone, as Swift's DateFormatter: Sep 25 or 26, 2027
  r.check(/^Sep 2[56], 2027$/.test(A.dayString(1_822_000_000_000n, "en-US")), `dayString: ${A.dayString(1_822_000_000_000n, "en-US")}`);
  const nameInfoOf = (n, withPeriod = true) => new RS.NameInfo({
    name: s(n.name), key: hx(n.key), owner: hx(n.owner), price: u64(n.price), expiresAt: u64(n.expiresAt),
    periodStart: withPeriod ? u64(n.periodStart) : null, outpoint: T.makeOutpoint(hx(n.utxo.txid), num(n.utxo.index)),
  });
  /** A record's UTXO as the fake node serves it. */
  const nodeUtxo = (u) => plainOf(u, S.p2shAddress(u.entry.script));
  /** Actions over a fake node holding the step's records (name, offer) and wallet, at the
   *  step's median time. `extra`: more node UTXOs; `registry`: overrides of the registry stub. */
  const actionsAt = (st, pastMedianTime = u64(st.env.blockTimeMs), { extra = [], registry = {}, blockDaa = u64(st.env.blockDaa) } = {}) => {
    const rec = st.records;
    const held = [rec.name && nameRec(rec.name).utxo, rec.offer && offerRec(rec.offer).utxo].filter(Boolean).map(nodeUtxo);
    const coins = st.wallet.map(utxo).map((u) => plainOf(u, s(v.deployer.address)));
    const engine = {
      ...fakeEngine({ utxos: [...held, ...extra, ...coins], dag: { networkId: "testnet-10", virtualDaaScore: blockDaa, pastMedianTime } }),
      address: s(v.deployer.address), privateKeyHex: C.hex(sk),
    };
    const svc = new S.KachatNamesService(engine, { bundledManifest: v.manifest });
    svc.loadManifest = async () => m;
    const act = new A.KachatNamesActions({
      engine, service: svc, registry: { ...registryStub, ...registry }, storage: { get: () => null, set: () => {} },
    });
    act.feerate = async () => 100;
    // a fee speed (iOS e426432) is priced from the network's estimate: fixed here, nothing fetched
    act.feerateForTier = async () => 100;
    return act;
  };
  const extStep = v.steps.find((x) => x.op === "extend");
  const renewStep = v.steps.find((x) => x.op === "renew" && x.label.includes("in-window"));
  if (extStep && renewStep) {
    const ext = nameInfoOf(extStep.records.name);
    const extActions = actionsAt(extStep);
    try {
      const plan = await extActions.plan(A.Operation.extend(ext, 1n));
      r.eq(plan.op, s(extStep.label), "actions: extend plans the vector's operation");
      r.check(plan.unsignedTx.lockTime === 0n && plan.unsignedTx.inputs.every((i) => i.sequence === 0n), "actions: extend lock time 0, sequences 0");
      r.eq(plan.priceFee, M.paramsRenewPrice(m.params, C.utf8(ext.name).length), "actions: extend pays the fixed renewal price (registry v4)");
      r.check(plan.inputs.every((i) => i.role !== "price.use") && plan.outputs.length === 2, "actions: extend spends no price shard (name continuation + change)");
    } catch (e) { r.check(false, `actions: extend threw ${e.stack || e}`); }
    await r.throws(() => extActions.plan(A.Operation.extend(ext, 2n)),
      (e) => e instanceof A.ActionError && e.code === "periodFull" && e.renewalOpensMs === ext.renewOpens(m.params)
        && e.message.startsWith("This name is already paid up to its longest period."), "actions: extend past the 2-period cap is periodFull");
    // registry v4: no shard read, so no registry.shards() call is needed
    r.eq(typeof A.ActionError.priceBusy, "undefined", "registry v4: ActionError.priceBusy is gone");
    await r.throws(() => extActions.plan(A.Operation.extend(ext, 0n)), (e) => e.code === "periodFull", "actions: extend by 0 is refused");
    await r.throws(() => extActions.plan(A.Operation.extend(nameInfoOf(extStep.records.name, false), 1n)),
      (e) => e.code === "periodUnknown", "actions: extend without periodStart is periodUnknown");
    // a name paid a period further out: its window (renewWindowMs - 2 hours on the testnet day
    // clock - before the expiry) is not open yet
    const ext2 = nameInfoOf(extStep.records.name);
    ext2.expiresAt += m.params.periodMs;
    await r.throws(() => extActions.plan(A.Operation.renew(ext2, 1n)),
      (e) => e.code === "renewalNotOpen" && e.opensMs === ext2.renewOpens(m.params) && e.message.startsWith("Renewal opens on "), "actions: renew before the window is renewalNotOpen");
    await r.throws(() => extActions.plan(A.Operation.transfer(nameInfoOf(extStep.records.name, false), me)),
      (e) => e.code === "periodUnknown", "actions: a record without periodStart is never spent");
    const ren = nameInfoOf(renewStep.records.name);
    const renActions = actionsAt(renewStep);
    try {
      const plan = await renActions.plan(A.Operation.renew(ren, 1n));
      r.eq(plan.op, s(renewStep.label), "actions: renew in the window plans the vector's operation");
      r.eq(plan.priceFee, M.paramsRenewPrice(m.params, C.utf8(ren.name).length), "actions: renew pays the fixed renewal price (registry v4)");
      r.check(plan.unsignedTx.lockTime >= ren.renewOpens(m.params) && plan.unsignedTx.lockTime < u64(renewStep.env.blockTimeMs), "actions: renew lock time in the window, below the median time");
    } catch (e) { r.check(false, `actions: renew threw ${e.stack || e}`); }
    // exactly at the opening the median time has not passed it
    await r.throws(() => actionsAt(renewStep, ren.renewOpens(m.params)).plan(A.Operation.renew(ren, 1n)),
      (e) => e.code === "renewalNotOpen", "actions: renew at exactly the opening is refused");
  } else {
    r.check(false, "no extend / in-window renew step in the vectors");
  }

  // MARK: actions: one build, one submit (registry v4: no shard to lose, nothing to retry)
  if (extStep) {
    const ext = nameInfoOf(extStep.records.name);
    const act = actionsAt(extStep);
    act.registry = { ...act.registry, refreshAfter: () => {} };
    let submits = 0;
    act.service.signAndSubmit = async () => { submits += 1; throw new Error("transaction rejected: already spent by another transaction in the mempool"); };
    await r.throws(() => act.perform(A.Operation.extend(ext, 1n)), (e) => /already spent/.test(e.message), "submit: a spend conflict is thrown");
    r.eq(submits, 1, "submit: not retried (registry v4 has no price shard to pick again)");
    r.eq(typeof A.isSpentConflict, "undefined", "registry v4: isSpentConflict is gone");
  }
  // MARK: actions: never pay more than the price the person confirmed (iOS 4f5d95e, IOS-054)
  r.eq(typeof dry.requireLaunched, "function", "IOS-058: service.requireLaunched");
  r.check((() => { try { dry.requireLaunched(); dry.requireTestnet(); return true; } catch { return false; } })(), "IOS-058: requireLaunched (and its old name) pass on testnet");
  if (extStep) {
    const ext = nameInfoOf(extStep.records.name);
    const act = actionsAt(extStep);
    act.registry = { ...act.registry, refreshAfter: () => {} };
    let submits = 0;
    act.service.signAndSubmit = async (plan) => { submits += 1; return T.txIdHex(plan.unsignedTx); };
    try {
      const shown = await act.plan(A.Operation.extend(ext, 1n));
      r.check(shown.priceFee > 0n, "IOS-054: an extend has a price");
      await r.throws(() => act.perform(A.Operation.extend(ext, 1n), { maxPrice: shown.priceFee - 1n }),
        (e) => e instanceof A.ActionError && e.code === "priceChanged" && e.price === shown.priceFee && e.message.startsWith("The price changed to "),
        "IOS-054: an extend that now costs more than confirmed is priceChanged");
      r.eq(submits, 0, "IOS-054: nothing is sent when the price went up");
      await act.perform(A.Operation.extend(ext, 1n), { maxPrice: shown.priceFee });
      r.eq(submits, 1, "IOS-054: the confirmed price is paid");
      await act.perform(A.Operation.extend(ext, 1n), { maxPrice: shown.priceFee + 1n });
      r.eq(submits, 2, "IOS-054: a lower price than confirmed is paid");
      await act.perform(A.Operation.extend(ext, 1n));
      r.eq(submits, 3, "IOS-054: no cap (background actions) still sends");
    } catch (e) { r.check(false, `IOS-054: extend threw ${e.stack || e}`); }

  }

  // MARK: the registration driver registers at the fixed price, never above the confirmed one
  const regStep = v.steps.find((x) => x.op === "register");
  if (regStep) {
    const rc = regStep.records;
    const g0 = gapRec(rc.gap);
    const c0 = commitRec(rc.commit);
    const gapInfo = new RS.GapInfo({ lo: g0.lo, hi: g0.hi, outpoint: g0.utxo.outpoint });
    const freeLookup = async (name) => ({ kind: "free", name, gap: gapInfo });
    const regAt = (lookup = freeLookup) => {
      const act = actionsAt({ ...regStep, records: {} }, undefined, { extra: [nodeUtxo(g0.utxo)], registry: { lookup } });
      act._startDriver = () => {};
      act._loadPending(s(v.deployer.address));
      return act;
    };
    const price = M.paramsRegisterCost(m.params, C.utf8(c0.name).length, u64(regStep.args.years));
    r.eq(price, m.params.registerPrices[C.tier(C.utf8(c0.name).length)], "registry v4: a 1-period registration costs the registration price");
    const recordFor = (id, cap, extra = {}) => ({
      id, name: c0.name, years: Number(regStep.args.years), owner: C.hex(me), commitTxId: C.hex(c0.utxo.outpoint.txid), commitScript: C.hex(c0.utxo.entry.script),
      commitDaa: Number(c0.utxo.entry.blockDaaScore), registerTxId: null, reclaimTxId: null, commitSentAt: Date.now(), commitResends: null, cancelTxId: null,
      stage: A.Stage.waiting, createdAt: Date.now(), updatedAt: Date.now(), lastError: null, salt: C.hex(c0.salt), maxPrice: cap.toString(), ...extra,
    });
    // above the confirmed price: nothing is sent, the registration fails (the person decides)
    const low = regAt();
    let lowSubmits = 0;
    low.service.signAndSubmit = async () => { lowSubmits += 1; return "ee".repeat(32); };
    low._upsert(recordFor("reg-cap", price - 1n));
    await low._register(low._find("reg-cap"), c0.utxo);
    const stopped = low.pending.find((x) => x.id === "reg-cap");
    r.eq(lowSubmits, 0, "IOS-054: nothing is registered above the confirmed price");
    r.eq(stopped.stage, A.Stage.failed, "IOS-054: a registration that would pay more fails (no priceChanged stage in v4)");
    r.check(/^The price changed to /.test(stopped.lastError ?? ""), `IOS-054: and says the price changed (${stopped.lastError})`);
    // at the confirmed price it registers
    const ok = regAt();
    const sent = [];
    ok.service.signAndSubmit = async (plan) => { sent.push(plan); return T.txIdHex(plan.unsignedTx); };
    ok._upsert(recordFor("reg-ok", price));
    await ok._register(ok._find("reg-ok"), c0.utxo);
    const going = ok.pending.find((x) => x.id === "reg-ok");
    r.eq(going.stage, A.Stage.registering, () => `the registration is sent at the confirmed price (${going.lastError})`);
    r.eq(sent.length, 1, "one register transaction");
    r.eq(sent[0]?.priceFee, price, "register pays registerCost (registry v4)");
    r.check(sent[0]?.inputs.length >= 2 && sent[0].inputs[0].role === "gap.register" && sent[0].inputs[1].role === "commit" && sent[0].inputs.every((x) => x.role !== "price.use"),
      "register spends [gap, commit, funding] - no price shard");
    r.eq(going.registerTxId, sent[0] && T.txIdHex(sent[0].unsignedTx), "the record keeps the register txid");
    r.eq(typeof A.Stage.priceChanged, "undefined", "registry v4: Stage.priceChanged is gone");
    r.eq(typeof ok.acceptNewPrice, "undefined", "registry v4: acceptNewPrice is gone");

    // MARK: claiming an expired name frees it first (iOS eea52b2, 4f0bd33)
    const lapsedInfo = new RS.NameInfo({
      name: c0.name, key: C.key(c0.name), owner: S.xonlyKey(other), price: 0n,
      expiresAt: BigInt(Date.now()) - m.params.graceMs - 60_000n, periodStart: BigInt(Date.now()) - m.params.graceMs - 60_000n - m.params.periodMs,
      outpoint: T.makeOutpoint(new Uint8Array(32).fill(0x58), 2),
    });
    // the reclaim's output 0 is the freed gap: the two gaps around the name, merged (iOS beb9c45)
    const reclaimTx = "5c".repeat(32);
    const nameKey = C.key(c0.name);
    const exitGaps = async () => ({
      below: new RS.GapInfo({ lo: g0.lo, hi: nameKey, outpoint: T.makeOutpoint(new Uint8Array(32).fill(0x61), 0) }),
      above: new RS.GapInfo({ lo: nameKey, hi: g0.hi, outpoint: T.makeOutpoint(new Uint8Array(32).fill(0x62), 0) }),
    });
    const freedUtxo = { ...g0.utxo, outpoint: T.makeOutpoint(C.unhex32(reclaimTx), 0) };
    let refreshes = 0;
    const lapsedLookup = async (name) => ({ kind: "registered", name, info: lapsedInfo });
    const claimAt = (live) => {
      const act = actionsAt({ ...regStep, records: {} }, undefined, {
        extra: live ? [nodeUtxo(freedUtxo)] : [],
        registry: { lookup: lapsedLookup, exitGaps, refresh: async () => { refreshes += 1; } },
      });
      act._startDriver = () => {};
      act._loadPending(s(v.deployer.address));
      return act;
    };
    const claim = claimAt(false);
    const performed = [];
    claim.perform = async (op) => { performed.push(op); return reclaimTx; };
    let claimSubmits = 0;
    claim.service.signAndSubmit = async () => { claimSubmits += 1; return "ee".repeat(32); };
    claim._upsert(recordFor("claim", price));
    await claim._register(claim._find("claim"), c0.utxo);
    let cr = claim.pending.find((x) => x.id === "claim");
    r.eq(performed.map((o) => `${o.kind}:${o.name?.name}`).join(","), `reclaim:${c0.name}`, "claim: the driver sends the reclaim of the expired record itself");
    r.eq(cr.reclaimTxId, reclaimTx, "claim: the record keeps the reclaim txid");
    r.eq(`${cr.reclaimLo}-${cr.reclaimHi}`, `${C.hex(g0.lo)}-${C.hex(g0.hi)}`, "claim: the record keeps the gap the reclaim reopens (iOS beb9c45)");
    r.eq(cr.lastError, `Freeing ${c0.name}.kachat for you...`, "claim: the card says the name is being freed");
    r.eq(cr.stage, A.Stage.waiting, "claim: still waiting (registers once the freed gap is on a node)");
    r.eq(claimSubmits, 0, "claim: nothing registered before the old record is gone");
    r.eq(A.freedGap(cr)?.outpoint.index, 0, "freedGap: the reclaim's output 0");
    r.check(A.freedGap(cr) && C.bytesEqual(A.freedGap(cr).outpoint.txid, C.unhex32(reclaimTx)) && A.freedGap(cr).contains(nameKey), "freedGap: at the reclaim txid, holding the name");
    r.eq(A.freedGap({ ...cr, reclaimLo: null }), null, "freedGap: null without the noted bounds (a record from before iOS beb9c45)");
    // the freed gap not on a node yet, sent just now: wait (the retry measures from when it was sent - iOS 4f0bd33)
    await claim._register(claim._find("claim"), c0.utxo);
    cr = claim.pending.find((x) => x.id === "claim");
    r.eq(performed.length, 1, "claim: no second reclaim while the first one is young");
    r.eq(cr.reclaimTxId, reclaimTx, "claim: the reclaim txid kept while it is young");
    // never accepted after two minutes: dropped, so the next tick sends it again
    claim._pending = claim._pending.map((x) => (x.id === "claim" ? { ...x, updatedAt: Date.now() - 121_000 } : x));
    await claim._register(claim._find("claim"), c0.utxo);
    cr = claim.pending.find((x) => x.id === "claim");
    r.check(cr.reclaimTxId === null && cr.reclaimLo === null && cr.reclaimHi === null, "claim: a reclaim not accepted after two minutes is dropped");
    await claim._register(claim._find("claim"), c0.utxo);
    r.eq(performed.length, 2, "claim: and sent again on the next tick");
    // a node has the freed gap: it registers into it at once, while the registry still shows the
    // old record (no wait for a chain walk or the indexer; iOS beb9c45)
    const claimLive = claimAt(true);
    claimLive.perform = async (op) => { performed.push(op); return reclaimTx; };
    const liveSent = [];
    claimLive.service.signAndSubmit = async (plan) => { liveSent.push(plan); return T.txIdHex(plan.unsignedTx); };
    claimLive._upsert({ ...claim._find("claim") });
    await claimLive._register(claimLive._find("claim"), c0.utxo);
    cr = claimLive.pending.find((x) => x.id === "claim");
    r.check(cr.stage === A.Stage.registering && liveSent.length === 1 && cr.lastError == null, `claim: registers into the freed gap as soon as a node has it (${cr.stage}, ${cr.lastError})`);
    r.check(liveSent[0] && liveSent[0].inputs[0].role === "gap.register" && C.bytesEqual(liveSent[0].unsignedTx.inputs[0].previousOutpoint?.txid ?? liveSent[0].inputs[0].utxo?.outpoint?.txid ?? new Uint8Array(), C.unhex32(reclaimTx)),
      "claim: the register spends the reclaim's output 0");
    r.eq(performed.length, 2, "claim: no reclaim sent again once the gap is there");
    // the registry caught up first (it shows the gap): it registers there
    const caught = regAt();
    let caughtSubmits = 0;
    caught.service.signAndSubmit = async (plan) => { caughtSubmits += 1; return T.txIdHex(plan.unsignedTx); };
    caught._upsert({ ...claim._find("claim"), id: "claim-caught" });
    await caught._register(caught._find("claim-caught"), c0.utxo);
    cr = caught.pending.find((x) => x.id === "claim-caught");
    r.check(cr.stage === A.Stage.registering && caughtSubmits === 1 && cr.lastError == null, `claim: once the registry shows the gap the name registers (${cr.stage}, ${cr.lastError})`);
    // a name held by its owner (not lapsed) is taken; our own is registered
    const taken = regAt(async (name) => ({ kind: "registered", name, info: new RS.NameInfo({ ...lapsedInfo, outpoint: lapsedInfo.outpoint, expiresAt: BigInt(Date.now()) + 600_000n }) }));
    taken._upsert(recordFor("taken", price));
    await taken._register(taken._find("taken"), c0.utxo);
    r.eq(taken.pending.find((x) => x.id === "taken").stage, A.Stage.taken, "claim: an active name of someone else is taken");

    // MARK: startRegistration: claims side by side, an expired name can be claimed (iOS b219bb0, eea52b2)
    const starter = regAt();
    starter._upsert(recordFor("open-one", price));
    let commits = 0;
    starter.service.signAndSubmit = async (plan) => { commits += 1; return T.txIdHex(plan.unsignedTx); };
    try {
      const txId = await starter.startRegistration({ name: "second-claim", years: 1, maxPrice: price });
      r.check(/^[0-9a-f]{64}$/.test(txId) && commits === 1, "startRegistration: a second claim starts while one is open");
      const second = starter.pending.find((x) => x.name === "second-claim");
      r.check(second && second.stage === A.Stage.waiting && typeof second.commitSentAt === "number" && second.reclaimTxId === null && second.commitResends === null,
        "startRegistration: the record carries commitSentAt, reclaimTxId and commitResends");
      r.eq(starter.openRegistrations.length, 2, "openRegistrations lists both claims");
    } catch (e) { r.check(false, `startRegistration (second claim) threw ${e.stack || e}`); }
    const lapsedStarter = claimAt(false);
    lapsedStarter.service.signAndSubmit = async (plan) => T.txIdHex(plan.unsignedTx);
    const startPerformed = [];
    lapsedStarter.perform = async (op) => { startPerformed.push(op); return reclaimTx; };
    try {
      await lapsedStarter.startRegistration({ name: c0.name, years: 1, maxPrice: price });
      const started = lapsedStarter.pending.find((x) => x.name === c0.name);
      r.check(started != null, "startRegistration: an expired name (past grace) can be claimed");
      r.eq(startPerformed.map((o) => o.kind).join(","), "reclaim", "startRegistration: the reclaim goes out right after the commit, while it ages (iOS beb9c45)");
      r.check(started?.reclaimTxId === reclaimTx && started?.reclaimLo === C.hex(g0.lo) && started?.reclaimHi === C.hex(g0.hi) && started?.stage === A.Stage.waiting,
        "startRegistration: the record notes the reclaim and the gap it reopens");
    } catch (e) { r.check(false, `startRegistration of an expired name threw ${e.stack || e}`); }
    // a reclaim that can't go out at the start doesn't stop the claim: the driver sends it
    const failingStarter = claimAt(false);
    failingStarter.service.signAndSubmit = async (plan) => T.txIdHex(plan.unsignedTx);
    failingStarter.perform = async () => { throw new Error("node busy"); };
    try {
      await failingStarter.startRegistration({ name: c0.name, years: 1, maxPrice: price });
      const started = failingStarter.pending.find((x) => x.name === c0.name);
      r.check(started?.stage === A.Stage.waiting && started.reclaimTxId === null, "startRegistration: a failed early reclaim leaves the claim waiting, reclaim to the driver");
    } catch (e) { r.check(false, `startRegistration with a failing reclaim threw ${e.stack || e}`); }

    // MARK: the claim receipt shows as soon as the registration is in a block (iOS d65fd1a), node
    // only (iOS e426432): no node holds the register in its mempool and the commit is gone from the
    // UTXO set; a node error is never read as "spent". The registry then catches up (iOS 32260ae).
    {
      const landAt = ({ commitLive = false, inPool = false, nodeDown = false } = {}) => {
        const act = actionsAt({ ...regStep, records: {} }, undefined, { extra: [nodeUtxo(g0.utxo), ...(commitLive ? [nodeUtxo(c0.utxo)] : [])] });
        act._startDriver = () => {};
        act._loadPending(s(v.deployer.address));
        const catchUps = [];
        act.registry = {
          ...act.registry,
          // the REST API would say "accepted": never asked any more for a registration
          isAccepted: async () => true,
          refreshUntilIncludes: async (txId, daa) => { catchUps.push([txId, daa]); return true; },
        };
        act.engine.getMempoolEntry = async () => (inPool ? { transaction: {} } : null);
        if (nodeDown) act.engine.getUtxosWithCovenants = async () => { throw new Error("node unreachable"); };
        act._upsert(recordFor("land", price, { stage: A.Stage.registering, registerTxId: "ab".repeat(32) }));
        return { act, catchUps };
      };
      const pooled = landAt({ inPool: true });
      await pooled.act._advance(pooled.act._find("land"));
      r.eq(pooled.act._find("land").stage, A.Stage.registering, "registering (node only): still in a mempool -> not registered yet (REST's yes is not asked)");
      const live = landAt({ commitLive: true });
      await live.act._advance(live.act._find("land"));
      r.eq(live.act._find("land").stage, A.Stage.registering, "registering (node only): the commit still in the UTXO set -> not registered yet");
      const down = landAt({ nodeDown: true });
      r.eq(await down.act._commitSpent(down.act._find("land")), null, "commitSpent: a node error is unknown (null), never spent");
      await down.act._advance(down.act._find("land"));
      r.eq(down.act._find("land").stage, A.Stage.registering, "registering (node only): a node error is never read as spent");
      const landed = landAt();
      r.eq(await landed.act._commitSpent(landed.act._find("land")), true, "commitSpent: gone from the node's UTXO set -> true");
      r.eq(await live.act._commitSpent(live.act._find("land")), false, "commitSpent: still in the UTXO set -> false");
      await landed.act._advance(landed.act._find("land"));
      r.eq(landed.act._find("land").stage, A.Stage.registered, "registering (node only): out of every mempool and the commit spent -> registered, without waiting for the registry");
      await new Promise((res) => setTimeout(res, 0));
      r.eq(JSON.stringify(landed.catchUps.map(([t, d]) => [t, String(d)])), JSON.stringify([["ab".repeat(32), String(u64(regStep.env.blockDaa))]]),
        "registering: the registry refreshes in the background until it includes the register (at the virtual DAA score)");
    }
    // MARK: a claim's fee speed (iOS e426432): quoted and committed at it, kept on the record, and
    // the register, a resent commit and the reclaim pay it too; claims from before keep the priority rate
    {
      const tiered = regAt();
      const tierCalls = [];
      let priorityCalls = 0;
      tiered.feerateForTier = async (t) => { tierCalls.push(t); return { normal: 100, fast: 200, priority: 500 }[t]; };
      tiered.feerate = async () => { priorityCalls += 1; return 300; };
      const commits = [];
      tiered.service.signAndSubmit = async (plan, { env }) => { commits.push({ plan, rate: env.feerate }); return T.txIdHex(plan.unsignedTx); };
      try {
        const q = await tiered.quote({ name: "fastname", years: 1, gap: gapInfo, feeTier: A.FeeTier.fast });
        r.eq(tierCalls.join(","), "fast", "quote: priced at the chosen speed");
        const slowQ = await tiered.quote({ name: "fastname", years: 1, gap: gapInfo, feeTier: "normal" });
        r.check(q.networkFee > slowQ.networkFee, `quote: Fast costs more network fee than Normal (${q.networkFee} > ${slowQ.networkFee})`);
        tierCalls.length = 0;
        await tiered.startRegistration({ name: "fastname", years: 1, maxPrice: price, feeTier: "Fast" });
        const started = tiered.pending.find((x) => x.name === "fastname");
        r.eq(started?.feeTier, "fast", "startRegistration: the record keeps feeTier (any case read, stored lowercase)");
        r.eq(commits[0]?.rate, 200, "startRegistration: the commit is sent at the chosen speed's rate");
        r.eq(tierCalls.join(","), "fast", "startRegistration: priced through feerateForTier");
        r.eq(await tiered._registrationFeerate({ feeTier: "priority" }), 500, "registrationFeerate: a claim's speed, at the network's rate now");
        r.eq(await tiered._registrationFeerate({ feeTier: null }), 300, "registrationFeerate: a claim from before (no feeTier) keeps the priority rate");
        r.eq(await tiered._registrationFeerate({}), 300, "registrationFeerate: no field at all -> the priority rate");
        // the register is sent at the claim's speed
        const regSent = regAt();
        regSent.feerateForTier = async (t) => ({ normal: 100, fast: 200, priority: 500 }[t]);
        regSent.feerate = async () => 300;
        const regRates = [];
        regSent.service.signAndSubmit = async (plan, { env }) => { regRates.push(env.feerate); return T.txIdHex(plan.unsignedTx); };
        regSent._upsert(recordFor("tier-reg", price, { feeTier: "priority" }));
        await regSent._register(regSent._find("tier-reg"), c0.utxo);
        regSent._upsert(recordFor("old-reg", price));
        await regSent._register(regSent._find("old-reg"), c0.utxo);
        r.eq(regRates.join(","), "500,300", "register: at the claim's speed (Priority 5x), a claim from before at the priority rate");
        // the reclaim of an expired name goes out at the claim's speed
        const rc = claimAt(false);
        const reclaimOpts = [];
        rc.perform = async (op, opts) => { reclaimOpts.push(opts ?? null); return reclaimTx; };
        await rc._sendReclaim(lapsedInfo, { ...recordFor("rc", price), feeTier: "fast" });
        await rc._sendReclaim(lapsedInfo, recordFor("rc2", price));
        r.eq(JSON.stringify(reclaimOpts.map((o) => o?.fee ?? null)), JSON.stringify([{ kind: "tier", tier: "fast" }, null]), "reclaim: at the claim's speed; a claim from before keeps the default");
      } catch (e) { r.check(false, `claim fee speed threw ${e.stack || e}`); }
    }

    const activeStarter = regAt(async (name) => ({ kind: "registered", name, info: new RS.NameInfo({ ...lapsedInfo, outpoint: lapsedInfo.outpoint, expiresAt: BigInt(Date.now()) - 1_000n }) }));
    await r.throws(() => activeStarter.startRegistration({ name: c0.name, years: 1, maxPrice: price }),
      (e) => e.code === "notRegisterable" && e.message === `${c0.name}.kachat is already registered.`, "startRegistration: a name in grace is still its owner's");
    await r.throws(() => regAt().startRegistration({ name: "pricecap", years: 1 }), (e) => /maxPrice/.test(e.message), "IOS-054: startRegistration needs the confirmed price");

    // MARK: a commit a busy network dropped is sent again (iOS b219bb0)
    const commitStep = v.steps.find((x) => x.op === "commit");
    const cAct = actionsAt(commitStep);
    cAct._startDriver = () => {};
    cAct._loadPending(s(v.deployer.address));
    const cSalt = hx(commitStep.args.salt);
    const cName = s(commitStep.args.name);
    const cScript = C.hex(C.p2shScript(C.commitRedeem(C.commitment(cName, me, cSalt), me)));
    const pendingCommit = (id, extra) => ({
      id, name: cName, years: 1, owner: C.hex(me), commitTxId: "cc".repeat(32), commitScript: cScript, commitDaa: null, registerTxId: null,
      reclaimTxId: null, commitSentAt: Date.now(), commitResends: null, cancelTxId: null, stage: A.Stage.waiting, createdAt: Date.now(),
      updatedAt: Date.now(), lastError: null, salt: C.hex(cSalt), maxPrice: "1", ...extra,
    });
    let inPool = false;
    cAct.engine.getMempoolEntry = async () => (inPool ? { transaction: {} } : null);
    let resends = 0;
    const realResend = cAct._resendCommit.bind(cAct);
    cAct._resendCommit = async () => { resends += 1; };
    cAct._upsert(pendingCommit("fresh", {}));
    r.eq(await cAct._commitStillPending(cAct._find("fresh")), true, "commit: just sent - wait");
    r.eq(resends, 0, "commit: no resend in the first 30 s");
    inPool = true;
    cAct._upsert(pendingCommit("pool", { commitSentAt: Date.now() - 40_000 }));
    r.eq(await cAct._commitStillPending(cAct._find("pool")), true, "commit: still in the mempool - wait");
    r.eq(cAct._find("pool").lastError, null, "commit: no note in the first minute");
    cAct._upsert(pendingCommit("busy", { commitSentAt: Date.now() - 70_000 }));
    await cAct._commitStillPending(cAct._find("busy"));
    r.eq(cAct._find("busy").lastError, "The network is busy. Your commit is waiting for a block.", "commit: after a minute in the mempool the card says the network is busy");
    inPool = false;
    cAct._upsert(pendingCommit("dropped", { commitSentAt: Date.now() - 40_000 }));
    r.eq(await cAct._commitStillPending(cAct._find("dropped")), true, "commit: dropped from the mempool - still pending");
    r.eq(resends, 1, "commit: dropped -> sent again");
    cAct._upsert(pendingCommit("gaveup", { commitSentAt: Date.now() - 40_000, commitResends: 3 }));
    r.eq(await cAct._commitStillPending(cAct._find("gaveup")), false, "commit: after 3 resends it is past saving");
    r.eq(resends, 1, "commit: no fourth resend");
    // the driver fails it then (Try Again)
    cAct._liveCommit = async () => null;
    cAct._ownsName = async () => false;
    await cAct._advance(cAct._find("gaveup"));
    r.check(cAct._find("gaveup").stage === A.Stage.failed && cAct._find("gaveup").lastError === "The commit never reached the chain.", "commit: a commit past saving fails the claim");
    await cAct._advance(cAct._find("fresh"));
    r.eq(cAct._find("fresh").stage, A.Stage.waiting, "commit: a young commit keeps waiting in the driver");
    // the resend itself: same salt, same script, the new txid and a count
    cAct._resendCommit = realResend;
    const resent = [];
    cAct.service.signAndSubmit = async (plan) => { resent.push(plan); return T.txIdHex(plan.unsignedTx); };
    cAct._upsert(pendingCommit("resend", { commitSentAt: Date.now() - 40_000 }));
    await cAct._resendCommit(cAct._find("resend"));
    const rs = cAct._find("resend");
    r.check(resent.length === 1 && C.hex(resent[0].newCommit.utxo.entry.script) === cScript, "resend: the same commit script (same salt)");
    r.check(rs.commitTxId === T.txIdHex(resent[0].unsignedTx) && rs.commitResends === 1 && Date.now() - rs.commitSentAt < 5_000,
      "resend: the record takes the new txid, the count and the time");
    r.eq(rs.lastError, "The network is busy, so the commit was sent again.", "resend: the card says it was sent again");
    cAct._upsert(pendingCommit("mismatch", { commitScript: "aa20" + "00".repeat(32) + "87" }));
    await cAct._resendCommit(cAct._find("mismatch"));
    const mm = cAct._find("mismatch");
    r.check(mm.commitResends === 1 && mm.lastError === "commit: a different script" && resent.length === 1, "resend: a different script is never sent (counted as a try)");
    // the mempool lookup goes through the engine (getMempoolEntry) or its withRpc
    const viaRpc = new A.KachatNamesActions({ engine: { withRpc: async (f) => f({ getMempoolEntry: async ({ transactionId }) => (transactionId === "ab".repeat(32) ? { mempoolEntry: {} } : null) }) }, service: dry, registry: registryStub, storage });
    r.eq(await viaRpc._inMempool("ab".repeat(32)), true, "inMempool: through withRpc");
    r.eq(await viaRpc._inMempool("cd".repeat(32)), false, "inMempool: not there");
    r.eq(await viaRpc._inMempool("not-a-txid"), false, "inMempool: a malformed id is never asked");
  }

  // MARK: the fee rate (iOS b219bb0): read twice, else 10x the floor
  {
    r.eq(A.unknownFeerate, 1000, "unknownFeerate = 10 x the 100 sompi/gram floor");
    const realFetch = globalThis.fetch;
    const act = new A.KachatNamesActions({ engine: actEngine, service: dry, registry: registryStub, storage });
    let calls = 0;
    try {
      globalThis.fetch = async () => { calls += 1; throw new Error("offline"); };
      r.eq(await act.feerate(), 1000, "feerate: unreadable -> unknownFeerate");
      r.eq(calls, 2, "feerate: read twice before falling back");
      calls = 0;
      globalThis.fetch = async () => { calls += 1; return calls === 1 ? { status: 503, json: async () => ({}) } : { status: 200, json: async () => ({ priorityBucket: { feerate: 250.5 } }) }; };
      r.eq(await act.feerate(), 250.5, "feerate: the second read answers");
      globalThis.fetch = async () => ({ status: 200, json: async () => ({ priorityBucket: { feerate: 12 } }) });
      r.eq(await act.feerate(), 100, "feerate: never below the floor");
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  // MARK: the claim progress sheet comes back once per launch; claims list (iOS b219bb0)
  {
    const mem3 = new Map();
    const st3 = { get: (k) => mem3.get(k) ?? null, set: (k, val) => mem3.set(k, val) };
    const addr = s(v.deployer.address);
    const now = Date.now();
    const base = { years: 1, owner: C.hex(me), commitTxId: "11".repeat(32), commitScript: "", commitDaa: null, registerTxId: null, cancelTxId: null, createdAt: now, updatedAt: now, lastError: null, salt: "33".repeat(32), maxPrice: "1" };
    mem3.set(A.registrationsStorageKey, JSON.stringify({ [addr]: [
      { ...base, id: "done", name: "done", stage: A.Stage.registered },
      { ...base, id: "run", name: "run", stage: A.Stage.waiting },
      { ...base, id: "gone", name: "gone", stage: A.Stage.cancelled },
      // a record from before registry v4, stopped at the old price-changed stage
      { ...base, id: "old", name: "old", stage: "priceChanged", priceChangedTo: "5" },
    ] }));
    const act = new A.KachatNamesActions({ engine: actEngine, service: dry, registry: registryStub, storage: st3 });
    act._startDriver = () => {};
    const snaps = [];
    act.subscribe((x) => snaps.push(x.autoPresentedRegistration));
    act.resume();
    r.eq(act.autoPresentedRegistration, "run", "resume: a claim in progress brings its sheet up");
    r.check(snaps.includes("run"), "resume: subscribers see autoPresentedRegistration");
    r.eq(act.openRegistrations.map((x) => x.id).join(","), "done,run,old", "openRegistrations: every one not cancelled");
    const old = act.pending.find((x) => x.id === "old");
    r.check(old.stage === A.Stage.failed && !("priceChangedTo" in old), "a stored priceChanged record loads as failed (registry v4)");
    act.clearAutoPresented();
    r.eq(act.autoPresentedRegistration, null, "clearAutoPresented: the sheet went down, the claim keeps running");
    act.resume();
    r.eq(act.autoPresentedRegistration, null, "resume again: only once per launch");
  }

  // MARK: actions: no offers on expired names, no renewals that stay expired (iOS 71128c4, IOS-055/056)
  if (renewStep) {
    const base = nameInfoOf(renewStep.records.name);
    const act = actionsAt(renewStep);
    const at = (expiresAt) => new RS.NameInfo({ ...base, outpoint: base.outpoint, expiresAt });
    const longAgo = at(BigInt(Date.now()) - 3n * m.params.periodMs);
    await r.throws(() => act.plan(A.Operation.renew(longAgo, 1n)), (e) => e.code === "expiredTooLong" && e.message.includes("reclaimed and registered again"),
      "IOS-056: a renewal that would still end in the past is refused");
    await r.throws(() => act.plan(A.Operation.renew(at(BigInt(Date.now()) - m.params.periodMs / 2n), 1n)), (e) => e.code !== "expiredTooLong",
      "IOS-056: a renewal that ends in the future is not refused as too late");
  }

  // MARK: actions: offers to the owner, accept, decline (registry v3)
  const offerStep = v.steps.find((x) => x.op === "offer");
  if (offerStep) {
    const t = offerStep.records.target;
    // the vectors make offers on the deployer's own names, which the app refuses
    const own = nameInfoOf(t);
    const act = actionsAt({ ...offerStep, records: { name: t } });
    await r.throws(() => act.plan(A.Operation.offer(own, u64(offerStep.args.amount), u64(offerStep.args.refundAfter))),
      (e) => e.code === "ownOffer", "actions: an offer on your own name is refused");
    // someone else's name: a synthetic record on the fake node
    const otherOwner = S.xonlyKey(other);
    const nf = C.nameFieldsFor(s(t.name), otherOwner, 0n, u64(t.periodStart), u64(t.expiresAt));
    const theirsUtxo = T.makeUtxo(T.makeOutpoint(new Uint8Array(32).fill(0x55), 0), T.makeUtxoEntry({
      amount: m.params.bond, script: M.templateScript(m.name, C.nameState(nf)), blockDaaScore: 1n, covenantId: m.registryCovenantId,
    }));
    const theirs = new RS.NameInfo({ name: s(t.name), key: nf.key, owner: otherOwner, price: 0n, expiresAt: nf.expiresAt, periodStart: nf.periodStart, outpoint: theirsUtxo.outpoint });
    const act2 = actionsAt({ ...offerStep, records: {} }, undefined, { extra: [nodeUtxo(theirsUtxo)] });
    const daa = u64(offerStep.env.blockDaa);
    const week = A.maxOfferDays * 86_400n * A.daaPerSecond;
    try {
      const plan = await act2.plan(A.Operation.offer(theirs, u64(offerStep.args.amount), daa + week));
      r.check(C.bytesEqual(plan.newOffer.fields.seller, otherOwner), "actions: the offer is made to the name's current owner");
      r.check(C.fromUtf8(plan.unsignedTx.payload).endsWith(`:${C.hex(otherOwner)}:${daa + week}`), "actions: the offer marker carries the seller");
    } catch (e) { r.check(false, `actions: offer threw ${e.stack || e}`); }
    await r.throws(() => act2.plan(A.Operation.offer(theirs, u64(offerStep.args.amount), daa + week + 1n)), (e) => e.code === "offerTooLong", "actions: an offer past 7 days is refused");
    await r.throws(() => act2.plan(A.Operation.offer(theirs, u64(offerStep.args.amount), daa)), (e) => e.code === "offerTooLong", "actions: an offer that is refundable at once is refused");
  }
  const acceptStep = v.steps.find((x) => x.op === "acceptOffer" && x.label.includes("wanted"));
  if (acceptStep) {
    const n = nameInfoOf(acceptStep.records.name);
    const o0 = acceptStep.records.offer;
    const offer = new RS.OfferInfo({
      outpoint: T.makeOutpoint(hx(o0.utxo.txid), num(o0.utxo.index)), key: hx(o0.key), name: o0.name ?? n.name,
      buyer: hx(o0.buyer), seller: hx(o0.seller), amount: u64(o0.value), refundAfter: u64(o0.refundAfter),
    });
    try {
      const plan = await actionsAt(acceptStep).plan(A.Operation.accept(offer, n));
      r.eq(plan.op, s(acceptStep.label), "actions: accept plans the vector's operation");
    } catch (e) { r.check(false, `actions: accept threw ${e.stack || e}`); }
    await r.throws(() => actionsAt(acceptStep, undefined, { blockDaa: u64(o0.refundAfter) + 1n }).plan(A.Operation.accept(offer, n)),
      (e) => e.code === "offerExpired", "actions: accept refuses an expired offer");
    const declined = new RS.OfferInfo({ ...offer, outpoint: offer.outpoint, seller: new Uint8Array(32).fill(4) });
    await r.throws(() => actionsAt(acceptStep).plan(A.Operation.accept(declined, n)), (e) => e.code === "offerDeclined", "actions: accept refuses an offer made to an earlier owner");
  }
  const declineStep = v.steps.find((x) => x.op === "declineOffer" && x.label.includes("6.0"));
  if (declineStep) {
    const o0 = declineStep.records.offer;
    const offer = new RS.OfferInfo({
      outpoint: T.makeOutpoint(hx(o0.utxo.txid), num(o0.utxo.index)), key: hx(o0.key), name: o0.name ?? null,
      buyer: hx(o0.buyer), seller: hx(o0.seller), amount: u64(o0.value), refundAfter: u64(o0.refundAfter),
    });
    try {
      const plan = await actionsAt(declineStep).plan(A.Operation.decline(offer));
      r.eq(plan.op, s(declineStep.label), "actions: decline plans the vector's operation");
      r.eq(C.hex(plan.unsignedTx.txid ?? plan.txid), s(declineStep.expected.txid), "actions: decline is the vector's transaction");
    } catch (e) { r.check(false, `actions: decline threw ${e.stack || e}`); }
    // the seller signs a decline: a spending address that holds the offer's seller key
    const spend = { spendingAddresses: () => [{ index: 3, address: RS.addressOf(hx(o0.seller)) }], spendingPrivateKey: () => C.hex(sk) };
    const wa = new A.KachatNamesActions({ engine: { ...actEngine, address: RS.addressOf(S.xonlyKey(other)), privateKeyHex: C.hex(other) }, service: dry, registry: registryStub, storage, wallet: spend });
    r.eq(wa.payerFor(A.Operation.decline(offer))?.index, 3, "payerFor(decline): the spending address that holds the seller key");
    r.check(C.bytesEqual(wa.signerFor(A.Operation.decline(offer)).me, hx(o0.seller)), "signerFor(decline): signs with the seller key");
    r.eq(A.KachatNamesActions.heldBy(A.Operation.withdraw(offer)), null, "heldBy(withdraw): the chatting address");
  }

  // MARK: actions: no offers on, or accepts of, expired names (iOS 71128c4, IOS-055)
  if (offerStep) {
    const t = offerStep.records.target;
    const otherOwner = S.xonlyKey(other);
    const act = actionsAt({ ...offerStep, records: {} });
    const daa = u64(offerStep.env.blockDaa);
    const mk = (expiresAt) => new RS.NameInfo({ name: s(t.name), key: hx(t.key), owner: otherOwner, price: 0n, expiresAt, periodStart: expiresAt - m.params.periodMs, outpoint: T.makeOutpoint(new Uint8Array(32).fill(0x56), 0) });
    for (const [label, when] of [["in grace", BigInt(Date.now()) - 1_000n], ["lapsed", BigInt(Date.now()) - m.params.graceMs - 1_000n]]) {
      await r.throws(() => act.plan(A.Operation.offer(mk(when), u64(offerStep.args.amount), daa + 1_000n)),
        (e) => e.code === "offerNameNotActive", `IOS-055: an offer on a name ${label} is refused`);
    }
  }
  if (acceptStep) {
    const n = nameInfoOf(acceptStep.records.name);
    const o0 = acceptStep.records.offer;
    const offer = new RS.OfferInfo({
      outpoint: T.makeOutpoint(hx(o0.utxo.txid), num(o0.utxo.index)), key: hx(o0.key), name: o0.name ?? n.name,
      buyer: hx(o0.buyer), seller: hx(o0.seller), amount: u64(o0.value), refundAfter: u64(o0.refundAfter),
    });
    const expired = new RS.NameInfo({ ...n, outpoint: n.outpoint, expiresAt: BigInt(Date.now()) - 1_000n });
    await r.throws(() => actionsAt(acceptStep).plan(A.Operation.accept(offer, expired)), (e) => e.code === "acceptNameNotActive",
      "IOS-055: accepting an offer on an expired name is refused");
  }

  // MARK: actions: offers that go back (expired, declined on a changed owner, the rest after a transfer)
  {
    const performed = [];
    const mk = (id, extra) => new RS.OfferInfo({
      outpoint: T.makeOutpoint(C.unhex32(id.repeat(32)), 0), key: C.key("alice"), name: "alice", buyer: me, seller: me, amount: 5n, refundAfter: 100n, ...extra,
    });
    const expired = mk("01", { refundAfter: 50n });
    const fresh = mk("02", { refundAfter: 590_000_200n });
    const stranger = S.xonlyKey(other);
    const toEarlier = mk("03", { refundAfter: 590_000_200n, seller: stranger });
    const freeName = mk("04", { refundAfter: 590_000_200n, name: "gone" });
    const notMine = mk("05", { refundAfter: 590_000_200n, buyer: stranger, seller: stranger });
    const aliceInfo = new RS.NameInfo({ name: "alice", key: C.key("alice"), owner: me, expiresAt: 1n, outpoint: T.makeOutpoint(C.zero32(), 0) });
    const reg2 = {
      ...registryStub,
      lookup: async (name) => (name === "alice" ? { kind: "registered", name, info: aliceInfo } : { kind: "free", name, gap: null }),
      offersFor: async () => [fresh, toEarlier, notMine, mk("06", { refundAfter: 590_000_200n })],
    };
    const act = new A.KachatNamesActions({ engine: actEngine, service: dry, registry: reg2, storage });
    act.perform = async (op) => { performed.push(`${op.kind}:${op.offer.id.slice(0, 2)}`); return "ff".repeat(32); };
    await act.returnExpiredOffers([expired, fresh]);
    await act.returnExpiredOffers([expired]);
    r.eq(performed.join(","), "refund:01", "returnExpiredOffers: only the expired one, once per session");
    performed.length = 0;
    await act.withdrawDeclinedOffers([fresh, toEarlier, freeName, notMine]);
    await act.withdrawDeclinedOffers([toEarlier]);
    r.eq(performed.sort().join(","), "withdraw:03,withdraw:04", "withdrawDeclinedOffers: mine, made to an earlier owner or on a free name, once");
    performed.length = 0;
    await act.declineOpenOffers(aliceInfo, fresh);
    r.eq(performed.sort().join(","), "decline:06", "declineOpenOffers: the rest made to this owner, not the accepted one");
  }

  // MARK: the registration driver stops while the registry is being upgraded
  const drvEngine = { ...fakeEngine(), address: s(v.deployer.address), privateKeyHex: C.hex(sk) };
  const drvMem = new Map([[A.registrationsStorageKey, JSON.stringify({ [s(v.deployer.address)]: [{ ...rec, id: "d1", stage: A.Stage.waiting }] })]]);
  const drv = new A.KachatNamesActions({
    engine: drvEngine, service: upgradingSvc, registry: registryStub, storage: { get: (k) => drvMem.get(k) ?? null, set: (k, val) => drvMem.set(k, val) },
  });
  let advanced = 0;
  drv._advance = async () => { advanced += 1; };
  upgradingSvc.registryUpgrading = true;
  drv.resume();
  await new Promise((res) => setTimeout(res, 20));
  r.eq(advanced, 0, "driver: no step while registryUpgrading");
  r.eq(drv._driver, null, "driver: stopped while registryUpgrading");
  drv.stop();

  // MARK: address profiles on every network (iOS d36fc42): profileSigner, saveProfile
  r.check(S.KachatNamesService.profilesEnabled && new S.KachatNamesService(fakeEngine()).profilesEnabled, "profilesEnabled on testnet");
  const ps = actions.profileSigner();
  r.check(ps.address === sg.address && C.hex(ps.me) === C.hex(sg.me) && ps.privateKey === sg.privateKey, "actions.profileSigner = the chatting signer on testnet");
  const mainnetAddr = RS.addressOf(me, "kaspa");
  await r.throws(() => new A.KachatNamesActions({ engine: { ...actEngine, address: mainnetAddr }, service: dry, registry: registryStub, storage }).profileSigner(),
    (e) => e instanceof S.ServiceError && e.code === "wrongAddressNetwork", "profileSigner refuses an address of the other network");
  await r.throws(() => new A.KachatNamesActions({ engine: { ...actEngine, privateKeyHex: C.hex(other) }, service: dry, registry: registryStub, storage }).profileSigner(),
    (e) => e.code === "keyMismatch", "profileSigner refuses a key that is not the address's");
  await r.throws(() => new A.KachatNamesActions({ engine: { ...actEngine, privateKeyHex: null }, service: dry, registry: registryStub, storage }).profileSigner(),
    (e) => e.code === "noWallet", "profileSigner: no wallet");
  await r.throws(() => dry.submitProfileRecord({ json: okJson, address: mainnetAddr }),
    (e) => e.code === "wrongAddressNetwork", "submitProfileRecord refuses an address of the other network");
  {
    const calls = [];
    const stubRegistry = { ...registryStub, noteOwnProfile: async (p, a, t) => { calls.push(["note", a, t, p.bio]); }, refreshAfter: (t) => { calls.push(["refresh", t]); } };
    const stubService = { submitProfileRecord: async ({ address, json }) => { calls.push(["submit", address, JSON.parse(json).v]); return "ab".repeat(32); } };
    const pa = new A.KachatNamesActions({ engine: actEngine, service: stubService, registry: stubRegistry, storage });
    const txId = await pa.saveProfile({ bio: "github.com/me" });
    r.eq(JSON.stringify(calls), JSON.stringify([["submit", sg.address, 1], ["note", sg.address, "ab".repeat(32), "https://github.com/me"], ["refresh", "ab".repeat(32)]]), "saveProfile on testnet: submit, note, refresh");
    r.eq(txId, "ab".repeat(32), "saveProfile returns the txid");
  }
  // mainnet: engine/network.js reads the network once per process, so a child process runs it
  {
    const child = `
      globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
      const S = await import("./engine/kachat-names/service.js");
      const A = await import("./engine/kachat-names/actions.js");
      const RS = await import("./engine/kachat-names/registry-state.js");
      const C = await import("./engine/kachat-names/codec.js");
      const sk = new Uint8Array(32); sk[0] = 0x5a; sk[31] = 77;
      const me = S.xonlyKey(sk);
      const address = RS.addressOf(me, "kaspa");
      const out = { isLaunched: S.KachatNamesService.isLaunched, profilesEnabled: S.KachatNamesService.profilesEnabled };
      const calls = [];
      const registry = { noteOwnProfile: async (p, a) => { calls.push("note:" + a); }, refreshAfter: () => { calls.push("refresh"); } };
      const service = { submitProfileRecord: async ({ address: a }) => { calls.push("submit:" + a); return "cd".repeat(32); } };
      const engine = { address, privateKeyHex: C.hex(sk) };
      const actions = new A.KachatNamesActions({ engine, service, registry, storage: { get: () => null, set: () => {} } });
      const err = (f) => { try { f(); return null; } catch (e) { return e.code ?? e.message; } };
      out.profileSigner = (() => { try { const s = actions.profileSigner(); return s.address === address && C.hex(s.me) === C.hex(me); } catch (e) { return e.code ?? e.message; } })();
      out.signer = err(() => new A.KachatNamesActions({ engine, registry, storage: { get: () => null, set: () => {} } }).signer());
      out.testnetAddress = err(() => new A.KachatNamesActions({ engine: { ...engine, address: RS.addressOf(me) }, service, registry, storage: { get: () => null, set: () => {} } }).profileSigner());
      out.manifest = await new S.KachatNamesService({}).loadManifest().then(() => null, (e) => e.code);
      out.submitTestnet = await new S.KachatNamesService({}).submitProfileRecord({ json: '{"v":1}', address: RS.addressOf(me) }).then(() => null, (e) => e.code);
      out.submitNoWallet = await new S.KachatNamesService({}).submitProfileRecord({ json: '{"v":1}', address }).then(() => null, (e) => e.message);
      out.saved = await actions.saveProfile({ bio: "x.com/me" });
      out.calls = calls;
      out.address = address;
      console.log(JSON.stringify(out));`;
    let res = null;
    try {
      res = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", child], { cwd: repo, encoding: "utf8" }).trim().split("\n").pop());
    } catch (e) { r.check(false, `mainnet child process failed: ${e.stderr || e.message}`); }
    if (res) {
      r.check(res.isLaunched === false && res.profilesEnabled === true, "mainnet: registry not launched, profiles enabled");
      r.eq(res.profileSigner, true, "mainnet: profileSigner signs for the kaspa: address");
      r.eq(res.signer, "testnetOnly", "mainnet: the registry signer stays testnet-only");
      r.eq(res.testnetAddress, "wrongAddressNetwork", "mainnet: profileSigner refuses a kaspatest: address");
      r.eq(res.manifest, "testnetOnly", "mainnet: no manifest");
      r.eq(res.submitTestnet, "wrongAddressNetwork", "mainnet: submitProfileRecord refuses a kaspatest: address");
      r.eq(res.submitNoWallet, "Load the wallet first.", "mainnet: submitProfileRecord passes the network gate for a kaspa: address");
      r.eq(res.saved, "cd".repeat(32), "mainnet: saveProfile returns the txid");
      r.eq(JSON.stringify(res.calls), JSON.stringify([`submit:${res.address}`, `note:${res.address}`]), "mainnet: saveProfile submits and notes, no registry refresh");
    }
  }

  // MARK: fees (iOS e426432): the node's estimate first, REST only as a fallback; speeds; busy
  {
    const realFetch = globalThis.fetch;
    try {
      let restCalls = 0;
      globalThis.fetch = async () => {
        restCalls += 1;
        return { status: 200, json: async () => ({ priorityBucket: { feerate: 900, estimatedSeconds: 1 }, normalBuckets: [{ feerate: 400, estimatedSeconds: 30 }] }) };
      };
      let nodeAnswer = { priority: { feerate: 250, seconds: 1 }, normal: { feerate: 120, seconds: 2 } };
      const feeEngine = { ...actEngine, getFeeEstimate: async () => { if (!nodeAnswer) throw new Error("no node"); return nodeAnswer; } };
      const fa = new A.KachatNamesActions({ engine: feeEngine, service: dry, registry: registryStub, storage });
      const seen = [];
      fa.subscribe((x) => seen.push(x.feeEstimate));
      const e1 = await fa.refreshFeeEstimate();
      r.check(e1.normal === 120 && e1.normalSeconds === 2 && e1.priority === 250 && e1.prioritySeconds === 1, "refreshFeeEstimate: from the node (GetFeeEstimate)");
      r.eq(restCalls, 0, "refreshFeeEstimate: the REST API isn't asked while a node answers");
      r.check(seen.some((x) => x?.normal === 120), "refreshFeeEstimate: subscribers see the new estimate");
      r.eq(e1.isBusy, false, "busy: 1.2x the floor, 2 s -> not busy");
      r.eq(await fa.feerate(), 250, "feerate: max(100, the priority rate) from the node");
      r.eq(await fa.feerateForTier(A.FeeTier.normal), 120, "feerateForTier: Normal = 1x the network's Normal rate");
      r.eq(await fa.feerateForTier("fast"), 240, "feerateForTier: Fast = 2x");
      r.eq(await fa.feerateForTier("Priority"), 600, "feerateForTier: Priority = 5x");
      nodeAnswer = { priority: { feerate: 60, seconds: 1 }, normal: { feerate: 40, seconds: 1 } };
      r.eq(await fa.feerateForTier("normal"), 100, "feerateForTier: never under the relay floor");
      r.eq(await fa.feerateForTier("fast"), 200, "feerateForTier: the floor times the multiplier");
      r.eq(await fa.feerate(), 100, "feerate: never under the floor");
      nodeAnswer = null;
      const e2 = await fa.refreshFeeEstimate();
      r.check(e2.normal === 400 && e2.normalSeconds === 30 && e2.priority === 900 && restCalls === 1, "refreshFeeEstimate: no node -> the REST API (normalBuckets[0], priorityBucket)");
      r.eq(e2.isBusy, true, "busy: Normal expected to wait 30 s");
      globalThis.fetch = async () => { throw new Error("offline"); };
      r.eq((await fa.refreshFeeEstimate())?.normal, 400, "refreshFeeEstimate: nothing answers -> the last estimate stays");
      const none = new A.KachatNamesActions({ engine: feeEngine, service: dry, registry: registryStub, storage });
      r.eq(await none.refreshFeeEstimate(), null, "refreshFeeEstimate: nothing ever answered -> null");
      r.eq(await none.feerateForTier("fast"), 2 * A.unknownFeerate, "feerateForTier: no estimate -> unknownFeerate times the multiplier");
      r.eq(A.isBusyEstimate({ normal: 150, normalSeconds: 10 }), false, "busy: exactly 1.5x the floor and 10 s is not busy");
      r.eq(A.isBusyEstimate({ normal: 151, normalSeconds: 1 }), true, "busy: Normal above 1.5x the floor");
      r.eq(A.isBusyEstimate({ normal: 100, normalSeconds: 11 }), true, "busy: Normal expected over 10 s");
      r.eq(A.isBusyEstimate(null), false, "busy: no estimate is not busy");
      r.eq(A.makeFeeEstimate({ normal: 200, priority: 300 }).isBusy, true, "makeFeeEstimate carries isBusy");
    } finally {
      globalThis.fetch = realFetch;
    }
    // fee choices
    r.eq(JSON.stringify(A.normalizeFeeChoice("fast")), JSON.stringify({ kind: "tier", tier: "fast" }), "normalizeFeeChoice: a speed id");
    r.eq(JSON.stringify(A.normalizeFeeChoice({ tier: "Priority" })), JSON.stringify({ kind: "tier", tier: "priority" }), "normalizeFeeChoice: { tier }");
    r.eq(A.normalizeFeeChoice({ customTotal: "5000" })?.total, 5000n, "normalizeFeeChoice: { customTotal }");
    r.eq(A.normalizeFeeChoice(A.FeeChoice.customTotal(7n))?.total, 7n, "normalizeFeeChoice: FeeChoice.customTotal");
    r.eq(A.normalizeFeeChoice({ customTotal: 0n }), null, "normalizeFeeChoice: a zero total is no choice");
    r.eq(A.normalizeFeeChoice("turbo"), null, "normalizeFeeChoice: an unknown speed is no choice");
    r.eq(A.normalizeFeeChoice(null), null, "normalizeFeeChoice: none");
    r.eq(A.parseFeeTier("NORMAL"), "normal", "parseFeeTier: any case");
    // the plan is rebuilt at the chosen fee, and sent at it
    if (extStep) {
      const ext = nameInfoOf(extStep.records.name);
      const fp = actionsAt(extStep);
      fp.feerateForTier = async (t) => ({ normal: 100, fast: 200, priority: 500 }[t]);
      fp.feerate = async () => 300;
      fp.registry = { ...fp.registry, refreshAfter: () => {} };
      try {
        const op = A.Operation.extend(ext, 1n);
        const normal = await fp.plan(op, { fee: A.FeeChoice.tier("normal") });
        const fast = await fp.plan(op, { fee: "fast" });
        const pri = await fp.plan(op, { fee: { tier: "priority" } });
        const dflt = await fp.plan(op);
        r.check(normal.networkFee < fast.networkFee && fast.networkFee < pri.networkFee, `plan: Normal < Fast < Priority (${normal.networkFee}, ${fast.networkFee}, ${pri.networkFee})`);
        r.check(dflt.networkFee > fast.networkFee && dflt.networkFee < pri.networkFee, "plan: no choice keeps the old priority rate");
        r.eq(normal.priceFee, pri.priceFee, "plan: the fee choice never changes the price");
        const target = normal.networkFee * 3n;
        const custom = await fp.plan(op, { fee: A.FeeChoice.customTotal(target) });
        const off = custom.networkFee > target ? custom.networkFee - target : target - custom.networkFee;
        r.check(off * 100n <= target, `plan: a custom total becomes a rate from the transaction's mass (${custom.networkFee} for ${target})`);
        const tiny = await fp.plan(op, { fee: A.FeeChoice.customTotal(1n) });
        r.eq(tiny.networkFee, normal.networkFee, "plan: a custom total under the floor pays the floor (Normal here is the floor)");
        const sent = [];
        fp.service.signAndSubmit = async (plan, { env }) => { sent.push({ fee: plan.networkFee, rate: env.feerate }); return T.txIdHex(plan.unsignedTx); };
        const txId = await fp.perform(op, { maxPrice: pri.priceFee, fee: "priority" });
        r.check(sent.length === 1 && sent[0].rate === 500 && sent[0].fee === pri.networkFee, "perform: sent at the chosen fee (the plan shown)");
        r.eq(fp.txStage(txId), A.TxStage.sent, "perform: the transaction is followed (receipt stage 'sent')");
      } catch (e) { r.check(false, `fee choice threw ${e.stack || e}`); }
    }
  }

  // MARK: the follower (iOS e426432, 32260ae): mempool, then the transaction's own output in the
  // UTXO set (in a block), then the registry until it includes it; dropped; REST last
  {
    const regOut = C.concat([0xaa, 0x20], new Uint8Array(32).fill(0x4e), [0x87]);
    const regAddress = S.p2shAddress(regOut);
    const planWith = (outputs) => ({ unsignedTx: { outputs } });
    const followPlan = planWith([{ script: C.p2pkScript(me), value: 1n }, { script: regOut, value: 2n }]);
    r.eq(JSON.stringify(A.followTarget(followPlan)), JSON.stringify({ index: 1, address: regAddress }), "followTarget: the registry / offer (P2SH) output");
    r.eq(JSON.stringify(A.followTarget(planWith([{ script: C.p2pkScript(me), value: 1n }]))), JSON.stringify({ index: 0, address: RS.addressOf(me) }), "followTarget: else output 0 (its P2PK address)");
    r.eq(JSON.stringify(A.followTarget(null)), JSON.stringify({ index: 0, address: null }), "followTarget: no plan -> no output to look for");
    r.eq(A.p2pkAddress(new Uint8Array(33)), null, "p2pkAddress: not a P2PK script");
    const txid = "7e".repeat(32);
    /** Actions over a scripted node: `script(tick)` -> { pool, utxo } per poll; a fake clock. */
    const followRig = ({ script, accepted = () => false, catchUp = true } = {}) => {
      let t = 0;
      let tick = 0;
      const calls = { utxo: 0, pool: 0, rest: 0, catchUps: [] };
      const engine = {
        ...actEngine,
        currentVirtualDaaScore: async () => 9_999n,
        getUtxosWithCovenants: async (addresses) => {
          calls.utxo += 1;
          const st = script(tick, t);
          return st.utxo && addresses.includes(regAddress) ? [{ outpoint: { transactionId: txid.toUpperCase(), index: 1 }, blockDaaScore: 4_242n }] : [];
        },
        getMempoolEntry: async () => { calls.pool += 1; const st = script(tick, t); tick += 1; return st.pool ? { transaction: {} } : null; },
      };
      const registry = {
        ...registryStub,
        isAccepted: async () => { calls.rest += 1; return accepted(t); },
        ...(catchUp ? { refreshUntilIncludes: async (id, daa) => { calls.catchUps.push([id, daa]); return true; } } : {}),
      };
      const act = new A.KachatNamesActions({ engine, service: dry, registry, storage, clock: { now: () => t, sleep: async (ms) => { t += ms; } } });
      const stages = [];
      act.subscribe(({ txStages }) => { const st = txStages[txid]; if (st && stages[stages.length - 1] !== st) stages.push(st); });
      return { act, calls, stages, time: () => t };
    };
    // lands: in the mempool for a while, then its registry output is in the UTXO set
    {
      const rig = followRig({ script: (tick) => ({ pool: tick < 3, utxo: tick >= 3 }) });
      const p1 = rig.act.follow(txid, followPlan);
      r.check(rig.act.follow(txid.toUpperCase(), followPlan) === p1, "follow: a transaction already followed isn't followed twice");
      const last = await p1;
      r.eq(last, A.TxStage.shown, "follow: lands -> shown");
      r.eq(rig.stages.join(">"), "sent>inMempool>accepted>shown", "follow: stages Sent to the network > (mempool) > In a block > Updated in KaChat");
      r.eq(JSON.stringify(rig.calls.catchUps.map(([i, d]) => [i, String(d)])), JSON.stringify([[txid, "4242"]]), "follow: the registry refreshes until it includes the tx, at the landed output's block DAA score");
      r.eq(rig.calls.rest, 0, "follow: the REST API is never asked when the node shows the output");
      r.eq(rig.act.txStage(txid.toUpperCase()), A.TxStage.shown, "txStage: by txid, any case");
      r.eq(rig.act.txStages[txid], A.TxStage.shown, "txStages: a copy by txid");
    }
    // dropped: never in a mempool, never in the UTXO set, REST doesn't know it -> dropped after a minute
    {
      const rig = followRig({ script: () => ({ pool: false, utxo: false }) });
      const last = await rig.act.follow(txid, followPlan);
      r.eq(last, A.TxStage.dropped, "follow: no node has it -> dropped");
      r.check(rig.time() > 60_000 && rig.time() <= 62_000, `follow: dropped after a minute (${rig.time()} ms)`);
      r.eq(rig.stages.join(">"), "sent>dropped", "follow: stages sent > dropped");
      r.check(rig.calls.rest > 0 && rig.calls.rest <= 42, `follow: the REST API asked only after 20 s, as a last resort (${rig.calls.rest}x)`);
    }
    // in a block, its output spent again right away: out of the mempool, not in the UTXO set -> REST says accepted
    {
      const rig = followRig({ script: (tick) => ({ pool: tick < 2, utxo: false }), accepted: () => true });
      const last = await rig.act.follow(txid, followPlan);
      r.eq(last, A.TxStage.shown, "follow: output already spent -> the REST API settles it -> shown");
      r.eq(rig.stages.join(">"), "sent>inMempool>accepted>shown", "follow: (REST) stages");
      r.eq(JSON.stringify(rig.calls.catchUps.map(([i, d]) => [i, String(d)])), JSON.stringify([[txid, "9999"]]), "follow: (REST) the registry catches up to the virtual DAA score");
    }
    // a transaction built elsewhere (a profile save): no plan -> mempool, then REST
    {
      const rig = followRig({ script: (tick) => ({ pool: tick < 2, utxo: true }), accepted: (t) => t >= 3_000 });
      const last = await rig.act.follow(txid, null);
      r.eq(last, A.TxStage.shown, "follow (no plan): mempool, then the REST API -> shown");
      r.eq(rig.calls.utxo, 0, "follow (no plan): no output to look for in the UTXO set");
    }
    // a registry without refreshUntilIncludes (an older copy) refreshes once
    {
      let refreshes = 0;
      const rig = followRig({ script: () => ({ pool: false, utxo: true }), catchUp: false });
      rig.act.registry.refresh = async () => { refreshes += 1; };
      r.eq(await rig.act.follow(txid, followPlan), A.TxStage.shown, "follow: lands at once");
      r.eq(refreshes, 1, "follow: a registry without refreshUntilIncludes refreshes once");
    }
    r.eq(await new A.KachatNamesActions({ engine: actEngine, service: dry, registry: registryStub, storage }).follow("nope"), null, "follow: a malformed txid isn't followed");
  }

  // MARK: report
  for (const sk2 of r.skipped) console.log(`SKIPPED ${sk2}`);
  if (r.fail) {
    for (const f of r.failures.slice(0, 40)) console.log(`FAIL ${f}`);
    if (r.failures.length > 40) console.log(`... and ${r.failures.length - 40} more`);
  }
  console.log(`kachat-names service: ${r.pass} checks passed, ${r.fail} failed; ${signedSteps}/${appSteps(v).length} vector plans signed, ${kaspa ? `${wasmSteps}/${appSteps(v).length} converted to WASM Transactions` : "WASM conversion skipped"}`);
  process.exit(r.fail ? 1 : 0);
}

await main();
