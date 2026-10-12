// The mainnet .kachat countdown runs on the network's clock, not the device's (XP-020).
import assert from "node:assert/strict";
import {
  MAINNET_PUBLIC_LAUNCH_MS, publicLaunchMs, isPubliclyOpen, noteChainTimeMs, networkNowMs, refreshChainTime,
} from "../engine/kachat-names/launch.js";

const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) };
const opens = MAINNET_PUBLIC_LAUNCH_MS;
assert.equal(publicLaunchMs("mainnet"), opens);
assert.equal(publicLaunchMs("testnet-10"), null);
// testnet has no countdown, whatever the time
assert.equal(isPubliclyOpen(null, "testnet-10"), true);
// mainnet: closed while the network's time is unknown, even with a device clock past the opening
assert.equal(networkNowMs(), null);
assert.equal(isPubliclyOpen(undefined, "mainnet"), false);
assert.equal(isPubliclyOpen(null, "mainnet"), false);
// a device clock set ahead does not open it: the network's time decides
noteChainTimeMs(opens - 86_400_000);
assert.ok(Math.abs(networkNowMs() - (opens - 86_400_000)) < 1_000);
assert.equal(isPubliclyOpen(undefined, "mainnet"), false);
// an explicit time (a device's) is judged but never remembered
assert.equal(isPubliclyOpen(opens + 5, "mainnet"), true);
assert.equal(store.size, 0, "a passed-in time is not remembered");
// once the network reaches the opening it is open, whatever the device says, and remembered
noteChainTimeMs(opens + 1_000);
assert.equal(isPubliclyOpen(undefined, "mainnet"), true);
assert.equal(store.get("kachat_names_public_opened.mainnet"), "1", "the opening is remembered");
// nonsense from a node is ignored
noteChainTimeMs(0); noteChainTimeMs("x");
assert.ok(networkNowMs() >= opens);

// refreshChainTime: a fresh reading is kept for a minute; a stale one is read again from the source
let reads = 0;
const read = async () => { reads += 1; return { pastMedianTime: BigInt(opens - 5_000) }; };
await refreshChainTime({ read });
assert.equal(reads, 0, "fresh: not read again");
await refreshChainTime({ read, maxAgeMs: 0 });
assert.equal(reads, 1, "stale: read from the node");
assert.ok(networkNowMs() < opens, "the node's time wins over the earlier note");
assert.equal(isPubliclyOpen(undefined, "mainnet"), true, "but once opened it stays open (its clock only moves forward)");
store.clear();
assert.equal(isPubliclyOpen(undefined, "mainnet"), false, "without the memory: the node's time decides");
// a failing node never throws, and is asked again at most every 5 s
const failing = async () => { reads += 1; throw new Error("no node"); };
await refreshChainTime({ read: failing, maxAgeMs: 0 });
assert.equal(reads, 1, "asked within 5 s of the last read: waits");
console.log("kachat launch countdown: ok");
