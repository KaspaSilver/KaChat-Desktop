// The .kachat name core (engine/kachat-names) against the kachat-domains test vectors
// (tools/fixtures/kachat-names-vectors.json, a copy of iOS KaChatTests/KachatNamesVectors.json,
// written by `kachat-names-vectors` from the CLI's own builders) and the official BLAKE3 test
// vectors. Port of iOS scripts/test_kachat_names_core.swift. Run from the repo root:
//
//   node tools/test-kachat-names-core.mjs [path/to/KachatNamesVectors.json] [fixed-budget-out.json]
//
// With a second path it also writes every step rebuilt with the app's fixed budgets (placeholder
// signatures), for `kachat-names-vectors check <out.json>` in kachat-domains (Swift
// `writeFixedBudget`).

import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { blake3 } from "@noble/hashes/blake3.js";

import * as C from "../engine/kachat-names/codec.js";
import * as T from "../engine/kachat-names/transaction.js";
import * as M from "../engine/kachat-names/manifest.js";
import * as B from "../engine/kachat-names/builder.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");

/** Official BLAKE3 test vectors (github.com/BLAKE3-team/BLAKE3 test_vectors.json): input byte i is
 *  i % 251, key "whats the Elvish word for friend"; the first 32 bytes of each output. */
const blake3Official = [
  [0, "af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262", "92b2b75604ed3c761f9d6f62392c8a9227ad0ea3f09573e783f1498a4ed60d26"],
  [1, "2d3adedff11b61f14c886e35afa036736dcd87a74d27b5c1510225d0f592e213", "6d7878dfff2f485635d39013278ae14f1454b8c0a3a2d34bc1ab38228a80c95b"],
  [2, "7b7015bb92cf0b318037702a6cdd81dee41224f734684c2c122cd6359cb1ee63", "5392ddae0e0a69d5f40160462cbd9bd889375082ff224ac9c758802b7a6fd20a"],
  [3, "e1be4d7a8ab5560aa4199eea339849ba8e293d55ca0a81006726d184519e647f", "39e67b76b5a007d4921969779fe666da67b5213b096084ab674742f0d5ec62b9"],
  [4, "f30f5ab28fe047904037f77b6da4fea1e27241c5d132638d8bedce9d40494f32", "7671dde590c95d5ac9616651ff5aa0a27bee5913a348e053b8aa9108917fe070"],
  [5, "b40b44dfd97e7a84a996a91af8b85188c66c126940ba7aad2e7ae6b385402aa2", "73ac69eecf286894d8102018a6fc729f4b1f4247d3703f69bdc6a5fe3e0c8461"],
  [6, "06c4e8ffb6872fad96f9aaca5eee1553eb62aed0ad7198cef42e87f6a616c844", "82d3199d0013035682cc7f2a399d4c212544376a839aa863a0f4c91220ca7a6d"],
  [7, "3f8770f387faad08faa9d8414e9f449ac68e6ff0417f673f602a646a891419fe", "af0a7ec382aedc0cfd626e49e7628bc7a353a4cb108855541a5651bf64fbb28a"],
  [8, "2351207d04fc16ade43ccab08600939c7c1fa70a5c0aaca76063d04c3228eaeb", "be2f5495c61cba1bb348a34948c004045e3bd4dae8f0fe82bf44d0da245a0600"],
  [63, "e9bc37a594daad83be9470df7f7b3798297c3d834ce80ba85d6e207627b7db7b", "bb1eb5d4afa793c1ebdd9fb08def6c36d10096986ae0cfe148cd101170ce37ae"],
  [64, "4eed7141ea4a5cd4b788606bd23f46e212af9cacebacdc7d1f4c6dc7f2511b98", "ba8ced36f327700d213f120b1a207a3b8c04330528586f414d09f2f7d9ccb7e6"],
  [65, "de1e5fa0be70df6d2be8fffd0e99ceaa8eb6e8c93a63f2d8d1c30ecb6b263dee", "c0a4edefa2d2accb9277c371ac12fcdbb52988a86edc54f0716e1591b4326e72"],
  [127, "d81293fda863f008c09e92fc382a81f5a0b4a1251cba1634016a0f86a6bd640d", "c64200ae7dfaf35577ac5a9521c47863fb71514a3bcad18819218b818de85818"],
  [128, "f17e570564b26578c33bb7f44643f539624b05df1a76c81f30acd548c44b45ef", "b04fe15577457267ff3b6f3c947d93be581e7e3a4b018679125eaf86f6a628ec"],
  [129, "683aaae9f3c5ba37eaaf072aed0f9e30bac0865137bae68b1fde4ca2aebdcb12", "d4a64dae6cdccbac1e5287f54f17c5f985105457c1a2ec1878ebd4b57e20d38f"],
  [1023, "10108970eeda3eb932baac1428c7a2163b0e924c9a9e25b35bba72b28f70bd11", "c951ecdf03288d0fcc96ee3413563d8a6d3589547f2c2fb36d9786470f1b9d6e"],
  [1024, "42214739f095a406f3fc83deb889744ac00df831c10daa55189b5d121c855af7", "75c46f6f3d9eb4f55ecaaee480db732e6c2105546f1e675003687c31719c7ba4"],
  [1025, "d00278ae47eb27b34faecf67b4fe263f82d5412916c1ffd97c8cb7fb814b8444", "357dc55de0c7e382c900fd6e320acc04146be01db6a8ce7210b7189bd664ea69"],
  [2048, "e776b6028c7cd22a4d0ba182a8bf62205d2ef576467e838ed6f2529b85fba24a", "879cf1fa2ea0e79126cb1063617a05b6ad9d0b696d0d757cf053439f60a99dd1"],
  [2049, "5f4d72f40d7a5f82b15ca2b2e44b1de3c2ef86c426c95c1af0b6879522563030", "9f29700902f7c86e514ddc4df1e3049f258b2472b6dd5267f61bf13983b78dd5"],
  [3072, "b98cb0ff3623be03326b373de6b9095218513e64f1ee2edd2525c7ad1e5cffd2", "044a0e7b172a312dc02a4c9a818c036ffa2776368d7f528268d2e6b5df191770"],
  [3073, "7124b49501012f81cc7f11ca069ec9226cecb8a2c850cfe644e327d22d3e1cd3", "68dede9bef00ba89e43f31a6825f4cf433389fedae75c04ee9f0cf16a427c95a"],
  [4096, "015094013f57a5277b59d8475c0501042c0b642e531b0a1c8f58d2163229e969", "befc660aea2f1718884cd8deb9902811d332f4fc4a38cf7c7300d597a081bfc0"],
  [4097, "9b4052b38f1c5fc8b1f9ff7ac7b27cd242487b3d890d15c96a1c25b8aa0fb995", "00df940cd36bb9fa7cbbc3556744e0dbc8191401afe70520ba292ee3ca80abbc"],
  [5120, "9cadc15fed8b5d854562b26a9536d9707cadeda9b143978f319ab34230535833", "2c493e48e9b9bf31e0553a22b23503c0a3388f035cece68eb438d22fa1943e20"],
  [5121, "628bd2cb2004694adaab7bbd778a25df25c47b9d4155a55f8fbd79f2fe154cff", "6ccf1c34753e7a044db80798ecd0782a8f76f33563accaddbfbb2e0ea4b2d024"],
  [6144, "3e2e5b74e048f3add6d21faab3f83aa44d3b2278afb83b80b3c35164ebeca205", "3d6b6d21281d0ade5b2b016ae4034c5dec10ca7e475f90f76eac7138e9bc8f1d"],
  [6145, "f1323a8631446cc50536a9f705ee5cb619424d46887f3c376c695b70e0f0507f", "9ac301e9e39e45e3250a7e3b3df701aa0fb6889fbd80eeecf28dbc6300fbc539"],
  [7168, "61da957ec2499a95d6b8023e2b0e604ec7f6b50e80a9678b89d2628e99ada77a", "b42835e40e9d4a7f42ad8cc04f85a963a76e18198377ed84adddeaecacc6f3fc"],
  [7169, "a003fc7a51754a9b3c7fae0367ab3d782dccf28855a03d435f8cfe74605e7817", "ed9b1a922c046fdb3d423ae34e143b05ca1bf28b710432857bf738bcedbfa511"],
  [8192, "aae792484c8efe4f19e2ca7d371d8c467ffb10748d8a5a1ae579948f718a2a63", "dc9637c8845a770b4cbf76b8daec0eebf7dc2eac11498517f08d44c8fc00d58a"],
  [8193, "bab6c09cb8ce8cf459261398d2e7aef35700bf488116ceb94a36d0f5f1b7bc3b", "954a2a75420c8d6547e3ba5b98d963e6fa6491addc8c023189cc519821b4a1f5"],
  [16384, "f875d6646de28985646f34ee13be9a576fd515f76b5b0a26bb324735041ddde4", "9e9fc4eb7cf081ea7c47d1807790ed211bfec56aa25bb7037784c13c4b707b0d"],
  [31744, "62b6960e1a44bcc1eb1a611a8d6235b6b4b78f32e7abc4fb4c6cdcce94895c47", "efa53b389ab67c593dba624d898d0f7353ab99e4ac9d42302ee64cbf9939a419"],
  [102400, "bc3e3d41a1146b069abffad3c0d44860cf664390afce4d9661f7902e7943e085", "1c35d1a5811083fd7119f5d5d1ba027b4d01c0c6c49fb6ff2cf75393ea5db4a7"],
];

