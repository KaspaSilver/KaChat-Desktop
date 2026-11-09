// node tools/test-group-control-cursor.mjs - the persisted by-recipient group control cursor
// (DSK-041; iOS GroupChatService.catchUpGroupControlByRecipient). A stub indexer serves
// /group-control/by-recipient through a stubbed fetch, so the real page read in
// engine/group-indexer.js and the real applyControl/_applyRoot in engine/group-store.js run.
// localStorage is an in-memory map; a "reload" is a new GroupManager on the same storage.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

class MemoryStorage {
  constructor() { this.map = new Map(); }
  getItem(key) { return this.map.has(key) ? this.map.get(key) : null; }
  setItem(key, value) { this.map.set(key, String(value)); }
  removeItem(key) { this.map.delete(key); }
  get length() { return this.map.size; }
  key(index) { return [...this.map.keys()][index] ?? null; }
}
globalThis.localStorage = new MemoryStorage();

const G = await import("../engine/group.js");
const { queryGroupControlByRecipientPage } = await import("../engine/group-indexer.js");
const { GroupManager, GROUP_CONTROL_CURSOR_KEY, CONTROL_PAGE_BUDGET, CONTROL_PAGE_LIMIT, GROUP_INVITES_KEY, GROUP_INVITE_ANSWERS_KEY, GROUP_MEMBER_STATUS_KEY } = await import("../engine/group-store.js");

const here = dirname(fileURLToPath(import.meta.url));
const UTF8 = new TextEncoder();
const FROM_UTF8 = new TextDecoder();
const toHex = (s) => G.bytesToHex(UTF8.encode(s));

const INDEXER = "https://indexer.stub.test";
const INDEXER_2 = "https://other-indexer.stub.test";
const KEY = (n) => n.toString(16).padStart(64, "0");
const WALLETS = {
  A: { address: "kaspa:qzwalletaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", key: KEY(0xa1) },
  A_TN: { address: "kaspatest:qzwalletaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", key: KEY(0xa1) },
  B: { address: "kaspa:qzwalletbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", key: KEY(0xb2) },
  C: { address: "kaspa:qzwalletcccccccccccccccccccccccccccccccccccccccccccccccccccc", key: KEY(0xc3) },
};
const ADMIN = { address: "kaspa:qpadmin0000000000000000000000000000000000000000000000000", key: KEY(0xad) };
const PUB = new Map([...Object.values(WALLETS), ADMIN].map((w) => [w.address, G.bytesToHex(G.xOnlyPublicKey(w.key))]));

// --- stub indexer: one ordered control stream per recipient; cursor = 1-based row number ---
const streams = new Map(); // recipient -> raw indexer rows
const requests = [];       // { recipient, cursor, limit, indexer }
let failNext = 0;          // fail this many upcoming by-recipient requests (HTTP 503)
function streamFor(recipient) {
  if (!streams.has(recipient)) streams.set(recipient, []);
  return streams.get(recipient);
}
function pushRow(recipient, payloadString, { rawPayloadHex = null } = {}) {
  const rows = streamFor(recipient);
  const n = rows.length + 1;
  rows.push({
    tx_id: `tx-${recipient.slice(-4)}-${n}`,
    sender: ADMIN.address,
    block_time: 1_700_000_000_000 + n,
    cursor: String(n),
    message_payload: rawPayloadHex ?? toHex(payloadString),
  });
  return n;
}
// Spam anyone can address to a key: a gctl row whose ciphertext is not ours.
function pushJunk(recipient, count) {
  for (let i = 0; i < count; i += 1) pushRow(recipient, `kchat:1:gctl:${G.bytesToHex(crypto.getRandomValues(new Uint8Array(24)))}`);
}
// The stub "ECIES": JSON naming its recipient, so only that wallet can open it.
const sealFor = (address, json) => toHex(JSON.stringify({ to: address, body: json }));
// `accepted`: this walk is about the stream, so the group joins at once as an already answered one.
function pushInvite(recipient, { name = "Group", epoch = 0, seed = G.generateGroupSeed(), accepted = true, admin = ADMIN } = {}) {
  const groupId = G.deriveGroupId(seed);
  const key = G.groupInviteKey(G.bytesToHex(groupId), PUB.get(admin.address));
  if (accepted) {
    const answers = JSON.parse(localStorage.getItem(GROUP_INVITE_ANSWERS_KEY) || "{}");
    const mine = answers[recipient] || { accepted: [], published: [], statusOutbox: [] };
    mine.accepted.push(key);
    mine.published.push(key);
    answers[recipient] = mine;
    localStorage.setItem(GROUP_INVITE_ANSWERS_KEY, JSON.stringify(answers));
  }
  const payload = G.buildSignedRootPayload({
    groupId, epoch,
    groupRootEpoch: G.deriveGroupRootEpoch(seed, groupId, epoch),
    blindingKey: G.deriveBlindingKey(seed, groupId),
    adminSigningPub: PUB.get(admin.address),
    members: [admin.address, recipient],
    name, adminPrivateKey: admin.key,
  });
  // The indexer strips the recipient prefix in REST rows: bare kchat:1:gctl:<encrypted>.
  const row = pushRow(recipient, `kchat:1:gctl:${sealFor(recipient, JSON.stringify(payload))}`);
  return { row, groupId: G.bytesToHex(groupId), seed, key };
}

globalThis.fetch = async (url) => {
  const u = new URL(url);
  if (u.pathname !== "/group-control/by-recipient") throw new Error(`unexpected request ${url}`);
  const recipient = u.searchParams.get("recipient");
  const cursor = u.searchParams.get("cursor");
  const limit = Number(u.searchParams.get("limit"));
  requests.push({ recipient, cursor, limit, indexer: u.origin });
  if (failNext > 0) { failNext -= 1; return { ok: false, status: 503, json: async () => ({ error: "busy" }) }; }
  const after = cursor ? Number(cursor) : 0;
  const rows = streamFor(recipient).filter((r) => Number(r.cursor) > after).slice(0, limit);
  return { ok: true, status: 200, json: async () => rows };
};

