// node tools/test-groups-outage.mjs - groups and first-contact messages while the indexer is down
// (iOS 4f8e14bb). A real KaspaEngine drives its real block handler, the real indexer-health detector
// and real REST parsing; only the node stream's input, the REST server and the decrypt stub are
// fakes. Group messages are genuinely sealed, and the signature tier runs real mainnet transactions.
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
const { indexerHealth, onIndexerAvailabilityChange } = await import("../engine/indexer-health.js");
const { createChainHistory } = await import("../engine/chain-history.js");
const { KaspaEngine } = await import("../engine/index.js");
const { BROADCAST_SENDER } = await import("../engine/broadcasts.js");
const { GroupManager, GROUP_CONTROL_CURSOR_KEY } = await import("../engine/group-store.js");

const FIXTURES = {"v0":{"transaction_id":"73c4bcbb285066ed63139c6cbc5c61e344d310a4a42dceb42752841c81a96421","version":0,"subnetwork_id":"0000000000000000000000000000000000000000","payload":"6b636861743a313a636f6d6d3a3937633263333633353731643a6f755a512f7736335058342f6c6471414134554d453068522b645154557339674b324f575339425944654e4331686249353461764649525932614779665355612f75524c6f697761675168594177736632446b7a375a7a38645061396546784d7230302b553679384462736677312b4350614557495248496275304356414d5766322f62726a784d6b4949557357744557746838766c5a61304e37553277664f","inputs":[{"previous_outpoint_hash":"43f766ab42aaa08844ece280e84dfa3092358acd5487a4148f1920cea39fea4b","previous_outpoint_index":"0","previous_outpoint_address":"kaspa:qzk2jrk7wq3zdw2n0260v87fglky82cg5u3pwy73wpktk3u864yecm5djll40","previous_outpoint_amount":195749331,"signature_script":"41f530b317de5005a7ee0e3a91803fb45088ce43af0d9e725f7514ba7a1773a3e3da52b1400526c7431d04d6697f89febbd538d0c9ae9e1c6273482a772a5ef14f01","sig_op_count":"1"}],"outputs":[{"index":0,"amount":195568328,"script_public_key":"20aca90ede702226b9537ab4f61fc947ec43ab08a7221713d1706cbb4787d5499cac","script_public_key_address":"kaspa:qzk2jrk7wq3zdw2n0260v87fglky82cg5u3pwy73wpktk3u864yecm5djll40","covenant_authorizing_input":null,"covenant_id":null}]},"v1":{"transaction_id":"97b1f40d00c696eeecd9563be173bc1929ab146db32e8f23e9d67575eff39b79","version":1,"subnetwork_id":"97b1000000000000000000000000000000000000","payload":"95789c8dcd792843011cc0f1f75e426e8626e44ec87a11a5146ac97d451a72162657422b6598e5684b720c39e6564c16424b7894891c19535bb694359b651bbd9d357ff8ffcdf78fdf3f9f5fbf1f64800efb585c9aed17952e17acba017f93665351348e64eb5c920712b6d11352aec07faf26fa6774b0e708223e71fb9d1988597da11ce304f8e00a55e91f20f3e1cdb26c7f6c27bec9a417d0e2d06232137ff0599a144d325e6bec28c514be526a03c403ef39a9d3536c8508c0080c22e66179d030af14c0ced18a4bb119acc47620a5ae16c4c1db2bae2621c37fd117bda3531d8a608ea7366d289cb84e5b35256e2aee9f37eae708d349613a6e540579a191d3b2bcb1d6cc73b8ca62d827fb01ff2f427043a70c7f4b477b655d07c2c02a7e4822056b1f64421e564e565af114437debd27c09aaad6aea9b7a55b70737497897d4adc516f9d98ca96cc6d358ededb4efd7ecd5b15338626904bda95ebb9638a4530d1a6771840cd55098af9507a73decf388c87b16be7c52a45ed7e3e1acdb71568c1ee95e086dd048908947523e9b400a70971d89a3f870db64477670aa5900bf40645b749eed28971889b1bf7c3cb2070001a29e","inputs":[{"previous_outpoint_hash":"97b18c603f4a4711cea105b982e762915b2873df970df9fb030297f39fe2f2e2","previous_outpoint_index":"0","previous_outpoint_address":"kaspa:qqt9pdktna9dzf8u2rz6jnqvpcda8nxpreaxnspq0m5hnumsmvqnu6nxxclec","previous_outpoint_amount":381428448,"signature_script":"410fd934777951dc52f74fbc9d8c4de671d59323f49b378baecb66fcea9137e6ae454094293bf907850172cf924b217c85aaa0a74b9a1b00c70ed474afe5eafe1401","sig_op_count":"0"}],"outputs":[{"index":0,"amount":381177148,"script_public_key":"201650b6cb9f4ad124fc50c5a94c0c0e1bd3ccc11e7a69c0207ee979f370db013eac","script_public_key_address":"kaspa:qqt9pdktna9dzf8u2rz6jnqvpcda8nxpreaxnspq0m5hnumsmvqnu6nxxclec","covenant_authorizing_input":null,"covenant_id":null}]},"missingFields":{"transaction_id":"f208a937f4bab5966d11504bde84dc4410504e5631c2d4aae23bfc47c557927f","version":0,"subnetwork_id":"0000000000000000000000000000000000000000","payload":null,"inputs":[{"previous_outpoint_hash":"5fc1ba14059a145b6a062b02af2dac518b51db870d25523ea8a048781b404645","previous_outpoint_index":"0","previous_outpoint_address":"kaspa:qzk2jrk7wq3zdw2n0260v87fglky82cg5u3pwy73wpktk3u864yecm5djll40","previous_outpoint_amount":500000000,"signature_script":"4140260c191d26666ebdab40895ad38d38ed6e2b2ac4c38fca18b2b0c6febbc6faed4271cd7ba2ca506adbc69b4c516eb7b4f3398c82f54473b5911f71b4a933d701","sig_op_count":"1"},{"previous_outpoint_hash":"852fd248f8a599d413b3a857106ad56bb24839488922782d94d7f74b00c6f76c","previous_outpoint_index":"0","previous_outpoint_address":"kaspa:qzk2jrk7wq3zdw2n0260v87fglky82cg5u3pwy73wpktk3u864yecm5djll40","previous_outpoint_amount":95485528,"signature_script":"41ec8b8df6b6a876e65f94842a22f8c0167a5c1056250dc9f08feac1b73e041c1d21623aafc315ba6ac91c1ae8f8a895a52fbd6a2197945e9b0c2d20a60ed7d30001","sig_op_count":"1"}],"outputs":[{"index":0,"amount":595211325,"script_public_key":"20af1044f8c7ac523b7862ac6d6d5d91909d22d93001775ae65dce7f3541e4950dac","script_public_key_address":"kaspa:qzh3q38cc7k9ywmcv2kx6m2ajxgf6gkexqqhwkhxth887d2puj2s6ah2epnet","covenant_authorizing_input":null,"covenant_id":null}]}};
const clone = (value) => JSON.parse(JSON.stringify(value));

