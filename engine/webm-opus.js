// WebM-Opus for on-chain voice notes (iOS 7c5c22e3 WebMOpusEncoder / WebMOpusDecoder,
// MESSAGING.md "Long voice notes (multi-part)").
//
// Writing: a recording is cut into parts of at most partSeconds; each part is encoded on its own
// at 16 kbps CBR in 60 ms frames, fed the codec's 312-sample look-ahead from the next part, and
// muxed exactly as iOS muxes it (EBML header, Info with the part's real Duration, one Opus track,
// Clusters of about a second of SimpleBlocks). The encoder is the browser's WebCodecs
// AudioEncoder (libopus underneath, as on iOS).
//
// Reading: each part is decoded to 48 kHz PCM, its pre-skip dropped and the rest cut to its Info
// Duration, and the parts are concatenated, so a long note plays with no gap.

import { MAX_PARTS, MAX_PART_SECONDS, VOICE_BITRATE, VOICE_FRAME_MS, VOICE_LOOKAHEAD_SAMPLES, VOICE_SAMPLE_RATE } from "./voice-parts.js";

// ---------------------------------------------------------------------------------------------
// EBML writing (iOS WebMOpusEncoder.buildWebM, byte for byte)
// ---------------------------------------------------------------------------------------------

function concat(parts) {
  let length = 0;
  for (const part of parts) length += part.length;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

function encodeVint(value) {
  for (let length = 1; length <= 8; length += 1) {
    const max = 2 ** (7 * length) - 1;
    if (value <= max) {
      const bytes = new Uint8Array(length);
      let temp = value;
      for (let i = 0; i < length; i += 1) {
        bytes[length - 1 - i] = temp % 256;
        temp = Math.floor(temp / 256);
      }
      bytes[0] |= 1 << (8 - length);
      return bytes;
    }
  }
  return Uint8Array.from([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
}

function encodeUnsigned(value) {
  const bytes = [];
  let temp = value;
  do { bytes.unshift(temp % 256); temp = Math.floor(temp / 256); } while (temp > 0);
  return Uint8Array.from(bytes);
}

function encodeFloat64(value) {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setFloat64(0, value, false);
  return out;
}

function element(id, payload) {
  return concat([Uint8Array.from(id), encodeVint(payload.length), payload]);
}
const uintElement = (id, value) => element(id, encodeUnsigned(value));
const floatElement = (id, value) => element(id, encodeFloat64(value));
const stringElement = (id, value) => element(id, new TextEncoder().encode(value));

/** The OpusHead a WebM track carries: version 1, channels, pre-skip, input rate, gain 0. */
export function makeOpusHead({ channels = 1, preSkip = VOICE_LOOKAHEAD_SAMPLES, sampleRate = VOICE_SAMPLE_RATE } = {}) {
  const head = new Uint8Array(19);
  head.set(new TextEncoder().encode("OpusHead"), 0);
  const view = new DataView(head.buffer);
  head[8] = 1;
  head[9] = channels;
  view.setUint16(10, preSkip, true);
  view.setUint32(12, sampleRate, true);
  view.setInt16(16, 0, true);
  head[18] = 0;
  return head;
}

/** One WebM file around `packets` (iOS buildWebM). */
export function buildWebM({ packets, opusHead, sampleRate = VOICE_SAMPLE_RATE, durationSeconds, frameDurationMs = VOICE_FRAME_MS }) {
  const ebml = element([0x1a, 0x45, 0xdf, 0xa3], concat([
    uintElement([0x42, 0x86], 1),
    uintElement([0x42, 0xf7], 1),
    uintElement([0x42, 0xf2], 4),
    uintElement([0x42, 0xf3], 8),
    stringElement([0x42, 0x82], "webm"),
    uintElement([0x42, 0x87], 4),
    uintElement([0x42, 0x85], 2),
  ]));
  const info = element([0x15, 0x49, 0xa9, 0x66], concat([
    uintElement([0x2a, 0xd7, 0xb1], 1_000_000),
    floatElement([0x44, 0x89], durationSeconds * 1000),
    stringElement([0x4d, 0x80], "kasia-ios"),
    stringElement([0x57, 0x41], "kasia-ios"),
  ]));
  const uid = new Uint32Array(1);
  globalThis.crypto.getRandomValues(uid);
  const audio = element([0xe1], concat([floatElement([0xb5], sampleRate), uintElement([0x9f], 1)]));
  const entry = element([0xae], concat([
    uintElement([0xd7], 1),
    // Top bit set: always 4 bytes, so a part's size is exact (iOS's 155 bytes of headers).
    uintElement([0x73, 0xc5], (uid[0] | 0x80000000) >>> 0),
    uintElement([0x83], 2),
    stringElement([0x86], "A_OPUS"),
    element([0x63, 0xa2], opusHead),
    audio,
  ]));
  const tracks = element([0x16, 0x54, 0xae, 0x6b], entry);
  const perCluster = Math.max(1, Math.floor(1000 / Math.max(frameDurationMs, 1)));
  const clusters = [];
  for (let index = 0; index < packets.length; index += perCluster) {
    const slice = packets.slice(index, index + perCluster);
    const blocks = [uintElement([0xe7], index * frameDurationMs)];
    slice.forEach((packet, offset) => {
      const relative = Math.min(32767, offset * frameDurationMs);
      const block = new Uint8Array(4 + packet.length);
      block[0] = 0x81;
      block[1] = (relative >> 8) & 0xff;
      block[2] = relative & 0xff;
      block[3] = 0x80;
      block.set(packet, 4);
      blocks.push(element([0xa3], block));
    });
    clusters.push(element([0x1f, 0x43, 0xb6, 0x75], concat(blocks)));
  }
  const segmentPayload = concat([info, tracks, ...clusters]);
  return concat([ebml, Uint8Array.from([0x18, 0x53, 0x80, 0x67]), encodeVint(segmentPayload.length), segmentPayload]);
}

// ---------------------------------------------------------------------------------------------
// EBML reading
// ---------------------------------------------------------------------------------------------

function readVint(bytes, offset, { keepMarker = false } = {}) {
  if (offset >= bytes.length) return null;
  const first = bytes[offset];
  let length = 1;
  while (length <= 8 && !(first & (0x80 >> (length - 1)))) length += 1;
  if (length > 8 || offset + length > bytes.length) return null;
  let value = keepMarker ? first : first & (0xff >> length);
  let allOnes = value === (0xff >> length);
  for (let i = 1; i < length; i += 1) {
    value = value * 256 + bytes[offset + i];
    if (bytes[offset + i] !== 0xff) allOnes = false;
  }
  return { value, length, unknown: !keepMarker && allOnes };
}

const CONTAINERS = new Set([0x18538067, 0x1549a966, 0x1654ae6b, 0xae, 0x1f43b675, 0xa0, 0xe1]);
const TOP_LEVEL = new Set([0x1f43b675, 0x1c53bb6b, 0x1254c367, 0x1941a469, 0x1043a770, 0x114d9b74, 0x1549a966, 0x1654ae6b]);

/**
 * The Opus packets, OpusHead pre-skip and Info Duration of a WebM-Opus file; null when it is not
 * one this reader handles (laced blocks, no Opus track). Tolerates unknown-size Segments and
 * Clusters, as browsers' MediaRecorder writes them.
 */
export function parseWebMOpus(bytes) {
  const packets = [];
  let preSkip = null;
  let durationMs = null;
  let timecodeScale = 1_000_000;
  let codec = null;
  let laced = false;
  function walk(start, end, depth) {
    let offset = start;
    while (offset < end) {
      const id = readVint(bytes, offset, { keepMarker: true });
      if (!id) return;
      const size = readVint(bytes, offset + id.length);
      if (!size) return;
      const dataStart = offset + id.length + size.length;
      const unknown = size.unknown;
      const dataEnd = unknown ? end : Math.min(end, dataStart + size.value);
      const elementId = id.value;
      if (CONTAINERS.has(elementId)) {
        if (unknown && elementId === 0x1f43b675) {
          // An unknown-size Cluster runs to the next top-level element.
          let scan = dataStart;
          let bound = end;
          while (scan < end) {
            const childId = readVint(bytes, scan, { keepMarker: true });
            const childSize = childId && readVint(bytes, scan + childId.length);
            if (!childId || !childSize) { bound = end; break; }
            if (TOP_LEVEL.has(childId.value)) { bound = scan; break; }
            if (childSize.unknown) { bound = end; break; }
            scan += childId.length + childSize.length + childSize.value;
          }
          walk(dataStart, bound, depth + 1);
          offset = bound;
          continue;
        }
        walk(dataStart, dataEnd, depth + 1);
      } else if (elementId === 0xa3 || elementId === 0xa1) {
        const track = readVint(bytes, dataStart);
        if (track) {
          const flags = bytes[dataStart + track.length + 2];
          if (flags & 0x06) laced = true;
          else packets.push(bytes.subarray(dataStart + track.length + 3, dataEnd));
        }
      } else if (elementId === 0x63a2) {
        const head = bytes.subarray(dataStart, dataEnd);
        if (head.length >= 12 && new TextDecoder().decode(head.subarray(0, 8)) === "OpusHead") {
          preSkip = head[10] | (head[11] << 8);
        }
      } else if (elementId === 0x86) {
        codec = new TextDecoder().decode(bytes.subarray(dataStart, dataEnd));
      } else if (elementId === 0x2ad7b1) {
        let value = 0;
        for (let i = dataStart; i < dataEnd; i += 1) value = value * 256 + bytes[i];
        if (value > 0) timecodeScale = value;
      } else if (elementId === 0x4489) {
        const view = new DataView(bytes.buffer, bytes.byteOffset + dataStart, dataEnd - dataStart);
        const raw = dataEnd - dataStart === 4 ? view.getFloat32(0, false) : dataEnd - dataStart === 8 ? view.getFloat64(0, false) : NaN;
        if (Number.isFinite(raw) && raw > 0) durationMs = raw;
      }
      offset = dataEnd;
    }
  }
  try {
    walk(0, bytes.length, 0);
  } catch {
    return null;
  }
  if (laced || codec !== "A_OPUS" || !packets.length) return null;
  return {
    packets,
    preSkip: preSkip ?? VOICE_LOOKAHEAD_SAMPLES,
    durationSeconds: durationMs == null ? null : (durationMs * timecodeScale) / 1e9,
  };
}

/** Samples (at 48 kHz) an Opus packet decodes to, from its TOC byte (RFC 6716 3.1). */
export function opusPacketSamples(packet) {
  if (!packet || !packet.length) return 0;
  const toc = packet[0];
  const config = toc >> 3;
  let frameSamples;
  if (config < 12) frameSamples = [480, 960, 1920, 2880][config & 3];
  else if (config < 16) frameSamples = (config & 1) ? 960 : 480;
  else frameSamples = [120, 240, 480, 960][config & 3];
  const code = toc & 3;
  let frames;
  if (code === 0) frames = 1;
  else if (code === 1 || code === 2) frames = 2;
  else frames = packet.length > 1 ? packet[1] & 0x3f : 0;
  return frameSamples * frames;
}

// ---------------------------------------------------------------------------------------------
// Encoding (WebCodecs)
// ---------------------------------------------------------------------------------------------

const ENCODER_CONFIG = Object.freeze({
  codec: "opus",
  sampleRate: VOICE_SAMPLE_RATE,
  numberOfChannels: 1,
  bitrate: VOICE_BITRATE,
  bitrateMode: "constant",
  opus: { frameDuration: VOICE_FRAME_MS * 1000, application: "voip", complexity: 10 },
});

let encoderSupport = null;
/** Whether this browser can encode the on-chain voice format (16 kbps CBR Opus, 60 ms frames). */
export function voicePartsEncoderSupported() {
  if (encoderSupport) return encoderSupport;
  encoderSupport = (async () => {
    if (typeof globalThis.AudioEncoder !== "function" || typeof globalThis.AudioData !== "function") return false;
    try {
      const result = await globalThis.AudioEncoder.isConfigSupported(ENCODER_CONFIG);
      return Boolean(result?.supported);
    } catch {
      return false;
    }
  })();
  return encoderSupport;
}

async function encodeOpusPackets(samples) {
  const packets = [];
  let failure = null;
  const encoder = new globalThis.AudioEncoder({
    output: (chunk) => {
      const out = new Uint8Array(chunk.byteLength);
      chunk.copyTo(out);
      packets.push(out);
    },
    error: (error) => { failure = error; },
  });
  encoder.configure(ENCODER_CONFIG);
  const frameSamples = (VOICE_SAMPLE_RATE * VOICE_FRAME_MS) / 1000;
  // Whole frames, the tail padded with silence, as iOS feeds libopus.
  const padded = new Float32Array(Math.ceil(samples.length / frameSamples) * frameSamples);
  padded.set(samples);
  const data = new globalThis.AudioData({
    format: "f32",
    sampleRate: VOICE_SAMPLE_RATE,
    numberOfFrames: padded.length,
    numberOfChannels: 1,
    timestamp: 0,
    data: padded,
  });
  encoder.encode(data);
  data.close();
  await encoder.flush();
  encoder.close();
  if (failure) throw failure;
  // A flush may pad one more frame than iOS writes; keep what covers the input.
  const expected = padded.length / frameSamples;
  return packets.slice(0, Math.max(1, expected));
}

/**
 * A recording (mono Float32 at 48 kHz) as WebM-Opus parts of at most `path.partSeconds` each
 * (one part when it is that short), every part a complete file of its own (iOS
 * WebMOpusEncoder.encodeParts). Audio past MAX_PARTS parts is dropped, and so is a last scrap
 * under 0.2 s after a full part. Each part is capped at `path.maxBytes`.
 */
export async function encodeVoiceParts(samples, path) {
  if (!samples?.length) throw new Error("The recording is empty.");
  const rate = VOICE_SAMPLE_RATE;
  const partSamples = Math.max(1, Math.floor(path.partSeconds * rate));
  let total = Math.min(samples.length, partSamples * MAX_PARTS);
  const remainder = total % partSamples;
  if (total > partSamples && remainder > 0 && remainder < Math.floor(0.2 * rate)) total -= remainder;
  const opusHead = makeOpusHead({ preSkip: VOICE_LOOKAHEAD_SAMPLES });
  const parts = [];
  for (let start = 0; start < total; start += partSamples) {
    const end = Math.min(start + partSamples, total);
    const contentCount = end - start;
    const withLookahead = new Float32Array(contentCount + VOICE_LOOKAHEAD_SAMPLES);
    withLookahead.set(samples.subarray(start, Math.min(samples.length, end + VOICE_LOOKAHEAD_SAMPLES)));
    const packets = await encodeOpusPackets(withLookahead);
    const durationSeconds = contentCount / rate;
    const keptDuration = () => Math.min(durationSeconds, (packets.length * VOICE_FRAME_MS) / 1000);
    let webm = buildWebM({ packets, opusHead, durationSeconds: keptDuration() });
    while (webm.length > path.maxBytes && packets.length > 1) {
      packets.pop();
      webm = buildWebM({ packets, opusHead, durationSeconds: keptDuration() });
    }
    parts.push(webm);
  }
  return parts;
}

// ---------------------------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------------------------

let decodeContext = null;
function offlineContext() {
  const Ctor = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  if (!Ctor) return null;
  if (!decodeContext) decodeContext = new Ctor(1, 1, VOICE_SAMPLE_RATE);
  return decodeContext;
}

/** Mono Float32 at 48 kHz of any audio the browser can decode (a recording to encode). */
export async function decodeToMono48k(arrayBuffer) {
  const context = offlineContext();
  if (!context) throw new Error("Audio decoding isn't supported in this browser.");
  const buffer = await context.decodeAudioData(arrayBuffer.slice(0));
  if (buffer.numberOfChannels === 1) return buffer.getChannelData(0).slice();
  const out = new Float32Array(buffer.length);
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < out.length; i += 1) out[i] += data[i] / buffer.numberOfChannels;
  }
  return out;
}

/**
 * One part's PCM with its pre-skip dropped and cut to its Info Duration. Whether the browser
 * already dropped the pre-skip is read from the decoded length against the packets' total.
 */
async function decodePart(bytes) {
  const parsed = parseWebMOpus(bytes);
  const pcm = await decodeToMono48k(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  if (!parsed) return pcm;
  const full = parsed.packets.reduce((sum, packet) => sum + opusPacketSamples(packet), 0);
  const skip = Math.abs(pcm.length - full) <= Math.abs(pcm.length - (full - parsed.preSkip)) ? parsed.preSkip : 0;
  let length = pcm.length - skip;
  if (parsed.durationSeconds != null) length = Math.min(length, Math.round(parsed.durationSeconds * VOICE_SAMPLE_RATE));
  length = Math.max(0, Math.min(length, MAX_PART_SECONDS * VOICE_SAMPLE_RATE));
  return pcm.subarray(skip, skip + length);
}

/** The parts (in index order) as one gapless mono PCM at 48 kHz. */
export async function decodePartsToPcm(parts) {
  const decoded = [];
  for (const part of parts) decoded.push(await decodePart(part));
  const total = decoded.reduce((sum, pcm) => sum + pcm.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const pcm of decoded) { out.set(pcm, offset); offset += pcm.length; }
  return out;
}

/** A 16-bit PCM WAV of mono samples, downsampled 2:1 to 24 kHz (Opus at 16 kbps carries nothing
 *  above that), for an <audio> element. */
export function pcmToWavBlob(samples, sampleRate = VOICE_SAMPLE_RATE) {
  const half = sampleRate % 2 === 0;
  const outRate = half ? sampleRate / 2 : sampleRate;
  const count = half ? Math.floor(samples.length / 2) : samples.length;
  const buffer = new ArrayBuffer(44 + count * 2);
  const view = new DataView(buffer);
  const write = (offset, text) => { for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i)); };
  write(0, "RIFF");
  view.setUint32(4, 36 + count * 2, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, outRate, true);
  view.setUint32(28, outRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, "data");
  view.setUint32(40, count * 2, true);
  for (let i = 0; i < count; i += 1) {
    const value = half ? (samples[2 * i] + samples[2 * i + 1]) / 2 : samples[i];
    const clamped = Math.max(-1, Math.min(1, value));
    view.setInt16(44 + i * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
  }
  return new Blob([buffer], { type: "audio/wav" });
}
