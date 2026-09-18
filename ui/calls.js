// Voice and video calls in 1:1 chats, over Nextcloud Talk, entirely inside the app (port of the
// iOS CallService, 5fdc8f4 and the commits after it).
//
// Calls need a Nextcloud on ONE side only. The caller's Nextcloud (Talk with calls enabled)
// hosts a throwaway public Talk conversation; the contact joins it as a Talk guest on that
// server, so they need nothing but KaChat. The media is one WebRTC peer connection between the
// two, negotiated over Talk's internal signaling API with the server's own STUN/TURN; nothing
// runs through any KaChat server.
//
// Ringing rides the chat itself: call_invite / call_request / call_end are ordinary encrypted
// 1:1 messages sharing a callId, rendered as call-history lines ("Voice call started", "Missed
// call", "Call · 4:12"). The caller is the only side that ever writes to the chain, at most
// twice: one opening message and one closing message. The callee answers, declines and hangs up
// through the Talk room itself (joining it, a kachat_decline signaling message, or leaving it).
//
// A call rings for 30 s on the callee; the caller gives up after 35 s; an invite is answerable
// for 45 s after its block time. Every call id this device has rung, placed, answered or seen
// end is remembered (persisted, bounded) so a re-ingested invite never rings twice.

import { NextcloudTalkClient, TalkError } from "./talk.js";

const RING_TIMEOUT_MS = 35_000;
const INCOMING_RING_TIMEOUT_MS = 30_000;
const INVITE_FRESHNESS_MS = 45_000;
const OFFER_FALLBACK_MS = 10_000;
const HANDLED_KEY = "kachat-calls-handled-v1";
const HANDLED_CAP = 200;

let deps = null;
let session = null;
let overlay = null;
let ui = null;
let statusTicker = null;
let handledCallIds = [];
let tone = null;

// ---------------------------------------------------------------------------------------------
// Envelopes
// ---------------------------------------------------------------------------------------------

const CALL_TYPES = new Set(["call_invite", "call_request", "call_response", "call_end"]);
const parseCache = new Map();

/** {type, callId, server?, token?, video?, viaRequest?, accepted?, reason?, durationSeconds?} or null. */
export function parseCallEnvelope(text) {
  const value = String(text || "");
  if (value.length > 4096) return null;
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") || !trimmed.includes("\"call_")) return null;
  if (parseCache.has(trimmed)) return parseCache.get(trimmed);
  let result = null;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && CALL_TYPES.has(parsed.type) && typeof parsed.callId === "string" && parsed.callId) {
      result = {
        type: parsed.type,
        callId: String(parsed.callId).toLowerCase(),
        server: typeof parsed.server === "string" ? parsed.server : "",
        token: typeof parsed.token === "string" ? parsed.token : "",
        video: parsed.video === true,
        viaRequest: parsed.viaRequest === true,
        accepted: parsed.accepted === true,
        reason: typeof parsed.reason === "string" ? parsed.reason : null,
        durationSeconds: Number.isFinite(Number(parsed.durationSeconds)) ? Number(parsed.durationSeconds) : null,
      };
    }
  } catch { result = null; }
  if (parseCache.size > 1024) parseCache.clear();
  parseCache.set(trimmed, result);
  return result;
}

function encodeInvite({ callId, server, token, video, viaRequest = false }) {
  const body = { type: "call_invite", callId, server, token, video };
  if (viaRequest) body.viaRequest = true;
  return JSON.stringify(body);
}
function encodeRequest({ callId, video }) { return JSON.stringify({ type: "call_request", callId, video }); }
function encodeEnd({ callId, reason, durationSeconds }) {
  const body = { type: "call_end", callId, reason };
  if (durationSeconds != null) body.durationSeconds = durationSeconds;
  return JSON.stringify(body);
}

