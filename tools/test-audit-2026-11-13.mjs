// The fixes from the audit of 2026-11-13 (Build 289), run from their own source with the page
// around them stubbed, plus the engine's fee estimate with a stand-in SDK.
//
//   node tools/test-audit-2026-11-13.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const app = readFileSync(join(here, "..", "ui", "app.js"), "utf8");
const broadcasts = readFileSync(join(here, "..", "ui", "broadcasts.js"), "utf8");

// --- source extraction (as tools/test-ui-shell-guards.mjs) -------------------------------------
function skipLiteral(src, i) {
  const c = src[i];
  if (c === "/" && src[i + 1] === "/") { const end = src.indexOf("\n", i); return end < 0 ? src.length : end; }
  if (c === "/" && src[i + 1] === "*") return src.indexOf("*/", i + 2) + 2;
  if (c === '"' || c === "'") {
    for (let j = i + 1; j < src.length; j += 1) { if (src[j] === "\\") { j += 1; continue; } if (src[j] === c) return j + 1; }
  }
  if (c === "`") {
    for (let j = i + 1; j < src.length; j += 1) {
      if (src[j] === "\\") { j += 1; continue; }
      if (src[j] === "`") return j + 1;
      if (src[j] === "$" && src[j + 1] === "{") j = matchClose(src, j + 1, "{", "}") - 1;
    }
  }
  return i;
}
function matchClose(src, open, a, b) {
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    const next = skipLiteral(src, i);
    if (next !== i) { i = next - 1; continue; }
    if (src[i] === a) depth += 1;
    else if (src[i] === b) { depth -= 1; if (depth === 0) return i + 1; }
  }
  throw new Error("unbalanced source");
}
function extractFunction(src, name) {
  const match = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(src);
  assert.ok(match, `function ${name} in the source`);
  const paramsEnd = matchClose(src, match.index + match[0].length - 1, "(", ")");
  const bodyStart = src.indexOf("{", paramsEnd);
  return src.slice(match.index, matchClose(src, bodyStart, "{", "}"));
}
function sandbox(sources, overrides = {}) {
  const calls = [];
  const scope = new Proxy(overrides, {
    has: (target, key) => typeof key === "string" && (key in target || !(key in globalThis)),
    get: (target, key) => {
      if (key === Symbol.unscopables) return undefined;
      if (key in target) return target[key];
      const fn = (...args) => { calls.push([key, ...args]); return undefined; };
      target[key] = fn;
      return fn;
    },
    set: (target, key, value) => { target[key] = value; return true; },
  });
  const names = sources.map((src) => /function\s+([A-Za-z0-9_$]+)/.exec(src)?.[1]).filter(Boolean);
  // eslint-disable-next-line no-new-func
  const run = new Function("scope", `with (scope) { ${sources.join("\n")}\n return { ${names.join(", ")} }; }`);
  return { fns: run(scope), calls, scope: overrides, called: (name) => calls.filter((c) => c[0] === name) };
}

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`ok - ${name}`); }
  catch (error) { console.error(`not ok - ${name}`); throw error; }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// --- Chats and Public Chats ---------------------------------------------------------------------
