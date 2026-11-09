// The KaPost audit fixes of iOS ee5ec98 not yet on Desktop. Run: node tools/test-kaposts-audit-remaining.mjs
//
// The logic lives in engine/kaposts.js and is driven directly. ui/kaposts.js and ui/broadcasts.js need
// a DOM, so only their wiring is checked, on the source text. Nothing leaves the machine.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  KAPOSTS_SCHEDULE_INDEXER_GRACE_MS, KAPOSTS_SCHEDULED_SENDING_SOON, KAPOSTS_SCHEDULED_ON_ITS_WAY, KAPOSTS_SCHEDULED_CANCEL_UNREACHED,
  KAPOSTS_DRAFT_SOURCE_LOADING, KAPOSTS_DRAFT_SOURCE_MISSING, KAPOSTS_THREAD_UNCONFIRMED_PROMPT,
  isScheduledPostRejection, scheduledPostsAwaitIndexer, applyScheduledOutcomes, submitDueScheduledPosts, cancelScheduledEntry,
  scheduledWaitingLine, submitScheduledLocally, draftSourceNotice, draftSourceIds, threadRemainderDraft, kapostOutcomeUnknown,
  settleFailedKaPostDelete, settleFailedKaPostEdit, restoreKaPostVote, restoreKaPostRepost, followingAfterFailedFollow,
  feedPageLeavesGap, hasMixedScripts, roomLinkJoinPrompt, recordRoomEdit, restoreRoomEdit, roomPollGapFloor,
} from "../engine/kaposts.js";
import { SEND_OUTCOME_UNKNOWN, sendOutcomeUnknownError } from "../engine/transactions.js";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const kaposts = read("ui/kaposts.js");
const broadcasts = read("ui/broadcasts.js");

/** The text of `function name(...) { ... }` in a source file, up to its closing brace at column 0. */
function fnText(source, name) {
  const start = source.search(new RegExp(`\\n(?:export )?(?:async )?function ${name}\\(`));
  assert.ok(start >= 0, `${name} is there`);
  return source.slice(start, source.indexOf("\n}\n", start) + 2);
}
function ordered(text, first, second, message) {
  const i = text.indexOf(first);
  assert.ok(i >= 0, `${message}: "${first}" is there`);
  assert.ok(text.indexOf(second, i) > i, `${message}: "${first}" comes before "${second}"`);
}

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const NOW = 1_800_000_000_000;
const entry = (over = {}) => ({ id: "a".repeat(64), text: "hi", notBefore: NOW - 1000, onServer: false, status: "scheduled", error: null, submittedAt: null, ...over });
/** One pass over `entries`; returns what it submitted and offered to the indexer. */
async function pass(entries, { submit = async () => "tx", handToIndexer = async () => {}, inFlight = new Set(), stillOurs } = {}) {
  const sent = [];
  const offered = [];
  const logged = [];
  const changed = await submitDueScheduledPosts({
    readEntries: () => entries, inFlight, now: NOW, stillOurs,
    submit: async (e) => { sent.push(e.id); return submit(e); },
    handToIndexer: async (e) => { offered.push(e.id); return handToIndexer(e); },
    log: (line) => logged.push(line),
  });
  return { sent, offered, changed, logged };
}

// --- 1. Past-due scheduled posts the indexer holds -----------------------------------------------

test("1: a post the indexer holds is left to it for 150 s past its time, then sent from here", async () => {
  assert.equal(KAPOSTS_SCHEDULE_INDEXER_GRACE_MS, 150_000);
  const inGrace = entry({ onServer: true, notBefore: NOW - 149_000 });
  assert.deepEqual((await pass([inGrace])).sent, []);
  assert.equal(inGrace.status, "scheduled");
  const stranded = entry({ onServer: true, notBefore: NOW - 150_000 });
  assert.deepEqual((await pass([stranded])).sent, [stranded.id]);
  assert.equal(stranded.status, "submitted");
  assert.equal(applyScheduledOutcomes([stranded], [{ txId: stranded.id, status: "failed", error: "already spent" }], new Set(), NOW), false, "a late indexer can't undo what went out from here");
  assert.equal(stranded.status, "submitted");
});

