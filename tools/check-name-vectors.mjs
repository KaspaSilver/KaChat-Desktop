// Checks the extension's .k / .kaspa normalizers against the services' own SDK vectors.
//   node tools/check-name-vectors.mjs [~/dotk-sdk] [~/kns-sdk]
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dotkNormalize, dotkInvalidReason, kaspaNamesCanonical } from "../extension/src/names-normalize.js";

const dotkDir = process.argv[2] || `${homedir()}/dotk-sdk`;
const knsDir = process.argv[3] || `${homedir()}/kns-sdk`;
let failures = 0;
let checked = 0;
for (const net of ["mainnet", "testnet-10"]) {
  const vectors = JSON.parse(readFileSync(`${dotkDir}/src/generated/${net}/vectors.json`, "utf8")).normalize;
  for (const v of vectors) {
    checked += 1;
    const normalized = dotkNormalize(v.input);
    const reason = dotkInvalidReason(normalized);
    if (normalized !== v.normalized || reason !== v.reason) {
      failures += 1;
      console.log(`dotk ${net} FAIL ${JSON.stringify(v.input)}: got ${JSON.stringify([normalized, reason])}, want ${JSON.stringify([v.normalized, v.reason])}`);
    }
  }
}
for (const c of JSON.parse(readFileSync(`${knsDir}/vectors/normalization.json`, "utf8")).cases) {
  checked += 1;
  const got = kaspaNamesCanonical(c.input);
  if (got !== c.canonical) {
    failures += 1;
    console.log(`kaspa FAIL ${JSON.stringify(c.input)}: got ${JSON.stringify(got)}, want ${JSON.stringify(c.canonical)}`);
  }
}
console.log(`${checked} vectors, ${failures} failures`);
process.exit(failures ? 1 : 0);
