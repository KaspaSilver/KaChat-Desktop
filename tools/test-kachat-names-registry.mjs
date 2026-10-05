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
import {
  KachatNamesRegistry, parseJSONExact, KachatSocialImageResolver, socialImageCachePrefix,
  ownProfileStorageKey, ownProfileKeyPrefixFor, profilesUnavailablePauseMs, profileMissPauseMs,
} from "../engine/kachat-names/registry.js";

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

/** The vectors' end-to-end plan (README "The end-to-end run", registry v3), after both geneses:
 *  commits, three registrations, a price change, extend, renew, another price change, transfer,
 *  list, buy, four offers (accept, decline, refund, withdraw), release, reclaim. The steps after
 *  it are edge cases on their own synthetic records. */
const e2eCount = 23;

/** A step's price shard records: `shard` (register, extend, renew) or `shards` (a price change). */
function shardRecords(rec) {
  if (rec.shard) return [rec.shard];
  return Array.isArray(rec.shards) ? rec.shards : [];
}

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
      r.eq(found.periodStart, u64(n.periodStart), `${label}: periodStart`);
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
      r.eq(found.seller, s(o.seller), `${label}: offer seller`);
      r.eq(found.refundAfter, u64(o.refundAfter), `${label}: offer refundAfter`);
      r.eq(found.value, u64(o.value), `${label}: offer value`);
    }
  }
  for (const sh of shardRecords(rec)) {
    const found = state.shards.find((x) => `${x.txid}:${x.index}` === outpointKey(sh.utxo));
    r.check(!!found, `${label}: price shard ${sh.shard} at ${outpointKey(sh.utxo).slice(0, 16)} not in the walked state`);
    if (found) {
      r.eq(found.shard, u64(sh.shard), `${label}: shard index`);
      r.eq(found.authority, s(sh.authority), `${label}: shard authority`);
      r.eq(found.prices, sh.prices.map(u64), `${label}: shard prices`);
      r.eq(found.value, u64(sh.value), `${label}: shard value`);
    }
  }
}

/** A state holding exactly a step's records (the edge cases run on synthetic registry UTXOs). */
function seeded(st, m) {
  const state = R.RegistryState.atGenesis(m);
  state.gaps = [];
  state.shards = [];
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
      price: u64(n.price), periodStart: u64(n.periodStart), expiresAt: u64(n.expiresAt), value: u64(n.value), registeredAt: null, registeredTxId: null, updatedAt: null,
    });
  }
  if (rec.offer) {
    const o = rec.offer;
    state.offers.push({
      txid: s(o.utxo.txid), index: Number(o.utxo.index), key: s(o.key), buyer: s(o.buyer), seller: s(o.seller), refundAfter: u64(o.refundAfter),
      value: u64(o.value), name: typeof o.name === "string" ? o.name : null, createdAt: null,
    });
  }
  for (const sh of shardRecords(rec)) {
    state.shards.push({
      txid: s(sh.utxo.txid), index: Number(sh.utxo.index), shard: u64(sh.shard), authority: s(sh.authority),
      prices: sh.prices.map(u64), value: u64(sh.value),
    });
  }
  return state;
}

function tryApply(state, tx, m) { try { return state.apply(tx, m); } catch { return null; } }

