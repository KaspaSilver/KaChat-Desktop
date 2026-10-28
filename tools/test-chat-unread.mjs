// node tools/test-chat-unread.mjs - the Chats dock tab's unread count (ui/chat-unread.js; iOS
// 64d63846 AppTabBadge, KaPosts-iPhone eec2e30 PublicChatUnreadBadge).
import assert from "node:assert/strict";
import { chatListUnreadCount, chatsTabUnreadCount, debouncedCountPublisher } from "../ui/chat-unread.js";

// The chats the list shows: a Message Request, a blocked or a declined chat never counts.
{
  const conversations = [
    { id: "a", unreadCount: 3 },
    { id: "request", unreadCount: 5 },
    { id: "blocked", unreadCount: 2 },
    { id: "b", unreadCount: 0 },
    { id: "c", unreadCount: -4 }, // never below zero
    { id: "d", unreadCount: "2" },
    { id: "e" },
  ];
  const hidden = new Set(["request", "blocked"]);
  assert.equal(chatListUnreadCount(conversations, (c) => !hidden.has(c.id)), 5);
  assert.equal(chatListUnreadCount(conversations, () => false), 0);
  assert.equal(chatListUnreadCount(null, () => true), 0);
}

// Chats + groups (iOS's Chats and Groups tabs) + rooms (KaPost's Public Chats tab), on one tab.
assert.equal(chatsTabUnreadCount({ chats: 2, groups: 3, rooms: 4 }), 9);
assert.equal(chatsTabUnreadCount({ chats: 2 }), 2, "Simple Mode: no rooms");
assert.equal(chatsTabUnreadCount({ chats: -1, groups: NaN, rooms: 1.5 }), 1);
assert.equal(chatsTabUnreadCount(), 0);
console.log("chat unread: counts ok");

// Recounted after the changes stop, published only when the number moves.
{
  let now = 0;
  const timers = new Map();
  let nextId = 1;
  const setTimer = (fn, ms) => { const id = nextId++; timers.set(id, { fn, at: now + ms }); return id; };
  const clearTimer = (id) => timers.delete(id);
  const advance = (ms) => {
    now += ms;
    for (const [id, t] of [...timers]) if (t.at <= now) { timers.delete(id); t.fn(); }
  };
  let count = 1;
  let reads = 0;
  const published = [];
  const schedule = debouncedCountPublisher({
    read: () => { reads += 1; return count; },
    publish: (n) => published.push(n),
    delayMs: 300, setTimer, clearTimer,
  });

  schedule(); advance(100); schedule(); advance(100); schedule();
  advance(299);
  assert.equal(reads, 0, "a burst waits for quiet");
  advance(1);
  assert.deepEqual(published, [1]);
  assert.equal(reads, 1, "one recount for the burst");

  schedule(); advance(300);
  assert.deepEqual(published, [1], "the same number isn't published again");
  count = 4;
  schedule(); advance(300);
  assert.deepEqual(published, [1, 4]);
  count = 0;
  schedule(); advance(300);
  assert.deepEqual(published, [1, 4, 0], "back to zero takes the badge off");

  // A publish that throws (the page not ready yet) is tried again on the next change.
  let ready = false;
  const shown = [];
  const late = debouncedCountPublisher({
    read: () => 7,
    publish: (n) => { if (!ready) throw new Error("not yet"); shown.push(n); },
    delayMs: 300, setTimer, clearTimer,
  });
  late(); advance(300);
  assert.deepEqual(shown, []);
  ready = true;
  late(); advance(300);
  assert.deepEqual(shown, [7]);

  // A read that throws publishes nothing.
  const broken = debouncedCountPublisher({ read: () => { throw new Error("no"); }, publish: () => assert.fail("published"), delayMs: 300, setTimer, clearTimer });
  broken(); advance(300);
}
console.log("chat unread: debounce ok");