// --- stub engine (the parts GroupManager reaches) ---
const engine = {
  address: "",
  privateKeyHex: "",
  indexer: INDEXER,
  log() {},
  groupIndexerUrl() { return this.indexer; },
  scanGroupControlByRecipientPage(cursor = null, limit = 50) {
    return queryGroupControlByRecipientPage({ indexerUrl: this.indexer, recipient: this.address, cursor, limit });
  },
  async scanGroupControlByRecipient() { throw new Error("the uncursored 20-page scan must not be used by syncGroups"); },
  async decryptGroupControl(encryptedHex) {
    const sealed = JSON.parse(FROM_UTF8.decode(G.hexToBytes(encryptedHex))); // junk throws here
    if (sealed.to !== this.address) throw new Error("not ours");
    return sealed.body;
  },
  async xOnlyPubKeyForAddress(address) {
    if (!PUB.has(address)) throw new Error(`no pubkey for ${address}`);
    return PUB.get(address);
  },
  async scanGroupMessages() { return []; },
  async scanGroupMessagesSince() { return { messages: [], latestBlockTime: 0, count: 0 }; },
  async encryptGroupControl() { throw new Error("tests send nothing"); },
  async sendGroupPayload() { throw new Error("tests send nothing"); },
};
function useWallet(w) {
  engine.address = w.address;
  engine.privateKeyHex = w.key;
  return new GroupManager(engine); // the app makes a new manager per wallet (getGroupManager)
}
async function pass(manager) {
  const before = requests.length;
  const { controls } = await manager.syncGroups();
  const mine = requests.slice(before).filter((r) => r.recipient === engine.address);
  return { controls, requests: mine };
}
const storedCursors = () => JSON.parse(localStorage.getItem(GROUP_CONTROL_CURSOR_KEY) || "{}");

let ok = 0;
async function test(name, fn) {
  await fn();
  ok += 1;
  console.log(`ok ${ok} - ${name}`);
}

assert.equal(CONTROL_PAGE_LIMIT, 50);
assert.equal(CONTROL_PAGE_BUDGET, 40);

// --- 1500 rows, the newest an invite ---
pushJunk(WALLETS.A.address, 1499);
const inviteA = pushInvite(WALLETS.A.address, { name: "Row 1500" });
assert.equal(inviteA.row, 1500);

let a = useWallet(WALLETS.A);

await test("1500 rows: the invite at row 1500 is seen on the first pass (old scan stopped at 1000)", async () => {
  const r = await pass(a);
  assert.equal(r.requests[0].cursor, null, "a fresh wallet walks from the start");
  assert.ok(r.requests.length <= CONTROL_PAGE_BUDGET);
  assert.equal(r.requests.length, 31, "30 full pages + the empty one that ends the walk");
  const joined = r.controls.filter((e) => e.kind === "joined");
  assert.deepEqual(joined.map((e) => e.groupId), [inviteA.groupId]);
  assert.ok(a.getGroup(inviteA.groupId), "the group is stored");
  assert.equal(storedCursors()[WALLETS.A.address].cursor, "1500");
  assert.equal(storedCursors()[WALLETS.A.address].indexer, INDEXER);
  assert.equal(storedCursors()[WALLETS.A.address].caughtUp, true);
});

await test("steady state: one request, from the stored cursor, when nothing is new", async () => {
  for (let i = 0; i < 3; i += 1) {
    const r = await pass(a);
    assert.equal(r.requests.length, 1);
    assert.equal(r.requests[0].cursor, "1500");
    assert.equal(r.controls.length, 0);
  }
});

await test("a new invite after the cursor is picked up in one request", async () => {
  const next = pushInvite(WALLETS.A.address, { name: "Row 1501" });
  const r = await pass(a);
  assert.equal(r.requests.length, 1);
  assert.deepEqual(r.controls.filter((e) => e.kind === "joined").map((e) => e.groupId), [next.groupId]);
  assert.equal(storedCursors()[WALLETS.A.address].cursor, "1501");
});

await test("the cursor persists across a reload (new store instance, same storage)", async () => {
  a = useWallet(WALLETS.A);
  const r = await pass(a);
  assert.equal(r.requests.length, 1);
  assert.equal(r.requests[0].cursor, "1501");
  assert.equal(r.controls.length, 0);
});

await test("a junk last row with an unreadable payload still advances the cursor", async () => {
  pushRow(WALLETS.A.address, "", { rawPayloadHex: "zz-not-hex" });
  const r = await pass(a);
  assert.equal(r.requests.length, 1);
  assert.equal(storedCursors()[WALLETS.A.address].cursor, "1502");
  assert.equal((await pass(a)).requests[0].cursor, "1502");
});

await test("a failed request holds the cursor at the last applied page and resumes from it", async () => {
  pushJunk(WALLETS.A.address, 120); // rows 1503..1622: three pages
  failNext = 0;
  // Fail the second page of the walk.
  const origFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url) => { calls += 1; if (calls === 2) failNext = 1; return origFetch(url); };
  const r1 = await pass(a);
  globalThis.fetch = origFetch;
  assert.equal(r1.requests.length, 2);
  assert.equal(storedCursors()[WALLETS.A.address].cursor, "1552", "the applied first page only");
  const r2 = await pass(a);
  assert.equal(r2.requests[0].cursor, "1552", "resumes, does not restart");
  assert.equal(storedCursors()[WALLETS.A.address].cursor, "1622");
});

