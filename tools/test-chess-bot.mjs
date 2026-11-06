// KaPlay > Bots (iOS c3c04a1, KaPlay ddec987, ONLINE_CHESS.md §7): the #chess-bots stamp against
// iOS's bytes, the five bots and their settings, the search board against engine/chess.js's rules
// (every legal move, make/unmake), mate in one found at level 5, a repeated position scored as
// a draw, every level's search inside its time limit, the unlock rules, the game loop (free while
// played, one stamp when it ends, five retries then Retry, resign), and a bot's board (fewest moves
// to win, the player's own stamped wins merged in). Pure: no DOM, no network. Run from the repo
// root:
//
//   node tools/test-chess-bot.mjs

import * as Chess from "../engine/chess.js";
import {
  CHESS_BOTS, CHESS_BOTS_CHANNEL, chessBot, botSearchSettings, botResultMessage, encodeBotMessage, newBotGameId,
  sampleStampContent, botRecord, isBotUnlocked, addBotResult, parseBotRecords, BotPosition, botMoveToChessMove, chessBotBestMove,
  addStampedWin, bestStampedWin, parseStampedWins, indexerBotBoards, botBoardRows, botHasBeenPlayed,
  ChessBotGame, BOT_SEND_RETRIES,
} from "../engine/chess-bot.js";
import { broadcastPayloadBytes, isServiceBroadcastChannel } from "../engine/broadcasts.js";
import { periodSinceMs } from "../engine/chess-tournament.js";

const r = {
  pass: 0, fail: 0, failures: [],
  check(ok, label) { if (ok) this.pass++; else { this.fail++; this.failures.push(label); } },
  eq(a, b, label) { this.check(a === b, `${label}: got ${String(a)}, expected ${String(b)}`); },
};

// --- A FEN reader for the test positions ------------------------------------------------------
function fen(text) {
  const [placement, side, castling, ep] = text.trim().split(/\s+/);
  const types = { p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen", k: "king" };
  const squares = Array.from({ length: 8 }, () => Array(8).fill(null));
  placement.split("/").forEach((row, i) => {
    const rank = 7 - i;
    let file = 0;
    for (const ch of row) {
      if (/\d/.test(ch)) { file += Number(ch); continue; }
      squares[rank][file] = { type: types[ch.toLowerCase()], color: ch === ch.toUpperCase() ? Chess.WHITE : Chess.BLACK };
      file += 1;
    }
  });
  return {
    squares,
    sideToMove: side === "b" ? Chess.BLACK : Chess.WHITE,
    whiteCanCastleKingside: castling.includes("K"),
    whiteCanCastleQueenside: castling.includes("Q"),
    blackCanCastleKingside: castling.includes("k"),
    blackCanCastleQueenside: castling.includes("q"),
    enPassantTarget: ep && ep !== "-" ? Chess.squareFromAlgebraic(ep) : null,
  };
}
const moveText = (m) => `${Chess.algebraic(m.from)}${Chess.algebraic(m.to)}${m.promotion ? Chess.promotionLetter(m.promotion) : ""}`;
const now = () => performance.now();

// --- The stamp: the bytes iOS's JSONEncoder (.sortedKeys, .withoutEscapingSlashes) emits --------
const uci = (text) => text.split(" ").map((m) => ({ from: Chess.squareFromAlgebraic(m.slice(0, 2)), to: Chess.squareFromAlgebraic(m.slice(2, 4)), promotion: Chess.promotionFromLetter(m[4]) || null }));
// The example in iOS ONLINE_CHESS.md §7, game id as printed there; run through Swift's JSONEncoder
// to check it.
r.eq(
  encodeBotMessage(botResultMessage("3b0f…", 3, Chess.WHITE, { kind: "won", why: "checkmate" }, uci("e2e4 e7e5 d1h5 b8c6 f1c4 g8f6 h5f7"))),
  `{"a":"result","bot":3,"c":"w","g":"3b0f…","m":"e2e4 e7e5 d1h5 b8c6 f1c4 g8f6 h5f7","r":"won","type":"chess_bot","v":2,"why":"checkmate"}`,
  "the stamp matches the iOS example byte for byte",
);
const gid = "9d2c7a54-1f0e-4b8a-a3c1-6e5f4d3b2a10";
r.eq(
  encodeBotMessage(botResultMessage(gid, 5, Chess.BLACK, { kind: "drawn", why: "the fifty-move rule" }, uci("e7e8q"))),
  `{"a":"result","bot":5,"c":"b","g":"${gid}","m":"e7e8q","r":"drawn","type":"chess_bot","v":2,"why":"the fifty-move rule"}`,
  "black, a draw, a promotion: Swift's bytes",
);
r.eq(uci("e7e8n")[0].promotion, "knight", "the test's move reader takes a promotion");
r.check(encodeBotMessage(botResultMessage(gid, 1, Chess.WHITE, { kind: "lost", why: "resignation" }, [])).includes(`"m":""`), "a game resigned before a move still has its m");
{
  const sample = JSON.parse(sampleStampContent());
  r.eq(sample.m.split(" ").length, 80, "the fee sample is 40 moves a side");
  r.eq(`${sample.r} ${sample.why} ${sample.bot} ${sample.c}`, "won checkmate 1 w", "the fee sample is iOS's");
}
r.check(!encodeBotMessage({ type: "chess_bot", v: 1, g: "a/b", a: "x" }).includes("\\/"), "slashes are not escaped");
r.eq(CHESS_BOTS_CHANNEL, "chess-bots", "channel");
r.eq(broadcastPayloadBytes(CHESS_BOTS_CHANNEL, "{}"), "kchat:1:bcast:chess-bots:{}".length, "payload prefix kchat:1:bcast:chess-bots:");
r.check(isServiceBroadcastChannel("chess-bots"), "#chess-bots is a service room, never a public chat");
const id = newBotGameId();
r.check(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id), `game id is a lowercase UUID (${id})`);

