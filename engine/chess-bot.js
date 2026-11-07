// KaPlay > Bots (iOS c3c04a1, KaPlay ddec987, ONLINE_CHESS.md §7): five bots, level 1 to 5, played
// on this device. Ports of iOS ChessBotModels.swift (the bots, the stamp, the record, the wins that
// count), ChessBotEngine.swift (the search), ChessBotGame.swift (one game, stamped when it ends) and
// the pure half of ChessBotLeaderboardService.swift (a bot's board).
// Pure and UI-free: the search also runs in engine/chess-bot-worker.js, and the tests run all of
// it under node (tools/test-chess-bot.mjs).
//
// engine/chess.js is the rules - it decides what is legal, and every move a bot plays is checked
// against its list - but it copies the whole board for every move it tries, far too slow to look
// several moves ahead. So the search runs on its own compact board (BotPosition: 64 ints,
// make/unmake in place) with a plain alpha-beta: iterative deepening under a time limit, captures
// searched to quiet positions, piece-square tables for the evaluation.

import {
  WHITE, BLACK, opposite, algebraic, promotionLetter, initialBoard, legalMoves, applyMove, isLegalMove,
  normalizingPromotion, isCheckmate, isStalemate, isInsufficientMaterial, pieceAt, squareEquals,
} from "./chess.js";
import { positionKey, periodSinceMs, isRetryableSendError, friendlySendErrorMessage, sendOutcomeUnknownTxid, SEND_OUTCOME_UNKNOWN_NOTE } from "./chess-tournament.js";

// ---------------------------------------------------------------------------------------------
// The bots (ChessBotModels.swift)
// ---------------------------------------------------------------------------------------------

/** `timeLimit` in seconds, as iOS. Colours are iOS's gradient, top to bottom, as CSS. */
export const CHESS_BOTS = Object.freeze([
  Object.freeze({
    level: 1, name: "Kaspa Silver", title: "Beginner",
    bio: "Here for the fun of it. Moves fast and sometimes leaves a piece hanging.",
    initials: "KS",
    colors: Object.freeze(["rgb(199, 204, 214)", "rgb(128, 135, 148)"]),
    settings: Object.freeze({ depth: 1, quiescence: false, noise: 250, randomChance: 0.35, timeLimit: 1 }),
  }),
  Object.freeze({
    level: 2, name: "Izio Dev", title: "Novice",
    bio: "Knows how every piece moves and loves grabbing free material. Watch your loose pawns.",
    initials: "ID",
    colors: Object.freeze(["rgb(92, 204, 219)", "rgb(31, 133, 168)"]),
    settings: Object.freeze({ depth: 1, quiescence: true, noise: 100, randomChance: 0.12, timeLimit: 1 }),
  }),
  Object.freeze({
    level: 3, name: "Coderofstuff", title: "Intermediate",
    bio: "Looks a couple of moves ahead before committing. Steady and hard to trick.",
    initials: "CS",
    colors: Object.freeze(["rgb(112, 199, 186)", "rgb(41, 140, 120)"]),
    settings: Object.freeze({ depth: 2, quiescence: true, noise: 40, randomChance: 0.04, timeLimit: 2 }),
  }),
  Object.freeze({
    level: 4, name: "Michael Sutton", title: "Advanced",
    bio: "Calculates carefully and punishes mistakes. Come with a plan.",
    initials: "MS",
    colors: Object.freeze(["rgb(140, 140, 242)", "rgb(82, 64, 184)"]),
    settings: Object.freeze({ depth: 3, quiescence: true, noise: 12, randomChance: 0, timeLimit: 3 }),
  }),
  Object.freeze({
    level: 5, name: "Yonatan Sompolinsky", title: "Master",
    bio: "Thinks deep and sees far. Beat this one and you have climbed the whole ladder.",
    initials: "YS",
    colors: Object.freeze(["rgb(250, 204, 92)", "rgb(217, 133, 26)"]),
    settings: Object.freeze({ depth: 6, quiescence: true, noise: 0, randomChance: 0, timeLimit: 4 }),
  }),
]);

export function chessBot(level) {
  return CHESS_BOTS.find((bot) => bot.level === Number(level)) || null;
}

/** The search for the move at `ply` (0 = the game's first). The master varies its opening a
 *  little so no two games start the same; past the opening it plays its best. */
export function botSearchSettings(bot, ply) {
  const settings = bot.settings;
  if (settings.noise !== 0 || ply >= 8) return settings;
  return { ...settings, noise: 12 };
}

/** The player's colour choice before a game (ChessBotSidePreference). */
export const SIDE_PREFERENCES = Object.freeze(["White", "Random", "Black"]);
export function resolveSide(preference, random = Math.random) {
  if (preference === "White") return WHITE;
  if (preference === "Black") return BLACK;
  return random() < 0.5 ? WHITE : BLACK;
}

// ---------------------------------------------------------------------------------------------
// On chain (ONLINE_CHESS.md §7, KaPlay ddec987): a finished game's stamp, plaintext broadcast JSON
// in `#chess-bots`, signed by the player's address, sent once when the game ends. Earlier builds
// sent `v: 1` messages per move; they are still on chain and count for nothing.
// ---------------------------------------------------------------------------------------------

export const CHESS_BOTS_CHANNEL = "chess-bots";

function botMoveText(move) {
  return `${algebraic(move.from)}${algebraic(move.to)}${move.promotion ? promotionLetter(move.promotion) : ""}`;
}

/** The stamp (ChessBotCodec.result). `result`: { kind: "won" | "lost" | "drawn", why }. `moves`:
 *  every move of the game, both sides, as { from, to, promotion } with board squares. */
