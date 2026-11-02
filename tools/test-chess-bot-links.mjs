// The links between KaPlay and KaPost (KaPlay ddec987 ChessBotLinks.swift, KaPost 9e22075
// KaPlayChallengeViews.swift, ONLINE_CHESS.md §7.2): the challenge link and the shared post against
// what iOS's URLComponents and string interpolation produce (run through Swift to get them), the
// link's checks (only the level has to be right, a bad value is dropped), the card's title, finding
// the link in a post, the banner. Test keys only; nothing leaves the machine. Run from the repo root:
//
//   node tools/test-chess-bot-links.mjs

import assert from "node:assert/strict";
import { schnorr } from "@noble/curves/secp256k1.js";
import {
  botChallengeUrl, botSharePostText, parseBotChallengeLink, botChallengeTitle, botChallengeIn,
  botChallengeBannerText, botChallengeFromLaunchSearch,
} from "../engine/chess-bot-links.js";
import { addressOf } from "../engine/kachat-names/registry-state.js";

const fromHex = (h) => Uint8Array.from(h.match(/../g), (b) => parseInt(b, 16));
const BY = addressOf(schnorr.getPublicKey(fromHex("0000000000000000000000000000000000000000000000000000000000000003")), "kaspa");
const GAME = "9d2c7a54-1f0e-4b8a-a3c1-6e5f4d3b2a10";

// --- The link and the post: iOS's bytes -------------------------------------------------------
// The address here is only text, as in the Swift run: the builder writes what it is given.
const SWIFT_ADDRESS = "kaspa:qpzry9x8gf2tvdw0s3jn54khce6mua7lqpzry9x8gf2tvdw0s3jn54khce6mua7l";
const swiftLink = `kachatchess://bot/1?name=Kaspa%20Silver&moves=14&by=${SWIFT_ADDRESS}&game=${GAME}`;
assert.equal(botChallengeUrl({ level: 1, botName: "Kaspa Silver", moves: 14, by: SWIFT_ADDRESS, gameId: GAME }), swiftLink, "URLComponents' bytes");
assert.equal(
  botSharePostText({ level: 1, botName: "Kaspa Silver", moves: 14, by: SWIFT_ADDRESS, gameId: GAME }),
  `I beat Kaspa Silver (Level 1) in 14 moves on KaPlay. Think you can do it in fewer?\n\n${swiftLink}`,
  "the post iOS writes",
);
// URLComponents on every character a query treats specially.
assert.equal(
  botChallengeUrl({ level: 2, botName: "a&b=c+d/e?f:g@h!i$j'k(l)m*n,o;p#q%r~s é \"t\"" }),
  `kachatchess://bot/2?name=a%26b%3Dc+d/e?f:g@h!i$j'k(l)m*n,o;p%23q%25r~s%20%C3%A9%20%22t%22`,
  "the link escapes what URLComponents escapes",
);

// --- Parsing ----------------------------------------------------------------------------------
const full = parseBotChallengeLink(`kachatchess://bot/3?name=Coderofstuff&moves=14&by=${BY}&game=${GAME}`);
assert.deepEqual(full, { level: 3, botName: "Coderofstuff", moves: 14, by: BY, game: GAME, url: `kachatchess://bot/3?name=Coderofstuff&moves=14&by=${BY}&game=${GAME}` });
assert.equal(parseBotChallengeLink("kachatchess://bot/3").url, "kachatchess://bot/3", "only the level is required");
assert.equal(parseBotChallengeLink("kachatchess://bot/3/").level, 3, "a trailing slash, as URL.pathComponents reads it");
assert.equal(parseBotChallengeLink("KACHATCHESS://BOT/5").level, 5, "scheme and host in any case");
for (const bad of ["kachatchess://bot/0", "kachatchess://bot/6", "kachatchess://bot/+3", "kachatchess://bot/x", "kachatchess://bot/", "kachatchess://bot", "kachatchess://bot/1/2", "kachatchess://game/3", "kachat://bot/3", "https://bot/3", "kachatchess://evil.example/bot/3", "", null, undefined]) {
  assert.equal(parseBotChallengeLink(bad), null, `not a challenge: ${bad}`);
}

