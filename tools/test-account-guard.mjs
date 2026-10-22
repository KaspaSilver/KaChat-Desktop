// node tools/test-account-guard.mjs - work that started for one account never writes into another
// (ui/account-guard.js, engine/messages.js self-stash owner check; iOS dfaba68 isActiveWallet /
// c130dc1 stillSameAccount). Nothing leaves the machine: the self-stash "send" is a fake engine that
// records whether it would have broadcast.
import assert from "node:assert/strict";
import { accountGuard, accountScopedValue, accountStillSaved } from "../ui/account-guard.js";
import {
  runSpendingDiscovery, captureSpendingAccount, deriveSpendingAddressForAccount, deriveSpendingAddressesForAccount,
  probeFreshQuantumSlot, chooseReceiveAddress,
  postSendTarget, revealSpendingIndexFor, setPrimarySpendingIndexFor, markQuantumSpentFor,
} from "../ui/spending-discovery.js";
import { spendingStateFromRecord, spendingRecordFromState } from "../engine/quantum.js";
import { KaspaEngine } from "../engine/index.js";
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

// The Discover sweep belongs to the account it started for (iOS e571f45, IOS-107, owner's Go Fix
// choice; ui/spending-discovery.js runSpendingDiscovery, wired as ui/app.js
// discoverSpendingAddressesFor wires it): the account and its seed are captured at the start, every
// derivation uses THAT seed and every write goes to THAT account's state, even after a switch.
// Only a removal (or a vault lock) drops the results. Fake engine and seeds: nothing leaves the
// machine and no real key is derived.
const QBASE = 1_000_000;
const SEED_A = "alpha alpha alpha";
const SEED_B = "bravo bravo bravo";
function fakeSeedEngine() {
  const calls = [];
  const name = (mnemonic, passphrase, form, index) => `${mnemonic}~${passphrase}~${form}-${index}`;
  return {
    kaspa: {},
    calls,
    deriveSpendingWallet(mnemonic, index, passphrase = "", { passphraseForm = "nfkd" } = {}) {
      calls.push([mnemonic, index]);
      return { address: name(mnemonic, passphrase, passphraseForm, index) };
    },
    deriveSpendingAddressRange(mnemonic, start, count, passphrase = "", { passphraseForm = "nfkd" } = {}) {
      calls.push([mnemonic, start]);
      return Array.from({ length: count }, (_, k) => ({ index: start + k, address: name(mnemonic, passphrase, passphraseForm, start + k) }));
    },
  };
}
const savedPair = () => [
  { address: A, mnemonic: SEED_A, passphrase: "pa" },
  { address: B, mnemonic: SEED_B, passphrase: "" },
];
const freshStore = () => ({
  [A]: { maxIndex: 0, qMaxIndex: -1, hidden: [] },
  [B]: { maxIndex: 0, qMaxIndex: -1, hidden: [] },
});
function discoveryWorld({ switchAt = null, removeAt = null, lockAt = null, bulk = true } = {}) {
  let active = A;
  let saved = savedPair();
  const store = freshStore();
  const writes = [];
  const engine = fakeSeedEngine();
  const memo = new Map();
  const hit = (label) => {
    if (label === switchAt) active = B;
    if (label === removeAt) { saved = saved.filter((entry) => entry.address !== A); active = B; }
    if (label === lockAt) saved = saved.map((entry) => (entry.address === A ? { address: A, locked: true } : entry));
  };
  const world = {
    get active() { return active; },
    engine,
    memo,
    store,
    writes,
    run: () => {
      const wallet = active;
      const account = captureSpendingAccount(saved.find((entry) => entry.address === wallet), { passphraseForm: "nfkd" });
      const stillSaved = () => accountStillSaved(wallet, { activeAddress: active, savedAccounts: saved });
      return runSpendingDiscovery({
        stillSaved,
        derive: (start, end) => deriveSpendingAddressesForAccount(engine, account, start, end, { memo, pause: null }),
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
        readState: () => store[wallet],
        writeState: (state) => {
          if (!stillSaved()) return;
          store[wallet] = { ...store[wallet], ...state };
          writes.push([wallet, state]);
        },
        base: QBASE, floor: 200, limit: 10_000,
      });
    },
  };
  return world;
}
const seedsUsed = (world) => new Set(world.engine.calls.map(([mnemonic]) => mnemonic));
const untouchedB = (world) => assert.deepEqual(world.store[B], { maxIndex: 0, qMaxIndex: -1, hidden: [] }, "B's state is never written");