// --- The bots (ChessBotModels.swift) ---------------------------------------------------------
r.eq(CHESS_BOTS.map((b) => `${b.level}:${b.name}:${b.title}:${b.initials}`).join("|"),
  "1:Kaspa Silver:Beginner:KS|2:Izio Dev:Novice:ID|3:Coderofstuff:Intermediate:CS|4:Michael Sutton:Advanced:MS|5:Yonatan Sompolinsky:Master:YS",
  "five bots, names, titles, initials");
r.eq(CHESS_BOTS.map((b) => [b.settings.depth, b.settings.quiescence ? 1 : 0, b.settings.noise, b.settings.randomChance, b.settings.timeLimit].join(",")).join("|"),
  "1,0,250,0.35,1|1,1,100,0.12,1|2,1,40,0.04,2|3,1,12,0,3|6,1,0,0,4",
  "depth, quiescence, noise, random chance, time limit");
r.eq(botSearchSettings(chessBot(5), 0).noise, 12, "the master varies its opening: noise 12 at ply 0");
r.eq(botSearchSettings(chessBot(5), 7).noise, 12, "noise 12 at ply 7");
r.eq(botSearchSettings(chessBot(5), 8).noise, 0, "noise 0 from ply 8");
r.eq(botSearchSettings(chessBot(4), 0).noise, 12, "a bot with noise keeps its own");
r.eq(botSearchSettings(chessBot(1), 0).noise, 250, "beginner noise");

// --- Unlock rules and the record ----------------------------------------------------------------
let records = {};
r.check(isBotUnlocked(records, 1), "level 1 is open from the start");
r.check(!isBotUnlocked(records, 2), "level 2 is locked before a win");
records = addBotResult(records, 1, "lost");
records = addBotResult(records, 1, "drawn");
r.check(!isBotUnlocked(records, 2), "a loss and a draw do not unlock level 2");
records = addBotResult(records, 1, "won");
r.check(isBotUnlocked(records, 2), "a win against level 1 unlocks level 2");
r.check(!isBotUnlocked(records, 3), "level 3 stays locked");
r.eq(JSON.stringify(botRecord(records, 1)), `{"wins":1,"losses":1,"draws":1}`, "record W/L/D");
r.eq(JSON.stringify(botRecord(records, 4)), `{"wins":0,"losses":0,"draws":0}`, "an unplayed level is 0/0/0");
const reread = parseBotRecords(JSON.stringify(records));
r.check(isBotUnlocked(reread, 2) && botRecord(reread, 1).wins === 1, "records survive a save and a read");
r.eq(JSON.stringify(parseBotRecords("not json")), "{}", "a broken store reads as nothing played");
records = addBotResult(addBotResult(addBotResult(records, 2, "won"), 3, "won"), 4, "won");
r.check(isBotUnlocked(records, 5), "beating level 4 unlocks the master");

