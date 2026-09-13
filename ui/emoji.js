// Emoji for reactions and the composer (iOS EmojiReactionPicker / DesktopEmojiLibrary).
//
// Two pickers share this file. The REACTION picker is a curated, sectioned list - the long tail
// of Unicode is unsearchable by eye and inflates a sheet for no practical gain. The COMPOSER
// picker is the wide library the desktop composer's emoji button offers, categorised by
// codepoint the way iOS's DesktopEmojiLibrary does it.

// ---------------------------------------------------------------------------
// Recents: emoji you have actually reacted with, most recent first. Local and shared across
// every chat type - a reaction is a reaction whether it lands on a 1:1 message, a group message
// or a broadcast.
// ---------------------------------------------------------------------------

const RECENTS_KEY = "kachat_emoji_reaction_recents";
const RECENTS_LIMIT = 24;

export function emojiRecents() {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENTS_KEY) || "[]");
    return Array.isArray(raw) ? raw.filter((e) => typeof e === "string" && e) : [];
  } catch { return []; }
}

export function recordEmojiRecent(emoji) {
  if (!emoji) return;
  const updated = [emoji, ...emojiRecents().filter((e) => e !== emoji)].slice(0, RECENTS_LIMIT);
  try { localStorage.setItem(RECENTS_KEY, JSON.stringify(updated)); } catch {}
}

// ---------------------------------------------------------------------------
// The reaction picker's sections (byte-for-byte the iOS list, grouped the way a keyboard groups
// them).
// ---------------------------------------------------------------------------

export const REACTION_SECTIONS = [
  ["Smileys", ["😀","😃","😄","😁","😆","😅","🤣","😂","🙂","🙃","😉","😊","😇","🥰","😍","🤩","😘","😗","😚","😙","😋","😛","😜","🤪","😝","🤗","🤭","🤫","🤔","🤐","😐","😑","😶","😏","😒","🙄","😬","😮","😯","😪","😴","😌","😔","😕","🙁","☹️","😣","😖","😫","😩","🥺","😢","😭","😤","😠","😡","🤬","🤯","😳","🥵","🥶","😱","😨","😰","😥","🤡","💩"]],
  ["Gestures", ["👍","👎","👌","🤌","✌️","🤞","🤟","🤘","🤙","👈","👉","👆","👇","☝️","✋","🤚","🖐️","🖖","👋","🤝","🙏","💪","🫶","👏","🙌","👐","🤲","✊","👊"]],
  ["Hearts", ["❤️","🧡","💛","💚","💙","💜","🖤","🤍","🤎","💔","❣️","💕","💞","💓","💗","💖","💘","💝"]],
  ["Celebration", ["🔥","✨","🎉","🎊","🥳","🏆","🥇","💯","⭐","🌟","💫","⚡","💥","🚀","🎯","🎁"]],
  ["Objects", ["👀","🧠","💡","💰","💸","💎","📈","📉","🔒","🔑","⏰","📌","✅","❌","⚠️","❓","❗"]],
  ["Animals & Nature", ["🐶","🐱","🦊","🐻","🐼","🐨","🦁","🐮","🐷","🐸","🐵","🐔","🐧","🦄","🐝","🦋","🌸","🌻","🌈","🌊","🌙","☀️"]],
];

