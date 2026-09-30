// Shared screen plumbing for the popup: rendering, the toast, clipboard, the iOS-style
// navigation header, SF-Symbol-like icons, and the address QR screen.

import { tellBackground, getLocal } from "./browser.js";
import { drawKaspaQr } from "../../engine/qr.js";
import { formatKas } from "./wallet.js";

export const app = document.getElementById("app");
const toastEl = document.getElementById("toast");
export const isTab = new URLSearchParams(location.search).get("view") === "tab";
if (isTab) document.body.classList.add("tab");

export const SETTINGS_KEY = "kachat.settings";

// --- small helpers -----------------------------------------------------------------------

export function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Screens drawn on the sign-in look (iOS OnboardingView): the green-cast near-black page.
const ONBOARDING_SCREENS = new Set(["welcome", "unlock"]);

export function render(html, screen = "") {
  app.innerHTML = html;
  if (screen) app.dataset.screen = screen;
  else delete app.dataset.screen;
  document.body.classList.toggle("onboarding", ONBOARDING_SCREENS.has(screen));
  const first = app.querySelector("[autofocus]");
  if (first) first.focus();
}

export function $(selector) { return app.querySelector(selector); }

let toastTimer = null;
export function toast(message) {
  toastEl.textContent = message;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, 1800);
}