// --- The search board against the rules engine --------------------------------------------------
// Every legal move engine/chess.js knows (promotions to queen or knight: the search makes no
// others) and nothing else, through random games; make/unmake gives the same board back.
function boardKey(position) { return `${[...position.squares].join(",")}|${position.side}|${position.castling}|${position.enPassant}|${position.kings.join(",")}`; }
function compareGenerators(board, label) {
  const expected = Chess.legalMoves(board).filter((m) => !m.promotion || m.promotion === "queen" || m.promotion === "knight").map(moveText).sort();
  const position = new BotPosition(board);
  const before = boardKey(position);
  const got = position.legalMoves().map((m) => moveText(botMoveToChessMove(m))).sort();
  for (const m of position.moves(false)) { position.make(m); position.unmake(); }
  const same = expected.join(" ") === got.join(" ");
  r.check(same, `${label}: legal moves\n      rules:  ${expected.join(" ")}\n      search: ${got.join(" ")}`);
  r.check(boardKey(position) === before, `${label}: make/unmake restores the board`);
  return same;
}
const tricky = {
  kiwipete: "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1",
  enPassant: "8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1",
  promotions: "r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1",
  pinnedEp: "8/8/8/K2pP2r/8/8/8/7k w - d6 0 1",
  blackPromo: "8/8/8/8/8/8/1p4k1/2R3K1 b - - 0 1",
};
for (const [name, text] of Object.entries(tricky)) compareGenerators(fen(text), name);
{
  let seed = 7;
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  let mismatches = 0;
  for (let game = 0; game < 40; game += 1) {
    let board = Chess.initialBoard();
    for (let ply = 0; ply < 120; ply += 1) {
      const legal = Chess.legalMoves(board);
      if (!legal.length) break;
      const expected = legal.filter((m) => !m.promotion || m.promotion === "queen" || m.promotion === "knight").map(moveText).sort().join(" ");
      const position = new BotPosition(board);
      const before = boardKey(position);
      const got = position.legalMoves().map((m) => moveText(botMoveToChessMove(m))).sort().join(" ");
      if (got !== expected || boardKey(position) !== before) { mismatches += 1; if (mismatches < 3) compareGenerators(board, `random game ${game} ply ${ply}`); }
      board = Chess.applyMove(board, legal[Math.floor(rand() * legal.length)]);
    }
  }
  r.eq(mismatches, 0, "random games: the search board's legal moves match engine/chess.js at every ply");
}

// --- The bot's move is always one of the rules engine's legal moves --------------------------
{
  const board = fen(tricky.kiwipete);
  const legal = Chess.legalMoves(board).map(moveText);
  for (const bot of CHESS_BOTS.slice(0, 3)) {
    for (let i = 0; i < 5; i += 1) {
      const m = chessBotBestMove(board, bot.settings);
      r.check(m && legal.includes(moveText(m)) && Chess.isLegalMove(board, m), `level ${bot.level}: move ${m && moveText(m)} is legal`);
    }
  }
  // An always-random beginner still plays a legal move.
  const m = chessBotBestMove(board, { ...chessBot(1).settings, randomChance: 1 });
  r.check(m && Chess.isLegalMove(board, m), "a random move is a legal one");
  r.eq(chessBotBestMove(fen("7k/5Q2/6K1/8/8/8/8/8 b - - 0 1"), chessBot(5).settings), null, "no move when the game is over (stalemate)");
  const only = chessBotBestMove(fen("k7/8/1K6/8/8/8/8/1R6 b - - 0 1"), chessBot(5).settings);
  r.eq(only && moveText(only), "a8b8", "the only legal move is played at once");
}