test("Discover: with no switch both chains are written", async () => {
  const world = discoveryWorld();
  const result = await world.run();
  assert.deepEqual(result, { matchCount: 2, removed: false }, "the legacy and the quantum match");
  assert.equal(world.writes.length, 2, "the legacy write, then the quantum one");
  assert.ok(world.writes.every(([owner]) => owner === A));
  assert.equal(world.store[A].maxIndex, 3);
  assert.equal(world.store[A].qMaxIndex, 210, "the quantum bound covers every slot with activity");
  assert.deepEqual([...seedsUsed(world)], [SEED_A]);
  untouchedB(world);
});

test("Discover: a switch during the legacy sweep still writes both chains to A, never to B", async () => {
  const world = discoveryWorld({ switchAt: "legacy-activity" });
  const result = await world.run();
  assert.equal(world.active, B, "B is active by the time the sweep writes");
  assert.deepEqual(result, { matchCount: 2, removed: false });
  assert.equal(world.writes.length, 2);
  assert.ok(world.writes.every(([owner]) => owner === A), "every write goes to the account the sweep started for");
  assert.equal(world.store[A].maxIndex, 3);
  assert.equal(world.store[A].qMaxIndex, 210);
  assert.ok(world.store[A].hidden.includes(1) && world.store[A].hidden.includes(QBASE), "A's hidden set takes the swept-in empty rows");
  untouchedB(world);
});

test("Discover: derivation keeps using A's captured seed after a switch", async () => {
  const world = discoveryWorld({ switchAt: "legacy-activity" });
  await world.run();
  assert.deepEqual([...seedsUsed(world)], [SEED_A], "B's seed is never used");
  assert.ok(world.engine.calls.some(([, start]) => start >= QBASE), "the quantum chain is swept after the switch");
  assert.ok([...world.memo.keys()].every((key) => key.startsWith(`${A}:`)), "the memo is keyed by the swept account");
  assert.ok([...world.memo.values()].every((address) => address.startsWith(`${SEED_A}~pa~nfkd-`)), "A's passphrase and form too");
});

test("Discover: a switch between quantum windows keeps going and writes the quantum bound to A", async () => {
  const world = discoveryWorld({ switchAt: "q-funded-0" });
  const result = await world.run();
  assert.deepEqual(result, { matchCount: 2, removed: false });
  assert.deepEqual(world.engine.calls.filter(([, start]) => start >= QBASE).map(([, start]) => start - QBASE), [0, 100, 200, 300, 400, 500], "windows 1 and 2 (100-slot derive chunks) still derived, from A");
  assert.equal(world.store[A].qMaxIndex, 210);
  untouchedB(world);
});

test("Discover: the fallback sweep keeps going after a switch and writes to A", async () => {
  const world = discoveryWorld({ bulk: false, switchAt: "legacy-funded-0" });
  const result = await world.run();
  assert.equal(result.removed, false);
  assert.ok(result.matchCount >= 1);
  assert.equal(world.store[A].maxIndex, 3);
  assert.ok(world.engine.calls.some(([, start]) => start === 100), "batch 1 is still derived");
  assert.deepEqual([...seedsUsed(world)], [SEED_A]);
  untouchedB(world);
});

