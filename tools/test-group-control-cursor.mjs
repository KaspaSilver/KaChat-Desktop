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
function pushInvite(recipient, { name = "Group", epoch = 0, seed = G.generateGroupSeed(), accepted = true } = {}) {
  const groupId = G.deriveGroupId(seed);
  if (accepted) {
    const answers = JSON.parse(localStorage.getItem(GROUP_INVITE_ANSWERS_KEY) || "{}");
    const mine = answers[recipient] || { accepted: [], published: [], statusOutbox: [] };
    mine.accepted.push(G.bytesToHex(groupId));
    mine.published.push(G.bytesToHex(groupId));
    answers[recipient] = mine;
    localStorage.setItem(GROUP_INVITE_ANSWERS_KEY, JSON.stringify(answers));
  }
  const payload = G.buildSignedRootPayload({
    groupId, epoch,
    groupRootEpoch: G.deriveGroupRootEpoch(seed, groupId, epoch),
    blindingKey: G.deriveBlindingKey(seed, groupId),
    adminSigningPub: PUB.get(ADMIN.address),
    members: [ADMIN.address, recipient],
    name, adminPrivateKey: ADMIN.key,
  });
  // The indexer strips the recipient prefix in REST rows: bare kchat:1:gctl:<encrypted>.
  const row = pushRow(recipient, `kchat:1:gctl:${sealFor(recipient, JSON.stringify(payload))}`);
  return { row, groupId: G.bytesToHex(groupId), seed };
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
  const groupId = m.pendingGroupInvites()[0].groupId;
  sent.length = 0;
  const joined = await m.acceptGroupInvite(groupId);
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
  m.rejectGroupInvite(invite.groupId);
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
  const accept = G.buildSignedInviteAcceptPayload({ groupId: G.hexToBytes(invite.groupId), signingPub: PUB.get(INVITEE.address), privateKey: INVITEE.key });
  pushRow(INVITEE.address, `kchat:1:gctl:${sealFor(INVITEE.address, JSON.stringify(accept))}`);
  const { controls } = await pass(m);
  assert.ok(controls.some((e) => e.kind === "joined" && e.groupId === invite.groupId));
  assert.ok(m.getGroup(invite.groupId));
  // Someone else's signature on it does nothing.
  const other = pushInvite(INVITEE.address, { name: "Forged", accepted: false });
  await pass(m);
  const forged = G.buildSignedInviteAcceptPayload({ groupId: G.hexToBytes(other.groupId), signingPub: PUB.get(ADMIN.address), privateKey: ADMIN.key });
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

await test("the invite stores are wiped with the account", async () => {
  const appSource = readFileSync(join(here, "../ui/app.js"), "utf8");
  for (const key of [GROUP_INVITES_KEY, GROUP_INVITE_ANSWERS_KEY, GROUP_MEMBER_STATUS_KEY]) assert.ok(appSource.includes(`"${key}"`), key);
});

console.log(`\n${ok} passed`);
