// node tools/test-kaposts-outage.mjs - KaPost with its indexer down (KaPosts-iPhone ee5ec98,
// engine/kaposts-chain-fallback.js, engine/kaposts.js).
//
// Runs the real read functions, the real outage detector and the real Kaspa WASM signer against an
// indexer and a Kaspa REST API stubbed in memory, with the clock under the test's control. Reports
// reach the detector through watchIndexerFetch, as the browser's fetch wrapper sends them. ui/kaposts.js
// needs a DOM, so its wiring is checked on the function text. Nothing leaves the machine.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { indexerHealth, indexerKey, isIndexerDown, onIndexerAvailabilityChange, watchIndexerFetch } from "../engine/indexer-health.js";
import { getEndpoint } from "../engine/endpoints.js";
import {
  fetchChainPost, fetchFollowingFeed, fetchGlobalFeed, fetchKaPostNotifications, fetchReplies, fetchUserPosts, fetchUserReplies,
  KACHAT_MARKER, KAPOSTS_PROTOCOL, kaPostIndexerIsDown, requesterPubkeyFor, utf8ToBase64,
} from "../engine/kaposts.js";
import {
  chainPayloadIsSigned, configureKaPostSavedPages, createKaPostLiveFeed, kaPostSignatureIsValid, kapostLiveFeed, mergeOutageRows,
  verifiedChainPost,
} from "../engine/kaposts-chain-fallback.js";
import { KaspaEngine } from "../engine/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");
const kaspa = await import("../kaspa/kaspa.js");
await kaspa.default({ module_or_path: readFileSync(join(repo, "kaspa/kaspa_bg.wasm")) });

const uiSource = readFileSync(join(repo, "ui/kaposts.js"), "utf8");
function fnText(name) {
  const start = uiSource.search(new RegExp(`\\n(?:export )?(?:async )?function ${name}\\(`));
  assert.ok(start >= 0, `${name} is in ui/kaposts.js`);
  return uiSource.slice(start, uiSource.indexOf("\n}\n", start) + 2);
}

// --- The world ------------------------------------------------------------------------------------

let clock = 1_800_000_000_000;
Date.now = () => clock;

const memoryStorage = () => {
  const map = new Map();
  return {
    get length() { return map.size; },
    key: (index) => [...map.keys()][index] ?? null,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); },
    snapshot: () => new Map(map),
  };
};

const makeAccount = (hex) => {
  const privateKey = new kaspa.PrivateKey(hex);
  const engine = {
    kaspa, privateKey, privateKeyHex: hex,
    address: privateKey.toKeypair().toAddress("mainnet").toString(),
    kapostPubkeyForAddress: KaspaEngine.prototype.kapostPubkeyForAddress,
  };
  return { engine, pubkey: requesterPubkeyFor(engine), sign: (message) => String(kaspa.signMessage({ message, privateKey: hex })).toLowerCase() };
};
const A = makeAccount("11".repeat(32));
const B = makeAccount("22".repeat(32));
const AUTHOR = makeAccount("33".repeat(32));

const INDEXER = getEndpoint("kapostIndexer");
const REST = getEndpoint("kaspaApi");
const txId = (n) => n.toString(16).padStart(64, "0");
const hexOf = (text) => Buffer.from(text, "utf8").toString("hex");
const b64Of = (text) => utf8ToBase64(KACHAT_MARKER + text);
const textOf = (post) => Buffer.from(post.postContent, "base64").toString("utf8").replace(KACHAT_MARKER, "");

const postPayload = (who, text, { signer = who } = {}) => {
  const b64 = b64Of(text);
  return KAPOSTS_PROTOCOL.postPayload(who.pubkey, signer.sign(KAPOSTS_PROTOCOL.postSigningString(b64, "[]")), b64, "[]");
};
const replyPayload = (who, parent, text) => {
  const b64 = b64Of(text);
  return KAPOSTS_PROTOCOL.replyPayload(who.pubkey, who.sign(KAPOSTS_PROTOCOL.replySigningString(parent, b64, "[]")), parent, b64, "[]");
};
const indexerRow = (n, text) => ({ id: txId(n), userPublicKey: AUTHOR.pubkey, postContent: b64Of(text), timestamp: clock - n, upVotesCount: 7 });

