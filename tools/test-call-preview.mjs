// The chat list's call line (iOS ConversationRow.formatPreview): only the reasons iOS names.
import assert from "node:assert/strict";
import { callPreviewText } from "../ui/calls.js";

assert.equal(callPreviewText({ type: "call_request", video: true }, true), "📹 Video call");
assert.equal(callPreviewText({ type: "call_invite", video: false }, false), "📞 Voice call");
assert.equal(callPreviewText({ type: "call_response", reason: "no_host" }, false), "📞 Calls need Nextcloud Talk");
assert.equal(callPreviewText({ type: "call_response", accepted: true }, false), "📞 Call answered");
assert.equal(callPreviewText({ type: "call_response", accepted: false }, false), "📞 Call declined");
assert.equal(callPreviewText({ type: "call_end", durationSeconds: 75 }, true), "📞 Call · 1:15");
assert.equal(callPreviewText({ type: "call_end", reason: "no_answer" }, true), "📞 Missed call");
assert.equal(callPreviewText({ type: "call_end", reason: "cancelled" }, true), "📞 Missed call");
assert.equal(callPreviewText({ type: "call_end", reason: "declined" }, true), "📞 Call declined");
// No Desktop-only end reasons: anything else is just "Call ended".
for (const reason of ["missed", "no_host", "failed", "hangup", undefined]) {
  assert.equal(callPreviewText({ type: "call_end", reason }, true), "📞 Call ended");
}
console.log("call preview: ok");
