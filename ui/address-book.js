// The Address Book screens (iOS AddressBookView, 00767a4 / cda0d99 / 98f3728 / 1be4f6e): Kaspa Hub >
// Address Book (also dockable), the add / edit sheet User Info and the chat-row menu open, and the
// full-screen picker New Chat, New Group and every Send screen use. The data is
// ui/address-book-store.js; this file only draws it. Every value interpolated is escaped.
//
// An entry's picture is the photo you assigned to it, else exactly the avatar that address set on
// its own profile (deps.profileAvatarHtml) - never a photo kept for a chat contact.

import {
  addressBookEntries, addressBookEntry, addressBookIsEmpty, searchAddressBook, addressBookPhoto,
  saveAddressBookEntry, removeAddressBookEntry, normalizeAddressBookAddress,
  addressBookPhotoBytes, removeAllAddressBookPhotos, onAddressBookChange,
  addressBookExportJson, addressBookExportFileName, importAddressBookExport,
  ADDRESS_BOOK_PHOTO_MAX_SIDE, ADDRESS_BOOK_PHOTO_QUALITY,
} from "./address-book-store.js";
import { scanKaspaAddress } from "./qr-scan.js";
import { otherNetworkReason } from "../engine/network.js";
import { onContextGesture } from "./touch.js";
import { saveFile } from "./save-file.js";
import { isNextcloudConnected, uploadToKaChatFolder, downloadNextcloudText, openNextcloudFilePicker } from "./nextcloud.js";
import { otherDomainsHtml, pickOtherDomain, nameNotFoundText } from "./send-kaspa-components.js";

const svg = (body, extra = "") => `<svg viewBox="0 0 24 24" aria-hidden="true"${extra}>${body}</svg>`;
const BOOK_PATH = '<path d="M5 4.5A1.5 1.5 0 0 1 6.5 3H19v15.5H6.5A1.5 1.5 0 0 0 5 20Z"/><path d="M5 20a1.5 1.5 0 0 0 1.5 1.5H19v-3"/>';
/** book.closed / book.closed.fill (stroke glyphs, currentColor). Trusted markup. */
export const ADDRESS_BOOK_ICONS = {
  book: svg(BOOK_PATH),
  bookFill: svg('<path d="M5 4.5A1.5 1.5 0 0 1 6.5 3H19v15.5H6.5A1.5 1.5 0 0 0 5 20Z" style="fill:currentColor"/><path d="M5 20a1.5 1.5 0 0 0 1.5 1.5H19v-3"/>'),
};
const ICONS = {
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  // square.and.arrow.up.on.square
  importExport: svg('<path d="M13 13V3"/><path d="m9.5 6.5 3.5-3.5 3.5 3.5"/><path d="M16.5 9.5H18A1.5 1.5 0 0 1 19.5 11v6.5A1.5 1.5 0 0 1 18 19H8a1.5 1.5 0 0 1-1.5-1.5V11A1.5 1.5 0 0 1 8 9.5h1.5"/><path d="M4 12.5V20a1.5 1.5 0 0 0 1.5 1.5H15"/>'),
  fileIn: svg('<path d="M12 4v10"/><path d="m8 10 4 4 4-4"/><path d="M5 15v3.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V15"/>'),
  fileOut: svg('<path d="M12 15V4"/><path d="m8 8 4-4 4 4"/><path d="M5 12v6.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V12"/>'),
  cloudIn: svg('<path d="M7 18a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 17.8 8.6 4.2 4.2 0 0 1 17.5 17"/><path d="M12 11v9"/><path d="m9 17 3 3 3-3"/>'),
  cloudOut: svg('<path d="M7 18a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 17.8 8.6 4.2 4.2 0 0 1 17.5 17"/><path d="M12 20v-9"/><path d="m9 14 3-3 3 3"/>'),
  back: svg('<path d="m15 5-7 7 7 7"/>'),
  copy: svg('<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8"/>'),
  check: svg('<path d="M20 6 9 17l-5-5"/>'),
  share: svg('<path d="M12 15V4"/><path d="m8 8 4-4 4 4"/><path d="M5 12v6.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V12"/>'),
  plane: svg('<path d="M21 3 3 10.5l7 2.5 2.5 7L21 3Z"/><path d="m10 13 4.5-4.5"/>'),
  bubble: svg('<path d="M4 5h16v11H8l-4 3z"/>'),
  pencil: svg('<path d="M4 20h4L18.5 9.5a2.12 2.12 0 0 0-3-3L5 17v3z"/><path d="M13.5 6.5l3 3"/>'),
  trash: svg('<path d="M3.5 6.5h17"/><path d="M18.5 6.5V19a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2V6.5"/><path d="M8.5 6.5V4.5a1.5 1.5 0 0 1 1.5-1.5h4a1.5 1.5 0 0 1 1.5 1.5v2"/>'),
  photo: svg('<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="8.5" cy="9.5" r="1.5"/><path d="m5 17 4.5-4.5 3.2 3.2 2.3-2.3L19 17"/>'),
  paste: svg('<rect x="8" y="2.5" width="8" height="4" rx="1.2"/><path d="M8 4.5H6.5A1.5 1.5 0 0 0 5 6v13.5A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V6a1.5 1.5 0 0 0-1.5-1.5H16"/>'),
  scan: svg('<path d="M3 8V5.5A2.5 2.5 0 0 1 5.5 3H8M16 3h2.5A2.5 2.5 0 0 1 21 5.5V8M21 16v2.5a2.5 2.5 0 0 1-2.5 2.5H16M8 21H5.5A2.5 2.5 0 0 1 3 18.5V16"/><path d="M7 12h10"/>'),
  warn: svg('<path d="M12 3 2 20h20L12 3zM12 9v5M12 17.5v.5"/>'),
  circle: svg('<circle cx="12" cy="12" r="9"/>'),
  circleCheck: svg('<circle cx="12" cy="12" r="9" style="fill:currentColor"/><path d="m8 12.4 2.6 2.6L16 9.6" style="stroke:var(--panel, #fff)"/>'),
};