// --- Mate in one at level 5 --------------------------------------------------------------------
const mates = {
  "back rank": "6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1",
  "back rank, black": "r5k1/5ppp/8/8/8/8/5PPP/6K1 b - - 0 1",
  "scholar's": "r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5Q2/PPPP1PPP/RNB1K1NR w KQkq - 2 3",
  "smothered": "6rk/6pp/8/6N1/8/8/8/6K1 w - - 0 1",
  "promotion": "k7/2P5/1K6/8/8/8/8/8 w - - 0 1",
};
for (const [name, text] of Object.entries(mates)) {
  const board = fen(text);
  let info = null;
  const began = now();
  const m = chessBotBestMove(board, chessBot(5).settings, [], { info: (i) => { info = i; } });
  const elapsed = now() - began;
  r.check(m && Chess.isCheckmate(Chess.applyMove(board, m)), `level 5 finds mate in one (${name}): played ${m && moveText(m)}`);
  r.check(info && info.score >= 100_000 - 100, `${name}: scored as a mate (${info?.score})`);
  r.check(elapsed < 1_000, `${name}: a mate stops the deepening early (${elapsed.toFixed(0)} ms)`);
}
// The opening noise (ply < 8) must not cost a mate either.
r.check(Chess.isCheckmate(Chess.applyMove(fen(mates["scholar's"]), chessBotBestMove(fen(mates["scholar's"]), botSearchSettings(chessBot(5), 4)))), "level 5 with opening noise still mates");

// --- A move that repeats a position scores as a draw -------------------------------------------
{
  // White has only a king against king and queen: every move loses, except the one that repeats.
  const board = fen("8/8/8/3k4/8/2q5/8/6K1 w - - 0 1");
  const legal = Chess.legalMoves(board);
  const repeat = legal.find((m) => moveText(m) === "g1h2") || legal[0];
  const m = chessBotBestMove(board, chessBot(4).settings, [repeat]);
  r.eq(m && moveText(m), moveText(repeat), "a losing bot takes the repetition (scored 0)");
  // And a winning one avoids it: black to move with the queen, its repeating moves marked.
  const winning = fen("8/8/8/3k4/8/2q5/8/6K1 b - - 0 1");
  const avoid = Chess.legalMoves(winning).filter((x) => moveText(x) !== "c3e1");
  const w = chessBotBestMove(winning, chessBot(4).settings, avoid);
  r.eq(w && moveText(w), "c3e1", "a winning bot keeps out of the repetition");
}

// --- Every search finishes inside its time limit ---------------------------------------------
const timed = [
  ["opening", Chess.initialBoard()],
  ["kiwipete", fen(tricky.kiwipete)],
  ["middlegame", fen("r1bq1rk1/pp2bppp/2n1pn2/2pp4/2PP4/2N1PN2/PP2BPPP/R1BQ1RK1 w - - 0 8")],
  ["endgame", fen("8/5k2/3p4/1p1Pp2p/pP2Pp1P/P4P1K/8/8 b - - 0 1")],
];
for (const bot of CHESS_BOTS) {
  for (const [name, board] of timed) {
    if (bot.level < 4 && name !== "kiwipete" && name !== "opening") continue;
    const settings = { ...bot.settings, randomChance: 0 };
    let info = null;
    const began = now();
    const m = chessBotBestMove(board, settings, [], { info: (i) => { info = i; } });
    const elapsed = now() - began;
    // The clock is read every 1024 nodes: a few milliseconds past the limit at most.
    const limit = settings.timeLimit * 1000 + 150;
    r.check(m && Chess.isLegalMove(board, m), `level ${bot.level} ${name}: a legal move`);
    r.check(elapsed <= limit, `level ${bot.level} ${name}: ${elapsed.toFixed(0)} ms within ${settings.timeLimit} s (depth ${info?.depth})`);
    r.check((info?.depth || 0) >= 1, `level ${bot.level} ${name}: depth 1 always finishes`);
    console.log(`  level ${bot.level} ${name.padEnd(10)} ${moveText(m).padEnd(5)} depth ${info?.depth} ${String(info?.nodes).padStart(8)} nodes ${elapsed.toFixed(0).padStart(5)} ms`);
  }
}

