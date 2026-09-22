// Chess tournaments (CHESS_TOURNAMENTS.md, iOS 334cdd1 / 7dc84bb / 6fd5248): Kaspa Hub > Chess.
// The `#chess-arena` room is read through the broadcast indexer and the live block scan,
// reduced by engine/chess-tournament.js into the bracket every device agrees on, and every
// action a player takes - join, move, resign, claim, chat - is one broadcast transaction.
// Screens: lobby, tournament (bracket, seats, lobby chat), game (board, clocks, chat),
// leaderboard. Anyone can watch any game live.

import * as T from "../engine/chess-tournament.js";
import * as Chess from "../engine/chess.js";
import { fetchBroadcastHistory, hasBroadcastIndexer, sendBroadcastMessage } from "../engine/broadcasts.js";
import { confirmDialog, promptDialog, alertDialog, chooseDialog } from "./dialogs.js";
import { setServiceScanWanted } from "./broadcasts.js";

const ARENA_CACHE_KEY = "kachat-chess-arena-v1";   // device-wide: the arena is the same for every wallet
const ARENA_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const ARENA_MAX_ROWS = 40_000;
const POLL_MS = 8_000;
const TICK_MS = 200;
const SEND_ATTEMPTS = 5;
const SEND_RETRY_MS = 1_200;

let deps = null;
let screenEl = null;
let rows = new Map();          // txId -> { txId, senderAddress, content, blockTime }
let tournaments = {};
let leaderboardRows = [];
let lastReducedCount = -1;
let active = false;            // the Chess screen is on
let pollTimer = null;
let tickTimer = null;
let unsubscribeHits = null;
let backfilled = false;
let now = Date.now();
let lastError = "";
const pendingMoveGames = new Set();   // "<tournament>|<game>" sent and not yet seen back
const claimedGames = new Set();       // claims already posted - one is enough
let queuedPublicRoomId = null;

// Navigation: lobby -> tournament -> game; leaderboard beside the lobby.
let view = { name: "lobby", tournamentId: null, gameId: null };
let autoOpenedGameId = null;
let selectedSquare = null;
let pendingPromotion = null;   // { from, to }
let busy = false;              // a join/create in flight
const drafts = {};             // chat drafts per screen, kept while the screen is up

const me = () => deps?.engine?.address || "";
const esc = (v) => deps.escapeHtml(String(v ?? ""));

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
      rows.set(r.txId, { txId: r.txId, senderAddress: r.senderAddress || "", content: r.content || "", blockTime: Number(r.blockTime) || 0 });
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

/** Merges indexer or scan rows; a row already held keeps the chain's block time. */
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