const UTF8 = new TextEncoder();
const toHex = (text) => G.bytesToHex(UTF8.encode(text));
const KEY = (n) => n.toString(16).padStart(64, "0");
const wallet = (name, n) => ({ address: `kaspa:qz${name.padEnd(58, name[0])}`, key: KEY(n) });
const ME = wallet("me", 0xa1);
const OTHER = wallet("other", 0xa2);
const ADMIN = wallet("admin", 0xad);
const MEMBER = wallet("bob", 0xb0);
const MALLORY = wallet("mallory", 0xee);
const PUB = new Map([ME, OTHER, ADMIN, MEMBER, MALLORY].map((w) => [w.address, G.bytesToHex(G.xOnlyPublicKey(w.key))]));

// --- REST server ---
const restTxs = new Map();        // txid -> raw REST transaction
const restUnlisted = new Set();   // txids the REST server doesn't know yet
const restHistory = new Map();    // address -> REST rows
const restRequests = [];
globalThis.fetch = async (url) => {
  const u = new URL(url);
  restRequests.push(u.pathname);
  const match = u.pathname.match(/^\/transactions\/(.+)$/);
  if (match) {
    const id = decodeURIComponent(match[1]);
    if (restUnlisted.has(id)) return { ok: false, status: 404, json: async () => ({}) };
    const raw = restTxs.get(id) || { transaction_id: id };
    return { ok: true, status: 200, json: async () => raw };
  }
  const lane = u.pathname.match(/^\/addresses\/(.+)\/full-transactions$/);
  if (lane) return { ok: true, status: 200, json: async () => restHistory.get(decodeURIComponent(lane[1])) || [] };
  return { ok: false, status: 503, json: async () => ({}) };
};

const sealFor = (address, json) => toHex(JSON.stringify({ to: address, body: json }));
const restRow = (txId, sender, blockTime, payloadHex) => ({
  transaction_id: txId, block_time: blockTime, is_accepted: true, payload: payloadHex,
  inputs: [{ previous_outpoint_address: sender }], outputs: [{ script_public_key_address: sender, amount: "1000" }],
});
const blockOf = (txs, timestamp = 1_700_000_000_000) => ({ type: "block-added", data: { block: { header: { timestamp }, transactions: txs } } });
const streamTx = (txId, claimedSender, payloadHex, blockTime = 1_700_000_500_000) => ({
  payload: payloadHex,
  outputs: [{ verboseData: { scriptPublicKeyAddress: claimedSender } }],
  verboseData: { transactionId: txId, blockTime },
});
const settle = async () => { for (let i = 0; i < 40; i += 1) await new Promise((resolve) => setImmediate(resolve)); };