test("Discover: removing the account mid-sweep writes nothing", async () => {
  const world = discoveryWorld({ removeAt: "legacy-activity" });
  const result = await world.run();
  assert.deepEqual(result, { matchCount: 0, removed: true });
  assert.equal(world.writes.length, 0, "no legacy bound, no hidden set, no quantum bound");
  assert.ok(!world.engine.calls.some(([, start]) => start >= QBASE), "the quantum chain is never swept");
  assert.deepEqual(world.store[A], { maxIndex: 0, qMaxIndex: -1, hidden: [] });
  untouchedB(world);
});

test("Discover: removing the account between quantum windows keeps the legacy write, no quantum write", async () => {
  const world = discoveryWorld({ removeAt: "q-funded-0" });
  const result = await world.run();
  assert.deepEqual(result, { matchCount: 1, removed: true }, "as on iOS, the legacy count stands");
  assert.equal(world.writes.length, 1);
  assert.equal(world.store[A].qMaxIndex, -1);
  assert.deepEqual(world.engine.calls.filter(([, start]) => start >= QBASE).map(([, start]) => start - QBASE), [0, 100], "only window 0 (two 100-slot chunks): window 1 is never derived");
  untouchedB(world);
});

test("Discover: the account's keys locked mid-sweep: nothing written", async () => {
  const world = discoveryWorld({ lockAt: "legacy-activity" });
  const result = await world.run();
  assert.deepEqual(result, { matchCount: 0, removed: true });
  assert.equal(world.writes.length, 0);
});

test("Discover: a sweep started with no account does nothing", async () => {
  const derived = [];
  const result = await runSpendingDiscovery({
    stillSaved: () => accountStillSaved("", { activeAddress: "", savedAccounts: savedPair() }),
    derive: async (s) => { derived.push(s); return new Map(); },
    activity: async () => new Map(), fundedAmong: async () => new Set(), ownersAmong: async () => new Set(),
    readState: () => ({ maxIndex: 0, qMaxIndex: -1, hidden: [] }), writeState: () => { throw new Error("must not write"); },
    base: QBASE, floor: 200, limit: 10_000,
  });
  assert.deepEqual(result, { matchCount: 0, removed: true });
  assert.equal(derived.length, 0);
});

test("still saved: active or saved, never once removed or locked", () => {
  const saved = savedPair();
  assert.equal(accountStillSaved(A, { activeAddress: B, savedAccounts: saved }), true, "a switch is not a removal");
  assert.equal(accountStillSaved(A, { activeAddress: A, savedAccounts: [] }), true, "the active account counts (iOS)");
  assert.equal(accountStillSaved(A, { activeAddress: B, savedAccounts: saved.filter((e) => e.address !== A) }), false, "removed");
  assert.equal(accountStillSaved(A, { activeAddress: A, savedAccounts: [{ address: A, locked: true }] }), false, "keys locked in the vault");
  assert.equal(accountStillSaved("", { activeAddress: "", savedAccounts: saved }), false);
});

test("the captured account keeps its secrets out of logs and JSON", () => {
  const account = captureSpendingAccount({ address: A, mnemonic: SEED_A, passphrase: "pa" }, { passphraseForm: "raw" });
  assert.equal(account.owner, A);
  assert.equal(account.mnemonic, SEED_A, "readable by the derive helpers");
  assert.equal(account.passphraseForm, "raw");
  assert.deepEqual(Object.keys(account), ["owner"], "only the owner is enumerable");
  assert.equal(JSON.stringify(account), JSON.stringify({ owner: A }));
  assert.ok(!JSON.stringify({ account }).includes("alpha"));
  assert.ok(Object.isFrozen(account));
  assert.equal(captureSpendingAccount({ address: A, locked: true }), null, "a locked record captures nothing");
  assert.equal(captureSpendingAccount({ address: A, mnemonic: "" }), null);
  assert.equal(captureSpendingAccount(null), null);
});