const world = { indexerUp: true, indexerCalls: [], rest: new Map(), restCalls: [], respond: null };
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function indexerAnswer(url) {
  if (world.respond) return world.respond(url);
  return json(200, { posts: [indexerRow(1, "from the indexer")], pagination: { hasMore: true, nextCursor: "c1" } });
}
globalThis.fetch = async (input) => {
  const url = String(input);
  if (url.startsWith(REST)) {
    world.restCalls.push(url);
    const parsed = new URL(url);
    if (parsed.pathname.startsWith("/transactions/")) {
      const row = world.rest.get(parsed.pathname.split("/")[2]);
      return row ? json(200, row) : json(404, {});
    }
    const address = decodeURIComponent(parsed.pathname.split("/")[2]);
    const offset = Number(parsed.searchParams.get("offset")) || 0;
    return json(200, offset ? [] : world.rest.get(address) || []);
  }
  return watchIndexerFetch(url, async () => {
    world.indexerCalls.push(url);
    if (!world.indexerUp) throw new TypeError("Failed to fetch");
    return indexerAnswer(url);
  });
};

const restRow = (n, payload, blockTime = clock - n * 1000) => ({ transaction_id: txId(n), is_accepted: true, block_time: blockTime, payload: hexOf(payload), inputs: [], outputs: [] });
const blockWith = (...transactions) => ({ data: { block: { header: { timestamp: clock }, transactions } } });
const blockTx = (n, payload) => ({ payload: hexOf(payload), verboseData: { transactionId: txId(n) } });

/** Three failures, spaced as the detector needs them. */
async function confirmOutage(engine = A.engine) {
  world.indexerUp = false;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await fetchGlobalFeed({ engine, limit: 9 }).catch(() => {});
    clock += 6_000;
  }
  assert.equal(isIndexerDown(INDEXER), true, "three failures confirm it");
}

let storage;
function freshWorld() {
  clock += 3_600_000; // past every cache and rate limit of the last test
  indexerHealth.reset();
  kapostLiveFeed.setActive(null, false);
  world.indexerUp = true; world.indexerCalls = []; world.rest = new Map(); world.restCalls = []; world.respond = null;
  storage = memoryStorage();
  configureKaPostSavedPages({ scopedKey: (base, account) => `kachat-account-data-v1:${account}:${base}`, storage });
}

let pass = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// --- Signatures -----------------------------------------------------------------------------------

test("the verifier agrees with the real Kaspa signer, and only for that key and text", () => {
  const signature = AUTHOR.sign("a:b");
  assert.equal(kaPostSignatureIsValid(signature, "a:b", AUTHOR.pubkey), true);
  assert.equal(kaPostSignatureIsValid(signature, "a:c", AUTHOR.pubkey), false);
  assert.equal(kaPostSignatureIsValid(signature, "a:b", A.pubkey), false);
  assert.equal(kaPostSignatureIsValid("zz", "a:b", AUTHOR.pubkey), false);
  assert.equal(kaPostSignatureIsValid(signature, "a:b", "not a key"), false);
});

test("a post, a reply and a poll pass only with their own signature", () => {
  assert.ok(verifiedChainPost(postPayload(AUTHOR, "hello"), txId(1), 5));
  assert.equal(verifiedChainPost(postPayload(AUTHOR, "hello", { signer: A }), txId(1), 5), null, "someone else signed it");
  assert.equal(verifiedChainPost(`kchat:1:post:${AUTHOR.pubkey}:${"00".repeat(64)}:${b64Of("hi")}:[]`, txId(1), 5), null);
  assert.equal(chainPayloadIsSigned(postPayload(AUTHOR, "hello")), true);
  assert.equal(chainPayloadIsSigned(replyPayload(AUTHOR, txId(9), "yes")), true);
  assert.equal(chainPayloadIsSigned(postPayload(AUTHOR, "hello", { signer: B })), false);
  const unmarked = utf8ToBase64("no marker: another app's post");
  const signed = KAPOSTS_PROTOCOL.postPayload(AUTHOR.pubkey, AUTHOR.sign(KAPOSTS_PROTOCOL.postSigningString(unmarked, "[]")), unmarked, "[]");
  assert.equal(verifiedChainPost(signed, txId(1), 5), null, "not a KaChat post, however well signed");
});

