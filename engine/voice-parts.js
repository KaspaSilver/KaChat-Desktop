// Long voice notes and multi-part photos (iOS 7c5c22e3, MESSAGING.md "Long voice notes
// (multi-part)" and "Photos: quality tiers and multi-part photos"; KaPost 1b15521 for rooms).
//
// A voice note longer than one transaction carries goes as several ordinary voice messages, each
// a complete WebM-Opus file tagged `"voicePart":{"id":"<hex>","index":i,"count":N}`. A photo
// bigger than one part goes as raw JPEG chunks tagged the same way under `mediaPart`. The tag
// sits in the binary media frame's header and in the media-file JSON rebuilt from it, between
// `mimeType` and `content`, so a head-window sniff finds it without reading the file.
//
// Parts belong together by (owner, id, count): owner is the sender in 1:1, the group id and
// sender id in a group, the room and sender in a room. The thread draws one bubble at the
// earliest part; unread, the chat list and notifications count the note once.
//
// Pure: no DOM, no WASM, no network.

/** The most parts one note or photo may have: a strict bound readers enforce. */
export const MAX_PARTS = 12;
/** The longest one voice part may run when read (iOS VoicePartTag.maxPartSeconds). */
export const MAX_PART_SECONDS = 25;

/** On-chain voice notes: 16 kbps CBR Opus in 60 ms frames (iOS VoiceNotePolicy). */
export const VOICE_BITRATE = 16000;
export const VOICE_FRAME_MS = 60;
export const VOICE_LOOKAHEAD_SAMPLES = 312;
export const VOICE_SAMPLE_RATE = 48000;
export const VOICE_PATHS = Object.freeze({
  // 1:1 (and rooms, KaPost VoiceNotePolicy.publicChat): 12 parts of 14.5 s are 0.977 KAS.
  oneToOne: Object.freeze({ partSeconds: 14.5, maxSeconds: 170, maxBytes: 31000 }),
  // Groups: 12 parts of 9.8 s are 0.964 KAS.
  group: Object.freeze({ partSeconds: 9.8, maxSeconds: 110, maxBytes: 21000 }),
  room: Object.freeze({ partSeconds: 14.5, maxSeconds: 170, maxBytes: 31000 }),
});

// ---------------------------------------------------------------------------------------------
// The tag
// ---------------------------------------------------------------------------------------------

function strictInteger(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value !== Math.round(value) || Math.abs(value) >= 1000) return null;
  return value;
}

/** A valid tag {id, index, count} from loose values, or null (iOS VoicePartTag.init). */
export function makePartTag(id, index, count) {
  if (typeof id !== "string") return null;
  const lowered = id.toLowerCase();
  if (lowered.length < 16 || lowered.length > 64 || !/^[0-9a-f]+$/.test(lowered)) return null;
  const i = strictInteger(index);
  const n = strictInteger(count);
  if (n == null || i == null || n < 2 || n > MAX_PARTS || i < 1 || i > n) return null;
  return { id: lowered, index: i, count: n };
}

/** A tag from a parsed JSON value: an object with a string id and integer index and count. */
export function partTagFromObject(object) {
  if (!object || typeof object !== "object" || Array.isArray(object)) return null;
  return makePartTag(object.id, object.index, object.count);
}

/** The tag as it goes into the media-file JSON, fixed key order. */
export function partTagJson(tag) {
  return `{"id":"${tag.id}","index":${tag.index},"count":${tag.count}}`;
}

/** The key a tag goes under: voicePart on audio, mediaPart on an image, else null. */
export function partKeyForMimeType(mimeType) {
  const lowered = String(mimeType || "").toLowerCase();
  if (lowered.startsWith("audio/")) return "voicePart";
  if (lowered.startsWith("image/")) return "mediaPart";
  return null;
}

export function voicePartFileName(tag) {
  return `voice-${tag.index}of${tag.count}.webm`;
}

export function photoPartFileName(tag) {
  return `photo-${tag.index}of${tag.count}.jpg`;
}

/** 16 random bytes as lowercase hex. */
export function newPartGroupId() {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** An inline media JSON's mimeType from its first 2 KB (iOS InlineMediaSniff.mimeType). */
export function sniffInlineMimeType(text) {
  if (typeof text !== "string") return null;
  const head = text.slice(0, 2048).trim();
  if (!head.startsWith("{")) return null;
  const keyAt = head.indexOf('"mimeType"');
  if (keyAt >= 0) {
    const match = /^\s*:\s*"([^"]*)"/.exec(head.slice(keyAt + 10));
    if (match) return match[1].replace(/\\\//g, "/");
  }
  const contentAt = head.indexOf('"content"');
  if (contentAt >= 0) {
    const match = /^\s*:\s*"data:([^;",]*)/.exec(head.slice(contentAt + 9));
    if (match) return match[1].replace(/\\\//g, "/");
  }
  return null;
}

const sniffCache = new Map();
const SNIFF_CACHE_MAX = 2048;