test("the derive helper fails quietly, logging the index but never the seed", () => {
  const logged = [];
  const engine = { kaspa: {}, deriveSpendingWallet: () => { throw new Error("bad index"); } };
  const account = captureSpendingAccount({ address: A, mnemonic: SEED_A, passphrase: "secretpass" });
  assert.equal(deriveSpendingAddressForAccount(engine, account, 7, { log: (line) => logged.push(line) }), null);
  assert.equal(logged.length, 1);
  assert.ok(logged[0].includes("#7") && !logged[0].includes("alpha") && !logged[0].includes("secretpass"));
});

// The fresh quantum slot probe (iOS 6891935 / fb2323e verifiedFreshQuantumSlot, IOS-109;
// ui/spending-discovery.js probeFreshQuantumSlot, wired as ui/app.js freshQuantumSlotFor): it takes
// the account and its seed at the start, derives the probed slots from that seed, and a used slot
// raises THAT account's chain end even after a switch; nothing is written once it was removed.
function probeWorld({ used = [0, 1], switchAtProbe = null, removeAtProbe = null } = {}) {
  let active = A;
  let saved = savedPair();
  const store = freshStore();
  const writes = [];
  const engine = fakeSeedEngine();
  const memo = new Map();
  let probes = 0;
  const usedSet = new Set(used.map((n) => QBASE + n));
  return {
    get active() { return active; },
    engine, store, writes,
    run: () => {
      const account = captureSpendingAccount(saved.find((entry) => entry.address === active));
      const owner = account.owner;
      return probeFreshQuantumSlot({
        account,
        deriveAt: (acc, index) => deriveSpendingAddressForAccount(engine, acc, index, { memo }),
        readQMaxIndex: () => store[owner].qMaxIndex,
        writeQMaxIndex: (qMaxIndex) => { store[owner] = { ...store[owner], qMaxIndex }; writes.push([owner, qMaxIndex]); },
        usedState: async (address) => {
          probes += 1;
          if (probes === switchAtProbe) active = B;
          if (probes === removeAtProbe) { saved = saved.filter((entry) => entry.address !== A); active = B; }
          return usedSet.has(Number(address.split("-").pop()));
        },
        stillSaved: () => accountStillSaved(owner, { activeAddress: active, savedAccounts: saved }),
      });
    },
  };
}

test("Fresh slot: with no switch the used slots are skipped and A's bound raised", async () => {
  const world = probeWorld();
  const slot = await world.run();
  assert.equal(slot.index, QBASE + 2);
  assert.equal(slot.address, `${SEED_A}~pa~nfkd-${QBASE + 2}`);
  assert.deepEqual(world.writes, [[A, 0], [A, 1]]);
});

test("Fresh slot: a switch mid-probe still raises the ORIGINAL owner's bound, never B's", async () => {
  const world = probeWorld({ switchAtProbe: 1 });
  const slot = await world.run();
  assert.equal(world.active, B);
  assert.equal(slot.index, QBASE + 2);
  assert.deepEqual(world.writes, [[A, 0], [A, 1]], "both raises land on A");
  assert.equal(world.store[A].qMaxIndex, 1);
  assert.equal(world.store[B].qMaxIndex, -1, "B's chain end is never touched");
});

test("Fresh slot: the returned address comes from the captured account's seed", async () => {
  const world = probeWorld({ switchAtProbe: 1 });
  const slot = await world.run();
  assert.ok(slot.address.startsWith(`${SEED_A}~`), "A's chain, not B's");
  assert.deepEqual([...new Set(world.engine.calls.map(([mnemonic]) => mnemonic))], [SEED_A]);
});

test("Fresh slot: removing the account mid-probe writes nothing and ends the probe", async () => {
  const world = probeWorld({ removeAtProbe: 1 });
  const slot = await world.run();
  assert.deepEqual(world.writes, [], "no chain end raised for a removed account");
  assert.equal(slot.index, QBASE + 1, "iOS: the slot past the used one");
  assert.equal(world.store[B].qMaxIndex, -1);
});

