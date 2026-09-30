// Manage screens - iOS ChattingAddressManageView and ManageAddressesView:
//   Manage (one address): balance, the address, Receive / Send / Compound, History and UTXOs
//     tabs, View in Explorer, Public Key, and the private key behind the wallet password.
//   Manage Addresses (the spending chain): total, every visible spending address with its
//     balance, and the menu - Generate New Spending Address, Discover Addresses, Address
//     Visibility, Send All Kaspa To Primary. Each row opens its own Manage screen with Rename,
//     Set as Primary and Hide.

import * as wallet from "./wallet.js";
import * as vault from "./vault.js";
import { app, esc, render, $, toast, copyText, ICONS, navHeader, showQr } from "./ui.js";
import { showSend } from "./send.js";

// --- one address ------------------------------------------------------------------------------

/**
 * @param {object} opts
 * @param {{kind:"main"}|{kind:"spending",index:number}} opts.source
 * @param {string} opts.address
 * @param {string} opts.title
 * @param {Function} opts.onBack
 * @param {object} [opts.spending] { index, label, primary, hidden } for spending rows
 */
export function showManageAddress(opts) {
  const state = { tab: "history", balance: null, history: null, historyError: "", coins: null, spending: opts.spending || null };
  const back = () => showManageAddress(opts);

  const load = async () => {
    wallet.balancesFor([opts.address]).then((b) => { state.balance = b[opts.address] ?? 0n; paintIfHere(); }).catch(() => {});
    wallet.history(opts.address).then((h) => { state.history = h; paintIfHere(); }).catch((error) => { state.historyError = error.message; paintIfHere(); });
    wallet.utxos(opts.address).then((c) => { state.coins = c; paintIfHere(); }).catch(() => { state.coins = []; paintIfHere(); });
  };
  const paintIfHere = () => { if (app.dataset.screen === `manage:${opts.address}`) paint(); };

  const paint = () => {
    const sp = state.spending;
    render(`
      ${navHeader({ title: opts.title })}
      <section class="screen manage">
        <div class="manage-balance">${state.balance != null ? `${esc(wallet.formatKas(state.balance, 8))} <span>KAS</span>` : '<span class="spinner"></span>'}</div>
        <button class="manage-address mono" id="copy" title="Copy">${esc(opts.address)}</button>
        ${sp ? `<div class="chips">${sp.primary ? '<span class="chip accent">Primary</span>' : ""}${sp.hidden ? '<span class="chip">Hidden</span>' : ""}</div>` : ""}
        <div class="manage-actions">
          <button class="manage-action" id="receive"><span class="circle-action">${ICONS.qr}</span><span>Receive</span></button>
          <button class="manage-action" id="send"><span class="circle-action">${ICONS.sendCircle}</span><span>Send</span></button>
          <button class="manage-action" id="compound"><span class="circle-action">${ICONS.merge}</span><span>Compound</span></button>
        </div>
        <div class="segmented wide" role="tablist">
          <button type="button" role="tab" data-tab="history" aria-checked="${state.tab === "history"}">History</button>
          <button type="button" role="tab" data-tab="utxos" aria-checked="${state.tab === "utxos"}">UTXOs${state.coins ? ` (${state.coins.length})` : ""}</button>
        </div>
        <div class="glass list">${state.tab === "history" ? historyHtml(state) : utxosHtml(state)}</div>
        <div class="glass list">
          ${sp ? `
            <button class="list-row" id="rename"><span>Rename</span>${ICONS.chevron}</button>
            ${sp.primary ? "" : `<button class="list-row" id="primary"><span>Set as Primary</span>${ICONS.chevron}</button>`}
            ${sp.primary ? "" : `<button class="list-row" id="hide"><span>${sp.hidden ? "Show in Manage Addresses" : "Hide"}</span>${ICONS.chevron}</button>`}` : ""}
          <a class="list-row" href="${esc(wallet.explorerAddressUrl(opts.address))}" target="_blank" rel="noopener noreferrer"><span>View in Explorer</span>${ICONS.chevron}</a>
          <button class="list-row" id="pubkey"><span>Public Key</span>${ICONS.chevron}</button>
          <button class="list-row danger-text" id="privkey"><span>View Private Key</span>${ICONS.chevron}</button>
        </div>
      </section>`, `manage:${opts.address}`);

    $("#back").onclick = opts.onBack;
    $("#copy").onclick = () => copyText(opts.address);
    $("#receive").onclick = () => showQr({ title: opts.title, address: opts.address, balanceSompi: state.balance, onBack: back });
    $("#send").onclick = () => showSend({ source: opts.source, fromAddress: opts.address, title: opts.title, onClose: back });
    $("#compound").onclick = () => {
      if (state.coins && state.coins.length < 2) { toast("Nothing to compound - this address holds one coin or none."); return; }
      showSend({ source: opts.source, fromAddress: opts.address, compound: true, onClose: back });
    };
    for (const tab of app.querySelectorAll("[data-tab]")) tab.onclick = () => { state.tab = tab.dataset.tab; paint(); };
    for (const row of app.querySelectorAll("[data-txid]")) row.onclick = () => window.open(wallet.explorerTxUrl(row.dataset.txid), "_blank", "noopener");
    $("#pubkey").onclick = async () => {
      try { showKey({ title: "Public Key", value: await wallet.publicKeyHex(opts.source), note: "Safe to share. It identifies this address; it cannot spend from it.", onBack: back }); }
      catch (error) { toast(error.message); }
    };
    $("#privkey").onclick = () => showPasswordGate({
      title: "View Private Key",
      onBack: back,
      onUnlocked: async () => showKey({
        title: "Private Key",
        value: await wallet.privateKeyHex(opts.source),
        secret: true,
        note: "Anyone with this key can take everything at this address. Never share it or paste it into a website.",
        onBack: back,
      }),
    });
    if (sp) {
      $("#rename").onclick = () => showRename({ index: sp.index, current: sp.label, onBack: back, onSaved: (label) => { sp.label = label; opts.title = label; back(); } });
      const primary = $("#primary");
      if (primary) primary.onclick = async () => { await wallet.setPrimarySpending(sp.index); sp.primary = true; sp.hidden = false; toast("Set as primary."); paint(); };
      const hide = $("#hide");
      if (hide) hide.onclick = async () => {
        try { await wallet.setSpendingHidden(sp.index, !sp.hidden); sp.hidden = !sp.hidden; toast(sp.hidden ? "Hidden." : "Shown."); paint(); }
        catch (error) { toast(error.message); }
      };
    }
  };
  paint();
  load();
}