// --- the page budget ---
await test("budget: a 2600-row stream stops after 40 pages and the next pass resumes from the cursor", async () => {
  pushJunk(WALLETS.C.address, 2599);
  const inviteC = pushInvite(WALLETS.C.address, { name: "Row 2600" });
  let c = useWallet(WALLETS.C);
  const r1 = await pass(c);
  assert.equal(r1.requests.length, CONTROL_PAGE_BUDGET);
  assert.equal(r1.requests[0].cursor, null);
  assert.equal(r1.controls.length, 0, "the invite is past the budget");
  assert.deepEqual(storedCursors()[WALLETS.C.address].cursor, "2000");
  assert.equal(storedCursors()[WALLETS.C.address].caughtUp, false);
  c = useWallet(WALLETS.C); // and survives a reload in between
  const r2 = await pass(c);
  assert.equal(r2.requests[0].cursor, "2000", "never restarts from zero");
  assert.equal(r2.requests.length, 13, "12 full pages + the empty one");
  assert.deepEqual(r2.controls.filter((e) => e.kind === "joined").map((e) => e.groupId), [inviteC.groupId]);
  assert.equal(storedCursors()[WALLETS.C.address].caughtUp, true);
  const r3 = await pass(c);
  assert.equal(r3.requests.length, 1);
  assert.equal(r3.requests[0].cursor, "2600");
});

// --- per wallet / per network / per indexer ---
await test("per-wallet isolation: another wallet walks its own stream from the start", async () => {
  pushJunk(WALLETS.B.address, 3);
  const inviteB = pushInvite(WALLETS.B.address, { name: "B's group" });
  const aCursor = storedCursors()[WALLETS.A.address].cursor;
  const b = useWallet(WALLETS.B);
  const r = await pass(b);
  assert.equal(r.requests.length, 1);
  assert.equal(r.requests[0].cursor, null);
  assert.deepEqual(r.controls.filter((e) => e.kind === "joined").map((e) => e.groupId), [inviteB.groupId]);
  assert.deepEqual(b.listGroups().map((g) => g.groupId), [inviteB.groupId], "B never sees A's groups");
  assert.equal(storedCursors()[WALLETS.B.address].cursor, String(inviteB.row));
  assert.equal(storedCursors()[WALLETS.A.address].cursor, aCursor, "A's cursor untouched");
  // Back to A: straight from A's own cursor.
  a = useWallet(WALLETS.A);
  const ra = await pass(a);
  assert.equal(ra.requests.length, 1);
  assert.equal(ra.requests[0].cursor, aCursor);
  assert.ok(!a.getGroup(inviteB.groupId));
});

await test("network split: the same key's testnet address has its own cursor", async () => {
  const aCursor = storedCursors()[WALLETS.A.address].cursor;
  const tn = useWallet(WALLETS.A_TN);
  const r = await pass(tn);
  assert.equal(r.requests.length, 1);
  assert.equal(r.requests[0].cursor, null);
  assert.equal(r.requests[0].recipient, WALLETS.A_TN.address);
  assert.equal(storedCursors()[WALLETS.A.address].cursor, aCursor);
  assert.ok(!(WALLETS.A_TN.address in storedCursors()), "an empty stream stores nothing");
});

await test("another indexer: the stored cursor is not reused, the walk starts over there", async () => {
  a = useWallet(WALLETS.A);
  engine.indexer = INDEXER_2;
  try {
    const r = await pass(a);
    assert.equal(r.requests[0].cursor, null);
    assert.equal(r.requests[0].indexer, INDEXER_2);
    assert.equal(storedCursors()[WALLETS.A.address].indexer, INDEXER_2);
  } finally {
    engine.indexer = INDEXER;
  }
  // Back on the first indexer the cursor is INDEXER_2's, so it walks from the start again.
  const r2 = await pass(a);
  assert.equal(r2.requests[0].cursor, null);
  assert.equal(storedCursors()[WALLETS.A.address].indexer, INDEXER);
});

await test("reset (Refresh Messages / wiped data) re-walks from the start, and re-applying is harmless", async () => {
  a = useWallet(WALLETS.A);
  const groupsBefore = JSON.stringify(a.listGroups().map((g) => ({ ...g, learnedAtMs: 0 })));
  a.resetGroupControlCursor();
  assert.equal(a.groupControlCursor(), null);
  const r = await pass(a);
  assert.equal(r.requests[0].cursor, null);
  assert.equal(r.controls.length, 0, "known roots re-applied: no join / update events");
  assert.equal(JSON.stringify(a.listGroups().map((g) => ({ ...g, learnedAtMs: 0 }))), groupsBefore);
  assert.equal(storedCursors()[WALLETS.A.address].cursor, String(streamFor(WALLETS.A.address).length));
  // Wiping only A leaves B and C alone.
  assert.ok(storedCursors()[WALLETS.B.address] && storedCursors()[WALLETS.C.address]);
});

await test("account removal wipes the cursor key with the other per-wallet group stores", async () => {
  const app = readFileSync(join(here, "..", "ui", "app.js"), "utf8");
  const wipe = app.split("\n").find((line) => line.includes('"kachat-group-tombstones-v1"') && line.includes("for (const key of"));
  assert.ok(wipe, "the per-wallet wipe list in removeAccountScopedLocalData");
  assert.ok(wipe.includes(`"${GROUP_CONTROL_CURSOR_KEY}"`), "the control cursor key is in it");
});

// --- group invites (iOS bfe9f022, MESSAGING.md "Group invites") ---
const INVITEE = { address: "kaspa:qzinviteeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", key: KEY(0xe1) };
PUB.set(INVITEE.address, G.bytesToHex(G.xOnlyPublicKey(INVITEE.key)));
const sent = [];
const answering = (fn) => async () => {
  engine.encryptGroupControl = async (address, json) => sealFor(address, json);
  engine.sendGroupPayload = async (payload) => { sent.push(payload); return { txids: ["tx"] }; };
  await fn();
};

await test("a root for a group this wallet doesn't hold waits as an invite", async () => {
  const m = useWallet(INVITEE);
  const invite = pushInvite(INVITEE.address, { name: "Friends", accepted: false });
  const { controls } = await pass(m);
  assert.deepEqual(controls.filter((e) => e.kind === "invite").map((e) => e.groupId), [invite.groupId]);
  assert.equal(controls.filter((e) => e.kind === "joined").length, 0);
  assert.equal(m.getGroup(invite.groupId), null, "not in the group");
  const [held] = m.pendingGroupInvites();
  assert.equal(held.name, "Friends");
  assert.equal(held.adminAddress, ADMIN.address, "the admin comes from the signing key");
  await m.syncGroups();
  assert.equal(m.pendingGroupInvites().length, 1, "a re-walk doesn't add it twice");
});

