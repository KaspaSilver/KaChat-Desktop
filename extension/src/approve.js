// The approval window for website requests (popup.html?view=approve&id=...). background.js opens
// it for anything a site can't do on its own - connect, send Kaspa, sign a message - and waits
// for this page's answer. Closing the window rejects.
//
// Every screen leads with the site's origin as the browser reported it, so a look-alike page name
// or title can't stand in for it. The page's own words (a message to sign) are shown as plain
// text, never markup.

import * as vault from "./vault.js";
import * as wallet from "./wallet.js";
import { ext, getLocal, setLocal } from "./browser.js";
import { esc, render, $, toast, noteActivity, resetActivityPing, ICONS } from "./ui.js";

export const CONNECTIONS_KEY = "kachat.connections";

export async function connections() {
  return (await getLocal(CONNECTIONS_KEY)) || {};
}

export async function removeConnection(origin) {
  const all = await connections();
  delete all[origin];
  await setLocal(CONNECTIONS_KEY, all);
}

/** Drops every site connected to an account (the account was removed). */
export async function removeConnectionsFor(accountId) {
  const all = await connections();
  for (const [origin, entry] of Object.entries(all)) if (!accountId || entry.accountId === accountId) delete all[origin];
  await setLocal(CONNECTIONS_KEY, all);
}

function siteHeader(origin) {
  let host = origin;
  try { host = new URL(origin).host; } catch { /* keep the origin */ }
  const insecure = origin.startsWith("http:") && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  return `
    <div class="approve-site">
      <div class="site-badge">${esc(host.replace(/^www\./, "").charAt(0).toUpperCase() || "?")}</div>
      <div class="site-host">${esc(host)}</div>
      <div class="muted tiny mono">${esc(origin)}</div>
      ${insecure ? '<div class="status bad">This site is not using a secure (https) connection.</div>' : ""}
    </div>`;
}

export async function showApproval(id) {
  const request = await ext.runtime.sendMessage({ type: "approval-get", id }).catch(() => null);
  if (!request) {
    render(`
      <section class="screen approve center">
        <p class="center-text">This request has expired or was already answered.</p>
        <button id="close">Close</button>
      </section>`, "approve");
    $("#close").onclick = () => window.close();
    return;
  }
  // Keeps the background worker (which holds the site's pending call) awake while you decide.
  setInterval(() => { ext.runtime.sendMessage({ type: "approval-ping" }).catch(() => {}); }, 20_000);

  let answered = false;
  const respond = (result) => {
    answered = true;
    ext.runtime.sendMessage({ type: "approval-result", id, result }).catch(() => {});
    setTimeout(() => window.close(), 150);
  };
  const reject = () => {
    answered = true;
    ext.runtime.sendMessage({ type: "approval-result", id, error: true }).catch(() => {});
    setTimeout(() => window.close(), 150);
  };
  window.addEventListener("beforeunload", () => { if (!answered) ext.runtime.sendMessage({ type: "approval-result", id, error: true }).catch(() => {}); });

  const proceed = () => {
    if (request.kind === "connect") return showConnect(request, respond, reject);
    if (request.kind === "sendKaspa") return showSendApproval(request, respond, reject);
    if (request.kind === "signMessage") return showSignApproval(request, respond, reject);
    return reject();
  };

  if (!(await vault.hasVault())) {
    render(`
      <section class="screen approve">
        ${siteHeader(request.origin)}
        <h2 class="center-text">Set up KaChat Wallet first</h2>
        <p class="muted center-text">This site wants to connect, but there is no wallet in this browser yet. Create or import an account in KaChat Wallet, then try again on the site.</p>
        <div class="spacer"></div>
        <button id="setup">Open KaChat Wallet</button>
        <button id="cancel" class="soft">Cancel</button>
      </section>`, "approve");
    $("#setup").onclick = async () => { await ext.tabs.create({ url: ext.runtime.getURL("popup.html?view=tab") }); reject(); };
    $("#cancel").onclick = reject;
    return;
  }
  if (!(await vault.isUnlocked())) return showApprovalUnlock(request, proceed, reject);
  noteActivity();
  proceed();
}

