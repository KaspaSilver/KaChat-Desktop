// The Wallet tab's numbers (iOS bfe9f022 WalletView), without a DOM, for
// tools/test-wallet-balance.mjs. Amounts are BigInt sompi, null while unknown. Unknown is never 0:
// a read that failed shows as a dash, not as an empty wallet.

/** Both parts or nothing: a total missing one of them would read as the whole balance. */
export function walletTotalSompi(chattingSompi, spendingSompi) {
  if (chattingSompi == null || spendingSompi == null) return null;
  return BigInt(chattingSompi) + BigInt(spendingSompi);
}

/**
 * The spending total after a read. `readSompi` is null when the read failed, and that leaves the
 * previous total in place: a few seconds stale reads better than a figure that vanishes because
 * one request timed out.
 */
export function spendingTotalAfterRead(previousSompi, readSompi) {
  return readSompi ?? previousSompi ?? null;
}

/** One batched read's per-address balances added up (Numbers from the node's answer). */
export function sumBalancesSompi(balances) {
  let sompi = 0n;
  for (const value of balances) sompi += BigInt(Math.round(Number(value) || 0));
  return sompi;
}

/** `format` for a known amount, the dash for an unknown one. */
export function walletAmountText(sompi, format) {
  return sompi == null ? "--" : format(sompi);
}
