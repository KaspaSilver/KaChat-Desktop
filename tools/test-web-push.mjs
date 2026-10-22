// node tools/test-web-push.mjs - Web Push, the parts with no browser: the signed-challenge auth
// (ui/web-push-core.js, a port of iOS PushNotificationManager.buildAuthPreimage and of what the
// push service verifies), the registration body, base64url / VAPID key handling, Kaspa address
// decoding for KaPosts author keys, the device-key signature format, and what the service worker
// shows for each push payload (public/sw-push.js). Nothing leaves the machine.
//
// When the iOS app and kachat-indexer checkouts sit next to this repo, the preimage line order is
// also read out of their sources (PushNotificationManager.swift buildAuthPreimage /
// buildDeviceAuthPreimage, push.rs build_auth_preimage / build_device_auth_preimage) and compared
// with ours, so a change on either side fails here.
import assert from "node:assert/strict";
import { createHash, createPublicKey, verify as nodeVerify, webcrypto } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";
import {
  buildAuthPreimage, buildDeviceAuthPreimage, buildPushAuth, buildRegistrationFields, registrationFingerprint,
  canonicalWatchedAddresses, canonicalAliases, canonicalGroupIds, walletPubkeyHex, compressedPubkeyHex,
  verifyPreimageSignature, clampAuthTimestamp, nextDeviceCounter, normalizeWebDeviceToken,
  toBase64Url, fromBase64Url, toBase64, vapidKeyBytes, sameBytes, bytesToHex, hexToBytes,
  decodeKaspaAddress, encodeKaspaAddress, authorKeyFromAddress, PUSH_LIMITS,
} from "../ui/web-push-core.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const sha = (text) => createHash("sha256").update(text, "utf8").digest("hex");

let pass = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const SECRET = "11".repeat(32); // the push service's own test key (push.rs schnorr_verification_accepts_valid_signature)
const ENDPOINT = "https://web.push.apple.com/QGuQyavXutnMH6bR9MvK7vQ1sJ0x-example_endpoint";
const ME = encodeKaspaAddress("kaspa", 0, hexToBytes(walletPubkeyHex(SECRET)));
const ALICE = "kaspa:qzy7da4589avjwmmnqfvkhp5p8p268gc7rvr9lg2xxpuhj75sy8kgdqmpd2fu";
const ECDSA_ADDR = "kaspa:qyp4nvaq3pdq7609z09fvdgwtc9c7rg07fuw5zgeee7xpr085de59eseqfcmynn";

// ---- preimage -------------------------------------------------------------------------------
test("register preimage: iOS's transitional-groups shape, every hash over the canonical list", () => {
  const preimage = buildAuthPreimage({
    nonce: "  abcd  ", method: "POST", path: "/v1/push/register", deviceToken: ENDPOINT,
    watchedAddresses: ["Kaspa:QPB", " kaspa:qpa ", "kaspa:qpa", ""], watchedGroupIds: ["FF", "aa"],
    primaryAddress: ME, aliases: ["b", " a ", "a"], walletPubkey: "pk", walletAddress: ME, timestampMs: 10, expiresAtMs: 20,
  });
  assert.equal(preimage, [
    "domain=kchat-push-auth:v1",
    "nonce=abcd",
    "method=POST",
    "path=/v1/push/register",
    `device_token_hash=${sha(ENDPOINT)}`,
    `watched_addresses_hash=${sha("kaspa:qpa\nkaspa:qpb")}`,
    `watched_group_ids_hash=${sha("aa\nff")}`,
    `primary_address=${ME}`,
    `aliases_hash=${sha("a\nb")}`,
    "wallet_pubkey=pk",
    `wallet_address=${ME}`,
    "timestamp_ms=10",
    "expires_at_ms=20",
  ].join("\n"));
});

test("unregister preimage: LegacyV1 (no group line) over empty lists, as the service verifies it", () => {
  const preimage = buildAuthPreimage({
    nonce: "n", method: "DELETE", path: "/v1/push/unregister", deviceToken: ENDPOINT, withGroupIds: false,
    walletPubkey: "pk", walletAddress: ME, timestampMs: 1, expiresAtMs: 2,
  });
  assert.ok(!preimage.includes("watched_group_ids_hash="));
  assert.ok(preimage.includes(`watched_addresses_hash=${sha("")}\nprimary_address=\naliases_hash=${sha("")}`));
});

