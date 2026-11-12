// node tools/test-voice-parts.mjs - long voice notes and multi-part photos (iOS 7c5c22e3,
// MESSAGING.md "Long voice notes (multi-part)" and "Photos: quality tiers and multi-part photos").
//
//   - the part tag's rules (count 2...12, index 1...count, hex id 16...64, integers only);
//   - the head sniff, voicePart on audio only and mediaPart on images only;
//   - the media frame carries the tag both ways, sorted like JSONSerialization;
//   - grouping: one cluster per (owner, id, count), anchored at the earliest part, delivered
//     duplicates preferred, combined status, unread counted once;
//   - the voice layout and the WebM writer agree with iOS's numbers (30,807 bytes for a full 1:1
//     part, 20,929 for a group part, 12 parts at the longest note);
//   - the WebM reader finds the packets, pre-skip and Info Duration it wrote;
//   - the photo tiers' fees match the table in MESSAGING.md.

import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const vp = await import("../engine/voice-parts.js");
const frame = await import("../engine/media-frame.js");
const webm = await import("../engine/webm-opus.js");

const ID = "0123456789abcdef0123456789abcdef";

// --- the tag ---------------------------------------------------------------------------------
assert.deepEqual(vp.makePartTag(ID.toUpperCase(), 2, 12), { id: ID, index: 2, count: 12 });
assert.equal(vp.makePartTag(ID, 1, 1), null, "one part is no tag");
assert.equal(vp.makePartTag(ID, 1, 13), null, "13 parts is past the bound");
assert.equal(vp.makePartTag(ID, 0, 3), null);
assert.equal(vp.makePartTag(ID, 4, 3), null);
assert.equal(vp.makePartTag(ID, 1.5, 3), null);
assert.equal(vp.makePartTag("abc", 1, 3), null, "short id");
assert.equal(vp.makePartTag("z".repeat(32), 1, 3), null, "not hex");
assert.equal(vp.partTagFromObject({ id: ID, index: "1", count: 3 }), null, "string index");
assert.equal(vp.partTagFromObject({ id: ID, index: true, count: 3 }), null, "boolean index");

function voiceJson(tag, { mime = "audio/webm", key = "voicePart" } = {}) {
  return frame.mediaFileEnvelopeJson({
    name: tag ? vp.voicePartFileName(tag) : "voice.webm",
    size: 3,
    mimeType: mime,
    dataUrlContent: `data:${mime};base64,AAAA`,
    [key]: tag,
  });
}

const tag2 = { id: ID, index: 2, count: 3 };
const json2 = voiceJson(tag2);
assert.equal(json2, `{"type":"file","name":"voice-2of3.webm","size":3,"mimeType":"audio/webm","voicePart":{"id":"${ID}","index":2,"count":3},"content":"data:audio/webm;base64,AAAA"}`);
assert.deepEqual(vp.sniffPartTag(json2), { kind: "voice", id: ID, index: 2, count: 3 });
assert.equal(vp.sniffPartTag(voiceJson(tag2, { mime: "image/jpeg", key: "voicePart" })), null, "voicePart on an image is no tag");
assert.deepEqual(vp.sniffPartTag(voiceJson(tag2, { mime: "image/jpeg", key: "mediaPart" })), { kind: "photo", id: ID, index: 2, count: 3 });
assert.equal(vp.sniffPartTag(voiceJson(null)), null);
assert.equal(vp.sniffPartTag("hello"), null);

// --- the frame -------------------------------------------------------------------------------
const framed = frame.mediaFrameForEnvelope(json2);
const headerLength = (framed[5] << 24) | (framed[6] << 16) | (framed[7] << 8) | framed[8];
const header = new TextDecoder().decode(framed.subarray(9, 9 + headerLength));
assert.equal(header, `{"mimeType":"audio\\/webm","name":"voice-2of3.webm","size":3,"voicePart":{"count":3,"id":"${ID}","index":2}}`);
assert.equal(frame.mediaEnvelopeFromFrame(framed), json2, "the frame reads back as the tagged JSON");
assert.equal(frame.mediaFrameByteLength({ rawBytes: 3, name: "voice-2of3.webm", mimeType: "audio/webm", part: tag2 }), framed.length);
const photoJson = voiceJson(tag2, { mime: "image/jpeg", key: "mediaPart" });
const photoFrame = frame.mediaFrameForEnvelope(photoJson);
assert.ok(new TextDecoder().decode(photoFrame).includes('{"mediaPart":{"count":3,'), "mediaPart sorts first");
assert.equal(frame.mediaEnvelopeFromFrame(photoFrame), photoJson);
// A malformed tag is dropped on the way in and on the way out.
const bad = json2.replace('"count":3', '"count":30');
assert.ok(!frame.mediaEnvelopeFromFrame(frame.mediaFrameForEnvelope(bad)).includes("voicePart"));

