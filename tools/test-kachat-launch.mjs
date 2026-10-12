// The mainnet .kachat countdown runs on the network's clock, not the device's (XP-020).
import assert from "node:assert/strict";
import {
  MAINNET_PUBLIC_LAUNCH_MS, publicLaunchMs, isPubliclyOpen, noteChainTimeMs, networkNowMs, refreshChainTime, countdownNowMs,
} from "../engine/kachat-names/launch.js";

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
// once the network reaches the opening it is open, whatever the device says
noteChainTimeMs(opens + 1_000);
assert.equal(isPubliclyOpen(undefined, "mainnet"), true);
// nonsense from a node is ignored
noteChainTimeMs(0); noteChainTimeMs("x");
assert.ok(networkNowMs() >= opens);

// the device's clock while it agrees with the network's (past median time trails by ~2 min)
noteChainTimeMs(opens - 120_000);
assert.equal(countdownNowMs(opens + 1), opens + 1, "a correct clock: opens on time");
assert.equal(isPubliclyOpen(countdownNowMs(opens + 1), "mainnet"), true);
const net = networkNowMs();
assert.ok(Math.abs(countdownNowMs(opens + 6 * 60_000) - net) < 1_000, "6 min ahead: the network's time");
assert.ok(Math.abs(countdownNowMs(opens + 5 * 86_400_000) - net) < 1_000, "days ahead: the network's time");
assert.equal(isPubliclyOpen(countdownNowMs(opens + 5 * 86_400_000), "mainnet"), false, "a date set ahead does not open it");
assert.ok(Math.abs(countdownNowMs(opens - 86_400_000) - net) < 1_000, "a day behind: the network's time");

// refreshChainTime: a fresh reading is kept for a minute; a stale one is read again from the source
let reads = 0;
const read = async () => { reads += 1; return { pastMedianTime: BigInt(opens - 5_000) }; };
await refreshChainTime({ read });
assert.equal(reads, 0, "fresh: not read again");
await refreshChainTime({ read, maxAgeMs: 0 });
assert.equal(reads, 1, "stale: read from the node");
assert.equal(isPubliclyOpen(undefined, "mainnet"), false, "the node's time wins over the earlier note");
// a failing node never throws, and is asked again at most every 5 s
const failing = async () => { reads += 1; throw new Error("no node"); };
await refreshChainTime({ read: failing, maxAgeMs: 0 });
assert.equal(reads, 1, "asked within 5 s of the last read: waits");
console.log("kachat launch countdown: ok");
