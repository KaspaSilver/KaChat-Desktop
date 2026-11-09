// KaPlay > Bots (iOS c3c04a1: ChessBotsView, ChessBotDetailView, ChessBotGameView; KaPlay ddec987:
// ChessBotLeaderboardViews, ChessBotLeaderboardService, ChessBotLinks; ONLINE_CHESS.md §7). Five
// bots, level 1 to 5, as a ladder: level 1 is open, each level opens when the one before it is
// beaten (kept on this device, per address). The bot runs here, its search in a Web Worker
// (engine/chess-bot-worker.js), and the game costs nothing while it is played; when it ends, its
// result and moves go on chain in #chess-bots in one transaction, the stamp. A stamped win counts
// on the bot's board and can be shared to KaPost; the post's challenge link opens the bot here.
//
// The screens live inside Chess Online's own screen (ui/chess-tournaments.js): its home card
// opens them, its render() paints renderChessBots() while view.name is "bots", and its click,
// leave and account-reset hooks call the exports below. The board, header and cards reuse its
// look (.chess-board, .chess-t-*).

import "./chess-bots.css";
import * as Chess from "../engine/chess.js";
import {
  CHESS_BOTS, CHESS_BOTS_CHANNEL, chessBot, SIDE_PREFERENCES, resolveSide, botRecord, isBotUnlocked,
  addBotResult, parseBotRecords, addStampedWin, parseStampedWins, indexerBotBoards, botBoardRows, botHasBeenPlayed,
  sampleStampContent, chessBotBestMove, ChessBotGame,
} from "../engine/chess-bot.js";
import { botSharePostText, botChallengeBannerText } from "../engine/chess-bot-links.js";
import { LEADERBOARD_PERIODS } from "../engine/chess-tournament.js";
import { sendBroadcastMessage, broadcastPayloadBytes } from "../engine/broadcasts.js";
import { confirmDialog } from "./dialogs.js";
import { KAS_UNIT } from "../engine/network.js";
import { getEndpoint } from "../engine/endpoints.js";

/** Level -> { wins, losses, draws }, under the account's scope (iOS keeps address -> level ->
 *  record in one UserDefaults entry; here the scope is the address). */
const RECORDS_KEY = "kachat-chess-bots-v1";
/** Level -> [{ moves, at }]: the stamped wins (ChessBotProgress.stampedWins), per account. */
const STAMPED_WINS_KEY = "kachat-chess-bot-stamped-wins-v1";
/** ui/app.js's accountScopedKey prefix, for when the host passes no accountScopedKey. */
const ACCOUNT_DATA_PREFIX = "kachat-account-data-v1";

let ctx = null;                // { deps, render, exit }
let screen = "ladder";         // ladder | detail | game | boards | board
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
let challenge = null;          // a challenge link on screen (engine/chess-bot-links.js), its banner up
let boards = {};               // period -> level -> { games, rows }: the indexer's boards
let boardLevel = 1;
let boardPeriod = "month";     // This month whenever a board comes up (iOS @State)
let lastBoardsFetch = 0;
let boardsSerial = 0;

const deps = () => ctx?.deps || {};
const esc = (v) => (deps().escapeHtml ? deps().escapeHtml(String(v ?? "")) : String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])));
const requestRender = () => { try { ctx?.render?.(); } catch { /* not on screen */ } };
const currentBot = () => chessBot(selectedLevel) || CHESS_BOTS[0];

// ---------------------------------------------------------------------------------------------
// Record (ChessBotProgress)
// ---------------------------------------------------------------------------------------------

/** `address`: whose data (a game's own account, which may no longer be the one on); the account
 *  on now when left out. */
