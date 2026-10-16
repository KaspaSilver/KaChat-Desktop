// Payment-pool envelopes and the one that lives on: `payment_notice` (iOS 927322b,
// ChatService+PaymentPools / PaymentPoolCodec, MESSAGING.md "Chat Payments From a Spending
// Address").
//
// A 1:1 chat payment From a spending address is a plain transfer the payee can't place (they
// have never seen that address), so the payer's chatting address sends an encrypted
// `payment_notice` in the chat right after it, and both sides file the payment in their 1:1 chat:
//   {"type":"payment_notice","txId":"<64 hex>","amountSompi":<int>,"address":"<payee's chatting address>","memo":"<optional>"}
// `addr_pool` / `addr_pool_request` are retired (iOS 6333dd3): dropped silently, never bubbles.
// A notice naming any other address (an old app paying one of our former pool addresses) is
// dropped too (XP-023).
//
// Pure helpers only - no DOM, no network - so tools/test-payment-notice.mjs can run them.

/** The longest note a notice carries or shows (iOS PaymentNoticeContent.maxMemoLength). */
export const PAYMENT_NOTICE_MAX_MEMO_LENGTH = 500;

let graphemeSegmenter = null;
function graphemes(text) {
  const value = String(text ?? "");
  try {
    graphemeSegmenter = graphemeSegmenter || new Intl.Segmenter(undefined, { granularity: "grapheme" });
    return Array.from(graphemeSegmenter.segment(value), (part) => part.segment);
  } catch {
    return Array.from(value);
  }
}

/** A memo as a notice carries it: trimmed, at most PAYMENT_NOTICE_MAX_MEMO_LENGTH characters
 *  (Swift's `prefix` counts characters, so graphemes here). */
export function clampPaymentNoticeMemo(memo) {
  const chars = graphemes(String(memo ?? "").trim());
  return (chars.length > PAYMENT_NOTICE_MAX_MEMO_LENGTH ? chars.slice(0, PAYMENT_NOTICE_MAX_MEMO_LENGTH).join("") : chars.join("")).trim();
}

/**
 * One of the three payment-pool envelope shapes, or null for anything else (unknown `type`
 * values fall through to the normal message pipeline, per the wire contract). The same shape
 * checks as iOS PaymentPoolCodec.parse: `{`-prefix and size guard first, since this runs on every
 * intercepted message.
 *   { kind: "pool" } | { kind: "request" } | { kind: "notice", notice: { txId, amountSompi, address, memo } }
 * `notice` here is only well-formed, not yet valid: see validPaymentNotice.
 */
export function parsePaymentPoolEnvelope(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed.startsWith("{") || trimmed.length > 100_000) return null;
  let parsed;
  try { parsed = JSON.parse(trimmed); } catch { return null; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  if (parsed.type === "addr_pool") return Array.isArray(parsed.addresses) ? { kind: "pool" } : null;
  if (parsed.type === "addr_pool_request") return { kind: "request" };
  if (parsed.type === "payment_notice") {
    // Codable's shape: strings, a non-negative integer amount, an optional string memo.
    const amount = parsed.amountSompi;
    if (typeof parsed.txId !== "string" || typeof parsed.address !== "string") return null;
    if (typeof amount !== "number" || !Number.isInteger(amount) || amount < 0) return null;
    if (parsed.memo != null && typeof parsed.memo !== "string") return null;
    return {
      kind: "notice",
      notice: {
        txId: parsed.txId,
        amountSompi: BigInt(amount),
        address: parsed.address,
        memo: typeof parsed.memo === "string" ? parsed.memo : "",
      },
    };
  }
  return null;
}

/** The notice from an envelope's text, or null when it is not a payment_notice. */
export function parsePaymentNotice(text) {
  const envelope = parsePaymentPoolEnvelope(text);
  return envelope?.kind === "notice" ? envelope.notice : null;
}

/**
 * A notice the app may file (iOS handlePaymentNotice's guards), normalized - or null to drop it:
 * the txId is 64 hex characters, the amount above zero, and the address it names is `paidAddress`
 * (the receiving side's chatting address: ours for a notice we received, the contact's for our own
 * notice read back). Returns { txId (lowercase), amountSompi (BigInt), address, memo (clamped) }.
 */
