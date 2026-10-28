// Chess Online > Bots (iOS c3c04a1: ChessBotsView, ChessBotDetailView, ChessBotGameView; ONLINE_CHESS.md
// §7). Five bots, level 1 to 5, as a ladder: level 1 is open, each level opens when the one
// before it is beaten (kept on this device, per address). The bot runs here, its search in a Web
// Worker (engine/chess-bot-worker.js); the game goes on chain in #chess-bots as it is played -
// the start, every move (the player's and the bot's, both signed by the player's address) and a
// resignation. No server, no stakes, no leaderboard.
//
// The screens live inside Chess Online's own screen (ui/chess-tournaments.js): its home card
// opens them, its render() paints renderChessBots() while view.name is "bots", and its click,
// leave and account-reset hooks call the exports below. The board, header and cards reuse its
// look (.chess-board, .chess-t-*).

import "./chess-bots.css";
import * as Chess from "../engine/chess.js";
import {
  CHESS_BOTS, CHESS_BOTS_CHANNEL, chessBot, SIDE_PREFERENCES, resolveSide, botRecord, isBotUnlocked,
  addBotResult, parseBotRecords, sampleMoveContent, chessBotBestMove, ChessBotGame,
} from "../engine/chess-bot.js";
import { sendBroadcastMessage, broadcastPayloadBytes } from "../engine/broadcasts.js";
import { confirmDialog } from "./dialogs.js";
import { KAS_UNIT } from "../engine/network.js";

/** Level -> { wins, losses, draws }, under the account's scope (iOS keeps address -> level ->
 *  record in one UserDefaults entry; here the scope is the address). */
const RECORDS_KEY = "kachat-chess-bots-v1";
/** ui/app.js's accountScopedKey prefix, for when the host passes no accountScopedKey. */
const ACCOUNT_DATA_PREFIX = "kachat-account-data-v1";

let ctx = null;                // { deps, render, exit }
let screen = "ladder";         // ladder | detail | game
let selectedLevel = 1;
let sidePreference = "White";
let game = null;
let selectedSquare = null;
let pendingPromotion = null;   // { from, to }
let showEnd = false;
let endShownFor = null;        // the game whose end overlay has come up once
let feeText = null;            // "0.0017 KAS" once estimated for this account
let feeEstimating = false;
let resetScroll = false;
let asking = false;            // a resign / leave sheet is up

const deps = () => ctx?.deps || {};
const esc = (v) => (deps().escapeHtml ? deps().escapeHtml(String(v ?? "")) : String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])));
const requestRender = () => { try { ctx?.render?.(); } catch { /* not on screen */ } };
const currentBot = () => chessBot(selectedLevel) || CHESS_BOTS[0];

// ---------------------------------------------------------------------------------------------
// Record (ChessBotProgress)
// ---------------------------------------------------------------------------------------------

function recordsKey() {
  const d = deps();
  if (typeof d.accountScopedKey === "function") return d.accountScopedKey(RECORDS_KEY);
  const address = String(d.engine?.address || "").trim();
  return address ? `${ACCOUNT_DATA_PREFIX}:${address}:${RECORDS_KEY}` : RECORDS_KEY;
}
function loadRecords() {
  try { return parseBotRecords(localStorage.getItem(recordsKey())); } catch { return {}; }
}
function saveResult(level, kind) {
  const next = addBotResult(loadRecords(), level, kind);
  try { localStorage.setItem(recordsKey(), JSON.stringify(next)); } catch { /* storage blocked: this session only */ }
}

// ---------------------------------------------------------------------------------------------
// The search, off the main thread
// ---------------------------------------------------------------------------------------------

let worker = null;
let workerBroken = false;
let thinkSerial = 0;
const thinking = new Map();    // id -> { resolve, board, settings, avoiding }

function searchHere(board, settings, avoiding) {
  // No Worker (or it failed to start): a macrotask on this thread, so the "thinking" state
  // paints before the search holds the page.
  return new Promise((resolve) => setTimeout(() => {
    try { resolve(chessBotBestMove(board, settings, avoiding)); } catch { resolve(null); }
  }, 30));
}

