// KaPost with the indexer down (iOS KaPosts ee5ec98, KaPostsChainFallback.swift). The indexer is what
// lists posts; the posts themselves are on chain. So while it doesn't answer, a read shows the page
// it last got (saved pages, below), a person's posts come from Kaspa REST, new posts come off the
// node's block stream, and it all goes back to the indexer by itself when it answers again. Whether
// it's down is engine/indexer-health.js's call: nothing here counts failures.
//
// A chain payload can name anyone as its author, so nothing from REST or the stream counts unless
// its signature verifies against the key it names, the same check the indexer makes.
import { blake2b } from "@noble/hashes/blake2.js";
import { schnorr } from "@noble/curves/secp256k1.js";
import { chainHistory } from "./chain-history.js";
import { blockFromBlockAddedEvent } from "./broadcasts.js";
import {
  KAPOSTS_PROTOCOL, KAPOSTS_EDIT_WINDOW_MS, base64ToUtf8, isKaChatContent, stripKaChatMarker, kaspaAddressFromPubkey,
} from "./kaposts.js";

const encodeUtf8 = (text) => new TextEncoder().encode(String(text));
const decodeUtf8Strict = (bytes) => { try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return null; } };
const bytesOfHex = (hex) => Uint8Array.from(String(hex).match(/../g) || [], (pair) => parseInt(pair, 16));
const hexOfBytes = (bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
const parsedMentions = (json) => {
  try { const list = JSON.parse(json); return Array.isArray(list) ? list.filter((key) => typeof key === "string") : null; }
  catch { return null; }
};
const showsText = (text) => isKaChatContent(text) && stripKaChatMarker(text).trim() !== "";

/** The lowercased x-only part of a 02/03 key. Addresses only give x, and a real post carries true
 *  parity, so keys are compared on this. */
export const xOnlyKey = (pubkey) => String(pubkey || "").slice(-64).toLowerCase();

// ---------------------------------------------------------------------------
// Signatures
// ---------------------------------------------------------------------------

const PERSONAL_MESSAGE_KEY = encodeUtf8("PersonalMessageSigningHash");

/** Whether `signature` is `pubkey`'s Kaspa personal-message signature of `signingString`: what
 *  `kaspa.signMessage` produces (schnorr over keyed blake2b-256). */
export function kaPostSignatureIsValid(signature, signingString, pubkey) {
  const key = String(pubkey || "").toLowerCase();
  const sig = String(signature || "").toLowerCase();
  if (!/^0[23][0-9a-f]{64}$/.test(key) || !/^[0-9a-f]{128}$/.test(sig)) return false;
  try {
    const digest = blake2b(encodeUtf8(signingString), { dkLen: 32, key: PERSONAL_MESSAGE_KEY });
    return schnorr.verify(bytesOfHex(sig), digest, bytesOfHex(key.slice(2)));
  } catch { return false; }
}

/** Whether a post, reply, quote or poll payload (either root) carries its author's signature. */
export function chainPayloadIsSigned(payload) {
  const text = String(payload || "");
  const root = ["kchat:1:", "k:1:"].find((candidate) => text.startsWith(candidate));
  if (!root) return false;
  const fields = text.slice(root.length).split(":");
  const [action, pubkey, signature] = fields;
  let signingString = null;
  if (action === "post" && fields.length >= 5) signingString = KAPOSTS_PROTOCOL.postSigningString(fields[3], fields[4]);
  else if (action === "reply" && fields.length >= 6) signingString = KAPOSTS_PROTOCOL.replySigningString(fields[3], fields[4], fields[5]);
  else if (action === "quote" && fields.length >= 6) signingString = KAPOSTS_PROTOCOL.quoteSigningString(fields[3], fields[4], fields[5]);
  else if (action === "poll" && fields.length >= 7) signingString = KAPOSTS_PROTOCOL.pollSigningString(fields[3], fields[4], fields[5], fields[6]);
  return signingString !== null && kaPostSignatureIsValid(signature, signingString, pubkey);
}

/** A post, reply or quote from a decoded payload as `{ post, repeatKey }`, `post` in the indexer's
 *  row shape, or null for anything else: another action, another app's post (no KaChat marker), a
 *  repost with no text, or a bad signature. `repeatKey` is the same for every copy of one signed
 *  payload: anyone can put it on chain again, as a new transaction with a new id. */
export function verifiedChainPost(payload, txId, timestampMs) {
  const text = String(payload || "");
  if (!text.startsWith(KAPOSTS_PROTOCOL.prefix)) return null;
  const fields = text.slice(KAPOSTS_PROTOCOL.prefix.length).split(":");
  if (fields.length < 5) return null;
  const [action, pubkey, signature] = fields;
  let b64;
  let signingString;
  let parentPostId = null;
  let mentionsJson = "[]";
  if (action === "post") {
    b64 = fields[3];
    mentionsJson = fields[4];
    signingString = KAPOSTS_PROTOCOL.postSigningString(b64, mentionsJson);
  } else if (action === "reply") {
    if (fields.length < 6 || parsedMentions(fields[5]) === null) return null;
    b64 = fields[4];
    parentPostId = fields[3];
    mentionsJson = fields[5];
    signingString = KAPOSTS_PROTOCOL.replySigningString(parentPostId, b64, mentionsJson);
  } else if (action === "quote") {
    if (fields.length < 6 || !/^[0-9a-f]{66}$/i.test(fields[5])) return null;
    b64 = fields[4];
    signingString = KAPOSTS_PROTOCOL.quoteSigningString(fields[3], b64, fields[5]);
  } else {
    return null;
  }
  const message = base64ToUtf8(b64);
  if (message === null || !showsText(message) || !kaPostSignatureIsValid(signature, signingString, pubkey)) return null;
  return {
    post: {
      id: txId, userPublicKey: pubkey.toLowerCase(), postContent: b64, timestamp: timestampMs,
      parentPostId, mentionedPubkeys: parsedMentions(mentionsJson) || [],
      contentType: action, isQuote: action === "quote", quote: null, editedAt: null, poll: null,
    },
    repeatKey: `${xOnlyKey(pubkey)}:${signature.toLowerCase()}`,
  };
}

/** A verified `delete:` or `edit:` record by `ofPubkey` only, or null. The indexer applies these the
 *  same way, and without them a deleted post comes back for as long as it's down. */
function verifiedAmendment(payload, timestampMs, ofPubkey) {
  const text = String(payload || "");
  if (!text.startsWith(KAPOSTS_PROTOCOL.prefix)) return null;
  const fields = text.slice(KAPOSTS_PROTOCOL.prefix.length).split(":");
  if (fields.length < 4 || xOnlyKey(fields[1]) !== xOnlyKey(ofPubkey)) return null;
  const [action, pubkey, signature, postId] = fields;
  if (action === "delete") {
    return kaPostSignatureIsValid(signature, KAPOSTS_PROTOCOL.deleteSigningString(postId), pubkey) ? { kind: "delete", postId } : null;
  }
  if (action !== "edit" || fields.length < 6) return null;
  const mentions = parsedMentions(fields[5]);
  const message = base64ToUtf8(fields[4]);
  if (mentions === null || message === null || !showsText(message)) return null;
  if (!kaPostSignatureIsValid(signature, KAPOSTS_PROTOCOL.editSigningString(postId, fields[4], fields[5]), pubkey)) return null;
  return { kind: "edit", postId, b64: fields[4], mentions, timestampMs };
}

// ---------------------------------------------------------------------------
// A person's posts from Kaspa REST
// ---------------------------------------------------------------------------

/** How far back a person's history is read, widening only while it turned up too little, so someone
 *  posting all day costs a few requests rather than the whole of their history. */
const CHAIN_POST_WINDOWS_MS = Object.freeze([14 * 86_400_000, 180 * 86_400_000, 0]);
const CHAIN_POSTS_ENOUGH = 20;

/** What's left of `pubkey`'s transactions (oldest first) as posts: the first copy of each signed
 *  payload, deleted ones gone, edits made within the indexer's window in place. Newest first. */
export function chainPostsFromTransactions(transactions, pubkey) {
  const found = [];
  const deleted = new Set();
  const latestEdits = new Map();
  for (const tx of transactions) {
    if (!/^(?:[0-9a-f]{2})+$/.test(tx.payloadHex || "")) continue;
    const payload = decodeUtf8Strict(bytesOfHex(tx.payloadHex));
    if (payload === null) continue;
    const amendment = verifiedAmendment(payload, tx.blockTime, pubkey);
    if (amendment?.kind === "delete") { deleted.add(amendment.postId); continue; }
    if (amendment?.kind === "edit") {
      if (tx.blockTime >= (latestEdits.get(amendment.postId)?.timestampMs ?? -Infinity)) latestEdits.set(amendment.postId, amendment);
      continue;
    }
    const verified = verifiedChainPost(payload, tx.txId, tx.blockTime);
    if (verified && xOnlyKey(verified.post.userPublicKey) === xOnlyKey(pubkey)) found.push(verified);
  }
  const repeats = new Set();
  return found
    .sort((a, b) => a.post.timestamp - b.post.timestamp)
    .filter(({ post, repeatKey }) => {
      if (repeats.has(repeatKey)) return false;
      repeats.add(repeatKey);
      return !deleted.has(post.id);
    })
    .map(({ post }) => {
      const edit = latestEdits.get(post.id);
      if (!edit || edit.timestampMs < post.timestamp || edit.timestampMs - post.timestamp > KAPOSTS_EDIT_WINDOW_MS) return post;
      return { ...post, postContent: edit.b64, mentionedPubkeys: edit.mentions, editedAt: edit.timestampMs };
    })
    .sort((a, b) => b.timestamp - a.timestamp);
}

const chainReadsInFlight = new Map(); // x-only key -> promise: a profile asks for posts and replies at once

/** `pubkey`'s posts and replies from Kaspa REST, newest first, or null when REST didn't answer. */
export function kaPostsOfPubkey(engine, pubkey, { history = chainHistory, now = Date.now() } = {}) {
  const key = xOnlyKey(pubkey);
  const reading = chainReadsInFlight.get(key);
  if (reading) return reading;
  const read = (async () => {
    const address = kaspaAddressFromPubkey(engine, pubkey);
    if (!address) return null;
    let found = null;
    for (const windowMs of CHAIN_POST_WINDOWS_MS) {
      let transactions;
      // Refused, or too much history to read: what the narrower window found.
      try { transactions = await history.chainTransactions(address, windowMs ? now - windowMs : 0); }
      catch { return found; }
      found = chainPostsFromTransactions(transactions, pubkey);
      if (found.length >= CHAIN_POSTS_ENOUGH) break;
    }
    return found;
  })().finally(() => chainReadsInFlight.delete(key));
  chainReadsInFlight.set(key, read);
  return read;
}

const FOLLOWED_READ_LIMIT = 20;
const FOLLOWED_READS_AT_ONCE = 4;

/** The people `addresses` names, as their posts on chain: the first 20, a few at a time, with what
 *  the block stream brought from them. */
export async function followedKaPostsFromChain(engine, addresses, options = {}) {
  const pubkeys = [...new Set(addresses || [])].sort().slice(0, FOLLOWED_READ_LIMIT)
    .map((address) => engine?.kapostPubkeyForAddress?.(address)).filter(Boolean);
  const found = [];
  for (let start = 0; start < pubkeys.length; start += FOLLOWED_READS_AT_ONCE) {
    const batch = await Promise.all(pubkeys.slice(start, start + FOLLOWED_READS_AT_ONCE).map((pubkey) => kaPostsOfPubkey(engine, pubkey, options)));
    for (const posts of batch) found.push(...(posts || []));
  }
  const followed = new Set(pubkeys.map(xOnlyKey));
  const seen = new Set();
  return [...found, ...kapostLiveFeed.posts().filter((post) => followed.has(xOnlyKey(post.userPublicKey)))]
    .filter((post) => { if (seen.has(post.id)) return false; seen.add(post.id); return true; });
}

// ---------------------------------------------------------------------------
// New posts off the block stream
// ---------------------------------------------------------------------------

const LIVE_FEED_KEEP = 300;
// Spelled out: this runs while the module loads, before KAPOSTS_PROTOCOL can be read through the import cycle.
const LIVE_PAYLOAD_PREFIXES = ["post:", "reply:", "quote:"].map((action) => hexOfBytes(encodeUtf8(`kchat:1:${action}`)));

const payloadHexOf = (payload) => {
  if (typeof payload === "string") return payload.trim().toLowerCase();
  if (payload && (ArrayBuffer.isView(payload) || Array.isArray(payload))) {
    return hexOfBytes(Array.isArray(payload) ? payload : new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength));
  }
  return "";
};

