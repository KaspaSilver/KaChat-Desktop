// In-app confirm / prompt / choose overlays.
//
// The browser's own `window.confirm`, `window.prompt` and `window.alert` announce themselves as
// "localhost:5173 says", which is the BROWSER speaking about the page rather than the app speaking
// to its user. On a page people are trusting with money that is the wrong voice, and it looks like
// something has gone wrong even when nothing has. These are the replacements: same shapes, same
// promise-returning ergonomics, rendered in the app's own chrome.
//
// One module rather than one per screen, so the confirm before deleting a group looks exactly like
// the confirm before wiping an account.

let host = null;
let settle = null;

function ensureHost() {
  if (host) return host;
  host = document.createElement("div");
  host.className = "modal-backdrop app-dialog-backdrop";
  host.hidden = true;
  host.innerHTML = `<div class="contact-modal app-dialog" role="dialog" aria-modal="true" data-app-dialog-body></div>`;
  document.body.appendChild(host);

  // A click on the backdrop itself cancels; a click inside must not.
  host.addEventListener("mousedown", (event) => { if (event.target === host) finish(null); });
  host.addEventListener("click", (event) => {
    if (event.target.closest("[data-app-dialog-cancel]")) { finish(null); return; }
    if (event.target.closest("[data-app-dialog-ok]")) {
      const input = host.querySelector("[data-app-dialog-input]");
      finish(input ? String(input.value) : true);
      return;
    }
    const choice = event.target.closest("[data-app-dialog-choice]");
    if (choice) finish(choice.dataset.appDialogChoice);
  });
  host.addEventListener("keydown", (event) => {
    if (event.key === "Escape") finish(null);
    if (event.key === "Enter" && host.querySelector("[data-app-dialog-input]")) {
      event.preventDefault();
      finish(String(host.querySelector("[data-app-dialog-input]").value));
    }
  });
  return host;
}

function finish(result) {
  if (host) host.hidden = true;
  const resolve = settle;
  settle = null;
  resolve?.(result);
}

