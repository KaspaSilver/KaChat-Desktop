// A conversation that was showing its newest message keeps showing it when its height changes.
//
// Tapping the composer on a phone brings up the keyboard, and the message list gets shorter by the
// keyboard's height. A scroller keeps its scrollTop when it shrinks, so the newest messages slid
// down out of sight behind the composer. Here every message list remembers whether it was at the
// bottom, and when its size changes while it was, it goes back to the bottom - as iOS Messages
// does. Someone scrolled up reading older messages is left where they are.

const SCROLLERS = "[data-message-area], [data-group-message-area], [data-broadcast-room-body]";
const AT_BOTTOM_PX = 80;

const atBottom = new WeakMap();
const lastHeight = new WeakMap();

function measure(el) {
  atBottom.set(el, el.scrollHeight - el.scrollTop - el.clientHeight < AT_BOTTOM_PX);
}

const resized = typeof ResizeObserver === "function"
  ? new ResizeObserver((entries) => {
    for (const { target } of entries) {
      const before = lastHeight.get(target) || 0;
      const now = target.clientHeight;
      lastHeight.set(target, now);
      // Only a list that was already on screen and changed size: a chat being opened (hidden, so
      // 0 tall, until now) is scrolled by the app itself, maybe to its first unread message.
      if (before > 0 && now > 0 && now !== before && atBottom.get(target)) target.scrollTop = target.scrollHeight;
      measure(target);
    }
  })
  : null;

function watch() {
  if (!resized) return;
  for (const el of document.querySelectorAll(SCROLLERS)) {
    if (atBottom.has(el)) continue;
    measure(el);
    lastHeight.set(el, el.clientHeight);
    el.addEventListener("scroll", () => measure(el), { passive: true });
    resized.observe(el);
  }
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", watch, { once: true });
else watch();