let deps = null;
let screenEl = null;
let active = false;
/** null: the list; an address: that entry's detail. */
let detailAddress = null;
let searchText = "";
let copiedTimer = 0;

const esc = (value) => (deps?.escapeHtml ? deps.escapeHtml(String(value ?? "")) : String(value ?? "")
  .replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])));
const short = (address) => (deps?.shortAddress ? deps.shortAddress(address) : String(address || ""));

/** The picture for an address: your assigned photo, else exactly its own profile avatar. */
export function addressBookAvatarHtml(address, className = "chat-avatar", pendingPhoto) {
  const photo = pendingPhoto === undefined ? addressBookPhoto(address) : pendingPhoto;
  if (photo) return `<span class="${esc(className)}"><img src="${esc(photo)}" alt="" /></span>`;
  try {
    if (deps?.profileAvatarHtml && address) return deps.profileAvatarHtml(address, className);
  } catch { /* fall back to the glyph */ }
  return `<span class="${esc(className)} avatar-fallback">${deps?.personGlyphSvg?.() || ""}</span>`;
}

function isOwnAddress(address) {
  const own = normalizeAddressBookAddress(deps?.ownAddress?.() || "");
  return Boolean(own) && own === normalizeAddressBookAddress(address);
}

function changed(kind) {
  try { deps?.onChange?.(kind); } catch { /* the host repaint never breaks a save */ }
}

// ---------------------------------------------------------------------------------------------
// Kaspa Hub > Address Book
// ---------------------------------------------------------------------------------------------

function rowHtml(entry) {
  return `
    <button type="button" class="ab-row" data-ab-open="${esc(entry.address)}">
      ${addressBookAvatarHtml(entry.address, "chat-avatar ab-avatar ab-avatar-38")}
      <span class="ab-row-copy">
        <strong>${esc(entry.name)}</strong>
        <small>${esc(short(entry.address))}</small>
      </span>
    </button>`;
}

function listRowsHtml() {
  const shown = searchAddressBook(searchText);
  if (!shown.length) return `<p class="ab-empty-line">No matches</p>`;
  return shown.map(rowHtml).join("");
}

function emptyStateHtml() {
  return `
    <div class="ab-empty">
      <span class="ab-empty-icon">${ADDRESS_BOOK_ICONS.book}</span>
      <strong>No saved addresses</strong>
      <p>Save the Kaspa addresses you use with a name you'll recognize. They stay in KaChat, for this wallet only, and never go into your phone's Contacts.</p>
      <button type="button" class="primary-button ab-empty-add" data-ab-add>${ICONS.plus}<span>Add Address</span></button>
    </div>`;
}

function listHtml() {
  const empty = addressBookIsEmpty();
  return `
    <div class="kaposts-header ab-header">
      <h1 class="kaposts-title">Address Book</h1>
      <div class="kaposts-header-actions">
        <button class="kaposts-icon-button" type="button" data-ab-import-export aria-label="Import or export" title="Import or export">${ICONS.importExport}</button>
        <button class="kaposts-icon-button" type="button" data-ab-add aria-label="Add Address" title="Add Address">${ICONS.plus}</button>
      </div>
    </div>
    ${empty ? emptyStateHtml() : `
      <div class="ab-body">
        <input class="ab-search" type="search" data-ab-search placeholder="Search names and addresses" autocomplete="off" spellcheck="false" value="${esc(searchText)}" aria-label="Search names and addresses" />
        <div class="ab-list" data-ab-list>${listRowsHtml()}</div>
      </div>`}`;
}

function actionRow({ attr, icon, label, danger = false, disabled = false }) {
  return `<button type="button" class="ab-action${danger ? " danger" : ""}" ${attr}${disabled ? " disabled" : ""}>
    <span class="ab-action-icon">${icon}</span><span class="ab-action-label">${esc(label)}</span></button>`;
}

function detailHtml(address) {
  const entry = addressBookEntry(address);
  const header = `
    <div class="kaposts-header ab-header">
      <button class="kaposts-icon-button ab-back" type="button" data-ab-back aria-label="Address Book" title="Address Book">${ICONS.back}</button>
      <h1 class="kaposts-title ab-detail-title">${esc(entry?.name || "")}</h1>
      <span class="ab-header-spacer" aria-hidden="true"></span>
    </div>`;
  if (!entry) {
    // Deleted (here or by a backup restore) while open.
    return `${header}<p class="ab-empty-line ab-gone">Not in your Address Book</p>`;
  }
  const canSend = Boolean(deps?.canSend?.());
  // The other network's address (saved before IOS-063, or restored from a backup) can't be paid or
  // messaged here; iOS turns both off and says why.
  const otherNetwork = entry ? otherNetworkReason(entry.address) : null;
  return `${header}
    <div class="ab-body">
      <div class="ab-card ab-hero">
        ${addressBookAvatarHtml(entry.address, "chat-avatar ab-avatar ab-avatar-76")}
        <strong class="ab-hero-name">${esc(entry.name)}</strong>
        ${entry.note ? `<p class="ab-hero-note">${esc(entry.note)}</p>` : ""}
      </div>
      <p class="ab-section-title">Address</p>
      <div class="ab-card">
        <p class="ab-address-mono">${esc(entry.address)}</p>
        ${actionRow({ attr: "data-ab-copy", icon: ICONS.copy, label: "Copy Address" })}
        ${actionRow({ attr: "data-ab-share", icon: ICONS.share, label: "Share Address" })}
      </div>
      <div class="ab-card">
        ${actionRow({ attr: "data-ab-send", icon: ICONS.plane, label: "Send KAS", disabled: !canSend || Boolean(otherNetwork) })}
        ${isOwnAddress(entry.address) ? "" : actionRow({ attr: "data-ab-message", icon: ICONS.bubble, label: "Message", disabled: Boolean(otherNetwork) })}
      </div>
      ${otherNetwork ? `<p class="ab-section-foot">${esc(otherNetwork)}</p>` : ""}
      <div class="ab-card">
        ${actionRow({ attr: "data-ab-edit", icon: ICONS.pencil, label: "Edit" })}
        ${actionRow({ attr: "data-ab-delete", icon: ICONS.trash, label: "Delete from Address Book", danger: true })}
      </div>
    </div>`;
}

