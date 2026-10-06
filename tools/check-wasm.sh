#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [[ ! -f "$ROOT/kaspa/kaspa.js" || ! -f "$ROOT/kaspa/kaspa_bg.wasm" ]]; then
  echo "Missing kaspa/kaspa.js or kaspa/kaspa_bg.wasm."
  echo "These are normally committed to the repo, so this shouldn't happen."
  echo "  - If your clone is incomplete or shallow, re-clone the repo."
  echo "  - If you deleted them intentionally, rebuild from source with:"
  echo "      npm run setup:wasm"
  exit 1
fi

# DSK-005: the prebuilt signing SDK (kaspa/) and the Kasia cipher (cipher/) must match the checksums
# committed beside them (kaspa/SHA256SUMS, cipher/SHA256SUMS; provenance in kaspa/VERSION), so a
# swapped binary cannot slip into a build unnoticed. Hashing runs in node, which every build has
# (shasum/sha256sum are missing from some slim build images).
#
# After an INTENTIONAL rebuild: bash tools/check-wasm.sh --update   (and update kaspa/VERSION)
MODE="${1:-check}"
node --input-type=module - "$ROOT" "$MODE" <<'NODE'
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const [root, mode] = process.argv.slice(2);
const SETS = {
  kaspa: ["kaspa.js", "kaspa_bg.wasm"],
  cipher: ["cipher.js", "cipher_bg.wasm", "cipher.d.ts", "cipher_bg.wasm.d.ts", "package.json"],
};
const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
let failed = false;

for (const [dir, files] of Object.entries(SETS)) {
  const sumsPath = join(root, dir, "SHA256SUMS");
  if (mode === "--update") {
    const present = files.filter((name) => existsSync(join(root, dir, name)));
    writeFileSync(sumsPath, present.map((name) => `${sha256(join(root, dir, name))}  ${name}\n`).join(""));
    console.log(`Updated ${dir}/SHA256SUMS (${present.length} files).`);
    continue;
  }
  if (!existsSync(sumsPath)) {
    console.error(`Missing ${dir}/SHA256SUMS - the ${dir} WASM cannot be verified.`);
    console.error("If you rebuilt it on purpose, record the new checksums: bash tools/check-wasm.sh --update");
    failed = true;
    continue;
  }
  const lines = readFileSync(sumsPath, "utf8").split(/\r?\n/).filter((line) => line.trim());
  for (const line of lines) {
    const match = /^([0-9a-f]{64})\s+\*?(.+)$/i.exec(line.trim());
    if (!match) { console.error(`${dir}/SHA256SUMS: unreadable line: ${line}`); failed = true; continue; }
    const [, expected, name] = match;
    const path = join(root, dir, name);
    if (!existsSync(path)) { console.error(`${dir}/${name}: missing (listed in SHA256SUMS)`); failed = true; continue; }
    const actual = sha256(path);
    if (actual !== expected.toLowerCase()) {
      console.error(`${dir}/${name}: CHECKSUM MISMATCH\n  expected ${expected}\n  actual   ${actual}`);
      failed = true;
    }
  }
}

if (mode !== "--update" && failed) {
  console.error("WASM checksum verification failed. Do not ship this build until the binaries are explained.");
  console.error("If the change is an intentional rebuild: bash tools/check-wasm.sh --update, and update kaspa/VERSION.");
  process.exit(1);
}
NODE