function historyHtml(state) {
  if (state.historyError) return `<div class="list-row muted">${esc(state.historyError)}</div>`;
  if (!state.history) return '<div class="list-row"><span class="spinner small-spin"></span></div>';
  if (!state.history.length) return '<div class="list-row muted">No transactions yet.</div>';
  return state.history.map((tx) => `
    <button class="list-row tx" data-txid="${esc(tx.txid)}">
      <span class="tx-icon ${tx.isOutgoing ? "out" : "in"}">${tx.isSelf ? ICONS.merge : tx.isOutgoing ? ICONS.arrowUp : ICONS.arrowDown}</span>
      <span class="tx-meta"><span>${tx.isSelf ? "Compound" : tx.isOutgoing ? "Sent" : "Received"}</span><span class="muted tiny">${tx.time ? esc(new Date(tx.time).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })) : "Pending"}</span></span>
      <span class="tx-amount ${tx.isOutgoing ? "" : "in"}">${tx.isSelf ? "" : `${tx.isOutgoing ? "−" : "+"}${esc(wallet.formatKas(tx.amountSompi, 8))}`}</span>
    </button>`).join("");
}

function utxosHtml(state) {
  if (!state.coins) return '<div class="list-row"><span class="spinner small-spin"></span></div>';
  if (!state.coins.length) return '<div class="list-row muted">No coins at this address.</div>';
  return state.coins.map((coin) => `
    <div class="list-row">
      <span class="mono tiny muted">${esc(coin.transactionId.slice(0, 12))}…:${coin.index}${coin.isCoinbase ? " · mined" : ""}</span>
      <span>${esc(wallet.formatKas(coin.amount, 8))} KAS</span>
    </div>`).join("");
}

