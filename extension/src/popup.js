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

// --- create account: iOS CreateWalletView + PassphraseOptionView, same steps and words ------
//
//   1. Create Account - Important card, Seed Phrase Length (12/24), Account Name, Generate Account
//   2. Write Down Your Seed Phrase - tap to reveal, numbered grid (no copy, as on iOS), the
//      "I have written down..." checkbox, Next
//   3. Passphrase - the question (Yes / No / What is a passphrase?), the entry screen with the
//      live address preview, and the explainer
//   4. Wallet password - the one step iOS does not have: a browser has no Face ID or iOS
//      keychain, so the phrase is sealed with a password instead (vault.js).
// iOS then shows its Welcome Guide (chat setup); a wallet-only extension goes straight home.

let createDraft = null;
function freshCreateDraft() {
  // Nothing preset: no length picked and an empty name. Generate Account stays off until the
  // user has chosen both.
  return { wordCount: null, name: "", phrase: null, revealed: false, confirmed: false };
}

function navHeader({ back = true, backLabel = "Back", title = "" } = {}) {
  return `
    <header class="navbar">
      ${back ? `<button class="nav-back" id="back" aria-label="${esc(backLabel)}">${ICONS.back}<span>${esc(backLabel)}</span></button>` : ""}
      ${title ? `<div class="nav-title">${esc(title)}</div>` : ""}
    </header>`;
}

function canGenerate(draft) {
  return (draft.wordCount === 12 || draft.wordCount === 24) && Boolean(draft.name.trim());
}

function showCreate() {
  if (!createDraft) createDraft = freshCreateDraft();
  if (createDraft.phrase) return showCreateSeed();
  const d = createDraft;
  render(`
    ${navHeader()}
    <section class="screen">
      <h1 class="large-title">Create Account</h1>
      <div class="callout warn">
        <div class="callout-title">${ICONS.warning}<span>Important</span></div>
        <p>You will be shown a seed phrase. This is the only way to recover your account. Write it down and store it securely.</p>
      </div>
      <div class="field-group">
        <h3>Seed Phrase Length</h3>
        <div class="segmented" role="radiogroup" aria-label="Seed Phrase Length">
          <button type="button" role="radio" data-words="12" aria-checked="${d.wordCount === 12}">12 words</button>
          <button type="button" role="radio" data-words="24" aria-checked="${d.wordCount === 24}">24 words</button>
        </div>
      </div>
      <div class="field-group">
        <h3>Account Name</h3>
        <input id="name" value="${esc(d.name)}" placeholder="Enter account name" maxlength="40" autocomplete="off" autofocus />
      </div>
      <p class="error" id="error"></p>
      <button id="generate" class="with-icon" ${canGenerate(d) ? "" : "disabled"}>${ICONS.plusCircle}<span>Generate Account</span></button>
    </section>`, "create");
  $("#back").onclick = () => { createDraft = null; showWelcome(); };
  for (const option of app.querySelectorAll(".segmented button")) {
    option.onclick = () => {
      d.wordCount = Number(option.dataset.words);
      for (const other of app.querySelectorAll(".segmented button")) other.setAttribute("aria-checked", String(other === option));
      $("#generate").disabled = !canGenerate(d);
    };
  }
  const name = $("#name");
  name.oninput = () => { d.name = name.value; $("#generate").disabled = !canGenerate(d); };
  $("#generate").onclick = async () => {
    if (!d.wordCount) { $("#error").textContent = "Choose a seed phrase length."; return; }
    if (!d.name.trim()) { $("#error").textContent = "Enter an account name."; return; }
    const button = $("#generate");
    button.disabled = true;
    button.innerHTML = '<span class="spinner"></span><span>Generate Account</span>';
    try {
      d.phrase = await wallet.newRecoveryPhrase(d.wordCount);
      d.revealed = false;
      d.confirmed = false;
      showCreateSeed();
    } catch (error) {
      $("#error").textContent = error.message;
      button.disabled = !canGenerate(d);
      button.innerHTML = `${ICONS.plusCircle}<span>Generate Account</span>`;
    }
  };
}

