// node tools/test-app-state-account.mjs - state hydration and account-switch guards in the first
// part of ui/app.js: a conversation's composer draft survives a reload, the outgoing-handshake
// scan keeps its cursor, a balance read that spans an account switch writes nothing, and an
// Address Activity run that spans one announces and saves nothing into the next account.
// app.js can't be loaded in node, so the functions are cut out of its source and run on stubs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { accountGuard } from "../ui/account-guard.js";

const app = readFileSync(new URL("../ui/app.js", import.meta.url), "utf8");
const between = (start, end) => {
  const from = app.indexOf(start);
  const to = app.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `markers found: ${start}`);
  return app.slice(from, to);
};
const build = (source, env, exportsList, prelude = "") => {
  const names = Object.keys(env);
  // eslint-disable-next-line no-new-func
  return new Function(...names, `${prelude}\n${source}\nreturn ${exportsList};`)(...names.map((n) => env[n]));
};

let pass = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// --- The composer draft ----------------------------------------------------------------------
const normalizeConversationSource = between("function normalizeConversation(", "function migrateLegacyContacts(");
const { normalizeConversation } = build(normalizeConversationSource, {
  normalizeMessage: (message) => message,
  nowId: () => "new-id",
}, "{ normalizeConversation }");

test("a conversation's draft survives the reload's normalization", () => {
  const stored = JSON.parse(JSON.stringify({ id: "c1", contactId: "p1", createdAt: 1, messages: [], draft: "half a thought\nsecond line" }));
  assert.equal(normalizeConversation(stored).draft, "half a thought\nsecond line");
});

test("no draft, or a blank one, stays absent", () => {
  assert.equal("draft" in normalizeConversation({ id: "c2", contactId: "p1", messages: [] }), false);
  assert.equal("draft" in normalizeConversation({ id: "c3", contactId: "p1", messages: [], draft: "   " }), false);
  assert.equal("draft" in normalizeConversation({ id: "c4", contactId: "p1", messages: [], draft: { text: "x" } }), false);
});

// --- The outgoing-handshake cursor -----------------------------------------------------------
const handshakeStateSource = between("const HANDSHAKE_PROCESSED_TXIDS_MAX", "/** The scan state for the active wallet");
function handshakeApi(data) {
  const storage = { getItem: (k) => (data.has(k) ? data.get(k) : null), setItem: (k, v) => data.set(k, String(v)), removeItem: (k) => data.delete(k) };
  return build(handshakeStateSource.replace("let handshakeSyncState =", "var handshakeSyncState ="), {
    localStorage: storage,
    accountScopedKey: (key, wallet) => `${key}:${wallet}`,
    HANDSHAKE_SYNC_KEY: "hs",
    appendEngineLog: () => {},
    engine: { address: "kaspa:me" },
  }, "{ loadHandshakeSyncState, persistHandshakeSyncState, set: (v) => { handshakeSyncState = v; } }");
}

test("the outgoing-handshake scan's cursor is read back after a save", () => {
  const data = new Map();
  const first = handshakeApi(data);
  first.set({ walletAddress: "kaspa:me", cursor: 10, outCursor: 1_700_000_000_000, parserVersion: 3, processedTxids: [], declinedTxids: [] });
  first.persistHandshakeSyncState();
  const loaded = handshakeApi(data).loadHandshakeSyncState("kaspa:me");
  assert.equal(loaded.outCursor, 1_700_000_000_000, "the next launch resumes the outgoing scan");
  assert.equal(loaded.cursor, 10);
});

test("an old record or another wallet's starts the outgoing scan at 0", () => {
  const data = new Map([["hs:kaspa:me", JSON.stringify({ walletAddress: "kaspa:me", cursor: 5, outCursor: 99, parserVersion: 2 })]]);
  assert.equal(handshakeApi(data).loadHandshakeSyncState("kaspa:me").outCursor, 0);
  assert.equal(handshakeApi(new Map()).loadHandshakeSyncState("kaspa:other").outCursor, 0);
});