// The clock really cuts a deeper search: depth 20 under half a second still answers in time,
// with the deepest iteration that finished.
for (const [name, board] of timed.slice(0, 3)) {
  let info = null;
  const began = now();
  const m = chessBotBestMove(board, { depth: 20, quiescence: true, noise: 0, randomChance: 0, timeLimit: 0.5 }, [], { info: (i) => { info = i; } });
  const elapsed = now() - began;
  r.check(m && Chess.isLegalMove(board, m), `depth 20 cut by the clock (${name}): a legal move`);
  r.check(elapsed <= 650, `depth 20 cut by the clock (${name}): ${elapsed.toFixed(0)} ms within 0.5 s (depth ${info?.depth})`);
  r.check(info && info.depth >= 1 && info.depth < 20, `depth 20 cut by the clock (${name}): stopped at depth ${info?.depth}`);
}

// --- The bots' boards (ChessBotLeaderboardService) ---------------------------------------------
{
  const NOW = Date.UTC(2026, 10, 15);
  const MONTH = periodSinceMs("month", NOW);
  const ME = "kaspa:me", A = "kaspa:a", B = "kaspa:b";
  r.eq(indexerBotBoards({ period: "all", bots: [] }, "month"), null, "an answer for another period is not used");
  r.eq(indexerBotBoards({ bots: [] }, "all"), null, "an old indexer without a period is not used");
  r.eq(indexerBotBoards({ period: "all" }, "all"), null, "nor an answer without bots");
  const parsed = indexerBotBoards({ period: "all", since: 1, bots: [
    { level: 3, games: 9, players: [{ address: A, moves: 20, at: 5 }, { address: "", moves: 1, at: 1 }, { address: B, moves: "x", at: 1 }] },
    { level: 9, games: 1, players: [] },
  ] }, "all");
  r.eq(parsed[3].games, 9, "games read");
  r.eq(parsed[3].rows.length, 1, "bad rows dropped");
  r.eq(parsed[9], undefined, "a level with no bot is dropped");

  const boards = { all: { 3: { games: 3, rows: [{ address: A, moves: 20, at: 5 }, { address: B, moves: 12, at: 9 }, { address: "kaspa:c", moves: 12, at: 7 }] } } };
  const names = (rows) => rows.map((row) => `${row.address.slice(6)}${row.moves}`).join(",");
  r.eq(names(botBoardRows({ boards, level: 3, period: "all", wins: {}, address: ME, nowMs: NOW })), "c12,b12,a20", "fewest moves first, the earlier win on a tie");
  r.eq(botBoardRows({ boards, level: 2, period: "all", wins: {}, address: ME, nowMs: NOW }).length, 0, "nobody has beaten it");
  r.eq(botBoardRows({ boards, level: 3, period: "month", wins: {}, address: ME, nowMs: NOW }).length, 0, "another period's rows do not leak");

  let wins = addStampedWin({}, 3, 15, MONTH + 10);
  r.eq(names(botBoardRows({ boards, level: 3, period: "all", wins, address: ME, nowMs: NOW })), "c12,b12,me15,a20", "my stamped win shows before the indexer has it");
  wins = addStampedWin(wins, 3, 11, MONTH - 10);
  r.eq(bestStampedWin(wins, 3, 0).moves, 11, "my best");
  r.eq(bestStampedWin(wins, 3, MONTH).moves, 15, "my best this month leaves out last month's");
  r.eq(bestStampedWin(wins, 3, NOW), null, "nothing since");
  r.eq(bestStampedWin(addStampedWin(addStampedWin({}, 1, 8, 50), 1, 8, 40), 1, 0).at, 40, "the earlier win on a tie");
  r.eq(names(botBoardRows({ boards, level: 3, period: "month", wins, address: ME, nowMs: NOW })), "me15", "the month board only counts this month's win");
  const known = { all: { 3: { games: 1, rows: [{ address: "KASPA:ME", moves: 14, at: 3 }] } } };
  r.eq(botBoardRows({ boards: known, level: 3, period: "all", wins: addStampedWin({}, 3, 20, MONTH), address: ME, nowMs: NOW })[0].moves, 14, "the indexer's better row stays");
  r.eq(botBoardRows({ boards: known, level: 3, period: "all", wins: addStampedWin({}, 3, 10, MONTH), address: ME, nowMs: NOW })[0].moves, 10, "my better win replaces my row, whatever the case");
  r.eq(botBoardRows({ boards: known, level: 3, period: "all", wins: addStampedWin({}, 3, 10, MONTH), address: ME, nowMs: NOW }).length, 1, "one row per player");
  r.eq(botBoardRows({ boards: {}, level: 3, period: "all", wins: addStampedWin({}, 3, 10, MONTH), address: "", nowMs: NOW }).length, 0, "no account, no own row");

  r.eq(JSON.stringify(parseStampedWins(JSON.stringify(addStampedWin({}, 2, 9, 77)))), `{"2":[{"moves":9,"at":77}]}`, "stamped wins round trip");
  r.eq(JSON.stringify(parseStampedWins("nonsense")), "{}", "bad storage is empty");
  r.eq(JSON.stringify(parseStampedWins(`{"2":[{"moves":"x"}],"9":[{"moves":1,"at":1}]}`)), `{"2":[]}`, "bad wins and levels dropped");

  r.check(!botHasBeenPlayed({ records: {}, boards: {}, level: 4 }), "an unplayed bot");
  r.check(botHasBeenPlayed({ records: addBotResult({}, 4, "drawn"), boards: {}, level: 4 }), "played here");
  r.check(botHasBeenPlayed({ records: {}, boards: { all: { 4: { games: 1, rows: [] } } }, level: 4 }), "played by someone, by the indexer's all-time count");
  r.check(!botHasBeenPlayed({ records: {}, boards: { month: { 4: { games: 1, rows: [] } } }, level: 4 }), "only the all-time count decides");
}

