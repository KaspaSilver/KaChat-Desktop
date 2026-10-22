// Phone sheets: dialogs rise from the bottom edge and a downward drag closes them, the way iOS
// presents its sheets. The look is in ui/styles.css (`.modal-backdrop.as-sheet`, phones only);
// this file decides which backdrops are sheets and runs the drag.
//
// Every dialog in the app is a `.modal-backdrop` with its card as the only child - built once in
// index.html and shown by clearing `hidden`, or created on demand and appended. So one observer
// covers them all instead of each screen opting in.

// Alerts, blocking progress and the onboarding guide stay centred: iOS centres its alerts and
// full-screen flows, and a progress card that cannot be closed has nothing to drag.
const CENTRED = [
  ".app-dialog-backdrop.is-alert",
  ".kas-payment-alert-backdrop",
  ".progress-blocking",
  ".initial-sync-backdrop",
  "[data-setup-guide-modal]",
  "[data-delete-confirm-modal]",
  "[data-password-modal]",
  ".chatting-picker-confirm-backdrop",
  ".kns-send-progress-backdrop",
  "[data-cold-confirm-modal]",
  ".group-refresh-backdrop",
  ".chess-overlay",
].join(", ");

const DISMISS_PX = 110;          // drag this far, or flick, and the sheet closes
const FLICK_PX_PER_MS = 0.6;

function tag(backdrop) {
  if (!(backdrop instanceof HTMLElement) || !backdrop.classList.contains("modal-backdrop")) return;
  const sheet = !backdrop.matches(CENTRED);
  if (backdrop.classList.contains("as-sheet") !== sheet) backdrop.classList.toggle("as-sheet", sheet);
  const card = backdrop.firstElementChild;
  if (backdrop.hidden) {
    // A reused backdrop must open where it belongs, not where the last drag left its card.
    if (card instanceof HTMLElement && card.style.transform) card.style.transform = "";
    // Only classes that are there: classList.remove rewrites the attribute even when nothing
    // changes, which the observer below would see as a change and answer forever.
    for (const name of ["sheet-dragging", "sheet-settling", "sheet-enter"]) {
      if (backdrop.classList.contains(name)) backdrop.classList.remove(name);
    }
    delete backdrop.dataset.sheetShown;
  } else if (sheet && !backdrop.dataset.sheetShown) {
    // The rise plays once per opening - not again whenever a class on the backdrop changes.
    backdrop.dataset.sheetShown = "1";
    backdrop.classList.add("sheet-enter");
    card?.addEventListener("animationend", () => backdrop.classList.remove("sheet-enter"), { once: true });
    window.setTimeout(() => backdrop.classList.remove("sheet-enter"), 600);
  }
}

const observer = new MutationObserver((mutations) => {
  for (const m of mutations) {
    if (m.type === "attributes") { tag(m.target); continue; }
    for (const node of m.addedNodes) {
      if (!(node instanceof HTMLElement)) continue;
      if (node.classList.contains("modal-backdrop")) tag(node);
      else if (node.firstElementChild) node.querySelectorAll?.(".modal-backdrop").forEach(tag);
    }
  }
});

function start() {
  document.querySelectorAll(".modal-backdrop").forEach(tag);
  // `class` too: the shared app dialog switches between alert and sheet per presentation.
  observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["hidden", "class"] });
}
if (document.body) start();
else document.addEventListener("DOMContentLoaded", start, { once: true });

// ---- Drag down to close -------------------------------------------------------------------
const phoneSheets = window.matchMedia("(hover: none) and (pointer: coarse) and (max-width: 620px)");

/// The sheet's own close control, so a drag closes it exactly the way the X does - including
/// whatever that screen does on close. A sheet without one cannot be dragged away.
function closeControl(card) {
  return card.querySelector(".modal-close, [data-app-dialog-cancel], [data-close]");
}

/// True when nothing between the touch and the card is scrolled down: only then is a downward
/// drag a pull on the sheet rather than a scroll back up through its content.
function atScrollTop(target, card) {
  for (let el = target; el && el !== card.parentElement; el = el.parentElement) {
    if (el.scrollTop > 0) return false;
  }
  return true;
}

let drag = null;

document.addEventListener("touchstart", (event) => {
  if (!phoneSheets.matches || event.touches.length !== 1) return;
  const target = event.target instanceof Element ? event.target : null;
  const backdrop = target?.closest(".modal-backdrop.as-sheet");
  if (!backdrop || backdrop.hidden) return;
  const card = backdrop.firstElementChild;
  if (!(card instanceof HTMLElement) || !card.contains(target)) return;
  if (target.closest("input, textarea, select, [contenteditable='true'], .action-tiles input[type='range']")) return;
  if (!closeControl(card) || !atScrollTop(target, card)) return;
  const touch = event.touches[0];
  drag = { backdrop, card, x: touch.clientX, y: touch.clientY, dy: 0, t: event.timeStamp, active: false };
}, { passive: true });

document.addEventListener("touchmove", (event) => {
  if (!drag) return;
  const touch = event.touches[0];
  const dx = touch.clientX - drag.x;
  const dy = touch.clientY - drag.y;
  if (!drag.active) {
    // Up first, or sideways first: a scroll or a swipe on something inside, not ours.
    if (dy < -6 || Math.abs(dx) > Math.abs(dy) + 4) { drag = null; return; }
    if (dy < 8) return;
    drag.active = true;
    drag.backdrop.classList.add("sheet-dragging");
  }
  event.preventDefault();
  drag.dy = Math.max(0, dy);
  drag.card.style.transform = `translateY(${drag.dy}px)`;
}, { passive: false });

function endDrag(event) {
  if (!drag) return;
  const { backdrop, card, dy, t, active } = drag;
  drag = null;
  if (!active) return;
  backdrop.classList.remove("sheet-dragging");
  backdrop.classList.add("sheet-settling");
  const speed = dy / Math.max(1, event.timeStamp - t);
  const close = dy > DISMISS_PX || (dy > 30 && speed > FLICK_PX_PER_MS);
  card.style.transform = close ? "translateY(100%)" : "";
  window.setTimeout(() => {
    backdrop.classList.remove("sheet-settling");
    if (!close) return;
    closeControl(card)?.click();
    // A sheet that refused to close (a step that must be finished) comes back up.
    window.setTimeout(() => {
      if (backdrop.isConnected && !backdrop.hidden) {
        backdrop.classList.add("sheet-settling");
        card.style.transform = "";
        window.setTimeout(() => backdrop.classList.remove("sheet-settling"), 240);
      }
    }, 60);
  }, 220);
}
document.addEventListener("touchend", endDrag, { passive: true });
document.addEventListener("touchcancel", endDrag, { passive: true });
