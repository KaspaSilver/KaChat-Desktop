// Thousands commas in amount fields (iOS 40c5258, KaspaAmountEntry.grouped / ungrouped).
import assert from "node:assert/strict";
import { groupedAmountText as g, ungroupedAmountText as u } from "../engine/amounts.js";

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
console.log("grouped amount: ok");