function makeGroup() {
  const seed = G.generateGroupSeed();
  const groupId = G.deriveGroupId(seed);
  const epoch = 0;
  return {
    seed, groupId, epoch,
    groupIdHex: G.bytesToHex(groupId),
    root: G.deriveGroupRootEpoch(seed, groupId, epoch),
    blinding: G.deriveBlindingKey(seed, groupId),
    device: G.generateDeviceId(),
  };
}
function groupRecord(group, members = [ADMIN, MEMBER, ME]) {
  return {
    groupId: group.groupIdHex, name: "Group", isAdmin: false, adminAddress: ADMIN.address,
    adminSigningPub: PUB.get(ADMIN.address), groupSeedHex: null,
    groupRootEpochHex: G.bytesToHex(group.root), blindingKeyHex: G.bytesToHex(group.blinding),
    currentEpoch: group.epoch, deviceIdHex: G.bytesToHex(group.device), msgCounter: 0,
    members: members.map((w) => ({ address: w.address, xOnlyPubKeyHex: PUB.get(w.address), isAdmin: w === ADMIN })),
    cursors: {}, updatedAt: 0, learnedAtMs: 1,
  };
}
const sealFrom = (sender, group, text, counter = 1) => G.sealGroupMessage({
  plaintext: text, groupId: group.groupId, epoch: group.epoch, groupRootEpoch: group.root, blindingKey: group.blinding,
  senderAddress: sender.address, senderPrivateKey: sender.key, senderXOnlyPub: PUB.get(sender.address),
  deviceId: group.device, counter,
});
function rootControlPayload(group, recipient, { admin = ADMIN, name = "Invited", members = [admin.address, recipient.address] } = {}) {
  const payload = G.buildSignedRootPayload({
    groupId: group.groupId, epoch: group.epoch, groupRootEpoch: group.root, blindingKey: group.blinding,
    adminSigningPub: PUB.get(admin.address), members, name, adminPrivateKey: admin.key,
  });
  return G.buildControlPayload({ recipientXOnlyPubKey: G.hexToBytes(PUB.get(recipient.address)), encryptedHex: sealFor(recipient.address, JSON.stringify(payload)) });
}

const verdicts = new Map(); // txid -> verdict; missing = the REST API can't say yet
let verifyCalls = 0;
let verdictGate = null;     // when set, proofs wait for it (a proof still in flight)

function makeEngine({ account = ME } = {}) {
  verdicts.clear();
  verifyCalls = 0;
  verdictGate = null;
  restTxs.clear();
  restUnlisted.clear();
  restHistory.clear();
  restRequests.length = 0;
  indexerHealth.reset();
  localStorage.map.clear();
  const logs = [];
  const engine = new KaspaEngine({ log: (...parts) => logs.push(parts.join(" ")) });
  engine.address = account.address;
  engine.privateKeyHex = account.key;
  engine.outageProofRetryDelaysMs = [0, 0];
  engine.decryptGroupControl = async function decryptGroupControl(encryptedHex) {
    const sealed = JSON.parse(new TextDecoder().decode(G.hexToBytes(encryptedHex)));
    if (sealed.to !== this.address) throw new Error("not ours");
    return sealed.body;
  };
  engine.xOnlyPubKeyForAddress = async (address) => {
    if (!PUB.has(address)) throw new Error("no pubkey");
    return PUB.get(address);
  };
  engine.verifyChainTransaction = async (raw, txId) => {
    verifyCalls += 1;
    if (verdictGate) await verdictGate;
    return verdicts.get(txId) || { check: "unknown", sender: null };
  };
  const history = createChainHistory({ sleep: async () => {}, restBase: () => "https://rest.test" });
  engine.groupChainTransactions = (address, since) => history.chainTransactions(address, since);
  engine.scanGroupControlByRecipientPage = async () => ({ rows: [], nextCursor: null, rawCount: 0 });
  engine.scanGroupMessagesSince = async () => { throw new Error("the indexer is not read during an outage"); };
  return { engine, manager: new GroupManager(engine), logs };
}
function markIndexerDown(engine) {
  const url = engine.groupIndexerUrl();
  const real = Date.now;
  let t = real();
  for (let i = 0; i < 3; i += 1) { Date.now = () => (t += 6_000); indexerHealth.recordFailure(url); }
  Date.now = real;
  assert.equal(engine.isGroupIndexerDown(), true, "the detector is down");
}

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`ok ${name}`); }
  catch (error) { console.error(`FAIL ${name}\n`, error); process.exitCode = 1; }
}

// --- a forged sender --------------------------------------------------------------------------
await test("stream: a control whose input signature names someone else is dropped", async () => {
  const { engine, manager } = makeEngine();
  markIndexerDown(engine);
  await manager.syncGroups(); // starts the stream
  assert.equal(engine.blockScanClients.size, 1);
  const group = makeGroup();
  const wire = rootControlPayload(group, ME);
  verdicts.set("forged-tx", { check: "valid", sender: MALLORY.address });
  engine.handleBlockAddedEvent(blockOf([streamTx("forged-tx", ADMIN.address, toHex(wire))]));
  await settle();
  const { controls } = await manager.syncGroups();
  assert.deepEqual(controls, [], "no event");
  assert.equal(manager.getGroup(group.groupIdHex), null, "no group");
  assert.deepEqual(manager.pendingGroupInvites(), [], "no invite");
  assert.equal(verifyCalls, 1, "asked once, not per block");
  // a later copy of the same txid stays dropped
  engine.handleBlockAddedEvent(blockOf([streamTx("forged-tx", ADMIN.address, toHex(wire))]));
  await settle();
  assert.equal(verifyCalls, 1, "a forged tx isn't re-judged");
});