// --- Balance reads across an account switch --------------------------------------------------
function balanceHarness({ switchDuring = null } = {}) {
  const log = [];
  const engine = {
    address: "kaspa:old",
    connect: async () => {},
    balance: async () => {
      if (switchDuring === "balance") engine.address = "kaspa:new";
      return { totalKas: "12.5", entries: [] };
    },
    startWalletSubscription: async () => { if (switchDuring === "subscription") engine.address = "kaspa:new"; },
  };
  const env = {
    engine,
    accountGuard,
    rememberLastBalance: () => log.push("remember"),
    updateWalletUi: () => log.push("ui"),
    updateServiceSummary: () => {},
    setStatus: () => {},
    setService: () => {},
    setArchitectureBadge: () => {},
    networkIndicator: null, networkStatus: null, networkBadge: null,
    refreshSubscriptionAddresses: () => log.push("subscriptions"),
    appendEngineLog: () => {},
    offerPendingKnsTransferResume: async () => { log.push("kns-offer"); },
  };
  const source = between("async function connectAndRefresh(", "/// A conversation just became real");
  const api = build(source, env, "{ connectAndRefresh, refreshBalanceOnly, balance: () => currentBalanceKas }",
    'let currentBalanceKas = "--"; let balanceRefreshInFlight = false;');
  return { api, log, engine };
}

test("a balance refresh that finishes after an account switch writes nothing", async () => {
  const { api, log } = balanceHarness({ switchDuring: "balance" });
  assert.equal(await api.refreshBalanceOnly(), false);
  assert.equal(api.balance(), "--", "the old account's figure is not shown under the new one");
  assert.deepEqual(log, [], "nor remembered as its last balance");
});

test("a balance refresh with no switch still lands", async () => {
  const { api, log } = balanceHarness();
  assert.equal(await api.refreshBalanceOnly(), true);
  assert.equal(api.balance(), "12.5");
  assert.ok(log.includes("remember") && log.includes("ui"));
});

test("connect-and-refresh drops a balance read for the account that was left", async () => {
  for (const when of ["balance", "subscription"]) {
    const { api, log } = balanceHarness({ switchDuring: when });
    await api.connectAndRefresh({ quiet: true });
    assert.equal(api.balance(), "--", `switch during ${when}`);
    assert.ok(!log.includes("remember") && !log.includes("kns-offer"), `switch during ${when}`);
  }
  const { api, log } = balanceHarness();
  await api.connectAndRefresh({ quiet: true });
  assert.equal(api.balance(), "12.5");
  assert.ok(log.includes("remember") && log.includes("kns-offer"));
});

// --- Address Activity across an account switch -----------------------------------------------
function activityHarness({ switchDuring = null } = {}) {
  const writes = [];
  const engine = { address: "kaspa:old" };
  const tx = { transaction_id: "tx1", outputs: [{ address: "kaspa:spend", amount: 500n }] };
  const env = {
    engine,
    KAS_UNIT: "KAS",
    ownInputAddressSet: () => new Set(["kaspa:old"]),
    loadAddrActivityHandled: () => [],
    saveAddrActivityHandled: (list) => writes.push(["handled", engine.address, [...list]]),
    makeOutputAddressLookup: () => async () => null,
    fetchRecentFullTransactionsFor: async () => { if (switchDuring === "fetch") engine.address = "kaspa:new"; return [tx]; },
    catchUpCandidates: (txs) => ({ nextFloor: 1000, candidates: txs }),
    loadActivityFloor: () => 0,
    saveActivityFloor: (address, ms) => writes.push(["floor", engine.address, address, ms]),
    pushShowsReceive: () => false,
    kaspaOutputAddress: (output) => output.address,
    kaspaOutputAmount: (output) => output.amount,
    spendsOwnFunds: async () => { if (switchDuring === "inputs") engine.address = "kaspa:new"; return false; },
    postDesktopNotification: (note) => writes.push(["notify", engine.address, note.title]),
    recordGlobalNotification: (item) => writes.push(["bell", engine.address, item.id]),
    appendEngineLog: () => {},
    formatSompiForNotification: (sompi) => String(sompi),
    describeActivityAddress: () => "Spending address",
    addressActivityRoute: () => ({}),
    addressActivityCenterTarget: () => ({}),
    openAddressActivityTarget: () => {},
    shortAddress: (address) => address,
  };
  const source = between("async function attributeAndNotifyAddressActivity(", "// Where a tapped address-activity notification goes");
  const { attributeAndNotifyAddressActivity } = build(source, env, "{ attributeAndNotifyAddressActivity }");
  const increases = [{ address: "kaspa:spend", delta: 500n, kind: "spending" }];
  return { run: () => attributeAndNotifyAddressActivity(increases, "kaspa:old"), writes };
}

