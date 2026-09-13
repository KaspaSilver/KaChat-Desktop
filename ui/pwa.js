// Web-app plumbing: the service worker, the phone viewport, and the "installed" state.
// Loaded from index.html as its own module so it runs before the app has to care.

// ---- Service worker (offline shell + iOS notifications, see public/sw.js) -------------------
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((error) => {
      console.warn("Service worker registration failed:", error);
    });
  });
  // Notification taps routed through the worker (iOS shows notifications only that way).
  navigator.serviceWorker.addEventListener("message", (event) => {
    const msg = event.data;
    if (!msg || msg.type !== "kachat:notification-click") return;
    window.dispatchEvent(new CustomEvent("kachat:notification-click", { detail: msg.data || {} }));
  });
}

// ---- Installed / touch state as root classes, for CSS and for the app -----------------------
const root = document.documentElement;
const standaloneMedia = window.matchMedia("(display-mode: standalone)");
function syncStandalone() {
  const standalone = standaloneMedia.matches || window.navigator.standalone === true;
  root.classList.toggle("standalone", standalone);
}
syncStandalone();
standaloneMedia.addEventListener?.("change", syncStandalone);

const coarseMedia = window.matchMedia("(hover: none) and (pointer: coarse)");
function syncCoarse() { root.classList.toggle("touch", coarseMedia.matches); }
syncCoarse();
coarseMedia.addEventListener?.("change", syncCoarse);

// ---- Viewport height that follows the keyboard ----------------------------------------------
// On a phone, `100vh`/`100dvh` is the window, not the part of it you can see: when the keyboard
// comes up on iOS the layout viewport keeps its height and the page is scrolled instead, which
// pushes the composer under the keyboard and the headers off the top. The visual viewport is the
// honest number, so the shell is sized to it (html.app-h + --app-h, see ui/styles.css) and the
// stray page scroll the keyboard causes is undone. Touch devices only: a desktop window never
// needs it and a resizing sidebar would fight it.
const vv = window.visualViewport;
let keyboardOpen = false;
function applyViewportHeight() {
  if (!coarseMedia.matches) {
    root.classList.remove("app-h", "keyboard-open");
    root.style.removeProperty("--app-h");
    return;
  }
  const height = Math.round(vv ? vv.height : window.innerHeight);
  if (!height) return;
  root.style.setProperty("--app-h", `${height}px`);
  root.classList.add("app-h");
  // A viewport noticeably shorter than the window is the keyboard (or the URL bar mid-animation).
  keyboardOpen = window.innerHeight - height > 120;
  root.classList.toggle("keyboard-open", keyboardOpen);
  if (keyboardOpen && (window.scrollY || (vv && vv.offsetTop))) window.scrollTo(0, 0);
}
applyViewportHeight();
if (vv) {
  vv.addEventListener("resize", applyViewportHeight);
  vv.addEventListener("scroll", () => { if (keyboardOpen && vv.offsetTop) window.scrollTo(0, 0); });
}
window.addEventListener("resize", applyViewportHeight);
window.addEventListener("orientationchange", () => window.setTimeout(applyViewportHeight, 250));
coarseMedia.addEventListener?.("change", applyViewportHeight);

// A focused field must end up above the keyboard, inside the shrunken shell: once the viewport has
// settled, scroll the field into view within its own scroller (never the page).
document.addEventListener("focusin", (event) => {
  if (!coarseMedia.matches) return;
  const el = event.target;
  if (!(el instanceof HTMLElement)) return;
  if (!el.matches("input, textarea, select, [contenteditable=\"true\"]")) return;
  window.setTimeout(() => {
    try { el.scrollIntoView({ block: "nearest", inline: "nearest" }); } catch { /* older engines */ }
    if (window.scrollY) window.scrollTo(0, 0);
  }, 350);
});

