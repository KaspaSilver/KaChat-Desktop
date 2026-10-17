// A minimal ZIP writer: stored entries only (no compression), the same shape as iOS's
// SimpleZipWriter (Settings > Diagnostics > Export Diagnostics Archive). Enough for a handful of
// small text files; no dependency.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i += 1) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

/// DOS time/date fields for `date` (local time, as zip readers show it).
function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time: time & 0xFFFF, date: day & 0xFFFF };
}

/**
 * Builds a zip of `files` ([{ name, data }], data a string or Uint8Array) and returns its bytes.
 * Names are written as UTF-8 (general purpose flag bit 11).
 */
export function createStoredZip(files, { date = new Date() } = {}) {
  const encoder = new TextEncoder();
  const { time, date: day } = dosDateTime(date);
  const entries = files.map((file) => {
    const nameBytes = encoder.encode(String(file.name));
    const data = typeof file.data === "string" ? encoder.encode(file.data) : new Uint8Array(file.data || []);
    return { nameBytes, data, crc: crc32(data) };
  });

  let size = 22; // end of central directory
  for (const entry of entries) size += 30 + entry.nameBytes.length + entry.data.length + 46 + entry.nameBytes.length;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  let offset = 0;
  const u16 = (value) => { view.setUint16(offset, value, true); offset += 2; };
  const u32 = (value) => { view.setUint32(offset, value >>> 0, true); offset += 4; };
  const bytes = (value) => { out.set(value, offset); offset += value.length; };

  const localOffsets = [];
  for (const entry of entries) {
    localOffsets.push(offset);
    u32(0x04034B50); u16(20); u16(0x0800); u16(0); u16(time); u16(day);
    u32(entry.crc); u32(entry.data.length); u32(entry.data.length);
    u16(entry.nameBytes.length); u16(0);
    bytes(entry.nameBytes); bytes(entry.data);
  }
  const centralStart = offset;
  entries.forEach((entry, index) => {
    u32(0x02014B50); u16(20); u16(20); u16(0x0800); u16(0); u16(time); u16(day);
    u32(entry.crc); u32(entry.data.length); u32(entry.data.length);
    u16(entry.nameBytes.length); u16(0); u16(0); u16(0); u16(0); u32(0);
    u32(localOffsets[index]);
    bytes(entry.nameBytes);
  });
  const centralSize = offset - centralStart;
  u32(0x06054B50); u16(0); u16(0); u16(entries.length); u16(entries.length);
  u32(centralSize); u32(centralStart); u16(0);
  return out;
}
