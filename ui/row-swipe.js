// Chat rows swipe instead of hold (KaChat-iPhone d063b897 ChatListView swipeActions): left for
// Delete, Silence and Pin, right for Mark as Read or Unread. Touch only: a mouse has no swipe and
// keeps the right-click half sheet.
//
// The rows can't hold the action buttons (a row is a <button>) and the list redraws its rows all
// the time (a message arriving, a name resolving), so nothing here lives in a row. The buttons are
// one layer in the list, over the strip the row has slid away from, and refresh() puts both back
// after a redraw. The row's `touch-action: pan-y` (ui/styles.css) is what keeps this from fighting
// the list's scroll: a vertical drag is the browser's and ends here in a pointercancel.

const LOCK_PX = 10;            // how far a finger moves before it is a swipe or a scroll
const ACTION_WIDTH = 74;       // one of Delete / Silence / Pin
const LEADING_WIDTH = 96;      // Mark as Unread, which is a longer word
const FULL_SWIPE_RATIO = 0.6;  // of the row: letting go past this runs the right swipe's action
const FLING_PX_PER_MS = 0.45;
const OVERDRAG = 0.25;         // left has no full swipe, so past its buttons the row only gives a little
const SETTLE_MS = 220;

/** What a chat row's swipes offer. `left` is in iOS's order, first nearest the screen's edge, so
 *  Delete sits at the far right; your own chat has only Silence (it can't be deleted, and it is
 *  already first in the list). `right` follows the unread state. */
export function chatRowSwipeActions({ isSelf = false, unread = 0, isSilent = false, isPinned = false } = {}) {
  const silence = isSilent
    ? { id: "silence", title: "Unsilence", icon: "bell", tint: "orange" }
    : { id: "silence", title: "Silence", icon: "bellSlash", tint: "orange" };
  const pin = isPinned
    ? { id: "pin", title: "Unpin", icon: "unpin", tint: "accent" }
    : { id: "pin", title: "Pin", icon: "pin", tint: "accent" };
  return {
    left: isSelf ? [silence] : [{ id: "delete", title: "Delete", icon: "trash", tint: "red" }, silence, pin],
    right: [unread > 0
      ? { id: "read", title: "Mark as Read", icon: "envelopeOpen", tint: "accent" }
      : { id: "unread", title: "Mark as Unread", icon: "envelopeBadge", tint: "accent" }],
  };
}

/** The buttons' full width on each side. */
export function rowSwipeWidths({ left = [], right = [] } = {}) {
  return { leftWidth: left.length * ACTION_WIDTH, rightWidth: right.length * LEADING_WIDTH };
}

/** Which way a drag is going: null until it has moved far enough. A tie is a scroll, since the list
 *  scrolling is the commoner thing and a swipe can simply start again. */
export function rowSwipeAxis(dx, dy) {
  const x = Math.abs(dx);
  const y = Math.abs(dy);
  if (x < LOCK_PX && y < LOCK_PX) return null;
  return x > y ? "x" : "y";
}

/** Where the row sits for a finger at `offset`: left stops giving past its buttons, right runs on
 *  to the row's edge for the full swipe. */
export function clampRowSwipe(offset, { leftWidth = 0, rightWidth = 0, rowWidth = 0 } = {}) {
  if (offset < 0) {
    if (!leftWidth) return 0;
    return offset < -leftWidth ? -leftWidth + (offset + leftWidth) * OVERDRAG : offset;
  }
  if (!rightWidth) return 0;
  return Math.min(offset, rowWidth || offset);
}

/** Whether letting go here has passed the point where the right swipe's action runs. */
export function isFullRowSwipe(offset, { rightWidth = 0, rowWidth = 0 } = {}) {
  return rightWidth > 0 && rowWidth > 0 && offset >= rowWidth * FULL_SWIPE_RATIO;
}

/** Where a row goes when the finger lifts: "closed", "left" or "right" (open on that side), or
 *  "full" (a long right swipe runs its action; a left swipe has no full swipe, as on iOS, so a long
 *  swipe can't start a delete). `velocity` is px/ms, positive to the right. */
export function settleRowSwipe({ offset = 0, velocity = 0, leftWidth = 0, rightWidth = 0, rowWidth = 0 } = {}) {
  if (offset > 0) {
    if (isFullRowSwipe(offset, { rightWidth, rowWidth })) return "full";
    if (!rightWidth || velocity < -FLING_PX_PER_MS) return "closed";
    return offset >= rightWidth / 2 || velocity > FLING_PX_PER_MS ? "right" : "closed";
  }
  if (offset < 0) {
    if (!leftWidth || velocity > FLING_PX_PER_MS) return "closed";
    return -offset >= leftWidth / 2 || velocity < -FLING_PX_PER_MS ? "left" : "closed";
  }
  return "closed";
}

