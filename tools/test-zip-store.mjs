// The diagnostics zip writer (iOS SimpleZipWriter): stored entries, CRC-32, a readable directory.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, createStoredZip } from "../ui/zip-store.js";

const enc = new TextEncoder();
assert.equal(crc32(enc.encode("")), 0);
assert.equal(crc32(enc.encode("hello")), 0x3610A686);
assert.equal(crc32(enc.encode("The quick brown fox jumps over the lazy dog")), 0x414FA339);

const json = JSON.stringify({ app: "KaChat", n: 1 }, null, 2);
const log = "2026-10-17T00:00:00Z line one\nline two é";
const zip = createStoredZip([{ name: "diagnostics.json", data: json }, { name: "app.log", data: log }], { date: new Date(2026, 9, 17, 12, 30, 10) });
const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);

// End of central directory: two entries, and it points at a central directory that is there.
const eocd = zip.length - 22;
assert.equal(view.getUint32(eocd, true), 0x06054B50);
assert.equal(view.getUint16(eocd + 10, true), 2);
const cdSize = view.getUint32(eocd + 12, true);
const cdStart = view.getUint32(eocd + 16, true);
assert.equal(cdStart + cdSize, eocd);

// Walk the central directory and read each file back through its local header.
const dec = new TextDecoder();
let p = cdStart;
const read = {};
for (let i = 0; i < 2; i += 1) {
  assert.equal(view.getUint32(p, true), 0x02014B50);
  const crc = view.getUint32(p + 16, true);
  const size = view.getUint32(p + 20, true);
  const nameLen = view.getUint16(p + 28, true);
  const local = view.getUint32(p + 42, true);
  const name = dec.decode(zip.subarray(p + 46, p + 46 + nameLen));
  assert.equal(view.getUint32(local, true), 0x04034B50);
  assert.equal(view.getUint16(local + 8, true), 0, "stored, no compression");
  const localNameLen = view.getUint16(local + 26, true);
  const data = zip.subarray(local + 30 + localNameLen, local + 30 + localNameLen + size);
  assert.equal(crc32(data), crc);
  read[name] = dec.decode(data);
  p += 46 + nameLen;
}
assert.equal(read["diagnostics.json"], json);
assert.equal(read["app.log"], log);

// And a real unzip agrees, where one is installed.
let unzip = null;
try { execFileSync("unzip", ["-v"], { stdio: "ignore" }); unzip = "unzip"; } catch { /* not installed */ }
if (unzip) {
  const dir = mkdtempSync(join(tmpdir(), "kachat-zip-"));
  try {
    writeFileSync(join(dir, "a.zip"), zip);
    execFileSync(unzip, ["-tq", join(dir, "a.zip")], { stdio: "ignore" });
    execFileSync(unzip, ["-oq", join(dir, "a.zip"), "-d", join(dir, "out")], { stdio: "ignore" });
    assert.equal(readFileSync(join(dir, "out", "app.log"), "utf8"), log);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("zip-store: ok");
