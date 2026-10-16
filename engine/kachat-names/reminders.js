// Local reminders for .kachat names held by one of this wallet's spending addresses (Buy From),
// iOS d1026de `KachatNameReminders` (XP-024): the indexer's renewal and expiry pushes reach only
// the chatting address, so the app reminds by itself - renewal opens, the name expired, and a day
// before grace ends - from each name's expiry. Nothing leaves the device.
//
// iOS hands each reminder to the OS (UNTimeIntervalNotificationTrigger), rescheduled on every
// notifier check. The desktop has no OS-scheduled notifications (a web page can't leave one with
// the system), so this is the closest equivalent: every notifier check ARMS the reminders still in
// the future (persisted per wallet and network - the same set iOS would have pending), drops the
// ones that no longer apply (a renewed name moves them: its expiry is in the id; a name that left
// the wallet loses them), and a reminder whose time has come FIRES once - on that check, or on a timer the
// notifier sets for the soonest one while the app is open. A reminder that came due while the app
// was closed fires on the next check, and when several of one name's did, only the latest (the one
// that still holds) is shown. Like iOS, a time already past when first seen is never armed, so
// nothing fires about the past.
//
// Pure: the notifier (ui/kachat-names-notifier.js) keeps the state and shows what is due.

import { dayString as defaultDayString } from "./actions.js";

// Each wallet and network keeps its own set (iOS 6128f1e, IOS-088): a check on one never keeps,
// drops or fires another's. Ids are `kachat-reminder-<network>-<wallet tag>-<name>-<expiresAt>-
// <kind>` (Swift `KachatNameReminders.root`), stored under `remindersStorageKey(wallet, network)`.
// The first build's sets (`kachat-name-reminders-v1:<wallet>`, ids `kachat-local-...`) were one
// per wallet whatever the network: removed wherever found (`legacyRemindersStoragePrefix`).

/** The ids' root (Swift `KachatNameReminders.root`). */
export const reminderRoot = "kachat-reminder-";
/** The first build's ids (Swift `KachatNameReminders.legacyPrefix`). */
export const legacyReminderPrefix = "kachat-local-";
/** The first build's storage keys, `<prefix><wallet>`: removed wherever found. */
export const legacyRemindersStoragePrefix = "kachat-name-reminders-v1:";
/** Where every wallet's sets are kept: `<prefix><network>:<wallet>`. */
export const remindersStoragePrefix = "kachat-name-reminders-v2:";
/** The networks a set can be kept for (the manifests' network names). */
export const reminderNetworks = Object.freeze(["mainnet", "testnet-10"]);

/** A short, stable tag for a wallet in the ids: the address's last 12 characters (iOS walletTag). */
export function reminderWalletTag(walletAddress) {
  return String(walletAddress ?? "").toLowerCase().slice(-12);
}

/** The ids' prefix for one wallet on one network. */
export function reminderIdPrefix(walletAddress, network) {
  return `${reminderRoot}${network}-${reminderWalletTag(walletAddress)}-`;
}

/** The storage key of a wallet's armed reminders on a network: `{ [id]: Reminder }`. */
export function remindersStorageKey(walletAddress, network) {
  return `${remindersStoragePrefix}${network}:${String(walletAddress ?? "").toLowerCase()}`;
}

/** Every storage key a wallet's reminders can be under, on every network, the first build's too:
 *  for when the wallet leaves this device (iOS removeAll(forWallet:)). */
export function remindersStorageKeysForWallet(walletAddress) {
  const wallet = String(walletAddress ?? "").toLowerCase();
  if (!wallet) return [];
  return [...reminderNetworks.map((network) => remindersStorageKey(wallet, network)), `${legacyRemindersStoragePrefix}${wallet}`];
}

const lastCallBeforeMs = 86_400_000n;

/**
 * Every reminder `names` (NameInfo[], the ones on a spending address) want, past ones included:
 * `[{ id, at: unix ms Number, name, title, body }]` - per name `renew` (expiresAt - renewWindowMs),
 * `grace` (expiresAt) and `lastcall` (a day before grace ends, at most half the grace in). The
 * texts are the iOS ones (the Profile bell's). Ids carry `wallet` (the chatting address the set
 * belongs to) and `network` (`reminderIdPrefix`).
 */
export function wantedReminders(names, params, { dayString = defaultDayString, wallet = "", network = "" } = {}) {
  if (!params || !Array.isArray(names)) return [];
  const prefix = reminderIdPrefix(wallet, network);
  const grace = BigInt(params.graceMs);
  const window = BigInt(params.renewWindowMs);
  const half = grace / 2n;
  const lastCallBefore = half < lastCallBeforeMs ? half : lastCallBeforeMs;
  const out = [];
  for (const n of names) {
    if (!n?.name || n.expiresAt == null) continue;
    const expiresAt = BigInt(n.expiresAt);
    const display = `${n.name}.kachat`;
    const base = `${prefix}${n.name}-${expiresAt}-`;
    const graceEnds = dayString(Number(expiresAt + grace));
    out.push({
      id: `${base}renew`, at: Number(expiresAt - window), name: n.name,
      title: `Renew ${display}`, body: `Renewal is open: renew it before ${dayString(Number(expiresAt))} to keep it.`,
    });
    out.push({
      id: `${base}grace`, at: Number(expiresAt), name: n.name,
      title: `${display} has expired`, body: `Renew it before ${graceEnds} or anyone can claim it.`,
    });
    out.push({
      id: `${base}lastcall`, at: Number(expiresAt + grace - lastCallBefore), name: n.name,
      title: `${display} has expired`, body: `Renew it before ${graceEnds} or anyone can claim it.`,
    });
  }
  return out;
}

/**
 * One check: `armed` (the stored `{ [id]: Reminder }`, or null), what is `wanted` now
 * (`wantedReminders`), at `now` (unix ms). -> `{ armed, due }`: the reminders to keep (future
 * ones, newly seen ones included) and the ones to show now - an armed reminder whose time has
 * come, one per name (its latest). A wanted reminder already past and never armed is skipped; an
 * armed one no longer wanted is dropped.
 */
export function stepReminders(armed, wanted, now) {
  const prev = armed && typeof armed === "object" ? armed : {};
  const next = {};
  const dueByName = new Map();
  for (const r of Array.isArray(wanted) ? wanted : []) {
    if (!r?.id || !Number.isFinite(r.at)) continue;
    if (r.at > now) { next[r.id] = r; continue; }
    if (!prev[r.id]) continue;
    const best = dueByName.get(r.name);
    if (!best || r.at > best.at) dueByName.set(r.name, r);
  }
  return { armed: next, due: [...dueByName.values()].sort((a, b) => a.at - b.at) };
}

/**
 * The armed reminders that have come due by `now`, without a registry read (the notifier's timer):
 * `{ armed, due }` like `stepReminders`, with every armed one still kept as wanted.
 */
export function dueArmedReminders(armed, now) {
  const list = Object.values(armed && typeof armed === "object" ? armed : {});
  return stepReminders(armed, list, now);
}

/** The soonest armed reminder's time (unix ms), or null. */
export function nextReminderAt(armed) {
  let soonest = null;
  for (const r of Object.values(armed && typeof armed === "object" ? armed : {})) {
    if (Number.isFinite(r?.at) && (soonest == null || r.at < soonest)) soonest = r.at;
  }
  return soonest;
}
