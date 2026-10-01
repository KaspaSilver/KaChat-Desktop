// Your Domains - iOS KNSDomainsListView, KNSDomainDetailView and KNSDomainSendView.
//
//   list     an underline tab per name service, KaChat's own first: .kachat (coming), .kas
//            (KNS), .k (dotk), .kaspa (Kaspa Names). Each outside service's tab lists the
//            chatting address's names as teal cards and pins "Get a <ending> domain at <site>",
//            which opens that service's site - KaChat creates only its own .kachat names.
//            .kas cards carry "Primary"; a .kaspa name still settling carries "Settling".
//   detail   (.kas) the card, Asset ID, Set as Primary / Primary Domain, Status: Listed, Send
//   send     recipient (address or a name on any service, with "Other domains"), Normal /
//            Fast / Priority fee on 0.02 KAS, the two-transaction progress sheet, the Sent sheet
//
// Left out on purpose: inscribing and profile editing. Profiles are moving to .kachat names.

import { remember } from "./dock.js";
import * as wallet from "./wallet.js";
import { app, esc, render, $, toast, ICONS, navHeader } from "./ui.js";
import * as names from "./names.js";

const BASE_FEE_SOMPI = 2_000_000n; // 0.02 KAS - iOS WithdrawFeeTier base for domain transfers
const FEE_TIERS = [
  { id: "normal", label: "Normal", multiplier: 1n },
  { id: "fast", label: "Fast", multiplier: 2n },
  { id: "priority", label: "Priority", multiplier: 5n },
];

const sameDomain = (a, b) => String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();

// iOS DomainNameCardView: the name, and an optional corner badge.
function nameCardHtml(title, badge = null) {
  return `
    <div class="domain-card">
      <span class="domain-name">${esc(title)}</span>
      ${badge ? `<span class="domain-badge">${esc(badge)}</span>` : ""}
    </div>`;
}

function cardHtml(domain, primary) {
  return nameCardHtml(domain.fullName, primary ? "Primary" : null);
}

// Which tab Your Domains shows, kept while you go into a domain and back.
let selectedTab = names.DEFAULT_TAB;

