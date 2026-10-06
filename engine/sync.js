// Real Kasia indexer synchronization plus the existing local preview helper.
// Step 27 queries the public Kasia indexer for COMM messages sent by the
// selected contact, decrypts messages intended for the active session wallet,
// and returns normalized incoming message objects to the UI.

import { ADDRESS_PREFIX, NETWORK, KAS_UNIT } from "./network.js";
import {
  base64ToHex,
  fromHex,
  makeKasiaCommPayload,
  parseKasiaPayloadHex,
  selfStashEncryptedCandidates,
  parseSelfStashPayload,
  paymentPayloadEncryptedHex,
} from "./kasia-protocol.js";
import { getEndpoint, ENDPOINT_DEFAULTS } from "./endpoints.js";
import { kasTextFromSompi } from "./amounts.js";
import { decodeAddress, AddressVersion } from "./kachat-names/registry-state.js";

// Kept as a named export for callers, but the effective default now comes from
// the configurable endpoint registry (Settings > Connectivity).
export const DEFAULT_KASIA_INDEXER_URL = ENDPOINT_DEFAULTS.kasiaIndexer;
export const DEFAULT_KASIA_ALIAS = "KaChat";

function shortHash(input) {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function textToHex(value) {
  return Array.from(new TextEncoder().encode(String(value || "")))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** A pay-to-script-hash address (`kaspa:p…` / `kaspatest:p…`, version byte 8): a contract, never a
 *  chat partner (iOS ChatService.isScriptAddress). Any prefix; false for anything that isn't a valid
 *  address. */
export function isScriptAddress(address) {
  const clean = String(address || "").trim();
  if (!clean) return false;
  const decoded = decodeAddress(clean.toLowerCase());
  return Boolean(decoded) && decoded.version === AddressVersion.scriptHash;
}

const KACHAT_CONTRACT_PAYLOAD_PREFIXES = ["kchat:1:name:", "kchat:1:offer:"].map((value) => textToHex(value));

function restOutputAddress(output) {
  return String(
    output?.script_public_key_address || output?.scriptPublicKeyAddress || output?.address ||
    output?.script_public_key?.address || output?.scriptPublicKey?.address || "",
  ).trim();
}

function restInputAddress(input) {
  return String(
    input?.previous_outpoint_address || input?.previousOutpointAddress || input?.previous_outpoint?.address ||
    input?.previous_outpoint?.resolved_transaction_output?.script_public_key_address ||
    input?.previous_outpoint?.resolvedTransactionOutput?.scriptPublicKeyAddress ||
    input?.resolved_previous_outpoint?.script_public_key_address ||
    input?.resolvedPreviousOutpoint?.scriptPublicKeyAddress || "",
  ).trim();
}

/**
 * A `.kachat` registry or offer transaction, or any other contract spend (iOS 32fdaa4
 * isKachatContractTransaction): a REST transaction with a `kchat:1:name:` / `kchat:1:offer:`
 * payload, or one that pays to or from a script (P2SH) address - a name's commit and 1 KAS bond,
 * the gaps, an offer's locked KAS, a KNS commit/reveal. A chat partner is always a key address, so
 * such a transaction is never a chat payment (it still shows in the wallet history).
 */
export function isKachatContractTransaction(tx) {
  let payload = String(tx?.payload || "").replace(/^0x/i, "").trim().toLowerCase();
  if (payload.startsWith("6a") && payload.length >= 4) payload = payload.slice(4);
  if (payload && KACHAT_CONTRACT_PAYLOAD_PREFIXES.some((prefix) => payload.startsWith(prefix))) return true;
  const outputs = Array.isArray(tx?.outputs) ? tx.outputs : [];
  if (outputs.some((output) => isScriptAddress(restOutputAddress(output)))) return true;
  const inputs = Array.isArray(tx?.inputs) ? tx.inputs : [];
  return inputs.some((input) => isScriptAddress(restInputAddress(input)));
}

function normalizeBaseUrl(value) {
  const raw = String(value || DEFAULT_KASIA_INDEXER_URL).trim().replace(/\/+$/, "");
  // Testnet has no KaChat indexer yet: blank means none (never the mainnet one).
  if (!raw) throw new Error("No KaChat indexer on this network yet.");
  if (!/^https?:\/\//i.test(raw)) throw new Error("Indexer URL must begin with http:// or https://");
  return raw;
}

function encryptedHexFromIndexerPayload(messagePayloadHex) {
  const clean = String(messagePayloadHex || "").replace(/^0x/i, "").trim();
  if (!clean || clean.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(clean)) {
    throw new Error("Indexer returned an invalid message payload.");
  }

  // The indexer returns the bytes after kchat:1:comm:<alias>: (or the legacy, read-only
  // ciph_msg:1:comm:<alias>:) as hex.
  // Kasia currently places base64(encrypted bytes) there, so decode the ASCII
  // body first and then convert the base64 bytes back to encrypted hex.
  const asciiBody = fromHex(clean).trim();
  const base64Candidate = asciiBody.replace(/\s+/g, "");
  if (base64Candidate && /^[A-Za-z0-9+/]+={0,2}$/.test(base64Candidate)) {
    const decoded = base64ToHex(base64Candidate);
    if (decoded) return { encryptedHex: decoded, base64Body: base64Candidate };
  }

  // Compatibility fallback for indexers/clients that store raw encrypted bytes.
  return { encryptedHex: clean, base64Body: null };
}

// How far behind a cursor every fetch starts (iOS ChatService's live-tail rewind buffer).
export const SYNC_REWIND_MS = 90 * 1000;
export function rewoundCursor(cursor) {
  const value = Number(cursor || 0);
  return value > 0 ? Math.max(0, value - SYNC_REWIND_MS) : 0;
}

export function buildConversationSyncPlan({
  conversationId,
  contactAddress,
  walletAddress,
  knownTxids = [],
  cursor = 0,
  indexerUrl = DEFAULT_KASIA_INDEXER_URL,
  alias = DEFAULT_KASIA_ALIAS,
} = {}) {
  return {
    conversationId,
    contactAddress,
    walletAddress,
    knownTxids: Array.isArray(knownTxids) ? knownTxids.filter(Boolean) : [],
    cursor: Number.isFinite(Number(cursor)) ? Number(cursor) : 0,
    indexerUrl: normalizeBaseUrl(indexerUrl),
    alias: String(alias || DEFAULT_KASIA_ALIAS).slice(0, 16),
    transport: "kasia-indexer",
    network: NETWORK,
    createdAt: Date.now(),
  };
}

export async function testKasiaIndexer(indexerUrl = DEFAULT_KASIA_INDEXER_URL) {
  const baseUrl = normalizeBaseUrl(indexerUrl);
  const response = await fetch(`${baseUrl}/metrics`, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`Indexer health check failed (${response.status}).`);
  const metrics = await response.json();
  return { baseUrl, metrics };
}

export async function syncConversationFromIndexer({
  conversationId,
  contact,
  walletAddress,
  privateKeyHex,
  decryptMessage,
  knownTxids = [],
  cursor = 0,
  indexerUrl = DEFAULT_KASIA_INDEXER_URL,
  alias = DEFAULT_KASIA_ALIAS,
  limit = 50,
} = {}) {
  if (!conversationId) throw new Error("conversationId is required for sync.");
  if (!contact?.address?.startsWith(ADDRESS_PREFIX)) throw new Error("A kaspa: contact address is required for sync.");
  if (!walletAddress?.startsWith(ADDRESS_PREFIX)) throw new Error("Load a wallet before syncing real messages.");
  if (!privateKeyHex) throw new Error("The active session private key is required to decrypt messages.");
  if (typeof decryptMessage !== "function") throw new Error("Kasia cipher decryptor is not available.");

  const plan = buildConversationSyncPlan({
    conversationId,
    contactAddress: contact.address,
    walletAddress,
    knownTxids,
    cursor,
    indexerUrl,
    alias,
  });

  const query = new URLSearchParams({
    address: contact.address,
    alias: textToHex(plan.alias),
    // Always a buffer behind the cursor, never cursor + 1: the indexer does not surface messages
    // in block-time order (acceptance in the DAG is not monotonic, and an indexer catching up
    // serves what it has), so a message served late would otherwise be skipped for good. The
    // overlap comes back and is deduped by txid.
    block_time: String(rewoundCursor(plan.cursor)),
    limit: String(Math.max(1, Math.min(50, Number(limit) || 50))),
  });
  const url = `${plan.indexerUrl}/contextual-messages/by-sender?${query.toString()}`;
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });

  if (!response.ok) {
    let detail = "";
    try {
      const body = await response.json();
      detail = body?.error ? ` ${body.error}` : "";
    } catch {}
    throw new Error(`Kasia indexer request failed (${response.status}).${detail}`);
  }

  const rows = await response.json();
  if (!Array.isArray(rows)) throw new Error("Kasia indexer returned an unexpected response.");

  const known = new Set(plan.knownTxids);
  const messages = [];
  let decryptFailures = 0;
  let nextCursor = plan.cursor;

  const ordered = [...rows].sort((a, b) => Number(a.block_time || 0) - Number(b.block_time || 0));
  for (const row of ordered) {
    const txid = String(row.tx_id || "");
    const blockTime = Number(row.block_time || 0);
    if (blockTime > nextCursor) nextCursor = blockTime;
    if (!txid || known.has(txid)) continue;

    try {
      const payload = encryptedHexFromIndexerPayload(row.message_payload);
      const clearText = await decryptMessage(payload.encryptedHex, privateKeyHex);
      if (typeof clearText !== "string" || !clearText.length) throw new Error("Decrypted message was empty.");

      const createdAt = blockTime > 0 ? blockTime : Date.now();
      // Self-chat (contact IS you): every message here is one YOU sent to yourself, so it's
      // outgoing on every device — not "incoming from a stranger". Decryption already scopes the
      // by-sender(self) query to self→self messages (messages to others fail with your key).
      const isSelfChat = contact.address === walletAddress;
      messages.push({
        id: `indexer-${txid}`,
        conversationId,
        contactId: contact.id,
        direction: isSelfChat ? "outgoing" : "incoming",
        text: clearText,
        sender: row.sender || contact.address,
        receiver: walletAddress,
        status: row.accepting_daa_score != null ? "confirmed" : "pending",
        txid,
        daaScore: row.accepting_daa_score != null ? String(row.accepting_daa_score) : null,
        confirmations: row.accepting_daa_score != null ? 1 : 0,
        network: NETWORK,
        payloadHex: String(row.message_payload || ""),
        payloadBytes: Math.ceil(String(row.message_payload || "").length / 2),
        encryptedHex: payload.encryptedHex,
        messageType: "comm",
        transport: "kasia-indexer",
        protocol: "kasia",
        protocolVersion: 1,
        recipientAlias: plan.alias,
        createdAt,
        updatedAt: Date.now(),
        acceptingBlock: row.accepting_block || null,
      });
      known.add(txid);
    } catch {
      // The sender+alias endpoint can contain messages encrypted to another
      // recipient. Decryption failure is therefore a normal filtering signal.
      decryptFailures += 1;
    }
  }

  return {
    plan,
    cursor: plan.cursor,
    nextCursor,
    scanned: true,
    scannedCount: rows.length,
    decryptFailures,
    found: messages.length,
    messages,
    note: messages.length
      ? `Real sync received ${messages.length} encrypted Kasia message${messages.length === 1 ? "" : "s"}.`
      : `Real sync complete: no new decryptable messages (${rows.length} indexed row${rows.length === 1 ? "" : "s"} checked).`,
  };
}

// --- Hybrid alias read (XP-003; iOS DETERMINISTIC_ALIASES.md §3.2/§4.2) ------------------------
// A peer whose handshake carried a legacy/random alias (old Kasia web, Android builds that send a
// fresh random alias) writes its messages to us under THAT alias, not our deterministic myAlias.
// iOS keeps such contacts in hybrid mode and fetches both; this is the desktop equivalent.

/** Whether `alias` can be a wire alias: what goes between `comm:` and the next `:` (Kasia's are
 *  12 hex; the plan truncates to 16, so anything longer could never match a row anyway). */
export function isUsableWireAlias(alias) {
  return /^[0-9A-Za-z_-]{1,16}$/.test(String(alias || ""));
}

/** Clean, de-duplicated legacy incoming aliases (at most `max`), dropping `exclude`. */
export function legacyWireAliases(list, { exclude = [], max = 4 } = {}) {
  const skip = new Set((Array.isArray(exclude) ? exclude : [exclude]).map((value) => String(value || "")));
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const alias = String(raw || "").trim();
    if (!isUsableWireAlias(alias) || skip.has(alias) || out.includes(alias)) continue;
    out.push(alias);
    if (out.length >= max) break;
  }
  return out;
}

