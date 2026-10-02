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
import { IS_TESTNET, TESTNET_REST, switchNetwork } from "./net.js";

const BOOK_KEY = IS_TESTNET ? "nodeBookTestnet" : "nodeBook";
import { NAME_SERVICES } from "./names.js";

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

// iOS ConnectionHubPage: Connection Settings, the Testnet toggle and its footer, then Kaspa
// Explorer in its own section. iOS applies a switch on the next launch; the extension reloads its
// pages straight away (every open KaChat Wallet window follows).
function showConnectionHub({ onBack }) {
  const explorer = wallet.EXPLORERS[wallet.currentExplorer()].name;
  render(`
    ${navHeader({ title: "Connection" })}
    <section class="screen settings">
      <div class="section-header">Connection</div>
      <div class="glass list">
        ${rowHtml("connection-settings", ICONS.antenna, "Connection Settings")}
        <button class="list-row settings-row" id="testnet" role="switch" aria-checked="${IS_TESTNET}">
          <span class="settings-label"><span class="testnet-icon">${TESTTUBE}</span><span>Testnet</span></span>
          <span class="toggle testnet-toggle ${IS_TESTNET ? "on" : ""}"></span>
        </button>
      </div>
      <!-- "K&#x41;S": a sentence, not an amount - ui.unitText must not make it TKAS. -->
      <p class="form-footer">Testnet is for testing only - testnet K&#x41;S has no value. On testnet your account uses its kaspatest: address, with its own balance, and Connection Settings holds testnet values: the testnet explorer and automatic node discovery. Turning it off brings your mainnet settings back.</p>
      <div class="glass list">
        ${rowHtml("explorer", ICONS.safari, "Kaspa Explorer", IS_TESTNET ? "tn10.kaspa.stream" : explorer)}
      </div>
      ${IS_TESTNET ? `
        <div class="glass list">
          <a class="list-row settings-row" href="https://faucet-tn10.kaspanet.io" target="_blank" rel="noopener noreferrer">
            <span class="settings-label"><span class="testnet-icon">${DROP}</span><span>TN10 Faucet</span></span>
            <span class="settings-value">${ICONS.chevron}</span>
          </a>
        </div>
        <p class="form-footer">Free testnet-10 coins for trying things out.</p>` : ""}
    </section>`, "settings");
  $("#back").onclick = onBack;
  const again = () => showConnectionHub({ onBack });
  $("#connection-settings").onclick = () => showConnectionSettings({ onBack: again });
  $("#explorer").onclick = () => showExplorerPicker({ onBack: again });
  $("#testnet").onclick = async () => {
    const next = IS_TESTNET ? "mainnet" : "testnet";
    await switchNetwork(next);
    await wallet.disconnect();
    // Back on this page after the reload: the dock and toolbar show the new network.
    location.reload();
  };
}

