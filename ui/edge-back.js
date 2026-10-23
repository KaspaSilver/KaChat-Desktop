// Swipe from the left edge to go back, as on every iPhone screen with a back button.
//
// An installed web app gets no system back gesture (there is no browser history to swipe
// through), so a phone user's habitual swipe did nothing. This runs the screen's own back button:
// whichever one is on screen and not covered by anything - a sheet or overlay on top hides the
// buttons beneath it, so the swipe always means "back from what I am looking at". A chevron
// follows the finger so the gesture shows it has been understood before it fires.

const EDGE_PX = 24;          // the swipe must start this close to the left edge
const TRIGGER_PX = 72;       // and travel this far right
const BACK_SELECTOR = 'button[aria-label="Back"], button[aria-label^="Back to"]';
// A full-screen panel (Settings, Connection Status, Notifications, User Info) at its top level has
// no back button, only Done / Close / Cancel: with no back button showing, the swipe closes it, as
// swiping a pushed screen away does on iOS.
const CLOSE_SELECTOR = [
  "[data-close-account-overlay]",
  "[data-close-connection-overlay]",
  "[data-close-notif-center]",
  "[data-chat-info-cancel]",
].map((sel) => `.account-overlay:not([hidden]) ${sel}`).join(", ");
const phone = window.matchMedia("(hover: none) and (pointer: coarse)");

/// The back button a tap could reach right now - else a full-screen panel's Done - or null:
/// rendered, enabled, and the element at its centre is the button itself (not a sheet or overlay
/// drawn over it).
function reachableBackButton() {
  return reachable(BACK_SELECTOR) || reachable(CLOSE_SELECTOR);
}
function reachable(selector) {
  const candidates = [...document.querySelectorAll(selector)].reverse();
  for (const button of candidates) {
    if (button.disabled || button.hidden || !button.getClientRects().length) continue;
    const rect = button.getBoundingClientRect();
    if (rect.width < 4 || rect.height < 4) continue;
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) continue;
    const hit = document.elementFromPoint(x, y);
    if (hit && (hit === button || button.contains(hit))) return button;
  }
  return null;
}

let indicator = null;
function showIndicator(dx, y, armed) {
  if (!indicator) {
    indicator = document.createElement("div");
    indicator.className = "edge-back-indicator";
    indicator.setAttribute("aria-hidden", "true");
    indicator.innerHTML = '<svg viewBox="0 0 24 24"><path d="M15 5.5 8.5 12l6.5 6.5"/></svg>';
    document.body.append(indicator);
  }
  const travel = Math.min(dx, TRIGGER_PX * 1.4);
  indicator.style.top = `${Math.round(y)}px`;
  indicator.style.transform = `translate(${Math.round(travel * 0.6 - 44)}px, -50%)`;
  indicator.style.opacity = String(Math.min(1, travel / TRIGGER_PX));
  indicator.classList.toggle("armed", armed);
  indicator.hidden = false;
}
function hideIndicator() {
  if (indicator) indicator.hidden = true;
}

let swipe = null;

document.addEventListener("touchstart", (event) => {
  if (!phone.matches || event.touches.length !== 1) return;
  const touch = event.touches[0];
  if (touch.clientX > EDGE_PX) return;
  const button = reachableBackButton();
  if (!button) return;
  swipe = { button, x: touch.clientX, y: touch.clientY, dx: 0, active: false };
}, { passive: true });

document.addEventListener("touchmove", (event) => {
  if (!swipe) return;
  const touch = event.touches[0];
  const dx = touch.clientX - swipe.x;
  const dy = touch.clientY - swipe.y;
  if (!swipe.active) {
    // A vertical scroll that happened to start at the edge stays a scroll.
    if (Math.abs(dy) > 12 && Math.abs(dy) > dx) { swipe = null; return; }
    if (dx < 10) return;
    swipe.active = true;
  }
  event.preventDefault();
  swipe.dx = Math.max(0, dx);
  showIndicator(swipe.dx, touch.clientY, swipe.dx >= TRIGGER_PX);
}, { passive: false });

function endSwipe() {
  if (!swipe) return;
  const { button, dx, active } = swipe;
  swipe = null;
  hideIndicator();
  if (active && dx >= TRIGGER_PX && button.isConnected) button.click();
}
document.addEventListener("touchend", endSwipe, { passive: true });
document.addEventListener("touchcancel", () => { swipe = null; hideIndicator(); }, { passive: true });
