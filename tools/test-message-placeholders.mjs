// node tools/test-message-placeholders.mjs - the placeholders a 1:1 chat never shows (ui/message-
// placeholders.js, iOS c130dc1 ChatMessage.isHiddenPlaceholder): which bodies are hidden, the
// chat-list preview skipping them, and when a readable copy replaces one. Nothing leaves the machine.
import assert from "node:assert/strict";
import {
  SENT_PLACEHOLDER, UNREADABLE_PLACEHOLDER, isSentPlaceholder, isHiddenPlaceholder,
  isHiddenPlaceholderMessage, newestVisibleMessage, upgradesPlaceholder,
} from "../ui/message-placeholders.js";

let pass = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("the two placeholder bodies are exactly iOS's", () => {
  assert.equal(SENT_PLACEHOLDER, "📤 Sent via another device");
  assert.equal(UNREADABLE_PLACEHOLDER, "[Encrypted message]");
});

test("both placeholders are hidden; anything else is not", () => {
  assert.equal(isHiddenPlaceholder("📤 Sent via another device"), true);
  assert.equal(isHiddenPlaceholder("[Encrypted message]"), true);
  assert.equal(isSentPlaceholder("📤 Sent via another device"), true);
  assert.equal(isSentPlaceholder("[Encrypted message]"), false, "the cross-device check stays narrow");
  for (const text of ["", "hello", "[Encrypted message] ", " [Encrypted message]", "[encrypted message]", "[Encrypted message]!", "Sent via another device", null, undefined]) {
    assert.equal(isHiddenPlaceholder(text), false, JSON.stringify(text));
  }
  assert.equal(isHiddenPlaceholderMessage({ text: "[Encrypted message]" }), true);
  assert.equal(isHiddenPlaceholderMessage({ text: "hi" }), false);
  assert.equal(isHiddenPlaceholderMessage(null), false);
});

test("the chat-list preview is the newest visible message, first among equals", () => {
  const a = { id: "a", text: "first", createdAt: 100 };
  const b = { id: "b", text: "[Encrypted message]", createdAt: 300 };
  const c = { id: "c", text: "📤 Sent via another device", createdAt: 400 };
  const d = { id: "d", text: "second", createdAt: 200 };
  const e = { id: "e", text: "tie", createdAt: 200 };
  assert.equal(newestVisibleMessage([a, b, c, d, e]).id, "d", "placeholders never claim the preview; a tie keeps the first");
  assert.equal(newestVisibleMessage([b, c]), null, "only placeholders: no preview at all");
  assert.equal(newestVisibleMessage([]), null);
  assert.equal(newestVisibleMessage(undefined), null);
  assert.equal(newestVisibleMessage([d, null, a]).id, "d", "order of the array does not matter");
});

test("a readable copy replaces a placeholder; nothing else does", () => {
  const unreadable = { txid: "t1", text: "[Encrypted message]" };
  const crossDevice = { txid: "t2", text: "📤 Sent via another device" };
  const real = { txid: "t3", text: "hello" };
  assert.equal(upgradesPlaceholder(unreadable, { text: "the real text" }), true);
  assert.equal(upgradesPlaceholder(crossDevice, { text: "what I sent" }), true);
  assert.equal(upgradesPlaceholder(unreadable, { text: "📤 Sent via another device" }), false, "a placeholder for a placeholder");
  assert.equal(upgradesPlaceholder(unreadable, { text: "[Encrypted message]" }), false);
  assert.equal(upgradesPlaceholder(unreadable, { text: "   " }), false, "an empty body is not text");
  assert.equal(upgradesPlaceholder(unreadable, {}), false);
  assert.equal(upgradesPlaceholder(real, { text: "edited?" }), false, "a real message is never replaced this way");
  assert.equal(upgradesPlaceholder(null, { text: "x" }), false);
  assert.equal(upgradesPlaceholder(unreadable, null), false);
});

for (const [name, fn] of tests) {
  try { await fn(); pass++; }
  catch (error) { console.error(`FAIL ${name}\n  ${error?.message || error}`); process.exitCode = 1; }
}
console.log(`message-placeholders: ${pass}/${tests.length} passed`);
