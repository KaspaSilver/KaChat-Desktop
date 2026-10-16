// node tools/test-kaposts-tip.mjs - the KaPosts tip payload (KAPOSTS_INDEXER.md 5.11, iOS a6bd60a):
//
//   kchat:1:tip:<pubkey>:<signature>:<post_id>:<author_pubkey>:<sealed_hex>
//
// built and signed by engine/kaposts.js (buildKaPostTipPayload), read back as a chat payment by
// engine/kasia-protocol.js (paymentPayloadEncryptedHex, kaPostTipParts). Uses the real Kaspa WASM
// (signMessage / verifyMessage) and the real Kasia cipher (the sealed record), and checks the
// signature the way iOS makes it (BIP-340 Schnorr over Blake2b-256 keyed
// "PersonalMessageSigningHash", WalletManager.signArbitraryMessage(.kaspaPersonalMessage)).
// Nothing leaves the machine.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { blake2b } from "@noble/hashes/blake2.js";
import { schnorr } from "@noble/curves/secp256k1.js";

import { KAPOSTS_PROTOCOL, buildKaPostTipPayload, kaPostTipPayloadFor, kaspaAddressFromPubkey } from "../engine/kaposts.js";
import {
  KAPOSTS_TIP_PREFIX, kaPostTipParts, paymentPayloadEncryptedHex, sealPaymentRecord, buildEncryptedPaymentPayload, toHex,
} from "../engine/kasia-protocol.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");

const kaspa = await import("../kaspa/kaspa.js");
await kaspa.default({ module_or_path: readFileSync(join(repo, "kaspa/kaspa_bg.wasm")) });
const cipher = await import("../cipher/cipher.js");
await cipher.default({ module_or_path: readFileSync(join(repo, "cipher/cipher_bg.wasm")) });

let pass = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const NET = "mainnet";
const tipperHex = "5a".padEnd(62, "0") + "4d";
const authorHex = "5a".padEnd(62, "0") + "4e";
const tipperKey = new kaspa.PrivateKey(tipperHex);
const authorKey = new kaspa.PrivateKey(authorHex);
const authorPubkey = String(authorKey.toPublicKey().toString()).toLowerCase();
const authorAddress = authorKey.toAddress(NET).toString();
const POST_ID = "ab".repeat(32);

const encryptMessage = async (address, text) => ({ encryptedHex: cipher.encrypt_message(String(address), String(text)).to_hex() });
const decryptFor = (privateKeyHex, sealedHex) =>
  cipher.decrypt_message(new cipher.EncryptedMessage(sealedHex), new cipher.PrivateKey(privateKeyHex));

// The slice of the engine buildKaPostTipPayload reads: the chatting key, the SDK, and the seal.
const engine = {
  kaspa,
  privateKey: tipperKey,
  privateKeyHex: tipperHex,
  sealPaymentRecord: ({ receiver, note, amountSompi }) => sealPaymentRecord({ receiver, note, amountSompi, encryptMessage }),
};

const bytesToHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const hexBytes = (hex) => Uint8Array.from(String(hex).match(/.{2}/g), (b) => Number.parseInt(b, 16));
const personalMessageDigest = (message) =>
  blake2b(new TextEncoder().encode(message), { dkLen: 32, key: new TextEncoder().encode("PersonalMessageSigningHash") });

test("the payload is exactly kchat:1:tip:<pubkey>:<sig>:<post_id>:<author_pubkey>:<sealed_hex>", async () => {
  const built = await buildKaPostTipPayload({ engine, receiver: authorAddress, note: "thanks", amountSompi: 150_000_000, postId: POST_ID, authorPubkey });
  const tipperPubkey = String(tipperKey.toPublicKey().toString()).toLowerCase();
  assert.match(built.payloadText, /^kchat:1:tip:0[23][0-9a-f]{64}:[0-9a-f]{128}:[0-9a-f]{64}:0[23][0-9a-f]{64}:[0-9a-f]+$/);
  const parts = kaPostTipParts(built.payloadText);
  assert.equal(parts.pubkey, tipperPubkey);
  assert.equal(parts.postId, POST_ID);
  assert.equal(parts.authorPubkey, authorPubkey);
  assert.equal(parts.sealedHex, built.sealedHex);
  assert.equal(built.payloadText, KAPOSTS_PROTOCOL.tipPayload(parts.pubkey, parts.signature, POST_ID, authorPubkey, built.sealedHex));
  // the bytes on chain are the UTF-8 of that text - no binary part (unlike kchat:1:pay:)
  assert.equal(new TextDecoder().decode(built.payloadBytes), built.payloadText);
});

