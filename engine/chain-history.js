// An address's history from the Kaspa REST API, in the indexer's row shapes, for while the indexer
// is down (iOS 4f8e14bb chainTransactions and friends). A node keeps no history by address.
import { getEndpoint } from "./endpoints.js";

export const CHAIN_PAGE_SIZE = 100;
/** 2,000 transactions per address; past this a window is left to the indexer when it's back. */
export const CHAIN_MAX_PAGES = 20;
const CACHE_LIFETIME_MS = 20_000;
/** One request every quarter second at most: an outage hits everyone at once, on the same server. */
const REQUEST_SPACING_MS = 250;
const BACK_OFF_MS = 30_000;

const hexOfText = (text) => Array.from(new TextEncoder().encode(String(text)), (b) => b.toString(16).padStart(2, "0")).join("");
const textOfHex = (hex) => {
  if (!/^(?:[0-9a-f]{2})+$/i.test(String(hex || ""))) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(String(hex).match(/../g), (pair) => parseInt(pair, 16)));
  } catch { return null; }
};

const HANDSHAKE_PREFIXES = ["kchat:1:handshake:", "ciph_msg:1:handshake:"].map(hexOfText);

/** REST rows as `{ txId, blockTime, payloadHex, senders: Set, outputs: [{address, amount}], raw }`,
 *  accepted ones only. Also returns the page's row count, which says whether more follow. */
export function parseChainRows(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const transactions = [];
  for (const row of list) {
    if (row?.is_accepted === false) continue;
    const txId = String(row?.transaction_id || "");
    const blockTime = Number(row?.block_time);
    if (!txId || !Number.isFinite(blockTime)) continue;
    const senders = new Set((Array.isArray(row?.inputs) ? row.inputs : [])
      .map((input) => String(input?.previous_outpoint_address || "").toLowerCase()).filter(Boolean));
    const outputs = (Array.isArray(row?.outputs) ? row.outputs : []).flatMap((output) => {
      const address = String(output?.script_public_key_address || "").toLowerCase();
      if (!address || output?.amount == null) return [];
      return [{ address, amount: output.amount }];
    });
    transactions.push({ txId, blockTime, payloadHex: String(row?.payload || "").toLowerCase(), senders, outputs, raw: row });
  }
  return { transactions, rows: list.length };
}

