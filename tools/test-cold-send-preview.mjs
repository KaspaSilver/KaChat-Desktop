// Cold storage send: the live coin preview a fee change outran is not used (ui/coldstorage.js
// scheduleSendPreview). The build passes the preview's coin set straight through, so a preview
// picked at the old fee rate that landed after a speed change showed the old fee and could make
// the build fail "insufficient" at the new rate. Run from its own source with the page stubbed:
//
//   node tools/test-cold-send-preview.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "..", "ui", "coldstorage.js"), "utf8");
const fnStart = src.indexOf("function scheduleSendPreview(");
assert.ok(fnStart >= 0, "scheduleSendPreview in the source");
let depth = 0;
let end = -1;
for (let i = src.indexOf("{", fnStart); i < src.length; i += 1) {
  if (src[i] === "{") depth += 1;
  else if (src[i] === "}") { depth -= 1; if (depth === 0) { end = i + 1; break; } }
}
const code = src.slice(fnStart, end);

const timers = [];
const env = {
  send: null,
  rate: 100n,
  previews: [],
  renders: 0,
};
const make = new Function("env", `
  let sendPreviewTimer = null;
  const window = { setTimeout: (fn) => { env.timers.push(fn); return env.timers.length; } };
  const clearTimeout = () => {};
  const SEND_FORM_STEPS = new Set(["review"]);
  const deps = { engine: {} };
  const sendAmountSompi = () => env.send?.amount ?? null;
  const sendFeeRateOverride = () => env.rate;
  const renderSendFlow = () => { env.renders += 1; };
  const previewAutomaticSelection = ({ feeRateSompiPerGram }) => new Promise((resolve) => {
    env.previews.push({ rate: feeRateSompiPerGram, resolve });
  });
  let send;
  Object.defineProperty(env, "liveSend", { get: () => send, set: (v) => { send = v; } });
  ${code}
  return { scheduleSendPreview };
`);
env.timers = timers;
const { scheduleSendPreview } = make(env);

const flow = { amount: 500n, manualUtxoKeys: null, step: "review", preview: null };
env.send = flow;
env.liveSend = flow;

// Normal rate: a preview goes out.
scheduleSendPreview();
timers.shift()();
assert.equal(env.previews.length, 1);
assert.equal(env.previews[0].rate, 100n);

// The person picks Fast while it is out: a second preview at the new rate.
env.rate = 200n;
scheduleSendPreview();
timers.shift()();
assert.equal(env.previews[1].rate, 200n);

// The Fast preview lands first, then the stale Normal one.
env.previews[1].resolve({ utxoKeys: ["fast"], feeSompi: 2000n });
await new Promise((r) => setTimeout(r, 0));
assert.deepEqual(flow.preview?.utxoKeys, ["fast"]);
env.previews[0].resolve({ utxoKeys: ["normal"], feeSompi: 1000n });
await new Promise((r) => setTimeout(r, 0));
assert.deepEqual(flow.preview?.utxoKeys, ["fast"], "the preview picked at the old rate is not used");
assert.equal(flow.preview.feeSompi, 2000n, "the fee shown is the new rate's");

// A coin-control set chosen meanwhile wins over an automatic preview.
scheduleSendPreview();
timers.shift()();
flow.manualUtxoKeys = ["picked"];
env.previews[2].resolve({ utxoKeys: ["auto"], feeSompi: 2000n });
await new Promise((r) => setTimeout(r, 0));
assert.equal(flow.preview, null, "no automatic preview over a manual selection");

console.log("cold send preview: all checks passed");
