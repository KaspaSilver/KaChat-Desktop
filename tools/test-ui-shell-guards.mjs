// UI shell guards in ui/app.js, run from their own source with the page around them stubbed: a
// staged photo stays with its chat and account, a tab going to the background doesn't take the
// active account back, notification taps only run this page's handlers, a voice start waiting on
// the mic prompt can be cancelled and is never doubled, Escape on an overlay leaves the group
// screens beneath alone, the quick-reaction bar closes on a group thread scroll, and contact /
// group prefs are per account with a one-time takeover of the old global stores.
//
//   node tools/test-ui-shell-guards.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const app = readFileSync(join(here, "..", "ui", "app.js"), "utf8");
const broadcasts = readFileSync(join(here, "..", "ui", "broadcasts.js"), "utf8");

// --- source extraction -----------------------------------------------------------------------
// Skips a string, template literal or comment starting at i; returns the index after it, or i.
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
function extractStatement(src, startText) {
  const start = src.indexOf(startText);
  assert.ok(start >= 0, startText);
  let i = start;
  for (; i < src.length; i += 1) {
    const next = skipLiteral(src, i);
    if (next !== i) { i = next - 1; continue; }
    if (src[i] === "(") { i = matchClose(src, i, "(", ")") - 1; continue; }
    if (src[i] === "{") { i = matchClose(src, i, "{", "}") - 1; continue; }
    if (src[i] === ";") break;
  }
  return src.slice(start, i + 1);
}

// Runs `sources` in a scope where every name the page would supply comes from `overrides`, or is
// a recorded no-op function. Assignments to those names land in `overrides`.
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