test("1: a future post the indexer holds is not sent; a local one is offered to it again", async () => {
  const held = entry({ onServer: true, notBefore: NOW + 60_000 });
  const local = entry({ id: "b".repeat(64), notBefore: NOW + 60_000 });
  const { sent, offered } = await pass([held, local]);
  assert.deepEqual(sent, []);
  assert.deepEqual(offered, [local.id]);
  assert.equal(local.onServer, true);
});

test("1: a connection that isn't up leaves it scheduled, its coins held; a node's refusal fails it", async () => {
  const offline = entry();
  const first = await pass([offline], { submit: async () => { throw new Error("websocket is not connected"); } });
  assert.equal(offline.status, "scheduled");
  assert.equal(first.changed, false);
  const refused = entry();
  await pass([refused], { submit: async () => { throw new Error("transaction rejected: mass too high"); } });
  assert.equal(refused.status, "failed");
  assert.match(refused.error, /mass/);
});

test("1: an unknown outcome stays scheduled: the same transaction can go again", async () => {
  const lost = entry();
  await pass([lost], { submit: async () => { throw sendOutcomeUnknownError(lost.id); } });
  assert.equal(lost.status, "scheduled");
});

test("1: a connection error carrying a rejection word is not a rejection", () => {
  // All of these matched the old NODE_REJECTION_RE, which froze the post as failed.
  for (const message of ["WebSocket is already in CLOSING or CLOSED state", "connection lost: invalid frame", "Request timed out: missing response", "Could not connect: host not found", "Failed to fetch: not found"]) {
    assert.equal(isScheduledPostRejection(new Error(message)), false, message);
  }
  assert.equal(isScheduledPostRejection(sendOutcomeUnknownError("x")), false);
  for (const message of ["orphan where orphan is disallowed", "fee too low: insufficient", "invalid signature", "This scheduled post cannot be rebuilt on this device. Cancel it and schedule again."]) {
    assert.equal(isScheduledPostRejection(new Error(message)), true, message);
  }
});

test("1: a failed connect is never read as a rejection, whatever it says", async () => {
  const engine = { connect: async () => { throw new Error("invalid WebSocket URL"); } };
  await assert.rejects(submitScheduledLocally({ engine, serialized: {} }), (error) => {
    assert.equal(error.notSubmitted, true);
    assert.equal(isScheduledPostRejection(error), false);
    return true;
  });
});

test("1: past-due posts the server doesn't know turn local; future ones and in-flight ones stay", async () => {
  const gone = entry({ onServer: true });
  const future = entry({ id: "b".repeat(64), onServer: true, notBefore: NOW + 60_000 });
  const busy = entry({ id: "c".repeat(64), onServer: true });
  assert.equal(applyScheduledOutcomes([gone, future, busy], [], new Set([busy.id]), NOW), true);
  assert.equal(gone.onServer, false);
  assert.equal(future.onServer, true);
  assert.equal(busy.onServer, true);
  assert.deepEqual((await pass([gone])).sent, [gone.id], "and the next pass sends it");
});

test("1: the server's outcome lands; an unknown status changes nothing", () => {
  const e = entry({ onServer: true });
  assert.equal(applyScheduledOutcomes([e], [{ txId: e.id, status: "failed", error: "spent" }], new Set(), NOW), true);
  assert.equal(e.status, "failed");
  const same = entry({ onServer: true });
  assert.equal(applyScheduledOutcomes([same], [{ txId: same.id, status: "weird" }], new Set(), NOW), false);
  assert.equal(same.status, "scheduled");
});

test("1: only a post the indexer holds past its time is worth asking about", () => {
  assert.equal(scheduledPostsAwaitIndexer([entry({ onServer: true })], NOW), true);
  assert.equal(scheduledPostsAwaitIndexer([entry({ onServer: true, notBefore: NOW + 1 })], NOW), false);
  assert.equal(scheduledPostsAwaitIndexer([entry()], NOW), false);
  assert.equal(scheduledPostsAwaitIndexer([entry({ onServer: true, status: "submitted" })], NOW), false);
});

