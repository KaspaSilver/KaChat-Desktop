// The rest of the iOS chess audit (KaPlay da59726, KaChat 4f8e14bb), run on the real
// ui/chess-tournaments.js, ui/chess-bots.js and engine against a fake indexer and REST API: the
// arena is paged again after a lapse in the polling, a ply gap in one of this player's games, or a
// claim that didn't take; a bot stamp says "stamped" only once the chain shows it; and a 1:1 move
// sent twice counts once. Run from the repo root:
//
//   node tools/test-chess-audit-remaining.mjs

import { registerHooks } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoUrl = (path) => pathToFileURL(join(here, "..", path)).href;

const r = {
  pass: 0, fail: 0, failures: [],
  check(ok, label) { if (ok) this.pass++; else { this.fail++; this.failures.push(label); } },
  eq(a, b, label) { this.check(a === b, `${label}: got ${String(a)}, expected ${String(b)}`); },
};

// --- The page around the modules ------------------------------------------------------------------
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
};
const realNow = Date.now.bind(Date);
let clockOffset = 0;
Date.now = () => realNow() + clockOffset;
const advance = (ms) => { clockOffset += ms; };
const intervals = new Map();
globalThis.window = {
  setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 5)),
  clearTimeout: (id) => clearTimeout(id),
  setInterval: (fn, ms) => { intervals.set(ms, fn); return ms; },
  clearInterval: () => {},
};
const screen = { innerHTML: "", querySelector: () => null, querySelectorAll: () => [], addEventListener: (type, fn) => { screen.onclick = fn; } };
globalThis.document = { hidden: false, querySelector: (sel) => (sel === "[data-chess-tournaments]" ? screen : null) };

// --- Fake indexer, REST API and sends ---------------------------------------------------------------
const stub = globalThis.__chessStub = {
  sends: [], rest: {}, botGames: [], nextTx: 1,
  indexer: { rows: [], requests: [], failWhen: null },
};
globalThis.fetch = async (url) => {
  const txId = decodeURIComponent(String(url).match(/\/transactions\/([^?]+)/)?.[1] || "");
  const answer = stub.rest[txId]?.() || { status: 404 };
  return { status: answer.status, json: async () => answer.json };
};
const dataModule = (source) => `data:text/javascript,${encodeURIComponent(source)}`;
const STUBS = {
  "../engine/broadcasts.js": dataModule(`
    const s = globalThis.__chessStub;
    export const parseBroadcastPayload = () => null; export const restBroadcastSenderShape = () => ({}); export const judgeBroadcastSender = () => ({}); export const BROADCAST_SENDER = {};
    export const hasBroadcastIndexer = () => true;
    export const broadcastPayloadBytes = () => 200;
    export async function fetchBroadcastHistory({ limit, before }) {
      const ix = s.indexer;
      ix.requests.push({ limit, before });
      if (ix.failWhen?.(ix.requests.length)) throw new Error("indexer unavailable");
      const older = ix.rows.filter((m) => before == null || m.blockTime < before).sort((a, b) => b.blockTime - a.blockTime);
      return { messages: older.slice(0, limit).map((m) => ({ ...m })), hasMore: older.length > limit };
    }
    export async function sendBroadcastMessage(args) { const txid = "sent-" + (s.nextTx++); s.sends.push({ args, txid }); return txid; }`),
  "./dialogs.js": dataModule(`export const confirmDialog = async () => true; export const promptDialog = async () => null; export const chooseDialog = async () => null;`),
  "./broadcasts.js": dataModule(`export const setServiceScanWanted = () => {};`),
  "../engine/endpoints.js": dataModule(`export const getEndpoint = (name) => (name === "kaspaApi" ? "https://rest.test" : name === "broadcastIndexer" ? "https://indexer.test" : "");`),
  "./chess-bots.css": dataModule(``),
  "../engine/chess-bot.js": dataModule(`
    import * as real from ${JSON.stringify(repoUrl("engine/chess-bot.js"))};
    export * from ${JSON.stringify(repoUrl("engine/chess-bot.js"))};
    export class ChessBotGame extends real.ChessBotGame {
      constructor(options) { super(options); globalThis.__chessStub.botGames.push({ game: this, options }); }
    }`),
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (STUBS[specifier] && /\/ui\/chess-(tournaments|bots)\.js(\?.*)?$/.test(context.parentURL || "")) return { url: STUBS[specifier], shortCircuit: true };
    return nextResolve(specifier, context);
  },
});

