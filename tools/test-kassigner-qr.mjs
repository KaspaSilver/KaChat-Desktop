// node tools/test-kassigner-qr.mjs - the unsigned KSPT frames Cold Storage shows a KasSigner device
// are drawn exactly like iOS ByteModeQRCode: one byte-mode segment, error correction "L", mask 0,
// the smallest version 1-6 that fits, and never anything bigger. Every frame the chunker
// (ui/kspt.js, iOS QrFrameChunker) can produce - a single frame of up to 134 bytes, or a chunked
// one of 3 + 106 = 109 - fits, and survives a jsQR round trip byte for byte (zeros included).
import assert from "node:assert/strict";
import QRCode from "qrcode";
import jsQR from "jsqr";
import {
  kasSignerQrVersionFor, kasSignerQrOptions, KASSIGNER_QR_BYTE_CAPACITY, KASSIGNER_QR_MAX_VERSION,
} from "../engine/qr.js";
import { chunkQrFrames } from "../ui/kspt.js";

let pass = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

/** Renders the symbol's modules to RGBA pixels (4-module quiet zone) and decodes them. */
function roundTrip(bytes) {
  const symbol = QRCode.create([{ data: bytes, mode: "byte" }], kasSignerQrOptions(bytes.length));
  const size = symbol.modules.size;
  const scale = 5;
  const margin = 4;
  const width = (size + margin * 2) * scale;
  const pixels = new Uint8ClampedArray(width * width * 4).fill(255);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (!symbol.modules.get(y, x)) continue;
      for (let dy = 0; dy < scale; dy += 1) {
        for (let dx = 0; dx < scale; dx += 1) {
          const o = (((y + margin) * scale + dy) * width + ((x + margin) * scale + dx)) * 4;
          pixels[o] = 0; pixels[o + 1] = 0; pixels[o + 2] = 0;
        }
      }
    }
  }
  return { symbol, decoded: jsQR(pixels, width, width) };
}

test("smallest KasSigner version per byte count, as ByteModeQRCode picks it", () => {
  assert.equal(kasSignerQrVersionFor(1), 1);
  assert.equal(kasSignerQrVersionFor(17), 1);
  assert.equal(kasSignerQrVersionFor(18), 2);
  assert.equal(kasSignerQrVersionFor(106), 5);
  assert.equal(kasSignerQrVersionFor(107), 6);
  assert.equal(kasSignerQrVersionFor(109), 6);
  assert.equal(kasSignerQrVersionFor(134), 6);
  assert.equal(kasSignerQrVersionFor(135), null);
  assert.equal(KASSIGNER_QR_MAX_VERSION, 6);
  assert.deepEqual(KASSIGNER_QR_BYTE_CAPACITY, { 1: 17, 2: 32, 3: 53, 4: 78, 5: 106, 6: 134 });
});

test("options are EC L, mask 0, capped version; above version 6 is an error", () => {
  assert.deepEqual(kasSignerQrOptions(109), { errorCorrectionLevel: "L", version: 6, maskPattern: 0 });
  assert.throws(() => kasSignerQrOptions(135), /too large/);
});

test("the symbol really is level L, the chosen version, one byte segment", () => {
  for (const n of [1, 17, 18, 53, 78, 106, 109, 134]) {
    const symbol = QRCode.create([{ data: new Uint8Array(n), mode: "byte" }], kasSignerQrOptions(n));
    assert.equal(symbol.version, kasSignerQrVersionFor(n), `version for ${n}`);
    assert.equal(symbol.errorCorrectionLevel.bit, QRCode.create("x", { errorCorrectionLevel: "L" }).errorCorrectionLevel.bit);
    assert.equal(symbol.maskPattern, 0);
    assert.equal(symbol.segments.length, 1);
    assert.equal(symbol.segments[0].mode.id, "Byte");
  }
});

test("every chunker frame fits version 6 and round-trips byte for byte", () => {
  for (const total of [20, 134, 135, 200, 500, 1200, 64 * 106]) {
    const payload = new Uint8Array(total);
    for (let i = 0; i < total; i += 1) payload[i] = i % 7 === 0 ? 0 : (i * 37) & 0xff;
    const frames = chunkQrFrames(payload);
    for (const frame of frames) {
      assert.ok(frame.length <= 134, `frame of ${frame.length} bytes`);
      if (frames.length > 1) assert.ok(frame.length <= 109, `chunked frame of ${frame.length} bytes`);
      const { symbol, decoded } = roundTrip(frame);
      assert.ok(symbol.version <= 6);
      assert.ok(decoded, `decodes a ${frame.length}-byte frame`);
      assert.deepEqual([...decoded.binaryData], [...frame]);
    }
  }
});

for (const [name, fn] of tests) {
  try { await fn(); pass += 1; }
  catch (error) { console.error(`FAIL ${name}\n`, error); process.exitCode = 1; }
}
console.log(`${pass}/${tests.length} KasSigner QR tests passed`);