function showCreateSeed() {
  const d = createDraft;
  const words = d.phrase.split(" ");
  render(`
    ${navHeader()}
    <section class="screen">
      <h1 class="large-title">Create Account</h1>
      <div class="callout warn tinted">
        <div class="callout-title">${ICONS.pencil}<span>Write Down Your Seed Phrase</span></div>
        <p>Store this in a safe place. Anyone with these words can access your account.</p>
      </div>
      ${d.revealed
        ? `<div class="seed-grid">${words.map((w, i) => `<div class="seed-word"><span class="n">${i + 1}.</span><span class="w">${esc(w)}</span></div>`).join("")}</div>`
        : `<button class="reveal-box" id="reveal">${ICONS.eyeSlash}<span>Tap to reveal seed phrase</span></button>`}
      <button class="checkline" id="confirm" role="checkbox" aria-checked="${d.confirmed}">
        ${d.confirmed ? ICONS.checkSquare : ICONS.square}
        <span>I have written down my seed phrase and stored it securely</span>
      </button>
      <button id="next" ${d.confirmed ? "" : "disabled"}>Next</button>
    </section>`, "create");
  // Leaving this screen leaves Create Account, as on iOS: the phrase goes with it.
  $("#back").onclick = () => { createDraft = null; showWelcome(); };
  const reveal = $("#reveal");
  if (reveal) reveal.onclick = () => { d.revealed = true; showCreateSeed(); };
  $("#confirm").onclick = () => { d.confirmed = !d.confirmed; showCreateSeed(); };
  // One flow object, so Back from the password step returns to the same passphrase question.
  const flow = { mode: "create", phrase: d.phrase, family: "kaspaStandard", onBack: showCreateSeed, onProceed: null };
  flow.onProceed = (passphrase) => showSetPassword(
    { mnemonic: d.phrase, passphrase, family: "kaspaStandard", name: d.name.trim() },
    () => showPassphraseQuestion(flow),
  );
  $("#next").onclick = () => showPassphraseQuestion(flow);
}

// --- passphrase: iOS PassphraseOptionView ------------------------------------------------

function showPassphraseQuestion(flow) {
  const title = flow.mode === "create"
    ? "Do you want to add a passphrase to your account?"
    : "Did you create this seed with a passphrase?";
  render(`
    ${navHeader({ title: "Passphrase" })}
    <section class="screen question">
      <div class="question-body">
        <div class="question-icon">${ICONS.lockShield}</div>
        <h2 class="question-title">${esc(title)}</h2>
        ${flow.mode === "import" ? '<p class="muted center-text">If you are not sure, the answer is almost certainly no. A passphrase is something you would have typed in on purpose.</p>' : ""}
      </div>
      <div class="stack">
        <button id="yes" class="big">Yes</button>
        <button id="no" class="big soft">No</button>
        <button id="what" class="ghost">What is a passphrase?</button>
      </div>
    </section>`, "passphrase");
  $("#back").onclick = flow.onBack;
  $("#yes").onclick = () => showPassphraseEntry(flow);
  $("#no").onclick = () => flow.onProceed("");
  $("#what").onclick = () => showPassphraseExplainer(flow);
}