await test("accept joins, then says so on chain: to this wallet, then to the group", answering(async () => {
  const m = useWallet(INVITEE);
  const [{ id, groupId }] = m.pendingGroupInvites();
  assert.equal(id, G.groupInviteKey(groupId, PUB.get(ADMIN.address)));
  sent.length = 0;
  const joined = await m.acceptGroupInvite(id);
  assert.equal(joined.kind, "joined");
  assert.ok(m.getGroup(groupId), "in the group");
  assert.equal(m.pendingGroupInvites().length, 0);
  await new Promise((resolve) => setTimeout(resolve, 20)); // accepting sends them on its own
  assert.equal(sent.length, 2, "a self-addressed accept and a member_status message");
  assert.ok(sent[0].startsWith("kchat:1:gctl:"));
  assert.ok(sent[1].startsWith("kchat:1:gcomm:"));
  sent.length = 0;
  await m._publishGroupAnswers();
  assert.equal(sent.length, 0, "each answer goes once");
}));

await test("reject: never offered again, and the group hears declined with the invite's keys", answering(async () => {
  const m = useWallet(INVITEE);
  const invite = pushInvite(INVITEE.address, { name: "Spam", accepted: false });
  await pass(m);
  assert.equal(m.pendingGroupInvites().length, 1);
  sent.length = 0;
  m.rejectGroupInvite(invite.key);
  assert.equal(m.pendingGroupInvites().length, 0);
  assert.ok(m.isGroupTombstoned(invite.groupId));
  await new Promise((resolve) => setTimeout(resolve, 20));
  await m._publishGroupAnswers();
  assert.ok(sent.some((p) => p.startsWith("kchat:1:gctl:")), "the delete marker");
  assert.ok(sent.some((p) => p.startsWith("kchat:1:gcomm:")), "the declined message");
  assert.equal(m._loadInvites().length, 0, "its keys are gone once that's out");
  m.resetGroupControlCursor();
  await pass(m);
  assert.equal(m.pendingGroupInvites().length, 0);
}));

await test("a root that leaves you out takes the invite back; one naming no one you know never shows", async () => {
  const m = useWallet(INVITEE);
  const seed = G.generateGroupSeed();
  const invite = pushInvite(INVITEE.address, { name: "Later", accepted: false, seed });
  await pass(m);
  assert.ok(m.pendingGroupInvites().some((entry) => entry.groupId === invite.groupId));
  const groupId = G.deriveGroupId(seed);
  const leftOut = G.buildSignedRootPayload({
    groupId, epoch: 1, groupRootEpoch: G.deriveGroupRootEpoch(seed, groupId, 1), blindingKey: G.deriveBlindingKey(seed, groupId),
    adminSigningPub: PUB.get(ADMIN.address), members: [ADMIN.address], name: "Later", adminPrivateKey: ADMIN.key,
  });
  pushRow(INVITEE.address, `kchat:1:gctl:${sealFor(INVITEE.address, JSON.stringify(leftOut))}`);
  await pass(m);
  assert.ok(!m.pendingGroupInvites().some((entry) => entry.groupId === invite.groupId));
});

await test("a blocked inviter is ignored", async () => {
  const m = useWallet(INVITEE);
  m.isInviterBlocked = (address) => address === ADMIN.address;
  pushInvite(INVITEE.address, { name: "Blocked", accepted: false });
  await pass(m);
  assert.ok(!m.pendingGroupInvites().some((entry) => entry.name === "Blocked"));
});

await test("a gctl_invite_accept joins the waiting group, from another device or a restore", async () => {
  const m = useWallet(INVITEE);
  const invite = pushInvite(INVITEE.address, { name: "Elsewhere", accepted: false });
  await pass(m);
  const accept = G.buildSignedInviteAcceptPayload({ groupId: G.hexToBytes(invite.groupId), adminSigningPub: PUB.get(ADMIN.address), signingPub: PUB.get(INVITEE.address), privateKey: INVITEE.key });
  pushRow(INVITEE.address, `kchat:1:gctl:${sealFor(INVITEE.address, JSON.stringify(accept))}`);
  const { controls } = await pass(m);
  assert.ok(controls.some((e) => e.kind === "joined" && e.groupId === invite.groupId));
  assert.ok(m.getGroup(invite.groupId));
  // Someone else's signature on it does nothing.
  const other = pushInvite(INVITEE.address, { name: "Forged", accepted: false });
  await pass(m);
  const forged = G.buildSignedInviteAcceptPayload({ groupId: G.hexToBytes(other.groupId), adminSigningPub: PUB.get(ADMIN.address), signingPub: PUB.get(ADMIN.address), privateKey: ADMIN.key });
  pushRow(INVITEE.address, `kchat:1:gctl:${sealFor(INVITEE.address, JSON.stringify(forged))}`);
  await pass(m);
  assert.equal(m.getGroup(other.groupId), null);
});

await test("a group this device holds keeps its admin, whatever a higher epoch signs", async () => {
  const m = useWallet(INVITEE);
  const seed = G.generateGroupSeed();
  const invite = pushInvite(INVITEE.address, { name: "Mine", seed, accepted: true });
  await pass(m);
  const groupId = G.deriveGroupId(seed);
  const takeover = G.buildSignedRootPayload({
    groupId, epoch: 9, groupRootEpoch: G.deriveGroupRootEpoch(seed, groupId, 9), blindingKey: G.deriveBlindingKey(seed, groupId),
    adminSigningPub: PUB.get(WALLETS.C.address), members: [WALLETS.C.address, INVITEE.address], name: "Taken", adminPrivateKey: WALLETS.C.key,
  });
  pushRow(INVITEE.address, `kchat:1:gctl:${sealFor(INVITEE.address, JSON.stringify(takeover))}`);
  await pass(m);
  const held = m.getGroup(invite.groupId);
  assert.equal(held.name, "Mine");
  assert.equal(held.adminSigningPub, PUB.get(ADMIN.address));
});