// ---- "Add to Home Screen" nudge on iPhone/iPad Safari ---------------------------------------
// Safari has no install prompt: the only way to get the app-like version (full screen, its own
// icon, notifications) is Share > Add to Home Screen. Shown once, on iOS Safari, in a browser tab.
const IOS_HINT_KEY = "kachat.pwa.iosHintDismissed";
function isIosSafariTab() {
  const ua = navigator.userAgent || "";
  const iosDevice = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  if (!iosDevice) return false;
  if (root.classList.contains("standalone")) return false;
  // Chrome/Firefox/Edge on iOS are Safari underneath but have no Add to Home Screen in Share.
  if (/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua)) return false;
  return /Safari/.test(ua);
}
function showIosInstallHint() {
  let dismissed = false;
  try { dismissed = localStorage.getItem(IOS_HINT_KEY) === "1"; } catch { /* storage blocked */ }
  if (dismissed || !isIosSafariTab()) return;
  const hint = document.createElement("div");
  hint.className = "ios-install-hint";
  hint.setAttribute("role", "status");
  hint.innerHTML = `
    <img class="ios-install-hint-icon" src="/icons/icon-192.png" alt="" />
    <div class="ios-install-hint-copy">
      <strong>Get KaChat as an app</strong>
      <span>Tap <svg viewBox="0 0 24 24" aria-label="Share"><path d="M12 3v13"/><path d="m7 8 5-5 5 5"/><path d="M5 12v8h14v-8"/></svg> then <b>Add to Home Screen</b>. It opens full screen and can notify you.</span>
    </div>
    <button type="button" class="ios-install-hint-close" aria-label="Dismiss">×</button>`;
  hint.querySelector(".ios-install-hint-close").addEventListener("click", () => {
    hint.remove();
    try { localStorage.setItem(IOS_HINT_KEY, "1"); } catch { /* fine */ }
  });
  document.body.append(hint);
}
window.addEventListener("load", () => window.setTimeout(showIosInstallHint, 1500));

// ---- Phone keyboards that fit the field ----------------------------------------------------
// iOS capitalises and autocorrects everything typed unless told otherwise, which mangles
// addresses, domains, node URLs, seed words and API keys; and a KAS amount deserves the number
// pad. The app renders many of its fields from templates, so the hints are applied when a field
// is about to be focused (pointerdown lands before focus, when iOS reads them) and once at boot.
const NO_CAPS_HINT = /kaspa:|\.kas\b|wss?:\/\/|https?:\/\/|host|node|channel|domain|seed|passphrase|api key|search|cloud\.|address|recipient|payout|url|\bname\b/i;
const NO_CAPS_ATTR = /address|recipient|node|domain|seed|url|payout|api|search|query|join|import|custom|passphrase|password/i;
const AMOUNT_HINT = /^0([.,]0+)?$/;
const AMOUNT_ATTR = /amount|fee|price|quantity|tip|hashrate/i;
function applyKeyboardHints(el) {
  if (!(el instanceof HTMLInputElement) && !(el instanceof HTMLTextAreaElement)) return;
  if (el.dataset.kbHinted) return;
  el.dataset.kbHinted = "1";
  const type = (el.type || "text").toLowerCase();
  if (["checkbox", "radio", "file", "range", "hidden", "color", "number", "date"].includes(type)) return;
  const attrs = [...el.attributes].map((a) => a.name).join(" ");
  const text = `${el.placeholder || ""} ${el.className || ""} ${el.name || ""} ${attrs}`;
  const isComposer = /composer|chess-chat|reply-input|notes|bio|display-name|group-name|account-name|utxoName|contact name/i.test(text)
    && !/join-input|api key/i.test(text);
  if (!isComposer && (type === "search" || type === "url" || type === "email" || NO_CAPS_HINT.test(text) || NO_CAPS_ATTR.test(attrs))) {
    if (!el.hasAttribute("autocapitalize")) el.setAttribute("autocapitalize", "none");
    if (!el.hasAttribute("autocorrect")) el.setAttribute("autocorrect", "off");
    if (!el.hasAttribute("spellcheck")) el.setAttribute("spellcheck", "false");
  }
  if (type === "text" && !el.hasAttribute("inputmode") && (AMOUNT_HINT.test((el.placeholder || "").trim()) || AMOUNT_ATTR.test(attrs) || /amount/i.test(el.className || ""))) {
    el.setAttribute("inputmode", "decimal");
  }
}
if (coarseMedia.matches) {
  document.addEventListener("pointerdown", (event) => {
    const field = event.target instanceof Element ? event.target.closest("input, textarea") : null;
    if (field) applyKeyboardHints(field);
  }, { capture: true, passive: true });
  window.addEventListener("load", () => document.querySelectorAll("input, textarea").forEach(applyKeyboardHints));
}
