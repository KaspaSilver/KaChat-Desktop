import QRCode from "qrcode";
import jsQR from "jsqr";

export function makeQrPayload(address) {
  if (!address) throw new Error("Generate or import a private key first.");
  return address;
}

// `errorCorrectionLevel` defaults to "M" (every address QR on iOS). Only the kpub QR passes "L"
// (iOS ColdStorageKpubQRView.generateQR: a kpub is several times longer, and "M" pushes it into
// a denser version that scans worse on screen).
export async function drawKaspaQr(canvas, payload, { dark = "#effcf7", light = "#071415", errorCorrectionLevel = "M" } = {}) {
  await QRCode.toCanvas(canvas, payload, {
    errorCorrectionLevel,
    margin: 3,
    width: 512,
    color: { dark, light }
  });
}

// --- KasSigner binary frames -----------------------------------------------------
// Port of iOS ByteModeQRCode.generateImage: one pure byte-mode segment, error correction "L",
// mask 0, at the smallest version 1-6 that fits — exactly what KasSigner's firmware itself
// produces/expects (bootloader/src/qr/encoder.rs). Nothing bigger than version 6 is ever drawn:
// a payload that does not fit is an error, not a silently denser symbol the device cannot read.
// QrFrameChunker (ui/kspt.js) keeps every frame within this: a single frame is at most 134 bytes,
// a chunked one 3 + 106 = 109.

/** Byte-mode capacity at ECC level L per version (KasSigner's VERSION_TABLE). */
export const KASSIGNER_QR_BYTE_CAPACITY = Object.freeze({ 1: 17, 2: 32, 3: 53, 4: 78, 5: 106, 6: 134 });
export const KASSIGNER_QR_MAX_VERSION = 6;

/**
 * The smallest KasSigner-supported QR version (1-6) that holds `byteLength` bytes, or null.
 * @param {number} byteLength
 * @returns {number|null}
 */
export function kasSignerQrVersionFor(byteLength) {
  for (let version = 1; version <= KASSIGNER_QR_MAX_VERSION; version += 1) {
    if (KASSIGNER_QR_BYTE_CAPACITY[version] >= byteLength) return version;
  }
  return null;
}

/**
 * The qrcode options for one KasSigner frame. Throws for a payload above version 6
 * (iOS QRError.tooLargeForSupportedVersions).
 * @param {number} byteLength
 */
export function kasSignerQrOptions(byteLength) {
  const version = kasSignerQrVersionFor(byteLength);
  if (!version) throw new Error(`Payload too large for a single QR frame (${byteLength} bytes)`);
  return { errorCorrectionLevel: "L", version, maskPattern: 0 };
}

/**
 * Draws one binary KasSigner frame onto `canvas`.
 * @param {HTMLCanvasElement} canvas
 * @param {Uint8Array} frame
 */
export async function drawKasSignerFrame(canvas, frame, { dark = "#06110f", light = "#ffffff", width = 480 } = {}) {
  await QRCode.toCanvas(canvas, [{ data: frame, mode: "byte" }], {
    ...kasSignerQrOptions(frame.length),
    // iOS pads CIBarcodeGenerator's 1-module quiet zone out to the ISO 4 modules.
    margin: 4,
    width,
    color: { dark, light },
  });
}

// --- Decoding ---------------------------------------------------------------
// jsQR rather than the browser's BarcodeDetector: BarcodeDetector is missing from
// Chromium on Linux and from Firefox entirely, and it only ever returns strings, so
// it cannot round-trip the binary KSPT frames the cold storage flow scans. jsQR is
// already bundled for that flow, so text scanning reuses the same decoder.

/**
 * Decodes a single QR code out of one canvas frame.
 * @param {ImageData|null} imageData Pixels from `ctx.getImageData(...)`.
 * @returns {string|null} The trimmed decoded text, or null when no code was found.
 */
export function decodeQrFromImageData(imageData) {
  if (!imageData?.data || !imageData.width || !imageData.height) return null;
  const code = jsQR(imageData.data, imageData.width, imageData.height, { inversionAttempts: "dontInvert" });
  const value = typeof code?.data === "string" ? code.data.trim() : "";
  return value || null;
}

/**
 * Normalizes a scanned/pasted Kaspa address: trims, and for a `kaspa:` / `kaspatest:`
 * URI drops any query string (`?amount=...`) so only the address itself survives.
 * Port of the shared `handleScannedQRCode` normalization on iOS.
 * @param {string} text
 * @returns {string}
 */
export function normalizeScannedKaspaAddress(text) {
  let value = String(text || "").trim();
  const lower = value.toLowerCase();
  if (lower.startsWith("kaspa:") || lower.startsWith("kaspatest:")) {
    const query = value.indexOf("?");
    if (query !== -1) value = value.slice(0, query);
  }
  return value.trim();
}
