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
  // Short waits run at once; the ring / join / offer timeouts (10 s and up) keep their length, so
  // a call can be driven to "connected" before it rings out.
  setTimeout: (fn, ms) => setTimeout(fn, ms >= 10_000 ? ms : Math.min(ms, 5)),
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
const pcs = [];
globalThis.RTCPeerConnection = class {
  constructor() { peerConnections += 1; pcs.push(this); this.connectionState = "new"; this.remoteDescription = null; }
  close() { this.closed = true; }
  addTrack() { if (this.closed) throw new Error("closed"); }
  async createOffer() { return { type: "offer", sdp: "v=0" }; }
  async setLocalDescription() {}
};
globalThis.MediaStream = class { getTracks() { return []; } addTrack() {} };
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
let media = null;
const stoppedTracks = [];
const fakeStream = () => {
  const tracks = [{ kind: "audio", enabled: true, stop() { stoppedTracks.push(this); } }];
  return {
    getTracks: () => [...tracks], getAudioTracks: () => tracks.filter((t) => t.kind === "audio"),
    getVideoTracks: () => tracks.filter((t) => t.kind === "video"), addTrack: (t) => { tracks.push(t); },
  };
};
const fakeCamera = () => {
  const track = { kind: "video", enabled: true, stop() { stoppedTracks.push(this); } };
  return { getTracks: () => [track], getVideoTracks: () => [track], getAudioTracks: () => [] };
};
Object.defineProperty(globalThis, "navigator", {
  value: { mediaDevices: { getUserMedia: () => media.promise } },
  configurable: true,
});

const { NextcloudTalkClient } = await import("../ui/talk.js");
const Calls = await import("../ui/calls.js");

// --- Talk stub ----------------------------------------------------------------------------------
const talk = { deleted: [], left: 0, joinedCalls: 0, events: [], signals: [] };
Object.assign(NextcloudTalkClient.prototype, {
  async createPublicConversation() { return "room1"; },
  async signalingSettings() { return { mode: "internal", iceServers: [] }; },
  async joinConversation() { talk.current = this; return "s-me"; },
  async setGuestDisplayName() {},
  async joinCall() { talk.joinedCalls += 1; },
  async leaveCall() {},
  async leaveConversation() { talk.left += 1; },
  async deleteConversation(token) { talk.deleted.push(token); },
  // Events go to the live call's client only (an ended call's loop may still be mid-poll).
  async pullSignaling() { await new Promise((r) => setTimeout(r, talk.events.length ? 1 : 20)); return talk.current === this ? talk.events.splice(0) : []; },
  cancelPull() {},
  async sendSignaling(token, sessionId, messages) { for (const m of messages) talk.signals.push(m.type); },
});

const sent = [];
const toasts = [];
let sendGate = null;
Calls.initCalls({
  accountScopedKey: (key) => key,
  callsEnabledFor: () => true,
  nextcloudAccount: () => ({ server: "https://cloud.test", username: "me", appPassword: "pw" }),
  talkCallsAvailable: async () => true,
  displayNameFor: () => "Peer",
  ownDisplayName: () => "Me",
  showToast: (text) => { toasts.push(String(text)); },
  appendEngineLog: (text) => { toasts.push(String(text)); },
  sendEnvelope: async (address, text) => { sent.push(JSON.parse(text)); if (sendGate) await sendGate.promise; },
});

const PEER = "kaspa:qppeer00000000000000000000000000000000000000000000000000000";
const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = () => new Promise((r) => setTimeout(r, 30));
async function reset() {
  await settle();
  sent.length = 0; stoppedTracks.length = 0; talk.deleted.length = 0;
  talk.left = 0; talk.joinedCalls = 0; talk.events.length = 0; audioContexts = 0; peerConnections = 0; pcs.length = 0; sendGate = null;
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

test("the call ends while the browser asks for the camera (switch to video): the camera is stopped", async () => {
  await reset();
  media = deferred();
  media.resolve(fakeStream());
  await Calls.startCall(PEER, false);
  // The peer joins (its session id sorts lower, so this side offers) and the media connects.
  talk.events.push({ kind: "usersInRoom", users: [{ sessionId: "s-a", inCall: 7 }] });
  for (let i = 0; i < 10 && talk.events.length; i += 1) await settle();
  await settle();
  pcs[0].connectionState = "connected";
  pcs[0].onconnectionstatechange();
  let cameraAsked = 0;
  media = deferred(); // the camera prompt stays up
  const prompt = media.promise;
  media = { promise: { then: (...args) => { cameraAsked += 1; return prompt.then(...args); } }, resolve: media.resolve };
  await Calls.toggleCamera(); // asks the other side first
  talk.events.push({ kind: "message", data: { from: "s-a", type: "kachat_video_accept" } });
  for (let i = 0; i < 10 && !cameraAsked; i += 1) await settle();
  assert.deepEqual(talk.signals, ["offer", "kachat_video_request"], "offered, then asked for video");
  assert.equal(cameraAsked, 1, "the camera was asked for");
  await Calls.hangUp();
  const camera = fakeCamera();
  media.resolve(camera); // the browser answers after the hang-up
  await settle();
  assert.ok(stoppedTracks.includes(camera.getTracks()[0]), "the late camera track is stopped");
  assert.equal(Calls.hasActiveCall(), false);
});

test("an account switch ends the call without a call_end signed by the new account", async () => {
  await reset();
  media = deferred();
  media.resolve(fakeStream());
  await Calls.startCall(PEER, false);
  assert.deepEqual(sent.map((m) => m.type), ["call_invite"]);
  Calls.resetCallsForAccount();
  await settle();
  assert.deepEqual(sent.map((m) => m.type), ["call_invite"], "no call_end after the switch");
  assert.ok(stoppedTracks.length >= 1, "the microphone is released");
  assert.ok(talk.deleted.includes("room1"), "the room is still cleaned up");
  assert.equal(intervals.size, 0, "no ringback left");
});

for (const [name, fn] of tests) {
  try { await fn(); pass += 1; }
  catch (error) { console.error(`FAIL ${name}\n  ${error?.stack || error}`); process.exitCode = 1; }
}
for (const id of intervals) clearInterval(id);
console.log(`call teardown: ${pass}/${tests.length} passed`);
process.exit(process.exitCode || 0);