// --- The game loop (ChessBotGame.swift, KaPlay ddec987) ----------------------------------------
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function settle(times = 30) { for (let i = 0; i < times; i += 1) await tick(); }
const sq = Chess.squareFromAlgebraic;

{
  // Player white, a bot that answers instantly: nothing is sent while the game is on.
  const sent = [];
  let recorded = null;
  let stampedMoves = null;
  const game = new ChessBotGame({
    bot: chessBot(1), playerColor: Chess.WHITE,
    send: async (content) => { sent.push(JSON.parse(content)); },
    think: async (board) => Chess.legalMoves(board)[0],
    record: (result) => { recorded = result; },
    recordStampedWin: (moves) => { stampedMoves = moves; },
    sleep: async () => {},
    id: gid,
  });
  r.check(!game.play({ from: sq("e2"), to: sq("e4"), promotion: null }), "nothing before start");
  game.start();
  r.check(game.canPlayerMove, "the player moves at once: nothing has to land first");
  r.check(!game.play({ from: sq("e2"), to: sq("e5"), promotion: null }), "an illegal move is refused");
  r.check(game.play({ from: sq("e2"), to: sq("e4"), promotion: null }), "e2e4 played");
  r.check(!game.canPlayerMove, "the bot's turn");
  await settle();
  r.eq(game.moves.length, 2, "the bot answered");
  r.eq(game.board.sideToMove, Chess.WHITE, "the player's turn again");
  r.eq(sent.length, 0, "a game on sends nothing");
  r.eq(game.stamp, "none", "no stamp yet");
  const played = game.moves.map((p) => moveText(p.move)).join(" ");
  game.resign();
  r.eq(recorded?.kind, "lost", "resigning records the loss at once");
  r.eq(recorded?.why, "resignation", "by resignation");
  r.eq(game.stamp, "sending", "the stamp goes out");
  await settle();
  r.eq(sent.length, 1, "one transaction for the whole game");
  r.eq(encodeBotMessage(sent[0]), `{"a":"result","bot":1,"c":"w","g":"${gid}","m":"${played}","r":"lost","type":"chess_bot","v":2,"why":"resignation"}`, "the stamp carries the result and every move");
  r.eq(game.stamp, "stamped", "stamped");
  r.eq(stampedMoves, null, "a loss is not a win that counts");
  r.check(!game.canPlayerMove, "no moves after the game is over");
  game.resign();
  game.retry();
  await settle();
  r.eq(sent.length, 1, "never stamped twice");
}

