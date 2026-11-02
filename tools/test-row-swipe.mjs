// node tools/test-row-swipe.mjs - what a chat row's swipes offer and where a row goes when the finger
// lifts (ui/row-swipe.js; KaChat-iPhone d063b897 ChatListView chatSwipeLeftActions / chatSwipeRightActions).
import assert from "node:assert/strict";
import {
  chatRowSwipeActions, rowSwipeWidths, rowSwipeAxis, clampRowSwipe, isFullRowSwipe, settleRowSwipe,
} from "../ui/row-swipe.js";

const ids = (actions) => actions.map((action) => action.id);
const titles = (actions) => actions.map((action) => action.title);

// Left: Delete, Silence and Pin, first nearest the screen's edge. Right: the read state.
{
  const { left, right } = chatRowSwipeActions({ unread: 0 });
  assert.deepEqual(titles(left), ["Delete", "Silence", "Pin"]);
  assert.deepEqual(titles(right), ["Mark as Unread"]);
  assert.deepEqual(left.map((action) => action.tint), ["red", "orange", "accent"]);
  assert.deepEqual(titles(chatRowSwipeActions({ unread: 3 }).right), ["Mark as Read"]);
  assert.deepEqual(ids(chatRowSwipeActions({ unread: 3 }).right), ["read"]);
  assert.deepEqual(ids(chatRowSwipeActions({ unread: 0 }).right), ["unread"]);
}
// The labels follow the state; the action is the same one.
{
  const { left } = chatRowSwipeActions({ isSilent: true, isPinned: true });
  assert.deepEqual(titles(left), ["Delete", "Unsilence", "Unpin"]);
  assert.deepEqual(ids(left), ["delete", "silence", "pin"]);
}
// Your own chat has only Silence, and still marks read or unread.
{
  const { left, right } = chatRowSwipeActions({ isSelf: true, unread: 1 });
  assert.deepEqual(titles(left), ["Silence"]);
  assert.deepEqual(titles(right), ["Mark as Read"]);
  assert.deepEqual(titles(chatRowSwipeActions({ isSelf: true, isSilent: true }).left), ["Unsilence"]);
}
console.log("row swipe: actions ok");

// A drag is nothing until it has moved; a tie goes to the list's scroll.
assert.equal(rowSwipeAxis(3, 4), null);
assert.equal(rowSwipeAxis(-9, 9), null);
assert.equal(rowSwipeAxis(14, 4), "x");
assert.equal(rowSwipeAxis(-14, 4), "x");
assert.equal(rowSwipeAxis(4, 14), "y");
assert.equal(rowSwipeAxis(4, -14), "y");
assert.equal(rowSwipeAxis(12, 12), "y");

const widths = { ...rowSwipeWidths(chatRowSwipeActions()), rowWidth: 375 };
const own = { ...rowSwipeWidths(chatRowSwipeActions({ isSelf: true })), rowWidth: 375 };
assert.deepEqual(widths, { leftWidth: 222, rightWidth: 96, rowWidth: 375 });
assert.equal(own.leftWidth, 74);

// Left gives only a little past its buttons; right runs to the row's edge; no buttons, no movement.
assert.equal(clampRowSwipe(-100, widths), -100);
assert.equal(clampRowSwipe(-222, widths), -222);
assert.equal(clampRowSwipe(-322, widths), -247);
assert.equal(clampRowSwipe(100, widths), 100);
assert.equal(clampRowSwipe(500, widths), 375);
assert.equal(clampRowSwipe(-50, { rightWidth: 96, rowWidth: 375 }), 0);
assert.equal(clampRowSwipe(50, { leftWidth: 74, rowWidth: 375 }), 0);

// The full swipe is the right swipe's alone.
assert.equal(isFullRowSwipe(224, widths), false);
assert.equal(isFullRowSwipe(225, widths), true);
assert.equal(settleRowSwipe({ offset: 300, ...widths }), "full");
assert.equal(settleRowSwipe({ offset: -374, ...widths }), "left", "a long swipe left can't start a delete");
assert.equal(settleRowSwipe({ offset: -247, velocity: -3, ...widths }), "left");

// Half way opens, short of it closes, either side.
assert.equal(settleRowSwipe({ offset: 0, ...widths }), "closed");
assert.equal(settleRowSwipe({ offset: 48, ...widths }), "right");
assert.equal(settleRowSwipe({ offset: 47, ...widths }), "closed");
assert.equal(settleRowSwipe({ offset: -111, ...widths }), "left");
assert.equal(settleRowSwipe({ offset: -110, ...widths }), "closed");
assert.equal(settleRowSwipe({ offset: -37, ...own }), "left");
assert.equal(settleRowSwipe({ offset: -36, ...own }), "closed");

// A flick counts for more than the distance, and a flick back shuts it.
assert.equal(settleRowSwipe({ offset: 20, velocity: 1, ...widths }), "right");
assert.equal(settleRowSwipe({ offset: -20, velocity: -1, ...widths }), "left");
assert.equal(settleRowSwipe({ offset: 90, velocity: -1, ...widths }), "closed");
assert.equal(settleRowSwipe({ offset: -200, velocity: 1, ...widths }), "closed");
console.log("row swipe: gesture ok");
