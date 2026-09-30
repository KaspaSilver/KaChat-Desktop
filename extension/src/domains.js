// Your Domains - iOS KNSDomainsListView, KNSDomainDetailView and KNSDomainSendView.
//
//   list     the chatting address's domains as teal cards, newest first, "Primary" badge,
//            "No domains yet." when empty
//   detail   the card, Asset ID, Set as Primary / Primary Domain, Status: Listed, Send
//   send     recipient (address or name.kas), Normal / Fast / Priority fee on 0.02 KAS, then the
//            two-transaction progress sheet and the Sent sheet
//
// Left out on purpose: "Inscribe New Domain" and profile editing. Profiles are moving to
// .kachat names, which are not built yet.

import * as wallet from "./wallet.js";
import { app, esc, render, $, toast, ICONS, navHeader } from "./ui.js";

const BASE_FEE_SOMPI = 2_000_000n; // 0.02 KAS - iOS WithdrawFeeTier base for domain transfers
const FEE_TIERS = [
  { id: "normal", label: "Normal", multiplier: 1n },
  { id: "fast", label: "Fast", multiplier: 2n },
  { id: "priority", label: "Priority", multiplier: 5n },
];

const sameDomain = (a, b) => String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();

function cardHtml(domain, primary) {
  return `
    <div class="domain-card">
      <span class="domain-name">${esc(domain.fullName)}</span>
      ${primary ? '<span class="domain-badge">Primary</span>' : ""}
    </div>`;
}

export function showDomains({ address, onBack }) {
  const state = { data: wallet.cachedDomains(address), loading: true, error: "" };
  const back = () => showDomains({ address, onBack });

  const paint = () => {
    const list = state.data?.domains || [];
    render(`
      ${navHeader({ title: "Your Domains" })}
      <section class="screen domains">
        ${state.error ? `<p class="error">${esc(state.error)}</p>` : ""}
        ${!state.data && state.loading ? '<div class="center-text"><span class="spinner"></span></div>' : ""}
        ${state.data && !list.length ? '<p class="muted center-text">No domains yet.</p>' : ""}
        ${list.map((domain, i) => `
          <button class="domain-button" data-i="${i}" aria-label="${esc(domain.fullName)}">
            ${cardHtml(domain, sameDomain(domain.fullName, state.data.primaryDomain))}
          </button>`).join("")}
        ${state.data && state.loading ? '<p class="muted small center-text"><span class="spinner small-spin"></span></p>' : ""}
      </section>`, "domains");
    $("#back").onclick = onBack;
    for (const button of app.querySelectorAll("[data-i]")) {
      button.onclick = () => showDomainDetail({ address, domain: list[Number(button.dataset.i)], primaryDomain: state.data.primaryDomain, onBack: back });
    }
  };
  paint();
  wallet.domains(address, { force: true })
    .then((data) => { state.data = data; state.error = ""; })
    .catch((error) => { state.error = state.data ? "" : error.message || "Could not load KNS domains."; })
    .finally(() => { state.loading = false; if (app.dataset.screen === "domains") paint(); });
}

function showDomainDetail({ address, domain, primaryDomain, onBack }) {
  const state = { primaryDomain, setting: false, error: "" };
  const paint = () => {
    const isPrimary = sameDomain(domain.fullName, state.primaryDomain);
    const listed = domain.status === "listed";
    const canSend = Boolean(domain.inscriptionId) && !listed;
    render(`
      ${navHeader({ title: domain.fullName })}
      <section class="screen domains">
        ${cardHtml(domain, isPrimary)}
        <div class="glass list">
          <div class="list-row"><span>Asset ID</span><span class="mono tiny muted ellipsis asset-id" title="${esc(domain.inscriptionId || "")}">${esc(domain.inscriptionId || "—")}</span></div>
          ${isPrimary
            ? `<div class="list-row"><span>Primary Domain</span><span class="accent">${ICONS.starFill}</span></div>`
            : domain.inscriptionId
              ? `<button class="list-row" id="set-primary" ${state.setting ? "disabled" : ""}><span>Set as Primary</span>${state.setting ? '<span class="spinner small-spin"></span>' : `<span class="accent">${ICONS.star}</span>`}</button>`
              : ""}
          ${listed ? '<div class="list-row"><span>Status</span><span class="muted">Listed</span></div>' : ""}
        </div>
        ${state.error ? `<p class="error small">${esc(state.error)}</p>` : ""}
        ${listed ? '<p class="muted small center-text">This domain is listed and can\'t be sent right now.</p>' : ""}
        <div class="spacer"></div>
        <button id="send" class="with-icon domain-send" ${canSend ? "" : "disabled"}>${ICONS.sendCircle}<span>Send</span></button>
      </section>`, "domain-detail");
    $("#back").onclick = onBack;
    const setPrimary = $("#set-primary");
    if (setPrimary) setPrimary.onclick = async () => {
      state.setting = true;
      state.error = "";
      paint();
      try {
        await wallet.setPrimaryDomain(domain.inscriptionId);
        state.primaryDomain = domain.fullName;
        toast(`Primary domain set to ${domain.fullName}.`);
        // The KNS API takes a moment to report the new primary (iOS refreshKNSUntilPrimarySettles).
        settlePrimary(address, domain.fullName);
      } catch (error) {
        state.error = String(error?.message || error).slice(0, 160);
      }
      state.setting = false;
      if (app.dataset.screen === "domain-detail") paint();
    };
    $("#send").onclick = () => {
      if (canSend) showSendDomain({ domain, onBack: paint, onSent: onBack });
    };
  };
  paint();
}

