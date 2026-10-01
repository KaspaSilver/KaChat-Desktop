// Managing your addresses - a 1:1 port of the iOS screens:
//
//   ChattingAddressManageView   Balance, Transaction History | UTXOs (n), Address Actions (View
//                               Private Key, View Public Key, View in Explorer), Receive / Send
//   ManageAddressesView         Total Balance, Address Actions (Generate, Discover, Address
//                               Visibility, Send All Kaspa To Primary), one card per spending
//                               address with its own actions sheet (Rename, Copy, Show QR Code,
//                               Set as Primary, Hide)
//   SpendingAddressTransactionHistoryView   one spending address: History | UTXOs | KNS Domains,
//                               private key export and explorer in the bar, Receive / Send
//   SpendingAddressVisibilityView, ConsolidateToPrimaryConfirmView, the private / public key
//   sheets, Rename UTXO, the Transaction sheet.
//
// Left out because the extension has no counterpart: "Notify on receive" (no notifications) and
// the Chat Privacy tab (chats only).

import { remember } from "./dock.js";
import * as wallet from "./wallet.js";
import * as vault from "./vault.js";
import {
  app, esc, render, $, toast, copyText, copySecret, ICONS, navHeader, showQr, showSheet, showAlert,
  passwordGate, formatKas8,
} from "./ui.js";
import { showSend } from "./send.js";
import { showSendDomain } from "./domains.js";
import { showAddToPortfolio } from "./portfolio.js";

// SF Symbols these screens use, drawn to match.
const SF = {
  arrowUpFill: '<svg width="26" height="26" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="currentColor"/><path d="M12 17V7.5M7.8 11.5L12 7.3l4.2 4.2" fill="none" stroke="var(--bg)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  // arrow.up.circle.fill on an accent capsule: a black disc with the arrow cut out in the accent.
  sendFill: '<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="currentColor"/><path d="M12 17V7.5M7.8 11.5L12 7.3l4.2 4.2" fill="none" stroke="var(--kaspa)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  chartPieFill: '<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><path d="M11 3.1A9 9 0 1 0 20.9 13H11z" fill="currentColor"/><path d="M13 2.6V11h8.4A8.6 8.6 0 0 0 13 2.6z" fill="currentColor"/></svg>',
  arrowDownFill: '<svg width="26" height="26" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="currentColor"/><path d="M12 7v9.5M7.8 12.5l4.2 4.2 4.2-4.2" fill="none" stroke="var(--bg)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  upRightSquare: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="4"/><path d="M9.5 14.5l6-6M10 8.5h5.5V14"/></svg>',
  cube: '<svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2l9 5v10l-9 5-9-5V7z" fill="currentColor"/><path d="M3 7l9 5 9-5M12 12v10" fill="none" stroke="var(--bg)" stroke-width="1.4"/></svg>',
  grid: '<svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10.5" fill="currentColor"/><circle cx="9" cy="9" r="2" fill="var(--bg)"/><circle cx="15" cy="9" r="2" fill="var(--bg)"/><circle cx="9" cy="15" r="2" fill="var(--bg)"/><circle cx="15" cy="15" r="2" fill="var(--bg)"/></svg>',
  pencil: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4z"/></svg>',
  merge: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3v4a6 6 0 0 0 6 6 6 6 0 0 1 6 6v2M18 3v4a6 6 0 0 1-3 5.2"/><path d="M3 6l3-3 3 3M15 6l3-3 3 3"/></svg>',
  keyFill: '<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><circle cx="7.5" cy="15.5" r="5" fill="currentColor"/><circle cx="7.5" cy="15.5" r="1.8" fill="var(--panel)"/><path d="M11 12L20.5 2.5M16 7l3 3M18.3 4.7l2.2 2.2" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>',
  number: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M10 3L8 21M16 3l-2 18M4 8.5h17M3 15.5h17"/></svg>',
  globe: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20"/></svg>',
  safari: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M16 8l-2.5 5.5L8 16l2.5-5.5z"/></svg>',
  person: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2.5" y="4" width="19" height="16" rx="3"/><circle cx="8.5" cy="11" r="2.5"/><path d="M4.8 17c.7-1.8 2-2.7 3.7-2.7s3 .9 3.7 2.7M14.5 10h4.5M14.5 14h3"/></svg>',
  qrcode: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM17 17h4v4M21 14v1"/></svg>',
  plusCircle: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 7.5v9M7.5 12h9"/></svg>',
  magnifier: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5L21 21"/></svg>',
  checklist: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 6.5l1.8 1.8L8.5 5M3.5 13.5l1.8 1.8 3.2-3.3M11.5 7h9M11.5 14h9M11.5 20h9"/></svg>',
  upToLine: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 3h14M12 21V8M6.5 13.5L12 8l5.5 5.5"/></svg>',
  doc: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><rect x="8" y="8" width="13" height="13" rx="2.5"/><path d="M16 8V5.5A2.5 2.5 0 0 0 13.5 3h-8A2.5 2.5 0 0 0 3 5.5v8A2.5 2.5 0 0 0 5.5 16H8"/></svg>',
  star: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9L12 3z"/></svg>',
  starFill: '<svg width="11" height="11" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9L12 3z" fill="currentColor"/></svg>',
  eyeSlash: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3l18 18"/><path d="M10.6 5.1A10.4 10.4 0 0 1 12 5c6.5 0 10 7 10 7a17.6 17.6 0 0 1-3.2 4.2M6.6 6.6C3.8 8.4 2 12 2 12s3.5 7 10 7c1.9 0 3.5-.6 4.9-1.4"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>',
  ellipsisV: '<svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="5" r="2" fill="currentColor"/><circle cx="12" cy="12" r="2" fill="currentColor"/><circle cx="12" cy="19" r="2" fill="currentColor"/></svg>',
  exportKey: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="7" y="7" width="13" height="14" rx="2.5"/><path d="M4 16V5.5A2.5 2.5 0 0 1 6.5 3H15M13.5 15.5V10.5M11 13l2.5-2.5L16 13"/></svg>',
  creditcard: '<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="2.5" y="5" width="19" height="14" rx="2.5"/><path d="M2.5 9.5h19M6 15h4"/></svg>',
  warning: '<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l10 18H2z" fill="currentColor"/><path d="M12 10v5" stroke="#000" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="18" r="1.1" fill="#000"/></svg>',
  seal: '<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2l2.4 1.8 3-.2.9 2.9 2.5 1.7-.9 2.8.9 2.8-2.5 1.7-.9 2.9-3-.2L12 22l-2.4-1.8-3 .2-.9-2.9-2.5-1.7.9-2.8-.9-2.8 2.5-1.7.9-2.9 3 .2z" fill="currentColor"/><path d="M8.5 12.2l2.4 2.4 4.6-4.8" fill="none" stroke="var(--bg)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  eyeSlashFill: '<svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3l18 18"/><path d="M10.6 5.1A10.4 10.4 0 0 1 12 5c6.5 0 10 7 10 7a17.6 17.6 0 0 1-3.2 4.2M6.6 6.6C3.8 8.4 2 12 2 12s3.5 7 10 7c1.9 0 3.5-.6 4.9-1.4"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>',
  chevronLeft: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>',
  chevronRight: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg>',
};

