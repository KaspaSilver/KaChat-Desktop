// Public-chat room names and the curated room lists, against iOS (PublicChatChannelName in
// KaChatTransactionBuilder.swift, PublicChatService.languageChannels). Run from the repo root:
//
//   node tools/test-broadcast-channels.mjs

import {
  LANGUAGE_BROADCAST_CHANNELS, normalizeBroadcastChannel, isValidBroadcastChannel,
  broadcastLanguageDisplayName, isServiceBroadcastChannel, parseBroadcastPayload,
} from "../engine/broadcasts.js";

const r = {
  pass: 0, fail: 0, failures: [],
  check(ok, label) { if (ok) this.pass++; else { this.fail++; this.failures.push(label); } },
  eq(a, b, label) { this.check(a === b, `${label}: got ${String(a)}, expected ${String(b)}`); },
};

// normalize = trimmed + lowercased, nothing else: a leading "#" is part of the name.
r.eq(normalizeBroadcastChannel("  Kaspa \n"), "kaspa", "trim + lowercase");
r.eq(normalizeBroadcastChannel("#kaspa"), "#kaspa", "a leading # is kept");
r.eq(normalizeBroadcastChannel(""), "", "empty");
r.eq(normalizeBroadcastChannel(null), "", "null");

// isValid: 1-36 characters, no whitespace, no colon.
r.check(isValidBroadcastChannel("kaspa"), "plain name is valid");
r.check(isValidBroadcastChannel("#kaspa"), "a # name is valid");
r.check(isValidBroadcastChannel("a".repeat(36)), "36 characters is valid");
r.check(!isValidBroadcastChannel("a".repeat(37)), "37 characters is not");
r.check(!isValidBroadcastChannel(""), "empty is not");
r.check(!isValidBroadcastChannel("two words"), "a space is not");
r.check(!isValidBroadcastChannel("a:b"), "a colon is not");
r.check(isValidBroadcastChannel("chess-arena") && isServiceBroadcastChannel("chess-arena"), "chess-arena is a valid service room");
r.check(isValidBroadcastChannel("chess-bots") && isServiceBroadcastChannel("chess-bots"), "chess-bots is a valid service room");
r.check(isServiceBroadcastChannel("  Chess-Bots "), "service rooms match after normalizing");
r.check(!isServiceBroadcastChannel("kaspa"), "a public room is not a service room");

// The language rooms in iOS order (alphabetical by display name, Latin scripts first).
const iosOrder = [
  "kaspa-indonesia", "kaspa-czech", "kaspa-german", "kaspa-espanol", "kaspa-francais",
  "kaspa-portugues", "kaspa-romania", "kaspa-slovak", "kaspa-russian", "kaspa-chinese",
  "kaspa-japanese", "kaspa-korean", "kaspa-hebrew",
];
r.eq(LANGUAGE_BROADCAST_CHANNELS.join(","), iosOrder.join(","), "language room order");
r.eq(broadcastLanguageDisplayName("kaspa-slovak"), "Slovenčina", "display name");

// Payload parsing keeps the on-chain name as written (lowercased), "#" included.
r.eq(parseBroadcastPayload("kchat:1:bcast:#Kaspa:hi")?.channel, "#kaspa", "payload room with #");
r.eq(parseBroadcastPayload("kchat:1:bcast:kaspa:hi:there")?.content, "hi:there", "content keeps colons");

if (r.fail) {
  console.error(`FAIL ${r.fail} of ${r.pass + r.fail}`);
  for (const failure of r.failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`ok ${r.pass} checks`);
