// Chess Online audit fixes (iOS 8d5f925): which send errors are retried and what a failed one
// says, the instant a side flags (flagAt) and the claim timing (a second and a half past it,
// only within half an hour, again after 30 s unless forced), the pending-move timeout, and our
// own locally stamped moves ordered by ply. Pure: no DOM, no network. Run from the repo root:
//
//   node tools/test-chess-tournament-sends.mjs

import * as T from "../engine/chess-tournament.js";
import * as Chess from "../engine/chess.js";

const r = {
  pass: 0, fail: 0, failures: [],
  check(ok, label) { if (ok) this.pass++; else { this.fail++; this.failures.push(label); } },
  eq(a, b, label) { this.check(a === b, `${label}: got ${String(a)}, expected ${String(b)}`); },
};

// --- Send errors --------------------------------------------------------------------------------
const err = (message, code) => Object.assign(new Error(message), code ? { code } : {});
for (const text of [
  "Transaction rejected: orphan transaction",
  "outpoint already spent",
  "No spendable funds available yet. Wait for confirmations and try again.",
  "No confirmed spendable UTXOs available",
  "no spendable utxos available",
  "No UTXOs available for this send",
  "The network is still confirming your previous send. Please try again in a few seconds.",
]) r.check(T.isRetryableSendError(err(text)), `retried: ${text}`);
for (const text of [
  "No UTXOs found. Fund the receive address first.",
  "Insufficient funds",
  "transaction rejected: double spend",
  "Every coin is reserved by a scheduled post.",
  "This game belongs to another account.",
  "Request timed out",
]) r.check(!T.isRetryableSendError(err(text)), `not retried: ${text}`);
// An unknown outcome is never retried, whatever its text says.
r.check(!T.isRetryableSendError(err("orphan", "SEND_OUTCOME_UNKNOWN")), "SEND_OUTCOME_UNKNOWN is never retried, even reading like an orphan");
r.check(!T.isRetryableSendError(err("This may have gone through, but the network didn't confirm it.", "SEND_OUTCOME_UNKNOWN")), "SEND_OUTCOME_UNKNOWN is not retried");
r.check(!T.isRetryableSendError(null), "no error is not retried");
r.check(T.isRetryableSendError("no utxos available"), "a thrown string is read too");

const CONFIRMING = "The network is still confirming your previous send. Please try again in a few seconds.";
const NO_KAS = "Not enough KAS on your Chatting Address. Add some and try again.";
r.eq(T.SEND_CONFIRMING_MESSAGE, CONFIRMING, "iOS's confirming message");
r.eq(T.NOT_ENOUGH_KAS_MESSAGE, NO_KAS, "iOS's notEnoughKasMessage");
r.eq(T.friendlySendErrorMessage(err("orphan transaction")), CONFIRMING, "orphan -> confirming");
r.eq(T.friendlySendErrorMessage(err("Already Spent")), CONFIRMING, "already spent -> confirming");
r.eq(T.friendlySendErrorMessage(err("double spend")), CONFIRMING, "double spend -> confirming");
r.eq(T.friendlySendErrorMessage(err("insufficient funds: need 1 KAS")), NO_KAS, "insufficient funds -> no KAS");
r.eq(T.friendlySendErrorMessage(err("No UTXOs found. Fund the receive address first.")), NO_KAS, "no coins at all -> no KAS (iOS: fresh UTXOs empty)");
r.eq(T.friendlySendErrorMessage(err("Request timed out")), "Request timed out", "anything else as it is");

// --- A live 1v1 -------------------------------------------------------------------------------
const A = "kaspa:alice", B = "kaspa:bob";
const T0 = 1_793_000_000_000;   // after ALLOWANCE_V2_FROM_MS: ten seconds a move
let serial = 0;
const ev = (sender, blockTime, message, txId = `tx${String(++serial).padStart(4, "0")}`) => ({ txId, sender, blockTime, message });
const ROOM = T.duelId(1);
const joins = [ev(A, T0, T.messages.join(ROOM)), ev(B, T0 + 1_000, T.messages.join(ROOM))];
const liveGame = (events) => Object.values(T.reduce(events)[ROOM]?.games || {})[0];
const game0 = liveGame(joins);
r.check(Boolean(game0), "the 1v1 started");
const whiteOf = game0.white, blackOf = game0.black;
const moveBy = (game, sender, blockTime, ply, from, to, txId) => ev(sender, blockTime, T.messages.move(ROOM, game.id, ply, from, to, null), txId);

