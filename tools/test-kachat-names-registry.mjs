// The .kachat registry data layer (engine/kachat-names/registry-state.js and registry.js) against
// the kachat-domains vectors. Port of iOS scripts/test_kachat_names_registry.swift: the walker's
// transition decoder (every e2e vector transaction applied in order, every later step's records
// found in the walked state), the edge cases, refusals, the walk loop over a simulated chain, the
// status / label / profile rules, the REST transaction parser and the indexer shapes. On top of
// the Swift script: the KachatNamesRegistry class itself, over a simulated chain served through a
// fake fetch and node (lookups, owners, history, exit gaps, resolveActive, the cache round trip)
// and over a fake names indexer. Run from the repo root:
//
//   node tools/test-kachat-names-registry.mjs [--live] [path/to/KachatNamesVectors.json]
//
// `--live` also walks the LIVE testnet-10 registry from the bundled manifest, read-only, through
// api-tn10.kaspa.org (UTXO liveness from GET /addresses/{a}/utxos instead of a node, spends from
// GET /addresses/{a}/full-transactions) and prints what it found. An unreachable network is
// reported, not failed.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import * as C from "../engine/kachat-names/codec.js";
import * as T from "../engine/kachat-names/transaction.js";
import * as M from "../engine/kachat-names/manifest.js";
import * as R from "../engine/kachat-names/registry-state.js";
import { KachatNamesRegistry, parseJSONExact } from "../engine/kachat-names/registry.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");

class Report {
  constructor() { this.pass = 0; this.fail = 0; this.failures = []; }
  check(ok, what) {
    if (ok) this.pass += 1;
    else { this.fail += 1; this.failures.push(typeof what === "function" ? what() : what); }
  }
  eq(a, b, what) {
    const show = (x) => JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? `${v}n` : v instanceof Uint8Array ? C.hex(v) : v));
    const sa = show(a), sb = show(b);
    this.check(sa === sb, () => `${what}: got ${sa} expected ${sb}`);
  }
}

const u64 = (v) => BigInt(v);
const s = (v) => { if (typeof v !== "string") throw new Error(`expected a string, got ${v}`); return v; };
const hx = (v) => C.unhex(s(v));
const sortStr = (xs) => [...xs].sort();

/** A vector step's signed transaction, as the walker sees it. */
function view(st, at) {
  const e = st.expected;
  return new R.TxView({
    id: hx(e.txid),
    inputs: e.inputs.map((i) => ({ outpoint: T.makeOutpoint(hx(i.txid), Number(i.index)), signatureScript: hx(i.signatureScript) })),
    outputs: e.outputs.map((o) => T.makeTxOutput({
      value: u64(o.value), scriptVersion: Number(o.scriptVersion), script: hx(o.script),
      covenant: o.covenant ? T.makeCovenantBinding(Number(o.covenant.authorizingInput), hx(o.covenant.covenantId)) : null,
    })),
    payload: hx(e.payload),
    at: BigInt(at),
  });
}

const outpointKey = (u) => `${s(u.txid)}:${Number(u.index)}`;

/** Every record a step was built from must be in the walked state, exactly. */
function checkRecords(st, state, r) {
  const label = s(st.label);
  const rec = st.records;
  for (const k of ["gap", "below", "above"]) {
    const g = rec[k];
    if (!g) continue;
    const found = state.gaps.find((x) => `${x.txid}:${x.index}` === outpointKey(g.utxo));
    r.check(!!found, `${label}: ${k} gap ${outpointKey(g.utxo).slice(0, 16)} not in the walked state`);
    if (found) {
      r.eq(found.lo, s(g.lo), `${label}: ${k} lo`);
      r.eq(found.hi, s(g.hi), `${label}: ${k} hi`);
      r.eq(found.value, u64(g.value), `${label}: ${k} value`);
    }
  }
  if (rec.name) {
    const n = rec.name;
    const found = state.names.find((x) => `${x.txid}:${x.index}` === outpointKey(n.utxo));
    r.check(!!found, `${label}: name ${n.name} at ${outpointKey(n.utxo).slice(0, 16)} not in the walked state`);
    if (found) {
      r.eq(found.name, s(n.name), `${label}: name`);
      r.eq(found.key, s(n.key), `${label}: key`);
      r.eq(found.owner, s(n.owner), `${label}: owner`);
      r.eq(found.price, u64(n.price), `${label}: price`);
      r.eq(found.expiresAt, u64(n.expiresAt), `${label}: expiresAt`);
      r.eq(found.value, u64(n.value), `${label}: value`);
    }
  }
  if (rec.offer) {
    const o = rec.offer;
    const found = state.offers.find((x) => `${x.txid}:${x.index}` === outpointKey(o.utxo));
    r.check(!!found, `${label}: offer at ${outpointKey(o.utxo).slice(0, 16)} not in the walked state`);
    if (found) {
      r.eq(found.key, s(o.key), `${label}: offer key`);
      r.eq(found.buyer, s(o.buyer), `${label}: offer buyer`);
      r.eq(found.refundAfter, u64(o.refundAfter), `${label}: offer refundAfter`);
      r.eq(found.value, u64(o.value), `${label}: offer value`);
    }
  }
}