await test("member answers update the list and never reach the thread; any other message means joined", async () => {
  const m = useWallet(INVITEE);
  const groupId = m.listGroups()[0].groupId;
  m.markMemberInvited(groupId, ADMIN.address);
  assert.equal(m.inviteStatus(groupId, ADMIN.address), "invited");
  const events = [];
  const declined = m._takeMemberStatuses([{ groupId, senderAddress: ADMIN.address, plaintext: G.encodeMemberStatus("declined"), txId: "t1" }], events);
  assert.equal(declined.length, 0);
  assert.equal(events[0].kind, "member-status");
  assert.equal(m.inviteStatus(groupId, ADMIN.address), "declined");
  const kept = m._takeMemberStatuses([{ groupId, senderAddress: ADMIN.address, plaintext: "hello" }], events);
  assert.equal(kept.length, 1);
  assert.equal(m.inviteStatus(groupId, ADMIN.address), null, "they're in");
});

// --- an invite is one admin's offer of a group id (iOS 30309e93) ---
const RIVAL = WALLETS.C;
const rootFrom = (admin, seed, recipient, { epoch = 0, name = "Rival", spell = (hex) => hex } = {}) => {
  const groupId = G.deriveGroupId(seed);
  const payload = G.buildSignedRootPayload({
    groupId, epoch, groupRootEpoch: G.deriveGroupRootEpoch(seed, groupId, epoch), blindingKey: G.deriveBlindingKey(seed, groupId),
    adminSigningPub: PUB.get(admin.address), members: [admin.address, recipient], name, adminPrivateKey: admin.key,
  });
  return { ...payload, group_id: spell(payload.group_id), admin_signing_pub: spell(payload.admin_signing_pub) };
};
const pushControl = (recipient, payload) => pushRow(recipient, `kchat:1:gctl:${sealFor(recipient, JSON.stringify(payload))}`);
const offersOf = (m, groupId) => m.pendingGroupInvites().filter((entry) => entry.groupId === groupId);
// What went out on chain: the sealed JSON is the wire's last field.
const sentControls = () => sent.filter((p) => p.startsWith("kchat:1:gctl:")).map((p) => JSON.parse(JSON.parse(FROM_UTF8.decode(G.hexToBytes(p.split(":").pop()))).body));
const keyFor = (groupId, admin) => G.groupInviteKey(groupId, PUB.get(admin.address));

await test("two admins' roots for an id are two invites, and the first can't shut out the real one", async () => {
  const m = useWallet(INVITEE);
  const seed = G.generateGroupSeed();
  const fake = pushInvite(INVITEE.address, { name: "Fake", seed, accepted: false, admin: RIVAL });
  pushInvite(INVITEE.address, { name: "Real", seed, accepted: false });
  await pass(m);
  const offers = offersOf(m, fake.groupId);
  assert.deepEqual(offers.map((entry) => entry.name).sort(), ["Fake", "Real"]);
  assert.deepEqual(offers.map((entry) => entry.adminAddress).sort(), [ADMIN.address, RIVAL.address].sort());
});