function render() {
  if (!screenEl || !active) return;
  const focusSearch = document.activeElement?.matches?.("[data-ab-search]");
  const scrollTop = screenEl.scrollTop;
  screenEl.innerHTML = detailAddress ? detailHtml(detailAddress) : listHtml();
  screenEl.scrollTop = scrollTop;
  if (focusSearch) {
    const input = screenEl.querySelector("[data-ab-search]");
    if (input) { input.focus(); try { input.setSelectionRange(input.value.length, input.value.length); } catch { /* not a text input */ } }
  }
}

function renderListRowsOnly() {
  const list = screenEl?.querySelector("[data-ab-list]");
  if (list) list.innerHTML = listRowsHtml();
}

async function confirmDelete(entry) {
  if (!entry) return false;
  const ok = await deps?.confirmDialog?.({
    title: `Delete ${entry.name} from your Address Book?`,
    confirmLabel: "Delete",
    destructive: true,
  });
  if (!ok) return false;
  removeAddressBookEntry(entry.address);
  return true;
}

async function shareAddress(address) {
  if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
    try { await navigator.share({ text: address }); return; } catch (error) { if (error?.name === "AbortError") return; }
  }
  try { await deps?.copyText?.(address); deps?.showToast?.("Copied"); } catch { deps?.showToast?.(address); }
}

async function onScreenClick(event) {
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;
  if (target.closest("[data-ab-add]")) { openAddressBookEditor({ address: null }); return; }
  if (target.closest("[data-ab-import-export]")) { openImportExportSheet(); return; }
  const open = target.closest("[data-ab-open]");
  if (open) { detailAddress = open.getAttribute("data-ab-open"); render(); screenEl.scrollTop = 0; return; }
  if (target.closest("[data-ab-back]")) { detailAddress = null; render(); return; }
  const entry = detailAddress ? addressBookEntry(detailAddress) : null;
  if (!entry) return;
  const copy = target.closest("[data-ab-copy]");
  if (copy) {
    try { await deps?.copyText?.(entry.address); } catch { return; }
    const label = copy.querySelector(".ab-action-label");
    const icon = copy.querySelector(".ab-action-icon");
    if (label) label.textContent = "Copied";
    if (icon) icon.innerHTML = ICONS.check;
    window.clearTimeout(copiedTimer);
    copiedTimer = window.setTimeout(() => {
      if (!copy.isConnected) return;
      if (label) label.textContent = "Copy Address";
      if (icon) icon.innerHTML = ICONS.copy;
    }, 1500);
    return;
  }
  if (target.closest("[data-ab-share]")) { shareAddress(entry.address); return; }
  if (target.closest("[data-ab-send]")) { if (deps?.canSend?.() && !otherNetworkReason(entry.address)) deps?.openSend?.(entry.address); return; }
  if (target.closest("[data-ab-message]")) { if (!otherNetworkReason(entry.address)) deps?.openChat?.(entry.address); return; }
  if (target.closest("[data-ab-edit]")) {
    const result = await openAddressBookEditor({ address: entry.address });
    if (result === "removed") { detailAddress = null; render(); }
    return;
  }
  if (target.closest("[data-ab-delete]")) {
    if (await confirmDelete(entry)) { detailAddress = null; render(); }
  }
}

function attachScreen() {
  screenEl = document.querySelector("[data-address-book]");
  if (!screenEl || screenEl.dataset.abBound) return;
  screenEl.dataset.abBound = "1";
  screenEl.classList.add("ab-screen");
  screenEl.addEventListener("click", onScreenClick);
  screenEl.addEventListener("input", (event) => {
    if (!event.target?.matches?.("[data-ab-search]")) return;
    searchText = String(event.target.value || "");
    renderListRowsOnly();
  });
  // Right-click (long-press on touch) a saved address to delete it - iOS's swipe to delete.
  onContextGesture(screenEl, async (event) => {
    const row = event.target?.closest?.("[data-ab-open]");
    if (!row) return;
    event.preventDefault();
    await confirmDelete(addressBookEntry(row.getAttribute("data-ab-open")));
  });
}

/** deps: { escapeHtml, shortAddress, personGlyphSvg, profileAvatarHtml(address, className),
 *  ownAddress(), canSend(), openSend(address), openChat(address), copyText(text), showToast(text),
 *  confirmDialog(opts), formatBytes(bytes), onChange(kind: "edit" | "photos" | "restore") } */
export function initAddressBook(dependencies) {
  deps = dependencies;
  attachScreen();
  // Every change - an edit here, a restore, Remove Address Book Photos - repaints the screens on
  // show and lets the host repaint names and owe a backup.
  onAddressBookChange((kind) => { refreshAddressBookScreens(); changed(kind); });
  document.querySelector("[data-address-book-photos-remove]")?.addEventListener("click", confirmRemoveAllPhotos);
  // The startup tab restore can show this screen before the app got round to starting it.
  if (screenEl && !screenEl.hidden) { active = true; render(); }
}

export function showAddressBook() {
  if (!deps) return;
  attachScreen();
  active = true;
  render();
}

export function hideAddressBook() {
  active = false;
}

/** The book changed (an edit, a restore, a wallet switch): repaint what is on screen. */
export function refreshAddressBookScreens() {
  if (active) render();
  if (pickerState) renderPicker();
  refreshAddressBookStorageRow();
}

/** Another wallet: back to the list, search cleared. */
export function resetAddressBookForAccount() {
  detailAddress = null;
  searchText = "";
  closePicker(null);
  closeEditor(null);
  closeImportExportSheet();
  if (active) window.setTimeout(render, 0);
}

