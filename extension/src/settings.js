// Settings - iOS SettingsView, cut down to the wallet. The pages kept, in the iOS order:
//
//   Customization    Currency (iOS also has Appearance and Language; the extension is dark and
//                    English only for now)
//   Security         Auto-Lock and Change Password - the browser's stand-ins for the three Face ID
//                    toggles: every secret is behind the wallet password instead
//   Connection       Connection Settings (KNS API, Kaspa REST API, Kaspa Node, Node Address Book)
//                    and Kaspa Explorer
//   Connected Sites  the extension's own addition: websites connected through window.kachat
//   View Seed Phrase the password, then iOS SeedPhraseView
//
// Chat-only pages (Notifications, Chats, Contacts, Storage, Chat History, Danger Zone,
// Diagnostics) are left out. "App Settings" - the gear on the accounts screen - is the same list
// without View Seed Phrase, as on iOS.

import * as vault from "./vault.js";
import * as wallet from "./wallet.js";
import { ext, tellBackground } from "./browser.js";
import {
  app, esc, render, $, toast, copyText, copySecret, settings, saveSettings, ICONS, navHeader, passwordGate,
} from "./ui.js";
import { ENDPOINT_DEFAULTS, getEndpoint, getEndpointOverride, setEndpoint } from "../../engine/endpoints.js";
import { connections, removeConnection } from "./approve.js";

// iOS AppCurrency, same order and codes (the code is CoinGecko's vs_currency).
export const CURRENCIES = [
  ["US Dollar", "usd"], ["Euro", "eur"], ["British Pound", "gbp"], ["Japanese Yen", "jpy"],
  ["Chinese Yuan", "cny"], ["Australian Dollar", "aud"], ["Canadian Dollar", "cad"], ["Swiss Franc", "chf"],
  ["Hong Kong Dollar", "hkd"], ["Indian Rupee", "inr"], ["South Korean Won", "krw"], ["Singapore Dollar", "sgd"],
  ["Indonesian Rupiah", "idr"], ["New Zealand Dollar", "nzd"], ["Mexican Peso", "mxn"], ["Brazilian Real", "brl"],
  ["Russian Ruble", "rub"], ["Turkish Lira", "try"], ["South African Rand", "zar"], ["Bitcoin", "btc"],
];

const AUTO_LOCK_CHOICES = [[1, "1 minute"], [5, "5 minutes"], [15, "15 minutes"], [30, "30 minutes"], [60, "1 hour"], [240, "4 hours"]];
const DEFAULT_AUTO_LOCK = 15;

function currencyLabel(code) {
  const entry = CURRENCIES.find(([, c]) => c === code) || CURRENCIES[0];
  return `${entry[0]} (${entry[1].toUpperCase()})`;
}

function rowHtml(id, icon, label, value = "", danger = false) {
  return `
    <button class="list-row settings-row ${danger ? "danger-text" : ""}" id="${id}">
      <span class="settings-label">${icon}<span>${esc(label)}</span></span>
      <span class="settings-value">${value ? `<span class="muted">${esc(value)}</span>` : ""}${danger ? "" : ICONS.chevron}</span>
    </button>`;
}

/**
 * @param {object} opts
 * @param {Function} opts.onBack
 * @param {boolean} [opts.appSettings]  the accounts screen's gear: no account-specific rows
 */