// --- shared formatting ------------------------------------------------------------------------

/** "Oct 1, 2026 at 3:04 PM" - iOS Date.FormatStyle(date: .abbreviated, time: .shortened). */
function txDate(ms) {
  const date = new Date(ms);
  const day = date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `${day} at ${time}`;
}

/** iOS feeText: four decimals from 0.001 KAS up, eight below. */
function feeText(sompi) {
  if (sompi == null) return "";
  const kas = Number(sompi) / 1e8;
  return `Fee ${kas >= 0.001 ? kas.toFixed(4) : kas.toFixed(8)} KAS`;
}

/** iOS PortfolioFormat.kas: grouped, 0-4 decimals. */
function portfolioKas(sompi) {
  return `${(Number(sompi) / 1e8).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 4 })} KAS`;
}

/** Middle truncation for a one-line monospaced id. */
function middle(text, keep = 12) {
  const value = String(text || "");
  return value.length > keep * 2 + 1 ? `${value.slice(0, keep)}…${value.slice(-keep)}` : value;
}

/** iOS SpendingAddressEntry.shortAddress: first 14 + "..." + last 6. */
function shortAddress(address) {
  const value = String(address || "");
  return value.length > 20 ? `${value.slice(0, 14)}...${value.slice(-6)}` : value;
}

// --- Transaction History, UTXOs, KNS Domains (shared by both detail screens) -----------------

function historyHtml(state) {
  if (!state.history && state.historyLoading) return '<div class="list-row center-row"><span class="spinner small-spin"></span></div>';
  const txs = state.history?.txs || [];
  if (!txs.length && state.history && !state.history.complete) {
    return '<div class="list-row stack-row"><span class="muted">Could not load transactions.</span><button class="link-button strong" id="history-retry">Try Again</button></div>';
  }
  if (!txs.length) return '<div class="list-row muted">No transactions yet.</div>';
  return txs.map((tx, i) => {
    const cls = tx.direction === "out" ? "out" : tx.direction === "in" ? "in" : "none";
    return `
      <button class="list-row ios-tx" data-tx="${i}">
        <span class="ios-tx-icon ${cls}">${tx.direction === "out" ? SF.arrowUpFill : SF.arrowDownFill}</span>
        <span class="tx-meta">
          <span class="ios-tx-title ${cls}">${tx.direction === "out" ? "Sent" : tx.direction === "in" ? "Received" : "Transaction"}</span>
          <span class="mono tiny muted">${esc(middle(tx.txid, 6))}</span>
          ${tx.time ? `<span class="tiny muted">${esc(txDate(tx.time))}</span>` : ""}
        </span>
        <span class="ios-tx-right">
          ${tx.direction ? `<span class="ios-tx-amount ${cls}">${tx.direction === "out" ? "-" : "+"}${esc(formatKas8(tx.amountSompi))} KAS</span>` : ""}
          ${tx.feeSompi != null ? `<span class="tiny muted">${esc(feeText(tx.feeSompi))}</span>` : ""}
        </span>
        <span class="accent">${SF.upRightSquare}</span>
      </button>`;
  }).join("");
}

// iOS TransactionActionsSheet: Open in Explorer, and Add to Portfolio when the transaction has
// a direction (a buy or a sell of KAS for this address).
function showTransactionSheet(tx, sourceAddress, onDone) {
  const summary = tx.direction ? `${tx.direction === "out" ? "Sent" : "Received"} ${portfolioKas(tx.amountSompi)}${tx.time ? ` on ${txDate(tx.time)}` : ""}` : "";
  showSheet({
    title: "Transaction",
    headerHtml: `${summary ? `<div class="muted small">${esc(summary)}</div>` : ""}<div class="mono tiny muted">${esc(middle(tx.txid, 16))}</div>`,
    cancel: false,
    rows: [{
      label: "Open in Explorer",
      subtitle: "Opens this transaction on the block explorer.",
      icon: SF.safari,
      onClick: () => window.open(wallet.explorerTxUrl(tx.txid), "_blank", "noopener"),
    }, ...(tx.direction ? [{
      label: "Add to Portfolio",
      subtitle: "Records it as a buy or a sell in a portfolio of your choosing.",
      icon: SF.chartPieFill,
      onClick: () => showAddToPortfolio({ txid: tx.txid, direction: tx.direction, amountSompi: tx.amountSompi, time: tx.time, sourceAddress, onDone }),
    }] : [])],
  });
}

function utxosHtml(state, compoundFooter) {
  const coins = state.coins;
  let body;
  if (!coins && state.coinsLoading) body = '<div class="list-row center-row"><span class="spinner small-spin"></span></div>';
  else if (!coins?.length && state.coinsError) {
    body = `<div class="list-row stack-row">
      <span class="danger-text strong small">${SF.warning} Couldn't load the coins at this address</span>
      <span class="muted tiny">${esc(state.coinsError)}</span>
      <button class="link-button strong" id="coins-retry">Try Again</button></div>`;
  } else if (!coins?.length) body = '<div class="list-row muted">No UTXOs.</div>';
  else {
    body = coins.map((coin, i) => {
      const label = state.labels?.[coin.key];
      return `
        <div class="list-row ios-utxo">
          <span class="accent">${coin.isCoinbase ? SF.cube : SF.grid}</span>
          <span class="tx-meta">
            ${label ? `<span class="accent tiny strong">${esc(label)}</span>` : ""}
            <span class="strong small">${esc(formatKas8(coin.amount))} KAS</span>
            <span class="mono tiny muted">${esc(middle(`${coin.transactionId}:${coin.index}`, 10))}</span>
          </span>
          ${coin.isCoinbase ? '<span class="tiny muted strong">Coinbase</span>' : ""}
          <button class="icon plain accent" data-rename-utxo="${i}" aria-label="Rename UTXO">${SF.pencil}</button>
        </div>`;
    }).join("");
  }
  const compound = coins && coins.length > 1 ? `
    <div class="glass list"><button class="list-row strong accent-row" id="compound">${SF.merge}<span>Compound UTXOs</span></button></div>
    <p class="form-footer">${esc(compoundFooter)}</p>` : "";
  return `${compound}<div class="glass list">${body}</div>`;
}

function bindTabsContent(state, { address, repaint, reloadHistory, reloadCoins, onCompound }) {
  for (const row of app.querySelectorAll("[data-tx]")) row.onclick = () => showTransactionSheet(state.history.txs[Number(row.dataset.tx)], address, repaint);
  const historyRetry = $("#history-retry");
  if (historyRetry) historyRetry.onclick = reloadHistory;
  const coinsRetry = $("#coins-retry");
  if (coinsRetry) coinsRetry.onclick = reloadCoins;
  const compound = $("#compound");
  if (compound) compound.onclick = onCompound;
  for (const button of app.querySelectorAll("[data-rename-utxo]")) {
    const coin = state.coins[Number(button.dataset.renameUtxo)];
    button.onclick = () => showAlert({
      title: "Rename UTXO",
      field: { placeholder: "Name", value: state.labels?.[coin.key] || "" },
      confirmLabel: "Save",
      cancelLabel: "Cancel",
      onConfirm: async (value) => { state.labels = await wallet.setUtxoLabel(address, coin.key, value); repaint(); },
    });
  }
}