// ---------------------------------------------------------------------------------------------
// Import or Export sheet (iOS AddressBookView importExportSheet, 87b2a0b)
// ---------------------------------------------------------------------------------------------
//
// Import File / Export File, and with Nextcloud connected Import from Nextcloud / Export to
// Nextcloud (else a line saying where to connect it). The file is the store's export JSON; Export
// to Nextcloud puts it in the KaChat folder with its spaces kept, one new file per tap
// (NEXTCLOUD_SYNC.md §1), and Import from Nextcloud picks a .json starting in that folder.

let ioSheetEl = null;
let ioFileInput = null;

function ensureImportExportSheet() {
  if (ioSheetEl) return ioSheetEl;
  ioSheetEl = document.createElement("div");
  ioSheetEl.className = "modal-backdrop ab-backdrop ab-io-backdrop";
  ioSheetEl.hidden = true;
  ioSheetEl.innerHTML = `<div class="contact-modal portfolio-editor-modal ab-io-sheet" role="dialog" aria-modal="true" aria-label="Import or Export" data-ab-io-body></div>`;
  document.body.appendChild(ioSheetEl);
  ioSheetEl.addEventListener("mousedown", (event) => { if (event.target === ioSheetEl) closeImportExportSheet(); });
  ioSheetEl.addEventListener("keydown", (event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeImportExportSheet(); } });
  ioSheetEl.addEventListener("click", onImportExportClick);
  ioFileInput = document.createElement("input");
  ioFileInput.type = "file";
  ioFileInput.accept = ".json,application/json";
  ioFileInput.hidden = true;
  ioFileInput.setAttribute("data-ab-io-file", "");
  document.body.appendChild(ioFileInput);
  ioFileInput.addEventListener("change", onImportFileChosen);
  return ioSheetEl;
}

function ioRowHtml({ action, icon, title, subtitle }) {
  return `
    <button type="button" class="cold-action-row" data-ab-io="${esc(action)}">
      <span class="cold-action-icon" aria-hidden="true">${icon}</span>
      <span class="cold-action-copy"><strong>${esc(title)}</strong><small>${esc(subtitle)}</small></span>
    </button>`;
}

function renderImportExportSheet() {
  const body = ioSheetEl?.querySelector("[data-ab-io-body]");
  if (!body) return;
  const connected = isNextcloudConnected();
  const rows = [
    { action: "import", icon: ICONS.fileIn, title: "Import File", subtitle: "Add addresses from an Address Book export." },
    { action: "export", icon: ICONS.fileOut, title: "Export File", subtitle: "Save this Address Book, with its photos, to a file." },
    ...(connected ? [
      { action: "nc-import", icon: ICONS.cloudIn, title: "Import from Nextcloud", subtitle: "Pick an Address Book export from your Nextcloud." },
      { action: "nc-export", icon: ICONS.cloudOut, title: "Export to Nextcloud", subtitle: "Save it to the KaChat folder in your Nextcloud, to import on any device." },
    ] : []),
  ];
  body.innerHTML = `
    <div class="modal-header">
      <div><p class="modal-kicker">Address Book</p><h2>Import or Export</h2></div>
      <button class="modal-close" type="button" data-ab-io-close aria-label="Close">×</button>
    </div>
    <div class="cold-action-rows">${rows.map(ioRowHtml).join("")}</div>
    ${connected ? "" : `<p class="create-chat-help ab-io-note">${esc("Connect Nextcloud in Settings > Storage to also save it there and import it on another device.")}</p>`}`;
}

function openImportExportSheet() {
  ensureImportExportSheet();
  renderImportExportSheet();
  ioSheetEl.hidden = false;
  window.setTimeout(() => ioSheetEl?.querySelector("[data-ab-io]")?.focus(), 0);
}

function closeImportExportSheet() {
  if (ioSheetEl) ioSheetEl.hidden = true;
}

function onImportExportClick(event) {
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;
  if (target.closest("[data-ab-io-close]")) { closeImportExportSheet(); return; }
  const row = target.closest("[data-ab-io]");
  if (!row) return;
  closeImportExportSheet();
  const action = row.getAttribute("data-ab-io");
  if (action === "import") { ioFileInput.value = ""; ioFileInput.click(); }
  else if (action === "export") exportToFile();
  else if (action === "nc-import") importFromNextcloud();
  else if (action === "nc-export") exportToNextcloud();
}

const toast = (message) => { try { deps?.showToast?.(message); } catch { /* no toast */ } };
const errorText = (error) => String(error?.message || error || "unknown error");

/** The export as { filename, json }, or null (with the toast said) when there is nothing to write. */
function buildExport() {
  if (addressBookIsEmpty()) { toast("Nothing to export yet. Add an address first."); return null; }
  try {
    return { filename: addressBookExportFileName(), json: addressBookExportJson() };
  } catch {
    toast("Export failed. Couldn't write the file.");
    return null;
  }
}

async function exportToFile() {
  const built = buildExport();
  if (!built) return;
  try { await saveFile(built.filename, "application/json", built.json); }
  catch { toast("Export failed. Couldn't write the file."); }
}

async function exportToNextcloud() {
  const built = buildExport();
  if (!built) return;
  try {
    const path = await uploadToKaChatFolder(new Blob([built.json], { type: "application/json" }), built.filename, "application/json", { keepSpaces: true });
    toast(`Saved to ${path} in Nextcloud.`);
  } catch (error) {
    toast(`Export to Nextcloud failed: ${errorText(error)}`);
  }
}

function importFromNextcloud() {
  openNextcloudFilePicker({
    allowedExtensions: ["json"],
    onPicked: async (file) => {
      let text;
      try { text = await downloadNextcloudText(file.path, { maxBytes: 50_000_000 }); }
      catch (error) { toast(`Import from Nextcloud failed: ${errorText(error)}`); return; }
      runImport(text);
    },
  });
}

async function onImportFileChosen() {
  const file = ioFileInput?.files?.[0];
  if (ioFileInput) ioFileInput.value = "";
  if (!file) return;
  let text;
  try {
    if (file.size > 50_000_000) throw new Error("too large");
    text = await file.text();
  } catch {
    toast("Couldn't read that file.");
    return;
  }
  runImport(text);
}

