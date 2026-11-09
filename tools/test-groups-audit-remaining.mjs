// node tools/test-groups-audit-remaining.mjs - the group fixes from iOS 4f8e14bb that Desktop's
// outage port left out: replay protection, former members, the invite cap and retention. The real
// GroupManager decodes genuinely sealed and signed messages on in-memory localStorage; only the
// indexer reads, the control channel's encryption and the chain send are stubs.
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
const {
  GroupManager, GROUP_SEEN_MSG_KEY, MAX_PENDING_GROUP_INVITES, MAX_PENDING_GROUP_INVITES_PER_ADMIN,
} = await import("../engine/group-store.js");

const UTF8 = new TextEncoder();
const toHex = (s) => G.bytesToHex(UTF8.encode(s));
const fromHex = (h) => new TextDecoder().decode(G.hexToBytes(h));
const KEY = (n) => n.toString(16).padStart(64, "0");
const wallet = (name, n) => ({ address: `kaspa:qz${name.padEnd(58, name[0])}`, key: KEY(n) });
const ME = wallet("me", 0xa1);
const OTHER = wallet("other", 0xa2);
const ADMIN = wallet("admin", 0xad);
const BOB = wallet("bob", 0xb0);
const STRANGER = wallet("stranger", 0xee);
const PUB = new Map();
const pub = (w) => { if (!PUB.has(w.address)) PUB.set(w.address, G.bytesToHex(G.xOnlyPublicKey(w.key))); return PUB.get(w.address); };
for (const w of [ME, OTHER, ADMIN, BOB, STRANGER]) pub(w);

const NOW = Date.now();
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// One group's secrets, as its admin holds them.
function makeGroup(admin = ADMIN) {
  const seed = G.generateGroupSeed();
  const id = G.deriveGroupId(seed);
  return { admin, seed, id, idHex: G.bytesToHex(id), blinding: G.deriveBlindingKey(seed, id), root: (epoch) => G.deriveGroupRootEpoch(seed, id, epoch) };
}

function controlFor(recipient, group, epoch, members, version) {
  const payload = G.buildSignedRootPayload({
    groupId: group.id, epoch, groupRootEpoch: group.root(epoch), blindingKey: group.blinding,
    adminSigningPub: pub(group.admin), members: members.map((m) => m.address), name: "Audit",
    adminPrivateKey: group.admin.key, rosterVersion: version,
  });
  return G.buildControlPayload({ recipientXOnlyPubKey: pub(recipient), encryptedHex: toHex(JSON.stringify(payload)) });
}

let counters = 0;
function seal(group, sender, plaintext, epoch = 0) {
  counters += 1;
  return G.sealGroupMessage({
    plaintext, groupId: group.id, epoch, groupRootEpoch: group.root(epoch), blindingKey: group.blinding,
    senderAddress: sender.address, senderPrivateKey: sender.key, senderXOnlyPub: pub(sender),
    deviceId: new Uint8Array(16).fill(7), counter: counters,
  });
}

// The indexer: rows per blinded lane, oldest first, each with its own cursor. Every read that goes
// through here is recorded, so a test can see which lanes were asked for.
function makeIndexer() {
  const lanes = new Map();
  const reads = [];
  let seq = 0;
  return {
    lanes, reads,
    add(group, sender, payloadString, txId, blockTime) {
      const lane = G.bytesToHex(G.deriveBlindedGroupId(group.blinding, pub(sender)));
      if (!lanes.has(lane)) lanes.set(lane, []);
      seq += 1;
      lanes.get(lane).push({ txId, sender: sender.address, blockTime, cursor: String(seq), payloadString });
    },
    laneOf: (group, sender) => G.bytesToHex(G.deriveBlindedGroupId(group.blinding, pub(sender))),
    scan: async (lane, cursor) => {
      reads.push(lane);
      return (lanes.get(lane) || []).filter((row) => !cursor || Number(row.cursor) > Number(cursor));
    },
  };
}