function loaders(state, address, repaintIfHere) {
  const loadHistory = () => {
    state.historyLoading = true;
    repaintIfHere();
    wallet.history(address)
      .then((result) => { state.history = result; })
      .catch(() => { state.history = { txs: [], complete: false }; })
      .finally(() => { state.historyLoading = false; repaintIfHere(); });
  };
  const loadCoins = () => {
    state.coinsLoading = true;
    state.coinsError = "";
    repaintIfHere();
    wallet.utxos(address)
      .then((coins) => { state.coins = coins; })
      .catch((error) => { state.coinsError = String(error?.message || error); })
      .finally(() => { state.coinsLoading = false; repaintIfHere(); });
  };
  return { loadHistory, loadCoins };
}

// --- keys -------------------------------------------------------------------------------------

// iOS ChattingAddressPrivateKeyView / SpendingAddressPrivateKeyView: the warning, tap to reveal
// for seven seconds, Copy Private Key Hex (clipboard cleared after 30 s).
async function showPrivateKey({ title, source, onBack }) {
  let value = "Unavailable";
  try { value = await wallet.privateKeyHex(source); } catch { /* shown as Unavailable */ }
  let revealed = false;
  let timer = null;
  const paint = () => {
    render(`
      ${navHeader({ title, backLabel: "Close" })}
      <section class="screen key-screen">
        <div class="callout warn">
          <div class="callout-title">${SF.warning}<span>Security Warning</span></div>
          <p>Anyone with this address's private key can spend its funds. Never share it with anyone.</p>
        </div>
        ${revealed ? `
          <div class="glass key-box mono">${esc(value)}</div>
          <button class="with-icon soft" id="copy-key">${SF.doc}<span>Copy Private Key Hex</span></button>`
          : `<button class="reveal-box" id="reveal">${SF.eyeSlashFill}<span>Tap to reveal private key</span></button>`}
      </section>`, "key");
    $("#back").onclick = () => { clearTimeout(timer); onBack(); };
    const reveal = $("#reveal");
    if (reveal) reveal.onclick = () => {
      revealed = true;
      paint();
      timer = setTimeout(() => { revealed = false; if (app.dataset.screen === "key") paint(); }, 7000);
    };
    const copy = $("#copy-key");
    if (copy) copy.onclick = () => copySecret(value, "Private key copied. Clipboard will clear in 30s.");
  };
  paint();
}

function gatePrivateKey({ title, source, onBack }) {
  passwordGate({
    title,
    message: "Enter your wallet password to view this address's private key.",
    verify: (password) => vault.verifyPassword(password),
    onBack,
    onUnlocked: () => showPrivateKey({ title, source, onBack }),
  });
}

// iOS ChattingAddressPublicKeyView.
async function showPublicKey({ source, onBack }) {
  let value = null;
  try { value = await wallet.publicKeyHex(source); } catch { /* fallback text */ }
  render(`
    ${navHeader({ title: "Public Key", backLabel: "Close" })}
    <section class="screen key-screen">
      <div class="callout safe">
        <div class="callout-title">${SF.seal}<span>Safe to share</span></div>
        <p>This is the public half of your chatting address. It identifies you and cannot spend anything.</p>
      </div>
      ${value ? `<div class="glass key-box mono selectable">${esc(value)}</div>
        <button class="with-icon soft" id="copy-key">${SF.doc}<span>Copy Public Key</span></button>`
        : '<p class="muted">This address does not carry a public key.</p>'}
    </section>`, "key");
  $("#back").onclick = onBack;
  const copy = $("#copy-key");
  if (copy) copy.onclick = () => copyText(value, "Public key");
}

// --- Chatting address: iOS ChattingAddressManageView ----------------------------------------

/**
 * @param {object} opts
 * @param {string} opts.address        the chatting address
 * @param {Function} opts.onBack
 * @param {Function} [opts.onChangeIdentity] imported accounts: Change Chatting Address
 */
export function showManageAddress(opts) {
  const source = { kind: "main" };
  const state = { tab: "history", history: null, historyLoading: false, coins: null, coinsLoading: false, coinsError: "", labels: {} };
  const back = () => paint();
  const here = () => app.dataset.screen === "manage-chat";
  const repaintIfHere = () => { if (here()) paint(); };
  const { loadHistory, loadCoins } = loaders(state, opts.address, repaintIfHere);
  const balance = () => (state.coins ? state.coins.reduce((sum, c) => sum + c.amount, 0n) : null);

  const openSend = (compound = false) => showSend({
    source, fromAddress: opts.address, compound, navTitle: compound ? "Compound UTXOs" : "Send Kaspa",
    feeFooter: "If the network is busy, Fast or Priority pays a higher fee to help your withdrawal confirm sooner. Tap the fee amount to set a custom fee.",
    onClose: () => { paint(); loadHistory(); loadCoins(); },
  });

  const addressActions = () => showSheet({
    title: "Address Actions",
    cancel: false,
    rows: [
      { label: "View Private Key", subtitle: "The key that spends this address. Never share it.", icon: SF.keyFill, onClick: () => gatePrivateKey({ title: "Chatting Address", source, onBack: back }) },
      { label: "View Public Key", subtitle: "The public half of this address, for anyone who asks for it.", icon: SF.number, onClick: () => showPublicKey({ source, onBack: back }) },
      { label: "View in Explorer", subtitle: "Opens this address on your chosen block explorer.", icon: SF.globe, onClick: () => window.open(wallet.explorerAddressUrl(opts.address), "_blank", "noopener") },
      // The extension's home for the picker iOS shows in its Welcome Guide after an import.
      ...(opts.onChangeIdentity ? [{ label: "Change Chatting Address", subtitle: "Pick another address of this seed that already holds your identity.", icon: SF.person, onClick: () => showChattingAddressPicker({ onBack: back, onChanged: opts.onChangeIdentity }) }] : []),
    ],
  });

  function paint() {
    const total = balance();
    const scroll = app.querySelector(".manage-scroll")?.scrollTop || 0;
    render(`
      ${navHeader({ title: "Chatting Address" })}
      <div class="manage-scroll">
        <div class="ios-balance"><span class="muted tiny">Balance</span><span class="ios-balance-value">${total != null ? `${esc(formatKas8(total))} KAS` : '<span class="spinner small-spin"></span>'}</span></div>
        <div class="segmented wide" role="tablist">
          <button type="button" role="tab" data-tab="history" aria-checked="${state.tab === "history"}">Transaction History</button>
          <button type="button" role="tab" data-tab="utxos" aria-checked="${state.tab === "utxos"}">UTXOs (${state.coins ? state.coins.length : 0})</button>
        </div>
        <button class="ios-capsule" id="address-actions">Address Actions</button>
        ${state.tab === "history"
          ? `<div class="glass list">${historyHtml(state)}</div>`
          : utxosHtml(state, "Combines all UTXOs at this address into a single one, to reduce the number of inputs a future send needs.")}
      </div>
      <div class="ios-bottom-bar">
        <button class="ios-capsule with-icon" id="receive">${SF.qrcode}<span>Receive</span></button>
        <button class="ios-capsule with-icon" id="send" ${total === 0n ? "disabled" : ""}>${SF.sendFill}<span>Send</span></button>
      </div>`, "manage-chat");
    remember(() => paint());
    const scroller = app.querySelector(".manage-scroll");
    if (scroller) scroller.scrollTop = scroll;
    $("#back").onclick = opts.onBack;
    for (const tab of app.querySelectorAll("[data-tab]")) tab.onclick = () => { state.tab = tab.dataset.tab; paint(); };
    $("#address-actions").onclick = addressActions;
    $("#receive").onclick = () => showQr({
      address: opts.address, balanceSompi: total, backLabel: "Close", onBack: back,
      note: "This address is for chatting and KNS profile creation. Funding it with around 50 Kaspa is enough to create a KNS profile and send messages for a long time.",
    });
    $("#send").onclick = () => openSend(false);
    bindTabsContent(state, { address: opts.address, repaint: paint, reloadHistory: loadHistory, reloadCoins: loadCoins, onCompound: () => openSend(true) });
  }

  paint();
  wallet.utxoLabels(opts.address).then((labels) => { state.labels = labels; repaintIfHere(); });
  loadHistory();
  loadCoins();
}

