// What an import works out before and after it lands, without a DOM, for
// tools/test-account-import.mjs.

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
 * Import's search (iOS da467165 WalletManager.findImportAccounts): of every wallet type's addresses,
 * the ones with funds, plus any with transaction history (a chat identity or an emptied wallet holds
 * no coins). The wallet type holding the most comes first, each type's addresses in index order, so
 * the first entry is the likeliest account. Ties go to the earlier type in `familyOrder`, so the
 * standard wallet wins when nothing tells them apart. Empty when nothing has any activity.
 * @param {{ family: string, index: number, address: string }[]} candidates
 * @param {Map<string, number>} balanceByAddress in sompi
 * @param {Set<string>} withHistory addresses with at least one transaction
 * @param {string[]} familyOrder
 */
export function rankImportAccounts(candidates, balanceByAddress, withHistory, familyOrder) {
  const totals = new Map();
  const active = [];
  for (const { family, index, address } of candidates) {
    const sompi = Math.max(0, Number(balanceByAddress.get(address)) || 0);
    const hasHistory = withHistory.has(address);
    if (sompi <= 0 && !hasHistory) continue;
    totals.set(family, (totals.get(family) || 0) + sompi);
    active.push({ family, index, address, sompi, hasHistory });
  }
  const rank = (family) => { const at = familyOrder.indexOf(family); return at < 0 ? familyOrder.length : at; };
  return active.sort((lhs, rhs) => {
    if (lhs.family === rhs.family) return lhs.index - rhs.index;
    const left = totals.get(lhs.family) || 0;
    const right = totals.get(rhs.family) || 0;
    if (left !== right) return right - left;
    return rank(lhs.family) - rank(rhs.family);
  });
}

/** Which wallet type and address an entry is, for comparing a pick (iOS ImportAccountChoice). */
export function importChoiceKey({ family = "kaspaStandard", index = 0 } = {}) {
  return `${family}-${Math.max(0, Math.floor(Number(index) || 0))}`;
}

/** The rows the found list shows: what the search found, then, once See Every Wallet Type is
 *  open, each type's address #0 that isn't already there (iOS visibleAddressRows). */
export function visibleImportRows(found, everyWalletType, showsEveryWalletType) {
  if (!showsEveryWalletType) return found;
  const seen = new Set(found.map(importChoiceKey));
  return [...found, ...everyWalletType.filter((entry) => !seen.has(importChoiceKey(entry)))];
}

/** The line under the balance on import (iOS fundsHint): what this address suggests. */
export function importFundsHint({ sompi, hasHistory, passphrase }) {
  if (sompi > 0) return { tone: "funds", text: "This address holds funds, so this looks like the right account." };
  if (hasHistory) return { tone: "funds", text: "This address has history, so this looks like the right account." };
  if (!passphrase) return { tone: "muted", text: "No funds or history on this address." };
  return { tone: "warn", text: "No funds on this address. If you expected funds here, check your passphrase." };
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
