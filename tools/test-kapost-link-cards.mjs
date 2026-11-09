// KaChat iOS a8a5807a and KaPost iOS 23920c8: a KaPost link in a chat or room is a card with the
// poster and the post's text, looked up with no reader key, and kaposts:// links count too.
// KaChat iOS 4f8e14bb: while a person's photos are held back, their link cards fetch nothing.
// Checked on the source, as the card needs the whole page to run.
// Run: node tools/test-kapost-link-cards.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const app = read("ui/app.js");
const kaposts = read("ui/kaposts.js");
const engine = read("engine/kaposts.js");
const format = read("ui/kaposts-format.js");
let passed = 0;
function test(name, fn) { fn(); passed += 1; console.log(`ok - ${name}`); }

// The snippet is a pure function: evaluated from the source, with its limit.
const start = kaposts.indexOf("export function kaPostLinkSnippet");
const end = kaposts.indexOf("/** The poster as the card names them", start);
assert.ok(start > 0 && end > start, "kaPostLinkSnippet is in kaposts.js");
const kaPostLinkSnippet = new Function("KAPOST_LINK_SNIPPET_MAX", `${kaposts.slice(start, end).replace("export ", "")}; return kaPostLinkSnippet;`)(300);

test("the snippet is one line with control and direction marks gone", () => {
  assert.equal(kaPostLinkSnippet("first\nsecond\r\nthird"), "first second third");
  assert.equal(kaPostLinkSnippet("a⁠b‮c​d﻿e"), "abcde");
  assert.equal(kaPostLinkSnippet("  ⁠ "), "");
});

test("the snippet stops at 300 characters without splitting an emoji", () => {
  assert.equal(kaPostLinkSnippet("x".repeat(300)), "x".repeat(300));
  assert.equal(kaPostLinkSnippet("x".repeat(301)), `${"x".repeat(300)}…`);
  const out = kaPostLinkSnippet("😀".repeat(301));
  assert.equal(Array.from(out).length, 301);
  assert.ok(out.endsWith("😀…"));
});

test("kaposts:// post links are found in text and parsed, only for posts", () => {
  for (const source of [app, format]) assert.match(source, /kaposts:\\\/\\\/kapost\\\/\[\^\\s<>"'\]\+/);
  assert.match(app, /text\.match\(\/\^kaposts:\\\/\\\/kapost\\\/\(\[\^\/\?#\]\+\)/);
});

test("the card's lookup sends a placeholder key and doesn't touch the feed's pool", () => {
  assert.equal(engine.match(/KAPOST_PLACEHOLDER_REQUESTER = `02\$\{"0"\.repeat\(64\)\}`/) != null, true);
  const lookup = kaposts.slice(kaposts.indexOf("async function kaPostLinkPost"), kaposts.indexOf("export function peekKaPostLinkPreview"));
  assert.match(lookup, /requesterPubkey: KAPOST_PLACEHOLDER_REQUESTER/);
  assert.doesNotMatch(lookup, /mergeIntoResolutionPool|indexerPost\(/);
  assert.match(lookup, /fetchChainPost\(id\)/, "a post the indexer hasn't got comes from the chain");
});

test("a post not found is asked again after five minutes", () => {
  assert.match(kaposts, /KAPOST_LINK_PREVIEW_RETRY_MS = 5 \* 60 \* 1000/);
  const resolve = kaposts.slice(kaposts.indexOf("export async function resolveKaPostLinkPreview"), kaposts.indexOf("export function openKaPostFromNotification"));
  assert.match(resolve, /Date\.now\(\) - missedAt < KAPOST_LINK_PREVIEW_RETRY_MS\) return null/);
});

test("the card and the chat list read as iOS's do", () => {
  assert.match(app, /entry\?\.authorName \|\| "A post on KaPost"/);
  assert.match(app, /"Tap to open it in KaPost\."/);
  assert.doesNotMatch(app, /Shared a KaPost post/);
  assert.equal(app.split('"Shared a KaPost"').length - 1, 2);
});

test("a held-back person's link card is the hidden photo tile", () => {
  assert.match(app, /const linkPhotoHeld = Boolean\(previewable\) && message\.direction === "incoming" && photosAreHidden\(photosUnlockAt\);/);
  assert.match(app, /: linkPhotoHeld \? buildHiddenPhotoTile\(peerName\)/);
});

console.log(`kapost link cards: ${passed} passed`);
