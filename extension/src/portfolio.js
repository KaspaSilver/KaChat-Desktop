// The Portfolio tab - a 1:1 port of iOS PortfolioView + PortfolioTransactionsView +
// PortfolioPickerHeader + AddToPortfolioSheet: a manually kept buy/sell ledger of KAS, up to five
// named portfolios per wallet account, valued in the app currency (Settings > Customization >
// Currency).
//
// One continuous page under the toolbar and large title: the portfolio cards, the Kaspa and Value
// squares, the Network Hashrate card, then Transactions. The squares and the hashrate card push
// their chart screens (portfolio-screens.js); everything else opens as a sheet, as on iOS.
// Data, math and prices live in portfolio-core.js.
//
// Left out on purpose (iOS-only services): Nextcloud import / export, and the home-screen widget.

import "./portfolio.css";
import { app, esc, render, $, showSheet, showAlert, isTab, onRender, ICONS } from "./ui.js";
import * as wallet from "./wallet.js";
import * as dock from "./dock.js";
import { ext } from "./browser.js";
import { scanQr } from "./camera.js";
import { looksLikeName, resolveEverywhere, primaryResolution } from "./names.js";
import * as core from "./portfolio-core.js";
import { sparklineSvg } from "./portfolio-charts.js";
import { SF, openPanel, pfToast, bindPullToRefresh, changeBadge, fitText } from "./portfolio-ui.js";
import { showPriceScreen, showValueScreen, showHashrateScreen } from "./portfolio-screens.js";

const { store, market, hashrate } = core;

const view = {
  selecting: false,
  selected: new Set(),
  scrollTop: 0,
  cardsLeft: 0,
  menuCardId: null,   // the card whose actions sheet is open (drawn lifted)
};

// =================================================================================================
// Tab root
// =================================================================================================

export async function showPortfolio() {
  await core.loadStore();
  core.primeFromCache();
  paintHome();
  core.refreshSpotPriceIfStale();
  core.ensureSevenDay();
  core.refreshHashrateIfNeeded();
  core.startPriceBackfillIfNeeded();
}

let homeUnsubscribe = null;
function paintHome() {
  const prev = app.querySelector("#pf-home-scroll");
  if (prev) { view.scrollTop = prev.scrollTop; view.cardsLeft = app.querySelector("#pf-cards")?.scrollLeft || 0; }
  const hidden = store.valuesHidden;
  render(`
    ${dock.tabTopHtml("Portfolio", { rightHtml: `<button class="icon plain pf-eye" id="pf-eye" aria-label="${hidden ? "Show amounts" : "Hide amounts"}">${hidden ? SF.eyeSlash() : SF.eye()}</button>` })}
    <div class="pf-scroll" id="pf-home-scroll">
      <div class="pf-ptr" id="pf-ptr"><span class="spinner small-spin"></span></div>
      <div class="pf-cards" id="pf-cards">${cardsHtml()}</div>
      <div class="pf-squares">${priceSquareHtml()}${valueSquareHtml()}</div>
      ${hashrateCardHtml()}
      ${realizedPLCardHtml()}
      ${feesCardHtml()}
      ${transactionsSectionHtml()}
    </div>`, "portfolio:home");
  dock.bindTabTop();
  dock.remember(() => showPortfolio());
  // The toolbar's balance hides with every other amount (iOS shows "•••••• KAS" there).
  if (hidden) {
    const balance = app.querySelector(".tab-toolbar .toolbar-balance span");
    if (balance) balance.textContent = `${core.MASKED} KAS`;
  }
  const scroller = $("#pf-home-scroll");
  scroller.scrollTop = view.scrollTop;
  $("#pf-cards").scrollLeft = view.cardsLeft;
  bindHome();
  fitText(app);
  homeUnsubscribe?.();
  homeUnsubscribe = core.subscribe(() => {
    if (!scroller.isConnected) { homeUnsubscribe?.(); homeUnsubscribe = null; return; }
    if (gestureActive) { repaintPending = true; return; }
    paintHome();
  });
}

let gestureActive = false;
let repaintPending = false;
function gestureDone() {
  gestureActive = false;
  if (repaintPending && app.querySelector("#pf-home-scroll")) { repaintPending = false; paintHome(); }
}

// --- cards (PortfolioPickerHeader) ---------------------------------------------------------------

function cardsHtml() {
  const list = core.portfolios();
  const cards = list.map((p) => {
    const active = p.id === core.activeId();
    const value = store.valuesHidden ? core.MASKED : core.currency(core.summaryFor(p.id).currentValue);
    const change = core.todayChangeFor(p.id);
    return `
      <div class="pf-pcard ${active ? "active" : ""} ${view.menuCardId === p.id ? "menu" : ""}" data-card="${esc(p.id)}" role="button" tabindex="0" aria-pressed="${active}">
        <div class="pf-pcard-top">
          <span class="pf-pcard-name">${esc(p.name)}</span>
          <button class="pf-pcard-gear" data-gear="${esc(p.id)}" aria-label="Edit ${esc(p.name)}">${SF.gearFill(12)}</button>
        </div>
        <div class="pf-pcard-value" data-fit="0.7">${esc(value)}</div>
        ${change ? changeBadge(change.percent, change.amount >= 0, { cls: "small" }) : '<span class="muted pf-caption">—</span>'}
      </div>`;
  }).join("");
  const add = list.length < core.MAX_PORTFOLIOS
    ? `<button class="pf-add-card" id="pf-add-portfolio" aria-label="Add portfolio"><span class="accent">${SF.plusCircleFill(24)}</span><span class="muted pf-caption">Add</span></button>`
    : "";
  return cards + add;
}

// --- launcher squares and the hashrate card ------------------------------------------------------

function priceSquareHtml() {
  const p = market.price;
  return `
    <button class="pf-glass pf-square" id="pf-open-price">
      <span class="pf-square-head"><img src="icons/kaspa-logo.png" alt="" class="pf-logo26" /><span class="pf-square-title">Kaspa</span><span class="pf-spacer"></span><span class="muted">${SF.chevronRight(11)}</span></span>
      <span class="pf-spacer"></span>
      <span class="pf-square-value" data-fit="0.6">${p ? esc(core.price(p.price)) : "—"}</span>
      ${p && p.change24h != null ? changeBadge(p.change24h, p.change24h >= 0, { cls: "foot" }) : ""}
    </button>`;
}