// --- keys -------------------------------------------------------------------------------------

function showPasswordGate({ title, onBack, onUnlocked }) {
  render(`
    ${navHeader({ title })}
    <section class="screen">
      <p class="muted">Enter your wallet password to continue.</p>
      <form id="form" class="stack">
        <input id="pw" type="password" autocomplete="current-password" placeholder="Password" aria-label="Password" autofocus />
        <p class="error" id="error"></p>
        <button id="ok" type="submit" class="big">Continue</button>
      </form>
    </section>`, "gate");
  $("#back").onclick = onBack;
  $("#form").onsubmit = async (event) => {
    event.preventDefault();
    const button = $("#ok");
    button.disabled = true;
    button.innerHTML = '<span class="spinner small-spin"></span>';
    if (await vault.verifyPassword($("#pw").value)) {
      try { await onUnlocked(); } catch (error) { toast(error.message); onBack(); }
    } else {
      $("#error").textContent = "Wrong password.";
      button.disabled = false;
      button.textContent = "Continue";
    }
  };
}

function showKey({ title, value, note, secret = false, onBack }) {
  render(`
    ${navHeader({ title })}
    <section class="screen">
      ${secret ? `<div class="callout warn tinted"><div class="callout-title">${ICONS.warning}<span>Keep this private</span></div><p>${esc(note)}</p></div>` : `<p class="muted">${esc(note)}</p>`}
      <div class="glass key-box mono ${secret ? "blurred-key" : ""}" id="key">${esc(value)}</div>
      ${secret ? '<button class="secondary" id="reveal">Show</button>' : ""}
      <button id="copy" class="with-icon">${ICONS.copy}<span>Copy</span></button>
    </section>`, "key");
  $("#back").onclick = onBack;
  const reveal = $("#reveal");
  if (reveal) reveal.onclick = () => { $("#key").classList.toggle("blurred-key"); reveal.textContent = $("#key").classList.contains("blurred-key") ? "Show" : "Hide"; };
  $("#copy").onclick = async () => {
    await copyText(value, secret ? "Private key" : "Public key");
    // A key left on the clipboard outlives the moment it was needed for.
    if (secret) setTimeout(async () => {
      try { if ((await navigator.clipboard.readText()) === value) await navigator.clipboard.writeText(""); } catch { /* not focused - fine */ }
    }, 30_000);
  };
}

function showRename({ index, current, onBack, onSaved }) {
  render(`
    ${navHeader({ title: "Rename" })}
    <section class="screen">
      <form id="form" class="stack">
        <input id="name" value="${esc(current)}" maxlength="40" aria-label="Address name" autofocus />
        <p class="muted small">Only on this device - nothing is written to the chain.</p>
        <button type="submit" class="big">Save</button>
      </form>
    </section>`, "rename");
  $("#back").onclick = onBack;
  $("#name").select();
  $("#form").onsubmit = async (event) => {
    event.preventDefault();
    const state = await wallet.setSpendingLabel(index, $("#name").value);
    onSaved(wallet.labelFor(state, index));
  };
}

// --- Manage Addresses (spending chain) ---------------------------------------------------------