const T = await import("../engine/chess-tournament.js");
const Chess = await import("../engine/chess.js");
const Bot = await import("../engine/chess-bot.js");

const ME = "kaspa:qme";
const OPP = "kaspa:qopponent";
let txCounter = 0;
const row = (sender, blockTime, message, txId = `tx-${++txCounter}`) => ({ txId, senderAddress: sender, content: T.encodeMessage(message), blockTime });
const noise = (count, newest, gap = 10) => Array.from({ length: count }, (_, i) => row(`kaspa:qnoise${i}`, newest - i * gap, T.messages.join(`noise-${i}`)));
const settle = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

/** A fresh copy of the module, shown on a fresh arena, its first crawl done. */
let instance = 0;
const unknownRows = new Set();
async function openArena(initialRows) {
  store.clear();
  intervals.clear();
  stub.sends = [];
  stub.rest = {};
  stub.indexer = { rows: [...initialRows], requests: [], failWhen: null };
  unknownRows.clear();
  const engine = {
    address: ME,
    onBroadcastBlockHits: () => () => {},
    getMempoolEntry: async () => null,
    verifyBroadcastRows: async (list) => ({
      accepted: list.filter((m) => !unknownRows.has(m.txId)),
      forged: [],
      unknown: list.filter((m) => unknownRows.has(m.txId)),
    }),
  };
  const scoped = (key) => `kachat-account-data-v1:${engine.address}:${key}`;
  const deps = {
    engine, displayNameFor: (a) => a, appendEngineLog: () => {}, showToast: () => {}, accountScopedKey: scoped,
    escapeHtml: (v) => String(v),
  };
  instance += 1;
  const ui = await import(`../ui/chess-tournaments.js?case=${instance}`);
  ui.initChessTournaments(deps);
  ui.showChessTournaments();
  await settle();
  const poll = async () => { stub.indexer.requests = []; intervals.get(8_000)(); await settle(); return stub.indexer.requests; };
  const tick = async () => { intervals.get(200)(); await settle(); };
  const cached = () => JSON.parse(store.get("kachat-chess-arena-v1") || "[]");
  const has = (txId) => cached().some((m) => m.txId === txId);
  const game = (tid, gid) => T.reduce(cached().map((m) => ({ txId: m.txId, sender: m.senderAddress, blockTime: m.blockTime, message: T.decodeMessage(m.content) })).filter((e) => e.message))[tid]?.games[gid];
  return { ui, engine, poll, tick, cached, has, game };
}

// --- A lapse in the polling -----------------------------------------------------------------------
{
  const t0 = Date.now();
  const old = noise(1_200, t0 - 10 * 86_400_000);
  const a = await openArena(old);
  r.eq(a.cached().length, 1_200, "the first crawl reads the whole window");

  // Polls on time: one newest page.
  advance(8_000);
  let requests = await a.poll();
  r.eq(requests.length, 1, "a poll on time asks once");
  r.eq(requests[0].limit, 100, "for the newest page");

  // 30 s without a poll, far more rows than one page holds.
  advance(30_000);
  const burst = noise(1_300, Date.now() - 1_000);
  stub.indexer.rows.push(...burst);
  requests = await a.poll();
  r.check(requests.length > 1, `a lapse pages back (asked ${requests.length} times)`);
  r.eq(requests[0].limit, 500, "in full pages");
  r.check(burst.every((m) => a.has(m.txId)), "every row of the lapse is in");
  r.check(requests.length <= 4, `and stops at the floor, not the whole 30 days (asked ${requests.length} times)`);

  // Done: back to one page.
  advance(8_000);
  requests = await a.poll();
  r.eq(requests.length, 1, "after the repage, one newest page again");
  a.ui.hideChessTournaments();
}

