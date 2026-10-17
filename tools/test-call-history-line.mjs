// The thread's call line (iOS MessageBubbleView.callBubble): the iOS wording, only the reasons iOS names.
import assert from "node:assert/strict";
import { callHistoryLine } from "../ui/calls.js";

const text = (envelope, outgoing = false) => callHistoryLine(envelope, outgoing).text;
assert.equal(text({ type: "call_request", video: true }, true), "Video call started");
assert.equal(text({ type: "call_invite", video: false }, false), "Incoming voice call");
assert.equal(text({ type: "call_invite", video: false, viaRequest: true }, false), "Voice call ready");
assert.equal(text({ type: "call_response", reason: "no_host" }), "Calls need Nextcloud Talk on one side");
assert.equal(text({ type: "call_response", accepted: true }), "Call answered");
assert.equal(text({ type: "call_response", accepted: false }), "Call declined");
assert.equal(text({ type: "call_end", durationSeconds: 75 }), "Call · 1:15");
assert.equal(text({ type: "call_end", reason: "no_answer" }, true), "No answer");
assert.equal(text({ type: "call_end", reason: "no_answer" }, false), "Missed call");
assert.equal(text({ type: "call_end", reason: "cancelled" }, true), "Call cancelled");
assert.equal(text({ type: "call_end", reason: "failed" }), "Call failed");
assert.equal(text({ type: "call_end", reason: "declined" }), "Call declined");
for (const reason of ["missed", "no_host", "hangup", undefined]) {
  assert.equal(text({ type: "call_end", reason }), "Call ended");
  assert.equal(callHistoryLine({ type: "call_end", reason }, false).icon, "phone-down");
}
console.log("call history line: ok");