test("the signature covers tip:<post_id>:<author_pubkey>:<sealed_hex> and verifies as iOS / the indexer check it", async () => {
  const built = await buildKaPostTipPayload({ engine, receiver: authorAddress, amountSompi: 100_000_000, postId: POST_ID, authorPubkey });
  const parts = kaPostTipParts(built.payloadText);
  const signed = `tip:${POST_ID}:${authorPubkey}:${built.sealedHex}`;
  assert.equal(KAPOSTS_PROTOCOL.tipSigningString(POST_ID, authorPubkey, built.sealedHex), signed);
  assert.equal(kaspa.verifyMessage({ message: signed, signature: parts.signature, publicKey: parts.pubkey }), true);
  // BIP-340 over the keyed Blake2b digest, against the x-only key (the compressed key minus its first byte)
  assert.equal(schnorr.verify(hexBytes(parts.signature), personalMessageDigest(signed), hexBytes(parts.pubkey.slice(2))), true);
  // a different sealed note (or post) breaks it
  assert.equal(kaspa.verifyMessage({ message: `tip:${"cd".repeat(32)}:${authorPubkey}:${built.sealedHex}`, signature: parts.signature, publicKey: parts.pubkey }), false);
});

test("two tips of one post never share a signature (the sealed note has a random IV)", async () => {
  const a = await buildKaPostTipPayload({ engine, receiver: authorAddress, amountSompi: 100_000_000, postId: POST_ID, authorPubkey });
  const b = await buildKaPostTipPayload({ engine, receiver: authorAddress, amountSompi: 100_000_000, postId: POST_ID, authorPubkey });
  assert.notEqual(a.sealedHex, b.sealedHex);
  assert.notEqual(kaPostTipParts(a.payloadText).signature, kaPostTipParts(b.payloadText).signature);
});

test("round trip: the author reads the tip as a chat payment, memo and amount included", async () => {
  const built = await buildKaPostTipPayload({ engine, receiver: authorAddress, note: "great post", amountSompi: 150_000_000, postId: POST_ID, authorPubkey });
  // the REST API serves the payload as hex
  const sealed = paymentPayloadEncryptedHex(bytesToHex(built.payloadBytes));
  assert.equal(sealed, built.sealedHex);
  const record = JSON.parse(decryptFor(authorHex, sealed));
  assert.equal(record.type, "payment");
  assert.equal(record.message, "great post");
  assert.equal(record.amount, 150_000_000);
  assert.equal(record.version, 1);
  // upper-case hex and a 0x prefix read the same
  assert.equal(paymentPayloadEncryptedHex(`0x${bytesToHex(built.payloadBytes).toUpperCase()}`), built.sealedHex);
  // the author's chatting address is the p2pk address of <author_pubkey>
  assert.equal(kaspaAddressFromPubkey({ kaspa }, kaPostTipParts(built.payloadText).authorPubkey), authorAddress);
});

