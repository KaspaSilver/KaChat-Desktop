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