/** The verified posts in one block, or block-added event. A block with none costs a prefix check per transaction. */
export function verifiedChainPostsInBlock(event) {
  const block = blockFromBlockAddedEvent(event);
  const transactions = Array.isArray(block?.transactions) ? block.transactions : [];
  const blockVerbose = block?.verboseData || block?.verbose_data || null;
  const blockTxIds = blockVerbose?.transactionIds || blockVerbose?.transaction_ids || null;
  const found = [];
  transactions.forEach((tx, index) => {
    const hex = payloadHexOf(tx?.payload);
    if (!LIVE_PAYLOAD_PREFIXES.some((prefix) => hex.startsWith(prefix))) return;
    const payload = decodeUtf8Strict(bytesOfHex(hex));
    const verbose = tx?.verboseData || tx?.verbose_data || null;
    const txId = String(verbose?.transactionId || verbose?.transaction_id || tx?.id || blockTxIds?.[index] || "");
    if (payload === null || !txId) return;
    const timestampMs = Number(verbose?.blockTime || verbose?.block_time || block?.header?.timestamp) || Date.now();
    const verified = verifiedChainPost(payload, txId, timestampMs);
    if (verified) found.push(verified);
  });
  return found;
}

/** New posts off the node's block stream, only while the indexer is down: streaming every block
 *  costs data the indexer otherwise saves. `engine.addBlockScanClient(fn)` hands over each block
 *  and returns its removal; an engine without it just has no live posts. */
