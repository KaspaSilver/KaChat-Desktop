// Account guards for async work (iOS dfaba68 / c130dc1 isActiveWallet, stillSameAccount).
//
// Creating or importing an account while signed in switches accounts in place, without a page
// reload, so a sync, a stash or a balance read that started for the previous account can finish
// after the switch. Whatever it learned belongs to that account: written into the new one's chats,
// cursors, aliases or balances it leaks across. Each such task takes a guard when it starts and
// re-checks it after every await before it writes anything.

/**
 * @param {() => string | null | undefined} readActiveAddress the active account's address, read
 *   fresh on every check (e.g. `() => engine.address`)
 * @returns {{ account: string, still: () => boolean }} `still()` is true while the account the task
 *   started for is still the active one; never true for a task started with no account
 */
export function accountGuard(readActiveAddress) {
  const read = () => String((typeof readActiveAddress === "function" ? readActiveAddress() : "") || "").trim();
  const account = read();
  return { account, still: () => account !== "" && read() === account };
}

/**
 * A value read for one account, readable only while that account is active: after a switch it
 * reads as `fallback` (a dash on screen until the new account's own figure lands), never as the
 * previous account's number.
 */
export function accountScopedValue(readActiveAddress, fallback = null) {
  let account = "";
  let value = fallback;
  const active = () => String((typeof readActiveAddress === "function" ? readActiveAddress() : "") || "").trim();
  return {
    get() { return account !== "" && account === active() ? value : fallback; },
    /** Stores `next` for `forAccount` (the account the read started for), only if it is still active. */
    set(next, forAccount = active()) {
      const owner = String(forAccount || "").trim();
      if (!owner || owner !== active()) return false;
      account = owner;
      value = next;
      return true;
    },
    clear() { account = ""; value = fallback; },
  };
}

/**
 * Whether an account a task captured at its start is still on this device (iOS e571f45 / 6891935
 * accountStillSaved, IOS-107 / IOS-109): the active account, or one of the saved ones. Work that
 * keeps writing to the account it started for (the Discover sweep, the fresh quantum slot probe)
 * drops its results only once this is false - a mere switch is not a reason. Desktop also drops
 * them while that account's keys are locked in the key vault (its saved record reads `locked`).
 *
 * @param {string} owner the captured account's address
 * @param {{ activeAddress?: string, savedAccounts?: Array<{ address?: string, locked?: boolean }> }} where
 */
export function accountStillSaved(owner, { activeAddress = "", savedAccounts = [] } = {}) {
  const clean = String(owner || "").trim();
  if (!clean) return false;
  const record = (Array.isArray(savedAccounts) ? savedAccounts : [])
    .find((entry) => String(entry?.address || "").trim() === clean);
  if (record?.locked) return false;
  return String(activeAddress || "").trim() === clean || Boolean(record);
}