function valueSquareHtml() {
  const summary = core.summaryFor();
  const change = core.todayChangeFor(core.activeId());
  return `
    <button class="pf-glass pf-square" id="pf-open-value">
      <span class="pf-square-head"><span class="muted">${SF.chartUptrend(16)}</span><span class="pf-square-title">Value</span><span class="pf-spacer"></span><span class="muted">${SF.chevronRight(11)}</span></span>
      <span class="pf-spacer"></span>
      <span class="pf-square-value" data-fit="0.6">${esc(store.valuesHidden ? core.MASKED : core.currency(summary.currentValue))}</span>
      ${change ? changeBadge(change.percent, change.amount >= 0, { cls: "foot" }) : '<span class="muted pf-tiny">24h change not available yet</span>'}
    </button>`;
}

function hashrateCardHtml() {
  return `
    <button class="pf-glass pf-hash-card" id="pf-open-hashrate">
      <span class="accent pf-hash-icon">${SF.pickaxe(20)}</span>
      <span class="pf-hash-text"><span class="pf-square-title">Network Hashrate</span><span class="pf-hash-value" data-fit="0.7">${esc(core.hashrateText(hashrate.current))}</span></span>
      <span class="pf-spacer"></span>
      ${hashrate.history.length >= 2 ? sparklineSvg(hashrate.history.slice(-90)) : ""}
      <span class="muted">${SF.chevronRight(11)}</span>
    </button>`;
}

// --- Realized P&L and Fees Spent ------------------------------------------------------------

/** This calendar year's sells against the cost of the KAS they sold, oldest buys first (FIFO). */
function realizedPLCardHtml() {
  const pl = core.realizedPLThisYear();
  const hidden = store.valuesHidden;
  const notes = [];
  if (pl.sellCount === 0) notes.push("No sells yet this year.");
  else {
    notes.push(`Sells: ${pl.sellCount}. Oldest buys first (FIFO).`);
    if (pl.uncoveredKas > 0) notes.push(`${hidden ? core.MASKED : core.kas(pl.uncoveredKas)} sold with no buy on record, counted at zero cost.`);
  }
  if (pl.pendingPriceCount > 0) notes.push("Some prices are still loading.");
  const value = hidden ? core.MASKED : `${pl.amount > 0 ? "+" : ""}${core.currency(pl.amount)}`;
  const tone = hidden || pl.sellCount === 0 ? "" : pl.amount >= 0 ? "up" : "down";
  return `
    <div class="pf-glass pf-info-card">
      <span class="accent pf-info-icon">${SF.checkSeal(20)}</span>
      <span class="pf-info-text">
        <span class="pf-square-title">Realized P&amp;L ${pl.year}</span>
        <span class="pf-info-value ${tone}" data-fit="0.7">${esc(value)}</span>
        <span class="muted pf-caption">${esc(notes.join(" "))}</span>
      </span>
    </div>`;
}

/** Network fees the active portfolio's imported addresses paid, in KAS and at each day's price. */
function feesCardHtml() {
  const fees = core.feeSummary();
  const hidden = store.valuesHidden;
  const body = fees.count === 0 ? `
        <span class="pf-info-value">—</span>
        <span class="muted pf-caption">Add your chatting address with + to count the network fees it has paid.</span>` : `
        <span class="pf-info-value" data-fit="0.7">${esc(hidden ? core.MASKED : core.feeKas(fees.totalKas))}</span>
        <span class="pf-info-fiat">${esc(hidden ? core.MASKED : core.currency(fees.totalFiat))}</span>
        <span class="muted pf-caption">${fees.unpricedCount > 0 ? `Transactions: ${fees.count}. Some prices are still loading.` : `Transactions: ${fees.count}, at each day's price.`}</span>`;
  return `
    <div class="pf-glass pf-info-card">
      <span class="accent pf-info-icon">${SF.fuelpump(20)}</span>
      <span class="pf-info-text"><span class="pf-square-title">Fees Spent</span>${body}</span>
    </div>`;
}

// --- Transactions section (PortfolioTransactionsView) -----------------------------------------

function transactionsSectionHtml() {
  const rows = core.transactionsDescending();
  const allSelected = rows.length > 0 && rows.every((t) => view.selected.has(t.id));
  const head = view.selecting
    ? `
      <button class="pf-icon-button accent" id="pf-select-all" aria-label="${allSelected ? "Deselect all" : "Select all"}">${allSelected ? SF.checkCircleSolid(22) : SF.checkCircle(22)}</button>
      <button class="pf-icon-button pf-delete-selected ${view.selected.size ? "destructive" : ""}" id="pf-delete-selected" aria-label="Delete selected" ${view.selected.size ? "" : "disabled"}>${SF.trash(18)}${view.selected.size ? `<span>${view.selected.size}</span>` : ""}</button>
      <button class="pf-text-button" id="pf-select-done">Done</button>`
    : `
      <button class="pf-text-button" id="pf-select" ${rows.length ? "" : "disabled"}>Select</button>
      <button class="pf-icon-button accent" id="pf-add" aria-label="Add to this portfolio">${SF.plusCircleFill(22)}</button>
      <button class="pf-icon-button accent" id="pf-io" aria-label="Import or export">${SF.importExport(18)}</button>`;
  return `
    <div class="pf-tx-head"><span class="pf-tx-title">Transactions</span><span class="pf-spacer"></span>${head}</div>
    <div class="pf-list ${view.selecting ? "selecting" : ""}">
      ${rows.length ? rows.map(rowHtml).join("") : `
        <div class="pf-empty">
          <span class="muted">${SF.chartUptrend(44)}</span>
          <div class="pf-empty-title">No Transactions Yet</div>
          <div class="muted pf-empty-text">Add a buy or sell to start tracking your portfolio</div>
        </div>`}
    </div>`;
}

const TYPE_TITLES = { buy: "Buy", sell: "Sell", transfer: "Transfer" };
const TRANSFER_FOOTER = "KAS moved between your own addresses - sent away and brought back, or wallet to wallet. It doesn't change your holdings, cost or profit.";

function typePickerHtml(attr, selected) {
  return `<div class="segmented wide pf-three" role="radiogroup" aria-label="Type">${core.TYPES.map((t) =>
    `<button type="button" role="radio" ${attr}="${t}" aria-checked="${selected === t}">${TYPE_TITLES[t]}</button>`).join("")}</div>`;
}