export async function showSettings(opts) {
  const { onBack, appSettings = false } = opts;
  const back = () => showSettings(opts);
  render(`
    ${navHeader({ title: appSettings ? "App Settings" : "Settings" })}
    <section class="screen settings">
      <div class="glass list">
        ${rowHtml("customization", ICONS.paintbrush, "Customization")}
        ${rowHtml("security", ICONS.lockShieldSmall, "Security")}
        ${rowHtml("connection", ICONS.antenna, "Connection")}
        ${appSettings ? "" : rowHtml("sites", ICONS.safari, "Connected Sites")}
      </div>
      ${appSettings ? "" : `<div class="glass list">${rowHtml("seed", ICONS.key, "View Seed Phrase", "", true)}</div>`}
    </section>`, "settings");
  $("#back").onclick = onBack;
  $("#customization").onclick = () => showCustomization({ onBack: back });
  $("#security").onclick = () => showSecurity({ onBack: back, appSettings });
  $("#connection").onclick = () => showConnectionHub({ onBack: back });
  const sites = $("#sites");
  if (sites) sites.onclick = () => showConnectedSites({ onBack: back });
  const seed = $("#seed");
  if (seed) seed.onclick = () => passwordGate({
    title: "View Seed Phrase",
    message: "Enter your wallet password to view your seed phrase.",
    verify: (password) => vault.verifyPassword(password),
    onBack: back,
    onUnlocked: (password) => showSeedPhrase({ password, onBack: back }),
  });
}

// --- Customization ------------------------------------------------------------------------

async function showCustomization({ onBack }) {
  const current = (await settings()).currency || "usd";
  render(`
    ${navHeader({ title: "Customization" })}
    <section class="screen settings">
      <div class="section-header">Customization</div>
      <div class="glass list">
        ${rowHtml("currency", "", "Currency", currencyLabel(current))}
      </div>
      <p class="form-footer">Used for the value shown beside amounts. Prices come from CoinGecko.</p>
    </section>`, "settings");
  $("#back").onclick = onBack;
  $("#currency").onclick = () => showCurrencyPicker({ current, onBack: () => showCustomization({ onBack }) });
}

function showCurrencyPicker({ current, onBack }) {
  render(`
    ${navHeader({ title: "Currency" })}
    <section class="screen settings">
      <div class="glass list" role="radiogroup" aria-label="Currency">
        ${CURRENCIES.map(([name, code]) => `
          <button class="list-row" role="radio" data-code="${code}" aria-checked="${code === current}">
            <span>${esc(name)} (${code.toUpperCase()})</span>${code === current ? `<span class="accent">${ICONS.checkmark}</span>` : ""}
          </button>`).join("")}
      </div>
    </section>`, "settings");
  $("#back").onclick = onBack;
  for (const row of app.querySelectorAll("[data-code]")) {
    row.onclick = async () => {
      await saveSettings({ currency: row.dataset.code });
      onBack();
    };
  }
}

// --- Security -----------------------------------------------------------------------------

async function showSecurity({ onBack, appSettings }) {
  const minutes = Number((await settings()).autoLockMinutes) || DEFAULT_AUTO_LOCK;
  const unlocked = (await vault.hasVault()) && (await vault.isUnlocked());
  const label = (AUTO_LOCK_CHOICES.find(([m]) => m === minutes) || [0, `${minutes} minutes`])[1];
  render(`
    ${navHeader({ title: "Security" })}
    <section class="screen settings">
      <div class="section-header">Security</div>
      <div class="glass list">
        ${rowHtml("autolock", "", "Auto-Lock", label)}
        ${unlocked ? rowHtml("password", "", "Change Password") : ""}
      </div>
      <p class="form-footer">KaChat Wallet locks itself after this long without use, and whenever the browser closes. Your seed phrase and private keys always ask for the wallet password.</p>
    </section>`, "settings");
  $("#back").onclick = onBack;
  const again = () => showSecurity({ onBack, appSettings });
  $("#autolock").onclick = () => showAutoLockPicker({ current: minutes, onBack: again });
  const password = $("#password");
  if (password) password.onclick = () => showChangePassword({ onBack: again });
}

