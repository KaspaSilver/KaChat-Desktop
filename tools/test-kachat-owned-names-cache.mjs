// Your Domains' saved .kachat list (engine/kachat-names/owned-names-cache.js, iOS f4f5c0f
// KachatOwnedNamesCache): kept per network and address as { names, offers, savedAt } with BigInt
// and bytes surviving the round trip; shown at once minus the names that lapsed since; only a
// registry answer replaces it - a failed read keeps what is shown and the saved copy as they were;
// the domain counts start from it. Run from the repo root: node tools/test-kachat-owned-names-cache.mjs
import assert from "node:assert/strict";
import {
  KachatOwnedNamesCache, ownedNamesStorageKey, ownedNamesToJSON, ownedNamesFromJSON, ownedNamesFormatVersion,
} from "../engine/kachat-names/owned-names-cache.js";
import { NameInfo, OfferInfo, Status } from "../engine/kachat-names/registry-state.js";
import { makeOutpoint } from "../engine/kachat-names/transaction.js";
import { hex } from "../engine/kachat-names/codec.js";

const bytes = (b) => new Uint8Array(32).fill(b);
const now = 1_800_000_000_000n;
const grace = 864_000_000n; // 10 days
const day = 86_400_000n;

function name(n, expiresAt, extra = {}) {
  return new NameInfo({
    name: n, key: bytes(n.length), owner: bytes(7), price: 0n, expiresAt, periodStart: expiresAt - 365n * day,
    outpoint: makeOutpoint(bytes(n.charCodeAt(0) & 0xff), 1), registeredAt: expiresAt - 365n * day, registeredTxId: "ab".repeat(32),
    updatedAt: null, ...extra,
  });
}
const active = name("alice", now + 30n * day, { price: 123_456_789_012_345_678n }); // past 2^53
const inGrace = name("bob", now - day);
const lapsed = name("carol", now - grace - day);
const offer = new OfferInfo({
  outpoint: makeOutpoint(bytes(9), 0), key: bytes(3), name: "dave", buyer: bytes(7), seller: bytes(8),
  amount: 9_007_199_254_740_993n, refundAfter: 400_000_000_000n, createdAt: now,
});
assert.equal(active.status(grace, now), Status.active);
assert.equal(inGrace.status(grace, now), Status.grace);
assert.equal(lapsed.status(grace, now), Status.lapsed);

/** a storage adapter that records writes */
function memoryStorage() {
  const map = new Map();
  return { map, writes: 0, get(k) { return map.has(k) ? map.get(k) : null; }, set(k, v) { this.writes += 1; map.set(k, String(v)); } };
}

const testnetAddress = "kaspatest:qq0000000000000000000000000000000000000000000000000000000000000000";
const mainnetAddress = "kaspa:qq0000000000000000000000000000000000000000000000000000000000000000";

// --- keys: per network and address ---------------------------------------------------------
assert.equal(ownedNamesStorageKey(testnetAddress), `kachat-names-owned-testnet-v1:${testnetAddress}`);
assert.equal(ownedNamesStorageKey(mainnetAddress), `kachat-names-owned-mainnet-v1:${mainnetAddress}`);
assert.equal(ownedNamesStorageKey(` ${testnetAddress.toUpperCase()} `), ownedNamesStorageKey(testnetAddress));

// --- round trip: BigInt past 2^53 and bytes survive ------------------------------------------
{
  const text = ownedNamesToJSON({ names: [active, inGrace], offers: [offer], savedAt: 1234 });
  assert.doesNotThrow(() => JSON.parse(text)); // plain JSON, no BigInt left in it
  const back = ownedNamesFromJSON(text);
  assert.equal(back.savedAt, 1234);
  assert.equal(back.names.length, 2);
  assert.ok(back.names[0] instanceof NameInfo);
  assert.equal(back.names[0].price, 123_456_789_012_345_678n);
  assert.equal(back.names[0].expiresAt, active.expiresAt);
  assert.equal(back.names[0].periodStart, active.periodStart);
  assert.equal(back.names[0].updatedAt, null);
  assert.equal(hex(back.names[0].key), hex(active.key));
  assert.equal(hex(back.names[0].outpoint.txid), hex(active.outpoint.txid));
  assert.equal(back.names[0].outpoint.index, 1);
  assert.equal(back.names[0].display, "alice.kachat");
  assert.equal(back.names[0].isListed, true);
  assert.ok(back.offers[0] instanceof OfferInfo);
  assert.equal(back.offers[0].amount, 9_007_199_254_740_993n);
  assert.equal(back.offers[0].id, offer.id);
  assert.equal(back.offers[0].createdAt, now);
  assert.equal(hex(back.offers[0].seller), hex(offer.seller));
  // another format, or garbage: not a saved list
  assert.throws(() => ownedNamesFromJSON({ v: ownedNamesFormatVersion + 1, names: [] }));
  assert.throws(() => ownedNamesFromJSON("{"));
}