// --- fakes for the microphone -----------------------------------------------------------------
function fakeMic() {
  const pending = [];
  const streams = [];
  return {
    pending, streams,
    mediaDevices: {
      getUserMedia: () => new Promise((resolve, reject) => { pending.push({ resolve, reject }); }),
    },
    grant(index = 0) {
      const stream = { tracks: [{ stopped: false, stop() { this.stopped = true; } }], getTracks() { return this.tracks; } };
      streams.push(stream);
      pending[index].resolve(stream);
      return stream;
    },
  };
}
class FakeMediaRecorder {
  constructor(stream) { this.stream = stream; this.state = "inactive"; this.mimeType = "audio/webm"; this.listeners = {}; this.onstop = null; }
  static isTypeSupported() { return true; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  start() { this.state = "recording"; }
  stop() {
    this.state = "inactive";
    for (const fn of this.listeners.dataavailable || []) fn({ data: new Blob(["x"]) });
    for (const fn of this.listeners.stop || []) fn();
    this.onstop?.();
  }
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
function fakeTimers() {
  const intervals = new Set();
  let next = 1;
  return {
    intervals,
    setInterval: () => { const id = next++; intervals.add(id); return id; },
    clearInterval: (id) => { intervals.delete(id); },
  };
}

// --- 4. createVoiceRecorder --------------------------------------------------------------------
function makeRecorder() {
  const mic = fakeMic();
  const timers = fakeTimers();
  const finished = [];
  const { fns } = sandbox([extractFunction(app, "createVoiceRecorder")], {
    navigator: { mediaDevices: mic.mediaDevices },
    window: { MediaRecorder: FakeMediaRecorder, setInterval: timers.setInterval, clearInterval: timers.clearInterval },
    MediaRecorder: FakeMediaRecorder,
    pickVoiceMimeType: () => "audio/webm",
    VOICE_AUDIO_BITS_PER_SECOND: 6000,
  });
  const recorder = fns.createVoiceRecorder({ maxDurationSeconds: () => 25, onElapsed: () => {}, onFinish: (result) => finished.push(result) });
  return { mic, timers, finished, recorder };
}

await test("voice: a second start during the mic prompt is ignored (one stream, one timer)", async () => {
  const { mic, timers, recorder } = makeRecorder();
  const first = recorder.start();
  assert.equal(recorder.isStarting(), true);
  assert.equal(await recorder.start(), null, "the duplicate returns at once");
  assert.equal(mic.pending.length, 1, "only one getUserMedia call");
  mic.grant(0);
  assert.equal(await first, null);
  assert.equal(recorder.isRecording(), true);
  assert.equal(recorder.isStarting(), false);
  assert.equal(timers.intervals.size, 1);
});

await test("voice: stop() during the prompt cancels it and the late stream is switched off", async () => {
  const { mic, timers, finished, recorder } = makeRecorder();
  const started = recorder.start();
  recorder.stop(false);
  assert.equal(recorder.isStarting(), false);
  assert.equal(finished.length, 1);
  assert.equal(finished[0].cancelled, true, "nothing to keep: it ends cancelled");
  const stream = mic.grant(0);
  assert.equal(await started, null);
  assert.equal(stream.tracks[0].stopped, true, "the mic goes straight off");
  assert.equal(recorder.isRecording(), false);
  assert.equal(timers.intervals.size, 0, "no orphaned timer");
  // A fresh start afterwards works.
  const again = recorder.start();
  assert.equal(mic.pending.length, 2);
  mic.grant(1);
  await again;
  assert.equal(recorder.isRecording(), true);
});

await test("voice: a denial after a cancel reports nothing", async () => {
  const { mic, recorder } = makeRecorder();
  const started = recorder.start();
  recorder.stop(true);
  mic.pending[0].reject(new Error("NotAllowedError"));
  assert.equal(await started, null);
  // Without the cancel the denial is reported.
  const next = recorder.start();
  mic.pending[1].reject(new Error("NotAllowedError"));
  assert.equal(await next, "Microphone access was denied.");
  assert.equal(recorder.isStarting(), false);
});

await test("voice: a normal recording stops its stream and hands back the blob", async () => {
  const { mic, timers, finished, recorder } = makeRecorder();
  const started = recorder.start();
  const stream = mic.grant(0);
  await started;
  recorder.stop(false);
  assert.equal(stream.tracks[0].stopped, true);
  assert.equal(timers.intervals.size, 0);
  assert.equal(finished.at(-1).cancelled, false);
  assert.ok(finished.at(-1).blob);
});

await test("voice: callers check the recorder after start (1:1, rooms) and cancel a pending start", () => {
  const chatStart = extractFunction(app, "startVoiceRecording");
  assert.match(chatStart, /chatVoiceRecorder\.isStarting\(\)/);
  assert.match(chatStart, /if \(!chatVoiceRecorder\.isRecording\(\)\)/);
  assert.match(extractFunction(app, "exitChatAudioMode"), /chatVoiceRecorder\.isStarting\(\)\) chatVoiceRecorder\.stop\(true\)/);
  const roomStart = extractFunction(broadcasts, "startVoiceRecording");
  assert.match(roomStart, /recorder\.isStarting\?\.\(\)/);
  assert.match(roomStart, /if \(!recorder\.isRecording\(\)\) return;/);
  assert.match(extractFunction(broadcasts, "cancelVoiceRecordingIfActive"), /isStarting\?\.\(\)/);
});

// --- 4. startGroupVoice --------------------------------------------------------------------------
function makeGroupVoice() {
  const mic = fakeMic();
  const timers = fakeTimers();
  const box = sandbox([
    extractStatement(app, "let groupVoiceStartToken = null;"),
    extractFunction(app, "startGroupVoice"),
    extractFunction(app, "stopGroupVoiceTimer"),
    extractFunction(app, "cancelGroupVoice"),
  ], {
    navigator: { mediaDevices: mic.mediaDevices },
    window: { setInterval: timers.setInterval },
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
    MediaRecorder: FakeMediaRecorder,
    pickVoiceMimeType: () => "audio/webm",
    VOICE_AUDIO_BITS_PER_SECOND: 6000,
    activeGroupId: "g1",
    groupVoiceRecorder: null,
    groupVoiceEncoding: false,
    groupVoiceTimer: null,
    groupVoiceChunks: [],
    groupVoicePanel: null,
    groupVoiceMaxDurationSeconds: () => 10,
  });
  return { mic, timers, ...box };
}

await test("group voice: a double tap opens one stream", async () => {
  const { mic, fns, scope, timers } = makeGroupVoice();
  const first = fns.startGroupVoice();
  await fns.startGroupVoice();
  assert.equal(mic.pending.length, 1);
  mic.grant(0);
  await first;
  assert.ok(scope.groupVoiceRecorder, "recording");
  assert.equal(timers.intervals.size, 1);
});

await test("group voice: trash during the prompt leaves no recording and the mic off", async () => {
  const { mic, fns, scope, timers } = makeGroupVoice();
  const started = fns.startGroupVoice();
  fns.cancelGroupVoice();
  const stream = mic.grant(0);
  await started;
  assert.equal(scope.groupVoiceRecorder, null);
  assert.equal(stream.tracks[0].stopped, true);
  assert.equal(timers.intervals.size, 0);
});

await test("group voice: another group opened during the prompt drops the stream", async () => {
  const { mic, fns, scope } = makeGroupVoice();
  const started = fns.startGroupVoice();
  scope.activeGroupId = "g2";
  const stream = mic.grant(0);
  await started;
  assert.equal(scope.groupVoiceRecorder, null);
  assert.equal(stream.tracks[0].stopped, true);
  // and the next start is not blocked by a stale token
  const next = fns.startGroupVoice();
  assert.equal(mic.pending.length, 2);
  mic.grant(1);
  await next;
  assert.ok(scope.groupVoiceRecorder);
});

// --- 1. staged photo follows neither the chat nor the account -----------------------------------
await test("photo: opening a different chat clears the staged photo; reopening the same one keeps it", () => {
  const make = (active) => sandbox([extractFunction(app, "openConversation")], {
    messageSelectionMode: false, selectedMessageIds: new Set(), activeConversationId: active,
    appDetail: null, state: { conversations: [] },
  });
  const other = make("conv-a");
  other.fns.openConversation("conv-b");
  assert.equal(other.called("clearPendingPhoto").length, 1);
  assert.equal(other.called("cancelReply").length, 1);
  const same = make("conv-a");
  same.fns.openConversation("conv-a");
  assert.equal(same.called("clearPendingPhoto").length, 0);
});

await test("photo: an account switch clears the staged photo, the recording and notification handlers", () => {
  const cleared = [];
  const box = sandbox([extractFunction(app, "closeChatsForAccountSwitch")], {
    messageSelectionMode: false, paySheetConversationId: null, composerInputField: null,
    activeGroupId: null, chatSelectionModeActive: false,
    pendingNotificationClicks: { clear: () => cleared.push(true) },
  });
  box.fns.closeChatsForAccountSwitch();
  assert.equal(box.called("clearPendingPhoto").length, 1);
  assert.equal(box.called("exitChatAudioMode").length, 1);
  assert.equal(cleared.length, 1);
});

await test("photo: a photo or video picked before a chat switch is not staged in the next chat", () => {
  assert.match(extractFunction(app, "attachPhotoBlob"), /if \(activeConversationId !== conversationId\) \{ photoViaNextcloud = false; return false; \}/);
  assert.match(extractFunction(app, "stageChatNextcloudVideo"), /if \(activeConversationId !== conversationId\) return;/);
});

// --- 2. a hidden tab doesn't take the active account back ---------------------------------------
await test("hide: the wallet is re-saved only while the stored active account is this tab's", () => {
  const make = (active, address = "kaspa:qa") => sandbox([extractFunction(app, "shouldPersistWalletOnLeave")], {
    engine: { privateKeyHex: "aa", address },
    readActiveAccountAddress: () => active,
    toActiveNetworkAddress: (value) => value,
  }).fns.shouldPersistWalletOnLeave();
  assert.equal(make("kaspa:qa"), true, "still this tab's account");
  assert.equal(make(""), true, "none stored yet");
  assert.equal(make("kaspa:qb"), false, "another tab switched to B since");
  assert.equal(sandbox([extractFunction(app, "shouldPersistWalletOnLeave")], { engine: { privateKeyHex: "" } }).fns.shouldPersistWalletOnLeave(), false);
  // Both the hide handler and beforeunload go through it.
  assert.match(app, /=== "hidden"\) \{\n\s*try \{\n\s*if \(shouldPersistWalletOnLeave\(\)\) persistTestingWallet\(\);/);
  assert.match(app, /"beforeunload", \(\) => \{\n\s*try \{\n\s*if \(shouldPersistWalletOnLeave\(\)\) persistTestingWallet\(\);/);
});

// --- 3. notification click ids -------------------------------------------------------------------
await test("notifications: ids are unique per page and a foreign or old-style id runs no handler", () => {
  const source = (() => {
    const block = app.slice(app.indexOf("const pendingNotificationClicks = new Map();"));
    return block.slice(0, block.indexOf("function ownNotificationClickHandler")) + extractFunction(block, "ownNotificationClickHandler");
  })();
  const page = () => {
    const opened = [];
    const ran = [];
    const scope = {
      crypto: globalThis.crypto,
      state: { conversations: [{ id: "c1" }, { id: "c2" }] },
      openConversation: (id) => opened.push(id),
      setActiveAppTab: () => {},
    };
    const run = new Function("scope", `with (scope) { ${source}\n${extractFunction(app, "routeNotificationClick")}\n return { pendingNotificationClicks, newNotificationClickId, routeNotificationClick }; }`);
    const api = run(new Proxy(scope, {
      has: (t, k) => typeof k === "string" && (k in t || !(k in globalThis)),
      get: (t, k) => (k === Symbol.unscopables ? undefined : k in t ? t[k] : () => {}),
      set: (t, k, v) => { t[k] = v; return true; },
    }));
    return { ...api, opened, ran };
  };
  const a = page();
  const b = page();
  const idA = a.newNotificationClickId();
  const idB = b.newNotificationClickId();
  assert.notEqual(idA, idB, "two pages never share an id");
  assert.notEqual(a.newNotificationClickId(), idA, "nor does one page twice");
  a.pendingNotificationClicks.set(idA, () => a.ran.push("A"));
  b.pendingNotificationClicks.set(idB, () => b.ran.push("B"));
  // The worker hands page B a tap on page A's notification: B goes by the route, runs nothing of its own.
  b.routeNotificationClick({ clickId: idA, route: { kind: "chat", conversationId: "c2" } });
  assert.deepEqual(b.ran, []);
  assert.deepEqual(b.opened, ["c2"]);
  // An old counter id ("1") from before a reload: route only.
  a.routeNotificationClick({ clickId: 1, route: { kind: "chat", conversationId: "c1" } });
  assert.deepEqual(a.ran, []);
  assert.deepEqual(a.opened, ["c1"]);
  // This page's own tap runs its handler, once.
  a.routeNotificationClick({ clickId: idA, route: { kind: "chat", conversationId: "c2" } });
  assert.deepEqual(a.ran, ["A"]);
  assert.equal(a.pendingNotificationClicks.has(idA), false);
});

// --- 5. Escape on an overlay ---------------------------------------------------------------------
await test("escape: a handled Escape or an open overlay leaves the group screens alone", () => {
  let open = null;
  const box = sandbox([extractFunction(app, "overlayTakesEscape")], { document: { querySelector: () => open } });
  assert.equal(box.fns.overlayTakesEscape({ defaultPrevented: true }), true);
  assert.equal(box.fns.overlayTakesEscape({ defaultPrevented: false }), false);
  open = {};
  assert.equal(box.fns.overlayTakesEscape({ defaultPrevented: false }), true);
  const handler = app.slice(app.indexOf("function overlayTakesEscape"), app.indexOf("function overlayTakesEscape") + 1200);
  assert.match(handler, /if \(event\.key !== "Escape" \|\| overlayTakesEscape\(event\)\) return;/);
  // The message menu and the quick-reaction bar mark their Escape handled.
  assert.match(extractFunction(app, "openQuickReactionBarFor"), /if \(ev\.key === "Escape"\) \{ ev\.preventDefault\(\); cleanup\(\); \}/);
  const menuStart = app.indexOf("const onDown = (ev) => { if (!menu.contains(ev.target)) cleanup(); };");
  assert.match(app.slice(menuStart, menuStart + 300), /ev\.preventDefault\(\); cleanup\(\);/);
});

// --- 9. quick-reaction bar and the group thread --------------------------------------------------
await test("quick reactions: a group or room thread scroll closes the bar too", () => {
  const bar = extractFunction(app, "openQuickReactionBarFor");
  assert.match(bar, /\[messageArea, groupMessageArea, roomBody\]/);
  assert.match(bar, /for \(const area of scrollAreas\) area\.addEventListener\("scroll", cleanup, true\)/);
  assert.match(bar, /for \(const area of scrollAreas\) area\.removeEventListener\("scroll", cleanup, true\)/);
});

// --- 8. contact / group prefs per account --------------------------------------------------------
function prefsPage(storage, engine, saved = []) {
  const localStorage = {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
  };
  return sandbox([
    extractFunction(app, "accountScopedKey"),
    extractFunction(app, "accountPrefsScope"),
    extractFunction(app, "legacyPrefsAccounts"),
    extractFunction(app, "loadAccountPrefs"),
    extractFunction(app, "saveAccountPrefs"),
    extractFunction(app, "contactPrefsStore"),
    extractFunction(app, "saveContactPrefs"),
    extractFunction(app, "getContactNotifyOverride"),
    extractFunction(app, "setContactPref"),
    extractFunction(app, "groupPrefsStore"),
    extractFunction(app, "saveGroupPrefs"),
    extractFunction(app, "getGroupNotify"),
    extractFunction(app, "setGroupNotify"),
  ], {
    engine, localStorage, loadSavedAccounts: () => saved.map((address) => ({ address })),
    ACCOUNT_DATA_PREFIX: /const ACCOUNT_DATA_PREFIX = "([^"]+)"/.exec(app)[1],
    CONTACT_PREFS_KEY: /const CONTACT_PREFS_KEY = "([^"]+)"/.exec(app)[1],
    GROUP_PREFS_KEY: /const GROUP_PREFS_KEY = "([^"]+)"/.exec(app)[1],
    GROUP_NOTIFY_MODES: ["all", "mentions", "muted"],
  });
}

