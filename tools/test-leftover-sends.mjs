// Sends left pending by a run that ended (iOS fdb32549). Run: node tools/test-leftover-sends.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isLeftoverSend, undeliveredRowFor, settleLeftoverGroupRows } from "../ui/leftover-sends.js";

const RUN = 1_000_000;
const opts = { runStartedAt: RUN };
const row = (over = {}) => ({ direction: "outgoing", text: "hi", status: "pending", createdAt: RUN - 1000, ...over });

assert.equal(isLeftoverSend(row(), opts), true);
for (const status of ["building", "signing", "broadcasting"]) assert.equal(isLeftoverSend(row({ status }), opts), true, status);
assert.equal(isLeftoverSend(row({ createdAt: RUN + 1 }), opts), false, "this run's send is still being worked on");
assert.equal(isLeftoverSend(row({ txid: "t" }), opts), false, "a node has it");
assert.equal(isLeftoverSend(row({ status: "failed" }), opts), false);
assert.equal(isLeftoverSend(row({ status: "confirmed" }), opts), false);

const delivered = { direction: "outgoing", text: "hi", txid: "t", status: "confirmed", createdAt: RUN - 500 };
const older = row({ createdAt: RUN - 2000 });
const failed = row({ status: "failed", createdAt: RUN - 900 });
assert.equal(undeliveredRowFor([row({ text: "other" }), failed, older], delivered, opts), older, "the oldest with the same text");
assert.equal(undeliveredRowFor([row({ text: "other" })], delivered, opts), null);
assert.equal(undeliveredRowFor([row({ direction: "incoming" })], delivered, opts), null, "never someone else's");
assert.equal(undeliveredRowFor([row({ createdAt: RUN + 5 })], delivered, opts), null, "a send of this run isn't a leftover");
assert.equal(undeliveredRowFor([row({ status: "failed", createdAt: delivered.createdAt + 11 * 60 * 1000 })], delivered, opts), null, "typed again after that copy went out");
assert.equal(undeliveredRowFor([failed], { ...delivered, text: "" }, opts), null, "an empty body matches nothing");

const me = "kaspa:me";
const mine = (m) => m.senderAddress === me;
const groupRow = (over = {}) => ({ senderAddress: me, text: "yo", txId: null, status: "pending", createdAt: RUN - 1000, ...over });
const rows = [
  groupRow({ id: "kept-as-failed", text: "never went" }),
  groupRow({ id: "has-copy" }),
  groupRow({ id: "copy", txId: "t", status: "confirmed", createdAt: RUN - 900 }),
  groupRow({ id: "this-run", text: "now", createdAt: RUN + 5 }),
  groupRow({ id: "theirs", senderAddress: "kaspa:them" }),
];
assert.equal(settleLeftoverGroupRows(rows, { mine, runStartedAt: RUN }), 2);
assert.deepEqual(rows.map((m) => m.id), ["kept-as-failed", "copy", "this-run", "theirs"]);
assert.equal(rows[0].status, "failed");
assert.equal(rows[2].status, "pending", "still being sent");
assert.equal(settleLeftoverGroupRows(rows, { mine, runStartedAt: RUN }), 0, "once is enough");

// A chat's sync called these with no import once, and every test here still passed.
const app = readFileSync(new URL("../ui/app.js", import.meta.url), "utf8");
assert.match(app, /import \{ isLeftoverSend, undeliveredRowFor, settleLeftoverGroupRows \} from "\.\/leftover-sends\.js";/);
assert.match(app, /import \{[^}]*SEND_OUTCOME_UNKNOWN[^}]*\} from "\.\.\/engine\/transactions\.js";/);
assert.match(app, /sendsSettled\) persistState\(\)/, "a settled row is saved, or it's on Sending again after a reload");

console.log("leftover sends: ok");