// --- Spending addresses: iOS ManageAddressesView -----------------------------------------------

let listSnapshot = null; // paints instantly next time (iOS kachat_spending_entries_cache)
const domainOwners = new Map(); // address -> owns a KNS domain

function displayLabel(row) { return row.label; }

// iOS sortedEntries: primary, then addresses holding Kaspa or a domain, then fresh ones; funded
// before unfunded, higher index first.
function sortRows(rows) {
  const active = (r) => r.balanceSompi > 0n || domainOwners.get(r.address);
  const rank = (r) => (r.primary ? 0 : active(r) ? 1 : 2);
  return [...rows].sort((a, b) => rank(a) - rank(b) || Number(b.balanceSompi > 0n) - Number(a.balanceSompi > 0n) || b.index - a.index);
}

export function showManageAddresses({ onBack }) {
  const state = { list: listSnapshot, loading: !listSnapshot, used: new Map(), busy: null, discovery: null, summary: "", error: "" };
  const back = () => { paint(); load(); };
  const here = () => app.dataset.screen === "manage-list";
  let actionsSheet = null;

  const visibleRows = () => (state.list?.rows || []).filter((r) => !r.hidden);

  const load = async () => {
    try {
      state.list = await wallet.spendingList();
      listSnapshot = state.list;
      state.error = "";
    } catch (error) {
      state.error = error.message;
    }
    state.loading = false;
    if (here()) paint();
    probeUsed();
    probeDomains();
  };

  // iOS: funded rows are used; the rest use what is known, then transactions-count 8 at a time,
  // lowest index first.
  const probeUsed = async () => {
    const rows = [...(state.list?.rows || [])].sort((a, b) => a.index - b.index);
    const queue = [];
    for (const row of rows) {
      if (row.balanceSompi > 0n) { state.used.set(row.address, true); continue; }
      const known = await wallet.knownUsedState(row.address);
      if (known != null) state.used.set(row.address, known); else if (!row.hidden) queue.push(row);
    }
    if (here()) paint();
    const worker = async () => {
      for (let row = queue.shift(); row; row = queue.shift()) {
        const used = await wallet.addressUsed(row.address);
        state.used.set(row.address, used == null ? "checking" : used);
        if (here()) paint();
      }
    };
    await Promise.all(Array.from({ length: 8 }, worker));
  };

  const probeDomains = async () => {
    const queue = visibleRows().filter((r) => !domainOwners.has(r.address));
    const worker = async () => {
      for (let row = queue.shift(); row; row = queue.shift()) {
        try {
          const data = await wallet.domains(row.address);
          domainOwners.set(row.address, data.domains.length > 0);
        } catch { /* leave unknown */ }
      }
    };
    await Promise.all(Array.from({ length: 4 }, worker));
    if (here()) paint();
  };

  const usedBadge = (row) => {
    const used = row.balanceSompi > 0n ? true : state.used.get(row.address);
    if (used === true) return '<span class="used-badge used">Used</span>';
    if (used === false) return '<span class="used-badge unused">Unused</span>';
    return '<span class="used-badge">Checking</span>';
  };

  const rowActions = (row) => {
    const hideable = !row.primary && row.balanceSompi === 0n;
    showSheet({
      title: row.customLabel || `Address ${row.index}`,
      subtitle: shortAddress(row.address),
      cancel: false,
      rows: [
        { label: "Rename Address", subtitle: "Gives this address a label of your own.", icon: SF.pencil, onClick: () => renameAddress(row) },
        { label: "Copy Address", subtitle: "Puts the full address on the clipboard.", icon: SF.doc, onClick: () => copyText(row.address) },
        { label: "Show QR Code", subtitle: "Full screen, for scanning with another device.", icon: SF.qrcode, onClick: () => showQr({ title: `Address #${row.index}`, address: row.address, backLabel: "Close", onBack: back }) },
        ...(row.primary ? [] : [{ label: "Set as Primary Address", subtitle: "New payments send from here by default.", icon: SF.star, onClick: () => setPrimary(row) }]),
        ...(hideable ? [{ label: "Hide Address", subtitle: "Removes it from this list. Re-enable it in Address Visibility.", icon: SF.eyeSlash, tint: "orange", onClick: () => hideAddress(row) }] : []),
      ],
    });
  };

  const renameAddress = (row) => showAlert({
    title: "Rename Address",
    message: "Give this address a label to help you recognize it.",
    field: { placeholder: "Label", value: row.customLabel || "" },
    confirmLabel: "Save",
    cancelLabel: "Cancel",
    onConfirm: async (value) => { await wallet.setSpendingLabel(row.index, value); load(); },
  });

  const setPrimary = async (row) => {
    state.busy = { primary: row.index };
    paint();
    try { await wallet.setPrimarySpending(row.index); } catch (error) { toast(error.message); }
    state.busy = null;
    load();
  };

  const hideAddress = async (row) => {
    try {
      // The balance is checked again on chain before hiding (iOS setSpendingAddressHidden).
      const live = (await wallet.balancesFor([row.address]))[row.address] ?? 0n;
      if (live > 0n || row.primary) throw new Error("This address can't be hidden.");
      await wallet.setSpendingHidden(row.index, true);
      toast("Address hidden. Re-enable it in Address Visibility.");
      load();
    } catch {
      toast("This address can't be hidden.");
    }
  };

  const actionRows = () => {
    const discovering = Boolean(state.discovery);
    const busy = state.busy === "generate";
    return [
      { label: "Generate New Spending Address", subtitle: "Reveals the next unused address in this wallet.", icon: SF.plusCircle, busy, disabled: discovering, onClick: generate },
      { label: "Discover Addresses", subtitle: "Finds addresses holding a balance or a KNS domain.", icon: SF.magnifier, disabled: discovering, keepOpen: true, onClick: discover },
      { label: "Address Visibility", subtitle: "Check off every address you want on the list, in one sitting.", icon: SF.checklist, disabled: discovering, onClick: () => showVisibility({ onBack: back }) },
      { label: "Send All Kaspa To Primary", subtitle: "Sweeps every other address into your primary spending address.", icon: SF.upToLine, disabled: discovering, onClick: () => showConsolidate({ list: state.list, onBack: back }) },
    ];
  };

  const discoveryHtml = () => {
    const d = state.discovery;
    if (!d) return state.summary ? `<p class="muted small strong sheet-summary">${esc(state.summary)}</p>` : "";
    return `
      <div class="discovery">
        <span class="spinner"></span>
        <div class="strong">Checking address #${d.checkingIndex}</div>
        <div class="muted small">${d.foundCount ? `${d.foundCount} found so far` : "No addresses with a balance or domain yet"}</div>
        <div class="muted tiny">Checks the first thousand addresses whatever the gaps, then keeps going while it keeps finding.</div>
        <button class="sheet-row center-text" id="keep-scanning"><span class="sheet-label">Close and Keep Scanning</span></button>
      </div>`;
  };

  const openActions = () => {
    actionsSheet = showSheet({
      title: "Address Actions",
      cancel: false,
      rows: state.discovery ? [] : actionRows(),
      footerHtml: discoveryHtml(),
    });
    bindKeepScanning();
  };
  const refreshActions = () => {
    if (!actionsSheet?.isOpen()) return;
    actionsSheet.update({ rows: state.discovery ? [] : actionRows(), footerHtml: discoveryHtml() });
    bindKeepScanning();
  };
  const bindKeepScanning = () => {
    const keep = document.querySelector("#keep-scanning");
    if (keep) keep.onclick = () => actionsSheet.close();
  };

  async function generate() {
    state.busy = "generate";
    paint();
    try {
      const index = await wallet.generateSpendingAddress();
      toast(`Spending address #${index} is ready.`);
    } catch (error) {
      toast(error.message);
    }
    state.busy = null;
    load();
  }

  async function discover() {
    state.discovery = { checkingIndex: 0, foundCount: 0 };
    state.summary = "";
    refreshActions();
    paint();
    let message;
    try {
      const found = await wallet.discoverSpendingAddresses((progress) => { state.discovery = progress; refreshActions(); });
      message = found ? `Found ${found} address${found === 1 ? "" : "es"} with a balance or domain.` : "No addresses with a balance or domain found.";
    } catch (error) {
      message = error.message;
    }
    state.discovery = null;
    // Sheet still open: the result shows under the rows. Closed: it arrives as a toast.
    if (actionsSheet?.isOpen()) { state.summary = message; refreshActions(); } else toast(message);
    load();
  }

  function paint() {
    const rows = sortRows(visibleRows());
    const total = rows.reduce((sum, r) => sum + r.balanceSompi, 0n);
    const busy = Boolean(state.discovery) || state.busy === "generate";
    const scroll = app.querySelector(".manage-scroll")?.scrollTop || 0;
    render(`
      ${navHeader({ title: "Manage Addresses" })}
      <div class="manage-scroll">
        <div class="ios-balance"><span class="muted tiny">Total Balance</span><span class="ios-balance-value big">${state.list ? `${esc(formatKas8(total))} KAS` : '<span class="spinner small-spin"></span>'}</span></div>
        <button class="ios-capsule" id="address-actions" ${busy ? "disabled" : ""}>${busy ? '<span class="spinner dark-spinner small-spin"></span>' : "Address Actions"}</button>
        ${state.error ? `<p class="error">${esc(state.error)}</p>` : ""}
        ${state.loading && !state.list ? '<div class="center-text"><span class="spinner"></span></div>' : ""}
        ${state.list && !rows.length ? `
          <div class="km-empty"><span class="muted">${SF.creditcard}</span><div class="km-title">No Spending Addresses</div>
          <p class="muted small">Generate one below to start sending payments from a separate address than the one you chat from.</p></div>` : ""}
        ${rows.map((row) => `
          <div class="glass address-card" data-open="${row.index}" role="button" tabindex="0">
            <div class="address-card-main">
              <span class="muted small medium">${esc(displayLabel(row))}${row.primary ? ` <span class="accent">${SF.starFill}</span>` : ""}</span>
              <span class="mono small">${esc(shortAddress(row.address))}</span>
              <span class="strong small">${esc(formatKas8(row.balanceSompi))} KAS</span>
              <span class="address-status">${usedBadge(row)}${domainOwners.get(row.address) ? '<span class="domain-tag">Contains domain</span>' : ""}</span>
            </div>
            ${state.busy?.primary === row.index
              ? '<span class="spinner small-spin"></span>'
              : `<button class="icon plain card-menu" data-menu="${row.index}" aria-label="More" ${state.busy?.primary != null ? "disabled" : ""}>${SF.ellipsisV}</button>`}
          </div>`).join("")}
      </div>`, "manage-list");
    remember(() => paint());
    const scroller = app.querySelector(".manage-scroll");
    if (scroller) scroller.scrollTop = scroll;
    $("#back").onclick = onBack;
    $("#address-actions").onclick = openActions;
    const byIndex = (index) => state.list.rows.find((r) => r.index === Number(index));
    for (const card of app.querySelectorAll("[data-open]")) {
      card.onclick = (event) => {
        if (event.target.closest("[data-menu]")) return;
        showSpendingAddress({ row: byIndex(card.dataset.open), onBack: back });
      };
      card.onkeydown = (event) => { if (event.key === "Enter") card.click(); };
    }
    for (const button of app.querySelectorAll("[data-menu]")) button.onclick = () => rowActions(byIndex(button.dataset.menu));
  }

  paint();
  load();
}

