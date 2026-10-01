// .kachat - the marketplace for KaChat's own names, a 1:1 port of iOS KachatMarketView,
// KachatListingDetailView, KachatBuySheet and KachatOfferSheet (Kaspa Hub > .kachat on iOS; here
// the .kachat row under Your Domains).
//
// UI only, as on iOS. Nothing is wired yet: search answers "Registration isn't open yet",
// listings, offers and activity are placeholder skeletons, and every final action is disabled.
// No invented names or prices anywhere - the skeletons are redacted shapes (iOS
// .redacted(reason: .placeholder)), so nothing here can be mistaken for a real listing.

import { app, esc, render, $, ICONS, navHeader } from "./ui.js";

// SF Symbols used by the marketplace, drawn to match.
const SYMBOLS = {
  tag: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9z"/><circle cx="7.5" cy="7.5" r="1.5" fill="currentColor"/></svg>',
  cart: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 3h3l2.5 12h11L21 7H6"/><circle cx="9" cy="20" r="1.5"/><circle cx="18" cy="20" r="1.5"/></svg>',
  at: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8"/></svg>',
  arrows: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 4L3 8l4 4M3 8h14M17 12l4 4-4 4M21 16H7"/></svg>',
  atPlus: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="10" cy="12" r="3.5"/><path d="M13.5 8.5v4.5a2.5 2.5 0 0 0 4.5 1.5M17 15.5a8.5 8.5 0 1 1 1.5-7"/><path d="M20 2.5v5M17.5 5h5"/></svg>',
  hand: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V12M11 11V4a1.5 1.5 0 0 1 3 0v7M14 11V5.5a1.5 1.5 0 0 1 3 0V13"/><path d="M17 9.5a1.5 1.5 0 0 1 3 0V15a7 7 0 0 1-7 7h-1a7 7 0 0 1-5.6-2.8L3.7 15.6a1.6 1.6 0 0 1 2.4-2.1L8 15"/></svg>',
  shield: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2l8 3v6c0 5-3.4 9.3-8 11-4.6-1.7-8-6-8-11V5l8-3z"/><path d="M8.5 12l2.5 2.5 4.5-5"/></svg>',
  question: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M9.2 9.2a3 3 0 0 1 5.6 1.3c0 2-2.8 2.5-2.8 4"/><circle cx="12" cy="17.6" r=".8" fill="currentColor"/></svg>',
  lock: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
  bubbles: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M3 5.5A2.5 2.5 0 0 1 5.5 3h8A2.5 2.5 0 0 1 16 5.5v5a2.5 2.5 0 0 1-2.5 2.5H8l-3.5 3V13A2.5 2.5 0 0 1 3 10.5z"/><path d="M19 8.5a2 2 0 0 1 2 2v5a2 2 0 0 1-1.5 2V21l-3.2-2.5H11a2 2 0 0 1-2-2"/></svg>',
};

/** The ".kachat" wordmark (iOS KachatTabIcon): heavy rounded type in the accent colour. */
export function kachatWordmark(side) {
  return `<span class="kachat-wordmark" style="font-size:${Math.round(side * 0.62)}px;height:${side}px">.kachat</span>`;
}

const redact = (text) => `<span class="redacted">${esc(text)}</span>`;
const pill = () => '<span class="coming-pill">Coming soon</span>';
const header = (title, detail) => `
  <div class="km-header"><div class="km-title">${esc(title)}</div>${detail ? `<div class="muted tiny">${esc(detail)}</div>` : ""}</div>`;

let page = "market"; // kept while you go into a listing and back, like iOS @State

