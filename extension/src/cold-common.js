// Shared bits for the Cold Storage tab (cold.js, cold-send.js): the SF Symbols the iOS screens
// use, drawn to match, the iOS formatting helpers, and the half sheet with one text field that
// iOS uses for Enter kpub / Name This Account / Rename Account / Rename UTXO.

import { esc } from "./ui.js";

export const SF = {
  // lock.fill
  lockFill: '<svg width="17" height="17" viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="10.5" width="16" height="11" rx="2.5" fill="currentColor"/><path d="M7.5 10.5V7.5a4.5 4.5 0 0 1 9 0v3" fill="none" stroke="currentColor" stroke-width="2.4"/></svg>',
  // lock.shield (outline, 40 pt on the empty state)
  lockShield: '<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true"><path d="M12 2.5l7.5 2.8v5.9c0 4.8-3.2 8.9-7.5 10.4-4.3-1.5-7.5-5.6-7.5-10.4V5.3L12 2.5z"/><rect x="9" y="11" width="6" height="4.8" rx="1"/><path d="M10.3 11V9.6a1.7 1.7 0 0 1 3.4 0V11"/></svg>',
  // doc.on.clipboard
  docOnClipboard: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8.5 4.5H6.5a2 2 0 0 0-2 2V19a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V6.5a2 2 0 0 0-2-2h-2"/><rect x="8.5" y="2.8" width="7" height="3.4" rx="1.2"/><path d="M8.5 11h7M8.5 14.5h7M8.5 18h4"/></svg>',
  // qrcode.viewfinder
  viewfinder: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 8V5.5A2.5 2.5 0 0 1 5.5 3H8M16 3h2.5A2.5 2.5 0 0 1 21 5.5V8M21 16v2.5a2.5 2.5 0 0 1-2.5 2.5H16M8 21H5.5A2.5 2.5 0 0 1 3 18.5V16"/><rect x="7" y="7" width="4" height="4" rx=".6"/><rect x="13" y="7" width="4" height="4" rx=".6"/><rect x="7" y="13" width="4" height="4" rx=".6"/><path d="M13 13h1.5v1.5H13zM16 16h1v1h-1z"/></svg>',
  // ellipsis (horizontal, bold)
  ellipsis: '<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="2.1" fill="currentColor"/><circle cx="12" cy="12" r="2.1" fill="currentColor"/><circle cx="19" cy="12" r="2.1" fill="currentColor"/></svg>',
  ellipsisV: '<svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="5" r="2" fill="currentColor"/><circle cx="12" cy="12" r="2" fill="currentColor"/><circle cx="12" cy="19" r="2" fill="currentColor"/></svg>',
  // doc.on.doc
  doc: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><rect x="8" y="8" width="13" height="13" rx="2.5"/><path d="M16 8V5.5A2.5 2.5 0 0 0 13.5 3h-8A2.5 2.5 0 0 0 3 5.5v8A2.5 2.5 0 0 0 5.5 16H8"/></svg>',
  docSmall: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linejoin="round" aria-hidden="true"><rect x="8" y="8" width="13" height="13" rx="2.5"/><path d="M16 8V5.5A2.5 2.5 0 0 0 13.5 3h-8A2.5 2.5 0 0 0 3 5.5v8A2.5 2.5 0 0 0 5.5 16H8"/></svg>',
  qrcode: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM17 17h4v4M21 14v1"/></svg>',
  qrcodeSmall: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM17 17h4v4M21 14v1"/></svg>',
  pencil: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4z"/></svg>',
  pencilSmall: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4z"/></svg>',
  trash: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13"/><path d="M9 7V4h6v3"/></svg>',
  plusCircle: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 7.5v9M7.5 12h9"/></svg>',
  magnifier: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5L21 21"/></svg>',
  checklist: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 6.5l1.8 1.8L8.5 5M3.5 13.5l1.8 1.8 3.2-3.3M11.5 7h9M11.5 14h9M11.5 20h9"/></svg>',
  eyeSlash: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3l18 18"/><path d="M10.6 5.1A10.4 10.4 0 0 1 12 5c6.5 0 10 7 10 7a17.6 17.6 0 0 1-3.2 4.2M6.6 6.6C3.8 8.4 2 12 2 12s3.5 7 10 7c1.9 0 3.5-.6 4.9-1.4"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>',
  globe: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20"/></svg>',
  safari: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M16 8l-2.5 5.5L8 16l2.5-5.5z"/></svg>',
  // chart.pie.fill
  pieFill: '<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><path d="M11 3.1A9 9 0 1 0 20.9 13H11z" fill="currentColor"/><path d="M13.2 2.2V10.8h8.6A8.8 8.8 0 0 0 13.2 2.2z" fill="currentColor"/></svg>',
  arrowUpFill: '<svg width="26" height="26" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="currentColor"/><path d="M12 17V7.5M7.8 11.5L12 7.3l4.2 4.2" fill="none" stroke="var(--bg)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  arrowDownFill: '<svg width="26" height="26" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="currentColor"/><path d="M12 7v9.5M7.8 12.5l4.2 4.2 4.2-4.2" fill="none" stroke="var(--bg)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  // arrow.up.circle.fill on an accent capsule: a black disc with the arrow cut out in the accent.
  sendFill: '<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="currentColor"/><path d="M12 17V7.5M7.8 11.5L12 7.3l4.2 4.2" fill="none" stroke="var(--kaspa)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  upRightSquare: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="4"/><path d="M9.5 14.5l6-6M10 8.5h5.5V14"/></svg>',
  cube: '<svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2l9 5v10l-9 5-9-5V7z" fill="currentColor"/><path d="M3 7l9 5 9-5M12 12v10" fill="none" stroke="var(--bg)" stroke-width="1.4"/></svg>',
  grid: '<svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10.5" fill="currentColor"/><circle cx="9" cy="9" r="2" fill="var(--bg)"/><circle cx="15" cy="9" r="2" fill="var(--bg)"/><circle cx="9" cy="15" r="2" fill="var(--bg)"/><circle cx="15" cy="15" r="2" fill="var(--bg)"/></svg>',
  // arrow.triangle.merge
  merge: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3v4a6 6 0 0 0 6 6 6 6 0 0 1 6 6v2M18 3v4a6 6 0 0 1-3 5.2"/><path d="M3 6l3-3 3 3M15 6l3-3 3 3"/></svg>',
  warning: '<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l10 18H2z" fill="currentColor"/><path d="M12 10v5" stroke="#000" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="18" r="1.1" fill="#000"/></svg>',
  chevronLeft: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>',
  chevronRight: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg>',
  // checkmark.circle.fill / xmark.circle.fill, large (Sent / Something Went Wrong)
  checkCircleBig: '<svg width="48" height="48" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="11" fill="#30d158"/><path d="M7 12.5l3.3 3.3L17 9" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  xCircleBig: '<svg width="56" height="56" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="11" fill="#ff453a"/><path d="M8.5 8.5l7 7M15.5 8.5l-7 7" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/></svg>',
  // AnimatedQRDisplayView's controls
  backwardFrame: '<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><path d="M11.5 6v12L3 12z" fill="currentColor"/><path d="M20.5 6v12L12 12z" fill="currentColor"/><rect x="1.4" y="5.5" width="1.6" height="13" rx=".8" fill="currentColor"/></svg>',
  forwardFrame: '<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><path d="M12.5 6v12L21 12z" fill="currentColor"/><path d="M3.5 6v12L12 12z" fill="currentColor"/><rect x="21" y="5.5" width="1.6" height="13" rx=".8" fill="currentColor"/></svg>',
  pauseFill: '<svg width="26" height="26" viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="4.5" width="4.2" height="15" rx="1.2" fill="currentColor"/><rect x="13.8" y="4.5" width="4.2" height="15" rx="1.2" fill="currentColor"/></svg>',
  playFill: '<svg width="26" height="26" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.5v15l12.5-7.5z" fill="currentColor"/></svg>',
};