/** syncConversationFromIndexer under the deterministic alias, plus every legacy incoming alias.
 *  Messages are de-duplicated by txid across the fetches. The returned cursor never passes a
 *  window an alias has not been read through: an alias that came back with a full page caps it
 *  at that page's newest row, and an alias whose fetch failed holds it where it started. */
export async function syncConversationFromIndexerWithLegacyAliases({ legacyAliases = [], ...details } = {}) {
  const primary = await syncConversationFromIndexer(details);
  const extras = legacyWireAliases(legacyAliases, { exclude: [primary.plan.alias] });
  if (!extras.length) return primary;

  const pageLimit = Math.max(1, Math.min(50, Number(details.limit) || 50));
  const known = new Set([...(Array.isArray(details.knownTxids) ? details.knownTxids : []), ...primary.messages.map((m) => m.txid)].filter(Boolean));
  const messages = [...primary.messages];
  let scannedCount = Number(primary.scannedCount || 0);
  let decryptFailures = Number(primary.decryptFailures || 0);
  let newest = Number(primary.nextCursor || 0);
  let cap = scannedCount >= pageLimit ? newest : Infinity;
  const errors = [];
  for (const alias of extras) {
    try {
      const result = await syncConversationFromIndexer({ ...details, alias, knownTxids: [...known] });
      for (const message of result.messages || []) {
        if (!message?.txid || known.has(message.txid)) continue;
        known.add(message.txid);
        messages.push(message);
      }
      scannedCount += Number(result.scannedCount || 0);
      decryptFailures += Number(result.decryptFailures || 0);
      newest = Math.max(newest, Number(result.nextCursor || 0));
      if (Number(result.scannedCount || 0) >= pageLimit) cap = Math.min(cap, Number(result.nextCursor || 0));
    } catch (error) {
      cap = Math.min(cap, Number(primary.cursor || 0));
      errors.push(`legacy alias: ${error?.message || error}`);
    }
  }
  messages.sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0));
  const nextCursor = Math.max(Number(primary.cursor || 0), Math.min(newest, cap));
  return {
    ...primary,
    nextCursor,
    scannedCount,
    decryptFailures,
    found: messages.length,
    messages,
    legacyAliasesFetched: extras.length,
    errors,
    note: messages.length
      ? `Real sync received ${messages.length} encrypted Kasia message${messages.length === 1 ? "" : "s"} (${extras.length + 1} aliases).`
      : `Real sync complete: no new decryptable messages (${scannedCount} indexed row${scannedCount === 1 ? "" : "s"} checked across ${extras.length + 1} aliases).`,
  };
}