function workerFailed(reason) {
  workerBroken = true;
  deps().appendEngineLog?.(`Chess bot worker unavailable, searching on the page: ${reason}`);
  try { worker?.terminate(); } catch { /* gone */ }
  worker = null;
  const waiting = [...thinking.values()];
  thinking.clear();
  for (const job of waiting) searchHere(job.board, job.settings, job.avoiding).then(job.resolve);
}

function ensureWorker() {
  if (worker || workerBroken || typeof Worker === "undefined") return worker;
  try {
    worker = new Worker(new URL("../engine/chess-bot-worker.js", import.meta.url), { type: "module" });
    worker.onmessage = (event) => {
      const { id, move, error } = event.data || {};
      const job = thinking.get(id);
      if (!job) return;
      thinking.delete(id);
      if (error) { deps().appendEngineLog?.(`Chess bot search failed: ${error}`); searchHere(job.board, job.settings, job.avoiding).then(job.resolve); return; }
      job.resolve(move || null);
    };
    worker.onerror = (event) => { event?.preventDefault?.(); workerFailed(event?.message || "worker error"); };
    worker.onmessageerror = () => workerFailed("message error");
  } catch (error) {
    workerFailed(error?.message || String(error));
  }
  return worker;
}

function think(board, settings, avoiding) {
  const w = ensureWorker();
  if (!w) return searchHere(board, settings, avoiding);
  return new Promise((resolve) => {
    const id = ++thinkSerial;
    const plainSettings = { ...settings };
    const plainAvoiding = (avoiding || []).map((m) => ({ from: { ...m.from }, to: { ...m.to }, promotion: m.promotion || null }));
    thinking.set(id, { resolve, board, settings: plainSettings, avoiding: plainAvoiding });
    try { w.postMessage({ id, board, settings: plainSettings, avoiding: plainAvoiding }); }
    catch (error) { workerFailed(error?.message || String(error)); }
  });
}

// ---------------------------------------------------------------------------------------------
// On chain
// ---------------------------------------------------------------------------------------------

/** One broadcast in #chess-bots from the chatting address. One input, like every Chess Online
 *  send: the fee is the one the detail screen quoted. */
async function sendContent(content, address) {
  const engine = deps().engine;
  // The game belongs to the address it started under: another account never signs its moves.
  if (!engine?.address || engine.address !== address) throw new Error("This game belongs to another account.");
  await sendBroadcastMessage({ engine, channel: CHESS_BOTS_CHANNEL, content, feeKas: "0", singleInput: true });
}

/** The "about 0.0017 KAS each" figure (ChessBotCodec.moveFeeText): a move at ply 40. */
async function estimateMoveFee() {
  if (feeText || feeEstimating || !deps().estimateFeeKas) return;
  feeEstimating = true;
  try {
    const fee = await deps().estimateFeeKas(broadcastPayloadBytes(CHESS_BOTS_CHANNEL, sampleMoveContent()), { singleInput: true });
    if (fee != null && Number.isFinite(Number(fee))) { feeText = `${Number(fee).toFixed(4)} ${KAS_UNIT}`; requestRender(); }
  } catch { /* "one small fee each" */ } finally { feeEstimating = false; }
}

// ---------------------------------------------------------------------------------------------
// Icons (SF Symbols iOS uses, drawn to match Chess Online's)
// ---------------------------------------------------------------------------------------------

export const ICON_CPU = `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2.2"/><rect x="9.5" y="9.5" width="5" height="5" rx=".8"/><path d="M9.5 2.8V6M14.5 2.8V6M9.5 18v3.2M14.5 18v3.2M2.8 9.5H6M2.8 14.5H6M18 9.5h3.2M18 14.5h3.2"/></svg>`;
const ICON_BACK = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10.5 19.5 3 12m0 0 7.5-7.5M3 12h18"/></svg>`;
const ICON_CHEVRON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>`;
const ICON_LOCK = `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>`;
const ICON_LINK = `<svg class="link" viewBox="0 0 24 24" aria-hidden="true"><path d="M10 13.5a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1.1 1.1"/><path d="M14 10.5a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1.1-1.1"/></svg>`;
const ICON_CHECK = `<svg class="ok" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="currentColor"/><path d="m7.5 12.3 3 3 6-6.3" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const ICON_TROPHY = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4h10v5a5 5 0 0 1-10 0V4Z"/><path d="M7 6H4a3 3 0 0 0 3 4M17 6h3a3 3 0 0 1-3 4M12 14v3M8 20h8M9 17h6"/></svg>`;
const ICON_FLAG = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 21V4m0 0h11l-2 4 2 4H5"/></svg>`;
const ICON_EQUAL = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M8.5 10h7M8.5 14h7"/></svg>`;
const STAR_PATH = "M12 3.3l2.6 5.4 5.9.8-4.3 4.1 1 5.9L12 16.7l-5.2 2.8 1-5.9-4.3-4.1 5.9-.8Z";

