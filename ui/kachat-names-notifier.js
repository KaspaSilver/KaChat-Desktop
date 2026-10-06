// The Profile bell's .kachat news (iOS 86471dd, KachatNamesNotifier in KachatNamesRegistry.swift):
// turns registry changes into notification-centre rows, so news about your names still leaves a
// trace - an offer on one of your names, a name sold or reclaimed, its renewal window opening, its
// expiry and lapse, and what became of your own offers (accepted, declined, expired, returned).
//
// It compares what the registry says now with what it saw on the last check (stored per wallet),
// after registry refreshes and when the app comes back to the front. The first check of a wallet
// only records where things stand. Offers this person withdrew or refunded themselves
// (actions.selfClosedOffers) aren't news. Testnet only until names launch on mainnet
// (`kachatNames()` is null there).
//
// Rows go to the app through `record({ id, source: "kachat", title, body, timestamp, targetKind:
// "kachat", targetId: name })`; ids are stable, so a row is never recorded twice.

import { kachatNames } from "./kachat-names-runtime.js";
import { KAS_UNIT } from "../engine/network.js";
import { Status } from "../engine/kachat-names/registry-state.js";
import { bytesEqual } from "../engine/kachat-names/codec.js";
import { dayString } from "../engine/kachat-names/actions.js";
import { formatSompiPlain } from "./send-kaspa-components.js";
import { openNameDetailLayer } from "./kachat-names-live.js";

const SNAPSHOT_PREFIX = "kachat-names-notifier-v1:";
/** A check runs at most this often (refreshes and front-of-screen both ask). */
const MIN_INTERVAL_MS = 20_000;

let deps = null;
let checking = false;
let lastCheckAt = 0;
let trailingTimer = null;
let watchedRegistry = null;

function readSnapshot(wallet) {
  try {
    const text = localStorage.getItem(SNAPSHOT_PREFIX + wallet);
    if (!text) return null;
    const j = JSON.parse(text);
    if (!j || typeof j !== "object" || typeof j.names !== "object") return null;
    return {
      names: j.names || {},
      offersOnMine: new Set(Array.isArray(j.offersOnMine) ? j.offersOnMine.map(String) : []),
      myOffers: j.myOffers && typeof j.myOffers === "object" ? j.myOffers : {},
    };
  } catch {
    return null;
  }
}

function writeSnapshot(wallet, snapshot) {
  try {
    localStorage.setItem(SNAPSHOT_PREFIX + wallet, JSON.stringify({
      names: snapshot.names,
      offersOnMine: [...snapshot.offersOnMine],
      myOffers: snapshot.myOffers,
    }));
  } catch { /* storage full: the next check compares against the older snapshot */ }
}

const kas = (sompi) => `${formatSompiPlain(sompi ?? 0n)} ${KAS_UNIT}`;

/**
 * One check: what changed for this wallet's names and offers since the last one. Never throws;
 * a registry that can't be read leaves the snapshot as it was.
 */