/**
 * Swipes on `listEl`'s rows, each row being its `rowAttr` element.
 * actionsFor(id): { left, right } as chatRowSwipeActions gives them, or null for no swipes.
 * iconFor(key): an action's icon markup. onAction(id, actionId): runs it, once the row has closed.
 * enabled(): false turns swipes off (Select mode, where the bulk bar owns actions).
 * ignoreStart(x): a touch that belongs to something else (the edge swipe back).
 */
export function attachRowSwipes(listEl, { rowAttr, actionsFor, iconFor, onAction, enabled = () => true, ignoreStart = () => false }) {
  const rowSelector = `[${rowAttr}]`;
  let gesture = null;      // the finger on a row: { pointerId, id, startX, startY, base, locked, ... }
  let openRow = null;      // the row left open: { id, side }
  let shown = null;        // the row out of place, open or on its way: { id, offset, actions }
  let layer = null;
  let layerSide = null;
  let swallowClick = false;
  let settleTimer = 0;

  const rowEl = (id) => listEl.querySelector(`[${rowAttr}="${CSS.escape(id)}"]`);

  function removeLayer() {
    layer?.remove();
    layer = null;
    layerSide = null;
  }

  function buildLayer(side, row, actions) {
    removeLayer();
    layer = document.createElement("div");
    layer.className = `chat-row-actions ${side}`;
    layer.innerHTML = actions[side].map((action) => `
      <button class="chat-row-action ${action.tint}" type="button" data-row-swipe-action="${action.id}">
        <span class="chat-row-action-icon" aria-hidden="true">${iconFor(action.icon)}</span>
        <span class="chat-row-action-title">${action.title}</span>
      </button>`).join("");
    layerSide = side;
    listEl.append(layer);
  }

  /** Beside its row, wherever the row is now: the rows above it can change height. */
  function placeLayer(row) {
    if (!layer || !row) return;
    layer.style.top = `${row.offsetTop}px`;
    layer.style.height = `${row.offsetHeight}px`;
  }

  function paint(animate) {
    if (!shown) return;
    const row = rowEl(shown.id);
    if (!row) return;
    const { offset, actions } = shown;
    row.classList.toggle("row-swipe-settling", animate);
    row.style.transform = offset ? `translate3d(${offset}px, 0, 0)` : "";
    if (!offset && !layer) return;
    const side = offset < 0 ? "left" : "right";
    if (offset && layerSide !== side) buildLayer(side, row, actions);
    if (!layer) return;
    placeLayer(row);
    layer.classList.toggle("row-swipe-settling", animate);
    layer.style.width = `${Math.abs(offset)}px`;
    // Past its button's width on a full swipe, the title keeps to the row's edge.
    if (layerSide === "right") {
      const inset = Math.max(0, offset - rowSwipeWidths(actions).rightWidth);
      layer.firstElementChild?.style.setProperty("padding-left", `${inset}px`);
    }
  }

  function settleTo(offset) {
    if (!shown) return;
    window.clearTimeout(settleTimer);
    shown.offset = offset;
    paint(true);
    settleTimer = window.setTimeout(() => {
      if (!shown || shown.offset !== 0) return;
      const row = rowEl(shown.id);
      if (row) { row.classList.remove("row-swipe-settling"); row.style.transform = ""; }
      removeLayer();
      shown = null;
    }, SETTLE_MS);
  }

  function close() {
    openRow = null;
    settleTo(0);
  }

  /** Back to nothing at all, at once: no row out of place, no finger being followed. */
  function reset() {
    window.clearTimeout(settleTimer);
    if (shown) {
      const row = rowEl(shown.id);
      if (row) { row.classList.remove("row-swipe-settling"); row.style.transform = ""; }
    }
    removeLayer();
    gesture = null;
    openRow = null;
    shown = null;
  }

  function runAfterClose(id, actionId) {
    close();
    window.setTimeout(() => onAction(id, actionId), SETTLE_MS);
  }

  const onPointerDown = (event) => {
    swallowClick = false;
    const target = event.target instanceof Element ? event.target : null;
    const onButtons = Boolean(layer && target && layer.contains(target));
    const row = target && listEl.contains(target) ? target.closest(rowSelector) : null;
    const id = row?.getAttribute(rowAttr) ?? null;
    const touch = event.pointerType === "touch" || event.pointerType === "pen";
    // A press anywhere else closes an open row; on another row it does only that, as on iOS. A
    // finger on the open row might yet swipe it, so that waits for the finger (onPointerEnd).
    if (openRow && !onButtons && (id !== openRow.id || !touch)) {
      close();
      if (target && listEl.contains(target)) swallowClick = true;
    }
    if (!touch) return;
    if (!event.isPrimary || !row || onButtons || !enabled() || ignoreStart(event.clientX)) return;
    const actions = actionsFor(id);
    if (!actions) return;
    gesture = {
      pointerId: event.pointerId, id, actions, row,
      startX: event.clientX, startY: event.clientY,
      base: shown && shown.id === id ? shown.offset : 0,
      locked: false, lastX: event.clientX, lastAt: event.timeStamp, velocity: 0, armed: false,
    };
  };

  const onPointerMove = (event) => {
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    if (!gesture.locked) {
      const axis = rowSwipeAxis(event.clientX - gesture.startX, event.clientY - gesture.startY);
      if (!axis) return;
      if (axis === "y") { gesture = null; return; }
      gesture.locked = true;
      gesture.startX = event.clientX;
      swallowClick = true;
      // The list stays when its rows are redrawn, so the rest of this swipe reaches it regardless.
      try { listEl.setPointerCapture(event.pointerId); } catch { /* the finger already lifted */ }
      window.clearTimeout(settleTimer);
      if (!shown || shown.id !== gesture.id) shown = { id: gesture.id, offset: 0, actions: gesture.actions };
    }
    const elapsed = event.timeStamp - gesture.lastAt;
    if (elapsed > 0) gesture.velocity = (event.clientX - gesture.lastX) / elapsed;
    gesture.lastX = event.clientX;
    gesture.lastAt = event.timeStamp;
    const widths = { ...rowSwipeWidths(gesture.actions), rowWidth: gesture.row.offsetWidth };
    shown.offset = clampRowSwipe(gesture.base + event.clientX - gesture.startX, widths);
    const armed = isFullRowSwipe(shown.offset, widths);
    if (armed !== gesture.armed) {
      gesture.armed = armed;
      try { navigator.vibrate?.(10); } catch { /* no haptics */ }
    }
    paint(false);
  };

  const onPointerEnd = (event) => {
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    const { id, actions, locked, velocity, row } = gesture;
    gesture = null;
    if (!locked) {
      // A tap on the open row closes it and doesn't open the chat.
      if (openRow?.id === id) {
        close();
        if (event.type === "pointerup") swallowClick = true;
      }
      return;
    }
    const widths = { ...rowSwipeWidths(actions), rowWidth: row.offsetWidth };
    // A finger taken away by the system (a call, a scroll) isn't a choice: it never runs an action.
    const where = settleRowSwipe({ offset: shown?.offset ?? 0, velocity: event.type === "pointerup" ? velocity : 0, ...widths });
    if (where === "full" && event.type === "pointerup") { runAfterClose(id, actions.right[0].id); return; }
    if (where === "left") { openRow = { id, side: "left" }; settleTo(-widths.leftWidth); return; }
    if (where === "right") { openRow = { id, side: "right" }; settleTo(widths.rightWidth); return; }
    close();
  };

  // Capturing, ahead of the list's own click that opens a chat.
  listEl.addEventListener("click", (event) => {
    const button = event.target instanceof Element ? event.target.closest("[data-row-swipe-action]") : null;
    if (button) {
      event.stopPropagation();
      const id = shown?.id;
      if (id != null) runAfterClose(id, button.getAttribute("data-row-swipe-action"));
      return;
    }
    if (!swallowClick) return;
    swallowClick = false;
    event.preventDefault();
    event.stopPropagation();
  }, true);
  document.addEventListener("pointerdown", onPointerDown, { capture: true, passive: true });
  document.addEventListener("pointermove", onPointerMove, { capture: true, passive: true });
  document.addEventListener("pointerup", onPointerEnd, { capture: true, passive: true });
  document.addEventListener("pointercancel", onPointerEnd, { capture: true, passive: true });
  // A turned phone: the row's new width isn't what its buttons were opened for.
  window.addEventListener("resize", () => { if (openRow) close(); }, { passive: true });
  if (typeof ResizeObserver === "function") {
    new ResizeObserver(() => { if (shown) placeLayer(rowEl(shown.id)); }).observe(listEl);
  }

  return {
    /** The list's rows were just redrawn: put back the row that was out of place. */
    refresh() {
      layer = null;
      layerSide = null;
      if (!shown) return;
      if (!enabled() || !rowEl(shown.id)) { reset(); return; }
      const actions = actionsFor(shown.id);
      if (!actions) { reset(); return; }
      shown.actions = actions;
      if (gesture) { gesture.actions = actions; gesture.row = rowEl(shown.id); }
      paint(false);
    },
    close() { if (openRow) close(); },
    /** A finger is on a row. An Android hold raises contextmenu with no other sign it was a touch. */
    fingerIsDown: () => Boolean(gesture),
  };
}