// ---------------------------------------------------------------------------------------------
// Pieces of the screens
// ---------------------------------------------------------------------------------------------

function headerHtml(title, trailing = "") {
  // data-chess-t-back: Chess Online's pushed-page back button, styled as its own (round chevron
  // on a phone); ui/chess-tournaments.js hands every click on a bots screen to this module first.
  return `
    <div class="kaposts-header chess-t-header chess-t-header-pushed">
      <button class="kaposts-icon-button" type="button" data-chess-t-back aria-label="Back">${ICON_BACK}</button>
      <h1 class="kaposts-title">${esc(title)}</h1>
      ${trailing}
    </div>`;
}

function avatarHtml(bot, size) {
  return `<span class="chess-bot-avatar" style="--size:${size}px;--from:${bot.colors[0]};--to:${bot.colors[1]}" aria-hidden="true"><span class="chess-bot-initials">${esc(bot.initials)}</span><span class="chess-bot-badge">${bot.level}</span></span>`;
}

function starsHtml(level) {
  let html = "";
  for (let star = 1; star <= 5; star += 1) html += `<svg viewBox="0 0 24 24" class="${star <= level ? "on" : ""}"><path d="${STAR_PATH}"/></svg>`;
  return `<span class="chess-bot-stars" role="img" aria-label="Level ${level} of 5">${html}</span>`;
}

function recordLineHtml(record) {
  return `<span class="chess-bot-record"><span class="w">${record.wins} W</span><span class="l">${record.losses} L</span><span class="d">${record.draws} D</span></span>`;
}

// --- The ladder (ChessBotsView) ---

function renderLadder() {
  const records = loadRecords();
  const cards = CHESS_BOTS.map((bot) => {
    const unlocked = isBotUnlocked(records, bot.level);
    const record = botRecord(records, bot.level);
    const previous = chessBot(bot.level - 1);
    const below = unlocked
      ? `${starsHtml(bot.level)}${record.wins + record.losses + record.draws > 0 ? recordLineHtml(record) : ""}`
      : (previous ? `<span class="chess-bot-unlock">Beat ${esc(previous.name)} to unlock</span>` : "");
    return `
      <button class="chess-bot-card" type="button" data-chess-bot-open="${bot.level}" ${unlocked ? "" : "disabled aria-disabled=\"true\""}>
        ${avatarHtml(bot, 56)}
        <span class="chess-bot-card-main"><strong>${esc(bot.name)}</strong><small>Level ${bot.level} · ${esc(bot.title)}</small>${below}</span>
        <span class="chess-bot-card-trailing">${unlocked ? ICON_CHEVRON : ICON_LOCK}</span>
      </button>`;
  }).join("");
  return `
    ${headerHtml("Bots")}
    <div class="chess-t-body chess-bot-body">
      <div class="chess-t-hero">
        <span class="chess-t-hero-icon">${ICON_CPU}</span>
        <h2>Climb the ladder</h2>
        <p>Five bots, level 1 to 5. Beat one to unlock the next. Every move, yours and the bot's, is a Kaspa transaction.</p>
      </div>
      ${cards}
    </div>`;
}

// --- One bot before a game (ChessBotDetailView) ---

function feeLine(bot) {
  const each = feeText ? `about ${feeText} each` : "one small fee each";
  return `Every move, yours and ${bot.name}'s, is a Kaspa transaction from your wallet, ${each}. Starting and resigning are one transaction too.`;
}