function makeEngine(me, indexer) {
  return {
    address: me.address,
    privateKeyHex: me.key,
    xOnlyPubKeyForAddress: async (address) => PUB.get(address) || null,
    encryptGroupControl: async (_to, json) => toHex(json),
    decryptGroupControl: async (hex) => fromHex(hex),
    sendGroupPayload: async () => ({ txids: ["sent"] }),
    groupIndexerUrl: () => "https://indexer.test",
    scanGroupControlByRecipientPage: async () => ({ rows: [], nextCursor: null, rawCount: 0 }),
    scanGroupMessages: indexer.scan,
  };
}

function makeManager(me, indexer) {
  const mgr = new GroupManager(makeEngine(me, indexer));
  mgr.sinceSupported = false; // every pass reads the per-member lanes
  return mgr;
}

async function joined(me, group, indexer, members) {
  const mgr = makeManager(me, indexer);
  await mgr.applyControl(controlFor(me, group, 0, members, NOW - 10 * DAY), group.admin.address, NOW - 10 * DAY);
  const [invite] = mgr.pendingGroupInvites();
  assert.ok(invite, "the root waits as an invite");
  await mgr.acceptGroupInvite(invite.id);
  assert.ok(mgr.getGroup(group.idHex), "accepting joins the group");
  return mgr;
}

const texts = (messages) => messages.map((m) => m.plaintext);
const txIds = (messages) => messages.map((m) => m.txId);

let passed = 0;
async function test(name, fn) {
  localStorage.clear();
  try { await fn(); passed += 1; console.log(`ok ${name}`); }
  catch (error) { console.log(`FAIL ${name}`); console.log(error); process.exitCode = 1; }
}

const reaction = JSON.stringify({ type: "reaction", targetTxId: "t", emoji: "+1", action: "add" });
const edit = JSON.stringify({ type: "edit", targetTxId: "t", text: "changed" });

await test("a payload copied into a new transaction is refused, for messages, reactions, edits and statuses", async () => {
  const group = makeGroup();
  const indexer = makeIndexer();
  const mgr = await joined(ME, group, indexer, [ADMIN, ME, BOB]);
  const status = G.encodeMemberStatus(G.MEMBER_STATUS.JOINED);
  const payloads = { hello: seal(group, BOB, "hello"), reaction: seal(group, BOB, reaction), edit: seal(group, BOB, edit), status: seal(group, BOB, status) };
  let i = 0;
  for (const payload of Object.values(payloads)) indexer.add(group, BOB, payload, `real${i += 1}`, NOW - HOUR);
  const first = await mgr.syncGroups();
  assert.deepEqual(new Set(texts(first.messages)), new Set(["hello", reaction, edit]), "all three arrive, the status is taken out");
  assert.equal(first.controls.filter((ev) => ev.kind === "member-status").length, 1);

  i = 0;
  for (const payload of Object.values(payloads)) indexer.add(group, BOB, payload, `copy${i += 1}`, NOW);
  const second = await mgr.syncGroups();
  assert.deepEqual(second.messages, [], "a fresh time and txid buys nothing");
  assert.equal(second.controls.length, 0, "and a copied status doesn't apply again");
});

await test("the same transaction re-read after a cursor rewind still decodes, and a copy in the same pass doesn't", async () => {
  const group = makeGroup();
  const indexer = makeIndexer();
  const mgr = await joined(ME, group, indexer, [ADMIN, ME, BOB]);
  const payload = seal(group, BOB, "once");
  indexer.add(group, BOB, payload, "tx-real", NOW - HOUR);
  assert.deepEqual(txIds((await mgr.syncGroups()).messages), ["tx-real"]);
  assert.deepEqual((await mgr.syncGroups()).messages, [], "the cursor has moved past it");

  await mgr.rewindGroupCursors(NOW - 2 * HOUR);
  indexer.add(group, BOB, payload, "tx-copy", NOW - HOUR + 1000);
  const again = await mgr.syncGroups();
  assert.deepEqual(txIds(again.messages), ["tx-real"], "the rewound row is served again as itself; the copy behind it is not");

  // Refresh Messages walks from the very start and hits the same claim.
  const refreshed = await mgr.forceRefresh(group.idHex);
  assert.deepEqual(txIds(refreshed.messages), ["tx-real"]);
  assert.equal(refreshed.rejections.replayed, 1, "and it's counted as a replay, not a decrypt failure");
});

