// node tools/test-kaposts-format.mjs - the KaPosts text/time helpers (ui/kaposts-format.js).
import assert from "node:assert/strict";
import {
  kapostsCharCount,
  kapostsClampChars,
  kapostsFoldedPrefix,
  kapostsEditWindowText,
  kapostsLongRelativeTime,
  kapostsNamedRelativeTime,
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

console.log("kaposts-format: ok");
