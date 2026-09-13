// The formatting KaPosts understands, and the single place its rules are written down.
//
// A port of iOS's KaPostsMarkdown.swift (which is itself kept byte-identical to the Android
// parser). A post is written on one platform and read on the others, so a rule that differs
// here shows up as one reader seeing asterisks where another sees bold. Keep every rule below
// in step with the Swift file; do not "improve" the grammar on one side only.
//
//   Bold           **text**
//   Italic         *text*
//   Underline      __text__
//   Strikethrough  ~~text~~
//   Subtext        -# text   (whole line)
//   Ordered list   1. text   (whole line)
//   Bullet list    * text / - text (whole line)
//   Link           [label](url)
//
// Deliberately absent: headings and spoilers. `__` is UNDERLINE here, not CommonMark's second
// bold; a line-leading `* ` is a bullet, never italic; `-# ` is checked before `- `.
//
// render() emits the text as it should READ (markers removed, bullet and number prefixes
// materialised) plus style spans addressed by offset into that output, so the caller can run its
// URL/@mention linkifier over the same string and layer these on top. Offsets are UTF-16 code
// units throughout, which is what a <textarea>'s selectionStart/End count in.

const PLAIN = Object.freeze({ bold: false, italic: false, underline: false, strikethrough: false, subtext: false, link: null });

function isPlain(style) {
  return !style.bold && !style.italic && !style.underline && !style.strikethrough && !style.subtext && !style.link;
}

function sameStyle(a, b) {
  return a.bold === b.bold && a.italic === b.italic && a.underline === b.underline
    && a.strikethrough === b.strikethrough && a.subtext === b.subtext && a.link === b.link;
}

/** True if `source` contains anything this parser would style. */
export function containsKaPostsFormatting(source) {
  return renderKaPostsMarkdown(source).hasFormatting;
}

export function renderKaPostsMarkdown(source) {
  const state = { out: "", spans: [] };
  const lines = String(source ?? "").split("\n");
  lines.forEach((line, index) => {
    if (index > 0) state.out += "\n";
    renderLine(line, state);
  });
  const spans = mergeAdjacent(state.spans);
  return { text: state.out, spans, hasFormatting: spans.length > 0 };
}

// --- Block level -----------------------------------------------------------------------------

function renderLine(line, state) {
  let content = line;
  const lineStyle = { ...PLAIN };
  let prefix = "";

  // Leading spaces are allowed before a marker so an indented list still reads as one.
  const indentLength = line.length - line.replace(/^ +/, "").length;
  const indent = line.slice(0, indentLength);
  const body = line.slice(indentLength);

  const ordered = orderedMarker(body);
  if (body.startsWith("-# ")) {
    // Checked before the "- " bullet, or "-# x" would become a bullet reading "# x".
    lineStyle.subtext = true;
    content = body.slice(3);
    prefix = indent;
  } else if (body.startsWith("* ") || body.startsWith("- ")) {
    content = body.slice(2);
    prefix = `${indent}• `;
  } else if (ordered) {
    content = body.slice(ordered.consumed);
    prefix = `${indent}${ordered.number}. `;
  }

  state.out += prefix;
  const lineStart = state.out.length;
  parseInline(content, lineStyle, state);
  // The bullet/number prefix carries the line's own style too, so a subtext line is uniformly
  // small rather than starting at body size.
  if (!isPlain(lineStyle) && prefix.length) {
    state.spans.push({ start: lineStart - prefix.length, end: lineStart, style: lineStyle });
  }
}

/** `12. ` at the start of a line: the number and how many characters it consumed. */
function orderedMarker(line) {
  const match = /^([0-9]{1,3})\. /.exec(line);
  if (!match) return null;
  return { number: parseInt(match[1], 10), consumed: match[1].length + 2 };
}

// --- Inline level ----------------------------------------------------------------------------

// Delimiters, longest first: `**` must be tried before `*`, or bold would parse as an italic run
// whose text starts with `*`.
const INLINE_DELIMITERS = [
  ["**", (s) => { s.bold = true; }],
  ["__", (s) => { s.underline = true; }],
  ["~~", (s) => { s.strikethrough = true; }],
  ["*", (s) => { s.italic = true; }],
];

function parseInline(chars, style, state) {
  let i = 0;
  let runStart = state.out.length;

  const flushPlainRun = () => {
    if (isPlain(style) || state.out.length <= runStart) return;
    state.spans.push({ start: runStart, end: state.out.length, style });
  };

  while (i < chars.length) {
    const link = matchLink(chars, i);
    if (link) {
      flushPlainRun();
      parseInline(link.label, { ...style, link: link.url }, state);
      i = link.next;
      runStart = state.out.length;
      continue;
    }
    const emphasis = matchEmphasis(chars, i);
    if (emphasis) {
      flushPlainRun();
      const inner = { ...style };
      emphasis.apply(inner);
      parseInline(emphasis.content, inner, state);
      i = emphasis.next;
      runStart = state.out.length;
      continue;
    }
    state.out += chars[i];
    i += 1;
  }
  flushPlainRun();
}