// Search matches an emoji's NAME ("fire", "heart", "cat"). Browsers expose no Unicode names, so
// the curated list carries its own short keyword table; anything not listed still matches on the
// character itself.
const REACTION_KEYWORDS = {
  "😀": "grinning face smile", "😃": "grinning big eyes smile", "😄": "grinning smiling eyes", "😁": "beaming grin",
  "😆": "grinning squinting laugh", "😅": "sweat smile", "🤣": "rolling on the floor laughing", "😂": "tears of joy laugh cry",
  "🙂": "slightly smiling", "🙃": "upside down", "😉": "wink", "😊": "smiling blush", "😇": "halo angel",
  "🥰": "smiling hearts love", "😍": "heart eyes love", "🤩": "star struck", "😘": "kiss", "😗": "kissing",
  "😚": "kissing closed eyes", "😙": "kissing smiling eyes", "😋": "yum delicious", "😛": "tongue", "😜": "wink tongue",
  "🤪": "zany crazy", "😝": "squinting tongue", "🤗": "hug", "🤭": "hand over mouth", "🤫": "shush quiet",
  "🤔": "thinking", "🤐": "zipper mouth", "😐": "neutral", "😑": "expressionless", "😶": "no mouth",
  "😏": "smirk", "😒": "unamused", "🙄": "eye roll", "😬": "grimace", "😮": "open mouth wow", "😯": "hushed",
  "😪": "sleepy", "😴": "sleeping zzz", "😌": "relieved", "😔": "pensive sad", "😕": "confused", "🙁": "frown",
  "☹️": "frowning", "😣": "persevere", "😖": "confounded", "😫": "tired", "😩": "weary", "🥺": "pleading puppy eyes",
  "😢": "crying sad tear", "😭": "loudly crying sob", "😤": "huffing steam", "😠": "angry", "😡": "pouting rage",
  "🤬": "cursing swearing", "🤯": "exploding head mind blown", "😳": "flushed", "🥵": "hot", "🥶": "cold freezing",
  "😱": "screaming fear", "😨": "fearful", "😰": "anxious sweat", "😥": "sad relieved", "🤡": "clown", "💩": "poop",
  "👍": "thumbs up like yes", "👎": "thumbs down dislike no", "👌": "ok hand", "🤌": "pinched fingers", "✌️": "victory peace",
  "🤞": "crossed fingers luck", "🤟": "love you", "🤘": "rock horns", "🤙": "call me shaka", "👈": "point left",
  "👉": "point right", "👆": "point up", "👇": "point down", "☝️": "index up", "✋": "raised hand stop", "🤚": "back of hand",
  "🖐️": "hand fingers splayed", "🖖": "vulcan salute", "👋": "wave hello bye", "🤝": "handshake deal", "🙏": "folded hands pray thanks",
  "💪": "flexed biceps strong", "🫶": "heart hands", "👏": "clapping applause", "🙌": "raising hands hooray", "👐": "open hands",
  "🤲": "palms up", "✊": "raised fist", "👊": "fist bump punch",
  "❤️": "red heart love", "🧡": "orange heart", "💛": "yellow heart", "💚": "green heart", "💙": "blue heart", "💜": "purple heart",
  "🖤": "black heart", "🤍": "white heart", "🤎": "brown heart", "💔": "broken heart", "❣️": "heart exclamation",
  "💕": "two hearts", "💞": "revolving hearts", "💓": "beating heart", "💗": "growing heart", "💖": "sparkling heart",
  "💘": "heart with arrow", "💝": "heart with ribbon gift",
  "🔥": "fire hot lit", "✨": "sparkles", "🎉": "party popper tada", "🎊": "confetti", "🥳": "partying face",
  "🏆": "trophy win", "🥇": "gold medal first", "💯": "hundred", "⭐": "star", "🌟": "glowing star", "💫": "dizzy",
  "⚡": "lightning zap", "💥": "collision boom", "🚀": "rocket moon", "🎯": "bullseye target", "🎁": "gift present",
  "👀": "eyes looking", "🧠": "brain", "💡": "light bulb idea", "💰": "money bag", "💸": "money with wings", "💎": "gem diamond",
  "📈": "chart increasing up", "📉": "chart decreasing down", "🔒": "locked", "🔑": "key", "⏰": "alarm clock",
  "📌": "pushpin", "✅": "check mark done", "❌": "cross mark no", "⚠️": "warning", "❓": "question", "❗": "exclamation",
  "🐶": "dog", "🐱": "cat", "🦊": "fox", "🐻": "bear", "🐼": "panda", "🐨": "koala", "🦁": "lion", "🐮": "cow", "🐷": "pig",
  "🐸": "frog", "🐵": "monkey", "🐔": "chicken", "🐧": "penguin", "🦄": "unicorn", "🐝": "bee", "🦋": "butterfly",
  "🌸": "cherry blossom flower", "🌻": "sunflower", "🌈": "rainbow", "🌊": "wave ocean", "🌙": "moon", "☀️": "sun",
};

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------------------------------------------------------------------------
// The reaction picker sheet ("React"): searchable, sectioned, Recents first.
// ---------------------------------------------------------------------------

