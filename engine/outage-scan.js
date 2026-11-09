// While the indexer is down the block stream is the only place some things can be seen (iOS
// 4f8e14bb): invites to groups this wallet doesn't hold yet, and first-contact messages from people
// it isn't watching. The blocks say who a transaction claims to be from (its first output); only
// the input's signature proves it, read from the REST API with `verifyIncomingPayment`.
import { blockFromBlockAddedEvent } from "./broadcasts.js";
import { DM_PREFIX } from "./kasia-protocol.js";

const TEXT = new TextEncoder();
const FROM_UTF8 = new TextDecoder("utf-8", { fatal: true });
const hexOfText = (text) => Array.from(TEXT.encode(String(text)), (b) => b.toString(16).padStart(2, "0")).join("");
const bytesHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

const GCOMM_PREFIXES = ["kchat:1:gcomm:", "ciph_msg:1:gcomm:"].map(hexOfText);
const GCTL_PREFIXES = ["kchat:1:gctl:", "ciph_msg:1:gctl:"].map(hexOfText);

/** Asked again after this long when the REST API doesn't list the transaction yet (iOS inboxProofRetries). */
export const PROOF_RETRY_DELAYS_MS = Object.freeze([3_000, 6_000, 9_000]);
const SEEN_LIMIT = 2_000;

export const payloadHexOf = (payload) => {
  if (payload == null) return "";
  if (typeof payload === "string") return payload.trim().toLowerCase();
  if (payload instanceof Uint8Array) return bytesHex(payload);
  if (Array.isArray(payload)) return bytesHex(Uint8Array.from(payload));
  if (ArrayBuffer.isView(payload)) return bytesHex(new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength));
  return "";
};

function textOfHex(hex) {
  if (!/^(?:[0-9a-f]{2})+$/.test(hex)) return null;
  try { return FROM_UTF8.decode(Uint8Array.from(hex.match(/../g), (pair) => parseInt(pair, 16))); }
  catch { return null; }
}

/** `{ kind: "control" | "message", payloadString }` for a group payload, or null. */
export function groupPayloadFromHex(payloadHex) {
  const hex = String(payloadHex || "").toLowerCase();
  const kind = GCTL_PREFIXES.some((prefix) => hex.startsWith(prefix)) ? "control"
    : GCOMM_PREFIXES.some((prefix) => hex.startsWith(prefix)) ? "message" : null;
  if (!kind) return null;
  const payloadString = textOfHex(hex);
  return payloadString ? { kind, payloadString } : null;
}

const toNumber = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

function firstOutputAddress(kaspa, tx, networkId) {
  const output = Array.isArray(tx?.outputs) ? tx.outputs[0] : null;
  const verbose = output?.verboseData || output?.verbose_data || null;
  const named = String(verbose?.scriptPublicKeyAddress || verbose?.script_public_key_address || "").trim();
  if (named) return named;
  const script = output?.scriptPublicKey ?? output?.script_public_key ?? null;
  if (script == null || typeof kaspa?.addressFromScriptPublicKey !== "function") return "";
  try {
    const address = kaspa.addressFromScriptPublicKey(script, networkId);
    return address == null ? "" : String(address);
  } catch { return ""; }
}

function eachBlockTransaction(event, visit) {
  const block = blockFromBlockAddedEvent(event);
  const transactions = Array.isArray(block?.transactions) ? block.transactions : [];
  if (!transactions.length) return;
  const blockVerbose = block.verboseData || block.verbose_data || null;
  const blockIds = blockVerbose?.transactionIds || blockVerbose?.transaction_ids || null;
  const headerTime = toNumber(block.header?.timestamp);
  transactions.forEach((tx, index) => {
    const verbose = tx?.verboseData || tx?.verbose_data || null;
    visit(tx, {
      txId: String(verbose?.transactionId || verbose?.transaction_id || tx?.id || blockIds?.[index] || ""),
      blockTime: toNumber(verbose?.blockTime || verbose?.block_time) || headerTime,
    });
  });
}

