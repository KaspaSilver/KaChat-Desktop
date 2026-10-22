// Chess leaderboard periods (iOS 77d6038, ONLINE_CHESS.md §6): the fresh-start cutoff, this
// month's `since` = max(cutoff, 1st of the UTC month), "counts in the period it STARTED", the
// indexer answer used only when its period and since match, the per-figure max merge and its
// sort, and the month rollover. Pure: no DOM, no network. Run from the repo root:
//
//   node tools/test-chess-leaderboard-period.mjs

import * as T from "../engine/chess-tournament.js";

const r = {
  pass: 0, fail: 0, failures: [],
  check(ok, label) { if (ok) this.pass++; else { this.fail++; this.failures.push(label); } },
  eq(a, b, label) { this.check(a === b, `${label}: got ${String(a)}, expected ${String(b)}`); },
};

const CUTOFF = 1_792_647_960_000;
const OCT_23 = Date.UTC(2026, 9, 23, 12, 0, 0);
const NOV_1 = Date.UTC(2026, 10, 1);           // 1_793_491_200_000
const NOV_15 = Date.UTC(2026, 10, 15, 8, 30);
const DEC_1 = Date.UTC(2026, 11, 1);

// --- The cutoff --------------------------------------------------------------------------------
r.eq(T.LEADERBOARD_FRESH_FROM_MS, CUTOFF, "cutoff equals iOS leaderboardFreshFromMs / indexer LEADERBOARD_FRESH_FROM_MS");
r.eq(new Date(CUTOFF).toISOString(), "2026-10-22T05:46:00.000Z", "cutoff is 2026-10-22 05:46 UTC");
r.eq(T.LEADERBOARD_PERIODS.join(","), "month,all", "periods use the indexer's names");

// --- Month start and since ------------------------------------------------------------------
r.eq(T.utcMonthStartMs(OCT_23), Date.UTC(2026, 9, 1), "UTC month start, October");
r.eq(T.utcMonthStartMs(NOV_1), NOV_1, "UTC month start at exactly 00:00 on the 1st");
r.eq(T.utcMonthStartMs(NOV_1 - 1), Date.UTC(2026, 9, 1), "one ms before the 1st is still October");
r.eq(NOV_1, 1_793_491_200_000, "Nov 1 2026 00:00 UTC matches the indexer test value");
r.eq(T.periodSinceMs("all", OCT_23), CUTOFF, "all time since = cutoff (Oct)");
r.eq(T.periodSinceMs("all", NOV_15), CUTOFF, "all time since = cutoff (Nov)");
r.eq(T.periodSinceMs("month", OCT_23), CUTOFF, "Oct 2026: the cutoff wins over Oct 1");
r.eq(T.periodSinceMs("month", CUTOFF + 1), CUTOFF, "Oct 2026 right after the cutoff: the cutoff");
r.eq(T.periodSinceMs("month", NOV_15), NOV_1, "Nov 2026: the month start wins");
r.eq(T.periodSinceMs("month", DEC_1 + 5), DEC_1, "Dec 2026: the month start wins");

// --- Counting by start time -------------------------------------------------------------------
const A = "kaspa:alice", B = "kaspa:bob", C = "kaspa:carol";
const duel = (id, startedAt, winner, loser, endedAt = startedAt + 120_000) => ({
  id, capacity: 2, players: [winner, loser], startedAt,
  games: { "1-0": { id: "1-0", white: winner, black: loser, winner, endedAt } },
});
// An 8-player tournament where `champ` wins every game they play (three), the others lose once.
const tournament = (id, startedAt, champ, others) => {
  const games = {};
  others.slice(0, 3).forEach((o, i) => { games[`${i + 1}-0`] = { id: `${i + 1}-0`, white: champ, black: o, winner: champ, endedAt: startedAt + (i + 1) * 60_000 }; });
  return { id, capacity: 8, players: [champ, ...others], startedAt, games };
};

const before = duel("pre", CUTOFF - 1, A, B);
r.eq(T.leaderboard([before]).length, 0, "a 1v1 started 1 ms before the cutoff never counts (default since = cutoff)");
r.eq(T.leaderboard([before], T.periodSinceMs("all", OCT_23)).length, 0, "... nor on all time");
const at = duel("at", CUTOFF, A, B);
r.eq(T.leaderboard([at])[0]?.wins, 1, "a 1v1 started exactly at the cutoff counts");
r.eq(T.leaderboard([{ ...at, startedAt: null }]).length, 0, "not started: not counted");

