// ui/dialogs.js focus handling (a choice sheet takes the focus, Escape is handled there, Tab stays
// inside, the opener gets the focus back) and ui/qr-scan.js camera restarts (one camera and one
// frame loop when the camera is tried again while the permission prompt is up). A small fake DOM
// stands in for the browser.
//
//   node tools/test-dialogs-qr-focus.mjs
import assert from "node:assert/strict";

// --- fake DOM ----------------------------------------------------------------------------------
function parseSelector(part) {
  const tag = /^[a-z]+/i.exec(part)?.[0]?.toUpperCase() || null;
  const required = [];
  const excluded = [];
  for (const m of part.matchAll(/(:not\()?\[([\w-]+)(?:="([^"]*)")?\]\)?/g)) (m[1] ? excluded : required).push([m[2], m[3]]);
  return { tag, required, excluded };
}
const hasAttr = (el, [name, value]) => name in el.attrs && (value === undefined || el.attrs[name] === value);
function matches(el, selector) {
  return selector.split(",").map((s) => s.trim()).filter(Boolean).some((part) => {
    const { tag, required, excluded } = parseSelector(part);
    if (tag && el.tagName !== tag) return false;
    return required.every((a) => hasAttr(el, a)) && !excluded.some((a) => hasAttr(el, a));
  });
}
class El {
  constructor(tag, attrs = {}) {
    this.tagName = tag.toUpperCase();
    this.attrs = { ...attrs };
    this.children = [];
    this.parent = null;
    this.listeners = {};
    this.hidden = false;
    this.style = {};
    this.className = "";
    this.textContent = "";
    this.value = "";
    this.classList = { toggle() {}, add() {}, remove() {} };
  }
  get dataset() {
    const out = {};
    for (const [k, v] of Object.entries(this.attrs)) if (k.startsWith("data-")) out[k.slice(5).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = v;
    return out;
  }
  get isConnected() { let n = this; while (n.parent) n = n.parent; return n === document.body || n === document.documentElement; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  appendChild(child) { child.parent = this; this.children.push(child); return child; }
  append(...children) { children.forEach((child) => this.appendChild(child)); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); this.parent = null; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== fn); }
  focus() { document.activeElement = this; }
  contains(other) { for (let n = other; n; n = n.parent) if (n === this) return true; return false; }
  getClientRects() { return this.hidden ? [] : [{}]; }
  matches(selector) { return /input|textarea/.test(selector) && (this.tagName === "INPUT" || this.tagName === "TEXTAREA"); }
  closest(selector) { for (let n = this; n && n.attrs; n = n.parent) if (matches(n, selector)) return n; return null; }
  querySelectorAll(selector) {
    const out = [];
    const walk = (node) => { for (const child of node.children) { if (matches(child, selector)) out.push(child); walk(child); } };
    walk(this);
    return out;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  // Only the controls and the dialog body matter here; they are created flat under this node.
  set innerHTML(html) {
    this.children = [];
    for (const m of String(html).matchAll(/<(button|input|div)\b([^>]*)>/g)) {
      const attrs = {};
      for (const a of m[2].matchAll(/([\w-]+)(?:="([^"]*)")?/g)) attrs[a[1]] = a[2] ?? "";
      if (m[1] === "div" && !("data-app-dialog-body" in attrs)) continue;
      const child = new El(m[1], attrs);
      this.appendChild(child);
    }
  }
  getContext() { return { drawImage() {}, getImageData: () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 }) }; }
  play() { return Promise.resolve(); }
  pause() {}
}
function dispatch(target, type, init = {}) {
  const event = {
    type, target, defaultPrevented: false, stopped: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this.stopped = true; },
    ...init,
  };
  // capture on the document first, then bubble from the target
  for (const fn of document.captureListeners[type] || []) { fn(event); }
  for (let n = target; n && !event.stopped; n = n.parent) {
    for (const fn of n.listeners[type] || []) fn(event);
    if (typeof n[`on${type}`] === "function") n[`on${type}`](event);
  }
  if (!event.stopped) for (const fn of document.bubbleListeners[type] || []) fn(event);
  return event;
}

const body = new El("body");
const document = {
  body,
  documentElement: new El("html"),
  activeElement: body,
  visibilityState: "visible",
  captureListeners: {},
  bubbleListeners: {},
  createElement: (tag) => new El(tag),
  addEventListener(type, fn, capture) { ((capture ? this.captureListeners : this.bubbleListeners)[type] ||= []).push(fn); },
  removeEventListener(type, fn, capture) { const map = capture ? this.captureListeners : this.bubbleListeners; map[type] = (map[type] || []).filter((f) => f !== fn); },
};
globalThis.document = document;
let coarsePointer = false;
const rafQueue = [];
globalThis.window = globalThis;
globalThis.isSecureContext = true;
globalThis.matchMedia = () => ({ matches: coarsePointer });
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.requestAnimationFrame = (fn) => { rafQueue.push(fn); return rafQueue.length; };
globalThis.cancelAnimationFrame = () => {};

const dialogs = await import("../ui/dialogs.js");

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`ok - ${name}`); }
  catch (error) { console.error(`not ok - ${name}`); throw error; }
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const dialogHost = () => body.children.find((c) => c.className === "modal-backdrop app-dialog-backdrop");
const dialogBody = () => dialogHost().querySelector("[data-app-dialog-body]");

// --- dialogs -----------------------------------------------------------------------------------
await test("dialogs: a choice sheet focuses itself, Escape closes it there, the opener gets the focus back", async () => {
  const opener = body.appendChild(new El("button"));
  opener.focus();
  const result = dialogs.chooseDialog({ title: "Pick", options: [{ id: "a", title: "A" }, { id: "b", title: "B" }] });
  assert.equal(document.activeElement, dialogBody(), "the sheet has the focus, not the opener");
  const event = dispatch(document.activeElement, "keydown", { key: "Escape" });
  assert.equal(event.defaultPrevented, true);
  assert.equal(event.stopped, true, "the page's own Escape doesn't see it");
  assert.equal(await result, null);
  assert.equal(dialogHost().hidden, true);
  assert.equal(document.activeElement, opener);
});