test("a tip built the iOS way (KaPostsProtocol.tipPayload + sealedPaymentHex) decodes and verifies", async () => {
  // Swift: sealed = KasiaCipher.encrypt(json).toBytes().hexString (lowercase); signed with
  // signArbitraryMessage(tipSigningString, .kaspaPersonalMessage) - BIP-340 over the keyed digest;
  // payload = "\(prefix)tip:\(pubkey):\(signature):\(postId):\(authorPubkey):\(sealedHex)".
  const json = JSON.stringify({ type: "payment", message: "", amount: 25_000_000, timestamp: 1_760_620_000_000, version: 1 });
  const sealedHex = cipher.encrypt_message(authorAddress, json).to_hex().toLowerCase();
  const iosPrivate = hexBytes("11".repeat(32));
  const iosPubkey = `02${bytesToHex(schnorr.getPublicKey(iosPrivate))}`; // x-only, even Y, compressed form
  const signingString = `tip:${POST_ID}:${authorPubkey}:${sealedHex}`;
  const iosSignature = bytesToHex(schnorr.sign(personalMessageDigest(signingString), iosPrivate, new Uint8Array(32)));
  const iosPayload = `kchat:1:tip:${iosPubkey}:${iosSignature}:${POST_ID}:${authorPubkey}:${sealedHex}`;

  const parts = kaPostTipParts(iosPayload);
  assert.deepEqual(parts, { pubkey: iosPubkey, signature: iosSignature, postId: POST_ID, authorPubkey, sealedHex });
  assert.equal(kaspa.verifyMessage({ message: signingString, signature: parts.signature, publicKey: parts.pubkey }), true);
  const sealed = paymentPayloadEncryptedHex(toHex(iosPayload));
  assert.equal(sealed, sealedHex);
  assert.deepEqual(JSON.parse(decryptFor(authorHex, sealed)), JSON.parse(json));
  // and the Desktop assembler, handed the same pieces, writes the very same text
  const desktop = kaPostTipPayloadFor({ pubkey: iosPubkey, sign: () => iosSignature, postId: POST_ID, authorPubkey, sealedHex });
  assert.equal(desktop.payloadText, iosPayload);
});

test("malformed tips are not payments; other roots are untouched", async () => {
  const sealed = "aa".repeat(40);
  const ok = `${KAPOSTS_TIP_PREFIX}02${"1".repeat(64)}:${"2".repeat(128)}:${POST_ID}:${authorPubkey}:${sealed}`;
  assert.equal(paymentPayloadEncryptedHex(toHex(ok)), sealed);
  assert.equal(kaPostTipParts(`${KAPOSTS_TIP_PREFIX}a:b:c:d`), null); // four fields
  assert.equal(kaPostTipParts(`${KAPOSTS_TIP_PREFIX}a:b:c:d:e:f`), null); // six fields
  assert.equal(kaPostTipParts(`${KAPOSTS_TIP_PREFIX}a:b:c:d:`), null); // empty sealed part
  assert.equal(kaPostTipParts("kchat:1:pay:abc"), null);
  assert.equal(paymentPayloadEncryptedHex(toHex(`${KAPOSTS_TIP_PREFIX}a:b:c:d:`)), "");
  assert.equal(paymentPayloadEncryptedHex(toHex(`${KAPOSTS_TIP_PREFIX}a:b:c:d:xyz`)), ""); // not hex
  assert.equal(paymentPayloadEncryptedHex(toHex(`${KAPOSTS_TIP_PREFIX}a:b:c:d:abc`)), ""); // odd length
  // kchat:1:pay: still reads its raw cipher bytes, and its builder is unchanged by the split
  const fixed = async () => ({ encryptedHex: "DEADBEEF" });
  const pay = await buildEncryptedPaymentPayload({ receiver: authorAddress, amountSompi: 1, encryptMessage: fixed });
  assert.equal(pay.payloadHex, `${toHex("kchat:1:pay:")}deadbeef`);
  assert.equal(paymentPayloadEncryptedHex(pay.payloadHex), "deadbeef");
});

test("a tip needs a post on the network and its author's key", async () => {
  await assert.rejects(buildKaPostTipPayload({ engine, receiver: authorAddress, amountSompi: 1, postId: "", authorPubkey }));
  await assert.rejects(buildKaPostTipPayload({ engine, receiver: authorAddress, amountSompi: 1, postId: POST_ID, authorPubkey: "" }));
  await assert.rejects(buildKaPostTipPayload({ engine, receiver: authorAddress, amountSompi: 0, postId: POST_ID, authorPubkey }));
});

for (const [name, fn] of tests) {
  try { await fn(); pass++; }
  catch (error) { console.error(`FAIL ${name}\n  ${error?.message || error}`); process.exitCode = 1; }
}
console.log(`kaposts-tip: ${pass}/${tests.length} passed`);
