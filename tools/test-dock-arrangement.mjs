// The dock and Kaspa Hub arrangement (iOS 0a3848f, 4da34ab: AppTab.visible / ecosystemSections and
// MenuVisibilityView's red minus and green plus).
import assert from "node:assert/strict";
import {
  DOCK_ASSIGNABLE, DOCK_DEFAULT, DOCK_MAX_ITEMS, DOCK_PINNED, HUB_DEFAULT,
  normalizeDockPrefs as norm, dockIsFull, removeFromDock, addToDock, reorderVisible,
} from "../ui/dock-arrangement.js";

const everyPlaced = ({ dock, hub }) => {
  const all = [...dock, ...hub];
  assert.equal(new Set(all).size, all.length, "no tab in both lists or twice");
  for (const tab of DOCK_ASSIGNABLE) assert.ok(all.includes(tab), `${tab} is placed somewhere`);
  for (const tab of DOCK_PINNED) assert.ok(dock.includes(tab), `${tab} is always in the dock`);
  assert.ok(dock.length <= DOCK_MAX_ITEMS);
  assert.ok(!hub.some((t) => DOCK_PINNED.includes(t)), "the Hub never holds a pinned tab");
};

// A fresh install: the default dock and Hub, unchanged.
const fresh = norm({ dock: DOCK_DEFAULT, hub: HUB_DEFAULT });
assert.deepEqual(fresh.dock, DOCK_DEFAULT);
assert.deepEqual(fresh.hub, HUB_DEFAULT);
everyPlaced(fresh);

// Chats is pinned now (iOS 0a3848f): an old dock without it gets it back where a fresh dock has it,
// and the third pick goes to the Hub.
const old = norm({ dock: ["cold-storage", "portfolio", "kaposts", "hub", "profile"], hub: ["chats", "apps"] });
assert.deepEqual(old.dock, ["cold-storage", "portfolio", "chats", "hub", "profile"]);
assert.equal(old.hub[0], "apps");
assert.ok(old.hub.includes("kaposts"));
everyPlaced(old);

// The stored order is kept, pinned tabs anywhere (iOS 4da34ab).
const moved = norm({ dock: ["profile", "kaposts", "chats", "hub", "portfolio"], hub: [] });
assert.deepEqual(moved.dock, ["profile", "kaposts", "chats", "hub", "portfolio"]);
everyPlaced(moved);

// Missing pinned ones are reinserted; duplicates and unknown tabs dropped; at most two picks.
const messy = norm({ dock: ["kaposts", "kaposts", "nope", "apps", "chess", "address-book"], hub: ["chess", "chats"] });
assert.deepEqual(messy.dock, ["kaposts", "apps", "chats", "hub", "profile"]);
assert.equal(messy.hub[0], "chess", "the stored Hub order comes first");
everyPlaced(messy);
everyPlaced(norm({}));
everyPlaced(norm({ dock: "x", hub: null }));

// Red minus: to the top of Kaspa Hub. Pinned tabs never leave.
const minus = removeFromDock(fresh, "portfolio");
assert.deepEqual(minus.dock, ["cold-storage", "chats", "hub", "profile"]);
assert.deepEqual(minus.hub, ["portfolio", ...HUB_DEFAULT]);
assert.equal(removeFromDock(fresh, "chats"), fresh);
assert.equal(removeFromDock(fresh, "hub"), fresh);
assert.equal(removeFromDock(fresh, "profile"), fresh);
everyPlaced(minus);

// Green plus: onto the end of the dock, only while it has room.
assert.equal(dockIsFull(fresh), true);
assert.equal(addToDock(fresh, "kaposts"), fresh, "refused while the dock is full");
assert.equal(dockIsFull(minus), false);
const plus = addToDock(minus, "kaposts");
assert.deepEqual(plus.dock, ["cold-storage", "chats", "hub", "profile", "kaposts"]);
assert.ok(!plus.hub.includes("kaposts"));
assert.equal(dockIsFull(plus), true);
everyPlaced(plus);

// Simple Mode hides KaPosts without writing it out: it keeps its stored slot, the visible dock has
// room, and adding a tab sends the hidden pick to the top of the Hub.
const simple = (tab) => tab !== "kaposts";
assert.equal(dockIsFull(plus, simple), false);
const simplePlus = addToDock(plus, "apps", simple);
assert.deepEqual(simplePlus.dock, ["cold-storage", "chats", "hub", "profile", "apps"]);
assert.equal(simplePlus.hub[0], "kaposts");
everyPlaced(simplePlus);
assert.deepEqual(norm(simplePlus), simplePlus, "a move's result is already legal");

// A drag reorders what is seen; hidden tabs keep their stored places.
assert.deepEqual(reorderVisible(["a", "b", "c"], ["c", "a", "b"]), ["c", "a", "b"]);
assert.deepEqual(reorderVisible(["a", "kaposts", "b", "c"], ["c", "b", "a"], simple), ["c", "kaposts", "b", "a"]);
const list = ["a", "b"];
assert.equal(reorderVisible(list, ["a"]), list, "a partial order is ignored");

console.log("dock arrangement: ok");
