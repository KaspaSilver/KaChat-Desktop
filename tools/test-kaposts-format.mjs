// node tools/test-kaposts-format.mjs - the KaPosts text/time helpers (ui/kaposts-format.js).
import assert from "node:assert/strict";
import {
  kapostsCharCount,
  kapostsClampChars,
  kapostsFoldedPrefix,
  kapostsEditWindowText,
  kapostsLongRelativeTime,
  kapostsNamedRelativeTime,
  KAPOSTS_FEED_MENU,
  KAPOSTS_PAGER_LOCK_PX,
  kapostsAxisLock,
  kapostsPagerOffset,
  kapostsProjectedTranslation,
  kapostsPagerTarget,
  kapostsDrawerWidth,
  kapostsDrawerShouldClose,
  kapostsDrawerDim,
} from "../ui/kaposts-format.js";

// Code points, not UTF-16 units.
assert.equal(kapostsCharCount("abc"), 3);
assert.equal(kapostsCharCount("a\u{1F600}b"), 3);
assert.equal(kapostsCharCount(""), 0);
assert.equal(kapostsClampChars("\u{1F600}\u{1F600}\u{1F600}", 2), "\u{1F600}\u{1F600}");
assert.equal(kapostsClampChars("abc", 5), "abc");

// Fold: short text unchanged; long text cut at the last whitespace past 600, with an ellipsis.
assert.equal(kapostsFoldedPrefix("short"), "short");
const long = `${"x".repeat(700)} ${"y".repeat(800)}`;
assert.equal(kapostsFoldedPrefix(long), `${"x".repeat(700)}…`);
const noSpace = "z".repeat(1500);
assert.equal(kapostsFoldedPrefix(noSpace), `${"z".repeat(1200)}…`);
const earlySpace = `${"a".repeat(100)} ${"b".repeat(1400)}`;
assert.equal(kapostsFoldedPrefix(earlySpace), `${earlySpace.slice(0, 1200)}…`);

// Edit window text.
assert.equal(kapostsEditWindowText(72 * 60000 + 5000), "1h 12m left");
assert.equal(kapostsEditWindowText(8 * 60000 + 59000), "8m left");
assert.equal(kapostsEditWindowText(20000), "1m left");
assert.equal(kapostsEditWindowText(0), "");

// Long relative time.
const now = 1_800_000_000_000;
assert.equal(kapostsLongRelativeTime(now - 45_000, now), "45 seconds");
assert.equal(kapostsLongRelativeTime(now - (2 * 3600 + 23 * 60) * 1000, now), "2 hours, 23 minutes");
assert.equal(kapostsLongRelativeTime(now - (86400 + 3600) * 1000, now), "1 day, 1 hour");
assert.equal(kapostsLongRelativeTime(now, now), "0 seconds");

// Named relative time (English locale pinned for the check).
assert.equal(kapostsNamedRelativeTime(now - 5 * 60000, now, "en"), "5 minutes ago");
assert.equal(kapostsNamedRelativeTime(now - 86400000, now, "en"), "yesterday");
assert.equal(kapostsNamedRelativeTime(now, now, "en"), "now");

// The hamburger's card (iOS 865c9ab SideMenuItem.feedMenu): exactly these rows, in this order.
assert.deepEqual(KAPOSTS_FEED_MENU.map((item) => item.title), ["Search", "Drafts", "Bookmarks", "Muted", "Blocked", "Scheduled"]);
assert.deepEqual(KAPOSTS_FEED_MENU.map((item) => item.key), ["search", "drafts", "bookmarks", "muted", "blocked", "scheduled"]);

// The card: 86% of the width up to 440 px; closes past a third, or on a flick past half.
assert.equal(kapostsDrawerWidth(390), 390 * 0.86);
assert.equal(kapostsDrawerWidth(1200), 440);
assert.equal(kapostsDrawerShouldClose({ dx: -120, panelWidth: 330 }), true, "dragged past a third");
assert.equal(kapostsDrawerShouldClose({ dx: -100, panelWidth: 330 }), false, "short of a third");
assert.equal(kapostsDrawerShouldClose({ dx: -40, predicted: -200, panelWidth: 330 }), true, "flicked past half");
assert.equal(kapostsDrawerShouldClose({ dx: 80, predicted: 300, panelWidth: 330 }), false, "rightward never closes");
assert.equal(kapostsDrawerDim(0, 330), 0.45, "45% while open");
assert.equal(kapostsDrawerDim(-165, 330), 0.225, "half as dim half way out");
assert.equal(kapostsDrawerDim(60, 330), 0.45, "a rightward drag does not lighten it");
assert.equal(kapostsDrawerDim(-400, 330), 0, "never below zero");

// Axis lock: nothing until 12 px, then whichever way it went further.
assert.equal(KAPOSTS_PAGER_LOCK_PX, 12);
assert.equal(kapostsAxisLock(8, 8), null, "11.3 px is not yet 12");
assert.equal(kapostsAxisLock(12, 3), "x");
assert.equal(kapostsAxisLock(-3, 12), "y");
assert.equal(kapostsAxisLock(9, 9), "y", "a tie is the list's (iOS: width > height)");

// Rubber band at the ends only.
assert.equal(kapostsPagerOffset(0, 3, 90), 30, "past the first page");
assert.equal(kapostsPagerOffset(2, 3, -90), -30, "past the last page");
assert.equal(kapostsPagerOffset(1, 3, 90), 90, "between pages");
assert.equal(kapostsPagerOffset(0, 3, -90), -90, "toward the next page from the first");

// Projection (UIKit normal deceleration): standing still coasts nowhere.
assert.equal(kapostsProjectedTranslation(40, 0), 40);
assert.ok(Math.abs(kapostsProjectedTranslation(0, 1) - 499) < 1e-9);

// Which page a release settles on.
const W = 390;
assert.equal(kapostsPagerTarget({ selection: 1, pageCount: 3, dx: -140, width: W }), 2, "past a third: next");
assert.equal(kapostsPagerTarget({ selection: 1, pageCount: 3, dx: -120, width: W }), 1, "short of a third: stays");
assert.equal(kapostsPagerTarget({ selection: 1, pageCount: 3, dx: -40, predicted: -200, width: W }), 2, "flick past half: next");
assert.equal(kapostsPagerTarget({ selection: 1, pageCount: 3, dx: 140, width: W }), 0, "past a third right: previous");
assert.equal(kapostsPagerTarget({ selection: 0, pageCount: 3, dx: 300, width: W }), 0, "nothing before the first");
assert.equal(kapostsPagerTarget({ selection: 2, pageCount: 3, dx: -300, width: W }), 2, "nothing after the last");
assert.equal(kapostsPagerTarget({ selection: 1, pageCount: 3, dx: -140, dy: 200, width: W }), 1, "ended more vertical than sideways");

console.log("kaposts-format: ok");