function renderDetail() {
  const bot = currentBot();
  const record = botRecord(loadRecords(), bot.level);
  return `
    ${headerHtml(bot.name)}
    <div class="chess-t-body chess-bot-body">
      <div class="chess-bot-hero">
        ${avatarHtml(bot, 104)}
        <h2>${esc(bot.name)}</h2>
        <span class="chess-bot-level">Level ${bot.level} · ${esc(bot.title)}</span>
        ${starsHtml(bot.level)}
        <p>${esc(bot.bio)}</p>
      </div>
      <div class="chess-bot-panel row"><strong>Your record</strong>${recordLineHtml(record)}</div>
      <div class="chess-bot-panel">
        <strong>Play as</strong>
        <div class="settings-segmented full" role="radiogroup" aria-label="Play as">
          ${SIDE_PREFERENCES.map((option) => `<button class="settings-segmented-option${sidePreference === option ? " active" : ""}" type="button" role="radio" aria-checked="${sidePreference === option}" data-chess-bot-side="${option}">${option}</button>`).join("")}
        </div>
      </div>
      <p class="chess-bot-fee">${ICON_LINK}<span>${esc(feeLine(bot))}</span></p>
      <button class="primary-button chess-bot-play" type="button" data-chess-bot-play>Play ${esc(bot.name)}</button>
    </div>`;
}

// --- The game (ChessBotMatchView) ---

function statusText(g) {
  const bot = g.bot;
  if (g.result) {
    const { kind, why } = g.result;
    if (kind === "won") return `You won by ${why}.`;
    if (kind === "lost") return why === "resignation" ? `You resigned. ${bot.name} wins.` : `${bot.name} won by ${why}.`;
    return `Draw by ${why}.`;
  }
  if (g.sendError != null) return "Couldn't put the last move on Kaspa.";
  if (g.isThinking) return `${bot.name} is thinking…`;
  if (g.outbox.length) return g.moves.length === 0 ? "Starting the game on Kaspa…" : "Putting the move on Kaspa…";
  if (g.board.sideToMove === g.playerColor) {
    return Chess.isKingInCheck(g.board, g.playerColor) ? "Check. Your move." : "Your move";
  }
  return `${bot.name} to move`;
}

function checkedKing(board) {
  const side = board.sideToMove;
  if (!Chess.isKingInCheck(board, side)) return null;
  for (let rank = 0; rank < 8; rank += 1) {
    for (let file = 0; file < 8; file += 1) {
      const piece = board.squares[rank][file];
      if (piece && piece.type === "king" && piece.color === side) return { file, rank };
    }
  }
  return null;
}

/** Short notation, as iOS writes it: O-O, Nf3, exd5, e8=Q. */
function notation(played) {
  const { move, piece, captured } = played;
  if (piece === "king" && Math.abs(move.to.file - move.from.file) === 2) return move.to.file === 6 ? "O-O" : "O-O-O";
  const letters = { pawn: "", knight: "N", bishop: "B", rook: "R", queen: "Q", king: "K" };
  const letter = piece === "pawn" ? (captured ? Chess.algebraic(move.from).slice(0, 1) : "") : letters[piece];
  const promotion = move.promotion ? `=${(Chess.promotionLetter(move.promotion) || "q").toUpperCase()}` : "";
  return `${letter}${captured ? "x" : ""}${Chess.algebraic(move.to)}${promotion}`;
}

function endOverlayHtml(g) {
  const result = g.result;
  const [icon, headline] = result.kind === "won" ? [ICON_TROPHY, "You won!"] : result.kind === "lost" ? [ICON_FLAG, "You lost"] : [ICON_EQUAL, "Draw"];
  const next = result.kind === "won" ? chessBot(g.bot.level + 1) : null;
  const unlockedLine = next && botRecord(loadRecords(), g.bot.level).wins === 1
    ? `<span class="chess-bot-unlocked">${esc(next.name)} is unlocked!</span>` : "";
  return `
    <div class="chess-t-end chess-bot-end ${result.kind}">
      <div class="chess-t-end-card">
        <span class="chess-t-end-icon">${icon}</span>
        <strong>${headline}</strong>
        <small>${esc(statusText(g))}</small>
        ${unlockedLine}
        <div class="chess-bot-end-actions">
          <button class="primary-button" type="button" data-chess-bot-again>Play again</button>
          <button class="secondary-button chess-bot-done" type="button" data-chess-bot-done>Done</button>
        </div>
        <button class="chess-bot-see" type="button" data-chess-bot-see>See the board</button>
      </div>
    </div>`;
}

