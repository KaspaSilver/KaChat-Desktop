// KaPosts work that waits - the 5 s undo hold, a thread's segment chain, a scheduled post being
// built - and the account it belongs to (iOS dfaba68 / c130dc1 isActiveWallet, stillSameAccount).
//
// Creating or importing an account switches accounts in place, without a page reload, and every
// on-chain write signs with whatever key deps.engine holds at that moment. A like held for five
// seconds under one account must never go out signed by the next one, so held work captures its
// owner when it is armed and drops itself if the active account is someone else by the time it
// would run. Pure helpers, so tools/test-kaposts-held.mjs can drive them without a DOM.

import { accountGuard } from "./account-guard.js";

/**
 * Wraps a held action so it runs only for the account that armed it. The owner is captured NOW
 * (when the hold starts); the returned function re-reads the active account when the countdown
 * runs out and, if it changed, calls `onDropped(owner)` instead of the action. Held work armed
 * with no account at all never runs.
 *
 * @param {() => any} action
 * @param {() => string | null | undefined} readActiveAddress e.g. `() => deps.engine.address`
 * @param {(owner: string) => void} [onDropped]
 */
export function kapostsOwnedAction(action, readActiveAddress, onDropped = null) {
  const guard = accountGuard(readActiveAddress);
  return () => {
    if (!guard.still()) {
      onDropped?.(guard.account);
      return undefined;
    }
    return action();
  };
}

/**
 * Drops every held action without running it or its Undo - the account switch. Undo is NOT run
 * on purpose: a held post's or reply's Undo reopens the composer with the words in it, which would
 * put the previous account's draft in front of the new one, and the posts it would touch are
 * about to be cleared with the old account's lists anyway. Returns how many were dropped.
 *
 * @param {Map<string, { timer?: any }>} pending key -> { timer, ... }
 * @param {(timer: any) => void} [clearTimer]
 */
export function dropKaPostsHeldActions(pending, clearTimer = clearTimeout) {
  if (!pending || typeof pending.values !== "function") return 0;
  let dropped = 0;
  for (const entry of pending.values()) {
    if (entry?.timer != null) clearTimer(entry.timer);
    dropped += 1;
  }
  pending.clear();
  return dropped;
}

/**
 * Whether a post can be answered on chain. A reply's payload names its parent by txid, so a post
 * that is still pending, failed or not confirmed (no remoteId yet) has nothing to reply TO: sent
 * anyway, the reply goes out with an empty parent - the fee is paid and the reply lands nowhere.
 */
export function kapostsCanReplyTo(post) {
  return String(post?.remoteId ?? "").trim() !== "";
}

export const KAPOSTS_ACCOUNT_CHANGED = "KAPOSTS_ACCOUNT_CHANGED";

/**
 * The error a thread chain stops with when the account changed between segments. `noRetry` keeps
 * kapostsSubmitWithUtxoRetry from trying again (each try would re-check and fail the same way).
 */
export function kapostsAccountChangedError() {
  const error = new Error("The account changed before this could be posted.");
  error.code = KAPOSTS_ACCOUNT_CHANGED;
  error.noRetry = true;
  return error;
}

/** What the reply guards say when the parent is not on the network yet. */
export const KAPOSTS_REPLY_NOT_ON_NETWORK = "The post you're replying to isn't on the network yet. Try again once it has posted.";