class Report {
  constructor() { this.pass = 0; this.fail = 0; this.failures = []; }
  check(ok, what) {
    if (ok) this.pass += 1;
    else { this.fail += 1; this.failures.push(typeof what === "function" ? what() : what); }
  }
  eq(a, b, what) { this.check(a === b, () => `${what}: got ${a} expected ${b}`); }
  eqHex(a, b, what) {
    const h = C.hex(a);
    this.check(h === b, () => `${what}: got ${h.slice(0, 160)} expected ${String(b).slice(0, 160)}`);
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

function shardRec(p) {
  const fields = C.makePriceFields({ shard: u64(p.shard), authority: hx(p.authority), prices: p.prices.map(u64) });
  return { fields, value: u64(p.value), utxo: utxo(p.utxo) };
}

const commitRec = (c) => ({ name: s(c.name), owner: hx(c.owner), salt: hx(c.salt), value: u64(c.value), utxo: utxo(c.utxo) });

function runBlake3Official(r) {
  const key = C.utf8("whats the Elvish word for friend");
  for (const [n, hash, keyed] of blake3Official) {
    const input = new Uint8Array(n);
    for (let i = 0; i < n; i++) input[i] = i % 251;
    r.eqHex(blake3(input), hash, `BLAKE3 official hash, len ${n}`);
    r.eqHex(blake3(input, { key }), keyed, `BLAKE3 official keyed hash, len ${n}`);
    const inc = blake3.create();
    let i = 0, step = 1;
    while (i < n) { const e = Math.min(n, i + step); inc.update(input.subarray(i, e)); i = e; step = (step * 3) % 1031 + 1; }
    r.eqHex(inc.digest(), hash, `BLAKE3 official hash, incremental, len ${n}`);
  }
}

function runCodecs(v, r) {
  const c = v.codecs;
  for (const k of c.nameKeys) {
    const name = s(k.name);
    r.eqHex(C.key(name), s(k.key), `key(${name})`);
    r.eqHex(C.padded(name), s(k.padded), `padded(${name})`);
    r.check(C.isValid(name), `valid ${name}`);
  }
  for (const k of c.commitments) {
    const name = s(k.name);
    const cm = C.commitment(name, hx(k.owner), hx(k.salt));
    r.eqHex(cm, s(k.commitment), `commitment(${name})`);
    const redeem = C.commitRedeem(cm, hx(k.owner));
    r.eqHex(redeem, s(k.redeem), `commitRedeem(${name})`);
    r.eqHex(C.p2shScript(redeem), s(k.spk), `commit spk(${name})`);
  }
  for (const b of c.blake3) {
    const n = num(b.len);
    const input = new Uint8Array(n);
    for (let i = 0; i < n; i++) input[i] = (i * 7) % 256;
    r.eqHex(C.blake3(input), s(b.hash), `blake3 len ${n} vs Rust blake3::hash`);
  }
  for (const x of c.num8) {
    const val = BigInt(s(x.value));
    r.eqHex(C.num8(val), s(x.num8), `num8(${val})`);
    r.eq(C.decodeNum8(C.num8(val)), val, `decodeNum8(${val})`);
  }
  for (const x of c.scriptNumbers) {
    const val = BigInt(s(x.value));
    r.eqHex(C.pushInt(val), s(x.push), `pushInt(${val})`);
  }
  for (const x of c.pushes) {
    const data = hx(x.data);
    r.eqHex(C.pushData(data), s(x.push), `pushData(len ${data.length})`);
    const parsed = C.parsePushes(hx(x.push));
    r.check(parsed.length === 1 && C.bytesEqual(parsed[0], data), `parsePushes(len ${data.length})`);
  }
  const st = c.states;
  const m = M.decodeManifest(v.manifest);
  const g = st.gap;
  const gs = C.gapState(hx(g.lo), hx(g.hi));
  r.eqHex(gs, s(g.state), "gap state");
  r.eqHex(M.templateScript(m.gap, gs), s(g.spk), "gap spk");
  const n = st.name;
  const nf = C.nameFieldsFor(s(n.name), hx(n.owner), u64(n.price), u64(n.periodStart), u64(n.expiresAt));
  r.eqHex(C.nameState(nf), s(n.state), "name state");
  r.eq(C.nameState(nf).length, 126, "name state is 126 bytes");
  r.eqHex(M.templateScript(m.name, C.nameState(nf)), s(n.spk), "name spk");
  r.check(C.nameFieldsEqual(C.decodeNameState(C.nameState(nf)), nf), "decode name state");
  r.eq(C.nameFieldsName(nf), s(n.name), "unpadded name");
  const o = st.offer;
  const of = C.makeOfferFields({ key: hx(o.key), buyer: hx(o.buyer), seller: hx(o.seller), refundAfter: u64(o.refundAfter) });
  r.eqHex(C.offerState(of), s(o.state), "offer state");
  r.eq(C.offerState(of).length, 108, "offer state is 108 bytes (registry v3: with the seller)");
  r.eqHex(M.templateScript(m.offer, C.offerState(of)), s(o.spk), "offer spk");
  r.check(C.offerFieldsEqual(C.decodeOfferState(C.offerState(of)), of), "decode offer state");
  const pj = st.price;
  const pf = C.makePriceFields({ shard: u64(pj.shard), authority: hx(pj.authority), prices: pj.prices.map(u64) });
  r.eqHex(C.priceState(pf), s(pj.state), "price state");
  r.eq(C.priceState(pf).length, 87, "price state is 87 bytes");
  r.eqHex(M.templateScript(m.price, C.priceState(pf)), s(pj.spk), "price spk");
  r.check(C.priceFieldsEqual(C.decodePriceState(C.priceState(pf)), pf), "decode price state");
  r.eq(C.hex(C.decodeGapState(gs).hi), s(g.hi), "decode gap state");
  for (const cv of c.covenantIds) {
    const outpoint = T.makeOutpoint(hx(cv.outpoint.txid), num(cv.outpoint.index));
    const outs = cv.outputs.map((x) => ({
      index: num(x.index),
      output: T.makeTxOutput({ value: u64(x.value), scriptVersion: num(x.scriptVersion), script: hx(x.script), covenant: null }),
    }));
    r.eqHex(C.covenantId(outpoint, outs), s(cv.covenantId), "covenant id (2 outputs)");
    r.eqHex(C.covenantId(outpoint, [outs[0]]), s(cv.covenantIdFirstOnly), "covenant id (1 output)");
  }
  const p = c.p2pk;
  r.eqHex(C.p2pkScript(hx(p.xonly)), s(p.spk), "p2pk spk");
  r.check(C.bytesEqual(C.p2pkKey(C.p2pkScript(hx(p.xonly))), hx(p.xonly)), "p2pkKey");
  // silverscript template.rs golden values
  r.eqHex(C.templateHash(new Uint8Array(0), new Uint8Array(0)), "e572dff82304700b856a555ac3a4558d0df3646a3727816500270a93c66aac1e", "template hash golden (empty)");
  r.eqHex(C.templateHash(Uint8Array.of(0x00, 0xff), Uint8Array.of(0x10, 0x00, 0x80)), "6616a66757315de0221cb2acba729113cebde31f8d3ca7fa93878a0584b96905", "template hash golden (classic)");
  // name rules
  for (const bad of ["", "-a", "a-", "A", "a_b", "é", "a".repeat(33), "a.b"]) {
    r.check(!C.isValid(bad), `invalid name accepted: ${bad}`);
  }
  r.eq(C.normalize("  Alice.KACHAT "), "alice", "normalize");
}

function verifies(m, opts) { try { M.verifyManifest(m, opts); return true; } catch { return false; } }

function runManifest(v, r) {
  const m = M.decodeManifest(JSON.stringify(v.manifest));
  try { M.verifyManifest(m); r.pass += 1; } catch (e) { r.check(false, `manifest verify: ${e.message}`); }
  r.check(m.isDryRun, "the vectors' manifest is a dry run");
  // the gap and name are not pinned until the testnet genesis: an indexer-served copy is refused
  r.check(!verifies(m, { source: M.ManifestSource.indexer }), "an indexer-served manifest with unpinned gap/name verified");
  // IOS-059: the offer template must be pinned too - an unpinned one could hold buyers' funds in a
  // script the indexer controls
  {
    const pins = M.pinnedTemplateHashes;
    const saved = { ...pins };
    try {
      pins.KachatGap = C.hex(m.gap.templateHash);
      pins.KachatName = C.hex(m.name.templateHash);
      r.check(!verifies(m, { source: M.ManifestSource.indexer }), "IOS-059: an indexer-served manifest with an unpinned offer template verified");
      r.check(verifies(m), "IOS-059: the same manifest from the bundle verifies");
      pins.KachatOffer = C.hex(m.offer.templateHash);
      r.check(verifies(m, { source: M.ManifestSource.indexer }), "IOS-059: an indexer-served manifest with every template pinned verifies");
      pins.KachatOffer = "00".repeat(32);
      r.check(!verifies(m, { source: M.ManifestSource.indexer }), "IOS-059: an offer template that is not the pinned build verified");
    } finally {
      for (const k of Object.keys(pins)) delete pins[k];
      Object.assign(pins, saved);
    }
  }
  // IOS-060: "expires soon" is 30 days on a yearly clock, the renewal window on a short one
  r.eq(M.paramsExpiresSoonMs({ periodMs: C.yearMs, renewWindowMs: 864_000_000n }), 2_592_000_000n, "IOS-060: expiresSoonMs on a yearly clock is 30 days");
  r.eq(M.paramsExpiresSoonMs({ periodMs: 600_000n, renewWindowMs: 600_000n }), 600_000n, "IOS-060: expiresSoonMs on a 10-minute clock is the renewal window");
  r.eq(M.paramsExpiresSoonMs({ periodMs: 3_600_000n, renewWindowMs: 60_000n }), 300_000n, "IOS-060: expiresSoonMs is a twelfth of a short period when that is longer than the window");
  r.eq(C.hex(m.priceCovenantId), s(v.priceCovenantId), "price covenant id");
  r.eq(m.genesisShards.length, num(v.priceShards), "price genesis shards");
  r.eq(m.params.periodMs, u64(v.periodMs), "periodMs");
  // a wrong price covenant id is caught
  const jp = structuredClone(v.manifest);
  jp.priceCovenantId = "cd".repeat(32);
  jp.priceGenesis.priceCovenantId = "cd".repeat(32);
  r.check(!verifies(M.decodeManifest(jp)), "manifest with a wrong price covenant id verified");
  // tampering is caught
  const j = structuredClone(v.manifest);
  j.registryCovenantId = "ab".repeat(32);
  r.check(!verifies(M.decodeManifest(j)), "manifest with a wrong registry id verified");
  const j2 = structuredClone(v.manifest);
  j2.artifacts.KachatGap.suffixHex = j2.artifacts.KachatGap.suffixHex.slice(0, -2) + "00";
  r.check(!verifies(M.decodeManifest(j2)), "manifest with a tampered gap suffix verified");
  const j3 = structuredClone(v.manifest);
  j3.network = "mainnet";
  r.check(!verifies(M.decodeManifest(j3)), "mainnet manifest verified");
  // the bundled testnet-10 manifest: byte-identical to iOS (when the iOS repo is here) and verified
  const bundledPath = join(repo, "engine/kachat-names/kachat-names-testnet-10.json");
  const bundled = readFileSync(bundledPath);
  const iosPath = [
    "/Users/restosaved/Everything KaChat/KaChat/KaChat/Resources/kachat-names-testnet-10.json",
    "/Users/restosaved/KaChat/KaChat/Resources/kachat-names-testnet-10.json",
  ].find((x) => existsSync(x));
  if (iosPath) r.check(Buffer.compare(bundled, readFileSync(iosPath)) === 0, "bundled manifest differs from the iOS resource");
  // the bundled manifest: either a verified v3 one, or an earlier one the app shows as "setting up"
  try {
    const bm = M.decodeManifest(new Uint8Array(bundled));
    M.verifyManifest(bm);
    r.check(!bm.isDryRun, "the bundled manifest is a dry run");
    r.pass += 1;
    console.log("bundled manifest: registry v3, verified");
  } catch (e) {
    r.check(e instanceof C.Failure && e.isOutdatedRegistry, `the bundled manifest neither verifies nor is an outdated one: ${e.message}`);
    console.log("bundled manifest: an earlier registry (outdated) - the app shows .kachat as setting up until the v3 genesis manifest is bundled");
  }
  return m;
}

/** The period rules on their own (KACHAT_NAMES.md 4.1, ops.rs) on the testnet-10 short clock
 *  (registry v3: periodMs = renewWindowMs = graceMs = 10 minutes): what extend may add, when renew
 *  opens, its lock time, the refusals. Port of Swift `runPeriodRules`. */
function runPeriodRules(v, m, r) {
  const p = m.params;
  const y = p.periodMs;
  r.eq(y, 600_000n, "periodMs from the manifest (10 minutes)");
  r.eq(p.renewWindowMs, 600_000n, "renewWindowMs from the manifest");
  r.eq(u64(v.renewWindowMs), p.renewWindowMs, "renewWindowMs matches the vectors");
  const start = 2_000_000_000_000n;
  r.eq(M.paramsExtendableYears(p, start, start + y), 1n, "1-period registration: extend by 1");
  r.eq(M.paramsExtendableYears(p, start, start + 2n * y), 0n, "2-period registration: no extend");
  r.eq(M.paramsExtendableYears(p, start, start + y + 1n), 0n, "just over a period paid: no extend");
  r.eq(M.paramsExtendableYears(p, start, start + 3n * y), 0n, "over-full: no extend");
  r.eq(M.paramsExtendableYears(p, start, start), 2n, "nothing paid: 2 periods");
  const f = C.nameFieldsFor("alice", new Uint8Array(32).fill(7), 0n, start, start + y);
  r.eq(M.paramsExtendableYearsOf(p, f), 1n, "extendableYears of the fields");
  r.eq(C.nameFieldsExtended(f, 1n, y).periodStart, start, "extend keeps periodStart");
  r.eq(C.nameFieldsExtended(f, 1n, y).expiresAt, start + 2n * y, "extend adds a period");
  r.eq(C.nameFieldsRenewed(f, 2n, y).periodStart, start + y, "renew starts at the old expiry");
  r.eq(C.nameFieldsRenewed(f, 2n, y).expiresAt, start + 3n * y, "renew adds from the old expiry");
  r.eq(C.nameFieldsWithOwner(f, new Uint8Array(32).fill(9)).periodStart, start, "transfer keeps periodStart");
  r.eq(C.nameFieldsWithPrice(f, 5n).periodStart, start, "list keeps periodStart");
  r.check((() => { try { return C.nameFieldsEqual(C.decodeNameState(C.nameState(f)), f); } catch { return false; } })(), "126-byte state round trip");
  r.check((() => { try { C.decodeNameState(C.nameState(f).subarray(0, 117)); return false; } catch { return true; } })(), "a 117-byte (v1) state is refused");
  // a 2-period name, so the window (one period before expiry) opens a period in
  const f2 = C.nameFieldsFor("alice", new Uint8Array(32).fill(7), 0n, start, start + 2n * y);
  const opens = M.paramsRenewOpens(p, f2.expiresAt);
  r.eq(opens, f2.expiresAt - 600_000n, "renew opens one period before expiry");
  const before = B.makeEnv({ me: f.owner, blockDaa: 1n, blockTimeMs: opens - 60_000n, wallMs: opens + 60_000n });
  r.check(!B.renewWindowOpen(before, p, f2.expiresAt), "window closed while the median time is before the opening");
  r.eq(B.renewLockTime(before, p, f2.expiresAt), opens, "lock time never before the opening");
  const at = B.makeEnv({ me: f.owner, blockDaa: 1n, blockTimeMs: opens, wallMs: opens + 180_000n });
  r.check(!B.Builder.renewWindowOpen(at, p, f2.expiresAt), "window closed at exactly the opening (the median time must pass it)");
  const after = B.makeEnv({ me: f.owner, blockDaa: 1n, blockTimeMs: opens + 300_000n, wallMs: opens + 400_000n });
  r.check(B.renewWindowOpen(after, p, f2.expiresAt), "window open five minutes later");
  r.eq(B.Builder.renewLockTime(after, p, f2.expiresAt), opens + 220_000n, "lock time = wall - 3 min once open");
  // desktop extra: periodMs is required where a period is added
  r.check((() => { try { C.nameFieldsExtended(f, 1n); return false; } catch (e) { return e instanceof C.Failure; } })(), "nameFieldsExtended without periodMs refused");
  // the builders refuse what the contract refuses, and say so
  const b = new B.Builder(m);
  const refused = (fn) => { try { fn(); return false; } catch (e) { return e instanceof C.Failure; } };
  const ext = v.steps.find((x) => s(x.op) === "extend");
  if (ext) {
    const env0 = ext.env;
    const env = B.makeEnv({ me: hx(env0.me), blockDaa: u64(env0.blockDaa), blockTimeMs: u64(env0.blockTimeMs), wallMs: u64(env0.wallMs) });
    const n = nameRec(ext.records.name);
    const wallet = ext.wallet.map(utxo);
    const sh = shardRec(ext.records.shard);
    r.check(refused(() => b.extend({ env, wallet, name: n, shard: sh, years: 2n })), "extend past 2 periods from periodStart refused");
    n.fields = C.nameFieldsExtended(n.fields, 1n, p.periodMs);
    r.check(refused(() => b.extend({ env, wallet, name: n, shard: sh, years: 1n })), "a second extend of a full name refused");
    r.check(refused(() => b.extend({ env, wallet, name: n, shard: sh, years: 0n })), "extend by 0 refused");
    // a shard with the wrong covenant id (a look-alike) is refused before anything is built
    const fake = shardRec(ext.records.shard);
    fake.utxo.entry.covenantId = null;
    r.check(refused(() => b.extend({ env, wallet, name: nameRec(ext.records.name), shard: fake, years: 1n })), "a look-alike price shard refused");
    // renew before the window: built (a note says it is not open) with the opening as lock time
    let plan = null;
    try { plan = b.renew({ env, wallet, name: n, shard: sh, years: 1n }); } catch { plan = null; }
    if (plan) {
      r.eq(plan.unsignedTx.lockTime, M.paramsRenewOpens(p, n.fields.expiresAt), "early renew: lock time = the window opening");
      r.check(plan.notes.some((x) => x.startsWith("renewal window not open")), "early renew: noted as not open");
      r.check(!B.renewWindowOpen(env, p, n.fields.expiresAt), "early renew: window closed");
    } else {
      r.check(false, "early renew plan not built");
    }
    r.check(refused(() => b.renew({ env, wallet, name: n, shard: sh, years: 3n })), "renew by 3 refused");
  } else {
    r.check(false, "no extend step in the vectors");
  }
  // the fixed budgets are the vectors' table, entry for entry
  const recommended = v.recommendedBudgets;
  const roles = Object.values(B.BudgetRole);
  // price.update / price.follow are the CLI's (price changes); every other role is the app's
  const appKeys = Object.keys(recommended).filter((k) => k !== "price.update" && k !== "price.follow");
  r.eq(appKeys.sort().join(","), [...roles].sort().join(","), "budget roles = recommendedBudgets keys");
  for (const role of roles) {
    r.eq(BigInt(B.recommendedBudgets[role]), u64(recommended[role]), `recommended budget ${role}`);
  }
  // an earlier registry's manifest (no registryVersion 3) is recognised as outdated, never trusted
  const old = structuredClone(v.manifest);
  delete old.registryVersion;
  try {
    M.decodeManifest(JSON.stringify(old));
    r.check(false, "a manifest without registryVersion 3 decoded");
  } catch (e) {
    r.check(e instanceof C.Failure && e.isOutdatedRegistry, `a manifest without registryVersion 3 is the outdated registry: ${e.message}`);
  }
  // desktop extra: registryVersion 2 (the previous genesis) is outdated too
  const v2 = structuredClone(v.manifest);
  v2.registryVersion = 2;
  try {
    M.decodeManifest(v2);
    r.check(false, "a registryVersion 2 manifest decoded");
  } catch (e) {
    r.check(e instanceof C.Failure && e.isOutdatedRegistry, `registryVersion 2 is the outdated registry: ${e.message}`);
  }
  r.check(C.Failure.outdatedRegistry().isOutdatedRegistry && !new C.Failure("x").isOutdatedRegistry, "Failure.outdatedRegistry / isOutdatedRegistry");
}

function build(b, op, env, wallet, args, rec) {
  switch (op) {
    case "commit": return b.commit({ env, wallet, name: s(args.name), salt: hx(args.salt) });
    case "register": return b.register({ env, wallet, gap: gapRec(rec.gap), commit: commitRec(rec.commit), shard: shardRec(rec.shard), years: u64(args.years), now: u64(args.now) });
    case "extend": return b.extend({ env, wallet, name: nameRec(rec.name), shard: shardRec(rec.shard), years: u64(args.years) });
    case "renew": return b.renew({ env, wallet, name: nameRec(rec.name), shard: shardRec(rec.shard), years: u64(args.years) });
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

/** The steps the app builds: price changes (setPrices) are built by the CLI only (the authority
 *  signs on KasSigner); the app reads the result. */
const appSteps = (v) => v.steps.filter((st) => st.op !== "setPrices");

function runSteps(v, m, r) {
  const b = new B.Builder(m);
  const results = [];
  const recommended = v.recommendedBudgets;
  r.eq(Object.keys(B.recommendedBudgets).length, Object.keys(recommended).length - 2, "recommended table size (less price.update / price.follow)");
  for (const st of appSteps(v)) {
    const failBefore = r.fail;
    const failuresBefore = r.failures.length;
    const label = s(st.label);
    const env0 = st.env;
    const exp = st.expected;
    const expInputs = exp.inputs;
    const budgets = { ...B.recommendedBudgets };
    for (const i of expInputs) {
      const role = s(i.role);
      const measured = num(i.computeBudget);
      r.check(role in B.recommendedBudgets, `${label}: unknown role ${role}`);
      r.check(measured <= B.budgetFor(B.recommendedBudgets, role), `${label}: measured budget ${measured} > recommended for ${role}`);
      r.eq(B.recommendedBudgets[role], num(recommended[role]), `recommended table ${role}`);
      budgets[role] = measured;
    }
    const env = B.makeEnv({ me: hx(env0.me), blockDaa: u64(env0.blockDaa), blockTimeMs: u64(env0.blockTimeMs), wallMs: u64(env0.wallMs), feerate: Number(env0.feerate), budgets });
    const wallet = st.wallet.map(utxo);
    const args = st.args;
    const rec = st.records;
    let plan;
    try {
      plan = build(b, s(st.op), env, wallet, args, rec);
      if (st.op === "register") {
        r.eq(B.registerNow(env), u64(args.now) + (label.includes("lapse") ? 45n * 60_000n : 0n), `${label}: registerNow`);
      } else if (st.op === "offer") {
        r.eq(plan.newOffer ? C.hex(plan.newOffer.fields.seller) : null, s(args.seller), `${label}: made to the seller`);
      } else if (st.op === "extend") {
        const n = nameRec(rec.name);
        r.check(u64(args.years) <= M.paramsExtendableYearsOf(m.params, n.fields), `${label}: extendableYears covers the step`);
        const lockAndSequences = new Set([plan.unsignedTx.lockTime, ...plan.unsignedTx.inputs.map((i) => i.sequence)]);
        r.check(lockAndSequences.size === 1 && lockAndSequences.has(0n), `${label}: lock time 0, every sequence 0`);
      } else if (st.op === "renew") {
        const n = nameRec(rec.name);
        const a = env.wallMs - 180_000n, bt = env.blockTimeMs - 1_000n;
        const lo = a < bt ? a : bt;
        const opens = n.fields.expiresAt - m.params.renewWindowMs;
        const rule = lo > opens ? lo : opens;
        r.eq(plan.unsignedTx.lockTime, rule, `${label}: lockTimeRules.renew`);
        r.eq(plan.unsignedTx.lockTime, B.renewLockTime(env, m.params, n.fields.expiresAt), `${label}: renewLockTime`);
        r.check(B.renewWindowOpen(env, m.params, n.fields.expiresAt), `${label}: the window is open`);
        r.check(plan.unsignedTx.inputs.every((i) => i.sequence === 0n), `${label}: every sequence 0`);
      }
    } catch (e) {
      r.check(false, `${label}: builder threw ${e.stack || e}`);
      results.push({ label, ok: false, firstFailure: String(e.message || e) });
      continue;
    }
    const tx0 = plan.unsignedTx;
    r.eq(plan.op, label, `${label}: op label`);
    r.eq(tx0.inputs.length, expInputs.length, `${label}: input count`);
    const expOutputs = exp.outputs;
    r.eq(tx0.outputs.length, expOutputs.length, `${label}: output count`);
    r.eq(BigInt(tx0.version), u64(exp.version), `${label}: version`);
    r.eq(tx0.lockTime, u64(exp.lockTime), `${label}: lock time`);
    r.eqHex(tx0.payload, s(exp.payload), `${label}: payload`);
    r.eqHex(tx0.subnetworkId, s(exp.subnetworkId), `${label}: subnetwork`);
    r.eq(tx0.gas, u64(exp.gas), `${label}: gas`);
    r.eq(tx0.storageMass, u64(exp.storageMass), `${label}: storage mass`);
    r.eq(plan.costs.size, u64(exp.size), `${label}: size`);
    r.eq(plan.costs.computeMass, u64(exp.computeMass), `${label}: compute mass`);
    r.eq(plan.costs.transientMass, u64(exp.transientMass), `${label}: transient mass`);
    r.eq(plan.costs.normalizedTransient, u64(exp.normalizedTransient), `${label}: normalized transient`);
    r.eq(plan.costs.minFee, u64(exp.minFee), `${label}: min fee`);
    r.eq(plan.priceFee, u64(exp.priceFee), `${label}: price fee`);
    r.eq(plan.networkFee, u64(exp.networkFee), `${label}: network fee`);
    r.eq(plan.fee, u64(exp.fee), `${label}: fee`);
    r.eqHex(T.txRestPreimage(tx0), s(exp.restPreimage), `${label}: rest preimage (unsigned)`);
    r.eqHex(plan.txid, s(exp.txid), `${label}: txid (unsigned)`);
    r.eq(T.txIdHex(tx0), s(exp.txid), `${label}: txIdHex`);
    const sighashes = B.planSighashes(plan);
    const sigs = new Map();
    expInputs.forEach((ei, i) => {
      if (i >= tx0.inputs.length) return;
      const ti = tx0.inputs[i];
      r.eqHex(ti.outpoint.txid, s(ei.txid), `${label}: input ${i} txid`);
      r.eq(ti.outpoint.index, num(ei.index), `${label}: input ${i} index`);
      r.eq(ti.sequence, u64(ei.sequence), `${label}: input ${i} sequence`);
      r.eq(ti.computeBudget, num(ei.computeBudget), `${label}: input ${i} budget`);
      r.eq(plan.inputs[i].role, s(ei.role), `${label}: input ${i} role`);
      r.check(T.utxoEntryEqual(plan.entries[i], utxo(ei.entry).entry), `${label}: input ${i} entry`);
      r.eqHex(sighashes[i], s(ei.sighash), `${label}: input ${i} sighash`);
      const es = ei.signatures;
      r.eq(B.unlockNeedsSignature(plan.inputs[i].unlock), es.length > 0, `${label}: input ${i} needs a signature`);
      if (es.length > 0) sigs.set(i, hx(es[0]));
    });
    expOutputs.forEach((eo, k) => {
      if (k >= tx0.outputs.length) return;
      const o = tx0.outputs[k];
      r.eq(o.value, u64(eo.value), `${label}: output ${k} value`);
      r.eq(o.scriptVersion, num(eo.scriptVersion), `${label}: output ${k} script version`);
      r.eqHex(o.script, s(eo.script), `${label}: output ${k} script`);
      if (eo.covenant != null) {
        r.eq(o.covenant?.authorizingInput, num(eo.covenant.authorizingInput), `${label}: output ${k} authorizing input`);
        r.eq(o.covenant ? C.hex(o.covenant.covenantId) : null, s(eo.covenant.covenantId), `${label}: output ${k} covenant id`);
      } else {
        r.check(o.covenant == null, `${label}: output ${k} has a covenant binding`);
      }
    });
    try {
      const signed = B.planSignedWithSignatures(plan, sigs);
      expInputs.forEach((ei, i) => {
        if (i < signed.inputs.length) r.eqHex(signed.inputs[i].signatureScript, s(ei.signatureScript), `${label}: input ${i} signature script`);
      });
      r.eqHex(T.txFullPreimage(signed), s(exp.fullPreimage), `${label}: full preimage (signed)`);
      r.eqHex(T.txHash(signed), s(exp.txHash), `${label}: tx hash (signed)`);
      r.eqHex(T.txId(signed), s(exp.txid), `${label}: txid (signed)`);
      r.eqHex(T.txRestPreimage(signed), s(exp.restPreimage), `${label}: rest preimage (signed)`);
      // the unsigned plan is left untouched by signing
      r.eqHex(T.txId(plan.unsignedTx), s(exp.txid), `${label}: unsigned tx untouched`);
      // the signer path calls back once per signing input with that input's sighash
      const seen = [];
      const viaSigner = B.planSignedBy(plan, (h) => { seen.push(C.hex(h)); return new Uint8Array(64).fill(0x11); });
      const wanted = sighashes.filter((_, i) => B.unlockNeedsSignature(plan.inputs[i].unlock)).map(C.hex);
      r.eq(seen.join(","), wanted.join(","), `${label}: signer sees the sighashes`);
      r.eq(viaSigner.inputs.map((i) => i.signatureScript.length).join(","), signed.inputs.map((i) => i.signatureScript.length).join(","), `${label}: signature script lengths`);
      const reqs = B.planSigningRequests(plan);
      r.eq(reqs.map((q) => C.hex(q.sighash)).join(","), wanted.join(","), `${label}: signing requests`);
    } catch (e) {
      r.check(false, `${label}: signing threw ${e.stack || e}`);
    }
    if (plan.newCommit) {
      r.eq(plan.newCommit.name, s(args.name), `${label}: new commit name`);
      r.check(C.bytesEqual(plan.newCommit.utxo.outpoint.txid, plan.txid), `${label}: new commit outpoint`);
    }
    if (plan.newOffer) {
      r.check(C.bytesEqual(plan.newOffer.utxo.outpoint.txid, plan.txid), `${label}: new offer outpoint`);
      r.check(C.bytesEqual(plan.newOffer.utxo.entry.script, tx0.outputs[0].script), `${label}: new offer script`);
    }
    const ok = r.fail === failBefore;
    results.push({ label, ok, firstFailure: ok ? null : r.failures[failuresBefore] });
  }
  return results;
}

function runFixedBudgets(v, m, r) {
  // every step also builds with the app's fixed (recommended) budgets, as the app will run them
  // (Swift: writeFixedBudget, which kachat-names-vectors check validates 35/35)
  const b = new B.Builder(m);
  for (const st of appSteps(v)) {
    const env = B.makeEnv({ me: hx(st.env.me), blockDaa: u64(st.env.blockDaa), blockTimeMs: u64(st.env.blockTimeMs), wallMs: u64(st.env.wallMs) });
    try {
      const plan = build(b, st.op, env, st.wallet.map(utxo), st.args, st.records);
      r.check(plan.unsignedTx.inputs.every((i, k) => i.computeBudget === B.recommendedBudgets[plan.inputs[k].role]), `${st.label}: fixed budgets`);
    } catch (e) {
      r.check(false, `${st.label}: fixed-budget build threw ${e.message}`);
    }
  }
}

/** JSON with BigInt written as plain integers (u64 values above 2^53 stay exact). */
function jsonWithBigInts(value) {
  const marks = [];
  const text = JSON.stringify(value, (_, x) => {
    if (typeof x !== "bigint") return x;
    marks.push(x.toString());
    return `@@big${marks.length - 1}@@`;
  }, 2);
  return text.replace(/"@@big(\d+)@@"/g, (_, i) => marks[Number(i)]);
}

/** Builds every vector step again with the app's fixed (recommended) budgets and writes the
 *  transactions, with placeholder signatures, for `kachat-names-vectors check` (Swift
 *  `writeFixedBudget`). */
function writeFixedBudget(v, m, out) {
  const b = new B.Builder(m);
  const entryJSON = (e) => ({
    amount: e.amount, scriptVersion: e.scriptVersion, script: C.hex(e.script), blockDaaScore: e.blockDaaScore,
    isCoinbase: e.isCoinbase, covenantId: e.covenantId ? C.hex(e.covenantId) : null,
  });
  const txs = appSteps(v).map((st) => {
    const env = B.makeEnv({ me: hx(st.env.me), blockDaa: u64(st.env.blockDaa), blockTimeMs: u64(st.env.blockTimeMs), wallMs: u64(st.env.wallMs) });
    const plan = build(b, st.op, env, st.wallet.map(utxo), st.args, st.records);
    const tx = plan.unsignedTx;
    return {
      label: plan.op, blockDaa: env.blockDaa, blockTimeMs: env.blockTimeMs,
      version: tx.version, lockTime: tx.lockTime, payload: C.hex(tx.payload), storageMass: tx.storageMass,
      networkFee: plan.networkFee, priceFee: plan.priceFee, computeMass: plan.costs.computeMass, txid: T.txIdHex(tx),
      inputs: tx.inputs.map((i, k) => ({
        txid: C.hex(i.outpoint.txid), index: i.outpoint.index, sequence: i.sequence, computeBudget: i.computeBudget,
        signatureScript: C.hex(i.signatureScript), entry: entryJSON(plan.entries[k]),
      })),
      outputs: tx.outputs.map((o) => ({
        value: o.value, scriptVersion: o.scriptVersion, script: C.hex(o.script),
        covenant: o.covenant ? { authorizingInput: o.covenant.authorizingInput, covenantId: C.hex(o.covenant.covenantId) } : null,
      })),
    };
  });
  const doc = {
    registryCovenantId: v.manifest.registryCovenantId, priceCovenantId: v.manifest.priceCovenantId, signer: v.deployer.xonly, transactions: txs,
  };
  writeFileSync(out, jsonWithBigInts(doc));
  console.log(`wrote ${txs.length} fixed-budget transactions to ${out}`);
}

async function runAsyncSigner(v, m, r) {
  // planSignedByAsync matches planSignedBy
  const b = new B.Builder(m);
  const st = v.steps.find((x) => x.op === "acceptOffer");
  const env = B.makeEnv({ me: hx(st.env.me), blockDaa: u64(st.env.blockDaa), blockTimeMs: u64(st.env.blockTimeMs), wallMs: u64(st.env.wallMs) });
  const plan = build(b, st.op, env, st.wallet.map(utxo), st.args, st.records);
  const sign = (h) => blake3(h, { dkLen: 64 });
  const a = B.planSignedBy(plan, sign);
  const c = await B.planSignedByAsync(plan, async (h) => sign(h));
  r.eqHex(T.txFullPreimage(c), C.hex(T.txFullPreimage(a)), "async signer matches the sync signer");
}

const vectorsPath = process.argv[2] || join(repo, "tools/fixtures/kachat-names-vectors.json");
const v = JSON.parse(readFileSync(vectorsPath, "utf8"));
const r = new Report();
runBlake3Official(r);
console.log(`blake3 official vectors: ${r.pass} checks pass, ${r.fail} fail`);
runCodecs(v, r);
console.log(`blake3 + codecs: ${r.pass} checks pass, ${r.fail} fail`);
const m = runManifest(v, r);
runPeriodRules(v, m, r);
console.log(`+ manifest and period rules: ${r.pass} checks pass, ${r.fail} fail`);
const results = runSteps(v, m, r);
runFixedBudgets(v, m, r);
await runAsyncSigner(v, m, r);
for (const res of results) {
  console.log((res.ok ? "MATCH  " : "DIFFER ") + res.label + (res.firstFailure ? "   <- " + res.firstFailure : ""));
}
console.log(`vectors: ${r.pass} checks pass, ${r.fail} fail; ${results.filter((x) => x.ok).length}/${results.length} transactions byte-identical`);
for (const f of r.failures.slice(0, 40)) console.log("  FAIL " + f);
if (process.argv[3]) writeFixedBudget(v, m, process.argv[3]);
if (r.fail !== 0) process.exit(1);
console.log("OK");
