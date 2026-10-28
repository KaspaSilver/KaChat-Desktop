// Payment requests (iOS PaymentRequest in LinkPreviewService.swift, c6851d6 / 7c71a98): who to
// pay, the exact amount and what it's for, carried in a link. Made in Chats > + > Request Payment
// (or a 1:1 chat's + sheet); pasting or tapping one anywhere in KaChat opens Send Kaspa filled in.
//
//   https://kachat.app/pay/<address>?amount=<KAS>&memo=<text>[&chat=1]&by=<maker>&sig=<hex>
//   kachat://pay/<address>?...                                   (the same tail)
//
// - the address without `kaspa:` on mainnet (like profile links), with `kaspatest:` on testnet;
// - `amount` in KAS, at most 8 decimals, "." as the separator;
// - `memo` optional, at most 140 characters, every byte outside A-Z a-z 0-9 - . _ ~ escaped;
// - `chat=1` when the address is the requester's chatting address (paid as a chat payment, the
//   memo encrypted inside); a spending address can't read a memo, so there it only tells the payer;
// - `by` + `sig` (7c71a98): the maker's chatting address and its BIP340 Schnorr signature over
//   SHA-256 of the signing string below. A link whose signature doesn't check out is refused; one
//   without both shows "Not signed".
//
// Everything in a link is attacker-controlled: the address must be valid on the running network,
// the amount positive and exact, and the memo is cleaned of control and direction marks. Pure: no
// DOM, no storage, so tools/test-payment-request.mjs runs it in node.
import { sha256 } from "@noble/hashes/sha2.js";
import { schnorr } from "@noble/curves/secp256k1.js";
import { sompiFromUserText, kasTextFromSompi } from "./amounts.js";
import { ADDRESS_HRP } from "./network.js";

export const PAYMENT_REQUEST_MEMO_LIMIT = 140;
/** The domain tag that leads the signing string, so the signature can't pass for anything else. */
export const PAYMENT_REQUEST_DOMAIN = "kachat-payment-request:v1";
export const PAYMENT_REQUEST_HOST = "kachat.app";

const UTF8 = new TextEncoder();
const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const GENERATORS = [0x98f2bc8e61n, 0x79b76d99e2n, 0xf33e5fb3c4n, 0xae2eabe2a8n, 0x1e4f43e470n];
// iOS: 32-byte aux of zeros (swift-secp256k1 auxiliaryRand: nil), so a signature is deterministic
// and byte-identical on every client.
const ZERO_AUX = new Uint8Array(32);

function polymod(values) {
  let c = 1n;
  for (const d of values) {
    const c0 = c >> 35n;
    c = ((c & 0x07ffffffffn) << 5n) ^ BigInt(d);
    for (let i = 0; i < 5; i += 1) if ((c0 >> BigInt(i)) & 1n) c ^= GENERATORS[i];
  }
  return c ^ 1n;
}

/** `{ hrp, version, payload }` of a checksummed Kaspa address, or null. */
function decodeKaspaAddress(address) {
  const lower = String(address ?? "");
  const colon = lower.indexOf(":");
  if (colon < 1 || lower.indexOf(":", colon + 1) !== -1) return null;
  const hrp = lower.slice(0, colon);
  const body = lower.slice(colon + 1);
  if (hrp !== "kaspa" && hrp !== "kaspatest") return null;
  const values = [];
  for (const ch of body) {
    const i = CHARSET.indexOf(ch);
    if (i < 0) return null;
    values.push(i);
  }
  if (values.length < 9) return null;
  const prefix = Array.from(hrp, (ch) => ch.charCodeAt(0) & 0x1f);
  if (polymod([...prefix, 0, ...values]) !== 0n) return null;
  let acc = 0, bits = 0;
  const bytes = [];
  for (const v of values.slice(0, -8)) {
    acc = ((acc << 5) | v) & 0xffff;
    bits += 5;
    if (bits >= 8) { bits -= 8; bytes.push((acc >> bits) & 0xff); }
  }
  if (!bytes.length) return null;
  return { hrp, version: bytes[0], payload: Uint8Array.from(bytes.slice(1)) };
}

/** A valid address of the network `hrp` (iOS KaspaAddress.isValidOnActiveNetwork): checksum, and
 *  a Schnorr (32), ECDSA (33) or P2SH (32) payload. A request can't cross networks. */
