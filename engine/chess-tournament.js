// Chess tournaments (CHESS_TOURNAMENTS.md, iOS 334cdd1 / 7dc84bb): the wire codec and the
// rules as one pure reducer. Every device runs this over the same `#chess-arena` rows in the
// same order and lands on the same bracket, boards, clocks and results - there is no referee.
// A port of iOS ChessTournamentModels.swift + ChessTournamentEngine.swift; keep it byte for
// byte, the indexer's leaderboard is a port of the same file.

import { sha256 } from "@noble/hashes/sha2.js";
import {
  WHITE, BLACK, opposite, squareFromAlgebraic, algebraic, promotionFromLetter, promotionLetter,
  initialBoard, pieceAt, applyMove, isLegalMove, normalizingPromotion, isCheckmate, isStalemate,
  isInsufficientMaterial, squareEquals,
} from "./chess.js";

export const ARENA_CHANNEL = "chess-arena";
export const PLAYER_COUNT = 8;
export const CLOCK_MS = 5 * 60 * 1000;
export const NAME_MAX_LENGTH = 40;
export const CHAT_MAX_LENGTH = 280;
/** Propagation is nobody's thinking time: ten seconds off every move's charge. */
export const MOVE_DELAY_MS = 10 * 1000;
/** A side's first move (ply 1 and 2) has 25 s before its clock runs - the gate on a
 *  simultaneous join, so nobody loses time before their screen has shown the board. */
export const FIRST_MOVE_GRACE_MS = 25 * 1000;
/** The allowances apply to games started at or after this instant (2026-09-24 00:00 UTC);
 *  earlier games have none. A rule change never reaches back (iOS 2641f2e). */
export const ALLOWANCE_FROM_MS = 1_790_208_000_000;
/** From 2026-09-24 20:00 UTC: 10 s on every move, the first included - the match-found
 *  countdown covers the start, so no separate grace holds the clock (iOS 11ac2b7). */
export const ALLOWANCE_V2_FROM_MS = 1_790_280_000_000;
/** "Match found": the ten seconds between the game's start block time and the board opening
 *  on every device together - equal to the move delay, so white's first move is charged from
 *  the moment the board is up and not before. */
export const MATCH_FOUND_DELAY_MS = 10 * 1000;
/** A seat in a waiting room lasts five minutes from the join. */
export const SEAT_TTL_MS = 5 * 60 * 1000;
export function allowanceMs(ply, startedAt) {
  if (startedAt >= ALLOWANCE_V2_FROM_MS) return MOVE_DELAY_MS;
  if (startedAt < ALLOWANCE_FROM_MS) return 0;
  return ply <= 2 ? FIRST_MOVE_GRACE_MS : MOVE_DELAY_MS;
}

// ---------------------------------------------------------------------------------------------
// Public rooms and private tournaments (§2.1)
// ---------------------------------------------------------------------------------------------

const PUBLIC_ID_PREFIX = "public-";
/** Public 1v1 rooms: the same queue, two seats: `duel-1`, `duel-2`, ... (iOS 10f3926). */
const DUEL_ID_PREFIX = "duel-";
function numberOf(id, prefix) {
  if (!String(id || "").startsWith(prefix)) return null;
  const rest = String(id).slice(prefix.length);
  if (!/^\d+$/.test(rest)) return null;
  const n = Number(rest);
  return n >= 1 ? n : null;
}
export function publicId(number) { return `${PUBLIC_ID_PREFIX}${number}`; }
export function duelId(number) { return `${DUEL_ID_PREFIX}${number}`; }
export function publicNumber(id) { return numberOf(id, PUBLIC_ID_PREFIX); }
export function duelNumber(id) { return numberOf(id, DUEL_ID_PREFIX); }
/** Public = a numbered room of either kind. */
export function isPublicId(id) { return publicNumber(id) !== null || duelNumber(id) !== null; }

/** The creator code for private tournaments. The chain carries only `k` = SHA-256(CODE:id),
 *  so the code never appears on chain. Change it on every platform to rotate it. */
export const PRIVATE_CREATE_CODE = "KACHAT-CHESS";

export function createKey(code, id) {
  const input = `${String(code || "").trim().toUpperCase()}:${id}`;
  const digest = sha256(new TextEncoder().encode(input));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("").slice(0, 24);
}
export function isValidCreateKey(key, id) {
  if (!key) return false;
  return key === createKey(PRIVATE_CREATE_CODE, id);
}