export function showManageAddresses({ onBack }) {
  const state = { list: null, error: "", menu: false, busy: "" };
  const back = () => showManageAddresses({ onBack });

  const load = async () => {
    try { state.list = await wallet.spendingList(); state.error = ""; }
    catch (error) { state.error = error.message; }
    if (app.dataset.screen === "addresses") paint();
  };

  const paint = () => {
    const rows = state.list?.rows?.filter((row) => !row.hidden) || [];
    const total = state.list ? state.list.rows.reduce((sum, row) => sum + row.balanceSompi, 0n) : null;
    render(`
      <header class="navbar">
        <button class="nav-back" id="back" aria-label="Back">${ICONS.back}<span>Back</span></button>
        <div class="nav-title">Manage Addresses</div>
        <button class="icon nav-right" id="menu" aria-label="More">${ICONS.ellipsis}</button>
      </header>
      <section class="screen manage">
        <div class="manage-balance small-balance">${total != null ? `${esc(wallet.formatKas(total, 8))} <span>KAS</span>` : '<span class="spinner"></span>'}</div>
        <p class="muted small center-text">Total across your spending addresses</p>
        ${state.busy ? `<p class="muted small center-text"><span class="spinner small-spin"></span> ${esc(state.busy)}</p>` : ""}
        ${state.error ? `<p class="error">${esc(state.error)}</p>` : ""}
        <div class="glass list">
          ${state.list ? rows.map((row) => `
            <button class="list-row address-list-row" data-index="${row.index}">
              <span class="tx-meta"><span>${esc(row.label)} ${row.primary ? '<span class="chip accent">Primary</span>' : ""}</span><span class="mono tiny muted">${esc(wallet.shortAddress(row.address))}</span></span>
              <span class="tx-amount">${esc(wallet.formatKas(row.balanceSompi, 8))} KAS</span>
              ${ICONS.chevron}
            </button>`).join("") : '<div class="list-row"><span class="spinner small-spin"></span></div>'}
        </div>
        ${state.menu ? `
          <div class="menu-sheet" role="menu">
            <button class="menu-item" id="generate">${ICONS.plusCircleSmall}<span>Generate New Spending Address</span></button>
            <button class="menu-item" id="discover">${ICONS.search}<span>Discover Addresses</span></button>
            <button class="menu-item" id="visibility">${ICONS.eye}<span>Address Visibility</span></button>
            <button class="menu-item" id="sweep">${ICONS.merge}<span>Send All Kaspa To Primary</span></button>
          </div>` : ""}
      </section>`, "addresses");

    $("#back").onclick = onBack;
    $("#menu").onclick = () => { state.menu = !state.menu; paint(); };
    for (const row of app.querySelectorAll("[data-index]")) {
      row.onclick = () => {
        const entry = state.list.rows.find((r) => r.index === Number(row.dataset.index));
        showManageAddress({
          source: { kind: "spending", index: entry.index },
          address: entry.address,
          title: entry.label,
          spending: { index: entry.index, label: entry.label, primary: entry.primary, hidden: entry.hidden },
          onBack: back,
        });
      };
    }
    if (!state.menu) return;
    // Tapping anywhere outside the menu closes it, like an iOS pull-down menu.
    setTimeout(() => {
      const close = (event) => {
        if (event.target.closest(".menu-sheet, #menu")) return;
        document.removeEventListener("click", close, true);
        if (state.menu && app.dataset.screen === "addresses") { state.menu = false; paint(); }
      };
      document.addEventListener("click", close, true);
    });
    $("#generate").onclick = async () => {
      state.menu = false; state.busy = "Generating…"; paint();
      try { const index = await wallet.generateSpendingAddress(); toast(`Spending #${index} added.`); }
      catch (error) { toast(error.message); }
      state.busy = ""; await load();
    };
    $("#discover").onclick = async () => {
      state.menu = false; state.busy = "Checking addresses…"; paint();
      try {
        const found = await wallet.discoverSpendingAddresses((done, total) => {
          state.busy = `Checking addresses… ${Math.min(done, total)} of ${total}`;
          if (app.dataset.screen === "addresses") paint();
        });
        toast(found ? `Found ${found} address${found === 1 ? "" : "es"} holding Kaspa.` : "No other addresses hold Kaspa.");
      } catch (error) { toast(error.message); }
      state.busy = ""; await load();
    };
    $("#visibility").onclick = () => { state.menu = false; showVisibility({ list: state.list, onBack: back }); };
    $("#sweep").onclick = () => { state.menu = false; confirmSweep({ list: state.list, onBack: back }); };
  };
  paint();
  load();
}

