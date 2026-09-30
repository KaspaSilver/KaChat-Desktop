// The wallet as the popup sees it: Kaspa WASM, the account's addresses, the node connection,
// balances and the KAS price. Built on the desktop app's engine (../../engine), so an address
// derived here is byte-for-byte the one KaChat on iOS, Android and desktop derives from the same
// recovery phrase:
//   main address      m/44'/111111'/0'/0/{identityIndex}  (or the account's legacy family)
//   spending address  m/44'/111111'/1'/0/{index}
// The main address is what KaChat calls the chatting address - your identity, where KNS domains
// live. Spending addresses are the fresh-address chain KaChat receives payments on.

import { loadKaspaModule } from "../../engine/wasm-loader.js";
import {
  generateMnemonicPhrase,
  importMnemonicWithFamily,
  deriveSpendingWallet,
  spendingDerivationPath,
  importPrivateKey,
} from "../../engine/wallet.js";
import { createRpc, probeRpc, disconnectRpc, getNodeRegistrySnapshot, PUBLIC_NODE_SEEDS } from "../../engine/rpc.js";
import { getEndpoint } from "../../engine/endpoints.js";
import { getBalance, sendKaspa, sendMaxKaspa, sweepAllToSelf, estimateSendFeeDetail } from "../../engine/transactions.js";
import { calculateMass, calculateFee, fetchQuotedFeeRateSompiPerGram } from "../../ui/kspt.js";
import { resolveDomain, looksLikeDomain } from "../../engine/kns.js";
import { fetchKasPrice, peekKasPrice } from "../../engine/prices.js";
import { getAddressInfo, getAddressProfile, fetchAddressInfo, fetchAddressProfile, peekAddressInfo, peekAddressProfile } from "../../engine/kns.js";
import { getLocal, setLocal } from "./browser.js";
import { activeAccountSecrets } from "./vault.js";

let kaspaPromise = null;
let rpc = null;
let rpcPromise = null;

/** Kaspa WASM, loaded once per page. ~12 MB; the browser caches the compiled module. */
export function kaspa() {
  if (!kaspaPromise) kaspaPromise = loadKaspaModule().catch((error) => { kaspaPromise = null; throw error; });
  return kaspaPromise;
}

/** A new 12- or 24-word phrase, from the Kaspa SDK's own BIP39 generator. */
export async function newRecoveryPhrase(wordCount = 24) {
  return generateMnemonicPhrase(await kaspa(), wordCount === 12 ? 12 : 24);
}

/**
 * The main address a phrase + passphrase open, for the passphrase screen's live preview (iOS
 * `previewChattingAddress`). Nothing is stored. Null when it cannot be derived.
 */
export async function previewMainAddress(phrase, passphrase = "", family = "kaspaStandard") {
  try {
    const derived = await importMnemonicWithFamily(await kaspa(), phrase, passphrase, { family, index: 0 });
    return derived.address;
  } catch {
    return null;
  }
}

/**
 * Checks a phrase the user typed (word list and checksum) without keeping anything. Returns the
 * normalized phrase, or throws with a message the import screen can show.
 */
export async function validateRecoveryPhrase(phrase) {
  const clean = String(phrase || "").trim().toLowerCase().replace(/\s+/g, " ");
  const words = clean ? clean.split(" ") : [];
  if (![12, 15, 18, 21, 24].includes(words.length)) {
    throw new Error("A recovery phrase has 12 or 24 words.");
  }
  const k = await kaspa();
  // The SDK checks every word against the BIP39 list and the checksum.
  let valid = false;
  try {
    valid = typeof k.Mnemonic.validate === "function" ? Boolean(k.Mnemonic.validate(clean)) : Boolean(new k.Mnemonic(clean));
  } catch {
    valid = false;
  }
  if (!valid) throw new Error("That recovery phrase isn't valid. Check each word and the order.");
  return clean;
}

// --- Addresses ---------------------------------------------------------------------------

function spendingStateKey(accountId) { return `kachat.spending.${accountId}`; }
function addressCacheKey(accountId) { return `kachat.addresses.${accountId}`; }

/**
 * The account's spending-address bookkeeping - same shape as the desktop app's, so the ideas
 * carry over: `activeIndex` is the primary spending address, `maxIndex` the highest revealed.
 */
