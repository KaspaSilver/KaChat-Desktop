// Send Kaspa - iOS WithdrawKaspaView, section for section:
//   Recipient Address (a kaspa: address, or a name on any service - .kachat, .kas, .k, .kaspa -
//     resolved as you type, with "Other domains" to pick another service's answer; Paste)
//   Amount (with the currency value beside it, Max, Available)
//   Coin Control (Automatic, or exactly which coins to spend)
//   Fee (Normal / Fast / Priority, the network fee - tap it to set your own)
// Send sits in the navigation bar, as on iOS, and a sent transaction ends on the Sent sheet.
// The same screen is Compound UTXOs: the recipient locked to the address itself, amount Max.

import * as wallet from "./wallet.js";
import { app, esc, render, $, toast, copyText, settings, ICONS, formatKas8 } from "./ui.js";
import { otherDomainsHtml, bindOtherDomains, splitTypedName } from "./names.js";

const FEE_TIERS = [
  { id: "normal", label: "Normal", multiplier: 1 },
  { id: "fast", label: "Fast", multiplier: 2 },
  { id: "priority", label: "Priority", multiplier: 5 },
];

/**
 * @param {object} opts
 * @param {{kind:"main"}|{kind:"spending",index:number}} opts.source
 * @param {string} opts.fromAddress
 * @param {string} [opts.title]      a line under the bar (Donate says who it is for)
 * @param {string} [opts.navTitle]   the bar title: iOS "Send Kaspa" / "Send Kaspa from Address #n"
 * @param {string} [opts.feeFooter]  the Fee footer (iOS words it per screen)
 * @param {boolean} [opts.compound]
 * @param {string} [opts.recipient]  prefill (Donate)
 * @param {Function} opts.onClose    back / cancel / done
 * @param {Function} [opts.onSent]   after a successful send, before the Sent sheet closes
 */
