// Broadcasts tab UI — desktop port of the iOS/Android 4.0 broadcast rooms. Channel list
// (featured rooms pinned + joinable customs), room view with indexer backfill (once on open +
// 8s polling while open), per-room hidden users, the "Other Languages" disclosure of curated
// language rooms, and a live connection dot in the room header. Feature parity with mobile:
// link previews in bubbles (same progressive Nextcloud probe as 1:1), reactions (same
// cross-platform JSON payload as 1:1, sent as normal broadcast messages), and voice notes
// via Nextcloud media upload.

import {
  BROADCAST_RETENTION_MS,
  FEATURED_BROADCAST_CHANNELS,
  LANGUAGE_BROADCAST_CHANNELS,
  broadcastLanguageDisplayName,
  fetchBroadcastHistory,
  hasBroadcastIndexer,
  isIndexedBroadcastChannel,
  isValidBroadcastChannel,
  normalizeBroadcastChannel,
  sendBroadcastMessage,
  broadcastPayloadBytes,
} from "../engine/broadcasts.js";
import { confirmDialog, promptDialog, alertDialog, chooseDialog } from "./dialogs.js";
import { onContextGesture, onDoubleGesture } from "./touch.js";

const CHANNELS_KEY = "kachat-broadcast-channels-v1";        // account-scoped: ["name", ...]
const HIDDEN_KEY = "kachat-broadcast-hidden-v1";            // account-scoped: { [channel]: [address, ...] }
const NOTIFY_KEY = "kachat-broadcast-notify-v1";            // account-scoped: { [channel]: true } — the bell
const LISTEN_KEY = "kachat-broadcast-listen-v1";            // account-scoped: { [channel]: true } — always-listen
const RETENTION_KEY = "kachat-broadcast-retention-v1";      // account-scoped: { [channel]: millis } (own channels only; absent = the 3h default)
const INDEXER_KEY = "kachat-broadcast-indexer-v1";          // account-scoped: { [channel]: url } — per-room indexer override (Room Info)
const JOINED_AT_KEY = "kachat-broadcast-joined-at-v1";      // account-scoped: { [channel]: ms } — when this device joined the room
// Retention is bounded (iOS BroadcastStore.maxRetentionMillis): a room can hold at most three
// days on this device, and a new room starts at three hours.
const MAX_RETENTION_MS = 3 * 24 * 60 * 60 * 1000;
const DEFAULT_RETENTION_MS = 3 * 60 * 60 * 1000;
const RETENTION_UNITS = [
  ["seconds", 1000], ["minutes", 60_000], ["hours", 3_600_000], ["days", 86_400_000],
];
// A voice note that goes on-chain is capped hard (iOS BroadcastAudioRecording.maxDuration);
// with Nextcloud carrying the bytes the 600s cap of 1:1 notes applies instead.
const ONCHAIN_VOICE_MAX_SECONDS = 10;
const LONG_MESSAGE_BYTES = 2000;
const LONG_MESSAGE_PREVIEW_CHARS = 500;
const LINK_HOST = "kachat.duckdns.org";
const CACHE_KEY = "kachat-broadcast-messages-cache-v1";     // GLOBAL: public chain data, account-agnostic
const REACTIONS_KEY = "kachat-broadcast-reactions-cache-v1"; // GLOBAL: public chain data, account-agnostic
const POLL_MS = 8000;
// Nextcloud carries the audio bytes — same 600s cap as the 1:1 Nextcloud voice notes.
const VOICE_MAX_DURATION_SECONDS = 600;

let deps = null;

let listEl, roomEl, roomTitleEl, roomDotEl, roomBodyEl, composerInput, sendBtn, joinInput;
let voicePanelEl, voiceTimeEl, voiceBtn;
let joinedChannels = [];
let hiddenByRoom = {};
let notifyByChannel = {};    // { [channel]: true } — the bell: OS pings for new messages
let retentionByChannel = {}; // { [channel]: millis } — own channels only; indexed rooms are fixed 30-day
let indexerByChannel = {};   // { [channel]: url } — Room Info's per-room indexer override
let joinedAtByChannel = {};  // { [channel]: ms }
let feeOverrideKas = null;   // the fee typed on the pill for the NEXT message
let feeEstimateKas = null;
// { [channel]: true } — always-listen, own channels only. Keeps a custom room's live block
// scan running while its screen is closed (iOS BroadcastChannel.alwaysListen). Curated rooms
// deliberately have no toggle: they are indexer-backed, so there is nothing to keep alive.
let listenByChannel = {};
// True while the Broadcasts tab is the visible tab. An open room only counts as "wanted"
// (and only polls) while its screen is actually on screen.
let tabVisible = false;
// "Other Languages" disclosure under Popular. Collapsed by default: eleven language rooms
// would bury the two Popular rooms and the user's own channels under a wall of list.
let languagesExpanded = false;
// Only messages arriving AFTER app launch may ping — backfilled history never notifies.
const broadcastSessionStartMs = Date.now();
let messageCache = {}; // { [channel]: [{ txId, senderAddress, content, blockTime, status? }] }
// { [channel]: { byTarget: { [targetTxId]: { [reactorAddress]: { emoji, blockTime, removed? } } },
//                txIds: [processed reaction txids], lastEvent: { senderAddress, emoji, blockTime } | null } }
let reactionsCache = {};
let activeChannel = null;
let pollTimer = null;
let sendInFlight = false;
let voiceRecorder = null;
let voiceRecordingChannel = null;

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function loadState() {
  try {
    joinedChannels = JSON.parse(localStorage.getItem(deps.accountScopedKey(CHANNELS_KEY)) || "[]") || [];
  } catch { joinedChannels = []; }
  try {
    hiddenByRoom = JSON.parse(localStorage.getItem(deps.accountScopedKey(HIDDEN_KEY)) || "{}") || {};
  } catch { hiddenByRoom = {}; }
  try {
    notifyByChannel = JSON.parse(localStorage.getItem(deps.accountScopedKey(NOTIFY_KEY)) || "{}") || {};
  } catch { notifyByChannel = {}; }
  try {
    retentionByChannel = JSON.parse(localStorage.getItem(deps.accountScopedKey(RETENTION_KEY)) || "{}") || {};
  } catch { retentionByChannel = {}; }
  try {
    listenByChannel = JSON.parse(localStorage.getItem(deps.accountScopedKey(LISTEN_KEY)) || "{}") || {};
  } catch { listenByChannel = {}; }
  try {
    indexerByChannel = JSON.parse(localStorage.getItem(deps.accountScopedKey(INDEXER_KEY)) || "{}") || {};
  } catch { indexerByChannel = {}; }
  try {
    joinedAtByChannel = JSON.parse(localStorage.getItem(deps.accountScopedKey(JOINED_AT_KEY)) || "{}") || {};
  } catch { joinedAtByChannel = {}; }
  // Older installs stored retention as a day count (0 = forever). Days become milliseconds,
  // and everything is clamped to the three-day ceiling the app now has.
  for (const channel of Object.keys(retentionByChannel)) {
    const value = Number(retentionByChannel[channel] || 0);
    if (!Number.isFinite(value) || value <= 0) { delete retentionByChannel[channel]; continue; }
    const millis = value < 1000 ? value * 86_400_000 : value;
    retentionByChannel[channel] = Math.min(MAX_RETENTION_MS, millis);
  }
  try {
    messageCache = JSON.parse(localStorage.getItem(CACHE_KEY) || "{}") || {};
  } catch { messageCache = {}; }
  try {
    reactionsCache = JSON.parse(localStorage.getItem(REACTIONS_KEY) || "{}") || {};
  } catch { reactionsCache = {}; }
  // The two featured rooms are always present for every account (matches iOS/Android). The
  // curated LANGUAGE rooms are deliberately NOT auto-joined - they are joined on first open or
  // bell tap, so a user who wants none of them pays for none of them.
  for (const name of FEATURED_BROADCAST_CHANNELS) {
    if (!joinedChannels.includes(name)) joinedChannels.push(name);
  }
  migrateCachedReactionRows();
  pruneCache();
}

/** Older caches stored reaction payload rows as normal messages — lift them into the
 *  reactions store so they never render as raw-JSON rows. */
function migrateCachedReactionRows() {
  let migrated = false;
  for (const channel of Object.keys(messageCache)) {
    const kept = [];
    for (const row of messageCache[channel] || []) {
      const reaction = deps.parseReactionEnvelope?.(row.content);
      if (reaction) {
        recordReaction(channel, row.txId, reaction, row.senderAddress || "", Number(row.blockTime) || 0);
        migrated = true;
      } else {
        kept.push(row);
      }
    }
    messageCache[channel] = kept;
  }
  if (migrated) { saveCache(); saveReactions(); }
}

function saveChannels() {
  localStorage.setItem(deps.accountScopedKey(CHANNELS_KEY), JSON.stringify(joinedChannels));
}

function saveHidden() {
  localStorage.setItem(deps.accountScopedKey(HIDDEN_KEY), JSON.stringify(hiddenByRoom));
}

function saveNotify() {
  localStorage.setItem(deps.accountScopedKey(NOTIFY_KEY), JSON.stringify(notifyByChannel));
}

function saveRetention() {
  localStorage.setItem(deps.accountScopedKey(RETENTION_KEY), JSON.stringify(retentionByChannel));
}

function saveListen() {
  localStorage.setItem(deps.accountScopedKey(LISTEN_KEY), JSON.stringify(listenByChannel));
}

function saveIndexerOverrides() {
  localStorage.setItem(deps.accountScopedKey(INDEXER_KEY), JSON.stringify(indexerByChannel));
}

function saveJoinedAt() {
  localStorage.setItem(deps.accountScopedKey(JOINED_AT_KEY), JSON.stringify(joinedAtByChannel));
}

function indexerOverrideFor(channel) {
  return String(indexerByChannel[channel] || "").trim();
}

function retentionMillisFor(channel) {
  const stored = Number(retentionByChannel[channel] || 0);
  return stored > 0 ? Math.min(MAX_RETENTION_MS, stored) : DEFAULT_RETENTION_MS;
}

// Splits a stored millis value into the largest unit that divides it evenly (iOS
// BroadcastRetentionUnit.fromMillis), so the sheet pre-fills "3 hours" rather than "10800 seconds".
function retentionParts(millis) {
  for (const [unit, per] of [...RETENTION_UNITS].reverse()) {
    const amount = Math.floor(millis / per);
    if (millis % per === 0 && amount >= 1 && amount <= Math.floor(MAX_RETENTION_MS / per)) return { amount, unit };
  }
  return { amount: Math.max(1, Math.floor(millis / 1000)), unit: "seconds" };
}

function retentionDescription(millis) {
  const { amount, unit } = retentionParts(millis);
  const label = amount === 1 ? unit.replace(/s$/, "") : unit;
  return `${amount} ${label}`;
}

// The share text and links for a room (iOS KaChatInternalLink.broadcastRoomShareText): one human
// line, then BOTH accepted link forms.
function roomShareLink(channel) {
  return `kachat://broadcast/${normalizeBroadcastChannel(channel)}`;
}
function roomShareText(channel) {
  const name = normalizeBroadcastChannel(channel);
  return `Join #${name} on KaChat.\n\nOpen in KaChat: ${roomShareLink(name)}\nOr: https://${LINK_HOST}/broadcast/${name}`;
}

