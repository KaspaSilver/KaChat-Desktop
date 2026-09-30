// KaChat Wallet popup (and the same page opened as a full tab with ?view=tab).
//
// Phase 1: create / import / unlock / lock, the encrypted vault, the node connection, and the
// home screen - total balance, main and spending addresses, Receive with a QR code.

import { ext, isExtension, tellBackground, getLocal } from "./browser.js";
import * as vault from "./vault.js";
import * as wallet from "./wallet.js";
import { drawKaspaQr } from "../../engine/qr.js";

const app = document.getElementById("app");
const toastEl = document.getElementById("toast");
const isTab = new URLSearchParams(location.search).get("view") === "tab";
if (isTab) document.body.classList.add("tab");

const SETTINGS_KEY = "kachat.settings";

// --- small helpers -----------------------------------------------------------------------

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Screens drawn on the sign-in look (iOS OnboardingView): the green-cast near-black page.
const ONBOARDING_SCREENS = new Set(["welcome", "unlock"]);

function render(html, screen = "") {
  app.innerHTML = html;
  if (screen) app.dataset.screen = screen;
  else delete app.dataset.screen;
  document.body.classList.toggle("onboarding", ONBOARDING_SCREENS.has(screen));
  const first = app.querySelector("[autofocus]");
  if (first) first.focus();
}

function $(selector) { return app.querySelector(selector); }

let toastTimer = null;
function toast(message) {
  toastEl.textContent = message;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, 1800);
}

