// KNS (Kaspa Name Service) write path — domain registration and profile field
// editing via real, on-chain commit/reveal inscription transactions. Mirrors
// iOS/Android's from-scratch Bitcoin-Ordinals-style envelope exactly, but
// built entirely on native rusty-kaspa WASM SDK primitives (ScriptBuilder,
// createPayToScriptHashScript, encodePayToScriptHashSignatureScript,
// createInputSignature, addressFromScriptPublicKey) instead of hand-rolled
// Blake2b hashing or canonical push-data encoding.
//
// Redeem script layout (byte-identical to iOS/Android):
//   <push 32-byte x-only pubkey> OP_CHECKSIG OP_FALSE OP_IF
//     <push "kns"> OP_0 <push payload JSON>
//   OP_ENDIF
// The commit output pays into Blake2b256(redeem script) as a P2SH-style
// ScriptPublicKey (Kaspa address version 8). The reveal transaction spends
// that output, providing <signature><redeem script> as its signature script.
//
// This module builds and signs transactions but never decides amounts on its
// own beyond what's passed in — economics (fee tiers, dust, priority fees)
// live in KNS_ECONOMICS below, matching the documented indexer behavior.

import { ADDRESS_PREFIX, NETWORK } from "./network.js";
import { NETWORK_ID, sompiToKaspaDisplay } from "./utils.js";
import {
  KNS_DEFAULT_URL,
  KNS_PROFILE_FIELD_KEYS,
  normalizeDomainLabel,
  KNSProfileLinkBuilder,
  checkDomainAvailability,
  fetchInscribeFeeTiers,
  resolveDomain,
  fetchProfileByAssetId,
  clearKnsCache,
} from "./kns.js";
import { sendKaspa } from "./transactions.js";
import { checkedUtxoAnswer } from "./amounts.js";

const KNS_TITLE_BYTES = new TextEncoder().encode("kns");
const MAX_PAYLOAD_BYTES = 520;

const OP_CHECKSIG = 0xac;
const OP_FALSE = 0x00;
const OP_IF = 0x63;
const OP_0 = 0x00;
const OP_ENDIF = 0x68;

export const KNS_REVENUE_ADDRESS_MAINNET = "kaspa:qyp4nvaq3pdq7609z09fvdgwtc9c7rg07fuw5zgeee7xpr085de59eseqfcmynn";

export const KNS_ECONOMICS = Object.freeze({
  revealPriorityFeeSompi: 2_000_000n, // 0.02 KAS, added on top of computed mass fee
  dustThresholdSompi: 10_000n,
  profileEditCommitSompi: 200_000_000n, // 2 KAS
  profileEditRevealSompi: 100_000_000n, // 1 KAS
  minRegistrationBalanceKas: 50, // fixed UX gate, deliberately generous
});

const FIELD_MAX_LENGTHS = Object.freeze({
  bio: 300,
  contactEmail: 254,
  x: 64,
  telegram: 64,
  github: 64,
  discord: 128,
  website: 2048,
  redirectUrl: 2048,
  avatarUrl: 2048,
  bannerUrl: 2048,
});

// Fixed order for sequential per-field writes (never concurrent).
export const PROFILE_FIELD_EDIT_ORDER = Object.freeze([
  "avatarUrl", "bannerUrl", "bio", "x", "website", "telegram", "discord", "contactEmail", "github", "redirectUrl",
]);

// --- payload construction ---------------------------------------------------
// Field order matters: it's part of the exact bytes inscribed and must match
// what the indexer expects to parse.

export function buildDomainCreatePayload(label) {
  return JSON.stringify({ op: "create", p: "domain", v: label });
}

export function buildAddProfilePayload(assetId, key, value) {
  return JSON.stringify({ op: "addProfile", id: assetId, key, value });
}

export function buildTransferPayload(assetId, toAddress) {
  return JSON.stringify({ op: "transfer", p: "domain", id: assetId, to: toAddress });
}

export function payloadByteLength(payloadJson) {
  return new TextEncoder().encode(payloadJson).length;
}

export function assertPayloadFits(payloadJson) {
  const len = payloadByteLength(payloadJson);
  if (len > MAX_PAYLOAD_BYTES) {
    throw new Error(`This value is too long to inscribe (${len} bytes, limit is ${MAX_PAYLOAD_BYTES}).`);
  }
  return len;
}

// --- field validation --------------------------------------------------------

// Validates one field's raw input, returning its trimmed stored value. An
// empty value is always allowed (clears the field). Throws with a
// user-presentable message on the first violation.
export function validateProfileFieldValue(key, rawValue) {
  const value = String(rawValue ?? "").trim();
  if (!value) return "";

  const maxLen = FIELD_MAX_LENGTHS[key];
  if (maxLen && value.length > maxLen) {
    throw new Error(`This field must be ${maxLen} characters or fewer.`);
  }
  if (key === "contactEmail") {
    const parts = value.split("@");
    if (parts.length !== 2 || !parts[0] || !parts[1] || !parts[1].includes(".")) {
      throw new Error("Invalid email address format");
    }
  }
  if (key === "discord" && !KNSProfileLinkBuilder.discordUrl(value)) {
    throw new Error("Discord must be a numeric user id or a valid /users/<id> URL");
  }
  return value;
}

// Validates every changed field before any spend happens. Returns a map of
// key -> validated value (only for keys present in `fields`).
export function validateProfileFields(fields) {
  const validated = {};
  for (const key of Object.keys(fields || {})) {
    if (!KNS_PROFILE_FIELD_KEYS.includes(key)) continue;
    validated[key] = validateProfileFieldValue(key, fields[key]);
  }
  return validated;
}

// --- registration economics --------------------------------------------------

export function registrationTierForLabel(label) {
  return Math.min(Math.max(String(label || "").length, 1), 5);
}

// feeTiers: {1: kas, 2: kas, ..., 5: kas} from fetchInscribeFeeTiers().
export function registrationAmounts(label, feeTiers, { isReservedDomain = false } = {}) {
  const tier = registrationTierForLabel(label);
  const feeForTier = feeTiers[tier] ?? feeTiers[5];
  if (feeForTier == null) throw new Error("Missing fee tier data for this domain length.");
  const revealKas = isReservedDomain ? 0 : feeForTier;
  const commitKas = revealKas <= 1 ? 2 : Math.round(revealKas * 1.05 * 100) / 100;
  return { tier, revealAmountKas: revealKas, commitAmountKas: commitKas };
}