function renderGame() {
  const g = game;
  if (!g) return renderDetail();
  const bot = g.bot;
  const flipped = g.playerColor === Chess.BLACK;
  const canMove = g.canPlayerMove;
  const destinations = canMove && selectedSquare ? Chess.legalMovesFrom(g.board, selectedSquare).map((m) => m.to) : [];
  const destinationKeys = new Set(destinations.map((s) => `${s.file},${s.rank}`));
  const checked = checkedKing(g.board);
  const last = g.moves.at(-1)?.move;
  const ranks = flipped ? [0, 1, 2, 3, 4, 5, 6, 7] : [7, 6, 5, 4, 3, 2, 1, 0];
  const files = flipped ? [7, 6, 5, 4, 3, 2, 1, 0] : [0, 1, 2, 3, 4, 5, 6, 7];
  let squares = "";
  for (const rank of ranks) {
    for (const file of files) {
      const classes = ["chess-sq", (file + rank) % 2 !== 0 ? "light" : "dark"];
      if (last && ((last.from.file === file && last.from.rank === rank) || (last.to.file === file && last.to.rank === rank))) classes.push("last");
      if (checked && checked.file === file && checked.rank === rank) classes.push("check");
      if (selectedSquare && selectedSquare.file === file && selectedSquare.rank === rank) classes.push("selected");
      const piece = g.board.squares[rank][file];
      squares += `<div class="${classes.join(" ")}" data-chess-bot-sq="${file},${rank}">${piece ? `<span class="chess-piece ${piece.color}">${Chess.PIECE_GLYPHS[piece.type]}</span>` : ""}${destinationKeys.has(`${file},${rank}`) ? `<span class="chess-dot${piece ? " capture" : ""}"></span>` : ""}</div>`;
    }
  }
  const promo = pendingPromotion ? `
    <div class="chess-promo chess-bot-promo" data-chess-bot-promo-cancel>
      <div class="chess-promo-card"><p>Promote to</p><div class="chess-promo-options">
        ${["queen", "rook", "bishop", "knight"].map((type) => `<button type="button" class="${g.playerColor}" data-chess-bot-promo="${type}" aria-label="${type}">${Chess.PIECE_GLYPHS[type]}</button>`).join("")}
      </div></div>
    </div>` : "";

  let chainTrailing;
  if (g.sendError != null) chainTrailing = `<button class="chess-bot-retry" type="button" data-chess-bot-retry>Retry</button>`;
  else if (g.outbox.length) chainTrailing = `<span class="chess-bot-spinner small" role="progressbar" aria-label="Sending"></span>`;
  else chainTrailing = ICON_CHECK;

  const moves = g.moves;
  let moveList = "";
  for (let index = 0; index < moves.length; index += 2) {
    moveList += `<span class="pair"><span class="num">${index / 2 + 1}.</span><span>${esc(notation(moves[index]))}</span>${index + 1 < moves.length ? `<span>${esc(notation(moves[index + 1]))}</span>` : ""}</span>`;
  }
  if (!moveList) moveList = `<span class="empty">${g.playerColor === Chess.WHITE ? "You move first." : `${esc(bot.name)} moves first.`}</span>`;

  const statusClass = g.sendError != null ? " error" : g.isOver ? " muted" : "";
  return `
    ${headerHtml(`Level ${bot.level}`, g.isOver ? "" : `<button class="chess-t-resign" type="button" data-chess-bot-resign>Resign</button>`)}
    <div class="chess-t-body chess-t-game chess-bot-body">
      <div class="chess-bot-game-head">
        ${avatarHtml(bot, 44)}
        <span class="chess-bot-card-main"><strong>${esc(bot.name)}</strong><small>Level ${bot.level} · ${esc(bot.title)} · You play ${g.playerColor === Chess.WHITE ? "white" : "black"}</small></span>
        ${g.isThinking ? `<span class="chess-bot-spinner" role="progressbar" aria-label="Thinking"></span>` : ""}
      </div>
      <p class="chess-bot-status${statusClass}" aria-live="polite">${esc(statusText(g))}</p>
      <div class="chess-board-wrap"><div class="chess-board chess-t-board chess-bot-board${canMove ? "" : " locked"}">${squares}</div>${showEnd && g.result ? endOverlayHtml(g) : ""}${promo}</div>
      <div class="chess-bot-chain">
        <div class="chess-bot-chain-row">${ICON_LINK}<span class="chess-bot-chain-label">${g.movesOnChain} of ${g.moves.length} moves on Kaspa</span>${chainTrailing}</div>
        ${g.sendError != null ? `<p class="chess-bot-chain-error">${esc(g.sendError)}</p>` : ""}
      </div>
      <div class="chess-bot-moves" data-chess-bot-moves>${moveList}</div>
    </div>`;
}

