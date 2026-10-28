// node tools/test-portfolio-csv.mjs - Portfolio CSV import/export (ui/portfolio-sync.js), iOS 59593af
// PortfolioViewModel.exportCsvURL / importCsv / resolveImportPortfolio: the trailing `Portfolio`
// column, routing rows by it, and CoinMarketCap / older files without it.
import assert from "node:assert/strict";
import {
  importPortfolioCsv, portfolioCsvText, portfolioCsvImportMessage, parsePortfolioCsvRecords,
  PORTFOLIO_SEED_NAME,
} from "../ui/portfolio-sync.js";

const CMC_HEADER = "Date (UTC+0:00),Token,Type,Price (USD),Amount,Total value (USD),Fee,Fee Currency,Notes";
const HEADER = `${CMC_HEADER},Portfolio`;
const row = (date, type, amount, total, notes = "", portfolio = null) =>
  `"${date}","KAS","${type}","0","${amount}","${total}","0.00","USD","${notes}"${portfolio === null ? "" : `,"${portfolio}"`}`;
const csv = (header, ...rows) => `${header}\n${rows.join("\n")}\n`;

let seq = 0;
const newId = () => `ID-${++seq}`;
const p = (id, name, { transactions = [], updatedAt } = {}) =>
  ({ id, name, createdAt: 1, ...(updatedAt !== undefined ? { updatedAt } : {}), transactions });
const tx = (id, timestamp, extra = {}) => ({ id, type: "buy", amountKas: 1, fiatValue: 1, timestamp, notes: null, ...extra });
const seedState = () => ({ activeId: "SEED", portfolios: [p("SEED", PORTFOLIO_SEED_NAME)] });
const ts = (s) => Date.parse(`${s.replace(" ", "T")}Z`);
const opts = (extra = {}) => ({ newId, now: 1000, maxPortfolios: 5, ...extra });

const tests = [];
function test(name, fn) { tests.push([name, fn]); }

test("export: header ends with Portfolio, every row carries the name (quotes doubled)", () => {
  const text = portfolioCsvText(p("A", 'Long "Term"', {
    transactions: [tx("2", ts("2026-02-01 00:00:00"), { type: "sell", notes: 'a "b"' }), tx("1", ts("2026-01-01 10:20:30"))],
  }));
  const records = parsePortfolioCsvRecords(text);
  assert.deepEqual(records[0], HEADER.split(","));
  assert.equal(records.length, 3);
  assert.equal(records[1][0], "2026-01-01 10:20:30"); // oldest first
  assert.equal(records[1][9], 'Long "Term"');
  assert.equal(records[2][2], "sell");
  assert.equal(records[2][8], 'a "b"');
  assert.equal(records[2][9], 'Long "Term"');
});

test("round trip: an export imports back into the portfolio of that name, not the active one", () => {
  const source = p("SRC", "Trading", { transactions: [tx("x", ts("2026-03-01 12:00:00"), { amountKas: 5, fiatValue: 2, notes: "hi" })] });
  const state = { activeId: "OTHER", portfolios: [p("OTHER", "Savings", { updatedAt: 5 }), p("TR", "trading", { updatedAt: 5 })] };
  const result = importPortfolioCsv(state, portfolioCsvText(source), opts());
  assert.equal(result.count, 1);
  assert.deepEqual(result.portfolioNames, ["trading"]); // matched in any case
  assert.equal(state.activeId, "TR");
  assert.equal(state.portfolios.length, 2);
  const [imported] = state.portfolios[1].transactions;
  assert.equal(imported.amountKas, 5);
  assert.equal(imported.fiatValue, 2);
  assert.equal(imported.notes, "hi"); // the Notes column, not the Portfolio column
  assert.equal(state.portfolios[0].transactions.length, 0);
});

test("an untouched Portfolio 1 takes the name instead of a new portfolio being made", () => {
  const state = seedState();
  const result = importPortfolioCsv(state, csv(HEADER, row("2026-01-01 00:00:00", "buy", 1, 1, "", "Cold Wallet")), opts());
  assert.equal(result.count, 1);
  assert.equal(state.portfolios.length, 1);
  assert.equal(state.portfolios[0].id, "SEED");
  assert.equal(state.portfolios[0].name, "Cold Wallet");
  assert.deepEqual(result.portfolioNames, ["Cold Wallet"]);
});