// A poll that fails counts as a lapse, and a repage that stops partway is done again.
{
  const a = await openArena(noise(50, Date.now() - 86_400_000));
  advance(8_000);
  await a.poll();
  const startedFailing = Date.now();
  stub.indexer.failWhen = () => true;
  for (let i = 0; i < 4; i += 1) { advance(8_000); await a.poll(); }
  r.check(Date.now() - startedFailing > T.POLL_LAPSE_MS, "the polls failed for longer than a lapse");
  const missed = noise(700, Date.now() - 1_000);
  stub.indexer.rows.push(...missed);
  // The repage's second page fails.
  stub.indexer.requests = [];
  stub.indexer.failWhen = (n) => n === 2;
  intervals.get(8_000)();
  await settle();
  r.eq(stub.indexer.requests.length, 2, "the repage got one page and failed on the next");
  r.check(!missed.every((m) => a.has(m.txId)), "so rows are still missing");
  stub.indexer.failWhen = null;
  advance(8_000);
  const requests = await a.poll();
  r.check(requests.length > 1, "the next poll pages again, the polls having been on time since");
  r.check(missed.every((m) => a.has(m.txId)), "and fills the gap the failed polls left");
  a.ui.hideChessTournaments();
}

// A row the REST API couldn't verify during a repage isn't lost once it's past the newest page.
{
  const a = await openArena(noise(10, Date.now() - 86_400_000));
  advance(30_000);
  const burst = noise(300, Date.now() - 1_000);
  const held = burst.at(-1); // the oldest: past a 100-row page
  unknownRows.add(held.txId);
  stub.indexer.rows.push(...burst);
  await a.poll();
  r.check(!a.has(held.txId), "an unverified row isn't taken as it stands");
  unknownRows.clear();
  advance(8_000);
  const requests = await a.poll();
  r.eq(requests.length, 1, "the next poll is the newest page again");
  r.check(a.has(held.txId), "the row is verified again and comes in anyway");
  a.ui.hideChessTournaments();
}

// --- A ply gap in one of this player's games ---------------------------------------------------------
{
  const t0 = Date.now() - 200_000;
  const joins = [row(ME, t0, T.messages.join("duel-1")), row(OPP, t0 + 1_000, T.messages.join("duel-1"))];
  const e4 = row(ME, t0 + 20_000, T.messages.move("duel-1", "1-0", 1, "e2", "e4", null));
  const a = await openArena([...joins, e4]);
  r.eq(a.game("duel-1", "1-0")?.moves.length, 1, "the board has the first move");

  // Three moves land; 100 other rows between them push the middle two past the newest page.
  const e5 = row(OPP, t0 + 40_000, T.messages.move("duel-1", "1-0", 2, "e7", "e5", null));
  const nf3 = row(ME, t0 + 60_000, T.messages.move("duel-1", "1-0", 3, "g1", "f3", null));
  const nc6 = row(OPP, Date.now() - 2_000, T.messages.move("duel-1", "1-0", 4, "b8", "c6", null));
  const between = noise(120, Date.now() - 3_000);
  stub.indexer.rows.push(e5, nf3, ...between, nc6);
  advance(8_000);
  let requests = await a.poll();
  r.eq(requests.length, 1, "the poll that brings the gap is one page");
  r.check(a.has(nc6.txId) && !a.has(e5.txId), "move 4 is here without move 2");
  r.eq(a.game("duel-1", "1-0").moves.length, 1, "so the board is stuck on move 1");

  advance(8_000);
  requests = await a.poll();
  r.check(requests.length >= 1 && requests[0].limit === 500, "the next poll pages the arena back");
  r.eq(a.game("duel-1", "1-0").moves.length, 4, "and the board has every move");
  r.check(a.has(e5.txId) && a.has(nf3.txId), "the missing rows came in");

  // Filled: no more repaging.
  advance(40_000);
  await a.poll(); // a lapse, this one
  advance(8_000);
  requests = await a.poll();
  r.eq(requests.length, 1, "no gap left: one newest page");
  a.ui.hideChessTournaments();
}

