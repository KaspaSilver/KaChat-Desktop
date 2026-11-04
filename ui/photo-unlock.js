// When photos from someone start to show (iOS d1844582 ContactsManager.photosUnlockDate), without a
// DOM, for tools/test-photo-unlock.mjs.

/** Ten minutes (iOS photoUnlockDelay). */
export const PHOTO_UNLOCK_DELAY_MS = 600_000;

// Everything before a message has gone out reads as iOS's .pending.
const NOT_SENT = new Set(["failed", "draft", "building", "signing", "broadcasting", "pending"]);

/**
 * The later of your first and their first message, plus ten minutes. Null until both of you have
 * sent one. Handshakes, failed messages and ones still going out don't count.
 * @param {{ direction: string, messageType?: string|null, status?: string, createdAt: number }[]} messages
 */
export function photosUnlockTime(messages) {
  let firstOutgoing = Infinity;
  let firstIncoming = Infinity;
  for (const message of messages || []) {
    if (message?.messageType === "handshake" || NOT_SENT.has(message?.status)) continue;
    const at = Number(message?.createdAt);
    if (!Number.isFinite(at) || at <= 0) continue;
    if (message.direction === "incoming") firstIncoming = Math.min(firstIncoming, at);
    else firstOutgoing = Math.min(firstOutgoing, at);
  }
  if (firstOutgoing === Infinity || firstIncoming === Infinity) return null;
  return Math.max(firstOutgoing, firstIncoming) + PHOTO_UNLOCK_DELAY_MS;
}

/** Hidden while the date is unknown or still ahead (iOS incomingPhotosBlocked). */
export function photosAreHidden(unlockAt, now = Date.now()) {
  return unlockAt == null || now < unlockAt;
}