await test("stream: an invalid signature is dropped, proven sender becomes an invite", async () => {
  const { engine, manager } = makeEngine();
  markIndexerDown(engine);
  await manager.syncGroups();
  const bad = makeGroup();
  verdicts.set("invalid-tx", { check: "invalid", sender: null });
  const good = makeGroup();
  verdicts.set("good-tx", { check: "valid", sender: ADMIN.address });
  engine.handleBlockAddedEvent(blockOf([
    streamTx("invalid-tx", ADMIN.address, toHex(rootControlPayload(bad, ME))),
    streamTx("good-tx", ADMIN.address, toHex(rootControlPayload(good, ME))),
  ]));
  await settle();
  const { controls } = await manager.syncGroups();
  assert.equal(controls.length, 1);
  assert.equal(controls[0].kind, "invite");
  assert.equal(controls[0].groupId, good.groupIdHex);
  assert.equal(controls[0].blockTime, 1_700_000_500_000);
  assert.equal(manager.pendingGroupInvites().length, 1);
});

await test("stream: another wallet's control costs no REST call; a legacy no-recipient one is decrypted", async () => {
  const { engine, manager } = makeEngine();
  markIndexerDown(engine);
  await manager.syncGroups();
  const elsewhere = rootControlPayload(makeGroup(), OTHER);
  engine.handleBlockAddedEvent(blockOf([streamTx("other-tx", ADMIN.address, toHex(elsewhere))]));
  await settle();
  assert.equal(verifyCalls, 0, "not ours: never proven");
  const bare = `ciph_msg:1:gctl:${sealFor(OTHER.address, "{}")}`;
  engine.handleBlockAddedEvent(blockOf([streamTx("legacy-tx", ADMIN.address, toHex(bare))]));
  await settle();
  assert.equal(verifyCalls, 0, "undecryptable legacy shape: never proven");
});

await test("stream: a transaction with no claimed sender isn't judged forged", async () => {
  const { engine, manager } = makeEngine();
  markIndexerDown(engine);
  await manager.syncGroups();
  const group = makeGroup();
  const tx = streamTx("no-claim", ADMIN.address, toHex(rootControlPayload(group, ME)));
  tx.outputs = [];
  engine.handleBlockAddedEvent(blockOf([tx]));
  await settle();
  assert.equal(verifyCalls, 0);
  assert.equal(manager._outageState.handled.has("no-claim"), false, "the REST lane can still read it");
});

await test("real signature check: the input's signature is what proves a sender", async () => {
  const { engine } = makeEngine();
  delete engine.verifyChainTransaction; // the real one, on real mainnet transactions
  const signer = FIXTURES.v0.inputs[0].previous_outpoint_address;
  const raw = clone(FIXTURES.v0);
  restTxs.set(raw.transaction_id, raw);
  assert.equal(await engine.provenChainSender({ txId: raw.transaction_id, expected: signer }), "proven");
  assert.equal(await engine.provenChainSender({ txId: raw.transaction_id, expected: MALLORY.address }), "forged", "someone else's claim");
  const badSig = clone(FIXTURES.v1);
  const script = badSig.inputs[0].signature_script;
  badSig.inputs[0].signature_script = script.slice(0, 10) + (script[10] === "0" ? "1" : "0") + script.slice(11);
  assert.equal(await engine.provenChainSender({ txId: badSig.transaction_id, expected: badSig.inputs[0].previous_outpoint_address, raw: badSig }), "forged", "a broken signature");
  restUnlisted.add("not-listed-yet");
  assert.equal(await engine.provenChainSender({ txId: "not-listed-yet", expected: signer }), "unknown", "not listed yet");
});

// --- applied once -------------------------------------------------------------------------------
await test("a message seen in two blocks and in the sender's REST history is applied once", async () => {
  const { engine, manager } = makeEngine();
  markIndexerDown(engine);
  const group = makeGroup();
  manager._put(groupRecord(group));
  await manager.syncGroups();
  const wire = sealFrom(MEMBER, group, "hello from the stream");
  const tx = streamTx("msg-1", MEMBER.address, toHex(wire));
  engine.handleBlockAddedEvent(blockOf([tx]));
  engine.handleBlockAddedEvent(blockOf([tx]));
  await settle();
  restHistory.set(MEMBER.address.toLowerCase(), [restRow("msg-1", MEMBER.address, Date.now() - 1000, toHex(wire))]);
  const first = await manager.syncGroups();
  const second = await manager.syncGroups();
  const delivered = [...first.messages, ...second.messages];
  assert.equal(delivered.length, 1, "exactly one delivery");
  assert.equal(delivered[0].plaintext, "hello from the stream");
  assert.equal(delivered[0].senderAddress, MEMBER.address);
  assert.equal(delivered[0].txId, "msg-1");
  assert.equal(delivered[0].groupId, group.groupIdHex);
});

