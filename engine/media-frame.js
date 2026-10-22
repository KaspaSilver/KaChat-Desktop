// The binary media frame (iOS f5f6a11, MESSAGING.md "Photos and voice notes: the binary media
// frame"): a 1:1 photo or voice note travels inside the encryption as its RAW bytes, not as the
// media-file JSON text whose base64 data URL was then base64'd a second time into the payload.
//
//   0xFF 'K' 'C' 'M' 0x01 | u32 big-endian header length | header JSON | raw file bytes
//   header JSON: {"mimeType":"image\/jpeg","name":"photo.jpg","size":20072}
//
// 0xFF never begins UTF-8, so a frame never collides with a text message. On receipt it becomes
// exactly the media-file JSON the text form carried (iOS MediaFileEnvelope.json), so storage,
// rendering, dedupe and backups see no difference. Pure: no DOM, no WASM, no network.
// iOS: ContextualMediaFrame (KaChatCipher.swift) and the push extension's mediaFrameEnvelope.

export const MEDIA_FRAME_MAGIC = Object.freeze([0xff, 0x4b, 0x43, 0x4d, 0x01]);
const HEADER_START = MEDIA_FRAME_MAGIC.length + 4;
const UTF8 = new TextEncoder();
const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true });
// Foundation's Data(base64Encoded:): standard alphabet, padded to a multiple of 4, no whitespace.
const STRICT_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** True when `bytes` starts with the frame's 5-byte magic. */
export function hasMediaFrameMagic(bytes) {
  if (!bytes || bytes.length < MEDIA_FRAME_MAGIC.length) return false;
  for (let i = 0; i < MEDIA_FRAME_MAGIC.length; i += 1) if (bytes[i] !== MEDIA_FRAME_MAGIC[i]) return false;
  return true;
}

/** iOS MediaFileEnvelope.json, byte for byte: fixed key order, and only `\` and `"` escaped
 *  (string interpolation, not JSONEncoder - so "/" stays "/"). */
export function mediaFileEnvelopeJson({ name, size, mimeType, dataUrlContent }) {
  return `{"type":"file","name":"${escapeIos(name)}","size":${size},"mimeType":"${escapeIos(mimeType)}","content":"${escapeIos(dataUrlContent)}"}`;
}

function escapeIos(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * The media-file JSON a frame stands for (iOS ContextualMediaFrame.envelopeText(from:)); null
 * when `bytes` is not a well-formed frame. Like iOS: the header's `size` is not checked - the
 * rebuilt JSON carries the raw byte count - a missing or non-string name reads "file", and a
 * header that is not a JSON object, has no mimeType, or leaves no file bytes is not a frame.
 */
export function mediaEnvelopeFromFrame(bytes) {
  if (!bytes || bytes.length <= HEADER_START || !hasMediaFrameMagic(bytes)) return null;
  const m = MEDIA_FRAME_MAGIC.length;
  const headerLength = ((bytes[m] << 24) >>> 0) + (bytes[m + 1] << 16) + (bytes[m + 2] << 8) + bytes[m + 3];
  if (headerLength <= 0 || HEADER_START + headerLength > bytes.length) return null;
  let header;
  try {
    header = JSON.parse(STRICT_UTF8.decode(bytes.subarray(HEADER_START, HEADER_START + headerLength)));
  } catch {
    return null;
  }
  if (!header || typeof header !== "object" || Array.isArray(header)) return null;
  const mimeType = header.mimeType;
  if (typeof mimeType !== "string" || !mimeType) return null;
  const raw = bytes.subarray(HEADER_START + headerLength);
  if (!raw.length) return null;
  return mediaFileEnvelopeJson({
    name: typeof header.name === "string" ? header.name : "file",
    size: raw.length,
    mimeType,
    dataUrlContent: `data:${mimeType};base64,${bytesToBase64(raw)}`,
  });
}

/**
 * The frame for a media-file JSON whose content is a base64 data URL of an image/* or audio/*
 * type (iOS ContextualMediaFrame.frame(forEnvelope:)); null for anything else, which goes out as
 * UTF-8 text as before. The header is what iOS's JSONSerialization(.sortedKeys) writes: keys
 * mimeType, name, size in that order, with "/" escaped as "\/".
 */
export function mediaFrameForEnvelope(text) {
  if (typeof text !== "string" || !text.startsWith("{") || !text.includes('"type":"file"')) return null;
  let object;
  try { object = JSON.parse(text); } catch { return null; }
  if (!object || typeof object !== "object" || Array.isArray(object) || object.type !== "file") return null;
  const content = object.content;
  if (typeof content !== "string" || !content.startsWith("data:")) return null;
  const comma = content.indexOf(",");
  if (comma < 0) return null;
  const meta = content.slice(5, comma);
  if (!meta.endsWith(";base64")) return null;
  const mimeType = meta.slice(0, -";base64".length);
  const lowered = mimeType.toLowerCase();
  if (!lowered.startsWith("image/") && !lowered.startsWith("audio/")) return null;
  const raw = strictBase64ToBytes(content.slice(comma + 1));
  if (!raw || !raw.length) return null;
  const header = UTF8.encode(appleJsonString({
    mimeType,
    name: typeof object.name === "string" ? object.name : "file",
    size: raw.length,
  }));
  if (header.length > 0xffffffff) return null;
  const frame = new Uint8Array(HEADER_START + header.length + raw.length);
  frame.set(MEDIA_FRAME_MAGIC, 0);
  const m = MEDIA_FRAME_MAGIC.length;
  frame[m] = (header.length >>> 24) & 0xff;
  frame[m + 1] = (header.length >>> 16) & 0xff;
  frame[m + 2] = (header.length >>> 8) & 0xff;
  frame[m + 3] = header.length & 0xff;
  frame.set(header, HEADER_START);
  frame.set(raw, HEADER_START + header.length);
  return frame;
}

/** Bytes of the frame a media-file JSON of `rawBytes` file bytes would make (for the composer's
 *  fee estimate): magic + length + header + raw. */
export function mediaFrameByteLength({ rawBytes, name = "file", mimeType }) {
  const header = UTF8.encode(appleJsonString({ mimeType: String(mimeType || ""), name: String(name), size: Number(rawBytes) || 0 }));
  return HEADER_START + header.length + (Number(rawBytes) || 0);
}

// JSONSerialization's output for a flat object of strings and integers, with the keys already in
// sorted order: JSON.stringify writes the same escapes (\" \\ \b \f \n \r \t, \u00xx for other
// controls, raw UTF-8 for the rest) except that Foundation also escapes "/" as "\/".
function appleJsonString(object) {
  return JSON.stringify(object).replace(/\//g, "\\/");
}

function strictBase64ToBytes(value) {
  if (!STRICT_BASE64.test(value)) return null;
  try {
    const binary = atob(value);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function bytesToBase64(bytes) {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