export async function spendingState(accountId) {
  const raw = (await getLocal(spendingStateKey(accountId))) || {};
  const activeIndex = Math.max(0, Math.floor(Number(raw.activeIndex) || 0));
  const maxIndex = Math.max(activeIndex, Math.floor(Number(raw.maxIndex) || 0));
  const hidden = Array.isArray(raw.hidden) ? raw.hidden.map(Number).filter((n) => Number.isInteger(n) && n >= 0) : [];
  const labels = raw.labels && typeof raw.labels === "object" ? { ...raw.labels } : {};
  // Which index the Receive QR is handing out (iOS receiveAddressIndex) - separate from the
  // primary, which is where payments are SENT from.
  const receiveIndex = Number.isInteger(raw.receiveIndex) && raw.receiveIndex >= 0 ? raw.receiveIndex : null;
  return { activeIndex, maxIndex, hidden, labels, receiveIndex };
}

export async function saveSpendingState(accountId, patch) {
  const next = { ...(await spendingState(accountId)), ...patch };
  next.maxIndex = Math.max(next.activeIndex, next.maxIndex, Number.isInteger(next.receiveIndex) ? next.receiveIndex : 0);
  await setLocal(spendingStateKey(accountId), next);
  return next;
}

/** Addresses already derived for an account (public data), so the popup paints instantly. */
export async function cachedAddresses(accountId) {
  return (await getLocal(addressCacheKey(accountId))) || null;
}

/**
 * Derives the active account's main address and its revealed spending addresses. Needs the
 * wallet unlocked (reads the phrase from the vault for the moment it takes).
 */
export async function deriveAddresses() {
  const account = await activeAccountSecrets();
  const k = await kaspa();
  const main = await importMnemonicWithFamily(k, account.mnemonic, account.passphrase, {
    family: account.family,
    index: account.identityIndex,
  });
  const state = await spendingState(account.id);
  const spending = {};
  for (let index = 0; index <= state.maxIndex; index += 1) {
    spending[index] = deriveSpendingWallet(k, account.mnemonic, index, account.passphrase).address;
  }
  const result = { accountId: account.id, main: main.address, spending, derivedAt: Date.now() };
  await setLocal(addressCacheKey(account.id), result);
  return result;
}

// --- Network -----------------------------------------------------------------------------

/**
 * A connected node, reusing the open one while it still answers. The engine picks the node the
 * same way the desktop app does: the user's own node if one is set, otherwise the Kaspa public
 * node resolver.
 */
// Every connection step goes to the console (right-click the popup > Inspect > Console), which
// is where to look when the dot stays yellow.
const logConnection = (...parts) => console.info("[KaChat Wallet]", ...parts);
const LAST_NODE_KEY = "kachat.lastNode";

export async function connection(log = logConnection) {
  if (rpc && await probeRpc(rpc)) return rpc;
  if (!rpcPromise) {
    rpcPromise = (async () => {
      if (rpc) { await disconnectRpc(rpc); rpc = null; }
      const k = await kaspa();
      // Fast path: the node that answered last time, straight away. The public resolver scan
      // behind createRpc can spend 15-20 seconds on one unresponsive seed server before it
      // moves on, which every popup open would otherwise wait out. A user-set node is left to
      // createRpc, which connects to it strictly.
      if (!getEndpoint("trustedNode")) {
        // Kept in extension storage too: it is written straight to disk, where the engine's
        // localStorage registry can be lost when the browser is closed abruptly.
        const lastGood = (await getLocal(LAST_NODE_KEY)) || getNodeRegistrySnapshot().lastGoodEndpoint;
        if (lastGood) {
          try {
            rpc = await connectDirect(k, lastGood);
            log("Reconnected to the last node:", lastGood);
            return rpc;
          } catch (error) {
            log(`Last node ${lastGood} did not answer (${error?.message || error}); scanning for another.`);
          }
        }
      }
      rpc = getEndpoint("trustedNode") ? await createRpc(k, log) : await raceForNode(k, log);
      if (!getEndpoint("trustedNode") && rpc?.url) await setLocal(LAST_NODE_KEY, rpc.url);
      return rpc;
    })().finally(() => { rpcPromise = null; });
  }
  return rpcPromise;
}

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * No remembered node: the public resolver scan, and - if it has not answered within three
 * seconds - the known public nodes tried directly alongside it. First to connect wins; a late
 * second connection is closed. The resolver alone can sit 20 seconds on one dead seed server.
 */
