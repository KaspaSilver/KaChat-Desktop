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
import { looksLikeName, resolveEverywhere, primaryResolution, notFoundMessage, ownsAnyName, ownedNamesOfMany } from "./names.js";
import { fetchKasPrice, peekKasPrice } from "../../engine/prices.js";
import { getAddressInfo, fetchAddressInfo, peekAddressInfo, clearKnsCache } from "../../engine/kns.js";
import { transferDomain as knsTransferDomain, setKnsPrimaryDomain } from "../../engine/kns-write.js";
import { getLocal, setLocal } from "./browser.js";
import { IS_TESTNET, NETWORK_ID, ADDRESS_PREFIX, netKey, MAINNET_REST, TESTNET_REST, MAINNET_KNS, TESTNET_KNS } from "./net.js";
import { activeAccountSecrets, accountSecretsById } from "./vault.js";

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

// Per network (iOS keeps spending state and the address cache apart): the same key derives
// kaspatest: addresses on testnet.
function spendingStateKey(accountId) { return netKey(`kachat.spending.${accountId}`); }
function addressCacheKey(accountId) { return netKey(`kachat.addresses.${accountId}`); }

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
const LAST_NODE_KEY = netKey("kachat.lastNode");

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
  const client = new k.RpcClient({ url, encoding: k.Encoding?.Borsh, networkId: NETWORK_ID });
  try {
    await withTimeout(
      client.connect({ blockAsyncConnect: true, strategy: k.ConnectStrategy?.Fallback ?? 1, timeoutDuration: timeoutMs }),
      timeoutMs + 1000,
      "Connecting",
    );
    const info = await withTimeout(client.getServerInfo(), 5000, "Node check");
    if (info?.isSynced === false) throw new Error("node is not synced");
    // A node of the other network answers too; only the running network's will do.
    const net = String(info?.networkId ?? "").toLowerCase();
    if (net && (IS_TESTNET ? !net.includes("testnet") : net.includes("testnet"))) throw new Error(`node is on ${info.networkId}`);
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
  const configured = String(getEndpoint("knsApi") || "").replace(/\/+$/, "");
  if (IS_TESTNET && (!configured || configured === MAINNET_KNS)) return { baseUrl: TESTNET_KNS };
  return { baseUrl: configured || MAINNET_KNS };
}

/** The KNS API for the running network (Connection Settings > Domains shows it). */
export function knsApiUrl() { return knsOptions().baseUrl; }
/** The Kaspa REST API for the running network. */
export function restApiUrl() { return restBase(); }

/** What is cached for an address right now (no network): { domainName, profile, domainCount }. */
export function cachedKns(address) {
  return knsView(peekAddressInfo(address));
}

/**
 * The address's .kas name and domain count, refreshed. Only the NAME: like iOS (KNSService
 * .loadsDomainProfiles = false), KaChat no longer loads .kas profiles - avatar, banner and bio
 * will come from .kachat names.
 */
export async function kns(address, { force = false } = {}) {
  const options = knsOptions();
  const info = force ? await fetchAddressInfo(address, options) : await getAddressInfo(address, options);
  return knsView(info);
}