await test("the claim survives a reload and is per account", async () => {
  const group = makeGroup();
  const indexer = makeIndexer();
  const mine = await joined(ME, group, indexer, [ADMIN, ME, OTHER, BOB]);
  const payload = seal(group, BOB, "persisted");
  indexer.add(group, BOB, payload, "first", NOW - HOUR);
  assert.deepEqual(txIds((await mine.syncGroups()).messages), ["first"]);

  // Another account on this browser saw only the copy: it's that account's first sight of the id.
  const copyIndexer = makeIndexer();
  const theirs = await joined(OTHER, group, copyIndexer, [ADMIN, ME, OTHER, BOB]);
  copyIndexer.add(group, BOB, payload, "copy", NOW);
  assert.deepEqual(txIds((await theirs.syncGroups()).messages), ["copy"], "another account's claim isn't this one's");

  const reloaded = makeManager(ME, indexer);
  indexer.add(group, BOB, payload, "copy", NOW);
  assert.deepEqual((await reloaded.syncGroups()).messages, [], "after a reload the copy behind the cursor is still refused");
  assert.deepEqual(txIds((await reloaded.forceRefresh(group.idHex)).messages), ["first"], "and the original is still fine when it's walked again");
  const stored = JSON.parse(localStorage.getItem(GROUP_SEEN_MSG_KEY));
  assert.ok(stored[ME.address][group.idHex] && stored[OTHER.address][group.idHex], "each account has its own bucket");
});

await test("a replay that reaches the block stream counts as dealt with", async () => {
  const group = makeGroup();
  const indexer = makeIndexer();
  const mgr = await joined(ME, group, indexer, [ADMIN, ME, BOB]);
  const payload = seal(group, BOB, "stream");
  const state = mgr._outageFor(ME.address);
  await mgr._ingestChainMessage(state, { txId: "stream-real", blockTime: NOW - 1000, payloadString: payload });
  assert.deepEqual(txIds(state.messages), ["stream-real"]);
  state.messages.length = 0;
  await mgr._ingestChainMessage(state, { txId: "stream-copy", blockTime: NOW, payloadString: payload });
  assert.deepEqual(state.messages, [], "refused");
  assert.ok(state.handled.has("stream-copy"), "and not asked about again");
});

await test("the seen set is bounded per group and per account, dropping the oldest", async () => {
  const mgr = makeManager(ME, makeIndexer());
  const fake = (group, n) => ({ senderId: new Uint8Array(32).fill(group + 1), epoch: 0, msgId: new Uint8Array(24).map((_, i) => (i < 4 ? (n >> (i * 8)) & 0xff : 0)) });
  mgr._withSeenIds(() => {
    for (let n = 0; n < 6000; n += 1) assert.equal(mgr._claimMessageId("group-a", fake(0, n), `tx${n}`), true);
  });
  const count = () => Object.keys(JSON.parse(localStorage.getItem(GROUP_SEEN_MSG_KEY))[ME.address]["group-a"]).length;
  assert.equal(count(), 5000, "a group holds at most 5000");
  assert.equal(mgr._claimMessageId("group-a", fake(0, 5999), "txOTHER"), false, "the newest ids are still claimed");
  assert.equal(mgr._claimMessageId("group-a", fake(0, 0), "txOTHER"), true, "the oldest aged out");

  mgr._withSeenIds(() => {
    for (let group = 1; group <= 5; group += 1) for (let n = 0; n < 5000; n += 1) mgr._claimMessageId(`group-${group}`, fake(group, n), `t${group}-${n}`);
  });
  const stored = JSON.parse(localStorage.getItem(GROUP_SEEN_MSG_KEY))[ME.address];
  const total = Object.values(stored).reduce((sum, seen) => sum + Object.keys(seen).length, 0);
  assert.ok(total <= 20000, `an account holds at most 20000 (has ${total})`);
  assert.equal(mgr._claimMessageId("group-5", fake(5, 4999), "txOTHER"), false, "a recent id in a full account is still held");
});

