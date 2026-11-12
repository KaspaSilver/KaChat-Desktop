// A send the network never answered offers no Retry anywhere (iOS e5a9b11): KaPost posts, room
// messages and reactions, instant tips; plus the room and .kachat-name fixes that came with it.
// Run: node tools/test-send-outcome-unknown-ui.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sendOutcomeUnknownError, SEND_OUTCOME_UNKNOWN_MESSAGE } from "../engine/transactions.js";
import { kapostsFailureDelivery, kapostsSubmitWithUtxoRetry } from "../ui/kaposts-format.js";
import { settleLeftoverRoomRows } from "../ui/leftover-sends.js";
import { identityBatchFlush, emptyKachatIdentity, IDENTITY_BATCH_DELAY_MS } from "../ui/kachat-unnamed-sweep.js";
import { isSendOutcomeUnknownText, NOT_CONFIRMED_ON_DEVICE } from "../ui/send-kaspa-components.js";

const unknown = sendOutcomeUnknownError("t");

// --- The swipe-up screen's "Not confirmed" -------------------------------------------------------
assert.ok(isSendOutcomeUnknownText(SEND_OUTCOME_UNKNOWN_MESSAGE));
assert.ok(isSendOutcomeUnknownText(`${SEND_OUTCOME_UNKNOWN_MESSAGE} (1 of 3 compound transactions were sent)`), "a chunked Compound with an unknown later chunk");
assert.ok(!isSendOutcomeUnknownText("Insufficient funds"));
assert.ok(!isSendOutcomeUnknownText(NOT_CONFIRMED_ON_DEVICE), "turned down on the device: nothing was sent, so Try Again");
assert.ok(!isSendOutcomeUnknownText(null));

// --- KaPost delivery ---------------------------------------------------------------------------
assert.equal(kapostsFailureDelivery(unknown), "unconfirmed");
assert.equal(kapostsFailureDelivery(new Error("Insufficient funds")), "failed");
assert.equal(kapostsFailureDelivery(null), "failed");

{
  let calls = 0;
  await assert.rejects(kapostsSubmitWithUtxoRetry(async () => { calls += 1; throw unknown; }, { delayMs: 0 }), (e) => e === unknown);
  assert.equal(calls, 1, "an unknown outcome is never sent again");
}
{
  let calls = 0;
  const retried = [];
  const txid = await kapostsSubmitWithUtxoRetry(async () => { calls += 1; if (calls < 3) throw new Error("utxo already spent"); return "tx"; },
    { delayMs: 0, onRetry: (attempt) => retried.push(attempt) });
  assert.equal(txid, "tx");
  assert.deepEqual(retried, [1, 2]);
}
{
  let calls = 0;
  await assert.rejects(kapostsSubmitWithUtxoRetry(async () => { calls += 1; throw new Error("nope"); }, { delayMs: 0 }), /nope/);
  assert.equal(calls, 5, "the first try and four retries");
}
{
  // a retry that ends unknown stops there
  let calls = 0;
  await assert.rejects(kapostsSubmitWithUtxoRetry(async () => { calls += 1; throw calls === 1 ? new Error("orphan") : unknown; }, { delayMs: 0 }), (e) => e === unknown);
  assert.equal(calls, 2);
}

