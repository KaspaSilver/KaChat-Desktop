// KaPost iOS 071e901: only a tip from the chatting address names the post and counts on it
// (KAPOSTS_INDEXER.md 5.11). KaPost Settings > Tips From picks the default tip's address; the tip
// sheet opens on From, and from another address a tip goes privately, as a plain payment with the
// chat notice. Checked on ui/app.js's source, as the tip sheet needs the whole page to run.
// Run: node tools/test-kaposts-tips-from.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../ui/app.js", import.meta.url), "utf8");
/** The text of one top-level function, up to the next top-level declaration. */
function body(name) {
  const start = app.search(new RegExp(`^(async )?function ${name}\\(`, "m"));
  assert.ok(start >= 0, `${name} is in app.js`);
  const rest = app.slice(start + 1);
  const end = rest.search(/^(async function|function|const|let|\/\/ ---)/m);
  return app.slice(start, start + 1 + (end < 0 ? rest.length : end));
}
let passed = 0;
function test(name, fn) { fn(); passed += 1; console.log(`ok - ${name}`); }

test("Tips From is kept per account and falls back to the chatting address", () => {
  const read = body("kaPostsTipSourceIndex");
  assert.match(read, /kaPostsTipSources\?\.\[engine\.address/);
  assert.match(read, /deriveSpendingAddressAt\(index\) \? index : null/);
  const write = body("setKaPostsTipSourceIndex");
  assert.match(write, /delete sources\[address\]/, "the chatting address is stored as no entry");
});

test("the tip sheet opens on From, on Tips From's address, with no lock", () => {
  const open = body("openTipModal");
  assert.match(open, /const fundingIndex = kaPostsTipSourceIndex\(\)/);
  assert.match(open, /goTipStep\("from", \{ instant: true \}\)/);
  assert.match(open, /tipChoosingFrom = sheet\.fundingIndex != null/);
  assert.doesNotMatch(open, /setLocked/, "a post's tip can leave from any address");
  assert.doesNotMatch(app, /tip\.tip\) return; \/\/ a tip that names a post/, "Choose an Address works on a post's tip");
});

test("only a tip from the chatting address carries the post and counts", () => {
  assert.match(body("tipPayloadBytesFor"), /if \(tip\.fundingAddress\) return null;/, "another address sends no kchat:1:tip:");
  const send = body("sendTipNow");
  assert.match(send, /if \(!tip\.fundingAddress\) \{ try \{ tip\.onTipped\?\.\(\); \}/);
  assert.match(send, /if \(tip\.fundingAddress\) sendSpendingPaymentNotice\(/, "the chat still hears about it");
});

test("the instant tip follows Tips From and goes privately from another address", () => {
  const instant = body("sendInstantTip");
  assert.match(instant, /tip && sourceIndex == null \? await kaPostTipPayloadBytes/);
  assert.match(instant, /engine\.sendFromSpending\(/);
  assert.match(instant, /if \(sourceIndex != null\) sendSpendingPaymentNotice\(/);
  assert.match(instant, /sourceIndex != null \? " privately" : ""/);
  const call = app.slice(app.indexOf("tipUser: async"), app.indexOf("kaPostsCooldownEnabled,", app.indexOf("tipUser: async")));
  assert.match(call, /const countsOnPost = sourceIndex == null;/);
  assert.match(call, /sendInstantTip\(address, name, sompi \/ 1e8, countsOnPost \? tip : null, fiatText, sourceIndex\)/);
  assert.match(call, /if \(countsOnPost\) \{ try \{ onTipped\?\.\(\); \}/);
});

test("KaPost Settings has the Tips From page", () => {
  const settings = body("openKaPostsSettings");
  assert.match(settings, /data-kaposts-open-tips-from/);
  assert.match(settings, /data-kaposts-settings-page="tips-from"/);
  assert.match(settings, /setKaPostsTipSourceIndex\(index\)/);
});

console.log(`kaposts tips from: ${passed} passed`);