// A gap the indexer can't fill is asked about every 30 s, not every poll.
{
  const t0 = Date.now() - 200_000;
  const joins = [row(ME, t0, T.messages.join("duel-1")), row(OPP, t0 + 1_000, T.messages.join("duel-1"))];
  const e4 = row(ME, t0 + 20_000, T.messages.move("duel-1", "1-0", 1, "e2", "e4", null));
  const a = await openArena([...joins, e4]);
  // The opponent's move 4 reaches this device; move 2 and 3 aren't on the indexer at all.
  stub.indexer.rows.push(row(OPP, Date.now() - 1_000, T.messages.move("duel-1", "1-0", 4, "b8", "c6", null)));
  advance(8_000);
  await a.poll();
  advance(5_000);
  let requests = await a.poll();
  r.eq(requests[0].limit, 500, "the gap repages");
  advance(5_000);
  requests = await a.poll();
  r.eq(requests.length, 1, "not again within 30 s");
  r.eq(requests[0].limit, 100, "just the newest page");
  advance(T.GAP_REPAGE_GAP_MS);
  await a.poll(); // the lapse this advance made, or the gap
  advance(5_000);
  await a.poll();
  r.eq(a.game("duel-1", "1-0").moves.length, 1, "the board waits for the row");
  a.ui.hideChessTournaments();
}

// Who counts as a gap (pure).
{
  const t0 = 1_800_000_000_000;
  const ev = (sender, at, message) => ({ txId: `e${at}`, sender, blockTime: at, message });
  const THIRD = "kaspa:qthird";
  const base = [ev(ME, t0, T.messages.join("duel-1")), ev(OPP, t0 + 1_000, T.messages.join("duel-1")), ev(ME, t0 + 20_000, T.messages.move("duel-1", "1-0", 1, "e2", "e4", null))];
  const started = t0 + 1_000;
  const gapped = [...base, ev(OPP, t0 + 40_000, T.messages.move("duel-1", "1-0", 4, "b8", "c6", null))];
  r.eq(T.earliestArenaGap(gapped, T.reduce(gapped), ME, t0 + 41_000), started, "a player's later move: the game's start");
  r.eq(T.earliestArenaGap(gapped, T.reduce(gapped), THIRD, t0 + 41_000), null, "someone else's game is not this player's gap");
  r.eq(T.earliestArenaGap(base, T.reduce(base), ME, t0 + 41_000), null, "the next ply is no gap");
  const nextPly = [...base, ev(OPP, t0 + 40_000, T.messages.move("duel-1", "1-0", 2, "e7", "e5", null))];
  r.eq(T.earliestArenaGap(nextPly, T.reduce(nextPly), ME, t0 + 41_000), null, "a move that applied is no gap");
  const byStranger = [...base, ev(THIRD, t0 + 40_000, T.messages.move("duel-1", "1-0", 9, "b8", "c6", null))];
  r.eq(T.earliestArenaGap(byStranger, T.reduce(byStranger), ME, t0 + 41_000), null, "a stranger's move can't ask for a repage");
  r.eq(T.earliestArenaGap(gapped, T.reduce(gapped), ME, t0 + 24 * 3_600_000), null, "a game the clock has decided needs no repage");
}