function runImport(text) {
  try {
    const { added, updated, skipped } = importAddressBookExport(text);
    let message = added + updated === 0
      ? "Already up to date. Every address in the file is saved."
      : `Imported: ${added} added, ${updated} updated.`;
    if (skipped > 0) message += ` Skipped ${skipped} from the other network.`;
    toast(message);
  } catch (error) {
    toast(errorText(error));
  }
}

// ---------------------------------------------------------------------------------------------
// Add / edit sheet
// ---------------------------------------------------------------------------------------------

let editorEl = null;
/** { address: fixed address or null, addressInput, name, note, pendingPhoto (undefined keep |
 *  string new | null removed), error, resolve, and for a typed domain (iOS 6ac48a7):
 *  resolvedAddress, resolvedName, nameResolutions, selectedTld, resolving, lookupError } */
let editorState = null;
let editorResolveToken = 0;

function ensureEditor() {
  if (editorEl) return editorEl;
  editorEl = document.createElement("div");
  editorEl.className = "modal-backdrop ab-backdrop ab-editor-backdrop";
  editorEl.hidden = true;
  editorEl.innerHTML = `<form class="contact-modal create-chat-modal ab-sheet" novalidate data-ab-editor role="dialog" aria-modal="true"></form>`;
  document.body.appendChild(editorEl);
  editorEl.addEventListener("mousedown", (event) => { if (event.target === editorEl) closeEditor(null); });
  editorEl.addEventListener("keydown", (event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeEditor(null); } });
  editorEl.addEventListener("submit", (event) => { event.preventDefault(); saveEditor(); });
  editorEl.addEventListener("input", onEditorInput);
  editorEl.addEventListener("click", onEditorClick);
  editorEl.addEventListener("change", onEditorFileChange);
  return editorEl;
}

/** The address being saved: the one this editor was opened for, else what the typed domain
 *  resolved to, else what was typed (iOS 6ac48a7 enteredAddress). */
function editorEffectiveAddress() {
  if (!editorState) return "";
  return normalizeAddressBookAddress(editorState.address ?? editorState.resolvedAddress ?? editorState.addressInput);
}

// The Address Book editor takes a domain too (iOS 6ac48a7): a typed name resolves on every
// service, .kachat first, with Other domains under the resolved name; the entry saves the address.
function editorResolutionHtml() {
  const s = editorState;
  if (!s || s.address) return "";
  if (s.resolving) return '<span class="create-chat-status-muted">Looking up domain…</span>';
  const others = otherDomainsHtml({ resolutions: s.nameResolutions || [], selectedTld: s.selectedTld ?? null });
  if (s.resolvedAddress) {
    return `<span class="create-chat-status-good">✓ Resolved: ${esc(s.resolvedName || "")}</span>`
      + `<span class="create-chat-status-mono">${esc(s.resolvedAddress)}</span>${others}`;
  }
  if (s.lookupError) return `<span class="create-chat-status-bad">✕ ${esc(s.lookupError)}</span>${others}`;
  return "";
}
function renderEditorResolution() {
  const host = editorEl?.querySelector("[data-ab-editor-resolution]");
  if (!host) return;
  const html = editorResolutionHtml();
  host.innerHTML = html;
  host.hidden = !html;
}
function resolveEditorName(input) {
  const s = editorState;
  if (!s || s.address) return;
  const typed = String(input || "").trim();
  const token = ++editorResolveToken;
  Object.assign(s, { resolvedAddress: null, resolvedName: null, nameResolutions: [], selectedTld: null, lookupError: null, resolving: false });
  if (!typed || !deps?.looksLikeName?.(typed) || typeof deps?.lookUpName !== "function") { renderEditorResolution(); return; }
  s.resolving = true;
  renderEditorResolution();
  window.setTimeout(async () => {
    if (token !== editorResolveToken || editorState !== s) return;
    let results = [];
    let resolution = null;
    try { ({ results, resolution } = await deps.lookUpName(typed)); } catch { results = []; resolution = null; }
    if (token !== editorResolveToken || editorState !== s) return;
    s.nameResolutions = results || [];
    s.resolving = false;
    if (resolution?.ownerAddress) selectEditorResolution({ address: resolution.ownerAddress, name: resolution.domain, tld: resolution.tld });
    else s.lookupError = nameNotFoundText(typed);
    renderEditorResolution();
    refreshEditorChrome();
  }, 300);
}
function selectEditorResolution({ address, name, tld }) {
  const s = editorState;
  if (!s || !address) return;
  s.resolvedAddress = address;
  s.resolvedName = name || null;
  s.selectedTld = tld || null;
  s.lookupError = null;
  // the name they're known by, unless one was typed already
  if (!String(s.name || "").trim() && name) {
    s.name = name;
    const field = editorEl?.querySelector("[data-ab-editor-name]");
    if (field) field.value = name;
  }
}

function editorShowsAssignedPhoto() {
  const p = editorState?.pendingPhoto;
  if (typeof p === "string") return true;
  if (p === null) return false;
  return Boolean(addressBookPhoto(editorEffectiveAddress()));
}

function editorAvatarHtml() {
  const address = editorEffectiveAddress();
  const pending = editorState.pendingPhoto;
  return addressBookAvatarHtml(address, "chat-avatar ab-avatar ab-avatar-84", pending === undefined ? undefined : (pending || null));
}

function editorCanSave() {
  return Boolean(String(editorState?.name || "").trim()) && Boolean(editorEffectiveAddress());
}