function rowInnerHtml(tx) {
  const kind = core.TYPES.includes(tx.type) ? tx.type : "buy";
  const hidden = store.valuesHidden;
  const pending = core.isPricePending(tx.notes);
  return `
    <span class="pf-row-icon ${kind}">${kind === "buy" ? SF.downCircleFill(26) : kind === "sell" ? SF.upCircleFill(26) : SF.transferCircleFill(26)}</span>
    <span class="pf-row-mid">
      <span class="pf-row-type">${TYPE_TITLES[kind]}${pending ? `<span class="pf-warn" title="Price still loading, tap to set manually" aria-label="Price still loading, tap to set manually">${SF.warnFill(12)}</span>` : ""}</span>
      <span class="muted pf-caption">${esc(core.dateTimeText(tx.timestamp))}</span>
      ${tx.notes ? `<span class="muted pf-caption pf-row-notes">${esc(tx.notes)}</span>` : ""}
    </span>
    <span class="pf-row-right">
      <span class="pf-row-amount">${esc(hidden ? `${core.MASKED} KAS` : core.kas(core.amountKasOf(tx)))}</span>
      <span class="muted pf-caption">${esc(hidden ? core.MASKED : core.currency(tx.fiatValue))}</span>
    </span>`;
}

function rowHtml(tx) {
  const picked = view.selected.has(tx.id);
  return `
    <div class="pf-row-wrap" data-tx="${esc(tx.id)}">
      <button class="pf-row-delete" data-delete="${esc(tx.id)}" tabindex="-1">${SF.trash(17)}<span>Delete</span></button>
      <div class="pf-row" role="button" tabindex="0">
        ${view.selecting ? `<span class="pf-row-check ${picked ? "on" : ""}">${picked ? SF.checkCircleSolid(22) : SF.circle(22)}</span>` : ""}
        ${rowInnerHtml(tx)}
      </div>
    </div>`;
}

// --- wiring -----------------------------------------------------------------------------------

function bindHome() {
  $("#pf-eye").onclick = () => core.setValuesHidden(!store.valuesHidden);
  bindPullToRefresh($("#pf-home-scroll"), $("#pf-ptr"), async () => {
    await Promise.all([core.pullRefresh(), core.refreshHashrateIfNeeded({ force: true })]);
  });

  for (const card of app.querySelectorAll("[data-card]")) {
    const select = () => core.setActivePortfolio(card.dataset.card);
    card.onclick = (event) => { if (!event.target.closest("[data-gear]")) select(); };
    card.onkeydown = (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); select(); } };
  }
  for (const gear of app.querySelectorAll("[data-gear]")) gear.onclick = (event) => { event.stopPropagation(); showPortfolioActions(gear.dataset.gear); };
  $("#pf-add-portfolio")?.addEventListener("click", showNewPortfolio);

  const back = () => showPortfolio();
  $("#pf-open-price").onclick = () => showPriceScreen({ onBack: back });
  $("#pf-open-value").onclick = () => showValueScreen({ onBack: back });
  $("#pf-open-hashrate").onclick = () => showHashrateScreen({ onBack: back });

  if (view.selecting) {
    $("#pf-select-all").onclick = () => {
      const rows = core.transactionsDescending();
      const all = rows.every((t) => view.selected.has(t.id));
      view.selected = all ? new Set() : new Set(rows.map((t) => t.id));
      paintHome();
    };
    $("#pf-delete-selected").onclick = confirmDeleteSelected;
    $("#pf-select-done").onclick = () => { view.selecting = false; view.selected.clear(); paintHome(); };
  } else {
    $("#pf-select").onclick = () => { view.selecting = true; view.selected.clear(); paintHome(); };
    $("#pf-add").onclick = showAddChooser;
    $("#pf-io").onclick = showImportExport;
  }
  for (const wrap of app.querySelectorAll("[data-tx]")) bindRow(wrap);
}

/**
 * A row: tap edits (or toggles in Select mode), a hold of 0.45 s moves it to another portfolio,
 * and a swipe to the left reveals Delete (a full swipe deletes) - iOS swipeActions.
 */
function bindRow(wrap) {
  const id = wrap.dataset.tx;
  const row = wrap.querySelector(".pf-row");
  const del = wrap.querySelector(".pf-row-delete");
  del.onclick = (event) => { event.stopPropagation(); core.deleteTransactions([id]); };
  if (view.selecting) {
    row.onclick = () => {
      if (view.selected.has(id)) view.selected.delete(id); else view.selected.add(id);
      paintHome();
    };
    return;
  }
  row.onkeydown = (event) => { if (event.key === "Enter") editTransaction(id); };
  let start = null;
  let offset = 0;
  let mode = null;    // null | "swipe" | "scroll" | "long"
  let timer = null;
  const isOpen = () => wrap.classList.contains("open");
  const setOffset = (x, animate) => {
    offset = x;
    row.style.transition = animate ? "transform .2s ease" : "none";
    row.style.transform = x ? `translateX(${x}px)` : "";
  };
  const onMove = (event) => {
    if (!start) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (!mode) {
      if (Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy)) { mode = "swipe"; clearTimeout(timer); }
      else if (Math.abs(dy) > 8) { mode = "scroll"; clearTimeout(timer); }
    }
    if (mode === "swipe") setOffset(Math.min(0, start.base + dx), false);
  };
  const end = () => {
    clearTimeout(timer);
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", end);
    window.removeEventListener("pointercancel", cancel);
    if (!start) return;
    const was = mode;
    start = null;
    row.classList.remove("pressed");
    if (was === "swipe") {
      const width = wrap.clientWidth || 320;
      if (offset < -width * 0.6) { setOffset(-width, true); setTimeout(() => core.deleteTransactions([id]), 180); }
      else if (offset < -40) { setOffset(-84, true); wrap.classList.add("open"); closeOtherRows(wrap); }
      else { setOffset(0, true); wrap.classList.remove("open"); }
      setTimeout(gestureDone, 220);
      return;
    }
    gestureDone();
    if (was === null) {
      if (isOpen()) { setOffset(0, true); wrap.classList.remove("open"); return; }
      if (closeOtherRows(null)) return;
      editTransaction(id);
    }
  };
  const cancel = () => { mode = "scroll"; end(); };
  row.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    start = { x: event.clientX, y: event.clientY, base: isOpen() ? -84 : 0 };
    mode = null;
    gestureActive = true;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", cancel);
    timer = setTimeout(() => {
      if (mode) return;
      mode = "long";
      row.classList.add("pressed");
      showMoveSheet(id);
    }, 450);
  });
  row.addEventListener("contextmenu", (event) => event.preventDefault());
}

/** Closes any row left swiped open; true when one was. */
function closeOtherRows(except) {
  let closed = false;
  for (const open of app.querySelectorAll(".pf-row-wrap.open")) {
    if (open === except) continue;
    open.classList.remove("open");
    const row = open.querySelector(".pf-row");
    row.style.transition = "transform .2s ease";
    row.style.transform = "";
    closed = true;
  }
  return closed;
}