test("a receive found after an account switch is neither announced nor saved", async () => {
  const fetchSwitch = activityHarness({ switchDuring: "fetch" });
  await fetchSwitch.run();
  assert.deepEqual(fetchSwitch.writes, [], "no floor, bell, banner or handled list under the new account");
  const inputSwitch = activityHarness({ switchDuring: "inputs" });
  await inputSwitch.run();
  assert.deepEqual(inputSwitch.writes.map((w) => w[0]), ["floor"], "only the old account's floor, saved before the switch");
  assert.equal(inputSwitch.writes[0][1], "kaspa:old");
});

test("with no switch the receive is announced, put in the bell and recorded", async () => {
  const { run, writes } = activityHarness();
  await run();
  assert.deepEqual(writes.map((w) => w[0]), ["floor", "notify", "bell", "handled"]);
  assert.ok(writes.every((w) => w[1] === "kaspa:old"));
  assert.deepEqual(writes.at(-1)[2], ["tx1"]);
});

test("the check hands its starting account to the attribution", () => {
  assert.match(between("async function runAddressActivityCheck(", "/** The address a transaction output went to"),
    /await attributeAndNotifyAddressActivity\(increases, walletAtStart\);/);
});

// --- Voice waveform decoding -----------------------------------------------------------------
function waveformHarness(decodeFails) {
  const contexts = [];
  class FakeAudioContext {
    constructor() { this.closed = false; contexts.push(this); }
    async decodeAudioData() {
      if (decodeFails) throw new Error("EncodingError");
      return { duration: 2, getChannelData: () => new Float32Array(400).fill(0.5) };
    }
    async close() { this.closed = true; }
  }
  const source = between("async function decodeWaveform(", "// `chatStyle` (1:1 and group threads");
  const { decodeWaveform } = build(source, {
    fetch: async () => ({ arrayBuffer: async () => new ArrayBuffer(8) }),
    window: { AudioContext: FakeAudioContext },
    voiceWaveformCache: new Map(),
    VOICE_WAVEFORM_BARS: 40,
  }, "{ decodeWaveform }");
  return { decodeWaveform, contexts };
}

test("a voice note that can't be decoded closes its audio context", async () => {
  const { decodeWaveform, contexts } = waveformHarness(true);
  assert.equal(await decodeWaveform("data:audio/ogg;base64,AAAA"), null);
  assert.equal(contexts.length, 1);
  assert.equal(contexts[0].closed, true, "no running context left behind per failed render");
});

test("a decodable voice note still gets its waveform, and its context closed", async () => {
  const { decodeWaveform, contexts } = waveformHarness(false);
  const decoded = await decodeWaveform("data:audio/mp4;base64,AAAA");
  assert.equal(decoded.samples.length, 40);
  assert.equal(decoded.duration, 2);
  assert.equal(contexts[0].closed, true);
});