/** `[label](url)` at `i`. The URL must carry a scheme we are willing to open, so a post cannot
 *  dress `javascript:` up as friendly link text. */
function matchLink(chars, i) {
  if (chars[i] !== "[") return null;
  const labelEnd = chars.indexOf("]", i + 1);
  if (labelEnd <= i + 1) return null;
  if (labelEnd + 1 >= chars.length || chars[labelEnd + 1] !== "(") return null;
  const urlEnd = chars.indexOf(")", labelEnd + 2);
  if (urlEnd <= labelEnd + 2) return null;
  const label = chars.slice(i + 1, labelEnd);
  const rawTarget = chars.slice(labelEnd + 2, urlEnd).trim();
  const url = resolveKaPostsLinkTarget(rawTarget);
  if (!url) return null;
  return { label, url, next: urlEnd + 1 };
}

/** Schemes a post is allowed to send a reader to. */
const ALLOWED_LINK_SCHEMES = new Set(["http", "https", "kachat"]);

/**
 * Turns a link target into a URL we are willing to open, or null.
 *
 * The scheme is decided BEFORE anything is prepended: anything that already names a scheme must
 * name an allowed one; only a genuinely bare host gets https assumed for it.
 */
export function resolveKaPostsLinkTarget(raw) {
  const target = String(raw ?? "").trim();
  if (!target) return null;
  for (let i = 0; i < target.length; i += 1) {
    const code = target.charCodeAt(i);
    if (code < 0x20 || /\s/.test(target[i])) return null;
  }

  const tryUrl = (candidate) => {
    try { return new URL(candidate).href ? candidate : null; } catch { return null; }
  };

  // Scheme-relative ("//host/path") keeps its host and just gains https.
  if (target.startsWith("//")) return tryUrl(`https:${target}`);
  const schemeMatch = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(target);
  if (schemeMatch) {
    const scheme = schemeMatch[1].toLowerCase();
    if (!ALLOWED_LINK_SCHEMES.has(scheme)) return null;
    return tryUrl(target);
  }
  // No scheme at all: a bare host, which is the common case in a social post.
  return tryUrl(`https://${target}`);
}

/** An emphasis run opening at `i`, or null. Requires a closing marker on the same line with at
 *  least one character between: `****` and a lone `*` stay literal text. */
function matchEmphasis(chars, i) {
  for (const [marker, apply] of INLINE_DELIMITERS) {
    if (!chars.startsWith(marker, i)) continue;
    const contentStart = i + marker.length;
    // An opening marker followed by whitespace is almost always literal punctuation
    // ("2 * 3 = 6"), not formatting.
    if (contentStart >= chars.length || /\s/.test(chars[contentStart])) continue;
    let j = contentStart;
    while (j < chars.length) {
      if (chars.startsWith(marker, j)) {
        if (j === contentStart) break;
        return { content: chars.slice(contentStart, j), apply, next: j + marker.length };
      }
      j += 1;
    }
  }
  return null;
}

/** Collapses spans that touch and share a style, so a bold run split by a nested parse does not
 *  become several attribute runs. */
function mergeAdjacent(spans) {
  if (spans.length < 2) return spans;
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  const merged = [];
  for (const span of sorted) {
    const last = merged[merged.length - 1];
    if (last && last.end === span.start && sameStyle(last.style, span.style)) {
      merged[merged.length - 1] = { start: last.start, end: span.end, style: last.style };
    } else {
      merged.push(span);
    }
  }
  return merged;
}

// --- Toolbar edits ---------------------------------------------------------------------------
//
// What the composer's formatting buttons do to the text. Mirrored exactly from the Swift file,
// because these are the rules that decide what gets WRITTEN. Every action toggles: applying it
// to text that already has that formatting removes it, which is what a person expects from a
// Bold button and what stops a double tap producing `****text****`.

export const KAPOSTS_TOOLBAR_ACTIONS = ["bold", "italic", "underline", "strikethrough", "bulletList", "numberedList", "subtext", "link"];

/** Placeholder inserted when a link is added with nothing selected, and the target that is
 *  pre-selected so typing replaces it. */
export const LINK_LABEL_PLACEHOLDER = "link text";
export const LINK_TARGET_PLACEHOLDER = "https://";

function inlineMarker(action) {
  switch (action) {
    case "bold": return "**";
    case "italic": return "*";
    case "underline": return "__";
    case "strikethrough": return "~~";
    default: return null;
  }
}

function linePrefix(action) {
  switch (action) {
    case "bulletList": return "* ";
    case "subtext": return "-# ";
    default: return null;
  }
}