test("a seed that was edited, holds rows or has fees is not pristine: a new portfolio is made", () => {
  for (const [state, fees] of [
    [{ activeId: "SEED", portfolios: [p("SEED", PORTFOLIO_SEED_NAME, { updatedAt: 9 })] }, []],
    [{ activeId: "SEED", portfolios: [p("SEED", PORTFOLIO_SEED_NAME, { transactions: [tx("t", 1)] })] }, []],
    [seedState(), [{ txId: "f", portfolioId: "SEED" }]],
  ]) {
    const result = importPortfolioCsv(state, csv(HEADER, row("2026-01-01 00:00:00", "buy", 1, 1, "", "New One")), opts({ fees }));
    assert.equal(result.count, 1);
    assert.equal(state.portfolios.length, 2);
    assert.equal(state.portfolios[0].name, PORTFOLIO_SEED_NAME);
    assert.equal(state.portfolios[1].name, "New One");
    assert.equal(state.portfolios[1].createdAt, 1000);
    assert.equal(state.activeId, state.portfolios[1].id);
  }
});

test("rows naming several portfolios go to each; toast lists them in file order; first becomes active", () => {
  const state = { activeId: "A", portfolios: [p("A", "Alpha", { updatedAt: 1 })] };
  const result = importPortfolioCsv(state, csv(HEADER,
    row("2026-01-01 00:00:00", "buy", 1, 1, "", "Beta"),
    row("2026-01-02 00:00:00", "buy", 1, 1, "", "alpha"),
    row("2026-01-03 00:00:00", "sell", 1, 1, "", "BETA"),
    row("2026-01-04 00:00:00", "buy", 1, 1, "", "Gamma")), opts());
  assert.equal(result.count, 4);
  assert.deepEqual(state.portfolios.map((x) => x.name), ["Alpha", "Beta", "Gamma"]);
  assert.deepEqual(result.portfolioNames, ["Beta", "Alpha", "Gamma"]);
  assert.equal(state.portfolios[1].transactions.length, 2);
  assert.equal(state.activeId, state.portfolios[1].id);
  assert.equal(portfolioCsvImportMessage(result), "Imported 4 transactions into Beta, Alpha, Gamma");
});

test("at the portfolio limit an unknown name goes to the active portfolio", () => {
  const portfolios = ["A", "B", "C", "D", "E"].map((id) => p(id, `P${id}`, { updatedAt: 1 }));
  const state = { activeId: "C", portfolios };
  const result = importPortfolioCsv(state, csv(HEADER,
    row("2026-01-01 00:00:00", "buy", 1, 1, "", "Nope"),
    row("2026-01-02 00:00:00", "buy", 1, 1, "", "pa")), opts());
  assert.equal(result.count, 2);
  assert.equal(state.portfolios.length, 5);
  assert.equal(state.portfolios[2].transactions.length, 1);
  assert.equal(state.portfolios[0].transactions.length, 1); // an existing name still matches
  assert.deepEqual(result.portfolioNames, ["PC", "PA"]);
  assert.equal(state.activeId, "C");
});

test("a row with an empty name, a short row, and a CoinMarketCap file go to the active portfolio", () => {
  const state = { activeId: "B", portfolios: [p("A", "Alpha", { updatedAt: 1 }), p("B", "Beta", { updatedAt: 1 })] };
  let result = importPortfolioCsv(state, csv(HEADER, row("2026-01-01 00:00:00", "buy", 1, 1, "", "  ")), opts());
  assert.deepEqual(result.portfolioNames, ["Beta"]);
  // Fewer fields than the header: no Portfolio field at all.
  result = importPortfolioCsv(state, csv(HEADER, `"2026-01-02 00:00:00","KAS","buy","0","1","1"`), opts());
  assert.deepEqual(result.portfolioNames, ["Beta"]);
  result = importPortfolioCsv(state, csv(CMC_HEADER, row("2026-01-03 00:00:00", "buy", 1, 1, "note")), opts());
  assert.equal(result.count, 1);
  assert.deepEqual(result.portfolioNames, ["Beta"]);
  assert.equal(state.portfolios[1].transactions.length, 3);
  assert.equal(state.portfolios[1].transactions[2].notes, "note");
  assert.equal(state.portfolios.length, 2);
  assert.equal(portfolioCsvImportMessage(result), "Imported 1 transaction into Beta");
});

