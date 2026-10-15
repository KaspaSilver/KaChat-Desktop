// node tools/test-payment-notice.mjs - the payment_notice envelope (engine/payment-notice.js, iOS
// 927322b PaymentPoolCodec / handlePaymentNotice / verifyPaymentNotice): which envelopes are pool
// envelopes, which notices may be filed, the exact wire JSON, the bubble text and the chain check.
// Nothing leaves the machine.
import assert from "node:assert/strict";
import {
  parsePaymentPoolEnvelope, parsePaymentNotice, validPaymentNotice, encodePaymentNotice,
  paymentNoticeText, sompiPaidToAddress, clampPaymentNoticeMemo, PAYMENT_NOTICE_MAX_MEMO_LENGTH,
  paymentNoticePlacement, checkPaymentNoticeTx,
} from "../engine/payment-notice.js";

let pass = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const TX = "A1B2".repeat(16);
const ME = "kaspa:qqmeexampleaddress0000000000000000000000000000000000000000";
const THEM = "kaspa:qqthemexampleaddress00000000000000000000000000000000000000";

test("pool envelopes are recognised; anything else falls through", () => {
  assert.deepEqual(parsePaymentPoolEnvelope('{"type":"addr_pool","addresses":["a"]}'), { kind: "pool" });
  assert.deepEqual(parsePaymentPoolEnvelope('{"type":"addr_pool_request"}'), { kind: "request" });
  assert.equal(parsePaymentPoolEnvelope('{"type":"addr_pool"}'), null);
  assert.equal(parsePaymentPoolEnvelope('{"type":"reaction","targetTxId":"x"}'), null);
  assert.equal(parsePaymentPoolEnvelope("hello"), null);
  assert.equal(parsePaymentPoolEnvelope("{not json"), null);
  assert.equal(parsePaymentPoolEnvelope(""), null);
});

test("a notice parses with an exact BigInt amount and an optional memo", () => {
  const notice = parsePaymentNotice(`{"type":"payment_notice","txId":"${TX}","amountSompi":123450000,"address":"${ME}","memo":"rent"}`);
  assert.equal(notice.txId, TX);
  assert.equal(notice.amountSompi, 123450000n);
  assert.equal(notice.address, ME);
  assert.equal(notice.memo, "rent");
  assert.equal(parsePaymentNotice(`{"type":"payment_notice","txId":"${TX}","amountSompi":1,"address":"${ME}"}`).memo, "");
});

test("a notice of the wrong shape is not a notice (Codable would not decode it)", () => {
  assert.equal(parsePaymentNotice(`{"type":"payment_notice","txId":"${TX}","amountSompi":"5","address":"${ME}"}`), null);
  assert.equal(parsePaymentNotice(`{"type":"payment_notice","txId":"${TX}","amountSompi":-5,"address":"${ME}"}`), null);
  assert.equal(parsePaymentNotice(`{"type":"payment_notice","txId":"${TX}","amountSompi":1.5,"address":"${ME}"}`), null);
  assert.equal(parsePaymentNotice(`{"type":"payment_notice","amountSompi":5,"address":"${ME}"}`), null);
  assert.equal(parsePaymentNotice(`{"type":"payment_notice","txId":"${TX}","amountSompi":5,"address":"${ME}","memo":7}`), null);
});

test("validation: 64 hex, amount above zero, the address paid must be the given one", () => {
  const ok = validPaymentNotice({ txId: ` ${TX} `, amountSompi: 5n, address: ME.toUpperCase(), memo: "  hi  " }, ME);
  assert.deepEqual(ok, { txId: TX.toLowerCase(), amountSompi: 5n, address: ME.toUpperCase(), memo: "hi" });
  assert.equal(validPaymentNotice({ txId: TX, amountSompi: 0n, address: ME }, ME), null);
  assert.equal(validPaymentNotice({ txId: "abc", amountSompi: 5n, address: ME }, ME), null);
  assert.equal(validPaymentNotice({ txId: "g".repeat(64), amountSompi: 5n, address: ME }, ME), null);
  // An old app's pool payment names a former pool address, not the chatting address (XP-023).
  assert.equal(validPaymentNotice({ txId: TX, amountSompi: 5n, address: THEM }, ME), null);
  assert.equal(validPaymentNotice({ txId: TX, amountSompi: 5n, address: ME }, ""), null);
  assert.equal(validPaymentNotice(null, ME), null);
});

test("encode: the iOS wire shape, txId lowercased, memo trimmed and omitted when empty", () => {
  assert.equal(
    encodePaymentNotice({ txId: TX, amountSompi: 123450000n, address: THEM, memo: "  rent  " }),
    `{"type":"payment_notice","txId":"${TX.toLowerCase()}","amountSompi":123450000,"address":"${THEM}","memo":"rent"}`,
  );
  assert.equal(
    encodePaymentNotice({ txId: TX, amountSompi: 1n, address: THEM, memo: "   " }),
    `{"type":"payment_notice","txId":"${TX.toLowerCase()}","amountSompi":1,"address":"${THEM}"}`,
  );
  // Exact past 2^53: no float in the way.
  assert.match(encodePaymentNotice({ txId: TX, amountSompi: 2_870_000_000_000_000_000n, address: THEM }), /"amountSompi":2870000000000000000,/);
  assert.equal(encodePaymentNotice({ txId: TX, amountSompi: 0n, address: THEM }), "");
  assert.equal(encodePaymentNotice({ txId: "", amountSompi: 1n, address: THEM }), "");
  // Round trip.
  const wire = encodePaymentNotice({ txId: TX, amountSompi: 42n, address: ME, memo: "a \"quoted\" note" });
  assert.deepEqual(validPaymentNotice(parsePaymentNotice(wire), ME), { txId: TX.toLowerCase(), amountSompi: 42n, address: ME, memo: "a \"quoted\" note" });
});

