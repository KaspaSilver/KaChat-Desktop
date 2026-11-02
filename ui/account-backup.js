// Backing up an account's seed phrase and passphrase, in plain steps (iOS d063b897 / KaPay 99ab88a
// AccountBackupView): why, getting ready, the words a few at a time, proving they were written down,
// the passphrase and its check if there is one, then where to keep them. And Backup Hygiene
// (BackupHygieneView), six months later: five random words in random order, then the passphrase.
//
// Words are written by hand: this flow never offers a copy (Settings > View Seed Phrase does). The
// seed is read from the vault when a flow opens, held in `flow` while it is open and nowhere else,
// and goes with it: every step redraws the sheet from nothing, so words leave the DOM with their
// step, and closing empties it. Nothing here logs or stores a word.
//
// iOS can warn after a screenshot and hide the words from one (SecureView); a page can do neither.
//
// The logic is in ui/account-backup-status.js. The strings are iOS's, with "phone" read as "device".
import {
  backupStepsFor, wordPageCount, wordPageRange, backupCheckPositions, randomWordPositions,
  wrongWordPositions, normalizedWord, passphraseMatches, HYGIENE_WORDS_TO_CHECK,
} from "./account-backup-status.js";
import { isBip39Word, bip39Matches } from "./bip39-english.js";

let deps = null;
let host = null;
/** The open flow, or null. It alone holds the seed phrase. */
let flow = null;

/**
 * @param {{
 *   status: ReturnType<import("./account-backup-status.js").createAccountBackupStatus>,
 *   activeAddress: () => string,
 *   readSeed: () => ({ words: string[], passphrase: string, passphraseForm: string } | null),
 *   unlockSeed: () => Promise<boolean>,
 *   onStatusChanged: () => void,
 *   setEye: (button: HTMLElement, revealed: boolean) => void,
 * }} dependencies
 */
export function configureAccountBackup(dependencies) { deps = dependencies; }

