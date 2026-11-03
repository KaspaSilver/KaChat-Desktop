// What an import works out before and after it lands, without a DOM, for
// tools/test-account-import.mjs.

/** The same depth as one page of the chatting address picker (iOS 836b62bc
 *  PassphraseAddressPreview.searchDepth). */
export const IMPORT_ADDRESS_SEARCH_DEPTH = 50;

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