// --- redeem script + commit address -----------------------------------------

// Derives the identity address's 32-byte x-only public key as a hex string
// (what the redeem script embeds — never a separate funding key, since all
// KNS activity is funded and settled from the single chatting/identity
// address in this app).
export function xOnlyPublicKeyHexFromPrivateKey(privateKey) {
  return privateKey.toPublicKey().toXOnlyPublicKey().toString();
}

// Builds the KNS redeem script for a given payload JSON string, keeping the
// live ScriptBuilder instance around (needed later to encode the reveal
// transaction's signature script — see buildRevealSignatureScript).
export function buildKnsRedeemScript(kaspa, xOnlyPubkeyHex, payloadJson) {
  const builder = new kaspa.ScriptBuilder();
  builder.addData(xOnlyPubkeyHex); // hex string -> decoded as the raw 32 pubkey bytes
  builder.addOp(OP_CHECKSIG);
  builder.addOp(OP_FALSE);
  builder.addOp(OP_IF);
  builder.addData(KNS_TITLE_BYTES);
  builder.addOp(OP_0);
  builder.addData(new TextEncoder().encode(payloadJson));
  builder.addOp(OP_ENDIF);

  const commitScriptPublicKey = builder.createPayToScriptHashScript();
  const commitAddress = kaspa.addressFromScriptPublicKey(commitScriptPublicKey, NETWORK_ID);
  if (!commitAddress) throw new Error("Failed to derive a commit address from the KNS redeem script.");
  return {
    builder,
    redeemScriptHex: builder.toString(),
    commitScriptPublicKey,
    commitAddress,
    commitAddressString: commitAddress.toString(),
  };
}

// Builds the final signature script for the reveal transaction's single
// input, given the already-computed input signature (hex) and the SAME
// ScriptBuilder instance used to build the commit output.
export function buildRevealSignatureScript(builder, signatureHex) {
  return builder.encodePayToScriptHashSignatureScript(signatureHex);
}

// --- commit transaction (funds the P2SH output) -----------------------------
// Reuses the same proven, tested UTXO-selection/fee/mass path as every other
// send in this app — the commit output is just a normal payment to the
// derived P2SH address, since Kaspa's Version::ScriptHash address encoding
// produces byte-identical scriptPublicKey bytes to
// ScriptBuilder.createPayToScriptHashScript().
//
// The commit carries no payload (the inscription lives in the redeem script, revealed later), so
// it goes through sendKaspa as a plain payment with `exactAmount: true`: the P2SH output must hold
// exactly the commit amount the reveal is built against. (It used to go through
// sendPayloadTransaction, which refuses a missing payload, so no KNS write could ever broadcast:
// audit DSK-017.)
//
// `signer` ({ privateKey, address }) funds and signs the commit; it defaults to the chatting
// identity. `changeAddress` redirects the change (default: back to the funding address).
// `commitScriptPublicKey` / `commitAmountSompi`, when given, are used to find which output of
// which broadcast transaction is the commit (the generator may first chain batch transactions
// when the wallet holds many coins; the commit is in the final one).
export async function sendKnsCommitTransaction({ engine, commitAddressString, commitAmountKas, signer = null, changeAddress = null, commitScriptPublicKey = null, commitAmountSompi = null, log = () => {} }) {
  const privateKey = signer?.privateKey || engine?.privateKey;
  const sourceAddress = signer?.address || engine?.address;
  if (!engine?.kaspa || !privateKey || !sourceAddress) throw new Error("Load a wallet before starting a KNS transaction.");
  await engine.connect();
  const sendResult = await sendKaspa({
    kaspa: engine.kaspa,
    rpc: engine.rpc,
    withRpc: engine.withRpc.bind(engine),
    privateKey,
    sourceAddress,
    destinationAddress: commitAddressString,
    amountKas: String(commitAmountKas),
    feeKas: "0",
    changeAddress,
    exactAmount: true,
    log,
  });
  const located = locateKnsCommitOutput(sendResult, commitScriptPublicKey, commitAmountSompi);
  if (!located.txid) throw new Error("Commit transaction did not return a transaction id.");
  return { txid: located.txid, outputIndex: located.index, sendResult };
}

/** The commit's { txid, index }: the output paying `commitScriptPublicKey` exactly
 *  `commitAmountSompi`, searched from the last broadcast transaction back. Falls back to the
 *  last transaction's output 0 (the generator puts the requested outputs before change). */
export function locateKnsCommitOutput(sendResult, commitScriptPublicKey, commitAmountSompi) {
  const txids = Array.isArray(sendResult?.txids) ? sendResult.txids : [];
  const pendings = Array.isArray(sendResult?.result?.transactions) ? sendResult.result.transactions : [];
  const wantScript = String(commitScriptPublicKey?.script ?? commitScriptPublicKey ?? "").toLowerCase();
  if (wantScript && commitAmountSompi != null) {
    const wantAmount = BigInt(commitAmountSompi);
    for (let i = Math.min(pendings.length, txids.length) - 1; i >= 0; i--) {
      try {
        const outputs = pendings[i]?.transaction?.outputs || [];
        for (let j = 0; j < outputs.length; j++) {
          const spk = outputs[j]?.scriptPublicKey;
          const script = String(typeof spk === "string" ? spk : spk?.script ?? "").toLowerCase();
          if (script === wantScript && BigInt(outputs[j].value) === wantAmount) return { txid: txids[i], index: j };
        }
      } catch {
        // An SDK object we cannot read: fall through to the default below.
      }
    }
  }
  return { txid: txids.length ? txids[txids.length - 1] : null, index: 0 };
}

// --- reveal transaction (manually constructed, spends the commit output) ---
//
// Sighash for a Kaspa input is a function of (previous outpoint, the SPENT
// output's scriptPublicKey + amount, sequence) plus tx-wide fields — it does
// NOT depend on the spending/redeem script's content, so createInputSignature
// works here exactly as it would for a standard P2PK input, as long as the
// Transaction's input carries a `utxo` entry describing the real commit
// output. The redeem script is only needed afterward, to build the actual
// signature script the VM will execute.
const NATIVE_SUBNETWORK_ID_HEX = "00".repeat(20);
const SIGHASH_ALL = 0;