// --- No-handshake first contact (NO_HANDSHAKE_MESSAGING.md §5.3) -----------------------------
/** Whether the indexer answers inbox lookups: true on an answer, false on 404 (an indexer
 *  without the feature), null when it couldn't be reached - unknown, so not worth caching. */
export async function probeInboxSupport(indexerUrl = DEFAULT_KASIA_INDEXER_URL) {
  try {
    const baseUrl = normalizeBaseUrl(indexerUrl);
    const query = new URLSearchParams({ tag: "0".repeat(32), limit: "1" });
    const response = await fetch(`${baseUrl}/contextual-messages/by-inbox?${query}`, { headers: { Accept: "application/json" }, cache: "no-store" });
    if (response.status === 404) return false;
    if (!response.ok) return null;
    const body = await response.json().catch(() => null);
    return Array.isArray(body) ? true : null;
  } catch {
    return null;
  }
}

/** First-contact messages filed under `tag` (the recipient's inbox tag), ascending, newer than
 *  `cursor`: [{ sender, txid, blockTime }]. Pages until the indexer runs dry or `maxPages`. */
export async function fetchInboxMessages({ tag, cursor = 0, indexerUrl = DEFAULT_KASIA_INDEXER_URL, limit = 100, maxPages = 20 } = {}) {
  if (!/^[0-9a-f]{32}$/.test(String(tag || ""))) throw new Error("A 32-hex inbox tag is required.");
  const baseUrl = normalizeBaseUrl(indexerUrl);
  const out = [];
  const seen = new Set();
  let since = Number(cursor) || 0;
  for (let page = 0; page < maxPages; page += 1) {
    const query = new URLSearchParams({ tag, block_time: String(since), limit: String(Math.max(1, Math.min(500, limit))) });
    const response = await fetch(`${baseUrl}/contextual-messages/by-inbox?${query}`, { headers: { Accept: "application/json" }, cache: "no-store" });
    if (!response.ok) throw new Error(`Inbox lookup failed (${response.status}).`);
    const rows = await response.json();
    if (!Array.isArray(rows) || !rows.length) break;
    let newest = since;
    for (const row of rows) {
      const txid = String(row?.tx_id || "");
      const blockTime = Number(row?.block_time || 0);
      if (blockTime > newest) newest = blockTime;
      if (!txid || seen.has(txid)) continue;
      seen.add(txid);
      out.push({ sender: String(row?.sender || ""), txid, blockTime });
    }
    if (rows.length < limit || newest <= since) break;
    since = newest;
  }
  return out;
}