function formatDuration(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** The call-history line a bubble shows (iOS MessageBubbleView.callBubble): icon + text. */
export function callHistoryLine(envelope, outgoing) {
  const kind = envelope.video ? "Video call" : "Voice call";
  switch (envelope.type) {
    case "call_request":
      return { icon: envelope.video ? "video" : "phone", text: outgoing ? `${kind} started` : `Incoming ${kind.toLowerCase()}` };
    case "call_invite":
      if (envelope.viaRequest) return { icon: envelope.video ? "video" : "phone", text: `${kind} ready` };
      return { icon: envelope.video ? "video" : "phone", text: outgoing ? `${kind} started` : `Incoming ${kind.toLowerCase()}` };
    case "call_response":
      if (envelope.reason === "no_host") return { icon: "phone-down", text: "Calls need Nextcloud Talk" };
      return { icon: envelope.accepted ? "phone" : "phone-down", text: envelope.accepted ? "Call answered" : "Call declined" };
    case "call_end": {
      if (envelope.durationSeconds != null && envelope.durationSeconds > 0) return { icon: "phone", text: `Call · ${formatDuration(envelope.durationSeconds)}` };
      switch (envelope.reason) {
        case "no_answer": return { icon: "phone-down", text: outgoing ? "No answer" : "Missed call" };
        case "cancelled": return { icon: "phone-down", text: outgoing ? "Call cancelled" : "Missed call" };
        case "declined": return { icon: "phone-down", text: "Call declined" };
        case "no_host": return { icon: "phone-down", text: "Calls need Nextcloud Talk" };
        case "failed": return { icon: "phone-down", text: "Call failed" };
        case "missed": return { icon: "phone-down", text: "Missed call" };
        default: return { icon: "phone", text: "Call ended" };
      }
    }
    default:
      return { icon: "phone", text: "Call" };
  }
}

/** The chat list's one-line preview (iOS ChatListView). */
export function callPreviewText(envelope, outgoing) {
  switch (envelope.type) {
    case "call_request":
    case "call_invite":
      return envelope.video ? "📹 Video call" : "📞 Voice call";
    case "call_response":
      return envelope.reason === "no_host" ? "📞 Calls need Nextcloud Talk" : (envelope.accepted ? "📞 Call answered" : "📞 Call declined");
    case "call_end":
      if (envelope.durationSeconds != null && envelope.durationSeconds > 0) return `📞 Call · ${formatDuration(envelope.durationSeconds)}`;
      switch (envelope.reason) {
        case "no_answer": case "cancelled": case "missed": return "📞 Missed call";
        case "declined": return "📞 Call declined";
        case "no_host": return "📞 Calls need Nextcloud Talk";
        case "failed": return "📞 Call failed";
        default: return "📞 Call ended";
      }
    default:
      return outgoing ? "📞 Call" : "📞 Call";
  }
}

// ---------------------------------------------------------------------------------------------
// Handled call ids (persisted, bounded)
// ---------------------------------------------------------------------------------------------

function loadHandled() {
  try { handledCallIds = JSON.parse(localStorage.getItem(deps.accountScopedKey(HANDLED_KEY)) || "[]") || []; }
  catch { handledCallIds = []; }
  if (!Array.isArray(handledCallIds)) handledCallIds = [];
}
function isHandled(callId) { return handledCallIds.includes(callId); }
function markHandled(callId) {
  if (!callId || isHandled(callId)) return;
  handledCallIds.push(callId);
  if (handledCallIds.length > HANDLED_CAP) handledCallIds = handledCallIds.slice(-HANDLED_CAP);
  try { localStorage.setItem(deps.accountScopedKey(HANDLED_KEY), JSON.stringify(handledCallIds)); } catch { /* fine */ }
}

// ---------------------------------------------------------------------------------------------
// Tones (ringback for the caller, ringtone for the callee), WebAudio, no assets
// ---------------------------------------------------------------------------------------------

function startTone(kind) {
  stopTone();
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return;
  let ctx;
  try { ctx = new Ctx(); } catch { return; }
  const gain = ctx.createGain();
  gain.gain.value = 0;
  gain.connect(ctx.destination);
  const osc = ctx.createOscillator();
  osc.type = "sine";
  osc.frequency.value = kind === "ringback" ? 440 : 660;
  osc.connect(gain);
  osc.start();
  // Ringback: 1s on, 3s off. Ringtone: two short bursts every 2.4s.
  const pattern = kind === "ringback" ? [[0, 1000]] : [[0, 220], [340, 220]];
  const period = kind === "ringback" ? 4000 : 2400;
  const beat = () => {
    const now = ctx.currentTime;
    for (const [offset, length] of pattern) {
      gain.gain.setValueAtTime(0.18, now + offset / 1000);
      gain.gain.setValueAtTime(0, now + (offset + length) / 1000);
    }
  };
  beat();
  const timer = window.setInterval(beat, period);
  tone = { ctx, osc, timer };
  ctx.resume?.().catch?.(() => {});
}
function stopTone() {
  if (!tone) return;
  const { ctx, osc, timer } = tone;
  tone = null;
  window.clearInterval(timer);
  try { osc.stop(); } catch { /* already */ }
  try { ctx.close(); } catch { /* already */ }
}

// ---------------------------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------------------------

export function initCalls(dependencies) {
  deps = dependencies;
  loadHandled();
  window.addEventListener("pagehide", () => { if (session) { try { hangUpQuietly(); } catch { /* leaving */ } } });
}

export function resetCallsForAccount() {
  if (session) finish("cancelled").catch(() => {});
  loadHandled();
}

export function hasActiveCall() { return Boolean(session); }

export function contactCanBeCalled(address) { return deps?.callsEnabledFor?.(address) === true; }

/** The chat header's call button: enable calls for the contact if they are off, then choose
 *  voice or video (iOS ChatDetailView, b67fa61 and 12343f3). */
export async function requestCallFromHeader(address) {
  if (!deps || !address) return;
  if (session) { deps.showToast?.("You are already on a call."); return; }
  const name = deps.displayNameFor(address);
  if (!deps.callsEnabledFor(address)) {
    const choice = await deps.chooseDialog({
      title: `Enable calls and video calls with ${name}?`,
      message: "Calls go over Nextcloud Talk. One of you needs a Nextcloud with Talk; the other joins as a guest.",
      options: [
        { id: "enable", title: "Enable", subtitle: `Lets ${name} ring you, and lets you call them.` },
        { id: "later", title: "Not now", subtitle: "Calls stay off for this contact." },
      ],
    });
    if (choice !== "enable") return;
    deps.setCallsEnabled(address, true);
  }
  const kind = await deps.chooseDialog({
    title: `Call ${name}`,
    options: [
      { id: "voice", title: "Voice call", subtitle: "Audio only." },
      { id: "video", title: "Video call", subtitle: "Camera and audio." },
    ],
  });
  if (kind !== "voice" && kind !== "video") return;
  await startCall(address, kind === "video");
}

/** Places a call. This device hosts the room when its Nextcloud can; otherwise it asks the
 *  contact to host (call_request) and joins their room as a guest. */
export async function startCall(address, video) {
  if (!deps || session) return;
  if (!deps.callsEnabledFor(address)) return;
  const callId = (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`).toLowerCase();
  const account = deps.nextcloudAccount();
  const canHost = account ? await deps.talkCallsAvailable() : false;
  const call = newSession({ id: callId, address, isOutgoing: true, hostsThisCall: Boolean(canHost), server: canHost ? account.server : "", token: "", video, phase: "ringingOut" });
  session = call;
  markHandled(callId);
  showOverlay(call);
  if (!canHost) {
    // No Nextcloud here: ask the contact to host. Their KaChat opens the room and rings (if
    // their "Allow calls" switch is on for us) and answers with an invite this call joins.
    try {
      await deps.sendEnvelope(address, encodeRequest({ callId, video }));
      call.openingMessageSent = true;
      startTone("ringback");
      call.timeout = window.setTimeout(() => { if (session === call && call.phase === "ringingOut") finish("no_answer"); }, RING_TIMEOUT_MS);
    } catch (error) {
      deps.showToast?.(`Could not start the call: ${error?.message || error}`);
      await finish("failed");
    }
    return;
  }
  const client = new NextcloudTalkClient({ server: account.server, auth: { kind: "basic", username: account.username, appPassword: account.appPassword } });
  call.client = client;
  try {
    const token = await client.createPublicConversation(`KaChat call with ${deps.displayNameFor(address)}`);
    if (session !== call) { await client.deleteConversation(token); return; }
    call.token = token;
    await joinAndSignal(call);
    await deps.sendEnvelope(address, encodeInvite({ callId, server: account.server, token, video }));
    call.openingMessageSent = true;
    startTone("ringback");
    call.timeout = window.setTimeout(() => { if (session === call && call.phase === "ringingOut") finish("no_answer"); }, RING_TIMEOUT_MS);
  } catch (error) {
    deps.appendEngineLog?.(`[Call] Starting call failed: ${error?.message || error}`);
    deps.showToast?.(`Could not start the call: ${error?.message || error}`);
    await finish("failed");
  }
}

/** Driven by the chat's ingest of an incoming message that parsed as a call envelope. */
export function handleIncomingCallEnvelope(envelope, message, contactAddress) {
  if (!deps || !envelope || message?.direction === "outgoing") return;
  const age = Date.now() - Number(message?.createdAt || 0);
  switch (envelope.type) {
    case "call_request": {
      // The contact has no Nextcloud and asks us to host their call. Only if their "Allow
      // calls" switch is on and this device can host; otherwise it stays quiet and their
      // phone rings out to "no answer".
      if (isHandled(envelope.callId)) return;
      if (!deps.callsEnabledFor(contactAddress) || age >= INVITE_FRESHNESS_MS) return;
      if (session) return;
      deps.talkCallsAvailable().then((canHost) => {
        if (!canHost || session || isHandled(envelope.callId)) { markHandled(envelope.callId); return; }
        markHandled(envelope.callId);
        hostRequestedCall(envelope.callId, contactAddress, envelope.video);
      }).catch(() => markHandled(envelope.callId));
      return;
    }
    case "call_invite": {
      let server = "";
      try { const parsed = new URL(envelope.server); if (parsed.protocol === "https:") server = parsed.origin; } catch { server = ""; }
      if (!server) return;
      // The contact hosting the call WE asked for: this invite answers our request, so join it
      // straight away as a guest - their phone is the one ringing.
      if (session && session.isOutgoing && !session.hostsThisCall && session.id === envelope.callId && session.phase === "ringingOut") {
        const call = session;
        call.server = server;
        call.token = envelope.token;
        setPhase(call, "connecting");
        window.clearTimeout(call.timeout);
        stopTone();
        call.client = new NextcloudTalkClient({ server, auth: { kind: "guest" } });
        joinAndSignal(call).catch(async (error) => {
          deps.appendEngineLog?.(`[Call] Joining the hosted call failed: ${error?.message || error}`);
          deps.showToast?.(`Could not join the call: ${error?.message || error}`);
          await finish("failed");
        });
        return;
      }
      if (isHandled(envelope.callId)) return;
      if (!deps.callsEnabledFor(contactAddress)) return;
      if (age >= INVITE_FRESHNESS_MS) return;
      if (session) return; // busy: silent, the caller rings out
      markHandled(envelope.callId);
      const call = newSession({ id: envelope.callId, address: contactAddress, isOutgoing: false, hostsThisCall: false, server, token: envelope.token, video: envelope.video, phase: "ringingIn" });
      ringIncoming(call);
      return;
    }
    case "call_response": {
      markHandled(envelope.callId);
      if (!session || session.id !== envelope.callId || !session.isOutgoing) return;
      if (envelope.accepted) { if (session.phase === "ringingOut") setPhase(session, "connecting"); }
      else finish(envelope.reason === "no_host" ? "no_host" : "declined");
      return;
    }
    case "call_end": {
      markHandled(envelope.callId);
      if (!session || session.id !== envelope.callId) return;
      finish(session.phase === "ringingIn" ? "missed" : "remote_hangup");
      return;
    }
    default:
  }
}

// ---------------------------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------------------------

function newSession(fields) {
  return {
    ...fields,
    client: null, mySessionId: "", mySid: Math.random().toString(36).slice(2, 10), peerSessionId: "", peerSid: "",
    pc: null, localStream: null, remoteStream: null, connectedAt: null, timeout: null, offerFallback: null,
    pulling: false, pendingCandidates: [], openingMessageSent: false, sawPeerInCall: false,
    muted: false, cameraOff: false, statusDetail: "", endedReason: null,
  };
}

function setPhase(call, phase) {
  call.phase = phase;
  renderOverlay();
}

function ringIncoming(call) {
  session = call;
  showOverlay(call);
  startTone("ringtone");
  call.timeout = window.setTimeout(() => { if (session === call && call.phase === "ringingIn") finish("missed"); }, INCOMING_RING_TIMEOUT_MS);
  const name = deps.displayNameFor(call.address);
  deps.notify?.({ title: `Incoming ${call.video ? "video" : "voice"} call`, body: name, route: { kind: "chat", address: call.address } });
}

/** Hosts a call the contact asked for: rings, and opens the room meanwhile so the requester
 *  can be waiting in it as a guest by the time we accept. */
async function hostRequestedCall(callId, address, video) {
  const account = deps.nextcloudAccount();
  if (!account) return;
  const call = newSession({ id: callId, address, isOutgoing: false, hostsThisCall: true, server: account.server, token: "", video, phase: "ringingIn" });
  ringIncoming(call);
  const client = new NextcloudTalkClient({ server: account.server, auth: { kind: "basic", username: account.username, appPassword: account.appPassword } });
  call.client = client;
  try {
    const token = await client.createPublicConversation(`KaChat call with ${deps.displayNameFor(address)}`);
    if (session !== call) { await client.deleteConversation(token); return; }
    call.token = token;
    // The one message a non-caller ever sends: the requester cannot learn the room otherwise.
    await deps.sendEnvelope(address, encodeInvite({ callId, server: account.server, token, video, viaRequest: true }));
  } catch (error) {
    deps.appendEngineLog?.(`[Call] Hosting a requested call failed: ${error?.message || error}`);
    deps.showToast?.(`Could not host the call: ${error?.message || error}`);
    await finish("failed");
  }
}

export async function acceptIncoming() {
  const call = session;
  if (!call || call.phase !== "ringingIn") return;
  stopTone();
  window.clearTimeout(call.timeout);
  setPhase(call, "connecting");
  // The room may still be on its way (a call we host opens it while ringing).
  let waited = 0;
  while (!call.token && waited < 150 && session === call) { await sleep(100); waited += 1; }
  if (session !== call) return;
  if (!call.token) { await finish("failed"); return; }
  if (!call.hostsThisCall) call.client = new NextcloudTalkClient({ server: call.server, auth: { kind: "guest" } });
  if (!call.client) { await finish("failed"); return; }
  try {
    await joinAndSignal(call);
  } catch (error) {
    deps.appendEngineLog?.(`[Call] Joining call failed: ${error?.message || error}`);
    deps.showToast?.(`Could not join the call: ${error?.message || error}`);
    await finish("failed");
  }
}

export async function declineIncoming() {
  const call = session;
  if (!call || call.phase !== "ringingIn") return;
  stopTone();
  if (!call.hostsThisCall && call.server && call.token) {
    // Tell the caller through Talk, not the chain: join their room as a guest, hand their
    // session one kachat_decline, and leave. Best effort.
    const { server, token } = call;
    (async () => {
      const client = new NextcloudTalkClient({ server, auth: { kind: "guest" } });
      try {
        const sessionId = await client.joinConversation(token);
        const events = await client.pullSignaling(token);
        for (const event of events) {
          if (event.kind !== "usersInRoom") continue;
          const messages = event.users.filter((u) => u.sessionId && u.sessionId !== sessionId)
            .map((u) => ({ to: u.sessionId, sid: "decline", roomType: "video", type: "kachat_decline", payload: {} }));
          if (messages.length) await client.sendSignaling(token, sessionId, messages);
        }
        await client.leaveConversation(token);
      } catch { /* the caller simply rings out */ }
    })();
  }
  await finish("declined");
}

export async function hangUp() {
  const call = session;
  if (!call || call.phase === "ended") return;
  if (call.phase === "ringingIn") { await declineIncoming(); return; }
  if (call.phase === "ringingOut") { await finish("cancelled"); return; }
  await finish("hangup");
}

function hangUpQuietly() {
  const call = session;
  if (!call || !call.client || !call.token) return;
  const { client, token, hostsThisCall } = call;
  client.leaveCall(token).then(() => client.leaveConversation(token)).then(() => { if (hostsThisCall) return client.deleteConversation(token); }).catch(() => {});
}

export function toggleMute() {
  const call = session;
  if (!call) return;
  call.muted = !call.muted;
  for (const track of call.localStream?.getAudioTracks?.() || []) track.enabled = !call.muted;
  renderOverlay();
}

export async function toggleCamera() {
  const call = session;
  if (!call || !call.pc) return;
  if (!call.video) { await upgradeToVideo(); return; }
  call.cameraOff = !call.cameraOff;
  for (const track of call.localStream?.getVideoTracks?.() || []) track.enabled = !call.cameraOff;
  renderOverlay();
}

/** A voice call becomes a video call: the camera joins the connection and a fresh offer carries
 *  it; the other side is told first (kachat_video_upgrade) so its answer carries its camera. */
async function upgradeToVideo() {
  const call = session;
  if (!call || !call.pc || call.video) return;
  try {
    const camera = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" }, audio: false });
    const track = camera.getVideoTracks()[0];
    if (!track) return;
    call.localStream?.addTrack(track);
    call.pc.addTrack(track, call.localStream);
    call.video = true;
    call.cameraOff = false;
    if (ui?.local) { ui.local.srcObject = call.localStream; ui.local.hidden = false; }
    if (call.peerSessionId) {
      sendPeer(call, "kachat_video_upgrade", {});
      await sendOffer(call);
    }
    call.client?.updateCallFlags(call.token, true);
    renderOverlay();
  } catch (error) {
    deps.showToast?.(`Camera unavailable: ${error?.message || error}`);
  }
}

// ---------------------------------------------------------------------------------------------
// Talk + WebRTC
// ---------------------------------------------------------------------------------------------

async function joinAndSignal(call) {
  const client = call.client;
  if (!client) return;
  const settings = await client.signalingSettings(call.token);
  if (String(settings.mode).toLowerCase() === "external") {
    throw new TalkError("external", "This Nextcloud uses an external signaling server, which KaChat calls do not support yet.");
  }
  const sessionId = await client.joinConversation(call.token);
  call.mySessionId = sessionId;
  if (client.auth?.kind === "guest") await client.setGuestDisplayName(call.token, deps.ownDisplayName());
  await client.joinCall(call.token, call.video);

  // Media first, so the peer connection carries our tracks from the first offer.
  try {
    call.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: call.video ? { facingMode: "user" } : false });
  } catch (error) {
    if (call.video) {
      // No camera: carry on as a voice call rather than failing the call.
      call.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      call.video = false;
      deps.showToast?.("No camera available; continuing as a voice call.");
    } else {
      throw new Error(`Microphone unavailable: ${error?.message || error}`);
    }
  }
  const pc = new RTCPeerConnection({ iceServers: settings.iceServers });
  call.pc = pc;
  call.remoteStream = new MediaStream();
  for (const track of call.localStream.getTracks()) pc.addTrack(track, call.localStream);
  pc.onicecandidate = (event) => {
    if (!event.candidate) return;
    sendPeer(call, "candidate", { candidate: { candidate: event.candidate.candidate, sdpMid: event.candidate.sdpMid || "", sdpMLineIndex: event.candidate.sdpMLineIndex ?? 0 } });
  };
  pc.ontrack = (event) => {
    for (const track of event.streams?.[0]?.getTracks?.() || [event.track]) {
      if (!call.remoteStream.getTracks().includes(track)) call.remoteStream.addTrack(track);
    }
    if (ui?.remote && ui.remote.srcObject !== call.remoteStream) ui.remote.srcObject = call.remoteStream;
    ui?.remote?.play?.().catch?.(() => {});
    renderOverlay();
  };
  pc.onconnectionstatechange = () => {
    if (session !== call) return;
    switch (pc.connectionState) {
      case "connected":
        if (!call.connectedAt) call.connectedAt = Date.now();
        call.statusDetail = "";
        setPhase(call, "connected");
        break;
      case "disconnected":
        call.statusDetail = "Reconnecting";
        renderOverlay();
        break;
      case "failed":
        finish("failed");
        break;
      default:
    }
  };
  if (ui?.local) { ui.local.srcObject = call.localStream; ui.local.hidden = !call.video; }
  renderOverlay();
  pullLoop(call);
}

async function pullLoop(call) {
  const client = call.client;
  if (!client || call.pulling) return;
  call.pulling = true;
  while (session === call && call.phase !== "ended") {
    try {
      const events = await client.pullSignaling(call.token);
      if (session !== call || call.phase === "ended") return;
      for (const event of events) await handleSignaling(event, call);
    } catch (error) {
      if (session !== call || call.phase === "ended") return;
      if (error?.name === "AbortError") return;
      if (error instanceof TalkError && (error.code === "conversationGone" || error.code === "sessionLost")) {
        deps.appendEngineLog?.(`[Call] Signaling ended: ${error.message}`);
        const declined = !call.hostsThisCall && !call.connectedAt;
        await finish(declined ? "declined" : "remote_hangup");
        return;
      }
      await sleep(3000);
    }
  }
}

async function handleSignaling(event, call) {
  if (event.kind === "usersInRoom") {
    const mine = call.mySessionId;
    const others = event.users.filter((u) => u.sessionId !== mine && u.inCall !== 0);
    if (!call.peerSessionId && others.length) {
      const peer = others[0];
      call.peerSessionId = peer.sessionId;
      call.sawPeerInCall = true;
      if (call.phase === "ringingOut" || call.phase === "ringingIn") { stopTone(); setPhase(call, "connecting"); }
      window.clearTimeout(call.timeout);
      // "Larger session ids call smaller ones" - the Talk web client's tie-break, so exactly
      // one side offers. The other side still offers itself if nothing arrives in ten seconds.
      if (peer.sessionId < mine) await sendOffer(call);
      else call.offerFallback = window.setTimeout(() => { if (session === call && call.pc && !call.pc.remoteDescription) sendOffer(call); }, OFFER_FALLBACK_MS);
    } else if (call.peerSessionId && call.sawPeerInCall && !others.some((u) => u.sessionId === call.peerSessionId)) {
      // The other side left the call (hung up, or their app died).
      await finish("remote_hangup");
    }
    return;
  }
  const data = event.data || {};
  const from = String(data.from || "");
  const type = String(data.type || "");
  if (!from || !type) return;
  if (type === "kachat_decline") {
    if (call.isOutgoing && !call.connectedAt) await finish("declined");
    return;
  }
  if (type === "kachat_video_upgrade") {
    if (!call.video && call.pc) {
      try {
        const camera = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" }, audio: false });
        const track = camera.getVideoTracks()[0];
        if (track) {
          call.localStream?.addTrack(track);
          call.pc.addTrack(track, call.localStream);
          call.video = true;
          call.cameraOff = false;
          if (ui?.local) { ui.local.srcObject = call.localStream; ui.local.hidden = false; }
          call.client?.updateCallFlags(call.token, true);
        }
      } catch { /* answer without a camera */ }
      renderOverlay();
    }
    return;
  }
  if (!call.peerSessionId) call.peerSessionId = from;
  if (from !== call.peerSessionId || !call.pc) return;
  const payload = data.payload && typeof data.payload === "object" ? data.payload : {};
  const pc = call.pc;
  switch (type) {
    case "offer": {
      call.peerSid = String(data.sid || "");
      window.clearTimeout(call.offerFallback);
      if (!payload.sdp) return;
      try {
        await pc.setRemoteDescription({ type: "offer", sdp: payload.sdp });
        await flushCandidates(call);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        sendPeer(call, "answer", { type: "answer", sdp: answer.sdp, nick: deps.ownDisplayName() });
      } catch (error) {
        deps.appendEngineLog?.(`[Call] Answering offer failed: ${error?.message || error}`);
      }
      return;
    }
    case "answer": {
      if (!payload.sdp) return;
      try {
        await pc.setRemoteDescription({ type: "answer", sdp: payload.sdp });
        await flushCandidates(call);
      } catch (error) {
        deps.appendEngineLog?.(`[Call] Applying answer failed: ${error?.message || error}`);
      }
      return;
    }
    case "candidate": {
      const inner = payload.candidate && typeof payload.candidate === "object" ? payload.candidate : null;
      if (!inner?.candidate) return;
      const candidate = { candidate: inner.candidate, sdpMid: inner.sdpMid ?? null, sdpMLineIndex: Number(inner.sdpMLineIndex) || 0 };
      if (pc.remoteDescription) { try { await pc.addIceCandidate(candidate); } catch { /* stale */ } }
      else call.pendingCandidates.push(candidate);
      return;
    }
    default:
  }
}

async function sendOffer(call) {
  const pc = call.pc;
  if (!pc) return;
  try {
    const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
    await pc.setLocalDescription(offer);
    sendPeer(call, "offer", { type: "offer", sdp: offer.sdp, nick: deps.ownDisplayName() });
  } catch (error) {
    deps.appendEngineLog?.(`[Call] Creating offer failed: ${error?.message || error}`);
  }
}

async function flushCandidates(call) {
  const queued = call.pendingCandidates;
  call.pendingCandidates = [];
  for (const candidate of queued) { try { await call.pc.addIceCandidate(candidate); } catch { /* stale */ } }
}

function sendPeer(call, type, payload) {
  const client = call.client;
  if (!client || !call.mySessionId || !call.peerSessionId) return;
  const message = { to: call.peerSessionId, sid: call.peerSid || call.mySid, roomType: "video", type, payload };
  client.sendSignaling(call.token, call.mySessionId, [message]).catch((error) => {
    deps.appendEngineLog?.(`[Call] Sending ${type} failed: ${error?.message || error}`);
  });
}

// ---------------------------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------------------------

async function finish(reason) {
  const call = session;
  if (!call || call.phase === "ended") return;
  stopTone();
  window.clearTimeout(call.timeout);
  window.clearTimeout(call.offerFallback);
  call.client?.cancelPull();
  try { call.pc?.close(); } catch { /* fine */ }
  call.pc = null;
  for (const track of call.localStream?.getTracks?.() || []) { try { track.stop(); } catch { /* fine */ } }
  const durationSeconds = call.connectedAt ? Math.floor((Date.now() - call.connectedAt) / 1000) : null;
  call.endedReason = reason;
  call.phase = "ended";
  renderOverlay();
  // The caller is the only side that ever puts a call on chain: one opening message and one
  // closing message with how it went and, if it connected, for how long.
  if (call.isOutgoing && call.openingMessageSent) {
    try { await deps.sendEnvelope(call.address, encodeEnd({ callId: call.id, reason, durationSeconds })); }
    catch (error) { deps.appendEngineLog?.(`[Call] Sending call_end failed: ${error?.message || error}`); }
  }
  if (call.client && call.token) {
    const { client, token, hostsThisCall } = call;
    (async () => {
      await client.leaveCall(token);
      await client.leaveConversation(token);
      if (hostsThisCall) await client.deleteConversation(token);
    })().catch(() => {});
  }
  window.setTimeout(() => {
    if (session === call) { session = null; hideOverlay(); }
  }, 1500);
}

function sleep(ms) { return new Promise((resolve) => window.setTimeout(resolve, ms)); }

// ---------------------------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------------------------

const ICONS = {
  phone: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25 11.4 11.4 0 0 0 3.6.6 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1 11.4 11.4 0 0 0 .6 3.6 1 1 0 0 1-.25 1z"/></svg>',
  "phone-down": '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.7 13.4a17 17 0 0 1 16.6 0l-1.5 2.6a1 1 0 0 1-1.2.4 11 11 0 0 0-3.1-.9 1 1 0 0 1-.8-.8l-.3-2.2a13.3 13.3 0 0 0-2.8 0l-.3 2.2a1 1 0 0 1-.8.8 11 11 0 0 0-3.1.9 1 1 0 0 1-1.2-.4z"/></svg>',
  video: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="6" width="13" height="12" rx="2"/><path d="m16 10 5-3v10l-5-3z"/></svg>',
  mic: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>',
  micOff: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3M4 4l16 16"/></svg>',
  camera: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="6" width="13" height="12" rx="2"/><path d="m16 10 5-3v10l-5-3z"/></svg>',
  cameraOff: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="6" width="13" height="12" rx="2"/><path d="m16 10 5-3v10l-5-3zM4 4l16 16"/></svg>',
};

export function callIconSvg(name) { return ICONS[name] || ICONS.phone; }

function ensureOverlay() {
  if (overlay) return;
  overlay = document.createElement("div");
  overlay.className = "call-overlay";
  overlay.hidden = true;
  overlay.innerHTML = `
    <div class="call-stage">
      <video class="call-remote" autoplay playsinline data-call-remote></video>
      <video class="call-local" autoplay playsinline muted hidden data-call-local></video>
      <div class="call-info">
        <div class="call-avatar" data-call-avatar></div>
        <strong class="call-name" data-call-name></strong>
        <span class="call-status" data-call-status></span>
      </div>
    </div>
    <div class="call-controls" data-call-controls></div>`;
  document.body.append(overlay);
  ui = {
    remote: overlay.querySelector("[data-call-remote]"),
    local: overlay.querySelector("[data-call-local]"),
    avatar: overlay.querySelector("[data-call-avatar]"),
    name: overlay.querySelector("[data-call-name]"),
    status: overlay.querySelector("[data-call-status]"),
    controls: overlay.querySelector("[data-call-controls]"),
  };
  ui.controls.addEventListener("click", (event) => {
    const button = event.target.closest("[data-call-action]");
    if (!button) return;
    const action = button.dataset.callAction;
    if (action === "accept") acceptIncoming();
    else if (action === "decline") declineIncoming();
    else if (action === "hangup") hangUp();
    else if (action === "mute") toggleMute();
    else if (action === "camera") toggleCamera();
  });
}

function showOverlay(call) {
  ensureOverlay();
  overlay.hidden = false;
  document.body.classList.add("call-active");
  if (ui.avatar) ui.avatar.innerHTML = deps.avatarHtmlFor?.(call.address) || "";
  if (ui.name) ui.name.textContent = deps.displayNameFor(call.address);
  if (ui.remote) ui.remote.srcObject = null;
  if (ui.local) { ui.local.srcObject = null; ui.local.hidden = true; }
  renderOverlay();
  if (!statusTicker) statusTicker = window.setInterval(renderStatus, 1000);
}

function hideOverlay() {
  if (!overlay) return;
  overlay.hidden = true;
  document.body.classList.remove("call-active");
  if (ui?.remote) ui.remote.srcObject = null;
  if (ui?.local) ui.local.srcObject = null;
  if (statusTicker) { window.clearInterval(statusTicker); statusTicker = null; }
}

function statusText(call) {
  switch (call.phase) {
    case "ringingOut": return call.hostsThisCall ? "Calling…" : "Asking them to host the call…";
    case "ringingIn": return `Incoming ${call.video ? "video" : "voice"} call`;
    case "connecting": return "Connecting…";
    case "connected": return call.statusDetail || (call.connectedAt ? formatDuration((Date.now() - call.connectedAt) / 1000) : "Connected");
    case "ended": {
      const line = callHistoryLine({ type: "call_end", reason: call.endedReason, durationSeconds: call.connectedAt ? Math.floor((Date.now() - call.connectedAt) / 1000) : null }, call.isOutgoing);
      return call.endedReason === "no_host" ? "One person in this chat needs Nextcloud Talk set up to make calls." : `Call ended · ${line.text}`;
    }
    default: return "";
  }
}

function renderStatus() {
  if (!ui || !session) return;
  ui.status.textContent = statusText(session);
}

function renderOverlay() {
  if (!ui || !session) return;
  const call = session;
  renderStatus();
  overlay.classList.toggle("video", Boolean(call.video));
  overlay.classList.toggle("connected", call.phase === "connected");
  if (ui.local) ui.local.hidden = !call.video || call.cameraOff || !call.localStream;
  let buttons = "";
  if (call.phase === "ringingIn") {
    buttons = `
      <button type="button" class="call-button decline" data-call-action="decline">${ICONS["phone-down"]}<span>Decline</span></button>
      <button type="button" class="call-button accept" data-call-action="accept">${call.video ? ICONS.video : ICONS.phone}<span>Accept</span></button>`;
  } else if (call.phase !== "ended") {
    buttons = `
      <button type="button" class="call-button${call.muted ? " active" : ""}" data-call-action="mute">${call.muted ? ICONS.micOff : ICONS.mic}<span>${call.muted ? "Unmute" : "Mute"}</span></button>
      <button type="button" class="call-button${call.video && !call.cameraOff ? " active" : ""}" data-call-action="camera">${call.video && !call.cameraOff ? ICONS.camera : ICONS.cameraOff}<span>${call.video ? (call.cameraOff ? "Camera on" : "Camera off") : "Video"}</span></button>
      <button type="button" class="call-button decline" data-call-action="hangup">${ICONS["phone-down"]}<span>${call.phase === "ringingOut" ? "Cancel" : "Hang up"}</span></button>`;
  }
  ui.controls.innerHTML = buttons;
}
