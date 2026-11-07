// node tools/test-kaposts-held.mjs - KaPosts work that waits never goes out as another account, and
// a reply never goes out without its parent (ui/kaposts-held.js, ui/kaposts.js, engine/kaposts.js;
// iOS dfaba68 / c130dc1 isActiveWallet, stillSameAccount).
//
// Creating or importing an account switches in place, and every KaPost write signs with whatever
// key the one engine holds when it goes out: a like held in the 5 s undo window, a thread's next
// segment, a scheduled post being built, a notification poll in flight. The pure helpers are
// driven directly; ui/kaposts.js needs a DOM, so its wiring is checked on the function text.
// Nothing leaves the machine.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  kapostsOwnedAction, dropKaPostsHeldActions, kapostsCanReplyTo, kapostsAccountChangedError,
  KAPOSTS_ACCOUNT_CHANGED, KAPOSTS_REPLY_NOT_ON_NETWORK,
} from "../ui/kaposts-held.js";
import { kapostsSubmitWithUtxoRetry } from "../ui/kaposts-format.js";
import { submitKaPostReply } from "../engine/kaposts.js";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "../ui/kaposts.js"), "utf8");

let pass = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const A = "kaspa:qqaccountaexample000000000000000000000000000000000000000000";
const B = "kaspa:qqaccountbexample000000000000000000000000000000000000000000";
const TXID = "ab".repeat(32);

/** The text of `function name(...) { ... }` in ui/kaposts.js, up to its closing brace at column 0. */
function fnText(name) {
  const start = source.search(new RegExp(`\\n(?:export )?(?:async )?function ${name}\\(`));
  assert.ok(start >= 0, `${name} is in ui/kaposts.js`);
  const end = source.indexOf("\n}\n", start);
  return source.slice(start, end + 2);
}
/** Asserts `first` appears before `second` inside `text`. */
function ordered(text, first, second, message) {
  const i = text.indexOf(first);
  const j = text.indexOf(second, Math.max(i, 0));
  assert.ok(i >= 0, `${message}: "${first}" is there`);
  assert.ok(j > i, `${message}: "${first}" comes before "${second}"`);
}

// --- Held actions (finding: a 5 s hold outlived an account switch) ---------------------------------

test("a held action runs for the account that armed it", () => {
  const engine = { address: A };
  let ran = 0;
  const held = kapostsOwnedAction(() => { ran += 1; return "tx"; }, () => engine.address);
  assert.equal(held(), "tx");
  assert.equal(ran, 1);
});

test("a held action whose account switched away is dropped, never signed by the new one", () => {
  const engine = { address: A };
  const submitted = [];
  const dropped = [];
  const held = kapostsOwnedAction(() => submitted.push(engine.address), () => engine.address, (owner) => dropped.push(owner));
  engine.address = B; // the account switched during the countdown
  assert.equal(held(), undefined);
  assert.deepEqual(submitted, [], "nothing goes out as B");
  assert.deepEqual(dropped, [A], "and the drop names the account that armed it");
});

test("a held action armed with no account never runs", () => {
  const engine = { address: "" };
  let ran = false;
  const held = kapostsOwnedAction(() => { ran = true; }, () => engine.address);
  engine.address = A;
  held();
  assert.equal(ran, false);
});

test("the account reset drops every hold: no countdown fires afterwards, no Undo runs", async () => {
  // The shape scheduleUndoable keeps: key -> { deadline, timer, undo, label }.
  const pending = new Map();
  const fired = [];
  const undone = [];
  for (const key of ["post:1", "like:2", "comment:3"]) {
    pending.set(key, { deadline: Date.now() + 20, timer: setTimeout(() => fired.push(key), 20), undo: () => undone.push(key), label: null });
  }
  assert.equal(dropKaPostsHeldActions(pending), 3);
  assert.equal(pending.size, 0);
  await sleep(60);
  assert.deepEqual(fired, [], "no held action went out after the switch");
  assert.deepEqual(undone, [], "Undo would reopen the old account's draft in the new one");
  assert.equal(dropKaPostsHeldActions(new Map()), 0);
  assert.equal(dropKaPostsHeldActions(null), 0);
});

test("ui/kaposts.js: scheduleUndoable fires through the owner check, reset drops holds and chains first", () => {
  const schedule = fnText("scheduleUndoable");
  assert.match(schedule, /kapostsOwnedAction\(action, \(\) => deps\?\.engine\?\.address/);
  assert.match(schedule, /ownedAction\(\);\n\s*\}, UNDO_DELAY_MS\)/, "the countdown runs the owned wrapper, not the bare action");
  const reset = fnText("resetKaPostsForAccount");
  ordered(reset, "dropAllUndoables();", "closeFeedDrawer();", "holds are dropped before anything else");
  assert.match(reset, /threadRemainders\.clear\(\);/, "an in-flight thread's ledger goes with the account");
  assert.match(fnText("dropAllUndoables"), /dropKaPostsHeldActions\(pendingActions, clearTimeout\)/);
});

// --- Thread chains (finding: continueThread kept posting segments across a switch) -----------------

test("a thread segment stopped by an account change is not retried", async () => {
  let calls = 0;
  await assert.rejects(
    kapostsSubmitWithUtxoRetry(async () => { calls += 1; throw kapostsAccountChangedError(); }, { delayMs: 0 }),
    (error) => error.code === KAPOSTS_ACCOUNT_CHANGED && error.noRetry === true,
  );
  assert.equal(calls, 1, "a UTXO retry after the switch would sign with the new key");
});