await test("prefs: the old global stores move to the account open, once; an account saved later starts clean", () => {
  const storage = new Map([
    ["kachat-contact-prefs-v1", JSON.stringify({ "kaspa:qfriend": { notify: "muted", calls: true } })],
    ["kachat-group-prefs-v1", JSON.stringify({ g1: { notify: "mentions" } })],
  ]);
  const engine = { address: "kaspa:qaccounta" };
  const { fns } = prefsPage(storage, engine);
  assert.equal(fns.getContactNotifyOverride("kaspa:qfriend"), "off");
  assert.equal((fns.contactPrefsStore()["kaspa:qfriend"]?.calls === true), true);
  assert.equal(fns.getGroupNotify("g1"), "mentions");
  assert.equal(storage.has("kachat-contact-prefs-v1"), false, "the global key is gone");
  assert.equal(storage.has("kachat-group-prefs-v1"), false);
  assert.ok(storage.has("kachat-account-data-v1:kaspa:qaccounta:kachat-contact-prefs-v1"));
  // Account B: nothing carried over.
  engine.address = "kaspa:qaccountb";
  assert.equal(fns.getContactNotifyOverride("kaspa:qfriend"), null);
  assert.equal((fns.contactPrefsStore()["kaspa:qfriend"]?.calls === true), false);
  assert.equal(fns.getGroupNotify("g1"), "all");
  fns.setContactPref("kaspa:qfriend", "calls", true);
  fns.setGroupNotify("g1", "muted");
  // Back to A: its own values, untouched by B's.
  engine.address = "kaspa:qaccounta";
  assert.equal(fns.getGroupNotify("g1"), "mentions");
  fns.setContactPref("kaspa:qfriend", "calls", undefined);
  engine.address = "kaspa:qaccountb";
  assert.equal((fns.contactPrefsStore()["kaspa:qfriend"]?.calls === true), true);
  assert.equal(fns.getGroupNotify("g1"), "muted");
});

