// The dock and Kaspa Hub arrangement (iOS AppTab.visible / ecosystemSections and the moves of
// MenuVisibilityView), as pure functions over { dock, hub } so the rules can be tested without a
// page. ui/app.js owns storage, rendering and Simple Mode; everything here takes `allowed`
// (a tab => boolean) for the tabs Simple Mode hides, which are never written out of the stored
// arrangement.

export const DOCK_MAX_ITEMS = 5;
/** Always in the dock (iOS 0a3848f AppTab.pinnedToDock): Chats, because it is what KaChat is;
 *  Kaspa Hub, because it holds everything not in the dock; Profile, because it is the way to
 *  Settings and the account list. In the order a fresh dock places them, so a missing one is
 *  reinserted where it sensibly goes. Where they sit among the five is the person's (iOS 4da34ab). */
export const DOCK_PINNED = ["chats", "hub", "profile"];
/** Tabs the user can place. Chats is listed (as on iOS) but pinned, so it never reaches the Hub. */
// .kachat and KaChat Stats (iOS 5.2) are Hub sections like the rest: first in the Hub on a fresh
// install, appended for an existing arrangement (normalizeDockPrefs), assignable to the dock.
// Contacts (the Address Book, iOS 00767a4) is a Hub section too: first in the Hub on a fresh install.
// KaChat Bots (iOS 82ab31d AppTab.kachatBots) follows KaChat Stats in the Hub; Simple Mode keeps it.
// ChangeNOW Swap (iOS AppTab.swap) is back (owner, 2026-10-22: KaChat is Desktop/PWA only, so the
// app-store rule that turned it off on iOS, f94db5a, does not apply): assignable, and in the Hub
// by default after KaChat Bots, where iOS defaultHub has it.
// Settings (iOS d54ea87c / KaPay 040f91a, where it is a dock tab): assignable like the rest, last in
// the Hub by default (owner, 2026-10-27: the default dock stays as it is).
export const DOCK_ASSIGNABLE = ["chats", "portfolio", "cold-storage", "swaps", "kaposts", "apps", "chess", "kachat-names", "kachat-stats", "address-book", "kachat-bots", "settings"]; // Public Chats live under Chats now (iOS a566da7)
// A fresh dock (owner's choice for Desktop, 2026-10-21; iOS's defaultDock is Storage, Portfolio,
// Chats, Hub, Profile): Kaspa Hub, Portfolio, Chats, KaPosts, Profile. Storage leads the Hub. An
// arrangement someone already made is theirs and is kept.
export const DOCK_DEFAULT_ORDER = ["hub", "portfolio", "chats", "kaposts", "profile", "cold-storage", "address-book", "kachat-names", "kachat-stats", "kachat-bots", "swaps", "apps", "chess", "settings"];
export const DOCK_DEFAULT = ["hub", "portfolio", "chats", "kaposts", "profile"];
export const HUB_DEFAULT = ["cold-storage", "address-book", "kachat-names", "kachat-stats", "kachat-bots", "swaps", "apps", "chess", "settings"];
/** Slots the person fills: the cap minus the pinned three (iOS assignableDockSlots). */
export const DOCK_PICK_SLOTS = DOCK_MAX_ITEMS - DOCK_PINNED.length;

const everyTab = () => true;
export const isPinnedToDock = (tab) => DOCK_PINNED.includes(tab);

/** Resolves any stored pair into a legal arrangement (iOS 4da34ab AppTab.visible): the stored dock
 *  order kept, deduplicated, with at most DOCK_PICK_SLOTS picks besides the pinned tabs, and every
 *  pinned tab reinserted whatever the stored list says. Every assignable tab ends in exactly one
 *  list; anything a stored list has never heard of (a tab added by an update, or a pick past the
 *  cap) is appended to the Hub in default order rather than lost. */
export function normalizeDockPrefs(prefs) {
  const seen = new Set();
  const dock = [];
  let picks = 0;
  for (const tab of Array.isArray(prefs?.dock) ? prefs.dock : []) {
    if (!DOCK_ASSIGNABLE.includes(tab) && !isPinnedToDock(tab)) continue;
    if (seen.has(tab)) continue;
    if (!isPinnedToDock(tab)) {
      if (picks >= DOCK_PICK_SLOTS) continue;
      picks += 1;
    }
    seen.add(tab); dock.push(tab);
  }
  // Reinserted whatever the stored list says, so no saved arrangement - or a hand-edited one - can
  // leave the app without Chats, the Hub that holds everything else, or Profile.
  for (const pinned of DOCK_PINNED) {
    if (seen.has(pinned)) continue;
    const at = DOCK_DEFAULT.indexOf(pinned);
    dock.splice(at < 0 ? dock.length : Math.min(at, dock.length), 0, pinned);
    seen.add(pinned);
  }
  const hub = [];
  for (const tab of [...(Array.isArray(prefs?.hub) ? prefs.hub : []), ...DOCK_DEFAULT_ORDER]) {
    if (!DOCK_ASSIGNABLE.includes(tab) || isPinnedToDock(tab) || seen.has(tab)) continue;
    seen.add(tab); hub.push(tab);
  }
  return { dock, hub };
}

/** Five at most, counting what is on screen (iOS dockIsFull). */
export function dockIsFull(arrangement, allowed = everyTab) {
  return arrangement.dock.filter(allowed).length >= DOCK_MAX_ITEMS;
}

/** Red minus (iOS 4da34ab removeFromDock): out of the dock, to the top of Kaspa Hub where it can
 *  be seen. The pinned three never leave. */
export function removeFromDock(arrangement, tab) {
  if (isPinnedToDock(tab) || !arrangement.dock.includes(tab)) return arrangement;
  return {
    dock: arrangement.dock.filter((t) => t !== tab),
    hub: [tab, ...arrangement.hub.filter((t) => t !== tab)],
  };
}

/** Green plus (iOS 4da34ab addToDock): into the dock, at its end; drag it to where it should sit.
 *  Refused while the dock is full. A pick Simple Mode hides still holds a stored slot without
 *  showing, so when the visible dock has room but the stored one has no pick slot left, the hidden
 *  pick makes way to the top of the Hub - the same place the red minus would have sent it. */
export function addToDock(arrangement, tab, allowed = everyTab) {
  if (dockIsFull(arrangement, allowed) || arrangement.dock.includes(tab) || !arrangement.hub.includes(tab)) return arrangement;
  let dock = [...arrangement.dock.filter((t) => t !== tab), tab];
  let hub = arrangement.hub.filter((t) => t !== tab);
  const hiddenPicks = dock.filter((t) => !isPinnedToDock(t) && !allowed(t));
  while (dock.filter((t) => !isPinnedToDock(t)).length > DOCK_PICK_SLOTS && hiddenPicks.length) {
    const evicted = hiddenPicks.pop();
    dock = dock.filter((t) => t !== evicted);
    hub = [evicted, ...hub];
  }
  return { dock, hub };
}

/** A drag within one list: `visibleOrder` is the order the person now sees. Tabs Simple Mode hides
 *  keep their stored positions and the visible ones fill the rest, in their new order. */
export function reorderVisible(list, visibleOrder, allowed = everyTab) {
  const queue = visibleOrder.filter((t) => list.includes(t) && allowed(t));
  if (queue.length !== list.filter(allowed).length) return list;
  return list.map((t) => (allowed(t) ? queue.shift() : t));
}