// --- A claim that didn't take ------------------------------------------------------------------------
{
  const record = (step) => ({ tries: step.record.tries, repaged: step.record.repaged, action: step.action });
  let step = T.nextAutoClaim(undefined, 5);
  r.eq(JSON.stringify(record(step)), `{"tries":1,"repaged":false,"action":"post"}`, "the first claim goes out");
  step = T.nextAutoClaim(step.record, 5);
  r.eq(step.action, "repage", "the second reads the arena first");
  step = T.nextAutoClaim(step.record, 5);
  r.eq(step.action, "post", "then goes out");
  r.eq(T.nextAutoClaim(step.record, 9).action, "post", "a new flag starts over");

  const t0 = Date.now() - 10 * 60_000;
  const joins = [row(ME, t0, T.messages.join("duel-1")), row(OPP, t0 + 1_000, T.messages.join("duel-2")), row(OPP, t0 + 2_000, T.messages.join("duel-1"))];
  const a = await openArena(joins);
  const claims = () => stub.sends.filter((s) => T.decodeMessage(s.args.content)?.a === "claim").length;
  // We (white) moved at once; the opponent's clock then ran out.
  stub.indexer.rows.push(row(ME, t0 + 20_000, T.messages.move("duel-1", "1-0", 1, "e2", "e4", null)));
  advance(8_000);
  await a.poll();
  advance(1_000);
  await a.poll();
  await a.tick();
  r.eq(claims(), 1, "the flag is claimed");

  // It never lands: its row is dropped, and the game is undecided again. The arena is read before
  // the next one is paid for.
  advance(61_000);
  await a.tick();
  await a.tick();
  await a.tick();
  await a.tick();
  r.eq(claims(), 1, "the second claim waits");
  let requests = await a.poll();
  r.eq(requests[0].limit, 500, "for the arena to be paged again");
  await a.tick();
  r.eq(claims(), 2, "and then goes out");

  // After four the app stops paying; the board's Claim win is still there.
  for (let i = 0; i < 6; i += 1) {
    advance(61_000);
    await a.tick();
    await a.poll();
    await a.tick();
  }
  r.eq(claims(), T.MAX_AUTO_CLAIMS, `no more than ${T.MAX_AUTO_CLAIMS} automatic claims`);
  a.ui.hideChessTournaments();
}

// --- A bot stamp says "stamped" only when the chain shows it ----------------------------------------
const sq = Chess.squareFromAlgebraic;
async function wonGame(options) {
  // Fool's mate, from the player's side as black: the game ends on the player's move.
  const stamped = [];
  const sleeps = [];
  const game = new Bot.ChessBotGame({
    bot: Bot.chessBot(1), playerColor: Chess.BLACK,
    think: async (board) => {
      const wanted = game.moves.length === 0 ? ["f2", "f3"] : ["g2", "g4"];
      return Chess.legalMoves(board).find((m) => Chess.algebraic(m.from) === wanted[0] && Chess.algebraic(m.to) === wanted[1]);
    },
    recordStampedWin: (moves) => stamped.push(moves),
    sleep: async (ms) => { sleeps.push(ms); },
    ...options,
  });
  game.start();
  await settle();
  r.check(game.play({ from: sq("e7"), to: sq("e5"), promotion: null }), "e7e5 played");
  await settle();
  r.check(game.play({ from: sq("d8"), to: sq("h4"), promotion: null }), "Qh4 mate played");
  return { game, stamped, sleeps };
}
{
  // The chain shows it on the third look.
  let looks = 0;
  const seen = [];
  const { game, stamped, sleeps } = await wonGame({
    send: async () => "stamp-tx",
    isAccepted: async (txId) => { seen.push(txId); looks += 1; return looks === 3; },
  });
  r.eq(game.result?.kind, "won", "the player won");
  r.eq(game.stamp, "sending", "not stamped on sending");
  await settle();
  r.eq(looks, 3, "asked until the chain shows it");
  r.eq(seen[0], "stamp-tx", "about the stamp's own transaction");
  r.eq(game.stamp, "stamped", "stamped once it's accepted");
  r.eq(stamped.length, 1, "the win counts then");
  r.check(sleeps.filter((ms) => ms === 4_000).length === 3, "4 s between looks");
}
{
  // Never shows: Not confirmed after 20 looks, and the win doesn't count.
  let looks = 0;
  let sends = 0;
  const { game, stamped, sleeps } = await wonGame({
    send: async () => { sends += 1; return "stamp-tx"; },
    isAccepted: async () => { looks += 1; return false; },
  });
  await settle(40);
  r.eq(looks, 20, "20 looks");
  r.eq(sleeps.filter((ms) => ms === 4_000).length, 20, "4 s apart");
  r.eq(game.stamp, "unconfirmed", "unconfirmed");
  r.eq(game.stampError, "Sent, but Kaspa hasn't confirmed it yet.", "and says so");
  r.eq(stamped.length, 0, "the win doesn't count");
  game.retry();
  await settle();
  r.eq(sends, 1, "no Retry: it may yet land");
}
{
  // A REST failure is one look, not an answer.
  let looks = 0;
  const { game } = await wonGame({
    send: async () => "stamp-tx",
    isAccepted: async () => { looks += 1; if (looks < 5) throw new Error("rest down"); return true; },
  });
  await settle();
  r.eq(looks, 5, "looks go on past a REST failure");
  r.eq(game.stamp, "stamped", "and a later look stamps it");
}
{
  // Another account came on: nothing more is asked or recorded.
  let looks = 0;
  const { game, stamped } = await wonGame({
    send: async () => "stamp-tx",
    isAccepted: async () => { looks += 1; if (looks === 2) game.dispose(); return false; },
  });
  await settle();
  r.eq(looks, 2, "looks stop with the game");
  r.check(game.stamp !== "unconfirmed" && game.stamp !== "stamped", "no verdict for an account gone");
  r.eq(stamped.length, 0, "and nothing counted");
}
{
  // A send that hands back no txid is not a stamp.
  let looks = 0;
  const { game } = await wonGame({ send: async () => "", isAccepted: async () => { looks += 1; return true; } });
  await settle();
  r.eq(game.stamp, "failed", "no txid: failed");
  r.eq(looks, 0, "nothing to look up");
}

