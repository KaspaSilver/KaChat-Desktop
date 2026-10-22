// node tools/test-account-guard.mjs - work that started for one account never writes into another
// (ui/account-guard.js, engine/messages.js self-stash owner check; iOS dfaba68 isActiveWallet /
// c130dc1 stillSameAccount). Nothing leaves the machine: the self-stash "send" is a fake engine that
// records whether it would have broadcast.
import assert from "node:assert/strict";
import { accountGuard, accountScopedValue } from "../ui/account-guard.js";
import { runSpendingDiscovery } from "../ui/spending-discovery.js";
import { createSelfStashEnvelope, sendSelfStashOnchain, selfStashAccountMismatch, SELF_STASH_ACCOUNT_CHANGED } from "../engine/messages.js";

let pass = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const A = "kaspa:qqaccountaexample000000000000000000000000000000000000000000";
const B = "kaspa:qqaccountbexample000000000000000000000000000000000000000000";
const PARTNER = "kaspa:qypartnerexample00000000000000000000000000000000000000000";

test("a guard holds while its account is active and fails after a switch", () => {
  let active = A;
  const guard = accountGuard(() => active);
  assert.equal(guard.account, A);
  assert.equal(guard.still(), true);
  active = B;
  assert.equal(guard.still(), false, "switched");
  active = A;
  assert.equal(guard.still(), true, "back on the same account: its own work may land");
  active = null;
  assert.equal(guard.still(), false, "signed out");
});

test("a guard taken with no account never holds", () => {
  let active = "";
  const guard = accountGuard(() => active);
  assert.equal(guard.still(), false);
  active = A;
  assert.equal(guard.still(), false, "work started signed out does not belong to whoever signs in");
  assert.equal(accountGuard(undefined).still(), false);
});

test("an account-scoped value reads as unknown after a switch and drops a late write", () => {
  let active = A;
  const total = accountScopedValue(() => active, null);
  assert.equal(total.get(), null);
  assert.equal(total.set(5n, A), true);
  assert.equal(total.get(), 5n);
  active = B;
  assert.equal(total.get(), null, "the previous account's number never shows for the new one");
  assert.equal(total.set(7n, A), false, "a read for A that finishes after the switch is dropped");
  assert.equal(total.get(), null);
  assert.equal(total.set(9n), true, "the new account's own read lands");
  assert.equal(total.get(), 9n);
  active = A;
  assert.equal(total.get(), null, "and A's old figure does not come back either");
  total.set(1n);
  total.clear();
  assert.equal(total.get(), null);
});

test("a self-stash note is stamped with, and sealed to, its owner", async () => {
  const sealedTo = [];
  const envelope = await createSelfStashEnvelope({
    ourAlias: "abc123", theirAlias: "def456", partnerAddress: PARTNER, ownerAddress: A,
    encryptToSelf: async (text) => { sealedTo.push(text); return { encryptedHex: "00ff" }; },
  });
  assert.equal(envelope.ownerAddress, A);
  assert.equal(sealedTo.length, 1);
  const unstamped = await createSelfStashEnvelope({ ourAlias: "x", partnerAddress: PARTNER, encryptToSelf: async () => ({ encryptedHex: "00" }) });
  assert.equal("ownerAddress" in unstamped, false, "no owner given, no stamp");
});

test("the owner check: mismatch only for a stamped note and another account", () => {
  assert.equal(selfStashAccountMismatch({ ownerAddress: A }, A), false);
  assert.equal(selfStashAccountMismatch({ ownerAddress: A }, B), true);
  assert.equal(selfStashAccountMismatch({ ownerAddress: A }, ""), true, "signed out: not the owner");
  assert.equal(selfStashAccountMismatch({}, B), false, "unstamped notes are not checked");
  assert.equal(selfStashAccountMismatch(null, B), false);
});

function fakeEngine(address, { switchTo = null } = {}) {
  const engine = {
    kaspa: {}, privateKey: {}, address, rpc: null, log: () => {},
    connected: 0,
    async connect() { this.connected += 1; if (switchTo) this.address = switchTo; },
    withRpc: async () => { throw new Error("fake engine: no node"); },
  };
  return engine;
}

test("a note made for A is never sent while B is active", async () => {
  const envelope = { protocolBytes: new Uint8Array([1, 2, 3]), ownerAddress: A };
  const engine = fakeEngine(B);
  await assert.rejects(() => sendSelfStashOnchain({ engine, envelope }), { message: SELF_STASH_ACCOUNT_CHANGED });
  assert.equal(engine.connected, 0, "refused before connecting");
});

test("a switch during the connect is caught before the keys are used", async () => {
  const envelope = { protocolBytes: new Uint8Array([1, 2, 3]), ownerAddress: A };
  const engine = fakeEngine(A, { switchTo: B });
  await assert.rejects(() => sendSelfStashOnchain({ engine, envelope }), { message: SELF_STASH_ACCOUNT_CHANGED });
  assert.equal(engine.connected, 1);
});

test("the owner's own note goes on to the send", async () => {
  const envelope = { protocolBytes: new Uint8Array([1, 2, 3]), ownerAddress: A };
  const engine = fakeEngine(A);
  // The fake has no node: getting past both owner checks means reaching the transaction build,
  // which fails here on purpose rather than broadcasting anything.
  await assert.rejects(() => sendSelfStashOnchain({ engine, envelope }), (error) => error?.message !== SELF_STASH_ACCOUNT_CHANGED);
  assert.equal(engine.connected, 1);
});