// --- grouping --------------------------------------------------------------------------------
const accessors = { content: (m) => m.content, owner: (m) => m.owner, key: (m) => m.key, status: (m) => m.status };
const thread = [
  { key: "a", owner: "kaspa:x", content: "hi", status: "sent" },
  { key: "p1", owner: "kaspa:x", content: voiceJson({ id: ID, index: 1, count: 3 }), status: "sent" },
  { key: "b", owner: "kaspa:x", content: "between", status: "sent" },
  { key: "p3", owner: "kaspa:x", content: voiceJson({ id: ID, index: 3, count: 3 }), status: "failed" },
  { key: "p3b", owner: "kaspa:x", content: voiceJson({ id: ID, index: 3, count: 3 }), status: "sent" },
  { key: "q1", owner: "kaspa:y", content: voiceJson({ id: ID, index: 1, count: 3 }), status: "sent" },
];
const grouped = vp.groupParts(thread, accessors);
assert.equal(grouped.clusters.size, 2, "same id from another sender is another note");
const cluster = grouped.clusters.get("p1");
assert.equal(cluster.parts.length, 2);
assert.deepEqual(cluster.parts.map((m) => m.key), ["p1", "p3b"], "the delivered duplicate wins");
assert.equal(cluster.isComplete, false);
assert.equal(cluster.status, "sent");
assert.deepEqual([...grouped.hidden].sort(), ["p3", "p3b"]);
assert.equal(grouped.anchorKeyOf.get("p3"), "p1");
assert.equal(vp.unreadUnits(thread, accessors), 4, "hi, the note once, between, the other note");
assert.equal(vp.isLaterPart(thread[3], thread, accessors), true);
assert.equal(vp.isLaterPart(thread[5], thread, accessors), false);
assert.equal(vp.combinedPartStatus(["sent", "pending", "failed"]), "failed");
assert.equal(vp.combinedPartStatus(["sent", "pending"]), "pending");

// --- voice layout ----------------------------------------------------------------------------
assert.deepEqual(vp.voicePartSizes(14.5, vp.VOICE_PATHS.oneToOne), [30807]);
assert.deepEqual(vp.voicePartSizes(9.8, vp.VOICE_PATHS.group), [20929]);
assert.equal(vp.voicePartSizes(170, vp.VOICE_PATHS.oneToOne).length, 12);
assert.equal(vp.voicePartSizes(110, vp.VOICE_PATHS.group).length, 12);
assert.equal(vp.voicePartSizes(60, vp.VOICE_PATHS.oneToOne).length, 5);

// The writer makes the layout's bytes: 242 packets of 120 bytes for 14.5 s.
const packets = Array.from({ length: 242 }, (_, i) => new Uint8Array(120).fill(i & 0xff).map((v, j) => (j === 0 ? 11 << 3 : v)));
const head = webm.makeOpusHead({ preSkip: 312 });
const file = webm.buildWebM({ packets, opusHead: head, durationSeconds: 14.5 });
// iOS's layout counts 10 bytes per Cluster; the first (timecode 0) takes 9, so the real file is
// one byte under the estimate, as iOS's own writer makes it.
assert.equal(file.length, 30806);
const parsed = webm.parseWebMOpus(file);
assert.equal(parsed.packets.length, 242);
assert.equal(parsed.preSkip, 312);
assert.ok(Math.abs(parsed.durationSeconds - 14.5) < 1e-9);
assert.deepEqual(Array.from(parsed.packets[7]), Array.from(packets[7]));
assert.equal(webm.opusPacketSamples(packets[0]), 2880, "config 11 is a 60 ms SILK wideband frame");
assert.equal(webm.opusPacketSamples(Uint8Array.from([(13 << 3) | 3, 3])), 2880, "hybrid at 60 ms: three 20 ms frames, code 3");
assert.equal(webm.opusPacketSamples(Uint8Array.from([0x78])), 960);

// --- photos ----------------------------------------------------------------------------------
const kas = (sompi) => sompi / 1e8;
assert.ok(Math.abs(kas(vp.photoEstimatedFeeSompi(368_000)) - 0.995) < 0.002);
assert.ok(Math.abs(kas(vp.photoEstimatedFeeSompi(184_000)) - 0.498) < 0.002);
assert.ok(Math.abs(kas(vp.photoEstimatedFeeSompi(36_000)) - 0.098) < 0.002);
assert.ok(Math.abs(kas(vp.photoEstimatedFeeSompi(243_000, { group: true })) - 0.996) < 0.002);
assert.ok(Math.abs(kas(vp.photoEstimatedFeeSompi(23_500, { group: true })) - 0.098) < 0.002);
for (const tier of vp.PHOTO_TIERS) {
  assert.ok(vp.photoEstimatedFeeSompi(tier.maxBytes.oneToOne) <= tier.budgetSompi, `${tier.id} 1:1 within budget`);
  assert.ok(vp.photoEstimatedFeeSompi(tier.maxBytes.group, { group: true }) <= tier.budgetSompi, `${tier.id} group within budget`);
}
assert.equal(vp.photoChunks(new Uint8Array(368_000)).length, 12);
assert.equal(vp.photoChunks(new Uint8Array(243_000), { group: true }).length, 12);
assert.equal(vp.photoChunks(new Uint8Array(31_000)).length, 1);