let reactionHost = null;
function ensureReactionHost() {
  if (reactionHost) return reactionHost;
  reactionHost = document.createElement("div");
  reactionHost.className = "modal-backdrop emoji-picker-backdrop";
  reactionHost.hidden = true;
  reactionHost.innerHTML = `
    <section class="contact-modal emoji-picker-sheet" role="dialog" aria-modal="true" aria-label="React">
      <div class="modal-header">
        <div><h2>React</h2></div>
        <button class="modal-close" type="button" data-emoji-cancel aria-label="Cancel">×</button>
      </div>
      <input class="emoji-picker-search" type="search" placeholder="Search emoji" autocomplete="off" spellcheck="false" data-emoji-search />
      <div class="emoji-picker-body" data-emoji-body></div>
      <div class="modal-actions"><button class="secondary-button" type="button" data-emoji-cancel>Cancel</button></div>
    </section>`;
  document.body.appendChild(reactionHost);
  return reactionHost;
}

export function openEmojiReactionPicker({ onPick }) {
  const host = ensureReactionHost();
  const body = host.querySelector("[data-emoji-body]");
  const search = host.querySelector("[data-emoji-search]");
  const close = () => { host.hidden = true; host.onclick = null; host.onkeydown = null; search.oninput = null; };
  const render = () => {
    const query = search.value.trim().toLowerCase();
    const sections = [];
    if (!query && emojiRecents().length) sections.push(["Recents", emojiRecents()]);
    for (const [title, emojis] of REACTION_SECTIONS) {
      const matches = query
        ? emojis.filter((emoji) => emoji.includes(query) || (REACTION_KEYWORDS[emoji] || "").includes(query))
        : emojis;
      if (matches.length) sections.push([title, matches]);
    }
    body.innerHTML = sections.length
      ? sections.map(([title, emojis]) => `
          <div class="emoji-picker-section">
            <div class="emoji-picker-title">${escapeHtml(title)}</div>
            <div class="emoji-picker-grid">${emojis.map((emoji) => `<button type="button" data-emoji="${escapeHtml(emoji)}" title="${escapeHtml(REACTION_KEYWORDS[emoji] || "")}">${escapeHtml(emoji)}</button>`).join("")}</div>
          </div>`).join("")
      : `<p class="emoji-picker-empty">No emoji match that.</p>`;
  };
  search.value = "";
  render();
  host.hidden = false;
  search.focus();
  search.oninput = render;
  host.onclick = (event) => {
    if (event.target === host || event.target.closest("[data-emoji-cancel]")) { close(); return; }
    const button = event.target.closest("[data-emoji]");
    if (!button) return;
    const emoji = button.dataset.emoji;
    recordEmojiRecent(emoji);
    close();
    onPick?.(emoji);
  };
  host.onkeydown = (event) => { if (event.key === "Escape") close(); };
}

// ---------------------------------------------------------------------------
// The composer's emoji library (iOS DesktopEmojiLibrary): categorised by codepoint, built once.
// ---------------------------------------------------------------------------

export const COMPOSER_CATEGORIES = [
  { id: "smileys", title: "Smileys", icon: "😊" },
  { id: "people", title: "People", icon: "🧑" },
  { id: "nature", title: "Nature", icon: "🌿" },
  { id: "food", title: "Food", icon: "🍔" },
  { id: "travel", title: "Travel", icon: "🚗" },
  { id: "activities", title: "Activities", icon: "⚽" },
  { id: "objects", title: "Objects", icon: "💡" },
  { id: "symbols", title: "Symbols", icon: "❤️" },
  { id: "flags", title: "Flags", icon: "🏁" },
];

function categoryFor(code) {
  const inRange = (a, b) => code >= a && code <= b;
  if (inRange(0x1F600, 0x1F64F) || inRange(0x1F970, 0x1F97F)) return "smileys";
  if (inRange(0x1F300, 0x1F32C) || inRange(0x1F330, 0x1F335) || inRange(0x1F337, 0x1F343) || inRange(0x1F400, 0x1F43F) || inRange(0x1F980, 0x1F9AE)) return "nature";
  if (inRange(0x1F32D, 0x1F37F) || inRange(0x1F950, 0x1F96F) || inRange(0x1F9C0, 0x1F9CB)) return "food";
  if (inRange(0x1F680, 0x1F6FF) || inRange(0x1F3E0, 0x1F3F0)) return "travel";
  if (inRange(0x1F380, 0x1F3DF) || inRange(0x1F3F8, 0x1F3FF) || inRange(0x1F93C, 0x1F945)) return "activities";
  if (inRange(0x1F466, 0x1F487) || inRange(0x1F590, 0x1F596) || inRange(0x1F645, 0x1F64F) || inRange(0x1F900, 0x1F93B) || inRange(0x1F9B0, 0x1F9DF)) return "people";
  if (inRange(0x1F4A0, 0x1F5FF) || inRange(0x1F9E0, 0x1FAFF)) return "objects";
  return "symbols";
}