/** A state holding exactly a step's records (the edge cases run on synthetic registry UTXOs). */
function seeded(st, m) {
  const state = R.RegistryState.atGenesis(m);
  state.gaps = [];
  state.applied = [];
  const rec = st.records;
  for (const k of ["gap", "below", "above"]) {
    const g = rec[k];
    if (!g) continue;
    state.gaps.push({ txid: s(g.utxo.txid), index: Number(g.utxo.index), lo: s(g.lo), hi: s(g.hi), value: u64(g.value) });
  }
  if (rec.name) {
    const n = rec.name;
    state.names.push({
      txid: s(n.utxo.txid), index: Number(n.utxo.index), name: s(n.name), key: s(n.key), owner: s(n.owner),
      price: u64(n.price), expiresAt: u64(n.expiresAt), value: u64(n.value), registeredAt: null, registeredTxId: null, updatedAt: null,
    });
  }
  if (rec.offer) {
    const o = rec.offer;
    state.offers.push({
      txid: s(o.utxo.txid), index: Number(o.utxo.index), key: s(o.key), buyer: s(o.buyer), refundAfter: u64(o.refundAfter),
      value: u64(o.value), name: typeof o.name === "string" ? o.name : null, createdAt: null,
    });
  }
  return state;
}

function tryApply(state, tx, m) { try { return state.apply(tx, m); } catch { return null; } }

function runWalker(v, r) {
  const m = M.decodeManifest(v.manifest);
  const steps = v.steps;
  const e2e = steps.slice(0, 18);
  const state = R.RegistryState.atGenesis(m);
  const ops = [];
  e2e.forEach((st, i) => {
    checkRecords(st, state, r);
    try {
      const events = state.apply(view(st, 1_000 + i), m);
      ops.push(...events.map((e) => `${e.op} ${e.name ?? "?"}`));
    } catch (e) {
      r.check(false, `${s(st.label)}: apply threw ${e.message}`);
    }
    try { state.checkInvariants(); } catch (e) { r.check(false, `${s(st.label)}: invariants: ${e.message}`); }
  });
  r.eq(ops, [
    "register alpha-tn", "register bravo-tn", "register lapse-tn", "renew alpha-tn", "transfer alpha-tn", "list alpha-tn",
    "sale alpha-tn", "offer bravo-tn", "offer_accepted bravo-tn", "offer_accept bravo-tn", "offer alpha-tn", "offer_refund alpha-tn",
    "offer alpha-tn", "offer_withdraw alpha-tn", "release bravo-tn", "reclaim lapse-tn",
  ], "e2e events");
  r.eq(state.names.map((n) => n.name), ["alpha-tn"], "names left after the e2e plan");
  r.eq(state.gaps.length, 2, "gaps left after the e2e plan");
  r.eq(state.offers.length, 0, "offers left after the e2e plan");
  const accepted = state.events.find((e) => e.op === "offer_accepted");
  const payout = accepted?.price ?? 0n;
  r.check(payout > 9n * 100_000_000n && payout < 10n * 100_000_000n, `accepted offer payout is the offer less the fee (${payout})`);
  const alpha = state.name("alpha-tn");
  r.check(alpha?.registeredTxId === C.hex(hx(e2e[3].expected.txid)), "registration tx carried through every transition");
  r.eq(alpha?.registeredAt, 1_003n, "registration time carried through every transition");
  // applying again changes nothing
  const snapshot = state.clone();
  e2e.forEach((st, i) => tryApply(state, view(st, 1_000 + i), m));
  r.check(state.equals(snapshot), "re-applying is a no-op");
  // the cache format round-trips
  r.check(R.RegistryState.fromJSON(JSON.stringify(state.toJSON())).equals(state), "cache JSON round trip");

  // the edge cases, each on a state seeded with its own records
  for (const st of steps.slice(18)) {
    const seededState = seeded(st, m);
    const label = s(st.label);
    try {
      const events = seededState.apply(view(st, 5), m);
      const op = s(st.op);
      if (op === "commit" || op === "cancelCommit") r.check(events.length === 0, `${label}: not a registry transaction`);
      else r.check(events.length > 0, `${label}: no events`);
      switch (op) {
        case "register": r.eq(seededState.names.length, 1, `${label}: name created`); r.eq(seededState.gaps.length, 2, `${label}: gaps split`); break;
        case "reclaim": r.eq(seededState.names.length, 0, `${label}: name gone`); r.eq(seededState.gaps.length, 1, `${label}: gaps merged`); break;
        case "acceptOffer": r.eq(seededState.offers.length, 0, `${label}: offer gone`); break;
        default: break;
      }
      if (op === "acceptOffer") {
        r.eq(seededState.names[0]?.owner, s(st.records.offer.buyer), `${label}: the name went to the buyer`);
      }
    } catch (e) {
      r.check(false, `${label}: apply threw ${e.message}`);
    }
  }

  // refusals leave the state alone
  const reg = steps[3];
  const genesis = R.RegistryState.atGenesis(m);
  const st0 = R.RegistryState.atGenesis(m);
  const tampered = view(reg, 1);
  tampered.outputs[2].script[5] ^= 0x01;
  r.check(tryApply(st0, tampered, m) === null, "a register whose name output holds another state was accepted");
  r.check(st0.equals(genesis), "refused register left the state alone");
  const extra = view(reg, 1);
  extra.outputs.push(extra.outputs[0]);
  r.check(tryApply(st0, extra, m) === null, "an unexplained registry output was accepted");
  const wrongAuth = view(reg, 1);
  wrongAuth.outputs[0].covenant.authorizingInput = 1;
  r.check(tryApply(st0, wrongAuth, m) === null, "an output authorized by another input was accepted");
  const badRedeem = view(reg, 1);
  const pushes = C.parsePushes(badRedeem.inputs[0].signatureScript);
  const redeem = pushes.pop();
  redeem[redeem.length - 1] ^= 0x01;
  badRedeem.inputs[0].signatureScript = C.concat(...pushes.map((p) => C.pushData(p)), C.pushData(redeem));
  r.check(tryApply(st0, badRedeem, m) === null, "a spend revealing another redeem script was accepted");
  r.check(st0.equals(genesis), "refusals left the state alone");
  // an unrelated transaction is ignored
  r.eq(tryApply(st0, view(steps[0], 1), m)?.length, 0, "a commit is not a registry transaction");
}