{
  // Bot white: it moves as the board opens.
  const sent = [];
  let thinks = 0;
  const game = new ChessBotGame({
    bot: chessBot(2), playerColor: Chess.BLACK,
    send: async (content) => { sent.push(JSON.parse(content)); },
    think: async (board) => { thinks += 1; return Chess.legalMoves(board)[0]; },
    sleep: async () => {},
  });
  game.start();
  r.check(!game.canPlayerMove, "the bot has white and is thinking");
  await settle();
  r.eq(thinks, 1, "with white the bot moves first");
  r.eq(sent.length, 0, "and it costs nothing");
  r.check(game.canPlayerMove, "then the player's turn");
  r.eq(game.playerMoveCount, 0, "the bot's move is not the player's");
}

{
  // A stamp that keeps failing with a retryable error: five retries, then it holds until Retry.
  // Then it counts.
  let attempts = 0;
  let failing = true;
  const sleeps = [];
  const stamped = [];
  const game = new ChessBotGame({
    bot: chessBot(1), playerColor: Chess.WHITE,
    send: async () => { attempts += 1; if (failing) throw new Error("no spendable UTXOs available"); },
    think: async () => null,
    recordStampedWin: (moves) => stamped.push(moves),
    sleep: async (ms) => { sleeps.push(ms); },
  });
  // Mate in one for the player, from a position with a move already played.
  game.board = fen("6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1");
  game.start();
  r.check(game.play({ from: sq("a1"), to: sq("a8"), promotion: null }), "back rank mate");
  r.eq(game.result?.kind, "won", "the player won");
  await settle(60);
  r.eq(attempts, 1 + BOT_SEND_RETRIES, "one send and five retries");
  r.check(sleeps.filter((ms) => ms === 1_200).length === BOT_SEND_RETRIES, "1.2 s between retries");
  r.eq(game.stamp, "failed", "the stamp failed");
  r.eq(game.stampError, "no spendable UTXOs available", "the error is held");
  r.eq(stamped.length, 0, "a win that is not on chain does not count");
  failing = false;
  game.retry();
  r.eq(game.stampError, null, "Retry clears the error");
  r.eq(game.stamp, "sending", "and sends again");
  await settle();
  r.eq(game.stamp, "stamped", "stamped on Retry");
  r.eq(stamped.join(), "1", "the win counts with the player's own moves");
  game.retry();
  await settle();
  r.eq(attempts, 1 + BOT_SEND_RETRIES + 1, "Retry does nothing once it is stamped");
}

{
  // Errors that are not retried (iOS 8d5f925): an unknown outcome, no coins at all, a refused
  // double spend - one attempt each, no sleep, and the error mapped for display.
  const cases = [
    [Object.assign(new Error("This may have gone through, but the network didn't confirm it."), { code: "SEND_OUTCOME_UNKNOWN" }), "This may have gone through, but the network didn't confirm it."],
    [new Error("No UTXOs found. Fund the receive address first."), "Not enough KAS on your Chatting Address. Add some and try again."],
    [new Error("Insufficient funds: need 0.1 KAS"), "Not enough KAS on your Chatting Address. Add some and try again."],
    [new Error("transaction rejected: double spend in mempool"), "The network is still confirming your previous send. Please try again in a few seconds."],
  ];
  for (const [thrown, shown] of cases) {
    let attempts = 0;
    const sleeps = [];
    const game = new ChessBotGame({
      bot: chessBot(1), playerColor: Chess.WHITE,
      send: async () => { attempts += 1; throw thrown; },
      think: async () => null,
      recordStampedWin: () => {},
      sleep: async (ms) => { sleeps.push(ms); },
    });
    game.board = fen("6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1");
    game.start();
    game.play({ from: sq("a1"), to: sq("a8"), promotion: null });
    await settle(20);
    r.eq(attempts, 1, `not retried: ${thrown.message}`);
    r.eq(sleeps.filter((ms) => ms === 1_200).length, 0, `no retry wait: ${thrown.message}`);
    r.eq(game.stamp, "failed", `failed at once: ${thrown.message}`);
    r.eq(game.stampError, shown, `shown as: ${shown}`);
  }
}

