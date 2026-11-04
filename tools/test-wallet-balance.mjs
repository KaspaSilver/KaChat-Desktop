// The Wallet tab's numbers (KaChat-iPhone bfe9f022 WalletView). No network. Run from the repo root:
//
//   node tools/test-wallet-balance.mjs

import assert from "node:assert/strict";
import { walletTotalSompi, spendingTotalAfterRead, sumBalancesSompi, walletAmountText } from "../ui/wallet-balance.js";

// The total is both parts or unknown, never one part passed off as the whole.
assert.equal(walletTotalSompi(1n, 2n), 3n);
assert.equal(walletTotalSompi(0n, 0n), 0n);
assert.equal(walletTotalSompi(null, 2n), null);
assert.equal(walletTotalSompi(1n, null), null);
assert.equal(walletTotalSompi(null, null), null);
assert.equal(walletTotalSompi(undefined, 2n), null);

// A failed read (null) keeps what was known; a good one replaces it, zero included.
assert.equal(spendingTotalAfterRead(5n, null), 5n);
assert.equal(spendingTotalAfterRead(null, null), null);
assert.equal(spendingTotalAfterRead(undefined, null), null);
assert.equal(spendingTotalAfterRead(5n, 7n), 7n);
assert.equal(spendingTotalAfterRead(5n, 0n), 0n, "an empty wallet is a real answer, not a failed read");

// One batched read added up.
assert.equal(sumBalancesSompi(new Map([["a", 150_000_000], ["b", 1]]).values()), 150_000_001n);
assert.equal(sumBalancesSompi([]), 0n);
assert.equal(sumBalancesSompi([undefined, NaN, 2]), 2n);

// Unknown shows the dash, and only unknown: 0 is a known amount.
const format = (sompi) => `${sompi} sompi`;
assert.equal(walletAmountText(null, format), "--");
assert.equal(walletAmountText(undefined, format), "--");
assert.equal(walletAmountText(0n, format), "0 sompi");
assert.equal(walletAmountText(12n, format), "12 sompi");

console.log("wallet balance: ok");