/** The simulated chain of the e2e transactions: scripts by outpoint and spends. */
function simulatedChain(v) {
  const m = M.decodeManifest(v.manifest);
  const steps = v.steps.slice(0, 18);
  const txs = steps.map((st, i) => view(st, 1_000 + i));
  const created = new Map(); // outpoint -> script
  const spentBy = new Map(); // outpoint -> txid
  for (const t of txs) {
    t.outputs.forEach((o, k) => created.set(`${t.idHex}:${k}`, o.script));
    for (const i of t.inputs) spentBy.set(`${C.hex(i.outpoint.txid)}:${i.outpoint.index}`, t.idHex);
  }
  // the genesis gap lives at the manifest's genesis outpoint
  created.set(`${C.hex(m.genesisTxid)}:0`, m.genesisOutput.script);
  const addr = (script) => R.addressFromScriptPublicKey(script, "kaspatest");
  const visibleUpTo = (upTo) => {
    const visible = txs.slice(0, upTo);
    const visibleIds = new Set(visible.map((t) => t.idHex));
    const live = (addresses) => {
      const out = new Set();
      for (const [op, script] of created) {
        if (addresses.includes(addr(script) ?? "") && (op.startsWith(C.hex(m.genesisTxid)) || visibleIds.has(op.slice(0, 64)))
          && !(spentBy.has(op) && visibleIds.has(spentBy.get(op)))) out.add(op);
      }
      return out;
    };
    const transactions = (a) => [...visible].reverse().filter((t) =>
      t.outputs.some((o) => addr(o.script) === a)
      || t.inputs.some((i) => { const sc = created.get(`${C.hex(i.outpoint.txid)}:${i.outpoint.index}`); return sc != null && addr(sc) === a; }));
    return { visible, live, transactions };
  };
  return { m, txs, addr, visibleUpTo };
}

/** The walk loop over a simulated chain holding every e2e transaction: liveness from the
 *  simulated UTXO set, spends found through addresses, transactions handed back newest first. */
async function runWalk(v, r) {
  const { m, addr, visibleUpTo } = simulatedChain(v);
  for (const upTo of [3, 6, 10, 18]) {
    const { visible, live, transactions } = visibleUpTo(upTo);
    const walked = R.RegistryState.atGenesis(m);
    try {
      const report = await walked.walk({ manifest: m, address: addr, live: async (a) => live(a), transactions: async (a) => transactions(a) });
      const reference = R.RegistryState.atGenesis(m);
      for (const t of visible) tryApply(reference, t, m);
      const ops = (xs) => sortStr(xs.map((x) => `${x.txid}:${x.index}`));
      r.eq(ops(walked.gaps), ops(reference.gaps), `walk to ${upTo}: gaps`);
      r.eq(sortStr(walked.names.map((n) => n.name)), sortStr(reference.names.map((n) => n.name)), `walk to ${upTo}: names`);
      r.eq(ops(walked.names), ops(reference.names), `walk to ${upTo}: name outpoints`);
      r.check(report.unresolved.length === 0, `walk to ${upTo}: unresolved ${report.unresolved}`);
      try { walked.checkInvariants(); } catch (e) { r.check(false, `walk to ${upTo}: invariants ${e.message}`); }
    } catch (e) {
      r.check(false, `walk to ${upTo} threw ${e.message}`);
    }
  }
}

function runRules(r) {
  const g = 864_000_000n;
  r.eq(R.Status.of(1_000n, g, 999n), "active", "status before expiry");
  r.eq(R.Status.of(1_000n, g, 1_000n), "grace", "status at expiry");
  r.eq(R.Status.of(1_000n, g, 1_000n + g - 1n), "grace", "status in grace");
  r.eq(R.Status.of(1_000n, g, 1_000n + g), "lapsed", "status at grace end");
  const me = new Uint8Array(32).fill(7);
  const info = (n, exp, reg) => new R.NameInfo({ name: n, key: C.key(n), owner: me, price: 0n, expiresAt: exp, outpoint: T.makeOutpoint(C.zero32(), 0), registeredAt: reg });
  const now = 10_000_000_000_000n;
  const owned = [info("zeta", now + 5n, 10n), info("alpha", now + 5n, 20n), info("old", now - 5n, 1n)];
  r.eq(R.label(owned, null, g, now), "zeta", "label: the oldest active name");
  r.eq(R.label(owned, "Alpha.kachat", g, now), "alpha", "label: the primary name");
  r.eq(R.label(owned, "old", g, now), "zeta", "label: a primary name in grace is skipped");
  r.eq(R.label(owned, "notmine", g, now), "zeta", "label: a primary name not owned is skipped");
  r.eq(R.label([owned[2]], null, g, now), null, "label: no active name");

  const p = new R.Profile({
    avatar: " https://example.com/a.png ", banner: "http://example.com/b.png", bio: "x".repeat(300),
    links: { website: "https://k.app", x: "", github: null, telegram: "  ", discord: null, nostr: "npub1" }, primaryName: "Alice.kachat",
  });
  const clean = p.sanitized();
  r.eq(clean.avatar, "https://example.com/a.png", "profile: avatar kept and trimmed");
  r.eq(clean.banner, null, "profile: http banner dropped");
  r.eq(clean.bio?.length, 280, "profile: bio cut to 280");
  r.eq({ ...clean.links }, { website: "https://k.app", x: null, github: null, telegram: null, discord: null, nostr: "npub1" }, "profile: blank links dropped");
  r.eq(clean.primaryName, "alice", "profile: primary name normalized");
  const json = p.recordJSON();
  r.check(C.utf8(json).length <= 2048, "profile JSON within 2 KB");
  r.check(json.startsWith("{\"avatar\":\"https://example.com/a.png\",\"bio\":"), `profile JSON compact with sorted keys: ${json.slice(0, 60)}`);
  r.check(R.profileEqual(R.Profile.parse(json), clean), "profile JSON round trip");
  r.check(R.profileEqual(R.Profile.parse("{\"v\":1,\"displayName\":\"x\",\"avatar\":\"ftp://a\"}"), new R.Profile()), "profile: unknown fields and bad schemes dropped");
  r.eq(R.Profile.parse("{\"v\":2}"), null, "profile: only v 1");
  r.eq(R.Profile.parse("{\"avatar\":\"https://a/b\"}"), null, "profile: v is required");
  const big = new R.Profile({ links: { website: "w".repeat(1500), x: "x".repeat(600) } });
  let threw = false;
  try { big.recordJSON(); } catch { threw = true; }
  r.check(threw, "profile over 2 KB refused");

  const k = C.concat(new Uint8Array(31).fill(0x10), [0x00]);
  r.eq(C.hex(R.step(k, -1)), C.hex(C.concat(new Uint8Array(30).fill(0x10), [0x0f, 0xff])), "key - 1 borrows");
  r.eq(C.hex(R.step(k, 1)), C.hex(C.concat(new Uint8Array(31).fill(0x10), [0x01])), "key + 1");
  r.eq(R.step(C.zero32(), -1), null, "0 - 1");
  r.eq(R.step(C.ff32(), 1), null, "ff..ff + 1");
}