export function createChainHistory({ now = () => Date.now(), sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), fetchImpl = (...args) => fetch(...args), restBase = () => getEndpoint("kaspaApi") } = {}) {
  const cache = new Map(); // address -> { since, at, transactions }
  const proven = new Set();
  let nextRequestAt = 0;
  let blockedUntil = 0;
  const reserveSlot = async () => {
    const at = now();
    if (at < blockedUntil) throw new Error("The Kaspa REST API is busy");
    const slot = Math.max(at, nextRequestAt);
    nextRequestAt = slot + REQUEST_SPACING_MS;
    if (slot > at) await sleep(slot - at);
  };
  /** `address`'s accepted transactions since `since` (ms), oldest first. Throws when the history runs
   *  past the page cap before reaching `since`: a partial read would move the caller's cursor past
   *  the part it never saw. */
  async function chainTransactions(address, since = 0) {
    const key = String(address || "").toLowerCase();
    const floor = Math.max(0, Number(since) || 0);
    const held = cache.get(key);
    if (held && held.since <= floor && now() - held.at < CACHE_LIFETIME_MS) return held.transactions.filter((tx) => tx.blockTime >= floor);
    const root = String(restBase() || "").replace(/\/+$/, "");
    const found = [];
    let reachedStart = false;
    for (let page = 0; page < CHAIN_MAX_PAGES; page += 1) {
      await reserveSlot();
      const url = `${root}/addresses/${encodeURIComponent(key)}/full-transactions?limit=${CHAIN_PAGE_SIZE}&offset=${page * CHAIN_PAGE_SIZE}&resolve_previous_outpoints=light`;
      const response = await fetchImpl(url, { headers: { Accept: "application/json" }, cache: "no-store" });
      if (response.status !== 200) {
        if (response.status === 429 || response.status >= 500) blockedUntil = now() + BACK_OFF_MS;
        throw new Error(`The Kaspa REST API answered ${response.status}`);
      }
      const parsed = parseChainRows(await response.json());
      found.push(...parsed.transactions);
      if (parsed.rows < CHAIN_PAGE_SIZE || (floor > 0 && parsed.transactions.some((tx) => tx.blockTime < floor))) {
        reachedStart = true;
        break;
      }
    }
    if (!reachedStart) throw new Error("Too much history to read from the chain");
    const inOrder = found.sort((a, b) => (a.blockTime - b.blockTime) || (a.txId < b.txId ? -1 : a.txId > b.txId ? 1 : 0));
    if (cache.size > 500) cache.clear();
    cache.set(key, { since: floor, at: now(), transactions: inOrder });
    return inOrder.filter((tx) => tx.blockTime >= floor);
  }
  /** Only rows whose author's input signature checks out: the REST listing's addresses are its word.
   *  A row that can't be proven now comes back from the indexer when it recovers. `verify(tx)` gives
   *  `{ check, sender }`. */
  async function provenByAuthor(items, verify) {
    const kept = [];
    for (const { row, tx, author } of items) {
      if (proven.has(tx.txId)) { kept.push(row); continue; }
      let verdict = null;
      try { verdict = await verify(tx.raw, tx.txId); } catch { verdict = null; }
      if (verdict?.check === "valid" && String(verdict.sender || "").toLowerCase() === String(author).toLowerCase()) {
        if (proven.size > 5000) proven.clear();
        proven.add(tx.txId);
        kept.push(row);
      }
    }
    return kept;
  }
  /** Handshakes `address` sent or received, as `/handshakes/by-*` rows. */
  async function handshakeRows({ address, sent, since = 0, verify }) {
    const me = String(address).toLowerCase();
    const items = [];
    for (const tx of await chainTransactions(address, since)) {
      const prefix = HANDSHAKE_PREFIXES.find((candidate) => tx.payloadHex.startsWith(candidate));
      if (!prefix || tx.senders.has(me) !== Boolean(sent)) continue;
      const sender = sent ? address : ([...tx.senders].sort()[0] || "");
      const receiver = sent ? (tx.outputs.find((output) => output.address !== me)?.address || "") : address;
      if (!sender || !receiver) continue;
      items.push({ tx, author: sender, row: { tx_id: tx.txId, sender, receiver, block_time: tx.blockTime, message_payload: tx.payloadHex.slice(prefix.length), source: "kaspa-rest" } });
    }
    return provenByAuthor(items, verify);
  }
  /** `kchat:1:comm:ALIAS:BASE64` as a `/contextual-messages/by-sender` row, the payload hex(BASE64).
   *  Only what `address` itself spent into: a message is a transaction from its author to themselves. */
  async function contextualRows({ address, alias, since = 0, verify }) {
    const me = String(address).toLowerCase();
    const items = [];
    for (const tx of await chainTransactions(address, since)) {
      if (!tx.senders.has(me) || !tx.payloadHex) continue;
      const text = textOfHex(tx.payloadHex);
      if (!text || !(text.startsWith("kchat:1:comm:") || text.startsWith("ciph_msg:1:comm:"))) continue;
      const parts = text.split(":");
      if (parts.length < 5) continue;
      const body = parts.slice(4).join(":");
      if (parts[3] !== alias || !body) continue;
      items.push({ tx, author: address, row: { tx_id: tx.txId, sender: address, block_time: tx.blockTime, message_payload: hexOfText(body) } });
    }
    return provenByAuthor(items, verify);
  }
  /** A self-stash scope as `/self-stash/by-owner` rows. Self-stash is decrypted with this wallet's
   *  own key, which is its proof. */
  async function selfStashRows({ owner, scope, since = 0 }) {
    const me = String(owner).toLowerCase();
    const prefixes = ["kchat:1:self_stash:", "ciph_msg:1:self_stash:"].map((head) => hexOfText(`${head}${scope}:`));
    const rows = [];
    for (const tx of await chainTransactions(owner, since)) {
      const prefix = prefixes.find((candidate) => tx.payloadHex.startsWith(candidate));
      if (!prefix || !tx.senders.has(me)) continue;
      rows.push({ tx_id: tx.txId, owner, block_time: tx.blockTime, stashed_data: tx.payloadHex.slice(prefix.length) });
    }
    return rows;
  }
  return { chainTransactions, handshakeRows, contextualRows, selfStashRows };
}

export const chainHistory = createChainHistory();
