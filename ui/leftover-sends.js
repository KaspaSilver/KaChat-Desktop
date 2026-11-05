// Sends left pending by a run that ended (iOS fdb32549, MESSAGING.md "When a send's outcome isn't
// known"). A closed tab takes the send's work with it, so its bubble would stay on Sending for good.
// After the account's first look at that chat this run, a delivered copy replaces the row and
// anything left is marked failed so Retry appears. A copy delivered later still replaces it. No DOM,
// so tools/test-leftover-sends.mjs runs it under node.

export const RUN_STARTED_AT = Date.now();

// A delivered copy's time comes from the chain and a row's from this device's clock.
const CLOCK_SLACK_MS = 10 * 60 * 1000;
const FAILED = "failed";
const SENT_STATUSES = new Set(["confirmed", "broadcast"]);

/** A row that was still being sent when its run ended: nothing is working on it now. */
export function isLeftoverSend(message, { idOf = (m) => m.txid, runStartedAt = RUN_STARTED_AT } = {}) {
  if (!message || idOf(message) || message.status === FAILED || SENT_STATUSES.has(message.status)) return false;
  return Number(message.createdAt || 0) < runStartedAt;
}

/** The oldest row a delivered copy stands for: unsent or failed, with the same text, not newer. */
export function undeliveredRowFor(messages, delivered, { idOf = (m) => m.txid, mine = (m) => m.direction === "outgoing", runStartedAt = RUN_STARTED_AT } = {}) {
  const text = String(delivered?.text ?? "");
  if (!text) return null;
  const deliveredAt = Number(delivered.createdAt || 0);
  let found = null;
  for (const row of messages || []) {
    if (row === delivered || !mine(row) || idOf(row) || String(row.text ?? "") !== text) continue;
    if (row.status !== FAILED && !isLeftoverSend(row, { idOf, runStartedAt })) continue;
    if (deliveredAt && Number(row.createdAt || 0) > deliveredAt + CLOCK_SLACK_MS) continue;
    if (!found || Number(row.createdAt || 0) < Number(found.createdAt || 0)) found = row;
  }
  return found;
}

/** Group rows: those with a delivered copy go, and the rest are marked failed. Changes `messages`
 *  in place and returns how many rows changed. */
export function settleLeftoverGroupRows(messages, { mine, runStartedAt = RUN_STARTED_AT } = {}) {
  const idOf = (m) => m.txId;
  let changed = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    const row = messages[index];
    if (!mine(row) || !isLeftoverSend(row, { idOf, runStartedAt })) continue;
    const delivered = messages.some((other) => other !== row && mine(other) && other.txId && String(other.text ?? "") === String(row.text ?? "")
      && Number(other.createdAt || 0) + CLOCK_SLACK_MS >= Number(row.createdAt || 0));
    if (delivered) messages.splice(index, 1);
    else row.status = FAILED;
    changed += 1;
  }
  return changed;
}