await test("Chats redraws its list whenever the list last drew rooms (Public Chats -> Wallet -> Chats)", () => {
  const body = extractFunction(app, "setActiveAppTab");
  assert.match(body, /appSidebar\?\.dataset\.listMode !== \(isRooms \? "rooms" : "chats"\)\) \{ try \{ renderChats\(\);/);
  assert.match(body, /refreshBroadcasts\(\{ onScreen: isRooms \}\)/);
});

await test("an open room starts polling again when its screen comes back, and is read only on Public Chats", () => {
  const body = extractFunction(broadcasts, "refreshBroadcasts");
  assert.match(body, /roomOnScreen = Boolean\(onScreen\)/);
  assert.match(body, /if \(!pollTimer && isIndexerTrackedBroadcastChannel\(activeChannel\)\) \{[\s\S]*startPolling\(channel\)/);
  assert.match(broadcasts, /channel === activeChannel && tabVisible && roomOnScreen && !document\.hidden\) markChannelRead/);
  assert.match(broadcasts, /row\.channel !== activeChannel \|\| !roomOnScreen \|\| document\.hidden/);
});

await test("a chat or group counts as on screen only while Chats shows it", () => {
  const { fns, scope } = (() => {
    const ctx = sandbox([extractFunction(app, "chatOnScreen"), extractFunction(app, "groupOnScreen")], {
      activeConversationId: "c1", activeGroupId: "g1", currentAppTab: "chats",
    });
    return ctx;
  })();
  assert.equal(fns.chatOnScreen("c1"), true);
  assert.equal(fns.groupOnScreen("g1"), true);
  scope.currentAppTab = "broadcasts";
  assert.equal(fns.chatOnScreen("c1"), false);
  assert.equal(fns.groupOnScreen("g1"), false);
  scope.currentAppTab = "wallet";
  assert.equal(fns.chatOnScreen("c1"), false);
  assert.equal(fns.chatOnScreen("c2"), false);
  assert.match(app, /if \(chatOnScreen\(conversationEntry\.id\) && appIsInFront\(\)\) return;/);
  assert.match(app, /if \(groupOnScreen\(groupId\) && appIsInFront\(\)\) return false;/);
  assert.match(extractFunction(app, "webPushFocusKey"), /if \(currentAppTab !== "chats"\) return "";/);
});

await test("re-opening the open group from another screen repaints it without taking over", () => {
  const body = extractFunction(app, "openGroupChat");
  assert.match(body, /const repaintBehind = !switching && currentAppTab !== "chats";/);
  assert.match(body, /if \(repaintBehind\) \{ renderGroupList\(\); return; \}/);
});

// --- messaging ------------------------------------------------------------------------------------
await test("a stranger's request never names them: the contact gets the short address", () => {
  const body = extractFunction(app, "syncIncomingHandshakeRequests");
  assert.match(body, /const displayName = defaultAliasFor\(request\.sender\);/);
  assert.doesNotMatch(body, /request\.alias \|\|/);
});

await test("block-scan hits never move the inbox cursor", () => {
  assert.match(extractFunction(app, "syncInbox"), /if \(!streamHits && nextCursor != null && nextCursor > s\.inboxCursor\)/);
});

await test("long-note parts stop after one that is Not confirmed, and the rest wait as Failed", async () => {
  const statuses = { a: "pending", b: "pending", c: "pending" };
  const patched = [];
  const ctx = sandbox([extractFunction(app, "sendOneToOnePartsInOrder")], {
    MESSAGE_STATUSES: { FAILED: "failed" }, MESSAGE_STATUS_UNCONFIRMED: "unconfirmed",
    state: { conversations: [{ id: "c", messages: Object.keys(statuses).map((id) => ({ id, get status() { return statuses[id]; } })) }] },
    runEngineSendPipeline: async (cid, id) => { statuses[id] = id === "a" ? "unconfirmed" : "confirmed"; },
    updateMessageStatus: (cid, id, patch) => patched.push([id, patch.status]),
  });
  assert.equal(await ctx.fns.sendOneToOnePartsInOrder("c", ["a", "b", "c"]), false);
  assert.deepEqual(patched, [["b", "failed"], ["c", "failed"]]);
});

await test("a stale copy never turns a later Failed back into Sending; confirmed still wins", () => {
  const body = extractFunction(app, "hydrateConversationMessages");
  assert.match(body, /if \(statusRank\(older\.status\) === 2 && statusRank\(merged\.status\) < 2\) merged\.status = older\.status;/);
  assert.match(app, /try \{ leftoverSendsSettled\.clear\(\); \} catch/);
});

await test("two quick first messages: the second waits for the first and goes untagged", async () => {
  const tagged = new Set();
  const ctx = sandbox([extractFunction(app, "releaseInboxTagClaim"), extractFunction(app, "firstContactInboxTag")], {
    inboxTagClaims: new Map(),
    engine: { address: "kaspa:me", inboxTagFor: () => "tag" },
    chatRequestState: () => ({ privateChats: new Set(), inboxTagged: tagged }),
    isPaymentLikeMessage: () => false,
    state: { conversations: [] },
    inboxSupported: async () => true,
  });
  const contact = { address: "kaspa:them" };
  const first = await ctx.fns.firstContactInboxTag(contact, { messages: [] });
  assert.equal(first, "tag");
  let secondDone = false;
  const second = ctx.fns.firstContactInboxTag(contact, { messages: [] }).then((tag) => { secondDone = true; return tag; });
  await tick();
  assert.equal(secondDone, false, "waits while the tagged first message is being sent");
  tagged.add("kaspa:them"); // the first went out (noteInboxTagged)
  ctx.fns.releaseInboxTagClaim("kaspa:them");
  assert.equal(await second, null);
});

await test("a payment notice is never written by an account that took over mid-payment", async () => {
  const ctx = sandbox([extractFunction(app, "sendPaymentNoticeEnvelope")], { engine: { address: "kaspa:new" } });
  await assert.rejects(ctx.fns.sendPaymentNoticeEnvelope({ id: "c" }, { id: "k", address: "kaspa:them" }, "payload", "kaspa:old"), /account changed/);
  assert.equal(ctx.called("createEncryptedMessageEnvelope").length, 0);
});

await test("an exported cell can't run as a spreadsheet formula", () => {
  const { fns } = sandbox([extractFunction(app, "csvEscape")]);
  assert.equal(fns.csvEscape("=HYPERLINK(\"x\")"), '"\'=HYPERLINK(""x"")"');
  assert.equal(fns.csvEscape("+1"), '"\'+1"');
  assert.equal(fns.csvEscape("@me"), '"\'@me"');
  assert.equal(fns.csvEscape("hello"), '"hello"');
  assert.equal(fns.csvEscape(-5), '"-5"', "a number stays a number");
});

await test("a group message's own chain copy fills in its still-sending bubble", () => {
  const list = [{ id: "local", senderAddress: "kaspa:me", text: "hi", txId: null, msgIdHex: null, status: "pending", createdAt: 1 }];
  let saved = null;
  const ctx = sandbox([extractFunction(app, "appendGroupMessage"), extractFunction(app, "groupMessagesAreSame")], {
    engine: { address: "kaspa:me" },
    groupMessages: () => list,
    saveGroupMessages: (gid, rows) => { saved = rows; },
    MESSAGE_STATUSES: { PENDING: "pending", CONFIRMED: "confirmed", FAILED: "failed" },
    MESSAGE_STATUS_UNCONFIRMED: "unconfirmed",
  });
  assert.equal(ctx.fns.appendGroupMessage("g", { id: "chain", senderAddress: "kaspa:me", text: "hi", txId: "t1", msgIdHex: "m1", createdAt: 2 }), false);
  assert.equal(saved.length, 1);
  assert.deepEqual([saved[0].id, saved[0].txId, saved[0].msgIdHex, saved[0].status], ["local", "t1", "m1", "confirmed"]);
});

// --- fees -----------------------------------------------------------------------------------------
await test("the fee estimate prices a fresh quantum-safe change address", async () => {
  const { estimateOnchainFeeDetail } = await import("../engine/transactions.js");
  const seen = [];
  const kaspa = {
    createTransactions: async ({ changeAddress }) => { seen.push(changeAddress); return { summary: { fees: 2000n, mass: 2000n }, transactions: [] }; },
  };
  const entry = { outpoint: { transactionId: "aa", index: 0 }, amount: 100_000_000n, scriptPublicKey: { version: 0, script: "20" + "11".repeat(32) + "ac" } };
  const rpc = { getUtxosByAddresses: async () => ({ entries: [entry] }) };
  const source = "kaspa:qypq3h5t3tgwqjmjhyerzdxeh9am9la4d6t3ahsn8d6fxn2xnp06f5qe2lzds5l";
  await estimateOnchainFeeDetail({ kaspa, rpc, sourceAddress: source, amountKas: "0.5" }).catch(() => null);
  await estimateOnchainFeeDetail({ kaspa, rpc, sourceAddress: source, amountKas: "0.5", quantumChange: true }).catch(() => null);
  assert.equal(seen.length, 2, `estimated twice (${seen.length})`);
  assert.equal(seen[0], source, "plain: change back to the source");
  assert.match(String(seen[1]), /^kaspa:p/, "quantum: a P2SH (kaspa:p...) change address");
});

console.log(`audit 2026-11-13: ${passed} passed`);