export function createKaPostLiveFeed() {
  let posts = []; // newest first
  let stopHandler = null;
  let active = false;
  const seenPayloads = new Set();
  const listeners = new Set();
  const announce = () => { for (const listener of listeners) { try { listener(posts); } catch { /* the others still hear */ } } };
  const feed = {
    posts: () => posts,
    isActive: () => active,
    /** `listener(posts)`; returns the unsubscribe. */
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    setActive(engine, wanted) {
      if (Boolean(wanted) === active) return;
      active = Boolean(wanted);
      if (active) {
        stopHandler = engine?.addBlockScanClient?.((block) => feed.ingest(block)) ?? null;
        return;
      }
      try { stopHandler?.(); } catch { /* the node's already gone */ }
      stopHandler = null;
      // The indexer has these now.
      const hadPosts = posts.length > 0;
      posts = [];
      seenPayloads.clear();
      if (hadPosts) announce();
    },
    ingest(event) {
      if (!active) return;
      const known = new Set(posts.map((post) => post.id));
      const fresh = verifiedChainPostsInBlock(event).filter(({ post, repeatKey }) => {
        if (known.has(post.id) || seenPayloads.has(repeatKey)) return false;
        seenPayloads.add(repeatKey);
        return true;
      }).map(({ post }) => post);
      if (!fresh.length) return;
      posts = [...fresh, ...posts].sort((a, b) => b.timestamp - a.timestamp).slice(0, LIVE_FEED_KEEP);
      announce();
    },
  };
  return feed;
}