test("ui/kaposts.js: continueThread re-checks its owner and its ledger before every segment", () => {
  const chain = fnText("continueThread");
  assert.match(chain, /const owner = accountGuard\(\(\) => deps\?\.engine\?\.address\);/);
  assert.match(chain, /owner\.still\(\) && threadRemainders\.get\(localId\) === state/, "a reset (ledger cleared) also stops it");
  // checked after the settle delay, and inside each try right before signing
  ordered(chain, "setTimeout(resolve, 1500)", "if (!stillOurs()) throw kapostsAccountChangedError();", "after the settle delay");
  const inOps = chain.match(/if \(!stillOurs\(\)\) throw kapostsAccountChangedError\(\);\n\s*return submitKaPost(Reply)?\(/g) || [];
  assert.equal(inOps.length, 2, "the root and every reply segment check right before signing");
  ordered(chain, "error?.code === KAPOSTS_ACCOUNT_CHANGED", "kapostsFailureDelivery(error)", "a stopped chain is not shown as failed");
});

// --- Replies need their parent's txid ---------------------------------------------------------------

test("only a post with a txid can be replied to", () => {
  assert.equal(kapostsCanReplyTo({ remoteId: TXID }), true);
  for (const post of [{ remoteId: null }, { remoteId: "" }, { remoteId: "  " }, {}, null, undefined]) {
    assert.equal(kapostsCanReplyTo(post), false, JSON.stringify(post));
  }
  assert.match(KAPOSTS_REPLY_NOT_ON_NETWORK, /isn't on the network yet/);
});

test("engine: a reply with no parent txid is refused before anything is signed or sent", async () => {
  // An engine that would record any signing or sending: neither may be reached.
  const touched = [];
  const engine = new Proxy({}, { get(_, prop) { touched.push(prop); return undefined; } });
  for (const postId of [null, undefined, "", "not-a-txid", "ab".repeat(31)]) {
    await assert.rejects(submitKaPostReply({ engine, text: "hi", postId }), /isn't on the network yet/, String(postId));
  }
  assert.deepEqual(touched, [], "the engine is never touched");
});

test("ui/kaposts.js: every reply path checks the parent's txid before the fee is committed", () => {
  const reply = fnText("submitReply");
  ordered(reply, "kapostsCanReplyTo(freshParent)", "scheduleUndoable(", "submitReply refuses before arming the send");
  ordered(reply, "findPost(parent?.id) || parent", "kapostsCanReplyTo(freshParent)", "it reads the freshest copy of the parent");
  // The composer keeps the words: it checks before closeComposer throws the draft away.
  const composerCheck = "!kapostsCanReplyTo(findPost(replyTarget.id) || replyTarget)";
  ordered(source, composerCheck, "closeComposer({ keepDraft: false });", "the composer checks before it closes");
  assert.match(source, /if \(!kapostsCanReplyTo\(target\)\) \{ deps\.showToast\?\.\(KAPOSTS_REPLY_NOT_ON_NETWORK\); return; \}/, "the pinned bar says why");
  assert.match(fnText("postCellHtml"), /data-kaposts-reply-to="\$\{pid\}"\$\{kapostsCanReplyTo\(post\) \? "" : " disabled"\}/, "Reply is off on a post with no txid");
});

// --- Scheduled post, notification poll, new-posts check --------------------------------------------

test("ui/kaposts.js: scheduleForLater files the built post only under the account that built it", () => {
  const schedule = fnText("scheduleForLater");
  ordered(schedule, "const owner = accountGuard(", "await buildScheduledPost(", "the owner is taken before the build");
  ordered(schedule, "await buildScheduledPost(", "if (!owner.still()) {", "and re-checked after it");
  ordered(schedule, "if (!owner.still()) {", "scheduledPosts.push(entry);", "before the entry is stored");
  ordered(schedule, "if (!owner.still()) {", "await scheduleOnServer(", "and before the indexer is asked under the current key");
  ordered(schedule, "await scheduleOnServer(", "if (!owner.still()) return;\n    entry.onServer = true;", "the server answer saves only for its account");
});

test("ui/kaposts.js: a notification poll that lands after a switch is dropped", () => {
  const poll = fnText("pollKaPostNotificationsForPings");
  ordered(poll, "const owner = accountGuard(", "await fetchKaPostNotifications(", "the owner is taken before the fetch");
  ordered(poll, "await fetchKaPostNotifications(", "if (!owner.still()) return;", "and checked once it lands");
  ordered(poll, "if (!owner.still()) return;", "loadSeenKaPostNotificationIds()", "before the seen list is read");
  ordered(poll, "await deps.engine.refreshKnsIfNeeded", "if (!owner.still()) return;", "and again after the name lookup");
  assert.match(poll, /const my = owner\.account;/);
});

test("ui/kaposts.js: checkForNewPosts drops a page from another feed generation or account", () => {
  const check = fnText("checkForNewPosts");
  ordered(check, "const generation = feedGeneration;", "await fetchFeedPage(null)", "the generation is taken before the fetch");
  ordered(check, "await fetchFeedPage(null)", "generation !== feedGeneration || !owner.still()", "and compared once it lands");
  ordered(check, "generation !== feedGeneration || !owner.still()", "pendingNewPosts = fresh;", "before the pill is set");
});

for (const [name, fn] of tests) {
  try { await fn(); pass++; }
  catch (error) { console.error(`FAIL ${name}\n  ${error?.message || error}`); process.exitCode = 1; }
}
console.log(`kaposts-held: ${pass}/${tests.length} passed`);