// ---------------------------------------------------------------------------
// Live block scanning (custom rooms)
//
// The broadcast indexer only tracks the curated rooms, so a user-created room has no
// history anywhere: its only delivery path is watching the chain live. The engine
// subscribes to the node's block-added notifications and hands back rows in the exact
// shape `fetchBroadcastHistory` returns, so both paths land in `mergeMessages` and dedupe
// by txId against the same cache. Live only, by construction - nothing backfills.
// ---------------------------------------------------------------------------

/** True for a room the user asked to keep listening to with its screen closed. */
function alwaysListening(channel) {
  return Boolean(listenByChannel[channel]) && !isIndexedBroadcastChannel(channel);
}

/**
 * The rooms that justify the block stream right now - iOS `BroadcastService.wantedChannels`:
 * the room whose screen is open, plus every always-listen room. Nothing else, so an idle app
 * does no block work at all.
 *
 * Indexer-backed rooms are then dropped, because they already have a service watching the
 * chain 24/7 plus an 8s poll while open: streaming every block for them would be pure
 * duplicate cost. If the user clears the broadcast indexer, they stay in - then the block
 * stream is their only live path too.
 */
function scanWantedChannels() {
  const wanted = new Set();
  if (tabVisible && activeChannel) wanted.add(activeChannel);
  for (const channel of Object.keys(listenByChannel)) {
    if (alwaysListening(channel) && joinedChannels.includes(channel)) wanted.add(channel);
  }
  if (hasBroadcastIndexer()) {
    for (const channel of [...wanted]) {
      if (isIndexedBroadcastChannel(channel)) wanted.delete(channel);
    }
  }
  return [...wanted];
}

/** Pushes the wanted set to the engine. Idempotent - the engine only starts/stops the
 *  subscription when the set actually changes between empty and non-empty. */
function syncScanWanted() {
  if (!deps?.engine?.setBroadcastScanChannels) return;
  try { deps.engine.setBroadcastScanChannels(scanWantedChannels()); }
  catch (error) { deps.appendEngineLog?.(`Broadcast live scan update failed: ${error.message}`); }
}

/** Live hits from the block stream, already filtered to the wanted rooms by the engine.
 *  Straight into `mergeMessages` — same store, same txId dedupe, same retention, same
 *  render as the indexer rows. */
function handleBroadcastBlockHits(hits) {
  const byChannel = new Map();
  for (const hit of hits || []) {
    const channel = normalizeBroadcastChannel(hit?.channel);
    if (!channel || !hit?.txId) continue;
    // Deliberately NOT filtering hidden senders here: the indexer path stores them and
    // filters at render time, so unhiding a user brings their messages back. Both paths must
    // leave the store in the same state, so this one stores them too.
    if (!byChannel.has(channel)) byChannel.set(channel, []);
    byChannel.get(channel).push(hit);
  }
  let touched = false;
  for (const [channel, rows] of byChannel) {
    if (mergeMessages(channel, rows) > 0) {
      touched = true;
      if (activeChannel === channel) renderRoom();
    }
  }
  if (touched) renderChannelList();
}

/** Effective retention cutoff for a channel: every indexer-backed room (featured + the curated
 *  language rooms) is fixed 30-day, matching iOS; own channels use their configured days,
 *  forever when unset/0. */
function retentionCutoffMs(channel) {
  if (isIndexedBroadcastChannel(channel)) return Date.now() - BROADCAST_RETENTION_MS;
  return Date.now() - retentionMillisFor(channel);
}

function saveCache() {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(messageCache)); }
  catch {
    // Quota: actually drop the OLDEST HALF of each channel's messages (the old code wiped
    // messageCache entirely, silently deleting every channel's history) and retry once.
    try {
      for (const channel of Object.keys(messageCache)) {
        const rows = messageCache[channel] || [];
        if (rows.length > 50) messageCache[channel] = rows.slice(Math.floor(rows.length / 2));
      }
      localStorage.setItem(CACHE_KEY, JSON.stringify(messageCache));
    } catch { /* still over quota — keep the in-memory copy, skip persisting */ }
  }
}

function saveReactions() {
  try { localStorage.setItem(REACTIONS_KEY, JSON.stringify(reactionsCache)); }
  catch { reactionsCache = {}; }
}

/** Rolling retention, matching the indexed rooms' product rule. */
function pruneCache() {
  // Per-channel retention (iOS parity): indexed rooms fixed 30-day, own channels use their
  // configured retention (0 = keep forever).
  for (const channel of Object.keys(messageCache)) {
    const cutoff = retentionCutoffMs(channel);
    if (!cutoff) continue;
    messageCache[channel] = (messageCache[channel] || []).filter((m) => (m.blockTime || 0) >= cutoff);
    if (messageCache[channel].length === 0) delete messageCache[channel];
  }
  for (const channel of Object.keys(reactionsCache)) {
    const cutoff = retentionCutoffMs(channel);
    const entry = reactionsCache[channel] || {};
    if (cutoff) {
      for (const targetTxId of Object.keys(entry.byTarget || {})) {
        const perReactor = entry.byTarget[targetTxId];
        for (const reactor of Object.keys(perReactor)) {
          if (Number(perReactor[reactor]?.blockTime || 0) < cutoff) delete perReactor[reactor];
        }
        if (Object.keys(perReactor).length === 0) delete entry.byTarget[targetTxId];
      }
      if (entry.lastEvent && Number(entry.lastEvent.blockTime || 0) < cutoff) entry.lastEvent = null;
    }
    if (Array.isArray(entry.txIds) && entry.txIds.length > 500) entry.txIds = entry.txIds.slice(-500);
    if (Object.keys(entry.byTarget || {}).length === 0 && !entry.lastEvent) delete reactionsCache[channel];
  }
}

function hiddenIn(channel) {
  return new Set(hiddenByRoom[channel] || []);
}

// ---------------------------------------------------------------------------
// Reactions store (mirrors app.js's reactionsByTxId semantics, per channel)
// ---------------------------------------------------------------------------

function reactionsFor(channel) {
  return reactionsCache[channel]?.byTarget || {};
}

/** Applies one reaction event. Newest-wins per (targetTxId, reactor); a "remove" is kept as
 *  a tombstone so an older "add" seen again on a later poll can't resurrect the reaction.
 *  Dedupes by reaction txId (pass null for optimistic local applies). Returns true if the
 *  store changed. */
