// The dock - iOS MainTabView's tab bar, wallet-only: Storage | Profile | Portfolio.
// Selected items take the accent, the rest the system grey; labels are 10 pt under 26 pt
// glyphs. Each tab keeps its own place: switching back returns to the screen you left there
// (iOS keeps every tab's NavigationStack alive). Tapping the tab you are on does nothing.
//
// Screens say whether they sit in a tab (the dock shows) or are a sheet / full-screen flow
// (it hides) by name: showsDock() lists the Profile tab's screens; any screen named "cold:..."
// or "portfolio:..." belongs to those tabs.

import { esc, toast, onRender } from "./ui.js";

const ICON = {
  // lock.shield
  cold: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" aria-hidden="true"><path d="M12 2.5l7.5 2.8v5.9c0 4.8-3.2 8.9-7.5 10.4-4.3-1.5-7.5-5.6-7.5-10.4V5.3L12 2.5z"/><rect x="9" y="11" width="6" height="4.8" rx="1"/><path d="M10.3 11V9.6a1.7 1.7 0 0 1 3.4 0V11"/></svg>',
  // chart.pie
  portfolio: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" aria-hidden="true"><path d="M11 3.1A9 9 0 1 0 20.9 13H11z"/><path d="M14 2.6V10h7.4A8.6 8.6 0 0 0 14 2.6z"/></svg>',
  // person.crop.circle
  profile: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><circle cx="12" cy="12" r="9.5"/><circle cx="12" cy="9.5" r="3.3"/><path d="M5.6 18.6c1.4-2.3 3.7-3.5 6.4-3.5s5 1.2 6.4 3.5"/></svg>',
};

// Profile sits in the middle, between the two wallet tools (the user's order).
const TABS = [["cold", "Storage"], ["profile", "Profile"], ["portfolio", "Portfolio"]];

const roots = {};
const last = {};
let current = "profile";
let enabled = false;
const profileScreens = new Set();

/** The Profile tab's screens that keep the dock (the rest of its screens are sheets / flows). */
export function showsDock(...screens) { for (const s of screens) profileScreens.add(s); }

/** Each tab's first screen. */
export function registerTab(id, showRoot) { roots[id] = showRoot; }

/** The dock appears once a wallet is open, and goes with it (lock, log out). */
export function enableDock(on) { enabled = on; if (!on) { for (const k of Object.keys(last)) delete last[k]; current = "profile"; } }

export function currentTab() { return current; }

/** Remember the screen now showing as this tab's place, so switching back returns to it. */
export function remember(thunk) { last[current] = thunk; }

/** Back to a tab's first screen (and forget where it was). */
export function resetTab(id) { delete last[id]; }

export function selectTab(id) {
  if (id === current || !roots[id]) return;
  current = id;
  (last[id] || roots[id])();
}

function belongsToTab(screen) {
  if (/^cold:/.test(screen)) return "cold";
  if (/^portfolio:/.test(screen)) return "portfolio";
  if (profileScreens.has(screen)) return "profile";
  return null;
}

const dockEl = document.getElementById("dock");

onRender((screen) => {
  const tab = enabled ? belongsToTab(screen) : null;
  const visible = Boolean(tab);
  if (visible) current = tab;
  document.body.classList.toggle("dock-on", visible);
  if (!dockEl) return;
  dockEl.hidden = !visible;
  if (!visible) return;
  dockEl.innerHTML = TABS.map(([id, label]) => `
    <button class="dock-item" data-dock="${id}" role="tab" aria-selected="${id === current}" aria-label="${esc(label)}">
      ${ICON[id]}<span>${esc(label)}</span>
    </button>`).join("");
  for (const button of dockEl.querySelectorAll("[data-dock]")) button.onclick = () => selectTab(button.dataset.dock);
});

// --- the toolbar every tab's first screen shares (iOS: connection dot, the chatting wallet's
// balance in the middle) and its large title ------------------------------------------------

const status = { connection: "busy", balanceText: null, nodeUrl: "" };

export function setStatus(patch) { Object.assign(status, patch); }

export function tabTopHtml(title, { rightHtml = "" } = {}) {
  const cls = status.connection === "ok" ? "ok" : status.connection === "bad" ? "bad" : "busy";
  return `
    <header class="tab-toolbar">
      <button class="dot-button" id="tab-dot" aria-label="Connection"><span class="dot ${cls}"></span></button>
      <div class="toolbar-balance"><img src="icons/kaspa-logo.png" alt="" /><span>${status.balanceText != null ? esc(status.balanceText) : "--"} KAS</span></div>
      <div class="toolbar-right">${rightHtml}</div>
    </header>
    <h1 class="large-tab-title">${esc(title)}</h1>`;
}

export function bindTabTop() {
  const dot = document.getElementById("tab-dot");
  if (dot) dot.onclick = () => toast(status.connection === "ok" ? `Connected to ${status.nodeUrl.replace(/^wss:\/\//, "")}` : status.connection === "bad" ? "Can't reach a Kaspa node - retrying" : "Connecting to the Kaspa network…");
}