async function resolveHandshakeSenderFromTransaction(txid, receiver) {
  if (!txid) return "";
  try {
    const url = new URL(`${getEndpoint("kaspaApi")}/transactions/${encodeURIComponent(txid)}`);
    url.searchParams.set("resolve_previous_outpoints", "light");
    const response = await fetch(url, { headers: { Accept: "application/json" }, cache: "no-store" });
    if (!response.ok) return "";
    const transaction = await response.json();
    const inputs = Array.isArray(transaction?.inputs) ? transaction.inputs : [];
    for (const input of inputs) {
      const address = String(
        input?.previous_outpoint_address ||
        input?.previousOutpointAddress ||
        input?.previous_outpoint?.address ||
        "",
      ).trim();
      if (address.startsWith(ADDRESS_PREFIX) && address !== receiver) return address;
    }
    const outputs = Array.isArray(transaction?.outputs) ? transaction.outputs : [];
    for (const output of outputs) {
      const address = String(output?.script_public_key_address || output?.scriptPublicKeyAddress || "").trim();
      if (address.startsWith(ADDRESS_PREFIX) && address !== receiver) return address;
    }
  } catch {
    // Sender resolution is a compatibility fallback. The indexer normally supplies it.
  }
  return "";
}

function handshakeEncryptedCandidates(payloadHex) {
  const clean = String(payloadHex || "").replace(/^0x/i, "").trim().toLowerCase();
  if (!clean || clean.length % 2 !== 0 || !/^[0-9a-f]+$/.test(clean)) return [];
  const candidates = [];
  const add = (value) => {
    const normalized = String(value || "").replace(/^0x/i, "").trim().toLowerCase();
    if (normalized && normalized.length % 2 === 0 && /^[0-9a-f]+$/.test(normalized) && !candidates.includes(normalized)) {
      candidates.push(normalized);
    }
  };
  add(clean);

  // REST/raw transaction payload compatibility: OP_RETURN + one-byte push length.
  let body = clean;
  if (body.startsWith("6a") && body.length >= 4) body = body.slice(4);
  add(body);

  // Dual-read: new `kchat:` root + legacy `ciph_msg:` roots (and the old `hs:` alias).
  const prefixes = [
    textToHex("kchat:1:handshake:"),
    textToHex("ciph_msg:1:handshake:"),
    textToHex("ciph_msg:1:hs:"),
  ];
  for (const value of [...candidates]) {
    for (const prefix of prefixes) {
      if (value.startsWith(prefix)) add(value.slice(prefix.length));
    }
  }
  // The Kasia indexer stores SealedHandshakeV2.sealed_hex directly, so the
  // unmodified payload remains the first and most common candidate.
  return candidates;
}


function isHandshakePayloadHex(payloadHex) {
  const clean = String(payloadHex || "").replace(/^0x/i, "").trim().toLowerCase();
  if (!clean || clean.length % 2 !== 0 || !/^[0-9a-f]+$/.test(clean)) return false;
  let body = clean;
  if (body.startsWith("6a") && body.length >= 4) body = body.slice(4);
  return body.startsWith(textToHex("kchat:1:handshake:")) || body.startsWith(textToHex("ciph_msg:1:handshake:"));
}

function transactionSenderAddress(transaction, receiver) {
  const inputs = Array.isArray(transaction?.inputs) ? transaction.inputs : [];
  for (const input of inputs) {
    const address = String(
      input?.previous_outpoint_address ||
      input?.previousOutpointAddress ||
      input?.previous_outpoint?.address ||
      "",
    ).trim();
    if (address.startsWith(ADDRESS_PREFIX) && address !== receiver) return address;
  }
  return "";
}

function transactionPaysAddress(transaction, receiver) {
  const outputs = Array.isArray(transaction?.outputs) ? transaction.outputs : [];
  return outputs.some((output) => String(
    output?.script_public_key_address ||
    output?.scriptPublicKeyAddress ||
    output?.address ||
    "",
  ).trim() === receiver);
}

async function fetchHandshakeTransactionsFromKaspaRest({ walletAddress, cursor = 0, knownTxids = [], limit = 100 } = {}) {
  const known = new Set((knownTxids || []).map(String));
  const url = new URL(`${getEndpoint("kaspaApi")}/addresses/${encodeURIComponent(walletAddress)}/full-transactions`);
  url.searchParams.set("limit", String(Math.max(1, Math.min(100, Number(limit) || 100))));
  url.searchParams.set("offset", "0");
  url.searchParams.set("resolve_previous_outpoints", "light");
  const response = await fetch(url, { headers: { Accept: "application/json" }, cache: "no-store" });
  if (!response.ok) throw new Error(`Kaspa REST handshake scan failed (${response.status}).`);
  const transactions = await response.json();
  if (!Array.isArray(transactions)) throw new Error("Kaspa REST returned an unexpected transaction response.");
  const rows = [];
  for (const transaction of transactions) {
    const txid = String(transaction?.transaction_id || transaction?.transactionId || transaction?.hash || "").trim();
    const blockTime = Number(transaction?.block_time || transaction?.blockTime || transaction?.accepting_block_time || 0);
    const payload = String(transaction?.payload || "").trim();
    if (!txid || known.has(txid) || (cursor > 0 && blockTime > 0 && blockTime <= rewoundCursor(cursor))) continue;
    if (!isHandshakePayloadHex(payload)) continue;
    if (!transactionPaysAddress(transaction, walletAddress)) continue;
    const sender = transactionSenderAddress(transaction, walletAddress);
    if (!sender) continue;
    rows.push({
      tx_id: txid, sender, receiver: walletAddress, block_time: blockTime,
      accepting_block: transaction?.accepting_block_hash || null,
      accepting_daa_score: transaction?.accepting_block_blue_score ?? null,
      message_payload: payload, source: "kaspa-rest",
    });
  }
  return rows;
}

