// node tools/test-group-force-refresh.mjs - Group Info > Refresh Messages (iOS
// GroupChatService.forceRefresh): the phases in order, this group's message cursors dropped and
// every member stream re-read from the start, rows decoded with the rejection counter, and
// archived epoch keys counted. The control read and decoding are stubbed; the orchestration is real.
import assert from "node:assert/strict";

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
const { GroupManager } = await import("../engine/group-store.js");

const KEY = (n) => n.toString(16).padStart(64, "0");
const pub = (n) => G.bytesToHex(G.xOnlyPublicKey(KEY(n)));
const GROUP = "ab".repeat(16);
const record = {
  groupId: GROUP,
  blindingKeyHex: "cd".repeat(32),
  members: [
    { address: "kaspa:qa", xOnlyPubKeyHex: pub(1) },
    { address: "kaspa:qb", xOnlyPubKeyHex: pub(2) },
    { address: "kaspa:qc", xOnlyPubKeyHex: pub(3) },
    { address: "kaspa:pending" }, // no key yet: no stream to read
  ],
  cursors: { stale: "99" },
  previousRootsHex: { 1: "aa" },
};
const blinded = record.members.filter((m) => m.xOnlyPubKeyHex)
  .map((m) => G.bytesToHex(G.deriveBlindedGroupId(G.hexToBytes(record.blindingKeyHex), m.xOnlyPubKeyHex)));

const scanned = [];
const engine = {
  async scanGroupMessages(blindedHex, cursor) {
    scanned.push({ blindedHex, cursor });
    const i = blinded.indexOf(blindedHex);
    return [
      { txId: `t${i}a`, blockTime: 1000 + i, cursor: `${i}-1`, payloadString: `ok:${i}` },
      { txId: `t${i}b`, blockTime: 2000 + i, cursor: `${i}-2`, payloadString: i === 1 ? "noroot" : i === 2 ? "badkey" : `ok:${i}b` },
    ];
  },
};
const mgr = new GroupManager(engine);
let resetCalls = 0;
let stored = null;
mgr.getGroup = (id) => (id === GROUP ? record : null);
mgr.resetGroupControlCursor = () => { resetCalls += 1; };
mgr._catchUpControlByRecipient = async (events) => {
  events.push({ groupId: GROUP, kind: "root" });
  record.previousRootsHex[2] = "bb"; // a rotation arrived: one more retired root archived
};
mgr._put = (r) => { stored = JSON.parse(JSON.stringify(r)); };
// Decoding is stubbed by call order (rows arrive member by member, two each): member 1's second
// row has no epoch key, member 2's second row fails to decrypt, the rest decode.
let call = 0;
mgr.processMessage = (_parsed, rejections) => {
  const n = call++;
  if (n === 3) { rejections.noRootForEpoch += 1; return null; }
  if (n === 5) { rejections.decryptFailed += 1; return null; }
  return { groupId: GROUP, senderAddress: "kaspa:qa", plaintext: `m${n}`, msgIdHex: `m${n}` };
};

const phases = [];
const result = await mgr.forceRefresh(GROUP, (p) => phases.push(p.phase === "messages" ? `messages ${p.done}/${p.total}` : p.phase));

assert.equal(resetCalls, 1, "the control cursor is dropped");
assert.deepEqual(phases, ["invites", "control", "messages 0/3", "messages 1/3", "messages 2/3", "messages 3/3", "rebuilding"], "phases in iOS order");
assert.equal(scanned.length, 3, "every member with a key is read; the pending one is skipped");
assert.ok(scanned.every((s) => s.cursor === null), "every stream is read from the start");
assert.equal(stored.cursors.stale, undefined, "old cursors are dropped");
for (let i = 0; i < 3; i += 1) assert.equal(stored.cursors[blinded[i]], `${i}-2`, "cursors rebuilt to the newest row read");
assert.equal(result.controls.length, 1, "control events are returned for the app to apply");
assert.equal(result.rejections.epochRootsArchived, 1, "newly archived epoch keys are counted");
assert.equal(result.rejections.noRootForEpoch, 1, "a message from an epoch with no key is counted");
assert.equal(result.rejections.decryptFailed, 1, "a message that fails to decrypt is counted");
assert.equal(result.messages.length, 4, "the rest decode");
console.log("group force refresh: ok", JSON.stringify(result.rejections), `${result.messages.length} decoded`);