function confirmDeleteSelected() {
  const n = view.selected.size;
  if (!n) return;
  showAlert({
    title: `Delete ${n} Transaction${n === 1 ? "" : "s"}?`,
    message: "This can't be undone.",
    confirmLabel: "Delete",
    cancelLabel: "Cancel",
    onConfirm: async () => {
      const ids = [...view.selected];
      view.selecting = false;
      view.selected.clear();
      await core.deleteTransactions(ids);
    },
  });
  document.querySelector(".alert-backdrop .alert-button.strong")?.classList.add("pf-destructive");
}

// =================================================================================================
// Portfolio card sheets: New Portfolio, and Rename / Reorder / Delete
// =================================================================================================

function showNewPortfolio() {
  const panel = openPanel({
    title: "New Portfolio",
    size: 210,
    leading: { label: "Cancel", onClick: () => panel.close() },
    trailing: { label: "Create", strong: true, disabled: true, onClick: () => create() },
    body: `<div class="form-section"><div class="form-card"><div class="form-row"><input class="plain-input" id="pf-new-name" placeholder="Portfolio Name" maxlength="40" autocomplete="off" /></div></div></div>`,
  });
  const input = panel.body.querySelector("#pf-new-name");
  const create = async () => {
    if (!input.value.trim()) return;
    panel.close();
    await core.addPortfolio(input.value);
  };
  input.oninput = () => panel.setBar({ trailing: { label: "Create", strong: true, disabled: !input.value.trim(), onClick: create } });
  input.onkeydown = (event) => { if (event.key === "Enter") create(); };
  input.focus();
}

function showPortfolioActions(portfolioId) {
  const portfolio = core.portfolioById(portfolioId);
  if (!portfolio) return;
  view.menuCardId = portfolioId;
  app.querySelector(`[data-card="${CSS.escape(portfolioId)}"]`)?.classList.add("menu");
  let draft = [];
  const panel = openPanel({
    title: portfolio.name,
    onClose: () => {
      view.menuCardId = null;
      app.querySelector(".pf-pcard.menu")?.classList.remove("menu");
    },
  });
  const sole = () => core.portfolios().length <= 1;
  const toMenu = () => {
    panel.setBar({ title: portfolio.name, leading: { label: "Cancel", onClick: () => panel.close() }, trailing: null });
    panel.setBody(`
      <div class="form-section">
        <div class="form-card">
          <button class="form-row pf-form-button" id="pf-rename">${SF.pencil(18)}<span>Rename</span></button>
          ${sole() ? "" : `
            <button class="form-row pf-form-button" id="pf-reorder">${SF.arrowsUpDown(18)}<span>Reorder Portfolios</span></button>
            <button class="form-row pf-form-button pf-destructive-row" id="pf-delete">${SF.trash(18)}<span>Delete '${esc(portfolio.name)}'</span></button>`}
        </div>
        ${sole() ? '<div class="form-footer">This is your only portfolio, so it can\'t be deleted or reordered.</div>' : ""}
      </div>`);
    panel.body.querySelector("#pf-rename").onclick = toRename;
    panel.body.querySelector("#pf-reorder")?.addEventListener("click", toReorder);
    panel.body.querySelector("#pf-delete")?.addEventListener("click", toDelete);
  };
  const back = { label: "Back", onClick: () => toMenu() };
  const toRename = () => {
    const save = async () => {
      const value = input.value.trim();
      if (!value) return;
      panel.close();
      await core.renamePortfolio(portfolioId, value);
    };
    panel.setBar({ title: "Rename", leading: back, trailing: { label: "Save", strong: true, onClick: save } });
    panel.setBody(`
      <div class="form-section">
        <div class="form-card"><div class="form-row"><input class="plain-input" id="pf-rename-input" placeholder="Portfolio Name" maxlength="40" value="${esc(portfolio.name)}" autocomplete="off" /></div></div>
        <div class="form-footer">Only the name changes. Transactions stay where they are.</div>
      </div>`);
    const input = panel.body.querySelector("#pf-rename-input");
    input.oninput = () => panel.setBar({ trailing: { label: "Save", strong: true, disabled: !input.value.trim(), onClick: save } });
    input.onkeydown = (event) => { if (event.key === "Enter") save(); };
    input.focus();
    input.select();
  };
  const toReorder = () => {
    draft = core.portfolios().map((p) => p.id);
    panel.setBar({
      title: "Reorder",
      leading: back,
      trailing: { label: "Done", strong: true, onClick: async () => { panel.close(); await core.reorderPortfolios(draft); } },
    });
    const paintList = () => {
      panel.setBody(`
        <div class="form-section">
          <div class="form-card pf-reorder" id="pf-reorder-list">
            ${draft.map((id) => {
              const p = core.portfolioById(id);
              return `<div class="form-row pf-reorder-row" data-id="${esc(id)}">
                <span class="${id === portfolioId ? "strong" : ""} ellipsis pf-reorder-name">${esc(p.name)}</span>
                <span class="muted pf-sub">${esc(store.valuesHidden ? core.MASKED : core.currency(core.summaryFor(id).currentValue))}</span>
                <span class="pf-handle muted" data-handle aria-label="Drag to reorder">${SF.handle(18)}</span>
              </div>`;
            }).join("")}
          </div>
          <div class="form-footer">Drag a portfolio to change the order its card appears in.</div>
        </div>`);
      bindReorderDrag(panel.body.querySelector("#pf-reorder-list"), (from, to) => {
        const [moved] = draft.splice(from, 1);
        draft.splice(to, 0, moved);
        paintList();
      });
    };
    paintList();
  };
  const toDelete = () => {
    panel.setBar({ title: "Delete Portfolio", leading: back, trailing: null });
    panel.setBody(`
      <div class="form-section">
        <div class="form-card"><button class="form-row pf-form-button pf-destructive-row" id="pf-confirm-delete">${SF.trash(18)}<span>Delete '${esc(portfolio.name)}'</span></button></div>
        <div class="form-footer">'${esc(portfolio.name)}' and its transactions will be deleted. This can't be undone.</div>
      </div>`);
    panel.body.querySelector("#pf-confirm-delete").onclick = async () => { panel.close(); await core.deletePortfolio(portfolioId); };
  };
  toMenu();
}

/** Drag handles on an always-editing list (iOS List .editMode active). */
function bindReorderDrag(list, onMove) {
  for (const handle of list.querySelectorAll("[data-handle]")) {
    handle.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      const row = handle.closest(".pf-reorder-row");
      const rows = [...list.querySelectorAll(".pf-reorder-row")];
      const from = rows.indexOf(row);
      const height = row.offsetHeight;
      const startY = event.clientY;
      let to = from;
      row.classList.add("dragging");
      const move = (e) => {
        const dy = e.clientY - startY;
        row.style.transform = `translateY(${dy}px)`;
        to = Math.max(0, Math.min(rows.length - 1, from + Math.round(dy / height)));
        rows.forEach((other, i) => {
          if (other === row) return;
          let shift = 0;
          if (from < to && i > from && i <= to) shift = -height;
          if (from > to && i < from && i >= to) shift = height;
          other.style.transform = shift ? `translateY(${shift}px)` : "";
        });
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", up);
        if (to !== from) onMove(from, to);
        else { row.style.transform = ""; row.classList.remove("dragging"); }
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", up);
    });
  }
}