// --- Saved pages ----------------------------------------------------------------------------------

test("up: the feed is the indexer's, as ever, and a failure or two still throw", async () => {
  freshWorld();
  const first = await fetchGlobalFeed({ engine: A.engine, limit: 9 });
  assert.equal(textOf(first.posts[0]), "from the indexer");
  assert.equal(first.outage, false);
  assert.equal(first.pagination.nextCursor, "c1");
  world.indexerUp = false;
  await assert.rejects(fetchGlobalFeed({ engine: A.engine, limit: 9 }), /Failed to fetch/);
  clock += 6_000;
  await assert.rejects(fetchGlobalFeed({ engine: A.engine, limit: 9 }), /Failed to fetch/, "two failures aren't an outage: the saved page stays put");
  assert.equal(isIndexerDown(INDEXER), false);
});

test("confirmed down: the saved page, at once, without a cursor or a wait on the indexer", async () => {
  freshWorld();
  await fetchGlobalFeed({ engine: A.engine, limit: 9 });
  await confirmOutage();
  clock += 1_000;
  const calls = world.indexerCalls.length;
  indexerHealth.claimRecoveryCheck(INDEXER); // this minute's check is spent
  const page = await fetchGlobalFeed({ engine: A.engine, limit: 9 });
  assert.equal(world.indexerCalls.length, calls, "the indexer isn't asked");
  assert.equal(page.outage, true);
  assert.equal(page.pagination, null, "a cursor is only good with the indexer");
  assert.deepEqual(page.posts.map(textOf), ["from the indexer"]);
  assert.equal(page.posts[0].upVotesCount, 7, "with the indexer's counts");
});

test("confirmed down: the confirming request itself gets the saved page", async () => {
  freshWorld();
  await fetchGlobalFeed({ engine: A.engine, limit: 9 });
  world.indexerUp = false;
  await fetchGlobalFeed({ engine: A.engine, limit: 9 }).catch(() => {}); clock += 6_000;
  await fetchGlobalFeed({ engine: A.engine, limit: 9 }).catch(() => {}); clock += 6_000;
  const page = await fetchGlobalFeed({ engine: A.engine, limit: 9 });
  assert.equal(page.outage, true);
  assert.deepEqual(page.posts.map(textOf), ["from the indexer"]);
});

test("confirmed down: a later page throws, for the pager to retry", async () => {
  freshWorld();
  await fetchGlobalFeed({ engine: A.engine, limit: 9 });
  await confirmOutage();
  await assert.rejects(fetchGlobalFeed({ engine: A.engine, limit: 9, before: "c1" }));
});

test("one account's saved pages are never another's, even from an answer that lands after a switch", async () => {
  freshWorld();
  await fetchGlobalFeed({ engine: A.engine, limit: 9 });
  // A shared engine object switching accounts while a read is in flight.
  const shared = { ...A.engine };
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  world.respond = async () => { await gate; return json(200, { posts: [indexerRow(2, "late for A")] }); };
  const inFlight = fetchGlobalFeed({ engine: shared, limit: 8 });
  Object.assign(shared, B.engine);
  release();
  await inFlight;
  world.respond = null;
  await confirmOutage(B.engine);
  await assert.rejects(fetchGlobalFeed({ engine: B.engine, limit: 9 }), "B has nothing saved");
  await assert.rejects(fetchGlobalFeed({ engine: B.engine, limit: 8 }), "the late answer stayed A's");
  assert.deepEqual((await fetchGlobalFeed({ engine: A.engine, limit: 8 })).posts.map(textOf), ["late for A"]);
  assert.deepEqual((await fetchGlobalFeed({ engine: A.engine, limit: 9 })).posts.map(textOf), ["from the indexer"]);
  for (const key of storage.snapshot().keys()) assert.match(key, new RegExp(`^kachat-account-data-v1:${A.engine.address}:`), "filed under the account, so removing it takes them along");
});