/** Text plus where the selection should sit afterwards: { text, selectionStart, selectionEnd }. */
export function applyKaPostsMarkdownAction(action, text, selectionStart, selectionEnd) {
  const chars = String(text ?? "");
  const start = Math.max(0, Math.min(selectionStart | 0, chars.length));
  const end = Math.max(start, Math.min(selectionEnd | 0, chars.length));
  if (action === "link") return applyLink(chars, start, end);
  const marker = inlineMarker(action);
  if (marker) return applyInline(marker, chars, start, end);
  return applyLine(action, chars, start, end);
}

function applyInline(marker, chars, start, end) {
  const width = marker.length;
  // Already wrapped, either inside the selection ("**bold**" highlighted) or just outside it
  // ("bold" highlighted between the markers). Both read as "this is bold" to the user, so both
  // unwrap.
  if (end - start >= 2 * width && chars.slice(start, start + width) === marker && chars.slice(end - width, end) === marker) {
    const inner = chars.slice(start + width, end - width);
    return { text: chars.slice(0, start) + inner + chars.slice(end), selectionStart: start, selectionEnd: start + inner.length };
  }
  if (start >= width && end + width <= chars.length
    && chars.slice(start - width, start) === marker && chars.slice(end, end + width) === marker) {
    const inner = chars.slice(start, end);
    return {
      text: chars.slice(0, start - width) + inner + chars.slice(end + width),
      selectionStart: start - width,
      selectionEnd: start - width + inner.length,
    };
  }
  const inner = chars.slice(start, end);
  const result = chars.slice(0, start) + marker + inner + marker + chars.slice(end);
  // Nothing selected: leave the caret between the markers, ready to type.
  const caret = start + width;
  return { text: result, selectionStart: caret, selectionEnd: inner.length ? caret + inner.length : caret };
}

/** Applies a line prefix to every line the selection touches, toggling off when they all already
 *  have it. Numbered lists renumber from 1 so a re-ordered selection stays sane. */
function applyLine(action, chars, start, end) {
  const lineStart = lineStartIndex(chars, start);
  const lineEnd = lineEndIndex(chars, end);
  const lines = chars.slice(lineStart, lineEnd).split("\n");
  const stripped = lines.map(stripLineMarkers);
  const alreadyApplied = lines.length > 0 && lines.every((line) => hasMarker(action, line));
  let rebuilt;
  if (alreadyApplied) {
    rebuilt = stripped;
  } else if (action === "numberedList") {
    rebuilt = stripped.map((line, index) => `${index + 1}. ${line}`);
  } else {
    const prefix = linePrefix(action);
    rebuilt = prefix ? stripped.map((line) => prefix + line) : stripped;
  }
  const replacement = rebuilt.join("\n");
  return {
    text: chars.slice(0, lineStart) + replacement + chars.slice(lineEnd),
    selectionStart: lineStart,
    selectionEnd: lineStart + replacement.length,
  };
}

function hasMarker(action, line) {
  const trimmed = line.replace(/^ +/, "");
  switch (action) {
    case "bulletList": return trimmed.startsWith("* ") || trimmed.startsWith("- ");
    case "subtext": return trimmed.startsWith("-# ");
    case "numberedList": return orderedMarker(trimmed) !== null;
    default: return false;
  }
}

/** Removes whichever block marker a line already carries, so switching a bullet to a number does
 *  not leave "1. * item". */
function stripLineMarkers(line) {
  const body = line.replace(/^ +/, "");
  if (body.startsWith("-# ")) return body.slice(3);
  if (body.startsWith("* ") || body.startsWith("- ")) return body.slice(2);
  const ordered = orderedMarker(body);
  if (ordered) return body.slice(ordered.consumed);
  return body;
}

function lineStartIndex(chars, index) {
  let i = Math.min(index, chars.length);
  while (i > 0 && chars[i - 1] !== "\n") i -= 1;
  return i;
}

function lineEndIndex(chars, index) {
  let i = Math.min(index, chars.length);
  while (i < chars.length && chars[i] !== "\n") i += 1;
  return i;
}

function applyLink(chars, start, end) {
  const selected = chars.slice(start, end);
  const label = selected.length ? selected : LINK_LABEL_PLACEHOLDER;
  const inserted = `[${label}](${LINK_TARGET_PLACEHOLDER})`;
  const text = chars.slice(0, start) + inserted + chars.slice(end);
  // Pre-select the part the user has to replace: the target when they highlighted their own
  // label, the label when they highlighted nothing.
  if (!selected.length) {
    return { text, selectionStart: start + 1, selectionEnd: start + 1 + label.length };
  }
  const targetStart = start + 1 + label.length + 2;
  return { text, selectionStart: targetStart, selectionEnd: targetStart + LINK_TARGET_PLACEHOLDER.length };
}