// Started before since, finished after: does not count (the whole event goes by its start).
const lateFinish = duel("late", NOV_1 - 60_000, A, B, NOV_1 + 60_000);
const novSince = T.periodSinceMs("month", NOV_15);
r.eq(T.leaderboard([lateFinish], novSince).length, 0, "started in October, finished in November: not on November's board");
r.eq(T.leaderboard([lateFinish], T.periodSinceMs("all", NOV_15))[0]?.wins, 1, "... but on all time");
// A tournament started on Oct 31, games into November: every game counts in October, none in November.
const t31 = tournament("t31", NOV_1 - 30_000, C, [A, B, "kaspa:d"]);
const octBoard = T.leaderboard([t31], T.periodSinceMs("month", OCT_23));
r.eq(octBoard.find((x) => x.address === C)?.wins, 3, "tournament started Oct 31: all its games count in October");
r.eq(T.leaderboard([t31], novSince).length, 0, "... and none of them in November");

// Through the real reducer: a public 1v1 joined before the cutoff and resigned after it.
{
  const id = T.duelId(5);
  const t0 = CUTOFF - 60_000;
  const events = [
    { txId: "a", sender: A, blockTime: t0, message: T.messages.join(id) },
    { txId: "b", sender: B, blockTime: t0 + 1_000, message: T.messages.join(id) },
  ];
  const white = T.reduce(events)[id].games["1-0"].white;
  events.push({ txId: "c", sender: white, blockTime: CUTOFF + 60_000, message: T.messages.resign(id, "1-0") });
  const reduced = T.reduce(events);
  r.check(reduced[id].games["1-0"].winner && reduced[id].games["1-0"].endedAt > CUTOFF, "reducer: the game ended after the cutoff");
  r.eq(T.leaderboard(Object.values(reduced)).length, 0, "reducer: started before the cutoff, so it is on neither board");
  // Same room joined after the cutoff counts.
  const later = events.map((e) => ({ ...e, blockTime: e.blockTime + 120_000 }));
  r.eq(T.duelLeaderboard(T.leaderboard(Object.values(T.reduce(later)))).length, 2, "reducer: started after the cutoff, both players on the 1v1 board");
}

// --- The indexer answer -----------------------------------------------------------------------
const remoteRow = (address, wins, losses, extra = {}) => ({ address, wins, losses, duelWins: wins, duelLosses: losses, tournamentGameWins: 0, tournamentGameLosses: 0, tournamentsPlayed: 0, tournamentsWon: 0, tournamentsLost: 0, lastPlayedAt: 1, ...extra });
const answer = (period, since, players) => ({ players, period, since, generatedAt: 1 });

r.eq(T.indexerLeaderboardBoard(answer("month", CUTOFF, [remoteRow(A, 2, 1)]), "month")?.since, CUTOFF, "matching period: accepted");
r.eq(T.indexerLeaderboardBoard(answer("all", CUTOFF, [remoteRow(A, 2, 1)]), "month"), null, "period all answered for month: rejected");
r.eq(T.indexerLeaderboardBoard({ players: [remoteRow(A, 2, 1)], generatedAt: 1 }, "all"), null, "old indexer (no period, no since): rejected");
r.eq(T.indexerLeaderboardBoard({ players: [remoteRow(A, 2, 1)], period: "all" }, "all"), null, "no since: rejected");
r.eq(T.indexerLeaderboardBoard({ period: "all", since: CUTOFF }, "all"), null, "no players: rejected");
r.eq(T.indexerLeaderboardBoard(answer("all", CUTOFF, [{ wins: 3 }, remoteRow(B, 1, 0)]), "all")?.rows.length, 1, "rows without an address are skipped");

const localOct = [remoteRow(A, 1, 0, { lastPlayedAt: 50 })];
// since must equal what this device computes now.
{
  const good = T.indexerLeaderboardBoard(answer("month", CUTOFF, [remoteRow(B, 5, 0)]), "month");
  r.eq(T.mergedLeaderboard(localOct, good, "month", OCT_23).length, 2, "Oct: month since = cutoff matches, indexer rows merged in");
  r.eq(T.mergedLeaderboard(localOct, good, "month", NOV_15), localOct, "Nov: the October answer (since = cutoff) no longer matches, own board only");
  const novAnswer = T.indexerLeaderboardBoard(answer("month", NOV_1, [remoteRow(B, 5, 0)]), "month");
  r.eq(T.mergedLeaderboard([], novAnswer, "month", NOV_15).length, 1, "Nov: since = Nov 1 matches");
  r.eq(T.mergedLeaderboard([], novAnswer, "month", OCT_23).length, 0, "Oct: an answer with since = Nov 1 does not match");
  const allWrong = T.indexerLeaderboardBoard(answer("all", CUTOFF - 1000, [remoteRow(B, 5, 0)]), "all");
  r.eq(T.mergedLeaderboard(localOct, allWrong, "all", OCT_23), localOct, "all time with another cutoff: own board only");
  r.eq(T.mergedLeaderboard(localOct, null, "all", OCT_23), localOct, "no indexer answer: own board");
}

