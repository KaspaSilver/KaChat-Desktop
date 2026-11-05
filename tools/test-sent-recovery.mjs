// A seed reading back what it sent (iOS bfe9f022, MESSAGING.md "Reading back your own sends") and the
// group invite answers. No network. Run from the repo root:
//
//   node tools/test-sent-recovery.mjs

import assert from "node:assert/strict";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { sealKasiaBytes, openKasiaBytes, openSentKasiaBytes, encryptKasiaContextualMessageWith, decryptSentKasiaMessageWith } from "../engine/kasia-cipher.js";
import { encodeMemberStatus, parseMemberStatus, MEMBER_STATUS, buildSignedInviteAcceptPayload, verifyInviteAcceptPayload, buildInviteAcceptSigningPayload, buildTombstoneSigningPayload, buildSignedTombstonePayload, verifyTombstonePayload, groupInviteKey } from "../engine/group.js";

const hex = (bytes) => Buffer.from(bytes).toString("hex");
const utf8 = (text) => new TextEncoder().encode(text);

const sender = secp256k1.utils.randomSecretKey();
const recipient = secp256k1.utils.randomSecretKey();
const recipientPublic = secp256k1.getPublicKey(recipient, true);
const fake = { debug_address_to_pubkey: () => hex(recipientPublic), encrypt_message: () => { throw new Error("the WASM's random key can't be read back"); } };

// Sealed with the sender's key: the recipient opens it as any message, the sender's seed reads it.
let sealed = sealKasiaBytes(recipientPublic, utf8("hello"), sender);
assert.equal(new TextDecoder().decode(openKasiaBytes(sealed, recipient)), "hello");
assert.equal(new TextDecoder().decode(openSentKasiaBytes(sealed, sender, recipientPublic)), "hello");

// The ephemeral key is exactly HKDF(chatting key, nonce, "kachat-sent-message-v1"), and the wire form is unchanged.
const nonce = sealed.subarray(0, 12);
const derived = hkdf(sha256, sender, nonce, utf8("kachat-sent-message-v1"), 32);
assert.equal(hex(sealed.subarray(12, 45)), hex(secp256k1.getPublicKey(derived, true)));

// Two sends of one text share no key.
const again = sealKasiaBytes(recipientPublic, utf8("hello"), sender);
assert.notEqual(hex(again.subarray(12, 45)), hex(sealed.subarray(12, 45)));

// A random-key send (older, or another client's) can't be read, and another seed can't either.
assert.throws(() => openSentKasiaBytes(sealKasiaBytes(recipientPublic, utf8("old")), sender, recipientPublic));
assert.throws(() => openSentKasiaBytes(sealed, secp256k1.utils.randomSecretKey(), recipientPublic));

// Through the contextual seal, for text and for an unknown sender key.
const out = encryptKasiaContextualMessageWith(fake, "kaspa:recipient", "text message", hex(sender));
assert.equal(out.mediaFrame, false);
assert.equal(decryptSentKasiaMessageWith(fake, out.encryptedHex, hex(sender), "kaspa:recipient"), "text message");
assert.equal(new TextDecoder().decode(openKasiaBytes(out.encryptedBytes, recipient)), "text message");
assert.throws(() => encryptKasiaContextualMessageWith(fake, "kaspa:recipient", "no key"));

// A photo comes back as the media-file JSON it was sent as.
const media = JSON.stringify({ type: "file", name: "a.jpg", mimeType: "image/jpeg", content: `data:image/jpeg;base64,${Buffer.from("photo-bytes").toString("base64")}` });
const photo = encryptKasiaContextualMessageWith(fake, "kaspa:recipient", media, hex(sender));
if (photo.mediaFrame) assert.equal(JSON.parse(decryptSentKasiaMessageWith(fake, photo.encryptedHex, hex(sender), "kaspa:recipient")).name, "a.jpg");

// A member's answer: only joined or declined, never "invited", never another type.
assert.equal(parseMemberStatus(encodeMemberStatus(MEMBER_STATUS.JOINED)), "joined");
assert.equal(parseMemberStatus(encodeMemberStatus(MEMBER_STATUS.DECLINED)), "declined");
assert.equal(parseMemberStatus(encodeMemberStatus(MEMBER_STATUS.INVITED)), null);
assert.equal(parseMemberStatus('{"type":"reaction","status":"joined"}'), null);
assert.equal(parseMemberStatus("joined"), null);
assert.equal(parseMemberStatus("{bad"), null);
assert.equal(encodeMemberStatus("joined"), '{"type":"member_status","status":"joined"}');

// gctl_invite_accept signs v || "gctl_invite_accept" || group_id || admin_signing_pub (iOS 30309e93).
const groupId = new Uint8Array(32).fill(7);
const adminSigningPub = new Uint8Array(32).fill(9);
assert.equal(hex(buildInviteAcceptSigningPayload({ groupId, adminSigningPub })), `02${hex(utf8("gctl_invite_accept"))}${hex(groupId)}${hex(adminSigningPub)}`);
const accept = buildSignedInviteAcceptPayload({ groupId, adminSigningPub, signingPub: secp256k1.getPublicKey(sender, true).subarray(1), privateKey: hex(sender) });
assert.equal(accept.type, "gctl_invite_accept");
assert.equal(verifyInviteAcceptPayload(accept), true);
assert.equal(accept.v, 2);
assert.equal(accept.admin_signing_pub, hex(adminSigningPub));
assert.equal(verifyInviteAcceptPayload({ ...accept, group_id: "08".repeat(32) }), false);
assert.equal(verifyInviteAcceptPayload({ ...accept, admin_signing_pub: "08".repeat(32) }), false);
const { admin_signing_pub: _omitted, ...noAdmin } = accept;
assert.equal(verifyInviteAcceptPayload(noAdmin), false);

// gctl_tombstone: v2 signs the admin too; v1 has no admin and covers the id from anyone.
const signingPub = secp256k1.getPublicKey(sender, true).subarray(1);
assert.equal(hex(buildTombstoneSigningPayload({ v: 2, groupId, adminSigningPub })), `02${hex(utf8("gctl_tombstone"))}${hex(groupId)}${hex(adminSigningPub)}`);
assert.equal(hex(buildTombstoneSigningPayload({ groupId })), `01${hex(utf8("gctl_tombstone"))}${hex(groupId)}`);
const markerV2 = buildSignedTombstonePayload({ groupId, adminSigningPub, signingPub, privateKey: hex(sender) });
assert.equal(markerV2.v, 2);
assert.equal(markerV2.admin_signing_pub, hex(adminSigningPub));
assert.equal(verifyTombstonePayload(markerV2), true);
assert.equal(verifyTombstonePayload({ ...markerV2, admin_signing_pub: "08".repeat(32) }), false);
const markerV1 = buildSignedTombstonePayload({ groupId, signingPub, privateKey: hex(sender) });
assert.equal(markerV1.v, 1);
assert.equal("admin_signing_pub" in markerV1, false);
assert.equal(verifyTombstonePayload(markerV1), true);

assert.equal(groupInviteKey("AB", "CD"), "ab:cd");

console.log("test-sent-recovery: all passed");