function renderEditor() {
  if (!editorEl || !editorState) return;
  const form = editorEl.querySelector("[data-ab-editor]");
  const existing = addressBookEntry(editorEffectiveAddress());
  const s = editorState;
  const assigned = editorShowsAssignedPhoto();
  form.innerHTML = `
    <header class="create-chat-header">
      <button class="create-chat-nav-button" type="button" data-ab-editor-cancel>Cancel</button>
      <h2>${esc(existing ? "Edit Address" : "Add to Address Book")}</h2>
      <button class="create-chat-nav-button" type="submit" data-ab-editor-save${editorCanSave() ? "" : " disabled"}>Save</button>
    </header>
    <section class="create-chat-section ab-photo-section">
      <div class="ab-photo-avatar" data-ab-editor-avatar>${editorAvatarHtml()}</div>
      <div class="ab-photo-buttons">
        <button type="button" class="ab-link-button" data-ab-photo-choose>${ICONS.photo}<span>${esc(assigned ? "Change Photo" : "Choose Photo")}</span></button>
        ${assigned ? `<button type="button" class="ab-link-button danger" data-ab-photo-remove>${ICONS.trash}<span>Remove Photo</span></button>` : ""}
      </div>
      <input type="file" accept="image/*" hidden data-ab-photo-input />
      <p class="create-chat-help">Without a photo of your own, this shows the avatar they set on their profile.</p>
    </section>
    <section class="create-chat-section">
      <label class="create-chat-section-title ab-section-title" for="ab-editor-name">Name</label>
      <input id="ab-editor-name" class="create-chat-name-input" type="text" data-ab-editor-name placeholder="Name" maxlength="80" autocomplete="off" value="${esc(s.name)}" />
    </section>
    <section class="create-chat-section">
      <p class="create-chat-section-title ab-section-title">Address</p>
      ${s.address
        ? `<p class="ab-address-mono ab-address-fixed">${esc(s.address)}</p>`
        : `<div class="create-chat-address-card">
            <textarea class="create-chat-address-input ab-address-input" rows="2" data-ab-editor-address placeholder="kaspa:qr... or domain" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="Address or domain">${esc(s.addressInput)}</textarea>
            <div class="create-chat-tools ab-address-tools">
              <button type="button" class="create-chat-tool" data-ab-editor-paste><span class="create-chat-tool-icon" aria-hidden="true">${ICONS.paste}</span><span>Paste</span></button>
              <button type="button" class="create-chat-tool" data-ab-editor-scan><span class="create-chat-tool-icon" aria-hidden="true">${ICONS.scan}</span><span>Scan QR</span></button>
            </div>
          </div>
          <div class="create-chat-status" data-ab-editor-resolution ${editorResolutionHtml() ? "" : "hidden"}>${editorResolutionHtml()}</div>`}
    </section>
    <section class="create-chat-section">
      <textarea class="create-chat-name-input ab-note-input" rows="2" data-ab-editor-note placeholder="Note (optional)" aria-label="Note (optional)">${esc(s.note)}</textarea>
      <p class="create-chat-help">Saved in KaChat for this wallet only. Never added to your phone's Contacts.</p>
    </section>
    ${s.error ? `<p class="create-chat-error ab-editor-error">${ICONS.warn}<span>${esc(s.error)}</span></p>` : ""}
    ${s.address && existing ? `
      <section class="create-chat-section">
        <button type="button" class="ab-remove-button" data-ab-editor-remove>${ICONS.trash}<span>Remove from Address Book</span></button>
      </section>` : ""}`;
}

function refreshEditorChrome() {
  const save = editorEl?.querySelector("[data-ab-editor-save]");
  if (save) save.disabled = !editorCanSave();
  const avatar = editorEl?.querySelector("[data-ab-editor-avatar]");
  if (avatar) avatar.innerHTML = editorAvatarHtml();
}

function onEditorInput(event) {
  if (!editorState) return;
  const t = event.target;
  if (t.matches("[data-ab-editor-name]")) editorState.name = t.value;
  else if (t.matches("[data-ab-editor-note]")) editorState.note = t.value;
  else if (t.matches("[data-ab-editor-address]")) { editorState.addressInput = t.value; resolveEditorName(t.value); }
  else return;
  refreshEditorChrome();
}

function setEditorAddressInput(value) {
  if (!editorState || editorState.address) return;
  editorState.addressInput = String(value || "").trim();
  const field = editorEl?.querySelector("[data-ab-editor-address]");
  if (field) field.value = editorState.addressInput;
  resolveEditorName(editorState.addressInput);
  // The title, Remove and photo buttons follow whether that address is already saved.
  const existing = addressBookEntry(editorEffectiveAddress());
  if (existing && !String(editorState.name || "").trim()) { editorState.name = existing.name; editorState.note = existing.note; }
  renderEditor();
}

async function onEditorClick(event) {
  const target = event.target instanceof Element ? event.target : null;
  if (!target || !editorState) return;
  if (target.closest("[data-ab-editor-cancel]")) { closeEditor(null); return; }
  // A pick under Other domains saves that service's address instead (iOS 6ac48a7).
  const otherDomain = pickOtherDomain(event, editorState.nameResolutions);
  if (otherDomain) {
    selectEditorResolution({ address: otherDomain.address, name: otherDomain.name, tld: otherDomain.tld });
    renderEditorResolution();
    refreshEditorChrome();
    return;
  }
  if (target.closest("[data-ab-photo-choose]")) { editorEl.querySelector("[data-ab-photo-input]")?.click(); return; }
  if (target.closest("[data-ab-photo-remove]")) { editorState.pendingPhoto = null; renderEditor(); return; }
  if (target.closest("[data-ab-editor-paste]")) {
    try {
      const pasted = await navigator.clipboard.readText();
      if (pasted) setEditorAddressInput(pasted);
    } catch { /* clipboard denied or empty: leave the field */ }
    return;
  }
  if (target.closest("[data-ab-editor-scan]")) {
    let scanned = null;
    try { scanned = await scanKaspaAddress({ title: "Scan QR", hint: "Point the camera at the address QR code you want to save." }); } catch { scanned = null; }
    if (scanned && editorState) setEditorAddressInput(normalizeAddressBookAddress(scanned));
    return;
  }
  if (target.closest("[data-ab-editor-remove]")) {
    removeAddressBookEntry(editorEffectiveAddress());
    closeEditor("removed");
  }
}