async function raceForNode(k, log) {
  let settled = false;
  const viaResolver = createRpc(k, log);
  const viaKnownNodes = (async () => {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const nodes = [...PUBLIC_NODE_SEEDS].sort(() => Math.random() - 0.5);
    for (const url of nodes) {
      if (settled) break;
      try {
        const client = await connectDirect(k, url);
        log("Connected directly to a known public node:", url);
        return client;
      } catch { /* next */ }
    }
    throw new Error("No known public node answered.");
  })();
  const attempts = [viaResolver, viaKnownNodes];
  let winner;
  try {
    winner = await Promise.any(attempts);
  } catch {
    throw new Error("Can't reach a Kaspa node right now.");
  }
  settled = true;
  for (const attempt of attempts) attempt.then((client) => { if (client && client !== winner) disconnectRpc(client); }, () => {});
  return winner;
}

/** One node, once, fast: connect, confirm it is synced, or give up within a few seconds. */
async function connectDirect(k, url, timeoutMs = 5000) {
  const client = new k.RpcClient({ url, encoding: k.Encoding?.Borsh, networkId: "mainnet" });
  try {
    await withTimeout(
      client.connect({ blockAsyncConnect: true, strategy: k.ConnectStrategy?.Fallback ?? 1, timeoutDuration: timeoutMs }),
      timeoutMs + 1000,
      "Connecting",
    );
    const info = await withTimeout(client.getServerInfo(), 5000, "Node check");
    if (info?.isSynced === false) throw new Error("node is not synced");
    return client;
  } catch (error) {
    try { await client.disconnect(); } catch { /* already closed */ }
    throw error;
  }
}

export function connectedNodeUrl() {
  return rpc?.url || "";
}

export async function disconnect() {
  const current = rpc;
  rpc = null;
  await disconnectRpc(current);
}

/**
 * Balances for the main address and every visible spending address, in sompi (BigInt), plus
 * the total. One node round trip per address, all in parallel.
 */
export async function balances(addresses, hiddenIndexes = []) {
  const node = await connection();
  const k = await kaspa();
  const hidden = new Set(hiddenIndexes);
  const spendingEntries = Object.entries(addresses.spending || {}).filter(([index]) => !hidden.has(Number(index)));
  const [main, ...spending] = await Promise.all([
    getBalance(k, node, addresses.main),
    ...spendingEntries.map(([, address]) => getBalance(k, node, address)),
  ]);
  const bySpendingIndex = {};
  spendingEntries.forEach(([index], i) => { bySpendingIndex[index] = spending[i].totalSompi; });
  const total = spending.reduce((sum, b) => sum + b.totalSompi, main.totalSompi);
  return { main: main.totalSompi, spending: bySpendingIndex, total };
}

// --- KNS ---------------------------------------------------------------------------------

function knsOptions() {
  return { baseUrl: getEndpoint("knsApi") };
}

/** What is cached for an address right now (no network): { domainName, profile, domainCount }. */
export function cachedKns(address) {
  const profile = peekAddressProfile(address);
  const info = peekAddressInfo(address);
  return knsView(profile, info);
}

/** The address's KNS name, profile (avatar, banner, bio) and domain count, refreshed. */
export async function kns(address, { force = false } = {}) {
  const options = knsOptions();
  const [info, profile] = force
    ? await Promise.all([fetchAddressInfo(address, options), fetchAddressProfile(address, options)])
    : await Promise.all([getAddressInfo(address, options), getAddressProfile(address, options)]);
  return knsView(profile, info);
}

function knsView(profile, info) {
  const domains = Array.isArray(info?.allDomains) ? info.allDomains : [];
  return {
    domainName: profile?.domainName || info?.primaryDomain || null,
    profile: profile?.profile || null,
    domainCount: domains.length,
    known: Boolean(profile || info),
  };
}

// --- Price -------------------------------------------------------------------------------

export function cachedPrice(currency = "usd") {
  return peekKasPrice(currency);
}

export async function price(currency = "usd") {
  try {
    return await fetchKasPrice({ currency });
  } catch {
    return peekKasPrice(currency);
  }
}