// The Discover sweep is tied to the account it started for (iOS 2343e84, IOS-107;
// ui/spending-discovery.js runSpendingDiscovery, as ui/app.js discoverSpendingAddressesFor runs it):
// derivation reads the CURRENT account's key, so a switch mid-sweep stops it and writes nothing.
const QBASE = 1_000_000;
function discoveryWorld({ switchAt = null, bulk = true } = {}) {
  let active = A;
  const derived = [];
  const writes = [];
  const hit = (label) => { if (label === switchAt) active = B; };
  const world = {
    get active() { return active; },
    derived,
    writes,
    run: () => {
      const guard = accountGuard(() => active);
      return runSpendingDiscovery({
        still: guard.still,
        derive: async (start, end) => {
          derived.push([active, start]);
          const map = new Map();
          for (let i = start; i < end; i += 1) map.set(i, `${active}-${i}`);
          return map;
        },
        // legacy: index 3 touched and funded; quantum: one touched slot in windows 0 and 1, so the
        // sweep goes on to window 2
        activity: async (addresses) => {
          const first = Number(addresses[0].split("-").pop());
          hit(first >= QBASE ? `q-activity-${(first - QBASE) / 200}` : "legacy-activity");
          if (!bulk) return null;
          const touched = new Map();
          for (const address of addresses) {
            const i = Number(address.split("-").pop());
            if (i === 3 || i === QBASE + 5 || i === QBASE + 210) touched.set(address, 0);
          }
          return touched;
        },
        fundedAmong: async (addresses) => {
          const first = Number(addresses[0].split("-").pop());
          hit(first >= QBASE ? `q-funded-${Math.floor((first - QBASE) / 200)}` : `legacy-funded-${Math.floor(first / 100)}`);
          return new Set(addresses.filter((address) => /-(3|1000005)$/.test(address)));
        },
        ownersAmong: async () => new Set(),
        readState: () => ({ maxIndex: 0, qMaxIndex: -1, hidden: [] }),
        writeState: (state) => { if (guard.still()) writes.push(state); },
        base: QBASE, floor: 200, limit: 10_000,
      });
    },
  };
  return world;
}

test("Discover: with no switch both chains are written", async () => {
  const world = discoveryWorld();
  const result = await world.run();
  assert.equal(result.stopped, false);
  assert.equal(result.matchCount, 2, "the legacy and the quantum match");
  assert.equal(world.writes.length, 2, "the legacy write, then the quantum one");
  assert.equal(world.writes[0].maxIndex, 3);
  assert.equal(world.writes[1].qMaxIndex, 210, "the quantum bound covers every slot with activity");
  assert.ok(world.derived.every(([account]) => account === A));
});

test("Discover: a switch during the legacy sweep writes nothing and stops", async () => {
  const world = discoveryWorld({ switchAt: "legacy-activity" });
  const result = await world.run();
  assert.deepEqual(result, { matchCount: 0, stopped: true });
  assert.equal(world.writes.length, 0, "no legacy bound, no hidden set, no quantum bound");
  assert.ok(world.derived.every(([account]) => account === A), "the new account's addresses are never derived");
  assert.ok(!world.derived.some(([, start]) => start >= QBASE), "the quantum chain is never swept");
});

test("Discover: a switch between quantum windows stops before the next window, no quantum write", async () => {
  const world = discoveryWorld({ switchAt: "q-funded-0" });
  const result = await world.run();
  assert.deepEqual(result, { matchCount: 0, stopped: true });
  assert.equal(world.writes.length, 1, "only the legacy write, made while A was still active");
  assert.equal(world.writes[0].maxIndex, 3);
  assert.deepEqual(world.derived.filter(([, start]) => start >= QBASE).map(([, start]) => start - QBASE), [0], "window 1 is never derived");
});

test("Discover: a switch in the last quantum window still writes no quantum state", async () => {
  const world = discoveryWorld({ switchAt: "q-activity-2" });
  const result = await world.run();
  assert.equal(result.stopped, true);
  assert.equal(world.writes.length, 1, "the quantum bound is not written for B");
});

test("Discover: the fallback sweep stops before its next batch", async () => {
  const world = discoveryWorld({ bulk: false, switchAt: "legacy-funded-0" });
  const result = await world.run();
  assert.deepEqual(result, { matchCount: 0, stopped: true });
  assert.equal(world.writes.length, 0);
  assert.deepEqual(world.derived.map(([, start]) => start), [0, 0], "the floor window, then batch 0 - batch 1 never derived");
});

test("Discover: a sweep started with no account does nothing", async () => {
  const derived = [];
  const result = await runSpendingDiscovery({
    still: accountGuard(() => "").still,
    derive: async (s) => { derived.push(s); return new Map(); },
    activity: async () => new Map(), fundedAmong: async () => new Set(), ownersAmong: async () => new Set(),
    readState: () => ({ maxIndex: 0, qMaxIndex: -1, hidden: [] }), writeState: () => { throw new Error("must not write"); },
    base: QBASE, floor: 200, limit: 10_000,
  });
  assert.deepEqual(result, { matchCount: 0, stopped: true });
  assert.equal(derived.length, 0);
});

for (const [name, fn] of tests) {
  try { await fn(); pass++; }
  catch (error) { console.error(`FAIL ${name}\n  ${error?.message || error}`); process.exitCode = 1; }
}
console.log(`account-guard: ${pass}/${tests.length} passed`);
