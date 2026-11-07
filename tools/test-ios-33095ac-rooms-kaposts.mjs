// KaPost iOS 33095ac and KaChat iOS d23e6f7a, the rooms / KaPost / .kachat names part: a room send
// whose outcome is unknown shows "Not confirmed" and settles when its copy comes back; leftover room
// rows are Not confirmed, not Failed; identity lookups without a batch go four at a time; your own
// profile and the Notifications list reload when they are out of date; a failed thread probe is
// asked again; a .kachat combine skips unconfirmed and coinbase coins and sends all less the fee.
// Run: node tools/test-ios-33095ac-rooms-kaposts.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { markRoomRowUnconfirmed, settleRoomCopy, settleLeftoverRoomRows, ROOM_UNCONFIRMED } from "../ui/leftover-sends.js";
import { identityBatchFlush, unnamedSweepPass, IDENTITY_FALLBACK_PARALLEL } from "../ui/kachat-unnamed-sweep.js";
import { kapostsKeptPageFresh } from "../ui/kaposts-format.js";
import { kapostActionShowsOnProfile, lastOwnKaPostActivityAt } from "../engine/kaposts.js";

const me = "kaspa:me";
const tx = (c) => c.repeat(64);

// --- A room send not confirmed (PublicChatStore.markMessageUnconfirmed) ------------------------
assert.equal(ROOM_UNCONFIRMED, "unconfirmed");
{
  const rows = [{ txId: "pending-1", senderAddress: me, content: "hi", blockTime: 5, status: "pending" }];
  const out = markRoomRowUnconfirmed(rows, "pending-1", tx("A"));
  assert.deepEqual(out, [{ txId: tx("a"), senderAddress: me, content: "hi", blockTime: 5, status: "unconfirmed" }], "takes the txid, lower case");
  assert.equal(rows[0].status, "pending", "the stored list isn't changed in place");
}
{
  // its copy is already here: it landed, so the row goes
  const rows = [
    { txId: "pending-1", senderAddress: me, content: "hi", blockTime: 5, status: "pending" },
    { txId: tx("b"), senderAddress: me, content: "hi", blockTime: 4 },
  ];
  assert.deepEqual(markRoomRowUnconfirmed(rows, "pending-1", tx("b")).map((m) => m.txId), [tx("b")]);
}
{
  // no usable txid: the pending id stays, Not confirmed
  const rows = [{ txId: "pending-1", senderAddress: me, content: "hi", blockTime: 5, status: "pending" }];
  for (const txid of [undefined, "", "nope"]) {
    const [row] = markRoomRowUnconfirmed(rows, "pending-1", txid);
    assert.equal(row.txId, "pending-1");
    assert.equal(row.status, "unconfirmed");
  }
  assert.deepEqual(markRoomRowUnconfirmed(undefined, "pending-1", tx("c")), [], "a room gone meanwhile");
}

// --- Its copy settles it (PublicChatStore.insertMessages) --------------------------------------
{
  const rows = [{ txId: tx("c"), senderAddress: me, content: "hi", blockTime: 5, status: "unconfirmed" }];
  assert.equal(settleRoomCopy(rows, tx("c"), 9), true);
  assert.deepEqual(rows[0], { txId: tx("c"), senderAddress: me, content: "hi", blockTime: 9 }, "sent, with the chain's time");
  assert.equal(settleRoomCopy(rows, tx("c"), 9), false, "already sent");
  assert.equal(settleRoomCopy([{ txId: tx("d"), status: "failed" }], tx("d"), 9), false, "only a Not confirmed row");
  const keep = [{ txId: tx("e"), status: "unconfirmed", blockTime: 3 }];
  assert.equal(settleRoomCopy(keep, tx("e"), undefined), true);
  assert.equal(keep[0].blockTime, 3, "no chain time: its own stays");
}