export function showKachatMarket({ onBack }) {
  const state = { search: "" };
  const back = () => showKachatMarket({ onBack });

  const searchResult = () => {
    const typed = state.search.trim().toLowerCase();
    if (!typed) return "";
    return `
      <div class="km-card km-search-result">
        <div class="tx-meta"><span class="strong ellipsis">${esc(typed)}.kachat</span><span class="muted tiny">Registration isn't open yet.</span></div>
        <button class="km-prominent small-button" disabled>Claim</button>
      </div>`;
  };

  const featured = () => `
    <button class="km-featured" data-listing>
      <div class="km-featured-card">${redact("name.kachat")}</div>
      <div class="strong small">${redact("000 KAS")}</div>
      <div class="accent tiny strong">${redact("Buy")}</div>
    </button>`;

  const listingRow = () => `
    <button class="km-row" data-listing>
      <span class="km-dot"></span>
      <span class="tx-meta"><span class="strong small">${redact("somename.kachat")}</span><span class="tiny">${redact("listed 1h ago")}</span></span>
      <span class="strong small">${redact("000 KAS")}</span>
      <span class="km-chevron">${ICONS.chevron}</span>
    </button>`;

  const marketPage = () => `
    ${header("Featured", "Names their owners have put up for sale.")}
    <div class="km-hscroll">${featured().repeat(4)}</div>
    ${header("Recently listed")}
    <div class="km-card km-list">${Array.from({ length: 5 }, listingRow).join("")}</div>
    <button class="km-bordered with-icon" disabled>${SYMBOLS.tag}<span>List a Name for Sale</span></button>
    <p class="muted small center-text">Listings appear here once .kachat names launch.</p>`;

  const myNamesPage = () => `
    <div class="km-empty">
      <span class="accent">${ICONS.atCircle}</span>
      <div class="km-title">No .kachat names yet</div>
      <p class="muted small">Names you claim or buy show here. From here you'll set one as your name in chats, list it for sale, or send it to someone.</p>
      <button class="km-prominent" disabled>Claim a Name</button>
    </div>
    ${header("Offers", "Offers you've made, and offers on names you own. Accept one, or withdraw your own, from here.")}
    <div class="km-card km-empty-card muted small">No offers yet.</div>`;

  const activityPage = () => `
    ${header("Recent activity", "Claims, listings and sales across the marketplace.")}
    <div class="km-card km-list">
      ${["tag", "cart", "at", "arrows"].map((icon) => `
        <div class="km-row">
          <span class="accent km-icon">${SYMBOLS[icon]}</span>
          <span class="tx-meta"><span class="strong small">${redact("somename.kachat sold")}</span><span class="tiny">${redact("2h ago")}</span></span>
          <span class="small">${redact("000 KAS")}</span>
        </div>`).join("")}
    </div>
    <p class="muted small center-text">Activity appears here once .kachat names launch.</p>`;

  const paint = () => {
    const scroll = app.querySelector(".km")?.scrollTop || 0;
    render(`
      <header class="navbar">
        <button class="nav-back" id="back" aria-label="Back">${ICONS.back}<span>Back</span></button>
        <div class="nav-title">.kachat</div>
        <button class="icon plain nav-right accent" id="how" aria-label="How it works">${SYMBOLS.question}</button>
      </header>
      <section class="km">
        <div class="km-hero">
          ${kachatWordmark(64)}
          <h2>Your name on KaChat</h2>
          <p class="muted small">Claim a .kachat name, or buy and sell them peer to peer. The name and the payment settle together on Kaspa - nobody holds either in between.</p>
          ${pill()}
        </div>
        <div class="km-search">
          <label class="km-card km-search-field">
            <span class="muted">${ICONS.search}</span>
            <input id="search" value="${esc(state.search)}" placeholder="Find a name" autocomplete="off" autocapitalize="off" spellcheck="false" />
            <span class="muted strong">.kachat</span>
          </label>
          <div id="search-result">${searchResult()}</div>
        </div>
        <div class="underline-tabs" role="tablist">
          ${[["market", "Marketplace"], ["myNames", "My Names"], ["activity", "Activity"]].map(([id, title]) =>
            `<button role="tab" data-page="${id}" aria-selected="${id === page}">${title}</button>`).join("")}
        </div>
        <div class="km-page">${page === "market" ? marketPage() : page === "myNames" ? myNamesPage() : activityPage()}</div>
      </section>`, "kachat-market");
    const scroller = app.querySelector(".km");
    if (scroller) scroller.scrollTop = scroll;
    $("#back").onclick = onBack;
    $("#how").onclick = showHowItWorks;
    const search = $("#search");
    search.oninput = () => { state.search = search.value; $("#search-result").innerHTML = searchResult(); };
    for (const tab of app.querySelectorAll("[data-page]")) tab.onclick = () => { page = tab.dataset.page; paint(); };
    for (const listing of app.querySelectorAll("[data-listing]")) listing.onclick = () => showListing({ onBack: back });
  };
  paint();
}