function showVisibility({ list, onBack }) {
  const rows = list?.rows || [];
  const paint = () => {
    render(`
      ${navHeader({ title: "Address Visibility" })}
      <section class="screen manage">
        <p class="muted small">Hidden addresses stay yours and keep their balance - they just leave the Manage Addresses list.</p>
        <div class="glass list">
          ${rows.map((row) => `
            <button class="list-row" data-index="${row.index}" role="switch" aria-checked="${!row.hidden}" ${row.primary ? "disabled" : ""}>
              <span class="tx-meta"><span>${esc(row.label)}</span><span class="mono tiny muted">${esc(wallet.shortAddress(row.address))} · ${esc(wallet.formatKas(row.balanceSompi, 8))} KAS</span></span>
              <span class="toggle ${row.hidden ? "" : "on"}"></span>
            </button>`).join("")}
        </div>
      </section>`, "visibility");
    $("#back").onclick = onBack;
    for (const button of app.querySelectorAll("[data-index]")) {
      button.onclick = async () => {
        const row = rows.find((r) => r.index === Number(button.dataset.index));
        try { await wallet.setSpendingHidden(row.index, !row.hidden); row.hidden = !row.hidden; paint(); }
        catch (error) { toast(error.message); }
      };
    }
  };
  paint();
}

function confirmSweep({ list, onBack }) {
  const primary = list?.rows?.find((row) => row.primary);
  const sources = (list?.rows || []).filter((row) => !row.primary && row.balanceSompi > 0n);
  const total = sources.reduce((sum, row) => sum + row.balanceSompi, 0n);
  render(`
    ${navHeader({ title: "Send All To Primary" })}
    <section class="screen">
      ${sources.length && primary ? `
        <p>Moves everything on your other spending addresses to <b>${esc(primary.label)}</b>.</p>
        <div class="glass list">
          ${sources.map((row) => `<div class="list-row"><span>${esc(row.label)}</span><span>${esc(wallet.formatKas(row.balanceSompi, 8))} KAS</span></div>`).join("")}
        </div>
        <p class="muted small">${sources.length} transaction${sources.length === 1 ? "" : "s"}, ${esc(wallet.formatKas(total, 8))} KAS before network fees.</p>
        <p class="error" id="error"></p>
        <div class="spacer"></div>
        <button id="go" class="big">Send All</button>` : '<p class="muted">Nothing to move - only the primary spending address holds Kaspa.</p>'}
    </section>`, "sweep");
  $("#back").onclick = onBack;
  const go = $("#go");
  if (!go) return;
  go.onclick = async () => {
    go.disabled = true;
    let done = 0;
    const failures = [];
    for (const row of sources) {
      go.innerHTML = `<span class="spinner small-spin"></span> ${done + 1} of ${sources.length}`;
      try {
        const coins = await wallet.utxos(row.address);
        const fee = await wallet.maxFee(coins.length);
        await wallet.send({ source: { kind: "spending", index: row.index }, destination: primary.address, max: true, totalFeeKas: fee.policyKas.toFixed(8) });
        done += 1;
      } catch (error) {
        failures.push(`${row.label}: ${error.message}`);
      }
    }
    if (failures.length) {
      $("#error").textContent = failures.join(" · ");
      go.disabled = false;
      go.textContent = "Try Again";
    } else {
      toast(`Moved ${done} address${done === 1 ? "" : "es"} to primary.`);
      onBack();
    }
  };
}