async function copyText(text, what = "Address") {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${what} copied`);
  } catch {
    toast("Couldn't copy - select and copy it instead");
  }
}

async function settings() {
  return (await getLocal(SETTINGS_KEY)) || {};
}

// Any interaction keeps the wallet unlocked for another auto-lock period (background.js).
let lastActivityPing = 0;
function noteActivity() {
  const now = Date.now();
  if (now - lastActivityPing < 20_000) return;
  lastActivityPing = now;
  tellBackground({ type: "activity" });
}
document.addEventListener("pointerdown", noteActivity, { capture: true });
document.addEventListener("keydown", noteActivity, { capture: true });

const ICONS = {
  lock: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
  expand: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="M21 3l-7 7"/><path d="M3 21l7-7"/></svg>',
  copy: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>',
  qr: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><path d="M14 14h3v3h-3zM20 14v.01M14 20h.01M17 17h4v4"/></svg>',
  back: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>',
  // SF Symbols plus.circle.fill / square.and.arrow.down, as on the iOS sign-in buttons.
  plusCircle: '<svg width="19" height="19" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="currentColor"/><path d="M12 7.5v9M7.5 12h9" stroke="var(--kaspa)" stroke-width="2.2" stroke-linecap="round"/></svg>',
  download: '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"/><path d="M7.5 10.5L12 15l4.5-4.5"/><path d="M5 14v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5"/></svg>',
};

// --- boot --------------------------------------------------------------------------------

async function boot() {
  if (!isExtension) {
    render('<section class="screen center"><p class="center-text">Open this page from the KaChat Wallet extension.</p></section>');
    return;
  }
  // Start the 12 MB WASM download/compile now, while the first screen is up.
  wallet.kaspa().catch(() => {});
  if (!(await vault.hasVault())) return showWelcome();
  if (!(await vault.isUnlocked())) return showUnlock();
  noteActivity();
  return showHome();
}

// The wallet can lock under an open popup (auto-lock alarm, or the lock button in another
// window): the unlock key disappears from storage.session, and the popup follows.
ext?.storage?.onChanged?.addListener((changes, area) => {
  if (area === "session" && changes["kachat.unlockKey"] && !changes["kachat.unlockKey"].newValue) {
    wallet.disconnect();
    showUnlock();
  }
});

// --- welcome / create / import -----------------------------------------------------------

// The KaChat wordmark with the app mark beside it - iOS OnboardingView.titleSection.
function wordmarkHtml(tagline) {
  return `
    <div class="hero">
      <div class="wordmark"><h1>KaChat</h1><img src="icons/kachat-logo.png" alt="KaChat logo" /></div>
      <p class="tagline">${esc(tagline)}</p>
    </div>`;
}

function showWelcome() {
  render(`
    <section class="onboard">
      ${wordmarkHtml("Secure Kaspa wallet on the BlockDAG")}
      <div class="buttons">
        <button id="create">${ICONS.plusCircle}<span>Create New Account</span></button>
        <button id="import" class="secondary">${ICONS.download}<span>Import Existing Account</span></button>
      </div>
    </section>`, "welcome");
  $("#create").onclick = () => showCreate();
  $("#import").onclick = () => showImport();
}

async function showCreate() {
  render('<section class="screen center"><p class="center-text"><span class="spinner"></span> Preparing a new recovery phrase…</p></section>');
  let phrase;
  try {
    phrase = await wallet.newRecoveryPhrase();
  } catch (error) {
    render(`<section class="screen center"><p class="error">${esc(error.message)}</p><button id="back" class="secondary">Back</button></section>`);
    $("#back").onclick = showWelcome;
    return;
  }
  const words = phrase.split(" ");
  render(`
    <header class="topbar"><button class="icon" id="back" aria-label="Back">${ICONS.back}</button><div class="title">Your recovery phrase</div></header>
    <section class="screen">
      <p class="muted">These 24 words are the only way to get this wallet back. Write them down in order and keep them somewhere safe. Anyone who has them can take your Kaspa.</p>
      <div class="words blurred" id="words">
        ${words.map((w, i) => `<span><b>${i + 1}</b>${esc(w)}</span>`).join("")}
      </div>
      <button class="secondary" id="reveal">Show words</button>
      <label class="check"><input type="checkbox" id="saved" /> I've written down my recovery phrase and stored it safely.</label>
      <div class="spacer"></div>
      <button id="next" disabled>Continue</button>
    </section>`);
  $("#back").onclick = showWelcome;
  $("#reveal").onclick = () => {
    const list = $("#words");
    const hidden = list.classList.toggle("blurred");
    $("#reveal").textContent = hidden ? "Show words" : "Hide words";
  };
  $("#saved").onchange = (e) => { $("#next").disabled = !e.target.checked; };
  $("#next").onclick = () => showSetPassword({ mnemonic: phrase, passphrase: "", family: "kaspaStandard" }, showCreate);
}

function showImport() {
  render(`
    <header class="topbar"><button class="icon" id="back" aria-label="Back">${ICONS.back}</button><div class="title">Import a wallet</div></header>
    <section class="screen">
      <label class="field">Recovery phrase
        <textarea id="phrase" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="12 or 24 words, separated by spaces" autofocus></textarea>
      </label>
      <details>
        <summary>Advanced</summary>
        <div class="stack" style="margin-top:10px">
          <label class="field">Passphrase (optional)
            <input id="passphrase" type="password" autocomplete="off" placeholder="Only if you set a 25th word" />
          </label>
          <label class="field">Wallet it came from
            <select id="family">
              <option value="kaspaStandard">KaChat, Kaspium, KasWare, Kastle, OKX, Ledger</option>
              <option value="kaspaLegacy972">KDX / Kaspanet web wallet (legacy)</option>
              <option value="oneKey">OneKey</option>
            </select>
          </label>
        </div>
      </details>
      <p class="error" id="error"></p>
      <div class="spacer"></div>
      <button id="next">Continue</button>
    </section>`);
  $("#back").onclick = showWelcome;
  $("#next").onclick = async () => {
    const button = $("#next");
    button.disabled = true;
    $("#error").textContent = "";
    try {
      const mnemonic = await wallet.validateRecoveryPhrase($("#phrase").value);
      showSetPassword({ mnemonic, passphrase: $("#passphrase").value, family: $("#family").value }, showImport);
    } catch (error) {
      $("#error").textContent = error.message;
      button.disabled = false;
    }
  };
}

function showSetPassword(account, onBack) {
  render(`
    <header class="topbar"><button class="icon" id="back" aria-label="Back">${ICONS.back}</button><div class="title">Set a password</div></header>
    <section class="screen">
      <p class="muted">This password unlocks KaChat Wallet in this browser and encrypts your recovery phrase on this computer. It can't recover your wallet - only the recovery phrase can.</p>
      <label class="field">Password
        <input id="pw" type="password" autocomplete="new-password" minlength="${vault.MIN_PASSWORD_LENGTH}" autofocus />
      </label>
      <label class="field">Confirm password
        <input id="pw2" type="password" autocomplete="new-password" />
      </label>
      <p class="error" id="error"></p>
      <div class="spacer"></div>
      <button id="finish">Create wallet</button>
    </section>`);
  // Going back from here must not lose a freshly generated phrase the user already wrote down.
  $("#back").onclick = () => (onBack === showCreate ? showWelcome() : onBack());
  $("#finish").onclick = async () => {
    const pw = $("#pw").value;
    const error = $("#error");
    error.textContent = "";
    if (pw.length < vault.MIN_PASSWORD_LENGTH) { error.textContent = `Use at least ${vault.MIN_PASSWORD_LENGTH} characters.`; return; }
    if (pw !== $("#pw2").value) { error.textContent = "The passwords don't match."; return; }
    const button = $("#finish");
    button.disabled = true;
    button.innerHTML = '<span class="spinner"></span> Encrypting…';
    try {
      await vault.createVault(pw, { ...account, name: "Account 1" });
      noteActivity();
      showHome();
    } catch (err) {
      error.textContent = err.message;
      button.disabled = false;
      button.textContent = "Create wallet";
    }
  };
}

// --- unlock / reset ----------------------------------------------------------------------

function showUnlock() {
  render(`
    <section class="onboard">
      ${wordmarkHtml("Enter your password to unlock")}
      <form id="form">
        <input id="pw" type="password" autocomplete="current-password" placeholder="Password" aria-label="Password" autofocus />
        <p class="error" id="error"></p>
        <div class="buttons"><button id="unlock" type="submit">Unlock</button></div>
        <button class="ghost" type="button" id="forgot">Forgot password?</button>
      </form>
    </section>`, "unlock");
  $("#form").onsubmit = async (event) => {
    event.preventDefault();
    const button = $("#unlock");
    button.disabled = true;
    button.innerHTML = '<span class="spinner"></span> Unlocking…';
    $("#error").textContent = "";
    try {
      await vault.unlock($("#pw").value);
      lastActivityPing = 0;
      noteActivity();
      showHome();
    } catch (error) {
      $("#error").textContent = error.message;
      button.disabled = false;
      button.textContent = "Unlock";
      $("#pw").select();
    }
  };
  $("#forgot").onclick = showReset;
}

function showReset() {
  render(`
    <header class="topbar"><button class="icon" id="back" aria-label="Back">${ICONS.back}</button><div class="title">Reset wallet</div></header>
    <section class="screen">
      <p>Without the password, the only way back in is your recovery phrase.</p>
      <p class="muted">Resetting removes KaChat Wallet's data from this browser. Your Kaspa stays on the network - import your recovery phrase afterwards to get it back. If you don't have the phrase, resetting loses access for good.</p>
      <label class="field">Type RESET to confirm
        <input id="confirm" autocomplete="off" autocapitalize="characters" />
      </label>
      <div class="spacer"></div>
      <button class="danger" id="reset" disabled>Reset wallet</button>
    </section>`);
  $("#back").onclick = showUnlock;
  $("#confirm").oninput = (e) => { $("#reset").disabled = e.target.value.trim() !== "RESET"; };
  $("#reset").onclick = async () => {
    await vault.resetWallet();
    await wallet.disconnect();
    showWelcome();
  };
}

// --- home --------------------------------------------------------------------------------

let homeState = null;

function connectionDot(state) {
  const cls = state === "ok" ? "ok" : state === "bad" ? "bad" : "busy";
  const label = state === "ok" ? "Connected" : state === "bad" ? "Not connected" : "Connecting";
  return `<span class="dot ${cls}" title="${label}" aria-label="${label}"></span>`;
}

async function showHome() {
  const accounts = await vault.readAccounts().catch(() => null);
  if (!accounts) return showUnlock();
  const account = accounts.accounts.find((a) => a.id === accounts.activeAccountId) || accounts.accounts[0];
  const currency = (await settings()).currency || "usd";
  const cached = await wallet.cachedAddresses(account.id);
  const spending = await wallet.spendingState(account.id);
  homeState = {
    account,
    currency,
    addresses: cached,
    spending,
    balances: null,
    price: wallet.cachedPrice(currency),
    connection: "busy",
    error: "",
  };
  paintHome();
  refreshHome();
}

function paintHome() {
  const s = homeState;
  if (!s) return;
  const total = s.balances?.total;
  const primary = s.addresses?.spending?.[s.spending.activeIndex];
  const mainBalance = s.balances ? `${wallet.formatKas(s.balances.main)} KAS` : "…";
  const primaryBalance = s.balances ? `${wallet.formatKas(s.balances.spending[s.spending.activeIndex] ?? 0n)} KAS` : "…";
  render(`
    <header class="topbar">
      ${connectionDot(s.connection)}
      <div class="title">${esc(s.account.name)}</div>
      ${isTab ? "" : `<button class="icon" id="expand" aria-label="Open in a tab" title="Open in a tab">${ICONS.expand}</button>`}
      <button class="icon" id="lock" aria-label="Lock" title="Lock">${ICONS.lock}</button>
    </header>
    <section class="screen">
      <div class="card balance">
        <div class="muted small">Total balance</div>
        <div class="amount">${total != null ? esc(wallet.formatKas(total)) : '<span class="spinner"></span>'}<span class="unit">KAS</span></div>
        <div class="fiat">${total != null ? esc(wallet.formatFiat(total, s.price)) : "&nbsp;"}</div>
      </div>
      <div class="actions">
        <button id="receive" ${primary ? "" : "disabled"}>Receive</button>
        <button id="send" class="secondary" disabled title="Sending arrives in the next update">Send</button>
      </div>
      ${s.error ? `<p class="error">${esc(s.error)}</p>` : ""}
      <div class="card stack">
        ${addressRowHtml("main", "Main address", s.addresses?.main, mainBalance, "Your KaChat identity and KNS domains")}
        ${addressRowHtml("spending", s.spending.activeIndex === 0 ? "Spending address" : `Spending #${s.spending.activeIndex}`, primary, primaryBalance, "Where Receive sends payments")}
      </div>
      <div class="spacer"></div>
      <p class="muted small center-text" id="node">${s.connection === "ok" ? `Node: ${esc(wallet.connectedNodeUrl())}` : s.connection === "bad" ? "Can't reach a Kaspa node - retrying" : "Connecting to the Kaspa network…"}</p>
    </section>`, "home");
  $("#lock").onclick = async () => { await vault.lock(); tellBackground({ type: "lock" }); await wallet.disconnect(); showUnlock(); };
  const expand = $("#expand");
  if (expand) expand.onclick = async () => { await ext.tabs.create({ url: ext.runtime.getURL("popup.html?view=tab") }); window.close(); };
  const receive = $("#receive");
  if (primary) receive.onclick = () => showQr({ title: "Receive Kaspa", address: primary, note: "Send only Kaspa (KAS) to this address." });
  for (const kind of ["main", "spending"]) {
    const address = kind === "main" ? s.addresses?.main : primary;
    if (!address) continue;
    const copy = $(`#copy-${kind}`);
    const qr = $(`#qr-${kind}`);
    if (copy) copy.onclick = () => copyText(address);
    if (qr) qr.onclick = () => showQr({ title: kind === "main" ? "Main address" : "Spending address", address });
  }
}