function recordReaction(channel, txId, reaction, reactorAddress, blockTime) {
  if (!reactorAddress) return false;
  const entry = (reactionsCache[channel] ||= { byTarget: {}, txIds: [], lastEvent: null });
  entry.txIds ||= [];
  entry.byTarget ||= {};
  if (txId && entry.txIds.includes(txId)) return false;
  if (txId) entry.txIds.push(txId);
  const perReactor = (entry.byTarget[reaction.targetTxId] ||= {});
  const existing = perReactor[reactorAddress];
  if (!existing || Number(existing.blockTime || 0) <= blockTime) {
    perReactor[reactorAddress] = {
      emoji: reaction.emoji,
      blockTime,
      ...(reaction.action === "remove" ? { removed: true } : {}),
    };
  }
  // Drives the channel list's "Reacted <emoji>" preview line. A remove clears the
  // event rather than advertising an undone reaction (same idea as 1:1's
  // lastReactionEvent handling).
  if (reaction.action === "remove") {
    if (entry.lastEvent && entry.lastEvent.senderAddress === reactorAddress && entry.lastEvent.emoji === reaction.emoji) {
      entry.lastEvent = null;
    }
  } else if (!entry.lastEvent || blockTime >= Number(entry.lastEvent.blockTime || 0)) {
    entry.lastEvent = { senderAddress: reactorAddress, emoji: reaction.emoji, blockTime };
  }
  return true;
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

function mergeMessages(channel, rows) {
  const existing = messageCache[channel] || [];
  const seen = new Set(existing.map((m) => m.txId));
  let added = 0;
  let reactionsChanged = false;
  const freshIncoming = [];
  for (const row of rows) {
    if (!row?.txId || seen.has(row.txId)) continue;
    seen.add(row.txId);
    const blockTime = Number(row.blockTime) || Date.now();
    // Reactions ride the same wire as normal messages but never become message
    // rows — they only update the per-channel reactions store (same as 1:1).
    const reaction = deps.parseReactionEnvelope?.(row.content);
    if (reaction) {
      if (recordReaction(channel, row.txId, reaction, row.senderAddress || "", blockTime)) reactionsChanged = true;
      continue;
    }
    // Our own just-sent message can come back from the chain BEFORE `sendBroadcastText`
    // rewrites its optimistic bubble from `pending-...` to the real txid — the live block
    // scan is fast enough to win that race where the 8s indexer poll never did. Resolve the
    // pending bubble in place instead of adding a second row for the same message (the later
    // rewrite then finds no pending row and is a no-op).
    if ((row.senderAddress || "") === deps.engine.address) {
      const pending = existing.find((m) =>
        m.status === "pending"
        && m.senderAddress === deps.engine.address
        && m.content === (row.content ?? ""));
      if (pending) {
        pending.txId = row.txId;
        pending.blockTime = blockTime;
        delete pending.status;
        added += 1;
        continue;
      }
    }
    existing.push({
      txId: row.txId,
      senderAddress: row.senderAddress || "",
      content: row.content ?? "",
      blockTime,
    });
    added += 1;
    if ((row.senderAddress || "") !== deps.engine.address) {
      freshIncoming.push({ channel, senderAddress: row.senderAddress || "", content: row.content ?? "", txId: row.txId, blockTime });
    }
  }
  existing.sort((a, b) => a.blockTime - b.blockTime);
  messageCache[channel] = existing;
  if (added > 0) saveCache();
  if (reactionsChanged) saveReactions();
  // The global notification center gates these by arrival time (only live messages ping, not the
  // backfilled history), so it's safe to hand it every fresh incoming row.
  if (freshIncoming.length) deps.onIncomingBroadcast?.(freshIncoming);
  // The per-channel bell (iOS parity): OS pings for LIVE messages in notify-enabled channels
  // you're not currently reading. Capped so one poll can't fire a burst.
  const pingable = freshIncoming.filter((row) =>
    notifyByChannel[row.channel]
    && row.channel !== activeChannel
    && Number(row.blockTime || 0) >= broadcastSessionStartMs);
  for (const row of pingable.slice(0, 3)) {
    deps.postDesktopNotification?.({
      title: `#${row.channel}`,
      body: `${senderName(row.senderAddress)}: ${humanizeBroadcastContent(row.content).slice(0, 90)}`,
      tag: `kachat-broadcast-${row.txId}`,
    });
  }
  return added + (reactionsChanged ? 1 : 0);
}

// Channels that already did the full historical page-back this session — the 8s poll
// afterwards only needs the newest page.
const deepBackfilled = new Set();

async function backfillChannel(channel, { quiet = true } = {}) {
  try {
    let added = 0;
    const baseUrl = indexerOverrideFor(channel) || null;
    if (deepBackfilled.has(channel)) {
      const result = await fetchBroadcastHistory({ channel, baseUrl });
      added = mergeMessages(channel, result.messages);
    } else {
      // First open this session: page backwards through the indexer's full history
      // (newest-first, `before` = oldest blockTime seen) so the room shows every
      // message still retained server-side, not just the newest page.
      deepBackfilled.add(channel);
      const cutoff = retentionCutoffMs(channel);
      let before = null;
      for (let page = 0; page < 20; page++) {
        const result = await fetchBroadcastHistory({ channel, limit: 500, before, baseUrl });
        added += mergeMessages(channel, result.messages);
        if (!result.hasMore || !result.messages.length) break;
        const oldest = result.messages.reduce(
          (min, m) => Math.min(min, Number(m.blockTime) || Infinity), Infinity);
        if (!Number.isFinite(oldest)) break;
        if (cutoff && oldest < cutoff) break; // older pages would be pruned anyway
        before = oldest;
      }
    }
    if (added > 0) {
      if (activeChannel === channel) renderRoom();
      renderChannelList();
    }
    return added;
  } catch (error) {
    if (!quiet) deps.showToast?.(error.message);
    deps.appendEngineLog?.(`Broadcast backfill failed for #${channel}: ${error.message}`);
    return -1;
  }
}

function startPolling(channel) {
  stopPolling();
  pollTimer = window.setInterval(() => { if (!document.hidden) backfillChannel(channel); }, POLL_MS);
}

function stopPolling() {
  if (pollTimer) { window.clearInterval(pollTimer); pollTimer = null; }
}

// ---------------------------------------------------------------------------
// Sending (single serialized queue so concurrent tx builds can't race UTXOs)
// ---------------------------------------------------------------------------

let sendQueue = Promise.resolve();
function enqueueBroadcastSend(task) {
  const run = sendQueue.then(task, task);
  sendQueue = run.then(() => {}, () => {});
  return run;
}

/** Shared send pipeline used by the composer, voice-note share links, and reactions
 *  (reactions pass showBubble:false — they never get a message row). */
async function sendBroadcastText(channel, text, { showBubble = true, feeKas = null } = {}) {
  const pendingId = `pending-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  if (showBubble) {
    (messageCache[channel] ||= []).push({
      txId: pendingId,
      senderAddress: deps.engine.address || "",
      content: text,
      blockTime: Date.now(),
      status: "pending",
    });
    if (activeChannel === channel) renderRoom();
  }
  try {
    const txid = await enqueueBroadcastSend(() => sendBroadcastMessage({ engine: deps.engine, channel, content: text, feeKas: feeKas || "0" }));
    if (showBubble) {
      messageCache[channel] = (messageCache[channel] || []).map((m) =>
        m.txId === pendingId ? { ...m, txId: txid, status: undefined } : m);
      saveCache();
    }
    return txid;
  } catch (error) {
    if (showBubble) {
      messageCache[channel] = (messageCache[channel] || []).map((m) =>
        m.txId === pendingId ? { ...m, status: "failed" } : m);
    }
    throw error;
  } finally {
    if (showBubble && activeChannel === channel) renderRoom();
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function senderName(address) {
  if (!address) return "unknown";
  if (address === deps.engine.address) return "You";
  const info = deps.engine.peekKnsAddressInfo?.(address);
  const domain = info?.explicitPrimaryDomain || info?.primaryDomain || "";
  if (domain) return domain.toLowerCase().endsWith(".kas") ? domain.slice(0, -4) : domain;
  return deps.shortAddress(address);
}

/** Last-activity preview for the channel list. Reaction payloads are humanized as
 *  "Reacted <emoji>" instead of showing raw JSON. */
function channelPreviewText(channel) {
  const last = (messageCache[channel] || []).at(-1) || null;
  const lastReaction = reactionsCache[channel]?.lastEvent || null;
  if (!last && !lastReaction) return "";
  if (Number(lastReaction?.blockTime || 0) > Number(last?.blockTime || 0)) {
    return `Reacted ${lastReaction.emoji}`;
  }
  if (!last) return "";
  const reaction = deps.parseReactionEnvelope?.(last.content); // defensive: shouldn't survive migration
  if (reaction) return `Reacted ${reaction.emoji}`;
  return humanizeBroadcastContent(last.content).replace(/\s+/g, " ").slice(0, 64);
}

// The bell icon pair, iOS-style: filled accent when notifications are on, slashed when off.
const BELL_ON_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4a5.5 5.5 0 0 1 5.5 5.5c0 3.2.8 5 1.8 6.2.4.5.05 1.3-.6 1.3H5.3c-.65 0-1-.8-.6-1.3 1-1.2 1.8-3 1.8-6.2A5.5 5.5 0 0 1 12 4Z" fill="currentColor" stroke="none"/><path d="M10 19.5a2 2 0 0 0 4 0"/></svg>`;
const BELL_OFF_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4a5.5 5.5 0 0 1 5.5 5.5c0 3.2.8 5 1.8 6.2.4.5.05 1.3-.6 1.3H5.3c-.65 0-1-.8-.6-1.3 1-1.2 1.8-3 1.8-6.2A5.5 5.5 0 0 1 12 4Z"/><path d="M10 19.5a2 2 0 0 0 4 0"/><path d="M4 4l16 16"/></svg>`;
const GEAR_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"/></svg>`;

function bellButtonHtml(name) {
  const on = Boolean(notifyByChannel[name]);
  return `<button class="broadcast-card-icon${on ? " active" : ""}" type="button" data-broadcast-notify="${deps.escapeHtml(name)}" title="${on ? "Notifications on" : "Notifications off"}" aria-label="Toggle notifications">${on ? BELL_ON_SVG : BELL_OFF_SVG}</button>`;
}

// Always-listen (own channels only): a broadcast antenna, filled with accent when on.
// Curated rooms get no such control - they are indexer-backed, so there is nothing to keep
// alive (same split iOS uses to hide the toggle for its indexed channels).
const LISTEN_ON_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="11" r="2.4" fill="currentColor" stroke="none"/><path d="M8.5 7.5a5 5 0 0 0 0 7"/><path d="M15.5 7.5a5 5 0 0 1 0 7"/><path d="M5.8 4.8a9 9 0 0 0 0 12.4"/><path d="M18.2 4.8a9 9 0 0 1 0 12.4"/><path d="M12 13.4V21"/></svg>`;
const LISTEN_OFF_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="11" r="2.4"/><path d="M8.5 7.5a5 5 0 0 0 0 7"/><path d="M15.5 7.5a5 5 0 0 1 0 7"/><path d="M12 13.4V21"/></svg>`;

function listenButtonHtml(name) {
  const on = alwaysListening(name);
  const title = on
    ? "Always listening. New messages arrive even with this room closed."
    : "Listen in the background. Off means this room only receives while it is open.";
  return `<button class="broadcast-card-icon${on ? " active" : ""}" type="button" data-broadcast-listen="${deps.escapeHtml(name)}" title="${title}" aria-label="Toggle background listening">${on ? LISTEN_ON_SVG : LISTEN_OFF_SVG}</button>`;
}

const GLOBE_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3c2.4 2.5 3.6 5.5 3.6 9s-1.2 6.5-3.6 9c-2.4-2.5-3.6-5.5-3.6-9S9.6 5.5 12 3Z"/></svg>`;
const CHEVRON_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>`;

// `indexed` = an indexer-backed room (featured or curated language). Those rooms have a fixed
// 30-day retention served by the indexer, so they get no retention gear and no Leave.
function channelCardHtml(name, { indexed }) {
  // Name only, no preview/description line - matches iOS's clean rows.
  return `
    <div class="broadcast-card">
      <button class="broadcast-card-main" type="button" data-broadcast-open="${deps.escapeHtml(name)}">
        <strong>#${deps.escapeHtml(name)}</strong>
      </button>
      ${bellButtonHtml(name)}
      ${indexed ? "" : listenButtonHtml(name)}
      ${indexed ? "" : `<button class="broadcast-card-icon" type="button" data-broadcast-retention="${deps.escapeHtml(name)}" title="Message retention" aria-label="Message retention">${GEAR_SVG}</button>`}
      ${indexed ? "" : `<button class="broadcast-card-leave" type="button" data-broadcast-leave="${deps.escapeHtml(name)}">Leave</button>`}
    </div>`;
}

/** One curated language room, indented under "Other Languages": native language name over the
 *  literal `#channel-name`, plus its own bell. Neither control assumes the room is joined -
 *  both join it on demand (see openRoom / the bell handler). */
function languageCardHtml(name) {
  const label = broadcastLanguageDisplayName(name) || `#${name}`;
  return `
    <div class="broadcast-card broadcast-card-language">
      <button class="broadcast-card-main" type="button" data-broadcast-open="${deps.escapeHtml(name)}">
        <strong>${deps.escapeHtml(label)}</strong>
        <span>#${deps.escapeHtml(name)}</span>
      </button>
      ${bellButtonHtml(name)}
    </div>`;
}

// iOS's list anatomy: Popular (curated, permanent - bell is the only control) pinned on top
// with the 30-day retention note beside its title and the collapsed "Other Languages" category
// at its foot, then Your Channels with a + to join/create, each row bell + retention gear +
// Leave. Note: these headers scroll away with their content - they are deliberately not sticky.
function renderChannelList() {
  if (!listEl) return;
  // Join order, as iOS keeps its store order - not alphabetical.
  const own = joinedChannels.filter((name) => !isIndexedBroadcastChannel(name));
  listEl.innerHTML = `
    <div class="broadcast-section-header">
      <span>Popular</span>
      <span class="broadcast-section-note">All messages persist for 30 days</span>
    </div>
    ${FEATURED_BROADCAST_CHANNELS.map((name) => channelCardHtml(name, { indexed: true })).join("")}
    <button class="broadcast-card broadcast-languages-toggle${languagesExpanded ? " expanded" : ""}" type="button"
            data-broadcast-languages-toggle aria-expanded="${languagesExpanded ? "true" : "false"}">
      <span class="broadcast-languages-globe">${GLOBE_SVG}</span>
      <strong>Other Languages</strong>
      <span class="broadcast-languages-count">${LANGUAGE_BROADCAST_CHANNELS.length}</span>
      <span class="broadcast-languages-chevron">${CHEVRON_SVG}</span>
    </button>
    ${languagesExpanded ? LANGUAGE_BROADCAST_CHANNELS.map((name) => languageCardHtml(name)).join("") : ""}
    <div class="broadcast-section-header broadcast-section-your">
      <span>Your Channels</span>
      <span style="display:flex;align-items:center;gap:8px;">
        <span class="broadcast-section-note">Live only, while open or listening</span>
        <button class="broadcast-join-toggle" type="button" data-broadcast-join-toggle aria-label="Join or create a channel">+</button>
      </span>
    </div>
    ${own.length
      ? own.map((name) => channelCardHtml(name, { indexed: false })).join("")
      : `<p class="broadcast-empty-hint">No channels yet - tap + to join or create one.</p>`}
  `;
}

/** One broadcast bubble: header, linkified body (+ the same preview card treatment as 1:1
 *  bubbles — Nextcloud shares get the progressive video→audio→img→attachment probe), hover
 *  reaction bar, and aggregated reaction chips. */
/** Avatar + bubble row, matching 1:1/group chats: sender avatar beside every message
 *  (left for others, right for your own). */
function buildMessageRow(m) {
  const mine = m.senderAddress === deps.engine.address;
  const row = document.createElement("div");
  row.className = `broadcast-msg-row${mine ? " mine" : ""}`;
  const avatar = document.createElement("span");
  avatar.className = "broadcast-avatar-slot group-avatar-clickable";
  avatar.innerHTML = deps.avatarHtmlForAddress?.(m.senderAddress, "message-avatar") || "";
  avatar.addEventListener("click", (event) => { event.stopPropagation(); openBroadcastSenderMenu(m.senderAddress, event.clientX, event.clientY); });
  const card = buildMessageElement(m);
  if (mine) row.append(card, avatar);
  else row.append(avatar, card);
  return row;
}

function buildMessageElement(m) {
  const mine = m.senderAddress === deps.engine.address;
  const el = document.createElement("div");
  el.className = `broadcast-message${mine ? " mine" : ""}`;

  const head = document.createElement("div");
  head.className = "broadcast-message-head";
  el.dataset.broadcastTxid = m.txId;
  const sender = document.createElement("strong");
  sender.dataset.broadcastSender = m.senderAddress;
  sender.textContent = senderName(m.senderAddress);
  const time = document.createElement("span");
  time.textContent = new Date(m.blockTime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  head.append(sender, time);
  if (m.status === "pending") {
    const badge = document.createElement("span");
    badge.className = "broadcast-pending";
    badge.textContent = "sending…";
    head.append(badge);
  }
  if (m.status === "failed") {
    const badge = document.createElement("span");
    badge.className = "broadcast-failed";
    badge.textContent = "failed";
    head.append(badge);
  }
  el.append(head);

  // Decode the same wire envelopes 1:1 chats use - replies, photos, and voice notes all
  // arrive as JSON payloads that must never render raw.
  const replyEnvelope = deps.parseReplyEnvelope?.(m.content) || null;
  const imageEnvelope = replyEnvelope ? null : (deps.parseImageEnvelope?.(m.content) || null);
  const audioEnvelope = (replyEnvelope || imageEnvelope) ? null : (deps.parseAudioEnvelope?.(m.content) || null);

  if (replyEnvelope) {
    const quote = document.createElement("div");
    quote.className = "message-reply-quote";
    const label = document.createElement("strong");
    label.textContent = replyEnvelope.replyToSender ? senderName(replyEnvelope.replyToSender) : "Reply";
    const preview = document.createElement("span");
    preview.textContent = replyEnvelope.replyToPreview || "Message";
    quote.append(label, preview);
    // Tapping the quote jumps to the original and lights it up; gone from this device's cache
    // (retention, or before you joined) says so instead of doing nothing.
    quote.classList.add("clickable");
    quote.addEventListener("click", (event) => { event.stopPropagation(); jumpToBroadcastMessage(replyEnvelope.replyToId); });
    el.append(quote);
  }

  if (imageEnvelope) {
    const img = document.createElement("img");
    img.className = "broadcast-photo";
    img.src = imageEnvelope.content;
    img.alt = imageEnvelope.name || "Photo";
    img.addEventListener("click", () => deps.openPhotoPreview?.(imageEnvelope.content));
    el.append(img);
  } else if (audioEnvelope) {
    const audioWrap = document.createElement("div");
    audioWrap.className = "message-audio-bubble";
    if (deps.buildVoicePlayer) {
      audioWrap.append(deps.buildVoicePlayer(audioEnvelope.content, { outgoing: mine, durationHint: audioEnvelope.duration }));
    } else {
      const player = document.createElement("audio");
      player.controls = true;
      player.preload = "metadata";
      player.src = audioEnvelope.content;
      player.addEventListener("click", (event) => event.stopPropagation());
      audioWrap.append(player);
    }
    el.append(audioWrap);
  } else {
    const body = document.createElement("div");
    body.className = "broadcast-message-body";
    const fullText = replyEnvelope ? replyEnvelope.text : m.content;
    // Public rooms are where stray base64 and essays land: past 2000 bytes the bubble shows a
    // 500-character preview and opens in full on demand, as iOS does.
    const isLong = new TextEncoder().encode(String(fullText || "")).length > LONG_MESSAGE_BYTES;
    const bodyText = isLong ? `${String(fullText).slice(0, LONG_MESSAGE_PREVIEW_CHARS)}…` : fullText;
    const urls = deps.renderTextWithLinks?.(body, bodyText) ?? [];
    if (!deps.renderTextWithLinks) body.textContent = bodyText;
    if (isLong) {
      const more = document.createElement("button");
      more.type = "button";
      more.className = "message-show-more";
      more.textContent = "Show More";
      more.addEventListener("click", (event) => {
        event.stopPropagation();
        alertDialog({ title: "Message", message: fullText, confirmLabel: "Done" });
      });
      body.append(more);
    }
    el.append(body);
    const previewable = urls.find((url) => deps.isPreviewableUrl?.(url));
    if (previewable) {
      const card = deps.buildLinkPreviewCard?.(previewable);
      if (card) el.append(card);
    }
  }

  appendReactionUi(el, m);
  // 1:1 parity: right-click opens the reactions + Reply/Copy/Hide menu.
  onContextGesture(el, (event) => {
    event.preventDefault();
    openBroadcastMessageMenu(m, event.clientX, event.clientY);
  });
  // Double-click: the quick-reaction bar (iOS double-tap), with "+" into the full picker.
  onDoubleGesture(el, (event) => {
    if (m.status) return;
    event.preventDefault();
    const perReactor = reactionsFor(activeChannel)[m.txId] || {};
    const myEntry = perReactor[deps.engine.address || ""];
    deps.openQuickReactionBar?.({
      anchor: el,
      alignRight: mine,
      current: myEntry && !myEntry.removed ? myEntry.emoji : null,
      onReact: (emoji) => sendBroadcastReaction(m.txId, emoji),
      onReply: () => startBroadcastReply(m),
    });
  });
  return el;
}

// Scrolls to the original a reply quotes and lights it up for a moment.
function jumpToBroadcastMessage(txId) {
  if (!txId || !roomBodyEl) return;
  let row = null;
  try { row = roomBodyEl.querySelector(`[data-broadcast-txid="${CSS.escape(String(txId))}"]`); } catch { row = null; }
  if (!row) { deps.showToast?.("Original message not available."); return; }
  row.scrollIntoView({ behavior: "smooth", block: "center" });
  row.classList.add("message-highlight");
  window.setTimeout(() => row.classList.remove("message-highlight"), 1200);
}

// The avatar menu (iOS BroadcastChannelView.avatarButton): who this is, and what you can do
// about them. Same menu from the sender's name.
function openBroadcastSenderMenu(address, x, y) {
  if (!address || !deps.openMsgContextMenu) return;
  const mine = address === deps.engine.address;
  const icons = deps.getMsgMenuIcons?.() || {};
  const name = senderName(address);
  const items = [];
  items.push({ label: "View Profile", icon: icons.info, onClick: () => deps.openUserInfo?.(address) });
  if (!mine) items.push({ label: "Open Chat", icon: icons.reply, onClick: () => deps.openChat?.(address, deps.contactNameFor?.(address) || "") });
  items.push({
    label: "Copy Address", icon: icons.copy,
    onClick: () => deps.copyText?.(address).then(() => deps.showToast?.(deps.addressCopiedToastText?.(address) || "Address copied")).catch(() => {}),
  });
  if (!mine) {
    items.push({ label: "Pay in Kaspa", icon: icons.explorer, onClick: () => deps.payInKaspa?.(address, deps.contactNameFor?.(address) || "") });
    items.push({ label: "Hide User", icon: icons.trash, danger: true, onClick: () => hideSender(address) });
  }
  void name;
  deps.openMsgContextMenu({ x, y, reaction: null, items });
}

// A failed send of yours: drop the failed row and send the same content again.
function retryBroadcastMessage(m) {
  if (!activeChannel || m.status !== "failed") return;
  messageCache[activeChannel] = (messageCache[activeChannel] || []).filter((row) => row.txId !== m.txId);
  renderRoom();
  sendBroadcastText(activeChannel, m.content).then(() => renderChannelList()).catch((error) => {
    deps.showToast?.(error.message);
  });
}

// ---------------------------------------------------------------------------
// Right-click context menu (1:1 parity): quick reactions + Reply / Copy /
// View in Explorer / Hide user. Reply-SENDING rides the same cross-platform
// reply envelope the room already renders.
// ---------------------------------------------------------------------------

let broadcastReplyTarget = null; // { txId, senderAddress, preview }

function startBroadcastReply(m) {
  broadcastReplyTarget = {
    txId: m.txId,
    senderAddress: m.senderAddress,
    preview: humanizeBroadcastContent(m.content).replace(/\s+/g, " ").slice(0, 90),
  };
  renderBroadcastReplyBanner();
  composerInput?.focus();
}

function cancelBroadcastReply() {
  broadcastReplyTarget = null;
  renderBroadcastReplyBanner();
}

function renderBroadcastReplyBanner() {
  const banner = document.querySelector("[data-broadcast-reply-banner]");
  const title = document.querySelector("[data-broadcast-reply-title]");
  const preview = document.querySelector("[data-broadcast-reply-preview]");
  if (!banner) return;
  banner.hidden = !broadcastReplyTarget;
  if (broadcastReplyTarget) {
    if (title) title.textContent = `Replying to ${senderName(broadcastReplyTarget.senderAddress)}`;
    if (preview) preview.textContent = broadcastReplyTarget.preview;
  }
}

function openBroadcastMessageMenu(m, x, y) {
  if (!deps.openMsgContextMenu) return;
  const mine = m.senderAddress === deps.engine.address;
  const pending = Boolean(m.status); // pending/failed rows have no on-chain txid yet
  const myAddress = deps.engine.address || "";
  const perReactor = reactionsFor(activeChannel)[m.txId] || {};
  const myEntry = perReactor[myAddress];
  const current = myEntry && !myEntry.removed ? myEntry.emoji : null;
  const icons = deps.getMsgMenuIcons?.() || {};
  const text = humanizeBroadcastContent(m.content);
  const items = [];
  if (!pending) {
    items.push({ label: "Reply", icon: icons.reply, onClick: () => startBroadcastReply(m) });
  }
  const firstLink = (String(text || "").match(/https?:\/\/[^\s<>"']+/) || [])[0] || null;
  if (firstLink) {
    items.push({ label: "Open Link", icon: icons.explorer, onClick: () => window.open(firstLink, "_blank", "noopener,noreferrer") });
    items.push({ label: "Copy Link", icon: icons.copy, onClick: () => deps.copyText?.(firstLink).catch(() => {}) });
  }
  if (text && !deps.parseAudioEnvelope?.(m.content)) {
    items.push({
      label: "Copy Message", icon: icons.copy,
      onClick: () => deps.copyText?.(text).then(() => deps.showToast?.("Message copied.")).catch(() => {}),
    });
  }
  if (!pending && deps.explorerTxUrl) {
    items.push({
      label: "View in Explorer", icon: icons.explorer,
      onClick: () => window.open(deps.explorerTxUrl(m.txId), "_blank", "noopener,noreferrer"),
    });
  }
  if (mine && m.status === "failed") {
    items.push({ label: "Retry Send", icon: icons.retry, onClick: () => retryBroadcastMessage(m) });
  }
  const reactionEntries = Object.entries(perReactor).filter(([, entry]) => !entry.removed)
    .map(([reactorAddress, entry]) => ({ emoji: entry.emoji, reactorAddress }));
  if (reactionEntries.length) {
    items.push({
      label: `Reactions (${reactionEntries.length})`, icon: icons.info,
      onClick: () => deps.showReactionsSheet?.({
        entries: reactionEntries,
        nameFor: (address) => senderName(address),
        avatarFor: (address) => deps.avatarHtmlForAddress?.(address, "chat-avatar reactions-sheet-avatar") || "",
      }),
    });
  }
  if (!mine) {
    items.push({ label: `Hide ${senderName(m.senderAddress)}`, icon: icons.trash, danger: true, onClick: () => hideSender(m.senderAddress) });
  }
  deps.openMsgContextMenu({
    x, y,
    reaction: pending ? null : { current, onPick: (emoji) => sendBroadcastReaction(m.txId, emoji) },
    items,
  });
}

/** Human text for previews/notifications: unwrap replies, name photos/voice notes. */
function humanizeBroadcastContent(content) {
  const reply = deps.parseReplyEnvelope?.(content);
  if (reply) return reply.text || "Reply";
  if (deps.parseImageEnvelope?.(content)) return "📷 Photo";
  if (deps.parseAudioEnvelope?.(content)) return "🎤 Audio message";
  return String(content || "");
}

function appendReactionUi(el, m) {
  if (m.status) return; // pending/failed rows have no on-chain txid to react to
  const myAddress = deps.engine.address || "";
  const perReactor = reactionsFor(activeChannel)[m.txId] || {};
  const myEntry = perReactor[myAddress];
  const myCurrentEmoji = myEntry && !myEntry.removed ? myEntry.emoji : null;

  // No hover bar: reacting is the right-click menu (and double-click), like everywhere else.

  // Aggregated chips under the bubble; clicking your own active emoji removes it.
  const entries = Object.values(perReactor).filter((entry) => !entry.removed);
  if (entries.length) {
    const chips = document.createElement("div");
    chips.className = "message-reaction-pill";
    const counts = new Map();
    for (const entry of entries) counts.set(entry.emoji, (counts.get(entry.emoji) || 0) + 1);
    for (const [emoji, count] of counts) {
      const chip = document.createElement("span");
      chip.className = "message-reaction-pill-entry";
      chip.textContent = emoji;
      if (emoji === myCurrentEmoji) {
        chip.classList.add("active");
        chip.dataset.broadcastReact = m.txId;
        chip.dataset.emoji = emoji;
        chip.title = "Remove your reaction";
      }
      if (count > 1) {
        const countEl = document.createElement("span");
        countEl.className = "message-reaction-pill-count";
        countEl.textContent = String(count);
        chip.append(countEl);
      }
      // Delivery indicator on YOUR just-sent reaction: ✓ once on-chain, red ! to retry.
      const statusEl = broadcastReactionStatusEl(`${m.txId}|${emoji}`);
      if (statusEl) chip.append(statusEl);
      chips.append(chip);
    }
    el.append(chips);
    el.classList.add("has-reactions");
  }
}

function renderRoom() {
  const inRoom = Boolean(activeChannel);
  if (roomEl) roomEl.hidden = !inRoom;
  const listWrap = document.querySelector("[data-broadcast-list-wrap]");
  if (listWrap) listWrap.hidden = inRoom;
  if (!inRoom) return;

  if (roomTitleEl) roomTitleEl.textContent = `#${activeChannel}`;
  if (composerInput) composerInput.placeholder = `Message #${activeChannel}`;
  // No in-room retention banner: iOS removed it so the room reads clean. The 30-day rule is
  // stated once, beside the Popular header in the channel list.
  updateVoiceButtonVisibility();
  syncBroadcastFundingGate();

  const hidden = hiddenIn(activeChannel);
  const messages = (messageCache[activeChannel] || []).filter((m) =>
    !hidden.has(m.senderAddress) && !deps.parseReactionEnvelope?.(m.content));
  if (roomBodyEl) {
    roomBodyEl.replaceChildren();
    if (messages.length === 0) {
      const empty = document.createElement("div");
      empty.className = "no-results-card";
      // A custom room has no history service anywhere, so "empty" here means "nothing has
      // been posted while you were watching" — say that plainly instead of leaving the room
      // looking broken or as if history were still loading.
      empty.innerHTML = isIndexedBroadcastChannel(activeChannel)
        ? `<strong>No messages yet</strong><span>Be the first to post in #${deps.escapeHtml(activeChannel)}.</span>`
        : `<strong>Listening for new messages</strong><span>#${deps.escapeHtml(activeChannel)} is a live room: messages appear here as they land on chain while it is open, or any time when background listening is on. There is no history to load.</span>`;
      roomBodyEl.append(empty);
    } else {
      // "Today"/"Yesterday"/date pill whenever the calendar day changes (iOS parity;
      // same pill class + label formatter as 1:1 and group chats).
      let lastDayKey = "";
      for (const m of messages) {
        const ts = Number(m.blockTime) || Date.now();
        const dayKey = new Date(ts).toDateString();
        if (dayKey !== lastDayKey && deps.daySeparatorLabel) {
          lastDayKey = dayKey;
          const sep = document.createElement("div");
          sep.className = "message-day-separator";
          const pill = document.createElement("span");
          pill.textContent = deps.daySeparatorLabel(ts);
          sep.append(pill);
          roomBodyEl.append(sep);
        }
        roomBodyEl.append(buildMessageRow(m));
      }
    }
    roomBodyEl.scrollTop = roomBodyEl.scrollHeight;
  }
  refreshVisibleSenderNames(messages);
}

let knsInFlight = false;
async function refreshVisibleSenderNames(messages) {
  if (knsInFlight) return;
  knsInFlight = true;
  try {
    const addresses = [...new Set(messages.slice(-30).map((m) => m.senderAddress))]
      .filter((a) => a && a !== deps.engine.address);
    let changed = false;
    for (const address of addresses) {
      const before = deps.engine.peekKnsAddressInfo?.(address)?.explicitPrimaryDomain || null;
      await deps.engine.fetchKnsAddressInfo?.(address).catch(() => null);
      const after = deps.engine.peekKnsAddressInfo?.(address)?.explicitPrimaryDomain || null;
      if (before !== after) changed = true;
    }
    if (changed && activeChannel) renderRoom();
  } finally {
    knsInFlight = false;
  }
}

// Zero-balance gate (iOS ZeroBalanceFundingCardView above a greyed compose bar): reading stays
// fully usable, only composing is blocked, and the card says where to send the KAS.
let fundingGateQrDrawnFor = null;
function syncBroadcastFundingGate() {
  const gate = document.querySelector("[data-broadcast-funding-gate]");
  const bar = composerInput?.closest(".kaposts-reply-bar");
  if (!gate) return;
  const address = deps.chattingAddress?.() || deps.engine.address || "";
  const gated = Boolean(activeChannel) && Boolean(address) && Boolean(deps.isChattingBalanceZero?.());
  gate.hidden = !gated;
  bar?.classList.toggle("gated", gated);
  if (composerInput) composerInput.disabled = gated;
  if (!gated) return;
  const addressEl = gate.querySelector("[data-broadcast-funding-gate-address]");
  if (addressEl) addressEl.textContent = address;
  const canvas = gate.querySelector("[data-broadcast-funding-gate-qr]");
  if (canvas && fundingGateQrDrawnFor !== address && deps.drawQr) {
    fundingGateQrDrawnFor = address;
    deps.drawQr(canvas, address).then(() => { canvas.style.width = "160px"; canvas.style.height = "160px"; })
      .catch(() => { fundingGateQrDrawnFor = null; });
  }
}

// The fee pill (iOS feeBubble): "fee: -------- KAS" shimmering while the estimate is in flight,
// the value underlined once it lands (a tap edits it), hidden with Show Fee Estimate off.
let feeTimer = null;
let feeToken = 0;
function formatKasExact(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(8) : "--";
}
function renderFeePill(feeKas, { estimating = false } = {}) {
  const pill = document.querySelector("[data-broadcast-fee]");
  if (!pill) return;
  pill.classList.toggle("estimating", estimating);
  if (estimating && feeKas == null) pill.textContent = "fee: -------- KAS";
  else if (feeKas == null) pill.textContent = "fee: -- KAS";
  else pill.textContent = `fee: ${formatKasExact(feeKas)} KAS`;
  pill.hidden = false;
}
function hideFeePill() {
  if (feeTimer) clearTimeout(feeTimer);
  feeTimer = null;
  feeEstimateKas = null;
  const pill = document.querySelector("[data-broadcast-fee]");
  if (pill) pill.hidden = true;
}
function scheduleBroadcastFeeEstimate() {
  const text = String(composerInput?.value || "").trim();
  if (!activeChannel || !text || !deps.showFeeEstimate?.() || !deps.estimateFeeKas) { hideFeePill(); return; }
  if (feeOverrideKas != null) { renderFeePill(feeOverrideKas); return; }
  if (feeTimer) clearTimeout(feeTimer);
  const token = ++feeToken;
  renderFeePill(feeEstimateKas, { estimating: true });
  feeTimer = setTimeout(async () => {
    try {
      const fee = await deps.estimateFeeKas(broadcastPayloadBytes(activeChannel, text));
      if (token !== feeToken) return;
      feeEstimateKas = fee == null ? null : String(fee);
      renderFeePill(feeEstimateKas);
    } catch {
      if (token === feeToken) renderFeePill(null);
    }
  }, 450);
}
async function editBroadcastFee() {
  const pill = document.querySelector("[data-broadcast-fee]");
  if (!pill || pill.classList.contains("estimating")) return;
  const current = feeOverrideKas ?? feeEstimateKas;
  if (current == null) return;
  const typed = await promptDialog({
    title: "Adjust Network Fee",
    label: "Fee (KAS)",
    message: "If the network is busy, a higher fee can help your transaction confirm faster.",
    initial: formatKasExact(current),
    confirmLabel: "Save",
  });
  if (typed == null) return;
  const normalized = String(typed).trim().replace(",", ".");
  if (normalized === "" || normalized === "0") { feeOverrideKas = null; scheduleBroadcastFeeEstimate(); return; }
  const value = Number(normalized);
  if (!Number.isFinite(value) || value < 0) { deps.showToast?.("Enter a fee in KAS."); return; }
  feeOverrideKas = normalized;
  renderFeePill(feeOverrideKas);
}

function updateConnectionDot() {
  if (!roomDotEl) return;
  const status = deps.engine.connectionState?.status || deps.engine.connectionState?.state || "";
  const healthy = String(status).toLowerCase().includes("connect") || deps.engine.rpc != null;
  roomDotEl.classList.toggle("ok", healthy);
}

// ---------------------------------------------------------------------------
// Voice notes (Nextcloud only — desktop has no on-chain broadcast audio)
// ---------------------------------------------------------------------------

function updateVoiceButtonVisibility() {
  // The mic is always there (iOS sendOrRecordButton). Nextcloud only changes where the bytes go.
  if (voiceBtn) voiceBtn.hidden = false;
}

function ensureVoiceRecorder() {
  if (voiceRecorder || !deps.createVoiceRecorder) return voiceRecorder;
  voiceRecorder = deps.createVoiceRecorder({
    maxDurationSeconds: () => (deps.isNextcloudMediaSendActive?.() ? VOICE_MAX_DURATION_SECONDS : ONCHAIN_VOICE_MAX_SECONDS),
    onElapsed: (elapsed) => {
      voiceRecordedSeconds = elapsed;
      const el = voicePanelEl?.querySelector("[data-broadcast-voice-time]");
      if (el) el.textContent = deps.formatRecordingTime ? deps.formatRecordingTime(elapsed) : `${Math.floor(elapsed)}s`;
    },
    onFinish: handleVoiceRecordingFinished,
  });
  return voiceRecorder;
}

async function startVoiceRecording() {
  if (!activeChannel) return;
  if (deps.isChattingBalanceZero?.()) {
    deps.showFundingGate?.();
    return;
  }
  const recorder = ensureVoiceRecorder();
  if (!recorder || recorder.isRecording()) return;
  voiceRecordingChannel = activeChannel;
  const error = await recorder.start();
  if (error) {
    deps.showToast?.(error);
    voiceRecordingChannel = null;
    return;
  }
  voiceRecordedSeconds = 0;
  deps.voicePreview?.clear(voicePanelEl);
  if (deps.voicePreview) deps.voicePreview.render(voicePanelEl, "recording", { prefix: "broadcast-voice", seconds: 0 });
  else if (voicePanelEl) voicePanelEl.hidden = false;
}

// Stop hands the recording to the preview bar (play/pause, length, trash, Send); Send is what
// sends it - the same bar the 1:1 and group composers use.
let voicePreviewChannel = null;
async function handleVoiceRecordingFinished({ blob, mimeType, cancelled }) {
  const channel = voiceRecordingChannel;
  voiceRecordingChannel = null;
  if (cancelled || !blob || !channel) { deps.voicePreview?.clear(voicePanelEl); if (voicePanelEl) voicePanelEl.hidden = true; return; }
  if (!deps.voicePreview) { await sendBroadcastVoice({ blob, mimeType, channel }); return; }
  voicePreviewChannel = channel;
  deps.voicePreview.set(voicePanelEl, { blob, mimeType, seconds: Math.round(Number(voiceRecordedSeconds) || 0) }, "broadcast-voice");
}
async function sendBroadcastVoicePreview() {
  const entry = deps.voicePreview?.get(voicePanelEl);
  const channel = voicePreviewChannel;
  voicePreviewChannel = null;
  deps.voicePreview?.clear(voicePanelEl);
  if (!entry || !channel) return;
  await sendBroadcastVoice({ blob: entry.blob, mimeType: entry.mimeType, channel });
}
async function sendBroadcastVoice({ blob, mimeType, channel }) {
  // With Nextcloud media send on, the bytes go to the server and the room gets the share link
  // (an audio card on every client). Otherwise, or when the upload fails, the note goes on
  // chain in the same envelope 1:1 and group voice notes use - if it is short enough.
  if (deps.isNextcloudMediaSendActive?.()) {
    try {
      const url = await deps.uploadNextcloudMedia(blob, `voice_${Date.now()}.${(deps.voiceFileName?.(mimeType) || "voice.webm").split(".").pop()}`, mimeType);
      await sendBroadcastText(channel, url);
      renderChannelList();
      return;
    } catch (error) {
      deps.showToast?.(`Nextcloud upload failed — sending on-chain instead. (${error.message})`);
      deps.appendEngineLog?.(`Broadcast voice note upload failed: ${error.message}`);
    }
  }
  const dataUrl = await new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => resolve("");
    reader.readAsDataURL(blob);
  });
  if (!dataUrl.startsWith("data:")) { deps.showToast?.("Could not process the recording."); return; }
  const durationSec = Math.round(Number(voiceRecordedSeconds) || 0);
  const envelope = JSON.stringify({ type: "file", name: deps.voiceFileName?.(mimeType) || "voice.webm", size: blob.size, mimeType: mimeType || "audio/webm", content: dataUrl, duration: durationSec });
  try {
    await sendBroadcastText(channel, envelope, { feeKas: feeOverrideKas });
    feeOverrideKas = null;
    renderChannelList();
  } catch (error) {
    deps.showToast?.(`Voice note failed: ${error.message}`);
    deps.appendEngineLog?.(`Broadcast voice note failed: ${error.message}`);
  }
}
let voiceRecordedSeconds = 0;

function cancelVoiceRecordingIfActive() {
  if (voiceRecorder?.isRecording()) voiceRecorder.stop(true);
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function openRoom(channel) {
  activeChannel = normalizeBroadcastChannel(channel);
  // Curated language rooms are not auto-joined, so opening one is what creates its row.
  if (activeChannel && isIndexedBroadcastChannel(activeChannel) && !joinedChannels.includes(activeChannel)) {
    joinedChannels.push(activeChannel);
    saveChannels();
    if (!joinedAtByChannel[activeChannel]) { joinedAtByChannel[activeChannel] = Date.now(); saveJoinedAt(); }
    renderChannelList();
  }
  cancelBroadcastReply(); // a reply drafted in another room must not leak across
  feeOverrideKas = null;
  hideFeePill();
  closeRoomInfo();
  renderRoom();
  updateConnectionDot();
  // Only the curated rooms have an indexer behind them. A custom room must never call it:
  // it serves nothing for that channel, so the request is pure noise and a failure there
  // would log a scary "backfill failed" for a room that was never meant to backfill.
  if (isIndexedBroadcastChannel(activeChannel)) {
    backfillChannel(activeChannel, { quiet: true });
    startPolling(activeChannel);
  } else {
    stopPolling();
  }
  syncScanWanted();
}

function closeRoom() {
  cancelVoiceRecordingIfActive();
  cancelBroadcastReply();
  activeChannel = null;
  stopPolling();
  syncScanWanted();
  renderRoom();
  renderChannelList();
}

function joinChannel(rawName) {
  const name = normalizeBroadcastChannel(rawName);
  if (!isValidBroadcastChannel(name)) {
    alertDialog({ title: "Couldn't Join Channel", message: "Channel names must be 1-36 characters with no spaces or colons." });
    return;
  }
  if (!joinedChannels.includes(name)) {
    joinedChannels.push(name);
    saveChannels();
    joinedAtByChannel[name] = Date.now();
    saveJoinedAt();
  }
  const joinCard = document.querySelector("[data-broadcast-join-card]");
  if (joinCard) joinCard.hidden = true;
  if (joinInput) joinInput.value = "";
  renderChannelList();
  openRoom(name);
}

function leaveChannel(name) {
  // Indexer-backed rooms (featured + curated language) can't be left - both are permanent
  // fixtures of the list screen, so no UI offers it; this guards stray paths.
  if (isIndexedBroadcastChannel(name)) return;
  joinedChannels = joinedChannels.filter((c) => c !== name);
  saveChannels();
  delete messageCache[name];
  saveCache();
  delete reactionsCache[name];
  saveReactions();
  delete listenByChannel[name];
  saveListen();
  delete indexerByChannel[name];
  saveIndexerOverrides();
  delete joinedAtByChannel[name];
  saveJoinedAt();
  if (activeChannel === name) closeRoom();
  syncScanWanted();
  renderChannelList();
}

async function sendCurrentMessage() {
  if (sendInFlight || !activeChannel || !composerInput) return;
  // Broadcast messages cost KAS too — same funding popup as chats when the
  // chatting balance is a confirmed zero.
  if (deps.isChattingBalanceZero?.()) {
    deps.showFundingGate?.();
    return;
  }
  const text = composerInput.value.trim();
  if (!text) return;
  sendInFlight = true;
  composerInput.value = "";
  const channel = activeChannel;
  // Reply mode: wrap in the exact cross-platform reply envelope the room renders.
  const replyTarget = broadcastReplyTarget;
  const content = replyTarget
    ? JSON.stringify({
        type: "reply",
        replyToId: replyTarget.txId,
        replyToSender: replyTarget.senderAddress,
        replyToPreview: replyTarget.preview,
        text,
      })
    : text;
  cancelBroadcastReply();
  const feeKas = feeOverrideKas;
  feeOverrideKas = null;
  hideFeePill();
  try {
    await sendBroadcastText(channel, content, { feeKas });
    renderChannelList();
  } catch (error) {
    deps.showToast?.(error.message);
    deps.appendEngineLog?.(`Broadcast send failed: ${error.message}`);
  } finally {
    sendInFlight = false;
  }
}

/** Toggle-sends a reaction. EXACT cross-platform wire format (iOS/Android/desktop 1:1):
 *  {"type":"reaction","targetTxId":"<txid>","emoji":"<emoji>","action":"add"|"remove"} —
 *  a normal broadcast message whose content is that JSON. Applied optimistically; the
 *  send failure is non-fatal (local state stays), matching the 1:1 behavior. */
async function sendBroadcastReaction(targetTxId, emoji) {
  if (!activeChannel || !targetTxId || !emoji) return;
  const myAddress = deps.engine.address || "";
  if (!myAddress) return;
  if (deps.isChattingBalanceZero?.()) {
    deps.showFundingGate?.();
    return;
  }
  const channel = activeChannel;
  const existing = reactionsFor(channel)[targetTxId]?.[myAddress];
  const action = existing && !existing.removed && existing.emoji === emoji ? "remove" : "add";

  recordReaction(channel, null, { targetTxId, emoji, action }, myAddress, Date.now());
  saveReactions();
  renderRoom();
  renderChannelList();

  const payload = JSON.stringify({ type: "reaction", targetTxId, emoji, action });
  // Delivery indicator only for ADDs — a removal deletes the chip (matches iOS/1:1).
  const statusKey = action === "add" ? `${targetTxId}|${emoji}` : null;
  const attempt = async () => {
    if (statusKey) setBroadcastReactionStatus(statusKey, "pending");
    try {
      const txid = await enqueueBroadcastSend(() => sendBroadcastMessage({ engine: deps.engine, channel, content: payload }));
      // Remember our own reaction tx so the next poll doesn't re-process it.
      const entry = reactionsCache[channel];
      if (entry && txid) {
        (entry.txIds ||= []).push(txid);
        saveReactions();
      }
      if (statusKey) setBroadcastReactionStatus(statusKey, "sent");
    } catch (error) {
      deps.appendEngineLog?.(`Broadcast reaction send failed (local state already applied): ${error.message}`);
      if (statusKey) setBroadcastReactionStatus(statusKey, "failed", attempt);
    }
  };
  await attempt();
}

// Reaction delivery status (1:1 parity): ✓ once on-chain (auto-hides after 60s),
// red "!" that retries on click when the send failed. In-memory only.
const broadcastReactionStatus = new Map(); // "txId|emoji" -> { status, retry }

function setBroadcastReactionStatus(key, status, retry = null) {
  broadcastReactionStatus.set(key, { status, retry });
  if (status === "sent") {
    window.setTimeout(() => {
      if (broadcastReactionStatus.get(key)?.status === "sent") {
        broadcastReactionStatus.delete(key);
        renderRoom();
      }
    }, 600_000);
  }
  renderRoom();
}

function broadcastReactionStatusEl(key) {
  const entry = broadcastReactionStatus.get(key);
  if (!entry) return null;
  const el = document.createElement("span");
  if (entry.status === "pending") {
    el.className = "reaction-status pending";
    el.textContent = "…";
    el.title = "Sending reaction…";
  } else if (entry.status === "sent") {
    el.className = "reaction-status sent";
    el.textContent = "✓";
    el.title = "Reaction sent";
  } else {
    el.className = "reaction-status failed";
    el.textContent = "!";
    el.title = "Reaction failed to send — click to retry";
    el.addEventListener("click", (event) => {
      event.stopPropagation();
      entry.retry?.();
    });
  }
  return el;
}

function hideSender(address) {
  if (!activeChannel || !address || address === deps.engine.address) return;
  const set = new Set(hiddenByRoom[activeChannel] || []);
  set.add(address);
  hiddenByRoom[activeChannel] = [...set];
  saveHidden();
  renderRoom();
  deps.showToast?.("User hidden in this room");
}

function infoPanelEl() {
  return document.querySelector("[data-broadcast-info-panel]") || document.querySelector("[data-broadcast-hidden-panel]");
}

function closeRoomInfo() {
  const panel = infoPanelEl();
  if (panel) { panel.hidden = true; panel.innerHTML = ""; }
}

// Hidden users in ONE room (iOS HiddenBroadcastSendersView): name over the full address,
// alphabetical, Unhide per row. Reached from Room Info.
function renderHiddenUsersPanel() {
  const panel = infoPanelEl();
  if (!panel || !activeChannel) return;
  const addresses = [...(hiddenByRoom[activeChannel] || [])].sort();
  panel.hidden = false;
  panel.innerHTML = `
    <div class="kaposts-thread-header">
      <button class="kaposts-icon-button" type="button" data-broadcast-info-open aria-label="Back to Room Info">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10.5 19.5 3 12m0 0 7.5-7.5M3 12h18"/></svg>
      </button>
      <strong>Hidden Users - #${deps.escapeHtml(activeChannel)}</strong>
      <button class="kaposts-view-link" type="button" data-broadcast-hidden-close>Done</button>
    </div>
    ${addresses.length === 0
      ? `<div class="no-results-card"><span>No hidden users in #${deps.escapeHtml(activeChannel)}. Right-click a message to hide its sender.</span></div>`
      : addresses.map((address) => `
          <div class="kaposts-notification-row">
            <div class="kaposts-notification-main">
              <span><strong>${deps.escapeHtml(senderName(address))}</strong></span>
              <span class="broadcast-info-address">${deps.escapeHtml(address)}</span>
            </div>
            <button class="kaposts-view-link" type="button" data-broadcast-unhide="${deps.escapeHtml(address)}">Unhide</button>
          </div>`).join("")}`;
}

// Everything about one room that is not the messages (iOS BroadcastRoomInfoView): what it is,
// what is in it, how to share it, who you have hidden, and which indexer it reads from.
let indexerCheck = { state: "idle" }; // idle | checking | reachable(count) | failed(reason)
function renderRoomInfoPanel() {
  const panel = infoPanelEl();
  if (!panel || !activeChannel) return;
  const channel = activeChannel;
  const curated = isIndexedBroadcastChannel(channel);
  const rows = messageCache[channel] || [];
  const people = new Set(rows.map((m) => m.senderAddress).filter(Boolean)).size;
  const times = rows.map((m) => Number(m.blockTime) || 0).filter(Boolean);
  const fmt = (ms) => new Date(ms).toLocaleString([], { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
  const fmtDay = (ms) => new Date(ms).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
  const language = broadcastLanguageDisplayName(channel);
  const joinedAt = joinedAtByChannel[channel];
  const hiddenCount = (hiddenByRoom[channel] || []).length;
  const appWide = String(deps.appWideBroadcastIndexer?.() || "").trim();
  const override = indexerOverrideFor(channel);
  const row = (label, value) => `<div class="broadcast-info-row"><span>${deps.escapeHtml(label)}</span><strong>${deps.escapeHtml(value)}</strong></div>`;
  const checkHtml = indexerCheck.state === "checking"
    ? `<p class="broadcast-info-check checking">Checking the indexer...</p>`
    : indexerCheck.state === "reachable"
      ? `<p class="broadcast-info-check ok">${indexerCheck.count === 0 ? "Connected. It holds nothing for this room yet." : "Connected, and it has this room's messages."}</p>`
      : indexerCheck.state === "failed"
        ? `<p class="broadcast-info-check failed">${deps.escapeHtml(indexerCheck.reason)}</p>`
        : "";
  panel.hidden = false;
  panel.innerHTML = `
    <div class="kaposts-thread-header">
      <strong>Room Info</strong>
      <button class="kaposts-view-link" type="button" data-broadcast-hidden-close>Done</button>
    </div>
    <section class="broadcast-info-section">
      ${row("Room", `#${channel}`)}
      ${language ? row("Language", language) : ""}
      ${row("Kind", curated ? "Popular" : "Added by you")}
      ${joinedAt ? row("Joined", fmtDay(joinedAt)) : ""}
      <p class="broadcast-info-footer">${curated
        ? "A curated room, always in your list. Anyone running KaChat can post to it."
        : "A room you added. Anyone who knows the name can post to it."}</p>
    </section>
    <section class="broadcast-info-section">
      <h3>On this device</h3>
      ${row("Messages", String(rows.length))}
      ${row("People who posted", String(people))}
      ${times.length ? row("Latest", fmt(Math.max(...times))) : ""}
      ${times.length ? row("Oldest held", fmt(Math.min(...times))) : ""}
      ${!curated ? row("Kept for", retentionDescription(retentionMillisFor(channel))) : ""}
    </section>
    <section class="broadcast-info-section">
      <button type="button" class="broadcast-info-action" data-broadcast-share-room>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m0-12 4 4m-4-4-4 4M5 14v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4"/></svg>
        <span>Share this room</span>
      </button>
      <button type="button" class="broadcast-info-action" data-broadcast-hidden-users>
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10" cy="8" r="4"/><path d="M3 20a7 7 0 0 1 12.5-4.3M17 15l4 4m0-4-4 4"/></svg>
        <span>Hidden users</span>
        <b>${hiddenCount}</b>
      </button>
      <p class="broadcast-info-footer">Sharing sends a link that opens this room in KaChat, and a web link for anyone without it. Hiding is per room: someone hidden here still shows in every other room.</p>
    </section>
    <section class="broadcast-info-section">
      <h3>Indexer for this room</h3>
      <input class="kaposts-reply-input" type="url" data-broadcast-indexer-input value="${deps.escapeHtml(override)}" placeholder="${deps.escapeHtml(appWide)}" autocomplete="off" spellcheck="false" />
      ${checkHtml}
      <div class="broadcast-info-buttons">
        <button type="button" class="primary-button" data-broadcast-indexer-save ${indexerCheck.state === "checking" ? "disabled" : ""}>Save</button>
        ${override ? `<button type="button" class="secondary-button danger" data-broadcast-indexer-clear>Use the app's indexer</button>` : ""}
      </div>
      <p class="broadcast-info-footer">A broadcast lives on the Kaspa blockDAG, so any indexer watching the same network serves the same room. Point this one wherever you like - your own, or someone else's - without changing the indexer every other room uses. Leave it blank to follow ${deps.escapeHtml(appWide || "the app's indexer")}.</p>
    </section>`;
}

// Saves the override, then asks the indexer for this room. A wrong URL is otherwise silent: the
// room simply stops filling in, with nothing on screen to say why.
async function saveRoomIndexer(value) {
  if (!activeChannel) return;
  const channel = activeChannel;
  const trimmed = String(value || "").trim();
  if (trimmed === indexerOverrideFor(channel)) return;
  if (trimmed) indexerByChannel[channel] = trimmed; else delete indexerByChannel[channel];
  saveIndexerOverrides();
  deps.showToast?.(trimmed ? `Indexer updated for #${channel}.` : "This room follows the app's indexer again.");
  deepBackfilled.delete(channel);
  indexerCheck = { state: "checking" };
  renderRoomInfoPanel();
  try {
    const target = trimmed || String(deps.appWideBroadcastIndexer?.() || "").trim() || null;
    const page = await fetchBroadcastHistory({ channel, limit: 1, baseUrl: target });
    indexerCheck = { state: "reachable", count: page.messages.length };
  } catch (error) {
    indexerCheck = { state: "failed", reason: `Could not reach it: ${error.message}` };
  }
  if (activeChannel === channel) renderRoomInfoPanel();
  if (isIndexedBroadcastChannel(channel) || trimmed) backfillChannel(channel, { quiet: true });
}

async function copyRoomLink(channel, { text = false } = {}) {
  const value = text ? roomShareText(channel) : roomShareLink(channel);
  try { await deps.copyText?.(value); deps.showToast?.("Room link copied"); } catch { deps.showToast?.("Could not copy the link."); }
}

// The retention sheet (iOS RetentionSettingsView): an amount and a unit, capped at three days.
function openRetentionSheet(channel) {
  const name = normalizeBroadcastChannel(channel);
  const { amount, unit } = retentionParts(retentionMillisFor(name));
  const host = document.createElement("div");
  host.className = "modal-backdrop broadcast-retention-backdrop";
  host.innerHTML = `
    <section class="contact-modal broadcast-retention-sheet" role="dialog" aria-modal="true" aria-label="Message Retention">
      <div class="modal-header"><div><h2>Message Retention</h2></div><button class="modal-close" type="button" data-retention-cancel aria-label="Cancel">×</button></div>
      <p class="screen-kicker">Message Retention for #${deps.escapeHtml(name)}</p>
      <div class="broadcast-retention-row">
        <input type="number" min="1" step="1" inputmode="numeric" data-retention-amount value="${amount}" placeholder="Amount" />
        <select data-retention-unit>${RETENTION_UNITS.map(([u]) => `<option value="${u}" ${u === unit ? "selected" : ""}>${u}</option>`).join("")}</select>
      </div>
      <p class="field-hint" data-retention-footer></p>
      <p class="field-hint broadcast-retention-warning">Longer retention means more messages stay cached on your device - this can slow the app down over time, especially for busy rooms.</p>
      <div class="modal-actions">
        <button class="secondary-button" type="button" data-retention-cancel>Cancel</button>
        <button class="primary-button" type="button" data-retention-save>Save</button>
      </div>
    </section>`;
  document.body.appendChild(host);
  const amountEl = host.querySelector("[data-retention-amount]");
  const unitEl = host.querySelector("[data-retention-unit]");
  const footer = host.querySelector("[data-retention-footer]");
  const save = host.querySelector("[data-retention-save]");
  const perUnit = () => RETENTION_UNITS.find(([u]) => u === unitEl.value)?.[1] || 1000;
  const maxAmount = () => Math.floor(MAX_RETENTION_MS / perUnit());
  const validate = () => {
    const value = Number(amountEl.value);
    const valid = Number.isInteger(value) && value >= 1 && value <= maxAmount();
    save.disabled = !valid;
    footer.textContent = `How long messages in this broadcast stay cached on this device, up to a maximum of 3 days. Max: ${maxAmount()} ${unitEl.value}.`;
  };
  validate();
  amountEl.addEventListener("input", validate);
  unitEl.addEventListener("change", validate);
  const close = () => host.remove();
  host.addEventListener("click", (event) => {
    if (event.target === host || event.target.closest("[data-retention-cancel]")) { close(); return; }
    if (event.target.closest("[data-retention-save]") && !save.disabled) {
      retentionByChannel[name] = Math.min(MAX_RETENTION_MS, Number(amountEl.value) * perUnit());
      saveRetention();
      pruneCache();
      saveCache();
      saveReactions();
      renderChannelList();
      if (activeChannel === name) renderRoom();
      close();
    }
  });
  host.addEventListener("keydown", (event) => { if (event.key === "Escape") close(); });
  amountEl.focus();
  amountEl.select();
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

export function refreshBroadcasts() {
  tabVisible = true;
  loadState();
  renderChannelList();
  if (activeChannel) renderRoom();
  syncScanWanted();
}

export function resetBroadcastsForAccount() {
  cancelVoiceRecordingIfActive();
  stopPolling();
  activeChannel = null;
  loadState();
  syncScanWanted();
  renderChannelList();
  renderRoom();
}

/** Called when the Broadcasts tab stops being the visible tab. The open room stops
 *  polling AND stops counting as wanted; always-listen rooms keep their block scan. */
export function stopBroadcastPolling() {
  stopPolling();
  if (!deps) return;
  tabVisible = false;
  syncScanWanted();
}

/** Deep-open a channel's room from OUTSIDE this module (the global bell center). */
// An in-chat room link (kachat://broadcast/<channel>): joins the room if it is not in the list
// yet, then opens it - the same gate a pasted room name goes through.
export function openBroadcastRoomFromLink(channel) {
  if (!deps) return;
  loadState();
  joinChannel(channel);
}

export function openBroadcastChannelFromNotification(channel) {
  if (!deps) return;
  const clean = normalizeBroadcastChannel(channel);
  if (!clean) return;
  loadState();
  openRoom(clean);
}

export function initBroadcasts(dependencies) {
  deps = dependencies;
  listEl = document.querySelector("[data-broadcast-list]");
  roomEl = document.querySelector("[data-broadcast-room]");
  roomTitleEl = document.querySelector("[data-broadcast-room-title]");
  roomDotEl = document.querySelector("[data-broadcast-room-dot]");
  roomBodyEl = document.querySelector("[data-broadcast-room-body]");
  // The in-room retention banner was removed for iOS parity (the room reads clean; the 30-day
  // rule is stated beside the Popular header instead). Its markup still lives in index.html —
  // drop the node so it can never render. Safe to delete the element from index.html later.
  // The banner markup is gone from index.html, but this is a PWA: a service-worker-cached
  // old shell can still carry it, so strip it at runtime too.
  document.querySelector("[data-broadcast-room-banner]")?.remove();
  composerInput = document.querySelector("[data-broadcast-input]");
  sendBtn = document.querySelector("[data-broadcast-send]");
  joinInput = document.querySelector("[data-broadcast-join-input]");
  voicePanelEl = document.querySelector("[data-broadcast-voice-panel]");
  voiceTimeEl = document.querySelector("[data-broadcast-voice-time]");
  voiceBtn = document.querySelector("[data-broadcast-voice]");
  document.querySelector("[data-broadcast-reply-cancel]")?.addEventListener("click", cancelBroadcastReply);

  loadState();
  renderChannelList();
  updateVoiceButtonVisibility();

  deps.engine.onConnectionState?.(() => updateConnectionDot());
  // Live block scanning: rows arrive in the indexer's row shape and go through the same
  // mergeMessages dedupe/retention/render path, so a message seen by both paths is stored once.
  deps.engine.onBroadcastBlockHits?.(handleBroadcastBlockHits);
  // Always-listen rooms must start scanning at launch, before the tab is ever opened.
  syncScanWanted();

  const joinButton = document.querySelector("[data-broadcast-join]");
  const joinCard = document.querySelector("[data-broadcast-join-card]");
  const syncJoinButton = () => { if (joinButton) joinButton.disabled = !String(joinInput?.value || "").trim(); };
  syncJoinButton();
  joinInput?.addEventListener("input", syncJoinButton);
  joinButton?.addEventListener("click", () => {
    if (!String(joinInput?.value || "").trim()) return;
    joinChannel(joinInput?.value || "");
    if (joinInput) joinInput.value = "";
    syncJoinButton();
  });
  document.querySelector("[data-broadcast-join-cancel]")?.addEventListener("click", () => {
    if (joinCard) joinCard.hidden = true;
    if (joinInput) joinInput.value = "";
    syncJoinButton();
  });
  joinInput?.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && String(joinInput.value || "").trim()) {
      joinChannel(joinInput.value);
      joinInput.value = "";
      syncJoinButton();
    }
  });
  // Right-click on a room row: share or copy its invite link (iOS row context menu).
  onContextGesture(listEl, async (event) => {
    const card = event.target.closest("[data-broadcast-open]");
    if (!card) return;
    event.preventDefault();
    const name = card.dataset.broadcastOpen;
    const choice = await chooseDialog({
      title: `#${name}`,
      options: [
        { id: "share", title: "Share Room Link", subtitle: "Copies an invite with both link forms to your clipboard." },
        { id: "copy", title: "Copy Room Link", subtitle: "Copies the kachat:// link on its own." },
      ],
    });
    if (choice === "share") copyRoomLink(name, { text: true });
    else if (choice === "copy") copyRoomLink(name);
  });
  composerInput?.addEventListener("input", scheduleBroadcastFeeEstimate);
  document.querySelector("[data-broadcast-fee]")?.addEventListener("click", editBroadcastFee);
  document.querySelector("[data-broadcast-funding-gate]")?.addEventListener("click", async (event) => {
    if (!event.target.closest("[data-broadcast-funding-gate-address], [data-broadcast-funding-gate-copy]")) return;
    const address = deps.chattingAddress?.() || "";
    if (!address) return;
    try { await deps.copyText?.(address); deps.showToast?.(deps.addressCopiedToastText?.(address) || "Address copied"); } catch {}
  });
  // The room's header chip opens Room Info; the dead space beside it jumps to the first message.
  document.querySelector("[data-broadcast-room-info]")?.addEventListener("click", () => { indexerCheck = { state: "idle" }; renderRoomInfoPanel(); });
  document.querySelector("[data-broadcast-room] .kaposts-thread-header")?.addEventListener("click", (event) => {
    if (event.target.closest("button") || !roomBodyEl) return;
    roomBodyEl.scrollTo({ top: 0, behavior: "smooth" });
    const first = roomBodyEl.querySelector("[data-broadcast-txid]");
    if (first) { first.classList.add("message-highlight"); window.setTimeout(() => first.classList.remove("message-highlight"), 1200); }
  });
  // Scroll-to-latest, appearing once you have scrolled up.
  if (roomBodyEl?.parentElement) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "group-scroll-bottom broadcast-scroll-bottom";
    btn.setAttribute("aria-label", "Scroll to latest");
    btn.hidden = true;
    btn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';
    btn.addEventListener("click", () => roomBodyEl.scrollTo({ top: roomBodyEl.scrollHeight, behavior: "smooth" }));
    roomBodyEl.parentElement.appendChild(btn);
    roomBodyEl.addEventListener("scroll", () => {
      btn.hidden = roomBodyEl.scrollHeight - roomBodyEl.scrollTop - roomBodyEl.clientHeight < 120;
    }, { passive: true });
  }

  document.querySelector("[data-broadcast-back]")?.addEventListener("click", closeRoom);
  sendBtn?.addEventListener("click", sendCurrentMessage);
  composerInput?.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      sendCurrentMessage();
    }
  });

  voiceBtn?.addEventListener("click", startVoiceRecording);
  voicePanelEl?.addEventListener("click", (event) => {
    if (event.target.closest("[data-broadcast-voice-stop]")) { voiceRecorder?.stop(false); return; }
    if (event.target.closest("[data-broadcast-voice-send]")) { sendBroadcastVoicePreview(); return; }
    if (event.target.closest("[data-broadcast-voice-play]")) { deps.voicePreview?.toggle(voicePanelEl); return; }
    if (event.target.closest("[data-broadcast-voice-cancel]")) {
      if (voiceRecorder?.isRecording()) voiceRecorder.stop(true);
      else { voicePreviewChannel = null; deps.voicePreview?.clear(voicePanelEl); if (voicePanelEl) voicePanelEl.hidden = true; }
    }
  });

  const screen = document.querySelector('[data-app-tab-screen="broadcasts"]');
  screen?.addEventListener("click", async (event) => {
    const react = event.target.closest("[data-broadcast-react]");
    if (react) {
      event.stopPropagation();
      sendBroadcastReaction(react.dataset.broadcastReact, react.dataset.emoji);
      return;
    }

    const leave = event.target.closest("[data-broadcast-leave]");
    if (leave) {
      event.stopPropagation();
      const confirmed = await confirmDialog({
        title: `Leave #${leave.dataset.broadcastLeave}`,
        message: "Leaving this broadcast permanently deletes every message cached for it on this device. This cannot be undone - rejoining later starts with no history.",
        confirmLabel: "Leave & Delete",
        destructive: true,
      });
      if (confirmed) leaveChannel(leave.dataset.broadcastLeave);
      return;
    }

    // "Other Languages": the collapsed category of curated language rooms under Popular.
    const languagesToggle = event.target.closest("[data-broadcast-languages-toggle]");
    if (languagesToggle) {
      event.stopPropagation();
      languagesExpanded = !languagesExpanded;
      renderChannelList();
      return;
    }

    // The bell: OS notifications for new messages in this channel.
    const notify = event.target.closest("[data-broadcast-notify]");
    if (notify) {
      event.stopPropagation();
      const name = notify.dataset.broadcastNotify;
      // Curated language rooms are not auto-joined - the bell creates the row on demand, so
      // the very first tap turns notifications ON rather than silently creating an off row.
      if (isIndexedBroadcastChannel(name) && !joinedChannels.includes(name)) {
        joinedChannels.push(name);
        saveChannels();
      }
      if (notifyByChannel[name]) {
        delete notifyByChannel[name];
        deps.showToast?.("Notifications are off for this broadcast");
      } else {
        notifyByChannel[name] = true;
        // Make sure the OS-level permission is actually granted so the pings can fire.
        deps.ensureNotificationPermission?.();
        deps.showToast?.(isIndexedBroadcastChannel(name)
          ? "You'll get notifications for new messages in this broadcast, even when the app is closed"
          : "You'll get a notification for new messages in this broadcast as long as your app remains open");
      }
      saveNotify();
      renderChannelList();
      return;
    }

    // Always-listen (own channels): keep this room's live block scan running with its screen
    // closed. Off, a custom room only receives while you are looking at it.
    const listen = event.target.closest("[data-broadcast-listen]");
    if (listen) {
      event.stopPropagation();
      const name = listen.dataset.broadcastListen;
      if (listenByChannel[name]) {
        delete listenByChannel[name];
        deps.showToast?.("You will no longer see messages in this broadcast unless you are in the broadcast at the same time chats come in");
      } else {
        listenByChannel[name] = true;
        deps.showToast?.("You will now listen for new chats as long as your app remains open");
      }
      saveListen();
      syncScanWanted();
      renderChannelList();
      return;
    }

    // Retention gear (own channels): how long cached messages are kept on this device.
    const retention = event.target.closest("[data-broadcast-retention]");
    if (retention) {
      event.stopPropagation();
      openRetentionSheet(retention.dataset.broadcastRetention);
      return;
    }

    // + in the "Your Channels" header: reveal the join/create card (iOS's join alert).
    const joinToggle = event.target.closest("[data-broadcast-join-toggle]");
    if (joinToggle) {
      event.stopPropagation();
      const card = document.querySelector("[data-broadcast-join-card]");
      if (card) {
        card.hidden = !card.hidden;
        if (!card.hidden) joinInput?.focus();
      }
      return;
    }

    const open = event.target.closest("[data-broadcast-open]");
    if (open) { openRoom(open.dataset.broadcastOpen); return; }

    const sender = event.target.closest("[data-broadcast-sender]");
    if (sender) {
      event.stopPropagation();
      openBroadcastSenderMenu(sender.dataset.broadcastSender, event.clientX, event.clientY);
      return;
    }

    const unhide = event.target.closest("[data-broadcast-unhide]");
    if (unhide) {
      hiddenByRoom[activeChannel] = (hiddenByRoom[activeChannel] || []).filter((a) => a !== unhide.dataset.broadcastUnhide);
      saveHidden();
      renderHiddenUsersPanel();
      renderRoom();
      return;
    }

    if (event.target.closest("[data-broadcast-hidden-users]")) { renderHiddenUsersPanel(); return; }
    if (event.target.closest("[data-broadcast-info-open]")) { renderRoomInfoPanel(); return; }
    if (event.target.closest("[data-broadcast-share-room]")) { copyRoomLink(activeChannel, { text: true }); return; }
    if (event.target.closest("[data-broadcast-indexer-save]")) {
      saveRoomIndexer(infoPanelEl()?.querySelector("[data-broadcast-indexer-input]")?.value || "");
      return;
    }
    if (event.target.closest("[data-broadcast-indexer-clear]")) { saveRoomIndexer(""); return; }

    const hiddenClose = event.target.closest("[data-broadcast-hidden-close]");
    if (hiddenClose) closeRoomInfo();
  });
  infoPanelEl()?.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && event.target.matches("[data-broadcast-indexer-input]")) {
      event.preventDefault();
      saveRoomIndexer(event.target.value);
    }
  });
}
