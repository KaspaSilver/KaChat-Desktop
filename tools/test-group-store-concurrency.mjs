// node tools/test-group-store-concurrency.mjs - DSK-053: group-store writers that overlap.
// forceRefresh and the routine syncGroups full scan used to read a group record, await the network
// scans and write the whole stale copy back, rolling back a msgCounter reserved meanwhile
// (ChaCha20-Poly1305 key+nonce reuse on chain) and undoing a rotation applied meanwhile. Pinned
// here: those passes merge only their cursors onto a fresh read, group-store mutations are
// serialised, the routine sync stands down during a refresh, and the per-group high-water mark
// keeps the next msg_id from ever going backwards. The real GroupManager runs on in-memory
// localStorage; the indexer reads and the chain send are stubs (nothing is ever broadcast).
import assert from "node:assert/strict";

class MemoryStorage {
  constructor() { this.map = new Map(); }
  getItem(key) { return this.map.has(key) ? this.map.get(key) : null; }
  setItem(key, value) { this.map.set(key, String(value)); }
  removeItem(key) { this.map.delete(key); }
  clear() { this.map.clear(); }
  get length() { return this.map.size; }
  key(index) { return [...this.map.keys()][index] ?? null; }
}
globalThis.localStorage = new MemoryStorage();

const G = await import("../engine/group.js");
const { GroupManager, GROUP_MSG_COUNTER_KEY } = await import("../engine/group-store.js");

const UTF8 = new TextEncoder();
const FROM_UTF8 = new TextDecoder();
const toHex = (s) => G.bytesToHex(UTF8.encode(s));
const fromHex = (h) => FROM_UTF8.decode(G.hexToBytes(h));
const KEY = (n) => n.toString(16).padStart(64, "0");
const SELF = { address: "kaspa:qzselfaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", key: KEY(0x51) };
const ADMIN = { address: "kaspa:qzadminbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", key: KEY(0xad) };
const OTHER = { address: "kaspa:qzothercccccccccccccccccccccccccccccccccccccccccccccccccccc", key: KEY(0x0c) };
const PUB = new Map([SELF, ADMIN, OTHER].map((w) => [w.address, G.bytesToHex(G.xOnlyPublicKey(w.key))]));

const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const settle = async (rounds = 20) => { for (let i = 0; i < rounds; i += 1) await new Promise((r) => setImmediate(r)); };
async function waitFor(cond, what) {
  for (let i = 0; i < 500; i += 1) { if (cond()) return; await new Promise((r) => setImmediate(r)); }
  throw new Error(`timed out waiting for ${what}`);
}

// --- stub engine ---
let scanGate = null;   // when set, every scanGroupMessages call waits for it
let controlGate = null; // when set, gctl sends wait for it (admin paths)
const scanCalls = [];
const sent = [];
const engine = {
  address: SELF.address,
  privateKeyHex: SELF.key,
  log() {},
  groupIndexerUrl: () => "https://indexer.stub.test",
  async xOnlyPubKeyForAddress(address) {
    const pub = PUB.get(address);
    if (!pub) throw new Error(`no key for ${address}`);
    return pub;
  },
  // The stub "ECIES": JSON naming its recipient, so only that wallet can open it.
  async encryptGroupControl(address, json) { return toHex(JSON.stringify({ to: address, body: json })); },
  async decryptGroupControl(encryptedHex) {
    const box = JSON.parse(fromHex(encryptedHex));
    if (box.to !== engine.address) throw new Error("not ours");
    return box.body;
  },
  // Stub of the chain send: records the payload, broadcasts nothing.
  async sendGroupPayload(payload) {
    if (controlGate && payload.startsWith(G.GROUP_PAYLOAD_PREFIXES.gctl)) await controlGate.promise;
    sent.push(payload);
    return { txids: [`tx-${sent.length}`] };
  },
  async scanGroupControlByRecipientPage() { return { rows: [], nextCursor: null, rawCount: 0 }; },
  async scanGroupMessagesSince() { const e = new Error("no /since"); e.unsupported = true; throw e; },
  async scanGroupMessages(blindedHex, cursor) {
    scanCalls.push({ blindedHex, cursor });
    if (scanGate) await scanGate.promise;
    // One unreadable row per stream: decodes to nothing, but carries the newest cursor.
    return [{ txId: `scan-${blindedHex.slice(0, 8)}`, blockTime: 1, cursor: `${cursor || "start"}>next`, payloadString: "junk" }];
  },
};

