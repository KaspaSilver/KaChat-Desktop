// Placeholder bodies a 1:1 chat never shows (iOS ChatMessage.isSentPlaceholder / isHiddenPlaceholder,
// c130dc1). Records that carry them stay in the store - a later copy with real text (an archive
// restore, a successful decrypt) replaces the body and the message appears - but they are hidden
// from the thread, the chat-list preview and search, and never notify or count as unread.

/** An outgoing message sent from another device whose text never reached this one. */
export const SENT_PLACEHOLDER = "📤 Sent via another device";

/** A message this account could not decrypt - typically one encrypted for another account that
 *  reached this contact's chat through an account mix-up (iOS ChatMessage.unreadablePlaceholder).
 *  Desktop's own sync drops undecryptable rows; this body arrives from another device's archive. */
export const UNREADABLE_PLACEHOLDER = "[Encrypted message]";

export function isSentPlaceholder(text) {
  return String(text ?? "") === SENT_PLACEHOLDER;
}

/** Placeholders the app never shows: cross-device sends and undecryptable messages. */
export function isHiddenPlaceholder(text) {
  const value = String(text ?? "");
  return value === SENT_PLACEHOLDER || value === UNREADABLE_PLACEHOLDER;
}

/** A message record (desktop shape, `text`) whose body is a hidden placeholder. */
export function isHiddenPlaceholderMessage(message) {
  return Boolean(message) && isHiddenPlaceholder(message.text);
}

/** The newest message the chat list may preview: the maximum `createdAt`, first among equals,
 *  skipping hidden placeholders (iOS Conversation.newestRealMessage). */
export function newestVisibleMessage(messages) {
  let newest = null;
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || isHiddenPlaceholderMessage(message)) continue;
    if (newest && Number(message.createdAt || 0) <= Number(newest.createdAt || 0)) continue;
    newest = message;
  }
  return newest;
}

/** Whether `incoming` (a fetched copy with real text) should replace the body of `existing`, a
 *  stored record of the same transaction that only holds a placeholder (iOS preferMessage: real
 *  content beats a placeholder). */
export function upgradesPlaceholder(existing, incoming) {
  if (!existing || !incoming) return false;
  if (!isHiddenPlaceholderMessage(existing)) return false;
  const text = String(incoming.text ?? "");
  return text.trim().length > 0 && !isHiddenPlaceholder(text);
}
