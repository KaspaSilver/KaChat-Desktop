// node tools/test-payment-notice.mjs - the payment_notice envelope (engine/payment-notice.js, iOS
// 927322b PaymentPoolCodec / handlePaymentNotice / verifyPaymentNotice): which envelopes are pool
// envelopes, which notices may be filed, the exact wire JSON, the bubble text and the chain check.
// Nothing leaves the machine.
import assert from "node:assert/strict";
import {
  parsePaymentPoolEnvelope, parsePaymentNotice, validPaymentNotice, encodePaymentNotice,
  paymentNoticeText, sompiPaidToAddress, clampPaymentNoticeMemo, PAYMENT_NOTICE_MAX_MEMO_LENGTH,
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

for (const [name, fn] of tests) {
  try { await fn(); pass++; }
  catch (error) { console.error(`FAIL ${name}\n  ${error?.message || error}`); process.exitCode = 1; }
}
console.log(`payment-notice: ${pass}/${tests.length} passed`);
