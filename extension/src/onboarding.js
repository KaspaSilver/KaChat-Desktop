// Everything before the home screen - iOS OnboardingView and the screens it pushes:
//
//   the accounts screen   KaChat wordmark, Saved Accounts (tap to sign in, pencil to rename or
//                         remove), Create New Account, Import Existing Account, App Settings.
//                         Log Out on the Profile screen lands here, as on iOS.
//   create                CreateWalletView -> seed -> PassphraseOptionView
//   import                ImportSourceWalletView -> ImportWalletView -> PassphraseOptionView
//   unlock / reset        the browser's stand-in for Face ID: the wallet password
//
// The first account also sets the wallet password (the vault); later accounts are added to the
// unlocked vault.

import * as vault from "./vault.js";
import * as wallet from "./wallet.js";
import { getLocal, setLocal, removeLocal } from "./browser.js";
import {
  app, esc, render, $, toast, noteActivity, resetActivityPing, ICONS, navHeader, showSheet,
} from "./ui.js";
import { isBip39Word, bip39Matches } from "../../ui/bip39-english.js";
import { removeConnectionsFor } from "./approve.js";

let goHome = () => {};
let goSettings = () => {};
/** popup.js hands over the screens that live outside onboarding. */
export function setHandlers({ home, settings }) {
  goHome = home;
  goSettings = settings;
}

// iOS keeps you signed out after Log Out until you pick an account again, across launches.
const LOGGED_OUT_KEY = "kachat.loggedOut";
const LAST_USED_KEY = "kachat.accountLastUsed";

export async function isLoggedOut() { return Boolean(await getLocal(LOGGED_OUT_KEY)); }
export async function setLoggedOut(value) {
  if (value) await setLocal(LOGGED_OUT_KEY, true);
  else await removeLocal([LOGGED_OUT_KEY]);
}
async function markUsed(accountId) {
  const map = (await getLocal(LAST_USED_KEY)) || {};
  map[accountId] = Date.now();
  await setLocal(LAST_USED_KEY, map);
}

/** After unlocking: the account screen when signed out, otherwise home. */
export async function enterApp() {
  if (await isLoggedOut()) return showWelcome();
  return goHome();
}

// iOS lists the full address truncated in the middle.
function middleTruncate(address) {
  const text = String(address || "");
  return text.length > 34 ? `${text.slice(0, 20)}…${text.slice(-10)}` : text;
}

function shortAddr(address) {
  const text = String(address || "");
  return text.length > 20 ? `${text.slice(0, 10)}...${text.slice(-6)}` : text;
}

// --- welcome / create / import -----------------------------------------------------------

// The KaChat wordmark with the app mark beside it - iOS OnboardingView.titleSection.
function wordmarkHtml(tagline) {
  return `
    <div class="hero">
      <div class="wordmark"><h1>KaChat</h1><img src="icons/kachat-logo.png" alt="KaChat logo" /></div>
      <p class="tagline">${esc(tagline)}</p>
    </div>`;
}

