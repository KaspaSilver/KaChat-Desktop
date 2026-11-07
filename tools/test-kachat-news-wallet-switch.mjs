// .kachat news stays with its wallet (ui/kachat-names-notifier.js checkKachatNamesNews). A check
// awaits the registry's history for names that left the wallet and offers that closed; a wallet
// switch during those lookups used to record the previous wallet's "sold" / "offer declined" news
// in the new wallet's bell. Run from its own source with the registry stubbed:
//
//   node tools/test-kachat-news-wallet-switch.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "..", "ui", "kachat-names-notifier.js"), "utf8");
const fnStart = src.indexOf("export async function checkKachatNamesNews(");
assert.ok(fnStart >= 0, "checkKachatNamesNews in the source");
let depth = 0;
let end = -1;
for (let i = src.indexOf("{", fnStart); i < src.length; i += 1) {
  if (src[i] === "{") depth += 1;
  else if (src[i] === "}") { depth -= 1; if (depth === 0) { end = i + 1; break; } }
}
const code = src.slice(fnStart, end).replace(/^export /, "");

function run({ switchDuringHistory }) {
  const snapshots = new Map([["kaspatest:qa", JSON.stringify({ names: { sold: { expiresAt: "1" } }, offersOnMine: [], myOffers: {} })]]);
  const recorded = [];
  const actions = {
    myAddress: "kaspatest:qa",
    myKey: new Uint8Array([1]),
    ownNamesAndOffers: async () => ({ names: [], offers: [] }),
    isOwnKey: () => false,
    selfClosedOffers: new Set(),
  };
  const registry = {
    manifest: { params: {} },
    graceMs: 1n,
    offersFor: async () => [],
    history: async () => {
      if (switchDuringHistory) actions.myAddress = "kaspatest:qb";
      return [{ op: "sale", txId: "t1", price: null }];
    },
  };
  const make = new Function("env", `
    const kachatNames = () => env.rt;
    const deps = env.deps;
    let checking = false;
    let lastCheckAt = 0;
    const Status = { active: "active", grace: "grace" };
    const bytesEqual = () => false;
    const updateReminders = () => {};
    const dayString = String;
    const kas = String;
    const KAS_UNIT = "KAS";
    const readSnapshot = (w) => { const t = env.snapshots.get(w); if (!t) return null; const j = JSON.parse(t);
      return { names: j.names, offersOnMine: new Set(j.offersOnMine), myOffers: j.myOffers }; };
    const writeSnapshot = (w, s) => env.snapshots.set(w, JSON.stringify({ names: s.names, offersOnMine: [...s.offersOnMine], myOffers: s.myOffers }));
    ${code}
    return checkKachatNamesNews;
  `);
  const check = make({ rt: { registry, actions }, deps: { record: (e) => recorded.push(e), log: () => {} }, snapshots });
  return check().then(() => ({ recorded, snapshots }));
}

// No switch: the sale is told and the snapshot moves on.
{
  const { recorded, snapshots } = await run({ switchDuringHistory: false });
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].title, "sold.kachat sold");
  assert.deepEqual(JSON.parse(snapshots.get("kaspatest:qa")).names, {});
}

// Switched during the history lookup: nothing in the new wallet's bell, A's snapshot kept so A's
// next check still tells it.
{
  const { recorded, snapshots } = await run({ switchDuringHistory: true });
  assert.equal(recorded.length, 0, "the previous wallet's news is not recorded after a switch");
  assert.ok(JSON.parse(snapshots.get("kaspatest:qa")).names.sold, "A's snapshot is left as it was");
  assert.equal(snapshots.has("kaspatest:qb"), false);
}

console.log("kachat news wallet switch: all checks passed");