// ---------------------------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------------------------

function onGameChange(g) {
  if (g !== game) return;
  if (g.result && endShownFor !== g) {
    endShownFor = g;
    selectedSquare = null;
    pendingPromotion = null;
    showEnd = true;
  }
  if (screen === "game") requestRender();
}

function newGame() {
  const d = deps();
  if (d.isChattingBalanceZero?.()) { d.showFundingGate?.(); return; }
  const bot = currentBot();
  const playerColor = resolveSide(sidePreference);
  const address = d.engine?.address || "";
  const g = new ChessBotGame({
    bot, playerColor,
    send: (content) => sendContent(content, address),
    think,
    record: (result) => saveResult(bot.level, result.kind),
    onChange: () => onGameChange(g),
    log: (line) => deps().appendEngineLog?.(line),
  });
  game = g;
  screen = "game";
  selectedSquare = null;
  pendingPromotion = null;
  showEnd = false;
  endShownFor = null;
  resetScroll = true;
  requestRender();
  g.start();
}

/** The resign sheet, and behind Back (or another tab) while the game is on, the leave one:
 *  leaving means resigning. Resolves true for Resign. */
async function askResign(leaving) {
  if (asking) return false;
  asking = true;
  try {
    const bot = game?.bot || currentBot();
    const consequence = `It counts as a loss against ${bot.name}. Resigning is one transaction.`;
    return await confirmDialog({
      title: leaving ? "Leave the game?" : "Resign this game?",
      message: leaving ? `If you leave, you resign the game. ${consequence}` : consequence,
      confirmLabel: leaving ? "Resign and leave" : "Resign",
      cancelLabel: leaving ? "Stay" : "Keep playing",
      destructive: true,
    });
  } finally { asking = false; }
}

function go(next) {
  screen = next;
  selectedSquare = null;
  pendingPromotion = null;
  resetScroll = true;
  if (next === "detail") estimateMoveFee().catch(() => {});
  requestRender();
}

async function back() {
  if (screen === "game") {
    const g = game;
    if (g && !g.isOver) {
      if (!(await askResign(true))) return;
      if (g !== game) return;
      g.resign();
    }
    go("detail");
    return;
  }
  if (screen === "detail") { go("ladder"); return; }
  ctx?.exit?.();
}

function tapSquare(file, rank) {
  const g = game;
  if (!g || !g.canPlayerMove) return;
  const mine = g.playerColor;
  const square = { file, rank };
  const piece = Chess.pieceAt(g.board, square);
  if (selectedSquare) {
    const legal = Chess.legalMovesFrom(g.board, selectedSquare).some((m) => Chess.squareEquals(m.to, square));
    if (legal) {
      const from = selectedSquare;
      selectedSquare = null;
      if (Chess.pieceAt(g.board, from)?.type === "pawn" && rank === (mine === Chess.WHITE ? 7 : 0)) {
        pendingPromotion = { from, to: square };
        requestRender();
      } else if (!g.play({ from, to: square, promotion: null })) {
        requestRender();
      }
      return;
    }
    selectedSquare = piece?.color === mine ? square : null;
    requestRender();
    return;
  }
  if (piece?.color === mine) { selectedSquare = square; requestRender(); }
}

// ---------------------------------------------------------------------------------------------
// Hooks for ui/chess-tournaments.js
// ---------------------------------------------------------------------------------------------

