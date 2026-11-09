// The audit round of 2026-11-09: KaChat iOS 4f8e14bb, KaPay 2da5f4b, KaPlay da59726, KaPost ee5ec98.
// Run: node tools/test-ios-audit-round-3.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { squareFromAlgebraic, chessTimeControlFromInvite, summarizeChessGame, chessInvite, chessResponse, chessMove } from "../engine/chess.js";
import { duelLeaderboard, tournamentLeaderboard } from "../engine/chess-tournament.js";
import { stripBidiControls, renderKaPostsMarkdown } from "../ui/kaposts-markdown.js";
import { RegistryState } from "../engine/kachat-names/registry-state.js";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const app = read("ui/app.js");
const kaposts = read("ui/kaposts.js");
const registry = read("engine/kachat-names/registry.js");
const nextcloud = read("ui/nextcloud.js");
const tournaments = read("ui/chess-tournaments.js");
const transactions = read("engine/transactions.js");
let passed = 0;
function test(name, fn) { fn(); passed += 1; console.log(`ok - ${name}`); }

test("chess squares are exactly a1..h8", () => {
  assert.deepEqual(squareFromAlgebraic("e4"), { file: 4, rank: 3 });
  for (const bad of ["A1", "e٤", "i1", "a9", "a", "a10", null]) assert.equal(squareFromAlgebraic(bad), null, String(bad));
});

test("an invite's time control outside 1-180 minutes or 0-180 seconds is untimed", () => {
  assert.deepEqual(chessTimeControlFromInvite({ tcMinutes: 3, tcIncSeconds: 2 }), { minutes: 3, incSeconds: 2 });
  assert.deepEqual(chessTimeControlFromInvite({ tcMinutes: 180 }), { minutes: 180, incSeconds: 0 });
  for (const bad of [{ tcMinutes: 181 }, { tcMinutes: 0 }, { tcMinutes: 1e300 }, { tcMinutes: 5, tcIncSeconds: 181 }, { tcMinutes: 5, tcIncSeconds: -1 }]) {
    assert.equal(chessTimeControlFromInvite(bad), null, JSON.stringify(bad));
  }
});

test("the first invite is the game; a late decline doesn't void it; clocks are capped", () => {
  const me = "kaspa:me", them = "kaspa:them";
  const gameId = "g1";
  const msg = (text, outgoing, at, txid) => ({ text, outgoing, at, txid });
  const summary = summarizeChessGame(gameId, [
    msg(chessInvite(gameId, "white", 5, 0), true, 1, "t1"),
    msg(chessResponse(gameId, true), false, 2, "t2"),
    msg(chessInvite(gameId, "black", 180, 0), false, 3, "t3"),
    msg(chessMove(gameId, "e2", "e4", null, 1e15), true, 4, "t4"),
    msg(chessResponse(gameId, false), false, 5, "t5"),
  ], me, them);
  assert.equal(summary.whiteAddress, me, "a later invite can't swap the colors");
  assert.equal(summary.timeControl.minutes, 5);
  assert.notEqual(summary.status.kind, "declined", "a decline after the first move doesn't void the game");
  assert.equal(summary.whiteClockMs, 30 * 24 * 60 * 60 * 1000);
});

test("leaderboard ties end on the address", () => {
  const row = (address) => ({ address, wins: 1, losses: 0, tournamentsWon: 1, tournamentsLost: 0, lastPlayedAt: 5 });
  assert.deepEqual(duelLeaderboard([row("b"), row("a")]).map((r) => r.address), ["a", "b"]);
  assert.deepEqual(tournamentLeaderboard([row("b"), row("a")]).map((r) => r.address), ["a", "b"]);
});

test("bidi controls are stripped, the plain direction marks stay", () => {
  assert.equal(stripBidiControls("a‮b⁦c‏d"), "abc‏d");
  assert.equal(renderKaPostsMarkdown("a‮b").text, "ab");
});

test("a chain copy records reaching the tip, across a save", () => {
  const state = new RegistryState({ version: 4, network: "testnet", registryCovenantId: "aa", reachedTip: true, verifiedAt: 5n });
  assert.equal(RegistryState.fromJSON(JSON.parse(JSON.stringify(state.toJSON()))).reachedTip, true);
});

test(".kachat: every send is confirmed live; a chain copy past its age answers nothing", () => {
  assert.doesNotMatch(registry, /source\?\.kind !== "indexer"\) return;/);
  assert.match(registry, /if \(address == null\) return address;/);
  assert.match(registry, /st\.reachedTip !== true/);
  assert.match(registry, /chainCopyMaxAgeMs\(\) \{ return 15 \* 60 \* 1000; \}/);
});

test("sends: an unknown outcome holds nothing; only the primary moves the primary", () => {
  assert.doesNotMatch(transactions, /SEND_OUTCOME_UNKNOWN\) noteSpentOutpoints/);
  assert.match(app, /sourceIndex === getSpendingState\(account\.owner\)\.activeIndex \? rotatePrimarySpendingTo : revealSpendingChangeAddress/);
  assert.match(app, /compoundSpending\(\{[^\n]*selectedOutpoints: outpoints \}/);
  assert.match(app, /expectedFeeSompi: max \? null : paymentTotalFeeSompi\(\)/);
  assert.match(app, /KNS_TRANSFER_MAX_FEE_SOMPI \? KNS_TRANSFER_MAX_FEE_SOMPI : sompi/);
});

test("accounts and tips", () => {
  assert.match(app, /if \(resetState && isNewAccount\)/);
  assert.match(app, /kaPostsTipSourceUnavailable\(\)\) \{\n\s+openTipModal/);
  assert.match(app, /instantTipHolds\.set\(inFlightKey, Date\.now\(\) \+ INSTANT_TIP_HOLD_MS\)/);
});

test("Portfolio: a name just written is kept; plain files stop counting once one is encrypted", () => {
  assert.match(nextcloud, /if \(writtenNames\.has\(String\(found\.file\.name\)\.toLowerCase\(\)\)\) continue;/);
  assert.match(nextcloud, /result\.own\.some\(\(found\) => !found\.plain\)/);
});

test("KaPost: a retried reply stays a reply; a refresh keeps unsent replies", () => {
  assert.match(kaposts, /comment\.parentRemoteId = parent\.remoteId;/);
  assert.match(kaposts, /\} else if \(post\.parentRemoteId\) \{/);
  assert.match(kaposts, /remotePosts = carryingUnsentComments\(remotePosts,/);
});

test("the arena: join queue is bounded and stray ids don't move it; the stream keeps indexer times", () => {
  assert.match(tournaments, /MAX_AUTO_REJOINS = 2/);
  assert.match(tournaments, /idOf\(number\) !== room\.id/);
  assert.match(tournaments, /!rows\.has\(h\.txId\) \|\| rows\.get\(h\.txId\)\.local/);
});

console.log(`ios audit round 3: ${passed} passed`);