async function settlePrimary(address, fullName) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    try {
      const data = await wallet.domains(address, { force: true });
      if (sameDomain(data.primaryDomain, fullName)) return;
    } catch { /* try again */ }
  }
}

// --- Send Domain ---------------------------------------------------------------------------

const STAGES = {
  "resolving-recipient": ["Preparing transfer", 0.1],
  "verifying-ownership": ["Preparing transfer", 0.1],
  committing: ["Submitting commit transaction", 0.3],
  committed: ["Waiting for the commit to settle", 0.55],
  revealing: ["Submitting reveal transaction", 0.8],
  revealed: ["Confirming the new owner", 0.95],
  verifying: ["Confirming the new owner", 0.95],
};

function showSendDomain({ domain, onBack, onSent }) {
  const state = {
    recipientInput: "", recipient: null, recipientError: "", resolving: false,
    tier: "normal", customFeeSompi: null, editingFee: false,
    sending: false, stage: null, error: "",
  };
  const feeSompi = () => state.customFeeSompi ?? BASE_FEE_SOMPI * (FEE_TIERS.find((t) => t.id === state.tier)?.multiplier || 1n);
  const canSend = () => Boolean(state.recipient) && !state.resolving && !state.sending;

  let resolveSeq = 0;
  let recipientTimer = null;
  const resolveRecipient = async () => {
    const seq = ++resolveSeq;
    const input = state.recipientInput.trim().split("?")[0];
    state.recipient = null;
    state.recipientError = "";
    if (!input) { paint(); return; }
    state.resolving = true;
    paint();
    try {
      const resolved = await wallet.resolveRecipient(input);
      if (seq !== resolveSeq) return;
      state.recipient = resolved;
    } catch (error) {
      if (seq !== resolveSeq) return;
      state.recipientError = /No KNS domain/.test(error.message) ? "KNS domain not found" : error.message;
    } finally {
      if (seq === resolveSeq) { state.resolving = false; paint(); }
    }
  };

  const paint = () => {
    if (state.sending) return paintProgress();
    const focusedId = document.activeElement?.id;
    const status = (() => {
      if (!state.recipientInput.trim()) return "";
      if (state.resolving) return `<div class="status muted"><span class="spinner small-spin"></span> Resolving KNS domain...</div>`;
      if (state.recipientError) return `<div class="status bad">${ICONS.xCircle}<span>${esc(state.recipientError)}</span></div>`;
      if (state.recipient?.domain) return `<div class="status good">${ICONS.checkFill}<span>Resolved: ${esc(state.recipient.domain)}</span></div><div class="mono tiny muted break">${esc(state.recipient.address)}</div>`;
      if (state.recipient) return `<div class="status good">${ICONS.checkFill}<span>Valid address</span></div>`;
      return "";
    })();
    const fee = feeSompi();
    render(`
      <header class="navbar form-bar">
        <button class="bar-text" id="cancel">Cancel</button>
        <div class="nav-title">Send Domain</div>
        <button class="bar-text strong" id="send" ${canSend() ? "" : "disabled"}>Send</button>
      </header>
      <section class="form">
        <div class="form-section">
          <div class="form-header">Domain</div>
          <div class="form-card"><div class="form-row stack-tight"><span class="strong">${esc(domain.fullName)}</span><span class="mono tiny muted break">${esc(domain.inscriptionId)}</span></div></div>
        </div>
        <div class="form-section">
          <div class="form-header">Recipient Address</div>
          <div class="form-card">
            <textarea id="recipient" class="mono recipient" rows="2" placeholder="kaspa:qr... or name.kas" spellcheck="false" autocapitalize="off">${esc(state.recipientInput)}</textarea>
            ${status ? `<div class="form-row stack-tight">${status}</div>` : ""}
            <div class="form-row"><button class="link-button" id="paste">${ICONS.clipboard}<span>Paste</span></button></div>
          </div>
          <div class="form-footer">Enter a Kaspa address (kaspa:...) or a .kas domain.</div>
        </div>
        <div class="form-section">
          <div class="form-header">Fee</div>
          <div class="form-card">
            <div class="form-row">
              <div class="segmented wide" role="radiogroup" aria-label="Fee">
                ${FEE_TIERS.map((t) => `<button type="button" role="radio" data-tier="${t.id}" aria-checked="${state.customFeeSompi == null && state.tier === t.id}">${t.label}</button>`).join("")}
              </div>
            </div>
            <div class="form-row between">
              <span>Network Fee</span>
              ${state.editingFee
                ? `<span class="fee-edit"><input id="custom-fee" inputmode="decimal" value="${esc(wallet.sompiToKasText(fee))}" /><button class="icon plain" id="fee-ok" aria-label="Use this fee">${ICONS.checkCircle}</button></span>`
                : `<button class="link-button underline" id="fee">${esc(wallet.sompiToKasText(fee))} KAS ${ICONS.pencilSmall}</button>`}
            </div>
          </div>
          <div class="form-footer">If the network is busy, Fast or Priority pays a higher fee to help your transfer confirm sooner. Tap the fee amount to set a custom fee.</div>
        </div>
        ${state.error ? `<div class="form-section"><div class="form-card"><div class="form-row error-text">${esc(state.error)}</div></div></div>` : ""}
      </section>`, "send-domain");
    $("#cancel").onclick = onBack;
    $("#send").onclick = doSend;
    const recipient = $("#recipient");
    recipient.oninput = () => {
      state.recipientInput = recipient.value;
      clearTimeout(recipientTimer);
      recipientTimer = setTimeout(resolveRecipient, 350);
    };
    $("#paste").onclick = async () => {
      try { state.recipientInput = (await navigator.clipboard.readText()).trim(); resolveRecipient(); }
      catch { toast("Clipboard unavailable - paste with ⌘V instead."); }
    };
    for (const button of app.querySelectorAll("[data-tier]")) {
      button.onclick = () => { state.tier = button.dataset.tier; state.customFeeSompi = null; state.editingFee = false; paint(); };
    }
    const feeButton = $("#fee");
    if (feeButton) feeButton.onclick = () => { state.editingFee = true; paint(); $("#custom-fee")?.select(); };
    const feeOk = $("#fee-ok");
    if (feeOk) {
      const commit = () => {
        const value = wallet.kasToSompi($("#custom-fee").value.trim());
        state.editingFee = false;
        if (value != null && value > 0n) state.customFeeSompi = value;
        paint();
      };
      feeOk.onclick = commit;
      $("#custom-fee").onkeydown = (event) => { if (event.key === "Enter") commit(); };
    }
    if (focusedId === "recipient") {
      const again = $("#recipient");
      again.focus();
      again.setSelectionRange(again.value.length, again.value.length);
    }
  };

  // The progress sheet can't be left while the two transactions are in flight (iOS disables
  // dismissal the same way): leaving between commit and reveal would strand the commit.
  const paintProgress = () => {
    const [title, fraction] = STAGES[state.stage] || ["Preparing transfer", 0.1];
    render(`
      <section class="screen progress-sheet">
        <h2 class="center-text">Sending ${esc(domain.fullName)}</h2>
        <div class="progress"><div class="progress-bar" style="width:${Math.round(fraction * 100)}%"></div></div>
        <p class="center-text">${esc(title)}</p>
        <p class="muted small center-text">A domain transfer is two transactions, so this takes a moment. Keep this window open until it finishes.</p>
      </section>`, "send-domain-progress");
  };

  const doSend = async () => {
    if (!canSend()) return;
    state.sending = true;
    state.stage = "verifying-ownership";
    state.error = "";
    paintProgress();
    try {
      const result = await wallet.transferDomain({
        domain: domain.fullName,
        assetId: domain.inscriptionId,
        toAddress: state.recipient.address,
        priorityFeeSompi: feeSompi(),
        onStatus: ({ status }) => { if (STAGES[status]) { state.stage = status; paintProgress(); } },
      });
      const who = state.recipient.domain || wallet.shortAddress(result.recipientAddress);
      toast(result.verified ? `${domain.fullName} transferred to ${who}.` : `Transfer submitted for ${domain.fullName}.`);
      showDomainSent({ txid: result.revealTxid, onDone: onSent });
    } catch (error) {
      console.warn("[KaChat Wallet] domain transfer failed:", error);
      state.sending = false;
      state.error = String(error?.message || error);
      paint();
    }
  };

  paint();
}

// iOS SentConfirmationSheet for a domain transfer: the reveal transaction.
function showDomainSent({ txid, onDone }) {
  render(`
    <section class="screen sent">
      <div class="sent-check accent">${ICONS.checkBig}</div>
      <h2>Sent</h2>
      <a class="mono small break link-button" href="${esc(wallet.explorerTxUrl(txid))}" target="_blank" rel="noopener noreferrer">${esc(txid)}</a>
      <p class="muted small center-text">Tap the transaction to open it in the explorer.</p>
      <div class="spacer"></div>
      <button id="done" class="big">Done</button>
    </section>`, "sent");
  $("#done").onclick = onDone;
}
