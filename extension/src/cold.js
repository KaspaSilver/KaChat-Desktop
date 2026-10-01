// Cold Storage - a 1:1 port of the iOS tab (Views/ColdStorage/ColdStorageView.swift and
// Services/ColdStorageManager.swift):
//
//   ColdStorageListView          the tab root: watch-only KasSigner accounts, Paste kpub / Scan,
//                                Enter kpub, Name This Account, the account actions sheet
//                                (Copy kpub, Show kpub QR, Rename) and the kpub QR page
//   ColdStorageDetailView        one account: Name, kpub, Total Balance, Address Actions
//                                (Generate More, Discover, Address Visibility), its addresses
//   ColdStorageAddressVisibilityView   the checklist, 50 a page, endless
//   ColdStorageAddressTransactionHistoryView   one address: History | UTXOs | .kachat,
//                                Receive / Send, the Transaction sheet (Add to Portfolio),
//                                Compound UTXOs, Rename UTXO
// The KasSigner send flow is in cold-send.js.
//
// A cold account is a kpub (account m/44'/111111'/0') and nothing else: the receive chain
// (kpub -> 0 -> i) is derived here, change goes back to the sending address, and signing happens
// on the device over a QR exchange. Accounts are kept per wallet account, like iOS keeps them
// per wallet. Left out: the per-account receive notifications toggle (the extension has none).

import "./cold.css";
import QRCode from "qrcode";
import * as wallet from "./wallet.js";
import * as vault from "./vault.js";
import * as dock from "./dock.js";
import { getLocal, setLocal } from "./browser.js";
import {
  app, esc, render, $, toast, copyText, ICONS, navHeader, showQr, showSheet, showAlert, formatKas8,
} from "./ui.js";
import { scanQr } from "./camera.js";
import { kachatWordmark } from "./market.js";
import { showAddToPortfolio } from "./portfolio.js";
import { showColdSend } from "./cold-send.js";
import { SF, txDate, feeText, portfolioKas, middle, shortAddress, fieldSheet } from "./cold-common.js";

const INVALID_KPUB = "That doesn't look like a valid Kaspa extended public key (kpub).";

// --- storage: kachat.cold.<wallet account id> -> [{ id, label, kpub, maxAddressIndex,
//     importedAt, labels: { index: label }, hidden: [index] }] ---------------------------------

let store = { key: null, accounts: [] };

async function storageKey() {
  const view = await vault.readAccounts();
  return `kachat.cold.${view.activeAccountId || view.accounts?.[0]?.id || "default"}`;
}

function normalize(raw) {
  if (!raw || typeof raw.kpub !== "string" || !raw.kpub) return null;
  return {
    id: String(raw.id || crypto.randomUUID()),
    label: String(raw.label || "Cold Storage"),
    kpub: raw.kpub.trim(),
    maxAddressIndex: Math.max(0, Number.parseInt(raw.maxAddressIndex, 10) || 0),
    importedAt: Number(raw.importedAt) || Date.now(),
    labels: raw.labels && typeof raw.labels === "object" ? { ...raw.labels } : {},
    hidden: Array.isArray(raw.hidden) ? [...new Set(raw.hidden.map(Number).filter(Number.isInteger))] : [],
  };
}

async function loadAccounts() {
  const key = await storageKey();
  const raw = await getLocal(key);
  const accounts = Array.isArray(raw) ? raw.map(normalize).filter(Boolean) : [];
  store = { key, accounts };
  return accounts;
}

async function saveAccounts(accounts) {
  const key = await storageKey();
  store = { key, accounts };
  await setLocal(key, accounts);
}

async function getAccount(id) {
  return (await loadAccounts()).find((a) => a.id === id) || null;
}

/** Reads fresh, changes one account, writes back. Returns the changed account (or null). */
async function updateAccount(id, change) {
  const accounts = await loadAccounts();
  const account = accounts.find((a) => a.id === id);
  if (!account) return null;
  change(account);
  await saveAccounts(accounts);
  return account;
}

/** iOS importAccount: a kpub already watched only takes the new name. */
async function importAccount(kpub, label) {
  const accounts = await loadAccounts();
  const name = label.trim() || `Cold Storage ${accounts.length + 1}`;
  const existing = accounts.find((a) => a.kpub === kpub);
  if (existing) existing.label = name;
  else accounts.push(normalize({ id: crypto.randomUUID(), label: name, kpub, maxAddressIndex: 0, importedAt: Date.now() }));
  await saveAccounts(accounts);
}

function labelOf(account, index) {
  const label = String(account.labels?.[index] ?? "").trim();
  return label || null;
}

/** iOS displayLabel: your label, else "Address #<index>". */
function displayLabel(entry) {
  return entry.label || `Address #${entry.index}`;
}

// --- per-address knowledge shared by the account screen and the checklist -------------------

const balanceCache = new Map(); // address -> sompi, last known
const domainOwners = new Map(); // address -> owns a KNS domain
const usedState = new Map();    // address -> true | false | "unknown" (probe failed)

/** iOS getAddressList: 0...maxAddressIndex with live balances (batched), labels and hidden. */
async function addressList(account) {
  const addresses = await wallet.kpubAddresses(account.kpub, 0, account.maxAddressIndex + 1);
  let balances = null;
  try { balances = await wallet.balancesFor(addresses); } catch { balances = null; }
  const hidden = new Set(account.hidden);
  return addresses.map((address, index) => {
    const balanceSompi = balances ? (balances[address] ?? 0n) : (balanceCache.get(address) ?? 0n);
    if (balances) balanceCache.set(address, balanceSompi);
    return { index, address, balanceSompi, label: labelOf(account, index), hidden: hidden.has(index) };
  });
}

async function ownsDomain(address) {
  if (domainOwners.has(address)) return domainOwners.get(address);
  try {
    const data = await wallet.domains(address);
    domainOwners.set(address, data.domains.length > 0);
    return data.domains.length > 0;
  } catch {
    return false;
  }
}