// The Receive QR (iOS fb2323e freshReceiveAddress, IOS-109; ui/spending-discovery.js
// chooseReceiveAddress): an answer that comes back after a switch is dropped, nothing written.
function receiveWorld({ switchDuring = null, remembered = QBASE + 4, rememberedUntouched = true } = {}) {
  let active = A;
  const remembers = [];
  const reveals = [];
  return {
    remembers, reveals,
    run: () => chooseReceiveAddress({
      owner: A,
      activeAddress: () => active,
      rememberedIndex: remembered,
      deriveAt: (index) => `${A}-${index}`,
      untouched: async () => { if (switchDuring === "untouched") active = B; return rememberedUntouched; },
      lowestUnusedIndex: async () => { if (switchDuring === "lowest") active = B; return QBASE + 7; },
      fallbackAddress: () => `${A}-primary`,
      remember: (index) => remembers.push(index),
      reveal: (index) => reveals.push(index),
    }),
  };
}

test("Receive QR: no switch, the remembered untouched slot is shown and revealed", async () => {
  const world = receiveWorld();
  assert.equal(await world.run(), `${A}-${QBASE + 4}`);
  assert.deepEqual(world.reveals, [QBASE + 4]);
});

test("Receive QR: no switch, a fresh slot is remembered and revealed", async () => {
  const world = receiveWorld({ rememberedUntouched: false });
  assert.equal(await world.run(), `${A}-${QBASE + 7}`);
  assert.deepEqual(world.remembers, [QBASE + 7]);
  assert.deepEqual(world.reveals, [QBASE + 7]);
});

test("Receive QR: a switch while the remembered slot is checked drops the answer", async () => {
  const world = receiveWorld({ switchDuring: "untouched" });
  assert.equal(await world.run(), null);
  assert.deepEqual(world.reveals, []);
  assert.deepEqual(world.remembers, []);
});

test("Receive QR: no derivable slot falls back without remembering anything", async () => {
  const reveals = [];
  const remembers = [];
  const address = await chooseReceiveAddress({
    owner: A, activeAddress: () => A, rememberedIndex: null, deriveAt: () => { throw new Error("must not derive"); },
    untouched: async () => true, lowestUnusedIndex: async () => null, fallbackAddress: () => "primary",
    remember: (i) => remembers.push(i), reveal: (i) => reveals.push(i),
  });
  assert.equal(address, "primary");
  assert.deepEqual([reveals, remembers], [[], []]);
});

test("Receive QR: a switch while the fresh slot is found drops the answer", async () => {
  const world = receiveWorld({ switchDuring: "lowest", rememberedUntouched: false });
  assert.equal(await world.run(), null);
  assert.deepEqual(world.reveals, [], "nothing revealed on either account");
  assert.deepEqual(world.remembers, [], "no pointer remembered");
});

// Writes after a send (iOS ca09dd0 revealSpendingAddress(at:owner:) / setActiveSpendingAddress(_:owner:)
// / markQuantumAddressSpent(_:owner:), IOS-109 last part; ui/spending-discovery.js): a send started on
// A that the node answers after a switch to B writes A's stored state, never B's, and nothing once A
// was removed. The store is the per-account spending records ui/app.js keeps, run through the same
// engine/quantum.js sanitizers as saveSpendingState.
function postSendWorld() {
  let active = A;
  let saved = savedPair();
  const records = { [A]: { maxIndex: 3, qMaxIndex: 1, activeIndex: 0 }, [B]: { maxIndex: 5, qMaxIndex: 2, activeIndex: 2 } };
  const writes = [];
  const notices = [];
  const io = {
    activeAddress: () => active,
    stillSaved: (owner) => accountStillSaved(owner, { activeAddress: active, savedAccounts: saved }),
    readState: (owner) => spendingStateFromRecord(records[owner] || {}),
    writeState: (patch, owner) => {
      writes.push(owner);
      records[owner] = spendingRecordFromState({ ...spendingStateFromRecord(records[owner] || {}), ...patch }, records[owner] || {});
    },
  };
  return {
    io, records, writes, notices,
    notify: (what) => () => notices.push(what),
    state: (owner) => spendingStateFromRecord(records[owner] || {}),
    switchTo: (next) => { active = next; },
    remove: (owner) => { saved = saved.filter((entry) => entry.address !== owner); if (active === owner) active = B; },
  };
}
const SPENT_A = "kaspa:qquantumaddressofaccounta0000000000000000000000000000000";