/** The REST API's shape for a version-1 transaction (the live genesis, 2026-10-02). */
const genesisREST = `{"subnetwork_id":"0000000000000000000000000000000000000000","transaction_id":"cba68dd1b07f374410270f1e609a3e71deaf42d3bd3b5849ac9b0e9cc687f45f","hash":"7a9e06cd3134a0cf0d90ecfb21d953a3ab3740f36fa00c552c2c3d10e8097978","mass":"2083","payload":null,"block_hash":["67c7ad399972fa99598c3baccfb380a89c509d5634d3738ed3bbca0e344162d4"],"block_time":1790909722843,"version":1,"is_accepted":true,"accepting_block_hash":"f6f3e6b5831b88991fe6bf47b7170fa6f0699126c217cf9f11236faed4d1b41d","accepting_block_blue_score":574239955,"accepting_block_time":1790909722989,"inputs":[{"transaction_id":"cba68dd1b07f374410270f1e609a3e71deaf42d3bd3b5849ac9b0e9cc687f45f","index":0,"previous_outpoint_hash":"f12c99e6f39833515eccb9900d5b8596565751dd76cbac98374597d9fbe73dab","previous_outpoint_index":"0","previous_outpoint_address":null,"previous_outpoint_amount":null,"signature_script":"41f5af0ec9cbad01185cfb488ceed108470a40af4d488ffe00da825ab0e9f5c65469e5dd1b60e18a6d66e611300a4d6965af730ead2b404841c5090f0a520aa91401","sig_op_count":null,"compute_budget":10,"covenant_id":null}],"outputs":[{"transaction_id":"cba68dd1b07f374410270f1e609a3e71deaf42d3bd3b5849ac9b0e9cc687f45f","index":0,"amount":100000000,"script_public_key":"aa2091e1c42572eec31a4bdfab6f4fe298fe51cb0934ac6f2cdb87e1052082744cc987","script_public_key_address":"kaspatest:pzg7r3p9wthvxxjtm74k7nlznrl9rjcfxjkx7txmslss2gyzw3xvj686vxecj","script_public_key_type":"scripthash","covenant_authorizing_input":0,"covenant_id":"9444187f09a3e77450e125d448b21eb79b3c54b692a5b3f3e8af38343b9a7a51"},{"transaction_id":"cba68dd1b07f374410270f1e609a3e71deaf42d3bd3b5849ac9b0e9cc687f45f","index":1,"amount":99791700,"script_public_key":"20a866cf597e3e681324adbc115ec34ca7746813cf70f6bfe4f9c36f2c9dd30848ac","script_public_key_address":"kaspatest:qz5xdn6e0clxsyey4k7pzhkrfjnhg6qneac0d0lyl8pk7tya6vyysf8pt3r8m","script_public_key_type":"pubkey","covenant_authorizing_input":null,"covenant_id":null}]}`;