// --- How it works (sheet) ------------------------------------------------------------------

function showHowItWorks() {
  const rows = [
    ["atPlus", "Claim", "Pick a free name and register it on Kaspa. It's yours: your name in chats, your profile, your link."],
    ["tag", "List", "Set a price. The name waits in an on-chain covenant, not with KaChat or anyone else, until someone buys it or you take it back."],
    ["cart", "Buy", "Pay the listed price. The payment reaches the seller and the name reaches you in the same transaction - both happen, or neither does."],
    ["hand", "Offer", "Name your own price. Your KAS waits on chain until the seller accepts, you withdraw the offer, or it expires - and you can message the seller first."],
    ["shield", "Trustless", "No middleman and no escrow account: Kaspa's own rules enforce every sale."],
  ];
  openPanel({
    title: "How .kachat works",
    trailing: "Done",
    body: `
      <div class="km-card km-how">
        ${rows.map(([icon, title, detail]) => `
          <div class="km-how-row">
            <span class="accent km-how-icon">${SYMBOLS[icon]}</span>
            <span class="tx-meta"><span class="strong small">${esc(title)}</span><span class="muted small">${esc(detail)}</span></span>
          </div>`).join("")}
      </div>
      <p class="form-footer">Nothing here is live yet.</p>`,
  });
}

// --- Listing (iOS KachatListingDetailView) --------------------------------------------------

function showListing({ onBack }) {
  const rows = (icon, line, trailing) => `
    <div class="km-row">
      <span class="accent km-icon">${SYMBOLS[icon]}</span>
      ${line}
      ${trailing}
    </div>`;
  render(`
    ${navHeader({ title: "Listing" })}
    <section class="km">
      <div class="km-card km-name-card">
        <div class="km-name-banner">${redact("name.kachat")}</div>
        <div class="km-price-row">
          <div class="tx-meta"><span class="muted tiny">Price</span><span class="km-price">${redact("000 KAS")}</span></div>
          <span class="tiny">${redact("listed 1h ago")}</span>
        </div>
        ${pill()}
      </div>
      <div class="km-actions">
        <button class="km-prominent with-icon" id="buy">${SYMBOLS.cart}<span>Buy Now</span></button>
        <button class="km-bordered with-icon" id="offer">${SYMBOLS.hand}<span>Make an Offer</span></button>
      </div>
      ${header("Seller")}
      <div class="km-card km-seller">
        <span class="km-dot big"></span>
        <span class="tx-meta"><span class="strong small">${redact("kaspa:xxxx....xxxx")}</span><span class="muted tiny">Ask about the name, or agree on a price before you offer.</span></span>
        <button class="km-bordered small-button with-icon" disabled>${SYMBOLS.bubbles}<span>Message</span></button>
      </div>
      ${header("Offers", "Open offers on this name, highest first. The seller can accept any of them.")}
      <div class="km-card km-list">
        ${Array.from({ length: 3 }, () => rows("hand",
          `<span class="tx-meta"><span class="strong small">${redact("kaspa:xxxx....xxxx")}</span><span class="tiny">${redact("expires in 2d")}</span></span>`,
          `<span class="strong small">${redact("000 KAS")}</span>`)).join("")}
      </div>
      ${header("History")}
      <div class="km-card km-list">
        ${["tag", "arrows", "atPlus"].map((icon) => rows(icon,
          `<span class="tx-meta"><span class="small">${redact("listed by kaspa:xxxx")}</span></span>`,
          `<span class="tiny">${redact("3d ago")}</span>`)).join("")}
      </div>
      <div class="km-notes muted small">
        <div>${SYMBOLS.cart}<span>Buying pays the seller and moves the name to you in one transaction.</span></div>
        <div>${SYMBOLS.lock}<span>An offer locks your KAS on chain until the seller accepts it, you withdraw it, or it expires.</span></div>
        <div>${SYMBOLS.bubbles}<span>Messages go to the seller like any KaChat chat.</span></div>
      </div>
    </section>`, "kachat-listing");
  $("#back").onclick = onBack;
  // Buy Now and Make an Offer open their sheets so the flow can be looked at; their final
  // buttons are disabled until names launch.
  $("#buy").onclick = showBuy;
  $("#offer").onclick = showOffer;
}