function showPassphraseEntry(flow) {
  const create = flow.mode === "create";
  render(`
    ${navHeader({ title: "Passphrase" })}
    <section class="screen">
      <h2>${create ? "Choose your passphrase" : "Enter your passphrase"}</h2>
      <p class="muted">${create
        ? "Write it down somewhere safe. Without it this account cannot be recovered, even with your seed phrase."
        : "It has to be exactly what you used before, including capital letters and spaces."}</p>
      <div class="secure-field">
        <input id="pp" type="password" placeholder="Passphrase" autocomplete="off" autocapitalize="off" spellcheck="false" autofocus />
        <button class="icon" id="eye" type="button" aria-label="Show passphrase">${ICONS.eye}</button>
      </div>
      ${create ? '<input id="pp2" type="password" placeholder="Re-enter passphrase" autocomplete="off" autocapitalize="off" spellcheck="false" />' : ""}
      <div class="preview">
        <div class="muted small">Your main address</div>
        <div class="preview-address" id="preview">Checking...</div>
        <div class="muted small" id="preview-note">This is the account your seed phrase opens on its own.</div>
      </div>
      <p class="error" id="error"></p>
      <button id="continue" class="big" disabled>${create ? "Continue" : "Import"}</button>
    </section>`, "passphrase");
  // iOS clears what was typed when you go back to the question.
  $("#back").onclick = () => showPassphraseQuestion(flow);
  const pp = $("#pp");
  const pp2 = $("#pp2");
  let revealed = false;
  $("#eye").onclick = () => {
    revealed = !revealed;
    for (const field of [pp, pp2]) if (field) field.type = revealed ? "text" : "password";
    $("#eye").innerHTML = revealed ? ICONS.eyeSlash : ICONS.eye;
    $("#eye").setAttribute("aria-label", revealed ? "Hide passphrase" : "Show passphrase");
  };
  // Address #0 for the passphrase as typed, on a short debounce (the derivation is PBKDF2).
  let previewTimer = null;
  let previewSeq = 0;
  const schedulePreview = () => {
    clearTimeout(previewTimer);
    const typed = pp.value;
    $("#preview-note").textContent = typed
      ? "A different passphrase gives a different address, and a different account."
      : "This is the account your seed phrase opens on its own.";
    const seq = ++previewSeq;
    previewTimer = setTimeout(async () => {
      const address = await wallet.previewMainAddress(flow.phrase, typed, flow.family);
      if (seq !== previewSeq || !$("#preview")) return;
      $("#preview").textContent = address || "Checking...";
    }, 250);
  };
  pp.oninput = () => { $("#continue").disabled = !pp.value; schedulePreview(); };
  schedulePreview();
  $("#continue").onclick = () => {
    const error = $("#error");
    error.textContent = "";
    if (!pp.value) { error.textContent = "Enter a passphrase, or go back and choose No."; return; }
    if (create && pp.value !== pp2.value) { error.textContent = "The passphrases do not match. Please re-enter them."; return; }
    flow.onProceed(pp.value);
  };
}

function showPassphraseExplainer(flow) {
  const sections = [
    ["The short version", "A passphrase is an extra word or sentence you add on top of your seed phrase. It is optional, and most people do not use one."],
    ["It does not lock your account", "This is the part people get wrong. A passphrase does not put a password on your account. It opens a completely different account. Your seed phrase with no passphrase opens one account. The same seed phrase with the word \"apple\" opens another one. With \"banana\", another one again. Every passphrase is its own separate account, with its own address and its own balance."],
    ["Why anyone bothers", "If someone finds your written seed phrase, they get the account it opens on its own. They do not get the one behind your passphrase, because they do not know there is one, and they could not guess it anyway."],
    ["The catch", "There is no reset and no recovery. If you forget your passphrase, the account it opened is gone for good. Your seed phrase alone will not bring it back, and nobody can help you. Treat it exactly like the seed phrase itself: written down, somewhere safe, before you rely on it."],
    ["One more thing to know", "If you type the wrong passphrase, nothing will tell you. You will simply land in a different account, and it will look empty. That is not a bug and your money is not lost - it just means you are in the wrong account."],
    ["So do you need one?", flow.mode === "create"
      ? "If you are not sure, choose No. Your account is still protected by your seed phrase, and you can always create another account with a passphrase later."
      : "If you never set one up, choose No. A passphrase is something you would have typed in on purpose, so if this is the first you are hearing of it, you do not have one."],
  ];
  render(`
    ${navHeader({ title: "What is a passphrase?" })}
    <section class="screen explainer">
      ${sections.map(([title, body]) => `<div><h3>${esc(title)}</h3><p class="muted">${esc(body)}</p></div>`).join("")}
    </section>`, "passphrase");
  $("#back").onclick = () => showPassphraseQuestion(flow);
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
    ${navHeader({ title: "Wallet Password" })}
    <section class="screen">
      <h2>Set a wallet password</h2>
      <p class="muted">This password unlocks KaChat Wallet in this browser and keeps your seed phrase encrypted on this computer. It can't recover your account - only your seed phrase can.</p>
      <input id="pw" type="password" autocomplete="new-password" placeholder="Password (at least ${vault.MIN_PASSWORD_LENGTH} characters)" aria-label="Password" autofocus />
      <input id="pw2" type="password" autocomplete="new-password" placeholder="Re-enter password" aria-label="Re-enter password" />
      <p class="error" id="error"></p>
      <div class="spacer"></div>
      <button id="finish" class="big">Create Account</button>
    </section>`, "password");
  $("#back").onclick = onBack;
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
      await vault.createVault(pw, account);
      createDraft = null;
      noteActivity();
      showHome();
    } catch (err) {
      error.textContent = err.message;
      button.disabled = false;
      button.textContent = "Create Account";
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