test("1: a post already going out, or another account's pass, is left alone", async () => {
  const busy = entry();
  assert.deepEqual((await pass([busy], { inFlight: new Set([busy.id]) })).sent, []);
  assert.deepEqual((await pass([entry()], { stillOurs: () => false })).sent, []);
});

test("1: a post past its time reads as on its way, whoever holds it", () => {
  assert.equal(KAPOSTS_SCHEDULED_SENDING_SOON, "Sending as soon as the network answers");
  assert.equal(scheduledWaitingLine(entry({ onServer: true }), "Nov 9", NOW), KAPOSTS_SCHEDULED_SENDING_SOON);
  assert.equal(scheduledWaitingLine(entry(), "Nov 9", NOW), KAPOSTS_SCHEDULED_SENDING_SOON);
  assert.equal(scheduledWaitingLine(entry({ onServer: true, notBefore: NOW + 1 }), "Nov 9", NOW), "Goes out Nov 9");
  assert.equal(scheduledWaitingLine(entry({ notBefore: NOW + 1 }), "Nov 9", NOW), "Goes out Nov 9 - from this browser, so keep KaChat open around then");
});

test("1: wiring: outcomes are read first, and the panel sends what they turned local", () => {
  assert.doesNotMatch(kaposts, /NODE_REJECTION_RE/);
  ordered(fnText(kaposts, "sendDueScheduledNow"), "scheduledPostsAwaitIndexer(scheduledPosts)", "submitDueScheduledPosts(", "statuses before sending");
  const panel = fnText(kaposts, "refreshScheduledPanel");
  ordered(panel, "refreshScheduledFromServer()", "sendDueScheduled()", "a local send after the pull");
  assert.equal((panel.match(/sendDueScheduled\(\)/g) || []).length, 2);
  assert.match(fnText(kaposts, "scheduledPanelHtml"), /scheduledWaitingLine\(entry, when\)/);
});

// --- 2. A Cancel the indexer didn't hear ----------------------------------------------------------

async function cancel(entries, { cancelOnServer = async () => {}, inFlight = new Set() } = {}) {
  const removed = [];
  const asked = [];
  const problem = await cancelScheduledEntry({
    id: entries[0].id, readEntries: () => entries, inFlight,
    cancelOnServer: async (e) => { asked.push(e.id); return cancelOnServer(e); },
    remove: (e) => removed.push(e.id),
  });
  return { problem, removed, asked };
}

test("2: an indexer that didn't answer keeps the post scheduled and says so", async () => {
  const e = entry({ onServer: true, notBefore: NOW + 60_000 });
  const inFlight = new Set();
  const { problem, removed } = await cancel([e], { cancelOnServer: async () => { throw new Error("offline"); }, inFlight });
  assert.equal(problem, KAPOSTS_SCHEDULED_CANCEL_UNREACHED);
  assert.equal(problem, "Couldn't reach the server, so this post is still scheduled. Try again in a moment.");
  assert.deepEqual(removed, []);
  assert.equal(e.status, "scheduled");
  assert.equal(inFlight.size, 0, "the guard comes off");
});

test("2: a post going out can't be cancelled", async () => {
  const e = entry({ onServer: true });
  const { problem, removed, asked } = await cancel([e], { inFlight: new Set([e.id]) });
  assert.equal(problem, KAPOSTS_SCHEDULED_ON_ITS_WAY);
  assert.equal(problem, "This post is on its way right now, so it can't be cancelled.");
  assert.deepEqual([removed, asked], [[], []]);
});

test("2: a heard Cancel removes it; a local post has no one to tell", async () => {
  const held = entry({ onServer: true });
  const told = await cancel([held]);
  assert.deepEqual([told.problem, told.removed, told.asked], [null, [held.id], [held.id]]);
  const local = entry();
  const silent = await cancel([local]);
  assert.deepEqual([silent.problem, silent.removed, silent.asked], [null, [local.id], []]);
});