export function isPaymentAddress(address, hrp = ADDRESS_HRP) {
  const decoded = decodeKaspaAddress(address);
  if (!decoded || decoded.hrp !== hrp) return false;
  const { version, payload } = decoded;
  return (version === 0 && payload.length === 32) || (version === 1 && payload.length === 33) || (version === 8 && payload.length === 32);
}

/** The x-only key a Schnorr address carries (iOS KaspaAddress.publicKey(from:) with count 32). */
function xOnlyKeyOf(address) {
  const decoded = decodeKaspaAddress(address);
  return decoded && decoded.version === 0 && decoded.payload.length === 32 ? decoded.payload : null;
}

function bytesToHex(bytes) {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}
function hexToBytes(hex) {
  const clean = String(hex || "");
  if (clean.length % 2 || /[^0-9a-fA-F]/.test(clean)) return null;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// Control (Cc) and format (Cf) scalars plus the zero-width and direction marks, as iOS cleanMemo.
// Lone surrogates can't exist in a Swift string; dropping them keeps the memo encodable here.
const MEMO_STRIP_RE = /[\p{Cc}\p{Cf}\p{Cs}​-‏‪-‮⁦-⁩﻿]/gu;
let graphemeSegmenter = null;
/** Characters as Swift counts them (grapheme clusters), for the 140 limit. */
export function memoCharacters(text) {
  const value = String(text ?? "");
  try {
    graphemeSegmenter = graphemeSegmenter || new Intl.Segmenter(undefined, { granularity: "grapheme" });
    return Array.from(graphemeSegmenter.segment(value), (part) => part.segment);
  } catch {
    return Array.from(value);
  }
}
/** The first `limit` characters of `text` (the memo field's clamp, iOS prefix(memoLimit)). */
export function clampMemoText(text, limit = PAYMENT_REQUEST_MEMO_LIMIT) {
  const chars = memoCharacters(text);
  return chars.length > limit ? chars.slice(0, limit).join("") : String(text ?? "");
}
/** iOS PaymentRequest.cleanMemo: control/format/direction marks out, trimmed, 140 characters. */
export function cleanPaymentMemo(memo) {
  return clampMemoText(String(memo ?? "").replace(MEMO_STRIP_RE, "").trim());
}

/** A request; the memo is always cleaned (iOS init). `signature` is lowercase hex or null. */
export function makePaymentRequest({ address, amountSompi, memo = "", toChattingAddress = false, creator = null, signature = null }) {
  return {
    address: String(address || ""),
    amountSompi: BigInt(amountSompi),
    memo: cleanPaymentMemo(memo),
    toChattingAddress: Boolean(toChattingAddress),
    creator: creator ? String(creator) : null,
    signature: signature ? String(signature).toLowerCase() : null,
  };
}

/** What the maker signs (iOS signingDigest): the domain tag and every field, one per line. */
export function paymentRequestSigningString(request, creator) {
  return [
    PAYMENT_REQUEST_DOMAIN,
    String(request.address).toLowerCase(),
    BigInt(request.amountSompi).toString(),
    request.memo,
    request.toChattingAddress ? "1" : "0",
    String(creator).toLowerCase(),
  ].join("\n");
}
export function paymentRequestDigest(request, creator) {
  return sha256(UTF8.encode(paymentRequestSigningString(request, creator)));
}

/** This request signed by `creator` (the chatting address) with its key, or null. */
export function signPaymentRequest(request, creator, privateKey) {
  try {
    const key = typeof privateKey === "string" ? hexToBytes(privateKey) : privateKey;
    if (!key || key.length !== 32) return null;
    const signature = schnorr.sign(paymentRequestDigest(request, creator), key, ZERO_AUX);
    return makePaymentRequest({ ...request, creator: String(creator).toLowerCase(), signature: bytesToHex(signature) });
  } catch {
    return null;
  }
}

/** True when `signatureHex` is `creator`'s over `request` (iOS PaymentRequest.verify). */
export function verifyPaymentRequestSignature(signatureHex, creator, request) {
  const key = xOnlyKeyOf(String(creator).toLowerCase());
  const signature = hexToBytes(signatureHex);
  if (!key || !signature || signature.length !== 64) return false;
  try { return schnorr.verify(signature, paymentRequestDigest(request, creator), key); }
  catch { return false; }
}

/** Query items as iOS URLComponents.queryItems reads them: "&"-separated, split at the first "=",
 *  percent-decoded ("+" stays "+"); an item without "=" has no value. Null when undecodable. */
function queryItems(query) {
  const items = [];
  if (!query) return items;
  for (const part of String(query).split("&")) {
    const eq = part.indexOf("=");
    try {
      const name = decodeURIComponent(eq === -1 ? part : part.slice(0, eq));
      const value = eq === -1 ? null : decodeURIComponent(part.slice(eq + 1));
      items.push({ name, value });
    } catch {
      return null;
    }
  }
  return items;
}

/**
 * A request from a link's address segment (already percent-decoded) and its query, or null unless
 * every part is valid (iOS PaymentRequest.init?(rawAddress:url:)). A signed one is returned only
 * when its signature checks out; a link carrying just one of by/sig is refused.
 */
export function parsePaymentRequest(rawAddress, query, { hrp = ADDRESS_HRP } = {}) {
  const raw = String(rawAddress ?? "").trim().toLowerCase();
  if (!raw || raw.length > 100) return null;
  const full = raw.includes(":") ? raw : `kaspa:${raw}`;
  if (!isPaymentAddress(full, hrp)) return null;
  const items = queryItems(query);
  if (!items) return null;
  const value = (name) => {
    const item = items.find((entry) => entry.name.toLowerCase() === name);
    return item ? item.value : null;
  };
  const amountText = value("amount");
  if (amountText == null || !/^[0-9.]*$/.test(amountText)) return null;
  const sompi = sompiFromUserText(amountText);
  if (sompi == null || sompi <= 0n) return null;
  const unsigned = makePaymentRequest({ address: full, amountSompi: sompi, memo: value("memo") ?? "", toChattingAddress: value("chat") === "1" });
  const by = value("by");
  const sig = value("sig");
  if (by == null && sig == null) return unsigned;
  if (by == null || sig == null) return null;
  const rawBy = by.trim().toLowerCase();
  const creator = rawBy.includes(":") ? rawBy : `kaspa:${rawBy}`;
  // a maker is shown only when the signature is theirs; one that isn't is a changed link
  if (rawBy.length > 100 || !isPaymentAddress(creator, hrp) || !/^[0-9a-fA-F]{128}$/.test(sig)) return null;
  if (!verifyPaymentRequestSignature(sig, creator, unsigned)) return null;
  return makePaymentRequest({ ...unsigned, creator, signature: sig });
}

const PAY_LINK_RE = /^(?:kachat:\/\/pay|https?:\/\/(?:www\.)?kachat\.app\/pay)\/([^/?#]+)\/?(?:\?([^#]*))?(?:#.*)?$/i;
/** Either link form -> a request, or null (the path holds exactly the address, as iOS parse). */
export function parsePaymentRequestLink(text, options = {}) {
  const match = String(text ?? "").trim().match(PAY_LINK_RE);
  if (!match) return null;
  let rawAddress;
  try { rawAddress = decodeURIComponent(match[1]); } catch { return null; }
  return parsePaymentRequest(rawAddress, match[2] || "", options);
}

/** The amount in KAS, exact: "12.5", "0.00000001". */
export function paymentRequestAmountText(request) {
  return kasTextFromSompi(request.amountSompi);
}

// Only unreserved characters stay as they are (iOS addingPercentEncoding(.unreserved)): "&", "=",
// "+", "#", "!", "'", "(", ")", "*" and spaces in a memo are all escaped, so it reads back exactly.
function encodeUnreserved(text) {
  return encodeURIComponent(text).replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** The link's address segment and query, shared by both forms (iOS linkTail). */
export function paymentRequestLinkTail(request) {
  const path = request.address.startsWith("kaspa:") ? request.address.slice("kaspa:".length) : request.address;
  let query = `amount=${paymentRequestAmountText(request)}`;
  if (request.memo) {
    try { query += `&memo=${encodeUnreserved(request.memo)}`; } catch { /* unencodable: no memo, as iOS */ }
  }
  if (request.toChattingAddress) query += "&chat=1";
  if (request.creator && request.signature) {
    const by = request.creator.startsWith("kaspa:") ? request.creator.slice("kaspa:".length) : request.creator;
    query += `&by=${by}&sig=${request.signature}`;
  }
  return `${path}?${query}`;
}

/** The link Copy and Share give out (iOS shareURLString). */
export function paymentRequestUniversalLink(request) {
  return `https://${PAYMENT_REQUEST_HOST}/pay/${paymentRequestLinkTail(request)}`;
}
/** The kachat:// twin (iOS shareLinkString). */
export function paymentRequestAppLink(request) {
  return `kachat://pay/${paymentRequestLinkTail(request)}`;
}