export async function checkKachatNamesNews() {
  const rt = kachatNames();
  if (!rt || !deps || checking) return;
  const { registry, actions } = rt;
  const me = actions.myKey;
  const wallet = actions.myAddress;
  const params = registry.manifest?.params;
  if (!me || !wallet || !params) return;
  checking = true;
  lastCheckAt = Date.now();
  try {
    const graceMs = registry.graceMs;
    let owned;
    let myOpenOffers;
    try {
      owned = await registry.namesOf(me, { includeInactive: true });
      myOpenOffers = await registry.myOffers(me);
    } catch {
      return;
    }
    const now = BigInt(Date.now());
    const offersOnMine = [];
    for (const n of owned) {
      if (n.status(graceMs, now) !== Status.active) continue;
      let open = [];
      try { open = await registry.offersFor(n.name); } catch { open = []; }
      for (const o of open) if (bytesEqual(o.seller, me)) offersOnMine.push(o);
    }
    // a different wallet signed in meanwhile: this answer isn't its
    if (actions.myAddress !== wallet) return;

    const old = readSnapshot(wallet);
    const quiet = old == null; // the first check only records where things stand
    const next = { names: {}, offersOnMine: new Set(), myOffers: {} };
    const stamp = Date.now();
    const post = (id, name, title, body) => {
      if (quiet) return;
      try {
        deps.record({ id: `kachat-${id}`, source: "kachat", title, body, timestamp: stamp, targetKind: "kachat", targetId: name });
      } catch { /* the bell's own problem */ }
    };

    // Your names: renewal open, expired (grace), lapsed - once per paid period.
    for (const n of owned) {
      const display = `${n.name}.kachat`;
      const expiresAt = String(n.expiresAt);
      const prev = old?.names?.[n.name];
      const s = prev && prev.expiresAt === expiresAt
        ? { ...prev }
        : { expiresAt, renewNoted: false, graceNoted: false, lapsedNoted: false };
      switch (n.status(graceMs, now)) {
        case Status.active:
          if (!s.renewNoted && n.renewOpen(params, now)) {
            post(`renew-${n.name}-${expiresAt}`, n.name, `Renew ${display}`,
              `Renewal is open: renew it before ${dayString(Number(n.expiresAt))} to keep it.`);
            s.renewNoted = true;
          }
          break;
        case Status.grace:
          s.renewNoted = true;
          if (!s.graceNoted) {
            post(`grace-${n.name}-${expiresAt}`, n.name, `${display} has expired`,
              `Renew it before ${dayString(Number(n.expiresAt) + Number(graceMs))} or anyone can claim it.`);
            s.graceNoted = true;
          }
          break;
        default:
          s.renewNoted = true;
          s.graceNoted = true;
          if (!s.lapsedNoted) {
            post(`lapsed-${n.name}-${expiresAt}`, n.name, `${display} has lapsed`,
              "Anyone can claim it now. Reclaim it yourself to get your bond back.");
            s.lapsedNoted = true;
          }
      }
      next.names[n.name] = s;
    }

    // Names that left this wallet: sold, bought through an offer, or reclaimed by someone. A
    // transfer or release is your own doing and needs no notice.
    for (const name of Object.keys(old?.names || {})) {
      if (next.names[name]) continue;
      let history = [];
      try { history = await registry.history(name); } catch { history = []; }
      const last = history.find((e) => ["sale", "offer_accepted", "offer_accept", "transfer", "release", "reclaim"].includes(e.op));
      if (!last) continue;
      const display = `${name}.kachat`;
      if (last.op === "sale") {
        post(`sold-${last.txId}`, name, `${display} sold`, last.price != null ? `${kas(last.price)} was paid to you.` : "Your listing was bought.");
      } else if (last.op === "offer_accepted" || last.op === "offer_accept") {
        post(`sold-${last.txId}`, name, `${display} sold`, "You accepted an offer for it.");
      } else if (last.op === "reclaim") {
        post(`reclaimed-${last.txId}`, name, `${display} was reclaimed`, "It lapsed and someone reclaimed it. It's free to register again.");
      }
    }

    // Offers on your names.
    for (const o of offersOnMine) {
      next.offersOnMine.add(o.id);
      if (old?.offersOnMine?.has(o.id) || !o.name) continue;
      post(`offer-${o.id}`, o.name, `New offer on ${o.name}.kachat`, `${kas(o.amount)} offered for it.`);
    }

    // Your offers: accepted, or back with you.
    for (const o of myOpenOffers) next.myOffers[o.id] = o.name || "";
    for (const [id, name] of Object.entries(old?.myOffers || {})) {
      if (next.myOffers[id] != null || !name) continue;
      if (actions.selfClosedOffers?.has(id)) continue;
      const display = `${name}.kachat`;
      if (owned.some((n) => n.name === name)) {
        post(`myoffer-${id}`, name, "Offer accepted", `${display} is yours now.`);
        continue;
      }
      let history = [];
      try { history = await registry.history(name); } catch { history = []; }
      const op = history.find((e) => ["offer_decline", "offer_refund", "offer_withdraw"].includes(e.op))?.op;
      if (op === "offer_decline") {
        post(`myoffer-${id}`, name, `Offer on ${display} declined`, `The owner declined it. The ${KAS_UNIT} is back with you.`);
      } else if (op === "offer_refund") {
        post(`myoffer-${id}`, name, `Offer on ${display} expired`, `Nobody accepted it in time. The ${KAS_UNIT} is back with you.`);
      } else {
        post(`myoffer-${id}`, name, `Offer on ${display} returned`, `It can no longer be accepted. The ${KAS_UNIT} is back with you.`);
      }
    }

    writeSnapshot(wallet, next);
  } catch (error) {
    try { deps?.log?.(`.kachat news check failed: ${error?.message || error}`); } catch { /* fine */ }
  } finally {
    checking = false;
  }
}

/**
 * A tapped .kachat row (iOS 86471dd: the name, the way a tapped .kachat push opens it). `showTab()`
 * brings the .kachat screen up; a registered name then opens its own sheet over it, a name that is
 * free again (reclaimed, released) leaves you on the screen to claim it.
 */
export async function openKachatNameFromNotification(name, { showTab = null } = {}) {
  const clean = String(name || "").trim().toLowerCase().replace(/\.kachat$/, "");
  try { showTab?.(); } catch { /* fine */ }
  const rt = kachatNames();
  if (!clean || !rt) return;
  try {
    await rt.registry.refreshIfStale();
    const r = await rt.registry.lookup(clean);
    if (r?.kind === "registered" && r.info) openNameDetailLayer(r.info, "market");
  } catch (error) {
    try { deps?.log?.(`.kachat name ${clean} didn't open: ${error?.message || error}`); } catch { /* fine */ }
  }
}

/** A check now, or once the minimum interval has passed (one trailing check at most). */
function scheduleCheck() {
  const wait = MIN_INTERVAL_MS - (Date.now() - lastCheckAt);
  if (wait <= 0) { checkKachatNamesNews(); return; }
  if (trailingTimer) return;
  trailingTimer = setTimeout(() => { trailingTimer = null; checkKachatNamesNews(); }, wait);
}

/**
 * Starts the notifier (safe to call more than once): checks after every registry change (a
 * refresh bumps its revision) and when the app comes back to the front, which refreshes a stale
 * registry first. `record(row)` puts a row in the bell; `log(text)` is optional.
 */
export function startKachatNamesNotifier({ record, log = null } = {}) {
  if (typeof record !== "function") return;
  deps = { record, log };
  const rt = kachatNames();
  if (!rt) return; // mainnet: no registry, no .kachat news
  if (watchedRegistry !== rt.registry) {
    watchedRegistry = rt.registry;
    try { rt.registry.onChange(() => scheduleCheck()); } catch { /* fine */ }
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", () => {
        if (document.hidden) return;
        rt.registry.refreshIfStale().then(() => scheduleCheck(), () => {});
      });
    }
  }
  rt.registry.refreshIfStale().then(() => scheduleCheck(), () => {});
}