test("2: a cancel started first holds off a submit", async () => {
  const e = entry({ onServer: true, notBefore: NOW - 200_000 });
  const inFlight = new Set();
  let release;
  const running = cancelScheduledEntry({
    id: e.id, readEntries: () => [e], inFlight,
    cancelOnServer: () => new Promise((resolve) => { release = resolve; }), remove: () => {},
  });
  assert.deepEqual((await pass([e], { inFlight })).sent, []);
  release();
  assert.equal(await running, null);
});

test("2: wiring: the alert, and scheduling holds the guard", () => {
  const fn = fnText(kaposts, "cancelScheduledPost");
  assert.match(fn, /cancelScheduledEntry\(/);
  assert.match(fn, /inFlight: scheduledInFlight/);
  ordered(fn, "if (problem)", "deps.alertDialog", "the reason is shown");
  ordered(fnText(kaposts, "scheduleForLater"), "scheduledInFlight.add(entry.id)", "scheduledInFlight.delete(entry.id)", "the guard is held across the hand-over");
});

// --- 3. A draft whose source can't load -----------------------------------------------------------

test("3: the notice says loading, then not found; nothing is said once it loaded", () => {
  assert.equal(draftSourceNotice(null), null);
  assert.equal(draftSourceNotice({ failed: false }), KAPOSTS_DRAFT_SOURCE_LOADING);
  assert.equal(draftSourceNotice({ failed: false }), "Loading the post this draft is about...");
  assert.equal(draftSourceNotice({ failed: true }), KAPOSTS_DRAFT_SOURCE_MISSING);
  assert.equal(draftSourceNotice({ failed: true }), "The post this draft is about couldn't be found right now, so it can't be posted yet. It stays in your drafts.");
});

test("3: saving again keeps the ids of a source that never loaded", () => {
  const kept = { quotedRemoteId: null, replyRemoteId: "b".repeat(64) };
  assert.deepEqual(draftSourceIds({ kept }), { quotedRemoteId: null, replyRemoteId: "b".repeat(64) });
  assert.deepEqual(draftSourceIds({ kept: { quotedRemoteId: "c".repeat(64), replyRemoteId: null } }), { quotedRemoteId: "c".repeat(64), replyRemoteId: null });
  assert.deepEqual(draftSourceIds({ quoteTarget: { remoteId: "d" }, kept: null }), { quotedRemoteId: "d", replyRemoteId: null });
  assert.deepEqual(draftSourceIds({}), { quotedRemoteId: null, replyRemoteId: null });
});

test("3: wiring: Post stays off, the notice shows, and the ids are kept", () => {
  assert.match(fnText(kaposts, "renderComposerThreadUi"), /composerSubmit\.disabled = composerKeptSource \? true/);
  assert.match(fnText(kaposts, "renderComposerThreadUi"), /renderComposerSourceNotice\(\)/);
  assert.match(kaposts, /composerSubmit\?\.addEventListener\("click", \(\) => \{\n\s+if \(composerKeptSource\) return;/);
  assert.match(fnText(kaposts, "saveDraftFromComposer"), /draftSourceIds\(\{ quoteTarget: composerQuoteTarget, replyTarget: composerReplyTarget, kept: composerKeptSource \}\)/);
  const open = fnText(kaposts, "openDraft");
  assert.match(open, /kept\.failed = true/);
  assert.match(open, /if \(composerKeptSource !== kept\) return;/);
  assert.doesNotMatch(open, /replyTarget: source \}\);\n\s+else openComposer\(source\)/, "an unresolved reply is not opened as a plain post");
  assert.match(fnText(kaposts, "openComposer"), /composerKeptSource = null/);
  assert.match(fnText(kaposts, "closeComposer"), /composerKeptSource = null/);
});

// --- 4. An unconfirmed thread's unsent segments ------------------------------------------------------

test("4: the prompt is iOS's", () => {
  assert.equal(KAPOSTS_THREAD_UNCONFIRMED_PROMPT, "The network didn't confirm part of your thread, so the rest wasn't sent. Save what's left as a draft? Its first post may have gone through, so check before posting it again.");
});

test("4: what's left becomes a draft the way the composer holds it", () => {
  assert.deepEqual(threadRemainderDraft({ rootText: "1", segments: ["2", "3"], parentTxId: null }, "id", 5),
    { id: "id", text: "3", threadSegments: ["1", "2"], quotedRemoteId: null, replyRemoteId: null, savedAt: 5 });
  assert.deepEqual(threadRemainderDraft({ rootText: null, segments: ["2", "3"], parentTxId: "root" }, "id", 5),
    { id: "id", text: "3", threadSegments: ["2"], quotedRemoteId: null, replyRemoteId: null, savedAt: 5 }, "several go back as a thread of their own");
});

test("4: a single reply left keeps its link to the post before it", () => {
  const draft = threadRemainderDraft({ rootText: null, segments: ["3"], parentTxId: "parent" }, "id", 5);
  assert.equal(draft.text, "3");
  assert.deepEqual(draft.threadSegments, []);
  assert.equal(draft.replyRemoteId, "parent");
});

test("4: nothing left, nothing saved", () => {
  assert.equal(threadRemainderDraft({ rootText: null, segments: [], parentTxId: "p" }, "id"), null);
});

test("4: wiring: only an unknown outcome asks, and only the answer saves", () => {
  assert.match(fnText(kaposts, "continueThread"), /kapostOutcomeUnknown\(error\) && threadRemainders\.get\(localId\) === state\) offerThreadRemainderDraft\(state\)/);
  const offer = fnText(kaposts, "offerThreadRemainderDraft");
  assert.match(offer, /confirmLabel: "Save as Draft", cancelLabel: "Not Now"/);
  ordered(offer, "if (!save", "kapostDrafts = [draft", "Not Now saves nothing");
});

