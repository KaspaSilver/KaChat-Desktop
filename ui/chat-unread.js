// The Chats dock tab's unread count (KaChat-iPhone 64d63846 AppTabBadge, KaPosts-iPhone eec2e30
// PublicChatUnreadBadge). iOS badges Chats, Groups and KaPost's Public Chats separately; Desktop
// has one Chats screen holding all three (groups and rooms are the circles above the chats), so its
// dock tab carries their sum. No DOM in here, so tools/test-chat-unread.mjs runs it under node.

/** Unread messages across the chats the Chats list shows (iOS ChatService.chatListUnreadCount).
 *  `isListed(conversation)` is iOS's isConversationVisibleInChatList: Message Requests, blocked and
 *  declined chats don't count, so an unaccepted sender can't keep ringing the badge. */
export function chatListUnreadCount(conversations, isListed) {
  let total = 0;
  for (const conversation of Array.isArray(conversations) ? conversations : []) {
    if (!isListed(conversation)) continue;
    total += Math.max(0, Number(conversation?.unreadCount) || 0);
  }
  return total;
}

/** The Chats tab's count: the 1:1 chats (iOS 64d63846's Chats), the group chats (its Groups tab,
 *  which Desktop doesn't have) and the public rooms (KaPost's Public Chats tab, eec2e30), each
 *  never below zero. */
export function chatsTabUnreadCount({ chats = 0, groups = 0, rooms = 0 } = {}) {
  const part = (n) => Math.max(0, Math.floor(Number(n) || 0));
  return part(chats) + part(groups) + part(rooms);
}

/**
 * Recounts `delayMs` after the last call and publishes only when the number changed (iOS
 * PublicChatUnreadBadge: a 300 ms debounce on the rooms' changes, `if total != count`), so a burst
 * of messages redraws the dock once. Returns the function to call whenever something that moves the
 * count changed. A `publish` that throws (the page not ready yet) leaves the number unrecorded, so
 * the next recount tries again. Timers are injectable for the test.
 */
export function debouncedCountPublisher({ read, publish, delayMs = 300, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let timer = null;
  let published = null;
  return function schedule() {
    if (timer !== null) clearTimer(timer);
    timer = setTimer(() => {
      timer = null;
      let count = 0;
      try { count = read(); } catch { return; }
      if (count === published) return;
      try { publish(count); published = count; } catch { /* the next change tries again */ }
    }, delayMs);
  };
}
