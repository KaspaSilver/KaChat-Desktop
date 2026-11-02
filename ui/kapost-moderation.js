// Moderation for KaPost and Public Chats (KaPosts-iPhone 9e22075, App Store guideline 1.2): the
// report that goes to support, the block that also takes an account out of every room, and the
// Terms of Use. No imports and no DOM on load, so tools/test-kapost-moderation.mjs can run it; the
// Terms' screen builds its own elements when asked, and its look is in ui/kapost-terms.css.

/** Where reports go, and the Terms' contact line (iOS ContentReport.supportEmail). */
export const SUPPORT_EMAIL = "kaspasilver@gmail.com";

// ---- reports (iOS ContentReport.swift) ---------------------------------------------------------

export function reportMailUrl(body) {
  return `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent("KaPost report")}&body=${encodeURIComponent(body)}`;
}

/** iOS KaPostCellView.reportPost. */
export function postReportBody(post) {
  return [
    "I want to report this post.",
    "",
    `Post: ${post.remoteId || "not yet on chain"}`,
    `Author: ${post.posterAddress}`,
    `Text: ${String(post.text || "").slice(0, 500)}`,
    "",
    "What is wrong with it:",
    "",
  ].join("\n");
}

/** iOS PublicChatChannelView.reportMessage: the message's id, room, sender and text. */
export function roomMessageReportBody({ channel, txId, senderAddress, text }) {
  return [
    "I want to report this public chat message.",
    "",
    `Room: #${channel}`,
    `Message: ${txId}`,
    `Sender: ${senderAddress}`,
    `Text: ${String(text || "").slice(0, 500)}`,
    "",
    "What is wrong with it:",
    "",
  ].join("\n");
}

function openMailUrl(url) {
  const link = document.createElement("a");
  link.href = url;
  link.click();
}

/**
 * Sends a report (iOS ContentReport.send + contentReportFallback). iOS asks the system whether a
 * mail account exists and only then falls back to copying. A browser can't tell whether anything
 * answers a mailto: link, so here every report does both: it is copied, the email opens if there is
 * something to open it, and the same alert says where to send it, with Open Email still on it for
 * another mail app. Copying and opening both start before the first await, while the click that
 * asked for them still counts.
 *
 * `confirm` is confirmDialog from ui/dialogs.js; `openUrl` is only replaced by the test.
 */
export async function sendContentReport(body, { copyText, confirm, openUrl = openMailUrl }) {
  const url = reportMailUrl(body);
  let copying;
  try { copying = Promise.resolve(copyText(body)); } catch (error) { copying = Promise.reject(error); }
  openUrl(url);
  let copied = true;
  try { await copying; } catch { copied = false; }
  const again = await confirm(copied
    ? {
      title: "Report Copied",
      message: `If no email opened, paste the report into an email to ${SUPPORT_EMAIL}.`,
      confirmLabel: "Open Email",
      cancelLabel: "OK",
    }
    : {
      title: "Report",
      message: `If no email opened, send this to ${SUPPORT_EMAIL}:\n\n${body}`,
      confirmLabel: "Open Email",
      cancelLabel: "OK",
    });
  if (again === true) openUrl(url);
  return copied;
}

// ---- blocking (iOS KaPostsModerationStore, PublicChatStore.blockedSenders) ---------------------

/** A block supersedes a mute: no need to track both (iOS KaPostsModerationStore.block). */
export function withBlockedAccount(prefs, address) {
  return {
    ...prefs,
    blocked: [...new Set([...prefs.blocked, address])],
    muted: prefs.muted.filter((entry) => entry !== address),
  };
}

/** Everyone whose messages a room leaves out: its own hides plus blocked accounts. */
export function roomHiddenSenders(roomHides, blocked) {
  return new Set([...(roomHides || []), ...(blocked || [])]);
}

// ---- Terms of Use (iOS TermsOfUseView.swift) ---------------------------------------------------

// Bump the version when the text changes, and everyone is asked again. The key is iOS's: agreeing
// belongs to this device, not to an account.
export const KAPOST_TERMS_VERSION = 1;
export const KAPOST_TERMS_ACCEPTED_KEY = "kaposts_terms_accepted_version";