function knsView(info) {
  const domains = Array.isArray(info?.allDomains) ? info.allDomains : [];
  return {
    domainName: info?.primaryDomain || null,
    domainCount: domains.length,
    known: Boolean(info),
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

const NETWORK = NETWORK_ID;

async function sourceWallet(source) {
  // `accountId` pins a specific account (a website's connected account); otherwise the active one.
  const account = source?.accountId ? await accountSecretsById(source.accountId) : await activeAccountSecrets();
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
  if (!clean.startsWith(ADDRESS_PREFIX) || !/^[a-z]+:[a-z0-9]{50,}$/.test(clean)) return false;
  try {
    const k = await kaspa();
    return typeof k.Address?.validate === "function" ? Boolean(k.Address.validate(clean)) : Boolean(new k.Address(clean));
  } catch {
    return false;
  }
}

/**
 * What the recipient field means: a kaspa: address, or a name on any service (iOS
 * NameServicesClient) - the ending typed, else the first of .kachat, .kas, .k, .kaspa that
 * resolves. Returns { address, domain, tld, resolutions } - `resolutions` is every service's
 * answer, for the "Other domains" picker - or throws with the message to show (a not-found error
 * carries `resolutions` too: another service may have the name).
 */
export async function resolveRecipient(input) {
  const text = String(input || "").trim();
  if (!text) throw new Error("Enter a Kaspa address (kaspa:...)");
  if (/^kaspa(test)?:/i.test(text)) {
    const address = text.split("?")[0].toLowerCase();
    if (!(await isValidAddress(address))) throw new Error("Invalid address format");
    return { address, domain: null, tld: null, resolutions: [] };
  }
  if (looksLikeName(text)) {
    const resolutions = await resolveEverywhere(text);
    const primary = primaryResolution(resolutions, text);
    if (!primary) {
      const error = new Error(notFoundMessage(text));
      error.resolutions = resolutions;
      throw error;
    }
    return { address: primary.address, domain: primary.display, tld: primary.tld, resolutions };
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
  const configured = String(getEndpoint("kaspaApi") || "").replace(/\/+$/, "");
  // Testnet reads api-tn10 (iOS a67a1c2) - also while the shared endpoint defaults still say mainnet.
  if (IS_TESTNET && (!configured || configured === MAINNET_REST)) return TESTNET_REST;
  return configured || MAINNET_REST;
}

/**
 * Up to 200 transactions touching `address`, newest first - iOS fetchFullTransactionsResult
 * (one page of 200, retried at 0 / 0.6 / 2 / 5 s on HTTP 429 or 5xx only). Returns
 * { txs, complete }: complete is false when the page could not be fetched.
 * Each tx: { txid, time (ms), direction: "out" | "in" | null, amountSompi, feeSompi }.
 */
export async function history(address) {
  const url = `${restBase()}/addresses/${encodeURIComponent(address)}/full-transactions?limit=200&offset=0&resolve_previous_outpoints=light`;
  for (const delay of [0, 600, 2000, 5000]) {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    let response;
    try {
      response = await fetch(url, { headers: { Accept: "application/json" }, cache: "no-store", signal: AbortSignal.timeout(20_000) });
    } catch {
      continue;
    }
    if (response.ok) {
      const txs = await response.json().catch(() => null);
      if (!Array.isArray(txs)) return { txs: [], complete: false };
      return { txs: txs.map((tx) => describeTransaction(tx, address)), complete: true };
    }
    if (response.status !== 429 && response.status < 500) break;
  }
  return { txs: [], complete: false };
}

// iOS KaspaFullTransactionResponse.direction(for:) and feeText(): outgoing when this address
// paid in and some output goes elsewhere (amount = the smallest such output); incoming when it
// only receives (amount = everything paid to it); otherwise no direction ("Transaction").
function describeTransaction(tx, address) {
  const inputs = tx.inputs || [];
  const outputs = tx.outputs || [];
  const isSender = inputs.some((input) => input.previous_outpoint_address === address);
  const toOthers = outputs.filter((o) => o.script_public_key_address && o.script_public_key_address !== address).map((o) => BigInt(o.amount || 0));
  const toUs = outputs.filter((o) => o.script_public_key_address === address).reduce((sum, o) => sum + BigInt(o.amount || 0), 0n);
  let direction = null;
  let amountSompi = null;
  if (isSender && toOthers.length) {
    direction = "out";
    amountSompi = toOthers.reduce((min, v) => (v < min ? v : min));
  } else if (!isSender && toUs > 0n) {
    direction = "in";
    amountSompi = toUs;
  }
  let feeSompi = null;
  if (inputs.length && inputs.every((input) => input.previous_outpoint_amount != null)) {
    const totalIn = inputs.reduce((sum, input) => sum + BigInt(input.previous_outpoint_amount), 0n);
    const totalOut = outputs.reduce((sum, o) => sum + BigInt(o.amount || 0), 0n);
    if (totalIn >= totalOut) feeSompi = totalIn - totalOut;
  }
  return { txid: tx.transaction_id, time: Number(tx.block_time || 0), direction, amountSompi, feeSompi };
}

// --- UTXO labels (iOS setSpendingUtxoLabel: per address, keyed "txid:index") -----------------

function utxoLabelsKey(address) { return `kachat.utxoLabels.${address}`; }

export async function utxoLabels(address) {
  return (await getLocal(utxoLabelsKey(address))) || {};
}

export async function setUtxoLabel(address, outpointKey, label) {
  const labels = await utxoLabels(address);
  const clean = String(label || "").trim();
  if (clean) labels[outpointKey] = clean; else delete labels[outpointKey];
  await setLocal(utxoLabelsKey(address), labels);
  return labels;
}

/**
 * Which addresses have ever been touched on chain, in bulk: POST /addresses/active, 250 per
 * request, 4 at a time (iOS AddressActivityService). { address: boolean }, or null when the
 * REST server can't answer it (callers fall back to sweeping balances).
 */
export async function addressesActive(addresses) {
  const batches = [];
  for (let i = 0; i < addresses.length; i += 250) batches.push(addresses.slice(i, i + 250));
  const out = {};
  for (let i = 0; i < batches.length; i += 4) {
    const results = await Promise.all(batches.slice(i, i + 4).map(async (batch) => {
      const response = await fetch(`${restBase()}/addresses/active`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ addresses: batch }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    }).map((p) => p.catch(() => null)));
    if (results.some((r) => !Array.isArray(r))) return null;
    for (const list of results) for (const entry of list) out[entry.address] = Boolean(entry.active);
  }
  return out;
}

const USED_KEY = netKey("kachat.usedAddresses");

/**
 * Has this address ever appeared on chain? iOS spendingAddressUsedState: the REST
 * transactions-count. A "used" answer is remembered for good; null means the probe failed.
 */
const sessionUnused = new Set();

/** What is known without asking: true (used, remembered for good), false (unused this session), or null. */
export async function knownUsedState(address) {
  if (new Set((await getLocal(USED_KEY)) || []).has(address)) return true;
  return sessionUnused.has(address) ? false : null;
}

export async function addressUsed(address) {
  const used = new Set((await getLocal(USED_KEY)) || []);
  if (used.has(address)) return true;
  try {
    const response = await fetch(`${restBase()}/addresses/${encodeURIComponent(address)}/transactions-count`, { cache: "no-store", signal: AbortSignal.timeout(8000) });
    if (!response.ok) return null;
    const json = await response.json();
    const isUsed = Number(json?.total ?? 0) > 0;
    if (isUsed) { used.add(address); await setLocal(USED_KEY, [...used]); } else sessionUnused.add(address);
    return isUsed;
  } catch {
    return null;
  }
}

// --- Spending addresses -------------------------------------------------------------------

async function cacheSpendingAddress(accountId, index, address) {
  const cached = (await cachedAddresses(accountId)) || { accountId, main: null, spending: {} };
  cached.spending = { ...(cached.spending || {}), [index]: address };
  await setLocal(addressCacheKey(accountId), cached);
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
    await setLocal(addressCacheKey(account.id), { ...all, accountId: account.id, spending: addresses });
  }
  const indexes = Array.from({ length: state.maxIndex + 1 }, (_, i) => i);
  const balancesByAddress = await balancesFor(indexes.map((i) => addresses[i]));
  return {
    state,
    rows: indexes.map((index) => ({
      index,
      address: addresses[index],
      label: labelFor(state, index),
      customLabel: customLabel(state, index),
      hidden: state.hidden.includes(index),
      primary: index === state.activeIndex,
      balanceSompi: balancesByAddress[addresses[index]] ?? 0n,
    })),
  };
}

/** The address's own label, or "" - iOS SpendingAddressEntry.label. */
export function customLabel(state, index) {
  return String(state.labels?.[index] ?? state.labels?.[String(index)] ?? "").trim();
}

/** iOS displayLabel: the label you gave it, else "Address #<index>". */
export function labelFor(state, index) {
  return customLabel(state, index) || `Address #${index}`;
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
  if (clean) labels[index] = clean; else delete labels[index];
  return saveSpendingState(account.id, { labels });
}

export async function setPrimarySpending(index) {
  const { account, state } = await activeState();
  const hidden = state.hidden.filter((i) => i !== index);
  return saveSpendingState(account.id, { activeIndex: index, maxIndex: Math.max(state.maxIndex, index), hidden });
}

/**
 * iOS "Generate New Spending Address" (ManageAddressesView.generateNew): a hidden address that
 * is not the primary, holds nothing and was never used is recycled, lowest index first - one
 * whose used-state is unknown gets one transactions-count probe, all probes sharing a 2 s
 * budget; when the budget runs out (or a probe fails) the chain extends by one instead.
 */
export async function generateSpendingAddress() {
  const { account, state } = await activeState();
  const cached = (await cachedAddresses(account.id))?.spending || {};
  const candidates = [...state.hidden].sort((a, b) => a - b).filter((i) => i !== state.activeIndex && i <= state.maxIndex);
  if (candidates.length) {
    const addresses = { ...(await spendingAddressRange(0, state.maxIndex + 1)), ...cached };
    const balances = await balancesFor(candidates.map((i) => addresses[i]));
    const deadline = Date.now() + 2000;
    for (const index of candidates) {
      const address = addresses[index];
      if ((balances[address] ?? 0n) > 0n) continue;
      let used = await knownUsedState(address);
      if (used == null) {
        if (Date.now() >= deadline) break;
        used = await Promise.race([addressUsed(address), new Promise((resolve) => setTimeout(() => resolve(null), Math.max(0, deadline - Date.now())))]);
        if (used == null) break;
      }
      if (used === false) {
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

/** Extends the revealed range to `index` (Address Visibility past the end): the ones between are hidden. */
export async function revealSpendingAddress(index) {
  const { account, state } = await activeState();
  if (index <= state.maxIndex) return setSpendingHidden(index, false);
  const hidden = new Set(state.hidden);
  for (let i = state.maxIndex + 1; i < index; i += 1) hidden.add(i);
  hidden.delete(index);
  const range = await spendingAddressRange(state.maxIndex + 1, index - state.maxIndex);
  const cached = (await cachedAddresses(account.id)) || { accountId: account.id, main: null, spending: {} };
  await setLocal(addressCacheKey(account.id), { ...cached, spending: { ...(cached.spending || {}), ...range } });
  return saveSpendingState(account.id, { maxIndex: index, hidden: [...hidden] });
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
 * iOS "Discover Addresses" (WalletManager.discoverSpendingAddresses). A match is an address
 * holding Kaspa or a KNS domain.
 *   fast path   indexes 0..999: one bulk /addresses/active pass says which were ever touched;
 *               UTXOs for the touched ones in one sweep; KNS for touched, unfunded ones below
 *               #200.
 *   fallback    (the REST server can't answer /addresses/active) balances 100 at a time up to
 *               #5000, stopping past #1000 after 60 misses in a row; KNS below #200.
 * Matches are un-hidden; when the highest is past the revealed range, the range grows to it and
 * the empty indexes in between are hidden. onProgress({ checkingIndex, foundCount }).
 */
export async function discoverSpendingAddresses(onProgress = () => {}) {
  const { account, state } = await activeState();
  const DEEP_FLOOR = 1000;
  const MAX_INDEX = 5000;
  const BATCH = 100;
  const KNS_DEPTH = 200;
  const GAP = 60;
  const found = new Set();
  const addresses = {};
  // Any name service (iOS 7a5b157): .kas through KNS, .k and .kaspa through their own APIs.
  const knsOwns = (address) => ownsAnyName(address, async (a) => ((await getAddressInfo(a, knsOptions()))?.allDomains || []).length > 0);

  onProgress({ checkingIndex: 0, foundCount: 0 });
  Object.assign(addresses, await spendingAddressRange(0, DEEP_FLOOR));
  const floorList = Array.from({ length: DEEP_FLOOR }, (_, i) => addresses[i]);
  const active = await addressesActive(floorList);
  if (active) {
    const touched = Array.from({ length: DEEP_FLOOR }, (_, i) => i).filter((i) => active[addresses[i]]);
    onProgress({ checkingIndex: DEEP_FLOOR - 1, foundCount: 0 });
    const balances = await balancesFor(touched.map((i) => addresses[i]));
    const knsChecks = [];
    for (const index of touched) {
      if ((balances[addresses[index]] ?? 0n) > 0n) found.add(index);
      else if (index < KNS_DEPTH) knsChecks.push(index);
    }
    for (let i = 0; i < knsChecks.length; i += 6) {
      const slice = knsChecks.slice(i, i + 6);
      const owns = await Promise.all(slice.map((index) => knsOwns(addresses[index])));
      slice.forEach((index, j) => { if (owns[j]) found.add(index); });
      onProgress({ checkingIndex: slice[slice.length - 1], foundCount: found.size });
    }
  } else {
    let misses = 0;
    for (let start = 0; start < MAX_INDEX; start += BATCH) {
      if (start >= DEEP_FLOOR) Object.assign(addresses, await spendingAddressRange(start, BATCH));
      const indexes = Array.from({ length: BATCH }, (_, i) => start + i);
      const balances = await balancesFor(indexes.map((i) => addresses[i]));
      for (const index of indexes) {
        let hit = (balances[addresses[index]] ?? 0n) > 0n;
        if (!hit && index < KNS_DEPTH) hit = await knsOwns(addresses[index]);
        if (hit) { found.add(index); misses = 0; } else misses += 1;
      }
      onProgress({ checkingIndex: start + BATCH - 1, foundCount: found.size });
      if (start + BATCH >= DEEP_FLOOR && misses >= GAP) break;
    }
  }

  const highest = Math.max(state.maxIndex, ...found);
  const hidden = new Set(state.hidden);
  for (let index = state.maxIndex + 1; index <= highest; index += 1) if (!found.has(index)) hidden.add(index);
  for (const index of found) hidden.delete(index);
  await saveSpendingState(account.id, { maxIndex: highest, hidden: [...hidden] });
  const cached = (await cachedAddresses(account.id)) || { accountId: account.id, main: null, spending: {} };
  const spending = { ...(cached.spending || {}) };
  for (let index = 0; index <= highest; index += 1) if (addresses[index]) spending[index] = addresses[index];
  await setLocal(addressCacheKey(account.id), { ...cached, spending });
  return found.size;
}

// --- Explorer -----------------------------------------------------------------------------

// The block explorer "view transaction" links open in - Settings > Connection > Kaspa Explorer,
// the same two choices as iOS (KaspaExplorer), explorer.kaspa.org by default.
export const EXPLORERS = Object.freeze({
  kaspaOrg: { name: "explorer.kaspa.org", tx: "https://explorer.kaspa.org/txs/", address: "https://explorer.kaspa.org/addresses/" },
  kaspaStream: { name: "kaspa.stream", tx: "https://kaspa.stream/transactions/", address: "https://kaspa.stream/addresses/" },
});
let explorerId = "kaspaOrg";
export function useExplorer(id) { explorerId = EXPLORERS[id] ? id : "kaspaOrg"; }
export function currentExplorer() { return explorerId; }
// On testnet every link goes to tn10.kaspa.stream, whichever explorer is picked (iOS 421a832).
export function explorerTxUrl(txid) { return IS_TESTNET ? `https://tn10.kaspa.stream/transactions/${txid}` : `${EXPLORERS[explorerId].tx}${txid}`; }
export function explorerAddressUrl(address) { return IS_TESTNET ? `https://tn10.kaspa.stream/addresses/${encodeURIComponent(address)}` : `${EXPLORERS[explorerId].address}${address}`; }

// --- KNS domains ------------------------------------------------------------------------------
//
// Your Domains (iOS KNSDomainsListView): the chatting address's verified domains, newest first,
// and which one is primary. Set as Primary is a signed message to the KNS API (no transaction);
// Send is the on-chain commit/reveal transfer inscription. No inscribing new domains and no
// profile editing here - profiles are moving to .kachat names.

/** { domains:[{fullName, inscriptionId, status, createdAt}], primaryDomain } - cached, or fetched. */
export function cachedDomains(address) {
  const info = peekAddressInfo(address);
  return info ? { domains: info.allDomains || [], primaryDomain: info.primaryDomain || null } : null;
}

export async function domains(address, { force = false } = {}) {
  const info = force ? await fetchAddressInfo(address, knsOptions()) : await getAddressInfo(address, knsOptions());
  return { domains: info?.allDomains || [], primaryDomain: info?.primaryDomain || null };
}

// The engine's KNS write path expects its wallet object; this is the same shape for one source.
async function knsEngine(source) {
  const from = await sourceWallet(source);
  const k = await kaspa();
  const engine = {
    kaspa: k,
    rpc: await connection(),
    address: from.address,
    privateKey: new k.PrivateKey(from.privateKeyHex),
    privateKeyHex: from.privateKeyHex,
    async connect() { engine.rpc = await connection(); return engine.rpc; },
    withRpc: (fn) => withRpc(fn),
  };
  return engine;
}

/** Makes `domainId` the chatting address's primary name. Throws with the API's reason. */
export async function setPrimaryDomain(domainId) {
  const engine = await knsEngine({ kind: "main" });
  await setKnsPrimaryDomain({ engine, domainId, baseUrl: knsApiUrl() });
  clearKnsCache(engine.address);
}

/**
 * Transfers a domain from the chatting address: commit, then reveal, then waits (up to 90 s)
 * for the KNS API to show the new owner. onStatus gets the engine's stage names.
 */
export async function transferDomain({ domain, assetId, toAddress, priorityFeeSompi, source = { kind: "main" }, onStatus = () => {} }) {
  const engine = await knsEngine(source);
  // From the PRIMARY spending address the change goes to a fresh index and the primary moves
  // there once it is accepted (iOS KNSDomainTransferService fromSpendingAddressIndex).
  let fresh = null;
  if (source?.kind === "spending") {
    const { account, state } = await activeState();
    if (source.index === state.activeIndex) {
      const index = Math.max(state.maxIndex, source.index) + 1;
      fresh = { accountId: account.id, index, address: (await spendingAddressRange(index, 1))[index] };
    }
  }
  const result = await knsTransferDomain({
    engine, domain, assetId, toAddress,
    signer: { privateKey: engine.privateKey, address: engine.address },
    changeAddress: fresh?.address || null,
    revealPriorityFeeSompi: priorityFeeSompi,
    onStatus,
    log: (...parts) => console.info("[KaChat Wallet]", ...parts),
  });
  if (fresh) {
    await saveSpendingState(fresh.accountId, { activeIndex: fresh.index, maxIndex: fresh.index });
    await cacheSpendingAddress(fresh.accountId, fresh.index, fresh.address);
  }
  return result;
}

// --- Chatting address picker (iOS ChattingAddressPickerView) ---------------------------------

/**
 * Identity addresses `start..start+count-1` of the active account's family, each with its
 * balance and KNS domains. Listed when they hold something, are index 0, or are current.
 */
export async function scanIdentityAddresses(start = 0, count = 50) {
  const account = await activeAccountSecrets();
  const k = await kaspa();
  const rows = [];
  for (let index = start; index < start + count; index += 1) {
    const derived = await importMnemonicWithFamily(k, account.mnemonic, account.passphrase, { family: account.family, index });
    rows.push({ index, address: derived.address });
  }
  const balancesByAddress = await balancesFor(rows.map((r) => r.address));
  // KNS a few at a time: the API rate-limits bursts.
  const queue = [...rows];
  const worker = async () => {
    for (let row = queue.shift(); row; row = queue.shift()) {
      try {
        const info = await getAddressInfo(row.address, knsOptions());
        row.domains = info?.allDomains || [];
        row.primaryDomain = info?.primaryDomain || null;
      } catch {
        row.domains = [];
      }
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  // .k and .kaspa too: an identity can live at an address whose only trace is a name there.
  const otherNames = await ownedNamesOfMany(rows.map((r) => r.address));
  for (const row of rows) {
    row.balanceSompi = balancesByAddress[row.address] ?? 0n;
    row.otherNames = otherNames[row.address] || [];
  }
  return { rows, currentIndex: account.identityIndex || 0 };
}

// --- Website connect --------------------------------------------------------------------------

/** The chatting address and public key a website sees for an account. */
export async function identityFor(accountId) {
  const from = await sourceWallet({ kind: "main", accountId });
  const k = await kaspa();
  return { address: from.address, publicKey: String(new k.PrivateKey(from.privateKeyHex).toPublicKey().toString()) };
}

/**
 * Signs `message` with the account's chatting key, the Kaspa wallet standard (Schnorr over
 * blake2b("PersonalMessageSigningHash", message)) - what KasWare's signMessage produces.
 */
export async function signMessage(accountId, message) {
  const from = await sourceWallet({ kind: "main", accountId });
  const k = await kaspa();
  return String(k.signMessage({ message: String(message), privateKey: from.privateKeyHex }));
}

// --- Cold Storage (watch-only kpub accounts) and the KSPT signing engine ----------------------

/** A KasSigner kpub, checked by deriving its first address; null when it isn't one. */
export async function validateKpub(kpub) {
  const trimmed = String(kpub || "").trim();
  if (!trimmed) return null;
  try {
    const k = await kaspa();
    k.PublicKeyGenerator.fromXPub(trimmed).receiveAddressAsStrings(NETWORK_ID, 0, 1);
    return trimmed;
  } catch {
    return null;
  }
}

/** Receive-chain addresses start..end-1 of a kpub (iOS: kpub -> 0 -> i; change chain unused). */
export async function kpubAddresses(kpub, start, end) {
  const k = await kaspa();
  // The same kpub gives kaspatest: addresses on testnet (iOS: only the prefix changes).
  return k.PublicKeyGenerator.fromXPub(String(kpub).trim()).receiveAddressAsStrings(NETWORK_ID, start, end);
}

/**
 * The engine shape ui/kspt.js (the KSPT codec, unsigned build, max, compound, broadcast) was
 * written against on desktop: { kaspa, connect, withRpc, balanceForAddress }.
 */
export async function ksptEngine() {
  const k = await kaspa();
  return {
    kaspa: k,
    connect: () => connection(),
    withRpc: (fn) => withRpc(fn),
    balanceForAddress: async (address) => getBalance(k, await connection(), address),
  };
}

/** Bulk "was this ever used" for the cold account screen and its visibility list. */
export { knownUsedState as usedStateKnown };