/** Has it ever been used? true / false, or null when the probe failed (iOS spendingAddressUsedState). */
async function probeUsed(address) {
  const known = await wallet.knownUsedState(address);
  if (known != null) return known;
  return wallet.addressUsed(address);
}

/** Hiding re-checks the live balance and fails closed (iOS setAddressHidden). */
async function setHidden(account, index, hidden) {
  if (hidden) {
    try {
      const [address] = await wallet.kpubAddresses(account.kpub, index, index + 1);
      const live = (await wallet.balancesFor([address]))[address] ?? 0n;
      if (live > 0n) return false;
    } catch {
      return false;
    }
  }
  await updateAccount(account.id, (a) => {
    const set = new Set(a.hidden);
    if (hidden) set.add(index); else set.delete(index);
    a.hidden = [...set];
  });
  return true;
}

/** iOS revealAddress: extends the chain to `index`, keeping the indexes in between hidden. */
async function revealAddress(account, index) {
  await updateAccount(account.id, (a) => {
    const set = new Set(a.hidden);
    if (index > a.maxAddressIndex) {
      for (let i = a.maxAddressIndex + 1; i < index; i += 1) set.add(i);
      a.maxAddressIndex = index;
    }
    set.delete(index);
    a.hidden = [...set];
  });
}

/**
 * iOS lowestUnusedAddress ("Generate More Addresses"): the lowest HIDDEN index with no balance
 * that a probe confirms was never used is shown again; otherwise the chain grows by one.
 */
async function generateAddress(accountId) {
  const account = await getAccount(accountId);
  if (!account) throw new Error("This account is no longer in Cold Storage.");
  const entries = await addressList(account);
  let pick = null;
  for (const entry of entries) {
    if (!entry.hidden || entry.balanceSompi > 0n) continue;
    if ((await probeUsed(entry.address)) === false) { pick = entry.index; break; }
  }
  await updateAccount(accountId, (a) => {
    if (pick == null) { a.maxAddressIndex += 1; pick = a.maxAddressIndex; }
    a.hidden = a.hidden.filter((i) => i !== pick);
  });
  return pick;
}

/**
 * iOS discoverAddresses: the first thousand addresses whatever the gaps. POST /addresses/active
 * says which were ever touched; only those are asked for balances, and the unfunded ones under
 * #200 for a KNS domain. A match holds a balance or a domain. Without /addresses/active it falls
 * back to the batched sweep (100 a batch, KNS under #200, past #1000 it stops after 60 misses).
 * Returns how many matched.
 */
async function discoverAddresses(accountId, onProgress) {
  const DEPTH = 1000;
  const MAX_INDEX = 5000;
  const BATCH = 100;
  const KNS_DEPTH = 200;
  const GAP = 60;
  const account = await getAccount(accountId);
  if (!account) return 0;
  let lastMatch = -1;
  let matchCount = 0;
  const matched = new Set();
  const window = await wallet.kpubAddresses(account.kpub, 0, DEPTH);
  onProgress({ checkingIndex: 0, foundCount: 0 });

  let activity = null;
  try { activity = await wallet.addressesActive(window); } catch { activity = null; }
  if (activity) {
    const touched = window.map((address, index) => ({ address, index })).filter((t) => activity[t.address]);
    const funded = new Set();
    if (touched.length) {
      try {
        const balances = await wallet.balancesFor(touched.map((t) => t.address));
        for (const [address, sompi] of Object.entries(balances)) {
          balanceCache.set(address, sompi);
          if (sompi > 0n) funded.add(address);
        }
      } catch { /* a balance we cannot read is not an empty one; KNS still decides below */ }
    }
    onProgress({ checkingIndex: touched.length ? touched[touched.length - 1].index : 0, foundCount: funded.size });
    const owners = new Set();
    await Promise.all(touched
      .filter((t) => t.index < KNS_DEPTH && !funded.has(t.address))
      .map(async (t) => { if (await ownsDomain(t.address)) owners.add(t.address); }));
    for (const t of touched) {
      if (funded.has(t.address) || owners.has(t.address)) {
        lastMatch = Math.max(lastMatch, t.index);
        matchCount += 1;
        matched.add(t.index);
      }
    }
  } else {
    let misses = 0;
    let index = 0;
    while (index < MAX_INDEX) {
      if (index >= DEPTH && misses >= GAP) break;
      onProgress({ checkingIndex: index, foundCount: matchCount });
      const upper = Math.min(index + BATCH, MAX_INDEX);
      const derived = upper <= DEPTH ? window.slice(index, upper) : await wallet.kpubAddresses(account.kpub, index, upper);
      if (!derived.length) break;
      let balances;
      try { balances = await wallet.balancesFor(derived); } catch { break; }
      for (let i = 0; i < derived.length; i += 1) {
        const address = derived[i];
        const at = index + i;
        balanceCache.set(address, balances[address] ?? 0n);
        const matches = (balances[address] ?? 0n) > 0n || (at < KNS_DEPTH && await ownsDomain(address));
        if (matches) {
          lastMatch = at;
          matchCount += 1;
          matched.add(at);
          misses = 0;
        } else {
          misses += 1;
        }
      }
      index += derived.length;
    }
  }

  // The bound covers the highest match (it only grows); the empty indexes it sweeps in are
  // hidden, and every match is shown again.
  await updateAccount(accountId, (a) => {
    const hidden = new Set(a.hidden);
    if (lastMatch > a.maxAddressIndex) {
      const previous = a.maxAddressIndex;
      a.maxAddressIndex = lastMatch + 1;
      for (let i = previous + 1; i < lastMatch; i += 1) if (!matched.has(i)) hidden.add(i);
    }
    for (const i of matched) hidden.delete(i);
    a.hidden = [...hidden];
  });
  return matchCount;
}

// =============================================================================================
// SCREEN 1 - the list (tab root)
// =============================================================================================