function parseHandshakeMetadata(clearText) {
  const fallback = { alias: "", conversationId: "", isResponse: false, rawText: String(clearText || "") };
  try {
    const parsed = JSON.parse(String(clearText || ""));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return fallback;
    return {
      alias: String(parsed.alias || parsed.displayName || parsed.name || "").trim(),
      // XP-003: the `alias` field ALONE is the sender's outgoing (wire) alias - what their
      // contextual messages to us carry. displayName/name are labels, never routing.
      wireAlias: String(parsed.alias || "").trim(),
      conversationId: String(parsed.conversationId || parsed.conversation_id || "").trim(),
      isResponse: Boolean(parsed.isResponse ?? parsed.is_response ?? false),
      recipientAddress: String(parsed.recipientAddress || parsed.recipient_address || "").trim(),
      type: String(parsed.type || "").trim(),
      rawText: String(clearText || ""),
    };
  } catch {
    // Original KaChat treats successfully decrypted non-JSON text as a valid,
    // alias-less legacy handshake rather than discarding the indexer row.
    return fallback;
  }
}

export async function syncIncomingHandshakesFromIndexer({
  walletAddress,
  privateKeyHex,
  decryptMessage,
  knownTxids = [],
  cursor = 0,
  indexerUrl = DEFAULT_KASIA_INDEXER_URL,
  limit = 50,
} = {}) {
  if (!walletAddress?.startsWith(ADDRESS_PREFIX)) throw new Error("Load a wallet before syncing incoming handshakes.");
  if (!privateKeyHex) throw new Error("The active private key is required to decrypt handshakes.");
  if (typeof decryptMessage !== "function") throw new Error("Kasia cipher decryptor is unavailable.");

  const known = new Set((knownTxids || []).map(String));
  const baseUrl = normalizeBaseUrl(indexerUrl);
  const query = new URLSearchParams({
    address: walletAddress,
    block_time: String(rewoundCursor(cursor)),
    limit: String(Math.max(1, Math.min(50, Number(limit) || 50))),
  });

  let indexerRows = [];
  let restRows = [];
  const errors = [];
  try {
    const response = await fetch(`${baseUrl}/handshakes/by-receiver?${query.toString()}`, {
      headers: { Accept: "application/json" }, cache: "no-store",
    });
    if (!response.ok) throw new Error(`Incoming handshake request failed (${response.status}).`);
    const rows = await response.json();
    if (!Array.isArray(rows)) throw new Error("Handshake indexer returned an unexpected response.");
    indexerRows = rows.map((row) => ({ ...row, source: "kasia-indexer" }));
  } catch (error) {
    errors.push(`Indexer: ${error.message}`);
  }

  // Original KaChat does not rely on the handshake indexer alone. It also
  // classifies wallet-address transactions from Kaspa REST/UTXO activity.
  // This fallback is essential for unknown senders when indexer ingestion or
  // sender resolution is delayed.
  try {
    restRows = await fetchHandshakeTransactionsFromKaspaRest({
      walletAddress, cursor, knownTxids: [...known], limit: 100,
    });
  } catch (error) {
    errors.push(`REST: ${error.message}`);
  }

  if (!indexerRows.length && !restRows.length && errors.length === 2) {
    throw new Error(errors.join(" | "));
  }

  const rowByTxid = new Map();
  for (const row of [...indexerRows, ...restRows]) {
    const txid = String(row?.tx_id || "").trim();
    if (!txid) continue;
    const prior = rowByTxid.get(txid);
    // Prefer indexer metadata when both sources know the transaction.
    if (!prior || row.source === "kasia-indexer") rowByTxid.set(txid, row);
  }

  const rows = [...rowByTxid.values()].sort((a, b) => Number(a.block_time || 0) - Number(b.block_time || 0));
  const handshakes = [];
  let nextCursor = Number(cursor || 0);
  let unresolvedFloor = null;

  for (const row of rows) {
    const txid = String(row.tx_id || "").trim();
    const blockTime = Number(row.block_time || 0);
    if (blockTime > nextCursor) nextCursor = blockTime;
    if (!txid || known.has(txid)) continue;

    const receiver = String(row.receiver || walletAddress).trim() || walletAddress;
    let sender = String(row.sender || "").trim();
    if (!sender.startsWith(ADDRESS_PREFIX)) sender = await resolveHandshakeSenderFromTransaction(txid, receiver);
    if (!sender.startsWith(ADDRESS_PREFIX)) {
      unresolvedFloor = unresolvedFloor == null ? blockTime : Math.min(unresolvedFloor, blockTime);
      continue;
    }

    let metadata = { alias: "", conversationId: "", isResponse: false, rawText: "" };
    let encryptedHex = handshakeEncryptedCandidates(row.message_payload || "")[0] || "";
    let decrypted = false;
    for (const candidate of handshakeEncryptedCandidates(row.message_payload || "")) {
      try {
        const clearText = await decryptMessage(candidate, privateKeyHex);
        metadata = parseHandshakeMetadata(clearText);
        encryptedHex = candidate;
        decrypted = true;
        break;
      } catch {}
    }

    handshakes.push({
      txid, sender, receiver, alias: metadata.alias, wireAlias: metadata.wireAlias || "", conversationId: metadata.conversationId,
      // `blockTime` raw, 0 when the indexer gave none - callers that compare against a deletion
      // tombstone need to tell "before the deletion" from "no time in hand", which createdAt's
      // Date.now() fallback hides.
      isResponse: metadata.isResponse, blockTime: blockTime || 0, createdAt: blockTime || Date.now(),
      acceptingBlock: row.accepting_block || null,
      daaScore: row.accepting_daa_score != null ? String(row.accepting_daa_score) : null,
      payloadHex: String(row.message_payload || ""), encryptedHex, decrypted,
      legacy: !decrypted || !metadata.type, source: row.source || "unknown",
    });
    known.add(txid);
  }

  if (unresolvedFloor != null && unresolvedFloor > 0) nextCursor = Math.min(nextCursor, Math.max(0, unresolvedFloor - 1));
  return {
    handshakes, nextCursor, scannedCount: rows.length,
    indexerScannedCount: indexerRows.length, restScannedCount: restRows.length, errors,
  };
}