// --- one spending address: iOS SpendingAddressTransactionHistoryView ---------------------------

function showSpendingAddress({ row, onBack }) {
  const source = { kind: "spending", index: row.index };
  const title = row.label;
  const state = {
    tab: "history", history: null, historyLoading: false, coins: null, coinsLoading: false, coinsError: "", labels: {},
    domains: null, domainsLoading: false, domainsFailed: false,
  };
  const back = () => paint();
  const here = () => app.dataset.screen === "manage-spending";
  const repaintIfHere = () => { if (here()) paint(); };
  const { loadHistory, loadCoins } = loaders(state, row.address, repaintIfHere);
  const loadDomains = () => {
    state.domainsLoading = true;
    repaintIfHere();
    wallet.domains(row.address, { force: true })
      .then((data) => { state.domains = data.domains; state.domainsFailed = false; })
      .catch(() => { state.domainsFailed = true; })
      .finally(() => { state.domainsLoading = false; repaintIfHere(); });
  };

  const openSend = (compound = false) => showSend({
    source, fromAddress: row.address, compound,
    navTitle: compound ? "Compound UTXOs" : `Send Kaspa from Address #${row.index}`,
    feeFooter: "If the network is busy, Fast or Priority pays a higher fee to help this confirm sooner. Tap the fee amount to set a custom fee.",
    onClose: () => { paint(); loadHistory(); loadCoins(); },
  });

  const domainsHtml = () => {
    if (!state.domains && state.domainsLoading) return '<div class="glass list"><div class="list-row center-row"><span class="spinner small-spin"></span></div></div>';
    if (state.domainsFailed && !state.domains) return '<div class="glass list"><div class="list-row muted">Could not load KNS domains. Pull to retry.</div></div>';
    if (!state.domains?.length) return '<div class="glass list"><div class="list-row muted">No KNS domains on this address.</div></div>';
    return state.domains.map((domain, i) => {
      const sendable = Boolean(domain.inscriptionId) && domain.status !== "listed";
      return `
        <button class="domain-button ${sendable ? "" : "dim"}" data-domain="${i}" ${sendable ? "" : "disabled"}>
          <div class="domain-card"><span class="domain-name">${esc(domain.fullName)}</span></div>
          ${sendable ? "" : '<span class="muted tiny">This domain is listed and can\'t be sent right now.</span>'}
        </button>`;
    }).join("");
  };

  function paint() {
    const scroll = app.querySelector(".manage-scroll")?.scrollTop || 0;
    render(`
      <header class="navbar">
        <button class="nav-back" id="back" aria-label="Back">${ICONS.back}<span>Back</span></button>
        <div class="nav-title ellipsis">${esc(title)}</div>
        <div class="nav-right bar-circles">
          <button class="bar-circle" id="export-key" aria-label="Export private key" title="Private key">${SF.exportKey}</button>
          <a class="bar-circle" href="${esc(wallet.explorerAddressUrl(row.address))}" target="_blank" rel="noopener noreferrer" aria-label="View in Explorer" title="View in Explorer">${SF.globe}</a>
        </div>
      </header>
      <div class="manage-scroll">
        <div class="ios-balance"><span class="muted tiny">Balance</span><span class="ios-balance-value">${esc(formatKas8(row.balanceSompi))} KAS</span></div>
        <div class="segmented wide three" role="tablist">
          <button type="button" role="tab" data-tab="history" aria-checked="${state.tab === "history"}">History</button>
          <button type="button" role="tab" data-tab="utxos" aria-checked="${state.tab === "utxos"}">UTXOs (${state.coins ? state.coins.length : 0})</button>
          <button type="button" role="tab" data-tab="domains" aria-checked="${state.tab === "domains"}">KNS Domains (${state.domains ? state.domains.length : 0})</button>
        </div>
        ${state.tab === "history" ? `<div class="glass list">${historyHtml(state)}</div>`
          : state.tab === "utxos" ? utxosHtml(state, "Combines this address's UTXOs to reduce the inputs a future send needs. A single transaction can only merge so many at once, so if this address has a very large number, tap Compound again after it confirms to keep reducing.")
          : domainsHtml()}
      </div>
      <div class="ios-bottom-bar">
        <button class="ios-capsule with-icon" id="receive">${SF.qrcode}<span>Receive</span></button>
        <button class="ios-capsule with-icon" id="send" ${row.balanceSompi === 0n ? "disabled" : ""}>${SF.sendFill}<span>Send</span></button>
      </div>`, "manage-spending");
    remember(() => paint());
    const scroller = app.querySelector(".manage-scroll");
    if (scroller) scroller.scrollTop = scroll;
    $("#back").onclick = onBack;
    $("#export-key").onclick = () => gatePrivateKey({ title, source, onBack: back });
    for (const tab of app.querySelectorAll("[data-tab]")) tab.onclick = () => { state.tab = tab.dataset.tab; paint(); };
    $("#receive").onclick = () => showQr({ title: `Address #${row.index}`, address: row.address, backLabel: "Close", onBack: back });
    $("#send").onclick = () => openSend(false);
    for (const button of app.querySelectorAll("[data-domain]")) {
      button.onclick = () => showSendDomain({ domain: state.domains[Number(button.dataset.domain)], source, onBack: back, onSent: () => { paint(); loadDomains(); } });
    }
    bindTabsContent(state, { address: row.address, repaint: paint, reloadHistory: loadHistory, reloadCoins: loadCoins, onCompound: () => openSend(true) });
  }

  paint();
  wallet.utxoLabels(row.address).then((labels) => { state.labels = labels; repaintIfHere(); });
  loadHistory();
  loadCoins();
  loadDomains();
}