test("device preimage matches the device_key_v1 layout", () => {
  assert.equal(buildDeviceAuthPreimage({ nonce: " n ", method: "POST", path: "/v1/push/register", deviceToken: ENDPOINT, keyId: "k", counter: 7, timestampMs: 1, expiresAtMs: 2 }), [
    "domain=kchat-push-device-auth:v1", "nonce=n", "method=POST", "path=/v1/push/register",
    `device_token_hash=${sha(ENDPOINT)}`, "key_id=k", "counter=7", "timestamp_ms=1", "expires_at_ms=2",
  ].join("\n"));
});

test("canonical lists: lowercase/trim/dedupe/sort for addresses and group ids, case kept for aliases", () => {
  assert.deepEqual(canonicalWatchedAddresses(["B", "a", " A "]), ["a", "b"]);
  assert.deepEqual(canonicalGroupIds(["CC", "bb", ""]), ["bb", "cc"]);
  assert.deepEqual(canonicalAliases(["Zz", "aa", " aa"]), ["Zz", "aa"]);
});

function linesOf(fnSource, pattern) {
  return [...fnSource.matchAll(pattern)].map((m) => m[1]);
}
test("line order equals the iOS app's and the push service's (when their checkouts are present)", () => {
  const ours = buildAuthPreimage({ nonce: "n", method: "POST", path: "/p", deviceToken: "t", walletPubkey: "w", walletAddress: "a", timestampMs: 1, expiresAtMs: 2 })
    .split("\n").map((line) => line.split("=")[0]);
  const oursDevice = buildDeviceAuthPreimage({ nonce: "n", method: "POST", path: "/p", deviceToken: "t", keyId: "k", counter: 1, timestampMs: 1, expiresAtMs: 2 })
    .split("\n").map((line) => line.split("=")[0]);
  const swiftPath = path.resolve(root, "../KaChat/KaChat/Services/PushNotificationManager.swift");
  if (existsSync(swiftPath)) {
    const swift = readFileSync(swiftPath, "utf8");
    const start = swift.indexOf("private func buildAuthPreimage(");
    const body = swift.slice(start, swift.indexOf("return lines.joined", start));
    assert.deepEqual(linesOf(body, /"([a-z_]+)=\\\(/g), ours, "iOS buildAuthPreimage line order");
    const dStart = swift.indexOf("private func buildDeviceAuthPreimage(");
    const dBody = swift.slice(dStart, swift.indexOf("].joined", dStart));
    assert.deepEqual(linesOf(dBody, /"([a-z_]+)=\\\(/g), oursDevice, "iOS buildDeviceAuthPreimage line order");
  } else console.log("  (iOS checkout not found: skipped the Swift comparison)");
  const rustPath = path.resolve(root, "../kachat-indexer/kasia-indexer/indexer/src/api/v1/push.rs");
  if (existsSync(rustPath)) {
    const rust = readFileSync(rustPath, "utf8");
    const start = rust.indexOf("fn build_auth_preimage(");
    const body = rust.slice(start, rust.indexOf("lines.join", start));
    // The transitional format: every line but auth_version= / capabilities_hash= (V2 only).
    const rustKeys = linesOf(body, /format!\(\s*"([a-z_]+)=/g).filter((key) => key !== "capabilities_hash");
    assert.deepEqual(rustKeys, ours, "push.rs build_auth_preimage line order");
    const dStart = rust.indexOf("fn build_device_auth_preimage(");
    const dBody = rust.slice(dStart, rust.indexOf(".join", dStart));
    assert.deepEqual(linesOf(dBody, /format!\("([a-z_]+)=/g), oursDevice, "push.rs build_device_auth_preimage line order");
  } else console.log("  (kachat-indexer checkout not found: skipped the Rust comparison)");
});

// ---- signing --------------------------------------------------------------------------------
test("the wallet key: x-only pubkey, its Schnorr address, a BIP340 signature that verifies", () => {
  const pubkey = walletPubkeyHex(SECRET);
  assert.match(pubkey, /^[0-9a-f]{64}$/);
  assert.match(compressedPubkeyHex(SECRET), /^0[23][0-9a-f]{64}$/);
  assert.equal(compressedPubkeyHex(SECRET).slice(2), pubkey);
  const challenge = { nonce: "abcd", issued_at_ms: 1000, expires_at_ms: 61000 };
  const { auth, preimage } = buildPushAuth({
    privateKeyHex: SECRET, walletAddress: ME, challenge, method: "POST", path: "/v1/push/register",
    deviceToken: ENDPOINT, watchedAddresses: [ME, ALICE], watchedGroupIds: [], primaryAddress: ME, aliases: ["x"], nowMs: 5000,
  });
  assert.equal(auth.wallet_pubkey, pubkey);
  assert.equal(auth.timestamp_ms, 5000);
  assert.equal(auth.expires_at_ms, 61000);
  assert.match(auth.signature, /^[0-9a-f]{128}$/);
  assert.ok(verifyPreimageSignature(preimage, auth.signature, pubkey));
  assert.ok(!verifyPreimageSignature(`${preimage}x`, auth.signature, pubkey));
});

test("the signed time is the local clock clamped into the challenge window (iOS)", () => {
  assert.equal(clampAuthTimestamp(5, 10, 20), 10);
  assert.equal(clampAuthTimestamp(15, 10, 20), 15);
  assert.equal(clampAuthTimestamp(99, 10, 20), 20);
});

test("device counter only goes up, even with the stored count lost", () => {
  assert.equal(nextDeviceCounter(0, 1000), 1000);
  assert.equal(nextDeviceCounter(5000, 1000), 5001);
  assert.ok(nextDeviceCounter(undefined, Date.now()) > 1e12);
});

test("WebCrypto's P-256 signature (r||s) verifies as the service's FIXED form; key_id = sha256(raw pubkey)", async () => {
  const pair = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const raw = new Uint8Array(await webcrypto.subtle.exportKey("raw", pair.publicKey));
  assert.equal(raw.length, 65);
  assert.equal(raw[0], 4);
  const message = Buffer.from(buildDeviceAuthPreimage({ nonce: "n", method: "POST", path: "/v1/push/register", deviceToken: ENDPOINT, keyId: "k", counter: 1, timestampMs: 1, expiresAtMs: 2 }));
  const signature = new Uint8Array(await webcrypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, message));
  assert.equal(signature.length, 64);
  const jwk = await webcrypto.subtle.exportKey("jwk", pair.publicKey);
  assert.ok(nodeVerify("sha256", message, { key: createPublicKey({ key: jwk, format: "jwk" }), dsaEncoding: "ieee-p1363" }, signature));
  assert.equal(fromBase64Url(toBase64(raw)).length, 65); // the service's decode_base64_any reads standard base64
  assert.match(createHash("sha256").update(raw).digest("hex"), /^[0-9a-f]{64}$/);
});

// ---- tokens and keys ------------------------------------------------------------------------
test("device token = the endpoint, trimmed and otherwise verbatim; only https", () => {
  assert.equal(normalizeWebDeviceToken(`  ${ENDPOINT} `), ENDPOINT);
  assert.throws(() => normalizeWebDeviceToken("http://example.com/x"));
  assert.throws(() => normalizeWebDeviceToken("https://a b"));
  assert.throws(() => normalizeWebDeviceToken(`https://x/${"a".repeat(2100)}`));
});

test("base64url: round trips, no padding, either alphabet accepted", () => {
  const bytes = Uint8Array.from([0xfb, 0xff, 0x00, 0x10, 0x3e]);
  const text = toBase64Url(bytes);
  assert.equal(text, "-_8AED4");
  assert.ok(sameBytes(fromBase64Url(text), bytes));
  assert.ok(sameBytes(fromBase64Url("+/8AED4="), bytes));
  assert.throws(() => fromBase64Url("not*base64"));
});

test("a VAPID key must be a 65-byte uncompressed point", () => {
  const point = new Uint8Array(65); point[0] = 4; point[64] = 9;
  assert.ok(sameBytes(vapidKeyBytes(toBase64Url(point)), point));
  assert.throws(() => vapidKeyBytes(toBase64Url(point.slice(1))));
  const compressed = new Uint8Array(65); compressed[0] = 2;
  assert.throws(() => vapidKeyBytes(toBase64Url(compressed)));
  assert.ok(!sameBytes(point, point.slice(1)));
});

test("Kaspa addresses: checksum, round trip, and the author key K knows a poster by", () => {
  assert.equal(encodeKaspaAddress("kaspa", 0, decodeKaspaAddress(ALICE).payload), ALICE);
  assert.equal(encodeKaspaAddress("kaspa", 1, decodeKaspaAddress(ECDSA_ADDR).payload), ECDSA_ADDR);
  assert.equal(decodeKaspaAddress(`${ALICE.slice(0, -1)}x`), null);
  assert.equal(decodeKaspaAddress("nonsense"), null);
  assert.equal(authorKeyFromAddress(ALICE), "89e6f6b4397ac93b7b9812cb5c3409c2ad1d18f0d832fd0a3183cbcbd4810f64");
  assert.equal(authorKeyFromAddress(ECDSA_ADDR), "0359b3a0885a0f69e513ca96350e5e0b8f0d0ff278ea0919ce7c608de7a37342e6");
  assert.equal(decodeKaspaAddress(ME).version, 0);
  assert.equal(bytesToHex(decodeKaspaAddress(ME).payload), walletPubkeyHex(SECRET));
});

// ---- registration body ----------------------------------------------------------------------
test("registration body: iOS's fields + platform web + web_push, lists normalised and capped", () => {
  const many = Array.from({ length: 300 }, (_, i) => `kaspa:qq${String(i).padStart(4, "0")}`);
  const fields = buildRegistrationFields({
    endpoint: ENDPOINT, p256dh: "BPub", authSecret: "sec", primaryAddress: ME,
    watchedAddresses: [ME, ME.toUpperCase(), ...many], watchedGroupIds: ["AB", "ab"], aliases: ["x", "x", ""],
    broadcastChannels: ["Kaspa", "kaspa"], hiddenBroadcastSenders: { Kaspa: ["s2", "s1", "s1"], empty: [] },
    kaposts: { pubkey: "02aa", likes: false }, kapostsWatchAuthors: ["AA", "aa", "bb"], watchOnlyAddresses: ["kaspa:qspend"],
  });
  assert.equal(fields.platform, "web");
  assert.equal(fields.device_token, ENDPOINT);
  assert.deepEqual(fields.web_push, { endpoint: ENDPOINT, p256dh: "BPub", auth: "sec" });
  assert.equal(fields.watched_addresses.length, PUSH_LIMITS.watched);
  assert.equal(fields.watched_addresses[0], ME.toLowerCase()); // first in = kept
  assert.deepEqual(fields.watched_group_ids, ["ab"]);
  assert.deepEqual(fields.aliases, ["x"]);
  assert.deepEqual(fields.watched_broadcast_channels, ["kaspa"]);
  assert.deepEqual(fields.hidden_broadcast_senders, { kaspa: ["s1", "s2"] });
  assert.equal(fields.kaposts_pubkey, "02aa");
  assert.equal(fields.kaposts_notify_likes, false);
  assert.equal(fields.kaposts_notify_comments, true);
  assert.deepEqual(fields.kaposts_watch_authors, ["aa", "bb"]);
  assert.deepEqual(fields.watch_only_addresses, ["kaspa:qspend"]);
  assert.equal(fields.primary_address, ME);
  assert.ok(!("auth" in fields));
  assert.ok(!("apns_environment" in fields) && !("voip_token" in fields));
});

test("no KaPosts identity (Simple Mode): no pubkey, no bell list, switches default on", () => {
  const fields = buildRegistrationFields({ endpoint: ENDPOINT, p256dh: "p", authSecret: "a", watchedAddresses: [ME], kapostsWatchAuthors: ["aa"] });
  assert.equal(fields.kaposts_pubkey, null);
  assert.deepEqual(fields.kaposts_watch_authors, []);
  assert.equal(fields.kaposts_notify_follows, true);
});

test("fingerprint: order-free, changes with content or wallet", () => {
  const a = buildRegistrationFields({ endpoint: ENDPOINT, p256dh: "p", authSecret: "a", watchedAddresses: [ME, ALICE] });
  const b = buildRegistrationFields({ endpoint: ENDPOINT, p256dh: "p", authSecret: "a", watchedAddresses: [ALICE, ME] });
  const c = buildRegistrationFields({ endpoint: ENDPOINT, p256dh: "p", authSecret: "a", watchedAddresses: [ME] });
  assert.equal(registrationFingerprint(a, ME), registrationFingerprint(b, ME));
  assert.notEqual(registrationFingerprint(a, ME), registrationFingerprint(c, ME));
  assert.notEqual(registrationFingerprint(a, ME), registrationFingerprint(a, ALICE));
});

// ---- the service worker's payload mapping ---------------------------------------------------
const sandbox = { globalThis: null };
sandbox.globalThis = sandbox;
vm.runInNewContext(readFileSync(path.join(root, "public/sw-push.js"), "utf8"), sandbox);
const { notificationFromPush, routeKey } = sandbox.KaChatPushMap;
const BOB = "kaspa:qpbob0000000000000000000000000000000000000000000000000000";
const mirror = {
  account: ME.toLowerCase(), unit: "KAS", sound: true,
  names: { [ALICE]: "Alice" }, quiet: [BOB], blocked: ["kaspa:qpblocked"],
  groups: { ["ab".repeat(32)]: { g: "group-1", n: "Friends", m: ALICE } },
  addressLabels: { "kaspa:qspend": "Spending address kaspa:qspend" },
};
const plain = (value) => JSON.parse(JSON.stringify(value)); // across the vm boundary

test("1:1 message: the mirrored name, 'New message', one tag per chat, opens the chat, counts on the badge", () => {
  const n = plain(notificationFromPush({ v: "1", type: "contextual", sender: ALICE, tx_id: "t1" }, mirror));
  assert.equal(n.title, "Alice");
  assert.equal(n.options.body, "New message");
  assert.equal(n.options.tag, `kachat-chat-${ALICE}`);
  assert.equal(n.options.renotify, true);
  assert.equal(n.options.silent, false);
  assert.deepEqual(n.options.data.route, { kind: "chatAddress", address: ALICE });
  assert.equal(n.options.data.key, "t1");
  assert.equal(n.badge, "increment");
  assert.equal(n.suppress, false);
});

test("payment: 'Sent you 1.5 KAS' (trailing zeros trimmed), unknown amount 'Sent you a payment'", () => {
  assert.equal(plain(notificationFromPush({ type: "payment", sender: ALICE, amount: "150000000" }, mirror)).options.body, "Sent you 1.5 KAS");
  assert.equal(plain(notificationFromPush({ type: "payment", sender: ALICE, amount: "100000000" }, { ...mirror, unit: "TKAS" })).options.body, "Sent you 1 TKAS");
  assert.equal(plain(notificationFromPush({ type: "payment", sender: ALICE }, mirror)).options.body, "Sent you a payment");
});

test("unknown sender: short address; No Sound contact: silent; sound off: silent", () => {
  const n = plain(notificationFromPush({ type: "contextual", sender: BOB }, mirror));
  assert.equal(n.title, "kaspa:qpbob0...000000");
  assert.equal(n.options.silent, true);
  assert.equal(plain(notificationFromPush({ type: "handshake", sender: ALICE }, { ...mirror, sound: false })).options.silent, true);
  assert.equal(plain(notificationFromPush({ type: "handshake", sender: ALICE }, mirror)).options.body, "Started a conversation");
});

test("message request (inbox push): iOS wording, one tag per sender, opens Message Requests, no badge", () => {
  const n = plain(notificationFromPush({ type: "contextual", inbox: "true", sender: BOB }, mirror));
  assert.equal(n.title, "New message request");
  assert.equal(n.options.body, "kaspa:qpbob0...000000 wants to chat with you.");
  assert.equal(n.options.tag, `kachat-request-${BOB}`);
  assert.deepEqual(n.options.data.route, { kind: "requests" });
  assert.equal(n.badge, null);
});

test("suppressed as iOS would: your own message, a blocked sender, the other network", () => {
  assert.equal(notificationFromPush({ type: "contextual", sender: ME }, mirror).suppress, true);
  assert.equal(notificationFromPush({ type: "contextual", sender: "kaspa:qpblocked" }, mirror).suppress, true);
  assert.equal(notificationFromPush({ type: "contextual", sender: "kaspatest:qpother" }, mirror).suppress, true);
  assert.equal(notificationFromPush({ type: "contextual", sender: ME }, mirror).badge, null);
});

test("group: name from the mirrored blinded id, 'member: New message', opens the group; unknown id falls back", () => {
  const n = plain(notificationFromPush({ type: "group_message", sender: ALICE, blinded_group_id: "AB".repeat(32) }, mirror));
  assert.equal(n.title, "Friends");
  assert.equal(n.options.body, "Alice: New message");
  assert.equal(n.options.tag, "kachat-group-group-1");
  assert.deepEqual(n.options.data.route, { kind: "group", groupId: "group-1" });
  assert.equal(n.badge, "increment");
  const unknown = plain(notificationFromPush({ type: "group_message", blinded_group_id: "cd".repeat(32) }, mirror));
  assert.equal(unknown.title, "Group chat");
  assert.equal(unknown.options.body, "New group message");
  assert.equal(plain(notificationFromPush({ type: "group_control", blinded_group_id: "ab".repeat(32) }, mirror)).options.body, "Group update");
});

test("public room, KaPosts, .kachat names, Address Activity: wording, tags and routes", () => {
  const room = plain(notificationFromPush({ type: "broadcast", channel: "Kaspa", title: "#kaspa", subtitle: "bob.kas", body: "gm", tx_id: "b1" }, mirror));
  assert.equal(room.title, "#kaspa");
  assert.equal(room.options.body, "bob.kas: gm");
  assert.equal(room.options.tag, "kachat-broadcast-b1");
  assert.deepEqual(room.options.data.route, { kind: "room", channel: "kaspa" });
  assert.equal(room.badge, null);
  assert.equal(plain(notificationFromPush({ type: "broadcast", channel: "kaspa", body: '{"text":"hi there"}' }, mirror)).options.body, "hi there");
  assert.equal(plain(notificationFromPush({ type: "broadcast", channel: "kaspa", body: "A".repeat(400) }, mirror)).options.body, "New message");
  assert.equal(notificationFromPush({ type: "broadcast", channel: "kaspa" }, { ...mirror, childMode: true }).suppress, true);
  const post = plain(notificationFromPush({ type: "kaposts", subtitle: "alice.kas", body: "liked your post", post_id: "p1", tx_id: "k1" }, mirror));
  assert.equal(post.title, "KaPosts");
  assert.equal(post.options.body, "alice.kas liked your post");
  assert.deepEqual(post.options.data.route, { kind: "kapost", txId: "p1" });
  const name = plain(notificationFromPush({ type: "name_event", title: "New offer on alice.kachat", body: "12 KAS offered for it.", name: "alice", dedup: "offer:alice:1" }, mirror));
  assert.equal(name.title, "New offer on alice.kachat");
  assert.equal(name.options.tag, "kachat-name-offer:alice:1");
  assert.deepEqual(name.options.data.route, { kind: "tab", tab: "kachat-names", name: "alice" });
  const funds = plain(notificationFromPush({ type: "address_activity", address: "kaspa:qspend", amount_kas: "12.5", tx_id: "f1" }, mirror));
  assert.equal(funds.title, "Received 12.5 KAS");
  assert.equal(funds.options.body, "Spending address kaspa:qspend");
  assert.equal(funds.options.tag, "kachat-addr-activity-f1");
  assert.deepEqual(funds.options.data.route, { kind: "address", address: "kaspa:qspend" });
});

test("an unread hint sets the badge; an unknown type uses the server's words", () => {
  assert.equal(notificationFromPush({ type: "contextual", sender: ALICE, unread: "7" }, mirror).badge, 7);
  const other = plain(notificationFromPush({ type: "future_thing", title: "T", body: "B", tx_id: "z" }, mirror));
  assert.equal(other.title, "T");
  assert.equal(other.options.body, "B");
  const empty = plain(notificationFromPush(null, null));
  assert.equal(empty.title, "KaChat");
});

test("route keys match the app's focus keys (sw.js keeps quiet for the stream on screen)", () => {
  assert.equal(routeKey({ kind: "chatAddress", address: ALICE.toUpperCase() }), `chat:${ALICE}`);
  assert.equal(routeKey({ kind: "group", groupId: "g" }), "group:g");
  assert.equal(routeKey({ kind: "room", channel: "Kaspa" }), "room:kaspa");
  assert.equal(routeKey({ kind: "tab", tab: "chats" }), "");
});

for (const [name, fn] of tests) {
  try { await fn(); pass += 1; console.log(`ok - ${name}`); }
  catch (error) { console.error(`FAIL - ${name}\n`, error); process.exitCode = 1; }
}
console.log(`${pass}/${tests.length} passed`);
