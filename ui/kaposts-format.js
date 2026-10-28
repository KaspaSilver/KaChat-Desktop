// Pure text/time and gesture helpers for the KaPosts screens, kept out of ui/kaposts.js so they can
// be tested in node (tools/test-kaposts-format.mjs). Each one names the iOS piece it mirrors.

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

// --- Feed menu, drawer and pager (iOS 865c9ab KaPostsFeedDrawer / KaPostsFeedPager) ---------------
// The gesture arithmetic, kept here with the other pure helpers so node can test it; ui/kaposts.js
// feeds it pointer positions and applies what comes back.

/** What the feed's hamburger card lists, in iOS order (865c9ab SideMenuItem.feedMenu). Profile,
 *  Notifications and Settings are dock tabs on iOS, so the card leaves them out. `key` is the
 *  KaPosts section ui/kaposts.js opens for the row. */
export const KAPOSTS_FEED_MENU = Object.freeze([
  { key: "search", title: "Search" },
  { key: "drafts", title: "Drafts" },
  { key: "bookmarks", title: "Bookmarks" },
  { key: "muted", title: "Muted" },
  { key: "blocked", title: "Blocked" },
  { key: "scheduled", title: "Scheduled" },
]);

/** How far a touch travels before it commits to one direction (iOS DragGesture(minimumDistance:
 *  12), measured as a straight-line distance as SwiftUI does). */
export const KAPOSTS_PAGER_LOCK_PX = 12;

/** The axis a touch locks to: null until it has moved `threshold` px, then "x" when it went more
 *  sideways than up or down (iOS `abs(t.width) > abs(t.height)`), else "y" - the list scrolling. */
export function kapostsAxisLock(dx, dy, threshold = KAPOSTS_PAGER_LOCK_PX) {
  if (Math.hypot(Number(dx) || 0, Number(dy) || 0) < threshold) return null;
  return Math.abs(dx) > Math.abs(dy) ? "x" : "y";
}

/** Where the pages sit under the finger: the finger's own offset, or a third of it past the first
 *  or the last page, so the edge gives a little and then resists (iOS `t.width / 3`). */
export function kapostsPagerOffset(selection, pageCount, dx) {
  const pastEdge = (selection === 0 && dx > 0) || (selection === pageCount - 1 && dx < 0);
  return pastEdge ? dx / 3 : dx;
}

/** Where a released drag would coast to - UIKit's projection at the normal deceleration rate
 *  (0.998 per ms), the figure SwiftUI's `predictedEndTranslation` gives. `velocity` in px/ms. */
export function kapostsProjectedTranslation(dx, velocity) {
  const rate = 0.998;
  return (Number(dx) || 0) + (Number(velocity) || 0) * (rate / (1 - rate));
}

/** The page a released drag settles on (iOS KaPostsFeedPager onEnded): one page on, past a third of
 *  the width or on a flick that would coast past half of it; otherwise back where it was. A drag
 *  that ended more up-and-down than sideways never changes the page. */
export function kapostsPagerTarget({ selection, pageCount, dx, dy = 0, predicted = dx, width }) {
  if (!(Math.abs(dx) > Math.abs(dy)) || !(width > 0)) return selection;
  if ((dx < -width / 3 || predicted < -width / 2) && selection < pageCount - 1) return selection + 1;
  if ((dx > width / 3 || predicted > width / 2) && selection > 0) return selection - 1;
  return selection;
}

/** The card's width: most of the screen, with enough of the feed left showing to tap it closed
 *  (iOS `min(width * 0.86, 440)`). */
export function kapostsDrawerWidth(viewportWidth) {
  return Math.min((Number(viewportWidth) || 0) * 0.86, 440);
}

/** Whether a drag on the open card closes it (iOS KaPostsFeedDrawer onEnded): dragged left by a
 *  third of its width, or flicked so it would coast past half. Rightward drags never count. */
export function kapostsDrawerShouldClose({ dx, predicted = dx, panelWidth }) {
  return -dx > panelWidth / 3 || predicted < -panelWidth / 2;
}