// --- flagAt -------------------------------------------------------------------------------------
{
  const g = game0;
  const expected = g.lastEventAt + T.allowanceMs(1, g.startedAt) + T.CLOCK_MS - T.usedMs(g, Chess.WHITE);
  r.eq(T.flagAt(g), expected, "flagAt = lastEventAt + allowance(next ply) + clock - used(side to move)");
  r.eq(T.flagAt(g), g.lastEventAt + 10_000 + 300_000, "a fresh game: ten seconds plus five minutes");
  r.eq(T.remainingMs(g, Chess.WHITE, T.flagAt(g)), 0, "out of clock at flagAt");
  r.check(T.remainingMs(g, Chess.WHITE, T.flagAt(g) - 1) > 0, "not a millisecond before");
  // White moves 40 s in (30 s charged): black's flag counts from that move, black's clock full.
  const m1 = moveBy(g, whiteOf, g.lastEventAt + 40_000, 1, "e2", "e4");
  const g1 = liveGame([...joins, m1]);
  r.eq(g1.moves.length, 1, "white's move applied");
  r.eq(T.usedMs(g1, Chess.WHITE), 30_000, "white charged past the allowance");
  r.eq(T.flagAt(g1), m1.blockTime + 10_000 + 300_000, "black's flag counts from white's move");
  // Black replies 100 s later (90 s charged); white's flag: 270 s left plus the allowance.
  const m2 = moveBy(g1, blackOf, m1.blockTime + 100_000, 2, "e7", "e5");
  const g2 = liveGame([...joins, m1, m2]);
  r.eq(T.flagAt(g2), m2.blockTime + 10_000 + 270_000, "white's flag: the allowance plus what is left");
  r.eq(T.remainingMs(g2, Chess.WHITE, T.flagAt(g2)), 0, "and the clock agrees");
  // A claim at flagAt + 1.5 s takes; the game is over and has no flag.
  const claim = ev(blackOf, T.flagAt(g2) + 1_500, T.messages.claim(ROOM, g2.id));
  const g3 = liveGame([...joins, m1, m2, claim]);
  r.eq(g3.winner, blackOf, "the claim wins on time");
  r.eq(T.flagAt(g3), null, "no flag once the game is over");
  // Decided on the clock before the claim, and the winner is the claimant.
  r.check(!T.isDecided(g2, T.flagAt(g2) + 2_999), "not decided inside the three-second margin");
  r.check(T.isDecided(g2, T.flagAt(g2) + 3_000), "decided three seconds past the flag");
  r.eq(T.decidedWinner(g2, T.flagAt(g2) + 3_000), blackOf, "Claim win is for black");
}

// --- Claim timing -----------------------------------------------------------------------------
{
  const flag = T0 + 1_000_000;
  r.eq(T.CLAIM_RETRY_MS, 30_000, "a claim goes again after 30 s");
  r.eq(T.AUTO_CLAIM_WINDOW_MS, 30 * 60_000, "auto-claims within 30 minutes of the flag");
  r.check(!T.autoClaimDue(null, flag), "no flag, no claim");
  r.check(!T.autoClaimDue(flag, flag), "not at the flag");
  r.check(!T.autoClaimDue(flag, flag + 1_499), "not 1.499 s past");
  r.check(T.autoClaimDue(flag, flag + 1_500), "1.5 s past the flag");
  r.check(T.autoClaimDue(flag, flag + 30 * 60_000 - 1), "just inside half an hour");
  r.check(!T.autoClaimDue(flag, flag + 30 * 60_000), "an old flag is left to Claim win");
  const now = T0 + 5_000_000;
  r.check(T.claimMayPost(undefined, now), "the first claim goes");
  r.check(!T.claimMayPost(now - 29_999, now), "not again within 30 s");
  r.check(T.claimMayPost(now - 30_000, now), "again after 30 s");
  r.check(T.claimMayPost(now - 1, now, true), "Claim win goes past the throttle");
  r.eq(T.PENDING_MOVE_TIMEOUT_MS, 25_000, "a pending move expires after 25 s");
  r.eq(T.PENDING_MOVE_EXPIRED_MESSAGE, "Your move didn't reach the network. Play it again.", "iOS's expiry message");
}