/**
 * The part tag of a media-file JSON, read from its head only (iOS VoicePartTag.sniff):
 * `{kind: "voice" | "photo", id, index, count}`, or null for everything else, including a tag
 * under the other kind's key and a malformed tag.
 */
export function sniffPartTag(text) {
  if (typeof text !== "string" || !text.startsWith("{") || text.length <= 64) return null;
  const head = text.slice(0, 2048);
  if (sniffCache.has(head)) return sniffCache.get(head);
  let result = null;
  const mime = sniffInlineMimeType(head);
  const key = mime ? partKeyForMimeType(mime) : null;
  if (key) {
    const keyAt = head.indexOf(`"${key}"`);
    if (keyAt >= 0) {
      const rest = head.slice(keyAt + key.length + 2);
      const open = rest.indexOf("{");
      if (open >= 0 && /^[\s:]*$/.test(rest.slice(0, open))) {
        const close = rest.indexOf("}", open);
        if (close > open) {
          try {
            const tag = partTagFromObject(JSON.parse(rest.slice(open, close + 1)));
            if (tag) result = { kind: key === "voicePart" ? "voice" : "photo", ...tag };
          } catch {}
        }
      }
    }
  }
  if (sniffCache.size >= SNIFF_CACHE_MAX) sniffCache.clear();
  sniffCache.set(head, result);
  return result;
}

/** The grouping key of a part: owner, id and count. */
export function partNoteKey(owner, tag) {
  return `${String(owner || "").toLowerCase()}|${tag.id}|${tag.count}`;
}

// ---------------------------------------------------------------------------------------------
// Grouping a thread
// ---------------------------------------------------------------------------------------------

const STATUS_PRIORITY = { failed: 0, pending: 1, warning: 2, sent: 3 };

/** One status for a whole note (iOS VoicePartCluster.deliveryStatus): any failed part fails it,
 *  then any pending part keeps it sending, then any unconfirmed part shows that. */
export function combinedPartStatus(statuses) {
  if (statuses.includes("failed")) return "failed";
  if (statuses.includes("pending")) return "pending";
  if (statuses.includes("warning")) return "warning";
  return "sent";
}

/**
 * Groups the parts of `messages` (in thread order). `accessors` reads a message:
 * `{ content(m), owner(m), key(m), status(m) }` where `key` is a stable id (txId or row id) and
 * `status` is one of failed / pending / warning / sent.
 *
 * Returns `{ clusters: Map<anchorKey, cluster>, hidden: Set<key>, anchorKeyOf: Map<key, anchorKey> }`.
 * A cluster is `{ noteKey, kind, count, parts (by index, in order), anchor, members, isComplete }`.
 * A note with a single part present still becomes a cluster (its bubble says it is receiving).
 */
export function groupParts(messages, accessors) {
  const tagged = new Map();
  for (const message of messages) {
    const tag = sniffPartTag(accessors.content(message));
    if (!tag) continue;
    const noteKey = `${tag.kind}|${partNoteKey(accessors.owner(message), tag)}`;
    if (!tagged.has(noteKey)) tagged.set(noteKey, []);
    tagged.get(noteKey).push({ message, tag });
  }
  const clusters = new Map();
  const hidden = new Set();
  const anchorKeyOf = new Map();
  for (const [noteKey, members] of tagged) {
    const anchor = members[0].message;
    const anchorKey = accessors.key(anchor);
    const byIndex = new Map();
    for (const { message, tag } of members) {
      const existing = byIndex.get(tag.index);
      if (!existing || (STATUS_PRIORITY[accessors.status(message)] ?? 3) > (STATUS_PRIORITY[accessors.status(existing)] ?? 3)) {
        byIndex.set(tag.index, message);
      }
    }
    const parts = [...byIndex.keys()].sort((a, b) => a - b).map((index) => byIndex.get(index));
    const count = members[0].tag.count;
    clusters.set(anchorKey, {
      noteKey,
      kind: members[0].tag.kind,
      count,
      parts,
      anchor,
      members: members.map((m) => m.message),
      isComplete: parts.length === count,
      status: combinedPartStatus(parts.map((m) => accessors.status(m))),
    });
    for (const { message } of members) {
      const key = accessors.key(message);
      anchorKeyOf.set(key, anchorKey);
      if (key !== anchorKey) hidden.add(key);
    }
  }
  return { clusters, hidden, anchorKeyOf };
}

/** How many unread units `messages` are: a note's parts count once. */
export function unreadUnits(messages, accessors) {
  let count = 0;
  const seen = new Set();
  for (const message of messages) {
    const tag = sniffPartTag(accessors.content(message));
    if (tag) {
      const key = `${tag.kind}|${partNoteKey(accessors.owner(message), tag)}`;
      if (seen.has(key)) continue;
      seen.add(key);
    }
    count += 1;
  }
  return count;
}

/** True when `message` is a part and `others` already holds another part of the same note:
 *  not news of its own (no unread bump, no banner). */