const COMMON_SEQUENCES = [
  ["❤️‍🔥", "symbols", "heart on fire love"], ["❤️‍🩹", "symbols", "mending heart heal love"],
  ["🏳️‍🌈", "flags", "rainbow pride flag"], ["🏳️‍⚧️", "flags", "transgender pride flag"], ["🏴‍☠️", "flags", "pirate flag"],
  ["😶‍🌫️", "smileys", "face in clouds fog"], ["😮‍💨", "smileys", "face exhaling relief"], ["😵‍💫", "smileys", "face dizzy spiral eyes"],
  ["🐈‍⬛", "nature", "black cat"], ["🐻‍❄️", "nature", "polar bear"], ["🐦‍🔥", "nature", "phoenix bird fire"],
  ["👨‍💻", "people", "man technologist coder developer"], ["👩‍💻", "people", "woman technologist coder developer"], ["🧑‍💻", "people", "person technologist coder developer"],
  ["👨‍🚀", "people", "man astronaut"], ["👩‍🚀", "people", "woman astronaut"], ["🧑‍🚀", "people", "person astronaut"],
  ["👨‍⚕️", "people", "man health worker doctor"], ["👩‍⚕️", "people", "woman health worker doctor"], ["🧑‍⚕️", "people", "person health worker doctor"],
  ["👨‍🏫", "people", "man teacher"], ["👩‍🏫", "people", "woman teacher"], ["🧑‍🏫", "people", "person teacher"],
  ["👨‍🍳", "people", "man cook chef"], ["👩‍🍳", "people", "woman cook chef"], ["🧑‍🍳", "people", "person cook chef"],
  ["👨‍👩‍👧", "people", "family"], ["👨‍👩‍👦", "people", "family"], ["👩‍👩‍👧", "people", "family"], ["👨‍👨‍👦", "people", "family"],
  ["👩‍👧", "people", "family mother daughter"], ["👨‍👦", "people", "family father son"],
];

let composerItems = null;
function buildComposerItems() {
  if (composerItems) return composerItems;
  const seen = new Set();
  const out = [];
  const add = (emoji, category, keywords) => {
    if (seen.has(emoji)) return;
    seen.add(emoji);
    out.push({ emoji, category, keywords: String(keywords || "").toLowerCase() });
  };
  // Every curated reaction emoji first, with its keywords, so the search finds the common ones
  // by name. The browser exposes no Unicode names, so the rest match on category and character.
  for (const [title, emojis] of REACTION_SECTIONS) {
    for (const emoji of emojis) {
      const code = emoji.codePointAt(0);
      add(emoji, categoryFor(code), `${REACTION_KEYWORDS[emoji] || ""} ${title}`);
    }
  }
  const presentation = /^\p{Emoji_Presentation}$/u;
  const emojiProp = /^\p{Emoji}$/u;
  const modifierBase = /^\p{Emoji_Modifier_Base}$/u;
  const ranges = [[0x00A9, 0x00AE], [0x203C, 0x3299], [0x1F000, 0x1FAFF]];
  const scalarItems = [];
  for (const [from, to] of ranges) {
    for (let code = from; code <= to; code += 1) {
      if ((code >= 0x1F1E6 && code <= 0x1F1FF) || (code >= 0x1F3FB && code <= 0x1F3FF)) continue;
      if (code === 0x23 || code === 0x2A || (code >= 0x30 && code <= 0x39)) continue;
      const char = String.fromCodePoint(code);
      const isPresentation = presentation.test(char);
      if (!isPresentation && !emojiProp.test(char)) continue;
      const emoji = isPresentation ? char : `${char}️`;
      const category = categoryFor(code);
      const title = COMPOSER_CATEGORIES.find((c) => c.id === category)?.title || "";
      scalarItems.push({ emoji, code, char, category, keywords: title.toLowerCase(), modifierBase: modifierBase.test(char) });
      add(emoji, category, title);
    }
  }
  const tones = [["\u{1F3FB}", "light skin tone"], ["\u{1F3FC}", "medium light skin tone"], ["\u{1F3FD}", "medium skin tone"], ["\u{1F3FE}", "medium dark skin tone"], ["\u{1F3FF}", "dark skin tone"]];
  for (const item of scalarItems) {
    if (!item.modifierBase) continue;
    for (const [tone, keywords] of tones) add(item.char + tone, "people", `${item.keywords} ${keywords}`);
  }
  for (const [emoji, category, keywords] of COMMON_SEQUENCES) add(emoji, category, keywords);
  // Regional flags: every two-letter ISO region the runtime knows a name for.
  let regionNames = null;
  try { regionNames = new Intl.DisplayNames(undefined, { type: "region" }); } catch { regionNames = null; }
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  for (const a of letters) {
    for (const b of letters) {
      const code = a + b;
      let name = "";
      try { name = regionNames?.of(code) || ""; } catch { name = ""; }
      if (!name || name === code) continue;
      const flag = String.fromCodePoint(0x1F1E6 + letters.indexOf(a), 0x1F1E6 + letters.indexOf(b));
      add(flag, "flags", `flag ${code.toLowerCase()} ${name}`);
    }
  }
  composerItems = out;
  return out;
}

