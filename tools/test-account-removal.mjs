// node tools/test-account-removal.mjs - the account and security items of KaChat iOS d23e6f7a,
// KaPay 1652437, KaPlay 4922804 and KaPost 33095ac that Desktop ports:
//   - every removal path erases the same data: its spending addresses' coin labels too (filed by
//     address, outside the account), and the app password its Nextcloud login holds is revoked;
//   - the funds search on import gives up after 12 s (Import on #0, Skip, Search Again);
//   - a chat archive imported from a file must be encrypted;
//   - log lines carry only an address's last 8 characters.
// app.js can't be loaded in node, so its functions are cut out of its source and run on stubs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { shortenLogAddresses } from "../ui/log-addresses.js";
import { IMPORT_ADDRESS_SEARCH_TIMEOUT_MS, raceImportSearch } from "../ui/account-import.js";
import { openEncryptedArchive, sealBackupEnvelope, BACKUP_NOT_ENCRYPTED_MESSAGE, BACKUP_DECRYPT_FAILED_MESSAGE } from "../ui/backup-crypto.js";
import { reencodeAddress } from "../engine/network.js";

const app = readFileSync(new URL("../ui/app.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
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

class MemoryStorage {
  constructor(entries = []) { this.map = new Map(entries); }
  getItem(key) { return this.map.has(key) ? this.map.get(key) : null; }
  setItem(key, value) { this.map.set(key, String(value)); }
  removeItem(key) { this.map.delete(key); }
  get length() { return this.map.size; }
  key(index) { return [...this.map.keys()][index] ?? null; }
}

const ME = "kaspa:qqmeaccount0000000000000000000000000000000000000000000000";
const OTHER = "kaspa:qqotheraccount000000000000000000000000000000000000000000";
const MY_SPEND_1 = "kaspa:qpmyspendone00000000000000000000000000000000000000000000";
const MY_SPEND_2 = "kaspa:qpmyspendtwo00000000000000000000000000000000000000000000";
const THEIR_SPEND = "kaspa:qptheirspend000000000000000000000000000000000000000000000";

// --- Logs (iOS d23e6f7a AppLog.shortenAddresses, KaPay 1652437) -----------------------------------

test("every address in a log line keeps only its last 8 characters", () => {
  assert.equal(shortenLogAddresses(`Deleted account ${ME}`), `Deleted account …${ME.slice(-8)}`);
  const testnet = "kaspatest:qqtestnetaddr000000000000000000000000000000000000abcdefgh";
  assert.equal(shortenLogAddresses(`from ${testnet} to ${OTHER}.`), `from …abcdefgh to …${OTHER.slice(-8)}.`);
  // the `_` form used in storage keys and file names, and upper case
  assert.equal(shortenLogAddresses("file kaspa_qqabcdefghijklmnop12345678.json"), "file …12345678.json");
  assert.equal(shortenLogAddresses("key prefix:kaspa:qqabcdefghijklmnop12345678:chats"), "key prefix:…12345678:chats");
  assert.equal(shortenLogAddresses("KASPA:QQABCDEFGHIJKLMNOPQRSTUV"), "…OPQRSTUV");
  // nothing that isn't a full address
  assert.equal(shortenLogAddresses("kaspa: node connected to wss://n.kaspa.org"), "kaspa: node connected to wss://n.kaspa.org");
  assert.equal(shortenLogAddresses("kaspa:qqshort"), "kaspa:qqshort");
});

test("appendEngineLog shortens whatever it is handed, objects included", () => {
  const source = between("function appendEngineLog(", "// A Kaspa address selected by hand");
  const lines = [];
  const engineLog = { get textContent() { return lines.join("\n"); }, set textContent(value) { lines.length = 0; lines.push(value); } };
  const { appendEngineLog } = build(source, {
    shortenLogAddresses, engineLog, nodeScanTraceActive: false, document: { querySelector: () => null },
  }, "{ appendEngineLog }");
  appendEngineLog(`Restored persistent testing wallet: ${ME}`);
  appendEngineLog({ wallet: OTHER });
  assert.ok(!engineLog.textContent.includes(ME) && !engineLog.textContent.includes(OTHER));
  assert.ok(engineLog.textContent.includes(`…${ME.slice(-8)}`));
});

// --- Encrypted archives only (iOS d23e6f7a BackupEnvelope.notEncrypted) --------------------------

test("a chat archive file must be KaChat's encrypted export", async () => {
  const key = "11".repeat(32);
  const archive = JSON.stringify({ version: 1, conversations: [] });
  await assert.rejects(openEncryptedArchive(archive, key, ME), { message: BACKUP_NOT_ENCRYPTED_MESSAGE });
  await assert.rejects(openEncryptedArchive("not json", key, ME), { message: BACKUP_NOT_ENCRYPTED_MESSAGE });
  const sealed = await sealBackupEnvelope(archive, key, ME);
  assert.equal(await openEncryptedArchive(sealed, key, ME), archive);
  await assert.rejects(openEncryptedArchive(sealed, "22".repeat(32), ME), { message: BACKUP_DECRYPT_FAILED_MESSAGE });
  // the restore screen goes through it, before anything is read
  const restore = between("async function runLocalHistoryRestore(", "document.querySelector(\"[data-history-restore-modal]\")");
  assert.match(restore, /openEncryptedArchive\(fileText,/);
  assert.ok(!/openSharedBackupJson\(fileText\)/.test(restore), "the pass-through reader no longer opens a file");
});

// --- The funds search on import gives up after 12 s ----------------------------------------------

test("the funds search lets go after 12 s, and a later answer doesn't count", async () => {
  assert.equal(IMPORT_ADDRESS_SEARCH_TIMEOUT_MS, 12_000);
  const timers = [];
  const fakeTimers = { setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimer: () => {} };
  let answer;
  const slow = new Promise((resolve) => { answer = resolve; });
  const raced = raceImportSearch(slow, IMPORT_ADDRESS_SEARCH_TIMEOUT_MS, fakeTimers);
  assert.equal(timers[0].ms, 12_000);
  timers[0].fn();
  assert.deepEqual(await raced, { timedOut: true });
  answer({ found: 1 });
  // an answer in time
  assert.deepEqual(await raceImportSearch(Promise.resolve(7), 50), { timedOut: false, value: 7 });
  // a failure in time is a failure, as before
  await assert.rejects(raceImportSearch(Promise.reject(new Error("node down")), 50), /node down/);
  // a failure after the time is up is nobody's problem
  const late = raceImportSearch(new Promise((_, reject) => setTimeout(() => reject(new Error("late")), 20)), 5);
  assert.deepEqual(await late, { timedOut: true });
  await new Promise((resolve) => setTimeout(resolve, 30));
});

test("the import screen: Import on #0 after the time, Search Again, and Skip while it searches", () => {
  const preview = between("function schedulePassphrasePreview(", "// The balance is only the chatting address's");
  assert.match(preview, /raceImportSearch\(/);
  assert.match(preview, /if \(outcome\.timedOut\) \{\n\s*importFoundAddresses = \[\];\n\s*importChattingIndex = 0;/);
  assert.match(preview, /setImportSearchIncomplete\(nodes, true\)/);
  assert.match(html, /data-passphrase-search-incomplete hidden>[\s\S]*didn't finish, so Import uses address #0\.[\s\S]*data-passphrase-search-again>Search Again</);
  assert.match(html, /data-import-passphrase-skip-search hidden>Skip the Search: Import on Address #0</);
  const enable = between("function updateImportPassphraseSubmitEnabled(", "importPassphraseInput?.addEventListener(\"input\"");
  assert.match(enable, /importSkipSearchBtn\.hidden = !finding/);
  assert.match(enable, /importChattingIndex = 0;\n\s*void commitImport\(pass\);/);
});

// --- Every removal path erases the same data (iOS d23e6f7a / KaPay 1652437 removeLocalData) -----

const SPENDING_BAL_CACHE_KEY = "kachat-spending-balcache-v1";
const UTXO_LABELS_KEY = "kachat-utxo-labels-v1";
const PREFIX = "kachat-account-data-v1";
const scopedKey = (base, address) => `${PREFIX}:${address}:${base}`;

function removalHarness(storage) {
  const removalSource = between("/** What removing `address` needs read", "function removeAccountScopedLocalData(");
  const scopedSource = between("function removeAccountScopedLocalData(", "/** Every removal path ends here");
  const noop = () => {};
  const env = {
    localStorage: storage,
    reencodeAddress,
    accountShellPrefs: {},
    takePreviousChattingAddresses: () => [],
    persistAccountShellPreferences: () => {},
    accountScopedKey: scopedKey,
    SPENDING_BAL_CACHE_KEY, UTXO_LABELS_KEY,
    ACCOUNT_DATA_PREFIX: PREFIX,
    storedNextcloudLoginsFor: (address) => (address === ME ? [{ server: "https://cloud.example.test", username: "me", appPassword: "pw" }] : []),
    loadSavedAccounts: () => storage.accounts || [],
    sameStoredAccountAddress: (a, b) => Boolean(a && b) && reencodeAddress(a, "kaspa") === reencodeAddress(b, "kaspa"),
    savedAccountSpendingAddresses: (record) => (record.address === ME ? [MY_SPEND_1] : []),
    removeAddressBookForWallet: noop, removeKachatNameReminders: noop,
    ownedNamesStorageKey: (a) => `owned:${a}`, marketAddressesStorageKey: (a) => `market:${a}`, ownProfileStorageKey: (a) => `profile:${a}`,
    STORAGE_KEY: "s", MESSAGE_HISTORY_KEY: "h", STATE_BACKUP_KEY: "b", chatStorageRemoveSync: noop,
    accountBackupStatus: { forget: noop },
    loadAccountMetaMap: () => ({}), saveAccountMetaMap: noop, ACCOUNT_SHELL_META_KEY: "meta",
    PERSISTED_WALLET_KEY: "wallet", HANDSHAKE_SYNC_KEY: "hs", readActiveAccountAddress: () => "", ACTIVE_ACCOUNT_KEY: "active",
    GROUP_MSG_KEY: "gm", GROUP_REACTIONS_KEY: "gr", GROUP_EDITS_KEY: "ge", GROUP_UNREAD_KEY: "gu", GROUP_HIDDEN_MEMBERS_KEY: "gh",
    GROUP_MUTED_MEMBERS_KEY: "gmu", SPENDING_STATE_KEY: "kachat-spending-state-v1", GROUP_PREFS_KEY: "gp",
  };
  return build(`${removalSource}\n${scopedSource}`, env,
    "{ accountRemovalContext, removeUtxoLabelsForAddresses, removeAccountScopedLocalData }",
    "let groupMsgSaveTimer = 0; let groupMsgAllCache = null; const window = { clearTimeout() {} };");
}

const labels = () => ({
  [ME]: { "a:0": "chatting" },
  [MY_SPEND_1]: { "b:0": "rent" },
  [MY_SPEND_2]: { "c:1": "savings" },
  [reencodeAddress(MY_SPEND_2, "kaspatest")]: { "d:0": "testnet copy" },
  [THEIR_SPEND]: { "e:0": "theirs" },
  [OTHER]: { "f:0": "theirs too" },
});

test("removing an account takes its spending addresses' coin labels, on both networks, and nobody else's", () => {
  const storage = new MemoryStorage([
    [UTXO_LABELS_KEY, JSON.stringify(labels())],
    // what Manage Addresses last showed for it: a spending address its seed can't be asked for now
    [scopedKey(SPENDING_BAL_CACHE_KEY, ME), JSON.stringify({ [MY_SPEND_2]: { kas: "1", used: true } })],
    [scopedKey(SPENDING_BAL_CACHE_KEY, OTHER), JSON.stringify({ [THEIR_SPEND]: { kas: "2", used: true } })],
  ]);
  storage.accounts = [{ address: ME, mnemonic: "my words" }, { address: OTHER, mnemonic: "their words" }];
  const api = removalHarness(storage);
  const context = api.accountRemovalContext(ME);
  assert.deepEqual(context.spendingAddresses, [MY_SPEND_1], "derived from its seed while it can be");
  assert.equal(context.keepCoinLabels, false);
  assert.equal(context.nextcloudLogins.length, 1);
  api.removeAccountScopedLocalData(ME, context);
  const left = JSON.parse(storage.getItem(UTXO_LABELS_KEY));
  assert.deepEqual(Object.keys(left).sort(), [OTHER, THEIR_SPEND].sort(), "the chatting, derived, cached and other-network labels go");
  assert.equal(storage.getItem(scopedKey(SPENDING_BAL_CACHE_KEY, ME)), null, "its own prefixed data goes in the same sweep");
  assert.ok(storage.getItem(scopedKey(SPENDING_BAL_CACHE_KEY, OTHER)));
});

test("an account sharing its words with another saved one leaves the shared spending labels alone", () => {
  const storage = new MemoryStorage([
    [UTXO_LABELS_KEY, JSON.stringify(labels())],
    [scopedKey(SPENDING_BAL_CACHE_KEY, ME), JSON.stringify({ [MY_SPEND_2]: { kas: "1" } })],
  ]);
  storage.accounts = [{ address: ME, mnemonic: "same words" }, { address: OTHER, mnemonic: "same words" }];
  const api = removalHarness(storage);
  const context = api.accountRemovalContext(ME);
  assert.equal(context.keepCoinLabels, true);
  api.removeAccountScopedLocalData(ME, context);
  assert.ok(JSON.parse(storage.getItem(UTXO_LABELS_KEY))[MY_SPEND_2], "still the other account's");
});

test("every removal path revokes the Nextcloud app password, with what it read before the lock", async () => {
  const source = between("/** Every removal path ends here", "let pendingSavedAccountRename");
  const calls = [];
  let saved = [{ address: ME }, { address: OTHER }];
  const env = {
    accountRemovalContext: (address) => { calls.push(`context:${address}`); return { nextcloudLogins: [{ server: "s", username: "u", appPassword: "fresh" }], spendingAddresses: [MY_SPEND_1], keepCoinLabels: false }; },
    loadSavedAccounts: () => saved,
    sameStoredAccountAddress: (a, b) => Boolean(a && b) && reencodeAddress(a, "kaspa") === reencodeAddress(b, "kaspa"),
    persistSavedAccounts: (list) => { saved = list; calls.push(`persist:${list.length}`); },
    localStorage: new MemoryStorage(),
    ACCOUNT_DELETED_SIGNAL_KEY: "signal",
    canonicalAccountAddress: (a) => reencodeAddress(a, "kaspa"),
    webPushForgetAccount: async () => {},
    removeAccountScopedLocalData: (address, options) => calls.push(`erase:${address}:${options.spendingAddresses.join(",")}`),
    takePreviousChattingAddresses: () => [],
    forgetAccountSecrets: () => calls.push("forget"),
    releaseAppPasswordIfUnused: () => false,
    refreshPasswordStatus: () => {},
    renderSavedAccountsScreen: () => {},
    revokeNextcloudLogins: async (logins) => { calls.push(`revoke:${logins.map((l) => l.appPassword).join(",")}`); },
  };
  const { removeSavedAccountFromDevice } = build(source, env, "{ removeSavedAccountFromDevice }");
  // The sign-in screen's Delete: read here.
  await removeSavedAccountFromDevice({ address: ME });
  assert.deepEqual(calls, ["context:" + ME, "persist:1", `erase:${ME}:${MY_SPEND_1}`, "forget", "revoke:fresh"]);
  assert.deepEqual(saved.map((a) => a.address), [OTHER]);
  // Settings' Delete Account: read before the vault locked, handed in.
  calls.length = 0;
  saved = [{ address: reencodeAddress(OTHER, "kaspatest") }];
  await removeSavedAccountFromDevice({ address: OTHER }, { nextcloudLogins: [{ appPassword: "early" }], spendingAddresses: [] });
  assert.deepEqual(calls, ["persist:0", `erase:${OTHER}:`, "forget", "revoke:early"], "the same account on the other network leaves the list");
  // No login: nothing to revoke.
  calls.length = 0;
  await removeSavedAccountFromDevice({ address: ME }, { nextcloudLogins: [], spendingAddresses: [] });
  assert.ok(!calls.some((c) => c.startsWith("revoke")));
});

test("Settings' Delete Account reads the login before the lock and lets the revoke finish before the reload", () => {
  const source = between("async function deleteCurrentAccount(", "document.querySelectorAll('[data-shell-action=\"delete-account\"]')");
  assert.ok(source.indexOf("accountRemovalContext(address)") < source.indexOf("lockKeyVault()"), "read while the account is open");
  assert.match(source, /removeSavedAccountFromDevice\(\{ address \}, removal\)/);
  assert.ok(source.indexOf("Promise.race([revoked") < source.indexOf("reloadKaChat()"));
});

for (const [name, fn] of tests) {
  try { await fn(); pass += 1; }
  catch (error) { console.error(`FAIL ${name}\n  ${error?.stack || error}`); process.exitCode = 1; }
}
console.log(`account removal, import search, archives, logs: ${pass}/${tests.length} passed`);
