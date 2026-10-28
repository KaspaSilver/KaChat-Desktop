// Chess Online > Bots (iOS c3c04a1, ONLINE_CHESS.md §7): the #chess-bots codec against iOS's
// bytes, the five bots and their settings, the search board against engine/chess.js's rules
// (every legal move, make/unmake), mate in one found at level 5, a repeated position scored as
// a draw, every level's search inside its time limit, the unlock rules and the game loop (the
// one-at-a-time outbox, five retries then Retry, resign). Pure: no DOM, no network. Run from the
// repo root:
//
//   node tools/test-chess-bot.mjs

import * as Chess from "../engine/chess.js";
import {
  CHESS_BOTS, CHESS_BOTS_CHANNEL, chessBot, botSearchSettings, botMessages, encodeBotMessage, newBotGameId,
  botRecord, isBotUnlocked, addBotResult, parseBotRecords, BotPosition, botMoveToChessMove, chessBotBestMove,
  ChessBotGame, BOT_SEND_RETRIES,
} from "../engine/chess-bot.js";
import { broadcastPayloadBytes, isServiceBroadcastChannel } from "../engine/broadcasts.js";

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

// --- Codec: the bytes iOS's JSONEncoder (.sortedKeys, .withoutEscapingSlashes) emits ------------
// The example in iOS ONLINE_CHESS.md §7, game id as printed there.
r.eq(
  encodeBotMessage(botMessages.move("3b0f…", 2, { from: Chess.squareFromAlgebraic("g8"), to: Chess.squareFromAlgebraic("f6"), promotion: null })),
  `{"a":"move","from":"g8","g":"3b0f…","n":2,"to":"f6","type":"chess_bot","v":1}`,
  "move matches the iOS example byte for byte",
);
const gid = "9d2c7a54-1f0e-4b8a-a3c1-6e5f4d3b2a10";
r.eq(encodeBotMessage(botMessages.start(gid, 3, Chess.BLACK)), `{"a":"start","bot":3,"c":"b","g":"${gid}","type":"chess_bot","v":1}`, "start: bot level and the player's colour");
r.eq(encodeBotMessage(botMessages.start(gid, 1, Chess.WHITE)), `{"a":"start","bot":1,"c":"w","g":"${gid}","type":"chess_bot","v":1}`, "start as white");
r.eq(
  encodeBotMessage(botMessages.move(gid, 41, { from: Chess.squareFromAlgebraic("e7"), to: Chess.squareFromAlgebraic("e8"), promotion: "knight" })),
  `{"a":"move","from":"e7","g":"${gid}","n":41,"promo":"n","to":"e8","type":"chess_bot","v":1}`,
  "promotion letter sits between n and to",
);
r.eq(encodeBotMessage(botMessages.resign(gid)), `{"a":"resign","g":"${gid}","type":"chess_bot","v":1}`, "resign");
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

// --- The game loop (ChessBotGame.swift) --------------------------------------------------------
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function settle(times = 30) { for (let i = 0; i < times; i += 1) await tick(); }

{
  // Player white, sends that land at once, a bot that answers instantly.
  const sent = [];
  let recorded = null;
  const game = new ChessBotGame({
    bot: chessBot(1), playerColor: Chess.WHITE,
    send: async (content) => { sent.push(JSON.parse(content)); },
    think: async (board) => Chess.legalMoves(board)[0],
    record: (result) => { recorded = result; },
    sleep: async () => {},
    id: gid,
  });
  r.check(!game.canPlayerMove || game.outbox.length === 0, "nothing before start");
  game.start();
  r.check(!game.canPlayerMove, "the player waits for the start to go on chain");
  await settle();
  r.eq(sent[0]?.a, "start", "the start goes first");
  r.eq(sent[0]?.c, "w", "start carries the player's colour");
  r.check(game.canPlayerMove, "the player may move once the start is on chain");
  r.check(!game.play({ from: Chess.squareFromAlgebraic("e2"), to: Chess.squareFromAlgebraic("e5"), promotion: null }), "an illegal move is refused");
  r.check(game.play({ from: Chess.squareFromAlgebraic("e2"), to: Chess.squareFromAlgebraic("e4"), promotion: null }), "e2e4 played");
  r.check(!game.canPlayerMove, "no second move while the first is sending");
  await settle();
  r.eq(sent.map((m) => `${m.a}${m.n ?? ""}`).join(","), "start,move1,move2", "the player's move, then the bot's, in order");
  r.eq(game.movesOnChain, 2, "two moves on chain");
  r.eq(game.board.sideToMove, Chess.WHITE, "the player's turn again");
  game.resign();
  r.eq(recorded?.kind, "lost", "resigning records the loss at once");
  r.eq(recorded?.why, "resignation", "by resignation");
  await settle();
  r.eq(sent.at(-1)?.a, "resign", "then the resign goes on chain");
  r.check(!game.canPlayerMove, "no moves after the game is over");
}