await test("a message with a forged signature never arrives; one under an unknown key is retried", async () => {
  const { engine, manager } = makeEngine();
  markIndexerDown(engine);
  const group = makeGroup();
  manager._put(groupRecord(group));
  await manager.syncGroups();
  const forged = sealFrom(MEMBER, group, "forged").replace(/.$/, (c) => (c === "0" ? "1" : "0"));
  const notYet = makeGroup();
  const wrongKey = sealFrom(MEMBER, notYet, "no key yet");
  engine.handleBlockAddedEvent(blockOf([
    streamTx("forged-msg", MEMBER.address, toHex(forged)),
    streamTx("nokey-msg", MEMBER.address, toHex(wrongKey)),
  ]));
  await settle();
  const { messages } = await manager.syncGroups();
  assert.deepEqual(messages, []);
  assert.equal(manager._outageState.handled.has("forged-msg"), false, "nothing is remembered for a message that didn't open");
  manager._put({ ...groupRecord(notYet), groupId: notYet.groupIdHex });
  engine.handleBlockAddedEvent(blockOf([streamTx("nokey-msg", MEMBER.address, toHex(wrongKey))]));
  await settle();
  const again = await manager.syncGroups();
  assert.equal(again.messages.length, 1, "a key that arrived later opens it");
});

await test("REST lane: forged control dropped, unknown stops the lane until it can be proven", async () => {
  const { engine, manager, logs } = makeEngine();
  markIndexerDown(engine);
  const group = makeGroup();
  manager._put(groupRecord(group));
  const now = Date.now();
  const invite = makeGroup();
  const later = makeGroup();
  const forgedInvite = makeGroup();
  restHistory.set(ADMIN.address.toLowerCase(), [
    restRow("ctl-forged", ADMIN.address, now - 3000, toHex(rootControlPayload(forgedInvite, ME))),
    restRow("ctl-unknown", ADMIN.address, now - 2000, toHex(rootControlPayload(invite, ME))),
    restRow("ctl-after", ADMIN.address, now - 1000, toHex(rootControlPayload(later, ME))),
  ]);
  verdicts.set("ctl-forged", { check: "valid", sender: MALLORY.address });
  verdicts.set("ctl-after", { check: "valid", sender: ADMIN.address });
  const first = await manager.syncGroups();
  assert.deepEqual(first.controls, [], "the row after the unknown one waited");
  assert.ok(logs.some((line) => line.includes("forged sender")), "the drop is logged");
  verdicts.set("ctl-unknown", { check: "valid", sender: ADMIN.address });
  const second = await manager.syncGroups();
  assert.deepEqual(second.controls.map((event) => event.kind), ["invite", "invite"]);
  assert.deepEqual(second.controls.map((event) => event.groupId).sort(), [invite.groupIdHex, later.groupIdHex].sort());
  assert.equal(manager.pendingGroupInvites().length, 2);
  const third = await manager.syncGroups();
  assert.deepEqual(third.controls, []);
});

await test("REST lane: admins read first, so a group's messages use keys its root just delivered", async () => {
  const { engine, manager } = makeEngine();
  markIndexerDown(engine);
  const group = makeGroup();
  const rotated = { ...group, epoch: 1, root: G.deriveGroupRootEpoch(group.seed, group.groupId, 1) };
  manager._put(groupRecord(group));
  const now = Date.now();
  // the member's message is older than the root in time, and on the member's lane
  restHistory.set(MEMBER.address.toLowerCase(), [restRow("rot-msg", MEMBER.address, now - 2000, toHex(sealFrom(MEMBER, rotated, "after rotation")))]);
  restHistory.set(ADMIN.address.toLowerCase(), [restRow("rot-root", ADMIN.address, now - 1000, toHex(rootControlPayload(rotated, ME, { members: [ADMIN.address, MEMBER.address, ME.address] })))]);
  verdicts.set("rot-root", { check: "valid", sender: ADMIN.address });
  const { messages } = await manager.syncGroups();
  assert.equal(messages.length, 1, "decoded with the root that arrived in the same pass");
  assert.equal(messages[0].plaintext, "after rotation");
  assert.equal(manager.getGroup(group.groupIdHex).currentEpoch, 1);
});

await test("while the indexer is up nothing reads the chain or the block stream", async () => {
  const { engine, manager } = makeEngine();
  const group = makeGroup();
  manager._put(groupRecord(group));
  let chainCalls = 0;
  engine.groupChainTransactions = async () => { chainCalls += 1; return []; };
  engine.scanGroupMessages = async () => [];
  engine.scanGroupMessagesSince = async () => ({ messages: [], latestBlockTime: 0, count: 0 });
  const before = restRequests.length;
  await manager.syncGroups();
  assert.equal(chainCalls, 0);
  assert.equal(engine.blockScanClients.size, 0);
  assert.equal(restRequests.length, before);
  // and an outage that ends puts things back
  markIndexerDown(engine);
  await manager.syncGroups();
  assert.equal(engine.blockScanClients.size, 1);
  indexerHealth.recordAnswer(engine.groupIndexerUrl());
  await manager.syncGroups();
  assert.equal(engine.blockScanClients.size, 0, "the stream stops on recovery");
});

