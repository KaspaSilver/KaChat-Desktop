// Broadcasts — public, unencrypted, many-to-many channels riding on Kaspa self-send
// transactions (payload `kchat:1:bcast:<channel>:<content>`; the legacy `ciph_msg:1:bcast:`
// root is read, never written), desktop port of the iOS/
// Android 4.0 feature. The curated rooms (#kaspa, #kachat-bugs and the eleven per-language
// rooms) are backed by the KaChat
// broadcast indexer (BROADCAST_INDEXER.md): it watches the chain 24/7 and serves history over
// REST, so clients backfill on room open and poll while the room stays visible. Messages are
// deduped by txid. There is no signature scheme: the sender is whoever signed the inputs, and a
// post is accepted only as a self-send whose output 0 pays that same address (audit DSK-045,
// see "Sender verification" below).

import { getEndpoint } from "./endpoints.js";
import { sendPayloadTransaction } from "./transactions.js";

/// Curated rooms that are AUTO-JOINED for every account and pinned at the top of the Popular
/// section. Matches iOS `BroadcastService.featuredChannels`.
export const FEATURED_BROADCAST_CHANNELS = Object.freeze(["kaspa", "kachat-bugs"]);

/// Curated per-language rooms, listed behind the collapsible "Other Languages" row under
/// Popular. Indexer-tracked exactly like the featured rooms (30-day retention, indexer history,
/// no retention gear, no Leave) but deliberately NOT auto-joined: the room is joined on first
/// open or bell tap. Auto-joining a dozen more rooms would multiply per-room work for every
/// user, including the vast majority who want none of them.
///
/// These names are the literal on-chain channel names and are deliberately inconsistent (native
/// romanizations for some, English for others, a country name for one). Do NOT "normalize" any
/// of them: a corrected name is a DIFFERENT, empty room. Copied verbatim from iOS
/// `BroadcastService.languageChannels`; order matches `BROADCAST_LANGUAGE_DISPLAY_NAMES`.
export const LANGUAGE_BROADCAST_CHANNELS = Object.freeze([
  "kaspa-indonesia",
  "kaspa-czech",
  "kaspa-german",
  "kaspa-espanol",
  "kaspa-francais",
  "kaspa-portugues",
  "kaspa-romania",
  "kaspa-russian",
  "kaspa-slovak",
  "kaspa-chinese",
  "kaspa-japanese",
  "kaspa-korean",
  "kaspa-hebrew",
]);

/// Every indexer-tracked room. EVERYTHING that follows from "the indexer serves this room's
/// history" keys off this set - the fixed 30-day retention, no per-room retention gear, no
/// Leave. Only auto-join and the pinned Popular list use `FEATURED_BROADCAST_CHANNELS` alone.
/// Mirrors iOS `BroadcastService.indexedChannels`.
export const INDEXED_BROADCAST_CHANNELS = Object.freeze([
  ...FEATURED_BROADCAST_CHANNELS,
  ...LANGUAGE_BROADCAST_CHANNELS,
]);

/// Rooms the app uses as machinery, never shown as chats: the chess arena
/// (CHESS_TOURNAMENTS.md). Hidden from Public Chats, no unread, no bell. Mirrors iOS
/// `BroadcastService.serviceChannels`.
export const SERVICE_BROADCAST_CHANNELS = Object.freeze(["chess-arena"]);
export function isServiceBroadcastChannel(name) {
  return SERVICE_BROADCAST_CHANNELS.includes(normalizeBroadcastChannel(name));
}

export const BROADCAST_RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // fixed 30 days (indexed rooms)

/// Native-language label for each curated language room, e.g. "kaspa-espanol" -> "Español".
/// Native names (not English ones) so a speaker scanning the list finds their own language.
/// Copied from iOS `BroadcastService.languageDisplayName`.
const BROADCAST_LANGUAGE_DISPLAY_NAMES = Object.freeze({
  "kaspa-indonesia": "Bahasa Indonesia",
  "kaspa-czech": "Čeština",
  "kaspa-german": "Deutsch",
  "kaspa-espanol": "Español",
  "kaspa-francais": "Français",
  "kaspa-portugues": "Português",
  "kaspa-romania": "Română",
  "kaspa-russian": "Русский",
  "kaspa-slovak": "Slovenčina",
  "kaspa-chinese": "中文",
  "kaspa-japanese": "日本語",
  "kaspa-korean": "한국어",
  "kaspa-hebrew": "עברית",
});

