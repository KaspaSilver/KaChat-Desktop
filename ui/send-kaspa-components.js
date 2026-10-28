// The pieces every Send Kaspa screen is built from, so they look and behave the same (iOS
// Views/Shared/SendKaspaComponents.swift, 4d0324f / afaad34 / e994235 / dae8a01 / 6333dd3): the
// 1:1 chat's Send KAS sheet, Send Kaspa (Chats > +, Donate, the Address Book, an address's Send,
// paying a payment request, and Compound UTXOs), KaPosts tips, and KasSigner's send.
//
//   From            - Chatting Address (the default) or Choose an Address, the chosen address and
//                     its balance; every send but KasSigner's and Compound UTXOs starts with it
//   recipient card  - "To": address or name, Paste and Scan QR beside the field, the lookup status
//                     and the address card; locked to one address for Compound UTXOs
//   amount entry    - the big centred amount, the KAS / currency switch (showing the converted
//                     value) and Max
//   info pills      - "Available: X KAS" (Compound UTXOs and KasSigner, which have no From)
//   fee controls    - Network Fee (click it for a custom one), Normal / Fast / Priority, Coin Control
//   action button   - slide the knob to the right end to send ("Slide to Send" / "Slide to
//                     Consolidate"); a plain button for KasSigner's Build Unsigned Transaction
//   own addresses   - Choose an Address: every address of the account, each Used / Unused
//
// Every screen keeps its own logic (name lookup, fee estimates, coin control, compound, KasSigner
// signing, the sent confirmation); these only draw it and handle the gestures. Markup comes out
// as strings (so a screen that re-renders with innerHTML, like KasSigner's, uses the same
// function) and `mountSendPieces` drops them into a static screen's placeholders. Every value
// interpolated here is escaped.

import { otherNetworkReason } from "../engine/network.js";

import { sanitizeAmountInput, groupedAmountText } from "../engine/amounts.js";
import { splitTypedName, notFoundMessage } from "../engine/name-services.js";
import { isQuantumIndex, spendingIndexTitle } from "../engine/quantum.js";

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

/** Sompi as KAS with all 8 decimals ("1.50000000", iOS String(format: "%.8f")). */
export function fixedKas8(sompi) {
  let value;
  try { value = BigInt(sompi ?? 0); } catch { value = BigInt(Math.round(Number(sompi) || 0)); }
  const negative = value < 0n;
  if (negative) value = -value;
  return `${negative ? "-" : ""}${value / 100000000n}.${(value % 100000000n).toString().padStart(8, "0")}`;
}

// --- Recipient ----------------------------------------------------------------------------------

// --- Other domains -------------------------------------------------------------------------------

// "Other domains" (iOS 6ac48a7 OtherDomainsDropdown): what the same typed name points to on the
// other services, under the name it resolved to, each selectable. Every field that takes an
// address shows it (Create chat, the group address field, the Send screens, KasSigner's send, Send
// Domain, Portfolio, the Address Book editor, .kachat Transfer); the order is always .kachat first,
// and where .kachat's registry isn't live yet (mainnet) it is listed as "Coming soon". Opens by
// itself when nothing was picked but another service has the name. A pick is a click on
// [data-other-domain="<tld>"]; `pickOtherDomain` turns it back into the answer.

/** What a service with no address for the name says: "Coming soon", "Couldn't check" or
 *  "Not registered" (iOS OtherDomainsDropdown.missingText). */
export function otherDomainMissingText(resolution) {
  if (resolution?.state === "notLive") return "Coming soon";
  return resolution?.state === "failed" ? "Couldn't check" : "Not registered";
}

/** The one not-found message every address field shows (iOS 5a5122d notFoundMessage): "No .kas
 *  domain found" for a typed ending, else the .kachat one - "No .kachat domain found", or
 *  ".kachat names aren't live on this network yet" where its registry isn't. `results` are the
 *  lookup's answers when the caller has them. */
export function nameNotFoundText(typed, results = []) {
  return notFoundMessage(String(typed || ""), results);
}

/** The dropdown's markup: every answer but the one in use (`selectedTld`), or "" when there is
 *  none. `resolutions` are engine NameResolution rows ({ tld, name, address, state }). */
export function otherDomainsHtml({ resolutions = [], selectedTld = null } = {}) {
  const list = Array.isArray(resolutions) ? resolutions : [];
  const others = list.filter((entry) => entry && entry.tld !== selectedTld);
  if (!others.length) return "";
  const open = selectedTld == null && list.some((entry) => entry?.address);
  return `
    <details class="create-chat-other-domains other-domains" data-other-domains ${open ? "open" : ""}>
      <summary>Other domains</summary>
      ${others.map((entry) => entry.address
        ? `<button type="button" class="create-chat-other-domain" data-other-domain="${esc(entry.tld)}"><strong>${esc(entry.name)}</strong><span>${esc(shortSendAddress(entry.address))}</span></button>`
        : `<div class="create-chat-other-domain muted"><strong>${esc(entry.name)}</strong><span>${esc(otherDomainMissingText(entry))}</span></div>`).join("")}
    </details>`;
}

/** The answer a click under Other domains picked, or null (not a pick, or nothing to pick). */
export function pickOtherDomain(event, resolutions) {
  const button = event?.target?.closest?.("[data-other-domain]");
  if (!button) return null;
  return (Array.isArray(resolutions) ? resolutions : [])
    .find((entry) => entry?.tld === button.dataset.otherDomain && entry.address) || null;
}

/** The line under the recipient saying what the input resolved to (iOS SendRecipientCard
 *  statusLine), with Other domains under it once the lookup is done (`nameResolutions` /
 *  `selectedTld`, iOS 6ac48a7). Empty while nothing is typed. */
export function recipientStatusHtml({ input = "", resolving = false, error = null, resolvedAddress = null, resolvedName = null, valid = false, nameResolutions = [], selectedTld = null } = {}) {
  const trimmed = String(input || "").trim();
  if (!trimmed) return "";
  if (resolving) return '<p class="sk-status muted"><span class="sk-spinner" aria-hidden="true"></span>Looking up domain...</p>';
  const others = otherDomainsHtml({ resolutions: nameResolutions, selectedTld });
  if (error) return `<p class="sk-status bad">✕ ${esc(error)}</p>${others}`;
  if (resolvedAddress) {
    return `<p class="sk-status good">✓ Resolved: ${esc(resolvedName || "")}</p>
      <p class="sk-status mono">${esc(resolvedAddress)}</p>${others}`;
  }
  if (valid) return '<p class="sk-status good">✓ Valid address</p>';
  // The other network's address is the same key on another chain (IOS-003): say which.
  const reason = otherNetworkReason(trimmed);
  return `<p class="sk-status bad">✕ ${esc(reason || "Invalid address format")}</p>`;
}