function showApprovalUnlock(request, onUnlocked, reject) {
  render(`
    <section class="screen approve">
      ${siteHeader(request.origin)}
      <p class="muted center-text">Unlock KaChat Wallet to continue.</p>
      <form id="form" class="stack">
        <input id="pw" type="password" autocomplete="current-password" placeholder="Password" aria-label="Password" autofocus />
        <p class="error" id="error"></p>
        <button id="unlock" type="submit">Unlock</button>
        <button id="cancel" type="button" class="soft">Cancel</button>
      </form>
    </section>`, "approve");
  $("#cancel").onclick = reject;
  $("#form").onsubmit = async (event) => {
    event.preventDefault();
    const button = $("#unlock");
    button.disabled = true;
    try {
      await vault.unlock($("#pw").value);
      resetActivityPing();
      noteActivity();
      onUnlocked();
    } catch (error) {
      $("#error").textContent = error.message;
      button.disabled = false;
      $("#pw").select();
    }
  };
}

// --- connect ----------------------------------------------------------------------------------

async function showConnect(request, respond, reject) {
  const view = await vault.readAccounts();
  const rows = await Promise.all(view.accounts.map(async (account) => ({
    ...account,
    address: (await wallet.cachedAddresses(account.id))?.main || null,
  })));
  let chosen = view.activeAccountId;
  const paint = () => {
    render(`
      <section class="screen approve">
        ${siteHeader(request.origin)}
        <h2 class="center-text">Connect to this site?</h2>
        <p class="muted small center-text">It will see this account's chatting address and balance, and it can ask you to send Kaspa or sign messages. Nothing is sent or signed without your approval here.</p>
        <div class="glass list" role="radiogroup" aria-label="Account">
          ${rows.map((row) => `
            <button class="list-row" role="radio" data-account="${esc(row.id)}" aria-checked="${row.id === chosen}">
              <span class="source-radio">${row.id === chosen ? ICONS.circleCheck : ICONS.circle}</span>
              <span class="tx-meta"><span>${esc(row.name)}</span><span class="mono tiny muted">${esc(row.address ? wallet.shortAddress(row.address) : "")}</span></span>
            </button>`).join("")}
        </div>
        <p class="error" id="error"></p>
        <div class="spacer"></div>
        <div class="approve-buttons">
          <button id="cancel" class="soft">Cancel</button>
          <button id="ok">Connect</button>
        </div>
      </section>`, "approve");
    for (const row of document.querySelectorAll("[data-account]")) row.onclick = () => { chosen = row.dataset.account; paint(); };
    $("#cancel").onclick = reject;
    $("#ok").onclick = async () => {
      const button = $("#ok");
      button.disabled = true;
      button.innerHTML = '<span class="spinner"></span>';
      try {
        const account = rows.find((r) => r.id === chosen);
        const identity = await wallet.identityFor(chosen);
        const all = await connections();
        all[request.origin] = { accountId: chosen, accountName: account?.name || "", address: identity.address, publicKey: identity.publicKey, connectedAt: Date.now() };
        await setLocal(CONNECTIONS_KEY, all);
        respond([identity.address]);
      } catch (error) {
        $("#error").textContent = error.message;
        button.disabled = false;
        button.textContent = "Connect";
      }
    };
  };
  paint();
}

async function connectionFor(request, reject) {
  const connection = (await connections())[request.origin];
  if (!connection) { toast("This site is no longer connected."); reject(); return null; }
  const view = await vault.readAccounts();
  if (!view.accounts.some((a) => a.id === connection.accountId)) { toast("The connected account was removed."); reject(); return null; }
  return { ...connection, accountName: view.accounts.find((a) => a.id === connection.accountId)?.name || connection.accountName };
}

// --- send Kaspa -------------------------------------------------------------------------------