export function validPaymentNotice(notice, paidAddress) {
  if (!notice) return null;
  const txId = String(notice.txId || "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(txId)) return null;
  let amountSompi;
  try { amountSompi = BigInt(notice.amountSompi); } catch { return null; }
  if (amountSompi <= 0n) return null;
  const address = String(notice.address || "").trim();
  if (!address || !paidAddress || address.toLowerCase() !== String(paidAddress).trim().toLowerCase()) return null;
  return { txId, amountSompi, address, memo: clampPaymentNoticeMemo(notice.memo) };
}

/** The envelope the chatting address sends after a payment From a spending address (iOS
 *  sendSpendingPaymentNotice): txId lowercased, memo trimmed and clamped, omitted when empty.
 *  The amount is written as an exact integer (BigInt sompi never goes through a float). */
export function encodePaymentNotice({ txId, amountSompi, address, memo = "" }) {
  const id = String(txId || "").trim().toLowerCase();
  let amount;
  try { amount = BigInt(amountSompi); } catch { return ""; }
  if (!id || amount <= 0n || !address) return "";
  const note = clampPaymentNoticeMemo(memo);
  return `{"type":"payment_notice","txId":${JSON.stringify(id)},"amountSompi":${amount.toString()},"address":${JSON.stringify(String(address))}${note ? `,"memo":${JSON.stringify(note)}` : ""}}`;
}

/** A notice-filed payment bubble's text, the template every payment bubble uses ("Received X KAS",
 *  "Sent X KAS — memo"), which parsePaymentCardParts reads back for the card. */
export function paymentNoticeText({ amountKas, unit = "KAS", memo = "", outgoing = false }) {
  const head = `${outgoing ? "Sent" : "Received"} ${amountKas} ${unit}`;
  return memo ? `${head} — ${memo}` : head;
}

/** A chat payment's notification body, under the payer's name as the title (iOS dcb329a
 *  NotificationService.handlePayment): "Sent you 1.5 KAS" - the amount without trailing zeros -
 *  or "Sent you a payment" when the amount is unknown or zero. `amountSompi` (integer sompi) wins
 *  over `amountKas` (KAS text); `unit` is the network's (TKAS on testnet, as iOS unitLabel). A
 *  notice-filed payment is not one of these: it reads "Received payment", never the amount it
 *  claims (iOS 927322b, IOS-080). */
export function chatPaymentNotificationBody({ amountSompi = null, amountKas = null, unit = "KAS" } = {}) {
  let sompi = null;
  try {
    if (amountSompi != null && String(amountSompi).trim() !== "") sompi = BigInt(amountSompi);
  } catch { sompi = null; }
  if (sompi == null && amountKas != null) {
    const m = /^\s*([0-9]+)(?:\.([0-9]*))?\s*$/.exec(String(amountKas));
    if (m) {
      const fraction = String(m[2] || "").slice(0, 8).padEnd(8, "0");
      sompi = BigInt(m[1]) * 100_000_000n + BigInt(fraction);
    }
  }
  if (sompi == null || sompi <= 0n) return "Sent you a payment";
  const whole = sompi / 100_000_000n;
  const fraction = (sompi % 100_000_000n).toString().padStart(8, "0").replace(/0+$/, "");
  return `Sent you ${whole}${fraction ? `.${fraction}` : ""} ${unit}`;
}

/** What a REST transaction (`/transactions/{txid}`) paid `address`, in BigInt sompi. */
export function sompiPaidToAddress(tx, address) {
  const target = String(address || "").trim().toLowerCase();
  if (!target) return 0n;
  let total = 0n;
  for (const output of Array.isArray(tx?.outputs) ? tx.outputs : []) {
    const outputAddress = String(output?.script_public_key_address || output?.scriptPublicKeyAddress || "").toLowerCase();
    if (outputAddress !== target) continue;
    try { total += BigInt(output?.amount ?? 0); } catch { /* an unreadable amount pays nothing */ }
  }
  return total;
}

/**
 * Where a notice may put the payment it names (IOS-083, iOS 3eaa0b6), given every stored row with
 * that txid - `{ chat: "this" | "self" | "other", direction, messageType, fromKnown }` (`fromKnown`:
 * its sender is a contact or ours) - and the notice's direction:
 *   "file" - shown nowhere yet: a new bubble in this chat;
 *   "move" - shown only in the self-chat, as received payments from an address that is no contact
 *            (a plain transfer, "From: <address>"), and the notice is one we received: it moves
 *            into this chat - the first notice to claim it wins;
 *   "drop" - anything else. A row in this chat is already placed (never refiled the other way
 *            round), and a row in any other chat - another contact's payment, or a message we sent
 *            someone - is never taken by a notice.
 */
export function paymentNoticePlacement(rows, direction) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return "file";
  if (list.some((row) => row?.chat !== "self")) return "drop";
  const plainReceived = list.every((row) => row.direction === "incoming" && row.messageType === "payment" && !row.fromKnown);
  return direction === "incoming" && plainReceived ? "move" : "drop";
}

/**
 * The chain's verdict on a notice we received (IOS-083), from the REST transaction read with its
 * inputs resolved (`resolve_previous_outpoints=light`): `{ ok: true }` only when it pays
 * `paidAddress` exactly `claimedSompi`, carries no payload (a chat payment From a spending address
 * is a plain transfer) and none of its inputs is one of `foreignAddresses` (ours, or another
 * contact's: that payment is not this contact's to claim). Else `{ ok: false, reason }`, with
 * `unknown: true` when the inputs' addresses weren't resolved (as good as no chain answer).
 */
export function checkPaymentNoticeTx(tx, { paidAddress, claimedSompi, foreignAddresses = [] } = {}) {
  let claimed;
  try { claimed = BigInt(claimedSompi); } catch { return { ok: false, reason: "has no amount" }; }
  const paid = sompiPaidToAddress(tx, paidAddress);
  if (paid === 0n) return { ok: false, reason: "pays nothing to the chatting address" };
  if (paid !== claimed) return { ok: false, reason: "pays a different amount than it says" };
  const payload = String(tx?.payload ?? "").trim();
  if (payload && !/^0*$/.test(payload)) return { ok: false, reason: "carries a payload, so it is not a plain transfer" };
  const foreign = new Set((foreignAddresses || []).map((address) => String(address || "").trim().toLowerCase()).filter(Boolean));
  const inputs = (Array.isArray(tx?.inputs) ? tx.inputs : [])
    .map((input) => String(input?.previous_outpoint_address || input?.previousOutpointAddress || "").trim().toLowerCase())
    .filter(Boolean);
  if (!inputs.length) return { ok: false, unknown: true, reason: "has no readable inputs yet" };
  if (inputs.some((from) => foreign.has(from))) return { ok: false, reason: "was paid from an address that is yours or another contact's" };
  return { ok: true };
}