// --- Room rows left pending by an earlier run --------------------------------------------------
{
  const me = "kaspa:me";
  const t = 10_000_000;
  const rows = [
    { txId: "pending-a", senderAddress: me, content: "hi", blockTime: t, status: "pending" },
    { txId: "tx-a", senderAddress: me, content: "hi", blockTime: t - 200_000 }, // its copy, chain time a little earlier
    { txId: "pending-b", senderAddress: me, content: "never went", blockTime: t, status: "pending" },
    { txId: "pending-c", senderAddress: me, content: "old", blockTime: t, status: "pending" },
    { txId: "tx-c", senderAddress: me, content: "old", blockTime: t - 400_000 }, // too early to be its copy
    { txId: "pending-d", senderAddress: me, content: "theirs", blockTime: t, status: "pending" },
    { txId: "tx-d", senderAddress: "kaspa:them", content: "theirs", blockTime: t }, // someone else's
    { txId: "pending-e", senderAddress: me, content: "this run", blockTime: t, status: "pending" },
    { txId: "pending-f", senderAddress: me, content: "copy failed too", blockTime: t, status: "pending" },
    { txId: "pending-g", senderAddress: me, content: "copy failed too", blockTime: t, status: "failed" }, // not a sent copy
  ];
  const changed = settleLeftoverRoomRows(rows, { keeping: new Set(["pending-e"]) });
  assert.equal(changed, 5);
  const byId = Object.fromEntries(rows.map((r) => [r.txId, r]));
  assert.equal(byId["pending-a"], undefined, "the delivered copy replaces it");
  // It may have landed while the app was closed: Not confirmed, no Retry (iOS 33095ac).
  assert.equal(byId["pending-b"].status, "unconfirmed", "no Retry that could pay twice");
  assert.equal(byId["pending-c"].status, "unconfirmed");
  assert.equal(byId["pending-d"].status, "unconfirmed");
  assert.equal(byId["pending-e"].status, "pending", "this run's send is still being worked on");
  assert.equal(byId["pending-f"].status, "unconfirmed");
  assert.equal(settleLeftoverRoomRows(rows, { keeping: new Set(["pending-e"]) }), 0, "nothing left to settle");
}

// --- .kachat names in batches ------------------------------------------------------------------
assert.equal(IDENTITY_BATCH_DELAY_MS, 150);
assert.deepEqual(emptyKachatIdentity("kaspa:x"), { address: "kaspa:x", label: null, names: [], profile: null });
{
  const stored = new Map();
  let notified = 0;
  const looked = [];
  const result = await identityBatchFlush(["kaspa:a", "kaspa:b"], {
    batch: async (keys) => { assert.deepEqual(keys, ["kaspa:a", "kaspa:b"]); return new Map([["kaspa:a", { address: "kaspa:a", label: "alice", names: ["alice"], profile: null }]]); },
    store: (key, identity) => { stored.set(key, identity); return true; },
    notify: () => { notified += 1; },
    lookUp: (key) => { looked.push(key); },
  });
  assert.equal(result, "batch");
  assert.equal(stored.get("kaspa:a").label, "alice");
  assert.deepEqual(stored.get("kaspa:b"), emptyKachatIdentity("kaspa:b"), "left out of the answer: no names, no profile");
  assert.equal(notified, 1, "one notify for the whole batch");
  assert.deepEqual(looked, []);
}
{
  let notified = 0;
  const result = await identityBatchFlush(["kaspa:a"], {
    batch: async () => new Map(), store: () => false, notify: () => { notified += 1; }, lookUp: () => {},
  });
  assert.equal(result, "batch");
  assert.equal(notified, 0, "nothing changed, nothing to tell");
}
for (const failing of [async () => null, async () => { throw new Error("down"); }]) {
  const looked = [];
  const result = await identityBatchFlush(["kaspa:a", "kaspa:b"], {
    batch: failing, store: () => { throw new Error("not on a failed batch"); }, notify: () => {},
    lookUp: async (key) => { looked.push(key); if (key === "kaspa:b") throw new Error("one lookup failing doesn't stop the others"); },
  });
  assert.equal(result, "each");
  assert.deepEqual(looked.sort(), ["kaspa:a", "kaspa:b"], "a failed batch: one lookup per address");
}
assert.equal(await identityBatchFlush([], { batch: () => { throw new Error("no"); } }), "none");

// --- Wiring (the pieces above are only as good as their callers) --------------------------------
const kaposts = readFileSync(new URL("../ui/kaposts.js", import.meta.url), "utf8");
assert.doesNotMatch(kaposts, /p\.delivery = "failed"/, "every post failure goes through kapostsFailureDelivery");
assert.equal((kaposts.match(/p\.delivery = kapostsFailureDelivery\(error\)/g) || []).length, 6,
  "schedulePost, schedulePoll, continueThread, scheduleQuote, submitReply and retryPost");