/** A picked image as the JPEG an entry keeps: at most 384 px on its longer side (an avatar is
 *  never drawn bigger), quality 0.8 - tens of KB, so the backup stays small. */
export async function prepareAddressBookPhoto(file) {
  let source = null;
  let width = 0;
  let height = 0;
  if (typeof createImageBitmap === "function") {
    source = await createImageBitmap(file);
    width = source.width; height = source.height;
  } else {
    const url = URL.createObjectURL(file);
    try {
      source = await new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error("unreadable"));
        img.src = url;
      });
      width = source.naturalWidth; height = source.naturalHeight;
    } finally { URL.revokeObjectURL(url); }
  }
  if (!width || !height) throw new Error("unreadable");
  const scale = Math.min(1, ADDRESS_BOOK_PHOTO_MAX_SIDE / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext("2d");
  // JPEG has no alpha: a transparent picture goes onto white rather than black.
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  try { source.close?.(); } catch { /* not a bitmap */ }
  const dataUrl = canvas.toDataURL("image/jpeg", ADDRESS_BOOK_PHOTO_QUALITY);
  if (!dataUrl.startsWith("data:image/jpeg")) throw new Error("unreadable");
  return dataUrl;
}

async function onEditorFileChange(event) {
  const input = event.target;
  if (!input?.matches?.("[data-ab-photo-input]") || !editorState) return;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  const state = editorState;
  try {
    const prepared = await prepareAddressBookPhoto(file);
    if (editorState !== state) return;
    state.pendingPhoto = prepared;
    state.error = null;
  } catch {
    if (editorState !== state) return;
    state.error = "Couldn't use that photo.";
  }
  renderEditor();
}

function saveEditor() {
  if (!editorState || !editorCanSave()) return;
  try {
    const p = editorState.pendingPhoto;
    saveAddressBookEntry({
      address: editorEffectiveAddress(),
      name: editorState.name,
      note: editorState.note,
      photo: typeof p === "string" ? p : (p === null ? null : undefined),
    });
    closeEditor("saved");
  } catch (error) {
    editorState.error = String(error?.message || error || "");
    renderEditor();
  }
}

function closeEditor(result) {
  if (!editorState) return;
  const { resolve } = editorState;
  editorState = null;
  if (editorEl) { editorEl.hidden = true; editorEl.querySelector("[data-ab-editor]").innerHTML = ""; }
  try { resolve?.(result); } catch { /* caller's problem */ }
}

/**
 * Add or edit one entry. With an `address` it edits that address's entry (or adds it, with
 * `suggestedName` filled in - User Info's and the chat row's "Add to Address Book"); without one
 * the address is typed, pasted or scanned. Resolves "saved", "removed" or null (cancelled).
 */
export function openAddressBookEditor({ address = null, suggestedName = "" } = {}) {
  ensureEditor();
  closeEditor(null);
  const fixed = address ? normalizeAddressBookAddress(address) : null;
  const existing = fixed ? addressBookEntry(fixed) : null;
  return new Promise((resolve) => {
    editorState = {
      address: fixed,
      addressInput: "",
      name: existing ? existing.name : String(suggestedName || ""),
      note: existing ? existing.note : "",
      pendingPhoto: undefined,
      error: null,
      resolve,
      resolvedAddress: null,
      resolvedName: null,
      nameResolutions: [],
      selectedTld: null,
      resolving: false,
      lookupError: null,
    };
    editorResolveToken += 1;
    renderEditor();
    editorEl.hidden = false;
    window.setTimeout(() => {
      const focus = editorEl.querySelector(fixed ? "[data-ab-editor-name]" : "[data-ab-editor-address]");
      focus?.focus();
    }, 0);
  });
}

// ---------------------------------------------------------------------------------------------
// Picker: one address (New Chat, the Send screens) or several with ticks (New Group)
// ---------------------------------------------------------------------------------------------

let pickerEl = null;
/** { multiple, ticked: Set, excluding: Set, search, resolve } */
let pickerState = null;

function ensurePicker() {
  if (pickerEl) return pickerEl;
  pickerEl = document.createElement("div");
  pickerEl.className = "modal-backdrop ab-backdrop ab-picker-backdrop";
  pickerEl.hidden = true;
  pickerEl.innerHTML = `<div class="contact-modal create-chat-modal ab-sheet ab-picker" role="dialog" aria-modal="true" aria-label="Address Book">
    <header class="create-chat-header">
      <button class="create-chat-nav-button" type="button" data-ab-picker-cancel>Cancel</button>
      <h2>Address Book</h2>
      <button class="create-chat-nav-button" type="button" data-ab-picker-done hidden></button>
    </header>
    <div data-ab-picker-body></div>
  </div>`;
  document.body.appendChild(pickerEl);
  pickerEl.addEventListener("mousedown", (event) => { if (event.target === pickerEl) closePicker(null); });
  pickerEl.addEventListener("keydown", (event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closePicker(null); } });
  pickerEl.addEventListener("click", onPickerClick);
  pickerEl.addEventListener("input", (event) => {
    if (!pickerState || !event.target?.matches?.("[data-ab-picker-search]")) return;
    pickerState.search = String(event.target.value || "");
    renderPickerRows();
  });
  return pickerEl;
}

function pickerShown() {
  return searchAddressBook(pickerState?.search || "").filter((e) => !pickerState?.excluding.has(e.address));
}

function pickerRowsHtml() {
  const shown = pickerShown();
  if (!shown.length) return `<p class="ab-empty-line">No matches</p>`;
  return shown.map((entry) => {
    const ticked = pickerState.ticked.has(entry.address);
    // The other network's address can't be chatted with or added to a group (iOS IOS-063).
    const otherNetwork = otherNetworkReason(entry.address);
    return `
      <button type="button" class="create-chat-picker-row ab-picker-row${ticked ? " picked" : ""}${otherNetwork ? " ab-other-network" : ""}" data-ab-pick="${esc(entry.address)}"${pickerState.multiple ? ` aria-pressed="${ticked}"` : ""}${otherNetwork ? " disabled" : ""}>
        ${addressBookAvatarHtml(entry.address, "create-chat-picker-avatar")}
        <span class="create-chat-picker-copy">
          <span class="create-chat-picker-name">${esc(entry.name)}</span>
          <span class="create-chat-picker-sub">${esc(short(entry.address))}</span>
          ${otherNetwork ? `<span class="ab-other-network-note">${esc(otherNetwork)}</span>` : ""}
        </span>
        ${pickerState.multiple ? `<span class="ab-tick${ticked ? " on" : ""}" aria-hidden="true">${ticked ? ICONS.circleCheck : ICONS.circle}</span>` : ""}
      </button>`;
  }).join("");
}