export function normalizeBroadcastChannel(rawName) {
  return String(rawName || "").trim().toLowerCase().replace(/^#/, "");
}

export function isValidBroadcastChannel(name) {
  if (name === "__proto__" || name === "constructor" || name === "prototype") return false;
  return name.length > 0 && name.length <= 36 && !/[\s:]/.test(name);
}

export function isFeaturedBroadcastChannel(name) {
  return FEATURED_BROADCAST_CHANNELS.includes(normalizeBroadcastChannel(name));
}

export function isLanguageBroadcastChannel(name) {
  return LANGUAGE_BROADCAST_CHANNELS.includes(normalizeBroadcastChannel(name));
}

/** True for every indexer-backed room (featured + curated language rooms). */
export function isIndexedBroadcastChannel(name) {
  return INDEXED_BROADCAST_CHANNELS.includes(normalizeBroadcastChannel(name));
}

/** Native display name for a curated language room, or "" for any other channel. */
export function broadcastLanguageDisplayName(name) {
  return BROADCAST_LANGUAGE_DISPLAY_NAMES[normalizeBroadcastChannel(name)] || "";
}

// ---------------------------------------------------------------------------
// On-chain payload parsing + live block scanning
//
// The broadcast indexer only tracks the curated rooms, so a user-created room has NO
// history service anywhere. Its only possible delivery path is watching the chain
// directly: subscribe to the node's block-added notifications and pick the broadcast
// payloads out of every block. That is exactly what iOS does (BroadcastService's
// `startScanning` / `extractBroadcastHits`), and it is LIVE ONLY by construction - a
// block stream carries what is being mined now, never what was mined yesterday.
// ---------------------------------------------------------------------------

/** Payload root written by every current client. */
export const BROADCAST_PAYLOAD_PREFIX = "kchat:1:bcast:";
/** Legacy payload root, read-only (still on chain from pre-rename clients). */
export const LEGACY_BROADCAST_PAYLOAD_PREFIX = "ciph_msg:1:bcast:";

const TEXT_DECODER = new TextDecoder();

function asciiToHex(text) {
  let hex = "";
  for (let i = 0; i < text.length; i += 1) hex += text.charCodeAt(i).toString(16).padStart(2, "0");
  return hex;
}

// Prefix-match on the HEX before decoding anything: at Kaspa's block rate almost every
// transaction in almost every block is not a broadcast, and a string compare on the first
// 28/34 characters is far cheaper than decoding the whole payload to find that out.
const BROADCAST_PREFIX_HEX = asciiToHex(BROADCAST_PAYLOAD_PREFIX);
const LEGACY_BROADCAST_PREFIX_HEX = asciiToHex(LEGACY_BROADCAST_PAYLOAD_PREFIX);

function bytesToHex(bytes) {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

function hexToBytes(hex) {
  const clean = hex.length % 2 === 0 ? hex : hex.slice(0, hex.length - 1);
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Transaction payloads arrive as a hex string from wRPC, but a caller may hand us bytes. */
function normalizedPayloadHex(payload) {
  if (payload == null) return "";
  if (typeof payload === "string") return payload.trim().toLowerCase();
  if (payload instanceof Uint8Array) return bytesToHex(payload);
  if (Array.isArray(payload)) return bytesToHex(Uint8Array.from(payload));
  if (ArrayBuffer.isView(payload)) return bytesToHex(new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength));
  return "";
}

/**
 * Splits a decoded payload string into `{ channel, content }`, or returns null when it is
 * not a broadcast. Dual-root (new `kchat:` + legacy `ciph_msg:`), matching iOS
 * `KasiaTransactionBuilder.parseBroadcastPayload`.
 */
export function parseBroadcastPayload(payloadString) {
  const text = String(payloadString || "");
  let prefix = "";
  if (text.startsWith(BROADCAST_PAYLOAD_PREFIX)) prefix = BROADCAST_PAYLOAD_PREFIX;
  else if (text.startsWith(LEGACY_BROADCAST_PAYLOAD_PREFIX)) prefix = LEGACY_BROADCAST_PAYLOAD_PREFIX;
  else return null;
  const rest = text.slice(prefix.length);
  const colon = rest.indexOf(":");
  if (colon < 0) return null;
  const channel = normalizeBroadcastChannel(rest.slice(0, colon));
  if (!channel) return null;
  return { channel, content: rest.slice(colon + 1) };
}

/** u64 fields cross the WASM boundary as BigInt; everything else may be a number or string. */
function toNumber(value) {
  if (typeof value === "bigint") return Number(value);
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

const KASPA_ADDRESS_RE = /^kaspa(?:test)?:[a-z0-9]+$/;
/** A well-formed `kaspa:` / `kaspatest:` address string, or "". */
function cleanAddress(value) {
  if (value == null) return "";
  const text = String(typeof value === "object" && typeof value.toString === "function" ? value.toString() : value).trim();
  return KASPA_ADDRESS_RE.test(text) ? text : "";
}

/**
 * Address paid by output 0. On its own this is NOT the sender (audit DSK-045): output 0 can
 * pay anyone, so it is only ever compared with the address input 0 spends from - see
 * `judgeBroadcastSender`. Prefer the node's own verbose data, fall back to deriving it from
 * the script public key with the WASM SDK.
 */
function outputAddress(kaspa, output, networkId) {
  const verbose = output?.verboseData || output?.verbose_data || null;
  const direct = cleanAddress(verbose?.scriptPublicKeyAddress || verbose?.script_public_key_address || "");
  if (direct) return direct;
  return addressFromScriptPublicKey(kaspa, output?.scriptPublicKey ?? output?.script_public_key ?? null, networkId);
}

function addressFromScriptPublicKey(kaspa, scriptPublicKey, networkId) {
  if (scriptPublicKey == null || typeof kaspa?.addressFromScriptPublicKey !== "function") return "";
  const attempts = [scriptPublicKey];
  // A plain `{ version, script }` object (how wRPC serialises it) may not cast directly —
  // rebuild it as a real SDK ScriptPublicKey before giving up.
  if (typeof scriptPublicKey === "object" && scriptPublicKey?.script != null && kaspa?.ScriptPublicKey) {
    try { attempts.push(new kaspa.ScriptPublicKey(Number(scriptPublicKey.version || 0), scriptPublicKey.script)); }
    catch { /* fall through to the direct attempt only */ }
  }
  for (const candidate of attempts) {
    try {
      const address = kaspa.addressFromScriptPublicKey(candidate, networkId);
      const text = address == null ? "" : String(address.toString ? address.toString() : address);
      if (text.startsWith("kaspa:") || text.startsWith("kaspatest:")) return text;
    } catch { /* try the next shape */ }
  }
  return "";
}

// ---------------------------------------------------------------------------
// Sender verification (audit DSK-045)
//
// A `kchat:1:bcast:` post carries no signature, so its author has to come from the
// transaction itself. The author is whoever signed the inputs: the address input 0 spends
// from (its previous outpoint's script). Output 0 alone proves nothing - anyone can pay 0.2
// KAS to someone else's address with a broadcast payload and so "post as" them. A post is
// therefore accepted only in the self-send shape every KaChat client writes: output 0 pays
// the SAME address input 0 spends from, and that address is the sender. Anything else is
// dropped (logged with its txid, never shown, never counted, never notified). When input 0's
// address cannot be found out, the post is NOT attributed to output 0: it is retried, then
// dropped.
//
// Where input 0's address comes from, cheapest first:
//   1. the node's own data, when it attaches the spent UTXO to the input (verbose
//      `utxoEntry`); block-added notifications from today's nodes leave it out,
//   2. the outputs of a broadcast transaction this engine already saw in the stream (an
//      honest poster's next post usually spends the previous post's change),
//   3. the Kaspa REST API (`getEndpoint("kaspaApi")`): `/transactions/{id}` or
//      `POST /transactions/search` with `resolve_previous_outpoints=light`, whose inputs carry
//      `previous_outpoint_address`.
// ---------------------------------------------------------------------------

export const BROADCAST_SENDER = Object.freeze({
  VERIFIED: "verified", // self-send shape: sender = input 0's address = output 0's address
  FORGED: "forged",     // output 0 pays someone other than the input-0 spender: drop
  UNKNOWN: "unknown",   // input 0's (or output 0's) address not known (yet): never shown as-is
});

/** Input 0's previous outpoint as `{ transactionId, index }`, or null. */
export function broadcastInputOutpoint(tx) {
  const input = Array.isArray(tx?.inputs) ? tx.inputs[0] : null;
  const outpoint = input?.previousOutpoint || input?.previous_outpoint || input?.outpoint || null;
  const transactionId = String(outpoint?.transactionId || outpoint?.transaction_id || "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(transactionId)) return null;
  const index = Number(outpoint?.index ?? 0);
  if (!Number.isInteger(index) || index < 0) return null;
  return { transactionId, index };
}

/** Input 0's address from the node's own data (the spent UTXO attached to the input), or "". */
function inputVerboseAddress(kaspa, input, networkId) {
  const verbose = input?.verboseData || input?.verbose_data || null;
  const entry = verbose?.utxoEntry || verbose?.utxo_entry || input?.utxoEntry || input?.utxo_entry || input?.utxo || null;
  if (!entry || typeof entry !== "object") return "";
  const entryVerbose = entry.verboseData || entry.verbose_data || null;
  const direct = cleanAddress(entryVerbose?.scriptPublicKeyAddress || entryVerbose?.script_public_key_address || entry.address || "");
  if (direct) return direct;
  return addressFromScriptPublicKey(kaspa, entry.scriptPublicKey ?? entry.script_public_key ?? null, networkId);
}

/**
 * The one acceptance rule. `{ verdict, senderAddress }`: VERIFIED only when both addresses are
 * known and equal (sender = that address); FORGED when they differ; UNKNOWN otherwise.
 */
export function judgeBroadcastSender(inputAddress, outputAddress0) {
  const input = cleanAddress(inputAddress);
  const output = cleanAddress(outputAddress0);
  if (!input || !output) return { verdict: BROADCAST_SENDER.UNKNOWN, senderAddress: "" };
  if (input !== output) return { verdict: BROADCAST_SENDER.FORGED, senderAddress: "", inputAddress: input, outputAddress: output };
  return { verdict: BROADCAST_SENDER.VERIFIED, senderAddress: input };
}

/** Input 0's previous-outpoint address and output 0's address of a Kaspa REST transaction. */
export function restBroadcastSenderShape(restTx) {
  const first = (list) => {
    const items = Array.isArray(list) ? list : [];
    const byIndex = items.find((item) => item && item.index != null && Number(item.index) === 0);
    if (byIndex) return byIndex;
    return items[0] && items[0].index == null ? items[0] : null;
  };
  const input = first(restTx?.inputs);
  const output = first(restTx?.outputs);
  return {
    inputAddress: cleanAddress(
      input?.previous_outpoint_address || input?.previousOutpointAddress
      || input?.previous_outpoint_resolved?.script_public_key_address
      || input?.previousOutpointResolved?.scriptPublicKeyAddress || ""),
    outputAddress: cleanAddress(output?.script_public_key_address || output?.scriptPublicKeyAddress || ""),
  };
}

/**
 * Pulls the block out of a `block-added` RPC event. The WASM client hands over
 * `{ type: "block-added", data: { block } }`; tolerate being given the notification or the
 * block itself so a future shape change degrades to "no hits" rather than a thrown error.
 */
export function blockFromBlockAddedEvent(event) {
  if (!event || typeof event !== "object") return null;
  if (Array.isArray(event.transactions)) return event;
  const data = event.data ?? event;
  if (data?.block && Array.isArray(data.block.transactions)) return data.block;
  if (Array.isArray(data?.transactions)) return data;
  if (data?.data?.block && Array.isArray(data.data.block.transactions)) return data.data.block;
  return null;
}

/**
 * Every broadcast payload carried by one block, as
 * `{ txId, channel, senderAddress, content, blockTime }` rows — the SAME row shape
 * `fetchBroadcastHistory` returns, so both paths feed one merge/dedupe function upstream —
 * plus the sender-verification fields (DSK-045):
 *   `senderVerdict`  BROADCAST_SENDER.VERIFIED | FORGED | UNKNOWN
 *   `senderAddress`  the verified sender, "" unless VERIFIED (never output 0 on its own)
 *   `outputAddress`  output 0's address ("" if unreadable), `inputAddress` input 0's ("" if
 *                    not known here), `inputOutpoint` input 0's `{ transactionId, index }`,
 *   `outputAddresses` every output's address in order (for resolving later posts locally).
 * UNKNOWN rows must go through `BroadcastSenderVerifier.verifyHit` before they are shown.
 * `resolveOutpointAddress(transactionId, index)` may supply input 0's address from data the
 * caller already holds. Allocation-light: the common case is a block with zero broadcast
 * payloads, which costs one string comparison per transaction.
 */
export function extractBroadcastHitsFromBlock(kaspa, eventOrBlock, { networkId = "mainnet", onUnusable = null, resolveOutpointAddress = null } = {}) {
  const block = blockFromBlockAddedEvent(eventOrBlock);
  if (!block) return [];
  const transactions = Array.isArray(block.transactions) ? block.transactions : [];
  if (transactions.length === 0) return [];
  const headerTime = toNumber(block.header?.timestamp);
  // Per-transaction verbose data is the primary source of the txid, but a node/build that
  // omits it still lists the ids on the block, in transaction order.
  const blockVerbose = block.verboseData || block.verbose_data || null;
  const blockTxIds = Array.isArray(blockVerbose?.transactionIds) ? blockVerbose.transactionIds
    : Array.isArray(blockVerbose?.transaction_ids) ? blockVerbose.transaction_ids
    : null;
  const hits = [];
  for (let index = 0; index < transactions.length; index += 1) {
    const tx = transactions[index];
    const hex = normalizedPayloadHex(tx?.payload);
    if (!hex.startsWith(BROADCAST_PREFIX_HEX) && !hex.startsWith(LEGACY_BROADCAST_PREFIX_HEX)) continue;
    let parsed = null;
    try { parsed = parseBroadcastPayload(TEXT_DECODER.decode(hexToBytes(hex))); } catch { parsed = null; }
    if (!parsed) continue;
    const verbose = tx?.verboseData || tx?.verbose_data || null;
    const txId = String(
      verbose?.transactionId || verbose?.transaction_id || tx?.id || blockTxIds?.[index] || "");
    // A recognised broadcast payload we cannot turn into a row is a real (and otherwise
    // invisible) failure - the caller logs it rather than dropping the message in silence.
    if (!txId) { onUnusable?.("the node sent no transaction id with the block"); continue; }
    const outputs = Array.isArray(tx?.outputs) ? tx.outputs : [];
    const outputAddresses = outputs.map((output) => outputAddress(kaspa, output, networkId));
    const inputOutpoint = broadcastInputOutpoint(tx);
    let inputAddress = inputVerboseAddress(kaspa, Array.isArray(tx?.inputs) ? tx.inputs[0] : null, networkId);
    if (!inputAddress && inputOutpoint && typeof resolveOutpointAddress === "function") {
      try { inputAddress = cleanAddress(resolveOutpointAddress(inputOutpoint.transactionId, inputOutpoint.index)); }
      catch { inputAddress = ""; }
    }
    const judged = judgeBroadcastSender(inputAddress, outputAddresses[0] || "");
    hits.push({
      txId,
      channel: parsed.channel,
      senderAddress: judged.senderAddress,
      content: parsed.content,
      blockTime: toNumber(verbose?.blockTime || verbose?.block_time) || headerTime || Date.now(),
      senderVerdict: judged.verdict,
      outputAddress: outputAddresses[0] || "",
      inputAddress,
      inputOutpoint,
      outputAddresses,
    });
  }
  return hits;
}

/** Wait before each REST attempt for a live post (~95 s in all): the REST API indexes a block a
 *  moment after the node streams it, so the first look waits too. */
const LIVE_VERIFY_DELAYS_MS = Object.freeze([1_500, 3_000, 5_000, 10_000, 25_000, 50_000]);
const REST_TIMEOUT_MS = 12_000;
const REST_BATCH = 100;
const MAX_REMEMBERED = 20_000;

function rememberBounded(map, key, value) {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  if (map.size > MAX_REMEMBERED) map.delete(map.keys().next().value);
}

/**
 * Decides who really sent a public-chat post (DSK-045) for every path that ingests them: the
 * live block stream (`verifyHit`), and rows read from an indexer (`verifyRows`). Final verdicts
 * (VERIFIED / FORGED) are remembered per txid; UNKNOWN never is, so it is asked again later.
 * Everything network-facing is injectable for tests.
 */
export class BroadcastSenderVerifier {
  constructor({
    fetchImpl = null,
    restBase = () => getEndpoint("kaspaApi"),
    log = () => {},
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = () => Date.now(),
    liveDelaysMs = LIVE_VERIFY_DELAYS_MS,
  } = {}) {
    this.fetchImpl = fetchImpl || ((...args) => fetch(...args));
    this.restBase = restBase;
    this.log = log;
    this.sleep = sleep;
    this.now = now;
    this.liveDelaysMs = liveDelaysMs;
    this.verdicts = new Map();      // txId -> { verdict, senderAddress } (final verdicts only)
    this.outputs = new Map();       // txId -> [address per output index] (broadcast txs seen live)
    this.inflight = new Map();      // txId -> Promise<verdict> (live verification under way)
    this.rowBackoff = new Map();    // txId -> { attempts, nextAt } (indexer rows still UNKNOWN)
    this.droppedLogged = new Set();
  }

  /** `{ verdict, senderAddress }` once a txid has a final verdict, else null. */
  verdictFor(txId) {
    return this.verdicts.get(String(txId || "").toLowerCase()) || null;
  }

  remember(txId, judged) {
    const key = String(txId || "").toLowerCase();
    if (!key || !judged || judged.verdict === BROADCAST_SENDER.UNKNOWN) return;
    rememberBounded(this.verdicts, key, { verdict: judged.verdict, senderAddress: judged.senderAddress || "" });
    this.rowBackoff.delete(key);
  }

  /** A post this engine signed and sent itself: its sender is known without asking anyone. */
  rememberOwnBroadcast(txId, address) {
    const sender = cleanAddress(address);
    if (sender) this.remember(txId, { verdict: BROADCAST_SENDER.VERIFIED, senderAddress: sender });
  }

  /** Outputs of a broadcast transaction seen in the stream, so a later post spending one of
   *  them resolves its input 0 without a lookup. */
  rememberOutputs(txId, addresses) {
    const key = String(txId || "").toLowerCase();
    if (!key || !Array.isArray(addresses) || addresses.length === 0) return;
    rememberBounded(this.outputs, key, addresses.map((address) => cleanAddress(address)));
  }

  outpointAddress(transactionId, index) {
    const list = this.outputs.get(String(transactionId || "").toLowerCase());
    return (list && list[Number(index)]) || "";
  }

  /** Logs a dropped post once per txid. */
  logDropped(txId, channel, reason) {
    const key = String(txId || "").toLowerCase();
    if (this.droppedLogged.has(key)) return;
    this.droppedLogged.add(key);
    if (this.droppedLogged.size > MAX_REMEMBERED) this.droppedLogged.clear();
    this.log(`Public chat: dropped a #${channel || "?"} post, tx ${txId}: ${reason}.`);
  }

  /** Why a verdict means "not shown", for the log line. */
  static dropReason(judged) {
    if (judged?.verdict === BROADCAST_SENDER.FORGED) {
      return `output 0 pays ${judged.outputAddress} but input 0 spends from ${judged.inputAddress} (not a self-send, possible impersonation)`;
    }
    return "the address input 0 spends from could not be found out, so the sender is unverified";
  }

  /** Sync verdict for a live hit from what is already known (no network). */
  settleHit(hit) {
    const cached = this.verdictFor(hit?.txId);
    if (cached) return cached;
    let judged = hit?.senderVerdict && hit.senderVerdict !== BROADCAST_SENDER.UNKNOWN
      ? judgeBroadcastSender(hit.inputAddress, hit.outputAddress)
      : { verdict: BROADCAST_SENDER.UNKNOWN, senderAddress: "" };
    if (judged.verdict === BROADCAST_SENDER.UNKNOWN && hit?.inputOutpoint) {
      const local = this.outpointAddress(hit.inputOutpoint.transactionId, hit.inputOutpoint.index);
      if (local) judged = judgeBroadcastSender(local, hit.outputAddress);
    }
    this.remember(hit?.txId, judged);
    return judged;
  }

  /**
   * Final verdict for a live hit, asking the REST API with retries when nothing local settles
   * it. Resolves UNKNOWN after the last attempt - the caller drops the post (never shows it
   * under output 0's address). One verification per txid at a time: the same transaction
   * arrives once per DAG block that carries it.
   */
  verifyHit(hit) {
    const key = String(hit?.txId || "").toLowerCase();
    const settled = this.settleHit(hit);
    if (settled.verdict !== BROADCAST_SENDER.UNKNOWN) return Promise.resolve(settled);
    if (this.inflight.has(key)) return this.inflight.get(key);
    const run = (async () => {
      for (const delay of this.liveDelaysMs) {
        await this.sleep(delay);
        const local = this.settleHit(hit);
        if (local.verdict !== BROADCAST_SENDER.UNKNOWN) return local;
        let shape = null;
        try { shape = (await this.lookupRest([key])).get(key) || null; }
        catch { shape = null; }
        if (!shape) continue;
        // Output 0 as the node streamed it when it was readable, else as the REST API has it.
        const judged = judgeBroadcastSender(shape.inputAddress, hit.outputAddress || shape.outputAddress);
        if (judged.verdict !== BROADCAST_SENDER.UNKNOWN) { this.remember(key, judged); return judged; }
      }
      return { verdict: BROADCAST_SENDER.UNKNOWN, senderAddress: "" };
    })().finally(() => { this.inflight.delete(key); });
    this.inflight.set(key, run);
    return run;
  }

  /**
   * Verifies rows read from a broadcast indexer (`{ txId, senderAddress, ... }`, where
   * `senderAddress` is only the indexer's guess). Resolves `{ accepted, forged, unknown }`:
   * `accepted` rows carry the VERIFIED sender in `senderAddress`; `forged` rows are dropped and
   * logged; `unknown` rows (the REST API had no answer yet) back off and are asked again on a
   * later call, never shown in the meantime.
   */
  async verifyRows(rows, { channel = "" } = {}) {
    const accepted = [];
    const forged = [];
    const unknown = [];
    const ask = [];
    const nowMs = this.now();
    for (const row of Array.isArray(rows) ? rows : []) {
      const key = String(row?.txId || "").toLowerCase();
      if (!key) continue;
      const cached = this.verdictFor(key);
      if (cached) {
        if (cached.verdict === BROADCAST_SENDER.VERIFIED) accepted.push({ ...row, senderAddress: cached.senderAddress });
        else forged.push(row);
        continue;
      }
      const backoff = this.rowBackoff.get(key);
      if (backoff && backoff.nextAt > nowMs) { unknown.push(row); continue; }
      ask.push(row);
    }
    if (ask.length) {
      let shapes = new Map();
      try { shapes = await this.lookupRest(ask.map((row) => String(row.txId).toLowerCase())); }
      catch { shapes = new Map(); }
      for (const row of ask) {
        const key = String(row.txId).toLowerCase();
        const shape = shapes.get(key);
        const judged = shape ? judgeBroadcastSender(shape.inputAddress, shape.outputAddress)
          : { verdict: BROADCAST_SENDER.UNKNOWN, senderAddress: "" };
        if (judged.verdict === BROADCAST_SENDER.VERIFIED) {
          this.remember(key, judged);
          accepted.push({ ...row, senderAddress: judged.senderAddress });
        } else if (judged.verdict === BROADCAST_SENDER.FORGED) {
          this.remember(key, judged);
          forged.push(row);
          this.logDropped(row.txId, row.channel || channel, BroadcastSenderVerifier.dropReason(judged));
        } else {
          const attempts = (this.rowBackoff.get(key)?.attempts || 0) + 1;
          rememberBounded(this.rowBackoff, key, { attempts, nextAt: nowMs + Math.min(60_000, 1_000 * 2 ** (attempts - 1)) });
          unknown.push(row);
        }
      }
    }
    return { accepted, forged, unknown };
  }

  /**
   * `Map<txId, { inputAddress, outputAddress }>` from the Kaspa REST API. One id: GET
   * `/transactions/{id}`; several: `POST /transactions/search` in batches (falling back to one
   * GET each if the search endpoint refuses). A txid the API does not know is simply absent.
   */
  async lookupRest(txIds) {
    const ids = [...new Set((txIds || []).map((id) => String(id || "").toLowerCase()).filter((id) => /^[0-9a-f]{64}$/.test(id)))];
    const out = new Map();
    const base = String(this.restBase?.() || "").trim().replace(/\/+$/, "");
    if (!base || ids.length === 0) return out;
    const put = (tx) => {
      const id = String(tx?.transaction_id || tx?.transactionId || "").toLowerCase();
      if (id) out.set(id, restBroadcastSenderShape(tx));
    };
    const getOne = async (id) => {
      const url = `${base}/transactions/${id}?inputs=true&outputs=true&resolve_previous_outpoints=light`;
      const response = await this.fetchJson(url);
      if (response) put(response);
    };
    if (ids.length === 1) { await getOne(ids[0]); return out; }
    for (let i = 0; i < ids.length; i += REST_BATCH) {
      const batch = ids.slice(i, i + REST_BATCH);
      const url = `${base}/transactions/search?fields=transaction_id,inputs,outputs&resolve_previous_outpoints=light`;
      const list = await this.fetchJson(url, { method: "POST", body: JSON.stringify({ transactionIds: batch }) });
      if (Array.isArray(list)) { for (const tx of list) put(tx); continue; }
      for (const id of batch) { try { await getOne(id); } catch { /* absent = unknown */ } }
    }
    return out;
  }

  /** Parsed JSON, or null for a non-OK answer. Throws on a network error or timeout. */
  async fetchJson(url, { method = "GET", body = undefined } = {}) {
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), REST_TIMEOUT_MS) : null;
    try {
      const headers = { Accept: "application/json" };
      if (body !== undefined) headers["Content-Type"] = "application/json";
      const response = await this.fetchImpl(url, { method, headers, body, cache: "no-store", signal: controller?.signal });
      if (!response?.ok) return null;
      return await response.json();
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

/** Publishes a broadcast into `channel`. Returns the txid (= the message id). */
/** Bytes the chain will carry for a broadcast of `content` to `channel` - what a fee estimate
 *  has to be quoted for. */
export function broadcastPayloadBytes(channel, content) {
  const name = normalizeBroadcastChannel(channel);
  return new TextEncoder().encode(`${BROADCAST_PAYLOAD_PREFIX}${name}:${String(content || "")}`).length;
}

export async function sendBroadcastMessage({ engine, channel, content, feeKas = "0", singleInput = false }) {
  const name = normalizeBroadcastChannel(channel);
  if (!isValidBroadcastChannel(name)) throw new Error("Invalid channel name.");
  const text = String(content || "").trim();
  if (!text) throw new Error("Message is empty.");
  if (!engine?.kaspa || !engine?.privateKey || !engine?.address) {
    throw new Error("Load WASM and generate/import a wallet first.");
  }
  await engine.connect();
  const protocolString = `kchat:1:bcast:${name}:${text}`;
  const sendResult = await sendPayloadTransaction({
    kaspa: engine.kaspa,
    rpc: engine.rpc,
    withRpc: engine.withRpc.bind(engine),
    privateKey: engine.privateKey,
    sourceAddress: engine.address,
    destinationAddress: engine.address, // self-send; the payload IS the message
    amountKas: "0.2",
    feeKas: String(feeKas || "0"),
    payload: new TextEncoder().encode(protocolString),
    singleInput,
    log: engine.log,
  });
  const txid = sendResult.txids?.[0] || "";
  if (!txid) throw new Error("Broadcast transaction returned no txid.");
  // This engine signed it, so its sender is known: when the post comes back from the chain it
  // is accepted without a REST lookup (DSK-045).
  try { engine.broadcastSenderVerifier?.rememberOwnBroadcast?.(txid, engine.address); } catch { /* verified the slow way */ }
  return txid;
}

/** True when a broadcast indexer is configured, i.e. the curated rooms have a history
 *  service. Custom rooms never have one - the indexer only tracks the curated set. */
export function hasBroadcastIndexer() {
  return String(getEndpoint("broadcastIndexer") || "").trim().length > 0;
}

/**
 * History page from the broadcast indexer. Returns `{ messages, hasMore }` with rows shaped
 * `{ txId, channel, senderAddress, content, blockTime }` — or throws; callers treat failures
 * as "no backfill" (nothing user-facing breaks, live sends still work).
 */
export async function fetchBroadcastHistory({ channel, limit = 200, before = null, baseUrl = null } = {}) {
  // A room may read from its own indexer (Room Info): any indexer watching the same network
  // serves the same room, so one room can point elsewhere without moving every other room.
  const base = String(baseUrl || getEndpoint("broadcastIndexer") || "").replace(/\/+$/, "");
  const url = new URL(`${base}/get-broadcasts`);
  url.searchParams.set("channel", normalizeBroadcastChannel(channel));
  url.searchParams.set("limit", String(Math.max(1, Math.min(500, Number(limit) || 200))));
  if (before) url.searchParams.set("before", String(before));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Broadcast indexer request failed (${response.status}).`);
    const json = await response.json();
    return {
      messages: Array.isArray(json?.messages) ? json.messages : [],
      hasMore: json?.hasMore === true,
    };
  } finally {
    clearTimeout(timer);
  }
}