test("After a send: no switch, A's bound, primary and spent mark are written and shown", () => {
  const world = postSendWorld();
  const B_BEFORE = JSON.stringify(world.records[B]);
  assert.deepEqual(revealSpendingIndexFor(QBASE + 4, A, world.io, world.notify("reveal")), { owner: A, active: true });
  assert.deepEqual(setPrimarySpendingIndexFor(QBASE + 5, A, world.io, world.notify("primary")), { owner: A, active: true });
  assert.deepEqual(markQuantumSpentFor(SPENT_A.toUpperCase(), A, world.io, world.notify("spent")), { owner: A, active: true });
  const a = world.state(A);
  assert.equal(a.qMaxIndex, 5);
  assert.equal(a.activeIndex, QBASE + 5);
  assert.deepEqual(a.qSpent, [SPENT_A], "stored lowercased");
  assert.deepEqual(world.notices, ["reveal", "primary", "spent"], "the account on screen repaints");
  assert.equal(JSON.stringify(world.records[B]), B_BEFORE);
});

test("After a send: started on A, answered after a switch to B - A's bound, primary and qSpent, B untouched", () => {
  const world = postSendWorld();
  const B_BEFORE = JSON.stringify(world.records[B]);
  const owner = A; // captured when the send started
  world.switchTo(B); // the node answers after the switch
  assert.deepEqual(revealSpendingIndexFor(7, owner, world.io, world.notify("reveal")), { owner: A, active: false });
  assert.deepEqual(setPrimarySpendingIndexFor(QBASE + 6, owner, world.io, world.notify("primary")), { owner: A, active: false });
  assert.deepEqual(markQuantumSpentFor(SPENT_A, owner, world.io, world.notify("spent")), { owner: A, active: false });
  const a = world.state(A);
  assert.equal(a.maxIndex, 7, "A's legacy bound covers the revealed change slot");
  assert.equal(a.qMaxIndex, 6, "A's quantum bound covers its new primary");
  assert.equal(a.activeIndex, QBASE + 6, "A's primary moved");
  assert.deepEqual(a.qSpent, [SPENT_A], "the spent mark is A's");
  assert.deepEqual([...new Set(world.writes)], [A], "every write went to A");
  assert.equal(JSON.stringify(world.records[B]), B_BEFORE, "B's bounds, primary and spent marks are never touched");
  assert.deepEqual(world.state(B).qSpent, []);
});

test("After a send: the primary-changed notice is skipped for an account that isn't active", () => {
  const world = postSendWorld();
  world.switchTo(B);
  setPrimarySpendingIndexFor(QBASE + 2, A, world.io, world.notify("primary"));
  revealSpendingIndexFor(QBASE + 3, A, world.io, world.notify("reveal"));
  markQuantumSpentFor(SPENT_A, A, world.io, world.notify("spent"));
  assert.deepEqual(world.notices, [], "B's screen shows nothing of A's move");
  assert.equal(world.state(A).activeIndex, QBASE + 2, "but A's primary did move");
  world.switchTo(A);
  setPrimarySpendingIndexFor(QBASE + 3, A, world.io, world.notify("primary"));
  assert.deepEqual(world.notices, ["primary"], "back on A, its own move is shown");
});

test("After a send: a removed owner gets nothing written, and nobody else does either", () => {
  const world = postSendWorld();
  const before = JSON.stringify(world.records);
  world.remove(A); // A removed while its send was in flight; B is active now
  assert.equal(revealSpendingIndexFor(QBASE + 4, A, world.io, world.notify("reveal")), null);
  assert.equal(setPrimarySpendingIndexFor(QBASE + 4, A, world.io, world.notify("primary")), null);
  assert.equal(markQuantumSpentFor(SPENT_A, A, world.io, world.notify("spent")), null);
  assert.deepEqual(world.writes, []);
  assert.deepEqual(world.notices, []);
  assert.equal(JSON.stringify(world.records), before);
});