/**
 * Who the Kaspa goes to. Data attributes, with P = prefix: P-recipient (the input), P-paste,
 * P-scan (no tick in the field: the status line says it, as iOS), P-resolution (the address card's host, inside
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
  // The field gets the plain value: grouped-amount.js shows it in this device's style when it
  // wraps the input (a "2,500" written here would read back as 2.5 where "," is the point).
  const shown = groupedAmountText(value);
  const size = amountFontSize(shown);
  return `
    <div class="sk-amount" data-${p}-amount-entry>
      <label class="sk-amount-entry">
        <input class="sk-amount-input" type="text" inputmode="decimal" autocomplete="off" spellcheck="false" placeholder="0"
          data-${a.input} aria-label="${esc(ariaLabel)}" value="${esc(value)}"
          style="font-size:${size}px;width:${Math.max(1, shown.length || 1) + 0.6}ch" />
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

/** Re-sizes a mounted amount entry to what's typed (runs on every keystroke), commas included. */
export function layoutAmountEntry(input, unitEl) {
  if (!input) return;
  const display = groupedAmountText(String(input.value || ""));
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

/** One glass capsule of context. A `button` when it opens something. */
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
  busyLabel = "", type = "button",
} = {}) {
  const a = attrName(attr);
  const l = labelAttr ? `data-${attrName(labelAttr)}` : "";
  // Busy is a spinner only (iOS SendActionButton label: ProgressView), unless a screen names a label.
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
export function createSendActionButton(root, { onAction, busyLabel = "" } = {}) {
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
      // Busy: the spinner only (iOS SendActionButton), or a screen's own busy label beside it.
      if (label) {
        if (busy) label.innerHTML = `<span class="sk-spinner" aria-hidden="true"></span>${busyLabel ? esc(busyLabel) : ""}`;
        else label.textContent = title;
      }
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

// --- From (which of your addresses a send comes out of) ------------------------------------------
// iOS 6333dd3 SendFromSection / OwnAddressPicker / SelectablePill: every send starts with From -
// Chatting Address (the default) or Choose an Address (any address of the account, chatting first,
// each Used / Unused, with its balance) - so it is always plain which address the Kaspa leaves.
// Request Payment's Fresh Address / Choose an Address uses the same pills and picker.

/** A pill to pick one of a few choices, like the amount's currency switch: the chosen one filled
 *  in (iOS SelectablePill). `attr` names its data attribute, `value` is what it carries. */
export function selectablePillHtml({ attr, value = "", title, selected = false } = {}) {
  return `<button type="button" class="sk-select-pill${selected ? " selected" : ""}" data-${attrName(attr)}="${esc(value)}" aria-pressed="${selected ? "true" : "false"}">${esc(title)}</button>`;
}

/** Fills in the pill of `attr` whose value is `value` (null fills none). */
export function setSelectedPill(root, attr, value) {
  root?.querySelectorAll(`[data-${attrName(attr)}]`).forEach((pill) => {
    const on = value != null && pill.getAttribute(`data-${attrName(attr)}`) === String(value);
    pill.classList.toggle("selected", on);
    pill.setAttribute("aria-pressed", on ? "true" : "false");
  });
}

/** The From section (iOS SendFromSection): "FROM", the Chatting Address / Choose an Address pills,
 *  and the chosen address with its balance. Wired by `sendFromControls`. */
export function sendFromSectionHtml({ prefix }) {
  const p = attrName(prefix);
  return `
    <div class="sk-from" data-${p}-from>
      <span class="sk-from-label">From</span>
      <div class="sk-select-pills">
        ${selectablePillHtml({ attr: `${p}-from-choice`, value: "chatting", title: "Chatting Address", selected: true })}
        ${selectablePillHtml({ attr: `${p}-from-choice`, value: "choose", title: "Choose an Address" })}
      </div>
      <div class="sk-from-card">
        <span class="sk-from-copy">
          <span class="sk-from-title" data-${p}-from-title>Chatting Address</span>
          <code class="sk-from-address" data-${p}-from-address></code>
        </span>
        <span class="sk-from-balance" data-${p}-from-balance><span class="sk-spinner" aria-hidden="true"></span></span>
      </div>
    </div>`;
}

/**
 * Wires a From section. `onChatting()` runs for the Chatting Address pill, `onChoose()` for Choose
 * an Address (the screen opens `openOwnAddressPicker`). `render({ chatting, title, address,
 * balanceText })` shows the source (balanceText null = still loading); `setDisabled` locks the
 * pills while a send is on its way.
 */
export function sendFromControls(root, prefix, { onChatting, onChoose } = {}) {
  const p = attrName(prefix);
  const section = root?.querySelector(`[data-${p}-from]`);
  let disabled = false;
  section?.addEventListener("click", (event) => {
    const pill = event.target.closest(`[data-${p}-from-choice]`);
    if (!pill || disabled) return;
    if (pill.getAttribute(`data-${p}-from-choice`) === "chatting") onChatting?.();
    else onChoose?.();
  });
  return {
    render({ chatting = true, title = "Chatting Address", address = "", balanceText = null } = {}) {
      if (!section) return;
      setSelectedPill(section, `${p}-from-choice`, chatting ? "chatting" : "choose");
      const titleEl = section.querySelector(`[data-${p}-from-title]`);
      if (titleEl) titleEl.textContent = title;
      const addressEl = section.querySelector(`[data-${p}-from-address]`);
      if (addressEl) { addressEl.textContent = shortSendAddress(address); addressEl.title = address || ""; }
      const balanceEl = section.querySelector(`[data-${p}-from-balance]`);
      if (balanceEl) {
        balanceEl.innerHTML = balanceText == null ? '<span class="sk-spinner" aria-hidden="true"></span>' : esc(balanceText);
      }
    },
    setDisabled(value) {
      disabled = Boolean(value);
      section?.querySelectorAll(`[data-${p}-from-choice]`).forEach((pill) => { pill.disabled = disabled; });
    },
    /** Opened from one address's own page (its history's Send): that address only, so the pills
     *  are not offered (iOS 7a8102b SendFromSection isLocked). */
    setLocked(value) {
      const pills = section?.querySelector(".sk-select-pills");
      if (pills) pills.hidden = Boolean(value);
    },
  };
}

/** The Used / Unused / Checking tag (iOS OwnAddressPicker.usedTag): "Checking" until a lookup has
 *  answered, never a possibly-wrong "Unused". */
export function usedTagHtml(used) {
  if (used === true) return '<span class="sk-used-tag used">Used</span>';
  if (used === false) return '<span class="sk-used-tag unused">Unused</span>';
  return '<span class="sk-used-tag checking">Checking</span>';
}

let activeOwnAddressPicker = null;

/**
 * Your addresses to pick from (iOS OwnAddressPicker): the chatting address, then the spending
 * addresses (the ones Manage Addresses shows, plus hidden ones holding Kaspa, in number order),
 * each with its name, balance and whether it was ever used - a balance means used, else
 * `cachedUsed(address)` (true / false / null), else `probeUsed(address)` (a history lookup, eight
 * at a time). A send's Choose an Address ("Send From") and Request Payment's.
 *
 * `loadEntries()` resolves to { chatting: { address, balanceSompi }, spending: [{ index, address,
 * label, balanceSompi, hidden }] }. Picking a row calls `onPick({ kind: "chatting", address })` or
 * `onPick({ kind: "spending", index, address, label })` and closes; Cancel, Escape or the backdrop
 * leave things as they were.
 *
 * `excludeQuantum`: leave the quantum-safe (KIP-22) addresses out - the .kachat market signs its
 * funding inputs as plain P2PK, which a quantum-safe address can't be (iOS bba1b1e OwnAddressPicker).
 */
export function openOwnAddressPicker({ title = "Choose an Address", selectedAddress = null, loadEntries, cachedUsed, probeUsed, kasUnit = "KAS", onPick, excludeQuantum = false } = {}) {
  closeOwnAddressPicker();
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop sk-source-backdrop";
  backdrop.dataset.skSourcePicker = "";
  backdrop.innerHTML = `
    <section class="contact-modal sk-source-sheet" role="dialog" aria-modal="true" aria-labelledby="sk-source-title">
      <div class="modal-header">
        <div><h2 id="sk-source-title">${esc(title)}</h2></div>
        <button class="modal-close" type="button" data-sk-source-cancel aria-label="Cancel">×</button>
      </div>
      <div class="sk-source-list" data-sk-source-list role="listbox" aria-label="Your addresses">
        <p class="sk-source-empty"><span class="sk-spinner" aria-hidden="true"></span>Loading addresses…</p>
      </div>
      <div class="modal-actions">
        <button class="secondary-button" type="button" data-sk-source-cancel>Cancel</button>
      </div>
    </section>`;
  const list = backdrop.querySelector("[data-sk-source-list]");
  let rows = [];
  const used = new Map();

  const onKey = (event) => {
    if (event.key !== "Escape") return;
    // Only the picker closes, not the screen under it.
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();
    close();
  };
  const close = () => {
    window.removeEventListener("keydown", onKey, true);
    backdrop.remove();
    if (activeOwnAddressPicker === close) activeOwnAddressPicker = null;
  };
  activeOwnAddressPicker = close;
  window.addEventListener("keydown", onKey, true);

  backdrop.addEventListener("mousedown", (event) => { if (event.target === backdrop) close(); });
  backdrop.addEventListener("click", (event) => {
    if (event.target.closest("[data-sk-source-cancel]")) { close(); return; }
    const row = event.target.closest("[data-sk-source-key]");
    if (!row) return;
    const picked = rows.find((r) => r.key === row.getAttribute("data-sk-source-key"));
    close();
    if (picked) { try { onPick?.(picked.source); } catch { /* the screen reports its own errors */ } }
  });
  document.body.appendChild(backdrop);

  const rowHtml = (r) => {
    const funded = BigInt(r.balanceSompi || 0) > 0n;
    const current = selectedAddress != null && r.address === selectedAddress;
    return `
      <button type="button" class="sk-source-row${current ? " current" : ""}" role="option" aria-selected="${current ? "true" : "false"}" data-sk-source-key="${esc(r.key)}">
        <span class="sk-source-copy">
          <span class="sk-source-name">${esc(r.title)}<span data-sk-used="${esc(r.key)}">${usedTagHtml(used.get(r.address))}</span></span>
          <code class="sk-source-address">${esc(shortSendAddress(r.address))}</code>
        </span>
        <span class="sk-source-balance${funded ? "" : " empty"}">${esc(formatSompiPlain(r.balanceSompi || 0))} ${esc(kasUnit)}</span>
        <span class="sk-source-check" aria-hidden="true">${current ? SEND_ICONS.check : ""}</span>
      </button>`;
  };
  const paintUsed = (r) => {
    const slot = list.querySelector(`[data-sk-used="${CSS.escape(r.key)}"]`);
    if (slot) slot.innerHTML = usedTagHtml(used.get(r.address));
  };

  Promise.resolve()
    .then(() => loadEntries?.())
    .then(async (loaded) => {
      if (!backdrop.isConnected) return;
      const chatting = loaded?.chatting?.address ? [{
        key: "chatting", title: "Chatting Address", address: loaded.chatting.address,
        balanceSompi: loaded.chatting.balanceSompi || 0, source: { kind: "chatting", address: loaded.chatting.address },
      }] : [];
      const spending = (loaded?.spending || [])
        .filter((e) => !e.hidden || BigInt(e.balanceSompi || 0) > 0n)
        .filter((e) => !excludeQuantum || !isQuantumIndex(e.index))
        .sort((a, b) => a.index - b.index)
        .map((e) => ({
          key: `spending-${e.index}`, title: e.label || spendingIndexTitle(e.index), address: e.address,
          balanceSompi: e.balanceSompi || 0, source: { kind: "spending", index: e.index, address: e.address, label: e.label || spendingIndexTitle(e.index) },
        }));
      rows = [...chatting, ...spending];
      // Used: a balance means used, else the cached answer; the rest are looked up below.
      const toProbe = [];
      for (const r of rows) {
        if (BigInt(r.balanceSompi || 0) > 0n) { used.set(r.address, true); continue; }
        const cached = cachedUsed?.(r.address);
        if (cached === true || cached === false) used.set(r.address, cached);
        else toProbe.push(r);
      }
      list.innerHTML = `
        ${chatting.length ? `<p class="sk-source-section">Chatting Address</p>${chatting.map(rowHtml).join("")}` : ""}
        <p class="sk-source-section">Spending Addresses</p>
        ${spending.length ? spending.map(rowHtml).join("") : '<p class="sk-source-empty">No spending addresses yet.</p>'}`;
      list.querySelector(".sk-source-row.current")?.focus?.();
      // A few at a time, like Manage Addresses (a burst gets rate-limited).
      let next = 0;
      const worker = async () => {
        while (next < toProbe.length && backdrop.isConnected) {
          const r = toProbe[next++];
          let answer = null;
          try { answer = await probeUsed?.(r.address); } catch { answer = null; }
          if (!backdrop.isConnected) return;
          if (answer === true || answer === false) { used.set(r.address, answer); paintUsed(r); }
        }
      };
      await Promise.all(Array.from({ length: Math.min(8, toProbe.length) }, worker));
    })
    .catch((error) => {
      if (!backdrop.isConnected) return;
      list.innerHTML = `<p class="sk-source-empty bad">${esc(error?.message || "Couldn't load your addresses.")}</p>`;
    });
  return close;
}

export function closeOwnAddressPicker() {
  if (activeOwnAddressPicker) activeOwnAddressPicker();
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
 * paying, in the order the node lists them, each one tickable, with Select All / Automatic (Clear Selection) and the
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
      // A spinner only (iOS CoinControlView: ProgressView).
      body.innerHTML = '<p class="sk-source-empty"><span class="sk-spinner" aria-hidden="true"></span></p>';
      return;
    }
    if (!entries.length) {
      // iOS UtxoLoadFailureRow: an outage never reads as an empty address.
      body.innerHTML = loadError
        ? `<div class="sk-coin-failure">
            <p class="sk-coin-failure-title"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5 2.5 20h19L12 3.5Z"/><path d="M12 10v4.5M12 17.2v.3"/></svg>Couldn't load the coins at this address</p>
            <p class="sk-coin-failure-detail">${esc(loadError)}</p>
            <button type="button" class="cold-inline-link" data-sk-coin-retry>Try Again</button>
          </div>`
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
              <span class="cold-coincontrol-amount">${esc(fixedKas8(utxoEntrySompi(entry)))} ${esc(kasUnit)}</span>
              <span class="cold-coincontrol-outpoint">${esc(txid.slice(0, 10))}...:${esc(index)}</span>
            </span>
          </button>`;
        }).join("")}
      </div>
      ${selected.size ? `<p class="field-hint cold-coincontrol-total">Selected: ${esc(fixedKas8(total))} ${esc(kasUnit)} (${selected.size} UTXO${selected.size === 1 ? "" : "s"})</p>` : ""}`;
  }

  function load() {
    loading = true;
    loadError = "";
    paint();
    Promise.resolve()
      .then(() => loadEntries?.())
      .then((loaded) => {
        if (!backdrop.isConnected) return;
        // In the order the node lists them (iOS CoinControlView).
        entries = [...(loaded || [])];
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

// --- Sent confirmation (every successful send ends here) ----------------------------------------

let activeSentSheet = null;

/** A line that shortens in the middle when it doesn't fit: both ends of a txid or an address
 *  identify it, the middle doesn't (iOS `.truncationMode(.middle)`). */
function middleTruncatedHtml(text, tail = 10) {
  const value = String(text || "");
  if (value.length <= tail * 2) return `<span class="sk-mid-tail">${esc(value)}</span>`;
  return `<span class="sk-mid-head">${esc(value.slice(0, -tail))}</span><span class="sk-mid-tail">${esc(value.slice(-tail))}</span>`;
}

/**
 * The sheet every successful Kaspa send finishes on (iOS ActionSheet.swift SentConfirmationSheet):
 * a check, "Sent", the amount ("1.5 KAS", trailing zeros trimmed), "to <domain or address>", the
 * txid as a link to the explorer, and Done. Send Kaspa, KaPosts tips and Send Domain all use it.
 * `amountSompi` null leaves the amount line out, `recipient` empty the "to" line. `explorerUrl`
 * is the txid's explorer page (null shows the id as plain text). Done, Escape or the backdrop
 * close it and call `onDone`.
 */
export function openSentConfirmation({ txid, amountSompi = null, recipient = null, explorerUrl = null, kasUnit = "KAS", onDone } = {}) {
  closeSentConfirmation();
  const id = String(txid || "").trim();
  const amountLine = amountSompi == null ? "" : `${formatSompiPlain(amountSompi)} ${kasUnit}`;
  const to = String(recipient || "").trim();
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop sk-sent-backdrop";
  backdrop.dataset.skSentSheet = "";
  backdrop.innerHTML = `
    <section class="contact-modal sk-sent-sheet" role="dialog" aria-modal="true" aria-labelledby="sk-sent-title">
      <span class="sk-sent-check" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m6.5 12.5 3.6 3.6L17.5 8.5"/></svg></span>
      <h2 class="sk-sent-title" id="sk-sent-title">Sent</h2>
      ${amountLine ? `<p class="sk-sent-amount">${esc(amountLine)}</p>` : ""}
      ${to ? `<p class="sk-sent-to" title="${esc(to)}"><span class="sk-sent-to-word">to&nbsp;</span>${middleTruncatedHtml(to, 8)}</p>` : ""}
      ${id && explorerUrl
        ? `<a class="sk-sent-txid" href="${esc(explorerUrl)}" target="_blank" rel="noopener noreferrer" title="${esc(id)}">
             <span class="sk-sent-txid-text">${middleTruncatedHtml(id, 12)}</span>
             <svg class="sk-sent-open" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v4.5A1.5 1.5 0 0 1 16.5 20h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10"/></svg>
           </a>`
        : (id ? `<p class="sk-sent-txid plain" title="${esc(id)}"><span class="sk-sent-txid-text">${middleTruncatedHtml(id, 12)}</span></p>` : "")}
      <p class="sk-sent-hint">Click the transaction to open it in the explorer.</p>
      <button class="primary-button full sk-sent-done" type="button" data-sk-sent-done>Done</button>
    </section>`;
  let done = false;
  const onKey = (event) => {
    if (event.key !== "Escape") return;
    // Only this sheet closes, not the screen under it.
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();
    close();
  };
  const close = () => {
    window.removeEventListener("keydown", onKey, true);
    backdrop.remove();
    if (activeSentSheet === close) activeSentSheet = null;
    if (done) return;
    done = true;
    try { onDone?.(); } catch { /* the screen tidies up on its own */ }
  };
  activeSentSheet = close;
  window.addEventListener("keydown", onKey, true);
  backdrop.addEventListener("mousedown", (event) => { if (event.target === backdrop) close(); });
  backdrop.addEventListener("click", (event) => { if (event.target.closest("[data-sk-sent-done]")) close(); });
  document.body.appendChild(backdrop);
  backdrop.querySelector("[data-sk-sent-done]")?.focus?.();
  return close;
}

export function closeSentConfirmation() {
  if (activeSentSheet) activeSentSheet();
}

// --- Swipe up to send (iOS 59593af / 7abc06e8 SwipeUpToSendScrollView) --------------------------
// The send screens' bottom bar: press "Swipe up to Send" and drag it up. The whole screen rises
// with the finger and the sending screen comes up from below in its place. Let go past halfway and
// it sends: the sending screen takes the whole sheet, a BlockDAG runs across it while the
// transaction goes out, then it shows Sent (or the screen's own outcome) with Done, or Failed with
// the screen's error and Try Again, which brings the form back as it was. Let go sooner and it
// springs back. Only the bar answers, so scrolling the form never sends. A keyboard press or a
// screen reader's activation is the plain action (iOS accessibilityAction).

/** The words a swipe-up screen uses (iOS SwipeUpLabels): a Kaspa send, a .kachat buy or claim. */
export const SWIPE_UP_LABELS = {
  send: {
    release: "Release to Send", working: "Sending", workingDetail: "Broadcasting to the Kaspa BlockDAG...",
    done: "Sent", hint: "Let go past halfway to send.", recipientWord: "to", failedFallback: "The send didn't go out.",
  },
  buy: {
    release: "Release to Buy", working: "Buying", workingDetail: "Sending the purchase to the Kaspa BlockDAG...",
    done: "Name Bought", hint: "Let go past halfway to buy.", recipientWord: "for", failedFallback: "The purchase didn't go out.",
  },
  claim: {
    release: "Release to Claim", working: "Claiming", workingDetail: "Committing to the Kaspa BlockDAG...",
    done: "Claim Started", hint: "Let go past halfway to claim.", recipientWord: "for", failedFallback: "The claim didn't start.",
  },
};
/** A send whose device check (Face ID / the password) was turned down (iOS KachatNamesLiveViews). */
export const NOT_CONFIRMED_ON_DEVICE = "Not confirmed on this device, so nothing was sent.";

const SWIPE_BAR_ICONS = {
  up: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 15 6-6 6 6"/></svg>',
  check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5.5 12.5 4.2 4.2 8.8-9.2"/></svg>',
};
const SWIPE_MARKS = {
  done: '<svg viewBox="0 0 72 72" aria-hidden="true"><circle cx="36" cy="36" r="34" class="sk-swipe-mark-fill"/><path d="m22 37 9.5 9.5L51 27" class="sk-swipe-mark-ink"/></svg>',
  failed: '<svg viewBox="0 0 72 72" aria-hidden="true"><circle cx="36" cy="36" r="34" class="sk-swipe-mark-fill"/><path d="M25 25l22 22M47 25 25 47" class="sk-swipe-mark-ink"/></svg>',
};
const SWIPE_OPEN_ICON = '<svg class="sk-sent-open" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v4.5A1.5 1.5 0 0 1 16.5 20h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10"/></svg>';
const SWIPE_FAIL_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5 2.5 20h19L12 3.5Z"/><path d="M12 10v4.5M12 17.2v.1"/></svg>';
/** iOS settle: spring(response 0.45, damping 0.86). */
const SWIPE_SETTLE_MS = 450;

/**
 * Turns a sheet (`card`, a `.contact-modal`) into a swipe-up send screen. Its `.modal-header` is
 * replaced by the screen's own header - a Cancel capsule and the title - which moves up with the
 * rest of the form (iOS draws it in place of the navigation bar); everything else in the card
 * becomes the scrolling form, with the bar pinned under it.
 *
 * The screen drives it like iOS's bindings: `setBusy(true)` once the send really started,
 * `setSent({ txid, amountSompi, recipient, explorerUrl })` when it went out, or `setSucceeded(html)`
 * for an action that ends without one transaction (a claim; `html` is shown under the title; a send
 * can carry one too, `setSent(sent, html)`, and `setOutcome(html)` updates it), and
 * `setBusy(false)` without either is a failure, shown with `getFailureMessage()` (the screen's
 * error line) or the labels' fallback. `onAction` starts the send; `getPreview()` says what is being
 * sent ({ amountSompi, recipient }) for the rising screen. `reset()` puts the form back at once, for
 * a screen opened again.
 */
export function createSwipeUpScreen(card, {
  screenTitle = "Send Kaspa", barTitle = "Swipe up to Send", labels = SWIPE_UP_LABELS.send, kasUnit = "KAS",
  getPreview, getFailureMessage, onCancel, onDone, onAction,
} = {}) {
  const noop = { setBusy() {}, setEnabled() {}, setSent() {}, setOutcome() {}, setSucceeded() {}, setScreenTitle() {}, setBarTitle() {}, setLabels() {}, setKasUnit() {}, reset() {}, get sending() { return false; } };
  if (!card) return noop;
  card.querySelector(":scope > .modal-header")?.remove();
  card.classList.add("sk-swipe-host");
  const form = document.createElement("div");
  form.className = "sk-swipe-form";
  form.innerHTML = `
    <div class="sk-swipe-header"><div class="sk-swipe-header-row">
      <button type="button" class="sk-swipe-cancel" data-sk-swipe-cancel>Cancel</button>
      <h2 class="sk-swipe-title" data-sk-swipe-title></h2>
    </div></div>
    <div class="sk-swipe-scroll" data-sk-swipe-scroll></div>
    <div class="sk-swipe-barwrap">
      <button type="button" class="sk-swipe-bar" data-sk-swipe-bar>
        <span class="sk-swipe-bar-icon" data-sk-swipe-bar-icon></span>
        <span class="sk-swipe-bar-text" data-sk-swipe-bar-text></span>
      </button>
    </div>`;
  const scroll = form.querySelector("[data-sk-swipe-scroll]");
  while (card.firstChild) scroll.appendChild(card.firstChild);
  const progress = document.createElement("div");
  progress.className = "sk-swipe-progress";
  progress.hidden = true;
  progress.innerHTML = `
    <div class="sk-swipe-dag"><canvas data-sk-swipe-dag></canvas><span class="sk-swipe-mark" data-sk-swipe-mark></span></div>
    <div class="sk-swipe-lines">
      <h3 class="sk-swipe-big" data-sk-swipe-big></h3>
      <p class="sk-swipe-amount" data-sk-swipe-amount hidden></p>
      <p class="sk-swipe-to" data-sk-swipe-to hidden></p>
      <p class="sk-swipe-detail" data-sk-swipe-detail hidden></p>
    </div>
    <div class="sk-swipe-failure" data-sk-swipe-failure hidden>${SWIPE_FAIL_ICON}<span data-sk-swipe-failure-text></span></div>
    <div class="sk-swipe-tx" data-sk-swipe-tx hidden></div>
    <div class="sk-swipe-outcome" data-sk-swipe-outcome hidden></div>
    <div class="sk-swipe-spacer"></div>
    <button type="button" class="sk-swipe-final" data-sk-swipe-final hidden></button>`;
  card.append(form, progress);

  const q = (root, attr) => root.querySelector(`[data-${attr}]`);
  const titleEl = q(form, "sk-swipe-title");
  const bar = q(form, "sk-swipe-bar");
  const barIcon = q(form, "sk-swipe-bar-icon");
  const barText = q(form, "sk-swipe-bar-text");
  const canvas = q(progress, "sk-swipe-dag");
  const els = {
    mark: q(progress, "sk-swipe-mark"), big: q(progress, "sk-swipe-big"), amount: q(progress, "sk-swipe-amount"),
    to: q(progress, "sk-swipe-to"), detail: q(progress, "sk-swipe-detail"), failure: q(progress, "sk-swipe-failure"),
    failureText: q(progress, "sk-swipe-failure-text"), tx: q(progress, "sk-swipe-tx"), outcome: q(progress, "sk-swipe-outcome"),
    final: q(progress, "sk-swipe-final"),
  };

  let title = barTitle;
  let words = labels;
  let unit = kasUnit;
  let enabled = false;
  let busy = false;
  // iOS state: how far the screen is pushed up, past halfway (armed), form / sending, the DAG's
  // moment on screen, whether the send really started, and how it ended.
  let lift = 0;
  let armed = false;
  let phase = "form";
  let dagShown = false;
  let sendStarted = false;
  let confirmed = false;
  let failed = false;
  let sent = null;
  let succeeded = false;
  let outcomeHtml = "";
  let preview = {};
  let dragging = false;
  let pointerId = null;
  let startY = 0;
  const timers = new Set();
  const later = (ms, fn) => { const t = setTimeout(() => { timers.delete(t); fn(); }, ms); timers.add(t); };
  const clearTimers = () => { for (const t of timers) clearTimeout(t); timers.clear(); };
  const active = () => enabled && !busy;
  const height = () => card.clientHeight || window.innerHeight;
  const threshold = () => Math.max(160, height() * 0.5);
  const finished = () => (dagShown && (sent || succeeded)) || (failed && dagShown);
  const failureText = () => (failed && dagShown ? (String(getFailureMessage?.() || "").trim() || words.failedFallback) : null);
  const dag = blockDagAnimation(canvas);

  function paintBar() {
    barIcon.innerHTML = armed ? SWIPE_BAR_ICONS.check : SWIPE_BAR_ICONS.up;
    barText.textContent = armed ? words.release : title;
    bar.setAttribute("aria-label", title);
    bar.setAttribute("aria-disabled", enabled ? "false" : "true");
    bar.classList.toggle("disabled", !enabled);
  }
  function place(animate) {
    card.classList.toggle("sk-swipe-animating", Boolean(animate));
    const h = height();
    form.style.transform = lift ? `translateY(${-lift}px)` : "";
    progress.style.transform = `translateY(${Math.max(0, h - lift)}px)`;
    card.classList.toggle("sk-swipe-sending", phase === "sending");
    const showing = () => lift > 0 || phase === "sending";
    if (showing()) { progress.hidden = false; dag.start(); }
    // Springing back: the sending screen slides down out of sight before it goes.
    else if (animate) later(SWIPE_SETTLE_MS, () => { if (!showing()) { progress.hidden = true; dag.stop(); } });
    else { progress.hidden = true; dag.stop(); }
  }
  function paintProgress() {
    const done = dagShown && Boolean(sent || succeeded);
    const failure = failureText();
    const sending = phase === "sending";
    dag.setHighlight(sending && !failure);
    dag.setDimmed(Boolean(done || failure));
    els.mark.innerHTML = done ? SWIPE_MARKS.done : (failure ? SWIPE_MARKS.failed : "");
    els.mark.className = `sk-swipe-mark${done ? " done" : failure ? " failed" : ""}`;
    els.big.textContent = done ? words.done : failure ? "Failed" : (sending ? words.working : (armed ? words.release : "Keep Swiping"));
    const amount = sent?.amountSompi ?? preview.amountSompi;
    els.amount.hidden = amount == null;
    if (amount != null) els.amount.textContent = `${formatSompiPlain(amount)} ${unit}`;
    const to = String(sent?.recipient ?? preview.recipient ?? "").trim();
    els.to.hidden = !to;
    if (to) { els.to.title = to; els.to.innerHTML = `<span class="sk-sent-to-word">${esc(words.recipientWord)}&nbsp;</span>${middleTruncatedHtml(to, 8)}`; }
    const showDetail = !(done || failure);
    els.detail.hidden = !showDetail;
    if (showDetail) els.detail.textContent = sending ? words.workingDetail : words.hint;
    els.failure.hidden = !failure;
    if (failure) els.failureText.textContent = failure;
    const id = done && sent ? String(sent.txid || "").trim() : "";
    els.tx.hidden = !id;
    if (id) {
      const touch = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
      els.tx.innerHTML = sent.explorerUrl
        ? `<a class="sk-sent-txid sk-swipe-txid" href="${esc(sent.explorerUrl)}" target="_blank" rel="noopener noreferrer" title="${esc(id)}"><span class="sk-sent-txid-text">${middleTruncatedHtml(id, 12)}</span>${SWIPE_OPEN_ICON}</a>
           <p class="sk-swipe-tx-hint">${touch ? "Tap" : "Click"} the transaction to open it in the explorer.</p>`
        : `<p class="sk-sent-txid plain" title="${esc(id)}"><span class="sk-sent-txid-text">${middleTruncatedHtml(id, 12)}</span></p>`;
    }
    const showOutcome = done && Boolean(outcomeHtml);
    els.outcome.hidden = !showOutcome;
    if (showOutcome && els.outcome.dataset.html !== outcomeHtml) { els.outcome.innerHTML = outcomeHtml; els.outcome.dataset.html = outcomeHtml; }
    els.final.hidden = !(done || failure);
    els.final.textContent = done ? "Done" : "Try Again";
    els.final.dataset.kind = done ? "done" : "retry";
    progress.classList.toggle("finished", Boolean(finished()));
  }
  function paint(animate = false) { paintBar(); place(animate); paintProgress(); }

  function startSending() {
    armed = false;
    dagShown = false;
    sendStarted = busy;
    confirmed = false;
    failed = false;
    sent = null;
    succeeded = false;
    outcomeHtml = "";
    preview = getPreview?.() || preview;
    phase = "sending";
    lift = height() * 2;
    paint(true);
    try { onAction?.(); } catch { /* the screen reports its own errors */ }
    later(1800, () => { dagShown = true; paintProgress(); });
    // A send that never started (a check failed before it went busy) fails too.
    later(600, () => { if (!sendStarted) showFailure(); });
  }
  function showFailure() {
    if (phase !== "sending" || confirmed || failed) return;
    failed = true;
    paintProgress();
  }
  function returnToForm() {
    if (phase !== "sending" || confirmed) return;
    lift = 0;
    place(true);
    // After the screen is back down, so the sending screen doesn't change on its way out.
    later(SWIPE_SETTLE_MS, () => { phase = "form"; failed = false; paint(false); });
  }
  function springBack() {
    armed = false;
    lift = 0;
    paint(true);
  }

  bar.addEventListener("pointerdown", (event) => {
    if (!active() || phase !== "form") return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.preventDefault();
    dragging = true;
    pointerId = event.pointerId;
    startY = event.clientY;
    preview = getPreview?.() || {};
    try { bar.setPointerCapture(event.pointerId); } catch { /* fine */ }
    dag.restart();
  });
  bar.addEventListener("pointermove", (event) => {
    if (!dragging || event.pointerId !== pointerId) return;
    lift = Math.max(0, startY - event.clientY);
    armed = lift >= threshold();
    paint(false);
  });
  const end = (event, cancelled) => {
    if (!dragging || event.pointerId !== pointerId) return;
    dragging = false;
    pointerId = null;
    if (!cancelled && armed && active() && phase === "form") startSending();
    else springBack();
  };
  bar.addEventListener("pointerup", (event) => end(event, false));
  bar.addEventListener("pointercancel", (event) => end(event, true));
  bar.addEventListener("lostpointercapture", (event) => end(event, true));
  bar.addEventListener("contextmenu", (event) => event.preventDefault());
  bar.addEventListener("click", (event) => {
    // Pointer clicks end a drag the handlers above already judged.
    if (event.detail !== 0 || !active() || phase !== "form") return;
    dag.restart();
    startSending();
  });
  form.querySelector("[data-sk-swipe-cancel]").addEventListener("click", () => { if (phase === "form") onCancel?.(); });
  els.final.addEventListener("click", () => {
    if (els.final.dataset.kind === "done") { try { onDone?.(); } catch { /* the screen tidies up on its own */ } }
    else returnToForm();
  });
  // While it sends, Escape doesn't close the sheet under it (iOS interactiveDismissDisabled).
  window.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || phase !== "sending" || !card.isConnected || !card.offsetParent) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
  window.addEventListener("resize", () => { if (phase === "sending") { lift = height() * 2; place(false); } else if (!dragging && lift) springBack(); });

  const api = {
    setScreenTitle(text) { titleEl.textContent = String(text || ""); },
    setBarTitle(text) { title = String(text || ""); paintBar(); },
    setLabels(next) { words = next || SWIPE_UP_LABELS.send; paintBar(); paintProgress(); },
    setKasUnit(next) { unit = String(next || "KAS"); },
    setEnabled(on) { enabled = Boolean(on); paintBar(); },
    setBusy(on) {
      const was = busy;
      busy = Boolean(on);
      if (busy) { sendStarted = true; return; }
      // The screen says how it went as it stops being busy; give that a moment to land.
      if (was) later(300, () => { if (!confirmed) showFailure(); });
    },
    /** `outcome` (trusted markup) shows under the transaction, like a name's progress steps. */
    setSent(next, outcome = "") {
      if (!next) return;
      sent = next;
      outcomeHtml = String(outcome || "");
      confirmed = true;
      paintProgress();
    },
    /** Replaces the outcome shown once it worked (its progress moved on). */
    setOutcome(html = "") { outcomeHtml = String(html || ""); paintProgress(); },
    setSucceeded(html = "") {
      outcomeHtml = String(html || "");
      succeeded = true;
      confirmed = true;
      paintProgress();
    },
    reset() {
      clearTimers();
      dragging = false;
      pointerId = null;
      armed = false;
      lift = 0;
      phase = "form";
      dagShown = false;
      sendStarted = false;
      confirmed = false;
      failed = false;
      sent = null;
      succeeded = false;
      outcomeHtml = "";
      busy = false;
      scroll.scrollTop = 0;
      paint(false);
    },
    get sending() { return phase === "sending"; },
  };
  api.setScreenTitle(screenTitle);
  paint(false);
  return api;
}

/** A stable pseudo-random number for (column, salt) - iOS BlockDAGAnimationView.hash, the same
 *  64-bit mix, so the picture is the one iOS draws. */
const dagHashCache = new Map();
const DAG_M64 = (1n << 64n) - 1n;
export function blockDagHash(column, salt) {
  const key = `${column}:${salt}`;
  const cached = dagHashCache.get(key);
  if (cached !== undefined) return cached;
  if (dagHashCache.size > 6000) dagHashCache.clear();
  const a = BigInt.asIntN(64, BigInt(column) * 73856093n);
  const b = BigInt.asIntN(64, BigInt(salt) * 19349663n);
  let x = BigInt.asUintN(64, a ^ b);
  x ^= x >> 33n;
  x = (x * 0xff51afd7ed558ccdn) & DAG_M64;
  x ^= x >> 33n;
  const value = Number(x % 1000003n);
  dagHashCache.set(key, value);
  return value;
}
const dagCount = (column) => 1 + (blockDagHash(column, 1) % 3);
/** Block `row` of `column`'s centre height, as a fraction of the view. */
function dagY(column, row) {
  const n = dagCount(column);
  const jitter = ((blockDagHash(column, 10 + row) % 100) / 100) * 0.12 - 0.06;
  return (row + 1) / (n + 1) + jitter;
}
/** The parents of block `row` in `column`: rows of `column - 1` (several parents, not a chain). */
function dagParents(column, row) {
  const previous = dagCount(column - 1);
  const first = blockDagHash(column, 20 + row) % previous;
  const result = [first];
  if (previous > 1 && blockDagHash(column, 30 + row) % 2 === 0) result.push((first + 1) % previous);
  return result;
}

/**
 * Kaspa's BlockDAG drifting right to left on `canvas` (iOS BlockDAGAnimationView): columns 54px
 * apart at 60px/s, 18px blocks each pointing back at one or two blocks of the column before. With
 * the highlight on, the block entering on the right then is the transaction's: filled in the
 * accent with a pulsing glow, and the blocks after it point back at it in the same colour.
 */
function blockDagAnimation(canvas) {
  const SPACING = 54;
  const SPEED = 60;
  const BLOCK = 18;
  let start = performance.now();
  let highlightStart = null;
  let highlight = false;
  let frame = 0;
  let running = false;

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
    else ctx.rect(x, y, w, h);
  }
  function draw(now) {
    frame = 0;
    if (!running || !canvas.isConnected) { running = false; return; }
    const ratio = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const heightPx = canvas.clientHeight;
    if (width && heightPx) {
      if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(heightPx * ratio)) {
        canvas.width = Math.round(width * ratio);
        canvas.height = Math.round(heightPx * ratio);
      }
      const ctx = canvas.getContext("2d");
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.clearRect(0, 0, width, heightPx);
      const style = getComputedStyle(canvas);
      const accent = style.getPropertyValue("--accent").trim() || "#70c7ba";
      const primary = style.color || "#000";
      const elapsed = (now - start) / 1000;
      const scroll = elapsed * SPEED;
      const firstVisible = Math.floor(scroll / SPACING) - 1;
      const visibleColumns = Math.floor(width / SPACING) + 3;
      // The column just off the right edge when the send started is the transaction's.
      const highlightScroll = (((highlightStart ?? start) - start) / 1000) * SPEED;
      const txColumn = Math.floor((highlightScroll + width) / SPACING) + 1;
      const x = (column) => column * SPACING - scroll;
      const point = (column, row) => [x(column), dagY(column, row) * heightPx];
      // Edges first, under the blocks.
      for (let column = firstVisible; column <= firstVisible + visibleColumns; column += 1) {
        for (let row = 0; row < dagCount(column); row += 1) {
          for (const parent of dagParents(column, row)) {
            const lit = highlight && column - 1 === txColumn && parent === 0;
            const [x1, y1] = point(column, row);
            const [x2, y2] = point(column - 1, parent);
            ctx.beginPath();
            ctx.moveTo(x1, y1);
            ctx.lineTo(x2, y2);
            ctx.strokeStyle = lit ? accent : primary;
            ctx.globalAlpha = lit ? 0.8 : 0.28;
            ctx.lineWidth = lit ? 2 : 1;
            ctx.stroke();
          }
        }
      }
      for (let column = firstVisible; column <= firstVisible + visibleColumns; column += 1) {
        for (let row = 0; row < dagCount(column); row += 1) {
          const [cx, cy] = point(column, row);
          const left = cx - BLOCK / 2;
          const top = cy - BLOCK / 2;
          if (highlight && column === txColumn && row === 0) {
            ctx.globalAlpha = 0.25 + 0.2 * Math.sin(elapsed * 4);
            ctx.fillStyle = accent;
            roundRect(ctx, left - 7, top - 7, BLOCK + 14, BLOCK + 14, 9);
            ctx.fill();
            ctx.globalAlpha = 1;
            roundRect(ctx, left, top, BLOCK, BLOCK, 5);
            ctx.fill();
          } else {
            ctx.fillStyle = primary;
            ctx.globalAlpha = 0.16;
            roundRect(ctx, left, top, BLOCK, BLOCK, 5);
            ctx.fill();
            ctx.strokeStyle = primary;
            ctx.globalAlpha = 0.45;
            ctx.lineWidth = 1;
            ctx.stroke();
          }
        }
      }
      ctx.globalAlpha = 1;
    }
    frame = requestAnimationFrame(draw);
  }
  return {
    start() { if (running) return; running = true; frame = requestAnimationFrame(draw); },
    stop() { running = false; if (frame) cancelAnimationFrame(frame); frame = 0; },
    /** The view appearing again (iOS onAppear): the DAG starts over. */
    restart() { start = performance.now(); highlightStart = highlight ? start : null; },
    setHighlight(on) {
      if (Boolean(on) === highlight) return;
      highlight = Boolean(on);
      highlightStart = highlight ? performance.now() : null;
    },
    setDimmed(on) { canvas.classList.toggle("dimmed", Boolean(on)); },
  };
}