// --- Address Visibility: iOS SpendingAddressVisibilityView -----------------------------------
//
// Pages of 50 with a #start - #end pager that never runs out: pages past the revealed range
// derive the next indexes, and checking one of those reveals it (the ones in between are hidden).
// The primary never toggles; an address holding Kaspa can be shown but not hidden.

function showVisibility({ onBack }) {
  const PAGE = 50;
  const state = { page: 0, rows: null, loading: true, list: null, used: new Map() };
  const here = () => app.dataset.screen === "visibility";

  const loadPage = async () => {
    state.loading = true;
    state.rows = null;
    paint();
    try {
      state.list = await wallet.spendingList();
      const start = state.page * PAGE;
      const addresses = await wallet.spendingAddressRange(start, PAGE);
      const balances = await wallet.balancesFor(Object.values(addresses));
      const st = state.list.state;
      state.rows = Object.entries(addresses).map(([index, address]) => {
        const i = Number(index);
        const revealed = i <= st.maxIndex;
        return {
          index: i, address, revealed,
          visible: revealed && !st.hidden.includes(i),
          primary: i === st.activeIndex,
          customLabel: wallet.customLabel(st, i),
          balanceSompi: balances[address] ?? 0n,
        };
      });
    } catch {
      state.rows = [];
    }
    state.loading = false;
    if (here()) paint();
    // Used / Unused, lazily, 8 at a time.
    const queue = (state.rows || []).filter((r) => r.balanceSompi === 0n);
    const page = state.page;
    const worker = async () => {
      for (let row = queue.shift(); row; row = queue.shift()) {
        const known = await wallet.knownUsedState(row.address);
        const used = known ?? (await wallet.addressUsed(row.address));
        state.used.set(row.address, used);
        if (here() && state.page === page) paint();
      }
    };
    Promise.all(Array.from({ length: 8 }, worker));
  };

  const trailing = (row) => {
    if (row.balanceSompi > 0n) return `<span class="accent tiny">${esc((Number(row.balanceSompi) / 1e8).toFixed(4))} KAS</span>`;
    const used = state.used.get(row.address);
    if (used === true) return '<span class="used-badge used">Used</span>';
    if (used === false) return '<span class="muted tiny">Unused</span>';
    return '<span class="muted tiny">…</span>';
  };

  const toggle = async (row) => {
    if (row.primary) return;
    if (row.visible && row.balanceSompi > 0n) return; // hiding is blocked for funded addresses
    try {
      if (!row.revealed) await wallet.revealSpendingAddress(row.index);
      else await wallet.setSpendingHidden(row.index, row.visible);
    } catch (error) {
      toast(error.message);
      return;
    }
    await loadPage();
  };

  function paint() {
    const start = state.page * PAGE;
    render(`
      <header class="navbar form-bar">
        <span></span>
        <div class="nav-title">Address Visibility</div>
        <button class="bar-text strong" id="done">Done</button>
      </header>
      <div class="manage-scroll flush">
        ${state.loading ? '<div class="center-text pad"><span class="spinner"></span></div>'
          : !state.rows?.length ? '<p class="muted center-text pad">These addresses couldn\'t be derived right now. Go back a page or reopen this screen to retry.</p>'
          : `<div class="plain-list">${state.rows.map((row) => {
              const locked = row.primary || (row.visible && row.balanceSompi > 0n);
              return `
                <button class="vis-row ${locked ? "locked" : ""}" data-vis="${row.index}" ${locked ? "aria-disabled=\"true\"" : ""}>
                  <span class="${row.visible ? "accent" : "muted"}">${row.visible ? ICONS.circleCheck : ICONS.circle}</span>
                  <span class="tx-meta">
                    <span><span class="strong small mono-digits">#${row.index}</span>${row.primary ? ' <span class="accent tiny strong">Primary</span>' : ""}${row.customLabel ? ` <span class="muted tiny">${esc(row.customLabel)}</span>` : ""}</span>
                    <span class="mono tiny muted">${esc(`${row.address.slice(0, 16)}…${row.address.slice(-6)}`)}</span>
                  </span>
                  ${trailing(row)}
                </button>`;
            }).join("")}</div>`}
      </div>
      <div class="pager">
        <button class="icon plain accent" id="prev" ${state.page === 0 ? "disabled" : ""} aria-label="Previous page">${SF.chevronLeft}</button>
        <span class="strong small mono-digits">#${start} - #${start + PAGE - 1}</span>
        <button class="icon plain accent" id="next" aria-label="Next page">${SF.chevronRight}</button>
      </div>`, "visibility");
    $("#done").onclick = onBack;
    $("#prev").onclick = () => { if (state.page > 0) { state.page -= 1; loadPage(); } };
    $("#next").onclick = () => { state.page += 1; loadPage(); };
    for (const button of app.querySelectorAll("[data-vis]")) {
      button.onclick = () => toggle(state.rows.find((r) => r.index === Number(button.dataset.vis)));
    }
  }

  paint();
  loadPage();
}

