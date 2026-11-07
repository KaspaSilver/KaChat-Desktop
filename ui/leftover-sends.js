// Sends left pending by a run that ended (iOS fdb32549, MESSAGING.md "When a send's outcome isn't
// known"). A closed tab takes the send's work with it, so its bubble would stay on Sending for good.
// After the account's first look at that chat this run, a delivered copy replaces the row and
// anything left is marked failed so Retry appears (room rows: "Not confirmed", iOS 33095ac). A copy
// delivered later still replaces it. No DOM,
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

// A room's delivered copy may carry a block time a little before the pending row's clock time.
const ROOM_COPY_SLACK_MS = 300_000;

/** A room send whose outcome is unknown (iOS 33095ac): it may have landed, so it shows "Not
 *  confirmed" with no Retry, which could post and pay twice. */
export const ROOM_UNCONFIRMED = "unconfirmed";
const ROOM_PENDING_ID = /^pending-/;

/** Room rows still "pending" that no send of this run is working on (`keeping` holds the pending
 *  ids this run started), and "Not confirmed" rows from earlier runs whose id never became a
 *  transaction's: one whose delivered copy is here (same sender and content, sent, block time at
 *  most five minutes before the row's) goes. The rest may have landed while the app was closed, so
 *  they show "Not confirmed" rather than a Retry that could pay twice (iOS 33095ac
 *  PublicChatStore.settlePendingMessages). Changes `messages` in place and returns how many rows
 *  changed. */
export function settleLeftoverRoomRows(messages, { keeping = new Set() } = {}) {
  let changed = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    const row = messages[index];
    const leftover = row?.status === "pending"
      || (row?.status === ROOM_UNCONFIRMED && ROOM_PENDING_ID.test(String(row.txId || "")));
    if (!leftover || keeping.has(row.txId)) continue;
    const delivered = messages.some((other) => other !== row && !other.status
      && other.senderAddress === row.senderAddress
      && String(other.content ?? "") === String(row.content ?? "")
      && Number(other.blockTime || 0) >= Number(row.blockTime || 0) - ROOM_COPY_SLACK_MS);
    if (delivered) {
      messages.splice(index, 1);
      changed += 1;
    } else if (row.status !== ROOM_UNCONFIRMED) {
      row.status = ROOM_UNCONFIRMED;
      changed += 1;
    }
  }
  return changed;
}

/** A room send that ended in an unknown outcome (iOS 33095ac PublicChatStore.markMessageUnconfirmed):
 *  the row takes the transaction's id, so its delivered copy settles it (settleRoomCopy), and is
 *  "Not confirmed". A copy already here means it landed: the row goes. Without a txid the row keeps
 *  its pending id (settleLeftoverRoomRows matches it by content). Returns the list to store. */
export function markRoomRowUnconfirmed(messages, pendingId, txid) {
  const list = Array.isArray(messages) ? messages : [];
  const id = String(txid || "").trim().toLowerCase();
  const real = /^[0-9a-f]{64}$/.test(id) ? id : null;
  if (real && list.some((m) => m.txId === real && m.txId !== pendingId)) return list.filter((m) => m.txId !== pendingId);
  return list.map((m) => (m.txId === pendingId ? { ...m, txId: real || m.txId, status: ROOM_UNCONFIRMED } : m));
}

/** A delivered room row whose id is already stored: a "Not confirmed" row with that id did go out,
 *  so it turns sent with the chain's time (iOS 33095ac PublicChatStore.insertMessages). Returns
 *  whether a row changed. */
export function settleRoomCopy(messages, txId, blockTime) {
  const row = (messages || []).find((m) => m.txId === txId && m.status === ROOM_UNCONFIRMED);
  if (!row) return false;
  delete row.status;
  if (Number(blockTime) > 0) row.blockTime = Number(blockTime);
  return true;
}