/** "Oct 1, 2026 at 3:04 PM" - iOS Date.FormatStyle(date: .abbreviated, time: .shortened). */
export function txDate(ms) {
  const date = new Date(ms);
  const day = date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `${day} at ${time}`;
}

/** iOS feeText: four decimals from 0.001 KAS up, eight below. */
export function feeText(sompi) {
  if (sompi == null) return "";
  const kas = Number(sompi) / 1e8;
  return `Fee ${kas >= 0.001 ? kas.toFixed(4) : kas.toFixed(8)} KAS`;
}

/** iOS PortfolioFormat.kas: grouped, 0-4 decimals. */
export function portfolioKas(sompi) {
  return `${(Number(sompi) / 1e8).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 4 })} KAS`;
}

/** Middle truncation for a one-line monospaced id. */
export function middle(text, keep = 12) {
  const value = String(text || "");
  return value.length > keep * 2 + 1 ? `${value.slice(0, keep)}…${value.slice(-keep)}` : value;
}

/** iOS ColdStorageAddressEntry.shortAddress: first 14 + "..." + last 6. */
export function shortAddress(address) {
  const value = String(address || "");
  return value.length > 20 ? `${value.slice(0, 14)}...${value.slice(-6)}` : value;
}

/**
 * The iOS half sheet with one field (Enter kpub, Name This Account, Rename Account, Rename UTXO):
 * a title, a caption, the field on a glass card, and Cancel + the accent action, which stays
 * dimmed while the field is empty. Tapping outside or Escape dismisses it.
 */