function summaryRow(title, value, bold = false) {
  return `<div class="form-row between"><span class="${bold ? "strong" : ""}">${esc(title)}</span><span class="${bold ? "strong" : ""}">${redact(value)}</span></div>`;
}

function showBuy() {
  openPanel({
    title: "Buy Name",
    leading: "Cancel",
    full: true, // full height with Cancel top left, like Make an Offer (iOS 6dd5578)
    body: `
      <div class="form-section">
        <div class="form-card">
          ${summaryRow("Name", "name.kachat")}
          ${summaryRow("Price", "000 KAS")}
          ${summaryRow("Network fee", "0.0000 KAS")}
          ${summaryRow("Total", "000 KAS", true)}
        </div>
        <div class="form-footer">The payment reaches the seller and the name reaches you in the same transaction - both happen, or neither does.</div>
      </div>
      <div class="form-section">
        <div class="form-card"><button class="form-row km-form-button" disabled>Confirm Purchase</button></div>
        <div class="form-footer">Buying opens when .kachat names launch.</div>
      </div>`,
  });
}

function showOffer() {
  const expiries = [["1d", "1 Day"], ["3d", "3 Days"], ["7d", "7 Days"], ["30d", "30 Days"]];
  openPanel({
    title: "Make an Offer",
    leading: "Cancel",
    full: true,
    body: `
      <div class="form-section">
        <div class="form-card">
          ${summaryRow("Name", "name.kachat")}
          ${summaryRow("Listed at", "000 KAS")}
        </div>
      </div>
      <div class="form-section">
        <div class="form-header">Your offer</div>
        <div class="form-card"><div class="form-row"><input class="plain-input km-offer-amount" inputmode="decimal" placeholder="0" /><span class="muted">KAS</span></div></div>
        <div class="form-footer">Your KAS stays locked on chain until the seller accepts, you withdraw the offer, or it expires. Nobody else can touch it.</div>
      </div>
      <div class="form-section">
        <div class="form-header">Expires after</div>
        <div class="form-card"><div class="form-row">
          <div class="segmented wide km-expiry" role="radiogroup" aria-label="Expires after">
            ${expiries.map(([id, label]) => `<button type="button" role="radio" data-expiry="${id}" aria-checked="${id === "3d"}">${label}</button>`).join("")}
          </div>
        </div></div>
      </div>
      <div class="form-section">
        <div class="form-card"><button class="form-row km-form-button" disabled>Send Offer</button></div>
        <div class="form-footer">Offers open when .kachat names launch.</div>
      </div>`,
    onMount(panel) {
      // The amount and expiry can be set so the form can be tried, as on iOS.
      for (const option of panel.querySelectorAll("[data-expiry]")) {
        option.onclick = () => {
          for (const other of panel.querySelectorAll("[data-expiry]")) other.setAttribute("aria-checked", String(other === option));
        };
      }
      const amount = panel.querySelector(".km-offer-amount");
      amount.oninput = () => { amount.value = amount.value.replace(/[^\d.]/g, ""); };
    },
  });
}

/** An iOS sheet with its own navigation bar: Cancel on the left or Done on the right. */
function openPanel({ title, leading = null, trailing = null, body, onMount = null, full = false }) {
  document.querySelector(".panel-backdrop")?.remove();
  const backdrop = document.createElement("div");
  backdrop.className = "panel-backdrop";
  backdrop.innerHTML = `
    <div class="panel ${full ? "full" : ""}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="sheet-grabber"></div>
      <header class="panel-bar">
        ${leading ? `<button class="bar-text" data-close>${esc(leading)}</button>` : "<span></span>"}
        <div class="nav-title">${esc(title)}</div>
        ${trailing ? `<button class="bar-text strong" data-close>${esc(trailing)}</button>` : "<span></span>"}
      </header>
      <div class="panel-body form">${body}</div>
    </div>`;
  const close = () => { backdrop.remove(); document.removeEventListener("keydown", onKey); };
  const onKey = (event) => { if (event.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);
  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop || event.target.closest("[data-close]")) close();
  });
  document.body.appendChild(backdrop);
  onMount?.(backdrop.querySelector(".panel"));
}