function accountKey(key, address = deps().engine?.address) {
  const d = deps();
  const clean = String(address || "").trim();
  if (typeof d.accountScopedKey === "function") return d.accountScopedKey(key, clean);
  return clean ? `${ACCOUNT_DATA_PREFIX}:${clean}:${key}` : key;
}
function recordsKey(address) { return accountKey(RECORDS_KEY, address); }
function loadRecords(address) {
  try { return parseBotRecords(localStorage.getItem(recordsKey(address))); } catch { return {}; }
}
function saveResult(level, kind, address) {
  const next = addBotResult(loadRecords(address), level, kind);
  try { localStorage.setItem(recordsKey(address), JSON.stringify(next)); } catch { /* storage blocked: this session only */ }
}
function loadStampedWins(address) {
  try { return parseStampedWins(localStorage.getItem(accountKey(STAMPED_WINS_KEY, address))); } catch { return {}; }
}
function saveStampedWin(level, moves, address) {
  const next = addStampedWin(loadStampedWins(address), level, moves, Date.now());
  try { localStorage.setItem(accountKey(STAMPED_WINS_KEY, address), JSON.stringify(next)); } catch { /* storage blocked: the indexer will have it */ }
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
  return sendBroadcastMessage({ engine, channel: CHESS_BOTS_CHANNEL, content, feeKas: "0", singleInput: true });
}

/** The "about 0.0017 KAS" figure (ChessBotCodec.stampFeeText): a game of 40 moves a side. */
async function estimateStampFee() {
  if (feeText || feeEstimating || !deps().estimateFeeKas) return;
  feeEstimating = true;
  try {
    const fee = await deps().estimateFeeKas(broadcastPayloadBytes(CHESS_BOTS_CHANNEL, sampleStampContent()), { singleInput: true });
    if (fee != null && Number.isFinite(Number(fee))) { feeText = `${Number(fee).toFixed(4)} ${KAS_UNIT}`; requestRender(); }
  } catch { /* "one small fee" */ } finally { feeEstimating = false; }
}

// ---------------------------------------------------------------------------------------------
// The boards (ChessBotLeaderboardService, ONLINE_CHESS.md §7.1)
// ---------------------------------------------------------------------------------------------

const BOARDS_MIN_MS = 20_000;

/** GET /chess/bots/leaderboard?period=month|all&limit=100. At most every 20 s; any failure leaves
 *  what is there in place. */
function refreshBoards() {
  if (lastBoardsFetch && Date.now() - lastBoardsFetch < BOARDS_MIN_MS) return;
  const base = String(getEndpoint("broadcastIndexer") || "").trim().replace(/\/+$/, "");
  if (!base) return;
  lastBoardsFetch = Date.now();
  const serial = ++boardsSerial;
  (async () => {
    for (const period of LEADERBOARD_PERIODS) {
      let levels = null;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);
      try {
        const url = new URL(`${base}/chess/bots/leaderboard`);
        url.searchParams.set("period", period);
        url.searchParams.set("limit", "100");
        const response = await fetch(url, { headers: { Accept: "application/json" }, cache: "no-store", signal: controller.signal });
        if (response.ok) levels = indexerBotBoards(await response.json(), period);
      } catch { levels = null; }
      finally { clearTimeout(timer); }
      if (serial !== boardsSerial) return;
      if (!levels) continue;
      boards = { ...boards, [period]: levels };
      if (screen === "boards" || screen === "board") requestRender();
    }
  })().catch(() => {});
}

