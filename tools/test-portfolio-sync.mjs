// node tools/test-portfolio-sync.mjs - portfolios in the Nextcloud backup (ui/portfolio-sync.js,
// NEXTCLOUD_SYNC.md §5 "Portfolios", iOS 11f1548 PortfolioSync.merge / PortfolioLedgerStore.stamped).
import assert from "node:assert/strict";
import {
  mergePortfolioSync, mergePortfolioArchives, mergePortfolioTombstones, stampPortfolioChanges,
  portfolioSyncFromArchive, portfolioSyncToArchive, portfolioSyncFromDesktop, portfolioSyncToDesktop,
  portfolioSyncForArchive, isPristinePortfolioSeed, newPortfolioUuid, PORTFOLIO_SEED_NAME, foldPortfolioEquivalents,
} from "../ui/portfolio-sync.js";

const P1 = "11111111-1111-4111-8111-111111111111";
const P2 = "22222222-2222-4222-8222-222222222222";
const P3 = "33333333-3333-4333-8333-333333333333";
const T = Date.parse("2026-10-09T12:00:00Z");
const at = (seconds) => T + seconds * 1000;
const iso = (ms) => `${new Date(ms).toISOString().slice(0, 19)}Z`;

const portfolio = (id, name, { sortOrder = 0, createdAt = at(0), updatedAt = null } = {}) =>
  ({ id, name, sortOrder, createdAt, updatedAt });
const row = (id, portfolioId, { updatedAt = null, amountSompi = 100_000_000, fiatValue = 10, timestamp = at(0), notes = null } = {}) =>
  ({ id, type: "buy", amountSompi, fiatValue, timestamp, notes, portfolioId, sourceAddress: null, sourceTxId: null, updatedAt });
const fee = (txId, portfolioId, fiatValue = null) =>
  ({ txId, portfolioId, sourceAddress: "kaspa:qpsource", amountSompi: 2000, timestamp: at(0), fiatValue });
const tomb = (kind, id, deletedAt) => ({ kind, id, deletedAt });
const side = ({ portfolios = [], transactions = [], fees = [], tombstones = [] } = {}) => ({ portfolios, transactions, fees, tombstones });

const tests = [];
function test(name, fn) { tests.push([name, fn]); }

test("newest updatedAt wins per portfolio and per row; a tie keeps the first side", () => {
  const a = side({
    portfolios: [portfolio(P1, "Old name", { updatedAt: at(10) })],
    transactions: [row("tx-1", P1, { updatedAt: at(10), fiatValue: 1 }), row("tx-2", P1, { updatedAt: at(50), fiatValue: 5 })],
  });
  const b = side({
    portfolios: [portfolio(P1, "New name", { updatedAt: at(20) })],
    transactions: [row("tx-1", P1, { updatedAt: at(20), fiatValue: 2 }), row("tx-2", P1, { updatedAt: at(50), fiatValue: 6 })],
  });
  const merged = mergePortfolioSync([a, b]);
  assert.equal(merged.portfolios[0].name, "New name");
  assert.equal(merged.transactions.find((t) => t.id === "tx-1").fiatValue, 2);
  assert.equal(merged.transactions.find((t) => t.id === "tx-2").fiatValue, 5, "tie keeps the earlier side");
  // A portfolio without updatedAt counts as its createdAt; a row without one as the oldest possible.
  const c = mergePortfolioSync([
    side({ portfolios: [portfolio(P1, "Created", { createdAt: at(30) })], transactions: [row("tx-1", P1, { fiatValue: 7 })] }),
    side({ portfolios: [portfolio(P1, "Edited", { createdAt: at(0), updatedAt: at(29) })], transactions: [row("tx-1", P1, { updatedAt: at(1), fiatValue: 8 })] }),
  ]);
  assert.equal(c.portfolios[0].name, "Created");
  assert.equal(c.transactions[0].fiatValue, 8);
});

