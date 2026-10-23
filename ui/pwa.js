// Web-app plumbing: the service worker, the phone viewport, and the "installed" state.
// Loaded from index.html as its own module so it runs before the app has to care.
import { shouldRegisterServiceWorker } from "./origin-migration.js";
// The KaChat logo the sign-in screen shows (the install card matches it).
import kachatLogoUrl from "./assets/kachat-logo.png";
// Dialogs as iOS sheets on a phone, and the left-edge swipe back.
import "./sheets.js";
import "./edge-back.js";
// Conversations keep showing their newest message when the keyboard shortens them.
import "./stick-to-latest.js";

// The app is not always served from the root: the published site lives under /desktop/, so every
// path the web-app plumbing uses is built on Vite's base rather than written as root-absolute.
function appBase() {
  try { return import.meta.env.BASE_URL || "/"; } catch { return "/"; }
}

// ---- Service worker (offline shell + iOS notifications, see public/sw.js) -------------------
// Not on the old kachat.app/desktop/ address: it only hands accounts over to desktop.kachat.app
// now, and an installed copy must load that screen fresh, never a cached app (DSK-013).
if ("serviceWorker" in navigator && shouldRegisterServiceWorker()) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register(`${appBase()}sw.js`, { scope: appBase() }).catch((error) => {
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
  // Installed, it is simply the KaChat app: the app switcher and share sheet show this title, and
  // "KaChat Desktop" read wrong on a phone.
  if (standalone && document.title === "KaChat Desktop") document.title = "KaChat";
}
syncStandalone();
standaloneMedia.addEventListener?.("change", syncStandalone);

const coarseMedia = window.matchMedia("(hover: none) and (pointer: coarse)");
function syncCoarse() { root.classList.toggle("touch", coarseMedia.matches); }
syncCoarse();
coarseMedia.addEventListener?.("change", syncCoarse);

// ---- An app icon that matches dark mode -----------------------------------------------------
// The home-screen icon is read when the app is added, so the page offers the dark one (a near-black
// tile behind the same teal bubble) while the device is in dark mode, and the light one otherwise:
// apple-touch-icon for iPhone / iPad, the manifest (manifest-dark.json) for Android. A web app can't
// switch its installed icon later, as a native app's dark icon does; re-adding it picks up the
// current mode.
const darkScheme = window.matchMedia("(prefers-color-scheme: dark)");
function syncInstallIcons() {
  const dark = darkScheme.matches;
  const touch = document.querySelector('link[rel="apple-touch-icon"]');
  if (touch) touch.setAttribute("href", touch.getAttribute("href").replace(/apple-touch-icon(-dark)?\.png/, dark ? "apple-touch-icon-dark.png" : "apple-touch-icon.png"));
  const manifest = document.querySelector('link[rel="manifest"]');
  if (manifest) manifest.setAttribute("href", manifest.getAttribute("href").replace(/manifest(-dark)?\.json/, dark ? "manifest-dark.json" : "manifest.json"));
}
syncInstallIcons();
darkScheme.addEventListener?.("change", syncInstallIcons);
// Also when Safari comes back to the front (dark mode switched meanwhile, then Share > Add).
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") syncInstallIcons(); });

// ---- Viewport height that follows the keyboard ----------------------------------------------
// On a phone, `100vh`/`100dvh` is the window, not the part of it you can see: when the keyboard
// comes up on iOS the layout viewport keeps its height and the page is scrolled instead, which
// pushes the composer under the keyboard and the headers off the top. The visual viewport is the
// honest number, so the shell is sized to it (html.app-h + --app-h, see ui/styles.css) and the
// stray page scroll the keyboard causes is undone. Touch devices only: a desktop window never
// needs it and a resizing sidebar would fight it.
const vv = window.visualViewport;
let keyboardOpen = false;
/// The full screen height in CSS px when the page owns the whole screen - an installed web app
/// (standalone) whose window is as wide as the screen - else 0. iOS reports a home-screen app's
/// visual viewport and innerHeight as the screen MINUS the status bar while the page is drawn under
/// the status bar (black-translucent), so sizing the shell to them left a status-bar-tall gap under
/// the dock on an iPhone 15 Pro. iOS's screen.width/height are the portrait values in every
/// orientation, so the orientation picks which one is the height. iPad split view / Slide Over
/// (narrower than the screen) keep the reported viewport.
function standaloneScreenHeight() {
  if (!root.classList.contains("standalone")) return 0;
  const sw = Number(window.screen?.width) || 0;
  const sh = Number(window.screen?.height) || 0;
  if (!sw || !sh) return 0;
  const landscape = window.innerWidth > window.innerHeight;
  const screenW = landscape ? Math.max(sw, sh) : Math.min(sw, sh);
  const screenH = landscape ? Math.min(sw, sh) : Math.max(sw, sh);
  return Math.abs(window.innerWidth - screenW) <= 2 ? screenH : 0;
}
function applyViewportHeight() {
  if (!coarseMedia.matches) {
    root.classList.remove("app-h", "keyboard-open");
    root.style.removeProperty("--app-h");
    return;
  }
  const visible = Math.round(vv ? vv.height : window.innerHeight);
  if (!visible) return;
  const full = standaloneScreenHeight();
  // A viewport noticeably shorter than the window (or, installed, the screen) is the keyboard (or
  // the URL bar mid-animation).
  keyboardOpen = Math.max(window.innerHeight, full) - visible > 120;
  // Installed and no keyboard: the app is the whole screen, status bar to home indicator.
  const height = full && !keyboardOpen && full > visible ? full : visible;
  root.style.setProperty("--app-h", `${height}px`);
  root.classList.add("app-h");
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
// iOS can report a home-screen app's height wrong during the launch animation and send no resize
// afterwards, so measure again once the page has settled and whenever it comes back to the front.
window.addEventListener("load", () => window.setTimeout(applyViewportHeight, 300));
window.addEventListener("pageshow", () => window.setTimeout(applyViewportHeight, 100));
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") window.setTimeout(applyViewportHeight, 100); });
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

// ---- "Add to Home Screen" nudge on iPhone / iPad ----------------------------------------------
// iOS has no install prompt: the only way to get the app-like version (full screen, its own icon,
// notifications) is Share > Add to Home Screen - in Safari, or in Chrome (iOS 16.4+). A link opened
// inside another app (Telegram, X, Discord, Facebook, Instagram, Messages...) shows the page in that
// app's own browser, whose Share sheet has no Add to Home Screen at all - the commonest reason
// someone "can't add it" (their sheet offers "Open in Safari" instead). Some of those browsers say
// who they are in the user agent and get told to open Safari; the rest look exactly like Safari, so
// the Safari hint says what to do when the option is not there.
const IOS_HINT_KEY = "kachat.pwa.iosHintDismissed";
const SHARE_GLYPH = `<svg viewBox="0 0 24 24" aria-label="Share"><path d="M12 3v13"/><path d="m7 8 5-5 5 5"/><path d="M5 12v8h14v-8"/></svg>`;
/** Where this iPhone / iPad page is open, for the hint: "safari", "chrome", "in-app" (another
 *  app's own browser), "other" (a browser without Add to Home Screen), or null (not iOS, or
 *  already installed). */
function iosInstallContext() {
  const ua = navigator.userAgent || "";
  const iosDevice = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  if (!iosDevice || root.classList.contains("standalone")) return null;
  if (/FBAN|FBAV|FB_IAB|Instagram|LinkedInApp|Snapchat|musical_ly|TikTok|BytedanceWebview|Line\/|GSA\/|MicroMessenger|Pinterest/i.test(ua)) return "in-app";
  if (/CriOS/.test(ua)) return "chrome";
  if (/FxiOS|EdgiOS|OPiOS|DuckDuckGo|Brave/i.test(ua)) return "other";
  return /Safari/.test(ua) ? "safari" : "in-app";
}
function showIosInstallHint() {
  let dismissed = false;
  try { dismissed = localStorage.getItem(IOS_HINT_KEY) === "1"; } catch { /* storage blocked */ }
  const where = iosInstallContext();
  if (dismissed || !where) return;
  const steps = {
    safari: `Tap ${SHARE_GLYPH} then <b>Add to Home Screen</b> (scroll down, or under Edit Actions). Not there? Tap <b>Open in Safari</b> first - a link opened inside another app can't be added.`,
    chrome: `Tap ${SHARE_GLYPH} in the address bar, then <b>Add to Home Screen</b>.`,
    "in-app": `This page is open inside another app, which can't add it. Tap <b>…</b> or ${SHARE_GLYPH} and choose <b>Open in Safari</b>, then Share &gt; <b>Add to Home Screen</b>.`,
    other: `Open this page in <b>Safari</b>, then tap ${SHARE_GLYPH} and <b>Add to Home Screen</b>.`,
  }[where];
  const hint = document.createElement("div");
  hint.className = "ios-install-hint";
  hint.setAttribute("role", "status");
  hint.innerHTML = `
    <span class="ios-install-hint-icon" aria-hidden="true"><img src="${kachatLogoUrl}" alt="" /></span>
    <div class="ios-install-hint-copy">
      <strong>Get KaChat as an app</strong>
      <span>${steps} It opens full screen and can notify you.</span>
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
