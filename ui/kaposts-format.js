// Pure text/time helpers for the KaPosts screens, kept out of ui/kaposts.js so they can be tested
// in node (tools/test-kaposts-format.mjs). Each one names the iOS piece it mirrors.

/** Characters as the composer counts them: code points, so an emoji is one, not two UTF-16
 *  units (iOS counts `text.count`). */
export function kapostsCharCount(text) {
  return [...String(text || "")].length;
}

/** `text` cut to at most `limit` code points, never inside a surrogate pair. */
export function kapostsClampChars(text, limit) {
  const value = String(text || "");
  if (value.length <= limit) return value; // UTF-16 length bounds the code-point count
  const chars = [...value];
  return chars.length > limit ? chars.slice(0, limit).join("") : value;
}

/** What a folded cell lays out (iOS KaPostCellView.layoutText): a post longer than 1 200
 *  characters is cut to its first 1 200, back to the last whitespace when that is past 600 so a
 *  markdown span or link is never split, and ends with an ellipsis. Shorter text is unchanged. */
export function kapostsFoldedPrefix(text) {
  const chars = [...String(text || "")];
  if (chars.length <= 1200) return chars.join("");
  let cut = chars.slice(0, 1200);
  let space = -1;
  for (let i = cut.length - 1; i >= 0; i -= 1) {
    if (/\s/.test(cut[i])) { space = i; break; }
  }
  if (space > 600) cut = cut.slice(0, space);
  return `${cut.join("")}…`;
}

/** The Edit row's "1h 12m left" / "8m left" (iOS editWindowText): whole minutes, at least 1. */
export function kapostsEditWindowText(leftMs) {
  if (!(leftMs > 0)) return "";
  const minutes = Math.floor(leftMs / 60000);
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m left` : `${Math.max(minutes, 1)}m left`;
}

const LONG_UNITS = [
  ["year", 365 * 86400],
  ["month", 30 * 86400],
  ["week", 7 * 86400],
  ["day", 86400],
  ["hour", 3600],
  ["minute", 60],
  ["second", 1],
];

/** SwiftUI's `Text(date, style: .relative)`: the distance from now in the two largest units,
 *  spelled out - "2 hours, 23 minutes", "45 seconds" (iOS drafts list, search results). */
export function kapostsLongRelativeTime(timestampMs, now = Date.now()) {
  let left = Math.floor(Math.abs(now - Number(timestampMs || 0)) / 1000);
  const parts = [];
  for (const [unit, seconds] of LONG_UNITS) {
    if (parts.length === 2) break;
    const count = Math.floor(left / seconds);
    if (count > 0) {
      parts.push(`${count} ${unit}${count === 1 ? "" : "s"}`);
      left -= count * seconds;
    }
  }
  return parts.length ? parts.join(", ") : "0 seconds";
}

/** Foundation's `.relative(presentation: .named)` (iOS composer quote card): "5 minutes ago",
 *  "yesterday", "now", in the reader's locale. */
export function kapostsNamedRelativeTime(timestampMs, now = Date.now(), locale = undefined) {
  const deltaSec = Math.round((Number(timestampMs || 0) - now) / 1000);
  const abs = Math.abs(deltaSec);
  let value; let unit;
  if (abs < 60) { value = deltaSec; unit = "second"; }
  else if (abs < 3600) { value = Math.trunc(deltaSec / 60); unit = "minute"; }
  else if (abs < 86400) { value = Math.trunc(deltaSec / 3600); unit = "hour"; }
  else if (abs < 7 * 86400) { value = Math.trunc(deltaSec / 86400); unit = "day"; }
  else if (abs < 30 * 86400) { value = Math.trunc(deltaSec / (7 * 86400)); unit = "week"; }
  else if (abs < 365 * 86400) { value = Math.trunc(deltaSec / (30 * 86400)); unit = "month"; }
  else { value = Math.trunc(deltaSec / (365 * 86400)); unit = "year"; }
  try {
    return new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(value, unit);
  } catch {
    return `${Math.abs(value)} ${unit}${Math.abs(value) === 1 ? "" : "s"} ago`;
  }
}