function runREST(r) {
  const j = parseJSONExact(genesisREST);
  const t = R.TxView.fromREST(j);
  if (!t) { r.check(false, "REST genesis parsed as not accepted"); return; }
  r.eq(t.idHex, "cba68dd1b07f374410270f1e609a3e71deaf42d3bd3b5849ac9b0e9cc687f45f", "REST txid");
  r.eq(t.inputs.length, 1, "REST inputs");
  r.eq(C.hex(t.inputs[0].outpoint.txid), "f12c99e6f39833515eccb9900d5b8596565751dd76cbac98374597d9fbe73dab", "REST input outpoint");
  r.eq(t.outputs.length, 2, "REST outputs");
  r.eq(t.outputs[0].covenant?.authorizingInput, 0, "REST covenant binding");
  r.eq(t.outputs[0].covenant && C.hex(t.outputs[0].covenant.covenantId), "9444187f09a3e77450e125d448b21eb79b3c54b692a5b3f3e8af38343b9a7a51", "REST covenant id");
  r.eq(t.outputs[1].covenant, null, "REST plain output");
  r.eq(t.outputs[0].value, 100_000_000n, "REST amount");
  r.eq(t.at, 1790909722989n, "REST acceptance time");
  r.eq(R.addressFromScriptPublicKey(t.outputs[0].script, "kaspatest"), "kaspatest:pzg7r3p9wthvxxjtm74k7nlznrl9rjcfxjkx7txmslss2gyzw3xvj686vxecj", "P2SH address of the genesis gap");
  r.eq(R.p2shAddress(t.outputs[0].script), "kaspatest:pzg7r3p9wthvxxjtm74k7nlznrl9rjcfxjkx7txmslss2gyzw3xvj686vxecj", "p2shAddress of the genesis gap");
  // P2PK addresses: x-only key <-> kaspatest: address
  const xonly = C.p2pkKey(t.outputs[1].script);
  r.eq(R.addressOf(xonly), "kaspatest:qz5xdn6e0clxsyey4k7pzhkrfjnhg6qneac0d0lyl8pk7tya6vyysf8pt3r8m", "addressOf(x-only key)");
  r.eq(R.keyOf("KASPATEST:QZ5XDN6E0CLXSYEY4K7PZHKRFJNHG6QNEAC0D0LYL8PK7TYA6VYYSF8PT3R8M") && C.hex(R.keyOf("kaspatest:qz5xdn6e0clxsyey4k7pzhkrfjnhg6qneac0d0lyl8pk7tya6vyysf8pt3r8m")), C.hex(xonly), "keyOf(address)");
  r.eq(R.keyOf("kaspatest:qz5xdn6e0clxsyey4k7pzhkrfjnhg6qneac0d0lyl8pk7tya6vyysf8pt3r8n"), null, "keyOf refuses a bad checksum");
  r.eq(R.keyOf("kaspatest:pzg7r3p9wthvxxjtm74k7nlznrl9rjcfxjkx7txmslss2gyzw3xvj686vxecj"), null, "keyOf refuses a P2SH address");
  r.eq(R.keyOf(R.encodeAddress("kaspa", 0, xonly)), null, "keyOf refuses a mainnet address");
  const rejected = { ...j, is_accepted: false };
  r.eq(R.TxView.fromREST(rejected), null, "REST: a transaction not accepted is skipped");
  const big = parseJSONExact('[{"amount": 18446744073709551615, "t": 1790909722989}]');
  r.eq(big[0].amount, 18446744073709551615n, "REST amounts past 2^53 parsed exactly");
  r.eq(big[0].t, 1790909722989, "small numbers stay Numbers");

  // indexer shapes
  const nameJSON = JSON.parse(`{"name":"Alice","key":"00","registered":true,"status":"active","owner":"kaspatest:x","ownerKey":"${"ab".repeat(32)}",
    "price":"5000000000","expiresAt":1822000000000,"outpoint":{"txId":"${"cd".repeat(32)}","index":2},"registeredAt":1790000000000}`);
  const n = R.IndexerAPI.nameInfo(nameJSON, () => null);
  r.eq(n?.name, "alice", "indexer name normalized");
  r.eq(n?.price, 5_000_000_000n, "indexer price string");
  r.eq(n?.outpoint.index, 2, "indexer outpoint");
  r.eq(n && C.hex(n.key), C.hex(C.key("alice")), "indexer key recomputed from the name");
  const free = JSON.parse(`{"name":"bob","key":"00","registered":false,"gap":{"lo":"${"00".repeat(32)}","hi":"${"ff".repeat(32)}","outpoint":{"txId":"${"ee".repeat(32)}","index":0}}}`);
  const f = R.IndexerAPI.nameJSON(free);
  r.check(R.IndexerAPI.nameInfo(f, () => null) === null, "indexer free name has no record");
  r.check(f.gap?.contains(C.key("bob")) === true, "indexer gap decoded");
  let threw = false;
  try { R.IndexerAPI.nameJSON({ name: 5 }); } catch { threw = true; }
  r.check(threw, "indexer: a malformed name object throws");
}

// MARK: - The KachatNamesRegistry class over a simulated chain and a fake indexer

/** A TxView as kaspa-rest-server writes it. */
function toREST(t) {
  return {
    transaction_id: t.idHex,
    is_accepted: true,
    accepting_block_time: Number(t.at),
    payload: t.payload.length ? C.hex(t.payload) : null,
    inputs: t.inputs.map((i, k) => ({ index: k, previous_outpoint_hash: C.hex(i.outpoint.txid), previous_outpoint_index: String(i.outpoint.index), signature_script: C.hex(i.signatureScript) })),
    outputs: t.outputs.map((o, k) => ({
      index: k, amount: Number(o.value), script_public_key: C.hex(o.script),
      covenant_id: o.covenant ? C.hex(o.covenant.covenantId) : null, covenant_authorizing_input: o.covenant ? o.covenant.authorizingInput : null,
    })),
  };
}

function response(status, body) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return { status, ok: status === 200, text: async () => text, json: async () => JSON.parse(text) };
}

function memoryStorage() {
  const map = new Map();
  return { map, get: (k) => map.get(k) ?? null, set: (k, v) => { map.set(k, v); } };
}