/** The dim over the feed beside the card (iOS `0.45 * progress`): full while the card is open,
 *  fading as it is dragged closed. */
export function kapostsDrawerDim(dx, panelWidth) {
  if (!(panelWidth > 0)) return 0;
  const progress = Math.max(0, 1 + Math.min(0, Number(dx) || 0) / panelWidth);
  return 0.45 * progress;
}

// --- Default tip and payment request cards (iOS 4c0d5a8, 0b9fd28) --------------------------------

/** A currency amount for the default-tip field: two decimals, trimmed ("1", "1.5", "0.25") (iOS
 *  KaPostsSettingsView.fiatText). */
export function kapostsFiatFieldText(value) {
  const v = Number(value);
  if (!Number.isFinite(v) || v <= 0) return "";
  return v.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

/** A KAS amount for the field: eight decimals, trimmed (iOS KaPostsSettingsView.trimmed). */
export function kapostsKasFieldText(value) {
  const v = Number(value);
  if (!Number.isFinite(v) || v <= 0) return "";
  return v.toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
}

/** The number typed in the default-tip field, in either unit: a dot or the locale's comma, null for
 *  anything that is not a positive number. */
export function kapostsTipFieldAmount(text) {
  const raw = String(text ?? "").trim().replace(",", ".");
  if (!/^(?:\d+\.?\d*|\.\d+)$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** The field's text after the unit is tapped (iOS switchTipUnit): the amount carried over at
 *  `price` (1 KAS in the currency), or the text as typed when there is no price or no amount. */
export function kapostsSwitchTipText(text, toFiat, price) {
  const amount = kapostsTipFieldAmount(text);
  if (amount == null || !(Number(price) > 0)) return String(text ?? "");
  return toFiat ? kapostsFiatFieldText(amount * price) : kapostsKasFieldText(amount / price);
}

/** What one default tip sends, in sompi (iOS KaPostsView tip): a tip set in KAS (`{ sompi }`) as
 *  it is, one set in a currency (`{ fiat, currency }`) worked out at `price` - 1 KAS in that
 *  currency, the price of the moment - to the nearest sompi. null with no tip set, and for a
 *  currency tip with no price yet. */
export function kapostsDefaultTipSompi(tip, price) {
  if (!tip) return null;
  if (Number(tip.fiat) > 0) {
    if (!(Number(price) > 0)) return null;
    const sompi = Math.round((Number(tip.fiat) / Number(price)) * 1e8);
    return sompi > 0 ? sompi : null;
  }
  const sompi = Math.floor(Number(tip.sompi) || 0);
  return sompi > 0 ? sompi : null;
}

// The KaChat links a post can carry (the same set as ui/app.js INTERNAL_LINK_IN_TEXT_RE).
const KAPOSTS_INTERNAL_LINK_RE = /(?:kachat:\/\/(?:kapost|broadcast|profile|pay)\/[^\s<>"']+|https?:\/\/(?:www\.)?kachat\.app\/(?:post|broadcast|u|pay)\/[^\s<>"']+)/i;

/** A payment request link in a post (iOS 0b9fd28 KaPostCellView.paymentRequestLink): the first
 *  KaChat link in `text`, when it is a payment request `parseLink` accepts (signature and all).
 *  Returns `{ request, raw, bodyText }` - `bodyText` is the post without the link, which the card
 *  under it stands for - or null. Trailing prose punctuation is not part of the link. */
export function kapostsPaymentRequestIn(text, parseLink) {
  const value = String(text ?? "");
  const match = value.match(KAPOSTS_INTERNAL_LINK_RE);
  if (!match || !/\/pay\//i.test(match[0])) return null;
  const raw = match[0].replace(/[.,;:!?)\]}'"]+$/, "");
  const request = typeof parseLink === "function" ? parseLink(raw) : null;
  if (!request) return null;
  return { request, raw, bodyText: value.split(raw).join("").trim() };
}