await test("the indexer going down during a pass reads the chain in the same pass", async () => {
  const { engine, manager } = makeEngine();
  const group = makeGroup();
  manager._put(groupRecord(group));
  engine.scanGroupMessagesSince = async () => ({ messages: [], latestBlockTime: 0, count: 0 });
  let lanes = 0;
  engine.scanGroupMessages = async () => { markIndexerDown(engine); lanes += 1; return []; };
  let chainCalls = 0;
  engine.groupChainTransactions = async () => { chainCalls += 1; return []; };
  await manager.syncGroups();
  assert.ok(lanes > 0);
  assert.ok(chainCalls > 0, "the chain was read after the failure");
});

// --- rewinding ----------------------------------------------------------------------------------
await test("rewindGroupCursors: only cursors past the time move, the rest stay, deletions stay deleted", async () => {
  const { engine, manager } = makeEngine();
  const group = makeGroup();
  const rec = groupRecord(group);
  const T = 1_700_000_000_000;
  rec.cursors = { oldLane: "c-old", newLane: "c-new", unknownLane: "c-unknown" };
  rec.cursorTimes = { oldLane: T - 5000, newLane: T + 5000 };
  manager._put(rec);
  manager.sinceBlockTime = T + 9000;
  localStorage.setItem(GROUP_CONTROL_CURSOR_KEY, JSON.stringify({ [ME.address]: { cursor: "99", indexer: "x", caughtUp: true, at: T + 1 } }));
  const summary = await manager.rewindGroupCursors(T);
  assert.deepEqual(summary, { lanes: 2, control: true, since: true });
  const after = manager.getGroup(group.groupIdHex);
  assert.deepEqual(after.cursors, { oldLane: "c-old" });
  assert.equal(after.cursorTimes.oldLane, T - 5000);
  assert.equal(manager.sinceBlockTime, T);
  assert.equal(manager.groupControlCursor(), null);
  // a later rewind to an earlier time leaves what's already earlier alone
  localStorage.setItem(GROUP_CONTROL_CURSOR_KEY, JSON.stringify({ [ME.address]: { cursor: "5", indexer: "x", caughtUp: true, at: T - 100 } }));
  const none = await manager.rewindGroupCursors(T);
  assert.deepEqual(none, { lanes: 0, control: false, since: false });
  assert.equal(manager.groupControlCursor().cursor, "5");
});

await test("rewind doesn't resurrect a deleted group, and a re-served root for it stays refused", async () => {
  const { engine, manager } = makeEngine();
  const group = makeGroup();
  const keep = makeGroup();
  const T = 1_700_000_000_000;
  const rec = groupRecord(group);
  rec.cursors = { lane: "c" };
  rec.cursorTimes = { lane: T + 1 };
  manager._put(rec);
  manager._put(groupRecord(keep));
  manager._publishTombstone = async () => {}; // no chain write in this test
  manager.deleteGroup(group.groupIdHex);
  assert.equal(manager.getGroup(group.groupIdHex), null);
  await manager.rewindGroupCursors(T);
  assert.equal(manager.getGroup(group.groupIdHex), null, "no write resurrected it");
  assert.equal(manager.listGroups().length, 1);
  markIndexerDown(engine);
  const reserved = rootControlPayload(group, ME);
  const answer = await manager.applyControl(reserved, ADMIN.address, T + 10);
  assert.equal(answer, null, "the tombstone still decides");
  assert.equal(manager.getGroup(group.groupIdHex), null);
  assert.deepEqual(manager.pendingGroupInvites(), []);
});

await test("cursor times are recorded by the real passes, and a rewind beats a walk in progress", async () => {
  const { engine, manager } = makeEngine();
  const group = makeGroup();
  manager._put(groupRecord(group));
  const lane = G.bytesToHex(G.deriveBlindedGroupId(group.blinding, G.hexToBytes(PUB.get(ADMIN.address))));
  engine.scanGroupMessages = async (id) => (id === lane ? [{ txId: "t1", blockTime: 777, cursor: "c1", payloadString: "x" }] : []);
  engine.scanGroupMessagesSince = async () => ({ messages: [], latestBlockTime: 0, count: 0 });
  await manager.syncGroups();
  assert.equal(manager.getGroup(group.groupIdHex).cursors[lane], "c1");
  assert.equal(manager.getGroup(group.groupIdHex).cursorTimes[lane], 777);
  // the control walk: stored `at`, and not written back after a rewind landed mid-walk
  engine.scanGroupControlByRecipientPage = async () => ({ rows: [{ txId: "c", sender: ADMIN.address, blockTime: 900, payloadString: "kchat:1:gctl:00" }], nextCursor: "n1", rawCount: 1 });
  manager.sinceBlockTime = 0;
  await manager.syncGroups();
  assert.equal(manager.groupControlCursor().at, 900);
  engine.scanGroupControlByRecipientPage = async () => {
    await manager.rewindGroupCursors(5);
    return { rows: [], nextCursor: "n2", rawCount: 0 };
  };
  await manager.syncGroups();
  assert.equal(manager.groupControlCursor(), null, "the rewind wins over the walk it interrupted");
});