/** One block's group traffic as indexer-shaped rows, plus `kind`:
 *  `{ kind, txId, sender, blockTime, cursor: null, payloadString }`. A control row's `sender` is its
 *  first output's address, only a claim until proven; a message row's is null (it is signed). */
export function groupRowsFromBlock(kaspa, event, { networkId = "mainnet" } = {}) {
  const rows = [];
  eachBlockTransaction(event, (tx, { txId, blockTime }) => {
    const found = groupPayloadFromHex(payloadHexOf(tx?.payload));
    if (!found || !txId) return;
    rows.push({
      kind: found.kind,
      txId,
      sender: found.kind === "control" ? (firstOutputAddress(kaspa, tx, networkId) || null) : null,
      blockTime,
      cursor: null,
      payloadString: found.payloadString,
    });
  });
  return rows;
}

/** "proven" | "forged" | "unknown": whether `expected` really spent the inputs of `txId` (iOS
 *  provenSender). "unknown" is the REST API not knowing yet, never a judgement. */
export async function provenTxSender({ txId, expected, raw = null, fetchTx, verify }) {
  let tx = raw;
  if (!tx) { try { tx = await fetchTx(txId); } catch { tx = null; } }
  if (!tx) return "unknown";
  let verdict;
  try { verdict = await verify(tx, txId, ""); } catch { return "unknown"; }
  if (verdict?.check === "invalid") return "forged";
  if (verdict?.check !== "valid" || !verdict.sender) return "unknown";
  return String(verdict.sender).toLowerCase() === String(expected || "").toLowerCase() ? "proven" : "forged";
}

/** Asks again while the answer is "unknown" and `wanted()` holds; "unknown" if it never settles. */
export async function proofWithRetries(ask, { delays = PROOF_RETRY_DELAYS_MS, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), wanted = () => true } = {}) {
  let proof = await ask();
  for (const delay of delays) {
    if (proof !== "unknown" || !wanted()) break;
    await sleep(delay);
    if (!wanted()) break;
    proof = await ask();
  }
  return proof;
}

/** Watches blocks for first-contact messages tagged for `wallet`. `onHit` gets one
 *  `{ sender, txid, blockTime, payloadHex }` per transaction: the first three are a
 *  `fetchInboxMessages` row, `sender` proven by the input's signature, and `payloadHex` is the
 *  whole `kchat:1:dm:<tag>:<alias>:<sealed>` for decrypting. A scan stopped while a proof is out
 *  delivers nothing from it. */
export function createInboxBlockScan({ kaspa = null, networkId = "mainnet", wallet, tag, onHit, prove, isCurrent = () => true, retryDelays = PROOF_RETRY_DELAYS_MS, sleep } = {}) {
  const prefixHex = hexOfText(`${DM_PREFIX}${tag}:`);
  const seen = new Set();
  let stopped = false;
  const wanted = () => !stopped && isCurrent();
  async function ingest(tx, { txId, blockTime }) {
    const sender = firstOutputAddress(kaspa, tx, networkId);
    if (!sender || sender.toLowerCase() === String(wallet).toLowerCase()) return;
    const proof = await proofWithRetries(() => prove(txId, sender), { delays: retryDelays, sleep, wanted });
    if (proof !== "proven" || !wanted()) return;
    scan.onHit({ sender, txid: txId, blockTime, payloadHex: payloadHexOf(tx.payload) });
  }
  const scan = {
    wallet,
    tag,
    onHit,
    handleBlock(event) {
      if (!wanted()) return;
      eachBlockTransaction(event, (tx, details) => {
        if (!details.txId || !payloadHexOf(tx?.payload).startsWith(prefixHex) || seen.has(details.txId)) return;
        if (seen.size >= SEEN_LIMIT) seen.clear();
        seen.add(details.txId);
        ingest(tx, details).catch(() => {});
      });
    },
    stop() { stopped = true; },
  };
  return scan;
}