const svg = (body) => `<svg viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;
// Drawn after the SF Symbols iOS uses on the same lines.
const ICONS = {
  key: svg('<circle cx="12" cy="7.25" r="4.5"/><circle cx="12" cy="5.6" r="1"/><path d="M12 11.75v9l1.9-1.6-1.9-1.6 1.9-1.6-1.9-1.6"/>'),
  noDevice: svg('<rect x="7" y="3" width="10" height="18" rx="2.2"/><path d="M4 4l16 16"/>'),
  noPerson: svg('<circle cx="10" cy="8" r="3.4"/><path d="M4 20c.7-3.6 3-5.4 6-5.4s5.3 1.8 6 5.4"/><path d="m16.5 6.5 4 4M20.5 6.5l-4 4"/>'),
  question: svg('<circle cx="12" cy="12" r="9"/><path d="M9.6 9.3a2.5 2.5 0 0 1 4.85.85c0 1.7-2.45 2.2-2.45 3.85"/><path d="M12 17v.5"/>'),
  paper: svg('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M8.5 13h7M8.5 17h7"/>'),
  noCloud: svg('<path d="M7 18h10a4 4 0 0 0 .7-7.94A6 6 0 0 0 6.2 9.2 4.5 4.5 0 0 0 7 18Z"/><path d="M4 4l16 16"/>'),
  hand: svg('<path d="M7 11V5.5a1.5 1.5 0 0 1 3 0V11"/><path d="M10 10.5V4a1.5 1.5 0 0 1 3 0v6.5"/><path d="M13 10.5V5.5a1.5 1.5 0 0 1 3 0V13"/><path d="M16 9.5a1.5 1.5 0 0 1 3 0V15a6 6 0 0 1-6 6h-1a6 6 0 0 1-6-6v-2.5a1.5 1.5 0 0 1 3 0"/>'),
  split: svg('<rect x="3" y="5" width="7.5" height="14" rx="1.5"/><rect x="13.5" y="5" width="7.5" height="14" rx="1.5"/>'),
  gear: svg('<circle cx="12" cy="12" r="3"/><path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8"/>'),
  shieldCheck: svg('<path d="M12 3l7.5 3v5.5c0 4.5-3 8.2-7.5 9.5-4.5-1.3-7.5-5-7.5-9.5V6z"/><path d="m8.6 12.2 2.4 2.4 4.4-4.6"/>'),
};

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function ensureHost() {
  if (host) return host;
  host = document.createElement("div");
  host.className = "modal-backdrop account-backup-backdrop";
  host.hidden = true;
  host.dataset.accountBackupModal = "";
  host.innerHTML = `
    <section class="contact-modal account-backup-modal" role="dialog" aria-modal="true" aria-labelledby="account-backup-title">
      <header class="account-backup-bar">
        <button class="linklike-button account-backup-bar-button" type="button" data-account-backup-back hidden>Back</button>
        <h2 id="account-backup-title" data-account-backup-title></h2>
        <button class="linklike-button account-backup-bar-button" type="button" data-account-backup-close>Close</button>
      </header>
      <div class="account-backup-scroll" data-account-backup-body></div>
      <div class="account-backup-foot" data-account-backup-foot></div>
    </section>`;
  document.body.appendChild(host);
  // iOS .interactiveDismissDisabled(): only Close closes, so no click outside loses the place.
  host.querySelector("[data-account-backup-close]").addEventListener("click", () => closeAccountBackup());
  host.querySelector("[data-account-backup-back]").addEventListener("click", () => flow?.back?.());
  return host;
}

/** Ends whichever flow is open and empties the sheet. Safe to call with none open. */
export function closeAccountBackup() {
  const closing = flow;
  flow = null;
  if (host) {
    host.hidden = true;
    host.querySelector("[data-account-backup-body]").replaceChildren();
    host.querySelector("[data-account-backup-foot]").replaceChildren();
  }
  closing?.resolve?.();
}

// A page left in the back/forward cache keeps its DOM.
if (typeof window !== "undefined") window.addEventListener("pagehide", () => closeAccountBackup());

function loadSeed() {
  let seed = null;
  try { seed = deps.readSeed(); } catch { seed = null; }
  return seed?.words?.length ? seed : null;
}

function present(title, back) {
  const el = ensureHost();
  el.hidden = false;
  el.querySelector("[data-account-backup-title]").textContent = title;
  const backButton = el.querySelector("[data-account-backup-back]");
  backButton.hidden = !back;
  flow.back = back || null;
  const body = el.querySelector("[data-account-backup-body]");
  const foot = el.querySelector("[data-account-backup-foot]");
  body.replaceChildren();
  foot.replaceChildren();
  body.scrollTop = 0;
  return { body, foot };
}

function addFootButton(foot, title, { enabled = true, action, className = "primary-button full" }) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = title;
  button.disabled = !enabled;
  button.addEventListener("click", action);
  foot.append(button);
  return button;
}

function htmlBlock(html) {
  const block = document.createElement("div");
  block.innerHTML = html;
  return block;
}

const headingHtml = (title, detail) => `<h3 class="account-backup-heading">${esc(title)}</h3>${detail ? `<p class="account-backup-detail">${esc(detail)}</p>` : ""}`;

const pointHtml = (icon, title, detail) => `
  <div class="account-backup-point">
    <span class="account-backup-point-icon" aria-hidden="true">${icon}</span>
    <span class="account-backup-point-copy"><strong>${esc(title)}</strong><span>${esc(detail)}</span></span>
  </div>`;

/** A word field: no autofill, no autocorrect, and spellcheck off so a browser's cloud spellchecker
 *  never sees it. */
function makeWordInput(label, value = "") {
  const input = document.createElement("input");
  input.type = "text";
  input.className = "field-input account-backup-word-input";
  input.value = value;
  input.setAttribute("aria-label", label);
  input.autocomplete = "off";
  input.spellcheck = false;
  input.setAttribute("autocapitalize", "none");
  input.setAttribute("autocorrect", "off");
  input.setAttribute("inputmode", "text");
  input.setAttribute("data-1p-ignore", "");
  input.setAttribute("data-lpignore", "true");
  return input;
}

/** A passphrase field with its eye, as a password field, so nothing offers to remember it by name. */
function makePassphraseField(onInput) {
  const wrap = document.createElement("span");
  wrap.className = "passphrase-field";
  const input = document.createElement("input");
  input.className = "field-input";
  input.type = "password";
  input.placeholder = "Passphrase";
  input.setAttribute("aria-label", "Passphrase");
  input.autocomplete = "off";
  input.spellcheck = false;
  input.setAttribute("autocapitalize", "none");
  input.setAttribute("autocorrect", "off");
  input.setAttribute("data-1p-ignore", "");
  input.setAttribute("data-lpignore", "true");
  const eye = document.createElement("button");
  eye.type = "button";
  eye.className = "passphrase-eye";
  deps.setEye?.(eye, false);
  eye.addEventListener("click", () => {
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    deps.setEye?.(eye, show);
  });
  input.addEventListener("input", () => onInput(input.value));
  wrap.append(input, eye);
  return { wrap, input };
}

// -------------------------------------------------------------------------------------------------
// The backup steps
// -------------------------------------------------------------------------------------------------

/** Opens the steps; resolves when they close, finished or not. */
export function openAccountBackup() {
  closeAccountBackup();
  return new Promise((resolve) => startBackup(resolve));
}

function startBackup(resolve) {
  const seed = loadSeed();
  flow = {
    resolve,
    address: deps.activeAddress(),
    seed,
    step: "why",
    wordPage: 0,
    checklist: { pen: false, nobody: false, noPhotos: false },
    checkPositions: [],
    answers: {},
    wrong: [],
    passphraseAnswer: "",
    passphraseWrong: false,
  };
  if (!seed) {
    const { body } = present("Back Up Account", null);
    body.append(htmlBlock(`<p class="account-backup-unavailable">This account's seed phrase isn't available on this device.</p>`));
    return;
  }
  renderBackupStep();
}

function hasPassphrase() { return Boolean(flow.seed?.passphrase); }

function goTo(step) {
  flow.step = step;
  renderBackupStep();
}

function startWordCheck() {
  flow.checkPositions = backupCheckPositions(flow.seed.words.length);
  flow.answers = {};
  flow.wrong = [];
  goTo("wordCheck");
}

function backupGoBack() {
  switch (flow.step) {
    case "prepare": goTo("why"); break;
    case "explainer": goTo("why"); break;
    case "words":
      if (flow.wordPage > 0) { flow.wordPage -= 1; renderBackupStep(); } else goTo("prepare");
      break;
    case "wordCheck":
      flow.wordPage = wordPageCount(flow.seed.words.length) - 1;
      goTo("words");
      break;
    case "passphrase": startWordCheck(); break;
    case "passphraseCheck": goTo("passphrase"); break;
    case "tips":
      if (hasPassphrase()) { flow.passphraseAnswer = ""; goTo("passphraseCheck"); } else startWordCheck();
      break;
    default: break;
  }
}

function renderBackupStep() {
  const { body, foot } = present(flow.step === "explainer" ? "What is a seed phrase?" : "Back Up Account", flow.step === "why" ? null : backupGoBack);
  if (flow.step !== "explainer") {
    const steps = backupStepsFor(hasPassphrase());
    const progress = document.createElement("div");
    progress.className = "account-backup-progress";
    progress.setAttribute("role", "progressbar");
    progress.setAttribute("aria-valuemin", "1");
    progress.setAttribute("aria-valuemax", String(steps.length));
    progress.setAttribute("aria-valuenow", String(steps.indexOf(flow.step) + 1));
    const fill = document.createElement("span");
    fill.style.width = `${((steps.indexOf(flow.step) + 1) / steps.length) * 100}%`;
    progress.append(fill);
    body.append(progress);
  }
  ({ why: renderWhy, explainer: renderExplainer, prepare: renderPrepare, words: renderWords, wordCheck: renderWordCheck, passphrase: renderPassphrase, passphraseCheck: renderPassphraseCheck, tips: renderTips })[flow.step](body, foot);
}

function renderWhy(body, foot) {
  body.append(htmlBlock(`
    ${headingHtml("Protect your funds")}
    ${pointHtml(ICONS.key, "Your seed phrase is your account", "These secret words are created just for you. They are the master key to your funds.")}
    ${pointHtml(ICONS.noDevice, "Your device can't be your only copy", "If you lose, break or replace this device, these words are the only way back to your account.")}
    ${pointHtml(ICONS.noPerson, "Nobody can reset them", "There is no password reset. KaChat never sees your words, so we can't recover them for you.")}
    <button class="linklike-button account-backup-link" type="button" data-account-backup-explain>${ICONS.question}<span>What is a seed phrase?</span></button>`));
  body.querySelector("[data-account-backup-explain]").addEventListener("click", () => goTo("explainer"));
  addFootButton(foot, "Start Backup", { action: () => goTo("prepare") });
}

// iOS SeedPhraseExplainerPage: moved here from the Create Account steps, without "12 or 24 words?".
function renderExplainer(body) {
  body.append(htmlBlock(`
    <div class="passphrase-explainer account-backup-explainer">
      <section><h4>The short version</h4><p>A seed phrase is a list of 12 or 24 ordinary words that works as the master key to your account. Your wallet, your chatting address and your messages all come from it.</p></section>
      <section><h4>Anyone with it can take everything</h4><p>Anyone who has these words can take everything in your account. If you lose them and lose this device, nobody can get your account back, not even KaChat.</p></section>
      <section><h4>How to keep it safe</h4><p>Write the words on paper, in order, and keep them somewhere safe and private. Never type them into a website, send them in a chat, or keep them in a screenshot or cloud notes.</p></section>
    </div>`));
}

function renderPrepare(body, foot) {
  body.append(htmlBlock(headingHtml("Get ready", "Your secret words are next. Before you see them:")));
  const ready = () => Object.values(flow.checklist).every(Boolean);
  let button = null;
  for (const [key, title] of [["pen", "I have a pen and paper"], ["nobody", "Nobody can see my screen"], ["noPhotos", "I won't take a photo or screenshot"]]) {
    const label = document.createElement("label");
    label.className = "seed-confirm account-backup-check";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = flow.checklist[key];
    box.addEventListener("change", () => {
      flow.checklist[key] = box.checked;
      if (button) button.disabled = !ready();
    });
    const span = document.createElement("span");
    span.textContent = title;
    label.append(box, span);
    body.append(label);
  }
  button = addFootButton(foot, "Show My Seed Phrase", { enabled: ready(), action: () => { flow.wordPage = 0; goTo("words"); } });
}

function renderWords(body, foot) {
  const { words } = flow.seed;
  const [start, end] = wordPageRange(flow.wordPage, words.length);
  const last = flow.wordPage + 1 >= wordPageCount(words.length);
  body.append(htmlBlock(`
    ${headingHtml("Write down these words", "Write them on paper in this exact order, with their numbers.")}
    <p class="account-backup-range">Words ${start + 1} to ${end} of ${words.length}</p>`));
  const list = document.createElement("div");
  list.className = "account-backup-words";
  for (let position = start; position < end; position += 1) {
    const row = document.createElement("div");
    row.className = "account-backup-word";
    const number = document.createElement("span");
    number.className = "account-backup-word-number";
    number.textContent = `${position + 1}.`;
    const word = document.createElement("span");
    word.className = "account-backup-word-text";
    word.textContent = words[position];
    row.append(number, word);
    list.append(row);
  }
  body.append(list);
  addFootButton(foot, last ? "I Wrote Them Down" : "Next Words", {
    action: () => {
      if (last) { startWordCheck(); return; }
      flow.wordPage += 1;
      renderBackupStep();
    },
  });
}

function renderWordCheck(body, foot) {
  const positions = flow.checkPositions;
  body.append(htmlBlock(headingHtml("Check your paper", "Enter these words from what you wrote down, to be sure your copy is right.")));
  const filled = () => positions.every((position) => normalizedWord(flow.answers[position]));
  let button = null;
  const inputs = positions.map((position) => {
    const field = document.createElement("label");
    field.className = "account-backup-field";
    const caption = document.createElement("span");
    caption.textContent = `Word ${position + 1}`;
    const input = makeWordInput(`Word ${position + 1}`, flow.answers[position] || "");
    input.classList.toggle("is-wrong", flow.wrong.includes(position));
    input.addEventListener("input", () => {
      flow.answers[position] = input.value;
      input.classList.remove("is-wrong");
      if (button) button.disabled = !filled();
    });
    input.addEventListener("keydown", (event) => { if (event.key === "Enter" && button && !button.disabled) button.click(); });
    field.append(caption, input);
    body.append(field);
    return input;
  });
  if (flow.wrong.length) {
    body.append(htmlBlock(`<p class="account-backup-error">That doesn't match. Check your paper, or go back to see the words again.</p>
      <button class="linklike-button account-backup-link" type="button" data-account-backup-see-again><span>See My Words Again</span></button>`));
    body.querySelector("[data-account-backup-see-again]").addEventListener("click", () => { flow.wordPage = 0; goTo("words"); });
  }
  button = addFootButton(foot, "Check My Words", {
    enabled: filled(),
    action: () => {
      flow.wrong = wrongWordPositions(flow.seed.words, positions, flow.answers);
      if (flow.wrong.length) { renderBackupStep(); return; }
      if (hasPassphrase()) goTo("passphrase"); else goTo("tips");
    },
  });
  (inputs.find((input) => input.classList.contains("is-wrong")) || inputs[0])?.focus();
}

function renderPassphrase(body, foot) {
  body.append(htmlBlock(headingHtml("Write down your passphrase", "This account also needs its passphrase. Your seed phrase alone won't bring it back. Write it exactly, including capital letters and spaces.")));
  const value = document.createElement("div");
  value.className = "account-backup-passphrase";
  value.textContent = flow.seed.passphrase;
  body.append(value);
  addFootButton(foot, "I Wrote It Down", { action: () => { flow.passphraseAnswer = ""; flow.passphraseWrong = false; goTo("passphraseCheck"); } });
}

function renderPassphraseCheck(body, foot) {
  body.append(htmlBlock(headingHtml("Check your passphrase", "Enter it from what you wrote down. It has to match exactly.")));
  const error = document.createElement("p");
  error.className = "account-backup-error";
  error.textContent = "That doesn't match. Check your paper, or go back to see it again.";
  error.hidden = true;
  let button = null;
  const { wrap, input } = makePassphraseField((value) => {
    flow.passphraseAnswer = value;
    error.hidden = true;
    if (button) button.disabled = !value;
  });
  body.append(wrap, error);
  const check = () => {
    if (!passphraseMatches(flow.passphraseAnswer, flow.seed.passphrase, flow.seed.passphraseForm)) { error.hidden = false; return; }
    flow.passphraseAnswer = "";
    goTo("tips");
  };
  button = addFootButton(foot, "Check My Passphrase", { enabled: false, action: check });
  input.addEventListener("keydown", (event) => { if (event.key === "Enter" && !button.disabled) check(); });
  input.focus();
}

function renderTips(body, foot) {
  body.append(htmlBlock(`
    ${headingHtml("Keep it safe", "Your copy is right. Now keep it that way.")}
    ${pointHtml(ICONS.paper, "Keep it on paper", "Store it somewhere safe and private, away from fire and water.")}
    ${pointHtml(ICONS.noCloud, "Never keep it online", "No photos, screenshots, cloud storage, notes apps, email or chats.")}
    ${pointHtml(ICONS.hand, "Never share it", "Nobody needs your words. KaChat and real support will never ask for them. Anyone who asks is trying to take your funds.")}
    ${hasPassphrase() ? pointHtml(ICONS.split, "Keep your passphrase apart", "Store it away from your seed phrase. You need both, and losing either one loses the account.") : ""}
    ${pointHtml(ICONS.gear, "You can see it again", "Your seed phrase stays available in Settings > View Seed Phrase.")}`));
  addFootButton(foot, "Finish Backup", {
    action: () => {
      confirmBackup();
      closeAccountBackup();
    },
  });
}

function confirmBackup() {
  if (flow?.address) deps.status.markConfirmed(flow.address);
  deps.onStatusChanged?.();
}

// -------------------------------------------------------------------------------------------------
// Backup Hygiene
// -------------------------------------------------------------------------------------------------

/** Checks the written backup still works. Can't Complete This goes through the backup steps again.
 *  Either one starts the six months over; closing leaves the card up. */
export function openBackupHygiene() {
  closeAccountBackup();
  return new Promise((resolve) => {
    const seed = loadSeed();
    flow = { resolve, address: deps.activeAddress(), seed, asked: [], answers: [], active: 0, wrong: false, passphraseAnswer: "" };
    if (!seed) {
      const { body } = present("Backup Hygiene", null);
      body.append(htmlBlock(`<p class="account-backup-unavailable">This account's seed phrase isn't available on this device.</p>`));
      return;
    }
    flow.asked = randomWordPositions(seed.words.length, HYGIENE_WORDS_TO_CHECK);
    flow.answers = flow.asked.map(() => "");
    renderHygieneCheck();
  });
}

async function redoBackupFromHygiene() {
  const open = flow;
  if (!open || !(await deps.unlockSeed())) return;
  if (flow !== open) return;
  // The same promise: whoever opened Backup Hygiene hears when the steps close.
  const { resolve } = open;
  flow = null;
  startBackup(resolve);
}

function addCantComplete(foot) {
  addFootButton(foot, "Can't Complete This", { className: "linklike-button full account-backup-cant", action: redoBackupFromHygiene });
}

function renderHygieneCheck() {
  const { body, foot } = present("Backup Hygiene", null);
  const { asked, answers } = flow;
  body.append(htmlBlock(`
    <p class="account-backup-lead">Let's ensure your account is backed up in case you lose access to your device.</p>
    <p class="account-backup-detail">Enter these ${asked.length} words from your seed phrase. Each box shows the word's number.</p>`));

  const grid = document.createElement("div");
  grid.className = "seed-grid seed-entry-grid account-backup-hygiene-grid";
  const suggestions = document.createElement("div");
  suggestions.className = "seed-entry-suggestions";
  const error = document.createElement("p");
  error.className = "account-backup-error";
  error.textContent = "Some of those words don't match. Check your paper and try again.";
  error.hidden = !flow.wrong;
  let button = null;
  const inputs = [];

  const allFilled = () => answers.every((word) => isBip39Word(word));
  const refresh = () => {
    inputs.forEach((input, slot) => {
      input.classList.toggle("active", slot === flow.active);
      input.classList.toggle("invalid", Boolean(answers[slot]) && !isBip39Word(answers[slot]) && !bip39Matches(answers[slot], 1).length);
    });
    const current = normalizedWord(answers[flow.active]);
    suggestions.replaceChildren(...(current ? bip39Matches(current, 30) : []).map((word) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "seed-suggestion";
      chip.dataset.seedSuggest = word;
      const typed = document.createElement("b");
      typed.textContent = word.slice(0, current.length);
      chip.append(typed, word.slice(current.length));
      return chip;
    }));
    if (button) button.disabled = !allFilled();
  };
  const commit = (word) => {
    answers[flow.active] = word;
    inputs[flow.active].value = word;
    flow.wrong = false;
    error.hidden = true;
    if (flow.active + 1 < inputs.length) flow.active += 1;
    inputs[flow.active].focus();
    refresh();
  };

  asked.forEach((position, slot) => {
    const cell = document.createElement("label");
    cell.className = "seed-grid-cell seed-entry-cell";
    const number = document.createElement("span");
    number.className = "seed-grid-index";
    number.textContent = String(position + 1);
    const input = document.createElement("input");
    input.type = "text";
    input.className = "seed-entry-input";
    input.value = answers[slot];
    input.autocomplete = "off";
    input.spellcheck = false;
    input.setAttribute("aria-label", `Word ${position + 1}`);
    input.setAttribute("autocapitalize", "none");
    input.setAttribute("autocorrect", "off");
    input.setAttribute("data-1p-ignore", "");
    input.setAttribute("data-lpignore", "true");
    input.addEventListener("focus", () => { flow.active = slot; refresh(); });
    input.addEventListener("input", () => {
      answers[slot] = normalizedWord(input.value);
      if (input.value !== answers[slot]) input.value = answers[slot];
      flow.active = slot;
      flow.wrong = false;
      error.hidden = true;
      refresh();
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        const current = normalizedWord(input.value);
        if (isBip39Word(current)) commit(current);
        else if (bip39Matches(current, 1).length) commit(bip39Matches(current, 1)[0]);
      }
    });
    cell.append(number, input);
    grid.append(cell);
    inputs.push(input);
  });
  // A chip takes the click without taking the focus from the field.
  suggestions.addEventListener("mousedown", (event) => {
    const chip = event.target.closest("[data-seed-suggest]");
    if (!chip) return;
    event.preventDefault();
    commit(chip.dataset.seedSuggest);
  });
  body.append(grid, suggestions, error);

  button = addFootButton(foot, "Check My Words", {
    enabled: allFilled(),
    action: () => {
      const correct = asked.every((position, slot) => flow.seed.words[position] === normalizedWord(answers[slot]));
      if (!correct) { flow.wrong = true; error.hidden = false; return; }
      flow.wrong = false;
      if (flow.seed.passphrase) renderHygienePassphrase(); else finishHygiene();
    },
  });
  addCantComplete(foot);
  inputs[flow.active]?.focus();
  refresh();
}