// --- Our own local stamps ordered by ply ---------------------------------------------------------
{
  const g = game0;
  const m1 = moveBy(g, whiteOf, g.lastEventAt + 5_000, 1, "e2", "e4", "chain-1");
  // Our reply, stamped by a clock 20 s behind the chain: before the move it answers.
  const mine = moveBy(g, blackOf, m1.blockTime - 20_000, 2, "e7", "e5", "local-2");
  const events = [...joins, m1, mine];
  r.eq(liveGame(events).moves.length, 1, "unordered, our reply is out of turn and ignored");
  const ordered = T.orderingLocalStamps(events, new Set(["local-2"]));
  const moved = ordered.find((e) => e.txId === "local-2");
  r.eq(moved.blockTime, m1.blockTime + 1, "lifted to one past the move it answers");
  r.eq(liveGame(ordered).moves.length, 2, "and applied");
  r.check(ordered.find((e) => e.txId === "chain-1") === m1, "chain rows are untouched");
  r.check(T.orderingLocalStamps(events, new Set()) === events, "no local stamps: the same list");
  r.check(T.orderingLocalStamps(events, null) === events, "none given: the same list");
  // A clock ahead: our ply 2 after the opponent's ply 3 - clamped to one before it.
  const m3 = moveBy(g, whiteOf, m1.blockTime + 30_000, 3, "g1", "f3", "chain-3");
  const ahead = moveBy(g, blackOf, m1.blockTime + 90_000, 2, "e7", "e5", "local-2b");
  const events2 = [...joins, m1, ahead, m3];
  r.eq(liveGame(events2).moves.length, 2, "unordered, the opponent's ply 3 came first and was ignored");
  const ordered2 = T.orderingLocalStamps(events2, new Set(["local-2b"]));
  r.eq(ordered2.find((e) => e.txId === "local-2b").blockTime, m3.blockTime - 1, "lowered to one before the next ply");
  r.eq(liveGame(ordered2).moves.length, 3, "all three moves apply");
  // Already in place: the same event back.
  const inPlace = moveBy(g, blackOf, m1.blockTime + 10_000, 2, "e7", "e5", "local-2c");
  const ordered3 = T.orderingLocalStamps([...joins, m1, inPlace, m3], new Set(["local-2c"]));
  r.check(ordered3.find((e) => e.txId === "local-2c") === inPlace, "a stamp already between its neighbours is kept");
  // Only moves with a game and a ply; only the same tournament and game count as neighbours.
  const resign = ev(blackOf, 1, T.messages.resign(ROOM, g.id), "local-resign");
  r.check(T.orderingLocalStamps([m1, resign], new Set(["local-resign"]))[1] === resign, "a resign is never moved");
  const noPly = { ...mine, txId: "local-noply", message: { ...mine.message, n: null } };
  r.check(T.orderingLocalStamps([m1, noPly], new Set(["local-noply"]))[1] === noPly, "a move with no ply is never moved");
  const otherGame = { ...m1, txId: "other-game", message: { ...m1.message, g: "9-9" } };
  const otherRoom = { ...m1, txId: "other-room", message: { ...m1.message, t: T.duelId(2) } };
  r.check(T.orderingLocalStamps([otherGame, otherRoom, mine], new Set(["local-2"]))[2] === mine, "other games and rooms are not neighbours");
}

// --- Our own moves the chain never showed (accepted, never mined) ---------------------------------
{
  const g = game0;
  const sentAt = g.lastEventAt + 5_000;
  const mine = moveBy(g, whiteOf, sentAt, 1, "e2", "e4", "local-1");
  // Applied at once: the board is on the opponent's turn, so pendingMoveGames no longer has it.
  const view = T.reduce([...joins, mine]);
  r.eq(Object.values(view[ROOM].games)[0].moves.length, 1, "the local row is applied");
  const sent = new Map([["local-1", { tournamentId: ROOM, gameId: g.id, sentAt }]]);
  const at = (ms) => T.unconfirmedLocalMoves(sent, view, sentAt + ms);
  r.eq(at(T.PENDING_MOVE_TIMEOUT_MS).drop.length, 0, "not before the timeout");
  r.eq(at(T.PENDING_MOVE_TIMEOUT_MS + 1).drop.join(), "local-1", "unseen after the timeout, whoever's turn the row made it: dropped");
  r.eq(at(T.PENDING_MOVE_TIMEOUT_MS + 1).seen.length, 0, "and not seen");
  // The opponent answered it: it is on chain, whatever its row says.
  const reply = moveBy(g, blackOf, sentAt + 3_000, 2, "e7", "e5", "chain-2");
  const answered = T.reduce([...joins, mine, reply]);
  const later = T.unconfirmedLocalMoves(sent, answered, sentAt + 60_000);
  r.eq(later.seen.join(), "local-1", "answered: seen");
  r.eq(later.drop.length, 0, "never dropped");
  // The reducer refused it (no such game any more): dropped after the timeout too.
  r.eq(T.unconfirmedLocalMoves(sent, {}, sentAt + 30_000).drop.join(), "local-1", "a move in no game is dropped");
  r.eq(T.unconfirmedLocalMoves(new Map(), view, sentAt + 30_000).drop.length, 0, "nothing sent, nothing dropped");
  // Dropped, the board is ours to move again.
  const after = T.reduce([...joins]);
  r.eq(T.playerToMove(Object.values(after[ROOM].games)[0]), whiteOf, "without the row it is our turn again");
}

console.log(`chess tournament sends: ${r.pass} passed, ${r.fail} failed`);
if (r.fail) { for (const f of r.failures) console.log(`  FAIL ${f}`); process.exit(1); }