test("a page isn't saved from a later page, a proxy's answer, or an indexer error", async () => {
  freshWorld();
  await fetchGlobalFeed({ engine: A.engine, limit: 9, before: "cursor" });
  assert.equal(storage.length, 0, "a later page");
  world.respond = () => new Response("<html>bad gateway</html>", { status: 200, headers: { "content-type": "text/html" } });
  await fetchGlobalFeed({ engine: A.engine, limit: 9 });
  assert.equal(storage.length, 0, "a proxy's page");
  world.respond = () => json(400, { error: "nope" });
  await assert.rejects(fetchGlobalFeed({ engine: A.engine, limit: 9 }));
  assert.equal(storage.length, 0, "an error");
});

test("saved pages keep to their share of localStorage, oldest out first", async () => {
  freshWorld();
  const filler = "x".repeat(150_000);
  world.respond = () => json(200, { posts: [], filler });
  for (let limit = 1; limit <= 12; limit += 1) { await fetchGlobalFeed({ engine: A.engine, limit }); clock += 1_000; }
  const total = [...storage.snapshot().values()].reduce((sum, value) => sum + value.length, 0);
  assert.ok(total <= 1_200_000, `within the share (${total})`);
  world.respond = null;
  await confirmOutage();
  assert.equal((await fetchGlobalFeed({ engine: A.engine, limit: 12 })).outage, true, "the newest is still there");
  await assert.rejects(fetchGlobalFeed({ engine: A.engine, limit: 1 }), "the oldest went");
});

test("notifications: the saved page, with no cursor", async () => {
  freshWorld();
  world.respond = () => json(200, { notifications: [{ id: "n1" }], pagination: { hasMore: true, nextCursor: "c" } });
  await fetchKaPostNotifications({ engine: A.engine, limit: 5 });
  world.respond = null;
  await confirmOutage();
  const page = await fetchKaPostNotifications({ engine: A.engine, limit: 5 });
  assert.deepEqual(page.notifications, [{ id: "n1" }]);
  assert.equal(page.pagination, null);
  assert.equal(page.outage, true);
});

// --- A person's posts from REST -------------------------------------------------------------------

test("down: a person's posts come from REST, a bad signature dropped", async () => {
  freshWorld();
  await confirmOutage();
  world.rest.set(AUTHOR.engine.address, [
    restRow(11, postPayload(AUTHOR, "really theirs")),
    restRow(12, postPayload(AUTHOR, "forged in their name", { signer: A })),
    restRow(13, postPayload(A, "someone else's, in this listing")),
    restRow(14, replyPayload(AUTHOR, txId(99), "a reply of theirs")),
  ]);
  const posts = await fetchUserPosts({ engine: A.engine, pubkey: AUTHOR.pubkey });
  assert.deepEqual(posts.posts.map(textOf), ["really theirs"]);
  assert.equal(posts.outage, true);
  assert.equal(posts.pagination, null);
  const replies = await fetchUserReplies({ engine: A.engine, pubkey: AUTHOR.pubkey });
  assert.deepEqual(replies.posts.map(textOf), ["a reply of theirs"]);
  assert.equal(replies.posts[0].parentPostId, txId(99));
});

test("down: a saved profile page and REST together, the indexer's copy winning a tie", async () => {
  freshWorld();
  const shared = txId(21);
  world.respond = () => json(200, { posts: [{ id: shared, userPublicKey: AUTHOR.pubkey, postContent: b64Of("saved copy"), timestamp: clock, upVotesCount: 4 }] });
  await fetchUserPosts({ engine: A.engine, pubkey: AUTHOR.pubkey });
  world.respond = null;
  await confirmOutage();
  world.rest.set(AUTHOR.engine.address, [restRow(21, postPayload(AUTHOR, "chain copy")), restRow(22, postPayload(AUTHOR, "only on chain"))]);
  const page = await fetchUserPosts({ engine: A.engine, pubkey: AUTHOR.pubkey });
  assert.deepEqual(page.posts.map(textOf).sort(), ["only on chain", "saved copy"]);
  assert.equal(page.posts.find((post) => post.id === shared).upVotesCount, 4);
});

