// Keeps an open KaChat on the newest build. A home-screen app is resumed from memory, not
// reloaded, so without this it stayed on whatever build it last loaded - for days. The build writes
// version.json next to the page (vite.config.mjs); this compares it with the running build when the
// app comes back to the front, when the network returns, and every 15 minutes. A newer build
// reloads the app at once if it is coming back from the background with nothing under way (no
// send, no field being typed in, no sheet open); otherwise a small "New version" pill offers it.

const CHECK_EVERY_MS = 15 * 60 * 1000;
const RESUME_AFTER_MS = 30 * 1000; // hidden at least this long counts as coming back to the app

let currentBuild = 0;
let busy = () => false;
let hiddenAt = 0;
let checking = false;
let newerBuild = 0;
let pill = null;

function appBase() {
  try { return import.meta.env.BASE_URL || "/"; } catch { return "/"; }
}

async function latestBuild() {
  try {
    const response = await fetch(`${appBase()}version.json?t=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) return 0;
    const data = await response.json();
    return Number(data?.build) || 0;
  } catch { return 0; }
}

/** Something that a reload would cut short or lose. */
function somethingUnderWay() {
  try { if (busy()) return true; } catch { return true; }
  const el = document.activeElement;
  if (el instanceof HTMLElement && el.matches("input, textarea, [contenteditable='true']") && String(el.value ?? el.textContent ?? "").trim()) return true;
  return [...document.querySelectorAll(".modal-backdrop:not([hidden]), .account-overlay:not([hidden])")]
    .some((node) => getComputedStyle(node).display !== "none");
}

function showPill() {
  if (pill || !document.body) return;
  pill = document.createElement("button");
  pill.type = "button";
  pill.className = "app-update-pill";
  pill.innerHTML = `<span>New version of KaChat</span><strong>Update</strong>`;
  pill.addEventListener("click", () => window.location.reload());
  document.body.appendChild(pill);
}

async function check({ resumed = false } = {}) {
  if (checking || !currentBuild) return;
  checking = true;
  try {
    const latest = await latestBuild();
    if (latest <= currentBuild) return;
    newerBuild = latest;
    if (resumed && !somethingUnderWay()) { window.location.reload(); return; }
    showPill();
  } finally {
    checking = false;
  }
}

/**
 * @param {object} options
 * @param {number} options.build        the running build (APP_BUILD)
 * @param {function} [options.isBusy]   true while a reload would interrupt something (a send)
 */
export function startAppUpdateChecks({ build, isBusy } = {}) {
  currentBuild = Number(build) || 0;
  if (typeof isBusy === "function") busy = isBusy;
  if (!currentBuild || typeof window === "undefined") return;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") { hiddenAt = Date.now(); return; }
    const resumed = hiddenAt && Date.now() - hiddenAt >= RESUME_AFTER_MS;
    hiddenAt = 0;
    // Already known to be behind: coming back is the moment to move on.
    if (resumed && newerBuild > currentBuild && !somethingUnderWay()) { window.location.reload(); return; }
    check({ resumed: Boolean(resumed) });
  });
  window.addEventListener("online", () => check());
  window.setInterval(() => { if (document.visibilityState === "visible") check(); }, CHECK_EVERY_MS);
  window.setTimeout(() => check(), 20 * 1000);
}