function showAutoLockPicker({ current, onBack }) {
  render(`
    ${navHeader({ title: "Auto-Lock" })}
    <section class="screen settings">
      <div class="glass list" role="radiogroup" aria-label="Auto-Lock">
        ${AUTO_LOCK_CHOICES.map(([value, text]) => `
          <button class="list-row" role="radio" data-minutes="${value}" aria-checked="${value === current}">
            <span>${esc(text)}</span>${value === current ? `<span class="accent">${ICONS.checkmark}</span>` : ""}
          </button>`).join("")}
      </div>
    </section>`, "settings");
  $("#back").onclick = onBack;
  for (const row of app.querySelectorAll("[data-minutes]")) {
    row.onclick = async () => {
      await saveSettings({ autoLockMinutes: Number(row.dataset.minutes) });
      tellBackground({ type: "activity" }); // re-arms the alarm with the new length
      onBack();
    };
  }
}

function showChangePassword({ onBack }) {
  render(`
    ${navHeader({ title: "Change Password" })}
    <section class="screen">
      <form id="form" class="stack">
        <input id="current" type="password" autocomplete="current-password" placeholder="Current password" aria-label="Current password" autofocus />
        <input id="next" type="password" autocomplete="new-password" placeholder="New password (at least ${vault.MIN_PASSWORD_LENGTH} characters)" aria-label="New password" />
        <input id="next2" type="password" autocomplete="new-password" placeholder="Re-enter new password" aria-label="Re-enter new password" />
        <p class="muted small">The new password unlocks this wallet in this browser from now on. Your seed phrases are re-encrypted with it.</p>
        <p class="error" id="error"></p>
        <button type="submit" id="save">Change Password</button>
      </form>
    </section>`, "settings");
  $("#back").onclick = onBack;
  $("#form").onsubmit = async (event) => {
    event.preventDefault();
    const error = $("#error");
    error.textContent = "";
    const next = $("#next").value;
    if (next.length < vault.MIN_PASSWORD_LENGTH) { error.textContent = `Use at least ${vault.MIN_PASSWORD_LENGTH} characters.`; return; }
    if (next !== $("#next2").value) { error.textContent = "The passwords don't match."; return; }
    const button = $("#save");
    button.disabled = true;
    button.innerHTML = '<span class="spinner"></span> Encrypting…';
    try {
      await vault.changePassword($("#current").value, next);
      toast("Password changed.");
      onBack();
    } catch (err) {
      error.textContent = err.message;
      button.disabled = false;
      button.textContent = "Change Password";
    }
  };
}

// --- Connection ---------------------------------------------------------------------------

function showConnectionHub({ onBack }) {
  const explorer = wallet.EXPLORERS[wallet.currentExplorer()].name;
  render(`
    ${navHeader({ title: "Connection" })}
    <section class="screen settings">
      <div class="section-header">Connection</div>
      <div class="glass list">
        ${rowHtml("connection-settings", ICONS.antenna, "Connection Settings")}
        ${rowHtml("explorer", ICONS.safari, "Kaspa Explorer", explorer)}
      </div>
    </section>`, "settings");
  $("#back").onclick = onBack;
  const again = () => showConnectionHub({ onBack });
  $("#connection-settings").onclick = () => showConnectionSettings({ onBack: again });
  $("#explorer").onclick = () => showExplorerPicker({ onBack: again });
}

function showExplorerPicker({ onBack }) {
  const current = wallet.currentExplorer();
  render(`
    ${navHeader({ title: "Kaspa Explorer" })}
    <section class="screen settings">
      <div class="section-header">Explorer</div>
      <div class="glass list" role="radiogroup" aria-label="Explorer">
        ${Object.entries(wallet.EXPLORERS).map(([id, entry]) => `
          <button class="list-row" role="radio" data-explorer="${id}" aria-checked="${id === current}">
            <span>${esc(entry.name)}</span>${id === current ? `<span class="accent">${ICONS.checkmark}</span>` : ""}
          </button>`).join("")}
      </div>
      <p class="form-footer">Used to build "view transaction" links throughout the app.</p>
    </section>`, "settings");
  $("#back").onclick = onBack;
  for (const row of app.querySelectorAll("[data-explorer]")) {
    row.onclick = async () => {
      wallet.useExplorer(row.dataset.explorer);
      await saveSettings({ explorer: row.dataset.explorer });
      onBack();
    };
  }
}

