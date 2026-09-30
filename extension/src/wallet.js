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
} from "../../engine/wallet.js";
import { createRpc, probeRpc, disconnectRpc } from "../../engine/rpc.js";
import { getBalance } from "../../engine/transactions.js";
import { fetchKasPrice, peekKasPrice } from "../../engine/prices.js";
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

/** A 24-word phrase for a new wallet, from the Kaspa SDK's own BIP39 generator. */
export async function newRecoveryPhrase() {
  return generateMnemonicPhrase(await kaspa(), 24);
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
  return { activeIndex, maxIndex, hidden, labels };
}

export async function saveSpendingState(accountId, patch) {
  const next = { ...(await spendingState(accountId)), ...patch };
  next.maxIndex = Math.max(next.activeIndex, next.maxIndex);
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
export async function connection(log = () => {}) {
  if (rpc && await probeRpc(rpc)) return rpc;
  if (!rpcPromise) {
    rpcPromise = (async () => {
      if (rpc) { await disconnectRpc(rpc); rpc = null; }
      const k = await kaspa();
      rpc = await createRpc(k, log);
      return rpc;
    })().finally(() => { rpcPromise = null; });
  }
  return rpcPromise;
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