// =================================================================================================
// Add chooser, Import or Export, Move to Portfolio
// =================================================================================================

async function showAddChooser() {
  const chatting = (await wallet.cachedAddresses(store.accountId).catch(() => null))?.main || null;
  showSheet({
    title: "Add to Portfolio",
    cancel: false,
    rows: [
      { label: "Add Transaction", subtitle: "Record a buy or a sell by hand.", icon: SF.pencil(18), onClick: () => showEditor(null) },
      { label: "Add Kaspa Address", subtitle: "Track an address's balance as part of this portfolio.", icon: SF.arrowLeftRight(18), onClick: () => showAddAddress() },
      // One tap for the address KaChat itself spends from: its buys and sells, and every network
      // fee it paid (messages, handshakes, payments) for the Fees Spent card.
      ...(chatting ? [{ label: "Add Chatting Address", subtitle: "Your chatting address's buys and sells, and every network fee it has paid.", icon: SF.bubbles(18), onClick: () => showAddAddress(chatting) }] : []),
    ],
  });
}

function showImportExport() {
  showSheet({
    title: "Import or Export",
    cancel: false,
    rows: [
      { label: "Import CSV", subtitle: "Read transactions in from a file.", icon: SF.importFile(18), onClick: importCsv },
      { label: "Export CSV", subtitle: "Write this portfolio's transactions out to a file.", icon: SF.exportFile(18), onClick: exportCsv },
    ],
  });
}

function showMoveSheet(id) {
  const tx = core.findTransaction(id);
  if (!tx) { gestureDone(); return; }
  const others = core.portfolios().filter((p) => p.id !== tx.portfolioId);
  const holding = core.portfolioIdsContaining(tx.sourceTxId || "");
  const sheet = showSheet({
    title: "Move to Portfolio",
    cancel: false,
    headerHtml: `
      <div class="pf-move-card"><div class="pf-row static">${rowInnerHtml(tx)}</div></div>
      ${others.length ? "" : '<p class="muted pf-move-empty">Create another portfolio first, then you can move transactions into it.</p>'}`,
    rows: others.map((p) => ({
      label: p.name,
      subtitle: holding.has(p.id) ? "Already has this transaction." : "Move this transaction here.",
      icon: SF.folder(18),
      disabled: holding.has(p.id),
      onClick: async () => {
        await core.moveTransaction(id, p.id);
        pfToast(`Moved to ${p.name}.`);
      },
    })),
  });
  sheet.element.classList.add("pf-sheet");
  gestureDone();
}

// =================================================================================================
// Transaction editor (Add / Edit) - a full sheet, so no dock
// =================================================================================================

function showEditor(id) {
  const existing = id ? core.findTransaction(id) : null;
  const amountKas = existing ? core.amountKasOf(existing) : 0;
  const form = {
    type: existing && core.TYPES.includes(existing.type) ? existing.type : "buy",
    quantity: existing && amountKas > 0 ? core.trimmedAll(amountKas) : "",
    price: existing
      ? (amountKas > 0 ? core.trimmedAll(existing.fiatValue / amountKas) : "")
      : (market.price?.price != null ? core.trimmedAll(market.price.price) : ""),
    fee: "",
    notes: existing?.notes || "",
    timestamp: existing ? existing.timestamp : Date.now(),
  };
  const symbol = core.currencySymbol();
  const values = () => {
    const quantity = core.parsePortfolioNumber(form.quantity);
    const price = core.parsePortfolioNumber(form.price);
    const fee = core.parsePortfolioNumber(form.fee) || 0;
    // A transfer's total is what the KAS was worth when it moved - a note, counted nowhere.
    const base = quantity != null && price != null ? quantity * price : null;
    const total = base == null ? null : form.type === "buy" ? base + fee : form.type === "sell" ? base - fee : base;
    // A transfer needs only its amount; its price counts for nothing.
    return { quantity, price, total, valid: (quantity || 0) > 0 && (form.type === "transfer" || (price || 0) > 0) };
  };
  const close = () => showPortfolio();
  render(`
    <header class="navbar form-bar">
      <button class="bar-text" id="pf-ed-cancel">Cancel</button>
      <div class="nav-title">${existing ? "Edit Transaction" : "Add Transaction"}</div>
      <button class="bar-text strong" id="pf-ed-save" disabled>${existing ? "Save" : "Add"}</button>
    </header>
    <section class="form pf-editor">
      <div class="form-section"><div class="form-card"><div class="form-row">
        ${typePickerHtml("data-type", form.type)}
      </div></div><div class="form-footer" id="pf-ed-type-footer" ${form.type === "transfer" ? "" : "hidden"}>${esc(TRANSFER_FOOTER)}</div></div>
      <div class="form-section"><div class="form-card">
        <label class="form-row pf-field-row"><span>Quantity</span><input id="pf-ed-qty" inputmode="decimal" placeholder="0.00" value="${esc(form.quantity)}" autocomplete="off" /><span class="muted">KAS</span></label>
        <label class="form-row pf-field-row"><span>Price Per Coin</span><span class="muted pf-sym">${esc(symbol)}</span><input id="pf-ed-price" inputmode="decimal" placeholder="0.00" value="${esc(form.price)}" autocomplete="off" /></label>
        <label class="form-row pf-field-row" id="pf-ed-fee-row" ${form.type === "transfer" ? "hidden" : ""}><span>Fee (optional)</span><span class="muted pf-sym">${esc(symbol)}</span><input id="pf-ed-fee" inputmode="decimal" placeholder="0.00" autocomplete="off" /></label>
        <label class="form-row pf-field-row"><span>Date</span><input id="pf-ed-date" type="datetime-local" class="pf-date" value="${esc(toLocalInput(form.timestamp))}" /></label>
      </div></div>
      <div class="form-section"><div class="form-card">
        <div class="form-row"><textarea id="pf-ed-notes" class="plain-input pf-notes" rows="1" placeholder="Notes (optional)">${esc(form.notes)}</textarea></div>
      </div></div>
      <div class="form-section"><div class="form-card">
        <div class="form-row between"><span class="muted" id="pf-ed-total-label"></span><span class="strong" id="pf-ed-total"></span></div>
      </div></div>
      ${existing ? '<div class="form-section"><div class="form-card"><button class="form-row pf-form-button pf-destructive-row center" id="pf-ed-delete">Delete Transaction</button></div></div>' : ""}
    </section>`, "portfolio-editor");

  const update = () => {
    const v = values();
    $("#pf-ed-save").disabled = !v.valid;
    $("#pf-ed-total-label").textContent = form.type === "buy" ? "Total Spent" : form.type === "sell" ? "Total Received" : "Value at the Time";
    $("#pf-ed-fee-row").hidden = form.type === "transfer";
    $("#pf-ed-type-footer").hidden = form.type !== "transfer";
    $("#pf-ed-total").textContent = core.currency(v.total ?? 0);
  };
  for (const button of app.querySelectorAll("[data-type]")) {
    button.onclick = () => {
      form.type = button.dataset.type;
      for (const other of app.querySelectorAll("[data-type]")) other.setAttribute("aria-checked", String(other === button));
      update();
    };
  }
  $("#pf-ed-qty").oninput = (e) => { form.quantity = e.target.value; update(); };
  $("#pf-ed-price").oninput = (e) => { form.price = e.target.value; update(); };
  $("#pf-ed-fee").oninput = (e) => { form.fee = e.target.value; update(); };
  $("#pf-ed-date").onchange = (e) => { const t = new Date(e.target.value).getTime(); if (Number.isFinite(t)) form.timestamp = t; };
  const notes = $("#pf-ed-notes");
  const grow = () => { notes.style.height = "auto"; notes.style.height = `${notes.scrollHeight}px`; };
  notes.oninput = () => { form.notes = notes.value; grow(); };
  grow();
  $("#pf-ed-cancel").onclick = close;
  $("#pf-ed-save").onclick = async () => {
    const v = values();
    if (!v.valid) return;
    const trimmed = form.notes.trim();
    // A transfer with no price is still a complete record.
    const fields = { type: form.type, amountKas: v.quantity, fiatValue: v.total ?? 0, timestamp: form.timestamp, notes: trimmed || null };
    if (existing) await core.updateTransaction(existing.id, fields);
    else await core.addTransaction(fields);
    close();
  };
  $("#pf-ed-delete")?.addEventListener("click", async () => { await core.deleteTransactions([existing.id]); close(); });
  update();
  if (!existing) $("#pf-ed-qty").focus();
}