test("down: deletes and edits by the author apply; a replay of a signed post shows once", async () => {
  freshWorld();
  await confirmOutage();
  const gone = txId(31);
  const kept = txId(32);
  const newB64 = b64Of("edited");
  const original = postPayload(AUTHOR, "first version");
  world.rest.set(AUTHOR.engine.address, [
    restRow(31, postPayload(AUTHOR, "to be deleted"), clock - 50_000),
    restRow(32, original, clock - 40_000),
    restRow(33, original, clock - 30_000),
    restRow(34, KAPOSTS_PROTOCOL.deletePayload(AUTHOR.pubkey, AUTHOR.sign(KAPOSTS_PROTOCOL.deleteSigningString(gone)), gone), clock - 20_000),
    restRow(35, KAPOSTS_PROTOCOL.deletePayload(AUTHOR.pubkey, A.sign(KAPOSTS_PROTOCOL.deleteSigningString(kept)), kept), clock - 15_000),
    restRow(36, KAPOSTS_PROTOCOL.editPayload(AUTHOR.pubkey, AUTHOR.sign(KAPOSTS_PROTOCOL.editSigningString(kept, newB64, "[]")), kept, newB64, "[]"), clock - 10_000),
  ]);
  const page = await fetchUserPosts({ engine: A.engine, pubkey: AUTHOR.pubkey });
  assert.deepEqual(page.posts.map((post) => post.id), [kept], "deleted once, a forged delete ignored, the replay gone");
  assert.equal(textOf(page.posts[0]), "edited");
  assert.equal(page.posts[0].editedAt, clock - 10_000);
});

test("down: Following reads the people followed; up, REST isn't touched", async () => {
  freshWorld();
  world.respond = () => json(200, { posts: [] });
  await fetchFollowingFeed({ engine: A.engine, limit: 3, followingAddresses: [AUTHOR.engine.address] });
  assert.equal(world.restCalls.length, 0);
  world.respond = null;
  await confirmOutage();
  world.rest.set(AUTHOR.engine.address, [restRow(41, postPayload(AUTHOR, "followed")), restRow(42, replyPayload(AUTHOR, txId(9), "not in the feed"))]);
  const page = await fetchFollowingFeed({ engine: A.engine, limit: 3, followingAddresses: [AUTHOR.engine.address] });
  assert.deepEqual(page.posts.map(textOf), ["followed"]);
  assert.equal(page.outage, true);
});

test("one post from REST: unchecked as before with the indexer up, checked while it's down", async () => {
  freshWorld();
  const forged = postPayload(AUTHOR, "forged", { signer: A });
  world.rest.set(txId(51), { payload: hexOf(forged), block_time: clock });
  world.rest.set(txId(52), { payload: hexOf(postPayload(AUTHOR, "signed")), block_time: clock });
  assert.ok(await fetchChainPost(txId(51)), "up: unchanged");
  await confirmOutage();
  assert.equal(await fetchChainPost(txId(51)), null);
  assert.equal((await fetchChainPost(txId(52))).message, "signed");
});

// --- The block stream ------------------------------------------------------------------------------

test("down: new posts come off the stream, a bad signature dropped, replies kept for their thread", async () => {
  freshWorld();
  await fetchGlobalFeed({ engine: A.engine, limit: 9 });
  await confirmOutage();
  let feed = null;
  const engine = { ...A.engine, addBlockScanClient: (handler) => { feed = handler; return () => { feed = null; }; } };
  kapostLiveFeed.setActive(engine, true);
  assert.equal(typeof feed, "function", "the stream is asked for");
  const heard = [];
  const stopHearing = kapostLiveFeed.subscribe((posts) => heard.push(posts.length));
  const signedOnce = postPayload(AUTHOR, "live and signed");
  feed(blockWith(
    blockTx(61, signedOnce),
    blockTx(62, postPayload(AUTHOR, "live and forged", { signer: A })),
    blockTx(63, replyPayload(AUTHOR, txId(1), "live reply")),
    blockTx(64, "something else entirely"),
  ));
  feed(blockWith(blockTx(65, signedOnce))); // the same signed payload, put on chain again by anyone
  stopHearing();
  assert.equal(heard.length, 1, "told once, about the block that had something new");
  assert.deepEqual(kapostLiveFeed.posts().map((post) => post.id).sort(), [txId(61), txId(63)]);
  const global = await fetchGlobalFeed({ engine: A.engine, limit: 9 });
  assert.deepEqual(global.posts.map(textOf).sort(), ["from the indexer", "live and signed"]);
  assert.equal(global.outage, true);
  const replies = await fetchReplies({ engine: A.engine, postId: txId(1) });
  assert.deepEqual(replies.posts.map(textOf), ["live reply"]);
});