// SF Symbol drop.fill
const DROP = '<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5c3.5 4.4 6.5 8.2 6.5 11.7a6.5 6.5 0 0 1-13 0C5.5 10.7 8.5 6.9 12 2.5z" fill="currentColor"/></svg>';
// SF Symbol testtube.2
const TESTTUBE = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 3v13.5a2.5 2.5 0 0 0 5 0V3M6 3h7M8.5 10h3"/><path d="M15 6v10.5a2.5 2.5 0 0 0 5 0V6M14 6h7M16.5 12h3"/></svg>';

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
  if (!candidate) return { error: "Enter as host:port or wss://host" };
  try {
    const url = new URL(candidate);
    if (url.protocol !== "wss:" || !url.hostname) return { error: "Enter as host:port or wss://host" };
    return { value: candidate.replace(/\/+$/, "") };
  } catch {
    return { error: "Enter as host:port or wss://host" };
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

// iOS ConnectionSettingsView, wallet-only: of its underline tabs (Indexer, Node, Translation,
// Domains, Explorer) the wallet keeps Node, Domains and Explorer - the indexers and the
// translation service are for chats and KaPosts. As on iOS, picking a node applies at once,
// the IP Address Book saves as you edit it, and Save stores the URL fields.
const CONNECTION_TABS = [["node", "Node"], ["domains", "Domains"], ["explorer", "Explorer"]];
const HTTPS_REQUIRED = "Use https. Unencrypted connections are not supported.";
let connectionTab = "node";

async function showConnectionSettings({ onBack }) {
  // Each network keeps its own address book (iOS ConnectionProfile.savedNodeAddresses).
  const book = (await settings())[BOOK_KEY];
  const draft = {
    book: Array.isArray(book) ? book : [],
    restApi: getEndpointOverride("kaspaApi"),
    bookLabel: "",
    bookAddress: "",
    bookError: "",
    nodeError: "",
    error: "",
  };

  const nodeChoices = () => {
    const pinned = getEndpoint("trustedNode");
    const list = [["", "Default (Recommended)"]];
    for (const entry of draft.book) list.push([entry.address, entry.label || entry.address]);
    if (pinned && !list.some(([address]) => address === pinned)) list.push([pinned, pinned]);
    return list;
  };

  const nodeTab = () => {
    const pinned = getEndpoint("trustedNode");
    return `
      <div class="form-section">
        <div class="form-header">Kaspa Node</div>
        <div class="form-card">
          <label class="form-row between picker-row">
            <span>Kaspa Node</span>
            <span class="menu-picker">
              <select id="node-choice" aria-label="Kaspa Node">
                ${nodeChoices().map(([address, label]) => `<option value="${esc(address)}" ${address === pinned ? "selected" : ""}>${esc(label)}</option>`).join("")}
              </select>
              ${ICONS.chevronUpDown}
            </span>
          </label>
          ${draft.nodeError ? `<div class="form-row error-text small">${esc(draft.nodeError)}</div>` : ""}
          ${pinned ? '<div class="form-row"><span class="accent small">Connected only to this node</span></div>' : ""}
        </div>
        <div class="form-footer">Default finds a public Kaspa node for you and comes back to the last one that answered. Choosing a specific node connects only to it, without falling back to others. Doesn't affect the domains or explorer on the other tabs. Add custom addresses to the IP Address Book below to select them here.</div>
      </div>

      <div class="form-section">
        <div class="form-header">IP Address Book</div>
        <div class="form-card">
          <div class="form-row"><input id="book-label" class="plain-input" value="${esc(draft.bookLabel)}" placeholder="Label (optional)" autocomplete="off" /></div>
          <div class="form-row">
            <input id="book-address" class="plain-input mono" value="${esc(draft.bookAddress)}" placeholder="host:port or wss://host" autocomplete="off" spellcheck="false" />
            <button class="icon plain accent" id="book-add" aria-label="Add address" ${draft.bookAddress.trim() ? "" : "disabled"}>${ICONS.plusCircleSmall}</button>
          </div>
          ${draft.bookError ? `<div class="form-row error-text small">${esc(draft.bookError)}</div>` : ""}
          ${draft.book.length ? draft.book.map((entry, i) => `
            <div class="form-row between">
              <button class="plain-button stack-tight" data-copy="${i}" title="Copy">
                ${entry.label ? `<span>${esc(entry.label)}</span><span class="mono tiny muted">${esc(entry.address)}</span>` : `<span class="mono small">${esc(entry.address)}</span>`}
              </button>
              <button class="icon plain danger-text" data-remove="${i}" aria-label="Delete saved address">${ICONS.trash}</button>
            </div>`).join("") : '<div class="form-row muted"><i>No saved addresses</i></div>'}
        </div>
        <div class="form-footer">Save your own node addresses here, then pick one under Kaspa Node above. Tap an address to copy it. A browser reaches nodes over wRPC (wss://).</div>
      </div>`;
  };

  const domainsTab = () => `
    <div class="form-section">
      <div class="form-header">Kaspa Name Service</div>
      <div class="form-card"><div class="form-row stack-tight"><span class="muted small">KNS API URL</span><span class="mono small muted break">${esc(wallet.knsApiUrl())}</span></div></div>
      <div class="form-footer">KNS domain resolution service</div>
    </div>
    <div class="form-section">
      <div class="form-header">Other Name Services</div>
      <div class="form-card">
        ${NAME_SERVICES.filter((n) => n.tld === "k" || n.tld === "kaspa").map((n) => `
          <div class="form-row stack-tight"><span class="muted small">${esc(n.serviceName)} (${esc(n.suffix)})</span>${n.api ? `<span class="mono small muted break">${esc(n.api)}</span>` : '<span class="muted">Not available on this network</span>'}</div>`).join("")}
        <div class="form-row stack-tight"><span class="muted small">KaChat Names (.kachat)</span><span class="muted">Coming soon</span></div>
      </div>
      <div class="form-footer">Used to show the .k and .kaspa names an address owns. KaChat's own .kachat names will be set here once they launch.</div>
    </div>`;

  const explorerTab = () => `
    <div class="form-section">
      <div class="form-header">Kaspa Explorer API</div>
      <div class="form-card"><div class="form-row stack-tight"><span class="muted small">Kaspa REST API URL</span>
        <input id="rest" class="plain-input mono" value="${esc(draft.restApi)}" placeholder="${esc(IS_TESTNET ? TESTNET_REST : ENDPOINT_DEFAULTS.kaspaApi)}" autocomplete="off" spellcheck="false" />
        <span class="error-text small" id="rest-error">${/^http:\/\//i.test(draft.restApi.trim()) ? HTTPS_REQUIRED : ""}</span>
      </div></div>
      <div class="form-footer">REST API for transaction history and balance lookups</div>
    </div>`;

  const paint = () => {
    const scroll = app.querySelector(".form")?.scrollTop || 0;
    render(`
      <header class="navbar form-bar">
        <button class="nav-back" id="back" aria-label="Back">${ICONS.back}<span>Back</span></button>
        <div class="nav-title">Connection Settings</div>
        <button class="bar-text strong" id="save">Save</button>
      </header>
      <div class="underline-tabs" role="tablist" aria-label="Connection">
        ${CONNECTION_TABS.map(([id, title]) => `<button role="tab" data-ctab="${id}" aria-selected="${id === connectionTab}">${esc(title)}</button>`).join("")}
      </div>
      <section class="form">
        ${connectionTab === "node" ? nodeTab() : connectionTab === "domains" ? domainsTab() : explorerTab()}
        ${draft.error ? `<div class="form-section"><div class="form-card"><div class="form-row error-text">${esc(draft.error)}</div></div></div>` : ""}
      </section>`, "settings");
    const form = app.querySelector(".form");
    if (form) form.scrollTop = scroll;

    $("#back").onclick = onBack;
    // Save covers every tab: the fields keep their edits while you switch between them.
    for (const tab of app.querySelectorAll("[data-ctab]")) {
      tab.onclick = () => { connectionTab = tab.dataset.ctab; draft.error = ""; paint(); };
    }

    const nodeChoice = $("#node-choice");
    if (nodeChoice) nodeChoice.onchange = async () => {
      const value = nodeChoice.value;
      if (value === getEndpoint("trustedNode")) return;
      setEndpoint("trustedNode", value);
      await wallet.disconnect();
      toast(value ? "Node updated." : "Default node connection enabled.");
      draft.nodeError = "";
      paint();
    };

    const label = $("#book-label");
    if (label) label.oninput = () => { draft.bookLabel = label.value; };
    const address = $("#book-address");
    if (address) address.oninput = () => {
      draft.bookAddress = address.value;
      draft.bookError = "";
      $("#book-add").disabled = !address.value.trim();
    };
    const add = $("#book-add");
    if (add) add.onclick = async () => {
      const parsed = normalizeNodeAddress(draft.bookAddress);
      if (!parsed || parsed.error) { draft.bookError = parsed?.error || "Enter as host:port or wss://host"; paint(); return; }
      if (!draft.book.some((entry) => entry.address === parsed.value)) draft.book.push({ label: draft.bookLabel.trim(), address: parsed.value });
      await saveSettings({ [BOOK_KEY]: draft.book });
      draft.bookLabel = "";
      draft.bookAddress = "";
      draft.bookError = "";
      paint();
    };
    for (const button of app.querySelectorAll("[data-copy]")) {
      button.onclick = () => copyText(draft.book[Number(button.dataset.copy)].address, "Node address");
    }
    for (const button of app.querySelectorAll("[data-remove]")) {
      button.onclick = async () => {
        // Removing the pinned node's entry keeps the pin; the picker then shows it as a custom
        // address (iOS deleteSavedNodeAddress).
        const [removed] = draft.book.splice(Number(button.dataset.remove), 1);
        await saveSettings({ [BOOK_KEY]: draft.book });
        toast(removed?.address === getEndpoint("trustedNode") ? "Removed from address book. Still connected to this node." : "Address removed.");
        paint();
      };
    }

    const rest = $("#rest");
    if (rest) rest.oninput = () => {
      draft.restApi = rest.value;
      $("#rest-error").textContent = /^http:\/\//i.test(rest.value.trim()) ? HTTPS_REQUIRED : "";
    };

    $("#save").onclick = async () => {
      const defaultRest = IS_TESTNET ? TESTNET_REST : ENDPOINT_DEFAULTS.kaspaApi;
      const parsed = normalizeHttpsUrl(draft.restApi, defaultRest);
      if (parsed.error) { draft.error = parsed.error; connectionTab = "explorer"; toast(parsed.error); paint(); return; }
      // A REST API other than api.kaspa.org needs the browser's permission to be reached. The
      // request has to come straight from this click, before anything else is awaited.
      if (parsed.value !== defaultRest && parsed.value !== ENDPOINT_DEFAULTS.kaspaApi && ext?.permissions?.request) {
        let granted = false;
        try { granted = await ext.permissions.request({ origins: [`${new URL(parsed.value).origin}/*`] }); } catch { granted = false; }
        if (!granted) { draft.error = "KaChat Wallet needs your permission to reach that address."; connectionTab = "explorer"; paint(); return; }
      }
      setEndpoint("kaspaApi", parsed.value);
      // The background worker has no localStorage; it reads the REST API from here.
      await saveSettings({ [IS_TESTNET ? "restApiTestnet" : "restApi"]: parsed.value });
      toast("Settings saved.");
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