function renderHygienePassphrase() {
  const { body, foot } = present("Backup Hygiene", null);
  flow.passphraseAnswer = "";
  body.append(htmlBlock(`
    <p class="account-backup-lead">Now enter your passphrase</p>
    <p class="account-backup-detail">Your seed phrase alone won't bring this account back. Enter the passphrase from what you wrote down, exactly, including capital letters and spaces.</p>`));
  const error = document.createElement("p");
  error.className = "account-backup-error";
  error.textContent = "That doesn't match. Check your paper and try again.";
  error.hidden = true;
  let button = null;
  const { wrap, input } = makePassphraseField((value) => {
    flow.passphraseAnswer = value;
    error.hidden = true;
    if (button) button.disabled = !value;
  });
  body.append(wrap, error);
  const check = () => {
    if (!passphraseMatches(flow.passphraseAnswer, flow.seed.passphrase, flow.seed.passphraseForm)) { error.hidden = false; return; }
    finishHygiene();
  };
  button = addFootButton(foot, "Check My Passphrase", { enabled: false, action: check });
  input.addEventListener("keydown", (event) => { if (event.key === "Enter" && !button.disabled) check(); });
  addCantComplete(foot);
  input.focus();
}

function finishHygiene() {
  confirmBackup();
  // Past the check nothing here needs the words any more.
  flow.seed = null;
  flow.asked = [];
  flow.answers = [];
  flow.passphraseAnswer = "";
  const { body, foot } = present("Backup Hygiene", null);
  body.append(htmlBlock(`
    <div class="account-backup-passed">
      <span class="account-backup-passed-icon" aria-hidden="true">${ICONS.shieldCheck}</span>
      <h3 class="account-backup-heading">Your backup is good</h3>
      <p class="account-backup-detail">We'll check again in 6 months.</p>
    </div>`));
  addFootButton(foot, "Done", { action: () => closeAccountBackup() });
}
