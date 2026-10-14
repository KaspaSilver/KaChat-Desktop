// Thousands commas in amount fields (iOS 40c5258, KaspaAmountEntry.grouped / ungrouped).
import assert from "node:assert/strict";
import { groupedAmountText as g, ungroupedAmountText as u, usesCommaDecimal } from "../engine/amounts.js";

assert.equal(g(""), "");
assert.equal(g("0"), "0");
assert.equal(g("123"), "123");
assert.equal(g("1234"), "1,234");
assert.equal(g("12345.5"), "12,345.5");
assert.equal(g("1234567.12345678"), "1,234,567.12345678");
assert.equal(g("1000."), "1,000.");
assert.equal(g(".5"), ".5");
assert.equal(g("12a45"), "12a45");

// Our commas go.
assert.equal(u("12,345", "12,345"), "12345");
assert.equal(u("12,3456", "12,345"), "123456");
assert.equal(u("1234", "123"), "1234");
assert.equal(u("1,234.5", "1,234."), "1234.5");
// A comma typed at the end is the decimal point.
assert.equal(u("12,345,", "12,345"), "12345.");
assert.equal(u("0,", "0"), "0.");
// "0,5" pasted is 0.5, never 5; a comma three digits from the end in an ungrouped number is grouping.
assert.equal(u("0,5", ""), "0.5");
assert.equal(u("1,234", ""), "1234");
assert.equal(u("1,23", "1"), "1.23");
// With a dot already there, every comma is ours.
assert.equal(u("1,234.5", ""), "1234.5");

// Round trip: what's shown always reads back as what was typed.
for (const plain of ["0", "5", "999", "1000", "12345.678", "29000000000", "0.00000001", "1000."]) {
  assert.equal(u(g(plain), g(plain)), plain);
}
// iOS 73af28a (IOS-078): "0,001" is 0.001 - no grouped number starts "0,".
assert.equal(u("0,001", ""), "0.001");
assert.equal(u(",5", ""), ".5");
assert.equal(u("2,500", ""), "2500", "elsewhere a comma three digits from the end is still grouping");

// A device that writes "," as the decimal point: a comma is always the decimal point, thousands
// show as a thin space, and a pasted "1.234,5" is 1234.5.
const cd = { commaDecimal: true };
assert.equal(g("2500", cd), "2\u202F500");
assert.equal(g("1234567.25", cd), "1\u202F234\u202F567.25");
assert.equal(u("2\u202F500", "2\u202F500", cd), "2500");
assert.equal(u("0,001", "", cd), "0.001");
assert.equal(u("2,500", "", cd), "2.500", "a comma is the decimal point there");
assert.equal(u("1.234,5", "", cd), "1234.5");
assert.equal(u("1 234,56", "", cd), "1234.56");
assert.equal(u("12\u202F345,", "12\u202F345", cd), "12345.");
for (const plain of ["0", "5", "1000", "12345.678", "29000000000", "0.00000001"]) {
  assert.equal(u(g(plain, cd), g(plain, cd), cd), plain);
}
assert.equal(usesCommaDecimal("de-DE"), true);
assert.equal(usesCommaDecimal("en-US"), false);
console.log("grouped amount: ok");