// --- Formatting --------------------------------------------------------------------------

const SOMPI_PER_KAS = 100_000_000n;

/** "1,234.5678 KAS"-style text from sompi, trimmed to `decimals` places (floor, never rounds up). */
export function formatKas(sompi, decimals = 4) {
  const value = BigInt(sompi || 0n);
  const whole = value / SOMPI_PER_KAS;
  const fraction = (value % SOMPI_PER_KAS).toString().padStart(8, "0").slice(0, decimals).replace(/0+$/, "");
  const wholeText = whole.toLocaleString("en-US");
  return fraction ? `${wholeText}.${fraction}` : wholeText;
}

export function formatFiat(sompi, priceEntry) {
  if (!priceEntry?.price) return "";
  const kasValue = Number(BigInt(sompi || 0n)) / 1e8;
  const currency = String(priceEntry.currency || "usd").toUpperCase();
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(kasValue * priceEntry.price);
  } catch {
    return `${(kasValue * priceEntry.price).toFixed(2)} ${currency}`;
  }
}

export function shortAddress(address) {
  const text = String(address || "");
  if (text.length <= 22) return text;
  return `${text.slice(0, 12)}…${text.slice(-6)}`;
}


// =========================================================================================
// Phase 2: sending and address management
// =========================================================================================
//
// A "source" names which of the account's addresses a transaction spends from:
//   { kind: "main" }                  the chatting (identity) address
//   { kind: "spending", index: n }    spending address #n
// Keys are derived from the vault for the moment they are needed and handed to the engine as
// hex; nothing about them is kept afterwards.

const NETWORK = "mainnet";

async function sourceWallet(source) {
  const account = await activeAccountSecrets();
  const k = await kaspa();
  if (source?.kind === "spending") {
    const derived = deriveSpendingWallet(k, account.mnemonic, source.index, account.passphrase);
    return { accountId: account.id, address: derived.address, privateKeyHex: derived.privateKeyHex };
  }
  const derived = await importMnemonicWithFamily(k, account.mnemonic, account.passphrase, {
    family: account.family,
    index: account.identityIndex,
  });
  return { accountId: account.id, address: derived.address, privateKeyHex: derived.privateKeyHex };
}

/** The node call wrapper the engine expects: one reconnect-and-retry on a dropped socket. */
async function withRpc(fn) {
  try {
    return await fn(await connection());
  } catch (error) {
    if (!/not connected|closed|timed out|timeout|network/i.test(String(error?.message || error))) throw error;
    await disconnect();
    return fn(await connection());
  }
}

/** Spendable coins at an address, sorted largest first. */
export async function utxos(address) {
  const response = await withRpc((node) => node.getUtxosByAddresses([address]));
  return (response?.entries || [])
    .map((entry) => ({
      entry,
      key: `${entry?.outpoint?.transactionId}:${entry?.outpoint?.index}`,
      transactionId: String(entry?.outpoint?.transactionId || ""),
      index: Number(entry?.outpoint?.index ?? 0),
      amount: BigInt(entry?.amount ?? 0),
      daaScore: BigInt(entry?.blockDaaScore ?? 0),
      isCoinbase: Boolean(entry?.isCoinbase),
    }))
    .sort((a, b) => (a.amount > b.amount ? -1 : a.amount < b.amount ? 1 : 0));
}

export function kasToSompi(kasText) {
  const text = String(kasText ?? "").trim();
  if (!/^\d*\.?\d{0,8}$/.test(text) || text === "" || text === ".") return null;
  const [whole, fraction = ""] = text.split(".");
  return BigInt(whole || "0") * 100_000_000n + BigInt((fraction + "00000000").slice(0, 8));
}

export function sompiToKasText(sompi) {
  return formatKas(sompi, 8).replace(/,/g, "");
}

/** Is this a valid mainnet Kaspa address? (checksum included, via the SDK) */
export async function isValidAddress(text) {
  const clean = String(text || "").trim();
  if (!/^kaspa:[a-z0-9]{50,}$/.test(clean)) return false;
  try {
    const k = await kaspa();
    return typeof k.Address?.validate === "function" ? Boolean(k.Address.validate(clean)) : Boolean(new k.Address(clean));
  } catch {
    return false;
  }
}