export function botResultMessage(id, level, playerColor, result, moves) {
  return {
    type: "chess_bot", v: 2, g: id, a: "result", bot: level, c: playerColor === WHITE ? "w" : "b",
    r: result.kind, why: result.why, m: moves.map(botMoveText).join(" "),
  };
}

/** Keys sorted, nil fields left out, slashes unescaped - the bytes iOS's JSONEncoder
 *  (`.sortedKeys, .withoutEscapingSlashes`) emits. */
export function encodeBotMessage(message) {
  const clean = {};
  for (const key of Object.keys(message).sort()) {
    if (message[key] === null || message[key] === undefined) continue;
    clean[key] = message[key];
  }
  return JSON.stringify(clean);
}

/** A game id: a lowercase UUID, as iOS's `UUID().uuidString.lowercased()`. */
export function newBotGameId() {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID().toLowerCase();
  const bytes = new Uint8Array(16);
  if (c?.getRandomValues) c.getRandomValues(bytes);
  else for (let i = 0; i < 16; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The sample the "about 0.0017 KAS" line is estimated for (ChessBotCodec.stampFeeText): a game
 *  of 40 moves a side, a fresh id. A longer game's stamp costs a little more. */
export function sampleStampContent() {
  const e4 = { from: { file: 4, rank: 1 }, to: { file: 4, rank: 3 }, promotion: null };
  return encodeBotMessage(botResultMessage(newBotGameId(), CHESS_BOTS[0].level, WHITE, { kind: "won", why: "checkmate" }, Array(80).fill(e4)));
}

// ---------------------------------------------------------------------------------------------
// Record (ChessBotProgress): level -> { wins, losses, draws }, per address. A win against a bot
// opens the next level. Pure helpers; ui/chess-bots.js keeps the map in account-scoped storage.
// ---------------------------------------------------------------------------------------------

export function botRecord(records, level) {
  const r = records?.[level] || records?.[String(level)] || {};
  return { wins: Number(r.wins) || 0, losses: Number(r.losses) || 0, draws: Number(r.draws) || 0 };
}

export function isBotUnlocked(records, level) {
  if (Number(level) <= 1) return true;
  const previous = chessBot(Number(level) - 1);
  if (!previous) return true;
  return botRecord(records, previous.level).wins > 0;
}

/** `kind`: "won" | "lost" | "drawn". Returns a new map. */
export function addBotResult(records, level, kind) {
  const record = botRecord(records, level);
  if (kind === "won") record.wins += 1;
  else if (kind === "lost") record.losses += 1;
  else record.draws += 1;
  return { ...(records || {}), [String(level)]: record };
}

export function parseBotRecords(text) {
  try {
    const parsed = JSON.parse(text || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out = {};
    for (const bot of CHESS_BOTS) {
      if (parsed[bot.level] != null) out[String(bot.level)] = botRecord(parsed, bot.level);
    }
    return out;
  } catch { return {}; }
}

// ---------------------------------------------------------------------------------------------
// The wins that count (ChessBotProgress.stampedWins): level -> [{ moves, at }], per address. Only a
// stamped win counts, and the player's own show on the boards before the indexer has them. A win
// is ranked by the player's own moves: a win as white in 7 plies is 4 moves.
// ---------------------------------------------------------------------------------------------

export function addStampedWin(wins, level, moves, at) {
  const list = Array.isArray(wins?.[level]) ? wins[level] : [];
  return { ...(wins || {}), [String(level)]: [...list, { moves, at }] };
}

/** The player's fewest moves against `level` since `since` (ms), the earlier win on a tie. */
export function bestStampedWin(wins, level, since) {
  let best = null;
  for (const win of Array.isArray(wins?.[level]) ? wins[level] : []) {
    if (win.at < since) continue;
    if (!best || win.moves < best.moves || (win.moves === best.moves && win.at < best.at)) best = win;
  }
  return best;
}

export function parseStampedWins(text) {
  try {
    const parsed = JSON.parse(text || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out = {};
    for (const bot of CHESS_BOTS) {
      const list = parsed[bot.level];
      if (!Array.isArray(list)) continue;
      out[String(bot.level)] = list
        .map((win) => ({ moves: Number(win?.moves), at: Number(win?.at) }))
        .filter((win) => Number.isFinite(win.moves) && Number.isFinite(win.at));
    }
    return out;
  } catch { return {}; }
}

// ---------------------------------------------------------------------------------------------
// The bots' boards (ChessBotLeaderboardService, ONLINE_CHESS.md §7.1): each player's fewest moves
// to win, this month and all time.
// ---------------------------------------------------------------------------------------------

/** GET /chess/bots/leaderboard's answer for `period`, as level -> { games, rows } - or null when
 *  it is for another period or not a board. */
export function indexerBotBoards(json, period) {
  if (!json || typeof json !== "object" || json.period !== period || !Array.isArray(json.bots)) return null;
  const levels = {};
  for (const bot of json.bots) {
    if (!chessBot(bot?.level)) continue;
    const rows = [];
    for (const p of Array.isArray(bot.players) ? bot.players : []) {
      const moves = Number(p?.moves);
      const at = Number(p?.at);
      if (typeof p?.address === "string" && p.address && Number.isFinite(moves) && Number.isFinite(at)) rows.push({ address: p.address, moves, at });
    }
    levels[String(bot.level)] = { games: Number(bot.games) || 0, rows };
  }
  return levels;
}

/** One bot's board in `period` (ChessBotLeaderboardService.rows): the indexer's rows with the
 *  player's own stamped wins merged in, so a win shows the moment it is stamped. Fewest moves
 *  first, the earlier win on a tie. */
export function botBoardRows({ boards, level, period, wins, address, nowMs }) {
  const rows = [...(boards?.[period]?.[level]?.rows || [])];
  const mine = address ? bestStampedWin(wins, level, periodSinceMs(period, nowMs)) : null;
  if (mine) {
    const own = { address, moves: mine.moves, at: mine.at };
    const index = rows.findIndex((row) => row.address.toLowerCase() === address.toLowerCase());
    if (index < 0) rows.push(own);
    else if (mine.moves < rows[index].moves) rows[index] = own;
  }
  return rows.sort((a, b) => (a.moves - b.moves) || (a.at - b.at));
}

/** Has anyone played this bot, as far as this device can tell? */
export function botHasBeenPlayed({ records, boards, level }) {
  const record = botRecord(records, level);
  if (record.wins + record.losses + record.draws > 0) return true;
  return (boards?.all?.[level]?.games || 0) > 0;
}

// ---------------------------------------------------------------------------------------------
// The search's board (BotPosition): squares 0...63 (rank * 8 + file, a1 = 0). Pieces are codes
// 1 pawn ... 6 king, positive for white, negative for black; `side` is 1 for white to move, -1
// for black.
// ---------------------------------------------------------------------------------------------

const FLAG_NORMAL = 0;
const FLAG_DOUBLE_PUSH = 1;
const FLAG_EN_PASSANT = 2;
const FLAG_CASTLE = 3;

const VALUES = [0, 100, 320, 330, 500, 900, 0];
const CODE_OF = { pawn: 1, knight: 2, bishop: 3, rook: 4, queen: 5, king: 6 };
const PROMO_TYPE = { 2: "knight", 3: "bishop", 4: "rook", 5: "queen" };

function targets(offsets) {
  const out = [];
  for (let square = 0; square < 64; square += 1) {
    const file = square % 8, rank = (square / 8) | 0;
    const list = [];
    for (const [df, dr] of offsets) {
      const f = file + df, r = rank + dr;
      if (f >= 0 && f < 8 && r >= 0 && r < 8) list.push(r * 8 + f);
    }
    out.push(list);
  }
  return out;
}
const KNIGHT_TARGETS = targets([[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]]);
const KING_TARGETS = targets([[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]]);
/** Rays from each square: directions 0...3 straight, 4...7 diagonal. */
const RAYS = (() => {
  const dirs = [[0, 1], [0, -1], [1, 0], [-1, 0], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  const out = [];
  for (let square = 0; square < 64; square += 1) {
    const file = square % 8, rank = (square / 8) | 0;
    out.push(dirs.map(([df, dr]) => {
      const ray = [];
      let f = file + df, r = rank + dr;
      while (f >= 0 && f < 8 && r >= 0 && r < 8) { ray.push(r * 8 + f); f += df; r += dr; }
      return ray;
    }));
  }
  return out;
})();
/** Castling bits a move from or to this square clears (1 white king side, 2 white queen side,
 *  4 black king side, 8 black queen side). */
const CASTLE_MASK = (() => {
  const mask = new Array(64).fill(0);
  mask[0] = 2; mask[4] = 3; mask[7] = 1; mask[56] = 8; mask[60] = 12; mask[63] = 4;
  return mask;
})();

function botMove(from, to, promo = 0, flag = FLAG_NORMAL, order = 0) {
  return { from, to, promo, flag, order };
}

/** A search move as a rules-engine move: { from, to, promotion }. */
export function botMoveToChessMove(m) {
  return {
    from: { file: m.from % 8, rank: (m.from / 8) | 0 },
    to: { file: m.to % 8, rank: (m.to / 8) | 0 },
    promotion: PROMO_TYPE[m.promo] || null,
  };
}

function sameChessMove(a, b) {
  return squareEquals(a.from, b.from) && squareEquals(a.to, b.to) && (a.promotion || null) === (b.promotion || null);
}

const byOrder = (a, b) => b.order - a.order;

export class BotPosition {
  constructor(board) {
    this.squares = new Int8Array(64);
    this.kings = [4, 60];
    for (let rank = 0; rank < 8; rank += 1) {
      for (let file = 0; file < 8; file += 1) {
        const piece = board.squares[rank][file];
        if (!piece) continue;
        const code = CODE_OF[piece.type];
        this.squares[rank * 8 + file] = piece.color === WHITE ? code : -code;
        if (piece.type === "king") this.kings[piece.color === WHITE ? 0 : 1] = rank * 8 + file;
      }
    }
    this.side = board.sideToMove === WHITE ? 1 : -1;
    this.castling = (board.whiteCanCastleKingside ? 1 : 0) | (board.whiteCanCastleQueenside ? 2 : 0)
      | (board.blackCanCastleKingside ? 4 : 0) | (board.blackCanCastleQueenside ? 8 : 0);
    this.enPassant = board.enPassantTarget ? board.enPassantTarget.rank * 8 + board.enPassantTarget.file : -1;
    this.history = [];
  }

  // --- Attacks ---

  isAttacked(square, color) {
    const s = this.squares;
    const file = square % 8, rank = (square / 8) | 0;
    // A white pawn attacks from the rank below, a black one from the rank above.
    const pawnRank = rank - color;
    if (pawnRank >= 0 && pawnRank < 8) {
      if (file > 0 && s[pawnRank * 8 + file - 1] === color) return true;
      if (file < 7 && s[pawnRank * 8 + file + 1] === color) return true;
    }
    for (const target of KNIGHT_TARGETS[square]) if (s[target] === 2 * color) return true;
    for (const target of KING_TARGETS[square]) if (s[target] === 6 * color) return true;
    const rays = RAYS[square];
    for (let direction = 0; direction < 8; direction += 1) {
      const ray = rays[direction];
      for (let i = 0; i < ray.length; i += 1) {
        const piece = s[ray[i]];
        if (piece === 0) continue;
        if (piece * color > 0) {
          const type = piece < 0 ? -piece : piece;
          if (type === 5 || type === (direction < 4 ? 4 : 3)) return true;
        }
        break;
      }
    }
    return false;
  }

  /** The side to move is in check. */
  get inCheck() { return this.isAttacked(this.kings[this.side === 1 ? 0 : 1], -this.side); }

  /** The side that just moved left its own king attacked: the move was not legal. */
  get moverInCheck() { return this.isAttacked(this.kings[this.side === 1 ? 1 : 0], this.side); }

  // --- Move generation (pseudo-legal; `make` then `moverInCheck` filters) ---

  moves(capturesOnly) {
    const moves = [];
    const us = this.side;
    const s = this.squares;
    for (let square = 0; square < 64; square += 1) {
      const piece = s[square];
      if (piece * us <= 0) continue;
      switch (piece < 0 ? -piece : piece) {
        case 1: this.pawnMoves(square, capturesOnly, moves); break;
        case 2: for (const target of KNIGHT_TARGETS[square]) this.add(square, target, capturesOnly, moves); break;
        case 3: this.slide(square, 4, 8, capturesOnly, moves); break;
        case 4: this.slide(square, 0, 4, capturesOnly, moves); break;
        case 5: this.slide(square, 0, 8, capturesOnly, moves); break;
        default:
          for (const target of KING_TARGETS[square]) this.add(square, target, capturesOnly, moves);
          if (!capturesOnly) this.castlingMoves(square, moves);
      }
    }
    return moves.sort(byOrder);
  }

  /** The legal moves, best-looking first. */
  legalMoves() {
    return this.moves(false).filter((m) => {
      this.make(m);
      const ok = !this.moverInCheck;
      this.unmake();
      return ok;
    });
  }

  add(from, to, capturesOnly, moves) {
    const victim = this.squares[to];
    if (victim * this.side > 0) return;
    if (victim === 0) {
      if (!capturesOnly) moves.push(botMove(from, to));
      return;
    }
    moves.push(botMove(from, to, 0, FLAG_NORMAL, captureOrder(Math.abs(victim), Math.abs(this.squares[from]))));
  }

  slide(from, firstDirection, endDirection, capturesOnly, moves) {
    const rays = RAYS[from];
    for (let direction = firstDirection; direction < endDirection; direction += 1) {
      const ray = rays[direction];
      for (let i = 0; i < ray.length; i += 1) {
        const target = ray[i];
        const piece = this.squares[target];
        if (piece === 0) {
          if (!capturesOnly) moves.push(botMove(from, target));
          continue;
        }
        if (piece * this.side < 0) {
          moves.push(botMove(from, target, 0, FLAG_NORMAL, captureOrder(Math.abs(piece), Math.abs(this.squares[from]))));
        }
        break;
      }
    }
  }

  pawnMoves(from, capturesOnly, moves) {
    const side = this.side;
    const step = side * 8;
    const rank = (from / 8) | 0, file = from % 8;
    const promotes = rank === (side === 1 ? 6 : 1);
    const startRank = side === 1 ? 1 : 6;
    // Queen and knight only: a rook or bishop promotion is never better than a queen except to
    // dodge stalemate, which is not worth the search time here.
    const promotions = (target, order) => {
      moves.push(botMove(from, target, 5, FLAG_NORMAL, order + 9_000));
      moves.push(botMove(from, target, 2, FLAG_NORMAL, order + 1_000));
    };
    const one = from + step;
    if (this.squares[one] === 0) {
      if (promotes) {
        promotions(one, 0);
      } else if (!capturesOnly) {
        moves.push(botMove(from, one));
        if (rank === startRank && this.squares[one + step] === 0) {
          moves.push(botMove(from, one + step, 0, FLAG_DOUBLE_PUSH));
        }
      }
    }
    for (const df of [-1, 1]) {
      const targetFile = file + df;
      if (targetFile < 0 || targetFile >= 8) continue;
      const target = one + df;
      const victim = this.squares[target];
      if (victim * side < 0) {
        const order = captureOrder(Math.abs(victim), 1);
        if (promotes) promotions(target, order); else moves.push(botMove(from, target, 0, FLAG_NORMAL, order));
      } else if (target === this.enPassant) {
        moves.push(botMove(from, target, 0, FLAG_EN_PASSANT, captureOrder(1, 1)));
      }
    }
  }

  castlingMoves(from, moves) {
    const side = this.side;
    const s = this.squares;
    const base = side === 1 ? 0 : 56;
    const kingSide = side === 1 ? 1 : 4;
    const queenSide = side === 1 ? 2 : 8;
    if (from !== base + 4) return;
    if ((this.castling & kingSide) !== 0 && s[base + 5] === 0 && s[base + 6] === 0 && s[base + 7] === 4 * side
      && !this.isAttacked(base + 4, -side) && !this.isAttacked(base + 5, -side) && !this.isAttacked(base + 6, -side)) {
      moves.push(botMove(from, base + 6, 0, FLAG_CASTLE));
    }
    if ((this.castling & queenSide) !== 0 && s[base + 3] === 0 && s[base + 2] === 0 && s[base + 1] === 0 && s[base] === 4 * side
      && !this.isAttacked(base + 4, -side) && !this.isAttacked(base + 3, -side) && !this.isAttacked(base + 2, -side)) {
      moves.push(botMove(from, base + 2, 0, FLAG_CASTLE));
    }
  }

  // --- Make / unmake ---

  make(m) {
    const s = this.squares;
    const side = this.side;
    const piece = s[m.from];
    this.history.push({ move: m, captured: s[m.to], castling: this.castling, enPassant: this.enPassant });
    s[m.to] = m.promo !== 0 ? m.promo * side : piece;
    s[m.from] = 0;
    if (m.flag === FLAG_EN_PASSANT) {
      s[m.to - 8 * side] = 0;
    } else if (m.flag === FLAG_CASTLE) {
      if (m.to > m.from) { s[m.from + 1] = s[m.from + 3]; s[m.from + 3] = 0; }
      else { s[m.from - 1] = s[m.from - 4]; s[m.from - 4] = 0; }
    }
    if (piece === 6 || piece === -6) this.kings[side === 1 ? 0 : 1] = m.to;
    this.castling &= ~(CASTLE_MASK[m.from] | CASTLE_MASK[m.to]);
    this.enPassant = m.flag === FLAG_DOUBLE_PUSH ? m.from + 8 * side : -1;
    this.side = -side;
  }

  unmake() {
    const last = this.history.pop();
    const m = last.move;
    const s = this.squares;
    this.side = -this.side;
    const side = this.side;
    const moved = s[m.to];
    s[m.from] = m.promo !== 0 ? side : moved;
    s[m.to] = last.captured;
    if (m.flag === FLAG_EN_PASSANT) {
      s[m.to - 8 * side] = -side;
    } else if (m.flag === FLAG_CASTLE) {
      if (m.to > m.from) { s[m.from + 3] = s[m.from + 1]; s[m.from + 1] = 0; }
      else { s[m.from - 4] = s[m.from - 1]; s[m.from - 1] = 0; }
    }
    if (moved === 6 || moved === -6) this.kings[side === 1 ? 0 : 1] = m.from;
    this.castling = last.castling;
    this.enPassant = last.enPassant;
  }

  // --- Evaluation ---

  /** Centipawns for the side to move: material, piece-square tables, and in a won endgame a push
   *  of the losing king to the edge so the bot can actually finish the game. */
  evaluate() {
    const s = this.squares;
    let nonPawnMaterial = 0;
    let balance = 0;
    for (let square = 0; square < 64; square += 1) {
      const piece = s[square];
      if (piece === 0) continue;
      const type = piece < 0 ? -piece : piece;
      if (type !== 1 && type !== 6) nonPawnMaterial += VALUES[type];
      balance += piece > 0 ? VALUES[type] : -VALUES[type];
    }
    const endgame = nonPawnMaterial <= 1_300;

    let score = balance;
    for (let square = 0; square < 64; square += 1) {
      const piece = s[square];
      if (piece === 0) continue;
      const type = piece < 0 ? -piece : piece;
      // Tables are drawn from white's side with rank 8 first; black reads them mirrored.
      const index = piece > 0 ? (7 - ((square / 8) | 0)) * 8 + (square % 8) : square;
      const table = type === 6 && endgame ? KING_ENDGAME : TABLES[type];
      score += piece > 0 ? table[index] : -table[index];
    }

    if (endgame && Math.abs(balance) >= 300) {
      const winner = balance > 0 ? 1 : -1;
      const loserKing = this.kings[winner === 1 ? 1 : 0];
      const winnerKing = this.kings[winner === 1 ? 0 : 1];
      const lf = loserKing % 8, lr = (loserKing / 8) | 0;
      const wf = winnerKing % 8, wr = (winnerKing / 8) | 0;
      const edge = Math.max(3 - lf, lf - 4) + Math.max(3 - lr, lr - 4);
      const distance = Math.abs(lf - wf) + Math.abs(lr - wr);
      score += winner * (edge * 10 + (14 - distance) * 4);
    }
    return score * this.side;
  }
}

function captureOrder(victim, attacker) {
  return 10_000 + VALUES[victim] * 10 - attacker;
}

// Michniewski's simplified evaluation tables, white's side, rank 8 first.
const PAWN = [
  0, 0, 0, 0, 0, 0, 0, 0,
  50, 50, 50, 50, 50, 50, 50, 50,
  10, 10, 20, 30, 30, 20, 10, 10,
  5, 5, 10, 25, 25, 10, 5, 5,
  0, 0, 0, 20, 20, 0, 0, 0,
  5, -5, -10, 0, 0, -10, -5, 5,
  5, 10, 10, -20, -20, 10, 10, 5,
  0, 0, 0, 0, 0, 0, 0, 0,
];
const KNIGHT = [
  -50, -40, -30, -30, -30, -30, -40, -50,
  -40, -20, 0, 0, 0, 0, -20, -40,
  -30, 0, 10, 15, 15, 10, 0, -30,
  -30, 5, 15, 20, 20, 15, 5, -30,
  -30, 0, 15, 20, 20, 15, 0, -30,
  -30, 5, 10, 15, 15, 10, 5, -30,
  -40, -20, 0, 5, 5, 0, -20, -40,
  -50, -40, -30, -30, -30, -30, -40, -50,
];
const BISHOP = [
  -20, -10, -10, -10, -10, -10, -10, -20,
  -10, 0, 0, 0, 0, 0, 0, -10,
  -10, 0, 5, 10, 10, 5, 0, -10,
  -10, 5, 5, 10, 10, 5, 5, -10,
  -10, 0, 10, 10, 10, 10, 0, -10,
  -10, 10, 10, 10, 10, 10, 10, -10,
  -10, 5, 0, 0, 0, 0, 5, -10,
  -20, -10, -10, -10, -10, -10, -10, -20,
];
const ROOK = [
  0, 0, 0, 0, 0, 0, 0, 0,
  5, 10, 10, 10, 10, 10, 10, 5,
  -5, 0, 0, 0, 0, 0, 0, -5,
  -5, 0, 0, 0, 0, 0, 0, -5,
  -5, 0, 0, 0, 0, 0, 0, -5,
  -5, 0, 0, 0, 0, 0, 0, -5,
  -5, 0, 0, 0, 0, 0, 0, -5,
  0, 0, 0, 5, 5, 0, 0, 0,
];
const QUEEN = [
  -20, -10, -10, -5, -5, -10, -10, -20,
  -10, 0, 0, 0, 0, 0, 0, -10,
  -10, 0, 5, 5, 5, 5, 0, -10,
  -5, 0, 5, 5, 5, 5, 0, -5,
  0, 0, 5, 5, 5, 5, 0, -5,
  -10, 5, 5, 5, 5, 5, 0, -10,
  -10, 0, 5, 0, 0, 0, 0, -10,
  -20, -10, -10, -5, -5, -10, -10, -20,
];
const KING_MIDDLEGAME = [
  -30, -40, -40, -50, -50, -40, -40, -30,
  -30, -40, -40, -50, -50, -40, -40, -30,
  -30, -40, -40, -50, -50, -40, -40, -30,
  -30, -40, -40, -50, -50, -40, -40, -30,
  -20, -30, -30, -40, -40, -30, -30, -20,
  -10, -20, -20, -20, -20, -20, -20, -10,
  20, 20, 0, 0, 0, 0, 20, 20,
  20, 30, 10, 0, 0, 10, 30, 20,
];
const KING_ENDGAME = [
  -50, -40, -30, -20, -20, -30, -40, -50,
  -30, -20, -10, 0, 0, -10, -20, -30,
  -30, -10, 20, 30, 30, 20, -10, -30,
  -30, -10, 30, 40, 40, 30, -10, -30,
  -30, -10, 30, 40, 40, 30, -10, -30,
  -30, -10, 20, 30, 30, 20, -10, -30,
  -30, -30, 0, 0, 0, 0, -30, -30,
  -50, -30, -30, -30, -30, -30, -30, -50,
];
const TABLES = [[], PAWN, KNIGHT, BISHOP, ROOK, QUEEN, KING_MIDDLEGAME];

// ---------------------------------------------------------------------------------------------
// Search (BotSearch)
// ---------------------------------------------------------------------------------------------

const MATE = 100_000;
const INFINITY = 1_000_000;
export const BOT_MATE_SCORE = MATE;

const defaultNow = () => (globalThis.performance?.now ? globalThis.performance.now() : Date.now());

function randomInt(min, max, random) {
  return min + Math.floor(random() * (max - min + 1));
}

class BotSearch {
  constructor(position, settings, drawish, { now = defaultNow, random = Math.random } = {}) {
    this.position = position;
    this.settings = settings;
    this.drawish = drawish || [];
    this.now = now;
    this.random = random;
    this.deadline = Infinity;
    this.nodes = 0;
    this.aborted = false;
    /** Depth 1 always finishes; only deeper iterations may be cut by the clock. */
    this.canAbort = false;
    /** The depth the returned move comes from (for tests and logs). */
    this.completedDepth = 0;
  }

  run() {
    let rootMoves = this.position.legalMoves();
    if (!rootMoves.length) return null;
    this.deadline = this.now() + this.settings.timeLimit * 1000;
    // With noise every root move needs its true score (a full window), not just a bound.
    const exact = this.settings.noise > 0;
    let lastScored = [];

    for (let depth = 1; depth <= Math.max(1, this.settings.depth); depth += 1) {
      this.canAbort = depth > 1;
      const scored = [];
      let alpha = -INFINITY;
      for (const m of rootMoves) {
        let score;
        if (this.isDrawish(m)) {
          score = 0;
        } else {
          this.position.make(m);
          score = -this.search(depth - 1, -INFINITY, exact ? INFINITY : -alpha, 1);
          this.position.unmake();
        }
        if (this.aborted) break;
        scored.push({ move: m, score });
        alpha = Math.max(alpha, score);
      }
      if (this.aborted) break;
      scored.sort((a, b) => b.score - a.score);
      lastScored = scored;
      this.completedDepth = depth;
      // Searched best first next time round, which is what makes deepening cheap.
      rootMoves = scored.map((entry) => entry.move);
      if (scored.length && Math.abs(scored[0].score) >= MATE - 100) break;
      if (this.now() > this.deadline) break;
    }

    if (!lastScored.length) return null;
    this.bestScore = lastScored[0].score;
    if (!(this.settings.noise > 0)) return lastScored[0].move;
    const noise = this.settings.noise;
    let best = null;
    for (const entry of lastScored) {
      const score = entry.score + randomInt(-noise, noise, this.random);
      if (!best || best.score < score) best = { move: entry.move, score };
    }
    return best?.move || null;
  }

  isDrawish(m) {
    if (!this.drawish.length) return false;
    const chess = botMoveToChessMove(m);
    return this.drawish.some((d) => sameChessMove(d, chess));
  }

  tick() {
    this.nodes += 1;
    if (this.canAbort && (this.nodes & 1023) === 0 && this.now() > this.deadline) this.aborted = true;
  }

  search(depthIn, alphaIn, beta, ply) {
    this.tick();
    if (this.aborted) return 0;
    const position = this.position;
    const inCheck = position.inCheck;
    // Checks are searched one ply deeper, so a mate just past the horizon is still seen.
    const depth = inCheck && ply < 12 ? depthIn + 1 : depthIn;
    if (depth <= 0) {
      return this.settings.quiescence ? this.quiesce(alphaIn, beta, 0) : position.evaluate();
    }
    let alpha = alphaIn;
    let legal = 0;
    for (const m of position.moves(false)) {
      position.make(m);
      if (position.moverInCheck) { position.unmake(); continue; }
      legal += 1;
      const score = -this.search(depth - 1, -beta, -alpha, ply + 1);
      position.unmake();
      if (this.aborted) return 0;
      if (score >= beta) return score;
      if (score > alpha) alpha = score;
    }
    if (legal === 0) return inCheck ? -MATE + ply : 0;
    return alpha;
  }

  quiesce(alphaIn, beta, ply) {
    this.tick();
    if (this.aborted) return 0;
    const position = this.position;
    const standPat = position.evaluate();
    if (standPat >= beta) return standPat;
    let alpha = Math.max(alphaIn, standPat);
    if (ply >= 6) return alpha;
    for (const m of position.moves(true)) {
      position.make(m);
      if (position.moverInCheck) { position.unmake(); continue; }
      const score = -this.quiesce(-beta, -alpha, ply + 1);
      position.unmake();
      if (this.aborted) return 0;
      if (score >= beta) return score;
      if (score > alpha) alpha = score;
    }
    return alpha;
  }
}

/**
 * The bot's move in `board` ({ from, to, promotion }, one of engine/chess.js's legal moves), or
 * null when there is none (the game is over). `avoiding`: moves that repeat a position already
 * seen in this game - scored as a draw, so a bot that is winning does not shuffle into threefold
 * repetition (and one that is losing takes the draw when it can). `opts.now` / `opts.random`
 * are for tests; `opts.info` receives { depth, nodes, score } when given.
 */
export function chessBotBestMove(board, settings, avoiding = [], opts = {}) {
  const random = opts.random || Math.random;
  const legal = legalMoves(board);
  if (!legal.length) return null;
  if (legal.length === 1) return legal[0];
  const pick = () => legal[Math.floor(random() * legal.length)];
  if (random() < settings.randomChance) return pick();
  const search = new BotSearch(new BotPosition(board), settings, avoiding, { now: opts.now, random });
  const found = search.run();
  if (typeof opts.info === "function") opts.info({ depth: search.completedDepth, nodes: search.nodes, score: search.bestScore });
  if (!found) return pick();
  const move = botMoveToChessMove(found);
  // The rules engine has the last word: a search move it does not know (it never should happen)
  // becomes a random legal one rather than an illegal move on chain.
  return legal.find((m) => sameChessMove(m, move)) || pick();
}

// ---------------------------------------------------------------------------------------------
// One game (ChessBotGame.swift, KaPlay ddec987). The whole game lives on this device and costs
// nothing while it is played; when it ends, its result and moves go on chain in one transaction,
// the stamp. A stamp that fails holds until Retry, and only a stamped win counts toward the
// player's best on the bot's board.
// ---------------------------------------------------------------------------------------------

export const BOT_SEND_RETRIES = 5;
export const BOT_SEND_RETRY_MS = 1_200;
/** The bot never answers quicker than this, so a reply does not land in the same instant as
 *  the player's move. */
export const BOT_MIN_THINK_MS = 800;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class ChessBotGame {
  /**
   * `send(content)`: one broadcast of `content` to #chess-bots; rejects on failure.
   * `think(board, settings, avoiding)`: resolves the bot's move (a Worker, off the main thread).
   * `record(result)`: the result for the player's record, once. `recordStampedWin(moves)`: a win
   * went on chain. `onChange()`: repaint.
   */
  constructor({ bot, playerColor, send, think, record = () => {}, recordStampedWin = () => {}, onChange = () => {}, log = () => {}, sleep = defaultSleep, now = defaultNow, id = newBotGameId() }) {
    this.bot = bot;
    this.playerColor = playerColor;
    this.id = id;
    this.sendContent = send;
    this.think = think;
    this.recordResult = record;
    this.recordStampedWin = recordStampedWin;
    this.onChange = onChange;
    this.log = log;
    this.sleep = sleep;
    this.now = now;

    this.board = initialBoard();
    /** { move, color, piece, captured } per ply. */
    this.moves = [];
    /** { kind: "won" | "lost" | "drawn", why } once the game is over. */
    this.result = null;
    this.isThinking = false;
    /** Where the result's transaction stands: none (the game is still on) | sending | stamped |
     *  failed | unconfirmed (may have gone through: no Retry). */
    this.stamp = "none";
    this.stampError = null;

    this.started = false;
    this.disposed = false;
    this.positionCounts = new Map();
    this.halfmoveClock = 0;
  }

  get botColor() { return opposite(this.playerColor); }
  get isOver() { return this.result != null; }

  /** The player may move: their turn, the bot not thinking. */
  get canPlayerMove() {
    return !this.isOver && this.board.sideToMove === this.playerColor && !this.isThinking;
  }

  /** The moves the player made, the number a win is ranked by. */
  get playerMoveCount() {
    return this.moves.filter((played) => played.color === this.playerColor).length;
  }

  /** The board opened: if the bot has white it moves now. */
  start() {
    if (this.started) return;
    this.started = true;
    this.positionCounts.set(positionKey(this.board), 1);
    this.changed();
    this.botMoveIfDue();
  }

  play(move) {
    if (!this.started || !this.canPlayerMove || !isLegalMove(this.board, move)) return false;
    this.apply(normalizingPromotion(this.board, move));
    return true;
  }

  resign() {
    if (!this.started || this.isOver) return;
    this.finish({ kind: "lost", why: "resignation" });
    this.changed();
  }

  retry() {
    if (this.stamp !== "failed") return;
    this.sendStamp();
    this.changed();
  }

  /** The account changed: nothing more is sent or played for this game. */
  dispose() {
    this.disposed = true;
  }

  changed() {
    if (this.disposed) return;
    try { this.onChange(); } catch { /* a repaint must not break the game */ }
  }

  // --- The board ---

  apply(move) {
    const board = this.board;
    const piece = pieceAt(board, move.from);
    if (!piece) return;
    const isEnPassant = piece.type === "pawn" && board.enPassantTarget && squareEquals(move.to, board.enPassantTarget) && !pieceAt(board, move.to);
    const captured = pieceAt(board, move.to)?.type || (isEnPassant ? "pawn" : null);
    const mover = board.sideToMove;
    this.board = applyMove(board, move);
    this.moves.push({ move, color: mover, piece: piece.type, captured });

    this.halfmoveClock = (piece.type === "pawn" || captured) ? 0 : this.halfmoveClock + 1;
    const key = positionKey(this.board);
    this.positionCounts.set(key, (this.positionCounts.get(key) || 0) + 1);

    if (isCheckmate(this.board)) {
      this.finish(mover === this.playerColor ? { kind: "won", why: "checkmate" } : { kind: "lost", why: "checkmate" });
    } else if (isStalemate(this.board)) {
      this.finish({ kind: "drawn", why: "stalemate" });
    } else if (isInsufficientMaterial(this.board)) {
      this.finish({ kind: "drawn", why: "insufficient material" });
    } else if (this.halfmoveClock >= 100) {
      this.finish({ kind: "drawn", why: "the fifty-move rule" });
    } else if ((this.positionCounts.get(key) || 0) >= 3) {
      this.finish({ kind: "drawn", why: "threefold repetition" });
    }
    this.changed();
    this.botMoveIfDue();
  }

  finish(result) {
    if (this.result) return;
    this.result = result;
    if (this.disposed) return;
    try { this.recordResult(result); } catch { /* storage blocked: the game still ends */ }
    this.sendStamp();
  }

  /** The bot's turn: think off the main thread (never quicker than a beat), then play. */
  botMoveIfDue() {
    if (this.disposed || this.isOver || this.board.sideToMove !== this.botColor || this.isThinking) return;
    this.isThinking = true;
    this.changed();
    const position = this.board;
    const settings = botSearchSettings(this.bot, this.moves.length);
    const avoiding = this.repeatingMoves();
    const began = this.now();
    Promise.resolve()
      .then(() => this.think(position, settings, avoiding))
      .catch((error) => { this.log(`Bot search failed: ${error?.message || error}`); return null; })
      .then(async (move) => {
        const elapsed = this.now() - began;
        if (elapsed < BOT_MIN_THINK_MS) await this.sleep(BOT_MIN_THINK_MS - elapsed);
        this.isThinking = false;
        if (this.disposed || this.isOver || !move || this.board !== position) { this.changed(); return; }
        this.apply(move);
      });
  }

  /** The bot's moves that bring back a position already seen this game. */
  repeatingMoves() {
    return legalMoves(this.board).filter((m) => this.positionCounts.has(positionKey(applyMove(this.board, m))));
  }

  // --- On chain ---

  /** Goes on even if the player leaves the screen: only another account stops it. Never twice for
   *  one game: not while one is going out, once one went out, or once one may have
   *  ("unconfirmed", iOS 4922804). */
  sendStamp() {
    if (this.disposed || !this.result || !["none", "failed"].includes(this.stamp)) return;
    this.stamp = "sending";
    this.stampError = null;
    const result = this.result;
    const message = botResultMessage(this.id, this.bot.level, this.playerColor, result, this.moves.map((played) => played.move));
    this.sendWithRetries(message).then((outcome) => {
      if (this.disposed) return;
      if (outcome?.unknown) {
        // A node may have taken it and never answered: it may be on chain. No Retry - a second
        // stamp of the same game (iOS 4922804 .unconfirmed).
        this.stamp = "unconfirmed";
        this.stampError = outcome.unknown;
        this.changed();
        return;
      }
      const error = outcome?.error;
      if (error) {
        this.stamp = "failed";
        this.stampError = error;
        this.changed();
        return;
      }
      this.stamp = "stamped";
      if (result.kind === "won") {
        try { this.recordStampedWin(this.playerMoveCount); } catch { /* storage blocked: it is still on chain */ }
      }
      this.changed();
    });
  }

  /** One broadcast transaction, with the retries a send needs while the change of the last
   *  transaction is not spendable yet (the arena's sends do the same). Only that kind of error
   *  is retried (isRetryableSendError): no KAS on the chatting address, or a send whose outcome
   *  is unknown (a second stamp of the same game), fails at once (iOS 8d5f925). Resolves null once
   *  it is sent, `{ unknown: note }` when it may have gone through (SEND_OUTCOME_UNKNOWN, iOS
   *  4922804), else `{ error }` - the error to show. */
  async sendWithRetries(message) {
    const content = encodeBotMessage(message);
    let attempt = 0;
    for (;;) {
      if (this.disposed) return null;
      try {
        await this.sendContent(content);
        return null;
      } catch (error) {
        if (sendOutcomeUnknownTxid(error) !== null) {
          this.log("Chess bot game stamp outcome unknown");
          return { unknown: error?.message || SEND_OUTCOME_UNKNOWN_NOTE };
        }
        attempt += 1;
        if (attempt > BOT_SEND_RETRIES || !isRetryableSendError(error)) {
          this.log(`Chess bot game stamp failed: ${error?.message || String(error)}`);
          return { error: friendlySendErrorMessage(error) };
        }
        await this.sleep(BOT_SEND_RETRY_MS);
      }
    }
  }
}