await test("deleting a group forgets its ids", async () => {
  const group = makeGroup();
  const indexer = makeIndexer();
  const mgr = await joined(ME, group, indexer, [ADMIN, ME, BOB]);
  indexer.add(group, BOB, seal(group, BOB, "x"), "tx", NOW - HOUR);
  await mgr.syncGroups();
  assert.ok(JSON.parse(localStorage.getItem(GROUP_SEEN_MSG_KEY))[ME.address][group.idHex]);
  mgr.deleteGroup(group.idHex);
  assert.equal(JSON.parse(localStorage.getItem(GROUP_SEEN_MSG_KEY))[ME.address][group.idHex], undefined);
});

// A member removed at epoch 1, by a root in a block at `removedAt`.
async function removal() {
  const group = makeGroup();
  const indexer = makeIndexer();
  const mgr = await joined(ME, group, indexer, [ADMIN, ME, BOB]);
  const removedAt = NOW - 2 * HOUR;
  const event = await mgr.applyControl(controlFor(ME, group, 1, [ADMIN, ME], NOW - HOUR), ADMIN.address, removedAt);
  assert.deepEqual(event.removed, [BOB.address]);
  return { group, indexer, mgr, removedAt };
}

await test("a former member's old message is accepted, and their lane is read to find it", async () => {
  const { group, indexer, mgr, removedAt } = await removal();
  indexer.add(group, BOB, seal(group, BOB, "before I left", 0), "old", removedAt - HOUR);
  const result = await mgr.syncGroups();
  assert.deepEqual(texts(result.messages), ["before I left"]);
  assert.equal(result.messages[0].senderAddress, BOB.address);
  assert.equal(result.messages[0].senderIsAdmin, false);
  assert.ok(indexer.reads.includes(indexer.laneOf(group, BOB)), "the removed member's lane is scanned");
});

await test("a block time in seconds compares against the removal correctly", async () => {
  const { group, indexer, mgr, removedAt } = await removal();
  indexer.add(group, BOB, seal(group, BOB, "seconds", 0), "secs", Math.floor((removedAt - HOUR) / 1000));
  assert.deepEqual(texts((await mgr.syncGroups()).messages), ["seconds"]);
});

await test("a former member's message from after the removal is refused", async () => {
  const { group, indexer, mgr, removedAt } = await removal();
  // They still hold the old epoch's key and can still sign with it.
  indexer.add(group, BOB, seal(group, BOB, "after I left", 0), "late", removedAt + 1000);
  indexer.add(group, BOB, seal(group, BOB, "at the removal", 0), "same", removedAt);
  assert.deepEqual((await mgr.syncGroups()).messages, []);
  const refreshed = await mgr.forceRefresh(group.idHex);
  assert.equal(refreshed.rejections.senderNotInRoster, 2);
  assert.deepEqual(refreshed.messages, []);
});

await test("a former member can't speak in an epoch after their last", async () => {
  const { group, indexer, mgr, removedAt } = await removal();
  indexer.add(group, BOB, seal(group, BOB, "new epoch", 1), "e1", removedAt - HOUR);
  assert.deepEqual((await mgr.syncGroups()).messages, []);
});

await test("someone who was never in the group is still refused", async () => {
  const { group, mgr, removedAt } = await removal();
  const rejections = { senderNotInRoster: 0 };
  const parsed = G.parseGroupMessagePayload(seal(group, STRANGER, "hi", 0));
  assert.equal(mgr.processMessage(parsed, rejections, { txId: "s", blockTime: removedAt - HOUR }), null);
  assert.equal(rejections.senderNotInRoster, 1);
});

await test("the admin's own removal records the former member, and it survives later roots", async () => {
  const group = makeGroup(ME);
  const indexer = makeIndexer();
  const mgr = makeManager(ME, indexer);
  await mgr._put({
    groupId: group.idHex, name: "Audit", isAdmin: true, adminAddress: ME.address, adminSigningPub: pub(ME),
    groupSeedHex: G.bytesToHex(group.seed), groupRootEpochHex: G.bytesToHex(group.root(0)), blindingKeyHex: G.bytesToHex(group.blinding),
    currentEpoch: 0, deviceIdHex: G.bytesToHex(new Uint8Array(16).fill(1)), msgCounter: 0,
    members: [{ address: ME.address, xOnlyPubKeyHex: pub(ME), isAdmin: true }, { address: BOB.address, xOnlyPubKeyHex: pub(BOB), isAdmin: false }, { address: OTHER.address, xOnlyPubKeyHex: pub(OTHER), isAdmin: false }],
    cursors: {}, updatedAt: 0,
  });
  await mgr.removeMember(group.idHex, BOB.address);
  const record = mgr.getGroup(group.idHex);
  assert.equal(record.formerMembers.length, 1);
  assert.equal(record.formerMembers[0].lastEpoch, 0, "the last epoch they held the key for");
  indexer.add(group, BOB, seal(group, BOB, "old", 0), "o", Date.now() - HOUR);
  assert.deepEqual(texts((await mgr.syncGroups()).messages), ["old"]);
  await mgr.applyControl(controlFor(ME, group, 2, [ME, OTHER], NOW + 5000), ME.address, Date.now());
  assert.equal(mgr.getGroup(group.idHex).formerMembers.length, 1, "a later root keeps the list");
});