// revealAmountSompi is the documented *target* amount (tiered registration fee,
// or the fixed 1 KAS profile-edit reveal) — it's only used as a stand-in for
// the first, pre-fee mass-estimation pass. The real output value is always
// commitAmountSompi minus the transaction's actual computed fee: a Kaspa
// input/output balance leaves no room for both an exact preset output value
// and a real, market-accurate fee, so the commit amount is deliberately
// funded ~5% above the target (see registrationAmounts) specifically to
// leave this fee-derived remainder landing close to the intended amount.
// `commitOutputIndex` is the commit output's index in the commit transaction (0 unless the
// commit was located elsewhere, see locateKnsCommitOutput).
export async function buildAndSubmitKnsReveal({
  engine,
  commitTxId,
  commitOutputIndex = 0,
  commitAmountSompi,
  commitScriptPublicKey,
  builder,
  revealTargetAddress,
  revealAmountSompi,
  signer = null,
  revealPriorityFeeSompi = KNS_ECONOMICS.revealPriorityFeeSompi,
  log = () => {},
}) {
  const kaspa = engine?.kaspa;
  // Optional signer ({ privateKey, address }) — the reveal input's signature
  // must come from the same key whose x-only pubkey the redeem script embeds,
  // which for spending-address KNS activity is NOT the chatting identity key.
  const privateKey = signer?.privateKey || engine?.privateKey;
  if (!kaspa || !privateKey) throw new Error("Load a wallet before revealing a KNS inscription.");

  const utxoEntry = {
    address: undefined,
    outpoint: { transactionId: commitTxId, index: commitOutputIndex },
    amount: commitAmountSompi,
    scriptPublicKey: commitScriptPublicKey,
    blockDaaScore: 0n,
    isCoinbase: false,
  };
  const revealTargetScriptPublicKey = kaspa.payToAddressScript(revealTargetAddress);

  // Placeholder-sized signature script for mass estimation — a Schnorr
  // signature is always exactly 64 bytes (+1 sighash-type byte), so a dummy
  // signature of that size yields the exact same script length as the real one.
  const dummySignature = "00".repeat(65);
  const placeholderSigScript = buildRevealSignatureScript(builder, dummySignature);

  const draftTx = new kaspa.Transaction({
    version: 0,
    inputs: [{
      previousOutpoint: { transactionId: commitTxId, index: commitOutputIndex },
      signatureScript: placeholderSigScript,
      sequence: 0n,
      sigOpCount: 1,
      utxo: utxoEntry,
    }],
    outputs: [{
      value: revealAmountSompi,
      scriptPublicKey: revealTargetScriptPublicKey,
    }],
    lockTime: 0n,
    subnetworkId: NATIVE_SUBNETWORK_ID_HEX,
    gas: 0n,
    payload: "",
  });

  log("Estimating KNS reveal transaction fee...");
  const massFee = kaspa.calculateTransactionFee(NETWORK_ID, draftTx, 1);
  if (massFee == null) throw new Error("Could not calculate the reveal transaction's network fee.");
  const totalFee = massFee + BigInt(revealPriorityFeeSompi ?? KNS_ECONOMICS.revealPriorityFeeSompi);
  const finalOutputValue = commitAmountSompi - totalFee;
  if (finalOutputValue < KNS_ECONOMICS.dustThresholdSompi) {
    throw new Error("Commit amount is too small to cover the reveal transaction's fee.");
  }

  draftTx.outputs = [{
    value: finalOutputValue,
    scriptPublicKey: revealTargetScriptPublicKey,
  }];

  log("Signing KNS reveal transaction...");
  const signatureHex = kaspa.createInputSignature(draftTx, 0, privateKey, SIGHASH_ALL);
  const finalSigScript = buildRevealSignatureScript(builder, signatureHex);
  draftTx.inputs = [{
    previousOutpoint: { transactionId: commitTxId, index: commitOutputIndex },
    signatureScript: finalSigScript,
    sequence: 0n,
    sigOpCount: 1,
    utxo: utxoEntry,
  }];
  draftTx.finalize();

  log("Broadcasting KNS reveal transaction...");
  const submit = (rpc) => rpc.submitTransaction({ transaction: draftTx, allowOrphan: false });
  // The reveal spends an output the node has only just seen in its mempool; a node that has not
  // seen the commit yet (a failover to another node) calls it an orphan / unknown outpoint. A few
  // short waits cover that before the caller has to offer "Retry reveal".
  let response = null;
  for (let attempt = 1; ; attempt++) {
    try {
      response = await engine.withRpc(submit, { retries: 1, label: "KNS reveal broadcast" });
      break;
    } catch (error) {
      const message = String(error?.message || error || "").toLowerCase();
      const commitNotSeen = message.includes("orphan") || (message.includes("outpoint") && !message.includes("already"));
      if (!commitNotSeen || attempt >= 3) throw error;
      log(`KNS reveal attempt ${attempt} did not find the commit yet (${error?.message || error}); retrying.`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
  const revealTxId = response?.transactionId || draftTx.id;
  return { txid: revealTxId, actualRevealAmountSompi: finalOutputValue, fee: totalFee };
}

// --- crash recovery ----------------------------------------------------------
// Persists just enough to retry a reveal if the browser/tab dies between the
// commit broadcast and the reveal broadcast, so a successfully-committed
// output is never silently stranded. Cleared as soon as the reveal succeeds.

const PENDING_COMMIT_KEY = "kachat-kns-pending-commit-v1";

function savePendingCommit(record) {
  try { localStorage.setItem(PENDING_COMMIT_KEY, JSON.stringify(record, (_, v) => typeof v === "bigint" ? v.toString() : v)); } catch {}
}

export function peekPendingKnsCommit() {
  try {
    const raw = localStorage.getItem(PENDING_COMMIT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function clearPendingKnsCommit() {
  try { localStorage.removeItem(PENDING_COMMIT_KEY); } catch {}
}

// --- pending domain transfers (audit EXT-005) -----------------------------------
// A transfer is a commit (2 KAS into a P2SH whose redeem script embeds the transfer payload)
// followed by a reveal that spends it. If the reveal is refused or the page dies in between, the
// commit sits in the P2SH and only this wallet's key plus the exact payload can spend it. So the
// transfer is written down BEFORE the commit is broadcast, the commit txid is added once it is,
// and the record is cleared only when the reveal has been accepted (or the commit provably never
// went out). Everything needed to rebuild the redeem script is in the record: the payload is
// deterministic from (assetId, recipient) and the key from `source`.
//
// Records live in one map per network ({ [assetId]: record }) behind a storage adapter, so the
// browser extension can plug in chrome.storage.local: setKnsPendingStorage({ getItem, setItem,
// removeItem }), each may return a value or a Promise. The default is window.localStorage.

const PENDING_TRANSFER_KEY_PREFIX = "kachat-kns-pending-transfer-v1";

const localStorageAdapter = Object.freeze({
  getItem(key) {
    try { return globalThis.localStorage ? globalThis.localStorage.getItem(key) : null; } catch { return null; }
  },
  setItem(key, value) {
    if (!globalThis.localStorage) throw new Error("No storage is available to save the transfer's recovery record.");
    globalThis.localStorage.setItem(key, value);
  },
  removeItem(key) {
    try { globalThis.localStorage?.removeItem(key); } catch { /* nothing to remove */ }
  },
});
let pendingStorage = localStorageAdapter;

/** Plugs in the storage pending-transfer records are kept in; null restores localStorage. */
export function setKnsPendingStorage(adapter) {
  if (adapter && (typeof adapter.getItem !== "function" || typeof adapter.setItem !== "function" || typeof adapter.removeItem !== "function")) {
    throw new Error("A KNS pending storage adapter needs getItem, setItem and removeItem.");
  }
  pendingStorage = adapter || localStorageAdapter;
}

/** The storage key holding the pending transfers of `network` ("mainnet" | "testnet"). */
export function pendingKnsTransferKey(network = NETWORK) {
  return `${PENDING_TRANSFER_KEY_PREFIX}:${network}`;
}

const bigintToString = (_, v) => (typeof v === "bigint" ? v.toString() : v);

async function readPendingTransfers() {
  let raw = null;
  try { raw = await pendingStorage.getItem(pendingKnsTransferKey()); } catch { raw = null; }
  if (!raw) return {};
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function writePendingTransfers(map) {
  const key = pendingKnsTransferKey();
  if (!Object.keys(map).length) { await pendingStorage.removeItem(key); return; }
  await pendingStorage.setItem(key, JSON.stringify(map, bigintToString));
}

async function savePendingTransfer(record) {
  const map = await readPendingTransfers();
  map[record.assetId] = { ...record, updatedAt: Date.now() };
  await writePendingTransfers(map);
  return map[record.assetId];
}

async function patchPendingTransfer(assetId, patch) {
  const map = await readPendingTransfers();
  if (!map[assetId]) return null;
  map[assetId] = { ...map[assetId], ...patch, updatedAt: Date.now() };
  await writePendingTransfers(map);
  return map[assetId];
}

/** Every pending transfer on this network; `sourceAddress` keeps those one address started. */
export async function listPendingKnsTransfers({ sourceAddress = null } = {}) {
  const records = Object.values(await readPendingTransfers()).filter((r) => r && r.kind === "transfer" && r.network === NETWORK);
  return sourceAddress ? records.filter((r) => r.source?.address === sourceAddress) : records;
}

/** The pending transfer of one domain (by asset id) on this network, or null. */
export async function getPendingKnsTransfer(assetId) {
  const record = (await readPendingTransfers())[String(assetId || "").trim()];
  return record && record.kind === "transfer" && record.network === NETWORK ? record : null;
}

/** Forgets a pending transfer. Only for a commit that is resolved or provably never sent. */
export async function clearPendingKnsTransfer(assetId) {
  const map = await readPendingTransfers();
  const key = String(assetId || "").trim();
  if (!(key in map)) return;
  delete map[key];
  await writePendingTransfers(map);
}

/** Failures the commit build raises before anything is broadcast: nothing moved, so the record
 *  written ahead of the commit can go. Anything else (a timeout, a dropped socket) may have
 *  reached the node, so the record stays and Finish transfer looks the commit up on chain. */
function isPreBroadcastFailure(error) {
  const m = String(error?.message || error || "").toLowerCase();
  return m.includes("insufficient") || m.includes("no utxos") || m.includes("amount must") ||
    m.includes("destination must") || m.includes("reserved by a scheduled") || m.includes("storage mass") ||
    m.includes("load a wallet");
}

/** A reveal refused because its input is already spent: only this key can spend the commit, so
 *  an earlier reveal of ours already went through (the page died before it was cleared). */
function isAlreadyRevealedError(error) {
  const m = String(error?.message || error || "").toLowerCase();
  return m.includes("already spent") || m.includes("already in the mempool") || m.includes("double spend") || m.includes("already accepted");
}

function revealPendingError(error, record) {
  const reason = error?.message || String(error);
  const wrapped = new Error(`The domain's commit was sent, but its reveal did not go through (${reason}). Your 2 KAS are safe: use Retry reveal to finish the transfer.`);
  wrapped.code = "knsTransferRevealPending";
  wrapped.assetId = record.assetId;
  wrapped.pendingTransfer = record;
  wrapped.cause = error;
  return wrapped;
}

// --- verification polling ---------------------------------------------------

async function pollUntil(checkFn, { timeoutMs, intervalMs = 2000 }) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await checkFn().catch(() => null);
    if (result) return result;
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

// --- domain registration orchestration ---------------------------------------

// Registers a new KNS domain end to end: availability check, fee lookup,
// commit, reveal, and ownership-verification polling. Throws on any step
// that can't proceed; commit/reveal broadcast results are still returned via
// onStatus even if the final verification poll times out (the registration
// may still land — the indexer can lag behind the chain).
export async function inscribeDomain({ engine, label, onStatus = () => {}, log = () => {} }) {
  if (!engine?.kaspa || !engine?.privateKey || !engine?.address) throw new Error("Load a wallet before registering a domain.");
  const normalizedLabel = normalizeDomainLabel(label);
  if (!normalizedLabel) throw new Error("Enter a valid domain name (letters, numbers, and hyphens only).");
  const fullDomain = `${normalizedLabel}.kas`;

  onStatus({ status: "checking-availability" });
  const availability = await checkDomainAvailability(engine.address, fullDomain, { baseUrl: KNS_DEFAULT_URL });
  if (!availability.available) throw new Error(`${fullDomain} is already taken.`);

  onStatus({ status: "fetching-fees" });
  const feeTiers = await fetchInscribeFeeTiers({ baseUrl: KNS_DEFAULT_URL });
  const { commitAmountKas, revealAmountKas } = registrationAmounts(normalizedLabel, feeTiers, { isReservedDomain: availability.isReservedDomain });

  const payloadJson = buildDomainCreatePayload(normalizedLabel);
  assertPayloadFits(payloadJson);

  const xOnlyPubkeyHex = xOnlyPublicKeyHexFromPrivateKey(engine.privateKey);
  const { builder, redeemScriptHex, commitScriptPublicKey, commitAddressString } = buildKnsRedeemScript(engine.kaspa, xOnlyPubkeyHex, payloadJson);

  const revealTargetAddress = availability.isReservedDomain ? engine.address : KNS_REVENUE_ADDRESS_MAINNET;
  const commitAmountSompi = engine.kaspa.kaspaToSompi(String(commitAmountKas));
  const revealAmountSompi = engine.kaspa.kaspaToSompi(String(revealAmountKas));

  onStatus({ status: "committing", commitAmountKas, redeemScriptHex });
  const commit = await sendKnsCommitTransaction({ engine, commitAddressString, commitAmountKas, commitScriptPublicKey, commitAmountSompi, log });
  savePendingCommit({
    kind: "domain",
    label: normalizedLabel,
    commitTxId: commit.txid,
    commitOutputIndex: commit.outputIndex,
    commitAmountSompi,
    commitScriptPublicKeyHex: commitScriptPublicKey.script,
    redeemScriptHex,
    revealTargetAddress,
    revealAmountSompi,
    createdAt: Date.now(),
  });
  onStatus({ status: "committed", commitTxid: commit.txid });

  onStatus({ status: "revealing" });
  const reveal = await buildAndSubmitKnsReveal({
    engine,
    commitTxId: commit.txid,
    commitOutputIndex: commit.outputIndex,
    commitAmountSompi,
    commitScriptPublicKey,
    builder,
    revealTargetAddress,
    revealAmountSompi,
    log,
  });
  clearPendingKnsCommit();
  onStatus({ status: "revealed", revealTxid: reveal.txid });

  onStatus({ status: "verifying" });
  clearKnsCache(engine.address);
  const verified = await pollUntil(
    async () => {
      const resolution = await resolveDomain(fullDomain, { baseUrl: KNS_DEFAULT_URL });
      return resolution && resolution.ownerAddress === engine.address ? resolution : null;
    },
    { timeoutMs: 90_000 },
  );
  onStatus({ status: verified ? "confirmed" : "pending-confirmation", domain: fullDomain });

  return {
    domain: fullDomain,
    commitTxid: commit.txid,
    revealTxid: reveal.txid,
    verified: Boolean(verified),
    assetId: verified?.inscriptionId || null,
  };
}

// --- domain transfer orchestration -------------------------------------------

// Transfers a KNS domain to another address end to end (iOS
// KNSDomainTransferService port): ownership pre-check, transfer-payload
// commit/reveal pair, recipient-ownership verification polling.
//
// `signer` ({ privateKey, address }) selects the OWNER of the domain — it
// funds the commit, its x-only pubkey goes into the redeem script, its key
// signs both transactions, and it receives the reveal remainder (transfers
// return funds to the owner; only the inscription moves ownership). Defaults
// to the engine's chatting identity; pass a derived spending wallet's keypair
// to transfer a domain held by a spending address (iOS's
// fromSpendingAddressIndex analog).
//
// Amounts match the KNS web app's transfer submission: tx.amount=0 maps to a
// fixed 2 KAS commit; the reveal output is commit minus the actual fee.
// `revealPriorityFeeSompi` is the fee picked on the Send Domain sheet (iOS WithdrawFeeTier: 0.02 KAS
// x Normal 1 / Fast 2 / Priority 5); left out, the 0.02 KAS default.
// `source` is an opaque, JSON-safe description of where the signer comes from (desktop:
// { kind: "identity" } or { kind: "spending", index }), kept in the pending-transfer record so
// "Finish transfer" can derive the same key again; the signer's address is added to it.
export async function transferDomain({ engine, domain, assetId, toAddress, signer = null, source = null, changeAddress = null, revealPriorityFeeSompi = KNS_ECONOMICS.revealPriorityFeeSompi, onStatus = () => {}, log = () => {} }) {
  const privateKey = signer?.privateKey || engine?.privateKey;
  const sourceAddress = signer?.address || engine?.address;
  if (!engine?.kaspa || !privateKey || !sourceAddress) throw new Error("Load a wallet before transferring a domain.");

  const cleanAssetId = String(assetId || "").trim();
  if (!cleanAssetId) throw new Error("Missing domain asset id.");
  const fullDomain = String(domain || "").trim().toLowerCase();
  if (!fullDomain) throw new Error("Missing domain name.");

  // One transfer per domain at a time: a commit already out must be revealed (or found never to
  // have gone out) before another 2 KAS are committed for the same domain.
  const unfinished = await getPendingKnsTransfer(cleanAssetId);
  if (unfinished) {
    const error = new Error(`A transfer of ${unfinished.domain || fullDomain} is not finished yet. Finish it before starting another.`);
    error.code = "knsTransferPending";
    error.assetId = cleanAssetId;
    error.pendingTransfer = unfinished;
    throw error;
  }

  // Recipient may be a .kas domain — resolve it to its owner address.
  let recipient = String(toAddress || "").trim();
  if (recipient.toLowerCase().endsWith(".kas")) {
    onStatus({ status: "resolving-recipient" });
    const resolution = await resolveDomain(recipient, { baseUrl: KNS_DEFAULT_URL });
    if (!resolution?.ownerAddress) throw new Error("Could not resolve the recipient KNS domain.");
    recipient = resolution.ownerAddress;
  }
  if (!recipient.startsWith(ADDRESS_PREFIX)) throw new Error("Recipient must be a kaspa: address or a .kas domain.");
  try {
    if (engine.kaspa.Address?.validate && engine.kaspa.Address.validate(recipient) !== true) {
      throw new Error("invalid");
    }
  } catch {
    throw new Error("Recipient address is invalid.");
  }
  if (recipient.toLowerCase() === sourceAddress.toLowerCase()) {
    throw new Error("Recipient must be different from the sending address.");
  }

  // Ownership pre-check (best-effort — a resolver miss doesn't block; the
  // chain-side inscription rules are authoritative).
  onStatus({ status: "verifying-ownership" });
  const owned = await resolveDomain(fullDomain, { baseUrl: KNS_DEFAULT_URL }).catch(() => null);
  if (owned && owned.ownerAddress !== sourceAddress) {
    throw new Error("This domain is not owned by the sending address.");
  }

  const payloadJson = buildTransferPayload(cleanAssetId, recipient);
  assertPayloadFits(payloadJson);

  const xOnlyPubkeyHex = xOnlyPublicKeyHexFromPrivateKey(privateKey);
  const { builder, commitScriptPublicKey, commitAddressString } = buildKnsRedeemScript(engine.kaspa, xOnlyPubkeyHex, payloadJson);

  const commitAmountKas = 2;
  const commitAmountSompi = BigInt(engine.kaspa.kaspaToSompi(String(commitAmountKas)));

  // Funded by the primary spending address: the commit's change and the reveal's output both
  // land on the fresh address the caller chose, so the primary can rotate there (iOS e53ea11).
  const changeTo = changeAddress || sourceAddress;

  // Written before the commit goes out (EXT-005); a storage failure stops the transfer here,
  // before any KAS moves.
  let record = await savePendingTransfer({
    kind: "transfer",
    version: 1,
    network: NETWORK,
    assetId: cleanAssetId,
    domain: fullDomain,
    recipient,
    source: { ...(source && typeof source === "object" ? source : {}), address: sourceAddress },
    commitAddress: commitAddressString,
    commitAmountSompi,
    commitTxId: null,
    commitOutputIndex: 0,
    revealTargetAddress: changeTo,
    revealPriorityFeeSompi: BigInt(revealPriorityFeeSompi ?? KNS_ECONOMICS.revealPriorityFeeSompi),
    status: "committing",
    lastError: null,
    createdAt: Date.now(),
  });

  onStatus({ status: "committing", commitAmountKas });
  let commit;
  try {
    commit = await sendKnsCommitTransaction({
      engine,
      commitAddressString,
      commitAmountKas,
      signer: { privateKey, address: sourceAddress },
      changeAddress: changeTo,
      commitScriptPublicKey,
      commitAmountSompi,
      log,
    });
  } catch (error) {
    if (isPreBroadcastFailure(error)) await clearPendingKnsTransfer(cleanAssetId).catch(() => {});
    else await patchPendingTransfer(cleanAssetId, { status: "commit-unknown", lastError: error?.message || String(error) }).catch(() => {});
    throw error;
  }
  record = (await patchPendingTransfer(cleanAssetId, { commitTxId: commit.txid, commitOutputIndex: commit.outputIndex, status: "committed" }).catch(() => null)) || record;
  onStatus({ status: "committed", commitTxid: commit.txid });

  onStatus({ status: "revealing" });
  let reveal;
  try {
    reveal = await buildAndSubmitKnsReveal({
      engine,
      commitTxId: commit.txid,
      commitOutputIndex: commit.outputIndex,
      commitAmountSompi,
      commitScriptPublicKey,
      builder,
      revealTargetAddress: changeTo,
      revealAmountSompi: commitAmountSompi, // pre-fee placeholder; real value = commit - fee
      signer: { privateKey, address: sourceAddress },
      revealPriorityFeeSompi,
      log,
    });
  } catch (error) {
    const failed = (await patchPendingTransfer(cleanAssetId, { status: "reveal-failed", lastError: error?.message || String(error) }).catch(() => null)) || record;
    throw revealPendingError(error, failed);
  }
  await clearPendingKnsTransfer(cleanAssetId).catch(() => {});
  onStatus({ status: "revealed", revealTxid: reveal.txid });

  const verified = await verifyKnsTransfer({ fullDomain, sourceAddress, recipient, onStatus });
  return {
    domain: fullDomain,
    recipientAddress: recipient,
    commitTxid: commit.txid,
    revealTxid: reveal.txid,
    verified: Boolean(verified),
  };
}

async function verifyKnsTransfer({ fullDomain, sourceAddress, recipient, onStatus }) {
  onStatus({ status: "verifying" });
  clearKnsCache(sourceAddress);
  clearKnsCache(recipient);
  const verified = await pollUntil(
    async () => {
      const resolution = await resolveDomain(fullDomain, { baseUrl: KNS_DEFAULT_URL });
      return resolution && resolution.ownerAddress === recipient ? resolution : null;
    },
    { timeoutMs: 90_000 },
  );
  onStatus({ status: verified ? "confirmed" : "pending-confirmation", domain: fullDomain });
  return verified;
}

// Finishes a transfer left between commit and reveal ("Finish transfer" / "Retry reveal"):
// rebuilds the redeem script from the signer's key and the recorded payload, finds the commit
// output (on chain at the P2SH address, else the recorded commit txid, which may still be in the
// mempool) and reveals it. `signer` must be the key that started the transfer (the record's
// `source` says which). Returns { status: "revealed" | "already-transferred" | "no-commit", ... }:
// - "already-transferred": the domain already belongs to the recipient; the record is cleared.
// - "no-commit": no commit was ever recorded or found. The record is kept, since a just-sent
//   commit can take a moment to show; the caller may offer clearPendingKnsTransfer to discard it.
export async function resumeKnsTransfer({ engine, assetId, signer = null, onStatus = () => {}, log = () => {} }) {
  const privateKey = signer?.privateKey || engine?.privateKey;
  const sourceAddress = signer?.address || engine?.address;
  if (!engine?.kaspa || !privateKey || !sourceAddress) throw new Error("Load a wallet before finishing a domain transfer.");
  const record = await getPendingKnsTransfer(assetId);
  if (!record) throw new Error("There is no unfinished transfer for this domain.");
  if (record.source?.address && record.source.address !== sourceAddress) {
    throw new Error("This transfer was started from another address. Open the account that sent it to finish it.");
  }
  const fullDomain = record.domain;
  const recipient = record.recipient;

  const payloadJson = buildTransferPayload(record.assetId, recipient);
  const xOnlyPubkeyHex = xOnlyPublicKeyHexFromPrivateKey(privateKey);
  const { builder, commitScriptPublicKey, commitAddressString } = buildKnsRedeemScript(engine.kaspa, xOnlyPubkeyHex, payloadJson);
  if (record.commitAddress && record.commitAddress !== commitAddressString) {
    throw new Error("This key does not match the unfinished transfer's commit address.");
  }

  await engine.connect();
  onStatus({ status: "locating-commit" });
  const lookup = async (rpc) => checkedUtxoAnswer(await rpc.getUtxosByAddresses([commitAddressString]));
  const found = await engine.withRpc(lookup, { retries: 1, label: "KNS commit lookup" }).catch(() => null);
  const entries = Array.isArray(found?.entries) ? found.entries : [];
  const wantAmount = record.commitAmountSompi != null ? BigInt(record.commitAmountSompi) : null;
  const entry = entries.find((e) => e?.outpoint?.transactionId === record.commitTxId)
    || entries.find((e) => wantAmount != null && BigInt(e?.amount ?? 0) === wantAmount)
    || entries[0]
    || null;

  let commitTxId;
  let commitOutputIndex;
  let commitAmountSompi;
  if (entry) {
    commitTxId = entry.outpoint.transactionId;
    commitOutputIndex = Number(entry.outpoint.index) || 0;
    commitAmountSompi = BigInt(entry.amount);
  } else {
    // Nothing unspent at the commit address. Either the reveal already went through (the
    // domain moved), the commit is still only in the mempool (use the recorded txid), or it
    // never went out.
    const owner = await resolveDomain(fullDomain, { baseUrl: KNS_DEFAULT_URL }).catch(() => null);
    if (owner?.ownerAddress === recipient) {
      await clearPendingKnsTransfer(record.assetId).catch(() => {});
      onStatus({ status: "confirmed", domain: fullDomain });
      return { status: "already-transferred", domain: fullDomain, recipientAddress: recipient, verified: true };
    }
    if (!record.commitTxId) {
      onStatus({ status: "no-commit" });
      return { status: "no-commit", domain: fullDomain, recipientAddress: recipient, record };
    }
    commitTxId = record.commitTxId;
    commitOutputIndex = Number(record.commitOutputIndex) || 0;
    commitAmountSompi = BigInt(record.commitAmountSompi);
  }
  if (commitTxId !== record.commitTxId || commitOutputIndex !== Number(record.commitOutputIndex || 0)) {
    await patchPendingTransfer(record.assetId, { commitTxId, commitOutputIndex, status: "committed" }).catch(() => {});
  }

  onStatus({ status: "revealing" });
  let reveal;
  try {
    reveal = await buildAndSubmitKnsReveal({
      engine,
      commitTxId,
      commitOutputIndex,
      commitAmountSompi,
      commitScriptPublicKey,
      builder,
      revealTargetAddress: record.revealTargetAddress || sourceAddress,
      revealAmountSompi: commitAmountSompi,
      signer: { privateKey, address: sourceAddress },
      revealPriorityFeeSompi: record.revealPriorityFeeSompi != null ? BigInt(record.revealPriorityFeeSompi) : KNS_ECONOMICS.revealPriorityFeeSompi,
      log,
    });
  } catch (error) {
    if (isAlreadyRevealedError(error)) {
      // Our own earlier reveal is in (only this key can spend the commit).
      await clearPendingKnsTransfer(record.assetId).catch(() => {});
      onStatus({ status: "revealed", revealTxid: null });
      const verified = await verifyKnsTransfer({ fullDomain, sourceAddress, recipient, onStatus });
      return { status: "revealed", domain: fullDomain, recipientAddress: recipient, commitTxid: commitTxId, revealTxid: null, verified: Boolean(verified) };
    }
    const failed = (await patchPendingTransfer(record.assetId, { status: "reveal-failed", lastError: error?.message || String(error) }).catch(() => null)) || record;
    throw revealPendingError(error, failed);
  }
  await clearPendingKnsTransfer(record.assetId).catch(() => {});
  onStatus({ status: "revealed", revealTxid: reveal.txid });
  const verified = await verifyKnsTransfer({ fullDomain, sourceAddress, recipient, onStatus });
  return { status: "revealed", domain: fullDomain, recipientAddress: recipient, commitTxid: commitTxId, revealTxid: reveal.txid, verified: Boolean(verified) };
}

// --- profile field editing orchestration -------------------------------------

// Submits a single profile field edit end to end (commit + reveal). Does not
// validate — callers should validate all changed fields up front via
// validateProfileFields before starting any spend.
export async function submitProfileField({ engine, assetId, key, value, onStatus = () => {}, log = () => {} }) {
  if (!engine?.kaspa || !engine?.privateKey || !engine?.address) throw new Error("Load a wallet before editing your KNS profile.");
  if (!KNS_PROFILE_FIELD_KEYS.includes(key)) throw new Error(`Unknown profile field: ${key}`);

  const payloadJson = buildAddProfilePayload(assetId, key, value);
  assertPayloadFits(payloadJson);

  const xOnlyPubkeyHex = xOnlyPublicKeyHexFromPrivateKey(engine.privateKey);
  const { builder, redeemScriptHex, commitScriptPublicKey, commitAddressString } = buildKnsRedeemScript(engine.kaspa, xOnlyPubkeyHex, payloadJson);

  const commitAmountSompi = KNS_ECONOMICS.profileEditCommitSompi;
  const revealAmountSompi = KNS_ECONOMICS.profileEditRevealSompi;
  const commitAmountKas = sompiToKaspaDisplay(engine.kaspa, commitAmountSompi);
  const revealTargetAddress = engine.address;

  onStatus({ status: "committing", key });
  const commit = await sendKnsCommitTransaction({ engine, commitAddressString, commitAmountKas, commitScriptPublicKey, commitAmountSompi, log });
  savePendingCommit({
    kind: "profile",
    assetId,
    key,
    commitTxId: commit.txid,
    commitOutputIndex: commit.outputIndex,
    commitAmountSompi,
    commitScriptPublicKeyHex: commitScriptPublicKey.script,
    redeemScriptHex,
    revealTargetAddress,
    revealAmountSompi,
    createdAt: Date.now(),
  });
  onStatus({ status: "committed", key, commitTxid: commit.txid });

  onStatus({ status: "revealing", key });
  const reveal = await buildAndSubmitKnsReveal({
    engine,
    commitTxId: commit.txid,
    commitOutputIndex: commit.outputIndex,
    commitAmountSompi,
    commitScriptPublicKey,
    builder,
    revealTargetAddress,
    revealAmountSompi,
    log,
  });
  clearPendingKnsCommit();
  onStatus({ status: "revealed", key, revealTxid: reveal.txid });

  onStatus({ status: "verifying", key });
  const verified = await pollUntil(
    async () => {
      const profile = await fetchProfileByAssetId(assetId, { baseUrl: KNS_DEFAULT_URL, keys: [key] });
      const expectEmpty = value === "";
      const actual = profile?.[key] ?? null;
      if (expectEmpty) return actual == null ? { profile } : null;
      return actual === value ? { profile } : null;
    },
    { timeoutMs: 60_000 },
  );
  onStatus({ status: verified ? "confirmed" : "pending-confirmation", key });

  return { key, commitTxid: commit.txid, revealTxid: reveal.txid, verified: Boolean(verified) };
}

// Submits every changed field sequentially, in the fixed documented order,
// tolerating per-field failure (a failure on one field does not roll back or
// block the others — matches iOS/Android's partial-success behavior).
export async function submitProfileFields({ engine, assetId, fields, onStatus = () => {}, log = () => {} }) {
  const validated = validateProfileFields(fields);
  const results = [];
  for (const key of PROFILE_FIELD_EDIT_ORDER) {
    if (!(key in validated)) continue;
    try {
      const result = await submitProfileField({ engine, assetId, key, value: validated[key], onStatus, log });
      results.push({ key, ok: true, ...result });
    } catch (error) {
      results.push({ key, ok: false, error: error?.message || String(error) });
      onStatus({ status: "field-failed", key, error: error?.message || String(error) });
    }
  }
  return results;
}

// --- image upload (avatar/banner) --------------------------------------------
// Off-chain, wallet-signed REST upload — the returned URL is what actually
// gets written on-chain afterward via submitProfileField("avatarUrl"/"bannerUrl").

function bytesToHex(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Strips the script-push envelope signScriptHash() adds ([0x41][64-byte sig]
// [sighash-type byte]) to recover a plain 64-byte Schnorr signature, for use
// in contexts (like this REST API) that expect a bare signature, not a
// script-ready push.
async function rawSchnorrSignDigest(kaspa, privateKey, digestBytes) {
  const hex = bytesToHex(digestBytes);
  const scriptPush = kaspa.signScriptHash(hex, privateKey);
  return scriptPush.slice(2, 130);
}

async function sha256Bytes(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return new Uint8Array(digest);
}

// Retries the whole request once with the next signing mode if the server
// reports a signature-verification failure — the response body text (not
// just the HTTP status) must be inspected, since that's the only place the
// rejection reason appears.
// Sets which of the wallet's domains is its primary name (iOS submitSetPrimaryDomainWithSignatureFallback).
// The signed message has to match app.knsdomains.org's bytes exactly; the signature is tried in
// the same three modes the image upload uses, because the API accepts one of them and does not
// say which up front.
export async function setKnsPrimaryDomain({ engine, domainId, baseUrl = KNS_DEFAULT_URL }) {
  if (!engine?.kaspa || !engine?.privateKey) throw new Error("Load a wallet before setting a primary domain.");
  const trimmedId = String(domainId || "").trim();
  if (!trimmedId) throw new Error("KNS domain id is missing.");
  const message = `{"domainId":"${trimmedId}","timestamp":${Date.now()}}`;
  const utf8Bytes = new TextEncoder().encode(message);
  const modes = [
    () => engine.kaspa.signMessage({ message, privateKey: engine.privateKeyHex || engine.privateKey }),
    async () => {
      if (utf8Bytes.length !== 32) throw new Error("message is not 32 bytes");
      return rawSchnorrSignDigest(engine.kaspa, engine.privateKey, utf8Bytes);
    },
    async () => rawSchnorrSignDigest(engine.kaspa, engine.privateKey, await sha256Bytes(utf8Bytes)),
  ];
  const base = String(baseUrl || KNS_DEFAULT_URL).replace(/\/+$/, "");
  const url = `${base}/domain/primary-name`;
  let lastErrorText = "";
  for (const mode of modes) {
    let signature;
    try { signature = await mode(); } catch { continue; }
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ signMessage: message, signature }),
    });
    const text = await response.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    if (response.ok && json?.success) return true;
    lastErrorText = json?.error || json?.message || text || `HTTP ${response.status}`;
    const retryable = /signature verification failed|unauthorized|invalid signature/i.test(lastErrorText);
    if (!retryable) throw new Error(lastErrorText || "KNS set primary failed.");
  }
  throw new Error(lastErrorText || "KNS set primary failed.");
}

export async function uploadKnsProfileImage({ engine, assetId, uploadType, blob, baseUrl = KNS_DEFAULT_URL }) {
  if (!engine?.kaspa || !engine?.privateKey) throw new Error("Load a wallet before uploading a KNS image.");
  if (uploadType !== "avatar" && uploadType !== "banner") throw new Error("uploadType must be 'avatar' or 'banner'.");

  const message = JSON.stringify({ assetId, uploadType });
  const utf8Bytes = new TextEncoder().encode(message);
  const modes = [
    () => engine.kaspa.signMessage({ message, privateKey: engine.privateKeyHex || engine.privateKey }),
    async () => {
      if (utf8Bytes.length !== 32) throw new Error("message is not 32 bytes");
      return rawSchnorrSignDigest(engine.kaspa, engine.privateKey, utf8Bytes);
    },
    async () => rawSchnorrSignDigest(engine.kaspa, engine.privateKey, await sha256Bytes(utf8Bytes)),
  ];

  const base = String(baseUrl || KNS_DEFAULT_URL).replace(/\/+$/, "");
  const url = `${base}/upload/image`;
  const ext = blob.type === "image/png" ? "png" : "jpg";
  const filename = `${uploadType}-${assetId}.${ext}`;

  let lastErrorText = "";
  for (const mode of modes) {
    let signature;
    try {
      signature = await mode();
    } catch {
      continue;
    }

    const form = new FormData();
    form.append("signMessage", message);
    form.append("signature", signature);
    form.append("image", blob, filename);

    const response = await fetch(url, { method: "POST", body: form });
    const text = await response.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }

    if (response.ok && json?.success && json.data?.success) {
      const imageUrl = json.data.data?.imageUrl || json.data.imageUrl;
      if (!imageUrl) throw new Error("KNS image upload response did not include an image URL.");
      return { imageUrl };
    }

    lastErrorText = text || json?.message || json?.error || `HTTP ${response.status}`;
    const retryable = /signature verification failed|unauthorized/i.test(lastErrorText);
    if (!retryable) throw new Error(lastErrorText || "KNS image upload failed.");
  }
  throw new Error(lastErrorText || "KNS image upload failed.");
}