{
  // Bot white: it moves once the start lands, never before.
  const sent = [];
  let thinks = 0;
  const game = new ChessBotGame({
    bot: chessBot(2), playerColor: Chess.BLACK,
    send: async (content) => { sent.push(JSON.parse(content)); },
    think: async (board) => { thinks += 1; return Chess.legalMoves(board)[0]; },
    sleep: async () => {},
  });
  game.start();
  r.eq(thinks, 0, "the bot does not think before the start is on chain");
  await settle();
  r.eq(thinks, 1, "with white the bot moves after the start");
  r.eq(sent.map((m) => `${m.a}${m.n ?? ""}`).join(","), "start,move1", "start then the bot's first move");
  r.eq(sent[0]?.c, "b", "the player plays black");
  r.check(game.canPlayerMove, "then the player's turn");
}

{
  // A send that keeps failing: five retries, then the game holds until Retry.
  let attempts = 0;
  let failing = true;
  const sleeps = [];
  const game = new ChessBotGame({
    bot: chessBot(1), playerColor: Chess.WHITE,
    send: async () => { attempts += 1; if (failing) throw new Error("no spendable UTXO"); },
    think: async (board) => Chess.legalMoves(board)[0],
    sleep: async (ms) => { sleeps.push(ms); },
  });
  game.start();
  await settle(60);
  r.eq(attempts, 1 + BOT_SEND_RETRIES, "one send and five retries");
  r.check(sleeps.filter((ms) => ms === 1_200).length === BOT_SEND_RETRIES, "1.2 s between retries");
  r.eq(game.sendError, "no spendable UTXO", "the error is held");
  r.check(!game.canPlayerMove, "no moves while a send has failed");
  failing = false;
  game.retry();
  await settle();
  r.eq(game.sendError, null, "Retry clears the error");
  r.check(game.canPlayerMove && game.outbox.length === 0, "and the game goes on");
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
  let recorded = null;
  const game = new ChessBotGame({
    bot: chessBot(3), playerColor: Chess.WHITE,
    send: async () => {},
    think: async (board) => { const t = script.shift(); return Chess.legalMoves(board).find((m) => moveText(m) === t); },
    record: (result) => { recorded = result; },
    sleep: async () => {},
  });
  game.start();
  await settle();
  game.play({ from: Chess.squareFromAlgebraic("f2"), to: Chess.squareFromAlgebraic("f3"), promotion: null });
  await settle();
  game.play({ from: Chess.squareFromAlgebraic("g2"), to: Chess.squareFromAlgebraic("g4"), promotion: null });
  await settle();
  r.eq(recorded && `${recorded.kind} ${recorded.why}`, "lost checkmate", "checkmate by the bot is a loss");
  r.eq(game.moves.length, 4, "four plies");
  r.eq(game.movesOnChain, 4, "the mating move goes on chain too");
}

{
  // A pawn reaching the back rank without a choice is a queen (normalizingPromotion).
  const sent = [];
  const game = new ChessBotGame({ bot: chessBot(1), playerColor: Chess.WHITE, send: async (c) => { sent.push(JSON.parse(c)); }, think: async (b) => Chess.legalMoves(b)[0], sleep: async () => {} });
  game.board = fen("k7/4P3/8/8/8/8/8/K7 w - - 0 1");
  game.start();
  await settle();
  game.play({ from: Chess.squareFromAlgebraic("e7"), to: Chess.squareFromAlgebraic("e8"), promotion: null });
  await settle();
  r.eq(sent.find((m) => m.a === "move")?.promo, "q", "promo q on chain");
}

if (r.fail) {
  console.error(`FAIL ${r.fail} of ${r.pass + r.fail}`);
  for (const failure of r.failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`ok ${r.pass} checks`);