/**
 * What the recipient field means: a kaspa: address, or a KNS name (alice.kas / alice) resolved
 * to its owner. Returns { address, domain } or throws with the message to show.
 */
export async function resolveRecipient(input) {
  const text = String(input || "").trim();
  if (!text) throw new Error("Enter a Kaspa address (kaspa:...)");
  if (text.toLowerCase().startsWith("kaspa:")) {
    const address = text.split("?")[0].toLowerCase();
    if (!(await isValidAddress(address))) throw new Error("Invalid address format");
    return { address, domain: null };
  }
  if (looksLikeDomain(text)) {
    const resolved = await resolveDomain(text, { baseUrl: getEndpoint("knsApi") });
    const address = resolved?.ownerAddress || resolved?.address || resolved?.owner;
    if (!address) throw new Error("No KNS domain by that name.");
    return { address, domain: resolved?.domain || resolved?.fullName || text.toLowerCase() };
  }
  throw new Error("Invalid address format");
}

/**
 * Fee for sending `amountKas` from `address`: { policyKas, sdkBaseKas } as numbers. The policy fee
 * (mass x 100 sompi/gram, as on iOS) is what is shown and paid; the SDK adds its own base fee
 * automatically, so the send passes the difference as a priority tip.
 */
export async function estimateFee({ address, amountKas = "0.2", selectedOutpoints = null }) {
  const detail = await estimateSendFeeDetail({
    kaspa: await kaspa(),
    rpc: await connection(),
    withRpc,
    sourceAddress: address,
    amountKas: String(amountKas),
    payloadBytes: 0,
    selectedOutpoints,
  });
  if (!detail) return null;
  return { policyKas: Number(detail.policyFeeKas), sdkBaseKas: Number(detail.sdkFeeKas) };
}

/** Fee for spending `inputCount` coins into one output (Max, compound), at the live quoted rate. */
export async function maxFee(inputCount) {
  const rate = await fetchQuotedFeeRateSompiPerGram();
  const mass = calculateMass(Math.max(1, inputCount), [34, 34], 0);
  return { policyKas: Number(calculateFee(mass, rate)) / 1e8, sdkBaseKas: Number(mass) / 1e8 };
}

/**
 * Sends Kaspa. `max` spends every coin (or the selected ones) into ONE output of total minus
 * `totalFeeKas`, which is the only shape KIP-9 accepts near a full balance. A normal send pays
 * `tipKas` on top of the SDK's base fee. Sending from the PRIMARY spending address sends change
 * to a fresh address and moves the primary there once the node accepts it (iOS/desktop parity).
 */
export async function send({ source, destination, amountKas = null, tipKas = "0", totalFeeKas = null, selectedOutpoints = null, max = false }) {
  const from = await sourceWallet(source);
  const k = await kaspa();
  const node = await connection();
  const log = (...parts) => console.info("[KaChat Wallet]", ...parts);
  if (max) {
    return sendMaxKaspa({
      kaspa: k, rpc: node, withRpc, privateKey: from.privateKeyHex, sourceAddress: from.address,
      destinationAddress: destination,
      totalFeeSompi: totalFeeKas != null ? kasToSompi(String(totalFeeKas)) : null,
      selectedOutpoints, log,
    });
  }
  let fresh = null;
  if (source?.kind === "spending") {
    const state = await spendingState(from.accountId);
    if (source.index === state.activeIndex) {
      const account = await activeAccountSecrets();
      const index = state.maxIndex + 1;
      fresh = { index, address: deriveSpendingWallet(k, account.mnemonic, index, account.passphrase).address };
    }
  }
  const result = await sendKaspa({
    kaspa: k, rpc: node, withRpc, privateKey: from.privateKeyHex, sourceAddress: from.address,
    destinationAddress: destination, amountKas: String(amountKas), feeKas: String(tipKas || "0"),
    selectedOutpoints, changeAddress: fresh?.address || null, log,
  });
  if (fresh) {
    await saveSpendingState(from.accountId, { activeIndex: fresh.index, maxIndex: fresh.index });
    await cacheSpendingAddress(from.accountId, fresh.index, fresh.address);
  }
  return result;
}