await test("invites are capped: 5 per admin, 50 in all, and answering one makes room", async () => {
  const indexer = makeIndexer();
  const mgr = makeManager(ME, indexer);
  const send = async (admin, n) => {
    const group = makeGroup(admin);
    PUB.set(admin.address, G.bytesToHex(G.xOnlyPublicKey(admin.key)));
    return mgr.applyControl(controlFor(ME, group, 0, [admin, ME], n), admin.address, NOW);
  };
  for (let n = 0; n < MAX_PENDING_GROUP_INVITES_PER_ADMIN; n += 1) assert.equal((await send(ADMIN, n + 1))?.kind, "invite");
  assert.equal(await send(ADMIN, 100), null, "a sixth from one admin is dropped");
  assert.equal(mgr.pendingGroupInvites().length, MAX_PENDING_GROUP_INVITES_PER_ADMIN);

  const before = mgr.pendingGroupInvites().length;
  for (let n = before; n < MAX_PENDING_GROUP_INVITES; n += 1) {
    assert.equal((await send(wallet(`adm${n}`, 0x1000 + n), 1))?.kind, "invite", `invite ${n}`);
  }
  assert.equal(await send(wallet("late", 0x2000), 1), null, "the 51st from a new admin is dropped");
  assert.equal(mgr.pendingGroupInvites().length, MAX_PENDING_GROUP_INVITES);

  mgr.rejectGroupInvite(mgr.pendingGroupInvites()[0].id);
  assert.equal((await send(wallet("later", 0x2001), 1))?.kind, "invite", "an answered invite stops counting");
  assert.equal(mgr.pendingGroupInvites().length, MAX_PENDING_GROUP_INVITES);
});

await test("an update to an invite already held isn't held against the cap", async () => {
  const mgr = makeManager(ME, makeIndexer());
  const group = makeGroup();
  await mgr.applyControl(controlFor(ME, group, 0, [ADMIN, ME], 1), ADMIN.address, NOW);
  for (let n = 0; n < MAX_PENDING_GROUP_INVITES_PER_ADMIN - 1; n += 1) await mgr.applyControl(controlFor(ME, makeGroup(), 0, [ADMIN, ME], 1), ADMIN.address, NOW);
  await mgr.applyControl(controlFor(ME, group, 1, [ADMIN, ME], 2), ADMIN.address, NOW + 1000);
  assert.equal(mgr._loadInvites().find((i) => i.groupId === group.idHex).roots.length, 2);
});

function retentionFixture() {
  const cutoff = NOW - 30 * DAY;
  const old = cutoff - DAY;
  const fresh = cutoff + DAY;
  const store = { [ME.address]: {
    g1: [
      { id: "a", txId: "tx-old", msgIdHex: "m-old", createdAt: old, text: "old" },
      { id: "b", txId: "tx-new", msgIdHex: "m-new", createdAt: fresh, text: "new" },
      { id: "c", txId: null, msgIdHex: null, createdAt: old, text: "sending", status: "pending" },
    ],
    g2: [{ id: "d", txId: "tx-only", msgIdHex: "m-only", createdAt: fresh, text: "kept" }],
  }, "kaspa:someoneelse": { g1: [{ id: "z", txId: "tx-z", createdAt: old, text: "theirs" }] } };
  localStorage.setItem("kachat-group-reactions-v1", JSON.stringify({ [ME.address]: { g1: { "tx-old": [{ reactorAddress: BOB.address, emoji: "x" }], "tx-new": [{ reactorAddress: BOB.address, emoji: "y" }] } } }));
  localStorage.setItem("kachat-group-edits-v1", JSON.stringify({ [ME.address]: { g1: { "m-old": { text: "e", at: fresh, editor: BOB.address }, "tx-new": { text: "f", at: fresh, editor: BOB.address } } } }));
  let saved = 0;
  return { cutoff, old, fresh, store, saved: () => saved, io: { loadMessages: () => store, saveMessages: () => { saved += 1; } } };
}