// --- Leftovers from earlier runs (settlePendingMessages) ---------------------------------------
{
  const t = 10_000_000;
  const rows = [
    // Not confirmed with no txid, from an earlier run: its copy came, so it goes
    { txId: "pending-x", senderAddress: me, content: "landed", blockTime: t, status: "unconfirmed" },
    { txId: tx("1"), senderAddress: me, content: "landed", blockTime: t },
    // Not confirmed with no copy: stays as it is, unchanged
    { txId: "pending-y", senderAddress: me, content: "unknown", blockTime: t, status: "unconfirmed" },
    // Not confirmed with its txid: only its own copy (by id) settles it
    { txId: tx("2"), senderAddress: me, content: "by id", blockTime: t, status: "unconfirmed" },
    { txId: tx("3"), senderAddress: me, content: "by id", blockTime: t },
    // a pending row from an earlier run: Not confirmed, never Failed
    { txId: "pending-z", senderAddress: me, content: "left", blockTime: t, status: "pending" },
  ];
  assert.equal(settleLeftoverRoomRows(rows, { keeping: new Set() }), 2);
  const byId = Object.fromEntries(rows.map((r) => [r.txId, r]));
  assert.equal(byId["pending-x"], undefined);
  assert.equal(byId["pending-y"].status, "unconfirmed");
  assert.equal(byId[tx("2")].status, "unconfirmed", "a txid row waits for its own copy");
  assert.equal(byId["pending-z"].status, "unconfirmed");
  assert.ok(!rows.some((r) => r.status === "failed"), "no Retry that could pay twice");
  assert.equal(settleLeftoverRoomRows(rows, { keeping: new Set() }), 0, "nothing more to change");
}

// --- Identity lookups without a batch: four at a time ------------------------------------------
assert.equal(IDENTITY_FALLBACK_PARALLEL, 4);
async function peakOf(run) {
  let active = 0;
  let peak = 0;
  const order = [];
  const lookUp = async (key) => {
    order.push(key);
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 2));
    active -= 1;
    if (key === "k3") throw new Error("one failing doesn't stop the rest");
    return true;
  };
  await run(lookUp);
  return { peak, order };
}
{
  const keys = Array.from({ length: 10 }, (_, i) => `k${i}`);
  const flush = await peakOf((lookUp) => identityBatchFlush(keys, { batch: async () => null, store: () => false, notify: () => {}, lookUp }));
  assert.equal(flush.peak, 4, "render-time fallback: four side by side, not ten");
  assert.deepEqual(flush.order, keys, "everyone asked, in order");
  const answered = [];
  const sweep = await peakOf((lookUp) => unnamedSweepPass(keys, {
    batch: async () => null, store: () => false, miss: () => {}, notify: () => {}, lookUp, answered: (key) => answered.push(key),
  }));
  assert.equal(sweep.peak, 4, "sweep fallback: four at a time, not one");
  assert.deepEqual(sweep.order, keys);
  assert.deepEqual(answered.sort(), keys.filter((k) => k !== "k3").sort(), "a failed lookup counts nothing");
}

// --- Kept pages: your own profile and Notifications ---------------------------------------------
{
  const now = 1_000_000;
  assert.equal(kapostsKeptPageFresh({ loadedAt: now - 1000, freshMs: 120_000, now }), true);
  assert.equal(kapostsKeptPageFresh({ loadedAt: now - 120_000, freshMs: 120_000, now }), false, "too old");
  assert.equal(kapostsKeptPageFresh({ loadedAt: 0, freshMs: 120_000, now }), false, "never loaded");
  assert.equal(kapostsKeptPageFresh({ loadedAt: now - 1000, freshMs: 120_000, changedAt: now - 500, now }), false, "changed since it loaded");
  assert.equal(kapostsKeptPageFresh({ loadedAt: now - 1000, freshMs: 120_000, changedAt: now - 2000, now }), true, "changed before it loaded");
}
for (const action of ["post", "reply", "quote", "unquote", "edit", "delete", "poll"]) {
  assert.equal(kapostActionShowsOnProfile(`kchat:1:${action}:02ab:sig:rest`), true, action);
}
for (const action of ["vote", "follow", "pollvote", "tip"]) {
  assert.equal(kapostActionShowsOnProfile(`kchat:1:${action}:02ab:sig:rest`), false, action);
}
assert.equal(kapostActionShowsOnProfile(null), false);
assert.equal(lastOwnKaPostActivityAt("kaspa:nobody"), 0, "nothing posted this run");