assert.match(kaposts, /post\.delivery === "unconfirmed"[\s\S]{0,200}kaposts-delivery unconfirmed[\s\S]{0,400}Not confirmed/);
assert.match(kaposts, /It may have gone through\. Check before posting it again\./);
assert.match(kaposts, /function retryPost\(post\) \{[\s\S]{0,200}if \(post\?\.delivery !== "failed"\) return;/, "no Retry for a post not confirmed");
assert.match(kaposts, /async function refreshScheduledFromServer\(\) \{[\s\S]{0,200}if \(!scheduledPosts\.some\(\(entry\) => entry\.onServer\)\) return;/);
assert.match(kaposts, /NOTIFICATIONS_FRESH_MS = 120 \* 1000/);
assert.match(kaposts, /PROFILE_FRESH_MS = 5 \* 60 \* 1000/);

const css = readFileSync(new URL("../ui/styles.css", import.meta.url), "utf8");
assert.match(css, /\.kaposts-delivery\.unconfirmed \{[^}]*color: var\(--ios-orange\)/);

const rooms = readFileSync(new URL("../ui/broadcasts.js", import.meta.url), "utf8");
assert.match(rooms, /showBubble && error\?\.code === SEND_OUTCOME_UNKNOWN\) \{[\s\S]{0,400}markRoomRowUnconfirmed\(messageCache\[channel\], pendingId, error\.txid\)/, "a room message not confirmed shows Not confirmed (iOS 33095ac)");
assert.match(rooms, /pendingSendsThisRun\.add\(pendingId\)/);
assert.match(rooms, /settledPendingRooms\.clear\(\)/, "an account switch checks the rooms again");
assert.match(rooms, /if \(error\?\.code === SEND_OUTCOME_UNKNOWN\) \{[\s\S]{0,300}return;\s*\}\s*\/\/ No toast \(iOS\): the pill turns red/, "a reaction not confirmed is not marked failed");
assert.match(rooms, /Not enough KAS on your Chatting Address\. Add some and try again\./);
assert.match(rooms, /newestKey !== lastRenderedNewestKey && newest\?\.senderAddress === deps\.engine\.address/, "rooms keep your place");

const app = readFileSync(new URL("../ui/app.js", import.meta.url), "utf8");
const tipUser = app.slice(app.indexOf("tipUser: async"), app.indexOf("kaPostsCooldownEnabled,", app.indexOf("tipUser: async")));
assert.match(tipUser, /instantTipsInFlight\.has\(inFlightKey\)\) return;/);
assert.match(tipUser, /finally \{\s*instantTipsInFlight\.delete\(inFlightKey\);/);
assert.match(tipUser, /error\?\.code === SEND_OUTCOME_UNKNOWN\) \{[\s\S]{0,300}showKaPostsActionToast\(SEND_OUTCOME_UNKNOWN_MESSAGE\);\s*return;/, "no amount screen after an unknown outcome");
assert.match(tipUser, /there is no recent KAS price to turn/);
assert.doesNotMatch(app, /no KAS price yet/);
const tipAvailable = app.slice(app.indexOf("async function tipLoadAvailable"), app.indexOf("function tipSetSource"));
assert.match(tipAvailable, /excludeReservedUtxos\(balance\?\.entries \|\| \[\]\)/, "coins a scheduled post holds aren't Available");

const live = readFileSync(new URL("../ui/kachat-names-live.js", import.meta.url), "utf8");
assert.match(live, /if \(stale && !identityLookups\.has\(key\)\) queueIdentityLookup\(registry, key\);/);
assert.match(live, /batch: \(list\) => registry\.identities\(list\)/);

// A message, payment or group message not confirmed: its own status with its txid, never Retry.
const between = (from, to) => app.slice(app.indexOf(from), app.indexOf(to, app.indexOf(from)));
assert.match(app, /const MESSAGE_STATUS_UNCONFIRMED = "unconfirmed";/);
const failurePatch = between("function sendFailurePatch", "\n}\n");
assert.match(failurePatch, /error\?\.code === SEND_OUTCOME_UNKNOWN[\s\S]{0,80}status: MESSAGE_STATUS_UNCONFIRMED, \.\.\.\(error\.txid \? \{ txid: String\(error\.txid\) \}/, "the txid stays");
const pipeline = between("async function runEngineSendPipeline", "function describeThrown");
assert.match(pipeline, /if \(error\?\.code === SEND_OUTCOME_UNKNOWN\) \{[\s\S]{0,300}updateMessageStatus\(conversationId, messageId, sendFailurePatch\(error\)\);[\s\S]{0,200}return;/, "a 1:1 message not confirmed is not FAILED");
assert.equal((app.match(/applyMessagePatch\(liveMessage, sendFailurePatch\(error, error\.message\)\)/g) || []).length, 3, "chat payment, tip sheet and instant tip");
assert.doesNotMatch(app, /applyMessagePatch\(liveMessage, \{ status: MESSAGE_STATUSES\.FAILED, note: error\.message \}\)/);
assert.equal((app.match(/unknown \? groupUnconfirmedPatch\(error\) : \{ status: MESSAGE_STATUSES\.FAILED \}/g) || []).length, 3, "group send, group retry and a note's parts in order");
const statusIcon = between("function createDeliveryStatusIcon", "const LONG_MESSAGE_BYTES");
assert.match(statusIcon, /const failed = status === MESSAGE_STATUSES\.FAILED;/, "only FAILED is the retry button");
assert.match(statusIcon, /status === MESSAGE_STATUS_UNCONFIRMED\) \{[\s\S]{0,700}word = "Not confirmed";/);
assert.match(app, /chat-row-delivery-word warning">Not confirmed</);
// ...and sent once the network has it: a sync looks it up, a group's chain copy settles it.
const settle = between("async function settleUnconfirmedSends", "async function refreshPendingPaymentStatuses");
assert.match(settle, /isTransactionKnown\(\{ withRpc: engine\.withRpc\.bind\(engine\), txid \}\)/);
assert.match(settle, /status: MESSAGE_STATUSES\.CONFIRMED/);
const refreshPayments = between("async function refreshPendingPaymentStatuses", "function normalizeKasAmount");
assert.match(refreshPayments, /message\.status !== MESSAGE_STATUS_UNCONFIRMED\s*\);\s*if \(await settleUnconfirmedSends\(conversationEntry, contact\)\) changed = true;/, "an unconfirmed payment isn't marked sent just for its txid");
assert.match(between("function appendGroupMessage(", "function dedupeStoredGroupMessages"), /existing\.status === MESSAGE_STATUS_UNCONFIRMED && message\.txId[\s\S]{0,120}existing\.status = MESSAGE_STATUSES\.CONFIRMED;/);

// Max checks the coins by the engine's rules (largest 80, just-spent left out): tests/test-amounts.mjs.
assert.match(between("function maxCoinKeys", "function sameCoinKeys"), /return maxSendOutpointKeys\(entries \|\| \[\], manualKeys\);/);

// The tip sheet is busy before its first await (the swipe-up screen fails a send not busy in 600 ms).
const tipSend = between("async function sendTipNow", "\n  // The chat with the poster is created HERE");
const firstAwait = tipSend.indexOf("await ");
assert.ok(tipSend.indexOf("tip.sending = true;") > 0 && tipSend.indexOf("tip.sending = true;") < firstAwait, "busy before the first await");
assert.match(tipSend, /const refuse = async \(reason, \{ refreshMax = false \} = \{\}\) => \{\s*if \(refreshMax && tipState === tip\) await tipSetMax\(\{ force: true \}\);\s*tip\.sending = false;/);
assert.match(app, /async function tipSetMax\(\{ force = false \} = \{\}\) \{[\s\S]{0,120}\(tip\.sending && !force\)\) return;/);

// A failed Max fill puts the fee back; the SDK base is 100 sompi/gram of the mass, not 1.
const maxFill = between("async function fillMaxAmountNow", "function sendKaspaSelectionKey");
assert.match(maxFill, /sendKaspaSdkBaseKas = Number\(calculateFee\(mass, MIN_RELAY_FEE_PER_GRAM\)\) \/ 1e8;/);
assert.doesNotMatch(maxFill, /sendKaspaSdkBaseKas = Number\(mass\) \/ 1e8/);
assert.match(maxFill, /catch \(error\) \{[^}]*setSendKaspaError[^\n]*\n\s*restoreFee\(\);\s*return;/);
assert.match(maxFill, /const restoreFee = \(\) => \{\s*if \(token !== sendKaspaMaxToken \|\| sendKaspaMaxMode\) return;\s*sendKaspaBaseFeeKas = feeBefore\.base;\s*sendKaspaSdkBaseKas = feeBefore\.sdkBase;\s*applySendKaspaFeeField\(\);\s*scheduleSendKaspaFeeEstimate\(\);/);

assert.ok(SEND_OUTCOME_UNKNOWN_MESSAGE.startsWith("This may have gone through"));
console.log("send outcome unknown (ui): ok");