await test("dialogs: a confirm focuses OK; Tab wraps from the last control to the first and back", async () => {
  const opener = body.appendChild(new El("button"));
  opener.focus();
  const result = dialogs.confirmDialog({ title: "Sure?" });
  const ok = dialogHost().querySelector("[data-app-dialog-ok]");
  assert.equal(document.activeElement, ok);
  const items = dialogHost().querySelectorAll("button");
  assert.equal(items.at(-1), ok);
  const forward = dispatch(ok, "keydown", { key: "Tab" });
  assert.equal(forward.defaultPrevented, true);
  assert.equal(document.activeElement, items[0], "wrapped to the first control");
  dispatch(items[0], "keydown", { key: "Tab", shiftKey: true });
  assert.equal(document.activeElement, ok, "and back to the last");
  // A Tab between them is left to the browser.
  items[1].focus();
  assert.equal(dispatch(items[1], "keydown", { key: "Tab" }).defaultPrevented, false);
  dispatch(document.activeElement, "keydown", { key: "Escape" });
  assert.equal(await result, false);
  assert.equal(document.activeElement, opener);
});

await test("dialogs: Shift+Tab from the focused sheet goes to its last option", async () => {
  const opener = body.appendChild(new El("button"));
  opener.focus();
  const result = dialogs.chooseDialog({ title: "Pick", options: [{ id: "a", title: "A" }, { id: "b", title: "B" }] });
  dispatch(dialogBody(), "keydown", { key: "Tab", shiftKey: true });
  assert.equal(document.activeElement.attrs["data-app-dialog-choice"], "b");
  dispatch(document.activeElement, "click");
  assert.equal(await result, "b");
});

await test("dialogs: no focus jump into a text field on a touch screen", async () => {
  coarsePointer = true;
  const field = body.appendChild(new El("textarea"));
  field.focus();
  const result = dialogs.alertDialog({ title: "Note" });
  dispatch(document.activeElement, "keydown", { key: "Escape" });
  await result;
  assert.notEqual(document.activeElement, field, "the keyboard isn't raised by itself");
  coarsePointer = false;
});

await test("dialogs: a dialog opened over another answers the first one as cancelled (it never hangs)", async () => {
  const opener = body.appendChild(new El("button"));
  opener.focus();
  let firstDone = false;
  const first = dialogs.confirmDialog({ title: "Send it?" }).then((value) => { firstDone = true; return value; });
  const second = dialogs.chooseDialog({ title: "Pick", options: [{ id: "a", title: "A" }] });
  await flush();
  assert.equal(firstDone, true, "the replaced confirm settled");
  assert.equal(await first, false, "as a cancel, never as a yes");
  dispatch(dialogHost().querySelector("[data-app-dialog-choice]"), "click");
  assert.equal(await second, "a", "the dialog on screen still answers for itself");
  assert.equal(document.activeElement, opener, "the first opener gets the focus back");
});

// --- qr-scan -----------------------------------------------------------------------------------
const pending = [];
const streams = [];
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: { mediaDevices: { getUserMedia: () => new Promise((resolve, reject) => pending.push({ resolve, reject })) } },
});
function grant(index) {
  const stream = { id: index, tracks: [{ stopped: false, stop() { this.stopped = true; } }], getTracks() { return this.tracks; } };
  streams[index] = stream;
  pending[index].resolve(stream);
  return stream;
}
const { scanQrCode } = await import("../ui/qr-scan.js");
const scanner = () => body.children.find((c) => c.className === "cold-scan-modal");
const button = (text) => scanner().querySelectorAll("button").find((b) => b.textContent === text);

function retryDuringPrompt() {
  pending.length = 0;
  rafQueue.length = 0;
  const result = scanQrCode({});
  assert.equal(pending.length, 1, "first camera start waits on the prompt");
  dispatch(button("Enter it manually"), "click");
  dispatch(button("Try the camera again"), "click");
  assert.equal(pending.length, 2, "second start");
  return { result };
}

await test("qr: the first start resolving late is stopped; only the retry's camera and loop run", async () => {
  const { result } = retryDuringPrompt();
  const first = grant(0);
  await flush();
  assert.equal(first.tracks[0].stopped, true, "superseded stream stopped");
  assert.equal(rafQueue.length, 0, "no loop for it");
  const second = grant(1);
  await flush();
  assert.equal(second.tracks[0].stopped, false);
  assert.equal(rafQueue.length, 1, "one frame loop");
  const video = scanner().querySelectorAll("video")[0] || scanner().children.flatMap((c) => c.children).find((c) => c.tagName === "VIDEO");
  assert.equal(video.srcObject, second);
  dispatch(body, "keydown", { key: "Escape" });
  assert.equal(await result, null);
  assert.equal(second.tracks[0].stopped, true, "closing releases it");
});

await test("qr: the retry resolving first keeps its camera when the old one lands after", async () => {
  const { result } = retryDuringPrompt();
  const second = grant(1);
  await flush();
  const first = grant(0);
  await flush();
  assert.equal(first.tracks[0].stopped, true);
  assert.equal(second.tracks[0].stopped, false, "the live camera isn't torn down by the stale start");
  assert.equal(rafQueue.length, 1);
  dispatch(body, "keydown", { key: "Escape" });
  assert.equal(await result, null);
  assert.equal(second.tracks[0].stopped, true);
});

console.log(`\n${passed} passed`);