async function runRegistryChain(v, r) {
  const { m, visibleUpTo } = simulatedChain(v);
  const { visible, live, transactions } = visibleUpTo(18);
  const restCalls = [];
  const fetch = async (url) => {
    restCalls.push(url);
    const u = new URL(url);
    let mm = u.pathname.match(/^\/addresses\/([^/]+)\/full-transactions$/);
    if (u.origin === "https://rest.test" && mm) return response(200, transactions(decodeURIComponent(mm[1])).map(toREST));
    mm = u.pathname.match(/^\/transactions\/([0-9a-f]+)$/);
    if (u.origin === "https://rest.test" && mm) return response(200, { transaction_id: mm[1], is_accepted: visible.some((t) => t.idHex === mm[1]) });
    return response(404, { error: "not_found" });
  };
  const registryId = C.hex(m.registryCovenantId);
  const getUtxosByAddresses = async (addresses) => {
    r.check(addresses.length <= 50, "node asked for at most 50 addresses");
    return [...live(addresses)].map((op) => {
      const [transactionId, index] = op.split(":");
      return { outpoint: { transactionId, index: Number(index) }, amount: 1n, scriptPublicKey: "", blockDaaScore: 0n, isCoinbase: false, covenantId: registryId };
    });
  };
  const storage = memoryStorage();
  const alphaRef = R.RegistryState.atGenesis(m);
  for (const t of visible) tryApply(alphaRef, t, m);
  const alpha = alphaRef.name("alpha-tn");
  let clock = Number(alpha.expiresAt) - 3_600_000; // an hour before alpha-tn expires
  const deps = { fetch, restBase: () => "https://rest.test/", indexerBase: () => "", getUtxosByAddresses, storage, manifest: m, now: () => clock, log: () => {} };
  const reg = new KachatNamesRegistry(deps);
  let changes = 0;
  reg.onChange(() => { changes += 1; });
  await reg.refresh();
  r.eq(reg.lastError, null, "registry (chain): refresh without error");
  r.eq(reg.source, { kind: "chain" }, "registry (chain): no indexer -> chain walker");
  r.check(changes === 1 && reg.revision === 1, "registry (chain): one change per refresh");
  r.eq(reg.chainState.names.map((n) => n.name), ["alpha-tn"], "registry (chain): walked names");
  r.check(reg.chainState.verifiedAt === BigInt(clock), "registry (chain): verifiedAt set");
  r.check(storage.map.has("kachat-names-registry-testnet-v1"), "registry (chain): cache saved under its key");

  const look = await reg.lookup("Alpha-TN.kachat");
  r.eq(look.kind, "registered", "registry (chain): lookup registered");
  r.eq(look.info?.owner && C.hex(look.info.owner), alpha.owner, "registry (chain): lookup owner");
  const freeLook = await reg.lookup("bravo-tn");
  r.eq(freeLook.kind, "free", "registry (chain): released name is free");
  r.check(freeLook.gap?.contains(C.key("bravo-tn")) === true, "registry (chain): free name's gap");
  let threw = false;
  try { await reg.lookup("bad_name"); } catch { threw = true; }
  r.check(threw, "registry (chain): an invalid name throws");

  const ownerKey = C.unhex32(alpha.owner);
  r.eq((await reg.namesOf(ownerKey)).map((n) => n.name), ["alpha-tn"], "registry (chain): namesOf(owner)");
  r.eq((await reg.namesOf(alpha.owner, true)).map((n) => n.name), ["alpha-tn"], "registry (chain): namesOf(hex, includeInactive)");
  r.eq((await reg.listings()).length, 0, "registry (chain): alpha-tn was sold, so not listed");
  r.eq((await reg.lapsed()).length, 0, "registry (chain): nothing lapsed");
  const hist = await reg.history("alpha-tn");
  // the walker sees transitions of tracked UTXOs only: offers made by others never spend one
  r.eq(hist.map((e) => e.op), ["sale", "list", "transfer", "renew", "register"], "registry (chain): history newest first");
  r.eq((await reg.activity()).length, reg.chainState.events.length, "registry (chain): activity");
  const gaps = await reg.exitGaps(look.info);
  r.check(C.bytesEqual(gaps.below.hi, look.info.key) && C.bytesEqual(gaps.above.lo, look.info.key), "registry (chain): exit gaps around the name");

  const ownerAddress = R.addressOf(ownerKey);
  r.eq(await reg.resolveActive("alpha-tn.kachat"), ownerAddress, "registry (chain): resolveActive -> owner address");
  r.check(ownerAddress.startsWith("kaspatest:q"), "registry (chain): resolved to a kaspatest: P2PK address");
  r.eq(await reg.resolveActive("bravo-tn"), null, "registry (chain): a free name does not resolve");
  r.eq(await reg.resolveActive("not valid!"), null, "registry (chain): an invalid name does not resolve");
  const callsBefore = restCalls.length;
  await reg.refreshIfStale();
  r.eq(restCalls.length, callsBefore, "registry (chain): a fresh registry is not refreshed again");
  clock = Number(alpha.expiresAt) + 1_000; // in grace
  r.eq(await reg.resolveActive("alpha-tn"), null, "registry (chain): a name in grace does not resolve");
  r.eq((await reg.namesOf(ownerKey)).length, 0, "registry (chain): namesOf hides a name in grace");
  r.eq((await reg.namesOf(ownerKey, { includeInactive: true })).length, 1, "registry (chain): includeInactive shows it");
  clock = Number(alpha.expiresAt + m.params.graceMs) + 1_000;
  r.eq((await reg.lapsed()).map((n) => n.name), ["alpha-tn"], "registry (chain): lapsed after grace");
  clock = Number(alpha.expiresAt) - 3_600_000;

  // identity: label from the walked names, own profile only
  const id0 = await reg.identity(ownerAddress.toUpperCase());
  r.eq({ label: id0.label, names: id0.names, profile: id0.profile }, { label: "alpha-tn", names: ["alpha-tn"], profile: null }, "registry (chain): identity");
  await reg.noteOwnProfile({ bio: " hi ", primaryName: "Alpha-TN" }, ownerAddress, "ab".repeat(32));
  const id1 = await reg.identity(ownerAddress);
  r.eq(id1.profile?.bio, "hi", "registry (chain): own profile known");
  const reg1b = new KachatNamesRegistry(deps);
  r.eq((await reg1b.ownProfile(ownerAddress))?.profile.primaryName, "alpha-tn", "registry (chain): own profile persisted");

  // offers this device made are tracked
  const offer = new R.OfferInfo({ outpoint: T.makeOutpoint(new Uint8Array(32).fill(9), 0), key: C.key("alpha-tn"), name: "alpha-tn", buyer: new Uint8Array(32).fill(3), amount: 5n, refundAfter: 10n });
  await reg.trackOffer(offer);
  r.eq((await reg.offersFor("alpha-tn")).map((o) => o.amount), [5n], "registry (chain): tracked offer listed");
  r.eq((await reg.myOffers(new Uint8Array(32).fill(3))).length, 1, "registry (chain): myOffers");

  // a new registry reads the cache instead of walking from genesis
  const reg2 = new KachatNamesRegistry({ ...deps, getUtxosByAddresses: async () => { throw new Error("no node"); } });
  await reg2.prepare();
  r.eq(reg2.chainState?.names.map((n) => n.name), ["alpha-tn"], "registry (chain): cache loaded");
  r.eq(reg2.chainState?.offers.length, 1, "registry (chain): cached tracked offer");
  await reg2.refresh();
  r.check(reg2.lastError != null && reg2.chainState.names.length === 1, "registry (chain): a failed refresh keeps the state and reports the error");
  // a cache for another registry is ignored
  const other = memoryStorage();
  other.set("kachat-names-registry-testnet-v1", storage.map.get("kachat-names-registry-testnet-v1").replace(registryId, "00".repeat(32)));
  const reg3 = new KachatNamesRegistry({ ...deps, storage: other });
  await reg3.prepare();
  r.eq(reg3.chainState?.names.length, 0, "registry (chain): a foreign cache is ignored");

  // concurrent refreshes share one walk
  const reg4 = new KachatNamesRegistry({ ...deps, storage: memoryStorage() });
  await Promise.all([reg4.refresh(), reg4.refresh(), reg4.refresh()]);
  r.eq(reg4.revision, 1, "registry (chain): concurrent refreshes coalesce");
  r.eq(reg4.chainState?.names.length, 1, "registry (chain): coalesced refresh walked");
}