/** "wss://host[:port][/path]" or "host:port" (made wss://). Null when it is neither. */
function normalizeNodeAddress(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;
  if (/^ws:\/\//i.test(text)) return { error: "Use wss. Unencrypted connections are not supported." };
  const candidate = /^wss:\/\//i.test(text) ? text : /^[a-z0-9.-]+:\d{2,5}(\/.*)?$/i.test(text) ? `wss://${text}` : null;
  if (!candidate) return { error: "Enter as wss://host or host:port" };
  try {
    const url = new URL(candidate);
    if (url.protocol !== "wss:" || !url.hostname) return { error: "Enter as wss://host or host:port" };
    return { value: candidate.replace(/\/+$/, "") };
  } catch {
    return { error: "Enter as wss://host or host:port" };
  }
}

/** "https://host" (https:// is added when left off). */
function normalizeHttpsUrl(raw, fallback) {
  const text = String(raw || "").trim();
  if (!text) return { value: fallback };
  if (/^http:\/\//i.test(text)) return { error: "Use https. Unencrypted connections are not supported." };
  const candidate = /^https:\/\//i.test(text) ? text : `https://${text}`;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "https:") return { error: "Use https. Unencrypted connections are not supported." };
    return { value: candidate.replace(/\/+$/, "") };
  } catch {
    return { error: "Enter a valid https:// address." };
  }
}

async function showConnectionSettings({ onBack }) {
  const stored = await settings();
  const book = Array.isArray(stored.nodeBook) ? stored.nodeBook : [];
  const draft = {
    restApi: getEndpointOverride("kaspaApi"),
    node: getEndpoint("trustedNode"),
    customNode: "",
    bookLabel: "",
    bookAddress: "",
    error: "",
    nodeError: "",
    bookError: "",
  };
  const nodeChoices = () => {
    const list = [["", "Automatic Scan (Recommended)"]];
    for (const entry of book) list.push([entry.address, entry.label || entry.address]);
    if (draft.node && !list.some(([address]) => address === draft.node)) list.push([draft.node, draft.node]);
    return list;
  };

  const paint = () => {
    render(`
      <header class="navbar form-bar">
        <button class="bar-text" id="cancel">Cancel</button>
        <div class="nav-title">Connection Settings</div>
        <button class="bar-text strong" id="save">Save</button>
      </header>
      <section class="form">
        <div class="form-section">
          <div class="form-header">Kaspa Name Service</div>
          <div class="form-card"><div class="form-row stack-tight"><span>KNS API URL</span><span class="mono tiny muted break">${esc(getEndpoint("knsApi"))}</span></div></div>
          <div class="form-footer">KNS domain resolution service</div>
        </div>

        <div class="form-section">
          <div class="form-header">Kaspa Explorer API</div>
          <div class="form-card"><div class="form-row stack-tight"><span>Kaspa REST API URL</span>
            <input id="rest" class="plain-input mono" value="${esc(draft.restApi)}" placeholder="${esc(ENDPOINT_DEFAULTS.kaspaApi)}" autocomplete="off" spellcheck="false" /></div></div>
          <div class="form-footer">REST API for transaction history and balance lookups</div>
        </div>

        <div class="form-section">
          <div class="form-header">Kaspa Node</div>
          <div class="form-card" role="radiogroup" aria-label="Kaspa Node">
            ${nodeChoices().map(([address, label]) => `
              <button class="form-row between" role="radio" data-node="${esc(address)}" aria-checked="${address === draft.node}">
                <span class="stack-tight"><span>${esc(label)}</span>${address && label !== address ? `<span class="mono tiny muted">${esc(address)}</span>` : ""}</span>
                ${address === draft.node ? `<span class="accent">${ICONS.checkmark}</span>` : ""}
              </button>`).join("")}
            <div class="form-row">
              <input id="custom-node" class="plain-input mono" value="${esc(draft.customNode)}" placeholder="wss://host or host:port" autocomplete="off" spellcheck="false" />
              <button class="link-button small" id="use-custom" ${draft.customNode.trim() ? "" : "disabled"}>Use</button>
            </div>
            ${draft.node ? '<div class="form-row"><span class="accent small">Connected only to this node</span></div>' : ""}
            ${draft.nodeError ? `<div class="form-row error-text">${esc(draft.nodeError)}</div>` : ""}
          </div>
          <div class="form-footer">Automatic Scan finds a public Kaspa node for you. Choosing a specific node connects only to it, without falling back to others. Doesn't affect the KNS/REST API URLs above. Add your own nodes to the Node Address Book below to select them here. Browsers can only reach nodes over wRPC (wss://).</div>
        </div>

        <div class="form-section">
          <div class="form-header">Node Address Book</div>
          <div class="form-card">
            <div class="form-row"><input id="book-label" class="plain-input" value="${esc(draft.bookLabel)}" placeholder="Label (optional)" autocomplete="off" /></div>
            <div class="form-row">
              <input id="book-address" class="plain-input mono" value="${esc(draft.bookAddress)}" placeholder="wss://host or host:port" autocomplete="off" spellcheck="false" />
              <button class="icon plain accent" id="book-add" aria-label="Add address">${ICONS.plusCircleSmall}</button>
            </div>
            ${draft.bookError ? `<div class="form-row error-text">${esc(draft.bookError)}</div>` : ""}
            ${book.length ? book.map((entry, i) => `
              <div class="form-row between">
                <button class="plain-button stack-tight" data-copy="${i}"><span>${esc(entry.label || "Node")}</span><span class="mono tiny muted">${esc(entry.address)}</span></button>
                <button class="icon plain danger-text" data-remove="${i}" aria-label="Delete saved address">${ICONS.trash}</button>
              </div>`).join("") : '<div class="form-row muted"><i>No saved addresses</i></div>'}
          </div>
          <div class="form-footer">Save your own node addresses here, then pick one under Kaspa Node above.</div>
        </div>

        ${draft.error ? `<div class="form-section"><div class="form-card"><div class="form-row error-text">${esc(draft.error)}</div></div></div>` : ""}
      </section>`, "settings");

    $("#cancel").onclick = onBack;
    const keep = () => {
      draft.restApi = $("#rest").value;
      draft.customNode = $("#custom-node").value;
      draft.bookLabel = $("#book-label").value;
      draft.bookAddress = $("#book-address").value;
    };
    $("#custom-node").oninput = (event) => { $("#use-custom").disabled = !event.target.value.trim(); };
    for (const row of app.querySelectorAll("[data-node]")) {
      row.onclick = () => { keep(); draft.node = row.dataset.node; draft.nodeError = ""; paint(); };
    }
    $("#use-custom").onclick = () => {
      keep();
      const parsed = normalizeNodeAddress(draft.customNode);
      if (!parsed || parsed.error) { draft.nodeError = parsed?.error || "Enter as wss://host or host:port"; paint(); return; }
      draft.node = parsed.value;
      draft.customNode = "";
      draft.nodeError = "";
      paint();
    };
    $("#book-add").onclick = async () => {
      keep();
      const parsed = normalizeNodeAddress(draft.bookAddress);
      if (!parsed || parsed.error) { draft.bookError = parsed?.error || "Enter as wss://host or host:port"; paint(); return; }
      if (!book.some((entry) => entry.address === parsed.value)) book.push({ label: draft.bookLabel.trim(), address: parsed.value });
      await saveSettings({ nodeBook: book });
      draft.nodeError = "";
      draft.bookLabel = "";
      draft.bookAddress = "";
      draft.bookError = "";
      paint();
    };
    for (const button of app.querySelectorAll("[data-copy]")) {
      button.onclick = () => copyText(book[Number(button.dataset.copy)].address, "Node address");
    }
    for (const button of app.querySelectorAll("[data-remove]")) {
      button.onclick = async () => {
        keep();
        const [removed] = book.splice(Number(button.dataset.remove), 1);
        await saveSettings({ nodeBook: book });
        toast(removed?.address === draft.node ? "Removed from address book. Still connected to this node." : "Address removed.");
        paint();
      };
    }

    $("#save").onclick = async () => {
      keep();
      const rest = normalizeHttpsUrl(draft.restApi, ENDPOINT_DEFAULTS.kaspaApi);
      if (rest.error) { draft.error = rest.error; toast(rest.error); paint(); return; }
      // A REST API other than api.kaspa.org needs the browser's permission to be reached. The
      // request has to come straight from this click, before anything else is awaited.
      if (rest.value !== ENDPOINT_DEFAULTS.kaspaApi && ext?.permissions?.request) {
        let granted = false;
        try { granted = await ext.permissions.request({ origins: [`${new URL(rest.value).origin}/*`] }); } catch { granted = false; }
        if (!granted) { draft.error = "KaChat Wallet needs your permission to reach that address."; paint(); return; }
      }
      const nodeChanged = draft.node !== getEndpoint("trustedNode");
      setEndpoint("kaspaApi", rest.value);
      // The background worker has no localStorage; it reads the REST API from here.
      await saveSettings({ restApi: rest.value });
      setEndpoint("trustedNode", draft.node);
      if (nodeChanged) {
        await wallet.disconnect();
        toast(draft.node ? "Node updated." : "Automatic scan enabled.");
      } else {
        toast("Settings saved.");
      }
      onBack();
    };
  };
  paint();
}

// --- Connected Sites ------------------------------------------------------------------------

async function showConnectedSites({ onBack }) {
  const all = await connections();
  const entries = Object.entries(all).sort((a, b) => (b[1].connectedAt || 0) - (a[1].connectedAt || 0));
  render(`
    ${navHeader({ title: "Connected Sites" })}
    <section class="screen settings">
      <div class="glass list">
        ${entries.length ? entries.map(([origin, entry]) => `
          <div class="list-row">
            <span class="tx-meta"><span class="ellipsis">${esc(origin.replace(/^https:\/\//, ""))}</span><span class="muted tiny">${esc(entry.accountName || "")} · ${esc(wallet.shortAddress(entry.address))}</span></span>
            <button class="link-button small danger-text" data-origin="${esc(origin)}">Disconnect</button>
          </div>`).join("") : '<div class="list-row muted">No sites are connected.</div>'}
      </div>
      <p class="form-footer">A connected site can see that account's chatting address and balance, and can ask you to send Kaspa or sign a message - every request opens KaChat Wallet for your approval.</p>
    </section>`, "settings");
  $("#back").onclick = onBack;
  for (const button of app.querySelectorAll("[data-origin]")) {
    button.onclick = async () => {
      await removeConnection(button.dataset.origin);
      toast("Disconnected.");
      showConnectedSites({ onBack });
    };
  }
}

// --- View Seed Phrase: iOS SeedPhraseView -------------------------------------------------

async function showSeedPhrase({ password, onBack }) {
  const view = await vault.readAccounts();
  const account = view.accounts.find((a) => a.id === view.activeAccountId) || view.accounts[0];
  let secrets;
  try {
    secrets = await vault.revealSecrets(account.id, password);
  } catch (error) {
    toast(error.message);
    onBack();
    return;
  }
  const words = secrets.mnemonic.split(" ");
  let revealed = false;
  let hideTimer = null;
  const paint = () => {
    render(`
      ${navHeader({ title: "Seed Phrase" })}
      <section class="screen">
        <div class="callout warn">
          <div class="callout-title">${ICONS.warning}<span>Security Warning</span></div>
          <p>Anyone with your seed phrase can access your account. Never share it with anyone.</p>
        </div>
        ${revealed ? `
          <div class="seed-grid">${words.map((w, i) => `<div class="seed-word"><span class="n">${i + 1}.</span><span class="w">${esc(w)}</span></div>`).join("")}</div>
          ${secrets.passphrase ? `<div class="glass key-box"><div class="muted small">Passphrase</div><div class="mono">${esc(secrets.passphrase)}</div></div>` : ""}
          <button id="copy-seed" class="with-icon soft">${ICONS.copy}<span>Copy Seed Phrase</span></button>
          <button id="copy-key" class="with-icon soft">${ICONS.key}<span>Copy Private Key Hex</span></button>`
          : `<button class="reveal-box" id="reveal">${ICONS.eyeSlash}<span>Tap to reveal seed phrase</span></button>
             ${secrets.passphrase ? '<p class="muted small center-text">This account also uses a passphrase - it is shown with the words.</p>' : ""}`}
      </section>`, "seed");
    $("#back").onclick = () => { clearTimeout(hideTimer); onBack(); };
    const reveal = $("#reveal");
    if (reveal) reveal.onclick = () => {
      revealed = true;
      paint();
      // iOS hides the words again after seven seconds.
      hideTimer = setTimeout(() => { revealed = false; if (app.dataset.screen === "seed") paint(); }, 7000);
    };
    const copySeed = $("#copy-seed");
    if (copySeed) copySeed.onclick = () => copySecret(secrets.mnemonic, "Seed phrase copied. Clipboard will clear in 30s.");
    const copyKey = $("#copy-key");
    if (copyKey) copyKey.onclick = async () => {
      try {
        copySecret(await wallet.privateKeyHex({ kind: "main" }), "Private key hex copied. Clipboard will clear in 30s.");
      } catch {
        toast("Private key unavailable.");
      }
    };
  };
  paint();
}

// --- Open Source Licenses: iOS OpenSourceLicensesView --------------------------------------

const MIT = "Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the \"Software\"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED \"AS IS\", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.";
const ISC = "Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted, provided that the above copyright notice and this permission notice appear in all copies.\n\nTHE SOFTWARE IS PROVIDED \"AS IS\" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.";
const APACHE2 = "Licensed under the Apache License, Version 2.0 (the \"License\"); you may not use this file except in compliance with the License. You may obtain a copy of the License at\n\nhttp://www.apache.org/licenses/LICENSE-2.0\n\nUnless required by applicable law or agreed to in writing, software distributed under the License is distributed on an \"AS IS\" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.";

const LICENSES = [
  { name: "Rusty Kaspa (Kaspa WASM SDK)", license: "ISC", holder: "Copyright (c) Kaspa developers", text: ISC },
  { name: "node-qrcode", license: "MIT", holder: "Copyright (c) 2012 Ryan Day", text: MIT },
  { name: "jsQR", license: "Apache License 2.0", holder: "Copyright 2017 Cosmo Wolfe", text: APACHE2 },
];

export function showLicenses({ onBack }) {
  render(`
    ${navHeader({ title: "Open Source Licenses" })}
    <section class="screen licenses">
      <p class="muted">KaChat Wallet is built with these open source libraries. Their authors ask that these notices travel with the app.</p>
      ${LICENSES.map((item) => `
        <div class="glass license-card">
          <div class="license-head"><span class="strong">${esc(item.name)}</span><span class="muted tiny">${esc(item.license)}</span></div>
          <div class="muted small">${esc(item.holder)}</div>
          <p class="license-text">${esc(item.text).replace(/\n/g, "<br />")}</p>
        </div>`).join("")}
    </section>`, "licenses");
  $("#back").onclick = onBack;
}