// --- shown at once, minus lapsed names ---------------------------------------------------------
{
  const storage = memoryStorage();
  const cache = new KachatOwnedNamesCache({ storage, clock: { now: () => 5000 } });
  assert.equal(cache.load(testnetAddress), null);
  assert.equal(cache.shown(testnetAddress, grace, now), null);
  assert.equal(cache.count(testnetAddress), null);
  cache.save(testnetAddress, [active, inGrace, lapsed], [offer]);
  const entry = cache.load(testnetAddress);
  assert.equal(entry.savedAt, 5000);
  assert.deepEqual(entry.names.map((n) => n.name), ["alice", "bob", "carol"]);
  const shown = cache.shown(testnetAddress, grace, now);
  // the lapsed one is dropped; the one in grace stays, to be renewed
  assert.deepEqual(shown.names.map((n) => n.name), ["alice", "bob"]);
  assert.deepEqual(shown.offers.map((o) => o.id), [offer.id]);
  // the counts start from the saved list (iOS f4f5c0f: cached.names.count)
  assert.equal(cache.count(testnetAddress), 3);
  // per address and network: nothing for another
  assert.equal(cache.load(mainnetAddress), null);
  assert.equal(cache.load(testnetAddress.replace("qq0", "qq1")), null);
  // an unreadable entry is no entry
  storage.map.set(ownedNamesStorageKey(mainnetAddress), "not json");
  assert.equal(cache.load(mainnetAddress), null);
}

// --- only an answer replaces it; a failed read keeps what is shown --------------------------
{
  const storage = memoryStorage();
  let clock = 1000;
  const cache = new KachatOwnedNamesCache({ storage, clock: { now: () => clock } });
  cache.save(testnetAddress, [active, inGrace], [offer]);
  const saved = storage.map.get(ownedNamesStorageKey(testnetAddress));
  const writes = storage.writes;
  const onScreen = cache.shown(testnetAddress, grace, now);

  // failed read: the list on screen and the saved copy stay as they were
  const failed = cache.afterRead(testnetAddress, onScreen, null, grace, now);
  assert.equal(failed.answered, false);
  assert.deepEqual(failed.names.map((n) => n.name), ["alice", "bob"]);
  assert.deepEqual(failed.offers.map((o) => o.id), [offer.id]);
  assert.equal(storage.writes, writes);
  assert.equal(storage.map.get(ownedNamesStorageKey(testnetAddress)), saved);

  // a failed read later on, after the one in grace lapsed meanwhile: it leaves the screen (iOS
  // dropLapsed), the saved copy is untouched
  const later = now + grace + day;
  const failedLater = cache.afterRead(testnetAddress, failed, null, grace, later);
  assert.deepEqual(failedLater.names.map((n) => n.name), ["alice"]);
  assert.equal(storage.map.get(ownedNamesStorageKey(testnetAddress)), saved);

  // nothing shown and the read failed: nothing to show (the empty note)
  const none = cache.afterRead(testnetAddress, null, null, grace, now);
  assert.deepEqual(none, { names: [], offers: [], answered: false });
  assert.equal(storage.map.get(ownedNamesStorageKey(testnetAddress)), saved);

  // an answer replaces both - a sale, a transfer or a lapse lands then
  clock = 2000;
  const dave = name("dave", now + 60n * day);
  const answered = cache.afterRead(testnetAddress, onScreen, { names: [dave], offers: [] }, grace, now);
  assert.equal(answered.answered, true);
  assert.deepEqual(answered.names.map((n) => n.name), ["dave"]);
  assert.deepEqual(answered.offers, []);
  const after = cache.load(testnetAddress);
  assert.equal(after.savedAt, 2000);
  assert.deepEqual(after.names.map((n) => n.name), ["dave"]);
  assert.deepEqual(after.offers, []);

  // an answer of no names is an answer too: the saved list empties
  cache.afterRead(testnetAddress, answered, { names: [], offers: [] }, grace, now);
  assert.deepEqual(cache.load(testnetAddress).names, []);
  assert.equal(cache.count(testnetAddress), 0);
}

// --- storage full or blocked: the read's answer is still shown --------------------------------
{
  const cache = new KachatOwnedNamesCache({ storage: { get() { throw new Error("blocked"); }, set() { throw new Error("full"); } } });
  assert.equal(cache.load(testnetAddress), null);
  const r = cache.afterRead(testnetAddress, null, { names: [active], offers: [] }, grace, now);
  assert.deepEqual(r.names.map((n) => n.name), ["alice"]);
}

console.log("kachat owned names cache: ok");
