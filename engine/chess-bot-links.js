// The links between KaPlay and KaPost (KaPlay ddec987 ChessBotLinks.swift, ONLINE_CHESS.md §7.2;
// KaPost 9e22075 KaPlayChallengeViews.swift): the post a stamped win shares, and the challenge
// link at the end of it,
//
//   kachatchess://bot/<level>?name=<bot name>&moves=<n>&by=<address>&game=<game id>
//
// `level` is 1 to 5 and is what makes it a challenge; a link without a valid one is not a link.
// Everything else is optional and attacker-controlled like any link in a post, so each value is
// checked and a bad one dropped, and `url` is rebuilt from what passed. Pure and UI-free; the tests
// run it under node (tools/test-chess-bot-links.mjs).

import { isPaymentAddress } from "./payment-request.js";

export const BOT_CHALLENGE_SCHEME = "kachatchess";
const NAME_LIMIT = 40;
/** The moves a post's card shows (iOS KaPlayBotChallenge) and the ones KaPlay's banner repeats
 *  (iOS ChessBotLinks.challenge). */
const CARD_MOVES_MAX = 9_999;
const BANNER_MOVES_MAX = 999;

/** A value as iOS's URLQueryItem writes it: the same bytes, so a link is one link on every app. */
function queryValue(value) {
  return encodeURIComponent(String(value)).replace(/%(?:2B|2F|3F|3A|40|24|2C|3B)/g, (hex) => decodeURIComponent(hex));
}

function buildChallengeUrl(level, items) {
  const query = items.filter(([, value]) => value != null).map(([name, value]) => `${name}=${queryValue(value)}`).join("&");
  return `${BOT_CHALLENGE_SCHEME}://bot/${level}${query ? `?${query}` : ""}`;
}

/** iOS ChessBotLinks.challengeURL. */
export function botChallengeUrl({ level, botName, moves, by, gameId }) {
  return buildChallengeUrl(level, [["name", botName], ["moves", moves], ["by", by], ["game", gameId]]);
}

/** The post a stamped win shares (iOS ChessBotLinks.shareToKaPost). The player still taps Post. */
export function botSharePostText({ level, botName, moves, by, gameId }) {
  const link = botChallengeUrl({ level, botName, moves, by, gameId });
  return `I beat ${botName} (Level ${level}) in ${moves} moves on KaPlay. Think you can do it in fewer?\n\n${link}`;
}

/** No control or direction marks, which could make the card read as something else. */
function cleanName(raw) {
  const text = String(raw).replace(/[\p{Cc}\p{Cf}]/gu, "").trim();
  // Characters as a person counts them, as Swift's `prefix` does.
  if (typeof Intl !== "undefined" && Intl.Segmenter) {
    const graphemes = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)];
    return graphemes.slice(0, NAME_LIMIT).map((g) => g.segment).join("");
  }
  return Array.from(text).slice(0, NAME_LIMIT).join("");
}

/** The items of a query, as URLComponents.queryItems reads them: percent escapes decoded, a `+`
 *  left a `+`, and an item with no `=` has no value. */
function queryItems(query) {
  if (!query) return [];
  const items = [];
  for (const part of query.split("&")) {
    const at = part.indexOf("=");
    const name = at < 0 ? part : part.slice(0, at);
    let value = at < 0 ? null : part.slice(at + 1);
    try { value = value == null ? null : decodeURIComponent(value); } catch { value = null; }
    items.push([name, value]);
  }
  return items;
}

/** A challenge link as `{ level, botName, moves, by, game, url }` - null when it is not one. */
export function parseBotChallengeLink(raw) {
  const match = String(raw ?? "").trim().match(/^kachatchess:\/\/bot\/+(\d+)\/*(?:\?([^#]*))?(?:#.*)?$/i);
  if (!match) return null;
  const level = Number(match[1]);
  if (!Number.isInteger(level) || level < 1 || level > 5) return null;
  const items = queryItems(match[2]);
  const value = (name) => items.find(([key]) => key === name)?.[1] ?? null;

  const name = value("name") == null ? "" : cleanName(value("name"));
  const botName = name || null;
  const rawMoves = value("moves");
  const moves = rawMoves != null && /^\d+$/.test(rawMoves) && Number(rawMoves) >= 1 && Number(rawMoves) <= CARD_MOVES_MAX ? Number(rawMoves) : null;
  const rawBy = value("by");
  const by = rawBy != null && (isPaymentAddress(rawBy, "kaspa") || isPaymentAddress(rawBy, "kaspatest")) ? rawBy : null;
  const rawGame = value("game");
  const game = rawGame != null && /^[A-Za-z0-9_-]{1,128}$/.test(rawGame) ? rawGame : null;

  return { level, botName, moves, by, game, url: buildChallengeUrl(level, [["name", botName], ["moves", moves], ["by", by], ["game", game]]) };
}

/** A post's card: "Beat Coderofstuff (Level 3) in 14 moves", or "Challenge: beat Coderofstuff
 *  (Level 3)" without a move count. */
export function botChallengeTitle(challenge) {
  const bot = challenge.botName ? `${challenge.botName} (Level ${challenge.level})` : `the Level ${challenge.level} bot`;
  if (challenge.moves == null) return `Challenge: beat ${bot}`;
  return `Beat ${bot} in ${challenge.moves} ${challenge.moves === 1 ? "move" : "moves"}`;
}

/** The first valid challenge in a post's text (iOS KaPlayBotChallenge.match), as
 *  `{ challenge, raw, bodyText }` - `bodyText` is the post without the link, which the card under
 *  it stands for - or null. Trailing prose punctuation is not part of the link. */
export function botChallengeIn(text) {
  const value = String(text ?? "");
  if (!value.toLowerCase().includes("kachatchess://")) return null;
  for (const match of value.matchAll(/kachatchess:\/\/bot\/[^\s<>"']+/gi)) {
    const raw = match[0].replace(/[.,;:!?)\]}'"]+$/, "");
    const challenge = parseBotChallengeLink(raw);
    if (challenge) return { challenge, raw, bodyText: value.split(raw).join("").trim() };
  }
  return null;
}

/** What a challenge asks, at the top of the screen it opened (iOS ChessBotChallengeBanner). `who`
 *  is the display name of the address that won. A move count past iOS's 999 is left out. */
export function botChallengeBannerText({ challenge, botName, who, unlocked }) {
  const person = challenge.by ? who : "Someone";
  const moves = challenge.moves != null && challenge.moves <= BANNER_MOVES_MAX ? challenge.moves : null;
  const claim = moves != null
    ? `${person} beat ${botName} in ${moves} moves. Can you do it in fewer?`
    : `${person} challenges you to beat ${botName}.`;
  return unlocked ? claim : `${claim} ${botName} is still locked: climb the ladder to reach it.`;
}

/** Desktop opened from a challenge: `?challenge=<the link>`. A web page can't be registered for
 *  `kachatchess://` itself, so this is the form that reaches it. */
export function botChallengeFromLaunchSearch(search) {
  try { return parseBotChallengeLink(new URLSearchParams(search).get("challenge")); } catch { return null; }
}