await test("retention deletes this account's old group messages with their reactions and edits", async () => {
  const fixture = retentionFixture();
  const mgr = makeManager(ME, makeIndexer());
  assert.equal(mgr.applyGroupRetention(fixture.cutoff, fixture.io), 1);
  const list = fixture.store[ME.address].g1;
  assert.deepEqual(list.map((row) => row.id), ["b", "c"], "the old row goes, the recent and the in-flight one stay");
  assert.equal(fixture.store[ME.address].g2.length, 1);
  assert.equal(fixture.store["kaspa:someoneelse"].g1.length, 1, "other accounts aren't touched");
  assert.equal(fixture.saved(), 1, "written through the app's own store");
  const reactions = JSON.parse(localStorage.getItem("kachat-group-reactions-v1"))[ME.address].g1;
  assert.deepEqual(Object.keys(reactions), ["tx-new"]);
  const edits = JSON.parse(localStorage.getItem("kachat-group-edits-v1"))[ME.address].g1;
  assert.deepEqual(Object.keys(edits), ["tx-new"], "keyed by either id of the row");
  assert.equal(mgr.applyGroupRetention(fixture.cutoff, fixture.io), 0, "nothing left to do");
});

await test("Keep forever deletes nothing and lifts the floor", async () => {
  const fixture = retentionFixture();
  const mgr = makeManager(ME, makeIndexer());
  mgr.applyGroupRetention(fixture.cutoff, fixture.io);
  assert.equal(mgr.applyGroupRetention(null, fixture.io), 0);
  assert.equal(mgr._retentionFloor.cutoffMs, null);
});

await test("past the cutoff a re-walk doesn't bring a message back, the claim stays, and a status still counts", async () => {
  const group = makeGroup();
  const indexer = makeIndexer();
  const mgr = await joined(ME, group, indexer, [ADMIN, ME, BOB]);
  const cutoff = NOW - 30 * DAY;
  const oldPayload = seal(group, BOB, "ancient");
  indexer.add(group, BOB, oldPayload, "old-real", cutoff - DAY);
  indexer.add(group, BOB, seal(group, BOB, "fresh"), "new-real", cutoff + DAY);
  indexer.add(group, BOB, seal(group, BOB, G.encodeMemberStatus(G.MEMBER_STATUS.JOINED)), "status-old", cutoff - DAY);
  mgr.applyGroupRetention(cutoff, { loadMessages: () => ({}), saveMessages: () => {} });
  const result = await mgr.syncGroups();
  assert.deepEqual(texts(result.messages), ["fresh"]);
  assert.equal(result.controls.filter((ev) => ev.kind === "member-status").length, 1, "who's in the group isn't a message");

  // The floor lifted, so only the claim stands between the copy and the store.
  mgr.applyGroupRetention(null, { loadMessages: () => ({}), saveMessages: () => {} });
  indexer.add(group, BOB, oldPayload, "old-copy", NOW);
  assert.deepEqual((await mgr.syncGroups()).messages, [], "the pruned message's id is still claimed");
});

await test("a floor set for one account doesn't apply to another", async () => {
  const group = makeGroup();
  const indexer = makeIndexer();
  const mgr = await joined(ME, group, indexer, [ADMIN, ME, BOB]);
  mgr._retentionFloor = { wallet: "kaspa:someoneelse", cutoffMs: NOW };
  indexer.add(group, BOB, seal(group, BOB, "mine"), "t", NOW - DAY);
  assert.deepEqual(texts((await mgr.syncGroups()).messages), ["mine"]);
});

console.log(`\n${passed} passed`);