await test("rejecting a fake offer leaves the real admin's; the id isn't refused for them", answering(async () => {
  const m = useWallet(INVITEE);
  const seed = G.generateGroupSeed();
  const fake = pushInvite(INVITEE.address, { name: "Fake", seed, accepted: false, admin: RIVAL });
  await pass(m);
  sent.length = 0;
  m.rejectGroupInvite(fake.key);
  assert.ok(m.isGroupTombstoned(fake.groupId, PUB.get(RIVAL.address)));
  assert.ok(!m.isGroupTombstoned(fake.groupId, PUB.get(ADMIN.address)));
  assert.ok(m.isGroupTombstoned(fake.groupId), "with no admin to go on, any marker counts");
  pushInvite(INVITEE.address, { name: "Real", seed, accepted: false });
  await pass(m);
  assert.deepEqual(offersOf(m, fake.groupId).map((entry) => entry.name), ["Real"]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await m._publishGroupAnswers();
  const markers = sentControls();
  const marker = markers.find((p) => p.type === "gctl_tombstone");
  assert.equal(marker.v, 2);
  assert.equal(marker.admin_signing_pub, PUB.get(RIVAL.address));
  assert.equal(G.verifyTombstonePayload(marker), true);
}));

await test("accepting one offer drops the others, unless one is only waiting to say you declined", answering(async () => {
  const m = useWallet(INVITEE);
  const seed = G.generateGroupSeed();
  const real = pushInvite(INVITEE.address, { name: "Real", seed, accepted: false });
  pushInvite(INVITEE.address, { name: "Fake", seed, accepted: false, admin: RIVAL });
  await pass(m);
  sent.length = 0;
  const joined = await m.acceptGroupInvite(real.key);
  assert.equal(joined.kind, "joined");
  assert.equal(m.getGroup(real.groupId).adminSigningPub, PUB.get(ADMIN.address));
  assert.equal(offersOf(m, real.groupId).length, 0);
  assert.ok(!m._loadInvites().some((entry) => entry.groupId === real.groupId));
  await new Promise((resolve) => setTimeout(resolve, 20));
  const accept = sentControls().find((p) => p.type === "gctl_invite_accept");
  assert.equal(accept.v, 2);
  assert.equal(accept.admin_signing_pub, PUB.get(ADMIN.address));

  // A rejected offer that hasn't said so yet survives the other's accept, and still says so.
  const seed2 = G.generateGroupSeed();
  const real2 = pushInvite(INVITEE.address, { name: "Real", seed: seed2, accepted: false });
  const fake2 = pushInvite(INVITEE.address, { name: "Fake", seed: seed2, accepted: false, admin: RIVAL });
  await pass(m);
  const send = engine.sendGroupPayload;
  engine.sendGroupPayload = async () => { throw new Error("no funds"); };
  m.rejectGroupInvite(fake2.key);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await m.acceptGroupInvite(real2.key);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(m._loadInvites().filter((entry) => entry.groupId === real2.groupId).map((entry) => entry.rejected), [true]);
  assert.equal(m.getGroup(real2.groupId).adminSigningPub, PUB.get(ADMIN.address));
  engine.sendGroupPayload = send;
  await m._publishGroupAnswers();
  assert.ok(!m._loadInvites().some((entry) => entry.groupId === real2.groupId), "its keys are gone once that's out");
  assert.ok(m.getGroup(real2.groupId), "and the group you joined stays");
}));

await test("an accepted id joins only from the admin you said yes to, after a restore too", async () => {
  const m = useWallet(INVITEE);
  const seed = G.generateGroupSeed();
  const groupId = G.bytesToHex(G.deriveGroupId(seed));
  pushControl(INVITEE.address, G.buildSignedInviteAcceptPayload({ groupId: G.hexToBytes(groupId), adminSigningPub: PUB.get(ADMIN.address), signingPub: PUB.get(INVITEE.address), privateKey: INVITEE.key }));
  await pass(m);
  pushControl(INVITEE.address, rootFrom(RIVAL, seed, INVITEE.address));
  await pass(m);
  assert.equal(m.getGroup(groupId), null, "someone else's root is an ordinary invite");
  assert.deepEqual(offersOf(m, groupId).map((entry) => entry.id), [keyFor(groupId, RIVAL)]);
  pushControl(INVITEE.address, rootFrom(ADMIN, seed, INVITEE.address, { name: "Real" }));
  const { controls } = await pass(m);
  assert.ok(controls.some((e) => e.kind === "joined" && e.groupId === groupId));
  assert.equal(m.getGroup(groupId).adminSigningPub, PUB.get(ADMIN.address));
});

await test("a v1 accept (no admin) is ignored, so that group is simply offered again", async () => {
  const m = useWallet(INVITEE);
  const seed = G.generateGroupSeed();
  const groupId = G.deriveGroupId(seed);
  const signed = G.signBytes(Uint8Array.from([1, ...UTF8.encode("gctl_invite_accept"), ...groupId]), INVITEE.key);
  const v1 = { type: "gctl_invite_accept", v: 1, group_id: G.bytesToHex(groupId), signing_pub: PUB.get(INVITEE.address), sig: G.bytesToHex(signed) };
  assert.equal(G.verifyInviteAcceptPayload(v1), false);
  pushControl(INVITEE.address, v1);
  pushControl(INVITEE.address, rootFrom(ADMIN, seed, INVITEE.address, { name: "Offered" }));
  await pass(m);
  assert.equal(m.getGroup(G.bytesToHex(groupId)), null);
  assert.equal(offersOf(m, G.bytesToHex(groupId)).length, 1);
});

await test("delete markers: v2 only touches its admin's group, v1 covers the id from anyone", async () => {
  const m = useWallet(INVITEE);
  const seed = G.generateGroupSeed();
  const held = pushInvite(INVITEE.address, { name: "Held", seed, accepted: true });
  await pass(m);
  const marker = (admin) => G.buildSignedTombstonePayload({ groupId: held.groupId, adminSigningPub: admin, signingPub: PUB.get(INVITEE.address), privateKey: INVITEE.key });
  pushControl(INVITEE.address, marker(PUB.get(RIVAL.address)));
  let { controls } = await pass(m);
  assert.ok(m.getGroup(held.groupId), "a marker about another admin's offer leaves the group");
  assert.ok(!controls.some((e) => e.kind === "deleted"));
  pushControl(INVITEE.address, marker(PUB.get(ADMIN.address)));
  ({ controls } = await pass(m));
  assert.equal(m.getGroup(held.groupId), null, "its own admin's marker removes it");
  assert.ok(controls.some((e) => e.kind === "deleted" && e.groupId === held.groupId));

  const seed2 = G.generateGroupSeed();
  const other = pushInvite(INVITEE.address, { name: "Old", seed: seed2, accepted: true });
  await pass(m);
  pushControl(INVITEE.address, G.buildSignedTombstonePayload({ groupId: other.groupId, signingPub: PUB.get(INVITEE.address), privateKey: INVITEE.key }));
  await pass(m);
  assert.equal(m.getGroup(other.groupId), null);
  pushControl(INVITEE.address, rootFrom(RIVAL, seed2, INVITEE.address));
  await pass(m);
  assert.equal(offersOf(m, other.groupId).length, 0, "no admin can offer it again");
});

await test("deleting a held group marks that admin's offer, and another admin can still offer the id", answering(async () => {
  const m = useWallet(INVITEE);
  const seed = G.generateGroupSeed();
  const held = pushInvite(INVITEE.address, { name: "Gone", seed, accepted: true });
  await pass(m);
  m.deleteGroup(held.groupId);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(m.isGroupTombstoned(held.groupId, PUB.get(ADMIN.address)));
  assert.ok(!m.isGroupTombstoned(held.groupId, PUB.get(RIVAL.address)));
  const { bucket } = m._tombstoneBucket();
  assert.ok(bucket.published.includes(held.key), "the entry is the offer's key, once on chain");
  pushControl(INVITEE.address, rootFrom(RIVAL, seed, INVITEE.address));
  await pass(m);
  assert.deepEqual(offersOf(m, held.groupId).map((entry) => entry.id), [keyFor(held.groupId, RIVAL)]);
}));

await test("a marker that couldn't go yet is sent at the next sync, with its admin", answering(async () => {
  const m = useWallet(INVITEE);
  const groupId = G.bytesToHex(G.deriveGroupId(G.generateGroupSeed()));
  m._recordTombstone(groupId, PUB.get(RIVAL.address), { published: false });
  sent.length = 0;
  await m.syncGroups();
  const marker = sentControls().find((p) => p.group_id === groupId);
  assert.equal(marker.admin_signing_pub, PUB.get(RIVAL.address));
  assert.ok(m._tombstoneBucket().bucket.published.includes(keyFor(groupId, RIVAL)));
}));

await test("old bare tombstone entries still cover the id from any admin", async () => {
  const m = useWallet(INVITEE);
  const seed = G.generateGroupSeed();
  const groupId = G.bytesToHex(G.deriveGroupId(seed));
  m._recordTombstone(groupId, null, { published: true });
  assert.ok(m.isGroupTombstoned(groupId, PUB.get(ADMIN.address)));
  assert.ok(m.isGroupTombstoned(groupId, PUB.get(RIVAL.address)));
  pushControl(INVITEE.address, rootFrom(ADMIN, seed, INVITEE.address));
  await pass(m);
  assert.equal(offersOf(m, groupId).length, 0);
});

await test("another spelling of an id is the same id: rejected stays rejected, held stays held", answering(async () => {
  const m = useWallet(INVITEE);
  const seed = G.generateGroupSeed();
  const groupId = G.bytesToHex(G.deriveGroupId(seed));
  for (const spell of [(hex) => hex.toUpperCase(), (hex) => `0x${hex}`, (hex) => ` ${hex} `]) {
    assert.equal(G.canonicalHex(spell(groupId)), groupId);
  }
  assert.equal(G.canonicalHex("not hex"), "not hex");
  assert.equal(G.canonicalHex(undefined), undefined);
  pushControl(INVITEE.address, rootFrom(ADMIN, seed, INVITEE.address, { name: "Spelled", spell: (hex) => hex.toUpperCase() }));
  await pass(m);
  const [offer] = offersOf(m, groupId);
  assert.equal(offer.id, keyFor(groupId, ADMIN), "held under the lowercase id");
  pushControl(INVITEE.address, rootFrom(ADMIN, seed, INVITEE.address, { name: "Spelled", spell: (hex) => `0x${hex}` }));
  await pass(m);
  assert.equal(offersOf(m, groupId).length, 1, "no second invite");
  m.rejectGroupInvite(offer.id);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await m._publishGroupAnswers();
  pushControl(INVITEE.address, rootFrom(ADMIN, seed, INVITEE.address, { name: "Spelled", spell: (hex) => hex.toUpperCase() }));
  await pass(m);
  assert.equal(offersOf(m, groupId).length, 0, "an uppercase copy doesn't reopen it");
}));

await test("a backup can't bring back the offer you deleted, and one with no admin counts any marker", () => {
  const m = useWallet(INVITEE);
  const groupId = G.bytesToHex(G.deriveGroupId(G.generateGroupSeed()));
  m._recordTombstone(groupId, PUB.get(ADMIN.address), { published: true });
  const record = { groupId, currentEpoch: 0, members: [], groupRootEpoch: "00".repeat(32), blindingKey: "00".repeat(32) };
  assert.equal(m.importGroupRecord({ ...record, adminSigningPub: PUB.get(ADMIN.address) }), false);
  assert.equal(m.importGroupRecord(record), false);
});

// --- signed rosters (iOS 26c4d76d, MESSAGING.md "Signed rosters") ---
function signedRoot(seed, { epoch = 0, members, name = "Team", rosterVersion, admin = ADMIN, unsigned = false }) {
  const groupId = G.deriveGroupId(seed);
  const payload = G.buildSignedRootPayload({
    groupId, epoch, groupRootEpoch: G.deriveGroupRootEpoch(seed, groupId, epoch), blindingKey: G.deriveBlindingKey(seed, groupId),
    adminSigningPub: PUB.get(admin.address), members, name, adminPrivateKey: admin.key, rosterVersion,
  });
  if (unsigned) { delete payload.roster_version; delete payload.roster_sig; }
  return payload;
}
function joined(recipient = INVITEE) {
  const m = useWallet(recipient);
  const invite = pushInvite(recipient.address, { name: "Team", seed: G.generateGroupSeed() });
  return { m, seed: invite.seed, groupId: invite.groupId, members: [ADMIN.address, recipient.address] };
}

await test("the roster signature covers the bytes the spec says, in any member order", () => {
  const groupId = new Uint8Array(32).fill(7);
  const bytes = G.buildRosterSigningPayload({ groupId, epoch: 2, rosterVersion: 1000, members: ["kaspa:B", "kaspa:a"], name: "Hi" });
  const le = (n) => [n, 0, 0, 0, 0, 0, 0, 0];
  const text = (t) => [...new TextEncoder().encode(t)];
  const expected = [1, ...text("gctl_roster"), ...groupId, ...le(2), 232, 3, 0, 0, 0, 0, 0, 0, ...le(2),
    ...le(7), ...text("kaspa:a"), ...le(7), ...text("kaspa:b"), ...le(2), ...text("Hi")];
  assert.deepEqual([...bytes], expected);
  const swapped = G.buildRosterSigningPayload({ groupId, epoch: 2, rosterVersion: 1000, members: ["KASPA:A", "kaspa:b"], name: "Hi" });
  assert.deepEqual([...swapped], expected);
});

await test("every root carries a roster signature, and an edited name or member list fails it", () => {
  const seed = G.generateGroupSeed();
  const root = signedRoot(seed, { members: [ADMIN.address, INVITEE.address], rosterVersion: 5 });
  assert.equal(root.roster_version, 5);
  assert.ok(G.verifyRosterPayload(root));
  assert.ok(!G.verifyRosterPayload({ ...root, name: "Renamed" }));
  assert.ok(!G.verifyRosterPayload({ ...root, members: [ADMIN.address] }));
  assert.ok(!G.verifyRosterPayload({ ...root, roster_sig: undefined }));
  assert.ok(G.verifyRootPayload({ ...root, name: "Renamed" }), "the old signature can't tell, which is why this exists");
});

await test("an edited signed root is refused whoever sends it, even the admin", async () => {
  const { m, seed, groupId, members } = joined();
  await pass(m);
  const edited = { ...signedRoot(seed, { members, name: "Team", rosterVersion: Date.now() + 1000 }), name: "Hacked" };
  assert.equal(await m._applyRoot(edited, ADMIN.address, 1), null);
  assert.equal(await m._applyRoot(edited, "", 1), null);
  assert.equal(m.getGroup(groupId).name, "Team");
});

await test("a signed root counts from any sender, and the admin stays the admin", async () => {
  const { m, seed, groupId, members } = joined();
  await pass(m);
  await m._applyRoot(signedRoot(seed, { members, name: "Renamed", rosterVersion: Date.now() + 1000 }), RIVAL.address, 1);
  const group = m.getGroup(groupId);
  assert.equal(group.name, "Renamed");
  assert.equal(group.adminAddress, ADMIN.address);
  assert.deepEqual(group.members.filter((member) => member.isAdmin).map((member) => member.address), [ADMIN.address]);
});

await test("an unsigned root needs its admin or a blank sender", async () => {
  const seed = G.generateGroupSeed();
  const m = useWallet(INVITEE);
  const key = G.groupInviteKey(G.bytesToHex(G.deriveGroupId(seed)), PUB.get(ADMIN.address));
  const root = (name) => signedRoot(seed, { members: [ADMIN.address, INVITEE.address], name, unsigned: true });
  assert.equal(await m._applyRoot(root("From a member"), RIVAL.address, 1), null);
  assert.ok(!m.pendingGroupInvites().some((entry) => entry.id === key), "no invite from someone who isn't the admin");
  await m._applyRoot(root("Blank"), "", 1);
  assert.ok(m.pendingGroupInvites().some((entry) => entry.name === "Blank"));
  const unknownSender = await m._applyRoot(root("Unknown"), "kaspa:nobody", 1);
  assert.equal(unknownSender, null);
});

await test("after a signed roster, an unsigned or older root changes nothing at the same epoch", async () => {
  const { m, seed, groupId, members } = joined();
  await pass(m);
  const version = Date.now() + 1000;
  await m._applyRoot(signedRoot(seed, { members, name: "Pinned", rosterVersion: version }), ADMIN.address, 1);
  assert.equal(m.getGroup(groupId).rosterVersion, version);
  assert.equal(await m._applyRoot(signedRoot(seed, { members: [ADMIN.address], name: "Old", unsigned: true }), ADMIN.address, 1), null);
  assert.equal(await m._applyRoot(signedRoot(seed, { members: [ADMIN.address], name: "Older", rosterVersion: version - 1 }), ADMIN.address, 1), null);
  assert.equal(m.getGroup(groupId).name, "Pinned");
  assert.equal(m.getGroup(groupId).members.length, 2);
});

await test("a newer epoch from an unsigned root brings its keys and keeps the name and members", async () => {
  const { m, seed, groupId, members } = joined();
  await pass(m);
  await m._applyRoot(signedRoot(seed, { members, name: "Pinned", rosterVersion: Date.now() + 1000 }), ADMIN.address, 1);
  const pin = m.getGroup(groupId).rosterVersion;
  const event = await m._applyRoot(signedRoot(seed, { epoch: 1, members: [ADMIN.address], name: "Changed", unsigned: true }), ADMIN.address, 2);
  const group = m.getGroup(groupId);
  assert.equal(group.currentEpoch, 1);
  assert.equal(group.groupRootEpochHex, G.bytesToHex(G.deriveGroupRootEpoch(seed, G.deriveGroupId(seed), 1)));
  assert.equal(group.name, "Pinned");
  assert.equal(group.members.length, 2);
  assert.equal(group.rosterVersion, pin);
  assert.deepEqual(event.removed, []);
});

await test("a newer signature with nothing else changed moves the pin quietly", async () => {
  const { m, seed, groupId, members } = joined();
  await pass(m);
  const base = m.getGroup(groupId).rosterVersion;
  assert.equal(await m._applyRoot(signedRoot(seed, { members, name: "Team", rosterVersion: base + 5 }), ADMIN.address, 1), null);
  assert.equal(m.getGroup(groupId).rosterVersion, base + 5);
});

await test("a held invite's signed roster isn't replaced by an unsigned or older one", async () => {
  localStorage.removeItem(GROUP_INVITES_KEY); // the shared store would be past the per-admin invite cap by now
  const seed = G.generateGroupSeed();
  const m = useWallet(INVITEE);
  const members = [ADMIN.address, INVITEE.address];
  await m._applyRoot(signedRoot(seed, { members, name: "Signed", rosterVersion: 100 }), ADMIN.address, 1);
  await m._applyRoot(signedRoot(seed, { members, name: "Unsigned", unsigned: true }), ADMIN.address, 2);
  await m._applyRoot(signedRoot(seed, { members, name: "Older", rosterVersion: 99 }), ADMIN.address, 3);
  assert.equal(m.pendingGroupInvites().find((entry) => entry.groupId === G.bytesToHex(G.deriveGroupId(seed))).name, "Signed");
  await m._applyRoot(signedRoot(seed, { members, name: "Newer", rosterVersion: 101 }), ADMIN.address, 4);
  assert.equal(m.pendingGroupInvites().find((entry) => entry.groupId === G.bytesToHex(G.deriveGroupId(seed))).name, "Newer");
});

await test("an admin's next version is above the last one, even with the clock set back", async () => {
  const { m, groupId } = joined();
  await pass(m);
  const future = Date.now() + 10_000_000;
  await m._mutateLocked(groupId, (fresh) => { fresh.rosterVersion = future; });
  assert.equal(await m._nextRosterVersion(groupId), future + 1);
  assert.equal(await m._nextRosterVersion(groupId), future + 2);
  assert.equal(m.getGroup(groupId).rosterVersion, future + 2);
});

await test("the invite stores are wiped with the account", async () => {
  const appSource = readFileSync(join(here, "../ui/app.js"), "utf8");
  for (const key of [GROUP_INVITES_KEY, GROUP_INVITE_ANSWERS_KEY, GROUP_MEMBER_STATUS_KEY]) assert.ok(appSource.includes(`"${key}"`), key);
});

console.log(`\n${ok} passed`);
