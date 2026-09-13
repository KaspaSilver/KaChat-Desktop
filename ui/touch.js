// Touch equivalents of desktop gestures. iOS Safari never fires `contextmenu` for a long-press
// (it shows its own callout for links and images, and nothing at all for anything else), so every
// right-click menu in the app - message bubbles, chat rows, broadcast rooms - gets a long-press
// path through here, the way the iOS app opens those same menus.

const LONG_PRESS_MS = 420;
const MOVE_TOLERANCE_PX = 10;

function swallowRelease() {
  const types = ["mousedown", "mouseup", "click"];
  const stop = (event) => { event.preventDefault(); event.stopImmediatePropagation(); };
  for (const type of types) document.addEventListener(type, stop, true);
  const done = () => { for (const type of types) document.removeEventListener(type, stop, true); };
  // Compatibility mouse events arrive right after pointerup; a second pointer means a real tap.
  document.addEventListener("pointerup", () => window.setTimeout(done, 80), { once: true, capture: true });
  window.setTimeout(done, 1500);
}

export const isTouchDevice = () => window.matchMedia("(hover: none) and (pointer: coarse)").matches;

/**
 * Long-press on `el` (or, with `selector`, on a matching descendant - for lists that delegate)
 * calls `onLongPress` with an object shaped like the contextmenu event the desktop handler
 * already takes: clientX, clientY, target, preventDefault(). The click that would follow the
 * release is swallowed so a long-press never ALSO opens the row/bubble it was held on.
 */
export function attachLongPress(el, onLongPress, { selector = null } = {}) {
  if (!el) return () => {};
  let timer = 0;
  let startX = 0;
  let startY = 0;
  let fired = false;
  let pointerId = null;

  const clear = () => {
    if (timer) window.clearTimeout(timer);
    timer = 0;
    pointerId = null;
  };
  const onPointerDown = (event) => {
    if (event.pointerType !== "touch" && event.pointerType !== "pen") return;
    if (!event.isPrimary) return;
    const target = selector ? event.target.closest(selector) : event.target;
    if (!target || !el.contains(target)) return;
    // Controls inside the held element have their own taps; a long-press on a button is still
    // a long-press on the bubble, but not on a text field or a link (those keep Safari's own).
    if (event.target.closest("input, textarea, select, a[href]")) return;
    clear();
    fired = false;
    pointerId = event.pointerId;
    startX = event.clientX;
    startY = event.clientY;
    timer = window.setTimeout(() => {
      timer = 0;
      fired = true;
      try { navigator.vibrate?.(10); } catch { /* no haptics */ }
      // Releasing the finger can still produce the compatibility mousedown/click at the release
      // point, which is the held element - outside the menu that just opened, so the menu's
      // outside-tap closer would shut it at once. Swallow that one release.
      swallowRelease();
      onLongPress({
        clientX: startX,
        clientY: startY,
        target,
        pointerType: event.pointerType,
        preventDefault() {},
        stopPropagation() {},
      });
    }, LONG_PRESS_MS);
  };
  const onPointerMove = (event) => {
    if (event.pointerId !== pointerId || !timer) return;
    if (Math.abs(event.clientX - startX) > MOVE_TOLERANCE_PX || Math.abs(event.clientY - startY) > MOVE_TOLERANCE_PX) clear();
  };
  const onPointerEnd = (event) => {
    if (event.pointerId !== pointerId) return;
    clear();
  };
  // The click after a fired long-press belongs to the menu, not to the row underneath.
  const onClick = (event) => {
    if (!fired) return;
    fired = false;
    event.preventDefault();
    event.stopPropagation();
  };
  el.addEventListener("pointerdown", onPointerDown, { passive: true });
  el.addEventListener("pointermove", onPointerMove, { passive: true });
  el.addEventListener("pointerup", onPointerEnd, { passive: true });
  el.addEventListener("pointercancel", onPointerEnd, { passive: true });
  el.addEventListener("click", onClick, true);
  // Some engines still raise contextmenu on a long-press; the desktop handler covers it. Keep
  // the two from both firing: a fired long-press swallows the contextmenu that follows.
  el.addEventListener("contextmenu", (event) => { if (fired) { event.preventDefault(); event.stopImmediatePropagation(); } }, true);
  return () => {
    clear();
    el.removeEventListener("pointerdown", onPointerDown);
    el.removeEventListener("pointermove", onPointerMove);
    el.removeEventListener("pointerup", onPointerEnd);
    el.removeEventListener("pointercancel", onPointerEnd);
    el.removeEventListener("click", onClick, true);
  };
}

/**
 * Wires both gestures at once: right-click on a desktop, long-press on touch, one handler.
 */
export function onContextGesture(el, handler, options) {
  if (!el) return;
  el.addEventListener("contextmenu", handler);
  attachLongPress(el, handler, options);
}

/**
 * Double-tap on touch, calling `handler` with a contextmenu-shaped event (clientX/Y, target,
 * preventDefault). iPhone Safari does not raise `dblclick` for two taps on an ordinary element,
 * so the desktop double-click (quick reactions on a bubble) needs this to exist on a phone.
 */
export function attachDoubleTap(el, handler) {
  if (!el) return;
  let lastTap = 0;
  let lastX = 0;
  let lastY = 0;
  el.addEventListener("pointerup", (event) => {
    if (event.pointerType !== "touch" && event.pointerType !== "pen") return;
    const now = performance.now();
    const near = Math.abs(event.clientX - lastX) < 24 && Math.abs(event.clientY - lastY) < 24;
    if (now - lastTap < 320 && near) {
      lastTap = 0;
      handler({ clientX: event.clientX, clientY: event.clientY, target: event.target, pointerType: event.pointerType, preventDefault() {}, stopPropagation() {} });
      return;
    }
    lastTap = now;
    lastX = event.clientX;
    lastY = event.clientY;
  }, { passive: true });
}

/** Double-click on a desktop, double-tap on touch, one handler. */
export function onDoubleGesture(el, handler) {
  if (!el) return;
  el.addEventListener("dblclick", handler);
  attachDoubleTap(el, handler);
}