// --- Restoring the stored account at launch --------------------------------------------------
function restoreHarness({ importFails = false, saveFails = false } = {}) {
  const log = [];
  const engine = {
    kaspa: {},
    address: null,
    importPrivateKey: (hex) => {
      if (importFails) throw new Error("bad key");
      engine.address = "kaspa:me";
      return { address: "kaspa:me", hex };
    },
  };
  const source = between("function restorePersistedTestingWallet(", "function normalizeContact(");
  const { restorePersistedTestingWallet, reason } = build(source, {
    engine,
    localStorage: { getItem: () => null },
    SESSION_LOGGED_OUT_KEY: "logged-out",
    isAppLocked: () => false,
    accountShellPrefs: { keepSignedIn: true },
    isSessionActive: () => true,
    getStoredTestingWalletHex: () => "ab".repeat(32),
    persistTestingWallet: () => { log.push("save"); if (saveFails) throw new Error("The current account's keys couldn't be backed up on this device"); },
    clearPersistedTestingWallet: () => log.push("CLEAR"),
    markSessionActive: () => log.push("active"),
    activateWalletDataScope: (address) => log.push(`scope:${address}`),
    appendEngineLog: () => {},
    userFacingError: (error) => error?.message || "",
  }, "{ restorePersistedTestingWallet, reason: () => restoreFailureReason }", 'let preScopedAddress = "";');
  return { restorePersistedTestingWallet, log, reason };
}

test("a re-save that fails at launch never deletes the stored keys", () => {
  const { restorePersistedTestingWallet, log } = restoreHarness({ saveFails: true });
  assert.equal(restorePersistedTestingWallet(), true, "the account still opens from the key it read");
  assert.ok(!log.includes("CLEAR"), "the stored record and the pre-v2 key stay");
  assert.deepEqual(log, ["save", "active", "scope:kaspa:me"]);
});

test("a stored key that does not open is still cleared, as before", () => {
  const { restorePersistedTestingWallet, log, reason } = restoreHarness({ importFails: true });
  assert.equal(restorePersistedTestingWallet(), false);
  assert.deepEqual(log, ["CLEAR"]);
  assert.equal(reason(), "bad key", "the reason waits for the sign-in screen (iOS d23e6f7a)");
});

// --- A sign-in's failure survives its reload (iOS d23e6f7a signInFailureMessage) ---------------
const signInSource = between("const SIGN_IN_ATTEMPT_KEY", "/** Whether any of `address`'s keys reached");
function signInHarness(session = new Map()) {
  return build(signInSource, {
    sessionStorage: { getItem: (k) => (session.has(k) ? session.get(k) : null), setItem: (k, v) => session.set(k, String(v)), removeItem: (k) => session.delete(k) },
    sameStoredAccountAddress: (a, b) => Boolean(a && b) && String(a).replace(/^kaspatest:/, "kaspa:") === String(b).replace(/^kaspatest:/, "kaspa:"),
  }, "{ takeSignInAttempt, signInFailureMessageFor, SIGN_IN_ATTEMPT_KEY }");
}

test("a sign-in that lands on its account says nothing; one that doesn't says why, once", () => {
  const session = new Map();
  const api = signInHarness(session);
  session.set(api.SIGN_IN_ATTEMPT_KEY, "kaspa:qpicked");
  const attempted = api.takeSignInAttempt();
  assert.equal(attempted, "kaspa:qpicked");
  assert.equal(api.takeSignInAttempt(), "", "read once: a later reload says nothing");
  assert.equal(api.signInFailureMessageFor(attempted, { restored: true, activeAddress: "kaspa:qpicked" }), "");
  assert.equal(api.signInFailureMessageFor(attempted, { restored: true, activeAddress: "kaspatest:qpicked" }), "", "the same account on the other network");
  assert.equal(api.signInFailureMessageFor(attempted, { restored: false, activeAddress: null, reason: "bad key" }), "bad key");
  assert.equal(api.signInFailureMessageFor(attempted, { restored: true, activeAddress: "kaspa:qother" }), "Unable to sign in to this account.", "another account opened");
  assert.equal(api.signInFailureMessageFor("", { restored: false }), "", "no sign-in asked: an ordinary launch");
});

