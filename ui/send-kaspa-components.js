// The pieces every Send Kaspa screen is built from, so they look and behave the same (iOS
// Views/Shared/SendKaspaComponents.swift, 4d0324f / afaad34 / e994235 / dae8a01): the 1:1 chat's
// Send KAS sheet, Profile's Send Kaspa (the chatting address), a spending address's Send (and its
// Compound UTXOs), and KasSigner's send.
//
//   recipient card  - "To": address or name, Paste and Scan QR beside the field, the lookup status
//                     and the address card; locked to one address for Compound UTXOs
//   amount entry    - the big centred amount, the KAS / currency switch (showing the converted
//                     value) and Max
//   info pills      - "Available: X KAS" (with "· Address #N ⌄" where the source can be picked)
//                     and "From ..."
//   fee controls    - Network Fee (click it for a custom one), Normal / Fast / Priority, Coin Control
//   action button   - slide the knob to the right end to send ("Slide to Send" / "Slide to
//                     Consolidate"); a plain button for KasSigner's Build Unsigned Transaction
//   Send From       - the spending-address picker behind the Available pill
//
// Every screen keeps its own logic (name lookup, fee estimates, coin control, compound, KasSigner
// signing, the sent confirmation); these only draw it and handle the gestures. Markup comes out
// as strings (so a screen that re-renders with innerHTML, like KasSigner's, uses the same
// function) and `mountSendPieces` drops them into a static screen's placeholders. Every value
// interpolated here is escaped.

import { otherNetworkReason } from "../engine/network.js";

import { sanitizeAmountInput } from "../engine/amounts.js";

const KNOB_INSET = 4;

export function escapeSendHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
const esc = escapeSendHtml;

// Only [a-z0-9-] survives in a data-attribute name built from a caller's prefix.
function attrName(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9-]/g, "");
}

export const SEND_ICONS = {
  paste: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="2.5" width="8" height="4" rx="1.2"/><path d="M8 4.5H6.5A1.5 1.5 0 0 0 5 6v13.5A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V6a1.5 1.5 0 0 0-1.5-1.5H16"/></svg>',
  scan: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 8V5.5A2.5 2.5 0 0 1 5.5 3H8M16 3h2.5A2.5 2.5 0 0 1 21 5.5V8M21 16v2.5a2.5 2.5 0 0 1-2.5 2.5H16M8 21H5.5A2.5 2.5 0 0 1 3 18.5V16"/><path d="M3 12h18"/></svg>',
  merge: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 4v6a4 4 0 0 0 4 4v6M16 4v6a4 4 0 0 1-4 4"/><path d="m9 17 3 3 3-3"/></svg>',
  check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>',
  checkCircle: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9.25"/><path d="M8 12.4l2.6 2.6L16 9.6"/></svg>',
  pencil: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L18.5 9.5a2.12 2.12 0 0 0-3-3L5 17v3z"/><path d="M13.5 6.5l3 3"/></svg>',
  chevronDown: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>',
  chevronRight: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>',
  arrows: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 20V5m0 0L3.5 8.5M7 5l3.5 3.5M17 4v15m0 0-3.5-3.5M17 19l3.5-3.5"/></svg>',
  slide: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 6 6-6 6M13 6l6 6-6 6"/></svg>',
  book: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4.5A1.5 1.5 0 0 1 6.5 3H19v15.5H6.5A1.5 1.5 0 0 0 5 20Z"/><path d="M5 20a1.5 1.5 0 0 0 1.5 1.5H19v-3"/></svg>',
  bookFill: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4.5A1.5 1.5 0 0 1 6.5 3H19v15.5H6.5A1.5 1.5 0 0 0 5 20Z" style="fill:currentColor"/><path d="M5 20a1.5 1.5 0 0 0 1.5 1.5H19v-3"/></svg>',
};

// The Address Book on every recipient card (iOS 00767a4 SendRecipientCard): a button beside Scan
// QR (only while the book has entries) that picks a saved address, and the saved name under the
// address card. The host app supplies the book: { hasEntries() -> bool, nameFor(address) ->
// string|null }. Unset, the card has neither.
let addressBookHooks = null;
export function configureSendAddressBook(hooks) {
  addressBookHooks = hooks && typeof hooks === "object" ? hooks : null;
}
function addressBookHasEntries() {
  try { return Boolean(addressBookHooks?.hasEntries?.()); } catch { return false; }
}
function addressBookNameFor(address) {
  const trimmed = String(address || "").trim();
  if (!trimmed) return null;
  try { return addressBookHooks?.nameFor?.(trimmed) || null; } catch { return null; }
}
function savedNameInnerHtml(name) {
  return name ? `${SEND_ICONS.bookFill}<span>${esc(name)}</span>` : "";
}

/** Re-reads the Address Book for a mounted card: the button's visibility and the saved name for
 *  `address` (the resolved address, else what is typed). */