test("After a send: A's keys locked meanwhile counts as gone - nothing written", () => {
  const world = postSendWorld();
  world.switchTo(B);
  world.io.stillSaved = (owner) => accountStillSaved(owner, { activeAddress: B, savedAccounts: [{ address: A, locked: true }, { address: B }] });
  assert.equal(setPrimarySpendingIndexFor(QBASE + 4, A, world.io), null);
  assert.deepEqual(world.writes, []);
});

test("After a send: no owner means the active account; no account at all writes nothing", () => {
  const world = postSendWorld();
  world.switchTo(B);
  assert.deepEqual(postSendTarget("", world.io), { owner: B, active: true });
  assert.deepEqual(revealSpendingIndexFor(QBASE + 9, null, world.io), { owner: B, active: true });
  assert.equal(world.state(B).qMaxIndex, 9);
  world.switchTo("");
  assert.equal(postSendTarget(null, world.io), null);
  assert.equal(markQuantumSpentFor(SPENT_A, undefined, world.io), null);
  assert.equal(markQuantumSpentFor("", A, world.io), null, "no address, no mark");
  assert.equal(revealSpendingIndexFor(-1, A, world.io), null);
});

test("After a send: a mark already there is not written twice; bounds only grow", () => {
  const world = postSendWorld();
  markQuantumSpentFor(SPENT_A, A, world.io);
  const writes = world.writes.length;
  markQuantumSpentFor(SPENT_A, A, world.io);
  assert.equal(world.writes.length, writes);
  revealSpendingIndexFor(1, A, world.io); // below A's legacy bound of 3
  assert.equal(world.state(A).maxIndex, 3);
});

test("Engine: the quantum spent hook carries the account the send started on", () => {
  const engine = new KaspaEngine({ log: () => {} });
  const calls = [];
  engine.onQuantumAddressSpent = (...args) => calls.push(args);
  engine.address = B; // active by the time the node accepted
  engine.noteSpendingSpent({ quantum: true, address: SPENT_A, index: QBASE + 1 }, A);
  assert.deepEqual(calls, [[SPENT_A, QBASE + 1, A]], "the owner passed in, not the active account");
  engine.noteSpendingSpent({ quantum: true, address: SPENT_A, index: QBASE + 1 });
  assert.deepEqual(calls[1], [SPENT_A, QBASE + 1, B], "no owner: the active account");
  engine.noteSpendingSpent({ quantum: false, address: "legacy", index: 3 }, A);
  assert.equal(calls.length, 2, "a legacy spend reveals nothing");
  engine.onQuantumAddressSpent = () => { throw new Error("bookkeeping slip"); };
  assert.doesNotThrow(() => engine.noteSpendingSpent({ quantum: true, address: SPENT_A, index: QBASE + 1 }, A), "never fails the send");
});

test("Engine: a spending send takes its owner when it is called, before any await", () => {
  // A destructured default is read at the call, so a switch during the connect does not move the
  // mark (checked on the function text: the send itself needs a node).
  for (const call of ["sendFromSpending", "sendMaxFromSpending", "compoundSpending"]) {
    assert.match(String(KaspaEngine.prototype[call]), /owner = this\.address/, `${call} defaults its owner at the call`);
    assert.match(String(KaspaEngine.prototype[call]), /noteSpendingSpent\(spending, owner\)/, `${call} hands the owner to the mark`);
  }
});

for (const [name, fn] of tests) {
  try { await fn(); pass++; }
  catch (error) { console.error(`FAIL ${name}\n  ${error?.message || error}`); process.exitCode = 1; }
}
console.log(`account-guard: ${pass}/${tests.length} passed`);