test("activateSavedAccount files the attempt last, after every write", () => {
  const source = between("function activateSavedAccount(", "// The account a sign-in picked");
  assert.match(source, /UI_SPOT_TAB_KEY[\s\S]*sessionStorage\.setItem\(SIGN_IN_ATTEMPT_KEY/);
});

// --- A failed save puts the previous account back (iOS d23e6f7a / KaPay 1652437 restoreActiveSlot) --
function persistHarness({ upsertFails = false, verifyFails = false } = {}) {
  const data = new Map([["wallet", JSON.stringify({ address: "kaspa:qold" })], ["active", "kaspa:qold"]]);
  const storage = { getItem: (k) => (data.has(k) ? data.get(k) : null), setItem: (k, v) => data.set(k, String(v)), removeItem: (k) => data.delete(k) };
  const source = between("function persistTestingWallet(", "function clearPersistedTestingWallet(");
  const api = build(source, {
    engine: { privateKeyHex: "ab".repeat(32), address: "kaspa:qnew" },
    accountShellPrefs: {},
    appendEngineLog: () => {},
    activeAccountMetadata: () => ({ name: "New" }),
    loadSavedAccounts: () => [],
    isAppLocked: () => false,
    normalizePassphraseForm: (f) => f,
    passphraseFormForRecord: () => "nfkd",
    fileStoredWalletBeforeReplacing: () => {},
    localStorage: storage,
    PERSISTED_WALLET_KEY: "wallet",
    ACTIVE_ACCOUNT_KEY: "active",
    persistedWalletRecordForStorage: (payload) => payload,
    canonicalAccountAddress: (a) => a,
    clearLegacyWalletKey: () => {},
    upsertSavedAccount: () => { data.set("active", "kaspa:qnew"); if (upsertFails) throw new Error("KaChat is locked."); },
    getStoredTestingWalletHex: () => (verifyFails ? "cd".repeat(32) : "ab".repeat(32)),
  }, "{ persistTestingWallet }");
  return { ...api, data };
}

test("a save that fails part-way leaves the previous account in the slot", () => {
  for (const options of [{ upsertFails: true }, { verifyFails: true }]) {
    const { persistTestingWallet, data } = persistHarness(options);
    assert.throws(() => persistTestingWallet({ mnemonic: "words" }));
    assert.equal(JSON.parse(data.get("wallet")).address, "kaspa:qold", JSON.stringify(options));
    assert.equal(data.get("active"), "kaspa:qold");
  }
  const { persistTestingWallet, data } = persistHarness();
  assert.equal(persistTestingWallet({ mnemonic: "words" }), true);
  assert.equal(JSON.parse(data.get("wallet")).address, "kaspa:qnew", "a save that works keeps the new account");
});

// --- Same words again are the same account (iOS d23e6f7a isNewWallet / isSameAccount) ---------
test("importing the account already in the slot doesn't reset its chats", () => {
  const source = between("async function importAndEnterAccount(", "// STEP 1 → STEP 2");
  assert.match(source, /const previousSlotAddress = String\(engine\.address \|\| readActiveAccountAddress\(\) \|\| ""\)/);
  assert.ok(source.indexOf("previousSlotAddress =") < source.indexOf("importMnemonicWithFamily"), "read before the import moves engine.address");
  assert.match(source, /if \(resetState && !sameStoredAccountAddress\(previousSlotAddress, wallet\.address\)\) \{\n\s*state = \{ contacts: \[\], conversations: \[\] \};/);
});

for (const [name, fn] of tests) {
  try { await fn(); pass += 1; }
  catch (error) { console.error(`FAIL ${name}\n  ${error?.stack || error}`); process.exitCode = 1; }
}
console.log(`app state + account guards: ${pass}/${tests.length} passed`);
