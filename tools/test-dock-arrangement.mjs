// The left dock and the phone bar (owner, 2026-11-12, Build 281): ui/dock-arrangement.js.
import assert from "node:assert/strict";
import { RAIL_ORDER, PHONE_BAR, dockLayoutFor } from "../ui/dock-arrangement.js";

// On a computer every screen is in the dock, once, and More is not.
const wide = dockLayoutFor(true);
assert.deepEqual(wide.dock, RAIL_ORDER);
assert.deepEqual(wide.hub, []);
assert.equal(new Set(wide.dock).size, wide.dock.length, "no screen twice");
assert.ok(!wide.dock.includes("hub"), "no More on a computer");
assert.ok(!wide.dock.includes("kachat-bots"), "no Bots screen: the bots live in Chats");
// Profile and Settings sit at the bottom.
assert.deepEqual(wide.dock.slice(-2), ["profile", "settings"]);

// On a phone: five in the bar, the last More, and every other screen under More.
const narrow = dockLayoutFor(false);
assert.deepEqual(narrow.dock, PHONE_BAR);
assert.equal(narrow.dock.length, 5);
assert.equal(narrow.dock.at(-1), "hub");
for (const tab of RAIL_ORDER) assert.ok(narrow.dock.includes(tab) !== narrow.hub.includes(tab), `${tab} is in exactly one place`);

// A fresh copy each time: changing one never changes the next.
wide.dock.push("x");
assert.ok(!dockLayoutFor(true).dock.includes("x"));

console.log("dock arrangement: all passed");