async function showSendApproval(request, respond, reject) {
  const connection = await connectionFor(request, reject);
  if (!connection) return;
  const [to, sompiText, priorityFeeText] = request.params;
  const amount = BigInt(sompiText);
  const priorityFee = BigInt(priorityFeeText || "0");
  const state = { fee: null, available: null, validTo: null, sending: false, error: "" };

  const paint = () => {
    const feeSompi = state.fee != null ? wallet.kasToSompi(state.fee.toFixed(8)) + priorityFee : null;
    const total = feeSompi != null ? amount + feeSompi : null;
    const short = state.available != null && total != null && total > state.available;
    render(`
      <section class="screen approve">
        ${siteHeader(request.origin)}
        <h2 class="center-text">Send Kaspa</h2>
        <div class="approve-amount">${esc(wallet.formatKas(amount, 8))} <span>KAS</span></div>
        <div class="glass list">
          <div class="list-row stack-tight"><span class="muted small">To</span><span class="mono small break">${esc(to)}</span></div>
          ${state.validTo === false ? '<div class="list-row error-text">This is not a valid Kaspa address.</div>' : ""}
          <div class="list-row stack-tight"><span class="muted small">From</span><span>${esc(connection.accountName)}</span><span class="mono tiny muted break">${esc(connection.address)}</span></div>
          <div class="list-row"><span>Network Fee</span><span>${feeSompi != null ? `${esc(wallet.formatKas(feeSompi, 8))} KAS` : '<span class="spinner small-spin"></span>'}</span></div>
          <div class="list-row"><span class="strong">Total</span><span class="strong">${total != null ? `${esc(wallet.formatKas(total, 8))} KAS` : "—"}</span></div>
          ${state.available != null ? `<div class="list-row"><span class="muted small">Available</span><span class="muted small">${esc(wallet.formatKas(state.available, 8))} KAS</span></div>` : ""}
        </div>
        ${short ? '<p class="error">Not enough Kaspa for this amount plus the network fee.</p>' : ""}
        ${state.error ? `<p class="error">${esc(state.error)}</p>` : ""}
        <div class="spacer"></div>
        <div class="approve-buttons">
          <button id="cancel" class="soft" ${state.sending ? "disabled" : ""}>Reject</button>
          <button id="ok" ${state.sending || state.validTo !== true || feeSompi == null || short ? "disabled" : ""}>${state.sending ? '<span class="spinner"></span>' : "Approve"}</button>
        </div>
      </section>`, "approve");
    $("#cancel").onclick = reject;
    $("#ok").onclick = async () => {
      state.sending = true;
      state.error = "";
      paint();
      try {
        const tip = Math.max(0, state.fee - state.sdkBase) + Number(priorityFee) / 1e8;
        const result = await wallet.send({
          source: { kind: "main", accountId: connection.accountId },
          destination: to,
          amountKas: wallet.sompiToKasText(amount),
          tipKas: tip.toFixed(8),
        });
        const txid = (result?.txids || [])[result?.txids?.length - 1] || "";
        if (!txid) throw new Error("The node did not return a transaction id.");
        respond(txid);
      } catch (error) {
        state.sending = false;
        state.error = String(error?.message || error);
        paint();
      }
    };
  };
  paint();
  state.validTo = await wallet.isValidAddress(to);
  paint();
  try {
    state.available = (await wallet.balancesFor([connection.address]))[connection.address] ?? 0n;
  } catch { /* shown as unknown */ }
  try {
    const estimate = await wallet.estimateFee({ address: connection.address, amountKas: wallet.sompiToKasText(amount) });
    state.fee = estimate?.policyKas ?? 0.002;
    state.sdkBase = estimate?.sdkBaseKas ?? 0.00002;
  } catch {
    state.fee = 0.002;
    state.sdkBase = 0.00002;
  }
  paint();
}

// --- sign message -----------------------------------------------------------------------------

async function showSignApproval(request, respond, reject) {
  const connection = await connectionFor(request, reject);
  if (!connection) return;
  const [message] = request.params;
  render(`
    <section class="screen approve">
      ${siteHeader(request.origin)}
      <h2 class="center-text">Sign Message</h2>
      <div class="glass list">
        <div class="list-row stack-tight"><span class="muted small">Account</span><span>${esc(connection.accountName)}</span><span class="mono tiny muted break">${esc(connection.address)}</span></div>
      </div>
      <div class="sign-message" tabindex="0" aria-label="Message">${esc(message)}</div>
      <p class="muted small">Only sign messages you understand. Signing proves you own this address; it does not send Kaspa.</p>
      <p class="error" id="error"></p>
      <div class="approve-buttons">
        <button id="cancel" class="soft">Reject</button>
        <button id="ok">Sign</button>
      </div>
    </section>`, "approve");
  $("#cancel").onclick = reject;
  $("#ok").onclick = async () => {
    const button = $("#ok");
    button.disabled = true;
    try {
      respond(await wallet.signMessage(connection.accountId, message));
    } catch (error) {
      $("#error").textContent = String(error?.message || error);
      button.disabled = false;
    }
  };
}