function editTransaction(id) { showEditor(id); }

function toLocalInput(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

// =================================================================================================
// Add Kaspa Address
// =================================================================================================

/** Add Kaspa Address; with `preset` (Add Chatting Address) there is no field - the import of that
 *  address starts as the sheet opens and the sheet shows only its progress. */
function showAddAddress(preset = null) {
  const s = { input: "", resolving: false, resolved: null, notFound: false, importing: false, progress: "Starting…" };
  let seq = 0;
  const looksRaw = (text) => /^kaspa(test)?:/i.test(text);
  const validRaw = (text) => /^kaspa(test)?:[a-z0-9]{50,90}$/.test(text.toLowerCase());
  const short = (address) => (address.length > 26 ? `${address.slice(0, 16)}...${address.slice(-8)}` : address);
  const effective = () => s.resolved?.address || s.input;
  const canImport = () => !s.importing && (Boolean(s.resolved?.address) || validRaw(s.input));

  const statusHtml = () => {
    if (!s.input || s.resolving) return "";
    if (s.resolved) return `<div class="pf-status good">${SF.checkCircleFill(13)}<span>Resolves to ${esc(short(s.resolved.address))}</span></div>`;
    if (s.notFound) return '<div class="pf-status muted">Domain not found</div>';
    if (looksRaw(s.input)) {
      return validRaw(s.input)
        ? `<div class="pf-status good">${SF.checkCircleFill(13)}<span>Valid address</span></div>`
        : `<div class="pf-status bad">${SF.xCircleFill(13)}<span>Invalid address format</span></div>`;
    }
    return "";
  };
  // AddressResolutionCard: who the address is - its KNS name when it has one - and the address.
  const profiles = {};
  const cardHtml = () => {
    const address = s.resolved?.address || (validRaw(s.input) ? s.input.toLowerCase() : null);
    if (!address) return "";
    let info = profiles[address];
    if (info === undefined) {
      const cached = wallet.cachedKns(address);
      info = profiles[address] = cached?.known ? { name: cached.domainName || null } : "loading";
      if (info === "loading") {
        wallet.kns(address).then((result) => { profiles[address] = { name: result?.domainName || null }; refreshExtra(); })
          .catch(() => { profiles[address] = { name: null }; refreshExtra(); });
      }
    }
    const name = info === "loading" ? null : info.name;
    return `
      <div class="form-row"><div class="pf-resolution">
        <span class="pf-res-avatar">${ICONS.person}</span>
        <span class="pf-res-text"><span class="${name ? "strong" : "muted strong"} ellipsis">${esc(name || (info === "loading" ? "Looking up..." : "No domain"))}</span><span class="mono pf-tiny muted ellipsis">${esc(middle(address, 14))}</span></span>
        ${info === "loading" ? '<span class="spinner small-spin"></span>' : ""}
      </div></div>`;
  };
  const bodyHtml = () => s.importing ? `
    <div class="form-section"><div class="form-card"><div class="form-row pf-progress"><span class="spinner small-spin"></span><span class="muted" id="pf-addr-progress">${esc(s.progress)}</span></div></div></div>` : `
    <div class="form-section">
      <div class="form-card">
        <textarea id="pf-addr" class="mono recipient" rows="2" placeholder="kaspa:qr... or domain" spellcheck="false" autocapitalize="off" autocomplete="off">${esc(s.input)}</textarea>
        <div id="pf-addr-extra">${cardHtml()}${statusHtml() ? `<div class="form-row">${statusHtml()}</div>` : ""}</div>
        <div class="form-row between">
          <button class="link-button" id="pf-addr-paste">${SF.clipboard(16)}<span>Paste</span></button>
          <button class="link-button" id="pf-addr-scan">${SF.qrViewfinder(16)}<span>Scan QR</span></button>
        </div>
      </div>
      <div class="form-footer">Enter a Kaspa address or a KNS domain like name.kas. Every received transaction on this address becomes a buy, every sent transaction becomes a sell, priced at that day's historical KAS price. Re-adding the same address later only imports transactions found since the last import.</div>
    </div>`;
  const bar = () => ({
    leading: { label: "Cancel", disabled: s.importing, onClick: () => panel.close() },
    trailing: preset ? null : { label: "Import", strong: true, disabled: !canImport(), onClick: start },
  });
  if (preset) s.importing = true;
  const panel = openPanel({ title: preset ? "Add Chatting Address" : "Add Kaspa Address", ...bar(), body: bodyHtml(), locked: () => s.importing });
  const refreshExtra = () => {
    const extra = panel.body.querySelector("#pf-addr-extra");
    if (extra) extra.innerHTML = `${cardHtml()}${statusHtml() ? `<div class="form-row">${statusHtml()}</div>` : ""}`;
    panel.setBar(bar());
  };
  const onInput = (raw) => {
    s.input = String(raw || "").trim();
    s.resolved = null; s.notFound = false; s.resolving = false;
    const mine = ++seq;
    if (s.input && !looksRaw(s.input) && looksLikeName(s.input)) {
      s.resolving = true;
      setTimeout(async () => {
        if (mine !== seq) return;
        let winner = null;
        try { winner = primaryResolution(await resolveEverywhere(s.input), s.input); } catch { winner = null; }
        if (mine !== seq) return; // the field moved on while this was in flight
        s.resolving = false;
        s.resolved = winner?.address ? { address: winner.address, display: winner.display } : null;
        s.notFound = !s.resolved;
        refreshExtra();
      }, 300);
    }
    refreshExtra();
  };
  const fill = (text) => {
    let value = String(text || "").trim();
    if (/^kaspa(test)?:/i.test(value)) value = value.split("?")[0];
    const field = panel.body.querySelector("#pf-addr");
    if (field) field.value = value;
    onInput(value);
  };
  const bind = () => {
    const field = panel.body.querySelector("#pf-addr");
    if (!field) return;
    field.oninput = () => onInput(field.value);
    panel.body.querySelector("#pf-addr-paste").onclick = async () => {
      try { fill(await navigator.clipboard.readText()); } catch { pfToast("Couldn't read the clipboard", { error: true }); }
    };
    panel.body.querySelector("#pf-addr-scan").onclick = async () => {
      const text = await scanQr({ title: "Scan QR Code", hint: "Point camera at a Kaspa address" });
      if (text && panel.isOpen() && !s.importing) fill(text);
    };
    field.focus();
  };
  async function start() {
    if (!preset && !canImport()) return;
    const address = preset || effective();
    s.importing = true;
    s.progress = "Starting…";
    panel.setBody(bodyHtml());
    panel.setBar(bar());
    try {
      const result = await core.importAddress(address, (text) => {
        s.progress = text;
        const el = panel.body.querySelector("#pf-addr-progress");
        if (el) el.textContent = text;
      });
      s.importing = false;
      panel.close();
      let message = `Imported ${result.imported} transaction${result.imported === 1 ? "" : "s"}`;
      if (result.feeCount > 0) message += `. Network fees counted: ${result.feeCount}`;
      if (result.missingPriceCount > 0) message += `. Prices for ${result.missingPriceCount} are still loading and will fill in automatically`;
      if (result.incomplete) message += ". Some history couldn't be fetched, re-add this address later to import the rest";
      pfToast(message, { duration: message.length > 40 ? 3200 : 1600 });
    } catch (error) {
      s.importing = false;
      panel.close();
      pfToast(error instanceof core.ImportError ? error.message : "Import failed.", { error: true, duration: 2600 });
    }
  }
  if (preset) start(); else bind();
}

// =================================================================================================
// CSV
// =================================================================================================

function exportCsv() {
  const built = core.buildCsv();
  if (!built) { pfToast("Nothing to export yet. Add a transaction first", { error: true }); return; }
  try {
    const url = URL.createObjectURL(new Blob([built.csv], { type: "text/csv" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = built.filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  } catch {
    pfToast("Export failed. Couldn't write the CSV file", { error: true });
  }
}

// In the toolbar popup a file picker takes focus away and the popup closes under it, so the CSV
// import happens in the tab view: the popup offers to open it there, straight on this sheet.
const IMPORT_PARAM = "portfolio";
function importCsv() {
  if (!isTab) {
    showAlert({
      title: "Import CSV",
      message: "Picking a file closes this popup. Open KaChat Wallet in a tab to import the CSV there.",
      confirmLabel: "Open in Tab",
      cancelLabel: "Cancel",
      onConfirm: async () => {
        await ext.tabs.create({ url: ext.runtime.getURL(`popup.html?view=tab&${IMPORT_PARAM}=import`) });
        window.close();
      },
    });
    return;
  }
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".csv,text/csv,text/plain";
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    let count = 0;
    try { count = await core.importCsv(await file.text()); } catch { count = 0; }
    if (count > 0) pfToast(`Imported ${count} transaction${count === 1 ? "" : "s"}`);
    else pfToast("Import failed. Check the CSV format", { error: true });
  };
  input.click();
}

// The tab opened by "Open in Tab" lands on the Portfolio with Import or Export up, once the wallet
// is unlocked and the Profile tab has drawn.
if (isTab && new URLSearchParams(location.search).get(IMPORT_PARAM) === "import") {
  let done = false;
  onRender((screen) => {
    if (done || screen !== "home") return;
    done = true;
    setTimeout(async () => {
      dock.selectTab("portfolio");
      history.replaceState(null, "", location.pathname + "?view=tab");
      setTimeout(showImportExport, 50);
    }, 0);
  });
}

// =================================================================================================
// Add to Portfolio (from a transaction's actions sheet)
// =================================================================================================

/**
 * iOS AddToPortfolioSheet, opened from a transaction's actions sheet.
 * @param {{txid:string, direction:"in"|"out", amountSompi:bigint, time:number, sourceAddress:string, onDone:Function}} opts
 */
export async function showAddToPortfolio(opts) {
  await core.loadStore();
  const candidate = {
    txid: opts.txid,
    isOutgoing: opts.direction === "out",
    amountKas: Number(BigInt(opts.amountSompi ?? 0)) / 1e8,
    timestamp: opts.time || Date.now(),
    address: opts.sourceAddress,
  };
  const s = {
    step: "choose",
    selected: core.activePortfolio(),
    type: candidate.isOutgoing ? "sell" : "buy",
    amountText: core.trimmedTwo(candidate.amountKas),
    priceText: "",
    date: candidate.timestamp,
    notes: "",
    lookingUp: true,
    duplicate: false,
  };
  let added = null;
  const summaryLine = `${candidate.isOutgoing ? "Sent" : "Received"} ${core.kas(candidate.amountKas)} on ${core.dateTimeText(candidate.timestamp)}`;
  const duplicates = () => core.portfolioIdsContaining(candidate.txid);
  const amount = () => core.parsePortfolioNumber(s.amountText);
  const pricePer = () => core.parsePortfolioNumber(s.priceText);
  const total = () => (amount() != null && pricePer() != null ? amount() * pricePer() : null);

  const chooseHtml = () => `
    <div class="form-section">
      <div class="form-header">Which portfolio?</div>
      <div class="form-card">
        ${core.portfolios().map((p) => `
          <button class="form-row pf-choose-row" data-choose="${esc(p.id)}">
            <span class="pf-choose-text"><span>${esc(p.name)}</span>
              ${duplicates().has(p.id) ? `<span class="pf-tag orange">${SF.warnFill(10)}Already added</span>` : p.id === core.activeId() ? '<span class="pf-tag accent">Current</span>' : ""}
            </span>
            <span class="muted">${SF.chevronRight(11)}</span>
          </button>`).join("")}
      </div>
      <div class="form-footer">${esc(summaryLine)}</div>
    </div>`;

  const detailsHtml = () => `
    ${s.duplicate ? `<div class="form-section"><div class="form-card"><div class="form-row pf-dup">${SF.warnFill(14)}<span>This transaction is already in ${esc(s.selected?.name || "this portfolio")}. Adding it again will double-count it.</span></div></div></div>` : ""}
    <div class="form-section">
      <div class="form-header">Type</div>
      <div class="form-card"><div class="form-row">
        ${typePickerHtml("data-atype", s.type)}
      </div></div>
    </div>
    <div class="form-section">
      <div class="form-header">Amount and price</div>
      <div class="form-card">
        <label class="form-row pf-field-row"><span>Amount</span><input id="pf-atp-amount" inputmode="decimal" placeholder="0" value="${esc(s.amountText)}" autocomplete="off" /></label>
        <label class="form-row pf-field-row"><span>Price per KAS</span><span id="pf-atp-spin">${s.lookingUp ? '<span class="spinner small-spin"></span>' : ""}</span><input id="pf-atp-price" inputmode="decimal" placeholder="0" value="${esc(s.priceText)}" autocomplete="off" /></label>
        <div class="form-row between" id="pf-atp-total-row" ${total() != null ? "" : "hidden"}><span>Total</span><span class="muted" id="pf-atp-total">${total() != null ? esc(core.currency(total())) : ""}</span></div>
      </div>
    </div>
    <div class="form-section">
      <div class="form-header">Date</div>
      <div class="form-card"><label class="form-row pf-field-row"><span>Date</span><input id="pf-atp-date" type="datetime-local" class="pf-date" value="${esc(toLocalInput(s.date))}" /></label></div>
    </div>
    <div class="form-section">
      <div class="form-header">Note</div>
      <div class="form-card"><div class="form-row"><textarea id="pf-atp-notes" class="plain-input pf-notes" rows="1" placeholder="Optional">${esc(s.notes)}</textarea></div></div>
    </div>
    <div class="form-section">
      <div class="form-header">Transaction</div>
      <div class="form-card"><div class="form-row"><span class="mono pf-tiny muted ellipsis pf-txid">${esc(middle(candidate.txid))}</span></div></div>
      <div class="form-footer">Recorded with the row, so this transaction is recognised if you add it again.</div>
    </div>`;

  const panel = openPanel({
    title: "Add to Portfolio",
    onClose: () => {
      if (added) showAddedCapsule(added.name);
      opts.onDone?.();
    },
  });
  const confirmItem = () => ({ label: "Confirm", strong: true, disabled: !(amount() > 0), onClick: confirm });
  const toChoose = () => {
    s.step = "choose";
    panel.setBar({ title: "Add to Portfolio", leading: { label: "Cancel", onClick: () => panel.close() }, trailing: null });
    panel.setBody(chooseHtml());
    for (const row of panel.body.querySelectorAll("[data-choose]")) {
      row.onclick = () => {
        s.selected = core.portfolioById(row.dataset.choose);
        s.duplicate = duplicates().has(s.selected.id);
        toDetails();
      };
    }
  };
  const updateTotal = () => {
    const row = panel.body.querySelector("#pf-atp-total-row");
    if (!row) return;
    row.hidden = total() == null;
    panel.body.querySelector("#pf-atp-total").textContent = total() != null ? core.currency(total()) : "";
    panel.setBar({ trailing: confirmItem() });
  };
  const toDetails = () => {
    s.step = "details";
    panel.setBar({ title: "Transaction Details", leading: { label: "Back", onClick: toChoose }, trailing: confirmItem() });
    panel.setBody(detailsHtml());
    for (const button of panel.body.querySelectorAll("[data-atype]")) {
      button.onclick = () => {
        s.type = button.dataset.atype;
        for (const other of panel.body.querySelectorAll("[data-atype]")) other.setAttribute("aria-checked", String(other === button));
      };
    }
    panel.body.querySelector("#pf-atp-amount").oninput = (e) => { s.amountText = e.target.value; updateTotal(); };
    panel.body.querySelector("#pf-atp-price").oninput = (e) => { s.priceText = e.target.value; updateTotal(); };
    panel.body.querySelector("#pf-atp-date").onchange = (e) => { const t = new Date(e.target.value).getTime(); if (Number.isFinite(t)) s.date = t; };
    const notes = panel.body.querySelector("#pf-atp-notes");
    notes.oninput = () => { s.notes = notes.value; notes.style.height = "auto"; notes.style.height = `${notes.scrollHeight}px`; };
  };
  async function confirm() {
    const a = amount();
    if (!s.selected || !(a > 0)) return;
    const trimmed = s.notes.trim();
    await core.addTransaction({
      type: s.type, amountKas: a, fiatValue: total() ?? 0, timestamp: s.date, notes: trimmed ? s.notes : null,
      portfolioId: s.selected.id, sourceAddress: candidate.address, sourceTxId: candidate.txid,
    });
    added = s.selected;
    panel.close();
  }
  toChoose();

  // The price on the day it happened; filled only if the field is still empty when it lands.
  core.historicalPrice(candidate.timestamp).then((value) => {
    s.lookingUp = false;
    if (!panel.isOpen()) return;
    const spin = panel.body.querySelector("#pf-atp-spin");
    if (spin) spin.innerHTML = "";
    if (value == null || s.priceText) return;
    s.priceText = core.trimmedTwo(value, 6);
    const field = panel.body.querySelector("#pf-atp-price");
    if (field && !field.value) { field.value = s.priceText; updateTotal(); }
  });
}

/** Middle truncation for a txid on one line. */
function middle(text, keep = 14) {
  const value = String(text || "");
  return value.length > keep * 2 + 1 ? `${value.slice(0, keep)}…${value.slice(-keep)}` : value;
}

/** PortfolioAddedCapsule: "Added to <name>", bottom-anchored, gone after 2.2 s. */
function showAddedCapsule(name) {
  pfToast(`Added to ${name}`, { duration: 2200 });
  document.querySelector(".pf-toast")?.classList.add("added");
}
