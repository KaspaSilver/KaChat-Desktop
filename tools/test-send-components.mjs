// The shared Send Kaspa pieces' pure helpers (ui/send-kaspa-components.js): Coin Control's
// 8-decimal amounts (iOS CoinControlView formatKas "%.8f"), the Sent sheet's trimmed amount
// (iOS SentConfirmationSheet amountText) and the Coin Control row summary.
import assert from "node:assert/strict";
import { fixedKas8, formatSompiPlain, coinControlSummaryText } from "../ui/send-kaspa-components.js";

assert.equal(fixedKas8(150000000n), "1.50000000");
assert.equal(fixedKas8(0n), "0.00000000");
assert.equal(fixedKas8(1n), "0.00000001");
assert.equal(fixedKas8(123456789012n), "1234.56789012");
assert.equal(fixedKas8(-5n), "-0.00000005");
assert.equal(fixedKas8("250000000"), "2.50000000");

assert.equal(formatSompiPlain(150000000n), "1.5");
assert.equal(formatSompiPlain(100000000n), "1");
assert.equal(formatSompiPlain(2000000n), "0.02");

assert.equal(coinControlSummaryText(0), "Automatic");
assert.equal(coinControlSummaryText(1), "1 UTXO selected");
assert.equal(coinControlSummaryText(3), "3 UTXOs selected");

console.log("send components: ok");
