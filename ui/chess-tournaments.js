// Chess Online (CHESS_TOURNAMENTS.md; iOS 334cdd1 … 01af8bc): Kaspa Hub > Chess Online.
// The `#chess-arena` room is read through the broadcast indexer and the live block scan,
// reduced by engine/chess-tournament.js into the rooms every device agrees on, and every
// action a player takes - join, leave, move, resign, claim, chat - is one broadcast
// transaction. Screens: home (choose 1v1 or Tournament), one screen per kind with four tabs
// (play, Active games to watch, Finished games, that kind's Leaderboard), the waiting room,
// the tournament bracket, the game (board, clocks, chat beneath) and the result screen.

import * as T from "../engine/chess-tournament.js";
import * as Chess from "../engine/chess.js";
import { fetchBroadcastHistory, hasBroadcastIndexer, sendBroadcastMessage, broadcastPayloadBytes } from "../engine/broadcasts.js";
import { confirmDialog, promptDialog, alertDialog, chooseDialog } from "./dialogs.js";
import { setServiceScanWanted } from "./broadcasts.js";

const ARENA_CACHE_KEY = "kachat-chess-arena-v1";   // device-wide: the arena is the same for every wallet
const ARENA_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const ARENA_MAX_ROWS = 40_000;
const POLL_MS = 8_000;
/** While this player holds a seat or has a game on, the arena is pulled from the indexer every
 *  two seconds on top of the 8 s poll and the block scan (iOS 593620e). */
const FAST_POLL_MS = 2_000;
const TICK_MS = 200;
const SEND_ATTEMPTS = 5;
const SEND_RETRY_MS = 1_200;
const HISTORY_WAIT_MS = 8_000;
const END_OVERLAY_MS = 2_400;

let deps = null;
let screenEl = null;
let rows = new Map();          // txId -> { txId, senderAddress, content, blockTime, local? }
let tournaments = {};
let leaderboardRows = [];
let active = false;            // the Chess screen is on
let pollTimer = null;
let fastPollTimer = null;
let tickTimer = null;
let unsubscribeHits = null;
let backfilled = false;
/** True once the arena's history has come back from the indexer (or there is none, or a few
 *  seconds passed). A join before that would pick a room from an empty view (iOS d2ab780). */
let historyReady = false;
let historyDeadline = 0;
let now = Date.now();
let lastError = "";
const pendingMoveGames = new Set();   // "<tournament>|<game>" sent and not yet seen back
const claimedGames = new Set();       // claims already posted - one is enough
let queuedPublicRoomId = null;
let joinFeeText = null;               // "0.0017 KAS" once estimated this session

// Navigation. mode: "duel" | "tournament". tab: play | active | finished | leaderboard.
let view = { name: "home", mode: "duel", tab: "play", tournamentId: null, gameId: null };
let autoOpenedGameId = null;
let selectedSquare = null;
let pendingPromotion = null;   // { from, to }
let busy = false;              // a join/create/leave in flight
let waitingNotice = "";
// End-of-game flow: the burst over the board, then the result screen for the two players.
let endOverlayFor = null;      // "<tournament>|<game>" showing the overlay
let endHandledFor = null;
let recordBeforeEnd = null;    // the player's row as it stood while the game was on
let resultRevealed = false;
let resultRevealTimer = null;
const drafts = {};             // chat drafts per game, kept while the screen is up

const me = () => deps?.engine?.address || "";
const esc = (v) => deps.escapeHtml(String(v ?? ""));
/** Contact name, then KNS domain, then the shortened address - the app's rule, and the same
 *  for the player themselves (never "You"; iOS 30d0cca). */
const nameFor = (address) => (address ? deps.displayNameFor(address) : "unknown");
const avatarFor = (address, cls = "chess-t-avatar") => deps.avatarHtmlFor?.(address, cls) || "";
const keyOf = (tid, gid) => `${tid}|${gid}`;

// ---------------------------------------------------------------------------------------------
// Arena rows: cache, backfill, live scan
// ---------------------------------------------------------------------------------------------

function loadCache() {
  rows = new Map();
  try {
    const list = JSON.parse(localStorage.getItem(ARENA_CACHE_KEY) || "[]");
    const cutoff = Date.now() - ARENA_RETENTION_MS;
    for (const r of Array.isArray(list) ? list : []) {
      if (!r?.txId || Number(r.blockTime || 0) < cutoff) continue;
      rows.set(r.txId, { txId: r.txId, senderAddress: r.senderAddress || "", content: r.content || "", blockTime: Number(r.blockTime) || 0, local: Boolean(r.local) });
    }
  } catch { rows = new Map(); }
}
let saveTimer = null;
function saveCache() {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    try {
      const list = [...rows.values()].sort((a, b) => a.blockTime - b.blockTime).slice(-ARENA_MAX_ROWS);
      localStorage.setItem(ARENA_CACHE_KEY, JSON.stringify(list));
    } catch { /* quota: the indexer refills it */ }
  }, 500);
}

/** Merges indexer or scan rows. A row this device sent was stamped with its own clock; the
 *  chain's block time replaces it when the scan or the indexer sees it (iOS 64aca7c). */
function mergeRows(list) {
  let changed = 0;
  for (const r of list || []) {
    if (!r?.txId || !T.decodeMessage(r.content)) continue;
    const existing = rows.get(r.txId);
    const blockTime = Number(r.blockTime) || 0;
    if (existing && existing.blockTime === blockTime && !existing.local) continue;
    rows.set(r.txId, { txId: r.txId, senderAddress: r.senderAddress || "", content: r.content || "", blockTime });
    changed += 1;
  }
  if (changed) { saveCache(); reduceArena(); }
  return changed;
}

async function backfill({ full = false } = {}) {
  if (!hasBroadcastIndexer()) { historyReady = true; return; }
  try {
    let before = null;
    const cutoff = Date.now() - ARENA_RETENTION_MS;
    const pages = backfilled && !full ? 1 : 20;
    for (let page = 0; page < pages; page += 1) {
      const result = await fetchBroadcastHistory({ channel: T.ARENA_CHANNEL, limit: 500, before });
      mergeRows(result.messages);
      if (!result.hasMore || !result.messages?.length) break;
      const oldest = result.messages.reduce((min, m) => Math.min(min, Number(m.blockTime) || Infinity), Infinity);
      if (!Number.isFinite(oldest) || oldest < cutoff) break;
      before = oldest;
    }
    backfilled = true;
    if (!historyReady) { historyReady = true; render(); }
  } catch (error) {
    // The indexer may not track the arena yet (CHESS_TOURNAMENTS.md §6): the lobby then shows
    // what this device scanned itself.
    deps.appendEngineLog?.(`Chess arena backfill failed: ${error.message}`);
  }
}

function handleHits(hits) {
  const mine = (hits || []).filter((h) => h?.channel === T.ARENA_CHANNEL);
  if (mine.length) mergeRows(mine);
}

function reduceArena() {
  const events = [];
  for (const r of rows.values()) {
    const message = T.decodeMessage(r.content);
    if (message) events.push({ txId: r.txId, sender: r.senderAddress, blockTime: r.blockTime, message });
  }
  tournaments = T.reduce(events);
  leaderboardRows = T.leaderboard(Object.values(tournaments));
  const my = me();
  // Asked to join a public room that filled first: queue into the next one, once.
  if (queuedPublicRoomId && my) {
    const room = tournaments[queuedPublicRoomId];
    if (room && T.isFull(room) && !room.players.includes(my)) {
      const wasDuel = T.duelNumber(queuedPublicRoomId) !== null;
      queuedPublicRoomId = null;
      joinPublicRoom(wasDuel).catch(() => {});
    } else if (room?.players.includes(my)) {
      queuedPublicRoomId = null;
    }
  }
  // A move of ours that the chain now shows is no longer pending.
  for (const key of [...pendingMoveGames]) {
    const [tid, gid] = key.split("|");
    const game = tournaments[tid]?.games[gid];
    if (!game) continue;
    if (!(T.playerToMove(game) === my && !game.winner)) pendingMoveGames.delete(key);
  }
  if (active) {
    rememberRecord();
    render();
    autoOpenMyGameIfNeeded();
    gameEndedIfNeeded();
  }
}

// ---------------------------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------------------------

/** The room to queue into: the lowest-numbered public room of that kind still waiting for
 *  players; when none is, one past the highest room this device knows (iOS d2ab780). */
function currentRoomNumber(numberOf) {
  let open = null;
  let highest = 0;
  for (const room of Object.values(tournaments)) {
    const number = numberOf(room.id);
    if (number === null) continue;
    highest = Math.max(highest, number);
    if (T.tournamentStatus(room) === "open" && !T.isFull(room)) open = open === null ? number : Math.min(open, number);
  }
  return open ?? highest + 1;
}
const currentPublicRoomId = () => T.publicId(currentRoomNumber(T.publicNumber));
const currentDuelRoomId = () => T.duelId(currentRoomNumber(T.duelNumber));

