// Kaspa Hub > KaChat Bots (iOS KaChatBotsView, 82ab31d / 7dd508a / 64ce0c7 / d576941 / 5fcf755).
// One card per bot; clicking a card opens (or starts) the 1:1 chat with it, accepted and named
// after the bot. A bot is a Kaspa address that answers in an ordinary chat (the KaChat-Bot repo, run
// from the Kaspa Quick Start panel); it asks its setup questions in the chat. Bots run on mainnet
// only. Bot chats never sit in the chat list: once you have written to one it is a circle in the
// row above it (app.js visibleChatCircles), and each card here carries the chat's unread count.

import { isNetworkAddress, isValidKaspaAddress } from "../engine/network.js";

const svg = (body) => `<svg viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;

/** SF Symbol stand-ins (stroke glyphs, currentColor). Trusted markup. */
export const KACHAT_BOT_ICONS = {
  // cpu (iOS AppTab.kachatBots)
  cpu: svg('<rect x="6.5" y="6.5" width="11" height="11" rx="2"/><rect x="9.6" y="9.6" width="4.8" height="4.8" rx=".8"/><path d="M9.5 3.5v3M14.5 3.5v3M9.5 17.5v3M14.5 17.5v3M3.5 9.5h3M3.5 14.5h3M17.5 9.5h3M17.5 14.5h3"/>'),
  // cube.transparent
  cube: svg('<path d="M12 2.8 20 7.3v9.4L12 21.2l-8-4.5V7.3Z"/><path d="m4 7.3 8 4.5 8-4.5M12 11.8v9.4"/><path d="M12 2.8v9M4 16.7l8-4.6 8 4.6" opacity=".45"/>'),
  // wallet.pass
  wallet: svg('<rect x="3" y="6.5" width="18" height="13.5" rx="2.5"/><path d="M3 11h18"/><path d="M6 6.5V5.2A1.7 1.7 0 0 1 7.7 3.5h8.6A1.7 1.7 0 0 1 18 5.2v1.3"/>'),
  // chart.line.uptrend.xyaxis
  chart: svg('<path d="M3.5 3.5v17h17"/><path d="m7 15.5 4-4.5 3 3 6-7"/>'),
  // questionmark.bubble
  question: svg('<path d="M12 3.5c-4.97 0-9 3.36-9 7.5 0 2.2 1.14 4.18 2.95 5.55L5.2 20.5l4.07-1.97c.87.2 1.78.3 2.73.3 4.97 0 9-3.36 9-7.5S16.97 3.5 12 3.5Z"/><path d="M10.1 8.9a2 2 0 1 1 2.75 1.85c-.55.25-.85.7-.85 1.3v.25"/><path d="M12 14.6v.1"/>'),
  chevron: svg('<path d="m9 6 6 6-6 6"/>'),
};

/** The bots Kaspa Hub > KaChat Bots lists, in this order (iOS KaChatBot.all). The addresses are
 *  the mainnet ones (iOS 64ce0c7), checksums verified with engine/network.js. */
export const KACHAT_BOTS = [
  {
    id: "block-rewards",
    name: "Block Reward Tracker",
    summary: "A message for every block reward paid to your mining address.",
    icon: "cube",
    address: "kaspa:qram07v34rnfwthwc7vssvgapxtdy9mheg8mz0v0yudqtm8z94sv5upwasd8q",
  },
  {
    id: "wallet",
    name: "Wallet Tracker",
    summary: "Tells you when a watched address receives or sends KAS.",
    icon: "wallet",
    address: "kaspa:qzh3m296f44ez75avxd4k0dyvv5hj6sf06cuzaty5hk89w9nsprr6nngjsfvq",
  },
  {
    // Between Wallet Tracker and Kaspa Answers (iOS 7dd508a).
    id: "price",
    name: "Price Bot",
    summary: "Alerts when KAS crosses your price, big moves and a daily summary.",
    icon: "chart",
    address: "kaspa:qzk2jrk7wq3zdw2n0260v87fglky82cg5u3pwy73wpktk3u864yecm5djll40",
  },
  {
    id: "kaspa-answers",
    name: "Kaspa Answers",
    summary: "Ask anything related to Kaspa.",
    icon: "question",
    address: "kaspa:qqj0vdfxv66xad0j382jeur2jpdpsjej2qzqzwaxtw66h2f3zg0djndh8ypq8",
  },
];

const BOT_ADDRESSES = new Set(KACHAT_BOTS.map((bot) => bot.address.toLowerCase()));

/** The bot at `address`, or null. */
export function kachatBotFor(address) {
  const key = String(address || "").toLowerCase();
  if (!key || !BOT_ADDRESSES.has(key)) return null;
  return KACHAT_BOTS.find((bot) => bot.address.toLowerCase() === key) || null;
}

/** True for a bot's address. Bot chats never sit in the chat list: they are circles in the row
 *  above it (with groups and rooms), once you have written to the bot (iOS d576941 / 5fcf755). */
export function isKachatBot(address) {
  return BOT_ADDRESSES.has(String(address || "").toLowerCase());
}

/** Why the bot can't be messaged from here, or null when it can (iOS unavailableReason). */
export function kachatBotUnavailableReason(bot) {
  if (!bot?.address) return "Coming soon.";
  if (!isValidKaspaAddress(bot.address) || !isNetworkAddress(bot.address)) return "Bots run on mainnet only.";
  return null;
}

/** The bot's glyph (trusted markup). */
export function kachatBotIconHtml(bot) {
  return KACHAT_BOT_ICONS[bot?.icon] || KACHAT_BOT_ICONS.cpu;
}

let deps = null;
let screenEl = null;
let active = false;
let lastHtml = "";

const esc = (value) => (deps?.escapeHtml ? deps.escapeHtml(String(value ?? "")) : String(value ?? "")
  .replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])));

function unreadFor(bot) {
  if (!bot.address) return 0;
  try { return Math.max(0, Number(deps?.unreadFor?.(bot.address) || 0)); } catch { return 0; }
}

function cardHtml(bot) {
  const unavailable = kachatBotUnavailableReason(bot);
  // The badge shows on an unavailable card too (iOS KaChatBotCard takes unread either way).
  const unread = unreadFor(bot);
  const hint = unavailable || "Opens a chat with this bot.";
  return `
    <button type="button" class="kb-card" data-kb-open="${esc(bot.id)}"${unavailable ? " disabled" : ""} title="${esc(hint)}">
      <span class="kb-card-icon">${kachatBotIconHtml(bot)}</span>
      <span class="kb-card-copy">
        <strong>${esc(bot.name)}</strong>
        <small>${esc(unavailable || bot.summary)}</small>
      </span>
      ${unread > 0 ? `<b class="kb-card-badge" aria-label="${esc(`${unread} unread`)}">${unread > 99 ? "99+" : unread}</b>` : ""}
      ${unavailable ? "" : `<span class="kb-card-chevron">${KACHAT_BOT_ICONS.chevron}</span>`}
    </button>`;
}

function render() {
  if (!screenEl || !active) return;
  const html = `
    <div class="kaposts-header kb-header">
      <h1 class="kaposts-title">KaChat Bots</h1>
    </div>
    <div class="kb-body">
      ${KACHAT_BOTS.map(cardHtml).join("")}
      <p class="kb-footnote">Messages to a bot are ordinary encrypted KaChat messages, so each one costs the usual network fee.</p>
    </div>`;
  // Unchanged cards are left alone, so a repaint for an unrelated chat does not reset hover.
  if (html !== lastHtml || !screenEl.firstElementChild) { screenEl.innerHTML = html; lastHtml = html; }
}

function attachScreen() {
  screenEl = document.querySelector("[data-kachat-bots]");
  if (!screenEl || screenEl.dataset.kbBound) return;
  screenEl.dataset.kbBound = "1";
  screenEl.classList.add("kb-screen");
  screenEl.addEventListener("click", (event) => {
    const card = event.target instanceof Element ? event.target.closest("[data-kb-open]") : null;
    if (!card) return;
    const bot = KACHAT_BOTS.find((entry) => entry.id === card.getAttribute("data-kb-open"));
    if (!bot || kachatBotUnavailableReason(bot)) return;
    try { deps?.openBot?.(bot); } catch { /* the host shows its own errors */ }
  });
}

/** deps: { escapeHtml, unreadFor(address), openBot(bot) } */
export function initKachatBots(dependencies) {
  deps = dependencies;
  attachScreen();
  // The startup tab restore can show this screen before the app got round to starting it.
  if (screenEl && !screenEl.hidden) { active = true; render(); }
}

export function showKachatBots() {
  if (!deps) return;
  attachScreen();
  active = true;
  lastHtml = "";
  render();
}

export function hideKachatBots() {
  active = false;
}

/** A chat's unread count changed: the cards on screen repaint. */
export function refreshKachatBots() {
  if (active) render();
}