export function showColdStorage() {
  const paint = (accounts) => {
    const scroll = app.querySelector(".cold-scroll")?.scrollTop || 0;
    render(`
      ${dock.tabTopHtml("Cold Storage")}
      <div class="cold-scroll">
        ${accounts && !accounts.length ? `
          <div class="cold-empty">
            <span class="muted">${SF.lockShield}</span>
            <div class="cold-empty-title">No Cold Storage Accounts</div>
            <p class="muted">Scan or paste a kpub exported from your KasSigner device to watch its balance.</p>
          </div>` : ""}
        ${(accounts || []).map((account) => `
          <div class="glass cold-account" data-open="${esc(account.id)}" role="button" tabindex="0">
            <span class="accent cold-account-lock">${SF.lockFill}</span>
            <span class="tx-meta">
              <span class="cold-account-label">${esc(account.label)}</span>
              <span class="muted tiny cold-account-kpub">${esc(middle(account.kpub, 15))}</span>
            </span>
            <button class="icon plain cold-more" data-more="${esc(account.id)}" aria-label="Account actions">${SF.ellipsis}</button>
          </div>`).join("")}
      </div>
      <div class="ios-bottom-bar cold-list-bar">
        <button class="ios-capsule with-icon" id="paste-kpub">${SF.docOnClipboard}<span>Paste kpub</span></button>
        <button class="ios-capsule with-icon cold-bold" id="scan-kpub">${SF.viewfinder}<span>Scan</span></button>
      </div>`, "cold:list");
    dock.bindTabTop();
    dock.remember(() => showColdStorage());
    const scroller = app.querySelector(".cold-scroll");
    if (scroller) scroller.scrollTop = scroll;
    const byId = (id) => (accounts || []).find((a) => a.id === id);
    for (const row of app.querySelectorAll("[data-open]")) {
      row.onclick = (event) => {
        if (event.target.closest("[data-more]")) return;
        showAccount({ accountId: row.dataset.open, onBack: () => showColdStorage() });
      };
      row.onkeydown = (event) => { if (event.key === "Enter") row.click(); };
    }
    for (const button of app.querySelectorAll("[data-more]")) button.onclick = () => accountActions(byId(button.dataset.more));
    $("#paste-kpub").onclick = () => manualEntry();
    $("#scan-kpub").onclick = async () => {
      const code = await scanQr({ title: "Scan QR Code", hint: "Point camera at a QR code" });
      if (code) beginImport(code);
    };
  };

  const refresh = async () => {
    try {
      const accounts = await loadAccounts();
      if (app.dataset.screen === "cold:list") paint(accounts);
    } catch (error) {
      toast(error.message);
    }
  };

  // Paints at once from what is known, then from storage.
  paint(store.accounts.length ? store.accounts : null);
  refresh();

  // Enter kpub: a half sheet with one field.
  function manualEntry() {
    fieldSheet({
      title: "Enter kpub",
      subtitle: "Paste the kpub exported from your KasSigner device. It contains no private key material.",
      placeholder: "kpub...",
      multiline: true,
      mono: true,
      confirmLabel: "Next",
      onConfirm: (text) => beginImport(text),
    });
  }

  async function beginImport(raw) {
    const kpub = await wallet.validateKpub(String(raw || "").trim());
    if (!kpub) {
      showAlert({ title: "Import Failed", message: INVALID_KPUB, confirmLabel: "OK" });
      return;
    }
    const count = (await loadAccounts()).length;
    fieldSheet({
      title: "Name This Account",
      subtitle: "Give this account a name so you can recognize it.",
      placeholder: "Name",
      value: `Cold Storage ${count + 1}`,
      confirmLabel: "Import",
      onConfirm: async (name) => {
        try {
          await importAccount(kpub, name);
        } catch (error) {
          showAlert({ title: "Import Failed", message: error.message, confirmLabel: "OK" });
        }
        refresh();
      },
    });
  }

  function accountActions(account) {
    if (!account) return;
    showSheet({
      title: account.label,
      cancel: false,
      rows: [
        {
          label: "Copy kpub", subtitle: "Puts the extended public key on the clipboard.", icon: SF.doc,
          onClick: () => copyKpub(account.kpub),
        },
        {
          label: "Show kpub QR", subtitle: "Scan it into another device to watch this account there.", icon: SF.qrcode,
          onClick: () => showKpubQr({ account, onBack: () => showColdStorage() }),
        },
        {
          label: "Rename", subtitle: "Changes the name shown for this account.", icon: SF.pencil,
          onClick: () => fieldSheet({
            title: "Rename Account",
            placeholder: "Name",
            value: account.label,
            confirmLabel: "Save",
            onCancel: () => accountActions(account),
            onConfirm: async (name) => { await updateAccount(account.id, (a) => { a.label = name; }); refresh(); },
          }),
        },
      ],
    });
  }
}

async function copyKpub(kpub) {
  try {
    await navigator.clipboard.writeText(kpub);
    toast("kpub copied to clipboard.");
  } catch {
    toast("Couldn't copy - select and copy it instead");
  }
}

// iOS ColdStorageKpubQRView: a white page, the kpub's QR (error correction L) in the accent
// frame, the kpub, what showing it means, "Tap anywhere to copy".
async function showKpubQr({ account, onBack }) {
  render(`
    <header class="navbar qr-bar">
      <button class="nav-back" id="back" aria-label="Close">${ICONS.back}<span>Close</span></button>
      <div class="nav-title cold-nav-title">${esc(account.label)}</div>
    </header>
    <section class="qr-page cold-kpub-page" id="qr-page" title="Tap anywhere to copy">
      <div class="qr-frame cold-kpub-frame"><canvas id="qr" width="520" height="520" aria-label="QR code for the kpub"></canvas></div>
      <div class="cold-kpub-text">${esc(account.kpub)}</div>
      <p class="cold-kpub-note">Watch-only. This cannot spend, but it reveals every address in this account.</p>
      <p class="qr-hint">Tap anywhere to copy</p>
    </section>`, "qr");
  $("#back").onclick = onBack;
  $("#qr-page").onclick = () => copyKpub(account.kpub);
  try {
    await QRCode.toCanvas($("#qr"), account.kpub, { errorCorrectionLevel: "L", margin: 1, width: 520, color: { dark: "#000000", light: "#ffffff" } });
  } catch { /* the kpub text is still there to copy */ }
}