// --- Send All Kaspa To Primary: iOS ConsolidateToPrimaryConfirmView ----------------------------

const TIERS = [["normal", "Normal", 1], ["fast", "Fast", 2], ["priority", "Priority", 5]];

async function showConsolidate({ list, onBack }) {
  const rows = list?.rows || [];
  const primary = rows.find((r) => r.primary);
  const sources = rows.filter((r) => !r.primary && r.balanceSompi > 0n);
  const state = { tier: "normal", customKas: null, editing: false, sending: false, base: null };
  try { state.base = (await wallet.maxFee(1)).policyKas; } catch { state.base = 0.002; }
  const feeKas = () => state.customKas ?? state.base * (TIERS.find((t) => t[0] === state.tier)?.[2] || 1);

  const paint = () => {
    const fee = feeKas();
    render(`
      <header class="navbar form-bar">
        <button class="bar-text" id="cancel" ${state.sending ? "disabled" : ""}>Cancel</button>
        <div class="nav-title">Consolidate to Primary</div>
        ${state.sending ? '<span class="bar-text"><span class="spinner small-spin"></span></span>' : `<button class="bar-text strong" id="confirm" ${sources.length ? "" : "disabled"}>Confirm</button>`}
      </header>
      <section class="form">
        <div class="form-section">
          <div class="form-header">From</div>
          <div class="form-card">
            ${sources.length ? sources.map((r) => `
              <div class="form-row between">
                <span class="tx-meta"><span class="muted tiny">${esc(r.label)}</span><span class="mono small">${esc(shortAddress(r.address))}</span></span>
                <span class="strong">${esc(wallet.sompiToKasText(r.balanceSompi))} KAS</span>
              </div>`).join("") : '<div class="form-row muted">No other addresses have a balance to consolidate.</div>'}
          </div>
        </div>
        <div class="form-section">
          <div class="form-header">To (Primary Address)</div>
          <div class="form-card"><div class="form-row"><span class="mono small ellipsis">${esc(primary?.address || "")}</span></div></div>
        </div>
        ${sources.length ? `
        <div class="form-section">
          <div class="form-header">Fee</div>
          <div class="form-card">
            <div class="form-row"><div class="segmented wide" role="radiogroup" aria-label="Fee">
              ${TIERS.map(([id, label]) => `<button type="button" role="radio" data-tier="${id}" aria-checked="${state.customKas == null && state.tier === id}">${label}</button>`).join("")}
            </div></div>
            <div class="form-row between">
              <span>Network Fee</span>
              ${state.editing
                ? `<span class="fee-edit"><input id="custom-fee" inputmode="decimal" placeholder="0.00" value="${esc(String(+fee.toFixed(8)))}" /><button class="icon plain" id="fee-ok" aria-label="Use this fee">${ICONS.checkCircle}</button></span>`
                : `<button class="link-button underline" id="fee">~${esc(String(+fee.toFixed(8)))} KAS ${ICONS.pencilSmall}</button>`}
            </div>
          </div>
          <div class="form-footer">${sources.length >= 2
            ? `${sources.length} separate transactions will be sent, one per address. Fast or Priority pays a higher fee to help them confirm sooner. Tap the fee amount to set a custom fee, applied to each.`
            : "If the network is busy, Fast or Priority pays a higher fee to help this confirm sooner. Tap the fee amount to set a custom fee."}</div>
        </div>` : ""}
      </section>`, "consolidate");
    $("#cancel").onclick = onBack;
    for (const button of app.querySelectorAll("[data-tier]")) button.onclick = () => { state.tier = button.dataset.tier; state.customKas = null; paint(); };
    const feeButton = $("#fee");
    if (feeButton) feeButton.onclick = () => { state.editing = true; paint(); $("#custom-fee")?.select(); };
    const feeOk = $("#fee-ok");
    if (feeOk) {
      const commit = () => {
        const value = Number($("#custom-fee").value);
        state.editing = false;
        // Below the normal fee is clamped up to it.
        if (Number.isFinite(value) && value > 0) state.customKas = Math.max(value, state.base);
        paint();
      };
      feeOk.onclick = commit;
      $("#custom-fee").onkeydown = (event) => { if (event.key === "Enter") commit(); };
    }
    const confirm = $("#confirm");
    if (confirm) confirm.onclick = run;
  };

  // One Max send per source, in turn; an error does not stop the rest.
  const run = async () => {
    state.sending = true;
    paint();
    const multiplier = TIERS.find((t) => t[0] === state.tier)?.[2] || 1;
    const txids = [];
    let lastError = null;
    for (const source of sources) {
      try {
        const coins = await wallet.utxos(source.address);
        if (!coins.length) continue;
        const base = (await wallet.maxFee(coins.length)).policyKas;
        const total = state.customKas != null ? Math.max(state.customKas, base) : base * multiplier;
        const result = await wallet.send({ source: { kind: "spending", index: source.index }, destination: primary.address, max: true, totalFeeKas: total.toFixed(8) });
        txids.push(...(result?.txids || []));
      } catch (error) {
        lastError = error;
      }
    }
    state.sending = false;
    if (txids.length) return showConsolidateSuccess({ txids, onDone: onBack });
    paint();
    if (lastError) showAlert({ title: "Something Went Wrong", message: String(lastError?.message || lastError), confirmLabel: "OK" });
  };

  paint();
}