test("a tombstone at or after the last edit deletes; an edit after it survives", () => {
  const items = side({
    portfolios: [portfolio(P1, "One", { updatedAt: at(10) }), portfolio(P2, "Two", { sortOrder: 1, updatedAt: at(10) })],
    transactions: [row("tx-at", P1, { updatedAt: at(10) }), row("tx-after", P1, { updatedAt: at(30) }), row("tx-legacy", P1)],
  });
  const deletions = side({
    tombstones: [
      tomb("portfolio", P2, at(10)),          // exactly at: deleted
      tomb("transaction", "tx-at", at(10)),   // exactly at: deleted
      tomb("transaction", "tx-after", at(20)),// before the edit: the row comes back
      tomb("transaction", "tx-legacy", at(0)),// a row with no stamp is as old as possible
    ],
  });
  const merged = mergePortfolioSync([items, deletions]);
  assert.deepEqual(merged.portfolios.map((p) => p.id), [P1]);
  assert.deepEqual(merged.transactions.map((t) => t.id).sort(), ["tx-after"]);
  assert.equal(merged.tombstones.length, 4, "tombstones are kept");
});

test("tombstones: union of both sides, the newest per item", () => {
  const merged = mergePortfolioTombstones([
    [tomb("transaction", "a", at(5)), tomb("portfolio", P1, at(9))],
    [tomb("transaction", "a", at(7)), tomb("transaction", "b", at(1)), tomb("portfolio", P1, at(3))],
  ]);
  assert.deepEqual(merged, [tomb("portfolio", P1, at(9)), tomb("transaction", "a", at(7)), tomb("transaction", "b", at(1))]);
});

test("a deleted portfolio takes its rows and fees, even rows edited later", () => {
  const merged = mergePortfolioSync([
    side({
      portfolios: [portfolio(P1, "Keep", { updatedAt: at(1) }), portfolio(P2, "Gone", { sortOrder: 1, updatedAt: at(1) })],
      transactions: [row("keep", P1, { updatedAt: at(1) }), row("gone", P2, { updatedAt: at(99) })],
      fees: [fee("f1", P1), fee("f2", P2, 3)],
    }),
    side({ tombstones: [tomb("portfolio", P2, at(5))] }),
  ]);
  assert.deepEqual(merged.portfolios.map((p) => p.id), [P1]);
  assert.deepEqual(merged.transactions.map((t) => t.id), ["keep"]);
  assert.deepEqual(merged.fees.map((f) => f.txId), ["f1"]);
});

test("fees merge by portfolioId:txId and a priced copy beats an unpriced one", () => {
  const ps = [portfolio(P1, "A", { updatedAt: at(1) }), portfolio(P2, "B", { sortOrder: 1, updatedAt: at(1) })];
  const merged = mergePortfolioSync([
    side({ portfolios: ps, fees: [fee("x", P1), fee("x", P2, 4), fee("y", P1, 1)] }),
    side({ fees: [fee("x", P1, 2), fee("x", P2), fee("y", P1, 9)] }),
  ]);
  assert.equal(merged.fees.length, 3);
  const get = (txId, pid) => merged.fees.find((f) => f.txId === txId && f.portfolioId === pid).fiatValue;
  assert.equal(get("x", P1), 2, "priced beats unpriced");
  assert.equal(get("x", P2), 4, "unpriced never replaces priced");
  assert.equal(get("y", P1), 1, "two priced copies: the first stays");
});

test("the untouched seed is never uploaded and is dropped when other portfolios arrive", () => {
  const seed = portfolio(P3, PORTFOLIO_SEED_NAME);
  const fresh = side({ portfolios: [seed] });
  assert.ok(isPristinePortfolioSeed(seed));
  assert.equal(portfolioSyncForArchive(fresh).portfolios.length, 0);
  assert.deepEqual(portfolioSyncToArchive(portfolioSyncForArchive(fresh)), {}, "nothing to upload");
  // A seed that was used is a real portfolio.
  assert.ok(!isPristinePortfolioSeed(seed, [row("r", P3)]));
  assert.ok(!isPristinePortfolioSeed(seed, [], [fee("f", P3)]));
  assert.ok(!isPristinePortfolioSeed({ ...seed, updatedAt: at(1) }));
  // Receiving the real list drops this device's own seed; alone it stays.
  const real = side({ portfolios: [portfolio(P1, "Portfolio 1", { updatedAt: at(1) })] });
  assert.deepEqual(mergePortfolioSync([fresh, real]).portfolios.map((p) => p.id), [P1]);
  assert.deepEqual(mergePortfolioSync([fresh]).portfolios.map((p) => p.id), [P3]);
});