// =============================================================================================
// SCREEN 2 - one account
// =============================================================================================

function showAccount({ accountId, onBack }) {
  const state = {
    account: store.accounts.find((a) => a.id === accountId) || null,
    entries: null,
    loading: true,
    busy: null,         // "generate"
    discovery: null,    // { checkingIndex, foundCount }
    summary: "",
    loadToken: 0,
  };
  let actionsSheet = null;
  const here = () => app.dataset.screen === "cold:account" && app.dataset.coldAccount === accountId;
  const repaintIfHere = () => { if (here()) paint(); };
  const back = () => { paint(); load(); };

  const visibleEntries = () => {
    const rows = (state.entries || []).filter((e) => !e.hidden)
      .sort((a, b) => (Number(b.balanceSompi > 0n) - Number(a.balanceSompi > 0n)) || b.index - a.index);
    const active = rows.filter((e) => e.balanceSompi > 0n || domainOwners.get(e.address));
    const fresh = rows.filter((e) => !(e.balanceSompi > 0n || domainOwners.get(e.address)));
    return [...active, ...fresh];
  };

  async function load() {
    const token = ++state.loadToken;
    const account = await getAccount(accountId);
    if (token !== state.loadToken) return;
    if (!account) { if (here()) onBack(); return; }
    state.account = account;
    if (!state.entries) state.loading = true;
    repaintIfHere();
    let entries;
    try {
      entries = await addressList(account);
    } catch (error) {
      if (token !== state.loadToken) return;
      state.loading = false;
      toast(error.message);
      repaintIfHere();
      return;
    }
    if (token !== state.loadToken) return;
    state.entries = entries;
    state.loading = false;
    repaintIfHere();
    await fillUsed(token);
    await fillDomains(token);
  }

  // Used / Unused for the zero-balance rows on the list: what is known, then one bulk
  // /addresses/active for a long list, else the transactions-count probe four at a time.
  async function fillUsed(token) {
    const pending = [];
    for (const entry of state.entries.filter((e) => !e.hidden && e.balanceSompi === 0n)) {
      const known = usedState.get(entry.address);
      if (known === true || known === false) continue;
      const remembered = await wallet.knownUsedState(entry.address);
      if (remembered != null) usedState.set(entry.address, remembered); else pending.push(entry);
    }
    if (token !== state.loadToken) return;
    repaintIfHere();
    if (pending.length > 8) {
      const active = await wallet.addressesActive(pending.map((e) => e.address)).catch(() => null);
      if (token !== state.loadToken) return;
      if (active) {
        for (const entry of pending) usedState.set(entry.address, Boolean(active[entry.address]));
        repaintIfHere();
        return;
      }
    }
    const queue = [...pending];
    const worker = async () => {
      for (let entry = queue.shift(); entry; entry = queue.shift()) {
        const used = await wallet.addressUsed(entry.address);
        if (token !== state.loadToken) return;
        usedState.set(entry.address, used == null ? "unknown" : used);
        repaintIfHere();
      }
    };
    await Promise.all(Array.from({ length: 4 }, worker));
  }

  // "Contains domain" tags, after the rows are up (KNS, four at a time, cached).
  async function fillDomains(token) {
    const queue = state.entries.filter((e) => !e.hidden && !domainOwners.has(e.address));
    let changed = false;
    const worker = async () => {
      for (let entry = queue.shift(); entry; entry = queue.shift()) {
        if (token !== state.loadToken) return;
        if (await ownsDomain(entry.address)) changed = true;
      }
    };
    await Promise.all(Array.from({ length: 4 }, worker));
    if (changed && token === state.loadToken) repaintIfHere();
  }

  const usedBadge = (entry) => {
    if (entry.balanceSompi > 0n || usedState.get(entry.address) === true) return '<span class="used-badge used">Used</span>';
    if (usedState.get(entry.address) === false) return '<span class="used-badge unused">Unused</span>';
    return '<span class="used-badge">Checking</span>';
  };

  // --- sheets ---------------------------------------------------------------------------------

  const rowActions = (entry) => showSheet({
    title: displayLabel(entry),
    headerHtml: `<div class="mono tiny muted">${esc(shortAddress(entry.address))}</div>`,
    cancel: false,
    rows: [
      { label: "Rename Address", subtitle: "Gives this address a label of your own.", icon: SF.pencil, onClick: () => renameAddress(entry) },
      { label: "Copy Address", subtitle: "Puts the full address on the clipboard.", icon: SF.doc, onClick: () => copyText(entry.address) },
      { label: "Show QR Code", subtitle: "Full screen, for scanning with another device.", icon: SF.qrcode, onClick: () => showQr({ title: displayLabel(entry), address: entry.address, backLabel: "Close", onBack: back }) },
      ...(entry.balanceSompi === 0n ? [{
        label: "Hide Address", subtitle: "Removes it from this list. Re-enable it in Address Visibility.", icon: SF.eyeSlash, tint: "orange",
        onClick: () => hideAddress(entry),
      }] : []),
    ],
  });

  const renameAddress = (entry) => showAlert({
    title: "Rename Address",
    field: { placeholder: "Label", value: entry.label || "" },
    confirmLabel: "Save",
    cancelLabel: "Cancel",
    onConfirm: async (value) => {
      const clean = String(value || "").trim();
      await updateAccount(accountId, (a) => { if (clean) a.labels[entry.index] = clean; else delete a.labels[entry.index]; });
      load();
    },
  });

  const hideAddress = async (entry) => {
    const ok = await setHidden(state.account, entry.index, true);
    if (!ok) { toast("This address can't be hidden."); return; }
    entry.hidden = true;
    paint();
    toast("Address hidden. Re-enable it in Address Visibility.");
    load();
  };

  const actionRows = () => {
    const discovering = Boolean(state.discovery);
    return [
      { label: "Generate More Addresses", subtitle: "Reveals the next unused address in this account.", icon: SF.plusCircle, busy: state.busy === "generate", disabled: discovering, onClick: generate },
      { label: "Discover Addresses", subtitle: "Finds addresses holding a balance or a KNS domain.", icon: SF.magnifier, disabled: discovering, keepOpen: true, onClick: discover },
      { label: "Address Visibility", subtitle: "Check off every address you want on the list, in one sitting.", icon: SF.checklist, disabled: discovering, onClick: () => showVisibility({ accountId, onDone: back }) },
    ];
  };

  const discoveryHtml = () => {
    const d = state.discovery;
    if (!d) return state.summary ? `<p class="muted small strong sheet-summary center-text">${esc(state.summary)}</p>` : "";
    return `
      <div class="discovery">
        <span class="spinner"></span>
        <div class="strong">Checking address #${d.checkingIndex}</div>
        <div class="muted small">${d.foundCount ? `${d.foundCount} found so far` : "No used addresses yet"}</div>
        <div class="muted tiny">Checks the first thousand addresses whatever the gaps, then keeps going while it keeps finding.</div>
        <button class="sheet-row center-text cold-keep-scanning" id="keep-scanning"><span class="sheet-label accent">Close and Keep Scanning</span></button>
      </div>`;
  };

  const openActions = () => {
    state.summary = "";
    actionsSheet = showSheet({ title: "Address Actions", cancel: false, rows: state.discovery ? [] : actionRows(), footerHtml: discoveryHtml() });
    bindKeepScanning();
  };
  const refreshActions = () => {
    if (!actionsSheet?.isOpen()) return;
    actionsSheet.update({ rows: state.discovery ? [] : actionRows(), footerHtml: discoveryHtml() });
    bindKeepScanning();
  };
  const bindKeepScanning = () => {
    const keep = document.querySelector("#keep-scanning");
    if (keep) keep.onclick = () => actionsSheet.close();
  };

  async function generate() {
    if (state.busy) return;
    state.busy = "generate";
    repaintIfHere();
    try {
      const index = await generateAddress(accountId);
      await load();
      toast(`Address #${index} is ready.`);
    } catch (error) {
      toast(error.message);
    }
    state.busy = null;
    repaintIfHere();
  }

  async function discover() {
    if (state.discovery) return;
    state.discovery = { checkingIndex: 0, foundCount: 0 };
    state.summary = "";
    refreshActions();
    repaintIfHere();
    let message;
    try {
      const found = await discoverAddresses(accountId, (progress) => { state.discovery = progress; refreshActions(); });
      message = found ? `Found ${found} address${found === 1 ? "" : "es"} with a balance or domain.` : "No addresses with a balance or domain found.";
    } catch (error) {
      message = error.message;
    }
    await load();
    state.discovery = null;
    // Sheet still open: the result shows in it. Closed: it arrives as a toast.
    if (actionsSheet?.isOpen()) { state.summary = message; refreshActions(); } else toast(message);
    repaintIfHere();
  }

  const renameAccount = () => fieldSheet({
    title: "Rename Account",
    subtitle: state.account.label,
    placeholder: "Name",
    value: state.account.label,
    confirmLabel: "Save",
    onConfirm: async (name) => {
      const account = await updateAccount(accountId, (a) => { a.label = name; });
      if (account) state.account = account;
      repaintIfHere();
    },
  });

  const removeAccount = () => {
    showAlert({
      title: "Remove Cold Storage Account",
      message: "This only removes it from KaChat's watch list. It has no effect on the KasSigner device or any funds it holds.",
      confirmLabel: "Remove",
      cancelLabel: "Cancel",
      onConfirm: async () => {
        await saveAccounts((await loadAccounts()).filter((a) => a.id !== accountId));
        onBack();
      },
    });
    document.querySelector(".alert-button.strong")?.classList.add("cold-destructive");
  };

  // --- paint ------------------------------------------------------------------------------------

  function paint() {
    const account = state.account;
    if (!account) {
      render(`${navHeader({})}<div class="manage-scroll"><div class="center-text pad"><span class="spinner"></span></div></div>`, "cold:account");
      app.dataset.coldAccount = accountId;
      $("#back").onclick = onBack;
      return;
    }
    const rows = visibleEntries();
    const total = (state.entries || []).filter((e) => !e.hidden).reduce((sum, e) => sum + e.balanceSompi, 0n);
    const busy = Boolean(state.discovery) || state.busy === "generate";
    const scroll = app.querySelector(".manage-scroll")?.scrollTop || 0;
    render(`
      <header class="navbar">
        <button class="nav-back" id="back" aria-label="Back">${ICONS.back}<span>Back</span></button>
        <div class="nav-title cold-nav-title">${esc(account.label)}</div>
        <div class="nav-right"><button class="icon plain cold-trash" id="remove" aria-label="Remove Cold Storage Account">${SF.trash}</button></div>
      </header>
      <div class="manage-scroll cold-detail">
        <div class="cold-summary">
          <div class="cold-summary-name">
            <div class="tx-meta"><span class="muted cold-caption">Name</span><span class="strong cold-name">${esc(account.label)}</span></div>
            <button class="icon plain accent cold-pencil" id="rename-account" aria-label="Rename Account">${SF.pencilSmall}</button>
          </div>
          <div class="cold-summary-kpub">
            <span class="muted cold-caption">kpub</span>
            <span class="mono cold-kpub">${esc(account.kpub)}</span>
            <button class="link-button cold-copy-kpub" id="copy-kpub">${SF.docSmall}<span>Copy kpub</span></button>
          </div>
          <div class="tx-meta">
            <span class="muted cold-caption">Total Balance</span>
            <span class="cold-total">${state.entries ? `${esc(formatKas8(total))} KAS` : '<span class="spinner small-spin"></span>'}</span>
          </div>
          <button class="ios-capsule" id="address-actions" ${busy ? "disabled" : ""}>${busy ? '<span class="spinner dark-spinner small-spin"></span>' : "Address Actions"}</button>
        </div>
        ${state.loading && !state.entries ? '<div class="center-text cold-loading"><span class="spinner"></span></div>'
          : !rows.length ? '<p class="muted cold-none">No addresses discovered yet.</p>'
          : rows.map((entry) => `
            <div class="glass address-card cold-address" data-open="${entry.index}" role="button" tabindex="0">
              <div class="address-card-main">
                <span class="accent cold-row-label">${esc(displayLabel(entry))}</span>
                <span class="mono cold-row-address">${esc(shortAddress(entry.address))}</span>
                <span class="strong cold-row-amount">${esc(formatKas8(entry.balanceSompi))} KAS</span>
                <span class="address-status">${usedBadge(entry)}${domainOwners.get(entry.address) ? '<span class="domain-tag">Contains domain</span>' : ""}</span>
              </div>
              <button class="icon plain card-menu" data-menu="${entry.index}" aria-label="Address actions">${SF.ellipsisV}</button>
            </div>`).join("")}
      </div>`, "cold:account");
    app.dataset.coldAccount = accountId;
    dock.remember(() => paint());
    const scroller = app.querySelector(".manage-scroll");
    if (scroller) scroller.scrollTop = scroll;
    $("#back").onclick = onBack;
    $("#remove").onclick = removeAccount;
    $("#rename-account").onclick = renameAccount;
    $("#copy-kpub").onclick = () => copyKpub(account.kpub);
    $("#address-actions").onclick = openActions;
    const byIndex = (index) => state.entries.find((e) => e.index === Number(index));
    for (const card of app.querySelectorAll("[data-open]")) {
      card.onclick = (event) => {
        if (event.target.closest("[data-menu]")) return;
        showAddress({ accountId, entry: byIndex(card.dataset.open), onBack: back });
      };
      card.onkeydown = (event) => { if (event.key === "Enter") card.click(); };
    }
    for (const button of app.querySelectorAll("[data-menu]")) button.onclick = () => rowActions(byIndex(button.dataset.menu));
  }

  paint();
  load();
}