test("an old CSV without the column imports as before: UTC offset, USD fee, transfer, replace by timestamp", () => {
  const at = ts("2026-01-01 14:00:00");
  const state = { activeId: "A", portfolios: [p("A", "Alpha", { updatedAt: 1, transactions: [tx("keep", at, { sourceTxId: "abc" })] })] };
  const header = "Date (UTC-4:00),Token,Type,Price (USD),Amount,Total value (USD),Fee,Fee Currency,Notes";
  const result = importPortfolioCsv(state, csv(header,
    `"2026-01-01 10:00:00","KAS","Buy","0","1,000","10,597.25","2.75","USD",""`,
    `"2026-01-02 10:00:00","KAS","sell","0","3","10","4","USD",""`,
    `"2026-01-03 10:00:00","KAS","Transfer In","0","3","10","4","USD",""`,
    `"2026-01-04 10:00:00","BTC","buy","0","3","10","0","USD",""`,
    `"bad date","KAS","buy","0","3","10","0","USD",""`), opts());
  assert.equal(result.count, 3);
  const rows = state.portfolios[0].transactions;
  assert.equal(rows.length, 3);
  assert.equal(rows[0].id, "keep"); // same timestamp: replaced in place, id kept
  assert.equal(rows[0].sourceTxId, "abc");
  assert.equal(rows[0].amountKas, 1000);
  assert.equal(rows[0].fiatValue, 10600);
  assert.equal(rows[1].fiatValue, 6);
  assert.equal(rows[2].type, "transfer");
  assert.equal(rows[2].fiatValue, 10);
});

test("replace by timestamp only looks inside the portfolio the row goes to", () => {
  const at = ts("2026-05-05 05:05:05");
  const state = { activeId: "A", portfolios: [p("A", "Alpha", { updatedAt: 1, transactions: [tx("a1", at)] }), p("B", "Beta", { updatedAt: 1 })] };
  const result = importPortfolioCsv(state, csv(HEADER, row("2026-05-05 05:05:05", "buy", 7, 7, "", "Beta")), opts());
  assert.equal(result.count, 1);
  assert.equal(state.portfolios[0].transactions[0].amountKas, 1);
  assert.equal(state.portfolios[1].transactions.length, 1);
  assert.equal(state.portfolios[1].transactions[0].amountKas, 7);
});

test("rows that don't parse never make a portfolio; nothing imported leaves the active one alone", () => {
  const state = { activeId: "A", portfolios: [p("A", "Alpha", { updatedAt: 1 })] };
  const result = importPortfolioCsv(state, csv(HEADER, `"nope","KAS","buy","0","1","1","0","USD","","Ghost"`), opts());
  assert.equal(result.count, 0);
  assert.deepEqual(result.portfolioNames, []);
  assert.equal(state.portfolios.length, 1);
  assert.equal(state.activeId, "A");
  assert.equal(portfolioCsvImportMessage(result), "Import failed. Check the CSV format");
  assert.equal(importPortfolioCsv(state, "", opts()).count, 0);
});

test("an unnamed row first fills the seed, so a later named row makes its own portfolio", () => {
  const state = seedState();
  const result = importPortfolioCsv(state, csv(HEADER,
    row("2026-01-01 00:00:00", "buy", 1, 1, "", ""),
    row("2026-01-02 00:00:00", "buy", 1, 1, "", "Named")), opts());
  assert.equal(result.count, 2);
  assert.deepEqual(state.portfolios.map((x) => x.name), [PORTFOLIO_SEED_NAME, "Named"]);
  assert.equal(state.activeId, "SEED");
  assert.equal(portfolioCsvImportMessage(result), `Imported 2 transactions into ${PORTFOLIO_SEED_NAME}, Named`);
});

let failed = 0;
for (const [name, fn] of tests) {
  try { fn(); console.log(`ok - ${name}`); }
  catch (error) { failed += 1; console.error(`FAIL - ${name}\n${error?.stack || error}`); }
}
console.log(`${tests.length - failed}/${tests.length} portfolio CSV checks passed`);
if (failed) process.exit(1);