test("ordered by sortOrder (ties by createdAt) and renumbered 0..n-1", () => {
  const merged = mergePortfolioSync([
    side({ portfolios: [portfolio(P1, "A", { sortOrder: 4, createdAt: at(1), updatedAt: at(1) }), portfolio(P2, "B", { sortOrder: 2, createdAt: at(5), updatedAt: at(1) })] }),
    side({ portfolios: [portfolio(P3, "C", { sortOrder: 2, createdAt: at(2), updatedAt: at(1) })] }),
  ]);
  assert.deepEqual(merged.portfolios.map((p) => [p.name, p.sortOrder]), [["C", 0], ["B", 1], ["A", 2]]);
});

test("archive round trip: ISO whole seconds, uppercase portfolio ids, optional fields left out", () => {
  const lower = P1.toLowerCase().replace(/1/g, "a");
  const archive = {
    portfolios: [{ id: lower, name: "Mine", sortOrder: 0, createdAt: "2026-10-09T12:00:00Z", updatedAt: "2026-10-09T12:00:05.250Z" }],
    portfolioTransactions: [
      { id: "ROW-1", type: "sell", amountSompi: 150000000, fiatValue: 3.5, timestamp: "2026-10-01T00:00:00Z", portfolioId: lower },
      { id: "bad", type: "mint", amountSompi: 1, fiatValue: 1, timestamp: "2026-10-01T00:00:00Z", portfolioId: lower },
    ],
    portfolioFees: [{ txId: "abc", portfolioId: lower, sourceAddress: "kaspa:q", amountSompi: 2000, timestamp: "2026-10-01T00:00:00Z" }],
    portfolioDeleted: [{ kind: "portfolio", id: P2.toLowerCase(), deletedAt: "2026-10-09T12:00:00Z" }],
  };
  const sync = portfolioSyncFromArchive(archive);
  assert.equal(sync.portfolios[0].id, lower.toUpperCase());
  assert.equal(sync.transactions.length, 1, "an unreadable row is skipped alone");
  assert.equal(sync.tombstones[0].id, P2);
  const out = portfolioSyncToArchive(sync);
  assert.equal(out.portfolios[0].updatedAt, "2026-10-09T12:00:05Z");
  assert.equal(out.portfolioTransactions[0].portfolioId, lower.toUpperCase());
  assert.ok(!("notes" in out.portfolioTransactions[0]) && !("updatedAt" in out.portfolioTransactions[0]));
  assert.ok(!("fiatValue" in out.portfolioFees[0]), "an unpriced fee has no fiatValue key");
  assert.match(newPortfolioUuid(), /^[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/);
});

test("shared-file merge: deletion on one device, edit on another, seed and empty keys", () => {
  const local = {
    portfolios: [{ id: P1, name: "Trading", sortOrder: 0, createdAt: iso(at(0)), updatedAt: iso(at(10)) }],
    portfolioTransactions: [{ id: "r1", type: "buy", amountSompi: 1, fiatValue: 1, timestamp: iso(at(0)), portfolioId: P1, updatedAt: iso(at(10)) }],
    portfolioDeleted: [{ kind: "transaction", id: "r2", deletedAt: iso(at(40)) }],
  };
  const remote = {
    portfolios: [
      { id: P1, name: "Trading (renamed)", sortOrder: 0, createdAt: iso(at(0)), updatedAt: iso(at(20)) },
      { id: P3, name: PORTFOLIO_SEED_NAME, sortOrder: 1, createdAt: iso(at(0)) },
    ],
    portfolioTransactions: [{ id: "r2", type: "buy", amountSompi: 1, fiatValue: 1, timestamp: iso(at(0)), portfolioId: P1, updatedAt: iso(at(30)) }],
  };
  const merged = mergePortfolioArchives(local, remote);
  assert.deepEqual(merged.portfolios.map((p) => p.name), ["Trading (renamed)"]);
  assert.deepEqual(merged.portfolioTransactions.map((t) => t.id), ["r1"]);
  assert.deepEqual(merged.portfolioDeleted, [{ kind: "transaction", id: "r2", deletedAt: iso(at(40)) }]);
  assert.ok(!("portfolioFees" in merged), "an empty key is left out");
  assert.deepEqual(mergePortfolioArchives({}, null), {});
});

test("stamping: added, renamed, moved and edited are stamped; gone becomes a tombstone", () => {
  const before = [
    { id: P1, name: "A", createdAt: at(0), transactions: [{ id: "r1", type: "buy", amountKas: 1, fiatValue: 1, timestamp: at(0), notes: null }] },
    { id: P2, name: "B", createdAt: at(0), transactions: [{ id: "r2", type: "buy", amountKas: 2, fiatValue: 2, timestamp: at(0), notes: null }, { id: "r3", type: "sell", amountKas: 1, fiatValue: 1, timestamp: at(0), notes: null }] },
    { id: P3, name: "C", createdAt: at(0), transactions: [{ id: "r4", type: "buy", amountKas: 1, fiatValue: 1, timestamp: at(0), notes: null }] },
  ];
  const now = at(100);
  // Unchanged: nothing stamped, nothing gone.
  const same = JSON.parse(JSON.stringify(before));
  assert.deepEqual(stampPortfolioChanges(before, same, now), { changed: false, tombstones: [] });
  assert.ok(same.every((p) => p.updatedAt === undefined));
  // B and A swap places, C is deleted (with r4), r1 moves to B, r2 is edited, a portfolio is added.
  const after = JSON.parse(JSON.stringify(before));
  const [a, b] = after;
  const r1 = a.transactions.pop();
  b.transactions.push(r1);
  b.transactions[0].fiatValue = 9;
  const added = { id: newPortfolioUuid(), name: "D", createdAt: now, transactions: [] };
  const result = stampPortfolioChanges(before, [b, a, added], now);
  assert.ok(result.changed);
  assert.equal(a.updatedAt, now, "moved");
  assert.equal(b.updatedAt, now, "moved");
  assert.equal(added.updatedAt, now, "added");
  assert.equal(r1.updatedAt, now, "moved to another portfolio");
  assert.equal(b.transactions[0].updatedAt, now, "edited");
  assert.equal(b.transactions[1].updatedAt, undefined, "untouched row");
  assert.deepEqual(result.tombstones, [tomb("portfolio", P3, now), tomb("transaction", "r4", now)]);
  // A stamp alone is not a change.
  const restamped = JSON.parse(JSON.stringify(before)).map((p) => ({ ...p, updatedAt: at(5) }));
  assert.equal(stampPortfolioChanges(before, restamped, now).changed, false);
});

test("Desktop store round trip keeps order, KAS amounts and stamps", () => {
  const stored = [
    { id: P2, name: "Second", createdAt: at(0), updatedAt: at(3), transactions: [{ id: "r1", type: "transfer", amountKas: 0.12345678, fiatValue: 0, timestamp: at(1), notes: "n", sourceAddress: "kaspa:q", sourceTxId: "t" }] },
    { id: P1, name: "First", createdAt: at(1), transactions: [] },
  ];
  const fees = [fee("f", P2, null)];
  const sync = portfolioSyncFromDesktop(stored, fees, [tomb("transaction", "x", at(2))]);
  assert.deepEqual(sync.portfolios.map((p) => [p.id, p.sortOrder]), [[P2, 0], [P1, 1]]);
  assert.equal(sync.transactions[0].amountSompi, 12_345_678);
  assert.equal(sync.transactions[0].portfolioId, P2);
  const back = portfolioSyncToDesktop(mergePortfolioSync([sync]));
  assert.deepEqual(back.portfolios.map((p) => p.name), ["Second", "First"]);
  assert.equal(back.portfolios[0].transactions[0].amountKas, 0.12345678);
  assert.equal(back.portfolios[0].updatedAt, at(3));
  assert.ok(!("updatedAt" in back.portfolios[1]));
  assert.equal(back.fees[0].fiatValue, null);
  assert.deepEqual(back.tombstones, [tomb("transaction", "x", at(2))]);
});

// iOS 54788da (IOS-073): what two devices made before sync is folded.
const imported = (id, portfolioId, sourceTxId, opts = {}) => ({ ...row(id, portfolioId, opts), type: "transfer", sourceTxId });
const deviceA = () => side({
  portfolios: [portfolio(P1, "Portfolio 1", { createdAt: at(0) })],
  transactions: [imported("a-1", P1, "txid-1"), imported("a-2", P1, "txid-2"), row("a-manual", P1)],
  fees: [fee("txid-1", P1, 3)],
});
const deviceB = () => side({
  portfolios: [portfolio(P2, "Portfolio 1", { createdAt: at(5) })],
  transactions: [imported("b-1", P2, "txid-1", { updatedAt: at(9), notes: "edited on B" }), imported("b-3", P2, "txid-3"), row("b-manual", P2)],
  fees: [fee("txid-1", P2, 3), fee("txid-3", P2, null)],
});

test("fold: same-named portfolios without updatedAt become one, rows and fees move, an import kept once", () => {
  const merged = mergePortfolioSync([deviceA(), deviceB()]);
  assert.deepEqual(merged.portfolios.map((p) => p.id), [P1], "the oldest id stays");
  assert.ok(merged.transactions.every((t) => t.portfolioId === P1));
  assert.deepEqual(merged.transactions.map((t) => t.id).sort(), ["a-2", "a-manual", "b-1", "b-3", "b-manual"]);
  assert.equal(merged.transactions.find((t) => t.sourceTxId === "txid-1").notes, "edited on B", "the newest edit stays");
  assert.deepEqual(merged.fees.map((f) => `${f.portfolioId}:${f.txId}`), [`${P1}:txid-1`, `${P1}:txid-3`]);
  // no updatedAt anywhere on the duplicate: ties keep the smaller id
  const tie = mergePortfolioSync([
    side({ portfolios: [portfolio(P1, "Main")], transactions: [imported("z-copy", P1, "t")] }),
    side({ portfolios: [portfolio(P2, "Main", { createdAt: at(1) })], transactions: [imported("m-copy", P2, "t")] }),
  ]);
  assert.deepEqual(tie.transactions.map((t) => [t.id, t.portfolioId]), [["m-copy", P1]]);
});

test("fold: either order gives the same result", () => {
  const ab = mergePortfolioSync([deviceA(), deviceB()]);
  const ba = mergePortfolioSync([deviceB(), deviceA()]);
  assert.deepEqual(ab.portfolios, ba.portfolios);
  assert.deepEqual(ab.transactions, ba.transactions);
  assert.deepEqual(ab.fees, ba.fees);
  // a createdAt tie folds into the smaller id whichever side comes first
  const x = side({ portfolios: [portfolio(P2, "Same")] });
  const y = side({ portfolios: [portfolio(P1, "Same")] });
  assert.deepEqual(mergePortfolioSync([x, y]).portfolios.map((p) => p.id), [P1]);
  assert.deepEqual(mergePortfolioSync([y, x]).portfolios.map((p) => p.id), [P1]);
});

test("fold: stable on the next sync", () => {
  const first = mergePortfolioSync([deviceA(), deviceB()]);
  // each device saves the merge; the next sync meets it again next to the device's old copy
  const again = mergePortfolioSync([first, deviceB()]);
  assert.deepEqual(again.portfolios, first.portfolios);
  assert.deepEqual(again.transactions, first.transactions);
  assert.deepEqual(again.fees, first.fees);
  assert.deepEqual(mergePortfolioSync([first, first]), first);
  const viaArchive = portfolioSyncFromArchive(mergePortfolioArchives(portfolioSyncToArchive(first), portfolioSyncToArchive(deviceA())));
  assert.deepEqual(viaArchive.transactions.map((t) => t.id), first.transactions.map((t) => t.id));
});

test("fold: different names, or an edited portfolio, stay apart", () => {
  const merged = mergePortfolioSync([
    side({ portfolios: [portfolio(P1, "Savings")], transactions: [imported("s", P1, "t")] }),
    side({ portfolios: [portfolio(P2, "Trading", { sortOrder: 1 })], transactions: [imported("t", P2, "t")] }),
  ]);
  assert.deepEqual(merged.portfolios.map((p) => p.id), [P1, P2]);
  assert.equal(merged.transactions.length, 2);
  const edited = mergePortfolioSync([
    side({ portfolios: [portfolio(P1, "Same")] }),
    side({ portfolios: [portfolio(P3, "Same", { sortOrder: 1, updatedAt: at(4) })] }),
  ]);
  assert.deepEqual(edited.portfolios.map((p) => p.id), [P1, P3]);
  assert.equal(foldPortfolioEquivalents([side()]).length, 1);
});

let failed = 0;
for (const [name, fn] of tests) {
  try { fn(); console.log(`ok - ${name}`); }
  catch (error) { failed += 1; console.error(`FAIL - ${name}\n${error?.stack || error}`); }
}
console.log(`${tests.length - failed}/${tests.length} portfolio sync checks passed`);
if (failed) process.exit(1);
