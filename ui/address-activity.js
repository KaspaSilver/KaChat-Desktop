// Address Activity, the chatting address's rules (iOS 56b75c8, AddressActivityNotifier). Pure, so
// tools/test-address-activity.mjs can run them without the app.
//
// The chatting address notifies only for a plain transfer: a transaction with a payload (a KaChat
// chat payment, a message, a handshake) is the chat's own news and stays quiet. Its catch-up only
// counts plain transfers newer than its last look (the floor), never a burst of old payments.

/** A transaction with no payload: plain KAS, not a KaChat chat payment, message or handshake
 *  (iOS isPlainTransfer). The REST API sends the payload as hex, "" or null when there is none. */
export function isPlainTransferTx(tx) {
  return !String(tx?.payload ?? "").trim();
}

/** A REST transaction's block time in ms, 0 when unknown. */
export function txBlockTimeMs(tx) {
  const value = Number(tx?.block_time ?? tx?.blockTime ?? 0);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/** One catch-up look at the chatting address: `floor` is the newest block time (ms) already looked
 *  at (0 = never). Gives the floor to store (the newest fetched block time, or `nowMs` when none
 *  has one, never below `floor`), whether this is the first look (it only sets where it starts),
 *  and which txs count: plain transfers newer than `floor`. */
export function chattingCatchUpLook(txs, floor, nowMs) {
  const list = Array.isArray(txs) ? txs : [];
  const previous = Number(floor) > 0 ? Number(floor) : 0;
  const times = list.map(txBlockTimeMs).filter((time) => time > 0);
  const newest = times.length ? Math.max(...times) : Number(nowMs) || 0;
  return {
    nextFloor: Math.max(newest, previous),
    firstLook: previous === 0,
    counted: previous === 0 ? [] : list.filter((tx) => isPlainTransferTx(tx) && txBlockTimeMs(tx) > previous),
  };
}
