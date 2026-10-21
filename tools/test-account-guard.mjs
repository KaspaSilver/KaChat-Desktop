// node tools/test-account-guard.mjs - work that started for one account never writes into another
// (ui/account-guard.js, engine/messages.js self-stash owner check; iOS dfaba68 isActiveWallet /
// c130dc1 stillSameAccount). Nothing leaves the machine: the self-stash "send" is a fake engine that
// records whether it would have broadcast.
import assert from "node:assert/strict";
import { accountGuard, accountScopedValue } from "../ui/account-guard.js";
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

for (const [name, fn] of tests) {
  try { await fn(); pass++; }
  catch (error) { console.error(`FAIL ${name}\n  ${error?.message || error}`); process.exitCode = 1; }
}
console.log(`account-guard: ${pass}/${tests.length} passed`);