test("the real engine's block stream reaches the feed while it's down, and stops after", () => {
  freshWorld();
  const engine = new KaspaEngine({ log: () => {} });
  engine.kaspa = kaspa;
  engine.startBroadcastBlockScan = async () => null; // no node here: the blocks are handed in below
  kapostLiveFeed.setActive(engine, true);
  assert.equal(engine.blockScanWanted(), true, "the stream is kept on for it");
  engine.handleBlockAddedEvent(blockWith(
    blockTx(66, postPayload(AUTHOR, "through the engine")),
    blockTx(67, postPayload(AUTHOR, "forged through the engine", { signer: A })),
  ));
  assert.deepEqual(kapostLiveFeed.posts().map(textOf), ["through the engine"]);
  kapostLiveFeed.setActive(engine, false);
  assert.equal(engine.blockScanWanted(), false, "recovered: no more streaming for it");
  engine.handleBlockAddedEvent(blockWith(blockTx(68, postPayload(AUTHOR, "after"))));
  assert.deepEqual(kapostLiveFeed.posts(), []);
});

test("the stream is only listened to while it's down, and an engine without the handler is fine", () => {
  const live = createKaPostLiveFeed();
  let added = 0;
  let removed = 0;
  const engine = { addBlockScanClient: () => { added += 1; return () => { removed += 1; }; } };
  live.ingest(blockWith(blockTx(71, postPayload(AUTHOR, "before"))));
  assert.deepEqual(live.posts(), [], "not active: nothing taken");
  live.setActive(engine, true);
  live.setActive(engine, true);
  assert.equal(added, 1);
  live.ingest(blockWith(blockTx(72, postPayload(AUTHOR, "during"))));
  assert.equal(live.posts().length, 1);
  live.setActive(engine, false);
  assert.equal(removed, 1);
  assert.deepEqual(live.posts(), [], "the indexer has these now");
  const bare = createKaPostLiveFeed();
  bare.setActive({}, true);
  bare.setActive({}, false);
});

// --- Recovery and what stays ------------------------------------------------------------------------

test("nothing read during the outage is saved over the indexer's pages", async () => {
  freshWorld();
  await fetchGlobalFeed({ engine: A.engine, limit: 9 });
  await fetchUserPosts({ engine: A.engine, pubkey: AUTHOR.pubkey, limit: 9 });
  await confirmOutage();
  const before = storage.snapshot();
  const engine = { ...A.engine, addBlockScanClient: (handler) => { engine.push = handler; return () => {}; } };
  kapostLiveFeed.setActive(engine, true);
  engine.push(blockWith(blockTx(81, postPayload(AUTHOR, "live"))));
  world.rest.set(AUTHOR.engine.address, [restRow(82, postPayload(AUTHOR, "rest"))]);
  await fetchGlobalFeed({ engine: A.engine, limit: 9 });
  await fetchUserPosts({ engine: A.engine, pubkey: AUTHOR.pubkey, limit: 9 });
  assert.deepEqual(storage.snapshot(), before);
});