// =============================================================================================
// SCREEN 3 - Address Visibility (an iOS sheet: no dock)
// =============================================================================================

function showVisibility({ accountId, onDone }) {
  const PAGE = 50;
  const state = { page: 0, account: null, entries: null, pageRows: null, used: new Map(), token: 0 };
  const here = () => app.dataset.screen === "cold-visibility";

  const loadEntries = async () => {
    state.account = await getAccount(accountId);
    if (!state.account) return onDone();
    state.entries = await addressList(state.account);
  };

  // The rows of this page: the loaded ones, and past the end freshly derived (hidden, no balance).
  const loadPage = async () => {
    const token = ++state.token;
    state.pageRows = null;
    paint();
    try {
      if (!state.entries) await loadEntries();
      const start = state.page * PAGE;
      const byIndex = new Map(state.entries.map((e) => [e.index, e]));
      const missing = byIndex.has(start + PAGE - 1) ? [] : await wallet.kpubAddresses(state.account.kpub, start, start + PAGE);
      if (token !== state.token) return;
      state.pageRows = Array.from({ length: PAGE }, (_, i) => byIndex.get(start + i)
        || { index: start + i, address: missing[i], balanceSompi: 0n, label: labelOf(state.account, start + i), hidden: true, derivedOnly: true })
        .filter((row) => row.address);
    } catch {
      if (token === state.token) state.pageRows = [];
    }
    if (token !== state.token) return;
    paint();
    // Used / Unused for this page's zero-balance rows, lazily; a failed probe keeps "…".
    const queue = state.pageRows.filter((r) => r.balanceSompi === 0n && !state.used.has(r.address));
    const worker = async () => {
      for (let row = queue.shift(); row; row = queue.shift()) {
        const used = await probeUsed(row.address);
        if (used != null) state.used.set(row.address, used);
        if (token === state.token && here()) paint();
      }
    };
    Promise.all(Array.from({ length: 6 }, worker));
  };

  const toggle = async (row) => {
    if (row.balanceSompi > 0n) return; // funded rows don't toggle
    const derivedMax = state.entries.length ? state.entries[state.entries.length - 1].index : -1;
    if (row.index > derivedMax) {
      await revealAddress(state.account, row.index);
      await loadEntries();
    } else {
      const ok = await setHidden(state.account, row.index, !row.hidden);
      if (!ok) return;
      row.hidden = !row.hidden;
      state.account = await getAccount(accountId);
    }
    const byIndex = new Map(state.entries.map((e) => [e.index, e]));
    state.pageRows = state.pageRows.map((r) => byIndex.get(r.index) || r);
    if (here()) paint();
  };

  const trailing = (row) => {
    if (row.balanceSompi > 0n) return `<span class="accent tiny strong">${esc((Number(row.balanceSompi) / 1e8).toFixed(4))} KAS</span>`;
    const used = state.used.get(row.address);
    if (used === true) return '<span class="used-badge used tiny">Used</span>';
    if (used === false) return '<span class="muted tiny strong">Unused</span>';
    return '<span class="muted tiny">…</span>';
  };

  function paint() {
    const start = state.page * PAGE;
    render(`
      <header class="navbar form-bar">
        <span></span>
        <div class="nav-title">Address Visibility</div>
        <button class="bar-text strong" id="done">Done</button>
      </header>
      <div class="manage-scroll flush" id="vis-scroll">
        ${!state.pageRows ? '<div class="center-text pad"><span class="spinner"></span></div>'
          : !state.pageRows.length ? '<p class="muted center-text pad">These addresses couldn\'t be derived right now. Go back a page or reopen this screen to retry.</p>'
          : `<div class="plain-list">${state.pageRows.map((row) => {
              const visible = !row.hidden;
              const funded = row.balanceSompi > 0n;
              return `
                <button class="vis-row ${funded ? "locked" : ""}" data-vis="${row.index}" ${funded ? 'aria-disabled="true"' : ""}>
                  <span class="${visible ? "accent" : "muted"}">${visible ? ICONS.circleCheck : ICONS.circle}</span>
                  <span class="tx-meta">
                    <span class="cold-vis-head"><span class="strong small mono-digits">#${row.index}</span>${row.label ? `<span class="muted tiny ellipsis">${esc(row.label)}</span>` : ""}</span>
                    <span class="mono tiny muted">${esc(`${row.address.slice(0, 16)}…${row.address.slice(-6)}`)}</span>
                  </span>
                  ${trailing(row)}
                </button>`;
            }).join("")}</div>`}
      </div>
      <div class="pager">
        <button class="icon plain accent" id="prev" ${state.page === 0 ? "disabled" : ""} aria-label="Previous page">${SF.chevronLeft}</button>
        <span class="strong small mono-digits">#${start} - #${start + PAGE - 1}</span>
        <button class="icon plain accent" id="next" aria-label="Next page">${SF.chevronRight}</button>
      </div>`, "cold-visibility");
    $("#done").onclick = onDone;
    $("#prev").onclick = () => { if (state.page > 0) { state.page -= 1; loadPage(); } };
    $("#next").onclick = () => { state.page += 1; loadPage(); };
    for (const button of app.querySelectorAll("[data-vis]")) {
      button.onclick = () => toggle(state.pageRows.find((r) => r.index === Number(button.dataset.vis)));
    }
  }

  loadPage();
}