/** Merges every coin at the source into one (a self-send with no change). */
export async function compound(source, totalFeeKas = null) {
  const from = await sourceWallet(source);
  return sweepAllToSelf({
    kaspa: await kaspa(), rpc: await connection(), withRpc,
    privateKey: from.privateKeyHex, sourceAddress: from.address,
    totalFeeSompi: totalFeeKas != null ? kasToSompi(String(totalFeeKas)) : null,
    log: (...parts) => console.info("[KaChat Wallet]", ...parts),
  });
}

/** The source's private key as hex - for the reveal screen, behind the password. */
export async function privateKeyHex(source) {
  return (await sourceWallet(source)).privateKeyHex;
}

/** The source's public key (compressed, hex). */
export async function publicKeyHex(source) {
  const from = await sourceWallet(source);
  const k = await kaspa();
  return String(new k.PrivateKey(from.privateKeyHex).toPublicKey().toString());
}

// --- History ------------------------------------------------------------------------------

function restBase() {
  return String(getEndpoint("kaspaApi") || "https://api.kaspa.org").replace(/\/+$/, "");
}

/**
 * Recent transactions touching `address` from the Kaspa REST API, each reduced to what the
 * history list shows: { txid, time, isOutgoing, amountSompi, feeSompi, confirmed }.
 */
export async function history(address, limit = 50) {
  const url = `${restBase()}/addresses/${encodeURIComponent(address)}/full-transactions?limit=${limit}&offset=0&resolve_previous_outpoints=light`;
  const response = await fetch(url, { headers: { Accept: "application/json" }, cache: "no-store" });
  if (!response.ok) throw new Error(`History unavailable (HTTP ${response.status}).`);
  const txs = await response.json();
  const own = await ownAddresses().catch(() => new Set());
  own.add(address);
  return (Array.isArray(txs) ? txs : []).map((tx) => describeTransaction(tx, address, own)).filter(Boolean);
}

// This account's known addresses (chatting + every cached spending address). A send from the
// primary spending address puts its change on a fresh spending address, so that output is
// change, not money sent - history counts only what left the account.
async function ownAddresses() {
  const account = await activeAccountSecrets();
  const cached = (await cachedAddresses(account.id)) || {};
  const own = new Set(Object.values(cached.spending || {}));
  if (cached.main) own.add(cached.main);
  return own;
}

function describeTransaction(tx, address, own = new Set([address])) {
  const inputs = tx.inputs || [];
  const outputs = tx.outputs || [];
  const weSent = inputs.some((input) => (input.previous_outpoint_address || input.previousOutpointAddress) === address);
  let toUs = 0n;
  let toOthers = 0n;
  let toOwn = 0n; // this account's other addresses: change, or a move between them
  for (const output of outputs) {
    const to = output.script_public_key_address;
    const amount = BigInt(output.amount || 0);
    if (to === address) toUs += amount;
    else if (to && own.has(to)) toOwn += amount;
    else if (to) toOthers += amount;
  }
  let fee = null;
  if (inputs.length && inputs.every((input) => input.previous_outpoint_amount != null)) {
    const totalIn = inputs.reduce((sum, input) => sum + BigInt(input.previous_outpoint_amount), 0n);
    const totalOut = outputs.reduce((sum, output) => sum + BigInt(output.amount || 0), 0n);
    if (totalIn >= totalOut) fee = totalIn - totalOut;
  }
  let isOutgoing;
  let amount;
  if (weSent && toOthers > 0n) { isOutgoing = true; amount = toOthers; }
  else if (!weSent && toUs > 0n) { isOutgoing = false; amount = toUs; }
  else if (weSent && toOwn > 0n) { isOutgoing = true; amount = toOwn; } // to another own address
  else if (weSent) { isOutgoing = true; amount = 0n; } // a self-send (compound)
  else return null;
  return {
    txid: tx.transaction_id,
    time: Number(tx.block_time || 0),
    isOutgoing,
    isSelf: weSent && toOthers === 0n && toOwn === 0n,
    amountSompi: amount,
    feeSompi: fee,
    confirmed: Boolean(tx.is_accepted),
  };
}

const USED_KEY = "kachat.usedAddresses";

/**
 * Has this address ever appeared on chain? iOS spendingAddressUsedState: the REST
 * transactions-count. A "used" answer is remembered for good; null means the probe failed.
 */
