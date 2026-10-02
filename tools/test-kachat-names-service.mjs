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
  const fields = C.makeNameFields({ key: hx(n.key), paddedName: C.padded(name), owner: hx(n.owner), price: u64(n.price), expiresAt: u64(n.expiresAt) });
  return { fields, value: u64(n.value), utxo: utxo(n.utxo) };
}
function offerRec(o) {
  const fields = C.makeOfferFields({ key: hx(o.key), buyer: hx(o.buyer), refundAfter: u64(o.refundAfter) });
  return { fields, value: u64(o.value), utxo: utxo(o.utxo), name: typeof o.name === "string" ? o.name : null };
}
const commitRec = (c) => ({ name: s(c.name), owner: hx(c.owner), salt: hx(c.salt), value: u64(c.value), utxo: utxo(c.utxo) });

function build(b, op, env, wallet, args, rec) {
  switch (op) {
    case "commit": return b.commit({ env, wallet, name: s(args.name), salt: hx(args.salt) });
    case "register": return b.register({ env, wallet, gap: gapRec(rec.gap), commit: commitRec(rec.commit), years: u64(args.years), now: u64(args.now) });
    case "renew": return b.renew({ env, wallet, name: nameRec(rec.name), years: u64(args.years) });
    case "transfer": return b.transfer({ env, wallet, name: nameRec(rec.name), newOwner: hx(args.newOwner) });
    case "list": return b.list({ env, wallet, name: nameRec(rec.name), price: u64(args.price) });
    case "buy": return b.buy({ env, wallet, name: nameRec(rec.name) });
    case "offer": return b.offer({ env, wallet, name: s(args.name), amount: u64(args.amount), refundAfter: u64(args.refundAfter), target: rec.target ? nameRec(rec.target) : null });
    case "acceptOffer": return b.acceptOffer({ env, name: nameRec(rec.name), offer: offerRec(rec.offer) });
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
    async submitRpcTransaction(tx) { this.submitted.push(tx); return tx.id; },
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
  const bundled = new S.KachatNamesService(fakeEngine());
  const bm = await bundled.loadManifest();
  r.eq(bundled.manifestSource, "bundle", "manifest from the bundle");
  r.eq(bm.network, "testnet-10", "bundled manifest network");
  r.check(!bm.isDryRun, "bundled manifest is not a dry run");
  const dry = new S.KachatNamesService(fakeEngine(), { bundledManifest: v.manifest });
  await r.throws(() => dry.loadManifest(), (e) => e.code === "dryRunManifest", "a dry-run manifest is refused");
  const m = await dry.loadManifest({ allowDryRun: true });
  r.check(m.isDryRun, "allowDryRun loads the vectors' manifest");

  // MARK: environment
  const env0 = await dry.environment({ privateKey: sk, feerate: 50 });
  r.eq(C.hex(env0.me), s(v.deployer.xonly), "environment: me");
  r.eq(env0.feerate, 100, "environment: feerate floor 100");
  r.eq(env0.blockDaa, 590_000_100n, "environment: virtual DAA");
  const wrongNet = new S.KachatNamesService(fakeEngine({ dag: { networkId: "mainnet", virtualDaaScore: 1n, pastMedianTime: 1n } }), { bundledManifest: v.manifest });
  await r.throws(() => wrongNet.environment({ privateKey: sk }), (e) => e.code === "wrongNodeNetwork", "environment refuses a mainnet node");

  // MARK: signing every vector plan
  const wasm = await loadWasm();
  const kaspa = wasm.error ? null : wasm;
  if (!kaspa) r.skipped.push(`WASM conversion: the Kaspa WASM did not load in Node (${wasm.error})`);
  const b = new B.Builder(m);
  let signedSteps = 0, wasmSteps = 0;
  const signedByLabel = new Map();
  for (const st of v.steps) {
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
  r.eq(signedSteps, v.steps.length, "every vector step signed");
  if (kaspa) r.eq(wasmSteps, v.steps.length, "every vector step converted");

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
    noteOwnProfile: async () => {},
  };
  const actions = new A.KachatNamesActions({ engine: actEngine, service: dry, registry: registryStub, storage });
  const sg = actions.signer();
  r.eq(C.hex(sg.me), s(v.deployer.xonly), "actions.signer: x-only key");
  r.eq(sg.address, s(v.deployer.address), "actions.signer: address");
  r.eq(C.hex(actions.myKey), s(v.deployer.xonly), "actions.myKey");
  const badEngine = { ...actEngine, privateKeyHex: C.hex(other) };
  r.check((() => { try { new A.KachatNamesActions({ engine: badEngine, service: dry, registry: registryStub, storage }).signer(); return false; } catch (e) { return e.code === "keyMismatch"; } })(), "signer refuses a key that is not the address's");
  r.eq(A.Operation.list({ name: "x" }, 5).price, 5n, "Operation.list price is BigInt");
  r.eq(A.Operation.offer("alice", 10, 20).refundAfterDaa, 20n, "Operation.offer refundAfterDaa");
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

  // MARK: report
  for (const sk2 of r.skipped) console.log(`SKIPPED ${sk2}`);
  if (r.fail) {
    for (const f of r.failures.slice(0, 40)) console.log(`FAIL ${f}`);
    if (r.failures.length > 40) console.log(`... and ${r.failures.length - 40} more`);
  }
  console.log(`kachat-names service: ${r.pass} checks passed, ${r.fail} failed; ${signedSteps}/${v.steps.length} vector plans signed, ${kaspa ? `${wasmSteps}/${v.steps.length} converted to WASM Transactions` : "WASM conversion skipped"}`);
  process.exit(r.fail ? 1 : 0);
}

await main();
