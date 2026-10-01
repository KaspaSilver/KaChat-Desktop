// Small UI pieces the Portfolio screens share: SF Symbol look-alikes, an iOS sheet with its own
// navigation bar (the portfolio actions, New Portfolio, Add Kaspa Address, Add to Portfolio),
// the iOS Toast capsule (success / error, 1.6 s), and pull to refresh.

import { esc } from "./ui.js";

const svg = (body, { size = 20, fill = "none", stroke = "currentColor", width = 2, viewBox = "0 0 24 24", cls = "" } = {}) =>
  `<svg class="${cls}" width="${size}" height="${size}" viewBox="${viewBox}" fill="${fill}" stroke="${stroke}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const SF = {
  gearFill: (size = 13) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" fill-rule="evenodd" d="M10.3 1.6h3.4l.5 2.7c.7.2 1.4.5 2 .9l2.3-1.6 2.4 2.4-1.6 2.3c.4.6.7 1.3.9 2l2.7.5v3.4l-2.7.5c-.2.7-.5 1.4-.9 2l1.6 2.3-2.4 2.4-2.3-1.6c-.6.4-1.3.7-2 .9l-.5 2.7h-3.4l-.5-2.7c-.7-.2-1.4-.5-2-.9l-2.3 1.6-2.4-2.4 1.6-2.3c-.4-.6-.7-1.3-.9-2l-2.7-.5v-3.4l2.7-.5c.2-.7.5-1.4.9-2L3.5 6l2.4-2.4 2.3 1.6c.6-.4 1.3-.7 2-.9zM12 8.2a3.8 3.8 0 1 0 0 7.6 3.8 3.8 0 0 0 0-7.6z"/></svg>`,
  plusCircleFill: (size = 22) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10.5" fill="currentColor"/><path d="M12 7v10M7 12h10" stroke="#000" stroke-width="2.2" stroke-linecap="round"/></svg>`,
  chevronRight: (size = 12) => svg('<path d="M9 5l7 7-7 7"/>', { size, width: 3 }),
  arrowUp: (size = 11) => svg('<path d="M12 20V4M5 11l7-7 7 7"/>', { size, width: 2.6 }),
  arrowDown: (size = 11) => svg('<path d="M12 4v16M5 13l7 7 7-7"/>', { size, width: 2.6 }),
  arrowUpRight: (size = 12) => svg('<path d="M7 17L17 7M8 7h9v9"/>', { size, width: 3 }),
  arrowDownRight: (size = 12) => svg('<path d="M7 7l10 10M17 8v9H8"/>', { size, width: 3 }),
  arrowRight: (size = 10) => svg('<path d="M4 12h16M13 5l7 7-7 7"/>', { size, width: 2.4 }),
  chartUptrend: (size = 16) => svg('<path d="M3 3v18h18"/><path d="M6 15l4-4 3 3 6-6"/><path d="M15 8h4v4"/>', { size }),
  pickaxe: (size = 20) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true"><g transform="rotate(45 12 12)" fill="currentColor"><path d="M1.2 9.6C6 1 18 1 22.8 9.6C18 6.6 6 6.6 1.2 9.6Z"/><path d="M10.5 5.4h3l-.4 16a1.1 1.1 0 0 1-2.2 0Z"/></g></svg>`,
  downCircleFill: (size = 26) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10.5" fill="currentColor"/><path d="M12 6.5v10M7.8 12.5l4.2 4.2 4.2-4.2" fill="none" stroke="#000" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  upCircleFill: (size = 26) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10.5" fill="currentColor"/><path d="M12 17.5v-10M7.8 11.5l4.2-4.2 4.2 4.2" fill="none" stroke="#000" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  warnFill: (size = 12) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5L1.5 21h21L12 2.5z" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M12 9.5v5M12 17.6v.3" stroke="#000" stroke-width="2.3" stroke-linecap="round"/></svg>`,
  checkCircleFill: (size = 18) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10.5" fill="currentColor"/><path d="M7.5 12.5l3 3 6-6.5" fill="none" stroke="#000" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  checkCircle: (size = 22) => svg('<circle cx="12" cy="12" r="9.5"/><path d="M7.8 12.4l2.9 2.9 5.5-6"/>', { size, width: 1.8 }),
  checkCircleSolid: (size = 22) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="currentColor"/><path d="M7.5 12.5l3 3 6-6.5" fill="none" stroke="#000" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  circle: (size = 22) => svg('<circle cx="12" cy="12" r="9.5"/>', { size, width: 1.6 }),
  trash: (size = 18) => svg('<path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13"/><path d="M9 7V4h6v3"/>', { size }),
  importExport: (size = 18) => svg('<path d="M12 2.5v10"/><path d="M8.5 6L12 2.5 15.5 6"/><path d="M8 9H6a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-2"/><path d="M8 21.5h11.5a1.5 1.5 0 0 0 1.5-1.5v-8.5"/>', { size, width: 2.1 }),
  importFile: (size = 18) => svg('<path d="M12 3v12"/><path d="M7.5 10.5L12 15l4.5-4.5"/><path d="M8 11H6a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-2"/>', { size }),
  exportFile: (size = 18) => svg('<path d="M12 15V3"/><path d="M7.5 7.5L12 3l4.5 4.5"/><path d="M8 11H6a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-2"/>', { size }),
  pencil: (size = 18) => svg('<path d="M4 20h4L19 9l-4-4L4 16v4z"/><path d="M14 6l4 4"/>', { size }),
  arrowLeftRight: (size = 18) => svg('<path d="M7 4L3 8l4 4M3 8h14M17 12l4 4-4 4M21 16H7"/>', { size }),
  arrowsUpDown: (size = 18) => svg('<path d="M7 20V4M3 8l4-4 4 4M17 4v16M13 16l4 4 4-4"/>', { size }),
  eye: (size = 20) => svg('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>', { size }),
  eyeSlash: (size = 20) => svg('<path d="M3 3l18 18"/><path d="M10.6 5.1A10.4 10.4 0 0 1 12 5c6.5 0 10 7 10 7a17.6 17.6 0 0 1-3.2 4.2M6.6 6.6C3.8 8.4 2 12 2 12s3.5 7 10 7c1.9 0 3.5-.6 4.9-1.4"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>', { size }),
  clipboard: (size = 16) => svg('<rect x="8" y="2.5" width="8" height="4" rx="1"/><path d="M16 4.5h2a1 1 0 0 1 1 1V20a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V5.5a1 1 0 0 1 1-1h2"/>', { size }),
  qrViewfinder: (size = 16) => svg('<path d="M3 8V4a1 1 0 0 1 1-1h4M16 3h4a1 1 0 0 1 1 1v4M21 16v4a1 1 0 0 1-1 1h-4M8 21H4a1 1 0 0 1-1-1v-4"/><rect x="7" y="7" width="4" height="4"/><rect x="13" y="7" width="4" height="4"/><rect x="7" y="13" width="4" height="4"/><path d="M13 13h4v4"/>', { size }),
  xCircleFill: (size = 14) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10.5" fill="currentColor"/><path d="M8.5 8.5l7 7M15.5 8.5l-7 7" stroke="#000" stroke-width="2.3" stroke-linecap="round"/></svg>`,
  xOctagonFill: (size = 18) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 2h8l6 6v8l-6 6H8l-6-6V8z" fill="currentColor"/><path d="M9 9l6 6M15 9l-6 6" stroke="#000" stroke-width="2.3" stroke-linecap="round"/></svg>`,
  bitcoin: (size = 26) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="11" fill="currentColor"/><path d="M9 6.5v11M9 7h4.2a2.5 2.5 0 0 1 0 5H9m0 0h4.8a2.6 2.6 0 0 1 0 5.2H9M10.5 5v2M13 5v2M10.5 17v2M13 17v2" fill="none" stroke="#000" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  chartCircle: (size = 26) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="11" fill="currentColor"/><path d="M6.5 15.5l3.5-3.5 2.5 2.5 5-5M14.5 9.5h3v3" fill="none" stroke="#000" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  hexCircle: (size = 26) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="11" fill="currentColor"/><g fill="none" stroke="#000" stroke-width="1.4"><path d="M12 5.5l2.3 1.3v2.6L12 10.7 9.7 9.4V6.8z"/><path d="M8 12.2l2.3 1.3v2.6L8 17.4l-2.3-1.3v-2.6z"/><path d="M16 12.2l2.3 1.3v2.6L16 17.4l-2.3-1.3v-2.6z"/></g></svg>`,
  folder: (size = 18) => svg('<path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.2l2 2h8.8A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z"/>', { size }),
  handle: (size = 18) => svg('<path d="M4 8h16M4 12h16M4 16h16"/>', { size, width: 1.8 }),
  gear: (size = 20) => svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>', { size, width: 1.8 }),
  checkSeal: (size = 20) => svg('<path d="M12 2.5l2.2 1.6 2.7-.1.9 2.6 2.2 1.6-.8 2.6.8 2.6-2.2 1.6-.9 2.6-2.7-.1L12 21.5l-2.2-1.6-2.7.1-.9-2.6L4 15.8l.8-2.6L4 10.6l2.2-1.6.9-2.6 2.7.1z"/><path d="M8.6 12.2l2.3 2.3 4.5-4.8"/>', { size, width: 1.9 }),
  fuelpump: (size = 20) => svg('<path d="M4 21V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v16"/><path d="M3 21h12"/><path d="M4 10h10"/><path d="M14 8h1.5a2 2 0 0 1 2 2v6.5a1.5 1.5 0 0 0 3 0V8.5L18 6"/>', { size, width: 1.9 }),
  transferCircleFill: (size = 26) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10.5" fill="currentColor"/><path d="M8.5 6.8L6 9.3l2.5 2.5M6 9.3h10.5M15.5 12.2l2.5 2.5-2.5 2.5M18 14.7H7.5" fill="none" stroke="#000" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  bubbles: (size = 18) => svg('<path d="M3 5.5A2.5 2.5 0 0 1 5.5 3h8A2.5 2.5 0 0 1 16 5.5v5a2.5 2.5 0 0 1-2.5 2.5H8l-3.5 3V13A2.5 2.5 0 0 1 3 10.5z"/><path d="M19 8.5a2 2 0 0 1 2 2v5a2 2 0 0 1-1.5 2V21l-3.2-2.5H11a2 2 0 0 1-2-2"/>', { size }),
  back: (size = 18) => svg('<path d="M15 18l-6-6 6-6"/>', { size }),
};

/** "Up" means >= 0: the arrow, the colour and the absolute value carry the sign. */
export function changeBadge(percent, positive, { cls = "" } = {}) {
  return `<span class="pf-change ${positive ? "up" : "down"} ${cls}">${positive ? SF.arrowUp() : SF.arrowDown()}<span>${Math.abs(percent).toFixed(2)}%</span></span>`;
}

// --- iOS sheet with its own navigation bar ------------------------------------------------------

/**
 * Opens a sheet over the current screen.
 *   leading / trailing: { label, strong, disabled, danger, onClick } or null
 *   size: "medium" (half, growing to fit), "large" or a pixel height
 *   locked(): true while the sheet must not be swiped / clicked away (an import running)
 */
export function openPanel({ title, leading = null, trailing = null, body = "", size = "medium", className = "", onMount = null, onClose = null, locked = null }) {
  document.querySelector(".pf-panel-backdrop")?.remove();
  const backdrop = document.createElement("div");
  backdrop.className = "panel-backdrop pf-panel-backdrop";
  let bar = { title, leading, trailing };
  const button = (item, side) => item
    ? `<button class="bar-text ${item.strong ? "strong" : ""} ${item.danger ? "danger-text" : ""}" data-bar="${side}" ${item.disabled ? "disabled" : ""}>${esc(item.label)}</button>`
    : "<span></span>";
  const barHtml = () => `${button(bar.leading, "leading")}<div class="nav-title">${esc(bar.title)}</div>${button(bar.trailing, "trailing")}`;
  const style = typeof size === "number" ? `height:${size}px` : size === "large" ? "height:92%" : "";
  backdrop.innerHTML = `
    <div class="panel pf-panel ${size === "medium" ? "pf-medium" : ""} ${className}" role="dialog" aria-modal="true" aria-label="${esc(title)}" style="${style}">
      <div class="sheet-grabber"></div>
      <header class="panel-bar pf-panel-bar">${barHtml()}</header>
      <div class="panel-body form pf-panel-body">${body}</div>
    </div>`;
  const panel = backdrop.querySelector(".panel");
  const barEl = backdrop.querySelector(".pf-panel-bar");
  const bodyEl = backdrop.querySelector(".pf-panel-body");
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    backdrop.remove();
    document.removeEventListener("keydown", onKey);
    onClose?.();
  };
  const onKey = (event) => { if (event.key === "Escape" && !locked?.()) close(); };
  document.addEventListener("keydown", onKey);
  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop) { if (!locked?.()) close(); return; }
    const barButton = event.target.closest("[data-bar]");
    if (barButton && !barButton.disabled) {
      const item = bar[barButton.dataset.bar];
      item?.onClick?.();
    }
  });
  document.body.appendChild(backdrop);
  const handle = {
    el: panel,
    body: bodyEl,
    close,
    isOpen: () => !closed,
    setBar(next) { bar = { ...bar, ...next }; barEl.innerHTML = barHtml(); },
    setBody(html) { bodyEl.innerHTML = html; },
  };
  onMount?.(handle);
  return handle;
}

// --- toast capsule --------------------------------------------------------------------------

let toastTimer = null;
/** iOS Toast: a capsule at the bottom with a green check or a red octagon; gone after 1.6 s. */
export function pfToast(message, { error = false, duration = 1600 } = {}) {
  document.querySelector(".pf-toast")?.remove();
  clearTimeout(toastTimer);
  const el = document.createElement("div");
  el.className = `pf-toast ${error ? "error" : ""}`;
  el.innerHTML = `<span class="pf-toast-icon">${error ? SF.xOctagonFill(17) : SF.checkCircleFill(17)}</span><span>${esc(message)}</span>`;
  document.body.appendChild(el);
  toastTimer = setTimeout(() => { el.classList.add("out"); setTimeout(() => el.remove(), 200); }, duration);
}

// --- pull to refresh ----------------------------------------------------------------------------

/**
 * iOS .refreshable on a scroller: pulling down past the top (a touch drag, or the mouse wheel /
 * trackpad scrolling up while already at the top) shows a spinner and runs `onRefresh`.
 */
export function bindPullToRefresh(scroller, indicator, onRefresh) {
  if (!scroller || !indicator) return;
  let pull = 0;
  let busy = false;
  let touchStart = null;
  let wheelTimer = null;
  const show = (amount) => {
    indicator.style.height = `${Math.min(amount, 60)}px`;
    indicator.classList.toggle("armed", amount >= 50);
  };
  const run = async () => {
    busy = true;
    show(44);
    indicator.classList.add("busy");
    try { await onRefresh(); } catch { /* the screen keeps what it had */ }
    busy = false;
    indicator.classList.remove("busy", "armed");
    show(0);
  };
  // A wheel gesture counts only if it began with the list already at the top: the momentum of
  // scrolling back up to the top must not trigger a refresh by itself.
  let lastWheel = 0;
  let startedAtTop = false;
  scroller.addEventListener("wheel", (event) => {
    const now = Date.now();
    if (now - lastWheel > 300) startedAtTop = scroller.scrollTop <= 0;
    lastWheel = now;
    if (busy || !startedAtTop || scroller.scrollTop > 0 || event.deltaY >= 0) { if (!busy && pull) { pull = 0; show(0); } return; }
    pull += -event.deltaY * 0.5;
    show(pull);
    clearTimeout(wheelTimer);
    if (pull >= 50) { pull = 0; run(); return; }
    wheelTimer = setTimeout(() => { if (!busy) { pull = 0; show(0); } }, 250);
  }, { passive: true });
  scroller.addEventListener("touchstart", (event) => {
    touchStart = scroller.scrollTop <= 0 && !busy ? event.touches[0].clientY : null;
  }, { passive: true });
  scroller.addEventListener("touchmove", (event) => {
    if (touchStart == null) return;
    pull = Math.max(0, (event.touches[0].clientY - touchStart) * 0.6);
    show(pull);
  }, { passive: true });
  scroller.addEventListener("touchend", () => {
    if (touchStart == null) return;
    touchStart = null;
    if (pull >= 50) run(); else show(0);
    pull = 0;
  });
}

/**
 * SwiftUI .minimumScaleFactor: every [data-fit="0.6"] under `root` that overflows its box is
 * scaled down until it fits, never below that factor (then it truncates).
 */
export function fitText(root = document) {
  for (const el of root.querySelectorAll("[data-fit]")) {
    el.style.fontSize = "";
    const base = parseFloat(getComputedStyle(el).fontSize);
    const min = Number(el.dataset.fit) || 0.6;
    if (!el.clientWidth || el.scrollWidth <= el.clientWidth) continue;
    const scale = Math.max(min, el.clientWidth / el.scrollWidth);
    el.style.fontSize = `${Math.floor(base * scale * 10) / 10}px`;
  }
}
