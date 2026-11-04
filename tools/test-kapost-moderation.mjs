// node tools/test-kapost-moderation.mjs - KaPost's moderation (KaPosts-iPhone 9e22075,
// ui/kapost-moderation.js): the report's email and text, reporting with no mail app, the block's
// bookkeeping, whose messages a room leaves out, and agreeing to the Terms of Use.
//
// When the KaPosts-iPhone checkout is around (KAPOSTS_IPHONE_DIR, or beside this repo), the Terms'
// text, version and storage key are also read out of TermsOfUseView.swift and compared with ours,
// and the report address out of ContentReport.swift, so a change on either side fails here.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  SUPPORT_EMAIL, reportMailUrl, postReportBody, roomMessageReportBody, sendContentReport,
  withBlockedAccount, roomHiddenSenders, KAPOST_TERMS_VERSION, KAPOST_TERMS_ACCEPTED_KEY,
  KAPOST_TERMS_SECTIONS, kaPostTermsAccepted, acceptKaPostTerms, kaPostTermsHtml,
} from "../ui/kapost-moderation.js";

const here = path.dirname(fileURLToPath(import.meta.url));
let pass = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const memoryStorage = () => {
  const map = new Map();
  return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)) };
};

test("the report email goes to support, with its subject and body encoded", () => {
  const url = reportMailUrl("line one\nline & two");
  assert.equal(SUPPORT_EMAIL, "kaspasilver@gmail.com");
  assert.equal(url, "mailto:kaspasilver@gmail.com?subject=KaPost%20report&body=line%20one%0Aline%20%26%20two");
});

test("a post's report: id, author, the text's first 500, what is wrong", () => {
  const body = postReportBody({ remoteId: "tx1", posterAddress: "kaspa:qa", text: "x".repeat(600) });
  assert.equal(body, `I want to report this post.\n\nPost: tx1\nAuthor: kaspa:qa\nText: ${"x".repeat(500)}\n\nWhat is wrong with it:\n`);
  assert.match(postReportBody({ posterAddress: "kaspa:qa", text: "" }), /Post: not yet on chain/);
});

test("a room message's report: room, id, sender, the text's first 500", () => {
  const body = roomMessageReportBody({ channel: "kaspa", txId: "tx2", senderAddress: "kaspa:qb", text: "y".repeat(600) });
  assert.equal(body, `I want to report this public chat message.\n\nRoom: #kaspa\nMessage: tx2\nSender: kaspa:qb\nText: ${"y".repeat(500)}\n\nWhat is wrong with it:\n`);
});

test("reporting copies the report, opens the email, and says where to send it", async () => {
  const opened = [];
  let copied = null;
  let asked = null;
  const ok = await sendContentReport("the report", {
    copyText: (text) => { copied = text; return Promise.resolve(); },
    confirm: (options) => { asked = options; return Promise.resolve(false); },
    openUrl: (url) => opened.push(url),
  });
  assert.equal(ok, true);
  assert.equal(copied, "the report");
  assert.deepEqual(opened, [reportMailUrl("the report")]);
  assert.equal(asked.title, "Report Copied");
  assert.equal(asked.confirmLabel, "Open Email");
  assert.equal(asked.cancelLabel, "OK");
  assert.ok(asked.message.includes(SUPPORT_EMAIL));
});

test("Open Email on the alert opens it again, for another mail app", async () => {
  const opened = [];
  await sendContentReport("r", { copyText: async () => {}, confirm: async () => true, openUrl: (url) => opened.push(url) });
  assert.equal(opened.length, 2);
});

test("with the clipboard refused, the report's text is on the alert, so it is never lost", async () => {
  for (const copyText of [async () => { throw new Error("blocked"); }, () => { throw new Error("blocked"); }]) {
    let asked = null;
    const ok = await sendContentReport("the report", { copyText, confirm: async (options) => { asked = options; return null; }, openUrl: () => {} });
    assert.equal(ok, false);
    assert.equal(asked.title, "Report");
    assert.ok(asked.message.includes(SUPPORT_EMAIL) && asked.message.includes("the report"));
  }
});