function runWalker(v, r) {
  const m = M.decodeManifest(v.manifest);
  const steps = v.steps;
  const e2e = steps.slice(0, e2eCount);
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
    "register alpha-tn", "register bravo-tn", "register lapse-tn", "prices ?", "extend alpha-tn", "renew lapse-tn", "prices ?",
    "transfer alpha-tn", "list alpha-tn", "sale alpha-tn", "offer bravo-tn", "offer_accepted bravo-tn", "offer_accept bravo-tn",
    "offer alpha-tn", "offer_decline alpha-tn", "offer alpha-tn", "offer_refund alpha-tn",
    "offer alpha-tn", "offer_withdraw alpha-tn", "release bravo-tn", "reclaim lapse-tn",
  ], "e2e events");
  r.eq(state.names.map((n) => n.name), ["alpha-tn"], "names left after the e2e plan");
  r.eq(state.gaps.length, 2, "gaps left after the e2e plan");
  r.eq(state.offers.length, 0, "offers left after the e2e plan");
  // the price record: all K shards, carried through every register / extend / renew, at the
  // last change's prices
  const lastChange = [...e2e].reverse().find((x) => x.op === "setPrices").args;
  const K = Number(m.params.priceShards);
  r.eq(state.shards.length, K, "every price shard tracked");
  r.eq(state.currentPrices?.prices, lastChange.prices.map(u64), "current prices = the last change's");
  r.eq(state.currentPrices && C.hex(state.currentPrices.authority), s(lastChange.newAuthority), "current authority");
  r.eq(state.shardInfos.map((x) => x.shard), [...Array(K).keys()].map(BigInt), "shards in order");
  r.eq(state.events.filter((e) => e.op === "prices").map((e) => e.price), [70_000_000n, 35_000_000n], "price events carry the 5+ price");
  const accepted = state.events.find((e) => e.op === "offer_accepted");
  const payout = accepted?.price ?? 0n;
  r.check(payout > 9n * 100_000_000n && payout < 10n * 100_000_000n, `accepted offer payout is the offer less the fee (${payout})`);
  const alpha = state.name("alpha-tn");
  r.check(alpha?.registeredTxId === C.hex(hx(e2e[3].expected.txid)), "registration tx carried through every transition");
  r.eq(alpha?.registeredAt, 1_003n, "registration time carried through every transition");
  const alphaRegister = e2e[3].args;
  r.eq(alpha?.periodStart, u64(alphaRegister.now), "alpha-tn: periodStart = register's now, kept by extend, transfer, list and buy");
  r.eq(alpha?.expiresAt, u64(alphaRegister.now) + 2n * m.params.periodMs, "alpha-tn: registered for 1 period, extended by 1");
  r.eq(m.params.periodMs, 600_000n, "testnet vectors run the 10-minute clock");
  // applying again changes nothing
  const snapshot = state.clone();
  e2e.forEach((st, i) => tryApply(state, view(st, 1_000 + i), m));
  r.check(state.equals(snapshot), "re-applying is a no-op");
  // the cache format round-trips
  r.check(R.RegistryState.fromJSON(JSON.stringify(state.toJSON())).equals(state), "cache JSON round trip");

  // the edge cases, each on a state seeded with its own records
  for (const st of steps.slice(e2eCount)) {
    const seededState = seeded(st, m);
    const label = s(st.label);
    const before = st.records.name ? { periodStart: u64(st.records.name.periodStart), expiresAt: u64(st.records.name.expiresAt) } : null;
    try {
      const events = seededState.apply(view(st, 5), m);
      const op = s(st.op);
      if (op === "commit" || op === "cancelCommit") r.check(events.length === 0, `${label}: not a registry transaction`);
      else r.check(events.length > 0, `${label}: no events`);
      switch (op) {
        case "register":
          r.eq(seededState.names.length, 1, `${label}: name created`); r.eq(seededState.gaps.length, 2, `${label}: gaps split`);
          r.eq(seededState.shards.length, 1, `${label}: the shard came back`);
          break;
        case "reclaim": r.eq(seededState.names.length, 0, `${label}: name gone`); r.eq(seededState.gaps.length, 1, `${label}: gaps merged`); break;
        case "acceptOffer": case "declineOffer": r.eq(seededState.offers.length, 0, `${label}: offer gone`); break;
        case "setPrices": {
          const a = st.args;
          const K = Number(m.params.priceShards);
          r.eq(seededState.shards.length, K, `${label}: every shard continues`);
          r.eq(seededState.currentPrices?.prices, a.prices.map(u64), `${label}: new prices`);
          r.eq(seededState.shardInfos.map((x) => x.shard), [...Array(K).keys()].map(BigInt), `${label}: each shard once, in order`);
          r.eq([...new Set(seededState.shards.map((x) => x.authority))], [s(a.newAuthority)], `${label}: every shard at the new authority`);
          break;
        }
        case "extend":
        case "renew": {
          const years = u64(st.args.years);
          const after = seededState.names[0];
          r.eq(events[0]?.op, op, `${label}: event`);
          r.eq(events[0]?.years, years, `${label}: event years`);
          r.eq(after?.expiresAt, before ? before.expiresAt + years * m.params.periodMs : null, `${label}: expiresAt + periods`);
          r.eq(seededState.shards.length, 1, `${label}: the shard came back`);
          // extend keeps the period; renew starts the next one at the old expiry
          r.eq(after?.periodStart, op === "extend" ? before?.periodStart : before?.expiresAt, `${label}: periodStart`);
          break;
        }
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
  // the price record: a shard continuation at another state, or a change missing a shard
  const stReg = R.RegistryState.atGenesis(m);
  for (const st of steps.slice(0, 3)) tryApply(stReg, view(st, 1), m);
  const beforeReg = stReg.clone();
  const shardTamper = view(reg, 2);
  shardTamper.outputs[3].script[5] ^= 0x01;
  r.check(tryApply(stReg, shardTamper, m) === null, "a register whose shard continuation holds another state was accepted");
  const shardOther = view(reg, 2);
  shardOther.outputs[3].covenant.covenantId = m.registryCovenantId;
  r.check(tryApply(stReg, shardOther, m) === null, "a shard continuation under the registry id was accepted");
  r.check(stReg.equals(beforeReg), "refused shard spends left the state alone");
  const stPrices = R.RegistryState.atGenesis(m);
  for (const st of steps.slice(0, 6)) tryApply(stPrices, view(st, 1), m);
  const beforePrices = stPrices.clone();
  const changeTamper = view(steps[6], 7);
  changeTamper.outputs[5].script[5] ^= 0x01;
  r.check(tryApply(stPrices, changeTamper, m) === null, "a price change with one shard at other prices was accepted");
  const changeDropped = view(steps[6], 7);
  changeDropped.outputs.splice(7, 1);
  r.check(tryApply(stPrices, changeDropped, m) === null, "a price change missing a shard continuation was accepted");
  r.check(stPrices.equals(beforePrices), "refused price changes left the state alone");
  // an unrelated transaction is ignored
  r.eq(tryApply(st0, view(steps[0], 1), m)?.length, 0, "a commit is not a registry transaction");
}

/** The simulated chain of the e2e transactions: scripts by outpoint and spends. */
function simulatedChain(v) {
  const m = M.decodeManifest(v.manifest);
  const steps = v.steps.slice(0, e2eCount);
  const txs = steps.map((st, i) => view(st, 1_000 + i));
  const created = new Map(); // outpoint -> script
  const spentBy = new Map(); // outpoint -> txid
  for (const t of txs) {
    t.outputs.forEach((o, k) => created.set(`${t.idHex}:${k}`, o.script));
    for (const i of t.inputs) spentBy.set(`${C.hex(i.outpoint.txid)}:${i.outpoint.index}`, t.idHex);
  }
  // the genesis gap lives at the manifest's genesis outpoint, the shards at the price genesis
  created.set(`${C.hex(m.genesisTxid)}:0`, m.genesisOutput.script);
  m.genesisShards.forEach((sh, i) => created.set(`${C.hex(m.priceGenesisTxid)}:${i}`, sh.output.script));
  const addr = (script) => R.addressFromScriptPublicKey(script, "kaspatest");
  const visibleUpTo = (upTo) => {
    const visible = txs.slice(0, upTo);
    const visibleIds = new Set(visible.map((t) => t.idHex));
    const live = (addresses) => {
      const out = new Set();
      for (const [op, script] of created) {
        if (addresses.includes(addr(script) ?? "")
          && (op.startsWith(C.hex(m.genesisTxid)) || op.startsWith(C.hex(m.priceGenesisTxid)) || visibleIds.has(op.slice(0, 64)))
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
  for (const upTo of [3, 6, 7, 8, 10, 11, 17, e2eCount]) {
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
      r.eq(ops(walked.shards), ops(reference.shards), `walk to ${upTo}: shard outpoints`);
      r.eq(walked.currentPrices, reference.currentPrices, `walk to ${upTo}: prices`);
      r.eq(ops(walked.offers), ops(reference.offers), `walk to ${upTo}: offers`);
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
    avatar: " x.com/KaspaCurrency/ ", banner: "youtube.com/@KaspaCurrency", bio: "instagram.com/instagram",
    linktree: "https://www.linktr.ee/kaspa?utm=1", primaryName: "Alice.kachat",
  });
  const clean = p.sanitized();
  r.eq(clean.avatar, "https://x.com/KaspaCurrency", "profile: avatar source normalized");
  r.eq(clean.banner, "https://www.youtube.com/@KaspaCurrency", "profile: banner from another account");
  r.eq(clean.bio, null, "profile: a bio source on a platform without bios is dropped");
  r.eq(clean.linktree, "https://linktr.ee/kaspa", "profile: Linktree link normalized");
  r.eq(clean.primaryName, "alice", "profile: primary name normalized");
  const other = new R.Profile({ avatar: "https://example.com/me", banner: "instagram.com/instagram", linktree: "https://example.com/links" });
  r.check(R.profileEqual(other.sanitized(), new R.Profile()), "profile: unsupported social site and non-Linktree link dropped");
  const json = p.recordJSON();
  r.check(C.utf8(json).length <= 2048, "profile JSON within 2 KB");
  r.eq(json, "{\"avatar\":\"https://x.com/KaspaCurrency\",\"banner\":\"https://www.youtube.com/@KaspaCurrency\",\"linktree\":\"https://linktr.ee/kaspa\",\"primaryName\":\"alice\",\"v\":1}", "profile JSON compact with sorted keys");
  r.check(R.profileEqual(R.Profile.parse(json), clean), "profile JSON round trip");
  r.check(R.profileEqual(R.Profile.parse("{\"v\":1,\"displayName\":\"x\",\"bio\":\"free text\",\"avatar\":\"ftp://a\"}"), new R.Profile()), "profile: free text, display names and bad links dropped");
  r.eq(R.Profile.parse("{\"v\":2}"), null, "profile: only v 1");
  r.eq(R.Profile.parse("{\"avatar\":\"https://a/b\"}"), null, "profile: v is required");
  r.check(R.profileEqual(R.Profile.parse("{\"v\":1,\"links\":{\"x\":\"@me\"},\"bio\":\"t.me/telegram\"}"), new R.Profile({ bio: "https://t.me/telegram" })), "profile: the old links object is ignored");
  r.eq(R.Profile.parse("{\"v\":1,\"linktree\":5}"), null, "profile: a non-string field does not decode");
  let threw = false;
  try { new R.Profile({ primaryName: "a".repeat(40) }).recordJSON(); } catch { threw = true; }
  r.check(!threw, "profile: an invalid primary name is dropped, not refused");

  // what a social link shows
  const SS = R.SocialSource;
  r.eq(SS.decodeEntities("a &amp; b &#39;c&#x27; &#064;d &quot;e&quot; &amp;#39;"), "a & b 'c' @d \"e\" &#39;", "entities decoded one level");
  const html = "<meta property=\"og:image\" content=\"https://pbs.twimg.com/profile_images/1/a_200x200.jpg\"/><meta property=\"og:description\" content=\"Builder &amp; miner\"/>";
  r.eq(SS.xAvatar(SS.openGraphImage(html)), "https://pbs.twimg.com/profile_images/1/a_400x400.jpg", "X avatar upgraded to 400px");
  r.eq(SS.bio("x", SS.openGraphDescription(html)), "Builder & miner", "X bio from og:description");
  r.eq(SS.bio("twitch", "Speedruns — Twitch streams live on Twitch!"), "Speedruns", "Twitch boilerplate cut");
  r.eq(SS.bio("instagram", "687M Followers, 305 Following"), null, "no bio from Instagram's counts");
  r.eq(SS.bio("x", "b".repeat(400))?.length, 280, "bio cut to 280");
  const gh = SS.githubProfile("{\"avatar_url\":\"https://avatars.githubusercontent.com/u/1\",\"bio\":\" hi \"}");
  r.check(gh.avatar === "https://avatars.githubusercontent.com/u/1" && gh.bio === "hi", "GitHub avatar and bio");
  const fx = SS.fxTwitterProfile("{\"code\":200,\"user\":{\"avatar_url\":\"https://pbs.twimg.com/profile_images/1/a_normal.jpg\",\"banner_url\":\"https://pbs.twimg.com/profile_banners/9/8\",\"description\":\"hi\"}}");
  r.eq(fx, new R.SocialProfile({ avatar: "https://pbs.twimg.com/profile_images/1/a_400x400.jpg", banner: "https://pbs.twimg.com/profile_banners/9/8/1500x500", bio: "hi" }), "FxTwitter: avatar 400px, banner 1500x500, bio");
  r.eq(SS.fxTwitterProfile("{\"code\":404,\"message\":\"NOT_FOUND\"}"), new R.SocialProfile(), "FxTwitter: unknown account answers empty");
  r.eq(SS.fxTwitterProfile("{\"code\":500}"), null, "FxTwitter: an error means fall back");
  r.eq(SS.fromLink("instagram.com/instagram", "bio"), null, "no bio source on Instagram");
  r.eq(SS.from("x", "@KaspaCurrency", "avatar")?.link, "https://x.com/KaspaCurrency", "X handle with @");
  r.eq(SS.from("youtube", "MrBeast", "banner")?.link, "https://www.youtube.com/@MrBeast", "YouTube handle");
  r.eq(SS.from("tiktok", "tiktok", "avatar")?.link, "https://www.tiktok.com/@tiktok", "TikTok handle");
  r.eq(SS.from("linkedin", "company/linkedin", "avatar")?.link, "https://www.linkedin.com/company/linkedin", "LinkedIn company path");
  r.eq(SS.from("discord", "discord-developers", "bio")?.link, "https://discord.gg/discord-developers", "Discord invite code");
  const pasted = SS.from("x", "https://www.youtube.com/@MrBeast", "avatar");
  r.check(pasted?.platform === "youtube" && pasted?.displayHandle === "MrBeast", "a pasted link switches platform");
  r.eq(SS.from("instagram", "instagram", "banner"), null, "no banner from Instagram");
  r.eq(SS.from("x", "bad handle!", "avatar"), null, "invalid handle refused");
  r.eq(R.Profile.linktreeLinkFromUsername("kaspa"), "https://linktr.ee/kaspa", "Linktree from a username");
  r.eq(R.Profile.linktreeLinkFromUsername("@kaspa "), "https://linktr.ee/kaspa", "Linktree from @username");
  r.eq(R.Profile.linktreeLinkFromUsername("https://linktr.ee/kaspa"), "https://linktr.ee/kaspa", "Linktree from a pasted link");
  r.eq(R.Profile.linktreeLinkFromUsername("kas pa"), null, "Linktree username with a space refused");
  r.eq(R.Profile.linktreeUsername("https://linktr.ee/kaspa"), "kaspa", "Linktree username shown back");
  r.check(SS.fromLink("t.me/telegram", "bio") != null, "bio source on Telegram");
  r.eq(SS.discordDescription("{\"guild\":{\"id\":\"1\",\"description\":\"Devs\"}}"), "Devs", "Discord server description");

  // desktop extras: the rest of the link rules, per-field platforms, the page readers
  const P = R.SocialPlatform;
  r.eq([...P.choices("banner")], ["x", "youtube", "discord"], "banner platforms");
  r.eq([...P.choices("bio")], ["x", "youtube", "telegram", "twitch", "kick", "github", "discord"], "bio platforms");
  r.eq(P.choices("avatar").length, 11, "every platform can fill the avatar");
  r.check(P.all.every((x) => P.prefix(x) && P.displayName(x)), "every platform has a prefix and a name");
  const links = {
    "twitter.com/jack": "https://x.com/jack", "https://mobile.twitter.com/jack?s=20": "https://x.com/jack",
    "m.youtube.com/channel/UC123": "https://www.youtube.com/channel/UC123", "fb.com/zuck": "https://www.facebook.com/zuck",
    "instagram.com/nasa/": "https://www.instagram.com/nasa/", "twitch.tv/twitch": "https://www.twitch.tv/twitch",
    "kick.com/xqc": "https://kick.com/xqc", "github.com/torvalds": "https://github.com/torvalds",
    "telegram.me/durov": "https://t.me/durov", "linkedin.com/in/someone": "https://www.linkedin.com/in/someone",
    "https://discord.com/invite/abc": "https://discord.gg/abc",
  };
  for (const [raw, want] of Object.entries(links)) r.eq(SS.fromLink(raw, "avatar")?.link ?? null, want, `link ${raw}`);
  for (const raw of ["x.com/home", "x.com/jack/status/1", "instagram.com/p/abc", "t.me/+invite", "tiktok.com/tiktok", "facebook.com/profile.php", "example.com/jack", "javascript:alert(1)", ""]) {
    r.eq(SS.fromLink(raw, "avatar"), null, `not a profile: ${raw || "(empty)"}`);
  }
  const yt = SS.fromLink("youtube.com/channel/UC123", "avatar");
  r.eq(SS.from("youtube", yt.displayHandle, "avatar")?.link, "https://www.youtube.com/channel/UC123", "a YouTube channel path shown back maps to itself");
  r.eq(SS.from("linkedin", "someone", "avatar")?.displayHandle, "someone", "LinkedIn handle shown without in/");
  r.eq(SS.openGraphImage("<meta content='https://a.example/i.png' name='twitter:image'><meta property=\"og:image\" content=\"http://insecure/x.png\">"), "https://a.example/i.png", "og:image: http skipped, twitter:image used");
  r.eq(SS.openGraphDescription("<meta property=\"og:description\" content=\"   \"><META NAME=\"Description\" content=\"  Hello &#x1F600; \">"), "Hello \u{1F600}", "description: a blank og:description skipped, any case, entities, trimmed");
  r.eq(SS.openGraphImage(`<meta${" a".repeat(100_000)}`), null, "an unterminated tag is not read");
  r.eq(SS.xBanner("x \"profile_banners/123/456\" y"), "https://pbs.twimg.com/profile_banners/123/456/1500x500", "X banner from the page");
  r.eq(SS.youtubeBanner("\"imageBannerViewModel\" ... \"imageBannerViewModel\":{\"image\":{\"sources\":[{\"url\":\"https://yt3.googleusercontent.com/abc=w1060\""), "https://yt3.googleusercontent.com/abc=w1060", "YouTube banner from the page");
  const invite = { guild: { id: "613425648685547541", icon: "a_1d18", banner: null, description: " Devs " } };
  r.eq(SS.discordImage(invite, "avatar"), "https://cdn.discordapp.com/icons/613425648685547541/a_1d18.png?size=256", "Discord server icon");
  r.eq(SS.discordImage(invite, "banner"), null, "Discord: no banner");
  r.eq(SS.discordImage({ guild: { id: "1/../x", icon: "a" } }, "avatar"), null, "Discord: an odd id refused");
  r.check(new R.SocialProfile().isEmpty && !new R.SocialProfile({ bio: "x" }).isEmpty, "SocialProfile.isEmpty");

  const k = C.concat(new Uint8Array(31).fill(0x10), [0x00]);
  r.eq(C.hex(R.step(k, -1)), C.hex(C.concat(new Uint8Array(30).fill(0x10), [0x0f, 0xff])), "key - 1 borrows");
  r.eq(C.hex(R.step(k, 1)), C.hex(C.concat(new Uint8Array(31).fill(0x10), [0x01])), "key + 1");
  // the paid period on a NameInfo (mainnet's clock: a year, a 10-day window)
  const params = {
    bond: 1n, gapValue: 1n, tCommit: 600n, maxYears: 2n, periodMs: C.yearMs, graceMs: g, renewWindowMs: 864_000_000n,
    genesisPrices: [1n, 1n, 1n, 1n, 1n], priceShards: 8n, priceValue: 100_000_000n, offerMaxFee: 1n,
  };
  const period = info("period", now + C.yearMs, 1n);
  r.eq(period.extendableYears(params), 0n, "period unknown: no extend");
  r.eq(period.fields, null, "period unknown: no on-chain state");
  period.periodStart = now;
  r.eq(period.extendableYears(params), 1n, "1 year paid of 2: extend by 1");
  r.eq(period.fields?.periodStart, now, "fields carry periodStart");
  r.check(!period.renewOpen(params, now), "renewal closed a year before expiry");
  r.eq(period.renewOpens(params), now + C.yearMs - 864_000_000n, "renewal opens 10 days before expiry");
  r.check(period.renewOpen(params, now + C.yearMs - 864_000_000n), "renewal open at the opening");
  period.expiresAt = now + 2n * C.yearMs;
  r.eq(period.extendableYears(params), 0n, "2 years paid: no extend");
  // testnet's 10-minute clock
  const tn = {
    bond: 1n, gapValue: 1n, tCommit: 600n, maxYears: 2n, periodMs: 600_000n, graceMs: 600_000n, renewWindowMs: 600_000n,
    genesisPrices: [1n, 1n, 1n, 1n, 1n], priceShards: 8n, priceValue: 100_000_000n, offerMaxFee: 1n,
  };
  const short = info("short", now + 600_000n, 1n);
  short.periodStart = now;
  r.eq(short.extendableYears(tn), 1n, "10 min paid of 20: extend by 1");
  r.check(short.renewOpen(tn, now), "a 1-period name's window is open at once on the short clock");
  short.expiresAt = now + 1_200_000n;
  r.eq(short.extendableYears(tn), 0n, "20 min paid: no extend");
  r.check(!short.renewOpen(tn, now), "renewal closed 20 min before expiry");

  // offers: declined once the name has another owner
  const seller = new Uint8Array(32).fill(3);
  const offer = new R.OfferInfo({ outpoint: T.makeOutpoint(C.zero32(), 0), key: C.key("x"), name: "x", buyer: me, seller, amount: 5n, refundAfter: 100n });
  r.check(!offer.isDeclined(seller), "an offer to the current owner stands");
  r.check(offer.isDeclined(me), "an offer to an earlier owner is declined");
  r.eq(offer.fields.seller, seller, "offer fields carry the seller");

  // a cache written before registry v3 (format 1 or 2: no shards, offers without a seller) is dropped
  const v1Cache = `{"v":1,"network":"testnet-10","registryCovenantId":"00","verifiedAt":null,"gaps":[],"names":[["00",0,"a","00","00","0","1","1",null,null,null]],"offers":[],"applied":[],"events":[]}`;
  r.check((() => { try { R.RegistryState.fromJSON(v1Cache); return false; } catch { return true; } })(), "a registry v1 cache does not decode");
  const v2Cache = `{"v":2,"network":"testnet-10","registryCovenantId":"00","verifiedAt":null,"gaps":[],"names":[],"offers":[],"applied":[],"events":[]}`;
  r.check((() => { try { R.RegistryState.fromJSON(v2Cache); return false; } catch { return true; } })(), "a registry v2 cache does not decode");
  r.eq(R.RegistryState.formatVersion, 3, "cache format 3 (registry v3)");

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
  r.eq(n?.periodStart, null, "indexer without periodStart: unknown");
  const withPeriod = JSON.parse(`{"name":"alice","registered":true,"ownerKey":"${"ab".repeat(32)}","price":"0","periodStart":1790000000000,
    "expiresAt":1822000000000,"outpoint":{"txId":"${"cd".repeat(32)}","index":0}}`);
  const np = R.IndexerAPI.nameInfo(withPeriod, () => null);
  r.eq(np?.periodStart, 1_790_000_000_000n, "indexer periodStart");
  r.eq(np?.fields?.periodStart, 1_790_000_000_000n, "indexer record spendable with its periodStart");
  const free = JSON.parse(`{"name":"bob","key":"00","registered":false,"gap":{"lo":"${"00".repeat(32)}","hi":"${"ff".repeat(32)}","outpoint":{"txId":"${"ee".repeat(32)}","index":0}}}`);
  const f = R.IndexerAPI.nameJSON(free);
  r.check(R.IndexerAPI.nameInfo(f, () => null) === null, "indexer free name has no record");
  r.check(f.gap?.contains(C.key("bob")) === true, "indexer gap decoded");
  let threw = false;
  try { R.IndexerAPI.nameJSON({ name: 5 }); } catch { threw = true; }
  r.check(threw, "indexer: a malformed name object throws");

  // registry v3: offers carry the seller; an indexer without it gives no offer
  const ab = "ab".repeat(32), cd = "cd".repeat(32);
  const keyOfFake = (a) => (a === "kaspatest:buyer" ? C.unhex32(ab) : a === "kaspatest:seller" ? C.unhex32(cd) : null);
  const o = R.IndexerAPI.offerInfo(JSON.parse(`{"outpoint":{"txId":"${cd}","index":0},"buyer":"kaspatest:buyer","seller":"kaspatest:seller","amount":"500000000","refundAfter":7,"name":"alice"}`), null, keyOfFake);
  r.eq(o && C.hex(o.seller), cd, "indexer offer seller");
  r.eq(o?.amount, 500_000_000n, "indexer offer amount");
  r.eq(R.IndexerAPI.offerInfo(JSON.parse(`{"outpoint":{"txId":"${cd}","index":0},"buyer":"kaspatest:buyer","amount":"500000000","refundAfter":7,"name":"alice"}`), null, keyOfFake), null, "an offer without a seller is dropped");
  const pj = R.IndexerAPI.prices(JSON.parse(`{"prices":["1","2","3","4","5"],"authority":"${ab}","shards":[{"shard":0,"outpoint":{"txId":"${cd}","index":0},"authority":"${ab}","prices":["1","2","3","4","5"],"value":"100000000"},
     {"shard":1,"outpoint":{"txId":"${cd}","index":1},"authority":"${ab}","prices":["1","2","3"],"value":"100000000"}]}`));
  r.eq(pj.shards.map((x) => x.shard), [0n], "indexer shards: a malformed one dropped");
  r.eq(pj.shards[0] && C.priceFieldsPrice(pj.shards[0].fields, 9), 5n, "indexer shard price for a long name");
  r.eq(R.IndexerAPI.status({ network: "testnet-10", priceCovenantId: ab }).priceCovenantId, ab, "indexer status: the price covenant id");
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
  const { visible, live, transactions } = visibleUpTo(e2eCount);
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
  const priceId = C.hex(m.priceCovenantId);
  // the covenant id a node reports per outpoint: gaps and names the registry's, shards the price
  // covenant's (registry v3), offers none
  const covenantOf = new Map();
  covenantOf.set(`${C.hex(m.genesisTxid)}:0`, registryId);
  m.genesisShards.forEach((_, i) => covenantOf.set(`${C.hex(m.priceGenesisTxid)}:${i}`, priceId));
  for (const t of visible) t.outputs.forEach((o, k) => covenantOf.set(`${t.idHex}:${k}`, o.covenant ? C.hex(o.covenant.covenantId) : null));
  let shardIdsSeen = 0;
  const getUtxosByAddresses = async (addresses) => {
    r.check(addresses.length <= 50, "node asked for at most 50 addresses");
    return [...live(addresses)].map((op) => {
      const [transactionId, index] = op.split(":");
      const covenantId = covenantOf.get(op) ?? null;
      if (covenantId === priceId) shardIdsSeen += 1;
      return { outpoint: { transactionId, index: Number(index) }, amount: 1n, scriptPublicKey: "", blockDaaScore: 0n, isCoinbase: false, covenantId };
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
  r.check(shardIdsSeen > 0, "registry (chain): the node reported price shards with the price covenant id");
  r.eq(reg.lastWalk?.unresolved, [], "registry (chain): live shards (price covenant id) are not taken for spent");
  r.eq(reg.chainState.shards.length, Number(m.params.priceShards), "registry (chain): every price shard walked");
  // the price record (registry v3)
  const lastChange = [...v.steps.slice(0, e2eCount)].reverse().find((x) => x.op === "setPrices").args;
  r.eq((await reg.shards()).map((x) => x.shard), [...Array(Number(m.params.priceShards)).keys()].map(BigInt), "registry (chain): shards() in order");
  r.eq(reg.cachedPrices, lastChange.prices.map(u64), "registry (chain): cachedPrices from the walked shards");
  r.eq((await reg.currentPrices())?.prices, lastChange.prices.map(u64), "registry (chain): currentPrices = the last change's");
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
  r.eq(hist.map((e) => e.op), ["sale", "list", "transfer", "extend", "register"], "registry (chain): history newest first");
  r.eq(look.info?.periodStart, alpha.periodStart, "registry (chain): lookup carries periodStart");
  r.eq(look.info?.fields?.periodStart, alpha.periodStart, "registry (chain): a walked record is spendable (fields)");
  r.eq(look.info?.extendableYears(m.params), 0n, "registry (chain): alpha-tn holds 2 paid years: no extend");
  r.eq((await reg.activity()).length, reg.chainState.events.filter((e) => !e.op.startsWith("price")).length, "registry (chain): activity");
  r.check((await reg.activity()).every((e) => !e.op.startsWith("price")), "registry (chain): activity leaves out price changes");
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
  await reg.noteOwnProfile({ bio: " t.me/telegram ", primaryName: "Alpha-TN" }, ownerAddress, "ab".repeat(32));
  const id1 = await reg.identity(ownerAddress);
  r.eq(id1.profile?.bio, "https://t.me/telegram", "registry (chain): own profile known");
  const reg1b = new KachatNamesRegistry(deps);
  r.eq((await reg1b.ownProfile(ownerAddress))?.profile.primaryName, "alpha-tn", "registry (chain): own profile persisted");

  // offers this device made are tracked
  const offer = new R.OfferInfo({ outpoint: T.makeOutpoint(new Uint8Array(32).fill(9), 0), key: C.key("alpha-tn"), name: "alpha-tn", buyer: new Uint8Array(32).fill(3), seller: ownerKey, amount: 5n, refundAfter: 10n });
  await reg.trackOffer(offer);
  r.eq((await reg.offersFor("alpha-tn")).map((o) => o.amount), [5n], "registry (chain): tracked offer listed");
  r.eq((await reg.myOffers(new Uint8Array(32).fill(3))).length, 1, "registry (chain): myOffers");
  r.eq((await reg.offersFor("alpha-tn")).map((o) => C.hex(o.seller)), [alpha.owner], "registry (chain): tracked offer keeps its seller");

  // a new registry reads the cache instead of walking from genesis
  const reg2 = new KachatNamesRegistry({ ...deps, getUtxosByAddresses: async () => { throw new Error("no node"); } });
  await reg2.prepare();
  r.eq(reg2.chainState?.names.map((n) => n.name), ["alpha-tn"], "registry (chain): cache loaded");
  r.eq(reg2.chainState?.offers.length, 1, "registry (chain): cached tracked offer");
  r.eq(reg2.chainState?.shards.length, Number(m.params.priceShards), "registry (chain): cached price shards");
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

/** A refused manifest (registry v1: "being upgraded") and other refresh failures: a failed refresh
 *  counts as an attempt and bumps `revision` only when the error changed (iOS d2e0673, the refresh
 *  loop fix); a cache of the previous format is walked again. */
async function runRegistryFailures(v, r) {
  const m = M.decodeManifest(v.manifest);
  let clock = 1_000_000;
  let manifestCalls = 0;
  let answer = () => { throw Object.assign(new Error("The .kachat registry on Testnet is being upgraded."), { code: "registryUpgrading" }); };
  const logs = [];
  const reg = new KachatNamesRegistry({
    manifest: async () => { manifestCalls += 1; return answer(); },
    restBase: () => "https://rest.test", indexerBase: () => "", storage: memoryStorage(),
    // the genesis gap and the price genesis's shards are live: nothing to walk
    getUtxosByAddresses: async () => [
      { outpoint: { transactionId: C.hex(m.genesisTxid), index: 0 }, covenantId: C.hex(m.registryCovenantId) },
      ...m.genesisShards.map((_, i) => ({ outpoint: { transactionId: C.hex(m.priceGenesisTxid), index: i }, covenantId: C.hex(m.priceCovenantId) })),
    ],
    now: () => clock, log: (...a) => logs.push(a.join(" ")),
  });
  await reg.refresh();
  r.check(reg.lastError != null && reg.registryUpgrading, "registry: a refused v1 manifest is registryUpgrading");
  r.eq(reg.revision, 1, "registry: the first refusal bumps the revision");
  r.eq(logs.length, 0, "registry: registryUpgrading is not logged as a failure");
  r.eq(reg.refreshedAt, clock, "registry: a failed refresh counts as an attempt");
  await reg.refreshIfStale();
  r.eq(manifestCalls, 1, "registry: refreshIfStale waits after a failed refresh");
  await reg.refresh();
  r.eq(reg.revision, 1, "registry: the same refusal again does not bump the revision (no refresh loop)");
  answer = () => { throw C.Failure.outdatedRegistry(); };
  await reg.refresh();
  r.check(reg.registryUpgrading, "registry: Failure.outdatedRegistry is registryUpgrading too");
  r.eq(reg.revision, 2, "registry: another error bumps the revision");
  answer = () => { throw new Error("no node"); };
  await reg.refresh();
  r.check(!reg.registryUpgrading && reg.lastError === "no node", "registry: another failure is not registryUpgrading");
  r.eq(logs.length, 1, "registry: other failures are logged once");
  await reg.refresh();
  r.eq(logs.length, 1, "registry: the same failure is not logged again");
  r.eq(reg.revision, 3, "registry: the same failure does not bump the revision");
  clock += 61_000;
  answer = () => m;
  await reg.refreshIfStale();
  r.check(reg.lastError == null && !reg.registryUpgrading && reg.revision === 4, () => `registry: a stale failure is retried, success clears it and bumps (${reg.lastError}, ${reg.revision})`);

  // a cache of the previous format (registry v1, no periodStart) is walked again
  const storage = memoryStorage();
  const old = R.RegistryState.atGenesis(m).toJSON();
  old.v = 1;
  old.names = [["00".repeat(32), 0, "a", "00".repeat(32), "00".repeat(32), "0", "1", "1", null, null, null]];
  storage.set("kachat-names-registry-testnet-v1", JSON.stringify(old));
  const reg2 = new KachatNamesRegistry({ manifest: m, storage, getUtxosByAddresses: async () => [], log: () => {} });
  await reg2.prepare();
  r.eq(reg2.chainState?.names.length, 0, "registry: a format-1 cache is dropped and walked from genesis");
  r.eq(reg2.chainState?.version, 3, "registry: the new state is format 3");
  // a format-2 cache (registry v2: no shards, offers without a seller) is walked again too
  const storage2 = memoryStorage();
  const old2 = R.RegistryState.atGenesis(m).toJSON();
  old2.v = 2;
  delete old2.shards;
  delete old2.priceCovenantId;
  old2.names = [["00".repeat(32), 0, "a", "00".repeat(32), "00".repeat(32), "0", "1", "1", "1", null, null, null]];
  storage2.set("kachat-names-registry-testnet-v1", JSON.stringify(old2));
  const reg3 = new KachatNamesRegistry({ manifest: m, storage: storage2, getUtxosByAddresses: async () => [], log: () => {} });
  await reg3.prepare();
  r.eq(reg3.chainState?.names.length, 0, "registry: a format-2 cache is dropped and walked from genesis");
  r.eq(reg3.chainState?.shards.length, Number(m.params.priceShards), "registry: the new state starts at both geneses");
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
    if (p === "/names/status") {
      return response(200, { network: "testnet-10", registryCovenantId: C.hex(m.registryCovenantId).toUpperCase(), priceCovenantId: C.hex(m.priceCovenantId), synced: true });
    }
    if (p === "/names/prices") {
      const sh = (i) => ({ shard: i, outpoint: { txId: "ab".repeat(32), index: i }, authority: "cd".repeat(32), prices: ["5", "4", "3", "2", "1"], value: "100000000" });
      return response(200, { prices: ["5", "4", "3", "2", "1"], authority: "cd".repeat(32), shards: [sh(1), sh(0)] });
    }
    if (p === "/names/alice") return response(200, nameObj("alice"));
    if (p === "/names/old") return response(200, nameObj("old", { status: "grace", expiresAt: nowMs - 1 }));
    if (p === "/names/bob") return response(200, { name: "bob", key: "00", registered: false, gap: { lo: "00".repeat(32), hi: "ff".repeat(32), outpoint: { txId: "ee".repeat(32), index: 0 } } });
    if (p === `/names/by-owner/${owner}`) return response(200, { names: [nameObj("zed", { registeredAt: 5 }), nameObj("alice")] });
    if (p === "/market/listings") return response(200, { listings: [nameObj("alice", { price: "700" })], next: null });
    if (p === "/names/alice/history") return response(200, { events: [{ txId: "aa", op: "sale", name: "alice", at: 5, price: "700" }], next: null });
    if (p === "/names/alice/offers") {
      return response(200, { offers: [
        { outpoint: { txId: "ef".repeat(32), index: 1 }, buyer: owner, seller: owner, amount: "100", refundAfter: 9, refundable: false },
        // registry v2 shape (no seller): dropped
        { outpoint: { txId: "ef".repeat(32), index: 2 }, buyer: owner, amount: "200", refundAfter: 9, refundable: false },
      ] });
    }
    if (p === `/identity/${owner}`) return response(200, { address: owner, label: "alice", names: ["alice"], profile: { v: 1, bio: " github.com/yo " } });
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
  r.eq((await reg.offersFor("alice")).map((o) => o.name), ["alice"], "registry (indexer): offers take the asked name (one without a seller dropped)");
  r.eq((await reg.shards()).map((x) => x.shard), [0n, 1n], "registry (indexer): GET /names/prices shards, in order");
  r.eq((await reg.currentPrices())?.prices, [5n, 4n, 3n, 2n, 1n], "registry (indexer): current prices");
  r.eq(reg.cachedPrices, [5n, 4n, 3n, 2n, 1n], "registry (indexer): cachedPrices after currentPrices()");
  const id = await reg.identity(owner);
  r.eq({ label: id.label, bio: id.profile?.bio }, { label: "alice", bio: "https://github.com/yo" }, "registry (indexer): identity sanitized");
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
  r.eq(reg2.cachedPrices, m.genesisShards[0].fields.prices, "registry (chain at genesis): cachedPrices = the genesis shards'");
  // an indexer that follows the registry but not (or another) price covenant is not used either
  for (const priceCovenantId of [undefined, "00".repeat(32)]) {
    const reg3 = new KachatNamesRegistry({
      fetch: async () => response(200, { registryCovenantId: C.hex(m.registryCovenantId), priceCovenantId }), restBase: () => "https://rest.test",
      indexerBase: () => "https://idx.test", getUtxosByAddresses: async () => [], storage: memoryStorage(), manifest: m, now: () => nowMs, log: () => {},
    });
    await reg3.prepare();
    r.eq(reg3.source, { kind: "chain" }, `registry (indexer): price covenant ${priceCovenantId ? "mismatch" : "missing"} -> chain walker`);
  }
  r.eq(KachatNamesRegistry.compactAddress(owner), `kaspatest:${owner.slice(10, 16)}...${owner.slice(-6)}`, "compactAddress: prefix + 6 ... 6");
  r.eq(R.compactAddress("kaspatest:abc"), "kaspatest:abc", "compactAddress: a short body unchanged");
  r.eq(R.compactAddress("nocolon"), "nocolon", "compactAddress: no prefix unchanged");
}

/** Where the network has no registry (isEnabled false: mainnet, iOS d36fc42): the registry is
 *  inert and identities are profile-only - own saved record, else GET /profiles/{address}; a 503
 *  pauses every lookup 10 minutes, any other failure that address 5 minutes. Own profiles are
 *  stored per network. */
async function runProfilesOnly(r) {
  const key = new Uint8Array(32).fill(0x42);
  const me = R.addressOf(key, "kaspa");
  const alice = R.addressOf(new Uint8Array(32).fill(0x43), "kaspa");
  const bob = R.addressOf(new Uint8Array(32).fill(0x44), "kaspa");
  const tn = R.addressOf(key);
  r.eq(ownProfileKeyPrefixFor("testnet"), "kachat-names-profile-testnet-v1", "profiles: testnet keeps its key prefix");
  r.eq(ownProfileStorageKey(tn.toUpperCase()), `kachat-names-profile-testnet-v1:${tn}`, "profiles: testnet own-profile key (lowercased)");
  r.eq(ownProfileStorageKey(me), `kachat-names-profile-mainnet-v1:${me}`, "profiles: mainnet own-profile key");

  let clock = 1_800_000_000_000;
  const seen = [];
  let answers = {};
  const fetch = async (url) => {
    seen.push(url);
    const p = new URL(url).pathname;
    const a = answers[p];
    if (typeof a === "function") return a();
    if (a) return response(a[0], a[1]);
    return response(404, { error: "not_found" });
  };
  const storage = memoryStorage();
  let manifestCalls = 0;
  const reg = new KachatNamesRegistry({
    fetch, storage, indexerBase: () => "https://idx.test/", restBase: () => "https://rest.test",
    manifest: async () => { manifestCalls += 1; throw new Error("no manifest on mainnet"); },
    getUtxosByAddresses: async () => { throw new Error("no registry reads"); },
    isEnabled: () => false, now: () => clock, log: () => {},
  });
  r.eq(reg.isLaunched, false, "profiles: registry.isLaunched false");

  // the registry stays inert: no manifest, no reads, refreshes are no-ops
  await reg.refresh();
  await reg.refreshAfter("ab".repeat(32));
  r.eq(reg.revision, 0, "profiles: refresh is a no-op");
  let refused = false;
  try { await reg.lookup("alice"); } catch { refused = true; }
  r.check(refused, "profiles: lookup refuses without a registry");
  refused = false;
  try { await reg.namesOf(key); } catch { refused = true; }
  r.check(refused, "profiles: namesOf refuses without a registry");
  r.eq((await reg.ownersOfNames([me])).size, 0, "profiles: ownersOfNames empty");
  r.eq(manifestCalls, 0, "profiles: the manifest is never loaded");

  // GET /profiles/{address}: 200 with a profile, 200 with profile null
  answers[`/profiles/${alice}`] = [200, { address: alice, profile: { v: 1, avatar: " x.com/alice ", primaryName: null }, updatedAt: 5, txId: "cd".repeat(32) }];
  answers[`/profiles/${bob}`] = [200, { address: bob, profile: null }];
  const ia = await reg.identity(alice.toUpperCase());
  r.eq(JSON.stringify({ label: ia.label, names: ia.names, avatar: ia.profile?.avatar }), JSON.stringify({ label: null, names: [], avatar: "https://x.com/alice" }), "profiles: identity from GET /profiles (sanitized, no label)");
  r.check(seen.includes(`https://idx.test/profiles/${alice}`), "profiles: asks GET /profiles/{address} on the indexer");
  r.check(!seen.some((u) => u.includes("/identity/") || u.includes("/names/")), "profiles: never /identity or /names");
  const ib = await reg.identity(bob);
  r.eq(ib.profile, null, "profiles: profile null = no profile");

  // a non-address is not asked about
  const n0 = seen.length;
  r.eq((await reg.identity("kaspa:not/an/address")).profile, null, "profiles: a non-address has no profile");
  r.eq(seen.length, n0, "profiles: a non-address is never put in a URL");

  // own saved record wins, stored under the mainnet key
  await reg.noteOwnProfile({ bio: " t.me/me ", linktree: "linktr.ee/me" }, me, "ef".repeat(32));
  r.check(storage.map.has(`kachat-names-profile-mainnet-v1:${me}`), "profiles: own mainnet profile stored per network");
  r.check(![...storage.map.keys()].some((k) => k.startsWith("kachat-names-profile-testnet-v1:")), "profiles: nothing under the testnet key");
  r.eq(reg.revision, 1, "profiles: noteOwnProfile bumps the revision");
  const n1 = seen.length;
  const im = await reg.identity(me);
  r.eq(im.profile?.bio, "https://t.me/me", "profiles: own saved profile");
  r.eq(seen.length, n1, "profiles: own profile needs no request");
  const reg2 = new KachatNamesRegistry({ fetch, storage, indexerBase: () => "https://idx.test", isEnabled: () => false, now: () => clock, log: () => {} });
  r.eq((await reg2.identity(me)).profile?.linktree, "https://linktr.ee/me", "profiles: own profile persisted per network");

  // any other failure pauses that address for 5 minutes
  const carol = R.addressOf(new Uint8Array(32).fill(0x45), "kaspa");
  answers[`/profiles/${carol}`] = [500, { error: "boom" }];
  refused = false;
  try { await reg.identity(carol); } catch { refused = true; }
  r.check(refused, "profiles: a 500 fails");
  const n2 = seen.length;
  answers[`/profiles/${carol}`] = [200, { address: carol, profile: { v: 1, bio: "github.com/carol" } }];
  refused = false;
  try { await reg.identity(carol); } catch { refused = true; }
  r.check(refused && seen.length === n2, "profiles: a failed address is not asked again within 5 minutes");
  r.eq((await reg.identity(alice)).profile?.avatar, "https://x.com/alice", "profiles: other addresses still answer");
  clock += profileMissPauseMs;
  r.eq((await reg.identity(carol)).profile?.bio, "https://github.com/carol", "profiles: asked again after 5 minutes");

  // a 503 pauses every lookup for 10 minutes
  answers = { [`/profiles/${alice}`]: [503, { error: "profiles off" }] };
  refused = false;
  try { await reg.identity(alice); } catch { refused = true; }
  r.check(refused, "profiles: a 503 fails");
  r.eq(reg.profilesPausedUntil, clock + profilesUnavailablePauseMs, "profiles: a 503 sets the 10-minute pause");
  const n3 = seen.length;
  for (const a of [bob, carol, alice]) { try { await reg.identity(a); } catch { /* paused */ } }
  r.eq(seen.length, n3, "profiles: no request for any address while paused");
  r.eq((await reg.identity(me)).profile?.bio, "https://t.me/me", "profiles: own profile still shows while paused");
  clock += profilesUnavailablePauseMs;
  answers[`/profiles/${bob}`] = [200, { address: bob, profile: { v: 1, bio: "x.com/bob" } }];
  r.eq((await reg.identity(bob)).profile?.bio, "https://x.com/bob", "profiles: asked again after 10 minutes");

  // no indexer: no request
  const reg3 = new KachatNamesRegistry({ fetch, storage: memoryStorage(), indexerBase: () => "", isEnabled: () => false, now: () => clock, log: () => {} });
  const n4 = seen.length;
  refused = false;
  try { await reg3.identity(bob); } catch { refused = true; }
  r.check(refused && seen.length === n4, "profiles: no indexer -> no request");

  // testnet still reads the old key
  const tnStorage = memoryStorage();
  tnStorage.set(`kachat-names-profile-testnet-v1:${tn}`, JSON.stringify({ address: tn, profile: { v: 1, bio: "https://x.com/tn" }, txId: "aa".repeat(32), at: 1 }));
  const reg4 = new KachatNamesRegistry({ storage: tnStorage, log: () => {} });
  r.eq((await reg4.ownProfile(tn))?.profile.bio, "https://x.com/tn", "profiles: testnet own profile read from the old key");
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
    console.log(`  name ${n.name}.kachat owner ${R.addressOf(C.unhex32(n.owner))} price ${n.price} period from ${new Date(Number(n.periodStart)).toISOString()} expires ${new Date(Number(n.expiresAt)).toISOString()} (${status}) at ${n.txid.slice(0, 16)}:${n.index}`);
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

/** The social profile resolver (social-image-resolver.js) over a fake fetchText: which requests a
 *  lookup makes per platform, the cache (reuse, persistence, drop on an empty answer, keep when
 *  unreachable), shared lookups and onChange. */
async function runSocialResolver(r) {
  let clock = 1_000_000;
  const mem = new Map();
  const storage = { get: (k) => mem.get(k) ?? null, set: (k, v) => { mem.set(k, v); } };
  const routes = new Map();
  const calls = [];
  const fetchText = async (url, opts) => {
    calls.push({ url, ...opts });
    const route = routes.get(url);
    if (route === undefined) return { status: 404, contentType: "text/plain", text: "" };
    if (route === null) return null;
    if (typeof route === "function") return route(opts);
    return { status: route.status ?? 200, contentType: route.contentType ?? "text/html", text: typeof route.body === "string" ? route.body : JSON.stringify(route.body) };
  };
  const make = () => new KachatSocialImageResolver({ fetchText, storage, now: () => clock });
  const res = make();

  // X: FxTwitter's one JSON answer
  routes.set("https://api.fxtwitter.com/KaspaCurrency", { body: { code: 200, user: { avatar_url: "https://pbs.twimg.com/profile_images/1/a_normal.jpg", banner_url: "https://pbs.twimg.com/profile_banners/9/8", description: " Kaspa " } } });
  const changes = [];
  res.onChange((link, p) => changes.push([link, p.avatar]));
  const a = await res.resolve("x.com/KaspaCurrency");
  r.eq(a, { kind: "answered", profile: { avatar: "https://pbs.twimg.com/profile_images/1/a_400x400.jpg", banner: "https://pbs.twimg.com/profile_banners/9/8/1500x500", bio: "Kaspa" } }, "resolver: X through FxTwitter");
  r.eq(calls.map((c) => [c.url, c.accept, c.agent]), [["https://api.fxtwitter.com/KaspaCurrency", "application/json", "browser"]], "resolver: X costs one JSON request");
  r.check(calls[0].timeoutMs === 8000 && calls[0].maxBytes > 0, "resolver: each request carries the 8 s limit and a read cap");
  r.eq(changes, [["https://x.com/KaspaCurrency", "https://pbs.twimg.com/profile_images/1/a_400x400.jpg"]], "resolver: onChange on a new answer");
  r.check(typeof mem.get(`${socialImageCachePrefix}https://x.com/KaspaCurrency`) === "string", "resolver: cached under kachat-social-image-v1:<link>");
  clock += 60_000;
  await res.resolve("https://twitter.com/KaspaCurrency/");
  r.eq(calls.length, 1, "resolver: an answer under five minutes old is reused");
  r.eq((await make().cached("x.com/KaspaCurrency"))?.bio, "Kaspa", "resolver: the cache survives a new instance");

  // shared lookups
  calls.length = 0;
  routes.set("https://api.github.com/users/torvalds", { contentType: "application/json", body: { avatar_url: "https://avatars.githubusercontent.com/u/1024025?v=4", bio: null } });
  const [g1, g2] = await Promise.all([res.resolve("github.com/torvalds"), res.resolve("https://github.com/torvalds")]);
  r.check(calls.length === 1 && g1.profile.avatar === g2.profile.avatar && g1.profile.avatar.startsWith("https://avatars."), "resolver: lookups of one link in flight are shared");

  // X fallback: FxTwitter fails, X's page
  calls.length = 0;
  routes.set("https://api.fxtwitter.com/jack", { status: 500, body: { code: 500 } });
  routes.set("https://x.com/jack", { body: "<meta property=\"og:image\" content=\"https://pbs.twimg.com/profile_images/2/b_200x200.jpg\"><meta property=\"og:description\" content=\"just setting up\"> profile_banners/12/34" });
  const xf = await res.resolve("x.com/jack");
  r.eq(xf.profile, { avatar: "https://pbs.twimg.com/profile_images/2/b_400x400.jpg", banner: "https://pbs.twimg.com/profile_banners/12/34/1500x500", bio: "just setting up" }, "resolver: X's page as the fallback");
  r.eq(calls.map((c) => c.agent), ["browser", "crawler"], "resolver: X's page asked as a crawler");

  // YouTube: the banner from the same page, else the desktop page
  calls.length = 0;
  const ytPage = (banner) => `<meta property="og:image" content="https://yt3.googleusercontent.com/av=s900"><meta property="og:description" content="Videos!">${banner ? "\"imageBannerViewModel\":{\"image\":{\"sources\":[{\"url\":\"https://yt3.googleusercontent.com/bn=w1060\"" : ""}`;
  routes.set("https://www.youtube.com/@withbanner", { body: ytPage(true) });
  const y1 = await res.resolve("youtube.com/@withbanner");
  r.check(calls.length === 1 && y1.profile.banner === "https://yt3.googleusercontent.com/bn=w1060" && y1.profile.bio === "Videos!", "resolver: YouTube in one request when the page has the banner");
  calls.length = 0;
  let asked = 0;
  routes.set("https://www.youtube.com/@twopages", (opts) => { asked += 1; return { status: 200, contentType: "text/html", text: ytPage(opts.agent === "browser") }; });
  const y2 = await res.resolve("youtube.com/@twopages");
  r.check(asked === 2 && y2.profile.banner === "https://yt3.googleusercontent.com/bn=w1060", "resolver: YouTube's desktop page for the banner");

  // images only; Twitch boilerplate; Discord; Telegram
  routes.set("https://www.instagram.com/nasa/", { body: "<meta property=\"og:image\" content=\"https://scontent.cdninstagram.com/a.jpg?x=1&amp;y=2\"><meta property=\"og:description\" content=\"97M Followers\">" });
  r.eq((await res.resolve("instagram.com/nasa")).profile, { avatar: "https://scontent.cdninstagram.com/a.jpg?x=1&y=2", banner: null, bio: null }, "resolver: Instagram gives the picture, no bio");
  routes.set("https://www.twitch.tv/speedy", { body: "<meta property=\"og:description\" content=\"Speedruns — Twitch streams live on Twitch!\"/>" });
  r.eq((await res.resolve("twitch.tv/speedy")).profile.bio, "Speedruns", "resolver: Twitch bio without its boilerplate");
  routes.set("https://discord.com/api/v10/invites/devs", { body: { guild: { id: "42", icon: "abc", banner: "def", description: "Devs" } } });
  r.eq((await res.resolve("discord.gg/devs")).profile, { avatar: "https://cdn.discordapp.com/icons/42/abc.png?size=256", banner: "https://cdn.discordapp.com/banners/42/def.png?size=1024", bio: "Devs" }, "resolver: Discord invite icon, banner, description");
  routes.set("https://t.me/someone", { body: "<meta property=\"og:image\" content=\"javascript:alert(1)\"><meta property=\"og:description\" content=\"hi &lt;b&gt;\">" });
  r.eq((await res.resolve("t.me/someone")).profile, { avatar: null, banner: null, bio: "hi <b>" }, "resolver: a non-https picture is never kept");
  routes.set("https://api.github.com/users/plain", { body: { avatar_url: "http://insecure.example/a.png", bio: "x" } });
  r.eq((await res.resolve("github.com/plain")).profile.avatar, null, "resolver: an http avatar is dropped");

  // moderation carries over: empty answer drops, unreachable keeps
  clock += 1_000;
  routes.set("https://api.github.com/users/torvalds", { status: 404, body: { message: "Not Found" } });
  const gone = await res.resolve("github.com/torvalds", { maxAgeMs: 0 });
  r.check(gone.kind === "answered" && gone.profile.isEmpty, "resolver: an account gone answers empty");
  r.check((await res.cached("github.com/torvalds"))?.isEmpty === true, "resolver: the cached picture is dropped");
  routes.set("https://api.fxtwitter.com/KaspaCurrency", null);
  routes.set("https://x.com/KaspaCurrency", null);
  const away = await res.resolve("x.com/KaspaCurrency", { maxAgeMs: 0 });
  r.eq([away.kind, away.profile?.bio], ["unreachable", "Kaspa"], "resolver: unreachable keeps the last answer");
  routes.set("https://kick.com/never", () => { throw new Error("boom"); });
  r.eq(await res.resolve("kick.com/never"), { kind: "unreachable", profile: null }, "resolver: a throwing fetch is unreachable");
  routes.set("https://kick.com/cut", () => ({ status: 200, contentType: "text/html", text: `${"x".repeat(3_000_000)}<meta property="og:description" content="late">` }));
  r.eq((await res.resolve("kick.com/cut")).profile.bio, null, "resolver: nothing past the read cap is read");
  r.eq(await res.resolve("example.com/whoever"), { kind: "answered", profile: { avatar: null, banner: null, bio: null } }, "resolver: no lookup for an unsupported link");

  // profile(link): the cached answer now, a background lookup when stale
  const res2 = make();
  clock += 25 * 3600 * 1000;
  routes.set("https://api.fxtwitter.com/KaspaCurrency", { body: { code: 200, user: { avatar_url: "https://pbs.twimg.com/profile_images/3/c_normal.jpg", description: "new" } } });
  const landed = new Promise((resolve) => res2.onChange((_l, p) => resolve(p)));
  const stale = await res2.profile("x.com/KaspaCurrency");
  r.eq(stale?.bio, "Kaspa", "resolver: profile() answers from the stale cache");
  r.eq((await landed).bio, "new", "resolver: and looks it up again");
  r.eq((await res2.cached("x.com/KaspaCurrency"))?.banner, null, "resolver: a banner X no longer shows is dropped");
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
  await runRegistryFailures(v, r);
  console.log(`+ KachatNamesRegistry refusals and failed refreshes: ${r.pass} pass, ${r.fail} fail`);
  await runRegistryIndexer(v, r);
  console.log(`+ KachatNamesRegistry over a fake indexer: ${r.pass} pass, ${r.fail} fail`);
  await runProfilesOnly(r);
  console.log(`+ profile-only identities (no registry): ${r.pass} pass, ${r.fail} fail`);
  await runSocialResolver(r);
  console.log(`+ social profile resolver: ${r.pass} pass, ${r.fail} fail`);
  for (const f of r.failures.slice(0, 40)) console.log(`  FAIL ${f}`);
  let ok = r.fail === 0;
  if (live) ok = (await runLive()) && ok;
  if (!ok) process.exit(1);
  console.log("OK");
}

await main();