export function showSend(opts) {
  const state = {
    recipientInput: opts.compound ? opts.fromAddress : (opts.recipient || ""),
    recipient: opts.compound ? { address: opts.fromAddress, domain: null } : null,
    recipientError: "",
    resolving: false,
    resolutions: [],        // every name service's answer for a typed name ("Other domains")
    othersOpen: false,
    amountText: "",
    maxMode: false,
    coins: null,            // all spendable coins at the source
    selected: null,         // Set of coin keys, or null for Automatic
    tier: "normal",
    base: null,             // { policyKas, sdkBaseKas } for the current amount/coins
    customFeeKas: null,     // number when the user typed their own
    editingFee: false,
    estimating: false,
    price: null,
    sending: false,
    error: "",
  };
  const view = { screen: "form" };

  // --- derived --------------------------------------------------------------------------
  const spendableSompi = () => {
    if (!state.coins) return null;
    const list = state.selected ? state.coins.filter((c) => state.selected.has(c.key)) : state.coins;
    return list.reduce((sum, c) => sum + c.amount, 0n);
  };
  const inputCount = () => (state.selected ? state.selected.size : (state.coins?.length || 1));
  const tierMultiplier = () => FEE_TIERS.find((t) => t.id === state.tier)?.multiplier || 1;
  const totalFeeKas = () => {
    if (state.customFeeKas != null) return state.customFeeKas;
    return state.base ? state.base.policyKas * tierMultiplier() : null;
  };
  const amountSompi = () => wallet.kasToSompi(state.amountText);
  const selectedOutpoints = () => (state.selected ? [...state.selected] : null);
  const canSend = () => {
    if (state.sending || !state.recipient || state.resolving) return false;
    const amount = amountSompi();
    const fee = totalFeeKas();
    const available = spendableSompi();
    if (amount == null || amount <= 0n || fee == null || available == null) return false;
    if (state.maxMode || opts.compound) return true;
    return amount + wallet.kasToSompi(fee.toFixed(8)) <= available;
  };

  // --- loading ----------------------------------------------------------------------------
  const load = async () => {
    wallet.utxoLabels(opts.fromAddress).then((labels) => { state.labels = labels; }).catch(() => {});
    try {
      state.coins = await wallet.utxos(opts.fromAddress);
    } catch (error) {
      state.error = `Couldn't load this address's coins: ${error.message}`;
    }
    const currency = (await settings()).currency || "usd";
    wallet.price(currency).then((p) => { state.price = p; paint(); }).catch(() => {});
    if (opts.compound) await fillMax(); else await estimate();
    paint();
  };

  let estimateTimer = null;
  const scheduleEstimate = () => {
    clearTimeout(estimateTimer);
    estimateTimer = setTimeout(() => estimate().then(paint), 400);
  };
  const estimate = async () => {
    if (state.maxMode || opts.compound) return;
    state.estimating = true;
    try {
      const available = spendableSompi();
      let amount = amountSompi();
      if (amount == null || amount <= 0n) amount = 20_000_000n;
      // Never estimate more than the balance: that throws "insufficient" instead of a fee.
      if (available != null && amount >= available) amount = available > 100_000n ? available - 100_000n : 1n;
      const result = await wallet.estimateFee({
        address: opts.fromAddress,
        amountKas: wallet.sompiToKasText(amount),
        selectedOutpoints: selectedOutpoints(),
      });
      if (result && result.policyKas > 0) state.base = result;
      else if (!state.base) state.base = { policyKas: 0.002, sdkBaseKas: 0.00002 };
    } catch {
      if (!state.base) state.base = { policyKas: 0.002, sdkBaseKas: 0.00002 };
    } finally {
      state.estimating = false;
    }
  };

  // Max: the fee for spending EVERY coin Max uses, at the live rate, then amount = spendable -
  // fee exactly, so the send is one output and nothing is left for a dust change output.
  const fillMax = async () => {
    const available = spendableSompi();
    if (available == null) return;
    state.estimating = true;
    paint();
    try {
      state.base = await wallet.maxFee(inputCount());
    } catch {
      state.base = state.base || { policyKas: 0.002, sdkBaseKas: 0.00002 };
    }
    state.estimating = false;
    const fee = wallet.kasToSompi(totalFeeKas().toFixed(8));
    if (available <= fee) {
      state.error = "Balance too low after network fees.";
      state.amountText = "";
      state.maxMode = false;
      return;
    }
    state.amountText = wallet.sompiToKasText(available - fee);
    state.maxMode = true;
    state.error = "";
  };

  let resolveSeq = 0;
  const resolveRecipient = async () => {
    const seq = ++resolveSeq;
    const input = state.recipientInput.trim();
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
      // Nothing for the ending typed, but another service has the name: show it straight away.
      state.othersOpen = state.resolutions.some((r) => r.address);
    } finally {
      if (seq === resolveSeq) { state.resolving = false; paint(); }
    }
  };

  // --- sending ---------------------------------------------------------------------------
  const doSend = async () => {
    if (!canSend()) return;
    state.sending = true;
    state.error = "";
    paint();
    const fee = totalFeeKas();
    try {
      let result;
      if (opts.compound) {
        result = await wallet.compound(opts.source, fee.toFixed(8));
      } else if (state.maxMode) {
        result = await wallet.send({
          source: opts.source, destination: state.recipient.address, max: true,
          totalFeeKas: fee.toFixed(8), selectedOutpoints: selectedOutpoints(),
        });
      } else {
        const tip = Math.max(0, fee - (state.base?.sdkBaseKas || 0));
        result = await wallet.send({
          source: opts.source, destination: state.recipient.address,
          amountKas: state.amountText, tipKas: tip.toFixed(8), selectedOutpoints: selectedOutpoints(),
        });
      }
      const txid = (result?.txids || [])[result?.txids?.length - 1] || "";
      opts.onSent?.();
      showSent({
        amountSompi: result?.amountSompi ?? result?.result?.summary?.amountSompi ?? amountSompi(),
        feeKas: fee,
        to: state.recipient,
        txid,
        compound: Boolean(opts.compound),
        onDone: opts.onClose,
      });
    } catch (error) {
      console.warn("[KaChat Wallet] send failed:", error);
      state.sending = false;
      state.error = friendlySendError(error);
      paint();
    }
  };

  // --- rendering -------------------------------------------------------------------------
  const paint = () => {
    if (view.screen !== "form") return;
    const focusedId = document.activeElement?.id;
    const caret = document.activeElement?.selectionStart;
    const available = spendableSompi();
    const fee = totalFeeKas();
    const amount = amountSompi();
    const fiat = amount != null && state.price?.price ? wallet.formatFiat(amount, state.price) : "";
    const recipientStatus = (() => {
      if (opts.compound || !state.recipientInput.trim()) return "";
      if (state.resolving) return `<div class="status muted"><span class="spinner small-spin"></span> Looking up domain...</div>`;
      if (state.recipientError) return `<div class="status bad">${ICONS.xCircle}<span>${esc(state.recipientError)}</span></div>`;
      if (state.recipient?.domain) return `<div class="status good">${ICONS.checkFill}<span>Resolved: ${esc(state.recipient.domain)}</span></div><div class="mono tiny muted break">${esc(state.recipient.address)}</div>`;
      if (state.recipient) return `<div class="status good">${ICONS.checkFill}<span>Valid address</span></div>`;
      return "";
    })();
    render(`
      <header class="navbar form-bar">
        <button class="bar-text" id="cancel">Cancel</button>
        <div class="nav-title ellipsis">${esc(opts.compound ? "Compound UTXOs" : opts.navTitle || "Send Kaspa")}</div>
        ${state.sending ? '<span class="bar-text"><span class="spinner small-spin"></span></span>' : `<button class="bar-text strong" id="send" ${canSend() ? "" : "disabled"}>Send</button>`}
      </header>
      <section class="form">
        ${opts.title ? `<p class="muted small center-text">${esc(opts.title)}</p>` : ""}
        <div class="form-section">
          <div class="form-header">${opts.compound ? "Consolidating This Address" : "Recipient Address"}</div>
          <div class="form-card">
            ${opts.compound
              ? `<div class="form-row">${ICONS.merge}<span class="mono small ellipsis">${esc(opts.fromAddress)}</span></div>`
              : `<textarea id="recipient" class="mono recipient" rows="2" placeholder="kaspa:qr... or domain" spellcheck="false" autocapitalize="off">${esc(state.recipientInput)}</textarea>
                 ${recipientStatus || state.resolutions.length ? `<div class="form-row stack-tight">${recipientStatus}${otherDomainsHtml({ resolutions: state.resolutions, selectedTld: state.recipient?.tld || splitTypedName(state.recipientInput).tld, open: state.othersOpen })}</div>` : ""}
                 <div class="form-row between"><button class="link-button" id="paste">${ICONS.clipboard}<span>Paste</span></button></div>`}
          </div>
          ${opts.compound ? "" : '<div class="form-footer">Enter a Kaspa address (kaspa:...) or a domain.</div>'}
        </div>

        <div class="form-section">
          <div class="form-header">Amount</div>
          <div class="form-card">
            <div class="form-row amount-row">
              <img src="icons/kaspa-logo.png" alt="" class="amount-logo" />
              <input id="amount" inputmode="decimal" placeholder="0.00" value="${esc(state.amountText)}" autocomplete="off" ${opts.compound ? "readonly" : ""} />
              ${fiat ? `<span class="muted tiny">${esc(fiat)}</span>` : ""}
              ${opts.compound ? "" : `<button class="link-button small" id="max" ${state.recipient ? "" : "disabled"}>Max</button>`}
              <span class="muted">KAS</span>
            </div>
          </div>
          ${available != null ? `<div class="form-footer">Available: ${esc(wallet.formatKas(available, 8))} KAS</div>` : ""}
        </div>

        ${opts.compound ? "" : `
        <div class="form-section">
          <div class="form-card">
            <button class="form-row between nav-like" id="coins">
              <span>Coin Control</span>
              <span class="muted">${state.selected ? `${state.selected.size} UTXO${state.selected.size === 1 ? "" : "s"} selected` : "Automatic"} ${ICONS.chevron}</span>
            </button>
          </div>
          <div class="form-footer">Choose exactly which UTXOs to spend instead of selecting automatically.</div>
        </div>`}

        <div class="form-section">
          <div class="form-header">Fee</div>
          <div class="form-card">
            <div class="form-row">
              <div class="segmented wide" role="radiogroup" aria-label="Fee">
                ${FEE_TIERS.map((t) => `<button type="button" role="radio" data-tier="${t.id}" aria-checked="${state.customFeeKas == null && state.tier === t.id}">${t.label}</button>`).join("")}
              </div>
            </div>
            <div class="form-row between">
              <span>Network Fee</span>
              ${state.editingFee
                ? `<span class="fee-edit"><input id="custom-fee" inputmode="decimal" value="${fee != null ? esc(fee.toFixed(8).replace(/0+$/, "").replace(/\.$/, "")) : ""}" /><button class="icon plain" id="fee-ok" aria-label="Use this fee">${ICONS.checkCircle}</button></span>`
                : state.estimating
                  ? '<span class="spinner small-spin"></span>'
                  : fee != null
                    ? `<button class="link-button underline" id="fee">${esc(fee.toFixed(8).replace(/0+$/, "").replace(/\.$/, ""))} KAS ${ICONS.pencilSmall}</button>`
                    : '<span class="muted">—</span>'}
            </div>
          </div>
          <div class="form-footer">${esc(opts.feeFooter || "If the network is busy, Fast or Priority pays a higher fee to help this confirm sooner. Tap the fee amount to set a custom fee.")}</div>
        </div>

        ${state.error ? `<div class="form-section"><div class="form-card"><div class="form-row error-text">${esc(state.error)}</div></div></div>` : ""}
      </section>`, "send");

    $("#cancel").onclick = opts.onClose;
    const sendButton = $("#send");
    if (sendButton) sendButton.onclick = doSend;
    const recipient = $("#recipient");
    if (recipient) {
      recipient.oninput = () => {
        state.recipientInput = recipient.value;
        clearTimeout(recipientTimer);
        recipientTimer = setTimeout(resolveRecipient, 350);
      };
    }
    bindOtherDomains(app, {
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
    const paste = $("#paste");
    if (paste) paste.onclick = async () => {
      try {
        state.recipientInput = (await navigator.clipboard.readText()).trim();
        resolveRecipient();
      } catch {
        toast("Clipboard unavailable - paste with ⌘V instead.");
      }
    };
    const amountInput = $("#amount");
    amountInput.oninput = () => {
      const cleaned = amountInput.value.replace(/[^\d.]/g, "");
      state.amountText = cleaned;
      state.maxMode = false;
      state.error = "";
      scheduleEstimate();
      refreshSendEnabled();
    };
    const max = $("#max");
    if (max) max.onclick = async () => { await fillMax(); paint(); };
    const coins = $("#coins");
    if (coins) coins.onclick = () => {
      view.screen = "coins";
      showCoinControl({
        coins: state.coins || [],
        selected: state.selected,
        labels: state.labels,
        onCancel: () => { view.screen = "form"; paint(); },
        onDone: (selection) => {
          state.selected = selection;
          state.maxMode = false;
          view.screen = "form";
          estimate().then(paint);
          paint();
        },
      });
    };
    for (const button of app.querySelectorAll("[data-tier]")) {
      button.onclick = async () => {
        state.tier = button.dataset.tier;
        state.customFeeKas = null;
        state.editingFee = false;
        if (state.maxMode) await fillMax();
        paint();
      };
    }
    const feeButton = $("#fee");
    if (feeButton) feeButton.onclick = () => { state.editingFee = true; paint(); $("#custom-fee")?.select(); };
    const feeOk = $("#fee-ok");
    if (feeOk) {
      const commit = async () => {
        const value = Number($("#custom-fee").value);
        state.editingFee = false;
        if (Number.isFinite(value) && value > 0) {
          state.customFeeKas = value;
          if (state.maxMode) {
            const available = spendableSompi();
            const feeSompi = wallet.kasToSompi(value.toFixed(8));
            if (available > feeSompi) state.amountText = wallet.sompiToKasText(available - feeSompi);
          }
        }
        paint();
      };
      feeOk.onclick = commit;
      $("#custom-fee").onkeydown = (event) => { if (event.key === "Enter") commit(); };
    }
    // Typing must not lose the caret when a repaint lands mid-word.
    if (focusedId) {
      const again = document.getElementById(focusedId);
      if (again && again !== document.activeElement) {
        again.focus();
        if (caret != null && typeof again.setSelectionRange === "function") {
          try { again.setSelectionRange(caret, caret); } catch { /* not a text field */ }
        }
      }
    }
  };
  let recipientTimer = null;

  // Enables/disables Send without a full repaint while typing the amount.
  const refreshSendEnabled = () => {
    const button = $("#send");
    if (button) button.disabled = !canSend();
  };

  paint();
  load();
  if (state.recipientInput && !opts.compound) resolveRecipient();
}

function friendlySendError(error) {
  const message = String(error?.message || error || "");
  if (/storage mass/i.test(message)) return "This amount can't be sent from these coins without leaving a tiny change output the network rejects. Try a slightly different amount, or Compound UTXOs first.";
  if (/insufficient/i.test(message)) return "Not enough Kaspa for this amount plus the network fee.";
  if (/not connected|timed out|timeout/i.test(message)) return "Couldn't reach the Kaspa network. Try again in a moment.";
  return message || "Send failed.";
}

// --- Coin Control: iOS CoinControlView --------------------------------------------------------

export function showCoinControl({ coins, selected, labels = {}, onCancel, onDone }) {
  const picked = new Set(selected || []);
  let menuOpen = false;
  const paint = () => {
    const total = coins.filter((c) => picked.has(c.key)).reduce((sum, c) => sum + c.amount, 0n);
    render(`
      <header class="navbar form-bar">
        <button class="bar-text" id="cancel">Cancel</button>
        <div class="nav-title">Coin Control</div>
        <button class="icon plain nav-menu accent" id="menu" aria-label="More">${ICONS.ellipsis}</button>
      </header>
      ${menuOpen ? `
        <div class="menu-sheet" role="menu">
          <button class="menu-item" id="select-all"><span>Select All</span></button>
          <button class="menu-item" id="clear"><span>Automatic (Clear Selection)</span></button>
        </div>` : ""}
      <section class="form">
        <div class="form-section">
          <div class="form-card">
            ${coins.length ? coins.map((coin) => `
              <button class="form-row coin" data-key="${esc(coin.key)}" role="checkbox" aria-checked="${picked.has(coin.key)}">
                <span class="${picked.has(coin.key) ? "accent" : "muted"}">${picked.has(coin.key) ? ICONS.circleCheck : ICONS.circle}</span>
                <span class="coin-meta">
                  ${labels[coin.key] ? `<span class="accent tiny strong">${esc(labels[coin.key])}</span>` : ""}
                  <span class="coin-amount">${esc(formatKas8(coin.amount))} KAS</span>
                  <span class="mono tiny muted">${esc(coin.transactionId.slice(0, 10))}...:${coin.index}</span>
                </span>
              </button>`).join("") : '<div class="form-row muted">No UTXOs found at this address.</div>'}
          </div>
          ${picked.size ? `<div class="form-footer">Selected: ${esc(formatKas8(total))} KAS (${picked.size} UTXO${picked.size === 1 ? "" : "s"})</div>` : ""}
        </div>
      </section>
      <div class="ios-bottom-bar"><button class="ios-capsule" id="confirm">${picked.size ? "Confirm Selection" : "Use Automatic Selection"}</button></div>`, "coins");
    $("#cancel").onclick = onCancel;
    $("#menu").onclick = () => { menuOpen = !menuOpen; paint(); };
    const selectAll = $("#select-all");
    if (selectAll) selectAll.onclick = () => { for (const c of coins) picked.add(c.key); menuOpen = false; paint(); };
    const clear = $("#clear");
    if (clear) clear.onclick = () => { picked.clear(); menuOpen = false; paint(); };
    $("#confirm").onclick = () => onDone(picked.size ? new Set(picked) : null);
    for (const row of app.querySelectorAll(".coin")) {
      row.onclick = () => {
        const key = row.dataset.key;
        if (picked.has(key)) picked.delete(key); else picked.add(key);
        paint();
      };
    }
  };
  paint();
}

// --- Sent: iOS SentConfirmationSheet -----------------------------------------------------------

// Sent, the amount, "to <recipient>" (not for a compound), the transaction as an explorer link,
// "Tap the transaction to open it in the explorer.", Done.
function showSent({ amountSompi, to, txid, compound, onDone }) {
  render(`
    <section class="screen sent">
      <div class="sent-check" style="color:#30d158">${ICONS.checkBig}</div>
      <h2>Sent</h2>
      <div class="sent-amount">${esc(wallet.sompiToKasText(amountSompi ?? 0n))} KAS</div>
      ${compound ? "" : `<div class="muted small center-text break">to ${esc(to?.domain || to?.address || "")}</div>`}
      ${txid ? `<a class="link-button center mono tiny break sent-tx" href="${esc(wallet.explorerTxUrl(txid))}" target="_blank" rel="noopener noreferrer">${esc(txid)} ${ICONS.upRightSquare}</a>
      <p class="muted tiny center-text">Tap the transaction to open it in the explorer.</p>` : ""}
      <div class="spacer"></div>
      <button id="done" class="big">Done</button>
    </section>`, "sent");
  $("#done").onclick = onDone;
}
