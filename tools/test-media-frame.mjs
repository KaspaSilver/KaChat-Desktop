// node tools/test-media-frame.mjs - the binary media frame of 1:1 photos and voice notes (iOS
// f5f6a11, MESSAGING.md "Photos and voice notes: the binary media frame"):
//
//   0xFF 'K' 'C' 'M' 0x01 | u32 big-endian header length | header JSON | raw file bytes
//
// engine/media-frame.js (the codec) and engine/kasia-cipher.js (sealing the frame's bytes, and
// reading one back as the media-file JSON) against the real Kasia cipher WASM. Nothing leaves the
// machine and nothing is sent.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  MEDIA_FRAME_MAGIC, hasMediaFrameMagic, mediaEnvelopeFromFrame, mediaFrameForEnvelope, mediaFileEnvelopeJson, mediaFrameByteLength,
} from "../engine/media-frame.js";
import {
  encryptKasiaContextualMessageWith, decryptKasiaMessageWith, sealKasiaBytes, openKasiaBytes,
} from "../engine/kasia-cipher.js";
import { buildEncryptedCommMessage, base64ToHex } from "../engine/kasia-protocol.js";
import { txFeeMass } from "../engine/quantum.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");
const kaspa = await import("../kaspa/kaspa.js");
await kaspa.default({ module_or_path: readFileSync(join(repo, "kaspa/kaspa_bg.wasm")) });
const cipher = await import("../cipher/cipher.js");
await cipher.default({ module_or_path: readFileSync(join(repo, "cipher/cipher_bg.wasm")) });

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const utf8 = (s) => new TextEncoder().encode(s);
const b64 = (bytes) => Buffer.from(bytes).toString("base64");
const hexToBytes = (hex) => Uint8Array.from(Buffer.from(hex, "hex"));
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};
const u32be = (n) => Uint8Array.of((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
/** A frame put together by hand from the spec, independent of the codec under test. */
const handFrame = (headerText, raw, { length = utf8(headerText).length } = {}) =>
  concat(Uint8Array.from(MEDIA_FRAME_MAGIC), u32be(length), utf8(headerText), raw);
const pseudoRandom = (n, seed = 7) => {
  const out = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i += 1) { x = (x * 1103515245 + 12345) >>> 0; out[i] = x >>> 24; }
  return out;
};

// A fake JPEG and WebM: their leading bytes, then noise (the codec never looks inside).
const JPEG = concat(Uint8Array.of(0xff, 0xd8, 0xff, 0xe0), pseudoRandom(20000 - 4, 3));
const WEBM = concat(Uint8Array.of(0x1a, 0x45, 0xdf, 0xa3), pseudoRandom(31000 - 4, 9));
const VOICE_MIME = "audio/webm;codecs=opus";

// What Desktop builds today (ui/app.js buildImageEnvelopeJson / sendChatVoicePreview).
const desktopPhotoJson = (raw, name = "photo.jpg") =>
  JSON.stringify({ type: "file", name, size: raw.length, mimeType: "image/jpeg", content: `data:image/jpeg;base64,${b64(raw)}` });
const desktopVoiceJson = (raw) =>
  JSON.stringify({ type: "file", name: "voice-message.webm", size: raw.length, mimeType: VOICE_MIME, content: `data:${VOICE_MIME};base64,${b64(raw)}` });

// Keys: a receiver and a third party.
const receiverHex = "5a".padEnd(62, "0") + "4e";
const strangerHex = "5a".padEnd(62, "0") + "4f";
const receiverAddress = new kaspa.PrivateKey(receiverHex).toAddress("mainnet").toString();
const wasmDecrypt = (hex, keyHex) => cipher.decrypt_message(new cipher.EncryptedMessage(hex), new cipher.PrivateKey(keyHex));

// MARK: - reading a frame

test("a frame built per the spec reads back as the exact iOS media-file JSON", () => {
  const raw = Uint8Array.of(0xff, 0xd8, 0xff, 0xd9, 0x00, 0x01, 0x02);
  const frame = handFrame('{"mimeType":"image\\/jpeg","name":"photo.jpg","size":7}', raw);
  assert.equal(
    mediaEnvelopeFromFrame(frame),
    `{"type":"file","name":"photo.jpg","size":7,"mimeType":"image/jpeg","content":"data:image/jpeg;base64,${b64(raw)}"}`,
  );
});

test("the rebuilt JSON equals the JSON Desktop would have sent as text (photo and voice note)", () => {
  assert.equal(mediaEnvelopeFromFrame(mediaFrameForEnvelope(desktopPhotoJson(JPEG))), desktopPhotoJson(JPEG));
  assert.equal(mediaEnvelopeFromFrame(mediaFrameForEnvelope(desktopVoiceJson(WEBM))), desktopVoiceJson(WEBM));
});

test("size is the raw byte count, whatever the header says", () => {
  const raw = pseudoRandom(10);
  const json = mediaEnvelopeFromFrame(handFrame('{"mimeType":"image/png","name":"a.png","size":99999}', raw));
  assert.equal(JSON.parse(json).size, 10);
  assert.equal(JSON.parse(json).mimeType, "image/png");
});

test("a name with quotes, backslashes and slashes: only \\ and \" escaped, \"/\" left alone (iOS MediaFileEnvelope)", () => {
  const raw = pseudoRandom(5);
  const name = 'my "best"\\shot/1.jpg';
  const header = JSON.stringify({ mimeType: "image/jpeg", name, size: 5 }).replace(/\//g, "\\/");
  const json = mediaEnvelopeFromFrame(handFrame(header, raw));
  assert.equal(json, `{"type":"file","name":"my \\"best\\"\\\\shot/1.jpg","size":5,"mimeType":"image/jpeg","content":"data:image/jpeg;base64,${b64(raw)}"}`);
  assert.equal(JSON.parse(json).name, name);
  assert.equal(json, mediaFileEnvelopeJson({ name, size: 5, mimeType: "image/jpeg", dataUrlContent: `data:image/jpeg;base64,${b64(raw)}` }));
});

test("a missing or non-string name reads \"file\"; extra header keys are ignored", () => {
  const raw = pseudoRandom(3);
  assert.equal(JSON.parse(mediaEnvelopeFromFrame(handFrame('{"mimeType":"audio/ogg"}', raw))).name, "file");
  assert.equal(JSON.parse(mediaEnvelopeFromFrame(handFrame('{"mimeType":"audio/ogg","name":42,"x":[1]}', raw))).name, "file");
});

test("text is not a frame: UTF-8 text, JSON text, and anything without the magic", () => {
  for (const text of ["hello", "", "{\"type\":\"file\"}", desktopPhotoJson(pseudoRandom(4)), "\u00ff KCM"]) {
    assert.equal(mediaEnvelopeFromFrame(utf8(text)), null, text.slice(0, 20));
    assert.equal(hasMediaFrameMagic(utf8(text)), false);
  }
  assert.equal(mediaEnvelopeFromFrame(Uint8Array.of(0xff, 0x4b, 0x43, 0x4d, 0x02, 0, 0, 0, 2, 0x7b, 0x7d, 1)), null, "version 2 magic");
});

test("malformed frames read as null, never throw", () => {
  const raw = pseudoRandom(8);
  const good = '{"mimeType":"image/jpeg","name":"p.jpg","size":8}';
  const cases = {
    "magic only": Uint8Array.from(MEDIA_FRAME_MAGIC),
    "magic + length, nothing else": concat(Uint8Array.from(MEDIA_FRAME_MAGIC), u32be(0)),
    "zero header length": handFrame(good, raw, { length: 0 }),
    "header length past the end": handFrame(good, raw, { length: utf8(good).length + raw.length + 1 }),
    "header length 0xFFFFFFFF": handFrame(good, raw, { length: 0xffffffff }),
    "header not JSON": handFrame("{mimeType:image/jpeg}", raw),
    "header an array": handFrame('["image/jpeg"]', raw),
    "header a string": handFrame('"image/jpeg"', raw),
    "header null": handFrame("null", raw),
    "header not UTF-8": concat(Uint8Array.from(MEDIA_FRAME_MAGIC), u32be(3), Uint8Array.of(0x7b, 0xff, 0x7d), raw),
    "no mimeType": handFrame('{"name":"p.jpg","size":8}', raw),
    "empty mimeType": handFrame('{"mimeType":"","name":"p.jpg"}', raw),
    "non-string mimeType": handFrame('{"mimeType":7}', raw),
    "no file bytes": handFrame(good, new Uint8Array(0)),
    "header length cuts the JSON short": handFrame(good, raw, { length: 10 }),
    "empty": new Uint8Array(0),
    "null": null,
  };
  for (const [label, bytes] of Object.entries(cases)) {
    assert.doesNotThrow(() => mediaEnvelopeFromFrame(bytes), label);
    assert.equal(mediaEnvelopeFromFrame(bytes), null, label);
  }
});

// MARK: - building a frame

test("a photo's frame: magic, u32 BE length, iOS's sorted header with \"/\" escaped, the raw JPEG", () => {
  const frame = mediaFrameForEnvelope(desktopPhotoJson(JPEG));
  const header = '{"mimeType":"image\\/jpeg","name":"photo.jpg","size":20000}';
  assert.deepEqual(frame, handFrame(header, JPEG));
  assert.deepEqual(Array.from(frame.subarray(0, 9)), [0xff, 0x4b, 0x43, 0x4d, 0x01, 0, 0, 0, utf8(header).length]);
  assert.equal(frame.length, 9 + utf8(header).length + JPEG.length);
  assert.equal(mediaFrameByteLength({ rawBytes: JPEG.length, name: "photo.jpg", mimeType: "image/jpeg" }), frame.length);
});

test("a voice note's frame keeps the codecs parameter in its mimeType", () => {
  const frame = mediaFrameForEnvelope(desktopVoiceJson(WEBM));
  assert.deepEqual(frame, handFrame('{"mimeType":"audio\\/webm;codecs=opus","name":"voice-message.webm","size":31000}', WEBM));
  assert.equal(mediaFrameByteLength({ rawBytes: WEBM.length, name: "voice-message.webm", mimeType: VOICE_MIME }), frame.length);
});

test("a header name with quotes/backslashes is escaped the JSONSerialization way and reads back", () => {
  const name = 'a "b"\\c/d.jpg';
  const raw = pseudoRandom(6);
  const frame = mediaFrameForEnvelope(desktopPhotoJson(raw, name));
  assert.deepEqual(frame, handFrame('{"mimeType":"image\\/jpeg","name":"a \\"b\\"\\\\c\\/d.jpg","size":6}', raw));
  assert.equal(JSON.parse(mediaEnvelopeFromFrame(frame)).name, name);
});

test("only image/* and audio/* base64 data URLs are framed; everything else stays text", () => {
  const raw = b64(pseudoRandom(9));
  const notFramed = [
    "hello",
    "{\"type\":\"edit\",\"targetTxId\":\"ab\",\"text\":\"x\"}",
    JSON.stringify({ type: "file", name: "a.pdf", size: 9, mimeType: "application/pdf", content: `data:application/pdf;base64,${raw}` }),
    JSON.stringify({ type: "file", name: "v.mp4", size: 9, mimeType: "video/mp4", content: `data:video/mp4;base64,${raw}` }),
    JSON.stringify({ type: "file", name: "a.jpg", size: 9, mimeType: "image/jpeg", content: "https://cloud.example/s/abc" }),
    JSON.stringify({ type: "file", name: "a.jpg", size: 9, mimeType: "image/jpeg", content: `data:image/jpeg,${raw}` }),
    JSON.stringify({ type: "file", name: "a.jpg", size: 9, mimeType: "image/jpeg", content: "data:image/jpeg;base64," }),
    JSON.stringify({ type: "file", name: "a.jpg", size: 9, mimeType: "image/jpeg", content: "data:image/jpeg;base64,@@@@" }),
    JSON.stringify({ type: "file", name: "a.jpg", size: 9, mimeType: "image/jpeg", content: `data:image/jpeg;base64,${raw.replace(/=+$/, "")}x` }),
    JSON.stringify({ type: "image", content: `data:image/jpeg;base64,${raw}` }),
    ` ${desktopPhotoJson(pseudoRandom(3))}`, // iOS checks hasPrefix("{") without trimming
    JSON.stringify({ type: "file", name: "a.jpg", size: 9, mimeType: "image/jpeg", content: `data:image/jpeg;base64,${raw}` }).replace('"type":"file"', '"type": "file"'),
  ];
  for (const text of notFramed) assert.equal(mediaFrameForEnvelope(text), null, text.slice(0, 60));
  const png = JSON.stringify({ type: "file", name: "x.png", size: 9, mimeType: "image/png", content: `data:IMAGE/PNG;base64,${raw}` });
  assert.ok(mediaFrameForEnvelope(png), "mime prefix matched case-insensitively, as iOS");
});

// MARK: - sealing with Desktop's cipher

test("the JS byte cipher is the WASM's: JS-sealed text opens in the WASM, WASM-sealed text opens in JS", () => {
  const text = "Hello from the byte path ✓";
  const pub = hexToBytes(cipher.debug_address_to_pubkey(receiverAddress));
  const jsSealed = Buffer.from(sealKasiaBytes(pub, utf8(text))).toString("hex");
  assert.equal(wasmDecrypt(jsSealed, receiverHex), text);
  const wasmSealed = cipher.encrypt_message(receiverAddress, text).to_hex();
  assert.equal(new TextDecoder().decode(openKasiaBytes(hexToBytes(wasmSealed), hexToBytes(receiverHex))), text);
  assert.throws(() => openKasiaBytes(hexToBytes(wasmSealed), hexToBytes(strangerHex)), "another key cannot open it");
});

for (const [label, json, mime] of [["photo", desktopPhotoJson(JPEG), "image/jpeg"], ["voice note", desktopVoiceJson(WEBM), VOICE_MIME]]) {
  test(`a ${label} round-trips in frame form: sealed as the frame, read back as the same JSON`, () => {
    const sealed = encryptKasiaContextualMessageWith(cipher, receiverAddress, json);
    assert.equal(sealed.mediaFrame, true);
    const plaintext = openKasiaBytes(sealed.encryptedBytes, hexToBytes(receiverHex));
    assert.equal(hasMediaFrameMagic(plaintext), true, "what is sealed is the frame, not the JSON");
    assert.equal(plaintext.length, mediaFrameForEnvelope(json).length);
    assert.equal(sealed.encryptedBytes.length, 12 + 33 + plaintext.length + 16);
    assert.throws(() => wasmDecrypt(sealed.encryptedHex, receiverHex), /UTF-8/, "a client without the frame fails cleanly");
    const read = decryptKasiaMessageWith(cipher, sealed.encryptedHex, receiverHex);
    assert.equal(read, json);
    assert.equal(JSON.parse(read).mimeType, mime);
    assert.throws(() => decryptKasiaMessageWith(cipher, sealed.encryptedHex, strangerHex), "not ours: fails as before");
  });
}

test("a text message still goes out as text, readable by the plain WASM", () => {
  for (const text of ["gm", "{\"type\":\"reaction\",\"emoji\":\"👍\"}", JSON.stringify({ type: "file", name: "a.pdf", size: 1, mimeType: "application/pdf", content: "data:application/pdf;base64,AA==" })]) {
    const sealed = encryptKasiaContextualMessageWith(cipher, receiverAddress, text);
    assert.equal(sealed.mediaFrame, false);
    assert.equal(wasmDecrypt(sealed.encryptedHex, receiverHex), text);
    assert.equal(decryptKasiaMessageWith(cipher, sealed.encryptedHex, receiverHex), text);
  }
});

test("sealed non-UTF-8 that is not a well-formed frame fails exactly as before (iOS: invalidPlaintext)", () => {
  const pub = hexToBytes(cipher.debug_address_to_pubkey(receiverAddress));
  for (const plain of [
    Uint8Array.of(0xff, 0xfe, 0x00),
    handFrame('{"mimeType":"image/jpeg"}', new Uint8Array(0)),
    handFrame('{"mimeType":"image/jpeg"}', pseudoRandom(4), { length: 999 }),
    handFrame("not json", pseudoRandom(4)),
  ]) {
    const hex = Buffer.from(sealKasiaBytes(pub, plain)).toString("hex");
    assert.throws(() => decryptKasiaMessageWith(cipher, hex, receiverHex), /UTF-8/);
  }
});

test("through the 1:1 payload builder: kchat:1:comm (and dm) carry the sealed frame; the record keeps the JSON", async () => {
  const json = desktopPhotoJson(JPEG);
  const encryptMessage = async (address, text) => encryptKasiaContextualMessageWith(cipher, address, text);
  for (const inboxTag of [null, "0123456789abcdef0123456789abcdef"]) {
    const built = await buildEncryptedCommMessage({ text: json, alias: "a1b2c3d4e5f6", receiver: receiverAddress, encryptMessage, inboxTag });
    assert.equal(built.clearText, json, "the local bubble / stored record keep the media-file JSON");
    const prefix = inboxTag ? `kchat:1:dm:${inboxTag}:a1b2c3d4e5f6:` : "kchat:1:comm:a1b2c3d4e5f6:";
    assert.ok(built.protocolString.startsWith(prefix));
    const body = built.protocolString.slice(prefix.length);
    assert.equal(decryptKasiaMessageWith(cipher, base64ToHex(body), receiverHex), json);
    // A 20 KB photo: ~27 KB of payload (iOS: 35.7 KB as text -> 26.8 KB framed).
    assert.ok(built.payloadBytes < 27_300 && built.payloadBytes > 26_500, `photo payload ${built.payloadBytes}`);
  }
});

test("on-chain sizes stay inside a standard transaction (100,000 mass at 2 grams a byte)", async () => {
  const encryptMessage = async (address, text) => encryptKasiaContextualMessageWith(cipher, address, text);
  for (const [label, json, ceiling] of [["20 KB photo", desktopPhotoJson(JPEG), 27_300], ["31 KB voice note", desktopVoiceJson(WEBM), 41_700]]) {
    const built = await buildEncryptedCommMessage({ text: json, alias: "a1b2c3d4e5f6", receiver: receiverAddress, encryptMessage });
    assert.ok(built.payloadBytes <= ceiling, `${label}: ${built.payloadBytes} bytes of payload`);
    // One plain input, the message output and change (both P2PK, 34-byte scripts).
    const mass = txFeeMass({ inputSigScriptLens: [66], outputScriptLens: [34, 34], payloadLength: built.payloadBytes });
    assert.ok(mass < 90_000n, `${label}: fee mass ${mass}`);
    // The old text form of the same 31 KB note would not have fitted.
    if (label.includes("voice")) {
      const asText = await buildEncryptedCommMessage({ text: json, alias: "a1b2c3d4e5f6", receiver: receiverAddress, encryptMessage: async (a, t) => ({ encryptedHex: cipher.encrypt_message(a, t).to_hex() }) });
      assert.ok(txFeeMass({ inputSigScriptLens: [66], outputScriptLens: [34, 34], payloadLength: asText.payloadBytes }) > 100_000n, "text form over the limit");
    }
  }
});

let pass = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    pass += 1;
    console.log(`ok   ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}\n     ${error?.stack || error}`);
    process.exitCode = 1;
  }
}
console.log(`\n${pass}/${tests.length} media-frame tests passed`);