/** `dependencies`: Chess Online's deps (engine, escapeHtml, estimateFeeKas, isChattingBalanceZero,
 *  showFundingGate, appendEngineLog, showToast; accountScopedKey when the host passes it).
 *  `render`: repaint Chess Online's screen. `exit`: back to Chess Online's home. */
export function initChessBots({ deps: dependencies, render, exit }) {
  ctx = { deps: dependencies || {}, render, exit };
}

/** The home card opened the bots: the ladder. */
export function openChessBots() {
  screen = "ladder";
  selectedSquare = null;
  pendingPromotion = null;
  resetScroll = true;
}

export function renderChessBots() {
  if (screen === "game" && game) return renderGame();
  if (screen === "detail") return renderDetail();
  return renderLadder();
}

/** After Chess Online painted a bots screen: the move list follows the newest move, and a new
 *  screen starts at the top. */
export function afterChessBotsRender(root) {
  if (!root) return;
  const moves = root.querySelector("[data-chess-bot-moves]");
  if (moves) moves.scrollLeft = moves.scrollWidth;
  if (resetScroll) {
    resetScroll = false;
    const body = root.querySelector(".chess-t-body");
    if (body) body.scrollTop = 0;
  }
}

/** Every click on a bots screen. */
export function chessBotsClick(event) {
  const t = event.target;
  if (t.closest("[data-chess-t-back]")) { back().catch(() => {}); return; }
  const open = t.closest("[data-chess-bot-open]");
  if (open) {
    const level = Number(open.dataset.chessBotOpen);
    if (!isBotUnlocked(loadRecords(), level)) return;
    selectedLevel = level;
    // A fresh detail page starts on White, as iOS's @State does.
    sidePreference = "White";
    go("detail");
    return;
  }
  const side = t.closest("[data-chess-bot-side]");
  if (side) { sidePreference = side.dataset.chessBotSide; requestRender(); return; }
  if (t.closest("[data-chess-bot-play]") || t.closest("[data-chess-bot-again]")) { newGame(); return; }
  if (t.closest("[data-chess-bot-done]")) { go("detail"); return; }
  if (t.closest("[data-chess-bot-see]")) { showEnd = false; requestRender(); return; }
  if (t.closest("[data-chess-bot-retry]")) { game?.retry(); return; }
  if (t.closest("[data-chess-bot-resign]")) {
    const g = game;
    if (!g || g.isOver) return;
    askResign(false).then((ok) => { if (ok && g === game) g.resign(); }).catch(() => {});
    return;
  }
  const promo = t.closest("[data-chess-bot-promo]");
  if (promo) {
    const mv = pendingPromotion;
    pendingPromotion = null;
    if (game && mv && game.play({ from: mv.from, to: mv.to, promotion: promo.dataset.chessBotPromo })) return;
    requestRender();
    return;
  }
  if (t.closest("[data-chess-bot-promo-cancel]") && !t.closest(".chess-promo-card")) { pendingPromotion = null; requestRender(); return; }
  const sq = t.closest("[data-chess-bot-sq]");
  if (sq) {
    const [file, rank] = sq.dataset.chessBotSq.split(",").map(Number);
    tapSquare(file, rank);
  }
}

/** A game on: true when nothing more can be played without resigning. */
export function chessBotsLockedIn() {
  return screen === "game" && Boolean(game) && !game.isOver;
}

/** May the dock take the player away? Only by resigning while a game is on - it asks
 *  ("Leave the game?"); Resign and leave resigns (the resign still goes on chain) and returns
 *  to the bot's page. */
export async function chessBotsMayLeave() {
  if (!chessBotsLockedIn()) return true;
  const g = game;
  const ok = await askResign(true).catch(() => false);
  if (!ok) return false;
  if (g === game && !g.isOver) g.resign();
  go("detail");
  return true;
}

/** Another account: its own record and fee; a game of the old one stops here (nothing more is
 *  sent from the new address for it). */
export function resetChessBotsForAccount() {
  try { game?.dispose(); } catch { /* fine */ }
  game = null;
  screen = "ladder";
  selectedSquare = null;
  pendingPromotion = null;
  showEnd = false;
  endShownFor = null;
  feeText = null;
}
