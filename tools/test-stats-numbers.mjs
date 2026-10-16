// KaChat Stats' numbers (engine/amounts.js statsCountText / statsKasText; iOS b6f55a5 + 1df1bcb,
// KaChatStatsView.grouped / kas): commas whatever the language, at most two decimals, and from a
// million on "1M", "1.01M", "2.5B", rounded DOWN so a figure is never shown before it is reached.
import assert from "node:assert/strict";
import { statsCountText as n, statsKasText as kas } from "../engine/amounts.js";

const KAS = 100_000_000n;

// Below a million: in full, with commas.
assert.equal(n(0), "0");
assert.equal(n(7), "7");
assert.equal(n(999), "999");
assert.equal(n(1000), "1,000");
assert.equal(n(774_086), "774,086");
assert.equal(n(999_999), "999,999");
assert.equal(n(774_086n), "774,086", "BigInt counts too");
assert.equal(n(-5), "0", "a negative count is none");
assert.equal(n(null), "0");

// From a million on: short, two decimals at most, trailing zeros dropped, rounded down.
assert.equal(n(1_000_000), "1M");
assert.equal(n(1_010_000), "1.01M");
assert.equal(n(1_009_999), "1M", "1.009999M is not yet 1.01M");
assert.equal(n(1_999_999), "1.99M", "never rounded up to 2M");
assert.equal(n(2_500_000), "2.5M");
assert.equal(n(1_150_000), "1.15M", "exact: no float landing a hundredth low");
assert.equal(n(4_560_000), "4.56M");
assert.equal(n(999_999_999), "999.99M");
assert.equal(n(1_000_000_000), "1B");
assert.equal(n(2_500_000_000), "2.5B");
assert.equal(n(2_509_999_999n), "2.5B");
assert.equal(n(1_000_000_000_000n), "1T");
assert.equal(n(123_456_000_000_000n), "123.45T");
assert.equal(n(1_000_000_000_000_000n), "1,000T", "past T the figure keeps its commas");

// KAS: commas, at most two decimals (half to even, as iOS's NumberFormatter), the unit after.
assert.equal(kas(0n), "0 KAS");
assert.equal(kas(1n), "0 KAS");
assert.equal(kas(150_000_000n), "1.5 KAS");
assert.equal(kas(21_035n * KAS + 50_000_000n), "21,035.5 KAS");
assert.equal(kas(21_035n * KAS + 52_000_000n), "21,035.52 KAS");
assert.equal(kas(21_035n * KAS + 50_500_000n), "21,035.5 KAS", "x.505 -> x.50 (half to even)");
assert.equal(kas(21_035n * KAS + 51_500_000n), "21,035.52 KAS", "x.515 -> x.52 (half to even)");
assert.equal(kas(21_035n * KAS + 51_500_001n), "21,035.52 KAS");
assert.equal(kas(12n * KAS + 99_600_000n), "13 KAS", "rounds into the whole part");
assert.equal(kas(999_999n * KAS + 99_999_999n), "1,000,000 KAS", "just under a million KAS rounds to it in full");
assert.equal(kas(1_000_000n * KAS), "1M KAS");
assert.equal(kas(1_019_999n * KAS + 99_999_999n), "1.01M KAS", "short KAS is rounded down too");
assert.equal(kas(2_500_000_000n * KAS), "2.5B KAS");
assert.equal(kas(150_000_000n, "TKAS"), "1.5 TKAS", "testnet's unit");
assert.equal(kas("2103550000000"), "21,035.5 KAS", "sompi as a string");

console.log("stats numbers: ok");