await test("the recovery notice carries the outage's start", async () => {
  const { engine } = makeEngine();
  const seen = [];
  const off = onIndexerAvailabilityChange((change) => seen.push(change));
  markIndexerDown(engine);
  indexerHealth.recordAnswer(engine.groupIndexerUrl());
  off();
  assert.deepEqual(seen.map((c) => c.down), [true, false]);
  assert.ok(seen[1].downSinceMs > 0);
});

// --- the inbox scan -----------------------------------------------------------------------------
const dmPayload = (tag, alias = "aabbcc", sealed = "c2VhbGVk") => toHex(`kchat:1:dm:${tag}:${alias}:${sealed}`);

await test("inbox scan: a proven first-contact message becomes one hit", async () => {
  const { engine } = makeEngine();
  const hits = [];
  assert.equal(engine.startInboxBlockScan({ wallet: ME.address, tag: engine.inboxTagFor(ME.address), onHit: (hit) => hits.push(hit) }), true);
  assert.equal(engine.blockScanClients.size, 1);
  const tag = engine.inboxTagFor(ME.address);
  const payload = dmPayload(tag);
  verdicts.set("dm-1", { check: "valid", sender: MEMBER.address });
  const tx = streamTx("dm-1", MEMBER.address, payload);
  engine.handleBlockAddedEvent(blockOf([tx]));
  engine.handleBlockAddedEvent(blockOf([tx]));
  await settle();
  assert.deepEqual(hits, [{ sender: MEMBER.address, txid: "dm-1", blockTime: 1_700_000_500_000, payloadHex: payload.toLowerCase() }]);
});

await test("inbox scan: forged sender dropped, unknown retried, wrong tag ignored, own message ignored", async () => {
  const { engine } = makeEngine();
  const hits = [];
  engine.startInboxBlockScan({ wallet: ME.address, tag: engine.inboxTagFor(ME.address), onHit: (hit) => hits.push(hit) });
  const tag = engine.inboxTagFor(ME.address);
  verdicts.set("dm-forged", { check: "valid", sender: MALLORY.address });
  verdicts.set("dm-self", { check: "valid", sender: ME.address });
  let asked = 0;
  const base = engine.verifyChainTransaction;
  engine.verifyChainTransaction = async (raw, txId) => {
    if (txId === "dm-slow" && (asked += 1) === 3) verdicts.set("dm-slow", { check: "valid", sender: MEMBER.address });
    return base(raw, txId);
  };
  engine.handleBlockAddedEvent(blockOf([
    streamTx("dm-forged", ADMIN.address, dmPayload(tag)),
    streamTx("dm-other", MEMBER.address, dmPayload("0".repeat(32))),
    streamTx("dm-self", ME.address, dmPayload(tag)),
    streamTx("dm-slow", MEMBER.address, dmPayload(tag)),
  ]));
  await settle();
  assert.deepEqual(hits.map((hit) => hit.txid), ["dm-slow"], "only the one that proved, after retries");
  assert.equal(asked, 3, "asked three times");
});

await test("account switch: inbox scan stops, an in-flight proof delivers nothing", async () => {
  const { engine } = makeEngine();
  const hits = [];
  const tag = engine.inboxTagFor(ME.address);
  engine.startInboxBlockScan({ wallet: ME.address, tag, onHit: (hit) => hits.push(hit) });
  let open;
  verdictGate = new Promise((resolve) => { open = resolve; });
  verdicts.set("dm-inflight", { check: "valid", sender: MEMBER.address });
  engine.handleBlockAddedEvent(blockOf([streamTx("dm-inflight", MEMBER.address, dmPayload(tag))]));
  await settle();
  assert.deepEqual(hits, [], "still proving");
  engine.setWallet({ address: OTHER.address, privateKey: null, privateKeyHex: OTHER.key });
  assert.equal(engine.inboxBlockScan, null, "stopped at once");
  assert.equal(engine.blockScanClients.size, 0, "off the block stream");
  open();
  await settle();
  assert.deepEqual(hits, [], "the old account's proof was dropped");
  engine.handleBlockAddedEvent(blockOf([streamTx("dm-late", MEMBER.address, dmPayload(tag))]));
  await settle();
  assert.deepEqual(hits, [], "no block reaches a stopped scan");
  // a scan for a wallet that isn't the one open is refused outright
  assert.equal(engine.startInboxBlockScan({ wallet: ME.address, tag, onHit: () => {} }), false);
  assert.equal(engine.blockScanClients.size, 0);
});