// Each value on its own: a bad one is dropped, and it is gone from the rebuilt link too.
const one = (query) => parseBotChallengeLink(`kachatchess://bot/3?${query}`);
assert.equal(one("moves=+3").moves, null, "digits only: Int() alone takes +3");
assert.equal(one("moves=0").moves, null);
assert.equal(one("moves=9999").moves, 9999);
assert.equal(one("moves=10000").moves, null);
assert.equal(one("moves=abc").url, "kachatchess://bot/3");
assert.equal(one("by=kaspa:notanaddress").by, null, "a bad checksum");
assert.equal(one(`by=${BY.slice(0, -1)}q`).by, null, "a changed character");
assert.equal(one("by=kaspa:notanaddress").url, "kachatchess://bot/3");
assert.equal(one("game=../../etc").game, null, "the game id's charset");
assert.equal(one(`game=${"a".repeat(129)}`).game, null, "the game id's length");
assert.equal(one(`game=${"a".repeat(128)}`).game, "a".repeat(128));
assert.equal(one("name=Kaspa%20Silver%26%22").url, "kachatchess://bot/3?name=Kaspa%20Silver%26%22", "the rebuilt link keeps the escapes");
assert.equal(one("name=A+B").botName, "A+B", "a + stays a + (URLComponents.queryItems)");
assert.equal(one("name=A%20B").botName, "A B");
assert.equal(one("name").botName, null, "no value");
assert.equal(one("name=%20%20").botName, null, "only spaces");
assert.equal(one("name=%E2%80%AEevil%00%07").botName, "evil", "no direction or control marks");
assert.equal(one(`name=${"é".repeat(60)}`).botName.length, 40, "a name is cut at 40");
assert.equal(one("name=first&name=second").botName, "first", "the first item of a name");
assert.equal(one("name=%ZZ").botName, null, "a broken escape");

// --- The card's title -------------------------------------------------------------------------
assert.equal(botChallengeTitle(full), "Beat Coderofstuff (Level 3) in 14 moves");
assert.equal(botChallengeTitle(one("name=Izio&moves=1")), "Beat Izio (Level 3) in 1 move");
assert.equal(botChallengeTitle(one("name=Izio")), "Challenge: beat Izio (Level 3)");
assert.equal(botChallengeTitle(one("moves=9")), "Beat the Level 3 bot in 9 moves");
assert.equal(botChallengeTitle(parseBotChallengeLink("kachatchess://bot/2")), "Challenge: beat the Level 2 bot");

// --- A link in a post -------------------------------------------------------------------------
{
  const link = `kachatchess://bot/3?name=Coderofstuff&moves=14&by=${BY}&game=${GAME}`;
  const found = botChallengeIn(`I beat Coderofstuff (Level 3) in 14 moves on KaPlay. Think you can do it in fewer?\n\n${link}`);
  assert.equal(found.raw, link);
  assert.equal(found.challenge.level, 3);
  assert.equal(found.bodyText, "I beat Coderofstuff (Level 3) in 14 moves on KaPlay. Think you can do it in fewer?", "the link is left out of the text");
  assert.equal(botChallengeIn(link).bodyText, "", "a post that is only the link");
  assert.equal(botChallengeIn("try kachatchess://bot/3.").raw, "kachatchess://bot/3", "trailing prose punctuation is not the link");
  assert.equal(botChallengeIn("(kachatchess://bot/3?moves=9)!").raw, "kachatchess://bot/3?moves=9");
  assert.equal(botChallengeIn("kachatchess://bot/9 then kachatchess://bot/2").challenge.level, 2, "the first valid one");
  assert.equal(botChallengeIn("kachatchess://bot/2 and kachatchess://bot/2").bodyText, "and", "every copy leaves the text");
  assert.equal(botChallengeIn("KaChatChess://Bot/4 caps").challenge.level, 4);
  assert.equal(botChallengeIn("kachatchess://bot/9"), null, "an invalid level stays plain text");
  assert.equal(botChallengeIn("no links here"), null);
  assert.equal(botChallengeIn("https://kachat.app/post/abcdef0123456789"), null);
  assert.equal(botChallengeIn(""), null);
  assert.equal(botChallengeIn(null), null);
}

// --- The banner -------------------------------------------------------------------------------
const banner = (query, unlocked = true) => botChallengeBannerText({ challenge: one(query), botName: "Coderofstuff", who: "alice.kas", unlocked });
assert.equal(banner(`moves=14&by=${BY}`), "alice.kas beat Coderofstuff in 14 moves. Can you do it in fewer?");
assert.equal(banner("moves=14"), "Someone beat Coderofstuff in 14 moves. Can you do it in fewer?", "no valid by: Someone");
assert.equal(banner(`by=${BY}`), "alice.kas challenges you to beat Coderofstuff.");
assert.equal(banner("moves=1000"), "Someone challenges you to beat Coderofstuff.", "KaPlay's own limit on moves is 999");
assert.equal(banner("moves=999"), "Someone beat Coderofstuff in 999 moves. Can you do it in fewer?");
assert.equal(banner("", false), "Someone challenges you to beat Coderofstuff. Coderofstuff is still locked: climb the ladder to reach it.");

// --- Opened from the link ---------------------------------------------------------------------
assert.equal(botChallengeFromLaunchSearch(`?challenge=${encodeURIComponent(`kachatchess://bot/4?moves=9&by=${BY}`)}`).by, BY);
assert.equal(botChallengeFromLaunchSearch("?challenge=kachatchess://bot/4").level, 4);
assert.equal(botChallengeFromLaunchSearch("?challenge=kachat://pay/x"), null, "only a challenge");
assert.equal(botChallengeFromLaunchSearch("?migrate=1"), null);
assert.equal(botChallengeFromLaunchSearch(""), null);

console.log("ok chess bot links");