export async function showWelcome() {
  // Saved accounts are listed only while the vault is open - names never sit unencrypted.
  let saved = [];
  if ((await vault.hasVault()) && (await vault.isUnlocked())) {
    const view = await vault.readAccounts().catch(() => null);
    const used = (await getLocal(LAST_USED_KEY)) || {};
    if (view) {
      saved = await Promise.all(view.accounts.map(async (account) => ({
        ...account,
        address: (await wallet.cachedAddresses(account.id))?.main || null,
        lastUsed: used[account.id] || account.createdAt || 0,
      })));
      saved.sort((a, b) => b.lastUsed - a.lastUsed);
    }
  }
  render(`
    <section class="onboard">
      <button class="icon onboard-gear" id="app-settings" aria-label="App Settings" title="App Settings">${ICONS.gearshape}</button>
      ${wordmarkHtml("Secure Kaspa wallet on the BlockDAG")}
      ${saved.length ? `
        <div class="saved">
          <div class="saved-header">Saved Accounts</div>
          <div class="saved-list">
            ${saved.map((account) => `
              <div class="saved-row">
                <button class="saved-main" data-sign-in="${esc(account.id)}">
                  <span class="saved-icon">${ICONS.personCheck}</span>
                  <span class="saved-text"><span class="saved-name">${esc(account.name)}</span><span class="saved-address" title="${esc(account.address || "")}">${esc(account.address ? middleTruncate(account.address) : "Address not derived yet")}</span></span>
                </button>
                <button class="icon plain saved-edit" data-edit="${esc(account.id)}" aria-label="Edit ${esc(account.name)}">${ICONS.pencilCircle}</button>
              </div>`).join("")}
          </div>
        </div>` : ""}
      <div class="buttons">
        <button id="create">${ICONS.plusCircle}<span>Create New Account</span></button>
        <button id="import" class="secondary">${ICONS.download}<span>Import Existing Account</span></button>
      </div>
    </section>`, "accounts");
  $("#app-settings").onclick = () => goSettings({ appSettings: true, onBack: showWelcome });
  $("#create").onclick = () => { createDraft = null; showCreate(); };
  $("#import").onclick = () => { importDraft = null; showImportSource(); };
  for (const button of app.querySelectorAll("[data-sign-in]")) {
    button.onclick = async () => {
      button.disabled = true;
      try {
        await vault.switchAccount(button.dataset.signIn);
        await markUsed(button.dataset.signIn);
        await setLoggedOut(false);
        noteActivity();
        goHome();
      } catch (error) {
        toast(error.message || "Unable to sign in to this account.");
        button.disabled = false;
      }
    };
  }
  for (const button of app.querySelectorAll("[data-edit]")) {
    const account = saved.find((a) => a.id === button.dataset.edit);
    button.onclick = () => showSheet({
      title: account.name,
      subtitle: shortAddr(account.address),
      rows: [
        { label: "Rename", subtitle: "Gives this account a name of your own.", icon: ICONS.pencil, onClick: () => showRenameAccount(account) },
        { label: "Delete", subtitle: "Removes this account and its local data from this browser.", icon: ICONS.trash, danger: true, onClick: () => confirmRemoveAccount(account, saved.length) },
      ],
    });
  }
}

function showRenameAccount(account) {
  render(`
    ${navHeader({ title: "Rename Account" })}
    <section class="screen">
      <form id="form" class="stack">
        <p class="muted">Enter a new name for this saved account.</p>
        <input id="name" value="${esc(account.name)}" placeholder="Account name" maxlength="40" autocomplete="off" autofocus />
        <button type="submit" id="save">Save</button>
      </form>
    </section>`, "rename-account");
  $("#back").onclick = showWelcome;
  $("#name").select();
  $("#form").onsubmit = async (event) => {
    event.preventDefault();
    const name = $("#name").value.trim();
    if (name && name !== account.name) {
      await vault.renameAccount(account.id, name);
      toast("Account renamed.");
    }
    showWelcome();
  };
}

function confirmRemoveAccount(account, count) {
  showSheet({
    title: "Remove Saved Account",
    rows: [{
      label: "Remove from Device",
      subtitle: `Deletes ${account.name} (${shortAddr(account.address)}) and its local data from this browser.`,
      icon: ICONS.trash,
      danger: true,
      onClick: async () => {
        try {
          if (count <= 1) {
            // The last account: nothing is left to seal, so the vault goes too.
            await vault.resetWallet();
            await setLoggedOut(false);
          } else {
            await vault.removeAccount(account.id);
          }
          // Both networks' data (iOS removeSavedAccount clears both encodings).
          const keys = ["spending", "addresses", "cold", "portfolios", "portfolioFees"].map((k) => `kachat.${k}.${account.id}`);
          await removeLocal([...keys, ...keys.map((k) => `${k}.testnet`)]);
          await removeConnectionsFor(account.id);
          await wallet.disconnect();
          toast("Account removed.");
        } catch (error) {
          toast(error.message);
        }
        showWelcome();
      },
    }],
  });
}

/**
 * The last step of create and import. The first account also chooses the wallet password;
 * after that, accounts go straight into the unlocked vault.
 */