// --- Wiring --------------------------------------------------------------------------------------
const rooms = readFileSync(new URL("../ui/broadcasts.js", import.meta.url), "utf8");
assert.match(rooms, /if \(seen\.has\(row\.txId\)\) \{[\s\S]{0,200}settleRoomCopy\(existing, row\.txId, row\.blockTime\)/, "a copy settles a Not confirmed row");
assert.match(rooms, /pendingSendsThisRun\.delete\(pendingId\);\s*messageCache\[channel\] = markRoomRowUnconfirmed/);
assert.match(rooms, /m\.status === ROOM_UNCONFIRMED \? ROOM_UNCONFIRMED : "confirmed"/, "the room row shows the Not confirmed label");
assert.match(rooms, /m\.status === ROOM_UNCONFIRMED && String\(m\.txId\)\.startsWith\("pending-"\)/, "a Not confirmed row with no txid is matched by content");
assert.match(rooms, /function retryBroadcastMessage\(m\) \{\s*if \(!activeChannel \|\| m\.status !== "failed"\) return;/, "no Retry for Not confirmed");

const kaposts = readFileSync(new URL("../ui/kaposts.js", import.meta.url), "utf8");
assert.match(kaposts, /kapostsKeptPageFresh\(\{ loadedAt: kept\.loadedAt, freshMs: PROFILE_FRESH_MS, changedAt: lastOwnKaPostActivityAt\(address\) \}\)/);
assert.match(kaposts, /kapostsKeptPageFresh\(\{ loadedAt: kept\.loadedAt, freshMs: NOTIFICATIONS_FRESH_MS, changedAt: lastKaPostsArrivalAt \}\)/);
assert.match(kaposts, /function recordUnseenKaPostsArrivals\(count\) \{\s*if \(count <= 0\) return;\s*lastKaPostsArrivalAt = Date\.now\(\);/);
assert.match(kaposts, /if \(await loadNotificationsFirstPage\(panel\)\) keptNotificationsPanel = \{ panel, loadedAt: Date\.now\(\) \};/, "kept only once a load worked");
assert.doesNotMatch(kaposts, /keptNotificationsPanel = \{ panel, loadedAt: Date\.now\(\) \};\s*await loadNotificationsFirstPage/);
assert.match(kaposts, /if \(threadRootProbe\.get\(post\.remoteId\) === false\) threadRootProbe\.delete\(post\.remoteId\);/, "a failed probe is unclaimed");

const engineKaposts = readFileSync(new URL("../engine/kaposts.js", import.meta.url), "utf8");
assert.match(engineKaposts, /if \(kapostActionShowsOnProfile\(protocolString\)\) ownKaPostActivity = \{ address: engine\.address, at: Date\.now\(\) \};/);

const names = readFileSync(new URL("../engine/kachat-names/actions.js", import.meta.url), "utf8");
const combine = names.slice(names.indexOf("async combineCoins(s) {"), names.indexOf("async _build("));
assert.match(combine, /BigInt\(u\.blockDaaScore \?\? 0\) > 0n && !u\.isCoinbase/);
assert.match(combine, /await sendMaxKaspa\(\{/, "all of it less the network fee, one output");
assert.doesNotMatch(combine, /total - combineFeeRoom/, "no fixed fee allowance left as change");

const app = readFileSync(new URL("../ui/app.js", import.meta.url), "utf8");
assert.match(app, /word = "Not confirmed";\s*aria = "Not confirmed yet\. It may still go through\.";/, "iOS d23e6f7a DeliveryStatusLabel");

console.log("iOS 33095ac rooms / KaPost / .kachat: ok");
