// KaChat Wallet popup (and the same page opened as a full tab with ?view=tab): boot and the home
// screen, which is the iOS Profile tab. Sign-in, create and import live in onboarding.js; Send
// and Manage in send.js / manage.js; Your Domains in domains.js; Settings in settings.js.

import { ext, isExtension, tellBackground } from "./browser.js";
import * as vault from "./vault.js";
import * as wallet from "./wallet.js";
import {
  app, isTab, esc, render, $, toast, copyText, settings, noteActivity, ICONS, showQr, showQrPending, showSheet,
} from "./ui.js";
import { showSend } from "./send.js";
import { showManageAddress, showManageAddresses } from "./manage.js";
import { cachedOwnedNames, ownedNames, otherNamesCount } from "./names.js";
import { showWelcome, showUnlock, enterApp, setHandlers, setLoggedOut } from "./onboarding.js";
import { showDomains } from "./domains.js";
import { showKachatMarket, kachatWordmark } from "./market.js";
import { showSettings, showLicenses } from "./settings.js";
import { showApproval } from "./approve.js";

const params = new URLSearchParams(location.search);
const isApproval = params.get("view") === "approve";

// --- boot --------------------------------------------------------------------------------

async function boot() {
  if (!isExtension) {
    render('<section class="screen center"><p class="center-text">Open this page from the KaChat Wallet extension.</p></section>');
    return;
  }
  // Start the 12 MB WASM download/compile now, while the first screen is up.
  wallet.kaspa().catch(() => {});
  wallet.useExplorer((await settings()).explorer);
  // A website's request (background.js opened this window for it).
  if (isApproval) return showApproval(params.get("id") || "");
  if (!(await vault.hasVault())) return showWelcome();
  if (!(await vault.isUnlocked())) return showUnlock();
  noteActivity();
  return enterApp();
}

setHandlers({
  home: () => showHome(),
  settings: (opts) => showSettings(opts),
});

// The wallet can lock under an open popup (auto-lock alarm, or the lock button in another
// window): the unlock key disappears from storage.session, and the popup follows.
ext?.storage?.onChanged?.addListener((changes, area) => {
  if (isApproval) return;
  if (area === "session" && changes["kachat.unlockKey"] && !changes["kachat.unlockKey"].newValue) {
    wallet.disconnect();
    showUnlock();
  }
});

// --- home: the iOS Profile tab ------------------------------------------------------------
//
// Section for section as ProfileView lays it out: the toolbar (connection dot, balance in the
// middle - lock and expand where iOS has the notification bell, which is chat-only), the pinned
// "Profile" title with the share button, then account name, profile hero, the two QR buttons,
// the Chatting and Spending rows, Your Domains, Settings, Log Out and About. Help is left out:
// its guides are the chat Welcome Guide and the KNS setup guide.
//
// No Create / Edit KNS Profile: profile creation is moving to .kachat names, which do not exist
// yet. Like iOS (5.2), only a .kas domain's NAME is read - no avatar, banner or bio: full
// profiles will come from .kachat. Your Domains counts .kas, .k and .kaspa names together.

let homeState = null;

function connectionDot(state) {
  const cls = state === "ok" ? "ok" : state === "bad" ? "bad" : "busy";
  const label = state === "ok" ? "Connected" : state === "bad" ? "Not connected" : "Connecting";
  return `<button class="dot-button" id="dot" aria-label="${label}" title="${label}"><span class="dot ${cls}"></span></button>`;
}

async function showHome() {
  const accounts = await vault.readAccounts().catch(() => null);
  if (!accounts) return showUnlock();
  const account = accounts.accounts.find((a) => a.id === accounts.activeAccountId) || accounts.accounts[0];
  const currency = (await settings()).currency || "usd";
  const cached = await wallet.cachedAddresses(account.id);
  const spending = await wallet.spendingState(account.id);
  homeState = {
    account,
    currency,
    addresses: cached,
    spending,
    balances: null,
    kns: cached?.main ? wallet.cachedKns(cached.main) : null,
    otherNames: cached?.main ? cachedOwnedNames(cached.main) : null,
    connection: "busy",
    editingName: false,
    error: "",
  };
  paintHome();
  refreshHome();
}

function spendingTotal(balances) {
  if (!balances) return null;
  return Object.values(balances.spending || {}).reduce((sum, value) => sum + BigInt(value || 0n), 0n);
}

function profileLinkFor(address) {
  return `https://kachat.app/u/${String(address || "").replace(/^kaspa:/, "")}`;
}