export function fieldSheet({
  title, subtitle = "", placeholder = "", value = "", multiline = false, mono = false,
  confirmLabel = "Save", allowEmpty = false, onConfirm, onCancel = null,
}) {
  document.querySelector(".sheet-backdrop")?.remove();
  const backdrop = document.createElement("div");
  backdrop.className = "sheet-backdrop";
  const fieldAttrs = `class="cold-field ${mono ? "mono" : ""}" placeholder="${esc(placeholder)}" spellcheck="false" autocapitalize="off" autocomplete="off" aria-label="${esc(placeholder || title)}"`;
  backdrop.innerHTML = `
    <form class="sheet cold-field-sheet" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="sheet-grabber"></div>
      <div class="sheet-head"><div class="sheet-title">${esc(title)}</div>${subtitle ? `<div class="muted tiny cold-sheet-sub">${esc(subtitle)}</div>` : ""}</div>
      ${multiline ? `<textarea ${fieldAttrs} rows="4">${esc(value)}</textarea>` : `<input ${fieldAttrs} value="${esc(value)}" />`}
      <div class="cold-sheet-buttons">
        <button type="button" class="cold-sheet-cancel" data-cancel>Cancel</button>
        <button type="submit" class="cold-sheet-confirm">${esc(confirmLabel)}</button>
      </div>
    </form>`;
  const field = backdrop.querySelector(".cold-field");
  const confirm = backdrop.querySelector(".cold-sheet-confirm");
  const refresh = () => { confirm.disabled = !allowEmpty && !field.value.trim(); };
  const close = () => { backdrop.remove(); document.removeEventListener("keydown", onKey); };
  const onKey = (event) => { if (event.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);
  field.addEventListener("input", refresh);
  if (multiline) {
    field.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); backdrop.querySelector("form").requestSubmit(); }
    });
  }
  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop) close();
    else if (event.target.closest("[data-cancel]")) { close(); onCancel?.(); }
  });
  backdrop.querySelector("form").onsubmit = (event) => {
    event.preventDefault();
    const text = field.value.trim();
    if (!allowEmpty && !text) return;
    close();
    onConfirm(text);
  };
  document.body.appendChild(backdrop);
  refresh();
  field.focus();
  if (!multiline) field.select();
  return { close };
}