export async function copyText(text, what = "Address") {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${what} copied`);
  } catch {
    toast("Couldn't copy - select and copy it instead");
  }
}

export async function settings() {
  return (await getLocal(SETTINGS_KEY)) || {};
}

// Any interaction keeps the wallet unlocked for another auto-lock period (background.js).
let lastActivityPing = 0;
/** Forget the last ping so the next interaction re-arms auto-lock immediately (after unlock). */
export function resetActivityPing() { lastActivityPing = 0; }
export function noteActivity() {
  const now = Date.now();
  if (now - lastActivityPing < 20_000) return;
  lastActivityPing = now;
  tellBackground({ type: "activity" });
}
document.addEventListener("pointerdown", noteActivity, { capture: true });
document.addEventListener("keydown", noteActivity, { capture: true });

export const ICONS = {
  // Send / Manage (SF Symbols equivalents).
  xCircle: '<svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="#ff453a"/><path d="M9 9l6 6M15 9l-6 6" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/></svg>',
  checkFill: '<svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="#30d158"/><path d="M7.5 12.5l3 3 6-6.5" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  merge: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3v5a6 6 0 0 0 6 6h0a6 6 0 0 1 6 6v1"/><path d="M18 3v5a6 6 0 0 1-3 5.2"/><path d="M3 6l3-3 3 3M15 6l3-3 3 3"/></svg>',
  clipboard: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="6" y="4" width="12" height="17" rx="2"/><path d="M9 4V3h6v1"/></svg>',
  pencilSmall: '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4z"/></svg>',
  checkBig: '<svg width="64" height="64" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="11" fill="var(--kaspa)"/><path d="M7 12.5l3.3 3.3L17 9" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  arrowUp: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 17L17 7M9 7h8v8"/></svg>',
  arrowDown: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 7L7 17M15 17H7V9"/></svg>',
  ellipsis: '<svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10.5" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="7.5" cy="12" r="1.4" fill="currentColor"/><circle cx="12" cy="12" r="1.4" fill="currentColor"/><circle cx="16.5" cy="12" r="1.4" fill="currentColor"/></svg>',
  plusCircleSmall: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/></svg>',
  search: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>',
  lock: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
  expand: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="M21 3l-7 7"/><path d="M3 21l7-7"/></svg>',
  copy: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>',
  qr: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><path d="M14 14h3v3h-3zM20 14v.01M14 20h.01M17 17h4v4"/></svg>',
  back: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>',
  // SF Symbols used on the iOS Profile tab.
  share: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"/><path d="M7.5 7.5L12 3l4.5 4.5"/><path d="M6 11H5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-1"/></svg>',
  pencilCircle: '<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="currentColor"/><path d="M8.5 15.5h2l5-5-2-2-5 5v2z" fill="var(--bg)"/></svg>',
  checkCircle: '<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="var(--kaspa)"/><path d="M7.5 12.5l3 3 6-6.5" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  qrBig: '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM20 14v.01M14 20h.01M17 17h4v4"/></svg>',
  sendCircle: '<svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="currentColor"/><path d="M12 16.5v-9M8 11.5l4-4 4 4" fill="none" stroke="var(--bg)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  gear: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
  at: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-3.9 7.9"/></svg>',
  chevron: '<svg class="chev" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18l6-6-6-6"/></svg>',
  logout: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4H6a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h8"/><path d="M11 12h10M17.5 8.5L21 12l-3.5 3.5"/></svg>',
  // SF Symbols used by the iOS create flow.
  warning: '<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3L2 20h20L12 3z" fill="currentColor"/><path d="M12 10v4.5M12 17.2v.3" stroke="#000" stroke-width="2" stroke-linecap="round"/></svg>',
  pencil: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4z"/><path d="M14 6l4 4"/></svg>',
  eye: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
  eyeSlash: '<svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3l18 18"/><path d="M10.6 5.1A10.4 10.4 0 0 1 12 5c6.5 0 10 7 10 7a17.6 17.6 0 0 1-3.2 4.2M6.6 6.6C3.8 8.4 2 12 2 12s3.5 7 10 7c1.9 0 3.5-.6 4.9-1.4"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>',
  square: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3.5" y="3.5" width="17" height="17" rx="3.5"/></svg>',
  checkSquare: '<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="4" fill="var(--kaspa)"/><path d="M7.5 12.5l3 3 6-6.5" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  lockShield: '<svg width="56" height="56" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2l8 3v6c0 5-3.4 9.3-8 11-4.6-1.7-8-6-8-11V5l8-3z" fill="currentColor"/><rect x="8.5" y="11" width="7" height="5.5" rx="1.2" fill="var(--bg)"/><path d="M10 11V9.5a2 2 0 0 1 4 0V11" fill="none" stroke="var(--bg)" stroke-width="1.6"/></svg>',
  // SF Symbols plus.circle.fill / square.and.arrow.down, as on the iOS sign-in buttons.
  plusCircle: '<svg width="19" height="19" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="currentColor"/><path d="M12 7.5v9M7.5 12h9" stroke="var(--kaspa)" stroke-width="2.2" stroke-linecap="round"/></svg>',
  download: '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"/><path d="M7.5 10.5L12 15l4.5-4.5"/><path d="M5 14v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5"/></svg>',
};

export function navHeader({ back = true, backLabel = "Back", title = "" } = {}) {
  return `
    <header class="navbar">
      ${back ? `<button class="nav-back" id="back" aria-label="${esc(backLabel)}">${ICONS.back}<span>${esc(backLabel)}</span></button>` : ""}
      ${title ? `<div class="nav-title">${esc(title)}</div>` : ""}
    </header>`;
}

// The address QR screen - iOS ChattingAddressQRView: balance, the code, the full address, a
// line on what the address is for, and copy.
export async function showQr({ title, address, balanceSompi = null, note = "", onBack }) {
  render(`
    ${navHeader({ title })}
    <section class="screen">
      <div class="qr">
        ${balanceSompi != null ? `<div class="qr-balance">${esc(formatKas(balanceSompi, 8))} KAS</div>` : ""}
        <canvas id="qr" width="512" height="512" aria-label="QR code for ${esc(address)}"></canvas>
        <div class="addr-full">${esc(address)}</div>
        ${note ? `<p class="muted small center-text">${esc(note)}</p>` : ""}
      </div>
      <button id="copy" class="with-icon">${ICONS.copy}<span>Copy Address</span></button>
    </section>`, "qr");
  $("#back").onclick = onBack;
  $("#copy").onclick = () => copyText(address);
  try {
    await drawKaspaQr($("#qr"), address, { dark: "#000000", light: "#ffffff" });
  } catch { /* the address text is still there to copy */ }
}