function myPrivate(duel) {
  const my = me();
  if (!my) return [];
  return Object.values(tournaments)
    .filter((t) => !T.isPublicId(t.id) && T.isDuel(t) === duel && ["open", "live"].includes(T.tournamentStatus(t)) && t.players.includes(my))
    .sort((a, b) => b.createdAt - a.createdAt);
}
function liveTournaments() {
  return Object.values(tournaments).filter((t) => T.tournamentStatus(t) === "live").sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
}
function finishedTournaments() {
  return Object.values(tournaments).filter((t) => T.tournamentStatus(t) === "finished").sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
}
/** The tournament this player is in that is not over. A waiting seat that has expired does
 *  not count: the player is free to join elsewhere. */
function myActiveTournament() {
  const my = me();
  if (!my) return null;
  return Object.values(tournaments)
    .filter((t) => (T.tournamentStatus(t) === "live" && t.players.includes(my)) || (T.tournamentStatus(t) === "open" && T.isSeated(t, my, now)))
    .sort((a, b) => b.createdAt - a.createdAt)[0] || null;
}

// ---------------------------------------------------------------------------------------------
// Fees
// ---------------------------------------------------------------------------------------------

/** An arena join is a fixed-size payload, so one estimate serves the whole session:
 *  "Join (Fee: 0.0017 KAS)" (iOS 3076f66 / 8e98503). */
async function estimateJoinFee() {
  if (joinFeeText || !deps.estimateFeeKas) return;
  try {
    const bytes = broadcastPayloadBytes(T.ARENA_CHANNEL, T.encodeMessage(T.messages.join("abcdefgh")));
    const fee = await deps.estimateFeeKas(bytes);
    if (fee == null) return;
    joinFeeText = `${Number(fee).toFixed(4)} KAS`;
    render();
  } catch { /* the label falls back to "Join" */ }
}
const joinLabel = () => (joinFeeText ? `Join (Fee: ${joinFeeText})` : "Join (one transaction)");

// ---------------------------------------------------------------------------------------------
// Actions (each one a broadcast transaction)
// ---------------------------------------------------------------------------------------------

/** One broadcast transaction, with the retries a fast sequence of sends needs: the change of the
 *  previous transaction is not spendable until it is mined, so a move sent within a second of
 *  the last one can hit "no spendable UTXO" - the same retry KaPosts threads use. */
async function send(message) {
  if (deps.isChattingBalanceZero?.()) { deps.showFundingGate?.(); return false; }
  const content = T.encodeMessage(message);
  let attempt = 0;
  for (;;) {
    try {
      const txid = await sendBroadcastMessage({ engine: deps.engine, channel: T.ARENA_CHANNEL, content, feeKas: "0" });
      // Applied at once with this device's clock; the chain's row replaces the time when it lands.
      rows.set(txid, { txId: txid, senderAddress: me(), content, blockTime: Date.now(), local: true });
      saveCache();
      reduceArena();
      lastError = "";
      return true;
    } catch (error) {
      attempt += 1;
      if (attempt > SEND_ATTEMPTS) {
        lastError = error?.message || String(error);
        deps.appendEngineLog?.(`Chess send failed after retries: ${lastError}`);
        deps.showToast?.(lastError);
        render();
        return false;
      }
      await new Promise((resolve) => window.setTimeout(resolve, SEND_RETRY_MS));
    }
  }
}

/** Joins the public room taking players now. The freshest shared view first - whatever the
 *  indexer holds this second is what every other device is choosing from - then the room. A
 *  seat that ran out is still in the player list until the next join drops it, so "already
 *  in" means seated NOW (iOS b552d7d). */
async function joinPublicRoom(duel) {
  const my = me();
  if (!my) return false;
  if (!historyReady) { deps.showToast?.("Still loading the rooms - try again in a moment."); return false; }
  await backfill();
  const id = duel ? currentDuelRoomId() : currentPublicRoomId();
  const busyIn = myActiveTournament();
  if (busyIn) {
    deps.showToast?.(T.tournamentStatus(busyIn) === "open" ? `You're already waiting in ${busyIn.name}.` : `You're still playing in ${busyIn.name}.`);
    return false;
  }
  const room = tournaments[id];
  if (room && T.isSeated(room, my, now)) { deps.showToast?.("You're already in this room."); return false; }
  queuedPublicRoomId = id;
  return send(T.messages.join(id));
}

async function createPrivate(duel) {
  const name = await promptDialog({
    title: duel ? "Create a private 1v1" : "Create a private tournament",
    message: duel
      ? "You get a code to share with the person you want to play. The game starts when they join. Creating it is one transaction."
      : "You take the first seat and get a code to share. It starts when eight players have joined. Creating it is one transaction.",
    label: "Name", initial: "", confirmLabel: duel ? "Create" : "Next", maxLength: T.NAME_MAX_LENGTH,
  });
  if (name === null || name === undefined) return;
  let message;
  const id = T.newPrivateId();
  const clean = String(name).trim();
  if (duel) message = T.messages.createDuel(id, clean || "1v1");
  else {
    const code = await promptDialog({ title: "Creator code", message: "Creating a private tournament needs the creator code.", label: "Creator code", initial: "", confirmLabel: "Create", maxLength: 64 });
    if (!code) return;
    if (T.createKey(code, "check") !== T.createKey(T.PRIVATE_CREATE_CODE, "check")) { deps.showToast?.("That creator code is not right."); return; }
    message = T.messages.create(id, clean || "Private tournament", code);
  }
  busy = true; render();
  const ok = await send(message);
  busy = false;
  // The creator holds the first seat: straight into the waiting room.
  if (ok) openWaitingRoom(id); else render();
}

async function joinPrivate() {
  const raw = await promptDialog({ title: "Join with a code", message: `The eight-character code the creator shared. Joining is one transaction${joinFeeText ? ` (fee: ${joinFeeText})` : ""}.`, label: "Code", initial: "", confirmLabel: "Join", maxLength: 64 });
  if (!raw) return;
  const id = String(raw).trim().toLowerCase();
  const t = tournaments[id];
  if (!t || T.isPublicId(id)) {
    alertDialog({ title: "No open tournament with that code", message: "Codes are eight characters; the tournament must exist and still have seats." });
    return;
  }
  if (T.tournamentStatus(t) !== "open") { deps.showToast?.("That tournament has already started."); return; }
  busy = true; render();
  const ok = await joinTournament(t);
  busy = false;
  if (ok) openWaitingRoom(id); else render();
}

async function joinTournament(t) {
  const my = me();
  if (!my || T.tournamentStatus(t) !== "open") return false;
  if (T.isSeated(t, my, now)) { deps.showToast?.("You're already in this room."); return false; }
  const busyIn = myActiveTournament();
  if (busyIn && busyIn.id !== t.id) {
    deps.showToast?.(T.tournamentStatus(busyIn) === "open" ? `You're already waiting in ${busyIn.name}.` : `You're still playing in ${busyIn.name}.`);
    return false;
  }
  return send(T.messages.join(t.id));
}

/** Gives the seat back while the room is still waiting (one transaction). Asks first. */
async function leaveTournament(t) {
  const my = me();
  if (!my || T.tournamentStatus(t) !== "open" || !T.isSeated(t, my, now)) return false;
  const ok = await confirmDialog({
    title: "Leave the queue?",
    message: "Leaving means you will no longer be searching for another player. Leaving is one transaction; you can join again any time.",
    confirmLabel: "Leave", destructive: true,
  });
  if (!ok) return false;
  queuedPublicRoomId = null;
  busy = true; render();
  const sent = await send(T.messages.leave(t.id));
  busy = false;
  render();
  return sent;
}

async function cancelTournament(t) {
  if (t.creator !== me() || T.tournamentStatus(t) !== "open") return;
  const ok = await confirmDialog({ title: "Cancel this tournament?", message: "Everyone who joined is released. This is one transaction.", confirmLabel: "Cancel tournament", destructive: true });
  if (ok) await send(T.messages.cancel(t.id));
}

/** Plays a move if it is ours to make and legal; the board shows it as pending until the chain
 *  returns it. */
async function play(t, game, mv) {
  const my = me();
  const key = keyOf(t.id, game.id);
  if (!my || T.playerToMove(game) !== my || game.winner || pendingMoveGames.has(key)) return;
  if (!Chess.isLegalMove(game.board, mv)) return;
  const normalized = Chess.normalizingPromotion(game.board, mv);
  pendingMoveGames.add(key);
  render();
  const sent = await send(T.messages.move(t.id, game.id, game.moves.length + 1, Chess.algebraic(normalized.from), Chess.algebraic(normalized.to), normalized.promotion ? Chess.promotionLetter(normalized.promotion) : null));
  if (!sent) { pendingMoveGames.delete(key); render(); }
}

/** Resign asks on a sheet that says what resigning means (iOS 30d0cca); behind the back button
 *  while the game is on, leaving means resigning (iOS 4152bf0). */