// --- groups: the frame inside gcomm ----------------------------------------------------------
const G = await import("../engine/group.js");
const keys = { groupRootEpoch: new Uint8Array(32).fill(7), groupId: new Uint8Array(32).fill(1), epoch: 1, senderId: new Uint8Array(32).fill(2), msgId: new Uint8Array(24).fill(3) };
const sealedVoice = G.encryptGroupMessage({ plaintext: json2, ...keys });
assert.equal(sealedVoice.length, framed.length + 16, "group voice is sealed as the frame");
assert.equal(G.decryptGroupMessage({ ciphertextWithTag: sealedVoice, ...keys }), json2, "and reads back as the tagged JSON");
const sealedPhoto = G.encryptGroupMessage({ plaintext: photoJson, ...keys });
assert.equal(G.decryptGroupMessage({ ciphertextWithTag: sealedPhoto, ...keys }), photoJson);
const sealedText = G.encryptGroupMessage({ plaintext: "gm ☕", ...keys });
assert.equal(sealedText.length, new TextEncoder().encode("gm ☕").length + 16, "text stays UTF-8");
assert.equal(G.decryptGroupMessage({ ciphertextWithTag: sealedText, ...keys }), "gm ☕");
// An older client's text-form group note (extra keys, base64 in JSON) still reads as text.
const textForm = JSON.stringify({ type: "file", name: "voice.webm", size: 3, mimeType: "audio/webm", duration: 2, content: "data:audio/webm;base64,AAAA" });
const raw = (await import("@noble/ciphers/chacha.js")).chacha20poly1305;
const { senderKey, nonce } = G.deriveMessageKeys(keys.groupRootEpoch, keys.groupId, keys.epoch, keys.senderId, keys.msgId);
const legacy = raw(senderKey, nonce, G.buildMessageAAD(keys.groupId, keys.epoch, keys.senderId, keys.msgId)).encrypt(new TextEncoder().encode(textForm));
assert.equal(G.decryptGroupMessage({ ciphertextWithTag: legacy, ...keys }), textForm);

// --- calls are gone: other clients' call messages are hidden, never raw JSON -------------------
const placeholders = await import("../ui/message-placeholders.js");
assert.equal(placeholders.isCallSignal('{"type":"call_invite","callId":"ab"}'), true);
assert.equal(placeholders.isCallSignal(' {"type":"call_end","callId":"ab","durationSeconds":3}'), true);
assert.equal(placeholders.isCallSignal('{"type":"reply","text":"call_me"}'), false);
assert.equal(placeholders.isCallSignal("let's do a call_invite later"), false);
assert.equal(placeholders.isHiddenPlaceholderMessage({ text: '{"type":"call_request","callId":"x"}' }), true);
assert.equal(placeholders.isHiddenPlaceholderMessage({ text: "hello" }), false);

// --- web push: one ring per burst from a sender or group (iOS part_push_bursts) ---------------
const { readFileSync } = await import("node:fs");
const vm = await import("node:vm");
const pushSandbox = {};
vm.runInNewContext(readFileSync(new URL("../public/sw-push.js", import.meta.url), "utf8"), pushSandbox);
const push = pushSandbox.KaChatPushMap;
assert.equal(push.partBurstKey({ type: "contextual", sender: "kaspa:QA" }), "chat:kaspa:qa");
assert.equal(push.partBurstKey({ type: "audio", sender: "kaspa:qa" }), "chat:kaspa:qa");
assert.equal(push.partBurstKey({ type: "contextual", sender: "kaspa:qa", inbox: "true" }), null, "a request rings");
assert.equal(push.partBurstKey({ type: "payment", sender: "kaspa:qa" }), null, "a payment rings");
assert.equal(push.partBurstKey({ type: "group_message", blinded_group_id: "AB" }), "group:ab");
const ringing = () => ({ options: { silent: false, renotify: true, tag: "t" }, badge: "increment" });
const quiet = push.applyPartBurst(ringing(), 1_000, 50_000);
assert.equal(quiet.options.silent, true);
assert.equal(quiet.options.renotify, false);
assert.equal(quiet.badge, null, "no badge for a later part");
assert.equal(push.applyPartBurst(ringing(), 1_000, 61_001).options.silent, false, "past 60 s it rings again");
assert.equal(push.applyPartBurst(ringing(), undefined, 5).options.silent, false, "the first push rings");

console.log("voice parts: all checks passed");
