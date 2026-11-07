// What an import works out before and after it lands, without a DOM, for
// tools/test-account-import.mjs.

/** The same depth as one page of the chatting address picker (iOS 836b62bc
 *  PassphraseAddressPreview.searchDepth). */
export const IMPORT_ADDRESS_SEARCH_DEPTH = 50;

/** How long Import waits for that search before letting go and importing onto #0 (KaPay 1652437,
 *  KaPlay 4922804, KaPost 33095ac PassphraseAddressPreview.searchTimeoutNanoseconds). */
export const IMPORT_ADDRESS_SEARCH_TIMEOUT_MS = 12_000;

/**
 * The funds search, given up after `timeoutMs`: `{ timedOut: false, value }` with its answer, or
 * `{ timedOut: true }` once the time is up (an answer after that is ignored by the caller). A search
 * that fails before then rejects, as it would have.
 */
export function raceImportSearch(search, timeoutMs = IMPORT_ADDRESS_SEARCH_TIMEOUT_MS, { setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let timer = null;
  const timeout = new Promise((resolve) => { timer = setTimer(() => resolve({ timedOut: true }), timeoutMs); });
  const answer = Promise.resolve(search).then((value) => ({ timedOut: false, value }));
  return Promise.race([answer, timeout]).finally(() => clearTimer(timer));
}

/**
 * Address #0 plus every other address on the identity chain holding funds, in index order
 * (iOS WalletManager.findChattingAddresses).
 * @param {{ index: number, address: string }[]} derived
 * @param {Map<string, number>} balanceByAddress in sompi
 */
export function foundChattingAddresses(derived, balanceByAddress) {
  return [...derived]
    .sort((a, b) => a.index - b.index)
    .map(({ index, address }) => ({ index, address, sompi: Math.max(0, Number(balanceByAddress.get(address)) || 0) }))
    .filter((entry) => entry.index === 0 || entry.sompi > 0);
}

/** The first address with funds, or the first address when none has any. Null for no addresses. */
export function firstFundedAddress(found) {
  return found.find((entry) => entry.sompi > 0) || found[0] || null;
}

/**
 * An invite mined before this account landed on this device is history, so its group doesn't show
 * as unread; one mined after is genuinely new (iOS 7916f5cd seedImportReadMarker). Times in
 * milliseconds; an account with no import time, or an invite with no time, is left as it is.
 */
export function rediscoveredGroupIsRead({ inviteAtMs, importedAtMs }) {
  const invite = Number(inviteAtMs) || 0;
  const imported = Number(importedAtMs) || 0;
  return invite > 0 && imported > 0 && invite < imported;
}

/** Import's Paste, when some of the pasted words aren't recovery words: only how many, never which,
 *  so a message on screen never repeats what was pasted (iOS 3942a5b7 pasteSeedPhrase). */
export function pastedWordsInvalidMessage(count) {
  const n = Math.max(1, Math.floor(Number(count) || 0));
  return n === 1
    ? "One of the pasted words isn't a valid word. Check your copy and try again."
    : `${n} of the pasted words aren't valid words. Check your copy and try again.`;
}