// --- Merge: per player the larger of each figure, then wins desc, losses asc, lastPlayedAt desc --
{
  const remote = { since: CUTOFF, rows: [
    remoteRow(A, 10, 4, { duelWins: 7, tournamentsWon: 1, tournamentsLost: 2, tournamentsPlayed: 3, tournamentGameWins: 3, tournamentGameLosses: 1, lastPlayedAt: 100 }),
    remoteRow(B, 6, 2, { lastPlayedAt: 300 }),
    remoteRow(C, 6, 2, { lastPlayedAt: 200 }),
  ] };
  const local = [
    remoteRow(A, 8, 5, { duelWins: 8, tournamentsWon: 0, tournamentsLost: 3, tournamentsPlayed: 2, tournamentGameWins: 4, tournamentGameLosses: 0, lastPlayedAt: 900 }),
    remoteRow("kaspa:dave", 6, 1, { lastPlayedAt: 10 }),
  ];
  const merged = T.mergedLeaderboard(local, remote, "all", OCT_23);
  const a = merged.find((x) => x.address === A);
  r.eq(a.wins, 10, "merge: wins = max(10, 8)");
  r.eq(a.losses, 5, "merge: losses = max(4, 5)");
  r.eq(a.duelWins, 8, "merge: duelWins = max(7, 8)");
  r.eq(a.tournamentsWon, 1, "merge: tournamentsWon = max(1, 0)");
  r.eq(a.tournamentsLost, 3, "merge: tournamentsLost = max(2, 3)");
  r.eq(a.tournamentsPlayed, 3, "merge: tournamentsPlayed = max(3, 2)");
  r.eq(a.tournamentGameWins, 4, "merge: tournamentGameWins = max(3, 4)");
  r.eq(a.tournamentGameLosses, 1, "merge: tournamentGameLosses = max(1, 0)");
  r.eq(a.lastPlayedAt, 900, "merge: lastPlayedAt = max(100, 900)");
  r.eq(merged.length, 4, "merge: a player on one side only is kept");
  r.eq(merged.map((x) => x.address).join(" "), [A, "kaspa:dave", B, C].join(" "), "sort: wins desc, then losses asc, then lastPlayedAt desc");
  r.eq(remote.rows[0].wins, 10, "merge leaves the indexer rows untouched");
  r.eq(local[0].losses, 5, "merge leaves the local rows untouched");
}

// --- Month rollover --------------------------------------------------------------------------
{
  r.eq(T.monthRolledOver(0, NOV_15), false, "not computed yet: no rollover");
  const octStart = T.utcMonthStartMs(OCT_23);
  r.eq(T.monthRolledOver(octStart, NOV_1 - 1), false, "still October: no rollover");
  r.eq(T.monthRolledOver(octStart, NOV_1), true, "00:00 UTC on Nov 1: rollover");
  // The recompute a rollover triggers: October's games leave the month board, stay on all time.
  const octGame = duel("oct", CUTOFF + 3_600_000, A, B);
  const novGame = duel("nov", NOV_1 + 3_600_000, C, A);
  const games = [octGame, novGame];
  const monthBefore = T.leaderboard(games, T.periodSinceMs("month", NOV_1 - 1));
  const monthAfter = T.leaderboard(games, T.periodSinceMs("month", NOV_1 + 3_700_000));
  r.eq(monthBefore.find((x) => x.address === A)?.wins, 1, "before the rollover: October's 1v1 on the month board");
  r.eq(monthAfter.find((x) => x.address === A)?.wins ?? 0, 0, "after: October's win is gone from the month board");
  r.eq(monthAfter.find((x) => x.address === C)?.wins, 1, "after: November's 1v1 is there");
  r.eq(T.leaderboard(games, T.periodSinceMs("all", NOV_1 + 3_700_000)).find((x) => x.address === A)?.wins, 1, "all time keeps October's win");
  // And the indexer's October month answer is dropped by the merge until a November one comes.
  const octAnswer = { since: CUTOFF, rows: [remoteRow(A, 9, 0)] };
  r.eq(T.mergedLeaderboard(monthAfter, octAnswer, "month", NOV_1 + 3_700_000), monthAfter, "after: October's indexer month board is not used");
}

console.log(`chess leaderboard period: ${r.pass} passed, ${r.fail} failed`);
if (r.fail) { for (const f of r.failures) console.log(`  FAIL ${f}`); process.exit(1); }