export function refreshRecipientAddressBook(root, prefix, address) {
  if (!root) return;
  const p = attrName(prefix);
  const button = root.querySelector(`[data-${p}-address-book]`);
  if (button) button.hidden = !addressBookHasEntries();
  const line = root.querySelector(`[data-${p}-saved-name]`);
  if (line) {
    const name = addressBookNameFor(address);
    line.innerHTML = savedNameInnerHtml(name);
    line.hidden = !name;
  }
}

/** "kaspa:qyp4abcdef...123456" - the iOS shortAddress (14 + 6). */
export function shortSendAddress(address) {
  const text = String(address || "");
  return text.length > 24 ? `${text.slice(0, 14)}...${text.slice(-6)}` : text;
}

/** Sompi as plain KAS: up to 8 decimals, trailing zeros dropped (iOS formatKas). */
export function formatSompiPlain(sompi) {
  let value;
  try { value = BigInt(sompi ?? 0); } catch { value = BigInt(Math.round(Number(sompi) || 0)); }
  const negative = value < 0n;
  if (negative) value = -value;
  const whole = value / 100000000n;
  const fraction = (value % 100000000n).toString().padStart(8, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

// --- Recipient ----------------------------------------------------------------------------------

/** The line under the recipient saying what the input resolved to (iOS SendRecipientCard
 *  statusLine). Empty while nothing is typed. */
export function recipientStatusHtml({ input = "", resolving = false, error = null, resolvedAddress = null, resolvedName = null, valid = false } = {}) {
  const trimmed = String(input || "").trim();
  if (!trimmed) return "";
  if (resolving) return '<p class="sk-status muted"><span class="sk-spinner" aria-hidden="true"></span>Looking up domain…</p>';
  if (error) return `<p class="sk-status bad">✕ ${esc(error)}</p>`;
  if (resolvedAddress) {
    return `<p class="sk-status good">✓ Resolved: ${esc(resolvedName || "")}</p>
      <p class="sk-status mono">${esc(resolvedAddress)}</p>`;
  }
  if (valid) return '<p class="sk-status good">✓ Valid address</p>';
  // The other network's address is the same key on another chain (IOS-003): say which.
  const reason = otherNetworkReason(trimmed);
  return `<p class="sk-status bad">✕ ${esc(reason || "Invalid address format")}</p>`;
}

/**
 * Who the Kaspa goes to. Data attributes, with P = prefix: P-recipient (the input), P-paste,
 * P-scan, P-check (the green tick in the field), P-resolution (the address card's host, inside
 * P-resolution-wrap),
 * P-status (the status line), P-locked / P-locked-address / P-locked-note (Compound UTXOs) and
 * P-recipient-row (the editable row, hidden while locked), P-address-book (the Address Book
 * button) and P-saved-name (the saved name under the card, for `savedNameAddress` or the value).
 */
export function recipientCardHtml({
  prefix, value = "", lockedAddress = null, placeholder = "kaspa:qr... or domain",
  statusHtml = "", cardHtml = "", valid = false, label = "To", savedNameAddress = null,
} = {}) {
  const p = attrName(prefix);
  const locked = Boolean(lockedAddress);
  const savedName = addressBookNameFor(savedNameAddress ?? value);
  return `
    <div class="sk-card sk-recipient" data-${p}-recipient-card>
      <span class="sk-card-label">${esc(label)}</span>
      <div class="sk-recipient-locked" data-${p}-locked ${locked ? "" : "hidden"}>
        ${SEND_ICONS.merge}<code data-${p}-locked-address>${esc(lockedAddress || "")}</code>
      </div>
      <p class="sk-caption sk-recipient-locked-note" data-${p}-locked-note ${locked ? "" : "hidden"}>Consolidating This Address</p>
      <div class="sk-recipient-row" data-${p}-recipient-row ${locked ? "hidden" : ""}>
        <span class="sk-recipient-field">
          <input class="sk-recipient-input" type="text" data-${p}-recipient placeholder="${esc(placeholder)}"
            autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="Recipient address or name" value="${esc(value)}" />
          <span class="sk-recipient-check" data-${p}-check ${valid ? "" : "hidden"} aria-hidden="true">${SEND_ICONS.check}</span>
        </span>
        <button type="button" class="sk-icon-button" data-${p}-paste aria-label="Paste" title="Paste">${SEND_ICONS.paste}</button>
        <button type="button" class="sk-icon-button" data-${p}-scan aria-label="Scan QR" title="Scan QR">${SEND_ICONS.scan}</button>
        <button type="button" class="sk-icon-button" data-${p}-address-book aria-label="Address Book" title="Address Book" ${addressBookHasEntries() ? "" : "hidden"}>${SEND_ICONS.book}</button>
      </div>
      <div class="sk-recipient-resolution" data-${p}-resolution-wrap ${locked ? "hidden" : ""}><div data-${p}-resolution>${cardHtml}</div></div>
      <p class="sk-saved-name" data-${p}-saved-name ${!locked && savedName ? "" : "hidden"}>${savedNameInnerHtml(locked ? null : savedName)}</p>
      <div class="sk-recipient-status" data-${p}-status role="status" aria-live="polite" ${locked ? "hidden" : ""}>${statusHtml}</div>
    </div>`;
}

/** Locks (Compound UTXOs) or unlocks a mounted recipient card in place. */
export function setRecipientLocked(root, prefix, lockedAddress) {
  if (!root) return;
  const p = attrName(prefix);
  const locked = Boolean(lockedAddress);
  const q = (name) => root.querySelector(`[data-${p}-${name}]`);
  const show = (el, on) => { if (el) el.hidden = !on; };
  show(q("locked"), locked);
  show(q("locked-note"), locked);
  show(q("recipient-row"), !locked);
  show(q("resolution-wrap"), !locked);
  show(q("status"), !locked);
  if (locked) show(q("saved-name"), false);
  const code = q("locked-address");
  if (code) code.textContent = lockedAddress || "";
  const input = q("recipient");
  if (input) input.readOnly = locked;
}

// --- Amount -------------------------------------------------------------------------------------

/**
 * The big centred amount and its unit, with the KAS / currency switch and Max under it.
 * Attribute names default to P-amount (input), P-unit-code (the unit after the number),
 * P-unit (the switch), P-conversion (the text inside the switch) and P-max; `attrs` renames any.
 */
export function amountEntryHtml({
  prefix, value = "", unitText = "KAS", conversionText = "", showToggle = false,
  maxDisabled = false, maxBusy = false, ariaLabel = "Amount", attrs = {},
} = {}) {
  const p = attrName(prefix);
  const a = {
    input: attrName(attrs.input || `${p}-amount`),
    unit: attrName(attrs.unit || `${p}-unit-code`),
    toggle: attrName(attrs.toggle || `${p}-unit`),
    conversion: attrName(attrs.conversion || `${p}-conversion`),
    max: attrName(attrs.max || `${p}-max`),
  };
  const size = amountFontSize(value);
  return `
    <div class="sk-amount" data-${p}-amount-entry>
      <label class="sk-amount-entry">
        <input class="sk-amount-input" type="text" inputmode="decimal" autocomplete="off" spellcheck="false" placeholder="0"
          data-${a.input} aria-label="${esc(ariaLabel)}" value="${esc(value)}"
          style="font-size:${size}px;width:${Math.max(1, String(value).length || 1) + 0.6}ch" />
        <span class="sk-amount-unit" data-${a.unit} style="font-size:${Math.round(size * 0.55)}px">${esc(unitText)}</span>
      </label>
      <div class="sk-amount-actions">
        <button type="button" class="sk-chip" data-${a.toggle} aria-label="Switch between Kaspa and your currency" ${showToggle ? "" : "hidden"}>
          ${SEND_ICONS.arrows}<span data-${a.conversion}>${esc(conversionText)}</span>
        </button>
        <button type="button" class="sk-chip sk-chip-max" data-${a.max} ${maxDisabled || maxBusy ? "disabled" : ""}>${maxBusy ? '<span class="sk-spinner" aria-hidden="true"></span>' : "Max"}</button>
      </div>
    </div>`;
}

/** Big when short, smaller as it grows (iOS: 52 / 40 / 30 pt). */
export function amountFontSize(text) {
  const length = String(text || "").length;
  return length <= 7 ? 52 : (length <= 10 ? 40 : 30);
}

/** Re-sizes a mounted amount entry to what's typed (runs on every keystroke). */
export function layoutAmountEntry(input, unitEl) {
  if (!input) return;
  const display = String(input.value || "");
  const size = amountFontSize(display);
  input.style.fontSize = `${size}px`;
  input.style.width = `${Math.max(1, display.length || 1) + 0.6}ch`;
  if (unitEl) unitEl.style.fontSize = `${Math.round(size * 0.55)}px`;
}

/** Digits and one decimal point, at most `maxDecimals` after it: "," and the Arabic decimal
 *  separator read as ".", Arabic-Indic / Persian digits as ASCII (iOS KaspaUnit.sanitizeAmountInput,
 *  the default for every amount entry, IOS-010). */
export function sanitizeAmountText(value, maxDecimals = 8) {
  return sanitizeAmountInput(value, maxDecimals);
}

// --- Pills --------------------------------------------------------------------------------------

/** The inside of an Available pill: "Available: X KAS", plus "· Address #N ⌄" when the source
 *  can be picked (or just "· Address #N" when it is shown but fixed). */
export function availablePillInnerHtml({ text, sourceLabel = null, chooser = false } = {}) {
  return `<span class="sk-pill-value" data-sk-pill-value>${esc(text)}</span>${sourceLabel
    ? `<span class="sk-pill-sep" aria-hidden="true">·</span><span class="sk-pill-source">${esc(sourceLabel)}</span>`
    : ""}${chooser ? `<span class="sk-pill-chevron" aria-hidden="true">${SEND_ICONS.chevronDown}</span>` : ""}`;
}

/** One glass capsule of context. A `button` when it opens something (the Send From picker). */
export function infoPillHtml({ attr = "", innerHtml = "", button = false, disabled = false, title = "" } = {}) {
  const a = attr ? `data-${attrName(attr)}` : "";
  return button
    ? `<button type="button" class="sk-pill sk-pill-button" ${a} ${disabled ? "disabled" : ""} ${title ? `title="${esc(title)}" aria-label="${esc(title)}"` : ""}>${innerHtml}</button>`
    : `<span class="sk-pill" ${a}>${innerHtml}</span>`;
}

// --- Fee and coin control -----------------------------------------------------------------------

export const SEND_FEE_TIERS = [
  { id: "normal", label: "Normal" },
  { id: "fast", label: "Fast" },
  { id: "priority", label: "Priority" },
];

/**
 * Network Fee (click the amount to type a custom one), the fee speed and Coin Control - one card.
 * Attributes: P-fee="tier" (the speed buttons), P-fee-edit (the fee amount button, its text in
 * P-fee-summary), P-fee-editor / P-fee-custom / P-fee-commit (the custom fee field),
 * P-fee-estimating, P-coin-toggle (the Coin Control row, its value in P-coin-summary) and
 * P-coin-list (an inline UTXO list under it, when `coinList` is set).
 */
export function feeControlsHtml({
  prefix, feeText = null, estimating = false, editing = false, customValue = "", tier = "normal",
  showCoinControl = true, coinSummary = "Automatic", coinList = false, coinListHtml = "",
} = {}) {
  const p = attrName(prefix);
  const showButton = !editing && !estimating;
  return `
    <div class="sk-card sk-fee" data-${p}-fee-card>
      <div class="sk-fee-row">
        <span class="sk-fee-title">Network Fee</span>
        <span class="sk-fee-value">
          <span class="sk-fee-editor" data-${p}-fee-editor ${editing ? "" : "hidden"}>
            <input class="sk-fee-input" type="text" inputmode="decimal" autocomplete="off" placeholder="0.00"
              data-${p}-fee-custom aria-label="Custom network fee" value="${esc(customValue)}" />
            <button type="button" class="sk-icon-button sk-fee-commit" data-${p}-fee-commit aria-label="Use this fee" title="Use this fee">${SEND_ICONS.checkCircle}</button>
          </span>
          <span class="sk-fee-estimating" data-${p}-fee-estimating ${estimating && !editing ? "" : "hidden"} aria-label="Estimating fee"><span class="sk-spinner" aria-hidden="true"></span></span>
          <button type="button" class="sk-fee-text" data-${p}-fee-edit ${showButton ? "" : "hidden"} title="Set a custom fee">
            <span data-${p}-fee-summary>${esc(feeText ?? "--")}</span>${SEND_ICONS.pencil}
          </button>
        </span>
      </div>
      <div class="settings-segmented full sk-fee-tiers" role="group" aria-label="Network fee speed">
        ${SEND_FEE_TIERS.map((t) => `<button type="button" class="settings-segmented-option${tier === t.id ? " active" : ""}" data-${p}-fee="${t.id}" aria-pressed="${tier === t.id ? "true" : "false"}">${esc(t.label)}</button>`).join("")}
      </div>
      <p class="sk-caption">If the network is busy, Fast or Priority pays a higher fee to help this confirm sooner. Click the fee amount to set a custom fee.</p>
      ${showCoinControl ? `
      <div class="sk-divider" aria-hidden="true"></div>
      <button type="button" class="sk-coin-row" data-${p}-coin-toggle aria-expanded="false">
        <span class="sk-coin-title">Coin Control</span>
        <span class="sk-coin-summary" data-${p}-coin-summary>${esc(coinSummary)}</span>
        <span class="sk-coin-chevron" aria-hidden="true">${coinList ? SEND_ICONS.chevronDown : SEND_ICONS.chevronRight}</span>
      </button>
      ${coinList ? `<div class="manage-send-coin-list sk-coin-list" data-${p}-coin-list hidden>${coinListHtml}</div>` : ""}` : ""}
    </div>`;
}

/** "Automatic" or "3 UTXOs selected", for the coin control row (iOS coinControlSummary). */
export function coinControlSummaryText(count) {
  const n = Number(count) || 0;
  return n ? `${n} UTXO${n === 1 ? "" : "s"} selected` : "Automatic";
}

/** DOM handle over a mounted fee card, for screens that update in place instead of re-rendering. */
export function feeControls(root, prefix) {
  const p = attrName(prefix);
  const q = (name) => root?.querySelector(`[data-${p}-${name}]`);
  let editing = false;
  let estimating = false;
  function paint() {
    const editor = q("fee-editor");
    const button = q("fee-edit");
    const spinner = q("fee-estimating");
    if (editor) editor.hidden = !editing;
    if (spinner) spinner.hidden = editing || !estimating;
    if (button) button.hidden = editing || estimating;
  }
  return {
    setTier(tier) {
      root?.querySelectorAll(`[data-${p}-fee]`).forEach((b) => {
        const on = b.getAttribute(`data-${p}-fee`) === tier;
        b.classList.toggle("active", on);
        b.setAttribute("aria-pressed", on ? "true" : "false");
      });
    },
    setText(text) { const el = q("fee-summary"); if (el) el.textContent = text ?? "--"; },
    setEstimating(on) { estimating = Boolean(on); paint(); },
    setEditing(on, value = null) {
      editing = Boolean(on);
      const input = q("fee-custom");
      if (input && value != null) input.value = value;
      paint();
      if (editing && input) { input.focus(); input.select?.(); }
    },
    get editing() { return editing; },
    setCoinSummary(text) { const el = q("coin-summary"); if (el) el.textContent = text; },
  };
}

// --- Send button --------------------------------------------------------------------------------

/**
 * The send button. Slide (default): a track with a white knob; slide it to the right end to send.
 * Plain (`requiresSlide: false`): an ordinary button in the same look (KasSigner's Build Unsigned
 * Transaction, which moves nothing by itself). `attr` is the button's data attribute, `labelAttr`
 * its label's.
 */
export function sendActionButtonHtml({
  attr, labelAttr = "", title = "Slide to Send", requiresSlide = true, disabled = true, busy = false,
  busyLabel = "Sending…", type = "button",
} = {}) {
  const a = attrName(attr);
  const l = labelAttr ? `data-${attrName(labelAttr)}` : "";
  const text = busy ? busyLabel : title;
  if (!requiresSlide) {
    return `<button type="${type === "submit" ? "submit" : "button"}" class="sk-action sk-action-plain${busy ? " busy" : ""}" data-${a} ${disabled || busy ? "disabled" : ""} aria-busy="${busy ? "true" : "false"}">
      <span class="sk-action-label" ${l}>${busy ? '<span class="sk-spinner" aria-hidden="true"></span>' : ""}${esc(text)}</span>
    </button>`;
  }
  return `<button type="button" class="sk-action sk-slide" data-${a} data-sk-slide ${disabled ? "disabled" : ""} aria-label="${esc(title)}" aria-busy="false">
      <span class="sk-slide-fill" aria-hidden="true"></span>
      <span class="sk-action-label sk-slide-label" ${l}>${esc(title)}</span>
      <span class="sk-slide-knob" aria-hidden="true">${SEND_ICONS.slide}</span>
    </button>`;
}

/**
 * Drives a slide button: drag the knob to the right end (95% counts) to call `onAction`. Released
 * early it springs back; after an action that didn't start a send (the small-amount question, an
 * error) it resets by itself, and again when `setBusy(false)` says the send finished. A keyboard
 * press or a screen reader's activation (a click with no pointer behind it, detail 0) is the plain
 * action; a mouse click on the track does nothing. Returns { setBusy, setEnabled, setTitle, reset }.
 */
export function createSendActionButton(root, { onAction, busyLabel = "Sending…" } = {}) {
  const noop = { setBusy() {}, setEnabled() {}, setTitle() {}, reset() {}, get busy() { return false; } };
  if (!root) return noop;
  const knob = root.querySelector(".sk-slide-knob");
  const fill = root.querySelector(".sk-slide-fill");
  const label = root.querySelector(".sk-action-label");
  let title = root.getAttribute("aria-label") || label?.textContent || "Slide to Send";
  let offset = 0;
  let dragging = false;
  let pointerId = null;
  let startX = 0;
  let busy = false;
  let enabled = !root.disabled;
  let resetTimer = null;

  const knobWidth = () => knob?.offsetWidth || 48;
  const maxOffset = () => Math.max(1, root.clientWidth - knobWidth() - KNOB_INSET * 2);
  function paint(animate) {
    root.classList.toggle("sk-slide-animating", Boolean(animate));
    const progress = Math.min(1, offset / maxOffset());
    if (knob) knob.style.transform = `translateX(${offset}px)`;
    if (fill) fill.style.width = `${KNOB_INSET * 2 + knobWidth() + offset}px`;
    if (label) label.style.opacity = busy ? "1" : String(1 - progress);
    root.classList.toggle("sk-slide-end", progress >= 0.95);
  }
  function reset() {
    dragging = false;
    pointerId = null;
    offset = 0;
    paint(true);
  }
  function fire() {
    if (busy || root.disabled) { reset(); return; }
    try { onAction?.(); } catch { /* the screen reports its own errors */ }
    if (resetTimer) clearTimeout(resetTimer);
    // A send that didn't start (dust question, a validation error) leaves it not busy: put the
    // knob back.
    resetTimer = setTimeout(() => { resetTimer = null; if (!busy) reset(); }, 600);
  }
  // A screen that drives `disabled` itself (never calls setEnabled) keeps doing so: busy only
  // ever adds a disable, and finishing leaves the screen's own state alone.
  let enabledManaged = false;
  function applyDisabled() {
    if (enabledManaged) root.disabled = busy || !enabled;
    else if (busy) root.disabled = true;
  }

  root.addEventListener("pointerdown", (event) => {
    if (root.disabled || busy || !knob) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    // The knob is what you slide - but a touch close to it counts, it is small on a phone.
    const knobBox = knob.getBoundingClientRect();
    if (event.clientX > knobBox.right + 12) return;
    event.preventDefault();
    dragging = true;
    pointerId = event.pointerId;
    startX = event.clientX - offset;
    try { root.setPointerCapture(event.pointerId); } catch { /* fine */ }
    root.classList.add("sk-slide-dragging");
    paint(false);
  });
  root.addEventListener("pointermove", (event) => {
    if (!dragging || event.pointerId !== pointerId) return;
    offset = Math.min(Math.max(0, event.clientX - startX), maxOffset());
    paint(false);
  });
  const end = (event, cancelled) => {
    if (!dragging || event.pointerId !== pointerId) return;
    dragging = false;
    pointerId = null;
    root.classList.remove("sk-slide-dragging");
    if (!cancelled && offset >= maxOffset() * 0.95) {
      offset = maxOffset();
      paint(true);
      fire();
    } else {
      reset();
    }
  };
  root.addEventListener("pointerup", (event) => end(event, false));
  root.addEventListener("pointercancel", (event) => end(event, true));
  root.addEventListener("lostpointercapture", (event) => end(event, true));
  root.addEventListener("contextmenu", (event) => event.preventDefault());
  root.addEventListener("click", (event) => {
    // Pointer clicks are the end of a slide the handlers above already judged.
    if (event.detail !== 0 || root.disabled || busy) return;
    fire();
  });
  window.addEventListener("resize", () => { if (!dragging && offset) reset(); });

  paint(false);
  return {
    setBusy(on) {
      busy = Boolean(on);
      root.classList.toggle("busy", busy);
      root.setAttribute("aria-busy", busy ? "true" : "false");
      if (label) label.textContent = busy ? busyLabel : title;
      applyDisabled();
      if (!busy) reset(); else paint(false);
    },
    setEnabled(on) { enabledManaged = true; enabled = Boolean(on); applyDisabled(); if (root.disabled && !busy && offset) reset(); },
    setTitle(text) {
      title = String(text || "");
      root.setAttribute("aria-label", title);
      if (label && !busy) label.textContent = title;
    },
    reset,
    get busy() { return busy; },
  };
}

// --- Mounting into a static screen --------------------------------------------------------------

/** Replaces each `[data-sk-mount="name"]` placeholder inside `root` with `html[name]`. */
export function mountSendPieces(root, html = {}) {
  if (!root) return;
  root.querySelectorAll("[data-sk-mount]").forEach((slot) => {
    const name = slot.getAttribute("data-sk-mount");
    if (!(name in html)) return;
    const holder = document.createElement("div");
    holder.innerHTML = String(html[name] || "").trim();
    slot.replaceWith(...holder.childNodes);
  });
}

// --- Send From (which spending address pays) ----------------------------------------------------

/** The rows Send From lists (iOS SpendingSourcePicker): every visible spending address plus
 *  hidden ones holding Kaspa (and the current one), funded first, then by index. */
export function sendFromRows(entries, currentIndex) {
  return (entries || [])
    .filter((e) => !e.hidden || BigInt(e.balanceSompi || 0) > 0n || e.index === currentIndex)
    .sort((a, b) => {
      const fa = BigInt(a.balanceSompi || 0) > 0n ? 0 : 1;
      const fb = BigInt(b.balanceSompi || 0) > 0n ? 0 : 1;
      return fa - fb || a.index - b.index;
    });
}

let activeSourcePicker = null;

/**
 * Opens Send From over the current screen. `loadEntries()` resolves to
 * [{ index, address, label, balanceSompi, isPrimary, hidden }]; picking a row calls
 * `onPick(entry)` and closes. Picking changes that one send only - the screen decides what that
 * means; this never touches which address is primary.
 */
export function openSendFromPicker({ loadEntries, currentIndex, kasUnit = "KAS", onPick } = {}) {
  closeSendFromPicker();
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop sk-source-backdrop";
  backdrop.dataset.skSourcePicker = "";
  backdrop.innerHTML = `
    <section class="contact-modal sk-source-sheet" role="dialog" aria-modal="true" aria-labelledby="sk-source-title">
      <div class="modal-header">
        <div><h2 id="sk-source-title">Send From</h2></div>
        <button class="modal-close" type="button" data-sk-source-cancel aria-label="Cancel">×</button>
      </div>
      <div class="sk-source-list" data-sk-source-list role="listbox" aria-label="Spending addresses">
        <p class="sk-source-empty"><span class="sk-spinner" aria-hidden="true"></span>Loading addresses…</p>
      </div>
      <div class="modal-actions">
        <button class="secondary-button" type="button" data-sk-source-cancel>Cancel</button>
      </div>
    </section>`;
  const list = backdrop.querySelector("[data-sk-source-list]");
  let entries = [];

  const onKey = (event) => {
    if (event.key !== "Escape") return;
    // Only the picker closes, not the send screen under it.
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();
    closeSendFromPicker();
  };
  const close = () => {
    window.removeEventListener("keydown", onKey, true);
    backdrop.remove();
    if (activeSourcePicker === close) activeSourcePicker = null;
  };
  activeSourcePicker = close;
  window.addEventListener("keydown", onKey, true);

  backdrop.addEventListener("mousedown", (event) => { if (event.target === backdrop) close(); });
  backdrop.addEventListener("click", (event) => {
    if (event.target.closest("[data-sk-source-cancel]")) { close(); return; }
    const row = event.target.closest("[data-sk-source-index]");
    if (!row) return;
    const picked = entries.find((e) => String(e.index) === row.getAttribute("data-sk-source-index"));
    close();
    if (picked) { try { onPick?.(picked); } catch { /* the screen reports its own errors */ } }
  });
  document.body.appendChild(backdrop);

  Promise.resolve()
    .then(() => loadEntries?.())
    .then((loaded) => {
      if (!backdrop.isConnected) return;
      entries = sendFromRows(loaded, currentIndex);
      if (!entries.length) { list.innerHTML = '<p class="sk-source-empty">No spending addresses yet.</p>'; return; }
      list.innerHTML = entries.map((e) => {
        const funded = BigInt(e.balanceSompi || 0) > 0n;
        const current = e.index === currentIndex;
        return `
          <button type="button" class="sk-source-row${current ? " current" : ""}" role="option" aria-selected="${current ? "true" : "false"}" data-sk-source-index="${esc(e.index)}">
            <span class="sk-source-copy">
              <span class="sk-source-name">${esc(e.label || `Address #${e.index}`)}${e.isPrimary ? '<span class="sk-source-primary">Primary</span>' : ""}</span>
              <code class="sk-source-address">${esc(shortSendAddress(e.address))}</code>
            </span>
            <span class="sk-source-balance${funded ? "" : " empty"}">${esc(formatSompiPlain(e.balanceSompi || 0))} ${esc(kasUnit)}</span>
            <span class="sk-source-check" aria-hidden="true">${current ? SEND_ICONS.check : ""}</span>
          </button>`;
      }).join("");
      list.querySelector(".sk-source-row.current")?.focus?.();
    })
    .catch((error) => {
      if (!backdrop.isConnected) return;
      list.innerHTML = `<p class="sk-source-empty bad">${esc(error?.message || "Couldn't load your spending addresses.")}</p>`;
    });
  return close;
}

export function closeSendFromPicker() {
  if (activeSourcePicker) activeSourcePicker();
}

// --- Coin Control (which coins pay) -------------------------------------------------------------

/** "txid:index" for a UTXO entry ({ outpoint: { transactionId, index } } or a flat one). */
export function utxoEntryKey(entry) {
  const outpoint = entry?.outpoint || entry || {};
  return `${outpoint.transactionId ?? outpoint.transaction_id ?? ""}:${outpoint.index ?? ""}`;
}

/** A UTXO entry's amount in sompi as BigInt (engine entries carry `amount`, others `amountSompi`). */
export function utxoEntrySompi(entry) {
  try { return BigInt(entry?.amount ?? entry?.amountSompi ?? 0); } catch { return 0n; }
}

let activeCoinPicker = null;

/**
 * Opens Coin Control over the current screen (iOS CoinControlView): the coins at the address
 * paying, largest first, each one tickable, with Select All / Automatic (Clear Selection) and the
 * selected total. `loadEntries()` resolves to UTXO entries; `initialSelection` is the current
 * "txid:index" list (null = automatic). Confirming calls `onDone(selection)`, where selection is
 * [{ key, amountSompi, entry }] or null for automatic (an empty pick means automatic, never
 * "spend nothing"); Cancel, Escape or the backdrop leave the choice as it was. `labels` maps
 * "txid:index" to a coin's name. A failed load says so, with Retry, instead of "no coins".
 */
export function openCoinControlPicker({ loadEntries, initialSelection = null, labels = {}, kasUnit = "KAS", onDone } = {}) {
  closeCoinControlPicker();
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop sk-source-backdrop sk-coin-backdrop";
  backdrop.dataset.skCoinPicker = "";
  backdrop.innerHTML = `
    <section class="contact-modal sk-source-sheet sk-coin-sheet" role="dialog" aria-modal="true" aria-labelledby="sk-coin-title">
      <div class="modal-header">
        <div><h2 id="sk-coin-title">Coin Control</h2></div>
        <button class="modal-close" type="button" data-sk-coin-cancel aria-label="Cancel">×</button>
      </div>
      <div class="sk-coin-body" data-sk-coin-body></div>
      <div class="modal-actions">
        <button class="secondary-button" type="button" data-sk-coin-cancel>Cancel</button>
        <button class="primary-button" type="button" data-sk-coin-done disabled>Use Automatic Selection</button>
      </div>
    </section>`;
  const body = backdrop.querySelector("[data-sk-coin-body]");
  const doneButton = backdrop.querySelector("[data-sk-coin-done]");
  let entries = [];
  let loading = true;
  let loadError = "";
  const selected = new Set(Array.isArray(initialSelection) ? initialSelection.map(String) : []);

  function paint() {
    if (doneButton) {
      doneButton.disabled = loading;
      doneButton.textContent = selected.size ? "Confirm Selection" : "Use Automatic Selection";
    }
    if (loading) {
      body.innerHTML = '<p class="sk-source-empty"><span class="sk-spinner" aria-hidden="true"></span>Loading this address\'s UTXOs…</p>';
      return;
    }
    if (!entries.length) {
      body.innerHTML = loadError
        ? `<p class="sk-source-empty bad">${esc(loadError)}</p><div class="sk-coin-retry"><button type="button" class="cold-inline-link" data-sk-coin-retry>Retry</button></div>`
        : '<p class="sk-source-empty">No UTXOs found at this address.</p>';
      return;
    }
    let total = 0n;
    for (const entry of entries) if (selected.has(utxoEntryKey(entry))) total += utxoEntrySompi(entry);
    body.innerHTML = `
      <div class="cold-coincontrol-actions sk-coin-actions">
        <button type="button" class="cold-inline-link" data-sk-coin-all>Select All</button>
        <button type="button" class="cold-inline-link" data-sk-coin-none>Automatic (Clear Selection)</button>
      </div>
      <div class="cold-coincontrol-list sk-coin-picker-list" role="group" aria-label="UTXOs at this address">
        ${entries.map((entry) => {
          const key = utxoEntryKey(entry);
          const on = selected.has(key);
          const label = labels?.[key];
          const [txid, index] = [key.slice(0, key.lastIndexOf(":")), key.slice(key.lastIndexOf(":") + 1)];
          return `
          <button type="button" class="cold-coincontrol-row${on ? " selected" : ""}" data-sk-coin-key="${esc(key)}" aria-pressed="${on ? "true" : "false"}">
            <span class="cold-coincontrol-check" aria-hidden="true">${on ? SEND_ICONS.checkCircle : '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9.25"/></svg>'}</span>
            <span class="cold-coincontrol-copy">
              ${label ? `<span class="cold-coincontrol-label">${esc(label)}</span>` : ""}
              <span class="cold-coincontrol-amount">${esc(formatSompiPlain(utxoEntrySompi(entry)))} ${esc(kasUnit)}</span>
              <span class="cold-coincontrol-outpoint">${esc(txid.slice(0, 10))}…:${esc(index)}</span>
            </span>
          </button>`;
        }).join("")}
      </div>
      ${selected.size ? `<p class="field-hint cold-coincontrol-total">Selected: ${esc(formatSompiPlain(total))} ${esc(kasUnit)} (${selected.size} UTXO${selected.size === 1 ? "" : "s"})</p>` : ""}`;
  }

  function load() {
    loading = true;
    loadError = "";
    paint();
    Promise.resolve()
      .then(() => loadEntries?.())
      .then((loaded) => {
        if (!backdrop.isConnected) return;
        entries = [...(loaded || [])].sort((a, b) => {
          const x = utxoEntrySompi(a);
          const y = utxoEntrySompi(b);
          return x > y ? -1 : (x < y ? 1 : 0);
        });
        // A coin spent since it was picked can't stay ticked.
        const live = new Set(entries.map(utxoEntryKey));
        for (const key of [...selected]) if (!live.has(key)) selected.delete(key);
        loading = false;
        paint();
      })
      .catch((error) => {
        if (!backdrop.isConnected) return;
        entries = [];
        loading = false;
        loadError = error?.message || "Couldn't read this address's UTXOs.";
        paint();
      });
  }

  const onKey = (event) => {
    if (event.key !== "Escape") return;
    // Only Coin Control closes, not the send screen under it.
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();
    closeCoinControlPicker();
  };
  const close = () => {
    window.removeEventListener("keydown", onKey, true);
    backdrop.remove();
    if (activeCoinPicker === close) activeCoinPicker = null;
  };
  activeCoinPicker = close;
  window.addEventListener("keydown", onKey, true);

  backdrop.addEventListener("mousedown", (event) => { if (event.target === backdrop) close(); });
  backdrop.addEventListener("click", (event) => {
    if (event.target.closest("[data-sk-coin-cancel]")) { close(); return; }
    if (event.target.closest("[data-sk-coin-retry]")) { load(); return; }
    if (event.target.closest("[data-sk-coin-all]")) { entries.forEach((e) => selected.add(utxoEntryKey(e))); paint(); return; }
    if (event.target.closest("[data-sk-coin-none]")) { selected.clear(); paint(); return; }
    if (event.target.closest("[data-sk-coin-done]")) {
      if (loading) return;
      const picked = entries
        .filter((e) => selected.has(utxoEntryKey(e)))
        .map((e) => ({ key: utxoEntryKey(e), amountSompi: utxoEntrySompi(e), entry: e }));
      close();
      try { onDone?.(picked.length ? picked : null); } catch { /* the screen reports its own errors */ }
      return;
    }
    const row = event.target.closest("[data-sk-coin-key]");
    if (!row) return;
    const key = row.getAttribute("data-sk-coin-key");
    if (selected.has(key)) selected.delete(key); else selected.add(key);
    const list = body.querySelector(".sk-coin-picker-list");
    const scrollTop = list?.scrollTop || 0;
    paint();
    const next = body.querySelector(".sk-coin-picker-list");
    if (next) next.scrollTop = scrollTop;
    body.querySelector(`[data-sk-coin-key="${CSS.escape(key)}"]`)?.focus?.();
  });
  document.body.appendChild(backdrop);
  load();
  return close;
}

export function closeCoinControlPicker() {
  if (activeCoinPicker) activeCoinPicker();
}