function escape(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

function headerHtml(kicker, title) {
  return `
    <div class="modal-header">
      <div>${kicker ? `<p class="modal-kicker">${escape(kicker)}</p>` : ""}<h2>${escape(title)}</h2></div>
      <button class="modal-close" type="button" data-app-dialog-cancel aria-label="Close">×</button>
    </div>`;
}

/// Message lines are escaped but newlines survive, so the callers that used "\n\n" in a
/// window.confirm keep their paragraphing.
function bodyHtml(message) {
  if (!message) return "";
  return String(message).split("\n").filter((line) => line.trim())
    .map((line) => `<p class="field-hint">${escape(line)}</p>`).join("");
}

function present(html, focusSelector, variantClass = "") {
  const el = ensureHost();
  const body = el.querySelector("[data-app-dialog-body]");
  // One host serves every dialog, so a variant (the tiles sheet) is set per presentation.
  body.classList.toggle("app-dialog-tiles", variantClass === "app-dialog-tiles");
  body.innerHTML = html;
  el.hidden = false;
  const focus = focusSelector ? el.querySelector(focusSelector) : el.querySelector("[data-app-dialog-ok]");
  focus?.focus();
  if (focus?.select) focus.select();
}

/// Resolves true when confirmed, false otherwise - never rejects, so callers read as an `if`.
export function confirmDialog({ title, message = "", kicker = null, confirmLabel = "Confirm", destructive = false } = {}) {
  return new Promise((resolve) => {
    settle = (value) => resolve(value !== null);
    present(`
      ${headerHtml(kicker, title)}
      ${bodyHtml(message)}
      <div class="modal-actions">
        <button class="secondary-button" type="button" data-app-dialog-cancel>Cancel</button>
        <button class="primary-button${destructive ? " danger" : ""}" type="button" data-app-dialog-ok>${escape(confirmLabel)}</button>
      </div>`);
  });
}

/// Resolves the typed string, or null when cancelled.
export function promptDialog({ title, label = "", message = "", kicker = null, initial = "", confirmLabel = "Save", maxLength = 120 } = {}) {
  return new Promise((resolve) => {
    settle = resolve;
    present(`
      ${headerHtml(kicker, title)}
      ${bodyHtml(message)}
      <div class="portfolio-editor-body">
        <label class="portfolio-editor-field">
          ${label ? `<span>${escape(label)}</span>` : ""}
          <input type="text" maxlength="${Number(maxLength) || 120}" data-app-dialog-input value="${escape(initial)}" />
        </label>
      </div>
      <div class="modal-actions">
        <button class="secondary-button" type="button" data-app-dialog-cancel>Cancel</button>
        <button class="primary-button" type="button" data-app-dialog-ok>${escape(confirmLabel)}</button>
      </div>`, "[data-app-dialog-input]");
  });
}

/// A sheet of caller-built HTML (already escaped) with one Done button: for lists that a plain
/// message cannot carry, such as who reacted to a message.
export function infoSheet({ title, html = "", kicker = null, confirmLabel = "Done" } = {}) {
  return new Promise((resolve) => {
    settle = () => resolve(true);
    present(`
      ${headerHtml(kicker, title)}
      <div class="app-dialog-sheet-body">${html}</div>
      <div class="modal-actions">
        <button class="primary-button" type="button" data-app-dialog-ok>${escape(confirmLabel)}</button>
      </div>`);
  });
}

/// A message with one button: resolves once dismissed.
export function alertDialog({ title, message = "", kicker = null, confirmLabel = "OK" } = {}) {
  return new Promise((resolve) => {
    settle = () => resolve(true);
    present(`
      ${headerHtml(kicker, title)}
      ${bodyHtml(message)}
      <div class="modal-actions">
        <button class="primary-button" type="button" data-app-dialog-ok>${escape(confirmLabel)}</button>
      </div>`);
  });
}

/// Icons for tile options (iOS ActionSheetRow's SF Symbols), drawn by the `.action-tile-icon`
/// CSS: stroke, no fill, currentColor. Trusted markup - callers pass these, never user text.
const tileSvg = (paths) => `<svg viewBox="0 0 24 24" aria-hidden="true">${paths}</svg>`;
export const ACTION_TILE_ICONS = {
  envelopeOpen: tileSvg('<path d="M3 10.5 12 4l9 6.5V19a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 19z"/><path d="m3 10.5 9 6 9-6"/>'),
  envelopeBadge: tileSvg('<path d="M14 5.5H4.5A1.5 1.5 0 0 0 3 7v11a1.5 1.5 0 0 0 1.5 1.5h15A1.5 1.5 0 0 0 21 18v-7"/><path d="m3 7.5 9 6 3.2-2.1"/><circle cx="19" cy="5.5" r="2.5"/>'),
  bell: tileSvg('<path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>'),
  bellSlash: tileSvg('<path d="M8.2 5.9A6 6 0 0 1 18 11v4.2M18 18.5H4.5l1.5-2V11c0-.9.2-1.8.6-2.6"/><path d="M10 20.5a2 2 0 0 0 4 0"/><path d="m3.5 3.5 17 17"/>'),
  pin: tileSvg('<path d="M9 3.5h6l-1 6 3.5 3.5h-11L10 9.5z"/><path d="M12 13v7.5"/>'),
  unpin: tileSvg('<path d="M9 3.5h6l-1 6 3.5 3.5h-11L10 9.5z"/><path d="M12 13v7.5"/><path d="m4 4 16 16"/>'),
  trash: tileSvg('<path d="M3.5 6.5h17"/><path d="M18.5 6.5V19a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2V6.5"/><path d="M8.5 6.5V4.5a1.5 1.5 0 0 1 1.5-1.5h4a1.5 1.5 0 0 1 1.5 1.5v2"/>'),
  link: tileSvg('<path d="M10 13.5a4 4 0 0 0 6 .4l3-3a4 4 0 0 0-5.7-5.7l-1.7 1.7"/><path d="M14 10.5a4 4 0 0 0-6-.4l-3 3a4 4 0 0 0 5.7 5.7l1.7-1.7"/>'),
  camera: tileSvg('<path d="M4 8.5A2.5 2.5 0 0 1 6.5 6h1.2l1.1-1.6A1 1 0 0 1 9.6 4h4.8a1 1 0 0 1 .8.4L16.3 6h1.2A2.5 2.5 0 0 1 20 8.5v8A2.5 2.5 0 0 1 17.5 19h-11A2.5 2.5 0 0 1 4 16.5z"/><circle cx="12" cy="12.5" r="3.2"/>'),
  photo: tileSvg('<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="8.5" cy="9.5" r="1.5"/><path d="m5 17 4.5-4.5 3.2 3.2 2.3-2.3L19 17"/>'),
  mic: tileSvg('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M6.5 11.5a5.5 5.5 0 0 0 11 0M12 17v4M9 21h6"/>'),
  file: tileSvg('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>'),
};

/// One of several named options, resolved as the chosen option's `id`, or null when cancelled.
/// Replaces the pattern of listing options in a prompt and asking for a number.
///
/// `layout: "tiles"` (iOS ActionSheetTiles, cdac6d0) draws the options as square tiles, three to
/// a row: `option.icon` (trusted SVG/HTML, e.g. from ACTION_TILE_ICONS) over the short `title`,
/// with `subtitle` moved to the tooltip and the accessible description. The long-press menus use
/// it; every other sheet keeps the default row form.
export function chooseDialog({ title, message = "", kicker = null, options = [], layout = "rows" } = {}) {
  const tiles = layout === "tiles";
  return new Promise((resolve) => {
    settle = resolve;
    const list = (options || []).filter(Boolean);
    present(`
      ${headerHtml(kicker, title)}
      ${bodyHtml(message)}
      ${tiles ? `
      <div class="action-tiles">
        ${list.map((option) => `
          <button type="button" class="action-tile${option.destructive ? " action-tile-danger" : ""}" data-app-dialog-choice="${escape(option.id)}"${option.subtitle ? ` title="${escape(option.subtitle)}" aria-description="${escape(option.subtitle)}"` : ""}${option.disabled ? " disabled" : ""}>
            <span class="action-tile-icon" aria-hidden="true">${option.icon || ""}</span>
            <span class="action-tile-title">${escape(option.title)}</span>
          </button>`).join("")}
      </div>` : `
      <div class="cold-action-rows">
        ${list.map((option) => `
          <button type="button" class="cold-action-row${option.destructive ? " cold-action-row-danger" : ""}" data-app-dialog-choice="${escape(option.id)}">
            <span class="cold-action-copy">
              <strong>${escape(option.title)}</strong>
              ${option.subtitle ? `<small>${escape(option.subtitle)}</small>` : ""}
            </span>
          </button>`).join("")}
      </div>`}`, null, tiles ? "app-dialog-tiles" : "");
  });
}

/// What an error says when a person has to read it (iOS UserFacingError). The app's own errors
/// carry sentences already written for the user, so those pass through with any developer prefix
/// stripped; the browser's network and parse errors are translated into something a person can act on.
export function userFacingError(error) {
  const fallback = "Something went wrong. Please try again.";
  if (error == null) return fallback;
  const name = String(error?.name || "");
  let text = String(error?.message ?? error ?? "").trim();
  if (name === "AbortError" || /^(aborted|cancelled|canceled)\.?$/i.test(text)) return "Cancelled.";
  if (/failed to fetch|networkerror when attempting|load failed|network request failed|err_network|err_internet_disconnected/i.test(text)) {
    return "Couldn't reach the server. Check your connection and try again.";
  }
  if (name === "SyntaxError" && /json|unexpected token|unexpected end of/i.test(text)) {
    return "The server sent something the app couldn't read. Try again in a moment.";
  }
  if (/timed? ?out/i.test(text) && text.length < 80) return "The connection timed out. Check your connection and try again.";
  for (const prefix of ["Network error: ", "API error: ", "RPC error: ", "Error: ", "TypeError: "]) {
    if (text.startsWith(prefix)) text = text.slice(prefix.length);
  }
  return text || fallback;
}

/// Drop-in replacements for a bare `confirm(text)` / `prompt(text, initial)`.
///
/// The app had twenty-two of these, each with its wording already written as one string. Splitting
/// every one by hand into a title and a body would have been twenty-two chances to change what a
/// warning says while moving it. These keep the text exactly as it was: the first line becomes the
/// heading, the rest the body, which is how those strings were already written - a short question,
/// then the consequences after a blank line.
export function confirmText(text, options = {}) {
  const [first, ...rest] = String(text ?? "").split("\n");
  return confirmDialog({
    title: first.trim() || "Confirm",
    message: rest.join("\n").trim(),
    ...options,
  });
}

export function promptText(text, initial = "", options = {}) {
  const [first, ...rest] = String(text ?? "").split("\n");
  return promptDialog({
    title: first.trim() || "Enter a value",
    message: rest.join("\n").trim(),
    initial,
    ...options,
  });
}