async function finishAccount(account, onBack, buttonLabel) {
  if (await vault.hasVault()) {
    if (!(await vault.isUnlocked())) return showUnlock();
    try {
      const view = await vault.addAccount(account);
      await markUsed(view.activeAccountId);
      await setLoggedOut(false);
      createDraft = null;
      importDraft = null;
      noteActivity();
      goHome();
    } catch (error) {
      toast(error.message);
    }
    return;
  }
  showSetPassword(account, onBack, buttonLabel);
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
  flow.onProceed = (passphrase) => finishAccount(
    { mnemonic: d.phrase, passphrase, family: "kaspaStandard", name: d.name.trim() },
    () => showPassphraseQuestion(flow),
    "Create Account",
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
        <div class="muted small">Your chatting address</div>
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

// --- import account: iOS ImportSourceWalletView -> ImportWalletView -> PassphraseOptionView ---

// Where the phrase came from decides the chatting address's derivation path. Same list, order,
// names and paths as iOS; KaChat (standard) is the default.
const SOURCE_ICONS = {
  bubbles: '<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 5.5A2.5 2.5 0 0 1 5.5 3h8A2.5 2.5 0 0 1 16 5.5v5a2.5 2.5 0 0 1-2.5 2.5H8l-3.5 3V13A2.5 2.5 0 0 1 3 10.5z" fill="currentColor"/><path d="M18 8h.5A2.5 2.5 0 0 1 21 10.5v5a2.5 2.5 0 0 1-1.5 2.3V21l-3.2-2.5H11A2.5 2.5 0 0 1 8.6 16" fill="currentColor" opacity=".75"/></svg>',
  puzzle: '<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3a2 2 0 0 1 2 2v1h4a1 1 0 0 1 1 1v4h1a2 2 0 1 1 0 4h-1v4a1 1 0 0 1-1 1h-4v-1a2 2 0 1 0-4 0v1H3v-6h1a2 2 0 1 0 0-4H3V7a1 1 0 0 1 1-1h3V5a2 2 0 0 1 2-2z" fill="currentColor"/></svg>',
  phone: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="6" y="2" width="12" height="20" rx="3"/><path d="M10.5 18.5h3" stroke-linecap="round"/></svg>',
  shield: '<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2l8 3v6c0 5-3.4 9.3-8 11-4.6-1.7-8-6-8-11V5l8-3z" fill="currentColor"/></svg>',
  desktop: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="2.5" y="3.5" width="19" height="13" rx="2"/><path d="M8 21h8M12 16.5V21"/></svg>',
  terminal: '<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><rect x="2" y="3.5" width="20" height="17" rx="3" fill="currentColor"/><path d="M6.5 9l3 3-3 3M11.5 15.5h5" fill="none" stroke="var(--bg)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  grid: '<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="8" height="8" rx="2" fill="currentColor"/><rect x="13" y="3" width="8" height="8" rx="2" fill="currentColor"/><rect x="3" y="13" width="8" height="8" rx="2" fill="currentColor"/><rect x="13" y="13" width="8" height="8" rx="2" fill="currentColor"/></svg>',
  key: '<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><circle cx="7.5" cy="15.5" r="5" fill="currentColor"/><circle cx="7.5" cy="15.5" r="1.8" fill="var(--bg)"/><path d="M11 12L20.5 2.5M16 7l3 3M18.3 4.7l2.2 2.2" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>',
  drive: '<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><path d="M5.5 4h13l3 9v5a2 2 0 0 1-2 2h-15a2 2 0 0 1-2-2v-5z" fill="currentColor"/><path d="M2.5 13h19" stroke="var(--bg)" stroke-width="1.5"/><circle cx="17.5" cy="16.5" r="1.2" fill="var(--bg)"/></svg>',
};
const IMPORT_SOURCES = [
  { id: "kachat", name: "KaChat", icon: "bubbles", family: "kaspaStandard", isDefault: true },
  { id: "kasware", name: "KasWare Wallet", icon: "puzzle", family: "kaspaStandard" },
  { id: "kaspium", name: "Kaspium Wallet", icon: "phone", family: "kaspaStandard" },
  { id: "kastle", name: "Kastle Wallet", icon: "shield", family: "kaspaStandard" },
  { id: "kdx", name: "KDX Wallet", icon: "desktop", family: "kaspaLegacy972" },
  { id: "cli", name: "Core Golang Cli Wallet", icon: "terminal", family: "kaspaStandard" },
  { id: "okx", name: "OKX Wallet", icon: "grid", family: "kaspaStandard" },
  { id: "onekey", name: "OneKey Wallet", icon: "key", family: "oneKey" },
  { id: "ledger", name: "Ledger Wallet", icon: "drive", family: "kaspaStandard" },
];
const FAMILY_PATHS = {
  kaspaStandard: "m/44'/111111'/0'",
  kaspaLegacy972: "m/44'/972/0'",
  oneKey: "m/44'/111111'/0' (OneKey)",
};

let importDraft = null;
function freshImportDraft() {
  // As with Create Account, nothing is preset: no name and no word count until one is chosen
  // (pasting a phrase picks the count for you).
  return { sourceId: "kachat", family: "kaspaStandard", name: "", wordCount: null, words: Array(24).fill(""), active: 0 };
}

function showImportSource() {
  if (!importDraft) importDraft = freshImportDraft();
  const d = importDraft;
  render(`
    ${navHeader({ title: "Import Account" })}
    <section class="screen import-source">
      <div class="source-head">
        <span class="source-head-icon">${ICONS.wallet}</span>
        <h2>Where is this seed phrase from?</h2>
        <p class="muted">Different wallets store your Kaspa on different address paths. Pick where this seed phrase comes from so KaChat finds your funds and domains.</p>
      </div>
      <div class="source-list" role="radiogroup" aria-label="Wallet">
        ${IMPORT_SOURCES.map((source) => `
          <button class="source-row" role="radio" data-source="${source.id}" aria-checked="${d.sourceId === source.id}">
            <span class="source-radio">${d.sourceId === source.id ? ICONS.circleCheck : ICONS.circle}</span>
            <span class="source-icon">${SOURCE_ICONS[source.icon]}</span>
            <span class="source-text">
              <span class="source-name">${esc(source.name)}${source.isDefault ? '<span class="source-default">Default</span>' : ""}</span>
              <span class="source-path">${esc(FAMILY_PATHS[source.family])}</span>
            </span>
          </button>`).join("")}
      </div>
      <button id="continue" class="with-icon">${ICONS.arrowRightCircle}<span>Continue</span></button>
    </section>`, "import");
  $("#back").onclick = () => { importDraft = null; showWelcome(); };
  for (const row of app.querySelectorAll("[data-source]")) {
    row.onclick = () => {
      const source = IMPORT_SOURCES.find((s) => s.id === row.dataset.source);
      d.sourceId = source.id;
      d.family = source.family;
      const scroll = app.querySelector(".source-list")?.scrollTop || 0;
      showImportSource();
      const list = app.querySelector(".source-list");
      if (list) list.scrollTop = scroll;
    };
  }
  $("#continue").onclick = showImportWords;
}

// The seed words go into a numbered grid, one word per slot, with the BIP39 suggestions bar -
// iOS SeedPhraseKeyboardView. A letter that no BIP39 word continues with is refused (the iOS
// keyboard greys those keys out), an exact unique word moves on by itself, and Space or Enter
// takes the top suggestion.
function importWordsValid(d) {
  if (!d.wordCount) return 0;
  return d.words.slice(0, d.wordCount).filter((w) => isBip39Word(w)).length;
}
function canImport(d) {
  return Boolean(d.wordCount) && importWordsValid(d) === d.wordCount && Boolean(d.name.trim());
}

/** iOS ImportWalletView.pasteFromClipboard, same rules and messages. */
function parsePastedPhrase(text) {
  const tokens = String(text || "").toLowerCase().split(/[\s,]+/)
    .map((t) => t.replace(/[.)]+$/, ""))
    .filter((t) => t && !/^\d+$/.test(t));
  if (!tokens.length) throw new Error("Nothing to paste.");
  if (tokens.length !== 12 && tokens.length !== 24) throw new Error(`A recovery phrase is 12 or 24 words - the clipboard holds ${tokens.length}.`);
  const unknown = tokens.filter((t) => !isBip39Word(t));
  if (unknown.length) throw new Error(`Not a recovery phrase word: ${unknown.slice(0, 3).join(", ")}.`);
  return tokens;
}

function showImportWords() {
  const d = importDraft || (importDraft = freshImportDraft());
  const count = d.wordCount;
  const valid = importWordsValid(d);
  render(`
    ${navHeader({ title: "Import Account" })}
    <section class="screen import-words">
      <div class="field-group">
        <h3>Account Name</h3>
        <input id="name" value="${esc(d.name)}" placeholder="Enter account name" maxlength="40" autocomplete="off" />
      </div>
      <div class="segmented" role="radiogroup" aria-label="Seed Phrase Length">
        <button type="button" role="radio" data-words="12" aria-checked="${count === 12}">12 words</button>
        <button type="button" role="radio" data-words="24" aria-checked="${count === 24}">24 words</button>
      </div>
      <div class="words-head">
        <span>Enter your recovery phrase</span>
        <button class="mini-button" id="paste" type="button">${ICONS.clipboard}<span>Paste</span></button>
        <span class="words-count ${count && valid === count ? "good" : ""}" id="count">${count ? `${valid}/${count}` : ""}</span>
      </div>
      ${count ? `
        <div class="word-grid">
          ${Array.from({ length: count }, (_, i) => `
            <label class="word-slot ${d.words[i] && !isBip39Word(d.words[i]) ? "invalid" : ""}">
              <span class="n">${i + 1}</span>
              <input data-i="${i}" value="${esc(d.words[i])}" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="Word ${i + 1}" />
            </label>`).join("")}
        </div>
        <div class="suggest" id="suggest" aria-label="Suggestions"></div>`
        : '<p class="muted small">Choose 12 or 24 words, or paste your recovery phrase.</p>'}
      <p class="error" id="error"></p>
      <button id="continue" class="with-icon" ${canImport(d) ? "" : "disabled"}>${ICONS.arrowRightCircle}<span>Continue</span></button>
    </section>`, "import");
  $("#back").onclick = showImportSource;

  const refresh = () => {
    const n = importWordsValid(d);
    const counter = $("#count");
    if (counter && d.wordCount) {
      counter.textContent = `${n}/${d.wordCount}`;
      counter.classList.toggle("good", n === d.wordCount);
    }
    $("#continue").disabled = !canImport(d);
  };
  const name = $("#name");
  name.oninput = () => { d.name = name.value; refresh(); };

  for (const option of app.querySelectorAll(".segmented button")) {
    option.onclick = () => {
      d.wordCount = Number(option.dataset.words);
      d.active = Math.min(d.active, d.wordCount - 1);
      showImportWords();
      focusSlot(d.active);
    };
  }

  const applyPaste = (text) => {
    try {
      const tokens = parsePastedPhrase(text);
      d.wordCount = tokens.length;
      d.words = [...tokens, ...Array(24 - tokens.length).fill("")];
      d.active = tokens.length - 1;
      // iOS clears the clipboard once the phrase is in.
      navigator.clipboard.writeText("").catch(() => {});
      showImportWords();
    } catch (error) {
      $("#error").textContent = error.message;
    }
  };
  $("#paste").onclick = async () => {
    $("#error").textContent = "";
    try {
      applyPaste(await navigator.clipboard.readText());
    } catch {
      $("#error").textContent = "Clipboard unavailable - click a word box and paste with ⌘V / Ctrl+V.";
    }
  };

  if (!count) return;
  const inputs = [...app.querySelectorAll(".word-slot input")];
  const suggest = $("#suggest");
  function focusSlot(i) {
    const input = app.querySelectorAll(".word-slot input")[i];
    if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
  }
  const showSuggestions = (i) => {
    const prefix = d.words[i] || "";
    const matches = prefix && !isBip39Word(prefix) ? bip39Matches(prefix, 30) : prefix ? bip39Matches(prefix, 30).filter((w) => w !== prefix) : [];
    suggest.innerHTML = matches.map((w) => `<button type="button" class="chip-word" data-word="${esc(w)}"><b>${esc(prefix)}</b>${esc(w.slice(prefix.length))}</button>`).join("");
    for (const chip of suggest.querySelectorAll("[data-word]")) {
      chip.onmousedown = (event) => event.preventDefault(); // keep the slot focused
      chip.onclick = () => commit(i, chip.dataset.word);
    }
  };
  const commit = (i, word) => {
    d.words[i] = word;
    inputs[i].value = word;
    inputs[i].closest(".word-slot").classList.remove("invalid");
    refresh();
    if (i < d.wordCount - 1) focusSlot(i + 1);
    else showSuggestions(i);
  };
  inputs.forEach((input, i) => {
    input.onfocus = () => {
      d.active = i;
      for (const slot of app.querySelectorAll(".word-slot")) slot.classList.remove("active");
      input.closest(".word-slot").classList.add("active");
      input.closest(".word-slot").classList.remove("invalid");
      showSuggestions(i);
    };
    input.onblur = () => {
      input.closest(".word-slot").classList.remove("active");
      input.closest(".word-slot").classList.toggle("invalid", Boolean(d.words[i]) && !isBip39Word(d.words[i]));
    };
    input.onpaste = (event) => {
      const text = event.clipboardData?.getData("text") || "";
      if (/\s/.test(text.trim())) { event.preventDefault(); applyPaste(text); }
    };
    input.oninput = () => {
      const typed = input.value.toLowerCase().replace(/[^a-z]/g, "");
      // No BIP39 word continues this way: refuse the letter, as the iOS keyboard does.
      if (typed && !bip39Matches(typed, 1).length) {
        input.value = d.words[i];
        return;
      }
      input.value = typed;
      d.words[i] = typed;
      refresh();
      const matches = bip39Matches(typed, 2);
      if (matches.length === 1 && matches[0] === typed) return commit(i, typed);
      showSuggestions(i);
    };
    input.onkeydown = (event) => {
      if (event.key === " " || event.key === "Enter") {
        event.preventDefault();
        const typed = d.words[i];
        if (isBip39Word(typed)) return commit(i, typed);
        const first = typed ? bip39Matches(typed, 1)[0] : null;
        if (first) commit(i, first);
        else if (event.key === "Enter" && canImport(d)) $("#continue").click();
      } else if (event.key === "Backspace" && !input.value && i > 0) {
        event.preventDefault();
        focusSlot(i - 1);
      }
    };
  });

  $("#continue").onclick = async () => {
    if (!canImport(d)) return;
    const button = $("#continue");
    button.disabled = true;
    $("#error").textContent = "";
    let phrase;
    try {
      phrase = await wallet.validateRecoveryPhrase(d.words.slice(0, d.wordCount).join(" "));
    } catch {
      $("#error").textContent = "This recovery phrase is invalid. Double-check the words - the last word encodes a checksum, so one wrong word fails validation.";
      button.disabled = false;
      return;
    }
    const flow = { mode: "import", phrase, family: d.family, onBack: showImportWords, onProceed: null };
    flow.onProceed = (passphrase) => finishAccount(
      { mnemonic: phrase, passphrase, family: d.family, name: d.name.trim(), imported: true },
      () => showPassphraseQuestion(flow),
      "Import Account",
    );
    showPassphraseQuestion(flow);
  };
  if (document.activeElement === document.body) focusSlot(Math.min(d.active, count - 1));
}

function showSetPassword(account, onBack, buttonLabel = "Create Account") {
  render(`
    ${navHeader({ title: "Wallet Password" })}
    <section class="screen">
      <h2>Set a wallet password</h2>
      <p class="muted">This password unlocks KaChat Wallet in this browser and keeps your seed phrase encrypted on this computer. It can't recover your account - only your seed phrase can.</p>
      <input id="pw" type="password" autocomplete="new-password" placeholder="Password (at least ${vault.MIN_PASSWORD_LENGTH} characters)" aria-label="Password" autofocus />
      <input id="pw2" type="password" autocomplete="new-password" placeholder="Re-enter password" aria-label="Re-enter password" />
      <p class="error" id="error"></p>
      <div class="spacer"></div>
      <button id="finish" class="big">${esc(buttonLabel)}</button>
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
      const view = await vault.createVault(pw, account);
      await markUsed(view.activeAccountId);
      await setLoggedOut(false);
      createDraft = null;
      importDraft = null;
      noteActivity();
      goHome();
    } catch (err) {
      error.textContent = err.message;
      button.disabled = false;
      button.textContent = buttonLabel;
    }
  };
}

// --- unlock / reset ----------------------------------------------------------------------

export function showUnlock() {
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
      resetActivityPing();
      noteActivity();
      enterApp();
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
    await setLoggedOut(false);
    await removeConnectionsFor(null);
    await wallet.disconnect();
    showWelcome();
  };
}