/** Private ids are short and shareable: eight lowercase letters and digits, no confusables. */
export function newPrivateId() {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

// ---------------------------------------------------------------------------------------------
// Wire protocol (§2)
// ---------------------------------------------------------------------------------------------

/** Keys sorted, slashes unescaped - the same bytes iOS's JSONEncoder emits. */
export function encodeMessage(message) {
  const clean = {};
  for (const key of Object.keys(message).sort()) {
    if (message[key] === null || message[key] === undefined) continue;
    clean[key] = message[key];
  }
  return JSON.stringify(clean);
}

/** Cheap gate first (this runs over every arena row), then the decode. */
export function decodeMessage(content) {
  const text = String(content || "");
  if (text.length > 2048 || !text.startsWith("{") || !text.includes('"chess_t"')) return null;
  let parsed;
  try { parsed = JSON.parse(text); } catch { return null; }
  if (!parsed || typeof parsed !== "object") return null;
  if (parsed.type !== "chess_t" || parsed.v !== 1) return null;
  if (typeof parsed.t !== "string" || !parsed.t || parsed.t.length > 64) return null;
  if (typeof parsed.a !== "string") return null;
  const str = (v) => (typeof v === "string" ? v : null);
  return {
    type: "chess_t", v: 1, t: parsed.t, a: parsed.a,
    name: str(parsed.name), g: str(parsed.g),
    n: Number.isInteger(parsed.n) ? parsed.n : null,
    p: Number.isInteger(parsed.p) ? parsed.p : null,
    from: str(parsed.from), to: str(parsed.to), promo: str(parsed.promo),
    text: str(parsed.text), k: str(parsed.k),
  };
}

export const messages = {
  create: (id, name, code) => ({ type: "chess_t", v: 1, t: id, a: "create", name: String(name).slice(0, NAME_MAX_LENGTH), k: createKey(code, id), p: PLAYER_COUNT }),
  /** A private 1v1 needs no creator code: anyone can open one for a friend. */
  createDuel: (id, name) => ({ type: "chess_t", v: 1, t: id, a: "create", name: String(name).slice(0, NAME_MAX_LENGTH), p: 2 }),
  join: (id) => ({ type: "chess_t", v: 1, t: id, a: "join" }),
  leave: (id) => ({ type: "chess_t", v: 1, t: id, a: "leave" }),
  cancel: (id) => ({ type: "chess_t", v: 1, t: id, a: "cancel" }),
  move: (id, game, ply, from, to, promo) => ({ type: "chess_t", v: 1, t: id, a: "move", g: game, n: ply, from, to, promo: promo || null }),
  resign: (id, game) => ({ type: "chess_t", v: 1, t: id, a: "resign", g: game }),
  claim: (id, game) => ({ type: "chess_t", v: 1, t: id, a: "claim", g: game }),
  chat: (id, game, text) => ({ type: "chess_t", v: 1, t: id, a: "chat", g: game || "", text: String(text).slice(0, CHAT_MAX_LENGTH) }),
};

// ---------------------------------------------------------------------------------------------
// Derived state (§3-4)
// ---------------------------------------------------------------------------------------------

export function isDuel(t) { return t.capacity === 2; }
export function roundsOf(t) { return isDuel(t) ? 1 : 3; }
export function finalGameId(t) { return `${roundsOf(t)}-0`; }
export function tournamentStatus(t) {
  if (t.cancelled) return "cancelled";
  if (t.startedAt == null) return "open";
  const final = t.games[finalGameId(t)];
  if (final && final.winner) return "finished";
  return "live";
}
export function champion(t) { return t.games[finalGameId(t)]?.winner || null; }
export function seatsLeft(t) { return Math.max(0, t.capacity - t.players.length); }
export function isFull(t) { return t.players.length >= t.capacity; }
export function seedOf(t, address) { const i = t.players.indexOf(address); return i < 0 ? null : i + 1; }
export function gamesInRound(t, round) {
  const count = isDuel(t) ? 1 : round === 1 ? 4 : round === 2 ? 2 : 1;
  const out = [];
  for (let i = 0; i < count; i += 1) { const g = t.games[`${round}-${i}`]; if (g) out.push(g); }
  return out;
}
/** The game `address` is playing (or waiting to play) right now, if any. */
export function currentGameFor(t, address) {
  for (const round of [3, 2, 1]) {
    const game = gamesInRound(t, round).find((g) => g.white === address || g.black === address);
    if (game) return game;
  }
  return null;
}

export function playerToMove(game) { return game.board.sideToMove === WHITE ? game.white : game.black; }
export function addressOf(game, color) { return color === WHITE ? game.white : game.black; }
export function colorOf(game, address) {
  if (address === game.white) return WHITE;
  if (address === game.black) return BLACK;
  return null;
}
export function usedMs(game, color) { return color === WHITE ? game.whiteUsedMs : game.blackUsedMs; }
/** What the side to move is charged for `elapsed` ms since the last event: the time past this
 *  ply's allowance. */
export function chargedMs(game, elapsed) {
  return Math.max(0, elapsed - allowanceMs(game.moves.length + 1, game.startedAt));
}
/** Remaining clock for `color` at chain time `now` (or wall time, for display). */
export function remainingMs(game, color, now) {
  let used = usedMs(game, color);
  if (!game.winner && color === game.board.sideToMove) used += chargedMs(game, now - game.lastEventAt);
  return Math.max(0, CLOCK_MS - used);
}
/** The allowance still unspent on the current move ("clock starts in 0:12"); zero once the
 *  clock is running. */
export function allowanceLeftMs(game, now) {
  if (game.winner) return 0;
  return Math.max(0, allowanceMs(game.moves.length + 1, game.startedAt) - Math.max(0, now - game.lastEventAt));
}
/** The players whose seats are still good at `now`: while a room waits, a seat older than
 *  SEAT_TTL_MS has expired. Once the room has started every player stays. */
export function seatedPlayers(t, now) {
  if (tournamentStatus(t) !== "open") return t.players;
  return t.players.filter((p) => (t.joinedAt[p] ?? t.createdAt) + SEAT_TTL_MS > now);
}
export function isSeated(t, address, now) { return seatedPlayers(t, now).includes(address); }
/** When `address`'s seat runs out, while waiting. */
export function seatExpiry(t, address) {
  if (tournamentStatus(t) !== "open" || !t.players.includes(address)) return null;
  return (t.joinedAt[address] ?? t.createdAt) + SEAT_TTL_MS;
}

/** Chain order: block time, then txid - the same on every device. */
export function ordered(events) {
  return [...events].sort((a, b) => {
    if (a.blockTime !== b.blockTime) return a.blockTime < b.blockTime ? -1 : 1;
    return a.txId < b.txId ? -1 : a.txId > b.txId ? 1 : 0;
  });
}

export function reduce(events) {
  const tournaments = {};
  for (const event of ordered(events)) apply(event, tournaments);
  return tournaments;
}

function newTournament({ id, name, creator, createdAt, createTxId, capacity }) {
  return { id, name, creator, createdAt, createTxId, capacity, players: [], joinedAt: {}, startedAt: null, cancelled: false, games: {}, chat: [], whiteCount: {} };
}

/** Seats that ran out while the room waited are given back - judged at a join's block time,
 *  the same on every device. */
function expireSeats(t, time) {
  const kept = t.players.filter((p) => (t.joinedAt[p] ?? t.createdAt) + SEAT_TTL_MS > time);
  if (kept.length === t.players.length) return;
  for (const gone of t.players) if (!kept.includes(gone)) delete t.joinedAt[gone];
  t.players = kept;
}

export function apply(event, tournaments) {
  const m = event.message;
  switch (m.a) {
    case "create": {
      // Public rooms are never created by message. A private tournament (8) needs the creator
      // key; a private 1v1 (2) is open to anyone.
      const capacity = m.p === 2 ? 2 : PLAYER_COUNT;
      if (tournaments[m.t] || isPublicId(m.t) || !(capacity === 2 || isValidCreateKey(m.k, m.t))) return;
      const trimmed = String(m.name || "").trim();
      const t = newTournament({
        id: m.t,
        name: trimmed ? trimmed.slice(0, NAME_MAX_LENGTH) : (capacity === 2 ? "1v1" : "Tournament"),
        creator: event.sender, createdAt: event.blockTime, createTxId: event.txId, capacity,
      });
      t.players = [event.sender];
      t.joinedAt[event.sender] = event.blockTime;
      tournaments[m.t] = t;
      return;
    }
    case "join": {
      if (!tournaments[m.t]) {
        // The first join opens a public room - whichever number it names. Which room is
        // "current" is a client choice (the lowest open room; see the UI module), so a device
        // missing the early rooms still agrees with the others (iOS d2ab780).
        const number = publicNumber(m.t);
        const duel = duelNumber(m.t);
        if (number !== null) {
          tournaments[m.t] = newTournament({ id: m.t, name: `Public tournament #${number}`, creator: event.sender, createdAt: event.blockTime, createTxId: event.txId, capacity: PLAYER_COUNT });
        } else if (duel !== null) {
          tournaments[m.t] = newTournament({ id: m.t, name: `Public 1v1 #${duel}`, creator: event.sender, createdAt: event.blockTime, createTxId: event.txId, capacity: 2 });
        }
      }
      const t = tournaments[m.t];
      if (!t || tournamentStatus(t) !== "open") return;
      // Seats that ran out while the room waited are given back first, so a room can never
      // fill with players who left long ago, and a returning player takes a fresh seat.
      expireSeats(t, event.blockTime);
      if (t.players.includes(event.sender)) return;
      t.players.push(event.sender);
      t.joinedAt[event.sender] = event.blockTime;
      if (t.players.length === t.capacity) start(t, event.blockTime);
      return;
    }
    case "leave": {
      // A seat given back while the room is still waiting. Once it has started there is no
      // leaving - only resigning the game.
      const t = tournaments[m.t];
      if (!t || tournamentStatus(t) !== "open") return;
      const index = t.players.indexOf(event.sender);
      if (index < 0) return;
      t.players.splice(index, 1);
      delete t.joinedAt[event.sender];
      return;
    }
    case "cancel": {
      const t = tournaments[m.t];
      if (!t || tournamentStatus(t) !== "open" || isPublicId(t.id) || t.creator !== event.sender) return;
      t.cancelled = true;
      return;
    }
    case "move": {
      const t = tournaments[m.t];
      if (!t || tournamentStatus(t) !== "live" || !m.g) return;
      const game = t.games[m.g];
      if (!game || game.winner || playerToMove(game) !== event.sender) return;
      if (m.n == null || m.n !== game.moves.length + 1) return;
      const from = m.from ? squareFromAlgebraic(m.from) : null;
      const to = m.to ? squareFromAlgebraic(m.to) : null;
      if (!from || !to) return;
      // A move after the mover's clock ran out is void: the opponent's claim decides. Charged
      // past the move's allowance (25 s for a side's first move, ten seconds after).
      const elapsed = chargedMs(game, event.blockTime - game.lastEventAt);
      const remaining = CLOCK_MS - usedMs(game, game.board.sideToMove);
      if (!(elapsed < remaining)) return;
      let mv = { from, to, promotion: promotionFromLetter(m.promo) };
      mv = normalizingPromotion(game.board, mv);
      const piece = pieceAt(game.board, from);
      if (!isLegalMove(game.board, mv) || !piece) return;
      const target = pieceAt(game.board, to);
      const isEnPassant = piece.type === "pawn" && game.board.enPassantTarget && squareEquals(to, game.board.enPassantTarget) && !target;
      const captured = target ? target.type : (isEnPassant ? "pawn" : null);
      const mover = game.board.sideToMove;
      game.board = applyMove(game.board, mv);
      if (mover === WHITE) game.whiteUsedMs += elapsed; else game.blackUsedMs += elapsed;
      game.lastEventAt = event.blockTime;
      game.moves.push({
        txId: event.txId, ply: m.n, color: mover, from, to, promotion: mv.promotion || null,
        pieceType: piece.type, captured, blockTime: event.blockTime,
        clockAfterMs: CLOCK_MS - usedMs(game, mover),
      });
      game.halfmoveClock = (piece.type === "pawn" || captured) ? 0 : game.halfmoveClock + 1;
      const key = positionKey(game.board);
      game.positionCounts[key] = (game.positionCounts[key] || 0) + 1;

      if (isCheckmate(game.board)) finish(game, addressOf(game, mover), { kind: "checkmate" }, event.blockTime);
      else if (isStalemate(game.board)) finishDraw(game, "stalemate", event.blockTime);
      else if (isInsufficientMaterial(game.board)) finishDraw(game, "insufficient material", event.blockTime);
      else if (game.halfmoveClock >= 100) finishDraw(game, "fifty-move rule", event.blockTime);
      else if (game.positionCounts[key] >= 3) finishDraw(game, "threefold repetition", event.blockTime);
      if (game.winner) advance(t, game);
      return;
    }
    case "resign": {
      const t = tournaments[m.t];
      if (!t || tournamentStatus(t) !== "live" || !m.g) return;
      const game = t.games[m.g];
      if (!game || game.winner) return;
      const color = colorOf(game, event.sender);
      if (!color) return;
      finish(game, addressOf(game, opposite(color)), { kind: "resignation" }, event.blockTime);
      advance(t, game);
      return;
    }
    case "claim": {
      const t = tournaments[m.t];
      if (!t || tournamentStatus(t) !== "live" || !m.g) return;
      const game = t.games[m.g];
      if (!game || game.winner) return;
      const claimant = colorOf(game, event.sender);
      if (!claimant || claimant === game.board.sideToMove) return;
      // Valid only if, by chain time, the side to move had indeed run out - past the same
      // allowance a move gets.
      const elapsed = chargedMs(game, event.blockTime - game.lastEventAt);
      const remaining = CLOCK_MS - usedMs(game, game.board.sideToMove);
      if (!(elapsed >= remaining)) return;
      if (game.board.sideToMove === WHITE) game.whiteUsedMs = CLOCK_MS; else game.blackUsedMs = CLOCK_MS;
      finish(game, event.sender, { kind: "timeout" }, event.blockTime);
      advance(t, game);
      return;
    }
    case "chat": {
      const t = tournaments[m.t];
      if (!t) return;
      const text = String(m.text || "").trim();
      if (!text) return;
      t.chat.push({ id: event.txId, sender: event.sender, text: text.slice(0, CHAT_MAX_LENGTH), blockTime: event.blockTime, game: m.g || "" });
      return;
    }
    default:
      return;
  }
}

// ---------------------------------------------------------------------------------------------
// Bracket
// ---------------------------------------------------------------------------------------------

function start(t, time) {
  t.startedAt = time;
  const seeds = t.players;
  const pairs = isDuel(t) ? [[0, 1]] : [[0, 7], [1, 6], [2, 5], [3, 4]];
  pairs.forEach(([a, b], index) => {
    const white = seeds[a], black = seeds[b];
    t.games[`1-${index}`] = makeGame(1, index, white, black, time);
    t.whiteCount[white] = (t.whiteCount[white] || 0) + 1;
  });
}

function advance(t, game) {
  if (game.round >= roundsOf(t) || game.endedAt == null) return;
  const nextRound = game.round + 1;
  const nextIndex = Math.floor(game.index / 2);
  const a = t.games[`${game.round}-${nextIndex * 2}`]?.winner;
  const b = t.games[`${game.round}-${nextIndex * 2 + 1}`]?.winner;
  if (!a || !b || t.games[`${nextRound}-${nextIndex}`]) return;
  // Colours: fewer whites so far gets white; tie -> lower seed.
  const whitesA = t.whiteCount[a] || 0, whitesB = t.whiteCount[b] || 0;
  const aIsWhite = whitesA !== whitesB ? whitesA < whitesB : (seedOf(t, a) ?? 99) < (seedOf(t, b) ?? 99);
  const white = aIsWhite ? a : b, black = aIsWhite ? b : a;
  t.games[`${nextRound}-${nextIndex}`] = makeGame(nextRound, nextIndex, white, black, game.endedAt);
  t.whiteCount[white] = (t.whiteCount[white] || 0) + 1;
}

function makeGame(round, index, white, black, time) {
  const board = initialBoard();
  const game = {
    id: `${round}-${index}`, round, index, white, black, startedAt: time, board, moves: [],
    whiteUsedMs: 0, blackUsedMs: 0, lastEventAt: time, winner: null, outcome: null, endedAt: null,
    positionCounts: {}, halfmoveClock: 0,
  };
  game.positionCounts[positionKey(board)] = 1;
  return game;
}

function finish(game, winner, outcome, time) {
  game.winner = winner;
  game.outcome = outcome;
  game.endedAt = time;
}

/** A draw on the board: the player with more clock left advances; equal -> black. */
function finishDraw(game, reason, time) {
  const whiteLeft = CLOCK_MS - game.whiteUsedMs;
  const blackLeft = CLOCK_MS - game.blackUsedMs;
  finish(game, whiteLeft > blackLeft ? game.white : game.black, { kind: "drawTiebreak", reason }, time);
}

/** Board, side to move, castling rights and en-passant square - what repetition compares. */
export function positionKey(board) {
  const letters = { pawn: "p", knight: "n", bishop: "b", rook: "r", queen: "q", king: "k" };
  let key = "";
  for (let rank = 0; rank < 8; rank += 1) {
    for (let file = 0; file < 8; file += 1) {
      const piece = board.squares[rank][file];
      if (!piece) { key += "."; continue; }
      const letter = letters[piece.type];
      key += piece.color === WHITE ? letter.toUpperCase() : letter;
    }
  }
  key += board.sideToMove === WHITE ? "w" : "b";
  key += board.whiteCanCastleKingside ? "K" : "-";
  key += board.whiteCanCastleQueenside ? "Q" : "-";
  key += board.blackCanCastleKingside ? "k" : "-";
  key += board.blackCanCastleQueenside ? "q" : "-";
  key += board.enPassantTarget ? algebraic(board.enPassantTarget) : "-";
  return key;
}

// ---------------------------------------------------------------------------------------------
// Leaderboard
// ---------------------------------------------------------------------------------------------

/** One player's record. Two boards read it: 1v1 (duel games, public and private) and
 *  Tournaments (tournaments won, then the games inside them). `wins`/`losses` are the totals
 *  over both, the figures the indexer's /chess/leaderboard serves. */
export function leaderboard(tournaments) {
  const rows = {};
  const row = (address) => (rows[address] ||= { address, wins: 0, losses: 0, duelWins: 0, duelLosses: 0, tournamentGameWins: 0, tournamentGameLosses: 0, tournamentsPlayed: 0, tournamentsWon: 0, tournamentsLost: 0, lastPlayedAt: 0 });
  for (const t of tournaments) {
    if (t.startedAt == null) continue;
    const duel = isDuel(t);
    // A 1v1 is not a tournament: it counts on the 1v1 board only.
    if (!duel) {
      for (const player of t.players) {
        const r = row(player);
        r.tournamentsPlayed += 1;
        r.lastPlayedAt = Math.max(r.lastPlayedAt, t.startedAt || 0);
      }
    }
    for (const game of Object.values(t.games)) {
      if (!game.winner) continue;
      const loser = game.winner === game.white ? game.black : game.white;
      const w = row(game.winner); w.wins += 1; if (duel) w.duelWins += 1; else w.tournamentGameWins += 1; w.lastPlayedAt = Math.max(w.lastPlayedAt, game.endedAt || 0);
      // Knocked out: a lost game inside a tournament is one tournament loss, counted the moment it happens.
      const l = row(loser); l.losses += 1; if (duel) l.duelLosses += 1; else { l.tournamentGameLosses += 1; l.tournamentsLost += 1; } l.lastPlayedAt = Math.max(l.lastPlayedAt, game.endedAt || 0);
    }
    const champ = duel ? null : champion(t);
    if (champ) row(champ).tournamentsWon += 1;
  }
  // Wins and losses are the leaderboard: most wins first, fewest losses breaking ties.
  return Object.values(rows).sort((a, b) => {
    if (a.wins !== b.wins) return b.wins - a.wins;
    if (a.losses !== b.losses) return a.losses - b.losses;
    return b.lastPlayedAt - a.lastPlayedAt;
  });
}

/** The 1v1 board: players with a 1v1 game behind them, most wins first, fewest losses. */
export function duelLeaderboard(rows) {
  return rows.filter((r) => r.duelWins + r.duelLosses > 0).sort((a, b) => {
    if (a.duelWins !== b.duelWins) return b.duelWins - a.duelWins;
    if (a.duelLosses !== b.duelLosses) return a.duelLosses - b.duelLosses;
    return b.lastPlayedAt - a.lastPlayedAt;
  });
}

/** The tournament board: whole tournaments only - won (champion) and lost (knocked out). Most
 *  won first, fewest lost breaking ties. Games inside a tournament are not a score. */
export function tournamentLeaderboard(rows) {
  return rows.filter((r) => r.tournamentsWon + r.tournamentsLost > 0).sort((a, b) => {
    if (a.tournamentsWon !== b.tournamentsWon) return b.tournamentsWon - a.tournamentsWon;
    if (a.tournamentsLost !== b.tournamentsLost) return a.tournamentsLost - b.tournamentsLost;
    return b.lastPlayedAt - a.lastPlayedAt;
  });
}

export { promotionLetter };