await test("prefs: the old global stores are copied to every saved account, not only the open one", () => {
  const storage = new Map([
    ["kachat-contact-prefs-v1", JSON.stringify({ "kaspa:qfriend": { notify: "muted" } })],
    ["kachat-account-data-v1:kaspa:qaccountc:kachat-contact-prefs-v1", JSON.stringify({ "kaspa:qother": { calls: true } })],
  ]);
  const engine = { address: "kaspa:qaccounta" };
  const { fns } = prefsPage(storage, engine, ["kaspa:qaccounta", "kaspa:qaccountb", "kaspa:qaccountc"]);
  assert.equal(fns.getContactNotifyOverride("kaspa:qfriend"), "off");
  assert.equal(storage.has("kachat-contact-prefs-v1"), false);
  engine.address = "kaspa:qaccountb";
  assert.equal(fns.getContactNotifyOverride("kaspa:qfriend"), "off", "B kept the mute it had");
  engine.address = "kaspa:qaccountc";
  assert.equal(fns.getContactNotifyOverride("kaspa:qfriend"), null, "C's own prefs are not overwritten");
  assert.equal((fns.contactPrefsStore()["kaspa:qother"]?.calls === true), true);
});

await test("prefs: with no account open nothing is read or written, and the global store waits", () => {
  const storage = new Map([["kachat-contact-prefs-v1", JSON.stringify({ x: { notify: "off" } })]]);
  const engine = { address: "" };
  const { fns } = prefsPage(storage, engine);
  assert.equal(fns.getContactNotifyOverride("x"), null);
  fns.setContactPref("x", "calls", true);
  assert.equal(storage.has("kachat-contact-prefs-v1"), true, "not taken over without an account");
  assert.equal([...storage.keys()].length, 1);
  // Removing an account sweeps its prefixed keys, so these go with it (no global key to clean).
  assert.match(extractFunction(app, "removeAccountScopedLocalData"), /legacyGroupPrefs/);
});

console.log(`\n${passed} passed`);