test("recovery: the minute's check finds it, and reads are the indexer's again, saved afresh", async () => {
  freshWorld();
  await fetchGlobalFeed({ engine: A.engine, limit: 9 });
  await confirmOutage();
  const changes = [];
  const stop = onIndexerAvailabilityChange((change) => changes.push(change));
  world.indexerUp = true;
  world.respond = (url) => {
    assert.match(url, /get-posts-watching\?requesterPubkey=020{64}&limit=1$/, "the check names no account");
    return json(200, { posts: [] });
  };
  clock += 61_000;
  assert.equal(kaPostIndexerIsDown(), true, "the check is on its way; still down until it answers");
  await new Promise((resolve) => setTimeout(resolve, 20));
  stop();
  assert.equal(isIndexerDown(INDEXER), false, "the answer ended it");
  assert.deepEqual(changes.map(({ key, down }) => ({ key, down })), [{ key: indexerKey(INDEXER), down: false }]);
  world.respond = () => json(200, { posts: [indexerRow(3, "back with news")], pagination: { hasMore: true, nextCursor: "c3" } });
  const page = await fetchGlobalFeed({ engine: A.engine, limit: 9 });
  assert.equal(page.outage, false);
  assert.deepEqual(page.posts.map(textOf), ["back with news"]);
  assert.equal(page.pagination.nextCursor, "c3");
  // A second outage serves what the indexer last said.
  world.respond = null;
  await confirmOutage();
  assert.deepEqual((await fetchGlobalFeed({ engine: A.engine, limit: 9 })).posts.map(textOf), ["back with news"]);
});

test("down with nothing saved: the indexer is still asked, and any answer ends the outage", async () => {
  freshWorld();
  await confirmOutage();
  world.indexerUp = true;
  world.respond = () => json(200, { posts: [indexerRow(4, "answered")] });
  const page = await fetchGlobalFeed({ engine: A.engine, limit: 2 });
  assert.equal(isIndexerDown(INDEXER), false);
  assert.deepEqual(page.posts.map(textOf), ["answered"]);
  assert.equal(page.outage, false);
});

test("an outage read adds to the screen and never replaces what's on it", () => {
  const onScreen = [{ remoteId: "b", timestamp: 20, likes: 9 }, { remoteId: "c", timestamp: 10 }];
  const merged = mergeOutageRows(onScreen, [{ remoteId: "a", timestamp: 30 }, { remoteId: "b", timestamp: 20, likes: 1 }]);
  assert.deepEqual(merged.map((row) => row.remoteId), ["a", "b", "c"]);
  assert.equal(merged[1].likes, 9, "the screen's copy stays");
  assert.equal(mergeOutageRows(onScreen, [{ remoteId: "c", timestamp: 10 }]), onScreen, "nothing new, nothing touched");
});

test("ui/kaposts.js: the feed merges during an outage, recovers, and says so", () => {
  const load = fnText("loadFeed");
  assert.match(load, /if \(result\.outage\)/);
  assert.match(load, /mergeOutageRows\(sameFeedOnScreen \? remotePosts : \[\], page\)/);
  assert.ok(load.indexOf("sameFeedOnScreen =") < load.indexOf("loadedFeedSource = feedSourceFor"), "compared before the source moves on");
  assert.ok(load.indexOf("if (result.outage)") < load.indexOf("loaded = true"), "an outage read doesn't count as a load");
  assert.match(fnText("checkForNewPosts"), /if \(kaPostIndexerIsDown\(\)\) return;/);
  const availability = fnText("handleKaPostIndexerAvailability");
  assert.match(availability, /kapostsUnavailableHere\(\)/, "testnet has no indexer to watch");
  assert.match(availability, /kapostLiveFeed\.setActive\(deps\.engine, change\.down\)/);
  assert.match(availability, /lastFeedLoadAt = 0/);
  assert.match(availability, /keptProfilePanel = null/);
  assert.match(fnText("renderStatus"), /isn't answering/);
  assert.match(fnText("initKaPosts"), /scopedKey: \(baseKey, account\) => deps\.accountScopedKey\(baseKey, account\)/);
  assert.match(fnText("fetchFeedPage"), /followingAddresses: prefs\.following/);
});

for (const [name, fn] of tests) {
  try {
    await fn();
    pass += 1;
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`FAILED - ${name}\n`, error);
    process.exitCode = 1;
  }
}
console.log(`kaposts-outage: ${pass}/${tests.length} passed`);
process.exit(process.exitCode || 0);
