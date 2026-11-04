// The hourly profile rescan's timing (KaChat-iPhone d1844582 ContactsManager.startProfileRescans):
// a fake clock and a fake sleep, nothing leaves the machine. Run from the repo root:
//
//   node tools/test-profile-rescan.mjs

import assert from "node:assert/strict";
import { createProfileRescans, PROFILE_RESCAN_INTERVAL_MS, PROFILE_RESCAN_FIRST_DELAY_MS, PROFILE_RESCAN_GAP_MS } from "../ui/profile-rescan.js";

assert.equal(PROFILE_RESCAN_INTERVAL_MS, 3_600_000);
assert.equal(PROFILE_RESCAN_FIRST_DELAY_MS, 30_000);
assert.equal(PROFILE_RESCAN_GAP_MS, 300);

function harness({ stamps = new Map(), key = "wallet-a", addresses = ["a", "b", "a", ""], onRescan = null, limit = 8000 } = {}) {
  const h = { at: 1_000_000_000, stamps, key, addresses, rescanned: [], sleeps: [], steps: 0 };
  h.loop = createProfileRescans({
    stampKey: () => h.key,
    readStamp: (k) => h.stamps.get(k) || 0,
    writeStamp: (k, at) => h.stamps.set(k, at),
    addresses: () => h.addresses,
    rescan: async (address) => {
      h.rescanned.push({ address, at: h.at });
      await onRescan?.(address, h);
    },
    now: () => h.at,
    sleep: async (ms) => {
      h.sleeps.push(ms);
      h.at += ms;
      h.steps += 1;
      if (h.steps > limit) h.loop.stop();
      await new Promise((resolve) => setImmediate(resolve));
    },
  });
  return h;
}
const settle = async (h, until) => {
  for (let i = 0; i < 20000 && !until(h); i += 1) await new Promise((resolve) => setImmediate(resolve));
};

// First run 30 s after start, stamped before anything is looked up; one at a time with the gap,
// each address once, an empty one skipped.
{
  const h = harness();
  const started = h.at;
  h.loop.start();
  await settle(h, (x) => x.rescanned.length >= 2);
  h.loop.stop();
  assert.equal(h.sleeps[0], PROFILE_RESCAN_FIRST_DELAY_MS);
  assert.deepEqual(h.rescanned.map((r) => r.address), ["a", "b"]);
  assert.equal(h.rescanned[0].at, started + PROFILE_RESCAN_FIRST_DELAY_MS);
  assert.equal(h.rescanned[1].at - h.rescanned[0].at, PROFILE_RESCAN_GAP_MS);
  assert.equal(h.stamps.get("wallet-a"), started + PROFILE_RESCAN_FIRST_DELAY_MS);
}

// A run less than an hour ago waits its turn; the next comes an hour after the stamp.
{
  const at = 1_000_000_000;
  const h = harness({ stamps: new Map([["wallet-a", at - 60_000]]), addresses: ["a"] });
  h.loop.start();
  await settle(h, (x) => x.rescanned.length >= 2);
  h.loop.stop();
  assert.equal(h.rescanned[0].at, at - 60_000 + PROFILE_RESCAN_INTERVAL_MS);
  assert.equal(h.rescanned[1].at, h.rescanned[0].at + PROFILE_RESCAN_INTERVAL_MS);
}

// Cut off mid-run: the rest waits, and starting again doesn't restart it at once (the stamp).
{
  const h = harness({ onRescan: (address, x) => { if (address === "a") x.loop.stop(); } });
  h.loop.start();
  await settle(h, (x) => x.rescanned.length >= 1);
  await settle(h, (x) => x.sleeps.length >= 2);
  const stamp = h.stamps.get("wallet-a");
  h.loop.start();
  await settle(h, (x) => x.rescanned.length >= 2);
  h.loop.stop();
  assert.equal(h.rescanned[0].address, "a");
  assert.ok(h.rescanned[1].at >= stamp + PROFILE_RESCAN_INTERVAL_MS, "the second run waits for its turn");
}

// A failed lookup doesn't stop the run, and each wallet has its own stamp.
{
  const h = harness({ onRescan: (address) => { if (address === "a") throw new Error("no answer"); } });
  h.loop.start();
  await settle(h, (x) => x.rescanned.length >= 2);
  h.key = "wallet-b";
  await settle(h, (x) => x.stamps.has("wallet-b"));
  h.loop.stop();
  assert.deepEqual(h.rescanned.slice(0, 2).map((r) => r.address), ["a", "b"]);
  assert.ok(h.stamps.has("wallet-a") && h.stamps.has("wallet-b"));
}

// No wallet: nothing runs, nothing is stamped.
{
  const h = harness({ key: "", limit: 20 });
  h.loop.start();
  await settle(h, (x) => x.steps >= 20);
  h.loop.stop();
  assert.equal(h.rescanned.length, 0);
  assert.equal(h.stamps.size, 0);
}

console.log("profile-rescan: ok");