export const KAPOST_TERMS_SECTIONS = [
  {
    title: "No objectionable content or abuse",
    text: "KaPost has no tolerance for objectionable content or abusive users. You may not post anything that is illegal, sexual content involving children, hate speech, threats, harassment, content that encourages violence or self-harm, or scams. Accounts that do can be removed from what KaPost shows, without notice.",
  },
  {
    title: "Your posts are public and permanent",
    text: "Posts, replies, likes and room messages are public transactions on the Kaspa network. You are responsible for what you post. Deleting a post removes it from KaPost, but nobody can erase a transaction from the network.",
  },
  {
    title: "Reporting and blocking",
    text: "Use Report on a post or room message to tell us about objectionable content; a person reads every report. Use Block to stop seeing an account's posts and room messages. We can remove content and accounts from the KaChat indexer, which KaPost reads by default.",
  },
  {
    title: "Your account and your funds",
    text: "Your account is a seed phrase kept on your device. We never have it, so we can't recover a lost one or reverse a transaction. Posting pays a network fee in KAS, and you are responsible for the funds you hold and send.",
  },
  {
    title: "No warranty",
    text: "KaPost is provided as it is, without warranty, and to the extent the law allows we are not liable for losses from using it or from what other users post. These terms are between you and KaPost's developer.",
  },
  {
    title: "Contact",
    text: `Questions and reports: ${SUPPORT_EMAIL}`,
  },
];

export function kaPostTermsAccepted(storage = globalThis.localStorage) {
  try { return Number(storage.getItem(KAPOST_TERMS_ACCEPTED_KEY)) >= KAPOST_TERMS_VERSION; } catch { return false; }
}

export function acceptKaPostTerms(storage = globalThis.localStorage) {
  try { storage.setItem(KAPOST_TERMS_ACCEPTED_KEY, String(KAPOST_TERMS_VERSION)); } catch { /* asked again next time */ }
}

/** The terms' text, shared by the first-open screen and Settings (iOS KaPostTermsText). No text
 *  here comes from outside this file, so it needs no escaping beyond the apostrophes HTML allows. */
export function kaPostTermsHtml() {
  return `<div class="kapost-terms-text">${KAPOST_TERMS_SECTIONS.map((section) => `
    <section>
      <h3>${section.title}</h3>
      <p>${section.text}</p>
    </section>`).join("")}</div>`;
}

let termsCover = null;

/**
 * The Terms' screen (iOS TermsAcceptanceView). On iOS it is the first thing the KaPost app shows;
 * Desktop is one app, so it comes up the first time someone opens KaPost or a public room, and
 * `onAgree` then carries on to what they were opening. Unlike iOS there is a way out, Not Now (or
 * Escape): the rest of the app doesn't depend on these terms, so nothing here should hold it up.
 */
export function askKaPostTerms({ onAgree = null } = {}) {
  // Asked again while it is up (a second tap, a link): the latest destination wins.
  if (termsCover) { termsCover.onAgree = onAgree; return; }
  const el = document.createElement("div");
  el.className = "kapost-terms-cover";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-modal", "true");
  el.setAttribute("aria-labelledby", "kapost-terms-title");
  el.innerHTML = `
    <div class="kapost-terms-card">
      <h1 id="kapost-terms-title" class="kapost-terms-title">Terms of Use</h1>
      <div class="kapost-terms-scroll">${kaPostTermsHtml()}</div>
      <div class="kapost-terms-footer">
        <p>You need to agree to use KaPost.</p>
        <button class="primary-button kapost-terms-agree" type="button" data-kapost-terms-agree>I Agree</button>
        <button class="kapost-terms-later" type="button" data-kapost-terms-later>Not Now</button>
      </div>
    </div>`;
  const restoreFocus = document.activeElement;
  const close = () => {
    window.removeEventListener("keydown", onKey, true);
    el.remove();
    termsCover = null;
    try { restoreFocus?.focus?.(); } catch { /* it went away */ }
  };
  const onKey = (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopImmediatePropagation();
    close();
  };
  termsCover = { onAgree };
  el.addEventListener("click", (event) => {
    if (event.target.closest("[data-kapost-terms-later]")) { close(); return; }
    if (!event.target.closest("[data-kapost-terms-agree]")) return;
    const carryOn = termsCover?.onAgree;
    acceptKaPostTerms();
    close();
    carryOn?.();
  });
  window.addEventListener("keydown", onKey, true);
  document.body.appendChild(el);
  el.querySelector("[data-kapost-terms-agree]")?.focus();
}