/**
 * Handshakes THIS wallet sent (requests it initiated + acceptances of others' requests) — the
 * restore-parity pass (matches iOS's getHandshakesBySender). After a seed import these are the
 * only on-chain proof a conversation was mutual: your own acceptance never appears in
 * handshakes/by-receiver. Payloads are encrypted for the recipient (undecryptable by us), so
 * rows carry existence + peer + time only.
 */
export async function syncOutgoingHandshakesFromIndexer({ walletAddress, cursor = 0, limit = 50, indexerUrl } = {}) {
  const baseUrl = normalizeBaseUrl(indexerUrl || DEFAULT_KASIA_INDEXER_URL);
  const query = new URLSearchParams({
    address: walletAddress,
    block_time: String(Number(cursor || 0)),
    limit: String(Math.max(1, Math.min(50, Number(limit) || 50))),
  });
  const response = await fetch(`${baseUrl}/handshakes/by-sender?${query.toString()}`, {
    headers: { Accept: "application/json" }, cache: "no-store",
  });
  if (!response.ok) throw new Error(`Outgoing handshake request failed (${response.status}).`);
  const rows = await response.json();
  if (!Array.isArray(rows)) throw new Error("Handshake indexer returned an unexpected response.");
  let nextCursor = Number(cursor || 0);
  const handshakes = [];
  for (const row of rows) {
    const txid = String(row?.tx_id || "").trim();
    const receiver = String(row?.receiver || "").trim();
    const blockTime = Number(row?.block_time || 0);
    if (blockTime > nextCursor) nextCursor = blockTime;
    if (!txid || !receiver.startsWith(ADDRESS_PREFIX)) continue;
    handshakes.push({ txid, receiver, createdAt: blockTime || Date.now(), payloadHex: String(row.message_payload || "") });
  }
  return { handshakes, nextCursor, scannedCount: rows.length };
}

function isSelfStashPayloadHex(payloadHex) {
  const clean = String(payloadHex || "").replace(/^0x/i, "").trim().toLowerCase();
  if (!clean || clean.length % 2 !== 0 || !/^[0-9a-f]+$/.test(clean)) return false;
  let body = clean;
  if (body.startsWith("6a") && body.length >= 4) body = body.slice(4);
  return body.startsWith(textToHex("kchat:1:self_stash:saved_handshake:"))
    || body.startsWith(textToHex("ciph_msg:1:self_stash:saved_handshake:"));
}

// A self-stash transaction pays back to the wallet's own address, so unlike
// handshake scanning there's no "sender differs from receiver" filter — the
// wallet is both sender and receiver. We just filter this wallet's own
// transaction history down to self_stash-shaped payloads.
async function fetchSelfStashTransactionsFromChain({ walletAddress, cursor = 0, knownTxids = [], limit = 100 } = {}) {
  const known = new Set((knownTxids || []).map(String));
  const url = new URL(`${getEndpoint("kaspaApi")}/addresses/${encodeURIComponent(walletAddress)}/full-transactions`);
  url.searchParams.set("limit", String(Math.max(1, Math.min(100, Number(limit) || 100))));
  url.searchParams.set("offset", "0");
  url.searchParams.set("resolve_previous_outpoints", "light");
  const response = await fetch(url, { headers: { Accept: "application/json" }, cache: "no-store" });
  if (!response.ok) throw new Error(`Kaspa REST self-stash scan failed (${response.status}).`);
  const transactions = await response.json();
  if (!Array.isArray(transactions)) throw new Error("Kaspa REST returned an unexpected transaction response.");
  const rows = [];
  for (const transaction of transactions) {
    const txid = String(transaction?.transaction_id || transaction?.transactionId || transaction?.hash || "").trim();
    const blockTime = Number(transaction?.block_time || transaction?.blockTime || transaction?.accepting_block_time || 0);
    const payload = String(transaction?.payload || "").trim();
    if (!txid || known.has(txid) || (cursor > 0 && blockTime > 0 && blockTime <= rewoundCursor(cursor))) continue;
    if (!isSelfStashPayloadHex(payload)) continue;
    rows.push({ tx_id: txid, block_time: blockTime, message_payload: payload });
  }
  return rows;
}

/**
 * Every saved-handshake note this wallet has written, read back from the indexer
 * (`/self-stash/by-owner`, scope `saved_handshake`, paged by block time) and decrypted. This is
 * the COMPLETE read-back a contact note may be written after (MESSAGING.md §4): `complete` is
 * true only when the paging ran to its end, so a partial answer never licenses a duplicate.
 */
export async function fetchSavedHandshakeNotes({ walletAddress, privateKeyHex, decryptMessage, indexerUrl, limit = 50, maxPages = 200 } = {}) {
  if (!walletAddress?.startsWith(ADDRESS_PREFIX)) throw new Error("Load a wallet before reading saved contacts.");
  if (!privateKeyHex) throw new Error("The active private key is required to decrypt saved contacts.");
  if (typeof decryptMessage !== "function") throw new Error("Kasia cipher decryptor is unavailable.");
  const baseUrl = normalizeBaseUrl(indexerUrl);
  const scopeHex = Array.from(new TextEncoder().encode("saved_handshake"), (b) => b.toString(16).padStart(2, "0")).join("");
  const seen = new Set();
  const stashes = [];
  let blockTime = 0;
  let complete = false;
  let rowCount = 0;
  for (let page = 0; page < maxPages; page += 1) {
    const query = new URLSearchParams({ owner: walletAddress, scope: scopeHex, limit: String(limit), block_time: String(blockTime) });
    const response = await fetch(`${baseUrl}/self-stash/by-owner?${query.toString()}`, { headers: { Accept: "application/json" }, cache: "no-store" });
    if (!response.ok) throw new Error(`Saved contact read-back failed (${response.status}).`);
    const rows = await response.json();
    if (!Array.isArray(rows)) throw new Error("The indexer returned an unexpected saved-contact response.");
    let newest = blockTime;
    for (const row of rows) {
      const txid = String(row?.tx_id || "").trim();
      const rowTime = Number(row?.block_time || 0);
      if (rowTime > newest) newest = rowTime;
      if (!txid || seen.has(txid)) continue;
      seen.add(txid);
      rowCount += 1;
      for (const candidate of selfStashEncryptedCandidates(row?.stashed_data || "")) {
        try {
          const parsed = parseSelfStashPayload(await decryptMessage(candidate, privateKeyHex));
          if (parsed.partnerAddress) { stashes.push({ txid, blockTime: rowTime, ...parsed }); break; }
        } catch { /* not this candidate */ }
      }
    }
    if (rows.length < limit) { complete = true; break; }
    if (newest <= blockTime) break; // no progress: stop rather than loop, and stay incomplete
    blockTime = newest;
  }
  // Notes that came back but none of which could be read means the read-back cannot be trusted
  // to say what is missing: never call that complete, or every chat would be noted again.
  if (rowCount > 0 && stashes.length === 0) complete = false;
  return { stashes, complete };
}