function renderPickerRows() {
  const list = pickerEl?.querySelector("[data-ab-picker-list]");
  if (list) list.innerHTML = pickerRowsHtml();
}

function renderPickerDone() {
  const done = pickerEl?.querySelector("[data-ab-picker-done]");
  if (!done || !pickerState) return;
  done.hidden = !pickerState.multiple;
  const n = pickerState.ticked.size;
  done.textContent = n ? `Add (${n})` : "Done";
}

function renderPicker() {
  if (!pickerEl || !pickerState) return;
  const body = pickerEl.querySelector("[data-ab-picker-body]");
  renderPickerDone();
  if (addressBookIsEmpty()) {
    body.innerHTML = `
      <div class="ab-empty ab-picker-empty">
        <span class="ab-empty-icon muted">${ADDRESS_BOOK_ICONS.book}</span>
        <strong>No saved addresses</strong>
        <p>Add addresses in Kaspa Hub &gt; Address Book.</p>
      </div>`;
    return;
  }
  const focused = document.activeElement?.matches?.("[data-ab-picker-search]");
  body.innerHTML = `
    <input class="ab-search" type="search" data-ab-picker-search placeholder="Search names and addresses" autocomplete="off" spellcheck="false" value="${esc(pickerState.search)}" aria-label="Search names and addresses" />
    <div class="ab-picker-list" data-ab-picker-list>${pickerRowsHtml()}</div>`;
  if (focused) body.querySelector("[data-ab-picker-search]")?.focus();
}

function onPickerClick(event) {
  const target = event.target instanceof Element ? event.target : null;
  if (!target || !pickerState) return;
  if (target.closest("[data-ab-picker-cancel]")) { closePicker(null); return; }
  if (target.closest("[data-ab-picker-done]")) {
    const ticked = pickerState.ticked;
    closePicker(addressBookEntries().filter((e) => ticked.has(e.address) && !otherNetworkReason(e.address)));
    return;
  }
  const row = target.closest("[data-ab-pick]");
  if (!row) return;
  const address = row.getAttribute("data-ab-pick");
  if (otherNetworkReason(address)) return;
  if (!pickerState.multiple) {
    closePicker(addressBookEntry(address));
    return;
  }
  if (pickerState.ticked.has(address)) pickerState.ticked.delete(address);
  else pickerState.ticked.add(address);
  renderPickerRows();
  renderPickerDone();
}

function closePicker(result) {
  if (!pickerState) return;
  const { resolve } = pickerState;
  pickerState = null;
  if (pickerEl) pickerEl.hidden = true;
  try { resolve?.(result); } catch { /* caller's problem */ }
}

function openPicker({ multiple, preselected = [], excluding = [] }) {
  ensurePicker();
  closePicker(null);
  const saved = new Set(addressBookEntries().map((e) => e.address));
  return new Promise((resolve) => {
    pickerState = {
      multiple,
      // Ticks start on who is already in (and saved).
      ticked: new Set([...preselected].map(normalizeAddressBookAddress).filter((a) => saved.has(a))),
      excluding: new Set((Array.isArray(excluding) ? excluding : [excluding]).filter(Boolean).map(normalizeAddressBookAddress)),
      search: "",
      resolve,
    };
    renderPicker();
    pickerEl.hidden = false;
    window.setTimeout(() => pickerEl.querySelector("[data-ab-picker-search]")?.focus(), 0);
  });
}

/** One address: resolves the picked entry, or null when cancelled. */
export function pickFromAddressBook() {
  return openPicker({ multiple: false });
}

/** Several: rows tick on and off (starting from `preselected`); resolves every ticked entry
 *  (possibly none) on Done / Add (n), or null when cancelled. `excluding` (an address or a list)
 *  is never offered. */
export function pickManyFromAddressBook({ preselected = [], excluding = [] } = {}) {
  return openPicker({ multiple: true, preselected, excluding });
}

// ---------------------------------------------------------------------------------------------
// Settings > Storage > Address Book Photos
// ---------------------------------------------------------------------------------------------

function formatBytes(bytes) {
  try { if (deps?.formatBytes) return deps.formatBytes(bytes); } catch { /* fall through */ }
  const kb = bytes / 1024;
  return kb < 1024 ? `${kb.toFixed(1)} KB` : `${(kb / 1024).toFixed(1)} MB`;
}

/** The row's size and whether Remove shows (every wallet on this device). */
export function refreshAddressBookStorageRow() {
  const sizeEl = document.querySelector("[data-address-book-photos-size]");
  const removeEl = document.querySelector("[data-address-book-photos-remove]");
  if (!sizeEl && !removeEl) return;
  let bytes = 0;
  try { bytes = addressBookPhotoBytes(); } catch { bytes = 0; }
  if (sizeEl) sizeEl.textContent = formatBytes(bytes);
  if (removeEl) removeEl.hidden = bytes <= 0;
}

async function confirmRemoveAllPhotos() {
  let bytes = 0;
  try { bytes = addressBookPhotoBytes(); } catch { bytes = 0; }
  const ok = await deps?.confirmDialog?.({
    title: "Remove Address Book Photos?",
    message: `Frees ${formatBytes(bytes)}. Saved addresses keep their names; they show the avatar their owner set instead.`,
    confirmLabel: "Remove",
    destructive: true,
  });
  if (!ok) return;
  removeAllAddressBookPhotos();
  refreshAddressBookStorageRow();
}