// =============================================================================================
// SCREEN 4 - one address: History | UTXOs | .kachat
// =============================================================================================

function showAddress({ accountId, entry, onBack }) {
  const address = entry.address;
  const title = displayLabel(entry);
  const state = {
    tab: "history",
    history: null, historyLoading: false,
    coins: null, coinsLoading: false, coinsError: "",
    labels: {},
  };
  const here = () => app.dataset.screen === "cold:address" && app.dataset.coldAddress === address;
  const repaintIfHere = () => { if (here()) paint(); };
  const back = () => paint();
  const balance = () => (state.coins ? state.coins.reduce((sum, c) => sum + c.amount, 0n) : entry.balanceSompi);

  const loadHistory = () => {
    state.historyLoading = true;
    repaintIfHere();
    wallet.history(address)
      .then((result) => { state.history = result; })
      .catch(() => { state.history = { txs: [], complete: false }; })
      .finally(() => { state.historyLoading = false; repaintIfHere(); });
  };
  const loadCoins = () => {
    state.coinsLoading = true;
    state.coinsError = "";
    repaintIfHere();
    wallet.utxos(address)
      .then((coins) => { state.coins = coins; balanceCache.set(address, coins.reduce((sum, c) => sum + c.amount, 0n)); })
      .catch((error) => { state.coinsError = String(error?.message || error); })
      .finally(() => { state.coinsLoading = false; repaintIfHere(); });
  };
  const reload = () => { loadHistory(); loadCoins(); };

  const openSend = (compound) => showColdSend({
    fromAddress: address,
    availableSompi: balance(),
    compound,
    onClose: () => { paint(); },
    onDone: () => { paint(); reload(); },
  });

  // iOS TransactionActionsSheet.
  const transactionSheet = (tx) => {
    const summary = tx.direction ? `${tx.direction === "out" ? "Sent" : "Received"} ${portfolioKas(tx.amountSompi)}${tx.time ? ` on ${txDate(tx.time)}` : ""}` : "";
    showSheet({
      title: "Transaction",
      headerHtml: `${summary ? `<div class="muted small">${esc(summary)}</div>` : ""}<div class="mono tiny muted">${esc(middle(tx.txid, 16))}</div>`,
      cancel: false,
      rows: [
        {
          label: "Open in Explorer", subtitle: "Opens this transaction on the block explorer.", icon: SF.safari,
          onClick: () => window.open(wallet.explorerTxUrl(tx.txid), "_blank", "noopener"),
        },
        ...(tx.direction ? [{
          label: "Add to Portfolio", subtitle: "Records it as a buy or a sell in a portfolio of your choosing.", icon: SF.pieFill,
          onClick: () => showAddToPortfolio({
            txid: tx.txid, direction: tx.direction, amountSompi: tx.amountSompi, time: tx.time, sourceAddress: address,
            onDone: () => { if (!here()) paint(); },
          }),
        }] : []),
      ],
    });
  };

  const historyHtml = () => {
    if (!state.history && state.historyLoading) return '<div class="glass list"><div class="list-row center-row"><span class="spinner small-spin"></span></div></div>';
    const txs = state.history?.txs || [];
    if (!txs.length && state.history && !state.history.complete) {
      return '<div class="glass list"><div class="list-row stack-row cold-left-stack"><span class="muted">Could not load transactions.</span><button class="link-button strong" id="history-retry">Try Again</button></div></div>';
    }
    if (!txs.length) return '<div class="glass list"><div class="list-row muted">No transactions yet.</div></div>';
    return `
      ${state.history && !state.history.complete ? '<p class="cold-partial">Some transactions could not be loaded. Pull to refresh to try again.</p>' : ""}
      <div class="glass list">${txs.map((tx, i) => {
        const cls = tx.direction === "out" ? "out" : tx.direction === "in" ? "in" : "none";
        return `
          <button class="list-row ios-tx" data-tx="${i}">
            <span class="ios-tx-icon ${cls}">${tx.direction === "out" ? SF.arrowUpFill : SF.arrowDownFill}</span>
            <span class="tx-meta">
              <span class="ios-tx-title ${cls}">${tx.direction === "out" ? "Sent" : tx.direction === "in" ? "Received" : "Transaction"}</span>
              <span class="mono tiny muted">${esc(middle(tx.txid, 6))}</span>
              ${tx.time ? `<span class="tiny muted">${esc(txDate(tx.time))}</span>` : ""}
            </span>
            <span class="ios-tx-right">
              ${tx.direction ? `<span class="ios-tx-amount ${cls}">${tx.direction === "out" ? "-" : "+"}${esc(formatKas8(tx.amountSompi))} KAS</span>` : ""}
              ${tx.feeSompi != null ? `<span class="tiny muted">${esc(feeText(tx.feeSompi))}</span>` : ""}
            </span>
            <span class="accent">${SF.upRightSquare}</span>
          </button>`;
      }).join("")}</div>`;
  };

  const utxosHtml = () => {
    const coins = state.coins;
    let body;
    if (!coins && state.coinsLoading) body = '<div class="list-row center-row"><span class="spinner small-spin"></span></div>';
    else if (!coins?.length && state.coinsError) {
      body = `<div class="list-row stack-row">
        <span class="danger-text strong small">${SF.warning} Couldn't load the coins at this address</span>
        <span class="muted tiny">${esc(state.coinsError)}</span>
        <button class="link-button strong" id="coins-retry">Try Again</button></div>`;
    } else if (!coins?.length) body = '<div class="list-row muted">No UTXOs.</div>';
    else {
      body = coins.map((coin, i) => {
        const label = state.labels?.[coin.key];
        return `
          <div class="list-row ios-utxo">
            <span class="accent">${coin.isCoinbase ? SF.cube : SF.grid}</span>
            <span class="tx-meta">
              ${label ? `<span class="accent tiny strong">${esc(label)}</span>` : ""}
              <span class="strong small">${esc(formatKas8(coin.amount))} KAS</span>
              <span class="mono tiny muted">${esc(middle(`${coin.transactionId}:${coin.index}`, 10))}</span>
            </span>
            ${coin.isCoinbase ? '<span class="tiny muted strong">Coinbase</span>' : ""}
            <button class="icon plain accent" data-rename-utxo="${i}" aria-label="Rename UTXO">${SF.pencilSmall}</button>
          </div>`;
      }).join("");
    }
    const compound = coins && coins.length > 1 ? `
      <div class="glass list"><button class="list-row strong accent-row" id="compound">${SF.merge}<span>Compound UTXOs</span></button></div>
      <p class="form-footer cold-compound-footer">Combines all UTXOs at this address into a single one, to reduce the number of inputs a future send needs.</p>` : "";
    return `${compound}<div class="glass list">${body}</div>`;
  };

  const kachatHtml = () => `
    <div class="cold-kachat">
      ${kachatWordmark(40)}
      <div class="strong cold-kachat-title">No .kachat names on this address</div>
      <p class="muted small">Names this address claims or buys show here once .kachat names launch.</p>
    </div>`;

  function paint() {
    const total = balance();
    const scroll = app.querySelector(".manage-scroll")?.scrollTop || 0;
    const tabs = [["history", "History"], ["utxos", "UTXOs"], ["kachat", ".kachat"]];
    render(`
      <header class="navbar">
        <button class="nav-back" id="back" aria-label="Back">${ICONS.back}<span>Back</span></button>
        <div class="nav-title cold-nav-title">${esc(title)}</div>
        <div class="nav-right"><a class="icon plain accent cold-globe" href="${esc(wallet.explorerAddressUrl(address))}" target="_blank" rel="noopener noreferrer" aria-label="View in Explorer" title="View in Explorer">${SF.globe}</a></div>
      </header>
      <div class="ios-balance cold-address-balance"><span class="muted tiny">Balance</span><span class="ios-balance-value">${esc(formatKas8(total))} KAS</span></div>
      <div class="underline-tabs cold-tabs" role="tablist">
        ${tabs.map(([id, label]) => `<button role="tab" data-tab="${id}" aria-selected="${state.tab === id}">${esc(label)}</button>`).join("")}
      </div>
      <div class="manage-scroll cold-address-scroll">
        ${state.tab === "history" ? historyHtml() : state.tab === "utxos" ? utxosHtml() : kachatHtml()}
      </div>
      <div class="ios-bottom-bar">
        <button class="ios-capsule with-icon" id="receive">${SF.qrcodeSmall}<span>Receive</span></button>
        <button class="ios-capsule with-icon cold-bold" id="send" ${total === 0n ? "disabled" : ""}>${SF.sendFill}<span>Send</span></button>
      </div>`, "cold:address");
    app.dataset.coldAddress = address;
    dock.remember(() => paint());
    const scroller = app.querySelector(".manage-scroll");
    if (scroller) scroller.scrollTop = scroll;
    $("#back").onclick = onBack;
    for (const tab of app.querySelectorAll("[data-tab]")) tab.onclick = () => { if (state.tab !== tab.dataset.tab) { state.tab = tab.dataset.tab; app.querySelector(".manage-scroll").scrollTop = 0; paint(); } };
    $("#receive").onclick = () => showQr({ title, address, backLabel: "Close", onBack: back });
    $("#send").onclick = () => openSend(false);
    for (const row of app.querySelectorAll("[data-tx]")) row.onclick = () => transactionSheet(state.history.txs[Number(row.dataset.tx)]);
    const historyRetry = $("#history-retry");
    if (historyRetry) historyRetry.onclick = loadHistory;
    const coinsRetry = $("#coins-retry");
    if (coinsRetry) coinsRetry.onclick = loadCoins;
    const compound = $("#compound");
    if (compound) compound.onclick = () => openSend(true);
    for (const button of app.querySelectorAll("[data-rename-utxo]")) {
      const coin = state.coins[Number(button.dataset.renameUtxo)];
      button.onclick = () => fieldSheet({
        title: "Rename UTXO",
        subtitle: coin.key,
        placeholder: "Name",
        value: state.labels?.[coin.key] || "",
        confirmLabel: "Save",
        allowEmpty: true,
        onConfirm: async (value) => { state.labels = await wallet.setUtxoLabel(address, coin.key, value); repaintIfHere(); },
      });
    }
  }

  paint();
  wallet.utxoLabels(address).then((labels) => { state.labels = labels; repaintIfHere(); });
  reload();
}
