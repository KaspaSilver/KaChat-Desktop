// Long voice notes and multi-part photos in the UI (iOS 7c5c22e3 / ca013fc8, KaPost 1b15521):
// turning a recording into on-chain parts, the parts' envelopes, and drawing a note or photo whose
// parts arrive as several messages as ONE bubble.

import {
  MAX_PARTS, VOICE_PATHS, makePartTag, newPartGroupId, voicePartFileName, photoPartFileName,
  photoChunks, sniffPartTag,
} from "../engine/voice-parts.js";
import { mediaFileEnvelopeJson } from "../engine/media-frame.js";
import { decodePartsToPcm, decodeToMono48k, encodeVoiceParts, pcmToWavBlob, voicePartsEncoderSupported } from "../engine/webm-opus.js";

export { VOICE_PATHS, sniffPartTag };

// Known once at start-up, so a recording's limit can be picked synchronously.
let encoderSupported = false;
voicePartsEncoderSupported().then((ok) => { encoderSupported = ok; }).catch(() => {});
/** True when this browser records the on-chain 16 kbps / 60 ms format (WebCodecs Opus). */
export function longVoiceNotesSupported() {
  return encoderSupported;
}

/** "2:50" for a limit in seconds (iOS's "Up to %@, sent on chain."). */
export function formatLimit(seconds) {
  const total = Math.max(0, Math.round(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function bytesToBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** The raw bytes of a media-file JSON's base64 data URL, or null. */
export function envelopeBytes(text) {
  if (typeof text !== "string") return null;
  const at = text.indexOf('"content":"data:');
  if (at < 0) return null;
  const comma = text.indexOf(",", at);
  const end = text.indexOf('"', comma + 1);
  if (comma < 0 || end < 0) return null;
  try {
    const binary = atob(text.slice(comma + 1, end));
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/**
 * A finished recording as the parts it goes on chain as (iOS encodeParts): `{parts, seconds,
 * previewBlob}`, where the preview is the note as it will be heard (the parts decoded and joined).
 */
export async function prepareVoiceParts(blob, path) {
  const pcm = await decodeToMono48k(await blob.arrayBuffer());
  const limited = pcm.subarray(0, Math.min(pcm.length, Math.round(path.maxSeconds * 48000)));
  const parts = await encodeVoiceParts(limited, path);
  const joined = await decodePartsToPcm(parts);
  return { parts, seconds: joined.length / 48000, previewBlob: pcmToWavBlob(joined) };
}

/** The media-file JSON of each part: one untagged message for a single part, else tagged
 *  `voicePart` parts sharing one random id. */
export function voicePartEnvelopes(parts, mimeType = "audio/webm") {
  const id = parts.length > 1 ? newPartGroupId() : null;
  return parts.map((bytes, offset) => {
    const tag = id ? makePartTag(id, offset + 1, parts.length) : null;
    return mediaFileEnvelopeJson({
      name: tag ? voicePartFileName(tag) : "voice.webm",
      size: bytes.length,
      mimeType,
      dataUrlContent: `data:${mimeType};base64,${bytesToBase64(bytes)}`,
      voicePart: tag,
    });
  });
}

/** A JPEG's media-file JSON(s): one plain photo when it fits one part, else `mediaPart` chunks. */
export function photoEnvelopes(jpeg, { group = false } = {}) {
  const chunks = photoChunks(jpeg, { group });
  if (chunks.length > MAX_PARTS) throw new Error("This photo is too large to send on chain.");
  const id = chunks.length > 1 ? newPartGroupId() : null;
  return chunks.map((bytes, offset) => {
    const tag = id ? makePartTag(id, offset + 1, chunks.length) : null;
    return mediaFileEnvelopeJson({
      name: tag ? photoPartFileName(tag) : "photo.jpg",
      size: bytes.length,
      mimeType: "image/jpeg",
      dataUrlContent: `data:image/jpeg;base64,${bytesToBase64(bytes)}`,
      mediaPart: tag,
    });
  });
}

// ---------------------------------------------------------------------------------------------
// Joined media, cached by the parts it was made from
// ---------------------------------------------------------------------------------------------

// Least recently used first. Only an entry nobody has asked for in the last minute is let go, so
// a thread showing more notes than the cap never evicts what it is drawing (which would decode,
// redraw and decode again without end); the map may run over the cap meanwhile.
const JOINED_CAP = 60;
const JOINED_KEEP_MS = 60_000;
const joined = new Map(); // key -> { promise, url, failed, usedAt }

function remember(key, make) {
  const now = Date.now();
  if (joined.has(key)) {
    const entry = joined.get(key);
    entry.usedAt = now;
    joined.delete(key);
    joined.set(key, entry);
    return entry;
  }
  const entry = { url: null, failed: false, promise: null, usedAt: now };
  entry.promise = make().then((url) => { entry.url = url; return url; }).catch(() => { entry.failed = true; return null; });
  joined.set(key, entry);
  for (const [oldKey, old] of joined) {
    if (joined.size <= JOINED_CAP || now - old.usedAt < JOINED_KEEP_MS) break;
    joined.delete(oldKey);
    if (old.url) setTimeout(() => URL.revokeObjectURL(old.url), 60_000);
  }
  return entry;
}

function partsKey(kind, texts) {
  return `${kind}|${texts.map((text) => `${text.length}:${text.slice(-48)}`).join("|")}`;
}

/** The parts present (texts in index order) joined into one playable WAV: {url, promise}. */
export function joinedVoice(texts) {
  return remember(partsKey("voice", texts), async () => {
    const parts = texts.map(envelopeBytes);
    if (parts.some((bytes) => !bytes)) throw new Error("unreadable part");
    const pcm = await decodePartsToPcm(parts);
    return URL.createObjectURL(pcmToWavBlob(pcm));
  });
}

/** A complete photo's chunks (texts in index order) joined into one JPEG: {url, promise}. */
export function joinedPhoto(texts) {
  return remember(partsKey("photo", texts), async () => {
    const parts = texts.map(envelopeBytes);
    if (parts.some((bytes) => !bytes)) throw new Error("unreadable part");
    const total = parts.reduce((sum, bytes) => sum + bytes.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const bytes of parts) { out.set(bytes, offset); offset += bytes.length; }
    return URL.createObjectURL(new Blob([out], { type: "image/jpeg" }));
  });
}

/** "Receiving… 7 of 12" (iOS). */
export function receivingText(present, count) {
  return `Receiving… ${present} of ${count}`;
}

/**
 * One bubble's body for a cluster (from groupParts): the joined voice note or photo.
 * `contentOf(message)` is the message's media-file JSON; `buildVoicePlayer` is the app's player;
 * `onReady` re-runs when the joined media lands (a later render then draws it at once).
 */
export function buildPartsBody(cluster, { contentOf, buildVoicePlayer, outgoing = false, onPhotoOpen = null, onReady = null }) {
  const texts = cluster.parts.map(contentOf);
  const wrap = document.createElement("div");
  const present = cluster.parts.length;
  if (cluster.kind === "voice") {
    wrap.className = "message-audio-bubble message-parts-voice";
    const entry = joinedVoice(texts);
    if (entry.url) wrap.append(buildVoicePlayer(entry.url, { outgoing, chatStyle: true }));
    else if (entry.failed) wrap.append(Object.assign(document.createElement("small"), { className: "message-parts-note", textContent: "This voice message can't be played." }));
    else {
      const loading = document.createElement("div");
      loading.className = `voice-player loading${outgoing ? " outgoing" : ""}`;
      loading.innerHTML = '<span class="composer-field-spinner" aria-hidden="true"></span><small class="voice-player-time">--:--</small>';
      wrap.append(loading);
      entry.promise.then((url) => { if (url && wrap.isConnected) onReady?.(); });
    }
    if (!cluster.isComplete) wrap.append(Object.assign(document.createElement("small"), { className: "message-parts-note", textContent: receivingText(present, cluster.count) }));
    return wrap;
  }
  wrap.className = "message-parts-photo";
  if (!cluster.isComplete) {
    wrap.classList.add("receiving");
    wrap.innerHTML = '<span class="composer-field-spinner" aria-hidden="true"></span><span></span>';
    wrap.querySelector("span:last-child").textContent = receivingText(present, cluster.count);
    return wrap;
  }
  const entry = joinedPhoto(texts);
  if (entry.url) {
    const img = document.createElement("img");
    img.className = "message-photo";
    img.src = entry.url;
    img.alt = "Photo";
    if (onPhotoOpen) img.addEventListener("click", () => onPhotoOpen(entry.url));
    wrap.append(img);
  } else {
    wrap.classList.add("receiving");
    wrap.innerHTML = '<span class="composer-field-spinner" aria-hidden="true"></span>';
    entry.promise.then((url) => { if (url && wrap.isConnected) onReady?.(); });
  }
  return wrap;
}
