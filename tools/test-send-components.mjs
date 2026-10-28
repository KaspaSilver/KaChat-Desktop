// The shared Send Kaspa pieces' pure helpers (ui/send-kaspa-components.js): Coin Control's
// 8-decimal amounts (iOS CoinControlView formatKas "%.8f"), the Sent sheet's trimmed amount
// (iOS SentConfirmationSheet amountText) and the Coin Control row summary.
import assert from "node:assert/strict";
import { fixedKas8, formatSompiPlain, coinControlSummaryText, blockDagHash, SWIPE_UP_LABELS } from "../ui/send-kaspa-components.js";

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

// The swipe-up screen's BlockDAG (iOS BlockDAGAnimationView.hash): the same 64-bit mix, so the same
// picture. Reference values from the Swift function itself.
for (const [column, salt, expected] of [
  [0, 1, 724033], [1, 1, 600138], [-1, 1, 305824], [5, 10, 837956],
  [-3, 20, 858816], [123456, 30, 828306], [-987654, 11, 55373], [40, 2, 784394],
]) assert.equal(blockDagHash(column, salt), expected, `hash(${column}, ${salt})`);

// iOS SwipeUpLabels.
assert.equal(SWIPE_UP_LABELS.send.release, "Release to Send");
assert.equal(SWIPE_UP_LABELS.claim.done, "Claim Started");
assert.equal(SWIPE_UP_LABELS.buy.recipientWord, "for");

console.log("send components: ok");