/**
 * Recovers conversation/alias metadata purely from on-chain self-stash
 * transactions plus the active private key — no local database required.
 * Matches iOS's historical-loader recovery flow (see buildSelfStash in
 * kasia-protocol.js for the wire format this decodes).
 */
export async function syncSelfStashFromChain({
  walletAddress,
  privateKeyHex,
  decryptMessage,
  knownTxids = [],
  cursor = 0,
  limit = 100,
} = {}) {
  if (!walletAddress?.startsWith(ADDRESS_PREFIX)) throw new Error("Load a wallet before recovering conversations.");
  if (!privateKeyHex) throw new Error("The active private key is required to decrypt stashed conversation data.");
  if (typeof decryptMessage !== "function") throw new Error("Kasia cipher decryptor is unavailable.");

  const known = new Set((knownTxids || []).map(String));
  const errors = [];
  let rows = [];
  try {
    rows = await fetchSelfStashTransactionsFromChain({ walletAddress, cursor, knownTxids: [...known], limit });
  } catch (error) {
    errors.push(`REST: ${error.message}`);
    throw new Error(errors.join(" | "));
  }

  rows.sort((a, b) => Number(a.block_time || 0) - Number(b.block_time || 0));
  const stashes = [];
  let nextCursor = Number(cursor || 0);

  for (const row of rows) {
    const txid = String(row.tx_id || "").trim();
    const blockTime = Number(row.block_time || 0);
    if (blockTime > nextCursor) nextCursor = blockTime;
    if (!txid || known.has(txid)) continue;
    known.add(txid);

    let decoded = null;
    for (const candidate of selfStashEncryptedCandidates(row.message_payload || "")) {
      try {
        const clearText = await decryptMessage(candidate, privateKeyHex);
        const parsed = parseSelfStashPayload(clearText);
        if (parsed.partnerAddress) { decoded = parsed; break; }
      } catch {}
    }
    if (!decoded) continue;

    stashes.push({ txid, blockTime, ...decoded });
  }

  return { stashes, nextCursor, scannedCount: rows.length, errors };
}

// Existing local preview helper retained for offline UI testing.
export async function syncConversationPreview({ conversationId, contact, walletAddress, knownTxids = [], cursor = 0 } = {}) {
  if (!conversationId) throw new Error("conversationId is required for sync.");
  if (!contact?.address?.startsWith(ADDRESS_PREFIX)) throw new Error("A kaspa: contact address is required for sync.");

  const plan = buildConversationSyncPlan({
    conversationId,
    contactAddress: contact.address,
    walletAddress,
    knownTxids,
    cursor,
  });
  await new Promise((resolve) => window.setTimeout(resolve, 350));

  const createdAt = Date.now();
  const syncIndex = Number(cursor || 0) + 1;
  const bodyText = `Synced preview #${syncIndex} from ${contact.name || "contact"}`;
  const payload = makeKasiaCommPayload({
    alias: contact.name || "contact",
    text: bodyText,
    sender: contact.address,
    receiver: walletAddress || null,
  });
  const txid = `sync-preview-${shortHash(`${conversationId}:${contact.address}:${syncIndex}`)}`;
  const messages = knownTxids.includes(txid) ? [] : [{
    id: `sync-${txid}`,
    conversationId,
    contactId: contact.id,
    direction: "incoming",
    text: parseKasiaPayloadHex(payload.payloadHex)?.bodyText || bodyText,
    sender: contact.address,
    receiver: walletAddress || null,
    status: "confirmed",
    txid,
    daaScore: String(Math.floor(createdAt / 1000)),
    confirmations: 1,
    network: NETWORK,
    payloadHex: payload.payloadHex,
    payloadBytes: Math.ceil(payload.payloadHex.length / 2),
    messageType: payload.type,
    transport: "sync-preview",
    protocol: "kasia",
    protocolVersion: 1,
    protocolString: payload.protocolString,
    createdAt,
    updatedAt: createdAt,
  }];

  return {
    plan,
    cursor: Number(cursor || 0),
    nextCursor: syncIndex,
    scanned: true,
    found: messages.length,
    messages,
    note: messages.length ? `Sync preview decoded inbound Kasia payload #${syncIndex}.` : "Sync preview found no new messages.",
  };
}


const paymentPageCache = new Map(); // url -> { at, promise }
const PAYMENT_PAGE_TTL_MS = 4000;

// The memo an incoming payment carries (iOS PaymentPayload.message), decrypted from its
// kchat:1:pay: payload; "" when there is no payload, no memo, or it can't be read.
async function paymentMemoFromPayload(payloadHex, decryptMessage) {
  if (typeof decryptMessage !== "function") return "";
  const encryptedHex = paymentPayloadEncryptedHex(payloadHex);
  if (!encryptedHex) return "";
  try {
    const parsed = JSON.parse(String(await decryptMessage(encryptedHex) || ""));
    if (parsed?.type && parsed.type !== "payment") return "";
    return typeof parsed?.message === "string" ? parsed.message.replace(/\s*\n\s*/g, " ").trim() : "";
  } catch {
    return "";
  }
}