export async function addressUsed(address) {
  const used = new Set((await getLocal(USED_KEY)) || []);
  if (used.has(address)) return true;
  try {
    const response = await fetch(`${restBase()}/addresses/${encodeURIComponent(address)}/transactions-count`, { cache: "no-store" });
    if (!response.ok) return null;
    const json = await response.json();
    const isUsed = Number(json?.total ?? 0) > 0;
    if (isUsed) { used.add(address); await setLocal(USED_KEY, [...used]); }
    return isUsed;
  } catch {
    return null;
  }
}

// --- Spending addresses -------------------------------------------------------------------

async function cacheSpendingAddress(accountId, index, address) {
  const cached = (await cachedAddresses(accountId)) || { accountId, main: null, spending: {} };
  cached.spending = { ...(cached.spending || {}), [index]: address };
  await setLocal(`kachat.addresses.${accountId}`, cached);
}

/** Addresses for a run of spending indexes, deriving the seed only once for the whole run. */
export async function spendingAddressRange(start, count) {
  const account = await activeAccountSecrets();
  const k = await kaspa();
  const master = new k.XPrv(new k.Mnemonic(account.mnemonic).toSeed(account.passphrase || ""));
  const result = {};
  for (let index = start; index < start + count; index += 1) {
    const key = master.derivePath(spendingDerivationPath(index)).toPrivateKey().toString();
    result[index] = importPrivateKey(k, key).address;
  }
  return result;
}

/** Every revealed spending address of the active account, with balances (one node call). */
export async function spendingList() {
  const account = await activeAccountSecrets();
  const state = await spendingState(account.id);
  const cached = (await cachedAddresses(account.id))?.spending || {};
  const missing = [];
  for (let index = 0; index <= state.maxIndex; index += 1) if (!cached[index]) missing.push(index);
  let addresses = { ...cached };
  if (missing.length) {
    addresses = { ...addresses, ...(await spendingAddressRange(0, state.maxIndex + 1)) };
    const all = (await cachedAddresses(account.id)) || { accountId: account.id, main: null };
    await setLocal(`kachat.addresses.${account.id}`, { ...all, accountId: account.id, spending: addresses });
  }
  const indexes = Array.from({ length: state.maxIndex + 1 }, (_, i) => i);
  const balancesByAddress = await balancesFor(indexes.map((i) => addresses[i]));
  return {
    state,
    rows: indexes.map((index) => ({
      index,
      address: addresses[index],
      label: labelFor(state, index),
      hidden: state.hidden.includes(index),
      primary: index === state.activeIndex,
      balanceSompi: balancesByAddress[addresses[index]] ?? 0n,
    })),
  };
}

export function labelFor(state, index) {
  const custom = String(state.labels?.[index] ?? state.labels?.[String(index)] ?? "").trim();
  if (custom) return custom;
  return index === 0 ? "Primary spending" : `Spending #${index}`;
}

/** Balances for many addresses in one node call: { address: sompi }. */
export async function balancesFor(addresses) {
  const list = addresses.filter(Boolean);
  if (!list.length) return {};
  const out = {};
  for (const address of list) out[address] = 0n;
  for (let i = 0; i < list.length; i += 50) {
    const chunk = list.slice(i, i + 50);
    const response = await withRpc((node) => node.getUtxosByAddresses(chunk));
    for (const entry of response?.entries || []) {
      const owner = String(entry?.address?.toString?.() ?? entry?.address ?? "");
      if (owner in out) out[owner] += BigInt(entry?.amount ?? 0);
    }
  }
  return out;
}

async function activeState() {
  const account = await activeAccountSecrets();
  return { account, state: await spendingState(account.id) };
}

export async function setSpendingHidden(index, hidden) {
  const { account, state } = await activeState();
  if (hidden && index === state.activeIndex) throw new Error("The primary spending address can't be hidden.");
  const set = new Set(state.hidden);
  if (hidden) set.add(index); else set.delete(index);
  return saveSpendingState(account.id, { hidden: [...set] });
}

export async function setSpendingLabel(index, label) {
  const { account, state } = await activeState();
  const labels = { ...state.labels };
  const clean = String(label || "").trim();
  if (clean) labels[index] = clean.slice(0, 40); else delete labels[index];
  return saveSpendingState(account.id, { labels });
}