async function runRegistryIndexer(v, r) {
  const m = M.decodeManifest(v.manifest);
  const ownerKey = new Uint8Array(32).fill(0xab);
  const owner = R.addressOf(ownerKey);
  const nowMs = 1_800_000_000_000;
  const nameObj = (name, extra = {}) => ({
    name, key: C.hex(C.key(name)), registered: true, status: "active", owner, ownerKey: C.hex(ownerKey), price: "0",
    expiresAt: nowMs + 1_000_000, outpoint: { txId: "cd".repeat(32), index: 2 }, registeredAt: 1_790_000_000_000, ...extra,
  });
  const seen = [];
  const fetch = async (url) => {
    seen.push(url);
    const u = new URL(url);
    const p = u.pathname;
    if (p === "/names/status") return response(200, { network: "testnet-10", registryCovenantId: C.hex(m.registryCovenantId).toUpperCase(), synced: true });
    if (p === "/names/alice") return response(200, nameObj("alice"));
    if (p === "/names/old") return response(200, nameObj("old", { status: "grace", expiresAt: nowMs - 1 }));
    if (p === "/names/bob") return response(200, { name: "bob", key: "00", registered: false, gap: { lo: "00".repeat(32), hi: "ff".repeat(32), outpoint: { txId: "ee".repeat(32), index: 0 } } });
    if (p === `/names/by-owner/${owner}`) return response(200, { names: [nameObj("zed", { registeredAt: 5 }), nameObj("alice")] });
    if (p === "/market/listings") return response(200, { listings: [nameObj("alice", { price: "700" })], next: null });
    if (p === "/names/alice/history") return response(200, { events: [{ txId: "aa", op: "sale", name: "alice", at: 5, price: "700" }], next: null });
    if (p === "/names/alice/offers") return response(200, { offers: [{ outpoint: { txId: "ef".repeat(32), index: 1 }, buyer: owner, amount: "100", refundAfter: 9, refundable: false }] });
    if (p === `/identity/${owner}`) return response(200, { address: owner, label: "alice", names: ["alice"], profile: { v: 1, bio: " yo " } });
    return response(404, { error: "not_found" });
  };
  const reg = new KachatNamesRegistry({ fetch, restBase: () => "https://rest.test", indexerBase: () => " https://idx.test/ ", getUtxosByAddresses: async () => [], storage: memoryStorage(), manifest: async () => m, now: () => nowMs, log: () => {} });
  await reg.refresh();
  r.eq(reg.source, { kind: "indexer", base: "https://idx.test" }, "registry (indexer): chosen when /names/status matches");
  r.eq(reg.chainState, null, "registry (indexer): no walker state");
  r.eq((await reg.lookup("ALICE")).info?.name, "alice", "registry (indexer): lookup");
  const bob = await reg.lookup("bob");
  r.check(bob.kind === "free" && bob.gap?.contains(C.key("bob")), "registry (indexer): free with its gap");
  r.eq(await reg.resolveActive("alice"), owner, "registry (indexer): resolveActive");
  r.eq(await reg.resolveActive("old"), null, "registry (indexer): grace does not resolve");
  r.eq((await reg.namesOf(ownerKey)).map((n) => n.name), ["zed", "alice"], "registry (indexer): namesOf oldest first");
  r.check(seen.some((u) => u.endsWith(`/names/by-owner/${owner}?includeInactive=false`)), "registry (indexer): by-owner URL");
  r.eq((await reg.listings()).map((n) => n.price), [700n], "registry (indexer): listings");
  r.eq((await reg.history("alice")).map((e) => e.price), [700n], "registry (indexer): history");
  r.eq((await reg.offersFor("alice")).map((o) => o.name), ["alice"], "registry (indexer): offers take the asked name");
  const id = await reg.identity(owner);
  r.eq({ label: id.label, bio: id.profile?.bio }, { label: "alice", bio: "yo" }, "registry (indexer): identity sanitized");
  let msg = "";
  try { await reg.lapsed(); } catch (e) { msg = e.message; }
  r.eq(msg, "not found", "registry (indexer): 404 -> not found");

  // an indexer for another registry is not used
  const reg2 = new KachatNamesRegistry({
    fetch: async () => response(200, { registryCovenantId: "00".repeat(32) }), restBase: () => "https://rest.test", indexerBase: () => "https://idx.test",
    getUtxosByAddresses: async () => [], storage: memoryStorage(), manifest: m, now: () => nowMs, log: () => {},
  });
  await reg2.prepare();
  r.eq(reg2.source, { kind: "chain" }, "registry (indexer): another registry's indexer -> chain walker");
}