// --- 5. Delete and Edit after an unknown outcome -------------------------------------------------------

const unknown = sendOutcomeUnknownError("t".repeat(64));

test("5: an unknown delete stays dimmed and marked, with no second Delete", () => {
  assert.equal(unknown.code, SEND_OUTCOME_UNKNOWN);
  assert.equal(kapostOutcomeUnknown(unknown), true);
  const post = { pendingDeletion: true, delivery: "sent" };
  settleFailedKaPostDelete(post, unknown);
  assert.deepEqual(post, { pendingDeletion: true, delivery: "unconfirmed" });
});

test("5: a failed delete lifts the dim", () => {
  const post = { pendingDeletion: true, delivery: "sent" };
  settleFailedKaPostDelete(post, new Error("insufficient funds"));
  assert.deepEqual(post, { pendingDeletion: false, delivery: "sent" });
});

test("5: an unknown edit keeps the new text, marked; a failed one restores the old", () => {
  const restore = (p) => { p.text = "old"; p.delivery = "sent"; };
  const lost = { text: "new", delivery: "pending" };
  settleFailedKaPostEdit(lost, unknown, restore);
  assert.deepEqual(lost, { text: "new", delivery: "unconfirmed" });
  const failed = { text: "new", delivery: "pending" };
  settleFailedKaPostEdit(failed, new Error("nope"), restore);
  assert.deepEqual(failed, { text: "old", delivery: "sent" });
});