export function showDomains({ address, onBack }) {
  const state = {
    data: wallet.cachedDomains(address), loading: true, error: "",
    owned: names.cachedOwnedNames(address), ownedLoading: true,
  };
  const back = () => showDomains({ address, onBack });
  const here = () => app.dataset.screen === "domains";

  const getNameButton = (tld) => {
    const info = names.service(tld);
    if (!info?.site) return "";
    return `<a class="get-domain" href="${esc(info.site)}" target="_blank" rel="noopener noreferrer">Get a ${esc(info.suffix)} domain at ${esc(info.siteName)}</a>`;
  };

  const kasTab = () => {
    const list = state.data?.domains || [];
    if (state.error) return `<p class="error">${esc(state.error)}</p>`;
    if (!state.data && state.loading) return '<div class="center-text"><span class="spinner"></span></div>';
    if (!list.length) return '<p class="muted center-text">No domains yet.</p>';
    return list.map((domain, i) => `
      <button class="domain-button" data-i="${i}" aria-label="${esc(domain.fullName)}">
        ${cardHtml(domain, sameDomain(domain.fullName, state.data.primaryDomain))}
      </button>`).join("");
  };

  const serviceTab = (tld) => {
    const info = names.service(tld);
    const list = state.owned?.[tld] || [];
    if (!list.length) {
      if (state.ownedLoading && !state.owned?.[tld]) return '<div class="center-text"><span class="spinner"></span></div>';
      if (state.owned?.failed?.[tld]) return `<p class="muted center-text">Couldn't reach ${esc(info.serviceName)}. <button class="link-button" id="retry">Try again</button></p>`;
      return `<p class="muted center-text">No ${esc(info.suffix)} names yet.</p>`;
    }
    return list.map((owned) => nameCardHtml(owned.display, owned.provisional ? "Settling" : null)).join("");
  };

  const kachatTab = () => `
    <div class="kachat-coming">
      <span class="accent">${ICONS.atCircle}</span>
      <h3>.kachat names are coming</h3>
      <p class="muted small">KaChat's own names will live here: claim one, set it as your name in chats, and share it as your profile link.</p>
    </div>`;

  const paint = () => {
    const body = selectedTab === "kas" ? kasTab() : selectedTab === "kachat" ? kachatTab() : serviceTab(selectedTab);
    render(`
      ${navHeader({ title: "Your Domains" })}
      <div class="underline-tabs" role="tablist" aria-label="Name service">
        ${names.NAME_SERVICES.map((s) => `<button role="tab" data-tab="${s.tld}" aria-selected="${s.tld === selectedTab}">${esc(s.suffix)}</button>`).join("")}
      </div>
      <section class="screen domains" id="domains-body">${body}</section>
      ${selectedTab === "kachat" ? "" : `<div class="get-domain-bar">${getNameButton(selectedTab)}</div>`}`, "domains");
    remember(() => paint());
    $("#back").onclick = onBack;
    for (const tab of app.querySelectorAll("[data-tab]")) tab.onclick = () => switchTo(tab.dataset.tab);
    const list = state.data?.domains || [];
    for (const button of app.querySelectorAll("[data-i]")) {
      button.onclick = () => showDomainDetail({ address, domain: list[Number(button.dataset.i)], primaryDomain: state.data.primaryDomain, onBack: back });
    }
    const retry = $("#retry");
    if (retry) retry.onclick = loadOwned;
    bindSwipe($("#domains-body"));
  };

  const switchTo = (tld) => {
    if (!names.service(tld) || tld === selectedTab) return;
    selectedTab = tld;
    paint();
  };

  // A sideways swipe (trackpad or touch) or the arrow keys change the name service, as the
  // iOS swipe does.
  const step = (delta) => {
    const order = names.NAME_SERVICES.map((s) => s.tld);
    const next = order[order.indexOf(selectedTab) + delta];
    if (next) switchTo(next);
  };
  function bindSwipe(element) {
    if (!element) return;
    let wheelX = 0;
    let wheelTimer = null;
    let cooldown = false;
    element.addEventListener("wheel", (event) => {
      if (cooldown || Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return;
      wheelX += event.deltaX;
      clearTimeout(wheelTimer);
      wheelTimer = setTimeout(() => { wheelX = 0; }, 200);
      if (Math.abs(wheelX) > 80) {
        cooldown = true;
        step(wheelX > 0 ? 1 : -1);
        wheelX = 0;
      }
    }, { passive: true });
    let start = null;
    element.addEventListener("pointerdown", (event) => { if (event.pointerType !== "mouse") start = { x: event.clientX, y: event.clientY }; });
    element.addEventListener("pointerup", (event) => {
      if (!start) return;
      const dx = event.clientX - start.x;
      const dy = event.clientY - start.y;
      start = null;
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) step(dx < 0 ? 1 : -1);
    });
  }
  const onKey = (event) => {
    if (!here()) { document.removeEventListener("keydown", onKey); return; }
    if (event.target.closest?.("input, textarea")) return;
    if (event.key === "ArrowRight") step(1);
    if (event.key === "ArrowLeft") step(-1);
  };
  document.addEventListener("keydown", onKey);

  const loadOwned = () => {
    state.ownedLoading = true;
    if (here()) paint();
    names.ownedNames(address)
      .then((owned) => { state.owned = owned; })
      .catch(() => {})
      .finally(() => { state.ownedLoading = false; if (here()) paint(); });
  };

  paint();
  wallet.domains(address, { force: true })
    .then((data) => { state.data = data; state.error = ""; })
    .catch((error) => { state.error = state.data ? "" : error.message || "Could not load KNS domains."; })
    .finally(() => { state.loading = false; if (here()) paint(); });
  loadOwned();
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

/** Send Domain. `source` is the owner: the chatting address, or { kind: "spending", index }. */
export function showSendDomain({ domain, onBack, onSent, source = { kind: "main" } }) {
  const state = {
    recipientInput: "", recipient: null, recipientError: "", resolving: false, resolutions: [], othersOpen: false,
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
    state.resolutions = [];
    state.othersOpen = false;
    if (!input) { paint(); return; }
    state.resolving = true;
    paint();
    try {
      const resolved = await wallet.resolveRecipient(input);
      if (seq !== resolveSeq) return;
      state.recipient = resolved;
      state.resolutions = resolved.resolutions || [];
    } catch (error) {
      if (seq !== resolveSeq) return;
      state.recipientError = error.message;
      state.resolutions = error.resolutions || [];
      state.othersOpen = state.resolutions.some((r) => r.address);
    } finally {
      if (seq === resolveSeq) { state.resolving = false; paint(); }
    }
  };

  const paint = () => {
    if (state.sending) return paintProgress();
    const focusedId = document.activeElement?.id;
    const status = (() => {
      if (!state.recipientInput.trim()) return "";
      if (state.resolving) return `<div class="status muted"><span class="spinner small-spin"></span> Looking up domain...</div>`;
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
            <textarea id="recipient" class="mono recipient" rows="2" placeholder="kaspa:qr... or domain" spellcheck="false" autocapitalize="off">${esc(state.recipientInput)}</textarea>
            ${status || state.resolutions.length ? `<div class="form-row stack-tight">${status}${names.otherDomainsHtml({ resolutions: state.resolutions, selectedTld: state.recipient?.tld || names.splitTypedName(state.recipientInput).tld, open: state.othersOpen })}</div>` : ""}
            <div class="form-row"><button class="link-button" id="paste">${ICONS.clipboard}<span>Paste</span></button></div>
          </div>
          <div class="form-footer">Enter a Kaspa address (kaspa:...) or a domain.</div>
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
    names.bindOtherDomains(app, {
      onToggle: () => { state.othersOpen = !state.othersOpen; paint(); },
      onPick: (tld) => {
        const pick = state.resolutions.find((r) => r.tld === tld && r.address);
        if (!pick) return;
        state.recipient = { address: pick.address, domain: pick.display, tld: pick.tld, resolutions: state.resolutions };
        state.recipientError = "";
        state.othersOpen = false;
        paint();
      },
    });
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
        source,
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