// MARK: - Live (read-only TN10 walk)

async function runLive() {
  const base = "https://api-tn10.kaspa.org";
  const m = M.decodeManifest(readFileSync(join(repo, "engine/kachat-names/kachat-names-testnet-10.json"), "utf8"));
  try { M.verifyManifest(m); } catch (e) { console.log(`live: manifest does not verify: ${e.message}`); return false; }
  const getJSON = async (path) => {
    const res = await fetch(base + path, { signal: AbortSignal.timeout(20_000) });
    if (res.status !== 200) throw new C.Failure(`GET ${path}: ${res.status}`);
    return parseJSONExact(await res.text());
  };
  const storage = memoryStorage();
  const reg = new KachatNamesRegistry({
    restBase: () => base,
    indexerBase: () => "",
    // REST fallback for a node: no covenant ids
    getUtxosByAddresses: async (addresses) => {
      const out = [];
      for (const a of addresses) {
        for (const u of await getJSON(`/addresses/${a}/utxos`)) {
          out.push({ outpoint: { transactionId: u.outpoint.transactionId, index: Number(u.outpoint.index) }, covenantId: u.utxoEntry?.covenantId ?? null });
        }
      }
      return out;
    },
    storage,
    manifest: m,
    log: (...a) => console.log("  log:", ...a),
  });
  const t0 = Date.now();
  await reg.refresh();
  if (reg.lastError) {
    const network = /fetch failed|aborted|timeout|ENOTFOUND|ECONNRE|EAI_AGAIN|: 5\d\d$/i.test(reg.lastError);
    console.log(`live walk failed: ${reg.lastError}${network ? ` (${base} unreachable; not counted)` : ""}`);
    return network;
  }
  const st = reg.chainState;
  try { st.checkInvariants(); } catch (e) { console.log(`live: invariants: ${e.message}`); return false; }
  console.log(`live TN10 registry ${C.hex(m.registryCovenantId).slice(0, 16)}...: ${Date.now() - t0} ms, ${st.applied.length - 1} transaction(s) walked, ${st.gaps.length} gap(s), ${st.names.length} name(s), ${st.events.length} event(s), cache ${storage.map.get("kachat-names-registry-testnet-v1")?.length ?? 0} bytes; walk ${reg.lastWalk.rounds} round(s), unresolved ${reg.lastWalk.unresolved.length}`);
  for (const g of st.gaps) console.log(`  gap ${g.lo.slice(0, 8)}..-${g.hi.slice(0, 8)}.. at ${g.txid.slice(0, 16)}:${g.index}`);
  for (const n of st.names) {
    const status = R.Status.of(n.expiresAt, m.params.graceMs, BigInt(Date.now()));
    console.log(`  name ${n.name}.kachat owner ${R.addressOf(C.unhex32(n.owner))} price ${n.price} expires ${new Date(Number(n.expiresAt)).toISOString()} (${status}) at ${n.txid.slice(0, 16)}:${n.index}`);
    console.log(`    resolveActive -> ${await reg.resolveActive(n.name)}`);
  }
  for (const e of st.events) console.log(`  event ${e.op} ${e.name ?? "?"} ${e.txId.slice(0, 16)}`);
  // the REST parser on the live API: the genesis transaction through the genesis gap's address
  const genesisAddress = R.p2shAddress(m.genesisOutput.script);
  let txs;
  try { txs = await reg.restTransactions(genesisAddress); } catch (e) {
    console.log(`  REST full-transactions failed: ${e.message} (not counted)`);
    return true;
  }
  const g = txs.find((t) => t.idHex === C.hex(m.genesisTxid));
  const ok = !!g && g.outputs[0].covenant != null && C.bytesEqual(g.outputs[0].covenant.covenantId, m.registryCovenantId) && C.bytesEqual(g.outputs[0].script, m.genesisOutput.script);
  console.log(`  REST full-transactions of ${genesisAddress}: ${txs.length} tx(s); genesis parsed with its covenant binding: ${ok}`);
  return ok;
}

async function main() {
  const args = process.argv.slice(2);
  const live = args.includes("--live");
  const path = args.find((a) => !a.startsWith("--")) ?? join(repo, "tools/fixtures/kachat-names-vectors.json");
  const v = JSON.parse(readFileSync(path, "utf8"));
  const r = new Report();
  runRules(r);
  console.log(`rules: ${r.pass} pass, ${r.fail} fail`);
  runREST(r);
  console.log(`+ REST, addresses and indexer shapes: ${r.pass} pass, ${r.fail} fail`);
  runWalker(v, r);
  console.log(`+ walker over the vectors: ${r.pass} pass, ${r.fail} fail`);
  await runWalk(v, r);
  console.log(`+ walk over a simulated chain: ${r.pass} pass, ${r.fail} fail`);
  await runRegistryChain(v, r);
  console.log(`+ KachatNamesRegistry over the simulated chain: ${r.pass} pass, ${r.fail} fail`);
  await runRegistryIndexer(v, r);
  console.log(`+ KachatNamesRegistry over a fake indexer: ${r.pass} pass, ${r.fail} fail`);
  for (const f of r.failures.slice(0, 40)) console.log(`  FAIL ${f}`);
  let ok = r.fail === 0;
  if (live) ok = (await runLive()) && ok;
  if (!ok) process.exit(1);
  console.log("OK");
}

await main();