async function resign(t, game, { leaving = false } = {}) {
  const my = me();
  const myColor = T.colorOf(game, my);
  if (!myColor || game.winner) return false;
  const opponent = nameFor(T.addressOf(game, Chess.opposite(myColor)));
  const consequence = T.isDuel(t)
    ? `${opponent} wins, and it counts as a loss on the leaderboard. Resigning is one transaction.`
    : `${opponent} goes through and you are out of the tournament. It counts as a loss on the leaderboard. Resigning is one transaction.`;
  const ok = await confirmDialog({
    title: leaving ? "Leave the game?" : "Resign this game?",
    message: leaving ? `If you leave, you resign the game. ${consequence}` : consequence,
    confirmLabel: leaving ? "Resign and leave" : "Resign", destructive: true,
  });
  if (!ok) return false;
  await send(T.messages.resign(t.id, game.id));
  return true;
}

async function sendChat(t, gameId, text) {
  const clean = String(text || "").trim();
  if (!clean) return;
  await send(T.messages.chat(t.id, gameId, clean));
}

/** The opponent flagged in one of our games: post the claim (once). Runs on every tick. */
function claimTimeoutsIfDue() {
  const my = me();
  if (!my) return;
  for (const t of Object.values(tournaments)) {
    if (T.tournamentStatus(t) !== "live") continue;
    for (const game of Object.values(t.games)) {
      if (game.winner) continue;
      const mine = T.colorOf(game, my);
      if (!mine || game.board.sideToMove === mine) continue;
      const key = keyOf(t.id, game.id);
      if (claimedGames.has(key)) continue;
      // A second's margin past zero, so the claim's block time is safely after.
      if (T.remainingMs(game, game.board.sideToMove, now - 1_500) !== 0) continue;
      claimedGames.add(key);
      send(T.messages.claim(t.id, game.id)).catch(() => {});
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------------------------

function clockText(ms, { tenths = false } = {}) {
  const total = Math.max(0, Number(ms) || 0);
  const seconds = Math.floor(total / 1000);
  if (tenths && seconds < 10) return `0:${String(seconds).padStart(2, "0")}.${Math.floor((total % 1000) / 100)}`;
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
function roundName(game, t) {
  if (T.isDuel(t)) return "1v1";
  return game.round === 3 ? "Final" : game.round === 2 ? "Semifinal" : "Round 1";
}
function outcomeText(game, { short = false } = {}) {
  if (!game.winner || !game.outcome) return short ? "finished" : "";
  const who = nameFor(game.winner);
  switch (game.outcome.kind) {
    case "checkmate": return short ? `${who} won by checkmate` : `Checkmate. ${who} won.`;
    case "resignation": return short ? `${who} won by resignation` : `${who} won by resignation.`;
    case "timeout": return short ? `${who} won on time` : `${who} won on time.`;
    default: return short ? `${who} won on clock after a draw (${game.outcome.reason})` : `Draw by ${game.outcome.reason}. ${who} won on clock.`;
  }
}
const modeIsDuel = () => view.mode === "duel";
const modeTitle = () => (modeIsDuel() ? "1v1" : "Tournaments");

// ---------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------

const ICON_PEOPLE = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="8" r="3.2"/><path d="M3 19c.6-3.5 3-5.5 6-5.5s5.4 2 6 5.5"/><circle cx="17" cy="9" r="2.5"/><path d="M15.5 13.6c2.6.2 4.6 2 5.2 5.4"/></svg>`;
const ICON_TWO = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="8" cy="8" r="3.2"/><path d="M2.5 19c.6-3.5 2.7-5.5 5.5-5.5s4.9 2 5.5 5.5"/><circle cx="16.5" cy="9" r="2.6"/><path d="M14.8 13.7c2.8.1 4.9 2 5.5 5.3"/></svg>`;
const ICON_LOCK = `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>`;
const ICON_TROPHY = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4h10v5a5 5 0 0 1-10 0V4Z"/><path d="M7 6H4a3 3 0 0 0 3 4M17 6h3a3 3 0 0 1-3 4M12 14v3M8 20h8M9 17h6"/></svg>`;
const ICON_BACK = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10.5 19.5 3 12m0 0 7.5-7.5M3 12h18"/></svg>`;
const ICON_CHEVRON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>`;
const ICON_EYE = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>`;
const ICON_KEY = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M15 8l2 2M18 5l2 2"/></svg>`;
const ICON_PLUS = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/></svg>`;
const ICON_FLAG = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 21V4m0 0h11l-2 4 2 4H5"/></svg>`;
const ICON_CHESS = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 21h7M4.5 18.5h6M5 18.5V10M10 18.5V10M4 10h7l-1-2H5l-1 2ZM4.5 5v3h6V5M6.5 5v2M8.5 5v2"/><path d="M13 21h8M13.5 18.5h7M15 18.5c0-3 .5-5.5 2.5-7.5 1.2-1.2 2-2.2 2-3.5 0-1-.5-2-1.5-2.5L17 6l-1.5 1.5c-1 .5-1.7 1.6-1.7 2.8 0 .8.3 1.4.8 1.8l1.6-.3"/></svg>`;

function render() {
  if (!screenEl || !active) return;
  const y = screenEl.querySelector(".chess-t-body")?.scrollTop || 0;
  let html;
  switch (view.name) {
    case "waiting": html = renderWaitingRoom(); break;
    case "result": html = renderResult(); break;
    case "game": html = renderGame(); break;
    case "tournament": html = renderTournament(); break;
    case "kind": html = renderKind(); break;
    default: html = renderHome();
  }
  screenEl.innerHTML = html;
  const body = screenEl.querySelector(".chess-t-body");
  if (body) body.scrollTop = y;
  for (const [key, text] of Object.entries(drafts)) {
    const input = screenEl.querySelector(`[data-chess-t-chat-input="${key}"]`);
    if (input && !input.value) input.value = text;
  }
}

function headerHtml(title, { back = null, trailing = "" } = {}) {
  return `
    <div class="kaposts-header chess-t-header">
      ${back ? `<button class="kaposts-icon-button" type="button" data-chess-t-back aria-label="Back">${ICON_BACK}</button>` : ""}
      <h1 class="kaposts-title">${esc(title)}</h1>
      ${trailing}
    </div>`;
}

function rowHtml({ icon, title, subtitle, action = "", attrs = "", trailing = "" }) {
  return `
    <button class="chess-t-row" type="button" ${attrs}>
      <span class="chess-t-row-icon">${icon}</span>
      <span class="chess-t-row-main"><strong>${title}</strong>${subtitle ? `<small>${subtitle}</small>` : ""}</span>
      ${trailing}
      ${action ? `<span class="chess-t-row-action">${esc(action)}</span>` : ""}
      <span class="chess-t-row-chevron">${ICON_CHEVRON}</span>
    </button>`;
}
const errorHtml = () => (lastError ? `<p class="field-hint chess-t-error">${esc(lastError)}</p>` : "");

// --- Home: choose your game (iOS e86868e) ---

function renderHome() {
  const mine = myActiveTournament();
  const waiting = mine && T.tournamentStatus(mine) === "open";
  return `
    ${headerHtml("Chess Online")}
    <div class="chess-t-body chess-t-home">
      <div class="chess-t-hero">
        <span class="chess-t-hero-icon">${ICON_CHESS}</span>
        <h2>Choose your game</h2>
        <p>Five minutes a side. Every move is a Kaspa transaction, so every game is on chain for good.</p>
      </div>
      ${mine ? `
        <button class="chess-t-resume" type="button" data-chess-t-resume="${esc(mine.id)}">
          <span class="chess-t-row-icon">${waiting ? "⏳" : "▶"}</span>
          <span class="chess-t-row-main"><strong>${waiting ? "You're waiting in" : "You're playing in"} ${esc(mine.name)}</strong><small>Click to go back to it</small></span>
          <span class="chess-t-row-chevron">${ICON_CHEVRON}</span>
        </button>` : ""}
      <button class="chess-t-game-card" type="button" data-chess-t-mode="duel">
        <span class="chess-t-game-card-icon">${ICON_TWO}</span>
        <span class="chess-t-row-main"><strong>1v1</strong><small>Play the next person who joins, or a friend by code. One game, winner takes the leaderboard point.</small></span>
        <span class="chess-t-row-chevron">${ICON_CHEVRON}</span>
      </button>
      <button class="chess-t-game-card" type="button" data-chess-t-mode="tournament">
        <span class="chess-t-game-card-icon">${ICON_TROPHY}</span>
        <span class="chess-t-row-main"><strong>Tournament</strong><small>Eight players, single elimination: quarterfinals, semifinals, final. Public rooms fill as players arrive; private ones by code.</small></span>
        <span class="chess-t-row-chevron">${ICON_CHEVRON}</span>
      </button>
      ${errorHtml()}
    </div>`;
}

// --- One kind: play / Active / Finished / Leaderboard (iOS 3e366a4, 8afa81a, 01f1c12) ---

function renderKind() {
  const duel = modeIsDuel();
  const tabs = [["play", duel ? "1v1" : "Tournaments"], ["active", "Active"], ["finished", "Finished"], ["leaderboard", "Leaderboard"]];
  let body;
  if (view.tab === "active") body = renderActiveTab();
  else if (view.tab === "finished") body = renderFinishedTab();
  else if (view.tab === "leaderboard") body = renderLeaderboardRows();
  else body = renderPlayTab();
  return `
    ${headerHtml(modeTitle(), { back: true })}
    <nav class="chats-tab-bar chess-t-tabs" role="tablist">
      ${tabs.map(([id, label]) => `<button class="chats-tab-button${view.tab === id ? " active" : ""}" type="button" role="tab" aria-selected="${view.tab === id}" data-chess-t-tab="${id}"><span class="chats-tab-label-row"><span>${esc(label)}</span></span></button>`).join("")}
    </nav>
    <div class="chess-t-body">
      ${body}
      ${waitingNotice ? `<p class="field-hint chess-t-error">${esc(waitingNotice)}</p>` : ""}
      ${errorHtml()}
    </div>`;
}

/** The one public room taking players: its live seats, and Join - or where you already are. */
function publicRoomCardHtml() {
  const duel = modeIsDuel();
  const my = me();
  const id = duel ? currentDuelRoomId() : currentPublicRoomId();
  const room = tournaments[id] || null;
  const number = (duel ? T.duelNumber(id) : T.publicNumber(id)) || 1;
  const capacity = duel ? 2 : T.PLAYER_COUNT;
  const seated = room ? T.seatedPlayers(room, now) : [];
  const count = seated.length;
  const inThisRoom = Boolean(my && seated.includes(my));
  const mine = myActiveTournament();
  const busyElsewhere = Boolean(mine) && !inThisRoom;
  let cta;
  if (inThisRoom) cta = `<button class="secondary-button chess-t-cta" type="button" data-chess-t-waiting="${esc(id)}">You're in. Waiting for ${Math.max(0, capacity - count)} more…</button>`;
  else if (busyElsewhere) cta = `<button class="secondary-button chess-t-cta" type="button" data-chess-t-resume="${esc(mine.id)}">${T.tournamentStatus(mine) === "open" ? "You're waiting in" : "You're playing in"} ${esc(mine.name)}</button>`;
  else cta = `<button class="${historyReady ? "primary-button" : "secondary-button"} chess-t-cta" type="button" data-chess-t-join-public ${busy || !historyReady ? "disabled" : ""}>${busy ? "Joining…" : historyReady ? joinLabel() : "Loading rooms…"}</button>`;
  const seats = Array.from({ length: capacity }, (_, i) => `<span class="chess-t-seat${i < count ? " taken" : ""}"></span>`).join("");
  return `
    <div class="chess-t-card">
      <div class="chess-t-card-top">
        <span class="chess-t-row-icon">${duel ? ICON_TWO : ICON_PEOPLE}</span>
        <span class="chess-t-row-main"><strong>${duel ? `Public 1v1 #${number}` : `Public tournament #${number}`}</strong><small>${count} of ${capacity} players waiting</small></span>
      </div>
      <div class="chess-t-seats">${seats}</div>
      ${cta}
    </div>`;
}

function tournamentRowHtml(t, action) {
  const icon = T.tournamentStatus(t) === "finished" ? ICON_TROPHY : T.isPublicId(t.id) ? (T.isDuel(t) ? ICON_TWO : ICON_PEOPLE) : ICON_LOCK;
  return rowHtml({ icon, title: esc(t.name), subtitle: esc(`${t.players.length} of ${t.capacity} players${T.isPublicId(t.id) ? "" : ` · code ${t.id}`}`), action, attrs: `data-chess-t-open="${esc(t.id)}"` });
}

function renderPlayTab() {
  const duel = modeIsDuel();
  const privates = myPrivate(duel);
  return `
    <p class="screen-kicker">Public</p>
    ${publicRoomCardHtml()}
    <p class="field-hint">${duel
      ? "Join and you are paired with the next person who joins. When a room fills, the game starts and the next room opens. Five minutes a side; every move is a Kaspa transaction (about 0.0017 KAS each). Games here count on the leaderboard."
      : "There is always a public room waiting for players. When it fills, it starts and the next one opens. Eight players, single elimination, five minutes a side. Every move is a Kaspa transaction (about 0.0017 KAS each)."}</p>
    <p class="screen-kicker">Private</p>
    <div class="chess-t-list">
      ${privates.map((t) => tournamentRowHtml(t, T.tournamentStatus(t) === "open" ? (duel ? "Waiting" : `${T.seatsLeft(t)} seat${T.seatsLeft(t) === 1 ? "" : "s"} left`) : "In play")).join("")}
      ${rowHtml({ icon: ICON_KEY, title: "Join with a code", subtitle: "The eight-character code a friend shared.", attrs: "data-chess-t-join-private" })}
      ${rowHtml({ icon: ICON_PLUS, title: duel ? "Create a private 1v1" : "Create a private tournament", subtitle: duel ? "Share its code with the person you want to play." : "Needs the creator code.", attrs: "data-chess-t-create" })}
    </div>
    <p class="field-hint">${duel
      ? "Play a friend: create a 1v1, share its code. Private 1v1s count on the leaderboard too."
      : "A private tournament is for friends: the creator shares its eight-character code. Creating one needs the creator code."}</p>`;
}

function gameNamesHtml(game, { bold = true } = {}) {
  const w = `<span class="${bold && game.winner === game.white ? "won" : ""}">${esc(nameFor(game.white))}</span>`;
  const b = `<span class="${bold && game.winner === game.black ? "won" : ""}">${esc(nameFor(game.black))}</span>`;
  return `${w} <em>vs</em> ${b}`;
}

function liveGameRowHtml(game, t) {
  return rowHtml({
    icon: ICON_EYE,
    title: gameNamesHtml(game, { bold: false }),
    subtitle: esc(`${T.isDuel(t) ? t.name : roundName(game, t)} · move ${Math.floor(game.moves.length / 2) + 1} · ${game.board.sideToMove} to move`),
    trailing: `<span class="chess-t-row-action mono" data-chess-t-clock-for="${esc(keyOf(t.id, game.id))}">${clockText(T.remainingMs(game, game.board.sideToMove, now))}</span>`,
    action: "Watch",
    attrs: `data-chess-t-watch="${esc(keyOf(t.id, game.id))}"`,
  });
}

/** Every public game of this kind being played right now, for anyone to watch. */
function renderActiveTab() {
  const duel = modeIsDuel();
  const live = liveTournaments().filter((t) => T.isDuel(t) === duel && T.isPublicId(t.id));
  if (!live.length) {
    return `<p class="screen-kicker">Live now</p><p class="field-hint">${duel
      ? "No 1v1 games are being played right now. When one starts, it shows up here to watch."
      : "No tournament is being played right now. When one starts, its games show up here to watch."}</p>`;
  }
  if (duel) {
    return `<p class="screen-kicker">Live now</p><div class="chess-t-list">${live.map((t) => { const g = Object.values(t.games)[0]; return g ? liveGameRowHtml(g, t) : ""; }).join("")}</div>
      <p class="field-hint">Watching is free - nothing is sent. Only the two players can move or chat.</p>`;
  }
  return live.map((t) => {
    const games = Object.values(t.games).filter((g) => !g.winner).sort((a, b) => a.round - b.round || a.index - b.index);
    return `<p class="screen-kicker">${esc(t.name)}</p><div class="chess-t-list">${games.map((g) => liveGameRowHtml(g, t)).join("")}${tournamentRowHtml(t, "Bracket")}</div>`;
  }).join("");
}

function finishedGameRowHtml(game, t) {
  return rowHtml({
    icon: ICON_TROPHY,
    title: gameNamesHtml(game),
    subtitle: esc(`${T.isDuel(t) ? t.name : roundName(game, t)} · ${outcomeText(game, { short: true })}`),
    attrs: `data-chess-t-watch="${esc(keyOf(t.id, game.id))}"`,
  });
}

/** Every public game of this kind that has ended, newest first - straight to the board as it
 *  ended (iOS 01af8bc). */
function renderFinishedTab() {
  const duel = modeIsDuel();
  const done = finishedTournaments().filter((t) => T.isDuel(t) === duel && T.isPublicId(t.id)).slice(0, 100);
  if (!done.length) return `<p class="screen-kicker">${duel ? "Finished 1v1 games" : "Finished tournaments"}</p><p class="field-hint">${duel ? "No finished 1v1 games yet." : "No finished tournaments yet."}</p>`;
  if (duel) return `<p class="screen-kicker">Finished 1v1 games</p><div class="chess-t-list">${done.map((t) => { const g = Object.values(t.games)[0]; return g ? finishedGameRowHtml(g, t) : ""; }).join("")}</div>`;
  return done.map((t) => {
    const games = Object.values(t.games).sort((a, b) => b.round - a.round || b.index - a.index);
    const champ = T.champion(t);
    return `<p class="screen-kicker">${esc(t.name)}${champ ? ` · won by ${esc(nameFor(champ))}` : ""}</p><div class="chess-t-list">${games.map((g) => finishedGameRowHtml(g, t)).join("")}</div>`;
  }).join("");
}

/** One kind's leaderboard (iOS 784208f). */
function renderLeaderboardRows() {
  const duel = modeIsDuel();
  const board = duel ? T.duelLeaderboard(leaderboardRows) : T.tournamentLeaderboard(leaderboardRows);
  const my = me();
  return `
    <p class="screen-kicker">${duel ? "1v1 leaderboard · most wins, fewest losses" : "Tournament leaderboard · most tournaments won"}</p>
    ${board.length ? "" : `<p class="field-hint">${duel ? "No finished 1v1 games yet." : "No finished tournaments yet."}</p>`}
    <div class="chess-t-list">
      ${board.map((r, i) => `
        <div class="chess-t-row static${r.address === my ? " me" : ""}">
          <span class="chess-t-rank">${i + 1}</span>
          ${avatarFor(r.address)}
          <span class="chess-t-row-main"><strong>${esc(nameFor(r.address))}</strong></span>
          ${duel
            ? `<span class="chess-t-wl"><b class="w">${r.duelWins} W</b><b class="l">${r.duelLosses} L</b></span>`
            : `<span class="chess-t-wl stacked"><span class="chess-t-titles">${ICON_TROPHY}${r.tournamentsWon}</span><span><b class="w">${r.tournamentGameWins} W</b> <b class="l">${r.tournamentGameLosses} L</b></span></span>`}
        </div>`).join("")}
    </div>`;
}

// --- Waiting room (iOS 64aca7c) ---

function renderWaitingRoom() {
  const t = tournaments[view.tournamentId];
  const my = me();
  if (!t) return `${headerHtml("Waiting", { back: true })}<div class="chess-t-body"><p class="field-hint">Loading the room from the arena…</p></div>`;
  const duel = T.isDuel(t);
  let shown = T.seatedPlayers(t, now);
  if (my) shown = [my, ...shown.filter((p) => p !== my)];
  const empties = Math.max(0, t.capacity - shown.length);
  const expiry = my ? T.seatExpiry(t, my) : null;
  const left = Math.max(0, Math.floor(((expiry ?? now) - now) / 1000));
  return `
    ${headerHtml(duel ? "Looking for an opponent" : "Waiting for players")}
    <div class="chess-t-body chess-t-waiting">
      <div class="chess-t-seat-grid${duel ? " two" : ""}">
        ${shown.map((address) => `<div class="chess-t-seat-card">${avatarFor(address, "chess-t-avatar big")}<span>${esc(nameFor(address))}</span></div>`).join("")}
        ${Array.from({ length: empties }, () => `<div class="chess-t-seat-card empty"><span class="chess-t-seat-empty">?</span><span>Waiting</span></div>`).join("")}
      </div>
      <div class="chess-t-countdown${left < 30 ? " low" : ""}" data-chess-t-countdown>${clockText(left * 1000)}</div>
      <p class="field-hint center">Your seat is held this long. If no one joins in time, you leave the queue.</p>
      ${T.isPublicId(t.id) ? "" : `
        <div class="chess-t-share">
          <small>Share this code</small>
          <div><b>${esc(t.id)}</b><button class="secondary-button" type="button" data-chess-t-copy="${esc(t.id)}">Copy</button></div>
        </div>`}
      <p class="field-hint center">${duel ? "You're paired with the next person who joins. The game starts by itself." : "The tournament starts by itself when all eight seats are taken."}</p>
      <button class="secondary-button chess-t-cta danger" type="button" data-chess-t-leave="${esc(t.id)}" ${busy ? "disabled" : ""}>${busy ? "Leaving…" : "Leave"}</button>
      ${errorHtml()}
    </div>`;
}

/** Filled, or the seat ran out: hand the screen over. Runs on every tick while waiting. */
function checkWaitingRoom() {
  if (view.name !== "waiting") return;
  const t = tournaments[view.tournamentId];
  const my = me();
  if (!t || !my) return;
  const status = T.tournamentStatus(t);
  if (status === "live" || status === "finished") {
    openTournament(t.id);
  } else if (status === "cancelled" || !T.isSeated(t, my, now)) {
    waitingNotice = status === "cancelled" ? "" : "No one joined in time. You're out of the queue - join again whenever you like.";
    view = { ...view, name: "kind", tournamentId: null, gameId: null };
    render();
  }
}

// --- Tournament: seats or bracket (no lobby chat; iOS cd6aed5) ---

function renderTournament() {
  const t = tournaments[view.tournamentId];
  if (!t) return `${headerHtml("Tournament", { back: true })}<div class="chess-t-body"><p class="field-hint">Loading the tournament from the arena…</p></div>`;
  const my = me();
  const status = T.tournamentStatus(t);
  const duel = T.isDuel(t);
  let statusHtml = "";
  if (status === "open") {
    const left = T.seatsLeft(t);
    statusHtml += `<p class="chess-t-status">${duel ? "Waiting for your opponent. The game starts by itself when they join." : `Waiting for ${left} more player${left === 1 ? "" : "s"}. It starts by itself when the eighth joins.`}</p>`;
    if (my && !T.isSeated(t, my, now)) statusHtml += `<button class="primary-button chess-t-cta" type="button" data-chess-t-join="${esc(t.id)}" ${busy ? "disabled" : ""}>${busy ? "Joining…" : joinLabel()}</button>`;
    else if (my) statusHtml += `<button class="secondary-button chess-t-cta danger" type="button" data-chess-t-leave="${esc(t.id)}" ${busy ? "disabled" : ""}>${busy ? "Leaving…" : "Leave (one transaction)"}</button>`;
    if (t.creator === my && !T.isPublicId(t.id)) statusHtml += `<button class="secondary-button chess-t-cta danger" type="button" data-chess-t-cancel="${esc(t.id)}">Cancel tournament</button>`;
    if (!T.isPublicId(t.id)) statusHtml += `<div class="chess-t-code"><span>Code: <b>${esc(t.id)}</b></span><button class="secondary-button" type="button" data-chess-t-copy="${esc(t.id)}">Copy</button></div>`;
  } else if (status === "live") {
    const game = my ? T.currentGameFor(t, my) : null;
    if (game) {
      if (game.winner) statusHtml += `<p class="chess-t-status">${game.winner === my ? `You won ${duel ? "the game" : roundName(game, t).toLowerCase()}. Waiting for your next opponent - watch the other game meanwhile.` : "You are out of this tournament. Watch the rest of the bracket."}</p>`;
      else statusHtml += `<button class="primary-button chess-t-cta" type="button" data-chess-t-game="${esc(game.id)}">Go to your game</button>`;
    } else statusHtml += `<p class="chess-t-status">In play. Open any game to watch it live.</p>`;
  } else if (status === "finished") {
    const champ = T.champion(t);
    if (champ) statusHtml += `<p class="chess-t-status chess-t-champion">${ICON_TROPHY} ${esc(nameFor(champ))} won${duel ? "" : " the tournament"}</p>`;
  } else statusHtml += `<p class="chess-t-status">Cancelled by the creator.</p>`;

  let bracketHtml = "";
  if (status === "open") {
    const seated = T.seatedPlayers(t, now);
    bracketHtml = `<p class="screen-kicker">Players (${seated.length} of ${t.capacity})</p><div class="chess-t-list">
      ${seated.map((address, i) => `<div class="chess-t-row static">${avatarFor(address)}<span class="chess-t-row-main"><strong>${esc(nameFor(address))}</strong></span><span class="chess-t-row-action muted">Seed ${i + 1}</span></div>`).join("")}
      ${Array.from({ length: Math.max(0, t.capacity - seated.length) }, () => `<div class="chess-t-row static"><span class="chess-t-open-seat"></span><span class="chess-t-row-main muted">Open seat</span></div>`).join("")}
    </div>`;
  } else if (status !== "cancelled") {
    for (let round = 1; round <= T.roundsOf(t); round += 1) {
      const games = T.gamesInRound(t, round);
      if (!games.length) continue;
      bracketHtml += `<p class="screen-kicker">${duel ? "Game" : round === 3 ? "Final" : round === 2 ? "Semifinals" : "Round 1"}</p><div class="chess-t-list">${games.map((game) => rowHtml({
        icon: game.winner ? ICON_TROPHY : ICON_EYE,
        title: gameNamesHtml(game),
        subtitle: esc(game.winner ? outcomeText(game, { short: true }) : `Move ${Math.floor(game.moves.length / 2) + 1} · ${game.board.sideToMove} to move`),
        trailing: game.winner ? "" : `<span class="chess-t-row-action mono" data-chess-t-clock-for="${esc(keyOf(t.id, game.id))}">${clockText(T.remainingMs(game, game.board.sideToMove, now))}</span>`,
        attrs: `data-chess-t-game="${esc(game.id)}"`,
      })).join("")}</div>`;
    }
  }
  return `
    ${headerHtml(t.name, { back: true })}
    <div class="chess-t-body">
      <div class="chess-t-card">${statusHtml}</div>
      ${bracketHtml}
      ${errorHtml()}
    </div>`;
}

// --- Game: board, clocks, chat beneath (iOS b27b4c8, 759a2d3, 4152bf0, 01af8bc) ---

function isLockedIn() {
  const t = tournaments[view.tournamentId];
  const game = t?.games[view.gameId];
  return Boolean(game && !game.winner && T.colorOf(game, me()));
}

function renderGame() {
  const t = tournaments[view.tournamentId];
  const game = t?.games[view.gameId];
  if (!t || !game) return `${headerHtml("Game", { back: true })}<div class="chess-t-body"><p class="field-hint">Loading…</p></div>`;
  const my = me();
  const myColor = my ? T.colorOf(game, my) : null;
  const pendingKey = keyOf(t.id, game.id);
  const isMyTurn = Boolean(myColor) && !game.winner && game.board.sideToMove === myColor && !pendingMoveGames.has(pendingKey);
  const flipped = myColor === Chess.BLACK;
  const locked = Boolean(myColor) && !game.winner;

  const clockChip = (color) => {
    const address = T.addressOf(game, color);
    const remaining = T.remainingMs(game, color, now);
    const running = !game.winner && game.board.sideToMove === color;
    const label = !myColor ? (color === Chess.WHITE ? "White" : "Black") : (color === myColor ? "You" : "Them");
    return `
      <div class="chess-t-chip${running ? " running" : ""}${running && remaining < 20_000 ? " low" : ""}" data-chess-t-chip="${color}">
        ${avatarFor(address, "chess-t-avatar small")}
        <strong>${esc(nameFor(address))}</strong>
        <span class="chess-t-chip-clock"><small>${label}</small><b data-chess-t-clock="${color}">${clockText(remaining, { tenths: true })}</b></span>
      </div>`;
  };

  const legal = isMyTurn && selectedSquare ? Chess.legalMovesFrom(game.board, selectedSquare).map((m) => m.to) : [];
  const legalKeys = new Set(legal.map((s) => `${s.file},${s.rank}`));
  const last = game.moves.at(-1);
  const ranks = flipped ? [0, 1, 2, 3, 4, 5, 6, 7] : [7, 6, 5, 4, 3, 2, 1, 0];
  const files = flipped ? [7, 6, 5, 4, 3, 2, 1, 0] : [0, 1, 2, 3, 4, 5, 6, 7];
  let board = "";
  for (const rank of ranks) {
    for (const file of files) {
      const classes = ["chess-sq", (file + rank) % 2 !== 0 ? "light" : "dark"];
      if (selectedSquare && selectedSquare.file === file && selectedSquare.rank === rank) classes.push("selected");
      if (last && ((last.from.file === file && last.from.rank === rank) || (last.to.file === file && last.to.rank === rank))) classes.push("last");
      const piece = game.board.squares[rank][file];
      board += `<div class="${classes.join(" ")}" data-chess-t-sq="${file},${rank}">${piece ? `<span class="chess-piece ${piece.color}">${Chess.PIECE_GLYPHS[piece.type]}</span>` : ""}${legalKeys.has(`${file},${rank}`) ? `<span class="chess-dot${piece ? " capture" : ""}"></span>` : ""}</div>`;
    }
  }
  const waitingOverlay = myColor && !game.winner && game.board.sideToMove !== myColor
    ? `<div class="chess-waiting"><span>Waiting on opponent…</span></div>` : "";
  let endOverlay = "";
  if (endOverlayFor === pendingKey && game.winner) {
    const iWon = myColor ? game.winner === my : null;
    const headline = iWon === true ? "You won!" : iWon === false ? "You lost" : `${nameFor(game.winner)} won`;
    const detail = game.outcome?.kind === "checkmate" ? "Checkmate" : game.outcome?.kind === "resignation" ? "By resignation" : game.outcome?.kind === "timeout" ? "On time" : `Draw by ${game.outcome?.reason} - won on clock`;
    endOverlay = `
      <div class="chess-t-end${iWon === true ? " won" : iWon === false ? " lost" : ""}">
        ${iWon === true ? Array.from({ length: 18 }, (_, i) => `<span class="chess-t-spark" style="--a:${(i / 18) * 360}deg">${["✨", "🎉", "⭐", "🎊", "💫"][i % 5]}</span>`).join("") : ""}
        <div class="chess-t-end-card"><span class="chess-t-end-icon">${iWon === true ? ICON_TROPHY : iWon === false ? ICON_FLAG : "✓"}</span><strong>${esc(headline)}</strong><small>${esc(detail)}</small></div>
      </div>`;
  }
  const promo = pendingPromotion ? `
    <div class="chess-promo">
      <div class="chess-promo-card"><p>Promote to</p><div class="chess-promo-options">
        ${["queen", "rook", "bishop", "knight"].map((type) => `<button type="button" class="${myColor || "white"}" data-chess-t-promo="${type}">${Chess.PIECE_GLYPHS[type]}</button>`).join("")}
      </div></div>
    </div>` : "";

  const lines = t.chat.filter((l) => l.game === game.id).slice(-80);
  const chat = game.winner
    ? `<p class="field-hint center">Chat was live only.</p>`
    : `<div class="chess-t-chat bubbles">
        ${lines.length ? lines.map((l) => `<div class="chess-t-bubble${l.sender === my ? " mine" : ""}">${l.sender === my ? "" : `<small>${esc(nameFor(l.sender))}</small>`}<span>${esc(l.text)}</span>${l.sender === my ? `<i class="chess-t-tick${rows.get(l.id)?.local ? " pending" : ""}" aria-hidden="true"></i>` : ""}</div>`).join("") : `<p class="field-hint">No messages yet.</p>`}
      </div>
      ${myColor ? `
      <form class="chess-t-composer" data-chess-t-chat="${esc(game.id)}">
        <input class="kaposts-reply-input" type="text" data-chess-t-chat-input="${esc(game.id)}" placeholder="Message (one transaction)" maxlength="${T.CHAT_MAX_LENGTH}" autocomplete="off" />
        <button class="primary-button" type="submit">Send</button>
      </form>` : ""}`;

  return `
    ${headerHtml(roundName(game, t), {
      back: true,
      trailing: locked ? `<button class="chess-t-resign" type="button" data-chess-t-resign>Resign</button>` : "",
    })}
    <div class="chess-t-body chess-t-game">
      <div class="chess-t-game-head">
        <strong>${myColor ? esc(nameFor(T.addressOf(game, Chess.opposite(myColor)))) : `${esc(nameFor(game.white))} vs ${esc(nameFor(game.black))}`}</strong>
        <span class="chess-t-status center${game.winner ? " muted" : ""}" data-chess-t-status>${esc(gameStatusText(t, game))}</span>
      </div>
      ${clockChip(flipped ? Chess.WHITE : Chess.BLACK)}
      <div class="chess-board-wrap"><div class="chess-board chess-t-board">${board}</div>${waitingOverlay}${endOverlay}${promo}</div>
      ${clockChip(flipped ? Chess.BLACK : Chess.WHITE)}
      ${chat}
      ${errorHtml()}
    </div>`;
}

function gameStatusText(t, game) {
  const my = me();
  const myColor = my ? T.colorOf(game, my) : null;
  if (game.winner) return outcomeText(game);
  if (pendingMoveGames.has(keyOf(t.id, game.id))) return "Sending your move…";
  // A side's first move has 25 seconds before its clock runs; say so.
  let grace = "";
  if (game.moves.length < 2) {
    const left = T.allowanceLeftMs(game, now);
    if (left > 0) grace = ` · clock starts in ${clockText(left)}`;
  }
  if (myColor) {
    if (game.board.sideToMove !== myColor && T.remainingMs(game, game.board.sideToMove, now) === 0) return "They ran out of time. Claiming the win…";
    if (game.board.sideToMove === myColor && Chess.isKingInCheck(game.board, myColor)) return `Check. Your move.${grace}`;
    return `${game.board.sideToMove === myColor ? "Your move" : "Their move"}${grace}`;
  }
  return `${game.board.sideToMove === Chess.WHITE ? "White to move" : "Black to move"}${grace}`;
}

// --- Result screen (iOS 759a2d3, af865b4) ---

function rememberRecord() {
  if (view.name !== "game" && view.name !== "result") return;
  const t = tournaments[view.tournamentId];
  const game = t?.games[view.gameId];
  const my = me();
  if (!t || !game || !my || game.winner) return;
  recordBeforeEnd = leaderboardRows.find((r) => r.address === my) || { address: my, duelWins: 0, duelLosses: 0, tournamentGameWins: 0, tournamentGameLosses: 0 };
}

/** The game just ended: the burst over the board for a couple of seconds, then - for the two
 *  players, not for someone watching - the result screen with the record. */
function gameEndedIfNeeded() {
  if (view.name !== "game") return;
  const t = tournaments[view.tournamentId];
  const game = t?.games[view.gameId];
  if (!t || !game || !game.winner) return;
  const key = keyOf(t.id, game.id);
  if (endHandledFor === key) return;
  endHandledFor = key;
  // Opened on a game that was already over (watching a finished board): nothing to show.
  if ((game.endedAt || 0) <= now - 60_000) return;
  endOverlayFor = key;
  render();
  window.setTimeout(() => {
    if (endOverlayFor !== key) return;
    endOverlayFor = null;
    if (view.name === "game" && view.tournamentId === t.id && view.gameId === game.id && T.colorOf(game, me())) {
      view = { ...view, name: "result" };
      resultRevealed = false;
      window.clearTimeout(resultRevealTimer);
      resultRevealTimer = window.setTimeout(() => { resultRevealed = true; render(); }, 500);
    }
    render();
  }, END_OVERLAY_MS);
}

function renderResult() {
  const t = tournaments[view.tournamentId];
  const game = t?.games[view.gameId];
  const my = me();
  if (!t || !game) return `${headerHtml("Result")}<div class="chess-t-body"><button class="primary-button chess-t-cta" type="button" data-chess-t-done>Done</button></div>`;
  const duel = T.isDuel(t);
  const board = duel ? T.duelLeaderboard(leaderboardRows) : T.tournamentLeaderboard(leaderboardRows);
  const mine = board.find((r) => r.address === my) || null;
  const rank = board.findIndex((r) => r.address === my);
  const iWon = game.winner === my;
  const wins = (r) => (duel ? r?.duelWins || 0 : r?.tournamentGameWins || 0);
  const losses = (r) => (duel ? r?.duelLosses || 0 : r?.tournamentGameLosses || 0);
  const shownRow = resultRevealed ? mine : recordBeforeEnd;
  const w = wins(shownRow), l = losses(shownRow);
  const rate = w + l === 0 ? "-" : `${Math.round((w / (w + l)) * 100)}%`;
  const stat = (label, value, delta, cls) => `<div class="chess-t-stat"><b class="${cls}">${value}</b><small>${label}</small><i class="${cls}">${delta > 0 ? `+${delta}` : ""}</i></div>`;
  const note = duel ? "" : `<p class="chess-t-status center">${iWon
    ? (T.tournamentStatus(t) === "finished" ? "You won the tournament." : "You go through to the next round. Your next game opens by itself when your opponent is decided.")
    : "You are out of this tournament. You can watch the rest of the bracket."}</p>`;
  return `
    ${headerHtml(duel ? "1v1" : "Tournament", { trailing: `<button class="secondary-button" type="button" data-chess-t-done>Done</button>` })}
    <div class="chess-t-body chess-t-result">
      <div class="chess-t-hero">
        <span class="chess-t-hero-icon ${iWon ? "won" : "lost"}">${iWon ? ICON_TROPHY : ICON_FLAG}</span>
        <h2>${iWon ? "Victory" : "Defeat"}</h2>
        <p>${esc(outcomeText(game))}</p>
      </div>
      <div class="chess-t-card">
        <p class="screen-kicker">${duel ? "Your 1v1 record" : "Your tournament record"}</p>
        <div class="chess-t-stats">
          ${stat("Wins", w, iWon ? 1 : 0, "w")}
          <div class="chess-t-stat"><b>${rate}</b><small>Win rate</small><i></i></div>
          ${stat("Losses", l, iWon ? 0 : 1, "l")}
        </div>
        ${rank >= 0 ? `<p class="field-hint center">#${rank + 1} on the ${duel ? "1v1" : "tournament"} board</p>` : ""}
      </div>
      ${note}
      <p class="screen-kicker">${duel ? "1v1 leaderboard" : "Tournament leaderboard"}</p>
      <div class="chess-t-list">
        ${board.slice(0, 5).map((r, i) => `
          <div class="chess-t-row static${r.address === my ? " me" : ""}">
            <span class="chess-t-rank">${i + 1}</span>
            ${avatarFor(r.address)}
            <span class="chess-t-row-main"><strong>${esc(nameFor(r.address))}</strong></span>
            ${duel
              ? `<span class="chess-t-wl"><b class="w">${r.duelWins} W</b><b class="l">${r.duelLosses} L</b></span>`
              : `<span class="chess-t-wl stacked"><span class="chess-t-titles">${ICON_TROPHY}${r.tournamentsWon}</span><span><b class="w">${r.tournamentGameWins} W</b> <b class="l">${r.tournamentGameLosses} L</b></span></span>`}
          </div>`).join("")}
      </div>
    </div>`;
}

// ---------------------------------------------------------------------------------------------
// Navigation and events
// ---------------------------------------------------------------------------------------------

function openKind(mode) {
  view = { name: "kind", mode, tab: "play", tournamentId: null, gameId: null };
  waitingNotice = "";
  render();
  showWaitingRoomIfSeated();
}
function openWaitingRoom(id) {
  view = { ...view, name: "waiting", tournamentId: id, gameId: null };
  waitingNotice = "";
  render();
  checkWaitingRoom();
}
/** Back on the kind screen with a live seat (a reload, a click on the room card): the waiting
 *  room is the only place to be. */
function showWaitingRoomIfSeated() {
  if (view.name !== "kind") return;
  const mine = myActiveTournament();
  if (mine && T.tournamentStatus(mine) === "open" && T.isSeated(mine, me(), now)) openWaitingRoom(mine.id);
}
function openTournament(id) {
  const t = tournaments[id];
  view = { ...view, name: "tournament", mode: t ? (T.isDuel(t) ? "duel" : "tournament") : view.mode, tournamentId: id, gameId: null };
  autoOpenedGameId = null;
  render();
  autoOpenMyGameIfNeeded();
}
function openGame(tid, gameId) {
  view = { ...view, name: "game", tournamentId: tid, gameId };
  selectedSquare = null;
  pendingPromotion = null;
  endHandledFor = null;
  recordBeforeEnd = null;
  rememberRecord();
  render();
  // Opened on a finished board: mark it handled so no burst plays.
  gameEndedIfNeeded();
}
function resumeTournament(id) {
  const t = tournaments[id];
  if (!t) return;
  if (T.tournamentStatus(t) === "open") openWaitingRoom(id); else openTournament(id);
}
function goBack() {
  if (view.name === "game") {
    const t = tournaments[view.tournamentId];
    // A finished 1v1 opened straight from Finished / Active: back to the kind screen.
    view = { ...view, name: t && T.isDuel(t) && T.isPublicId(t.id) ? "kind" : "tournament", gameId: null };
  } else if (view.name === "tournament" || view.name === "result") view = { ...view, name: "kind", tournamentId: null, gameId: null };
  else view = { ...view, name: "home", tournamentId: null, gameId: null };
  selectedSquare = null;
  pendingPromotion = null;
  render();
}

/** The player's game came into being: open it (once per game). */
function autoOpenMyGameIfNeeded() {
  if (!active || !["tournament", "game", "waiting"].includes(view.name)) return;
  const t = tournaments[view.tournamentId];
  const my = me();
  if (!t || !my) return;
  const game = T.currentGameFor(t, my);
  if (!game || game.winner || autoOpenedGameId === game.id) return;
  autoOpenedGameId = game.id;
  openGame(t.id, game.id);
}

function tapSquare(file, rank) {
  const t = tournaments[view.tournamentId];
  const game = t?.games[view.gameId];
  if (!t || !game) return;
  const my = me();
  const myColor = T.colorOf(game, my);
  const isMyTurn = Boolean(myColor) && !game.winner && game.board.sideToMove === myColor && !pendingMoveGames.has(keyOf(t.id, game.id));
  if (!isMyTurn) return;
  const square = { file, rank };
  const piece = Chess.pieceAt(game.board, square);
  if (selectedSquare) {
    const legal = Chess.legalMovesFrom(game.board, selectedSquare).some((m) => Chess.squareEquals(m.to, square));
    if (legal) {
      const from = selectedSquare;
      const moving = Chess.pieceAt(game.board, from);
      selectedSquare = null;
      if (moving?.type === "pawn" && rank === (myColor === Chess.WHITE ? 7 : 0)) {
        pendingPromotion = { from, to: square };
        render();
      } else {
        play(t, game, { from, to: square, promotion: null }).catch(() => {});
      }
      return;
    }
    selectedSquare = piece?.color === myColor ? square : null;
    render();
    return;
  }
  if (piece?.color === myColor) { selectedSquare = square; render(); }
}

function onClick(event) {
  const withBusy = (task) => { if (busy) return; busy = true; render(); task().catch(() => {}).finally(() => { busy = false; render(); }); };
  if (event.target.closest("[data-chess-t-back]")) {
    // While a player's game is on, leaving means resigning - and it asks.
    if (view.name === "game" && isLockedIn()) {
      const t = tournaments[view.tournamentId];
      const g = t?.games[view.gameId];
      resign(t, g, { leaving: true }).then((ok) => { if (ok) goBack(); }).catch(() => {});
      return;
    }
    goBack();
    return;
  }
  if (event.target.closest("[data-chess-t-done]")) { view = { ...view, name: "kind", tournamentId: null, gameId: null }; render(); return; }
  const mode = event.target.closest("[data-chess-t-mode]");
  if (mode) { openKind(mode.dataset.chessTMode); return; }
  const tab = event.target.closest("[data-chess-t-tab]");
  if (tab) { view = { ...view, tab: tab.dataset.chessTTab }; render(); return; }
  const resume = event.target.closest("[data-chess-t-resume]");
  if (resume) { const t = tournaments[resume.dataset.chessTResume]; if (t) { view.mode = T.isDuel(t) ? "duel" : "tournament"; resumeTournament(t.id); } return; }
  const waiting = event.target.closest("[data-chess-t-waiting]");
  if (waiting) { openWaitingRoom(waiting.dataset.chessTWaiting); return; }
  const open = event.target.closest("[data-chess-t-open]");
  if (open) { openTournament(open.dataset.chessTOpen); return; }
  const watch = event.target.closest("[data-chess-t-watch]");
  if (watch) { const [tid, gid] = watch.dataset.chessTWatch.split("|"); openGame(tid, gid); return; }
  const game = event.target.closest("[data-chess-t-game]");
  if (game) { openGame(view.tournamentId, game.dataset.chessTGame); return; }
  if (event.target.closest("[data-chess-t-join-public]")) {
    withBusy(async () => { await joinPublicRoom(modeIsDuel()); showWaitingRoomIfSeated(); });
    return;
  }
  if (event.target.closest("[data-chess-t-join-private]")) { joinPrivate().catch(() => {}); return; }
  if (event.target.closest("[data-chess-t-create]")) { createPrivate(modeIsDuel()).catch(() => {}); return; }
  const join = event.target.closest("[data-chess-t-join]");
  if (join) {
    const t = tournaments[join.dataset.chessTJoin];
    if (t) withBusy(async () => { if (await joinTournament(t)) openWaitingRoom(t.id); });
    return;
  }
  const leave = event.target.closest("[data-chess-t-leave]");
  if (leave) {
    const t = tournaments[leave.dataset.chessTLeave];
    if (t) leaveTournament(t).then((ok) => { if (ok && view.name === "waiting") { view = { ...view, name: "kind", tournamentId: null, gameId: null }; render(); } }).catch(() => {});
    return;
  }
  const cancel = event.target.closest("[data-chess-t-cancel]");
  if (cancel) { const t = tournaments[cancel.dataset.chessTCancel]; if (t) cancelTournament(t).catch(() => {}); return; }
  const copy = event.target.closest("[data-chess-t-copy]");
  if (copy) {
    navigator.clipboard?.writeText(copy.dataset.chessTCopy).then(() => deps.showToast?.("Code copied"), () => {});
    return;
  }
  if (event.target.closest("[data-chess-t-resign]")) {
    const t = tournaments[view.tournamentId];
    const g = t?.games[view.gameId];
    if (t && g) resign(t, g).catch(() => {});
    return;
  }
  const promo = event.target.closest("[data-chess-t-promo]");
  if (promo) {
    const t = tournaments[view.tournamentId];
    const g = t?.games[view.gameId];
    const mv = pendingPromotion;
    pendingPromotion = null;
    if (t && g && mv) play(t, g, { from: mv.from, to: mv.to, promotion: promo.dataset.chessTPromo }).catch(() => {});
    else render();
    return;
  }
  const sq = event.target.closest("[data-chess-t-sq]");
  if (sq) {
    const [file, rank] = sq.dataset.chessTSq.split(",").map(Number);
    tapSquare(file, rank);
  }
}

function onSubmit(event) {
  const form = event.target.closest("[data-chess-t-chat]");
  if (!form) return;
  event.preventDefault();
  const gameId = form.dataset.chessTChat || "";
  const input = form.querySelector("[data-chess-t-chat-input]");
  const text = String(input?.value || "").trim();
  const t = tournaments[view.tournamentId];
  if (!t || !text) return;
  if (input) input.value = "";
  delete drafts[gameId];
  sendChat(t, gameId, text).catch(() => {});
}

function onInput(event) {
  const input = event.target.closest("[data-chess-t-chat-input]");
  if (input) drafts[input.dataset.chessTChatInput || ""] = input.value;
}

// ---------------------------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------------------------

export function initChessTournaments(dependencies) {
  deps = dependencies;
  screenEl = document.querySelector("[data-chess-tournaments]");
  if (!screenEl) return;
  loadCache();
  reduceArena();
  screenEl.addEventListener("click", onClick);
  screenEl.addEventListener("submit", onSubmit);
  screenEl.addEventListener("input", onInput);
}

/** The Chess screen came on: keep the arena scanned and polled while it is up. */
export function showChessTournaments() {
  if (!deps || active) { if (active) render(); return; }
  active = true;
  now = Date.now();
  historyReady = !hasBroadcastIndexer();
  historyDeadline = Date.now() + HISTORY_WAIT_MS;
  render();
  setServiceScanWanted([T.ARENA_CHANNEL]);
  unsubscribeHits = deps.engine.onBroadcastBlockHits?.(handleHits) || null;
  backfill({ full: true }).catch(() => {});
  estimateJoinFee().catch(() => {});
  pollTimer = window.setInterval(() => { if (!document.hidden) backfill().catch(() => {}); }, POLL_MS);
  // Only while it matters: a seat held or a game on. Idle in the lobby, the poll is plenty.
  fastPollTimer = window.setInterval(() => { if (!document.hidden && myActiveTournament()) backfill().catch(() => {}); }, FAST_POLL_MS);
  tickTimer = window.setInterval(() => {
    now = Date.now();
    if (!historyReady && Date.now() > historyDeadline) { historyReady = true; render(); }
    claimTimeoutsIfDue();
    if (document.hidden || !screenEl) return;
    checkWaitingRoom();
    renderClocks();
  }, TICK_MS);
  showWaitingRoomIfSeated();
}

export function hideChessTournaments() {
  if (!active) return;
  active = false;
  setServiceScanWanted([]);
  if (unsubscribeHits) { try { unsubscribeHits(); } catch { /* fine */ } unsubscribeHits = null; }
  window.clearInterval(pollTimer); pollTimer = null;
  window.clearInterval(fastPollTimer); fastPollTimer = null;
  window.clearInterval(tickTimer); tickTimer = null;
}

export function resetChessTournamentsForAccount() {
  pendingMoveGames.clear();
  claimedGames.clear();
  queuedPublicRoomId = null;
  joinFeeText = null;
  view = { name: "home", mode: "duel", tab: "play", tournamentId: null, gameId: null };
  selectedSquare = null;
  pendingPromotion = null;
  endOverlayFor = null;
  endHandledFor = null;
  reduceArena();
}

/** Clocks tick five times a second; the rest of the screen only re-renders on arena changes. */
function renderClocks() {
  const t = tournaments[view.tournamentId];
  if (view.name === "waiting") {
    const el = screenEl.querySelector("[data-chess-t-countdown]");
    const expiry = t ? T.seatExpiry(t, me()) : null;
    if (el) {
      const left = Math.max(0, (expiry ?? now) - now);
      el.textContent = clockText(left);
      el.classList.toggle("low", left < 30_000);
    }
    return;
  }
  if (view.name === "game") {
    const game = t?.games[view.gameId];
    if (!game) return;
    for (const color of [Chess.WHITE, Chess.BLACK]) {
      const el = screenEl.querySelector(`[data-chess-t-clock="${color}"]`);
      const chip = screenEl.querySelector(`[data-chess-t-chip="${color}"]`);
      if (!el) continue;
      const remaining = T.remainingMs(game, color, now);
      el.textContent = clockText(remaining, { tenths: true });
      chip?.classList.toggle("low", !game.winner && game.board.sideToMove === color && remaining < 20_000);
    }
    const status = screenEl.querySelector("[data-chess-t-status]");
    if (status && !game.winner) {
      const text = gameStatusText(t, game);
      if (status.textContent !== text) status.textContent = text;
    }
    return;
  }
  // Rows with a running clock (bracket, Active games).
  for (const el of screenEl.querySelectorAll("[data-chess-t-clock-for]")) {
    const [tid, gid] = el.dataset.chessTClockFor.split("|");
    const game = tournaments[tid]?.games[gid];
    if (!game || game.winner) continue;
    el.textContent = clockText(T.remainingMs(game, game.board.sideToMove, now));
  }
}

void chooseDialog;