export const kapostLiveFeed = createKaPostLiveFeed();

// ---------------------------------------------------------------------------
// Saved pages
// ---------------------------------------------------------------------------

/** One entry per account and request, under the account's scoped key, so removing an account takes
 *  its pages with it. localStorage is shared with everything else the app keeps, so the pages get a
 *  fixed share of it: the oldest go first, whichever account they belong to. */
export const KAPOST_SAVED_PAGE_KEY = "kachat-kaposts-saved-page-v1";
const SAVED_PAGE_MAX_CHARS = 200_000;
const SAVED_PAGES_MAX_CHARS = 1_200_000;

let savedPagesConfig = null;

/** `scopedKey(baseKey, account)` is the app's accountScopedKey. Until this is called nothing is saved. */
export function configureKaPostSavedPages({ scopedKey, storage = globalThis.localStorage ?? null, now = () => Date.now() } = {}) {
  savedPagesConfig = scopedKey && storage ? { scopedKey, storage, now } : null;
}

/** The key of one first-page read, whole request included: its `requesterPubkey` is the account's. */
export function kaPostPageKey(base, path, query) {
  const canonical = `${base}|${path}|${Object.entries(query)
    .filter(([, value]) => value !== null && value !== undefined && value !== "")
    .map(([key, value]) => `${key}=${value}`).sort().join("&")}`;
  return hexOfBytes(blake2b(encodeUtf8(canonical), { dkLen: 16 }));
}

