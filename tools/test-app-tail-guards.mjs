// Guards in the last third of ui/app.js (payments, media, groups), run from their own source with
// the page around them stubbed: a voice note whose Nextcloud upload fails still goes to the chat it
// was recorded in; a group voice note goes to its own group (and not from another account); a group
// photo picked in one group isn't staged in the next; re-opening the open group keeps what is being
// composed there; a chat payment's txid is stored as soon as the node has it; Save Audio never takes
// a sender's non-audio file name.
//
//   node tools/test-app-tail-guards.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const app = readFileSync(join(here, "..", "ui", "app.js"), "utf8");

// --- source extraction (as tools/test-ui-shell-guards.mjs) -------------------------------------
function skipLiteral(src, i) {
  const c = src[i];
  if (c === "/" && src[i + 1] === "/") { const end = src.indexOf("\n", i); return end < 0 ? src.length : end; }
  if (c === "/" && src[i + 1] === "*") return src.indexOf("*/", i + 2) + 2;
  if (c === '"' || c === "'") {
    for (let j = i + 1; j < src.length; j += 1) { if (src[j] === "\\") { j += 1; continue; } if (src[j] === c) return j + 1; }
  }
  if (c === "`") {
    for (let j = i + 1; j < src.length; j += 1) {
      if (src[j] === "\\") { j += 1; continue; }
      if (src[j] === "`") return j + 1;
      if (src[j] === "$" && src[j + 1] === "{") j = matchClose(src, j + 1, "{", "}") - 1;
    }
  }
  return i;
}
function matchClose(src, open, a, b) {
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    const next = skipLiteral(src, i);
    if (next !== i) { i = next - 1; continue; }
    if (src[i] === a) depth += 1;
    else if (src[i] === b) { depth -= 1; if (depth === 0) return i + 1; }
  }
  throw new Error("unbalanced source");
}
function extractFunction(src, name) {
  const match = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(src);
  assert.ok(match, `function ${name} in the source`);
  const paramsEnd = matchClose(src, match.index + match[0].length - 1, "(", ")");
  const bodyStart = src.indexOf("{", paramsEnd);
  return src.slice(match.index, matchClose(src, bodyStart, "{", "}"));
}
function sandbox(sources, overrides = {}) {
  const calls = [];
  const scope = new Proxy(overrides, {
    has: (target, key) => typeof key === "string" && (key in target || !(key in globalThis)),
    get: (target, key) => {
      if (key === Symbol.unscopables) return undefined;
      if (key in target) return target[key];
      const fn = (...args) => { calls.push([key, ...args]); return undefined; };
      target[key] = fn;
      return fn;
    },
    set: (target, key, value) => { target[key] = value; return true; },
  });
  const names = sources.map((src) => /function\s+([A-Za-z0-9_$]+)/.exec(src)?.[1]).filter(Boolean);
  // eslint-disable-next-line no-new-func
  const run = new Function("scope", `with (scope) { ${sources.join("\n")}\n return { ${names.join(", ")} }; }`);
  return { fns: run(scope), calls, scope: overrides, called: (name) => calls.filter((c) => c[0] === name) };
}

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`ok - ${name}`); }
  catch (error) { console.error(`not ok - ${name}`); throw error; }
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
function deferred() {
  let resolve; let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
class FakeFileReader {
  readAsDataURL() { setTimeout(() => { this.result = "data:audio/webm;base64,eA=="; this.onload?.(); }, 0); }
}
const voiceFileName = extractFunction(app, "voiceFileName");

// --- 1:1 voice note: Nextcloud failure falls back to the chain in the chat it was made in ---------
await test("chat voice: a failed Nextcloud upload goes on chain to the chat it was recorded in", async () => {
  const panel = {};
  const upload = deferred();
  const queued = [];
  const ctx = sandbox([extractFunction(app, "sendChatVoicePreview"), voiceFileName], {
    voiceRecordingPanel: panel,
    voicePreviews: new Map([[panel, { blob: { size: 2000 }, mimeType: "audio/webm" }]]),
    activeConversationId: "chat-A",
    voiceViaNextcloud: true,
    isNextcloudConnected: () => true,
    CHAT_VOICE_MAX_BYTES: 31000,
    chatAudioMode: true,
    uploadNextcloudMedia: () => upload.promise,
    queueConversationMessage: (id, text) => queued.push({ id, text }),
    userFacingError: (e) => e.message,
    FileReader: FakeFileReader,
    VoiceNotes: { longVoiceNotesSupported: () => false },
  });
  const sending = ctx.fns.sendChatVoicePreview();
  // Another chat is opened while the upload runs; then the upload fails.
  ctx.scope.activeConversationId = "chat-B";
  upload.reject(new Error("offline"));
  await sending;
  assert.equal(queued.length, 1);
  assert.equal(queued[0].id, "chat-A", "not the chat open now");
  assert.match(queued[0].text, /"type":"file"/);
});

await test("chat voice: with the long-note encoder, a failed Nextcloud upload goes on chain as the parts", async () => {
  const panel = {};
  const upload = deferred();
  const queued = [];
  const partsQueued = [];
  const ctx = sandbox([extractFunction(app, "sendChatVoicePreview"), voiceFileName], {
    voiceRecordingPanel: panel,
    voicePreviews: new Map([[panel, { blob: { size: 400000 }, mimeType: "audio/webm" }]]),
    activeConversationId: "chat-A",
    voiceViaNextcloud: true,
    isNextcloudConnected: () => true,
    CHAT_VOICE_MAX_BYTES: 31000,
    chatAudioMode: true,
    uploadNextcloudMedia: () => upload.promise,
    queueConversationMessage: (id, text) => queued.push({ id, text }),
    queueOneToOneParts: (id, texts) => partsQueued.push({ id, texts }),
    userFacingError: (e) => e.message,
    FileReader: FakeFileReader,
    VOICE_PATHS: { oneToOne: {} },
    VoiceNotes: {
      longVoiceNotesSupported: () => true,
      prepareVoiceParts: async () => ({ parts: [new Uint8Array(3), new Uint8Array(2)] }),
      voicePartEnvelopes: (parts) => parts.map((_, i) => `part-${i + 1}`),
    },
  });
  const sending = ctx.fns.sendChatVoicePreview();
  ctx.scope.activeConversationId = "chat-B";
  upload.reject(new Error("offline"));
  await sending;
  assert.equal(queued.length, 0, "never the raw recording, which no longer fits one transaction");
  assert.deepEqual(partsQueued, [{ id: "chat-A", texts: ["part-1", "part-2"] }]);
});

// --- group voice note: its own group, its own account ---------------------------------------------
function groupVoiceCtx({ via = true } = {}) {
  const upload = deferred();
  const wires = [];
  const ctx = sandbox([extractFunction(app, "sendGroupVoiceBlob"), voiceFileName], {
    engine: { address: "kaspa:me" },
    activeGroupId: "g1",
    groupVoiceMime: "audio/webm",
    groupVoiceViaNextcloud: via,
    isNextcloudConnected: () => true,
    uploadNextcloudMedia: () => upload.promise,
    sendGroupWire: async (text, options) => { wires.push({ text, options }); return true; },
    userFacingError: (e) => e.message,
    FileReader: FakeFileReader,
    VoiceNotes: { longVoiceNotesSupported: () => false },
  });
  return { ctx, upload, wires };
}
await test("group voice: the link goes to the group it was recorded in, not the one open now", async () => {
  const { ctx, upload, wires } = groupVoiceCtx();
  const sending = ctx.fns.sendGroupVoiceBlob({ size: 10 }, 3, "g1");
  ctx.scope.activeGroupId = "g2";
  upload.resolve("https://cloud.example/s/abc");
  await sending;
  assert.equal(wires.length, 1);
  assert.equal(wires[0].text, "https://cloud.example/s/abc");
  assert.equal(wires[0].options.groupId, "g1");
});
await test("group voice: the on-chain fallback also keeps its group", async () => {
  const { ctx, upload, wires } = groupVoiceCtx();
  const sending = ctx.fns.sendGroupVoiceBlob({ size: 10 }, 3, "g1");
  ctx.scope.activeGroupId = "g2";
  upload.reject(new Error("offline"));
  await sending;
  assert.equal(wires.length, 1);
  assert.equal(wires[0].options.groupId, "g1");
  assert.match(wires[0].text, /"mimeType":"audio\/webm"/);
});
await test("group voice: nothing is sent once another account is active", async () => {
  const { ctx, upload, wires } = groupVoiceCtx();
  const sending = ctx.fns.sendGroupVoiceBlob({ size: 10 }, 3, "g1");
  ctx.scope.engine = { address: "kaspa:other" };
  upload.resolve("https://cloud.example/s/abc");
  await sending;
  assert.equal(wires.length, 0);
  const second = groupVoiceCtx({ via: false });
  const fallback = second.ctx.fns.sendGroupVoiceBlob({ size: 10 }, 3, "g1");
  second.ctx.scope.engine = { address: "kaspa:other" };
  await fallback;
  assert.equal(second.wires.length, 0);
});
await test("sendGroupWire: an explicit group is used even when another is open", async () => {
  const sent = [];
  const stored = [];
  const ctx = sandbox([extractFunction(app, "sendGroupWire")], {
    activeGroupId: "g2",
    engine: { address: "kaspa:me" },
    getGroupManager: () => ({
      getGroup: (id) => (id === "g1" || id === "g2" ? { groupId: id, isAdmin: false } : null),
      sendGroupMessage: async (gid, text) => { sent.push({ gid, text }); return { txid: "t", msgIdHex: "m" }; },
    }),
    appendGroupMessage: (gid, row) => stored.push({ gid, row }),
    nowId: () => "local-1",
    MESSAGE_STATUSES: { PENDING: "pending", CONFIRMED: "confirmed", FAILED: "failed" },
  });
  assert.equal(await ctx.fns.sendGroupWire("hi", { groupId: "g1" }), true);
  assert.deepEqual(sent, [{ gid: "g1", text: "hi" }]);
  assert.equal(stored[0].gid, "g1");
  // A group this account doesn't have sends nothing.
  assert.equal(await ctx.fns.sendGroupWire("hi", { groupId: "gone" }), false);
  assert.equal(sent.length, 1);
});

// --- group photo: staged only in the group it was picked in ---------------------------------------
await test("group photo: a pick that finishes compressing after a group switch is not staged", async () => {
  const compress = deferred();
  const staged = [];
  const ctx = sandbox([extractFunction(app, "handleGroupMediaFile")], {
    activeGroupId: "g1",
    groupPhotoViaNextcloud: false,
    isNextcloudConnected: () => false,
    compressImageBlob: () => compress.promise,
    canAcceptGroupImageAttachment: () => true,
    setGroupPendingPhoto: (attachment, name) => staged.push({ attachment, name }),
    userFacingError: (e) => e.message,
  });
  const input = { files: [{ type: "image/jpeg", name: "a.jpg" }], value: "x", accept: "" };
  const handling = ctx.fns.handleGroupMediaFile(input);
  ctx.scope.activeGroupId = "g2";
  compress.resolve({ dataUrl: "data:image/jpeg;base64,eA==", bytes: 10 });
  await handling;
  assert.equal(staged.length, 0, "not staged in the other group");
  // In the same group it is.
  const again = deferred();
  ctx.scope.compressImageBlob = () => again.promise;
  ctx.scope.activeGroupId = "g1";
  const second = ctx.fns.handleGroupMediaFile({ files: [{ type: "image/jpeg", name: "b.jpg" }], value: "", accept: "" });
  again.resolve({ dataUrl: "data:image/jpeg;base64,eA==", bytes: 10 });
  await second;
  assert.equal(staged.length, 1);
  assert.equal(staged[0].name, "b.jpg");
});

// --- re-opening the open group keeps the composer ---------------------------------------------------
function groupOpenCtx() {
  const input = { value: "" };
  const ctx = sandbox([extractFunction(app, "openGroupChat")], {
    getGroupManager: () => ({ getGroup: (id) => ({ groupId: id, name: id, photoHex: "", members: [{ address: "kaspa:me" }] }) }),
    activeGroupId: null,
    publicRoomOpen: false,
    groupFeeOverrideKas: null,
    groupSelectionMode: false,
    selectedGroupMessageKeys: new Set(),
    engine: { address: "kaspa:me" },
    groupChatName: null, groupChatSub: null, groupChatAvatar: null, groupReadonlyNote: null, groupComposer: null,
    detailEmptyState: null, conversation: null, groupChatScreen: null, appBody: null,
    document: { body: { classList: { add() {} } } },
    groupVoiceRecorder: null, groupVoiceEncoding: false, groupVoiceStartToken: null,
    groupDraftMentions: new Map(),
    groupComposerInput: input,
    readDraft: (key) => `draft for ${key}`,
    isTouchDevice: () => true,
  });
  return { ctx, input };
}
await test("group open: re-opening the open group keeps the text, photo and fee being composed", () => {
  const { ctx, input } = groupOpenCtx();
  ctx.fns.openGroupChat("g1");
  assert.equal(input.value, "draft for group:g1", "a fresh open restores the draft");
  // The person types, picks a fee; then a sync's photo control re-opens the same group.
  input.value = "half-typed message";
  ctx.scope.groupFeeOverrideKas = "0.001";
  const clearsBefore = ctx.called("clearGroupPendingPhoto").length;
  ctx.fns.openGroupChat("g1");
  assert.equal(input.value, "half-typed message");
  assert.equal(ctx.scope.groupFeeOverrideKas, "0.001");
  assert.equal(ctx.called("clearGroupPendingPhoto").length, clearsBefore, "the staged photo stays");
  assert.equal(ctx.called("cancelGroupReply").length, 1, "only the first open reset the reply");
  // Switching to another group still starts that group fresh.
  ctx.fns.openGroupChat("g2");
  assert.equal(input.value, "draft for group:g2");
  assert.equal(ctx.scope.groupFeeOverrideKas, null);
  assert.equal(ctx.called("clearGroupPendingPhoto").length, clearsBefore + 1);
});

// --- chat payment: the txid is stored before the slow verification ----------------------------------
await test("payment: the txid is persisted as soon as the node accepts, before verification ends", async () => {
  const messages = [];
  const conversationEntry = { id: "c1", messages };
  const snapshots = [];
  const verify = deferred();
  const ctx = sandbox([extractFunction(app, "sendKasPayment")], {
    paymentSendInFlight: false,
    state: { conversations: [conversationEntry] },
    contactForConversation: () => ({ id: "k1", address: "kaspa:them" }),
    normalizeKasAmount: (v) => String(v),
    clampPaymentMemo: (v) => String(v || ""),
    kasTextToSompi: () => 50000000n,
    engine: {
      address: "kaspa:me",
      balance: async () => ({ totalKas: "10", totalSompi: 1000000000n, entries: [] }),
      buildPaymentPayload: async () => ({ payloadBytes: new Uint8Array([1]) }),
      send: async () => ({ txids: ["tx-final"] }),
    },
    chatPaymentDestination: (contact) => contact.address,
    createMessage: (fields) => ({ id: "m1", ...fields }),
    applyMessagePatch: (message, patch) => Object.assign(message, patch),
    appendIncomingOrReactionMessage: (entry, message) => entry.messages.push(message),
    persistState: () => snapshots.push(messages.map((m) => ({ txid: m.txid || null, status: m.status }))),
    verifyKasPaymentBroadcast: () => verify.promise,
    activeConversationId: null,
    MESSAGE_STATUSES: { PENDING: "pending", CONFIRMED: "confirmed", FAILED: "failed" },
    KAS_UNIT: "KAS",
    NETWORK: "mainnet",
    MAX_AMOUNT_CHANGED: "MAX_AMOUNT_CHANGED",
    SEND_OUTCOME_UNKNOWN: "SEND_OUTCOME_UNKNOWN",
  });
  const paying = ctx.fns.sendKasPayment("c1", "0.5");
  for (let i = 0; i < 10; i += 1) await tick();
  // Still verifying (as when the tab is closed right after the Sent sheet):
  assert.equal(snapshots.at(-1)?.[0]?.txid, "tx-final", "stored with its txid already");
  assert.equal(messages[0].txid, "tx-final");
  verify.resolve("tx-final");
  ctx.scope.refreshBalanceOnly = async () => {};
  assert.equal(await paying, "tx-final");
  assert.equal(messages[0].status, "confirmed");
});

// --- Save Audio: the sender's name only when it is an audio file name -------------------------------
await test("save audio: a sender's non-audio file name is replaced", () => {
  const anchors = [];
  const ctx = sandbox([extractFunction(app, "saveAudioEnvelope"), voiceFileName], {
    document: {
      createElement: () => { const a = { click() {}, remove() {} }; anchors.push(a); return a; },
      body: { append() {} },
    },
  });
  ctx.fns.saveAudioEnvelope({ content: "data:audio/webm;base64,eA==", name: "voice-message.webm", mimeType: "audio/webm" });
  ctx.fns.saveAudioEnvelope({ content: "data:text/html;base64,eA==", name: "invoice.html", mimeType: "audio/webm" });
  ctx.fns.saveAudioEnvelope({ content: "data:audio/mp4;base64,eA==", name: "../../x.m4a", mimeType: "audio/mp4" });
  ctx.fns.saveAudioEnvelope({ content: "data:audio/ogg;base64,eA==", name: "", mimeType: "audio/ogg" });
  assert.deepEqual(anchors.map((a) => a.download), ["voice-message.webm", "voice.webm", "voice.m4a", "voice.ogg"]);
});

await test("account switch closes an open chess board", () => {
  assert.match(extractFunction(app, "closeChatsForAccountSwitch"), /step\(\(\) => closeChess\(\)\)/);
});

await test("instant tips store their txid before the 14 s verification, like chat payments", () => {
  const stores = [...app.matchAll(/applyMessagePatch\(liveMessage, \{ txid, network: NETWORK \}\);\n\s+persistState\(\);\n(?:.*\n){0,8}?\s+const verifiedTxid = await verifyKasPaymentBroadcast/g)];
  assert.equal(stores.length, 3, "sendKasPayment and both instant-tip paths");
});

await test("photo preview Share keeps only a plain image name from the sender", () => {
  const body = extractFunction(app, "openPhotoPreview");
  const names = [];
  for (const name of ["beach.png", "invoice.html", "../../x.jpg", "", "Holiday 2026.JPEG"]) {
    const ctx = sandbox([body], {
      photoPreviewOverlay: { hidden: true, querySelector: () => null, classList: { toggle() {} } },
      photoPreviewImage: { style: {} },
      setPhotoPreviewZoom() {},
    });
    ctx.fns.openPhotoPreview("data:image/png;base64,eA==", name);
    names.push(ctx.scope.photoPreviewName);
  }
  assert.deepEqual(names, ["beach.png", "photo.jpg", "photo.jpg", "photo.jpg", "Holiday 2026.JPEG"]);
});

console.log(`\n${passed} passed`);
