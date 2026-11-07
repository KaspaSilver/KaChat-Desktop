// Public-room sends are bound to the account that pressed Send (ui/broadcasts.js
// enqueueBroadcastSend). Sends go through one queue so their coin picks can't race; each task signs
// with whatever key the engine holds when its turn comes, so a message, reaction or edit queued
// behind another when the account switched went out as the new account. Run from its own source
// with the page stubbed:
//
//   node tools/test-room-send-account.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { accountGuard } from "../ui/account-guard.js";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "..", "ui", "broadcasts.js"), "utf8");

// The queue: from `let sendQueue` through the end of enqueueBroadcastSend.
const start = src.indexOf("let sendQueue = Promise.resolve();");
const fnStart = src.indexOf("function enqueueBroadcastSend(", start);
assert.ok(start >= 0 && fnStart > start, "the room send queue in the source");
let depth = 0;
let end = -1;
for (let i = src.indexOf("{", fnStart); i < src.length; i += 1) {
  if (src[i] === "{") depth += 1;
  else if (src[i] === "}") { depth -= 1; if (depth === 0) { end = i + 1; break; } }
}
const code = src.slice(start, end);
const make = new Function("accountGuard", "deps", `${code}\nreturn { enqueueBroadcastSend, ROOM_SEND_ACCOUNT_CHANGED };`);

const deps = { engine: { address: "kaspa:qa" } };
const { enqueueBroadcastSend, ROOM_SEND_ACCOUNT_CHANGED } = make(accountGuard, deps);

const signedBy = [];
let releaseFirst;
const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
// Signs (reads the key) when the task starts, as sendBroadcastMessage does.
const send = (label) => async () => { signedBy.push([label, deps.engine.address]); if (label === "first") await firstGate; return `tx-${label}`; };

// Account A queues three: the first is on the wire, two wait behind it.
const first = enqueueBroadcastSend(send("first"));
const second = enqueueBroadcastSend(send("second"));
const reaction = enqueueBroadcastSend(send("reaction"));
await Promise.resolve();

// The account switches while the first is still going out.
deps.engine.address = "kaspa:qb";
releaseFirst();

assert.equal(await first, "tx-first", "the send already under way finishes as A's");
await assert.rejects(second, (e) => e.code === ROOM_SEND_ACCOUNT_CHANGED, "a queued message is dropped");
await assert.rejects(reaction, (e) => e.code === ROOM_SEND_ACCOUNT_CHANGED, "a queued reaction is dropped");
assert.deepEqual(signedBy, [["first", "kaspa:qa"]], "nothing went out signed by B");

// B's own sends go through as before, the queue not stuck on the dropped ones.
assert.equal(await enqueueBroadcastSend(send("b")), "tx-b");
assert.deepEqual(signedBy.at(-1), ["b", "kaspa:qb"]);

// With no account at all, nothing is sent.
deps.engine.address = "";
await assert.rejects(enqueueBroadcastSend(send("none")), (e) => e.code === ROOM_SEND_ACCOUNT_CHANGED);

// The reaction Retry and the reset (source checks: their closures need the whole page).
const reactionFn = src.slice(src.indexOf("async function sendBroadcastReaction("), src.indexOf("function setBroadcastReactionStatus("));
assert.match(reactionFn, /const owner = accountGuard\([^)]*\)[^;]*;\s*(?:\/\/[^\n]*\n\s*)*const attempt = async \(\) => \{\s*if \(!owner\.still\(\)\) return;/,
  "a reaction's Retry only runs for the account that reacted");
assert.match(reactionFn, /error\?\.code === ROOM_SEND_ACCOUNT_CHANGED/, "a dropped reaction leaves no red mark");
const reset = src.slice(src.indexOf("export function resetBroadcastsForAccount("), src.indexOf("const SWEEP_MS"));
assert.match(reset, /broadcastReactionStatus\.clear\(\)/, "the reaction marks (and their Retry) go with the account");

console.log("room send account: all checks passed");