function showConsolidateSuccess({ txids, onDone }) {
  render(`
    <section class="screen sent">
      <div class="sent-check" style="color:#30d158">${ICONS.checkBig}</div>
      <h2>Sent</h2>
      ${txids.map((txid) => `<a class="mono tiny break link-button underline" href="${esc(wallet.explorerTxUrl(txid))}" target="_blank" rel="noopener noreferrer">${esc(txid)}</a>`).join("")}
      <div class="spacer"></div>
      <button id="ok" class="big">OK</button>
    </section>`, "sent");
  $("#ok").onclick = onDone;
}

// --- Change Chatting Address: iOS ChattingAddressPickerView ------------------------------------
//
// For imported accounts: the phrase may already hold your identity at another index of its
// family - a KNS domain or a funded balance. Scans 50 at a time; lists an index when it holds
// Kaspa or domains, or is #0, or is the current one.

function showChattingAddressPicker({ onBack, onChanged }) {
  const state = { rows: [], scanned: 0, scanning: false, current: 0, error: "" };
  const pickerBack = () => { state.scanning = false; paint(); };

  const scan = async () => {
    state.scanning = true;
    state.error = "";
    paint();
    try {
      const { rows, currentIndex } = await wallet.scanIdentityAddresses(state.scanned, 50);
      state.current = currentIndex;
      state.rows.push(...rows);
      state.scanned += 50;
    } catch {
      state.error = "Could not derive addresses from this seed. Please try again.";
    }
    state.scanning = false;
    if (app.dataset.screen === "identity-picker") paint();
  };

  const paint = () => {
    const shown = state.rows.filter((r) => r.balanceSompi > 0n || r.domains?.length || r.index === 0 || r.index === state.current);
    render(`
      ${navHeader({ title: "Chatting Address" })}
      <section class="screen manage">
        <div class="source-head">
          <h2>Choose Your Chatting Address</h2>
          <p class="muted">If this seed already holds your identity at a different address - a KNS domain or a funded chatting balance - pick it here. Only addresses with a balance or domains are shown.</p>
        </div>
        <div class="glass list">
          ${shown.map((row) => `
            <button class="list-row identity-row" data-index="${row.index}">
              <span class="identity-index">#${row.index}</span>
              <span class="tx-meta"><span class="mono small">${esc(row.address.slice(0, 10))}...${esc(row.address.slice(-6))}</span><span class="muted tiny">${esc(wallet.formatKas(row.balanceSompi, 8))} KAS</span></span>
              ${row.domains?.length ? `<span class="chip accent">${esc(row.domains.length === 1 ? row.domains[0].fullName : `${row.domains.length} domains`)}</span>` : ""}
              <span class="${row.index === state.current ? "accent strong" : "muted strong"} tiny">${row.index === state.current ? "Current" : row.index === 0 ? "Default" : ""}</span>
              ${ICONS.chevron}
            </button>`).join("") || (state.scanning ? "" : '<div class="list-row muted">Nothing found yet.</div>')}
        </div>
        ${state.error ? `<p class="error">${esc(state.error)}</p>` : ""}
        ${state.scanning
          ? `<p class="muted small center-text"><span class="spinner small-spin"></span> Scanning addresses ${state.scanned + 1} to ${state.scanned + 50}...</p>`
          : state.scanned ? `<p class="muted small center-text">Scanned the first ${state.scanned} addresses.</p><button class="soft with-icon" id="further">${ICONS.search}<span>Scan Further</span></button>` : ""}
      </section>`, "identity-picker");
    $("#back").onclick = onBack;
    const further = $("#further");
    if (further) further.onclick = scan;
    for (const button of app.querySelectorAll("[data-index]")) {
      const row = state.rows.find((r) => r.index === Number(button.dataset.index));
      button.onclick = () => showIdentityDetail({ row, current: state.current, onBack: pickerBack, onChanged });
    }
  };
  paint();
  scan();
}

function showIdentityDetail({ row, current, onBack, onChanged }) {
  const isCurrent = row.index === current;
  render(`
    ${navHeader({ title: "Chatting Address" })}
    <section class="screen manage">
      <h2>Address #${row.index}</h2>
      <button class="manage-address mono" id="copy">${esc(row.address)}</button>
      <p class="muted tiny center-text">Tap the address to copy it</p>
      <div class="glass list"><div class="list-row"><span>Balance</span><span>${esc(wallet.formatKas(row.balanceSompi, 8))} KAS</span></div></div>
      ${row.domains?.length ? `
        <div class="section-header">KNS Domains (${row.domains.length})</div>
        ${row.domains.map((d) => `<div class="domain-card small-card"><span class="domain-name">${esc(d.fullName)}</span>${String(d.fullName).toLowerCase() === String(row.primaryDomain || "").toLowerCase() ? '<span class="domain-badge">Primary</span>' : ""}</div>`).join("")}` : ""}
      <p class="error" id="error"></p>
      <div class="spacer"></div>
      <button id="set" ${isCurrent ? "disabled" : ""}>${isCurrent ? "Current Chatting Address" : "Set as Chatting Address"}</button>
    </section>`, "identity-detail");
  $("#back").onclick = onBack;
  $("#copy").onclick = () => copyText(row.address);
  $("#set").onclick = async () => {
    const button = $("#set");
    button.disabled = true;
    button.innerHTML = '<span class="spinner"></span>';
    try {
      const view = await vault.readAccounts();
      await vault.setIdentityIndex(view.activeAccountId, row.index);
      await wallet.deriveAddresses();
      toast(`Chatting address set to #${row.index}.`);
      onChanged();
    } catch (error) {
      $("#error").textContent = error.message;
      button.disabled = false;
      button.textContent = "Set as Chatting Address";
    }
  };
}
