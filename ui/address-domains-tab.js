// The Domains tab of an address screen - the chatting address, a spending address, a KasSigner
// address (iOS fe52376 AddressDomainsTab): one card per name service - .kachat, .k, .kaspa, .kas -
// each with how many names this address holds there; tap one to see them. Every service is asked
// at once, for this address only (Your Domains' own lists are left alone).

import { NAME_SERVICES } from "../engine/name-services.js";

/** The order the cards are listed in. */
export const ADDRESS_DOMAIN_ORDER = Object.freeze(["kachat", "k", "kaspa", "kas"]);

let ctx = null;
const renders = new WeakMap();
let seq = 0;

/** `engine` (name lookups), `renderKachat(el, address)` (the .kachat cards and their detail
 *  screens), `kachatNames(address)` (-> display names, or null when the lookup failed),
 *  `refreshKachat()` (the .kachat list's refresh: the registry), `escapeHtml`. Every card has the
 *  globe, .kachat too (iOS 0b68567). */
export function initAddressDomainsTab(deps) {
  ctx = deps;
}

const GLOBE = `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>`;
const CHEVRON = `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>`;
const BACK = `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m15 6-6 6 6 6"/></svg>`;
const REFRESH = `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19.4 12.6A7.5 7.5 0 1 1 17 6.6"/><path d="M19.6 3.8v4.6H15"/></svg>`;
const WARN = `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/></svg>`;

const esc = (value) => (ctx?.escapeHtml ? ctx.escapeHtml(String(value ?? "")) : String(value ?? ""));
const suffixOf = (tld) => `.${tld}`;
const serviceOf = (tld) => NAME_SERVICES[tld]?.serviceName || suffixOf(tld);

function countHtml(state, tld) {
  const count = state.counts.get(tld);
  if (count != null) {
    const label = count === 1 ? "1 domain" : `${count} domains`;
    return `<span class="addr-domains-count${count > 0 ? " has" : ""}" aria-label="${label}">${count}</span>`;
  }
  if (state.failed.has(tld)) return `<span class="addr-domains-warn" role="img" aria-label="Couldn't load">${WARN}</span>`;
  return `<span class="addr-domains-spinner" aria-label="Loading"></span>`;
}

/** The refresh button: the platform's stand-in for iOS's pull-to-refresh on the cards and on each
 *  service's list. */
function refreshHtml(state) {
  return `<button type="button" class="addr-domains-refresh${state.refreshing ? " spinning" : ""}" data-addr-domains-refresh
    aria-label="Refresh" title="Refresh" ${state.refreshing ? "disabled" : ""}>${REFRESH}</button>`;
}

function cardsHtml(state) {
  return `<div class="addr-domains-bar">${refreshHtml(state)}</div><div class="addr-domains-cards">${ADDRESS_DOMAIN_ORDER.map((tld) => `
    <button type="button" class="addr-domains-card" data-addr-domains-open="${tld}">
      <span class="addr-domains-icon" aria-hidden="true">${GLOBE}</span>
      <span class="addr-domains-text"><strong>${esc(suffixOf(tld))}</strong><small>${esc(serviceOf(tld))}</small></span>
      <span data-addr-domains-count="${tld}">${countHtml(state, tld)}</span>
      <span class="addr-domains-chevron" aria-hidden="true">${CHEVRON}</span>
    </button>`).join("")}</div>`;
}

function namesHtml(state, tld) {
  const list = state.names.get(tld) || [];
  if (!list.length) {
    const text = state.failed.has(tld) ? `Couldn't reach ${serviceOf(tld)}. Refresh to try again.` : `No ${suffixOf(tld)} names on this address.`;
    return `<p class="addr-domains-empty">${esc(text)}</p>`;
  }
  return `<div class="addr-domains-names">${list.map((name) => `<div class="kns-domain-card static">${esc(name)}</div>`).join("")}</div>`;
}

function paint(state) {
  const root = state.el.querySelector(`[data-addr-domains="${state.token}"]`);
  if (!root) return;
  if (!state.open) {
    root.innerHTML = cardsHtml(state);
    return;
  }
  const tld = state.open;
  root.innerHTML = `
    <div class="addr-domains-sub">
      <div class="addr-domains-subhead">
        <button type="button" class="addr-domains-back" data-addr-domains-back>${BACK}<span>Domains</span></button>
        <strong>${esc(suffixOf(tld))}</strong>
        ${refreshHtml(state)}
      </div>
      <div data-addr-domains-sub-body>${tld === "kachat" ? "" : namesHtml(state, tld)}</div>
    </div>`;
  // the .kachat cards and their detail screens, as before
  if (tld === "kachat") ctx?.renderKachat?.(root.querySelector("[data-addr-domains-sub-body]"), state.address);
}