export function composerEmoji(category) {
  return buildComposerItems().filter((item) => item.category === category);
}

export function searchComposerEmoji(query) {
  const tokens = String(query || "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  const items = buildComposerItems();
  if (!tokens.length) return items;
  return items.filter((item) => {
    const haystack = `${item.emoji} ${item.keywords}`;
    return tokens.every((token) => haystack.includes(token));
  });
}

// ---------------------------------------------------------------------------
// The composer's emoji popover (iOS DesktopEmojiPickerView): category bar, search, grid.
// ---------------------------------------------------------------------------

let composerPopover = null;
export function openComposerEmojiPopover({ anchor, onSelect }) {
  closeComposerEmojiPopover();
  const popover = document.createElement("div");
  popover.className = "emoji-composer-popover";
  popover.innerHTML = `
    <div class="emoji-composer-categories" role="tablist">
      ${COMPOSER_CATEGORIES.map((c, i) => `<button type="button" class="${i === 0 ? "active" : ""}" data-emoji-category="${c.id}" aria-label="${escapeHtml(c.title)}" title="${escapeHtml(c.title)}">${c.icon}</button>`).join("")}
    </div>
    <input class="emoji-picker-search" type="search" placeholder="Search emoji" autocomplete="off" spellcheck="false" data-emoji-search />
    <div class="emoji-composer-grid" data-emoji-grid></div>`;
  document.body.appendChild(popover);
  composerPopover = popover;
  let category = COMPOSER_CATEGORIES[0].id;
  const search = popover.querySelector("[data-emoji-search]");
  const grid = popover.querySelector("[data-emoji-grid]");
  const render = () => {
    const query = search.value.trim();
    const items = query ? searchComposerEmoji(query) : composerEmoji(category);
    popover.querySelectorAll("[data-emoji-category]").forEach((b) => b.classList.toggle("active", !query && b.dataset.emojiCategory === category));
    grid.innerHTML = items.length
      ? items.slice(0, 600).map((item) => `<button type="button" data-emoji="${escapeHtml(item.emoji)}" title="${escapeHtml(item.keywords)}">${escapeHtml(item.emoji)}</button>`).join("")
      : `<p class="emoji-picker-empty">No emoji found</p>`;
  };
  render();
  const rect = anchor.getBoundingClientRect();
  const width = 420;
  popover.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`;
  popover.style.bottom = `${Math.max(8, window.innerHeight - rect.top + 8)}px`;
  search.focus();
  search.addEventListener("input", render);
  popover.addEventListener("click", (event) => {
    const cat = event.target.closest("[data-emoji-category]");
    if (cat) { category = cat.dataset.emojiCategory; search.value = ""; render(); return; }
    const button = event.target.closest("[data-emoji]");
    if (button) onSelect?.(button.dataset.emoji);
  });
  const onDown = (event) => { if (!popover.contains(event.target) && event.target !== anchor && !anchor.contains(event.target)) closeComposerEmojiPopover(); };
  const onKey = (event) => { if (event.key === "Escape") closeComposerEmojiPopover(); };
  setTimeout(() => {
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
  }, 0);
  popover._cleanup = () => {
    document.removeEventListener("mousedown", onDown, true);
    document.removeEventListener("keydown", onKey, true);
  };
}

export function closeComposerEmojiPopover() {
  if (!composerPopover) return;
  composerPopover._cleanup?.();
  composerPopover.remove();
  composerPopover = null;
}

export function isComposerEmojiPopoverOpen() {
  return Boolean(composerPopover);
}