function paintHome() {
  const s = homeState;
  if (!s) return;
  const main = s.addresses?.main || null;
  const primary = s.addresses?.spending?.[s.spending.activeIndex] || null;
  const mainSompi = s.balances?.main;
  const primarySompi = s.balances ? (s.balances.spending[s.spending.activeIndex] ?? 0n) : null;
  const totalSpending = spendingTotal(s.balances);
  const kns = s.kns || {};
  // What other people see you as (iOS profileHeroSection): your .kachat name once you have one,
  // else your short address - never the account name (your own label), and since 5.2 not your
  // .kas name either (that is managed in Your Domains).
  const kachatName = null; // .kachat names are not live yet
  const displayName = kachatName || shortIdentity(main);
  const domainCount = kns.known ? kns.domainCount + otherNamesCount(s.otherNames) : null;
  const created = s.account.createdAt ? new Date(s.account.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "—";
  const version = ext?.runtime?.getManifest?.().version || "";

  render(`
    <div class="profile">
      <header class="toolbar">
        ${connectionDot(s.connection)}
        <button class="toolbar-balance" id="balance" aria-label="Copy balance">
          <img src="icons/kaspa-logo.png" alt="" />
          <span>${mainSompi != null ? esc(wallet.formatKas(mainSompi, 8)) : "--"} KAS</span>
        </button>
        <div class="toolbar-right">
          ${isTab ? "" : `<button class="icon" id="expand" aria-label="Open in a tab" title="Open in a tab">${ICONS.expand}</button>`}
          <button class="icon" id="lock" aria-label="Lock" title="Lock">${ICONS.lock}</button>
        </div>
      </header>
      <div class="profile-title">
        <h1>Profile</h1>
        <button class="share-circle" id="share" aria-label="Share your profile" title="Copy your profile link" ${main ? "" : "disabled"}>${ICONS.share}</button>
      </div>
      <section class="profile-body">
        <div class="account-row">
          ${s.editingName
            ? `<input id="account-name" value="${esc(s.account.name)}" maxlength="40" aria-label="Account name" autofocus />
               <button class="icon plain" id="save-name" aria-label="Save name">${ICONS.checkCircle}</button>`
            : `<span class="account-name">${esc(s.account.name)}</span>
               <button class="icon plain" id="edit-name" aria-label="Rename account">${ICONS.pencilCircle}</button>`}
        </div>

        <div class="glass hero">
          <div class="banner gradient"></div>
          <div class="hero-row">
            <div class="avatar avatar-glyph">${ICONS.person}</div>
          </div>
          <div class="hero-text">
            <div class="hero-name">${esc(displayName)}</div>
          </div>
        </div>

        <div class="qr-buttons">
          <button class="qr-button" id="receive" ${primary ? "" : "disabled"}>
            <span class="qr-circle">${ICONS.qrBig}</span><span>Receive Kaspa</span>
          </button>
          <button class="qr-button" id="chatting-qr" ${main ? "" : "disabled"}>
            <span class="qr-circle">${ICONS.qrBig}</span><span>Chatting Address</span>
          </button>
        </div>

        ${addressActionRowHtml("chatting", "Chatting", main, mainSompi != null ? `${wallet.formatKas(mainSompi, 8)} KAS` : null, null)}
        ${addressActionRowHtml("spending", "Spending", primary, primarySompi != null ? `${wallet.formatKas(primarySompi, 8)} KAS` : null, totalSpending != null ? `Total: ${wallet.formatKas(totalSpending, 8)} KAS` : null)}

        <button class="glass nav-row" id="domains">
          <span class="nav-row-label">${ICONS.at}<span>Your Domains</span></span>
          <span class="nav-row-value">${domainCount != null ? esc(String(domainCount)) : ""}</span>${ICONS.chevron}
        </button>
        <button class="glass nav-row" id="kachat-names">
          <span class="nav-row-label">${kachatWordmark(22)}<span>Marketplace</span></span>
          <span class="coming-pill">Coming soon</span>${ICONS.chevron}
        </button>
        <button class="glass nav-row" id="settings">
          <span class="nav-row-label">${ICONS.gear}<span>Settings</span></span>${ICONS.chevron}
        </button>
        <button class="glass nav-row danger-row" id="logout">
          <span>Log Out</span>${ICONS.logout}
        </button>

        <div class="section-header">About</div>
        <div class="glass list">
          <div class="list-row"><span>Created</span><span class="muted">${esc(created)}</span></div>
          <div class="list-row"><span>Version</span><span class="muted">${esc(version)}</span></div>
          <a class="list-row" href="https://linktr.ee/Kachat_" target="_blank" rel="noopener noreferrer"><span>Website</span><span class="muted">linktr.ee/Kachat_</span></a>
          <a class="list-row" href="mailto:kaspasilver@gmail.com"><span>Support Email</span><span class="muted">kaspasilver@gmail.com</span></a>
          <button class="list-row" id="donate"><span>Donate</span><span class="muted">kachat.kas</span></button>
          <button class="list-row" id="licenses"><span>Open Source Licenses</span>${ICONS.chevron}</button>
        </div>
      </section>
    </div>`, "home");

  $("#dot").onclick = () => toast(s.connection === "ok" ? `Connected to ${wallet.connectedNodeUrl().replace(/^wss:\/\//, "")}` : s.connection === "bad" ? "Can't reach a Kaspa node - retrying" : "Connecting to the Kaspa network…");
  $("#balance").onclick = () => { if (mainSompi != null) copyText(wallet.formatKas(mainSompi, 8), "Balance"); };
  $("#lock").onclick = lockWallet;
  const expand = $("#expand");
  if (expand) expand.onclick = async () => { await ext.tabs.create({ url: ext.runtime.getURL("popup.html?view=tab") }); window.close(); };
  if (main) $("#share").onclick = () => copyText(profileLinkFor(main), "Profile link");

  if (s.editingName) {
    const input = $("#account-name");
    const commit = async () => {
      const name = input.value.trim();
      s.editingName = false;
      if (name && name !== s.account.name) {
        const view = await vault.renameAccount(s.account.id, name);
        s.account = view.accounts.find((a) => a.id === s.account.id) || s.account;
        toast("Account renamed.");
      }
      paintHome();
    };
    $("#save-name").onclick = commit;
    input.onkeydown = (event) => { if (event.key === "Enter") commit(); if (event.key === "Escape") { s.editingName = false; paintHome(); } };
    input.select();
  } else {
    $("#edit-name").onclick = () => { s.editingName = true; paintHome(); };
  }

  // Receive hands out a never-used address (iOS ReceiveKaspaQRView over freshReceiveAddress):
  // "Preparing a fresh address" while it is worked out, then the white QR page with the
  // address's balance in the bar.
  if (primary) $("#receive").onclick = async () => {
    showQrPending({ onBack: showHome });
    let address;
    try { address = await wallet.freshReceiveAddress(); } catch { address = null; }
    if (app.dataset.screen !== "qr") return;
    if (!address) return showQrPending({ failed: true, onBack: showHome });
    let balanceSompi = null;
    try { balanceSompi = (await wallet.balancesFor([address]))[address] ?? null; } catch { /* unknown - nothing shown */ }
    if (app.dataset.screen !== "qr") return;
    showQr({
      address,
      balanceSompi,
      note: "A fresh address, never used before. Kaspa sent here lands in this account and shows in your spending total. This address should be used for everything not related to chatting or KNS profile creation.",
      onBack: showHome,
    });
  };
  if (main) $("#chatting-qr").onclick = () => showQr({
    address: main,
    balanceSompi: mainSompi,
    note: "This address is for chatting and KNS profile creation. Funding it with around 50 Kaspa is enough to create a KNS profile and send messages for a long time.",
    onBack: paintHome,
  });
  for (const [kind, address] of [["chatting", main], ["spending", primary]]) {
    const copy = $(`#copy-${kind}`);
    if (copy && address) copy.onclick = () => copyText(address);
  }
  const mainSource = { kind: "main" };
  const spendingSource = { kind: "spending", index: s.spending.activeIndex };
  // The Profile Send buttons: WithdrawKaspaView ("Send Kaspa") for the chatting address,
  // SpendingAddressWithdrawView ("Send Kaspa from Address #n") for the primary spending one.
  $("#send-chatting").onclick = () => {
    if (main) showSend({ source: mainSource, fromAddress: main, navTitle: "Send Kaspa", feeFooter: "If the network is busy, Fast or Priority pays a higher fee to help your withdrawal confirm sooner. Tap the fee amount to set a custom fee.", onClose: showHome });
  };
  $("#send-spending").onclick = () => {
    if (primary) showSend({ source: spendingSource, fromAddress: primary, navTitle: `Send Kaspa from Address #${s.spending.activeIndex}`, feeFooter: "If the network is busy, Fast or Priority pays a higher fee to help this confirm sooner. Tap the fee amount to set a custom fee.", onClose: showHome });
  };
  $("#manage-chatting").onclick = () => {
    if (!main) return;
    showManageAddress({
      address: main, onBack: showHome,
      onChangeIdentity: s.account.imported ? () => { homeState = null; showHome(); } : null,
    });
  };
  $("#manage-spending").onclick = () => showManageAddresses({ onBack: showHome });
  $("#domains").onclick = () => { if (main) showDomains({ address: main, onBack: showHome }); };
  $("#kachat-names").onclick = () => showKachatMarket({ onBack: showHome });
  $("#settings").onclick = () => showSettings({ onBack: showHome });
  $("#logout").onclick = () => showSheet({
    title: "Log Out",
    rows: [{
      label: "Log Out",
      subtitle: "Signs out of this account. Wallet data stays in this browser.",
      icon: ICONS.logout,
      danger: true,
      onClick: logOut,
    }],
  });
  // iOS Donate resolves kachat.kas and opens a payment to it; here, the Send screen from the
  // chatting address with kachat.kas filled in.
  $("#donate").onclick = () => { if (main) showSend({ source: mainSource, fromAddress: main, recipient: "kachat.kas", title: "Donate to KaChat", onClose: showHome }); };
  $("#licenses").onclick = () => showLicenses({ onBack: showHome });
}

// iOS Log Out: back to the accounts screen, where you pick an account (or add one). The vault
// stays unlocked; the lock button is what asks for the password again.
async function logOut() {
  await setLoggedOut(true);
  homeState = null;
  await wallet.disconnect();
  showWelcome();
}

async function lockWallet() {
  await vault.lock();
  tellBackground({ type: "lock" });
  await wallet.disconnect();
  showUnlock();
}

/** iOS Contact.generateDefaultAlias: "kaspa:" + the first 4 and last 4 of the address body. */
function shortIdentity(address) {
  const text = String(address || "");
  const colon = text.indexOf(":");
  if (colon < 0) return text || "…";
  const prefix = text.slice(0, colon);
  const body = text.slice(colon + 1);
  return body.length > 12 ? `${prefix}:${body.slice(0, 4)}....${body.slice(-4)}` : text;
}

// One address row: title + balance on the left (tapping it copies the address), then the
// Send and Manage circles - iOS addressActionRow.
function addressActionRowHtml(kind, title, address, balanceText, totalText) {
  return `
    <div class="glass address-action">
      <button class="address-copy" id="copy-${kind}" aria-label="Copy ${esc(title)} address" ${address ? "" : "disabled"}>
        <span class="address-title">${esc(title)}</span>
        ${address ? "" : '<span class="muted tiny">Address unlocking...</span>'}
        ${balanceText != null ? `<span class="address-balance">${esc(balanceText)}</span>` : '<span class="spinner small-spin"></span>'}
        ${totalText ? `<span class="muted tiny">${esc(totalText)}</span>` : ""}
      </button>
      <button class="circle-action" id="send-${kind}" aria-label="Send">${ICONS.sendCircle}</button>
      <button class="circle-action" id="manage-${kind}" aria-label="Manage">${ICONS.gear}</button>
    </div>`;
}

let refreshing = false;
async function refreshHome() {
  if (refreshing || !homeState) return;
  refreshing = true;
  const s = homeState;
  try {
    // Addresses first: derived from the phrase (a moment of CPU on first unlock), then cached.
    if (!s.addresses || s.addresses.accountId !== s.account.id || !s.addresses.spending?.[s.spending.maxIndex]) {
      s.addresses = await wallet.deriveAddresses();
      s.kns = wallet.cachedKns(s.addresses.main);
      s.otherNames = cachedOwnedNames(s.addresses.main);
      paintHomeIfShowing(s);
    }
    wallet.kns(s.addresses.main).then((info) => { s.kns = info; paintHomeIfShowing(s); }).catch(() => {});
    // .k / .kaspa names change rarely; the 30 s balance refresh asks for them every 5 minutes.
    if (!s.otherNamesAt || Date.now() - s.otherNamesAt > 5 * 60_000) {
      s.otherNamesAt = Date.now();
      ownedNames(s.addresses.main).then((owned) => { s.otherNames = owned; paintHomeIfShowing(s); }).catch(() => {});
    }
    try {
      await wallet.connection();
      s.connection = "ok";
      paintHomeIfShowing(s);
      s.balances = await wallet.balances(s.addresses, s.spending.hidden);
    } catch (error) {
      s.connection = "bad";
      console.warn("[KaChat Wallet] network:", error);
    }
  } catch (error) {
    s.error = error.message;
    toast(error.message);
  } finally {
    refreshing = false;
    paintHomeIfShowing(s);
  }
}

function paintHomeIfShowing(state) {
  // Only repaint when the home screen for this state is what's on screen, and never under
  // someone typing a new account name.
  if (homeState === state && app.dataset.screen === "home" && !state.editingName) {
    const scroller = app.querySelector(".profile-body");
    const scrollTop = scroller?.scrollTop || 0;
    paintHome();
    const next = app.querySelector(".profile-body");
    if (next) next.scrollTop = scrollTop;
  }
}

// Balances stay current while the popup is open.
setInterval(() => { if (homeState && app.dataset.screen === "home") refreshHome(); }, 30_000);

// --- QR ----------------------------------------------------------------------------------

boot();