export async function setPrimarySpending(index) {
  const { account, state } = await activeState();
  const hidden = state.hidden.filter((i) => i !== index);
  return saveSpendingState(account.id, { activeIndex: index, maxIndex: Math.max(state.maxIndex, index), hidden });
}

/**
 * iOS "Generate New Spending Address": the lowest hidden index that is confirmed unused
 * (never the primary, no balance) is un-hidden and reused; otherwise the chain extends by one.
 */
export async function generateSpendingAddress() {
  const { account, state } = await activeState();
  const cached = (await cachedAddresses(account.id))?.spending || {};
  const candidates = [...state.hidden].sort((a, b) => a - b).filter((i) => i !== state.activeIndex);
  if (candidates.length) {
    const addresses = { ...(await spendingAddressRange(0, state.maxIndex + 1)), ...cached };
    const balances = await balancesFor(candidates.map((i) => addresses[i]));
    for (const index of candidates) {
      const address = addresses[index];
      if ((balances[address] ?? 0n) > 0n) continue;
      if ((await addressUsed(address)) === false) {
        await saveSpendingState(account.id, { hidden: state.hidden.filter((i) => i !== index) });
        return index;
      }
    }
  }
  const index = state.maxIndex + 1;
  const [address] = Object.values(await spendingAddressRange(index, 1));
  await saveSpendingState(account.id, { maxIndex: index, hidden: state.hidden.filter((i) => i !== index) });
  await cacheSpendingAddress(account.id, index, address);
  return index;
}

/**
 * The Receive QR address (iOS freshReceiveAddress): the one handed out last time while it is
 * still unused, else the primary while THAT is unused, else a generated one. Never changes the
 * primary. A failed probe keeps the current answer rather than rotating on a guess.
 */
export async function freshReceiveAddress() {
  const { account, state } = await activeState();
  const addressAt = async (index) => {
    const cached = (await cachedAddresses(account.id))?.spending?.[index];
    return cached || (await spendingAddressRange(index, 1))[index];
  };
  if (Number.isInteger(state.receiveIndex)) {
    const address = await addressAt(state.receiveIndex);
    if ((await addressUsed(address)) !== true) return address;
  }
  const primary = await addressAt(state.activeIndex);
  if ((await addressUsed(primary)) !== true) {
    await saveSpendingState(account.id, { receiveIndex: state.activeIndex });
    return primary;
  }
  const index = await generateSpendingAddress();
  await saveSpendingState(account.id, { receiveIndex: index });
  return addressAt(index);
}

/**
 * iOS "Discover Addresses": sweeps the first 300 spending indexes (whatever the gaps - a
 * balance at #291 behind twenty empty slots is ordinary) in node batches of 50 and surfaces
 * every address that holds Kaspa. Returns how many were found.
 */
export async function discoverSpendingAddresses(onProgress = () => {}) {
  const { account, state } = await activeState();
  const window = 300;
  const addresses = await spendingAddressRange(0, window);
  const indexes = Object.keys(addresses).map(Number);
  const found = [];
  for (let i = 0; i < indexes.length; i += 50) {
    onProgress(i, window);
    const slice = indexes.slice(i, i + 50);
    const balances = await balancesFor(slice.map((index) => addresses[index]));
    for (const index of slice) if ((balances[addresses[index]] ?? 0n) > 0n) found.push(index);
  }
  onProgress(window, window);
  const highest = Math.max(state.maxIndex, ...found);
  const hidden = new Set(state.hidden);
  for (let index = state.maxIndex + 1; index <= highest; index += 1) if (!found.includes(index)) hidden.add(index);
  for (const index of found) hidden.delete(index);
  await saveSpendingState(account.id, { maxIndex: highest, hidden: [...hidden] });
  const cached = (await cachedAddresses(account.id)) || { accountId: account.id, main: null, spending: {} };
  const spending = { ...(cached.spending || {}) };
  for (let index = 0; index <= highest; index += 1) spending[index] = addresses[index] || spending[index];
  await setLocal(`kachat.addresses.${account.id}`, { ...cached, spending });
  return found.length;
}

// --- Explorer -----------------------------------------------------------------------------

export function explorerTxUrl(txid) { return `https://explorer.kaspa.org/txs/${txid}`; }
export function explorerAddressUrl(address) { return `https://explorer.kaspa.org/addresses/${address}`; }