function addressRowHtml(kind, label, address, balanceText, hint) {
  return `
    <div class="address-row">
      <div class="meta">
        <div class="row-between"><span class="label">${esc(label)}</span><span class="bal">${esc(balanceText)}</span></div>
        <div class="addr" title="${esc(address || "")}">${address ? esc(wallet.shortAddress(address)) : '<span class="spinner"></span>'}</div>
        <div class="muted small">${esc(hint)}</div>
      </div>
      <button class="icon" id="copy-${kind}" aria-label="Copy ${esc(label)}" title="Copy" ${address ? "" : "disabled"}>${ICONS.copy}</button>
      <button class="icon" id="qr-${kind}" aria-label="Show ${esc(label)} QR code" title="QR code" ${address ? "" : "disabled"}>${ICONS.qr}</button>
    </div>`;
}

let refreshing = false;
async function refreshHome() {
  if (refreshing || !homeState) return;
  refreshing = true;
  const s = homeState;
  try {
    // Addresses first: derived from the phrase (a moment of CPU on first unlock), then cached.
    if (!s.addresses || s.addresses.accountId !== s.account.id || !s.addresses.spending?.[s.spending.maxIndex]) {
      s.addresses = await wallet.deriveAddresses();
      paintHomeIfShowing(s);
    }
    wallet.price(s.currency).then((p) => { if (p) { s.price = p; paintHomeIfShowing(s); } });
    try {
      await wallet.connection();
      s.connection = "ok";
      s.error = "";
      s.balances = await wallet.balances(s.addresses, s.spending.hidden);
    } catch (error) {
      s.connection = "bad";
      s.error = "";
      console.warn("[KaChat Wallet] network:", error);
    }
  } catch (error) {
    s.error = error.message;
  } finally {
    refreshing = false;
    paintHomeIfShowing(s);
  }
}

function paintHomeIfShowing(state) {
  // Only repaint when the home screen for this state is what's on screen.
  if (homeState === state && app.dataset.screen === "home") paintHome();
}

// Balances stay current while the popup is open.
setInterval(() => { if (homeState && app.dataset.screen === "home") refreshHome(); }, 30_000);

// --- QR ----------------------------------------------------------------------------------

async function showQr({ title, address, note = "" }) {
  render(`
    <header class="topbar"><button class="icon" id="back" aria-label="Back">${ICONS.back}</button><div class="title">${esc(title)}</div></header>
    <section class="screen">
      <div class="qr">
        <canvas id="qr" width="512" height="512" aria-label="QR code for ${esc(address)}"></canvas>
        <div class="addr-full">${esc(address)}</div>
        ${note ? `<p class="muted small center-text">${esc(note)}</p>` : ""}
      </div>
      <button id="copy">${ICONS.copy} Copy address</button>
    </section>`, "qr");
  $("#back").onclick = () => paintHome();
  $("#copy").onclick = () => copyText(address);
  try {
    await drawKaspaQr($("#qr"), address, { dark: "#071415", light: "#ffffff" });
  } catch { /* the address text is still there to copy */ }
}

boot();