export async function syncIncomingPaymentsFromRest({ conversationId, contact, walletAddress, knownTxids = [], cursor = 0, limit = 100, decryptMessage = null } = {}) {
  if (!conversationId) throw new Error("conversationId is required for payment sync.");
  if (!contact?.address?.startsWith(ADDRESS_PREFIX)) throw new Error("A kaspa: contact address is required for payment sync.");
  if (!walletAddress?.startsWith(ADDRESS_PREFIX)) throw new Error("Load a wallet before syncing payments.");

  const addressFromOutput = (output) => String(
    output?.script_public_key_address || output?.scriptPublicKeyAddress || output?.address ||
    output?.script_public_key?.address || output?.scriptPublicKey?.address || "",
  ).trim();
  const amountFromOutput = (output) => {
    const raw = output?.amount ?? output?.value ?? output?.sompi ?? 0;
    try { return BigInt(raw); } catch { return 0n; }
  };
  const addressFromInput = (input) => String(
    input?.previous_outpoint_address || input?.previousOutpointAddress || input?.previous_outpoint?.address ||
    input?.previous_outpoint?.resolved_transaction_output?.script_public_key_address ||
    input?.previous_outpoint?.resolvedTransactionOutput?.scriptPublicKeyAddress ||
    input?.resolved_previous_outpoint?.script_public_key_address ||
    input?.resolvedPreviousOutpoint?.scriptPublicKeyAddress ||
    input?.previous_outpoint?.resolved_transaction_output?.script_public_key?.address || "",
  ).trim();
  const normalizeTransactions = (body) => Array.isArray(body) ? body
    : Array.isArray(body?.transactions) ? body.transactions
    : Array.isArray(body?.result) ? body.result
    : body && typeof body === "object" ? [body] : [];

  const known = new Set((knownTxids || []).map(String));
  // The page is the WALLET's, not the contact's: one sweep asks for it once per contact with the
  // same URL, so a page fetched within the last few seconds is reused (iOS reads its own copy).
  const url = new URL(`${getEndpoint("kaspaApi")}/addresses/${encodeURIComponent(walletAddress)}/full-transactions`);
  url.searchParams.set("limit", String(Math.max(1, Math.min(100, Number(limit) || 100))));
  url.searchParams.set("offset", "0");
  url.searchParams.set("resolve_previous_outpoints", "light");
  const pageKey = url.href;
  const cachedPage = paymentPageCache.get(pageKey);
  let transactions;
  if (cachedPage && Date.now() - cachedPage.at < PAYMENT_PAGE_TTL_MS) {
    transactions = await cachedPage.promise;
  } else {
    const promise = (async () => {
      const response = await fetch(url, { headers: { Accept: "application/json" }, cache: "no-store" });
      if (!response.ok) throw new Error(`Kaspa REST payment scan failed (${response.status}).`);
      return normalizeTransactions(await response.json());
    })();
    paymentPageCache.set(pageKey, { at: Date.now(), promise });
    promise.catch(() => paymentPageCache.delete(pageKey));
    transactions = await promise;
  }
  if (!transactions.length) return { messages: [], contractTxids: [], found: 0, nextCursor: Number(cursor || 0), note: "No new Kaspa payments." };

  const messages = [];
  const contractTxids = [];
  let nextCursor = Number(cursor || 0);
  for (const tx of transactions) {
    const txid = String(tx?.transaction_id || tx?.transactionId || tx?.hash || tx?.id || "").trim();
    const blockTimeRaw = Number(tx?.block_time || tx?.blockTime || tx?.accepting_block_time || tx?.acceptingBlockTime || 0);
    const createdAt = blockTimeRaw > 1e12 ? blockTimeRaw : (blockTimeRaw > 0 ? blockTimeRaw * 1000 : Date.now());
    if (createdAt > nextCursor) nextCursor = createdAt;
    if (!txid || known.has(txid)) continue;
    // .kachat registry/offer and other contract transactions are never chat payments (iOS 32fdaa4):
    // reported so the app keeps them suppressed on every path.
    if (isKachatContractTransaction(tx)) { contractTxids.push(txid); continue; }

    const inputs = Array.isArray(tx?.inputs) ? tx.inputs : [];
    const inputAddresses = inputs.map(addressFromInput).filter((value) => value.startsWith(ADDRESS_PREFIX));
    if (!inputAddresses.includes(contact.address)) continue;

    const outputs = Array.isArray(tx?.outputs) ? tx.outputs : [];
    let totalSompi = 0n;
    for (const output of outputs) {
      if (addressFromOutput(output) !== walletAddress) continue;
      totalSompi += amountFromOutput(output);
    }
    if (totalSompi <= 0n) continue;

    // Exact (BigInt) text: Number(totalSompi) / 1e8 loses sompi past 2^53.
    const amountKas = kasTextFromSompi(totalSompi);
    // "Received X KAS — memo" when the payer added one (iOS paymentContent).
    const memo = await paymentMemoFromPayload(tx?.payload, decryptMessage);
    messages.push({
      id: `payment-${txid}`, conversationId, contactId: contact.id, direction: "incoming",
      text: memo ? `Received ${amountKas} ${KAS_UNIT} — ${memo}` : `Received ${amountKas} ${KAS_UNIT}`, sender: contact.address, receiver: walletAddress,
      status: "confirmed", txid, confirmations: 1, network: NETWORK, messageType: "payment",
      paymentAmountKas: amountKas, transport: "kaspa-payment-rest", createdAt, updatedAt: Date.now(),
    });
    known.add(txid);
  }
  return { messages, contractTxids, found: messages.length, nextCursor, note: messages.length ? `Received ${messages.length} new Kaspa payment${messages.length === 1 ? "" : "s"}.` : "No new Kaspa payments." };
}