function boardRows(level, period) {
  return botBoardRows({ boards, level, period, wins: loadStampedWins(), address: deps().engine?.address || "", nowMs: Date.now() });
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
const ICON_SHARE = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15V3.5M8 7l4-4 4 4M7.5 10.5H6a1.5 1.5 0 0 0-1.5 1.5v7.5A1.5 1.5 0 0 0 6 21h12a1.5 1.5 0 0 0 1.5-1.5V12a1.5 1.5 0 0 0-1.5-1.5h-1.5"/></svg>`;
const ICON_CROSSED_FLAGS = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 21 15.5 4.5M15.5 4.5 21 8l-3.5 3.8L13 10.5M20 21 8.5 4.5M8.5 4.5 3 8l3.5 3.8 4.5-1.3"/></svg>`;
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

/** What a challenge asks, at the top of the screen it opened (ChessBotChallengeBanner). */
function challengeBannerHtml() {
  const bot = chessBot(challenge?.level);
  if (!bot) return "";
  const text = botChallengeBannerText({
    challenge, botName: bot.name, who: challenge.by ? (deps().displayNameFor?.(challenge.by) || challenge.by) : "",
    unlocked: isBotUnlocked(loadRecords(), bot.level),
  });
  return `<div class="chess-bot-challenge">${ICON_CROSSED_FLAGS}<span>${esc(text)}</span></div>`;
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
        <p>Five bots, level 1 to 5. Beat one to unlock the next. Each game's result is stamped on Kaspa when it ends.</p>
      </div>
      ${challenge ? challengeBannerHtml() : ""}
      ${cards}
    </div>`;
}

// --- One bot before a game (ChessBotDetailView) ---

function feeLine() {
  const fee = feeText ? `about ${feeText}` : "one small fee";
  return `The game itself is free. When it ends, win or lose, its result is stamped on Kaspa: one transaction from your wallet, ${fee}.`;
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
      ${challenge?.level === bot.level ? challengeBannerHtml() : ""}
      <div class="chess-bot-panel row"><strong>Your record</strong>${recordLineHtml(record)}</div>
      <div class="chess-bot-panel">
        <strong>Play as</strong>
        <div class="settings-segmented full" role="radiogroup" aria-label="Play as">
          ${SIDE_PREFERENCES.map((option) => `<button class="settings-segmented-option${sidePreference === option ? " active" : ""}" type="button" role="radio" aria-checked="${sidePreference === option}" data-chess-bot-side="${option}">${option}</button>`).join("")}
        </div>
      </div>
      <p class="chess-bot-fee">${ICON_LINK}<span>${esc(feeLine())}</span></p>
      <button class="primary-button chess-bot-play" type="button" data-chess-bot-play>Play ${esc(bot.name)}</button>
    </div>`;
}

// --- The game (ChessBotMatchView) ---

function statusText(g) {
  const bot = g.bot;
  if (g.result) {
    const { kind, why } = g.result;
    if (kind === "won") return `You won by ${why} in ${g.playerMoveCount} moves.`;
    if (kind === "lost") return why === "resignation" ? `You resigned. ${bot.name} wins.` : `${bot.name} won by ${why}.`;
    return `Draw by ${why}.`;
  }
  if (g.isThinking) return `${bot.name} is thinking…`;
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

/** Share to KaPost, once the win is on chain: what the post shows off can be looked up. */
function shareButtonHtml(g) {
  // May have gone through (iOS 4922804): no Retry - a second stamp of the same game - and nothing
  // to share until it is known to be on chain.
  const title = g.stamp === "stamped" ? "Share to KaPost" : g.stamp === "failed" ? "Retry the stamp" : g.stamp === "unconfirmed" ? "Not confirmed" : "Stamping the result…";
  const waiting = g.stamp === "sending" || g.stamp === "none" || g.stamp === "unconfirmed";
  return `<button class="chess-bot-share" type="button" data-chess-bot-share ${waiting ? "disabled" : ""}>${ICON_SHARE}<span>${title}</span></button>`;
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
        ${result.kind === "won" ? shareButtonHtml(g) : ""}
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

  let chainTrailing = "";
  if (g.stamp === "failed") chainTrailing = `<button class="chess-bot-retry" type="button" data-chess-bot-retry>Retry</button>`;
  else if (g.stamp === "sending") chainTrailing = `<span class="chess-bot-spinner small" role="progressbar" aria-label="Sending"></span>`;
  else if (g.stamp === "stamped") chainTrailing = ICON_CHECK;
  else if (g.stamp === "unconfirmed") chainTrailing = `<span class="chess-bot-unconfirmed" role="img" aria-label="Not confirmed" style="color: var(--ios-orange); font-weight: 700">?</span>`;
  const chainText = {
    none: "The result goes on Kaspa when the game ends",
    sending: "Stamping the result on Kaspa…",
    stamped: "Result stamped on Kaspa",
    failed: "Couldn't stamp the result on Kaspa",
    unconfirmed: "The stamp may have gone through",
  }[g.stamp];

  const moves = g.moves;
  let moveList = "";
  for (let index = 0; index < moves.length; index += 2) {
    moveList += `<span class="pair"><span class="num">${index / 2 + 1}.</span><span>${esc(notation(moves[index]))}</span>${index + 1 < moves.length ? `<span>${esc(notation(moves[index + 1]))}</span>` : ""}</span>`;
  }
  if (!moveList) moveList = `<span class="empty">${g.playerColor === Chess.WHITE ? "You move first." : `${esc(bot.name)} moves first.`}</span>`;

  const statusClass = g.isOver ? " muted" : "";
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
        <div class="chess-bot-chain-row">${ICON_LINK}<span class="chess-bot-chain-label">${chainText}</span>${chainTrailing}</div>
        ${g.stamp === "failed" ? `<p class="chess-bot-chain-error">${esc(g.stampError)}</p>` : ""}
        ${g.stamp === "unconfirmed" ? `<p class="chess-bot-chain-note field-hint">${esc(g.stampError)}</p>` : ""}
      </div>
      <div class="chess-bot-moves" data-chess-bot-moves>${moveList}</div>
    </div>`;
}

// --- Leaderboard > Bots: the bots that have been played (ChessBotLeaderboardsView) ---

function renderBoards() {
  const records = loadRecords();
  const played = CHESS_BOTS.filter((bot) => botHasBeenPlayed({ records, boards, level: bot.level }));
  const rows = played.map((bot) => {
    const best = boardRows(bot.level, "all")[0];
    return `
      <button class="chess-bot-card" type="button" data-chess-bot-board="${bot.level}">
        ${avatarHtml(bot, 44)}
        <span class="chess-bot-card-main"><strong>${esc(bot.name)}</strong><small>${best ? `Best: ${best.moves} moves` : "Not beaten yet"}</small></span>
        <span class="chess-bot-card-trailing">${ICON_CHEVRON}</span>
      </button>`;
  }).join("");
  return `
    ${headerHtml("Bots")}
    <div class="chess-t-body chess-bot-body">
      ${played.length ? "" : `<p class="field-hint">No bot has been played yet.</p>`}
      ${rows}
      <p class="field-hint">Ranked by the fewest moves to win.</p>
    </div>`;
}

// --- One bot's board (ChessBotLeaderboardView) ---

function renderBoard() {
  const bot = chessBot(boardLevel) || CHESS_BOTS[0];
  const month = boardPeriod === "month";
  const rows = boardRows(bot.level, boardPeriod);
  const my = String(deps().engine?.address || "");
  const nameOf = (address) => deps().displayNameFor?.(address) || address;
  const options = [["month", "This month"], ["all", "All time"]];
  return `
    ${headerHtml(bot.name)}
    <div class="chess-t-body chess-bot-body">
      <div class="settings-segmented full chess-t-segment" role="radiogroup" aria-label="Leaderboard period">
        ${options.map(([id, label]) => `<button class="settings-segmented-option${boardPeriod === id ? " active" : ""}" type="button" role="radio" aria-checked="${boardPeriod === id}" data-chess-bot-period="${id}">${esc(label)}</button>`).join("")}
      </div>
      ${month ? `<p class="field-hint chess-t-period-note">Resets on the 1st of every month (UTC).</p>` : ""}
      <p class="screen-kicker">Fewest moves to beat ${esc(bot.name)}</p>
      ${rows.length ? "" : `<p class="field-hint">${esc(month ? `Nobody has beaten ${bot.name} this month yet.` : `Nobody has beaten ${bot.name} yet.`)}</p>`}
      <div class="chess-t-list">
        ${rows.map((row, index) => `
          <button class="chess-t-row${row.address === my ? " me" : ""}" type="button" data-chess-bot-user="${esc(row.address)}">
            <span class="chess-t-rank">${index + 1}</span>
            ${deps().avatarHtmlFor?.(row.address, "chess-t-avatar") || ""}
            <span class="chess-t-row-main"><strong>${esc(nameOf(row.address))}</strong></span>
            <span class="chess-bot-board-moves">${row.moves} moves</span>
          </button>`).join("")}
      </div>
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
  const bot = currentBot();
  const playerColor = resolveSide(sidePreference);
  const address = d.engine?.address || "";
  const g = new ChessBotGame({
    bot, playerColor,
    send: (content) => sendContent(content, address),
    isAccepted: async (txId) => (await ctx.lookUpTransaction(txId)).status === "accepted",
    think,
    // Into the record of the account the game was played under: a stamp still going out after
    // Play again and an account switch is not the new account's win.
    record: (result) => saveResult(bot.level, result.kind, address),
    recordStampedWin: (moves) => saveStampedWin(bot.level, moves, address),
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
    const consequence = `It counts as a loss against ${bot.name}, and the result goes on Kaspa in one transaction.`;
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
  if (next === "detail") estimateStampFee().catch(() => {});
  if (next === "boards" || next === "board") refreshBoards();
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
  if (screen === "detail") {
    // A challenge that opened this bot's screen ends with it; one that opened on the ladder, because
    // its bot is still locked, stays up there.
    if (challenge?.level === selectedLevel) challenge = null;
    go("ladder");
    return;
  }
  if (screen === "board") { go("boards"); return; }
  if (screen === "boards") { ctx?.exit?.("leaderboard"); return; }
  challenge = null;
  ctx?.exit?.();
}

/** Share to KaPost (ChessBotLinks.shareToKaPost): KaPost's composer with the post written; the
 *  player still taps Post there. KaPost is in this app, so no kaposts://compose link. */
function shareWin(g) {
  const by = deps().engine?.address;
  if (!by) return;
  deps().openKaPostComposer?.(botSharePostText({ level: g.bot.level, botName: g.bot.name, moves: g.playerMoveCount, by, gameId: g.id }));
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
export function initChessBots({ deps: dependencies, render, exit, lookUpTransaction }) {
  ctx = { deps: dependencies || {}, render, exit, lookUpTransaction };
}

/** The home card opened the bots: the ladder. */
export function openChessBots() {
  screen = "ladder";
  challenge = null;
  selectedSquare = null;
  pendingPromotion = null;
  resetScroll = true;
}

/** The Leaderboard's Bots square: a board per played bot. */
export function openChessBotBoards() {
  go("boards");
}

/** A challenge link (ChessHomeView.takeChallenge): that bot's screen with the challenge at the top,
 *  or the ladder if the bot is still locked, which says who to beat first. */
export function openChessBotChallengeScreen(link) {
  challenge = link;
  if (isBotUnlocked(loadRecords(), link.level)) {
    selectedLevel = link.level;
    sidePreference = "White";
    go("detail");
  } else go("ladder");
}

export function renderChessBots() {
  if (screen === "game" && game) return renderGame();
  if (screen === "detail") return renderDetail();
  if (screen === "boards") return renderBoards();
  if (screen === "board") return renderBoard();
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
  const board = t.closest("[data-chess-bot-board]");
  if (board) {
    boardLevel = Number(board.dataset.chessBotBoard);
    boardPeriod = "month";
    go("board");
    return;
  }
  const period = t.closest("[data-chess-bot-period]");
  if (period) { boardPeriod = period.dataset.chessBotPeriod; requestRender(); return; }
  // A board's row: the same User Info sheet a public chat opens from View Profile.
  const user = t.closest("[data-chess-bot-user]");
  if (user) { deps().openUserInfo?.(user.dataset.chessBotUser); return; }
  const side = t.closest("[data-chess-bot-side]");
  if (side) { sidePreference = side.dataset.chessBotSide; requestRender(); return; }
  if (t.closest("[data-chess-bot-play]") || t.closest("[data-chess-bot-again]")) { newGame(); return; }
  if (t.closest("[data-chess-bot-done]")) { go("detail"); return; }
  if (t.closest("[data-chess-bot-see]")) { showEnd = false; requestRender(); return; }
  if (t.closest("[data-chess-bot-retry]")) { game?.retry(); return; }
  if (t.closest("[data-chess-bot-share]")) {
    const g = game;
    if (g?.stamp === "stamped") shareWin(g);
    else if (g?.stamp === "failed") g.retry();
    return;
  }
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
 *  ("Leave the game?"); Resign and leave resigns (the result still goes on chain) and returns
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

/** Another account: its own record, wins and fee; a game of the old one stops here (nothing more
 *  is sent from the new address for it). */
export function resetChessBotsForAccount() {
  try { game?.dispose(); } catch { /* fine */ }
  game = null;
  screen = "ladder";
  selectedSquare = null;
  pendingPromotion = null;
  showEnd = false;
  endShownFor = null;
  feeText = null;
  challenge = null;
}
