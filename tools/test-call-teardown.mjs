// node tools/test-call-teardown.mjs - hanging up while a hosted call is still starting leaves
// nothing behind (ui/calls.js startCall / joinAndSignal; iOS CallService's cancellation checks):
// no open microphone, no RTCPeerConnection, no ringback tone, and no invite to a deleted room.
// The Talk client, the browser media APIs and the DOM are stubs; nothing leaves the machine.
import assert from "node:assert/strict";

// --- Browser stubs (before calls.js is loaded) --------------------------------------------------
globalThis.location = { hostname: "localhost" };
const memory = new Map();
globalThis.localStorage = {
  getItem: (key) => (memory.has(key) ? memory.get(key) : null),
  setItem: (key, value) => { memory.set(key, String(value)); },
  removeItem: (key) => { memory.delete(key); },
};
const element = () => new Proxy({
  classList: { add() {}, remove() {}, toggle() {} },
  querySelector: () => element(), addEventListener() {}, append() {}, style: {},
}, { get: (target, key) => (key in target ? target[key] : undefined), set: (target, key, value) => { target[key] = value; return true; } });
globalThis.document = { createElement: () => element(), body: element() };
const intervals = new Set();
globalThis.window = {
  setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 5)),
  clearTimeout: (id) => clearTimeout(id),
  setInterval: (fn, ms) => { const id = setInterval(fn, ms); intervals.add(id); return id; },
  clearInterval: (id) => { intervals.delete(id); clearInterval(id); },
  addEventListener() {},
};
let audioContexts = 0;
class FakeAudioContext {
  constructor() { audioContexts += 1; this.currentTime = 0; this.destination = {}; }
  createGain() { return { gain: { value: 0, setValueAtTime() {} }, connect() {} }; }
  createOscillator() { return { type: "", frequency: { value: 0 }, connect() {}, start() {}, stop() {} }; }
  resume() { return Promise.resolve(); }
  close() {}
}
window.AudioContext = FakeAudioContext;
let peerConnections = 0;
globalThis.RTCPeerConnection = class { constructor() { peerConnections += 1; } close() {} addTrack() {} };
globalThis.MediaStream = class { getTracks() { return []; } addTrack() {} };
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
let media = null;
const stoppedTracks = [];
const fakeStream = () => {
  const track = { kind: "audio", enabled: true, stop() { stoppedTracks.push(this); } };
  return { getTracks: () => [track], getAudioTracks: () => [track], getVideoTracks: () => [] };
};
Object.defineProperty(globalThis, "navigator", {
  value: { mediaDevices: { getUserMedia: () => media.promise } },
  configurable: true,
});

const { NextcloudTalkClient } = await import("../ui/talk.js");
const Calls = await import("../ui/calls.js");

// --- Talk stub ----------------------------------------------------------------------------------
const talk = { deleted: [], left: 0, joinedCalls: 0 };
Object.assign(NextcloudTalkClient.prototype, {
  async createPublicConversation() { return "room1"; },
  async signalingSettings() { return { mode: "internal", iceServers: [] }; },
  async joinConversation() { return "s-me"; },
  async setGuestDisplayName() {},
  async joinCall() { talk.joinedCalls += 1; },
  async leaveCall() {},
  async leaveConversation() { talk.left += 1; },
  async deleteConversation(token) { talk.deleted.push(token); },
  async pullSignaling() { await new Promise((r) => setTimeout(r, 50)); return []; },
  cancelPull() {},
  async sendSignaling() {},
});

const sent = [];
let sendGate = null;
Calls.initCalls({
  accountScopedKey: (key) => key,
  callsEnabledFor: () => true,
  nextcloudAccount: () => ({ server: "https://cloud.test", username: "me", appPassword: "pw" }),
  talkCallsAvailable: async () => true,
  displayNameFor: () => "Peer",
  ownDisplayName: () => "Me",
  showToast: () => {},
  appendEngineLog: () => {},
  sendEnvelope: async (address, text) => { sent.push(JSON.parse(text)); if (sendGate) await sendGate.promise; },
});

const PEER = "kaspa:qppeer00000000000000000000000000000000000000000000000000000";
const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = () => new Promise((r) => setTimeout(r, 30));
async function reset() {
  await settle();
  sent.length = 0; stoppedTracks.length = 0; talk.deleted.length = 0;
  talk.left = 0; talk.joinedCalls = 0; audioContexts = 0; peerConnections = 0; sendGate = null;
}

let pass = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("hanging up while the microphone is asked for: the stream is stopped, no peer connection, no invite", async () => {
  await reset();
  media = deferred();
  const placing = Calls.startCall(PEER, false);
  for (let i = 0; i < 10 && talk.joinedCalls === 0; i += 1) await tick();
  assert.equal(talk.joinedCalls, 1, "reached the media request");
  await Calls.hangUp();
  media.resolve(fakeStream()); // the browser answers after the hang-up
  await placing;
  await settle();
  assert.equal(stoppedTracks.length, 1, "the late microphone stream is stopped");
  assert.equal(peerConnections, 0, "no RTCPeerConnection for an ended call");
  assert.equal(sent.filter((m) => m.type === "call_invite").length, 0, "no invite to the deleted room");
  assert.equal(sent.filter((m) => m.type === "call_end").length, 0, "nothing opened on chain, nothing to close");
  assert.ok(talk.deleted.includes("room1"), "the room is deleted");
  assert.equal(audioContexts, 0, "no ringback started");
  assert.equal(Calls.hasActiveCall(), false);
});

test("hanging up while the invite is being sent: the close follows it and no ringback starts", async () => {
  await reset();
  media = deferred();
  media.resolve(fakeStream());
  sendGate = deferred();
  const placing = Calls.startCall(PEER, false);
  for (let i = 0; i < 20 && !sent.length; i += 1) await tick();
  assert.equal(sent[0]?.type, "call_invite", "the invite is on its way");
  await Calls.hangUp();
  sendGate.resolve();
  await placing;
  await settle();
  assert.deepEqual(sent.map((m) => m.type), ["call_invite", "call_end"], "the other side is told it ended");
  assert.equal(sent[1].reason, "cancelled");
  assert.equal(audioContexts, 0, "no ringback for an ended call");
  assert.ok(stoppedTracks.length >= 1, "the call's microphone was released");
  assert.equal(Calls.hasActiveCall(), false);
});

test("an uninterrupted call still rings out with one invite", async () => {
  await reset();
  media = deferred();
  media.resolve(fakeStream());
  await Calls.startCall(PEER, false);
  assert.deepEqual(sent.map((m) => m.type), ["call_invite"]);
  assert.equal(peerConnections, 1);
  assert.equal(audioContexts, 1, "ringback playing");
  await Calls.hangUp();
  await settle();
  assert.deepEqual(sent.map((m) => m.type), ["call_invite", "call_end"]);
  assert.equal(intervals.size, 0, "the ringback interval is cleared");
});

for (const [name, fn] of tests) {
  try { await fn(); pass += 1; }
  catch (error) { console.error(`FAIL ${name}\n  ${error?.stack || error}`); process.exitCode = 1; }
}
for (const id of intervals) clearInterval(id);
console.log(`call teardown: ${pass}/${tests.length} passed`);
process.exit(process.exitCode || 0);