await test("clearSession stops scans; stop is idempotent; restart replaces the callback", async () => {
  const { engine } = makeEngine();
  const a = [];
  const b = [];
  const tag = engine.inboxTagFor(ME.address);
  engine.startInboxBlockScan({ wallet: ME.address, tag, onHit: (hit) => a.push(hit) });
  engine.startInboxBlockScan({ wallet: ME.address, tag, onHit: (hit) => b.push(hit) });
  assert.equal(engine.blockScanClients.size, 1);
  verdicts.set("dm-2", { check: "valid", sender: MEMBER.address });
  engine.handleBlockAddedEvent(blockOf([streamTx("dm-2", MEMBER.address, dmPayload(tag))]));
  await settle();
  assert.equal(a.length, 0);
  assert.equal(b.length, 1);
  engine.stopInboxBlockScan();
  engine.stopInboxBlockScan();
  engine.startInboxBlockScan({ wallet: ME.address, tag, onHit: () => {} });
  engine.clearSession();
  assert.equal(engine.blockScanClients.size, 0);
  assert.equal(engine.inboxBlockScan, null);
});

await test("account switch: in-flight group control dropped, group stream stopped", async () => {
  const { engine, manager } = makeEngine();
  markIndexerDown(engine);
  await manager.syncGroups();
  assert.equal(engine.groupBlockScan?.wallet, ME.address);
  const group = makeGroup();
  let open;
  verdictGate = new Promise((resolve) => { open = resolve; });
  verdicts.set("ctl-inflight", { check: "valid", sender: ADMIN.address });
  engine.handleBlockAddedEvent(blockOf([streamTx("ctl-inflight", ADMIN.address, toHex(rootControlPayload(group, ME)))]));
  await settle();
  engine.setWallet({ address: OTHER.address, privateKey: null, privateKeyHex: OTHER.key });
  assert.equal(engine.groupBlockScan, null);
  assert.equal(engine.blockScanClients.size, 0);
  open();
  await settle();
  // the old account's rows are not stored under either account
  const otherManager = new GroupManager(engine);
  assert.deepEqual(otherManager.pendingGroupInvites(), []);
  engine.address = ME.address;
  assert.deepEqual(new GroupManager(engine).pendingGroupInvites(), [], "nothing landed for the old account");
  assert.equal(manager._outageState.controls.length, 0);
});

await test("a pass that outlives an account change keeps nothing", async () => {
  const { engine, manager } = makeEngine();
  markIndexerDown(engine);
  const group = makeGroup();
  manager._put(groupRecord(group));
  engine.groupChainTransactions = async () => {
    engine.setWallet({ address: OTHER.address, privateKey: null, privateKeyHex: OTHER.key });
    return [];
  };
  const result = await manager.syncGroups();
  assert.equal(result.skipped, "account-changed");
  assert.deepEqual(result.messages, []);
});

// --- the shared stream ---------------------------------------------------------------------------
await test("rooms and outage scans share the subscription: neither tears it down under the other", async () => {
  const { engine } = makeEngine();
  let detached = 0;
  engine.detachBroadcastBlockScan = async () => { detached += 1; };
  engine.blockScanHandler = () => {};
  engine.blockScanRpc = engine.rpc;
  engine.setBroadcastScanChannels(["general"]);
  await settle();
  assert.equal(detached, 0);
  const remove = engine.addBlockScanClient(() => {});
  engine.setBroadcastScanChannels([]);
  await settle();
  assert.equal(detached, 0, "the room closed but a client still reads");
  remove();
  await settle();
  assert.equal(detached, 1, "both gone: unsubscribed");
  const removeAgain = engine.addBlockScanClient(() => {});
  engine.setBroadcastScanChannels(["general"]);
  await settle();
  removeAgain();
  await settle();
  assert.equal(detached, 1, "the client left while a room still reads");
  engine.setBroadcastScanChannels([]);
  await settle();
  assert.equal(detached, 2);
});

await test("a block with no clients and no rooms does nothing; broadcast rows still flow beside clients", async () => {
  const { engine } = makeEngine();
  engine.handleBlockAddedEvent(blockOf([streamTx("nothing", ME.address, toHex("kchat:1:bcast:general:hi"))]));
  engine.blockScanChannels = new Set(["general"]);
  // the room's own sender check isn't under test here, and a real one waits on timers
  engine.broadcastSenderVerifier = {
    outpointAddress: () => "", rememberOutputs() {}, logDropped() {},
    settleHit: (hit) => ({ verdict: BROADCAST_SENDER.VERIFIED, senderAddress: hit.outputAddress }),
  };
  const seen = [];
  const offRows = engine.onBroadcastBlockHits((rows) => seen.push(...rows));
  const client = [];
  const off = engine.addBlockScanClient((block) => client.push(block.transactions.length));
  engine.handleBlockAddedEvent(blockOf([streamTx("nope", ME.address, toHex("kchat:1:bcast:general:hello"))]));
  await settle();
  assert.deepEqual(client, [1], "the client read the block");
  assert.deepEqual(seen.map((row) => row.content), ["hello"], "and the room's listeners got theirs");
  off();
  offRows();
});

if (!process.exitCode) console.log(`\n${passed} passed`);