test("a block supersedes a mute, and blocks once", () => {
  const prefs = { following: ["kaspa:qf"], muted: ["kaspa:qa", "kaspa:qm"], blocked: ["kaspa:qx"] };
  const next = withBlockedAccount(withBlockedAccount(prefs, "kaspa:qa"), "kaspa:qa");
  assert.deepEqual(next.blocked, ["kaspa:qx", "kaspa:qa"]);
  assert.deepEqual(next.muted, ["kaspa:qm"]);
  assert.deepEqual(next.following, ["kaspa:qf"]);
  assert.deepEqual(prefs.blocked, ["kaspa:qx"]); // the old one is left as it was
});

test("a room leaves out its own hides plus blocked accounts", () => {
  assert.deepEqual([...roomHiddenSenders(["kaspa:qa"], ["kaspa:qb", "kaspa:qa"])].sort(), ["kaspa:qa", "kaspa:qb"]);
  assert.equal(roomHiddenSenders(undefined, undefined).size, 0);
});

test("the Terms: not agreed, agreed, asked again when the version moves", () => {
  const storage = memoryStorage();
  assert.equal(kaPostTermsAccepted(storage), false);
  acceptKaPostTerms(storage);
  assert.equal(kaPostTermsAccepted(storage), true);
  assert.equal(storage.getItem(KAPOST_TERMS_ACCEPTED_KEY), String(KAPOST_TERMS_VERSION));
  storage.setItem(KAPOST_TERMS_ACCEPTED_KEY, String(KAPOST_TERMS_VERSION - 1));
  assert.equal(kaPostTermsAccepted(storage), false);
  assert.equal(kaPostTermsAccepted({ getItem() { throw new Error("no storage"); } }), false);
});

test("the Terms' page shows every section", () => {
  const html = kaPostTermsHtml();
  for (const section of KAPOST_TERMS_SECTIONS) {
    assert.ok(html.includes(section.title));
    assert.ok(html.includes(section.text));
  }
  assert.ok(html.includes(`Questions and reports: ${SUPPORT_EMAIL}`));
});

const iosDir = [process.env.KAPOSTS_IPHONE_DIR, path.resolve(here, "../../../Everything KaChat iPhone/KaPosts-iPhone")].find((dir) => dir && existsSync(dir));
if (iosDir) {
  test("the Terms and the report address match KaPosts-iPhone's source", () => {
    const terms = readFileSync(path.join(iosDir, "KaPosts/Views/Onboarding/TermsOfUseView.swift"), "utf8");
    assert.equal(Number(terms.match(/currentVersion = (\d+)/)[1]), KAPOST_TERMS_VERSION);
    assert.equal(terms.match(/acceptedVersionKey = "([^"]+)"/)[1], KAPOST_TERMS_ACCEPTED_KEY);
    // iOS's "not Apple" is App Store wording, which a web app has no reason to carry. "12 or 24 words"
    // is KaChat's wording (iOS bfe9f022), which KaPosts-iPhone hasn't taken up yet.
    const pairs = [...terms.matchAll(/\(\s*"([^"]+)",\s*"([^"]+)"\s*\)/g)].map((m) => ({ title: m[1], text: m[2].replace(", not Apple.", ".").replace("\\(ContentReport.supportEmail)", SUPPORT_EMAIL).replace("Your account is a seed phrase kept on your device. We never have it, so we can't recover a lost one", "Your account is 12 or 24 words kept on your device. We never have them, so we can't recover lost ones") }));
    assert.deepEqual(pairs, KAPOST_TERMS_SECTIONS);
    const report = readFileSync(path.join(iosDir, "KaPosts/Views/Shared/ContentReport.swift"), "utf8");
    assert.equal(report.match(/supportEmail = "([^"]+)"/)[1], SUPPORT_EMAIL);
  });
}

for (const [name, fn] of tests) {
  try {
    await fn();
    pass += 1;
  } catch (error) {
    console.error(`FAIL ${name}\n`, error);
    process.exitCode = 1;
  }
}
console.log(`test-kapost-moderation: ${pass}/${tests.length} passed${iosDir ? "" : " (KaPosts-iPhone not found: iOS text not compared)"}`);