function pruneSavedPages(storage) {
  const marker = `${KAPOST_SAVED_PAGE_KEY}:`;
  const entries = [];
  let total = 0;
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (!key?.includes(marker)) continue;
    const value = storage.getItem(key) || "";
    entries.push({ key, size: value.length, savedAt: parseInt(value, 10) || 0 });
    total += value.length;
  }
  entries.sort((a, b) => a.savedAt - b.savedAt);
  for (const entry of entries) {
    if (total <= SAVED_PAGES_MAX_CHARS) break;
    storage.removeItem(entry.key);
    total -= entry.size;
  }
}

/** Keeps an indexer answer. Only ever called with one: nothing read from the chain comes here. */
export function saveKaPostPage(account, pageKey, body) {
  if (!savedPagesConfig || !account || !pageKey || body.length > SAVED_PAGE_MAX_CHARS) return;
  const { scopedKey, storage, now } = savedPagesConfig;
  try {
    storage.setItem(scopedKey(`${KAPOST_SAVED_PAGE_KEY}:${pageKey}`, account), `${now()}|${body}`);
    pruneSavedPages(storage);
  } catch { /* over quota: this page just isn't kept */ }
}

/** The saved answer for this account's request, marked `savedPage`, or null. */
export function loadKaPostPage(account, pageKey) {
  if (!savedPagesConfig || !account || !pageKey) return null;
  const { scopedKey, storage } = savedPagesConfig;
  try {
    const stored = storage.getItem(scopedKey(`${KAPOST_SAVED_PAGE_KEY}:${pageKey}`, account));
    if (!stored) return null;
    const parsed = JSON.parse(stored.slice(stored.indexOf("|") + 1));
    return parsed && typeof parsed === "object" ? { ...parsed, savedPage: true } : null;
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// On screen
// ---------------------------------------------------------------------------

/** What's on screen with what an outage read adds. A saved page can be older than the screen, so
 *  rows already showing stay as they are and only unknown ones come in, newest first. */
export function mergeOutageRows(onScreen, rows, idOf = (row) => row?.remoteId) {
  const known = new Set(onScreen.map(idOf).filter(Boolean));
  const added = rows.filter((row) => !known.has(idOf(row)));
  if (!added.length) return onScreen;
  return [...onScreen, ...added].sort((a, b) => (Number(b.timestamp) || 0) - (Number(a.timestamp) || 0));
}