function repaintCount(state, tld) {
  const slot = state.el.querySelector(`[data-addr-domains="${state.token}"] [data-addr-domains-count="${tld}"]`);
  if (slot) slot.innerHTML = countHtml(state, tld);
  else if (state.open === tld && tld !== "kachat") paint(state);
}

function set(state, tld, list) {
  state.names.set(tld, list);
  state.counts.set(tld, list.length);
  state.failed.delete(tld);
  repaintCount(state, tld);
}
function fail(state, tld) {
  if (!state.counts.has(tld)) state.failed.add(tld);
  repaintCount(state, tld);
}

/** Every service at once, for this address. */
async function load(state) {
  const { engine } = ctx || {};
  const address = state.address;
  const live = () => renders.get(state.el) === state;
  const kachat = (async () => {
    try {
      const list = await ctx?.kachatNames?.(address);
      if (!live()) return;
      if (Array.isArray(list)) set(state, "kachat", list); else fail(state, "kachat");
    } catch { if (live()) fail(state, "kachat"); }
  })();
  const services = (async () => {
    let result = null;
    try { result = await engine?.listOtherServiceNames?.(address); } catch { result = null; }
    if (!live()) return;
    for (const tld of ["k", "kaspa"]) {
      const entry = result?.[tld];
      if (entry?.state === "ok") set(state, tld, entry.names.map((n) => n.display || `${n.name}.${tld}`));
      else fail(state, tld);
    }
  })();
  const kas = (async () => {
    try {
      const info = await engine?.fetchKnsAddressInfo?.(address);
      if (!live()) return;
      // a failed lookup comes back uncached with fetchedAt 0 (engine/kns.js), not as a throw
      if (!info || (!info.fetchedAt && !info.allDomains?.length)) { fail(state, "kas"); return; }
      const domains = Array.isArray(info.allDomains) ? info.allDomains : [];
      set(state, "kas", domains.map((d) => d?.fullName || String(d || "")).filter(Boolean));
    } catch { if (live()) fail(state, "kas"); }
  })();
  await Promise.all([kachat, services, kas]);
}

/** The refresh button: the cards and a service's list ask every service again (iOS
 *  AddressDomainsTab .refreshable { load() }); the .kachat list re-reads the registry (iOS
 *  KachatAddressLiveNamesList: registry.refresh), which reloads it. */
async function refreshTab(state) {
  if (state.refreshing) return;
  state.refreshing = true;
  paintRefresh(state);
  try {
    if (state.open === "kachat") await ctx?.refreshKachat?.();
    else await load(state);
  } catch { /* each list says what it could read */ }
  state.refreshing = false;
  paintRefresh(state);
}
function paintRefresh(state) {
  if (renders.get(state.el) !== state) return;
  state.el.querySelectorAll(`[data-addr-domains="${state.token}"] [data-addr-domains-refresh]`).forEach((button) => {
    button.classList.toggle("spinning", state.refreshing);
    button.disabled = state.refreshing;
  });
}

/** Draws (or, for the same address, reloads in place) the Domains tab into `el`. */
export function renderAddressDomainsTab(el, address) {
  if (!el || !address) return;
  const key = String(address).trim().toLowerCase();
  const previous = renders.get(el);
  if (previous && previous.address === key && el.querySelector(`[data-addr-domains="${previous.token}"]`)) {
    if (previous.open === "kachat") paint(previous);
    void load(previous);
    return;
  }
  const state = { el, address: key, token: String(++seq), open: null, counts: new Map(), names: new Map(), failed: new Set(), refreshing: false };
  renders.set(el, state);
  el.innerHTML = `<div class="addr-domains" data-addr-domains="${state.token}"></div>`;
  paint(state);
  if (!el.dataset.addrDomainsBound) {
    el.dataset.addrDomainsBound = "1";
    el.addEventListener("click", (event) => {
      const current = renders.get(el);
      if (!current) return;
      const open = event.target.closest("[data-addr-domains-open]");
      if (open && el.contains(open)) { current.open = open.dataset.addrDomainsOpen; paint(current); return; }
      if (event.target.closest("[data-addr-domains-back]")) { current.open = null; paint(current); return; }
      const refresh = event.target.closest("[data-addr-domains-refresh]");
      if (refresh && el.contains(refresh)) refreshTab(current);
    });
  }
  void load(state);
}