{
  // Another account: nothing more is sent or counted for this game.
  let sends = 0;
  let release = null;
  const stamped = [];
  const game = new ChessBotGame({
    bot: chessBot(1), playerColor: Chess.WHITE,
    send: () => { sends += 1; return new Promise((resolve) => { release = resolve; }); },
    think: async () => null,
    recordStampedWin: (moves) => stamped.push(moves),
    sleep: async () => {},
  });
  game.board = fen("6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1");
  game.start();
  game.play({ from: sq("a1"), to: sq("a8"), promotion: null });
  r.eq(sends, 1, "the stamp is in flight");
  game.dispose();
  release();
  await settle();
  r.eq(stamped.length, 0, "the old account's win is not counted under the new one");
  const late = new ChessBotGame({ bot: chessBot(1), playerColor: Chess.WHITE, send: async () => { sends += 1; }, think: async () => null, sleep: async () => {} });
  late.start();
  late.dispose();
  late.resign();
  await settle();
  r.eq(sends, 1, "a disposed game sends nothing");
}

{
  // The bot thinks at least 0.8 s.
  const sleeps = [];
  const game = new ChessBotGame({
    bot: chessBot(1), playerColor: Chess.BLACK,
    send: async () => {},
    think: async (board) => Chess.legalMoves(board)[0],
    sleep: async (ms) => { sleeps.push(ms); },
  });
  game.start();
  await settle();
  r.check(sleeps.length === 1 && sleeps[0] > 700 && sleeps[0] <= 800, `a quick answer waits out the 0.8 s (${sleeps[0]?.toFixed?.(0)} ms)`);
}

{
  // Fool's mate: the bot (black) mates, the player lost; results follow from the rules.
  const script = ["e7e5", "d8h4"];
  const sent = [];
  let recorded = null;
  const stamped = [];
  const game = new ChessBotGame({
    bot: chessBot(3), playerColor: Chess.WHITE,
    send: async (content) => { sent.push(JSON.parse(content)); },
    think: async (board) => { const t = script.shift(); return Chess.legalMoves(board).find((m) => moveText(m) === t); },
    record: (result) => { recorded = result; },
    recordStampedWin: (moves) => stamped.push(moves),
    sleep: async () => {},
  });
  game.start();
  await settle();
  game.play({ from: sq("f2"), to: sq("f3"), promotion: null });
  await settle();
  game.play({ from: sq("g2"), to: sq("g4"), promotion: null });
  await settle();
  r.eq(recorded && `${recorded.kind} ${recorded.why}`, "lost checkmate", "checkmate by the bot is a loss");
  r.eq(game.moves.length, 4, "four plies");
  r.eq(sent.length, 1, "one stamp");
  r.eq(sent[0].m, "f2f3 e7e5 g2g4 d8h4", "with every move, both sides");
  r.eq(`${sent[0].r} ${sent[0].why} ${sent[0].c}`, "lost checkmate w", "the result as the player had it");
  r.eq(stamped.length, 0, "a loss does not count");
}

{
  // A pawn reaching the back rank without a choice is a queen (normalizingPromotion), and it mates.
  const sent = [];
  const game = new ChessBotGame({ bot: chessBot(1), playerColor: Chess.WHITE, send: async (c) => { sent.push(JSON.parse(c)); }, think: async (b) => Chess.legalMoves(b)[0], sleep: async () => {} });
  game.board = fen("7k/4P3/6K1/8/8/8/8/8 w - - 0 1");
  game.start();
  game.play({ from: sq("e7"), to: sq("e8"), promotion: null });
  await settle();
  r.eq(sent[0]?.m, "e7e8q", "promotion q in the stamp");
  r.eq(game.playerMoveCount, 1, "one move");
}

if (r.fail) {
  console.error(`FAIL ${r.fail} of ${r.pass + r.fail}`);
  for (const failure of r.failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`ok ${r.pass} checks`);