test("memo clamp: at most 500 characters, counted as characters", () => {
  assert.equal(PAYMENT_NOTICE_MAX_MEMO_LENGTH, 500);
  const long = clampPaymentNoticeMemo("👍🏽".repeat(600));
  assert.equal([...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(long)].length, 500);
  assert.equal(clampPaymentNoticeMemo("  x  "), "x");
});

test("bubble text is the payment template the card reads", () => {
  assert.equal(paymentNoticeText({ amountKas: "1.2345", unit: "KAS" }), "Received 1.2345 KAS");
  assert.equal(paymentNoticeText({ amountKas: "1.2345", unit: "TKAS", memo: "rent", outgoing: true }), "Sent 1.2345 TKAS — rent");
});

test("chain check: sums only the outputs paying the address", () => {
  const tx = { outputs: [
    { script_public_key_address: ME, amount: 100 },
    { script_public_key_address: THEM, amount: 7 },
    { scriptPublicKeyAddress: ME.toUpperCase(), amount: "50" },
    { script_public_key_address: ME, amount: "junk" },
  ] };
  assert.equal(sompiPaidToAddress(tx, ME), 150n);
  assert.equal(sompiPaidToAddress(tx, "kaspa:nobody"), 0n);
  assert.equal(sompiPaidToAddress({}, ME), 0n);
});

test("IOS-083: a notice only files a new payment or moves a received plain payment out of the self-chat", () => {
  const selfPay = { chat: "self", direction: "incoming", messageType: "payment" };
  assert.equal(paymentNoticePlacement([], "incoming"), "file");
  assert.equal(paymentNoticePlacement(undefined, "outgoing"), "file");
  assert.equal(paymentNoticePlacement([selfPay], "incoming"), "move");
  // our own notice read back never takes a row from the self-chat
  assert.equal(paymentNoticePlacement([selfPay], "outgoing"), "drop");
  // another contact's payment, or a message we sent someone else, is never taken
  assert.equal(paymentNoticePlacement([{ chat: "other", direction: "incoming", messageType: "payment" }], "incoming"), "drop");
  assert.equal(paymentNoticePlacement([{ chat: "other", direction: "outgoing", messageType: "text" }], "incoming"), "drop");
  assert.equal(paymentNoticePlacement([selfPay, { chat: "other", direction: "incoming", messageType: "payment" }], "incoming"), "drop");
  // already here (either direction): nothing to do, never refiled the other way round
  assert.equal(paymentNoticePlacement([{ chat: "this", direction: "incoming", messageType: "payment" }], "incoming"), "drop");
  assert.equal(paymentNoticePlacement([{ chat: "this", direction: "outgoing", messageType: "text" }], "incoming"), "drop");
  // only received plain payments move out of the self-chat
  assert.equal(paymentNoticePlacement([{ chat: "self", direction: "outgoing", messageType: "payment" }], "incoming"), "drop");
  assert.equal(paymentNoticePlacement([{ chat: "self", direction: "incoming", messageType: "text" }], "incoming"), "drop");
});

test("IOS-083: the chain check wants the exact amount, no payload and no input of ours or another contact's", () => {
  const OTHER = "kaspa:qqothercontact000000000000000000000000000000000000000000000";
  const SPEND = "kaspa:qqspendingaddress00000000000000000000000000000000000000000";
  const tx = (extra = {}) => ({ outputs: [{ script_public_key_address: ME, amount: 500 }, { script_public_key_address: SPEND, amount: 9 }], inputs: [{ previous_outpoint_address: SPEND }], ...extra });
  const args = { paidAddress: ME, claimedSompi: 500n, foreignAddresses: [ME, OTHER] };
  assert.deepEqual(checkPaymentNoticeTx(tx(), args), { ok: true });
  assert.equal(checkPaymentNoticeTx(tx(), { ...args, claimedSompi: 400n }).ok, false);
  assert.equal(checkPaymentNoticeTx({ outputs: [], inputs: [] }, args).ok, false);
  assert.equal(checkPaymentNoticeTx(tx({ payload: "6b636861743a313a" }), args).ok, false);
  assert.equal(checkPaymentNoticeTx(tx({ payload: "" }), args).ok, true);
  assert.equal(checkPaymentNoticeTx(tx({ inputs: [{ previous_outpoint_address: OTHER.toUpperCase() }] }), args).ok, false);
  assert.equal(checkPaymentNoticeTx(tx({ inputs: [{ previousOutpointAddress: ME }] }), args).ok, false);
  assert.equal(checkPaymentNoticeTx(tx(), { ...args, claimedSompi: "junk" }).ok, false);
});

for (const [name, fn] of tests) {
  try { await fn(); pass++; }
  catch (error) { console.error(`FAIL ${name}\n  ${error?.message || error}`); process.exitCode = 1; }
}
console.log(`payment-notice: ${pass}/${tests.length} passed`);