export function isLaterPart(message, others, accessors) {
  const tag = sniffPartTag(accessors.content(message));
  if (!tag) return false;
  const owner = String(accessors.owner(message) || "").toLowerCase();
  const key = partNoteKey(owner, tag);
  const ownKey = accessors.key(message);
  return others.some((other) => {
    if (accessors.key(other) === ownKey) return false;
    if (String(accessors.owner(other) || "").toLowerCase() !== owner) return false;
    const otherTag = sniffPartTag(accessors.content(other));
    return Boolean(otherTag && otherTag.kind === tag.kind && partNoteKey(owner, otherTag) === key);
  });
}

// ---------------------------------------------------------------------------------------------
// Voice layout (iOS VoiceNoteLayout)
// ---------------------------------------------------------------------------------------------

/** Bytes of each part a recording of `durationSeconds` makes on `path` (exact to a few bytes
 *  at CBR): parts of partSeconds, at most MAX_PARTS, each capped at maxBytes. */
export function voicePartSizes(durationSeconds, path, { bitrate = VOICE_BITRATE, frameMs = VOICE_FRAME_MS, sampleRate = VOICE_SAMPLE_RATE } = {}) {
  let remaining = Math.min(Math.max(durationSeconds, frameMs / 1000), path.partSeconds * MAX_PARTS);
  const frameSamples = Math.max(1, Math.floor(sampleRate * frameMs / 1000));
  const frameRate12 = Math.max(1, Math.floor(12 * sampleRate / frameSamples));
  const packetBytes = Math.floor((Math.floor(12 * bitrate / 8) + Math.floor(frameRate12 / 2)) / frameRate12);
  const packetsPerCluster = Math.max(1, Math.floor(1000 / Math.max(1, frameMs)));
  const lookahead = Math.floor(sampleRate * VOICE_LOOKAHEAD_SAMPLES / 48000);
  const sizes = [];
  while (remaining > 0.0005 && sizes.length < MAX_PARTS) {
    const part = Math.min(remaining, path.partSeconds);
    const samples = Math.floor(part * sampleRate) + lookahead;
    const packets = Math.ceil(samples / frameSamples);
    const clusters = Math.ceil(packets / packetsPerCluster);
    sizes.push(Math.min(155 + packets * (packetBytes + 6) + clusters * 10, path.maxBytes));
    remaining -= part;
  }
  return sizes;
}

// ---------------------------------------------------------------------------------------------
// Photos (iOS PhotoTier / PhotoPolicy)
// ---------------------------------------------------------------------------------------------

export const PHOTO_TIERS = Object.freeze([
  Object.freeze({ id: "high", title: "High", budgetSompi: 100_000_000, maxBytes: { oneToOne: 368_000, group: 243_000 } }),
  Object.freeze({ id: "medium", title: "Medium", budgetSompi: 50_000_000, maxBytes: { oneToOne: 184_000, group: 121_500 } }),
  Object.freeze({ id: "low", title: "Low", budgetSompi: 10_000_000, maxBytes: { oneToOne: 36_000, group: 23_500 } }),
]);

export function photoTier(id) {
  return PHOTO_TIERS.find((tier) => tier.id === id) || null;
}

export function photoTierMaxBytes(id, { group = false } = {}) {
  const tier = photoTier(id);
  return tier ? tier.maxBytes[group ? "group" : "oneToOne"] : 0;
}

export function photoPartBytes({ group = false } = {}) {
  return group ? 21_000 : 31_000;
}

/** A photo's bytes as the chunks it goes as, in order: one when it fits one part. */
export function photoChunks(bytes, { group = false } = {}) {
  const size = photoPartBytes({ group });
  if (bytes.length <= size) return [bytes];
  const chunks = [];
  for (let offset = 0; offset < bytes.length; offset += size) chunks.push(bytes.subarray(offset, Math.min(offset + size, bytes.length)));
  return chunks;
}

/** The fee a photo of `bytes` costs on a path (the quality sheet's number). */
export function photoEstimatedFeeSompi(bytes, { group = false } = {}) {
  const size = photoPartBytes({ group });
  const count = Math.max(1, Math.ceil(bytes / size));
  let total = 0;
  let remaining = bytes;
  for (let i = 0; i < count; i += 1) {
    const chunk = Math.min(size, remaining);
    remaining -= chunk;
    const header = count > 1 ? 142 : 100;
    const plaintext = 9 + header + chunk;
    const payload = group ? 391 + 2 * (plaintext + 16) : 26 + 4 * Math.floor((plaintext + 61 + 2) / 3);
    total += 2 * (payload + 272) * 100 + 3;
  }
  return total;
}

/** The long edges a photo is tried at, largest first (iOS ImagePrep.prepareJPEGForTiers). */
export const PHOTO_EDGES = Object.freeze([3000, 2560, 2240, 2048, 1920, 1600, 1440, 1280, 1080, 960, 800, 640, 480, 360]);