async function backfill() {
  if (!hasBroadcastIndexer()) return;
  try {
    let before = null;
    const cutoff = Date.now() - ARENA_RETENTION_MS;
    const pages = backfilled ? 1 : 20;
    for (let page = 0; page < pages; page += 1) {
      const result = await fetchBroadcastHistory({ channel: T.ARENA_CHANNEL, limit: 500, before });
      mergeRows(result.messages);
      if (!result.hasMore || !result.messages?.length) break;
      const oldest = result.messages.reduce((min, m) => Math.min(min, Number(m.blockTime) || Infinity), Infinity);
      if (!Number.isFinite(oldest) || oldest < cutoff) break;
      before = oldest;
    }
    backfilled = true;
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
  lastReducedCount = events.length;
  tournaments = T.reduce(events);
  leaderboardRows = T.leaderboard(Object.values(tournaments));
  const my = me();
  // Asked to join a public room that filled first: queue into the next one, once.
  if (queuedPublicRoomId && my) {
    const room = tournaments[queuedPublicRoomId];
    if (room && T.isFull(room) && !room.players.includes(my)) {
      queuedPublicRoomId = null;
      joinPublicQueue().catch(() => {});
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
  if (active) { render(); autoOpenMyGameIfNeeded(); }
}

// ---------------------------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------------------------

/** The public room taking players right now: the first numbered room that is not full. */
function currentPublicRoomId() {
  let number = 1;
  while (tournaments[T.publicId(number)] && T.isFull(tournaments[T.publicId(number)])) number += 1;
  return T.publicId(number);
}
function myPrivateTournaments() {
  const my = me();
  if (!my) return [];
  return Object.values(tournaments)
    .filter((t) => !T.isPublicId(t.id) && ["open", "live"].includes(T.tournamentStatus(t)) && t.players.includes(my))
    .sort((a, b) => b.createdAt - a.createdAt);
}
function liveTournaments() {
  return Object.values(tournaments).filter((t) => T.tournamentStatus(t) === "live").sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
}
function finishedTournaments() {
  return Object.values(tournaments).filter((t) => T.tournamentStatus(t) === "finished").sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
}
/** The tournament this player is in that is not over, if any. */
function myActiveTournament() {
  const my = me();
  if (!my) return null;
  return Object.values(tournaments)
    .filter((t) => ["open", "live"].includes(T.tournamentStatus(t)) && t.players.includes(my))
    .sort((a, b) => b.createdAt - a.createdAt)[0] || null;
}

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
      // Shown at once with this device's clock; the chain's row replaces the time when it lands.
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

/** Joins the public room taking players now. If that room fills before this join lands,
 *  reduceArena notices and joins the next room. */
async function joinPublicQueue() {
  if (!me() || myActiveTournament()) return;
  const id = currentPublicRoomId();
  if (tournaments[id]?.players.includes(me())) return;
  queuedPublicRoomId = id;
  await send(T.messages.join(id));
}

async function createPrivate() {
  const name = await promptDialog({
    title: "Create a private tournament",
    message: "You take the first seat and get a code to share. It starts when eight players have joined. Creating it is one transaction.",
    label: "Name", initial: "", confirmLabel: "Next", maxLength: T.NAME_MAX_LENGTH,
  });
  if (name === null || name === undefined) return;
  const code = await promptDialog({ title: "Creator code", message: "Creating a private tournament needs the creator code.", label: "Creator code", initial: "", confirmLabel: "Create", maxLength: 64 });
  if (!code) return;
  if (T.createKey(code, "check") !== T.createKey(T.PRIVATE_CREATE_CODE, "check")) {
    deps.showToast?.("That creator code is not right.");
    return;
  }
  const id = T.newPrivateId();
  const clean = String(name).trim();
  busy = true; render();
  const ok = await send(T.messages.create(id, clean || "Private tournament", code));
  busy = false;
  if (ok) openTournament(id); else render();
}

async function joinPrivate() {
  const raw = await promptDialog({ title: "Join a private tournament", message: "The eight-character code the creator shared. Joining is one transaction.", label: "Code", initial: "", confirmLabel: "Join", maxLength: 64 });
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
  if (ok) openTournament(id); else render();
}

async function joinTournament(t) {
  const my = me();
  if (!my || t.players.includes(my) || T.tournamentStatus(t) !== "open") return false;
  return send(T.messages.join(t.id));
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
  const key = `${t.id}|${game.id}`;
  if (!my || T.playerToMove(game) !== my || game.winner || pendingMoveGames.has(key)) return;
  if (!Chess.isLegalMove(game.board, mv)) return;
  const normalized = Chess.normalizingPromotion(game.board, mv);
  pendingMoveGames.add(key);
  render();
  const sent = await send(T.messages.move(t.id, game.id, game.moves.length + 1, Chess.algebraic(normalized.from), Chess.algebraic(normalized.to), normalized.promotion ? Chess.promotionLetter(normalized.promotion) : null));
  if (!sent) { pendingMoveGames.delete(key); render(); }
}

async function resign(t, game) {
  if (!T.colorOf(game, me()) || game.winner) return;
  const ok = await confirmDialog({ title: "Resign this game?", confirmLabel: "Resign", destructive: true });
  if (ok) await send(T.messages.resign(t.id, game.id));
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
      const key = `${t.id}|${game.id}`;
      if (claimedGames.has(key)) continue;
      // A second's margin past zero, so the claim's block time is safely after.
      if (T.remainingMs(game, game.board.sideToMove, now - 1_500) !== 0) continue;
      claimedGames.add(key);
      send(T.messages.claim(t.id, game.id)).catch(() => {});
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------------------------

function nameFor(address) {
  if (!address) return "unknown";
  if (address === me()) return "You";
  return deps.displayNameFor(address);
}
function avatarFor(address) { return deps.avatarHtmlFor?.(address, "chess-t-avatar") || ""; }

function clockText(ms, { tenths = false } = {}) {
  const total = Math.max(0, Number(ms) || 0);
  const seconds = Math.floor(total / 1000);
  if (tenths && seconds < 10) return `0:${String(seconds).padStart(2, "0")}.${Math.floor((total % 1000) / 100)}`;
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
function roundName(round) { return round === 3 ? "Final" : round === 2 ? "Semifinal" : "Round 1"; }
function outcomeText(game, { short = false } = {}) {
  if (!game.winner || !game.outcome) return "";
  const who = nameFor(game.winner);
  switch (game.outcome.kind) {
    case "checkmate": return short ? `${who} won by checkmate` : `Checkmate. ${who} won.`;
    case "resignation": return short ? `${who} won by resignation` : `${who} won by resignation.`;
    case "timeout": return short ? `${who} won on time` : `${who} won on time.`;
    default: return short ? `${who} won on clock after a draw (${game.outcome.reason})` : `Draw by ${game.outcome.reason}. ${who} won on clock.`;
  }
}

// ---------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------

const ICON_PEOPLE = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="8" r="3.2"/><path d="M3 19c.6-3.5 3-5.5 6-5.5s5.4 2 6 5.5"/><circle cx="17" cy="9" r="2.5"/><path d="M15.5 13.6c2.6.2 4.6 2 5.2 5.4"/></svg>`;
const ICON_LOCK = `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>`;
const ICON_TROPHY = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4h10v5a5 5 0 0 1-10 0V4Z"/><path d="M7 6H4a3 3 0 0 0 3 4M17 6h3a3 3 0 0 1-3 4M12 14v3M8 20h8M9 17h6"/></svg>`;
const ICON_BACK = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10.5 19.5 3 12m0 0 7.5-7.5M3 12h18"/></svg>`;
const ICON_CHEVRON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>`;

function render() {
  if (!screenEl || !active) return;
  const y = screenEl.querySelector(".chess-t-body")?.scrollTop || 0;
  let html;
  if (view.name === "game") html = renderGame();
  else if (view.name === "tournament") html = renderTournament();
  else if (view.name === "leaderboard") html = renderLeaderboard();
  else html = renderLobby();
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

function rowHtml({ icon, title, subtitle, action = "", attrs = "" }) {
  return `
    <button class="chess-t-row" type="button" ${attrs}>
      <span class="chess-t-row-icon">${icon}</span>
      <span class="chess-t-row-main"><strong>${esc(title)}</strong><small>${esc(subtitle)}</small></span>
      ${action ? `<span class="chess-t-row-action">${esc(action)}</span>` : ""}
      <span class="chess-t-row-chevron">${ICON_CHEVRON}</span>
    </button>`;
}

function renderLobby() {
  const my = me();
  const roomId = currentPublicRoomId();
  const room = tournaments[roomId] || null;
  const number = T.publicNumber(roomId) || 1;
  const count = room?.players.length || 0;
  const inThisRoom = Boolean(my && room?.players.includes(my));
  const mine = myActiveTournament();
  const busyElsewhere = Boolean(mine) && !inThisRoom;
  let cta;
  if (inThisRoom) cta = `<button class="secondary-button chess-t-cta" type="button" data-chess-t-open="${esc(roomId)}">You're in. Waiting for ${T.seatsLeft(room)} more…</button>`;
  else if (busyElsewhere) cta = `<button class="secondary-button chess-t-cta" type="button" data-chess-t-open="${esc(mine.id)}">${T.tournamentStatus(mine) === "open" ? "You're waiting in" : "You're playing in"} ${esc(mine.name)}</button>`;
  else cta = `<button class="primary-button chess-t-cta" type="button" data-chess-t-join-public ${busy ? "disabled" : ""}>${busy ? "Joining…" : "Join (one transaction)"}</button>`;
  const seats = Array.from({ length: T.PLAYER_COUNT }, (_, i) => `<span class="chess-t-seat${i < count ? " taken" : ""}"></span>`).join("");
  const privates = myPrivateTournaments();
  const live = liveTournaments().filter((t) => T.isPublicId(t.id) && t.id !== mine?.id);
  const done = finishedTournaments().filter((t) => T.isPublicId(t.id)).slice(0, 20);
  return `
    ${headerHtml("Chess", { trailing: `<button class="kaposts-icon-button" type="button" data-chess-t-leaderboard aria-label="Leaderboard" title="Leaderboard">${ICON_TROPHY}</button>` })}
    <div class="chess-t-body">
      <p class="screen-kicker">Public</p>
      <div class="chess-t-card">
        <div class="chess-t-card-top">
          <span class="chess-t-row-icon">${ICON_PEOPLE}</span>
          <span class="chess-t-row-main"><strong>Public tournament #${number}</strong><small>${count} of ${T.PLAYER_COUNT} players waiting</small></span>
        </div>
        <div class="chess-t-seats">${seats}</div>
        ${cta}
      </div>
      <p class="field-hint">There is always a public room waiting for players. When it fills, it starts and the next one opens. Eight players, single elimination, five minutes a side. Every move is a Kaspa transaction (about 0.0017 KAS each).</p>

      <p class="screen-kicker">Private</p>
      <div class="chess-t-list">
        ${privates.map((t) => rowHtml({ icon: ICON_LOCK, title: t.name, subtitle: `${t.players.length} of ${T.PLAYER_COUNT} players · code ${t.id}`, action: T.tournamentStatus(t) === "open" ? `${T.seatsLeft(t)} seat${T.seatsLeft(t) === 1 ? "" : "s"} left` : "In play", attrs: `data-chess-t-open="${esc(t.id)}"` })).join("")}
        ${rowHtml({ icon: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M15 8l2 2M18 5l2 2"/></svg>`, title: "Join with a code", subtitle: "The eight-character code a friend shared.", attrs: "data-chess-t-join-private" })}
        ${rowHtml({ icon: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/></svg>`, title: "Create a private tournament", subtitle: "Needs the creator code.", attrs: "data-chess-t-create" })}
      </div>
      <p class="field-hint">A private tournament is for friends: the creator shares its eight-character code. Creating one needs the creator code.</p>

      ${live.length ? `<p class="screen-kicker">In play</p><div class="chess-t-list">${live.map((t) => rowHtml({ icon: ICON_PEOPLE, title: t.name, subtitle: `${t.players.length} of ${T.PLAYER_COUNT} players`, action: "Watch", attrs: `data-chess-t-open="${esc(t.id)}"` })).join("")}</div>` : ""}
      ${done.length ? `<p class="screen-kicker">Finished</p><div class="chess-t-list">${done.map((t) => rowHtml({ icon: ICON_TROPHY, title: t.name, subtitle: `${t.players.length} of ${T.PLAYER_COUNT} players`, action: T.champion(t) ? `Won by ${nameFor(T.champion(t))}` : "Finished", attrs: `data-chess-t-open="${esc(t.id)}"` })).join("")}</div>` : ""}
      ${lastError ? `<p class="field-hint chess-t-error">${esc(lastError)}</p>` : ""}
    </div>`;
}

function renderLeaderboard() {
  const my = me();
  return `
    ${headerHtml("Leaderboard", { back: true })}
    <div class="chess-t-body">
      ${leaderboardRows.length ? "" : `<p class="field-hint">No finished games yet.</p>`}
      <div class="chess-t-list">
        ${leaderboardRows.map((r, i) => `
          <div class="chess-t-row static">
            <span class="chess-t-rank">${i + 1}</span>
            ${avatarFor(r.address)}
            <span class="chess-t-row-main"><strong>${esc(r.address === my ? "You" : nameFor(r.address))}</strong><small>${r.wins}W · ${r.losses}L · ${r.tournamentsPlayed} played</small></span>
            ${r.tournamentsWon > 0 ? `<span class="chess-t-titles">${ICON_TROPHY}${r.tournamentsWon}</span>` : ""}
          </div>`).join("")}
      </div>
    </div>`;
}

function renderTournament() {
  const t = tournaments[view.tournamentId];
  if (!t) {
    return `${headerHtml("Tournament", { back: true })}<div class="chess-t-body"><p class="field-hint">Loading the tournament from the arena…</p></div>`;
  }
  const my = me();
  const status = T.tournamentStatus(t);
  let statusHtml = "";
  if (status === "open") {
    const left = T.seatsLeft(t);
    statusHtml += `<p class="chess-t-status">Waiting for ${left} more player${left === 1 ? "" : "s"}. It starts by itself when the eighth joins.</p>`;
    if (my && !t.players.includes(my)) statusHtml += `<button class="primary-button chess-t-cta" type="button" data-chess-t-join="${esc(t.id)}" ${busy ? "disabled" : ""}>${busy ? "Joining…" : "Join (one transaction)"}</button>`;
    else if (t.creator === my && !T.isPublicId(t.id)) statusHtml += `<button class="secondary-button chess-t-cta danger" type="button" data-chess-t-cancel="${esc(t.id)}">Cancel tournament</button>`;
    if (!T.isPublicId(t.id)) statusHtml += `<div class="chess-t-code"><span>Code: <b>${esc(t.id)}</b></span><button class="secondary-button" type="button" data-chess-t-copy="${esc(t.id)}">Copy</button></div>`;
  } else if (status === "live") {
    const game = my ? T.currentGameFor(t, my) : null;
    if (game) {
      if (game.winner) statusHtml += `<p class="chess-t-status">${game.winner === my ? `You won ${roundName(game.round).toLowerCase()}. Waiting for your next opponent - watch the other game meanwhile.` : "You are out of this tournament. Watch the rest of the bracket."}</p>`;
      else statusHtml += `<button class="primary-button chess-t-cta" type="button" data-chess-t-game="${esc(game.id)}">Go to your game</button>`;
    } else statusHtml += `<p class="chess-t-status">In play. Open any game to watch it live.</p>`;
  } else if (status === "finished") {
    const champ = T.champion(t);
    if (champ) statusHtml += `<p class="chess-t-status chess-t-champion">${ICON_TROPHY} ${esc(nameFor(champ))} won the tournament</p>`;
  } else statusHtml += `<p class="chess-t-status">Cancelled by the creator.</p>`;

  let bracketHtml = "";
  if (status === "open") {
    bracketHtml = `<p class="screen-kicker">Players (${t.players.length} of ${T.PLAYER_COUNT})</p><div class="chess-t-list">
      ${t.players.map((address, i) => `<div class="chess-t-row static">${avatarFor(address)}<span class="chess-t-row-main"><strong>${esc(nameFor(address))}</strong></span><span class="chess-t-row-action muted">Seed ${i + 1}</span></div>`).join("")}
      ${Array.from({ length: T.seatsLeft(t) }, () => `<div class="chess-t-row static"><span class="chess-t-open-seat"></span><span class="chess-t-row-main muted">Open seat</span></div>`).join("")}
    </div>`;
  } else if (status !== "cancelled") {
    for (const round of [1, 2, 3]) {
      const games = T.gamesInRound(t, round);
      if (!games.length) continue;
      bracketHtml += `<p class="screen-kicker">${round === 3 ? "Final" : round === 2 ? "Semifinals" : "Round 1"}</p><div class="chess-t-list">${games.map((game) => `
        <button class="chess-t-row" type="button" data-chess-t-game="${esc(game.id)}">
          <span class="chess-t-row-main">
            <strong><span class="${game.winner === game.white ? "won" : ""}">${esc(nameFor(game.white))}</span> <em>vs</em> <span class="${game.winner === game.black ? "won" : ""}">${esc(nameFor(game.black))}</span></strong>
            <small>${esc(game.winner ? outcomeText(game, { short: true }) : `Move ${Math.floor(game.moves.length / 2) + 1} · ${game.board.sideToMove} to move`)}</small>
          </span>
          ${game.winner ? "" : `<span class="chess-t-row-action mono">${clockText(T.remainingMs(game, game.board.sideToMove, now))}</span>`}
          <span class="chess-t-row-chevron">${ICON_CHEVRON}</span>
        </button>`).join("")}</div>`;
    }
  }

  const lines = t.chat.filter((l) => !l.game).slice(-50);
  return `
    ${headerHtml(t.name, { back: true })}
    <div class="chess-t-body">
      <div class="chess-t-card">${statusHtml}</div>
      ${bracketHtml}
      <p class="screen-kicker">Lobby chat</p>
      <div class="chess-t-chat">
        ${lines.length ? lines.map((l) => `<div class="chess-t-line"><small>${esc(nameFor(l.sender))}</small><span>${esc(l.text)}</span></div>`).join("") : `<p class="field-hint">Say hello.</p>`}
      </div>
      ${chatComposerHtml("")}
      ${lastError ? `<p class="field-hint chess-t-error">${esc(lastError)}</p>` : ""}
    </div>`;
}

function chatComposerHtml(gameId) {
  return `
    <form class="chess-t-composer" data-chess-t-chat="${esc(gameId)}">
      <input class="kaposts-reply-input" type="text" data-chess-t-chat-input="${esc(gameId)}" placeholder="Message (one transaction)" maxlength="${T.CHAT_MAX_LENGTH}" autocomplete="off" />
      <button class="primary-button" type="submit">Send</button>
    </form>`;
}

function renderGame() {
  const t = tournaments[view.tournamentId];
  const game = t?.games[view.gameId];
  if (!t || !game) return `${headerHtml("Game", { back: true })}<div class="chess-t-body"><p class="field-hint">Loading…</p></div>`;
  const my = me();
  const myColor = my ? T.colorOf(game, my) : null;
  const pendingKey = `${t.id}|${game.id}`;
  const isMyTurn = Boolean(myColor) && !game.winner && game.board.sideToMove === myColor && !pendingMoveGames.has(pendingKey);
  const flipped = myColor === Chess.BLACK;

  const clockRow = (color) => {
    const address = T.addressOf(game, color);
    const remaining = T.remainingMs(game, color, now);
    const running = !game.winner && game.board.sideToMove === color;
    return `
      <div class="chess-t-clock-row">
        ${avatarFor(address)}
        <span class="chess-t-row-main"><strong>${esc(nameFor(address))}</strong><small>${color === Chess.WHITE ? "White" : "Black"}</small></span>
        <span class="chess-t-clock${running ? " running" : ""}${running && remaining < 20_000 ? " low" : ""}">${clockText(remaining, { tenths: true })}</span>
      </div>`;
  };

  let status;
  if (game.winner) status = outcomeText(game);
  else if (pendingMoveGames.has(pendingKey)) status = "Sending your move…";
  else if (myColor) {
    if (game.board.sideToMove === myColor && Chess.isKingInCheck(game.board, myColor)) status = "Check. Your move.";
    else status = game.board.sideToMove === myColor ? "Your move" : "Their move";
  } else status = game.board.sideToMove === Chess.WHITE ? "White to move" : "Black to move";

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
  const promo = pendingPromotion ? `
    <div class="chess-promo">
      <div class="chess-promo-card"><p>Promote to</p><div class="chess-promo-options">
        ${["queen", "rook", "bishop", "knight"].map((type) => `<button type="button" class="${myColor || "white"}" data-chess-t-promo="${type}">${Chess.PIECE_GLYPHS[type]}</button>`).join("")}
      </div></div>
    </div>` : "";

  const lines = t.chat.filter((l) => l.game === game.id).slice(-80);
  return `
    ${headerHtml(roundName(game.round), { back: true })}
    <div class="chess-t-body">
      ${clockRow(flipped ? Chess.WHITE : Chess.BLACK)}
      <div class="chess-board-wrap"><div class="chess-board chess-t-board">${board}</div>${promo}</div>
      ${clockRow(flipped ? Chess.BLACK : Chess.WHITE)}
      <p class="chess-t-status center${game.winner ? " muted" : ""}">${esc(status)}</p>
      ${myColor && !game.winner ? `<div class="chess-actions"><button class="secondary-button danger" type="button" data-chess-t-resign>Resign</button></div>` : ""}
      <p class="screen-kicker">Chat</p>
      <div class="chess-t-chat bubbles">
        ${lines.length ? lines.map((l) => `<div class="chess-t-bubble${l.sender === my ? " mine" : ""}">${l.sender === my ? "" : `<small>${esc(nameFor(l.sender))}</small>`}<span>${esc(l.text)}</span></div>`).join("") : `<p class="field-hint">No messages yet.</p>`}
      </div>
      ${chatComposerHtml(game.id)}
      ${lastError ? `<p class="field-hint chess-t-error">${esc(lastError)}</p>` : ""}
    </div>`;
}

// ---------------------------------------------------------------------------------------------
// Navigation and events
// ---------------------------------------------------------------------------------------------

function openTournament(id) {
  view = { name: "tournament", tournamentId: id, gameId: null };
  autoOpenedGameId = null;
  render();
  autoOpenMyGameIfNeeded();
}
function openGame(gameId) {
  view = { ...view, name: "game", gameId };
  selectedSquare = null;
  pendingPromotion = null;
  render();
}
function goBack() {
  if (view.name === "game") view = { ...view, name: "tournament", gameId: null };
  else view = { name: "lobby", tournamentId: null, gameId: null };
  selectedSquare = null;
  pendingPromotion = null;
  render();
}

/** The player's game came into being: open it (once per game). */
function autoOpenMyGameIfNeeded() {
  if (!active || view.name === "lobby" || view.name === "leaderboard") return;
  const t = tournaments[view.tournamentId];
  const my = me();
  if (!t || !my) return;
  const game = T.currentGameFor(t, my);
  if (!game || game.winner || autoOpenedGameId === game.id) return;
  autoOpenedGameId = game.id;
  openGame(game.id);
}

function tapSquare(file, rank) {
  const t = tournaments[view.tournamentId];
  const game = t?.games[view.gameId];
  if (!t || !game) return;
  const my = me();
  const myColor = T.colorOf(game, my);
  const isMyTurn = Boolean(myColor) && !game.winner && game.board.sideToMove === myColor && !pendingMoveGames.has(`${t.id}|${game.id}`);
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
  const back = event.target.closest("[data-chess-t-back]");
  if (back) { goBack(); return; }
  if (event.target.closest("[data-chess-t-leaderboard]")) { view = { name: "leaderboard", tournamentId: null, gameId: null }; render(); return; }
  const open = event.target.closest("[data-chess-t-open]");
  if (open) { openTournament(open.dataset.chessTOpen); return; }
  const game = event.target.closest("[data-chess-t-game]");
  if (game) { openGame(game.dataset.chessTGame); return; }
  if (event.target.closest("[data-chess-t-join-public]")) {
    if (busy) return;
    busy = true; render();
    joinPublicQueue().catch(() => {}).finally(() => { busy = false; render(); });
    return;
  }
  if (event.target.closest("[data-chess-t-join-private]")) { joinPrivate().catch(() => {}); return; }
  if (event.target.closest("[data-chess-t-create]")) { createPrivate().catch(() => {}); return; }
  const join = event.target.closest("[data-chess-t-join]");
  if (join) {
    const t = tournaments[join.dataset.chessTJoin];
    if (!t || busy) return;
    busy = true; render();
    joinTournament(t).catch(() => {}).finally(() => { busy = false; render(); });
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
  render();
  setServiceScanWanted([T.ARENA_CHANNEL]);
  unsubscribeHits = deps.engine.onBroadcastBlockHits?.(handleHits) || null;
  backfill().catch(() => {});
  pollTimer = window.setInterval(() => { if (!document.hidden) backfill().catch(() => {}); }, POLL_MS);
  tickTimer = window.setInterval(() => {
    now = Date.now();
    claimTimeoutsIfDue();
    if (!document.hidden && screenEl && (view.name === "game" || view.name === "tournament")) renderClocks();
  }, TICK_MS);
}

export function hideChessTournaments() {
  if (!active) return;
  active = false;
  setServiceScanWanted([]);
  if (unsubscribeHits) { try { unsubscribeHits(); } catch { /* fine */ } unsubscribeHits = null; }
  window.clearInterval(pollTimer); pollTimer = null;
  window.clearInterval(tickTimer); tickTimer = null;
}

export function resetChessTournamentsForAccount() {
  pendingMoveGames.clear();
  claimedGames.clear();
  queuedPublicRoomId = null;
  view = { name: "lobby", tournamentId: null, gameId: null };
  selectedSquare = null;
  pendingPromotion = null;
  reduceArena();
}

/** Clocks tick five times a second; the rest of the screen only re-renders on arena changes. */
function renderClocks() {
  const t = tournaments[view.tournamentId];
  if (!t) return;
  if (view.name === "game") {
    const game = t.games[view.gameId];
    if (!game || game.winner) return;
    const clocks = screenEl.querySelectorAll(".chess-t-clock");
    const myColor = T.colorOf(game, me());
    const order = myColor === Chess.BLACK ? [Chess.WHITE, Chess.BLACK] : [Chess.BLACK, Chess.WHITE];
    clocks.forEach((el, i) => {
      const color = order[i];
      if (!color) return;
      const remaining = T.remainingMs(game, color, now);
      el.textContent = clockText(remaining, { tenths: true });
      el.classList.toggle("low", game.board.sideToMove === color && remaining < 20_000);
    });
    // Our opponent flagged: the status can say so before the claim lands.
    if (myColor && game.board.sideToMove !== myColor && T.remainingMs(game, game.board.sideToMove, now) === 0) {
      const status = screenEl.querySelector(".chess-t-status.center");
      if (status && status.textContent !== "They ran out of time. Claiming the win…") status.textContent = "They ran out of time. Claiming the win…";
    }
  } else {
    // Bracket rows: only the live games carry a clock.
    for (const row of screenEl.querySelectorAll("[data-chess-t-game]")) {
      const game = t.games[row.dataset.chessTGame];
      const el = row.querySelector(".chess-t-row-action.mono");
      if (!game || game.winner || !el) continue;
      el.textContent = clockText(T.remainingMs(game, game.board.sideToMove, now));
    }
  }
}