// The real ui/chess-bots.js sends the txid back and asks the REST API.
{
  const a = await openArena([]);
  stub.botGames.length = 0;
  const click = (attr, dataset = {}) => { const el = { dataset }; screen.onclick({ target: { closest: (sel) => (sel === `[${attr}]` ? el : null) } }); };
  click("data-chess-t-bots");
  click("data-chess-bot-open", { chessBotOpen: "1" });
  click("data-chess-bot-play");
  const played = stub.botGames.at(-1);
  r.check(Boolean(played), "a bot game started");
  const txid = await played.options.send('{"type":"chess_bot"}');
  r.eq(stub.sends.at(-1).txid, txid, "the send resolves its txid");
  r.eq(await played.options.isAccepted("nope"), false, "a 404 is not accepted");
  stub.rest.yes = () => ({ status: 200, json: { is_accepted: true, block_time: Date.now() } });
  stub.rest.mined = () => ({ status: 200, json: { is_accepted: false } });
  r.eq(await played.options.isAccepted("yes"), true, "is_accepted is accepted");
  r.eq(await played.options.isAccepted("mined"), false, "known but not accepted is not");
  a.ui.hideChessTournaments();
}

// --- 1:1: a Not confirmed move sent again, both copies landing, counts once ------------------------
{
  const gameId = "abc";
  const at = 1_000_000;
  const rowsOf = (list) => list.map(([text, outgoing, offset, txid]) => ({ text, outgoing, txid, at: at + offset, blockTime: 0, failed: false }));
  const moves = rowsOf([
    [Chess.chessInvite(gameId, Chess.WHITE), true, 0, "i"],
    [Chess.chessResponse(gameId, true), false, 1_000, "r"],
    [Chess.chessMove(gameId, "e2", "e4"), true, 2_000, "a"],
    [Chess.chessMove(gameId, "e2", "e4"), true, 70_000, "b"],
    [Chess.chessMove(gameId, "e7", "e5"), false, 75_000, "c"],
    [Chess.chessMove(gameId, "g1", "f3"), true, 80_000, "d"],
  ]);
  const s = Chess.summarizeChessGame(gameId, moves, ME, OPP);
  r.eq(s.moveHistory.length, 3, "the second copy is dropped as illegal");
  r.eq(s.moveHistory.map((m) => Chess.algebraic(m.to)).join(), "e4,e5,f3", "and the game goes on from the first");
}

console.log(`chess audit remaining: ${r.pass} passed, ${r.fail} failed`);
if (r.fail) { for (const f of r.failures) console.log(`  FAIL ${f}`); process.exit(1); }
process.exit(0);
