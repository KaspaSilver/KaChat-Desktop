// On-chain photo quality tiers (iOS 7c5c22e3 ImagePrep.prepareJPEGForTiers, MESSAGING.md
// "Photos: quality tiers and multi-part photos"). Each tier is a byte budget; this finds the
// largest JPEG within it: the largest long edge (never upscaled) at which quality 0.5 fits, then
// the highest quality up to 0.85 that still fits at that edge. Below 0.5 only at the smallest
// edge. Re-rendered onto a white canvas, so orientation is applied and no EXIF/GPS is kept.

import { PHOTO_EDGES } from "../engine/voice-parts.js";

const MIN_QUALITY = 0.5;
const MAX_QUALITY = 0.85;

function canvasFor(width, height) {
  if (typeof OffscreenCanvas === "function") return new OffscreenCanvas(width, height);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

async function jpegBytes(canvas, quality) {
  let blob;
  if (typeof canvas.convertToBlob === "function") blob = await canvas.convertToBlob({ type: "image/jpeg", quality });
  else blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
  if (!blob) return null;
  return new Uint8Array(await blob.arrayBuffer());
}

/** A decodable image source from a Blob/File or data URL: {source, width, height}. */
export async function loadPhotoSource(input) {
  const blob = typeof input === "string" ? await (await fetch(input)).blob() : input;
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(blob, { imageOrientation: "from-image" });
      return { source: bitmap, width: bitmap.width, height: bitmap.height };
    } catch {}
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    await img.decode();
    return { source: img, width: img.naturalWidth, height: img.naturalHeight };
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

/**
 * The JPEG bytes for each budget in `budgets`, as {budget: Uint8Array}. `photo` is what
 * loadPhotoSource returns.
 */
export async function prepareJpegForTiers(photo, budgets) {
  const { source, width, height } = photo;
  if (!(width > 0 && height > 0)) throw new Error("This image can't be read.");
  const originalEdge = Math.max(width, height);
  const edges = [Math.min(originalEdge, PHOTO_EDGES[0]), ...PHOTO_EDGES.filter((edge) => edge < originalEdge && edge < PHOTO_EDGES[0])];
  const rendered = new Map();
  function render(edge) {
    if (rendered.has(edge)) return rendered.get(edge);
    const scale = edge / originalEdge;
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));
    const canvas = canvasFor(w, h);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(source, 0, 0, w, h);
    rendered.set(edge, canvas);
    return canvas;
  }
  const floorSize = new Map();
  async function atFloor(edge) {
    const data = await jpegBytes(render(edge), MIN_QUALITY);
    if (data) floorSize.set(edge, data.length);
    return data;
  }
  function predicted(edge) {
    if (!floorSize.size) return null;
    const known = Math.max(...floorSize.keys());
    return Math.floor((floorSize.get(known) * edge * edge) / (known * known));
  }
  const results = {};
  for (const budget of [...budgets].sort((a, b) => b - a)) {
    let chosen = null;
    for (const edge of edges) {
      if (floorSize.has(edge) && floorSize.get(edge) > budget) continue;
      if (!floorSize.has(edge)) {
        const guess = predicted(edge);
        if (guess != null && guess > (budget * 13) / 10) continue;
      }
      const floor = await atFloor(edge);
      if (!floor || floor.length > budget) continue;
      let best = floor;
      let low = MIN_QUALITY;
      let high = MAX_QUALITY;
      for (let i = 0; i < 6; i += 1) {
        const mid = (low + high) / 2;
        const data = await jpegBytes(render(edge), mid);
        if (!data) break;
        if (data.length <= budget) { best = data; low = mid; } else { high = mid; }
      }
      chosen = best;
      break;
    }
    if (!chosen) {
      // Nothing fits at the floor: the smallest edge, below it.
      const smallest = edges[edges.length - 1];
      for (let quality = 0.45; quality >= 0.05 - 1e-9; quality -= 0.05) {
        const data = await jpegBytes(render(smallest), quality);
        if (data && data.length <= budget) { chosen = data; break; }
        if (data) chosen = data;
      }
    }
    if (!chosen) throw new Error("This photo couldn't be compressed.");
    results[budget] = chosen;
  }
  for (const canvas of rendered.values()) { if (canvas.width) { canvas.width = 0; canvas.height = 0; } }
  return results;
}