// A member-side group (we are SELF, ADMIN runs it), epoch 0, three members.
function setupMemberGroup(mgr) {
  const seed = G.generateGroupSeed();
  const groupId = G.deriveGroupId(seed);
  const gid = G.bytesToHex(groupId);
  const ok = mgr.importGroupRecord({
    groupId: gid, name: "Test", isAdmin: false,
    adminAddress: ADMIN.address, adminSigningPub: PUB.get(ADMIN.address),
    groupRootEpoch: G.bytesToHex(G.deriveGroupRootEpoch(seed, groupId, 0)),
    blindingKey: G.bytesToHex(G.deriveBlindingKey(seed, groupId)),
    currentEpoch: 0,
    members: [ADMIN, SELF, OTHER].map((w) => ({ address: w.address, xOnlyPubKeyHex: PUB.get(w.address), isAdmin: w === ADMIN })),
  });
  assert.ok(ok, "group imported");
  return { seed, groupId, gid };
}
// The admin's gctl_root for `epoch`, as it arrives on the by-recipient stream (addressed to SELF).
function rootControl({ seed, groupId }, epoch, members) {
  const payload = G.buildSignedRootPayload({
    groupId, epoch,
    groupRootEpoch: G.deriveGroupRootEpoch(seed, groupId, epoch),
    blindingKey: G.deriveBlindingKey(seed, groupId),
    adminSigningPub: PUB.get(ADMIN.address),
    members: members.map((w) => w.address),
    name: "Test", adminPrivateKey: ADMIN.key,
  });
  return G.buildControlPayload({ recipientXOnlyPubKey: G.hexToBytes(PUB.get(SELF.address)), encryptedHex: toHex(JSON.stringify({ to: SELF.address, body: JSON.stringify(payload) })) });
}
const sentMsgIds = () => sent.map((p) => G.parseGroupMessagePayload(p)).filter(Boolean).map((m) => `${m.epoch}/${G.bytesToHex(m.msgId)}`);
function reset() {
  localStorage.clear();
  scanGate = null; controlGate = null;
  scanCalls.length = 0; sent.length = 0;
  engine.address = SELF.address; engine.privateKeyHex = SELF.key;
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test("forceRefresh with a slow scan: two sends meanwhile get unique counters and the higher one is stored", async () => {
  reset();
  const mgr = new GroupManager(engine);
  const g = setupMemberGroup(mgr);
  scanGate = deferred();
  const refresh = mgr.forceRefresh(g.gid);
  await waitFor(() => scanCalls.length > 0, "the refresh scans to start");
  const a = await mgr.sendGroupMessage(g.gid, "one");
  const b = await mgr.sendGroupMessage(g.gid, "two");
  assert.deepEqual([a.counter, b.counter], [0, 1], "counters reserved in order");
  scanGate.resolve();
  await refresh;
  const stored = mgr.getGroup(g.gid);
  assert.equal(stored.msgCounter, 2, "the refresh did not write its pre-scan msgCounter (0) back");
  assert.equal(Object.keys(stored.cursors).length, 3, "the refresh's rebuilt cursors were merged");
  const c = await mgr.sendGroupMessage(g.gid, "three");
  assert.equal(c.counter, 2, "the next send continues after the last reserved counter");
  const ids = sentMsgIds();
  assert.equal(ids.length, 3);
  assert.equal(new Set(ids).size, 3, "no msg_id went on the wire twice");
});

test("a rotation applied mid-refresh survives the refresh", async () => {
  reset();
  const mgr = new GroupManager(engine);
  const g = setupMemberGroup(mgr);
  const oldRoot = mgr.getGroup(g.gid).groupRootEpochHex;
  scanGate = deferred();
  const refresh = mgr.forceRefresh(g.gid);
  await waitFor(() => scanCalls.length > 0, "the refresh scans to start");
  const before = await mgr.sendGroupMessage(g.gid, "in epoch 0");
  // The admin removes OTHER and rotates; the routine path applies it while the refresh scans.
  const ev = await mgr.applyControl(rootControl(g, 1, [ADMIN, SELF]), ADMIN.address);
  assert.equal(ev?.kind, "root-updated");
  assert.deepEqual(ev.removed, [OTHER.address]);
  const after = await mgr.sendGroupMessage(g.gid, "in epoch 1");
  scanGate.resolve();
  await refresh;
  const stored = mgr.getGroup(g.gid);
  assert.equal(stored.currentEpoch, 1, "epoch 1 kept");
  assert.equal(stored.groupRootEpochHex, G.bytesToHex(G.deriveGroupRootEpoch(g.seed, g.groupId, 1)), "the new root kept");
  assert.equal(stored.previousRootsHex["0"], oldRoot, "the retired root archived");
  assert.deepEqual(stored.members.map((m) => m.address).sort(), [ADMIN.address, SELF.address].sort(), "the new roster kept");
  assert.deepEqual([before.epoch, before.counter, after.epoch, after.counter], [0, 0, 1, 0], "a new epoch starts its counter at 0");
  assert.equal(stored.msgCounter, 1, "epoch 1's reserved counter kept");
  assert.equal((await mgr.sendGroupMessage(g.gid, "next")).epoch, 1, "this device keeps sending in the new epoch");
});

test("the high-water mark prevents a reused counter even if msgCounter is forced back", async () => {
  reset();
  const mgr = new GroupManager(engine);
  const g = setupMemberGroup(mgr);
  const stale = mgr.getGroup(g.gid); // msgCounter 0
  for (let i = 0; i < 3; i += 1) await mgr.sendGroupMessage(g.gid, `m${i}`);
  // A stale write slips through anyway (the old bug, or any future one): msgCounter back to 0.
  mgr._put(stale);
  assert.equal(mgr.getGroup(g.gid).msgCounter, 0, "the record really was rolled back");
  assert.equal((await mgr.sendGroupMessage(g.gid, "after rollback")).counter, 3, "max(msgCounter, mark + 1)");
  // Same after a reload (new store instance, same storage) and a second rollback.
  const reloaded = new GroupManager(engine);
  reloaded._put({ ...reloaded.getGroup(g.gid), msgCounter: 1 });
  assert.equal((await reloaded.sendGroupMessage(g.gid, "after reload")).counter, 4, "the mark is persisted");
  const marks = JSON.parse(localStorage.getItem(GROUP_MSG_COUNTER_KEY));
  const deviceIdHex = reloaded.getGroup(g.gid).deviceIdHex;
  assert.equal(marks[SELF.address][g.gid][`${deviceIdHex}:0`], 4, "mark = highest reserved counter, per device and epoch");
  // A mark that cannot be persisted refuses the send: nothing goes on the wire.
  const setItem = localStorage.setItem;
  localStorage.setItem = function (key, value) {
    if (key === GROUP_MSG_COUNTER_KEY) throw new Error("QuotaExceededError");
    return setItem.call(this, key, value);
  };
  const sentBefore = sent.length;
  try {
    await assert.rejects(reloaded.sendGroupMessage(g.gid, "no room"), /message counter/);
  } finally { localStorage.setItem = setItem; }
  assert.equal(sent.length, sentBefore, "nothing was sent without a persisted reservation");
  assert.equal((await reloaded.sendGroupMessage(g.gid, "room again")).counter, 5, "the refused attempt reserved nothing");
  assert.equal(new Set(sentMsgIds()).size, sentMsgIds().length, "every msg_id on the wire is unique");
  // Deleting the group drops its marks with it.
  reloaded.deleteGroup(g.gid);
  assert.equal(JSON.parse(localStorage.getItem(GROUP_MSG_COUNTER_KEY))[SELF.address][g.gid], undefined, "marks dropped on delete");
});

test("the routine sync while forceRefresh runs stands down and does not clobber it", async () => {
  reset();
  const mgr = new GroupManager(engine);
  const g = setupMemberGroup(mgr);
  scanGate = deferred();
  const refresh = mgr.forceRefresh(g.gid);
  await waitFor(() => scanCalls.length === 3, "the refresh scans to start");
  const during = await mgr.syncGroups();
  assert.equal(during.skipped, "refreshing", "the routine pass stood down");
  assert.deepEqual([during.controls, during.messages], [[], []]);
  assert.equal(scanCalls.length, 3, "it read nothing");
  const sentMsg = await mgr.sendGroupMessage(g.gid, "during refresh");
  scanGate.resolve();
  await refresh;
  const stored = mgr.getGroup(g.gid);
  assert.ok(Object.values(stored.cursors).every((c) => c === "start>next"), "the refresh's cursors stand");
  assert.equal(stored.msgCounter, sentMsg.counter + 1);
  // Once the refresh is done, the routine sync runs again, from the refresh's cursors.
  scanCalls.length = 0;
  const afterwards = await mgr.syncGroups();
  assert.equal(afterwards.skipped, undefined);
  assert.equal(scanCalls.length, 3);
  assert.ok(scanCalls.every((c) => c.cursor === "start>next"), "resumes from the refresh's cursors");
});

test("syncGroups full scan: a send and a rotation during the scan survive; a cursor reset meanwhile is kept", async () => {
  reset();
  const mgr = new GroupManager(engine);
  const g = setupMemberGroup(mgr);
  await mgr.syncGroups(); // a first pass sets every stream's cursor
  const firstCursors = mgr.getGroup(g.gid).cursors;
  assert.equal(Object.keys(firstCursors).length, 3);
  scanGate = deferred();
  scanCalls.length = 0;
  const pass = mgr.syncGroups();
  await waitFor(() => scanCalls.length === 3, "the sync scans to start");
  assert.equal((await mgr.syncGroups()).skipped, "in-flight", "no overlapping pass");
  const a = await mgr.sendGroupMessage(g.gid, "during sync");
  await mgr.applyControl(rootControl(g, 1, [ADMIN, SELF, OTHER]), ADMIN.address); // new epoch: cursors reset
  scanGate.resolve();
  await pass;
  const stored = mgr.getGroup(g.gid);
  assert.equal(stored.currentEpoch, 1, "the rotation survived the sync's write");
  assert.equal(a.counter, 0);
  assert.equal(stored.msgCounter, 0, "epoch 1 has reserved nothing yet");
  assert.deepEqual(stored.cursors, {}, "the reset cursors stay reset, so the new key's history is re-walked");
  assert.equal((await mgr.sendGroupMessage(g.gid, "epoch 1")).counter, 0);
  // Same epoch: a counter reserved during the scan is not rolled back by it.
  scanGate = deferred();
  scanCalls.length = 0;
  const pass2 = mgr.syncGroups();
  await waitFor(() => scanCalls.length === 3, "the second sync's scans to start");
  const b = await mgr.sendGroupMessage(g.gid, "during sync 2");
  scanGate.resolve();
  await pass2;
  assert.equal(b.counter, 1);
  assert.equal(mgr.getGroup(g.gid).msgCounter, 2, "the reservation survived the sync's write");
  assert.equal(Object.keys(mgr.getGroup(g.gid).cursors).length, 3, "the sync's cursors merged where nobody moved them");
});

test("forceRefresh waits for a routine pass already in flight before re-walking", async () => {
  reset();
  const mgr = new GroupManager(engine);
  const g = setupMemberGroup(mgr);
  scanGate = deferred();
  const pass = mgr.syncGroups();
  await waitFor(() => scanCalls.length === 3, "the sync scans to start");
  const phases = [];
  const refresh = mgr.forceRefresh(g.gid, (p) => phases.push(p.phase));
  await settle();
  assert.deepEqual(phases, [], "the refresh has not started while the sync runs");
  scanGate.resolve();
  await pass;
  await refresh;
  assert.equal(phases[0], "invites");
  assert.equal(phases.at(-1), "rebuilding");
  assert.equal(scanCalls.filter((c) => c.cursor === null).length, 6, "both read from the start (the sync had no cursors yet)");
});

test("ten concurrent sends: ten unique counters, no deadlock", async () => {
  reset();
  const mgr = new GroupManager(engine);
  const g = setupMemberGroup(mgr);
  const results = await Promise.all(Array.from({ length: 10 }, (_, i) => mgr.sendGroupMessage(g.gid, `c${i}`)));
  assert.deepEqual(results.map((r) => r.counter).sort((x, y) => x - y), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(mgr.getGroup(g.gid).msgCounter, 10);
  // A locked section that throws releases the lock.
  await assert.rejects(mgr.sendGroupMessage("ff".repeat(16), "nowhere"), /Group not found/);
  assert.equal((await mgr.sendGroupMessage(g.gid, "after a failure")).counter, 10);
});

test("admin rotation: the post-send selfInviteEpoch write does not roll back a counter reserved meanwhile", async () => {
  reset();
  engine.address = ADMIN.address; engine.privateKeyHex = ADMIN.key;
  const mgr = new GroupManager(engine);
  const created = await mgr.createGroup({ name: "Admin", memberAddresses: [SELF.address, OTHER.address] });
  const gid = created.groupId;
  controlGate = deferred();
  const rotation = mgr.removeMember(gid, OTHER.address);
  await waitFor(() => mgr.getGroup(gid).currentEpoch === 1, "the rotation to apply");
  const s1 = await mgr.sendGroupMessage(gid, "during rotation");
  const s2 = await mgr.sendGroupMessage(gid, "during rotation 2");
  controlGate.resolve();
  const done = await rotation;
  const stored = mgr.getGroup(gid);
  assert.deepEqual([s1.epoch, s1.counter, s2.counter], [1, 0, 1]);
  assert.equal(stored.msgCounter, 2, "the rotation's later writes kept the reservation");
  assert.equal(stored.selfInviteEpoch, 1, "the recovery invite is still marked");
  assert.equal(done.msgCounter, 2, "the returned record is the fresh one");
  assert.deepEqual(stored.members.map((m) => m.address).sort(), [ADMIN.address, SELF.address].sort());
});

let passed = 0;
for (const { name, fn } of tests) {
  try { await fn(); passed += 1; console.log(`ok ${passed} - ${name}`); }
  catch (error) { console.error(`not ok - ${name}`); throw error; }
}
console.log(`\n${passed} passed`);