test("5: wiring: both go through the settle functions and alert the unknown message", () => {
  for (const name of ["scheduleEdit", "scheduleDelete"]) {
    assert.match(fnText(kaposts, name), /kapostOutcomeUnknown\(error\) \? SEND_OUTCOME_UNKNOWN_MESSAGE/, name);
  }
  assert.match(fnText(kaposts, "scheduleDelete"), /settleFailedKaPostDelete\(p, error\)/);
  assert.match(fnText(kaposts, "scheduleEdit"), /settleFailedKaPostEdit\(p, error, restore\)/);
  assert.doesNotMatch(fnText(kaposts, "scheduleDelete"), /catch \(error\) \{\n\s+mutatePost\(post\.id, \(p\) => \{ p\.pendingDeletion = false; \}\)/);
});

// --- 6. Room edits --------------------------------------------------------------------------------

const ME = "kaspa:me";
const T = "t".repeat(64);
const chain = (byTarget, txId, text, at) => recordRoomEdit(byTarget, txId, { targetTxId: T, text }, ME, at);

test("6: a failed edit goes back to no edit at all", () => {
  const byTarget = {};
  recordRoomEdit(byTarget, null, { targetTxId: T, text: "new" }, ME, 100, "pending");
  assert.equal(restoreRoomEdit(byTarget, T, null), true);
  assert.deepEqual(byTarget, {});
});

test("6: a failed edit goes back to the edit before it", () => {
  const byTarget = {};
  chain(byTarget, "tx1", "first", 100);
  const previous = { ...byTarget[T] };
  recordRoomEdit(byTarget, null, { targetTxId: T, text: "second" }, ME, 200, "pending");
  restoreRoomEdit(byTarget, T, previous);
  assert.equal(byTarget[T].text, "first");
  assert.equal(byTarget[T].status, undefined);
});

test("6: a delivered edit that replaced the pending one is left alone", () => {
  const byTarget = {};
  recordRoomEdit(byTarget, null, { targetTxId: T, text: "new" }, ME, 100, "pending");
  chain(byTarget, "other-device", "newest", 200);
  assert.equal(restoreRoomEdit(byTarget, T, null), false);
  assert.equal(byTarget[T].text, "newest");
});

test("6: Not confirmed gives way to its own chain copy, whatever the clocks", () => {
  const byTarget = {};
  recordRoomEdit(byTarget, "tx", { targetTxId: T, text: "new" }, ME, 500, "unconfirmed");
  assert.equal(byTarget[T].status, "unconfirmed");
  assert.equal(chain(byTarget, "tx", "new", 100), true, "same txid, older block time than this browser's clock");
  assert.equal(byTarget[T].status, undefined);
  assert.equal(byTarget[T].blockTime, 100);
});

test("6: a delivered edit still ignores older ones and repeats", () => {
  const byTarget = {};
  chain(byTarget, "tx2", "newer", 200);
  assert.equal(chain(byTarget, "tx1", "older", 100), false);
  assert.equal(byTarget[T].text, "newer");
  assert.equal(chain(byTarget, "tx2", "newer", 200), false);
});

test("6: wiring: Retry Edit, Not confirmed, and the unknown outcome's words", () => {
  const send = fnText(broadcasts, "sendBroadcastEdit");
  assert.doesNotMatch(send, /edit\.status = "failed"/);
  assert.match(send, /roomSendErrorText\(error, "Failed to edit: "\)/, "not \"Failed\" on an unknown outcome");
  ordered(send, "error?.code === SEND_OUTCOME_UNKNOWN", "ROOM_UNCONFIRMED", "an unknown outcome is Not confirmed");
  ordered(send, "restoreRoomEdit(", "failedRoomEdits.set(", "the text waits for Retry Edit");
  assert.match(broadcasts, /label: "Retry Edit"/);
  assert.match(broadcasts, /editFailed \? "failed" : roomEdit\?\.status === ROOM_UNCONFIRMED \? ROOM_UNCONFIRMED : baseStatus/);
  assert.match(fnText(broadcasts, "editFor"), /edit\.status !== "failed"/, "a failed edit left by an older build never shows");
});

// --- 7. Failed like, repost, follow, poll vote ----------------------------------------------------------

test("7: a failed like comes back, with the dislike it cleared", () => {
  const post = { likedByMe: true, likes: 3, dislikedByMe: false, dislikes: 1 };
  restoreKaPostVote(post, { likedByMe: false, dislikedByMe: true });
  assert.deepEqual(post, { likedByMe: false, likes: 2, dislikedByMe: true, dislikes: 2 });
});

test("7: a vote that already went back moves nothing, and counts don't go negative", () => {
  const same = { likedByMe: false, likes: 2, dislikedByMe: false, dislikes: 0 };
  restoreKaPostVote(same, { likedByMe: false, dislikedByMe: false });
  assert.deepEqual(same, { likedByMe: false, likes: 2, dislikedByMe: false, dislikes: 0 });
  const empty = { likedByMe: true, dislikedByMe: false };
  restoreKaPostVote(empty, { likedByMe: false, dislikedByMe: false });
  assert.equal(empty.likes, 0);
});

test("7: a failed repost and a failed unrepost both go back", () => {
  const reposted = { repostedByMe: true, reposts: 1 };
  restoreKaPostRepost(reposted, false);
  assert.deepEqual(reposted, { repostedByMe: false, reposts: 0 });
  const removed = { repostedByMe: false, reposts: 0 };
  restoreKaPostRepost(removed, true);
  assert.deepEqual(removed, { repostedByMe: true, reposts: 1 });
  const already = { repostedByMe: false, reposts: 4 };
  restoreKaPostRepost(already, false);
  assert.equal(already.reposts, 4);
});

test("7: a failed follow and unfollow both go back, and a list that moved on is left", () => {
  assert.deepEqual(followingAfterFailedFollow(["a", "b"], "b", true), ["a"]);
  assert.deepEqual(followingAfterFailedFollow(["a"], "b", false), ["a", "b"]);
  assert.deepEqual(followingAfterFailedFollow(["a"], "b", true), ["a"]);
});

test("7: wiring: each rolls back and goes red, except on an unknown outcome", () => {
  const vote = fnText(kaposts, "performVote");
  assert.match(vote, /if \(kapostOutcomeUnknown\(error\)\) return;/);
  ordered(vote, "restoreKaPostVote(p, before)", "showFailureToast(", "rolled back, then told");
  assert.match(vote, /Couldn't \$\{wasSet \? "remove" : "post"\} your \$\{kind\}/);
  const repost = fnText(kaposts, "scheduleRepost");
  ordered(repost, "kapostOutcomeUnknown(error)", "restoreKaPostRepost(p, wasReposted)", "repost");
  assert.match(repost, /"Couldn't remove your repost" : "Couldn't repost"/);
  const follow = fnText(kaposts, "toggleFollow");
  ordered(follow, "kapostOutcomeUnknown(error)", "followingAfterFailedFollow(", "follow");
  assert.match(follow, /"Couldn't follow" : "Couldn't unfollow"/);
  const poll = fnText(kaposts, "scheduleVote");
  assert.match(poll, /if \(!kapostOutcomeUnknown\(error\)\) showFailureToast\("Couldn't post your vote", error\)/);
  assert.match(fnText(kaposts, "scheduleQuote"), /restoreKaPostRepost\(p, wasReposted\)/);
  assert.match(fnText(kaposts, "showFailureToast"), /\{ failure: true \}/);
  assert.match(fnText(kaposts, "renderToasts"), /toast\.failure/);
});

// --- 8. A room link asks first --------------------------------------------------------------------

test("8: mixed alphabets are caught, one alphabet is fine", () => {
  assert.equal(hasMixedScripts("kаspa"), true, "Cyrillic a in a Latin name");
  assert.equal(hasMixedScripts("kaspa"), false);
  assert.equal(hasMixedScripts("казпа"), false);
  assert.equal(hasMixedScripts("kaspa-2026"), false, "digits and marks are no alphabet");
  assert.equal(hasMixedScripts("αb"), true, "Greek and Latin");
  assert.equal(hasMixedScripts("日本語kaspa"), false, "scripts that aren't look-alikes don't count");
});

test("8: the prompt is iOS's, with the warning only when it applies", () => {
  assert.deepEqual(roomLinkJoinPrompt("kaspa"), {
    title: "Join #kaspa?", message: "A link wants to add this room to your Public Chats.", confirmLabel: "Join", cancelLabel: "Cancel",
  });
  assert.equal(roomLinkJoinPrompt("kаspa").message,
    "A link wants to add this room to your Public Chats.\n\nThis name mixes letters from different alphabets, so it may be imitating another room.");
});

test("8: wiring: only a room not on the list asks, and the Terms still come first", () => {
  const open = fnText(broadcasts, "openBroadcastRoomFromLink");
  assert.match(open, /isCuratedBroadcastChannel\(name\) \|\| joinedChannels\.includes\(name\)/);
  ordered(open, "kaPostTermsAccepted()", "confirmDialog(roomLinkJoinPrompt(name))", "Terms before the join question");
  assert.match(open, /confirmDialog\(roomLinkJoinPrompt\(name\)\)\.then\(\(join\) => \{ if \(join\) joinChannel\(channel\); \}\)/);
});

// --- 9. The new-posts pill ----------------------------------------------------------------------------

test("9: more behind a page of all-new posts is a hole", () => {
  assert.equal(feedPageLeavesGap([{ id: "x" }, { id: "y" }], { hasMore: true }, new Set(["known"])), true);
});

test("9: a page touching the feed, or the last page, is safe to splice", () => {
  assert.equal(feedPageLeavesGap([{ id: "x" }, { id: "known" }], { hasMore: true }, new Set(["known"])), false);
  assert.equal(feedPageLeavesGap([{ id: "x" }], { hasMore: false }, new Set(["known"])), false);
  assert.equal(feedPageLeavesGap([{ id: "x" }], null, new Set()), false);
});

test("9: wiring: a gap reloads; a reload clears it", () => {
  assert.match(fnText(kaposts, "checkForNewPosts"), /pendingNewPostsHaveGap = feedPageLeavesGap\(result\.posts, result\.pagination, known\)/);
  const show = fnText(kaposts, "showPendingNewPosts");
  ordered(show, "if (pendingNewPostsHaveGap)", "loadFeed()", "the pill reloads");
  ordered(show, "loadFeed()", "remotePosts = [", "before any splice");
  assert.match(fnText(kaposts, "loadFeed"), /pendingNewPosts = \[\];\n\s+pendingNewPostsHaveGap = false;/);
});

// --- 10. Room burst gaps ---------------------------------------------------------------------------------

const page = (times, hasMore = true) => ({ messages: times.map((blockTime) => ({ blockTime })), hasMore });

test("10: a whole page newer than anything seen pages back to it", () => {
  assert.equal(roomPollGapFloor(page([300, 200]), 100), 100);
});

test("10: a page that reaches what was seen has no gap", () => {
  assert.equal(roomPollGapFloor(page([300, 100]), 100), null, "overlap");
  assert.equal(roomPollGapFloor(page([300, 90]), 100), null);
  assert.equal(roomPollGapFloor(page([300, 200], false), 100), null, "the end of the room");
  assert.equal(roomPollGapFloor(page([300, 200]), undefined), null, "nothing seen yet");
  assert.equal(roomPollGapFloor(page([]), 100), null);
});

test("10: wiring: a gap reopens the backfill with a floor, and every account starts over", () => {
  const backfill = fnText(broadcasts, "backfillChannel");
  ordered(backfill, "roomPollGapFloor(result, roomNewestSeen.get(channel))", "deepBackfillFloor.set(channel, gapFloor)", "the gap sets the floor");
  ordered(backfill, "deepBackfilled.delete(channel)", "if (!deepBackfilled.has(channel)) {", "and falls through to the page-back");
  assert.match(fnText(broadcasts, "resetBroadcastsForAccount"), /roomNewestSeen\.clear\(\)/);
  assert.match(fnText(broadcasts, "resetBroadcastsForAccount"), /failedRoomEdits\.clear\(\)/);
});

for (const [name, fn] of tests) {
  await fn();
  passed += 1;
  console.log(`ok - ${name}`);
}
console.log(`${passed}/${tests.length} passed`);
