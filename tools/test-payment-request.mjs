// node tools/test-payment-request.mjs - payment request links (engine/payment-request.js, iOS
// PaymentRequest c6851d6 / 7c71a98): the link format, the signing string, sign + verify with a test
// key, and that a changed amount, address or memo is refused. Nothing leaves the machine.
import assert from "node:assert/strict";
import { schnorr } from "@noble/curves/secp256k1.js";
import {
  makePaymentRequest, paymentRequestSigningString, paymentRequestDigest, signPaymentRequest,
  verifyPaymentRequestSignature, parsePaymentRequest, parsePaymentRequestLink, paymentRequestLinkTail,
  paymentRequestUniversalLink, paymentRequestAppLink, paymentRequestAmountText, cleanPaymentMemo,
  clampMemoText, memoCharacters, isPaymentAddress, PAYMENT_REQUEST_MEMO_LIMIT,
} from "../engine/payment-request.js";
import { addressOf } from "../engine/kachat-names/registry-state.js";

let pass = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
// Test keys only: the maker's chatting key, and a second account's.
const MAKER_KEY = "0000000000000000000000000000000000000000000000000000000000000003";
const OTHER_KEY = "00000000000000000000000000000000000000000000000000000000000000c1";
const fromHex = (h) => Uint8Array.from(h.match(/../g), (b) => parseInt(b, 16));
const MAKER = addressOf(schnorr.getPublicKey(fromHex(MAKER_KEY)), "kaspa");
const OTHER = addressOf(schnorr.getPublicKey(fromHex(OTHER_KEY)), "kaspa");
const MAKER_TN = addressOf(schnorr.getPublicKey(fromHex(MAKER_KEY)), "kaspatest");

// MARK: the primitive is iOS's (libsecp256k1 schnorrsig with auxiliaryRand nil = 32 zero bytes)
test("BIP340 vector 0 (zero aux) signs byte-identically", () => {
  const sig = schnorr.sign(new Uint8Array(32), fromHex(MAKER_KEY), new Uint8Array(32));
  assert.equal(hex(sig).toUpperCase(), "E907831F80848D1069A5371B402410364BDF1C5F8307B0084C55F1CE2DCA821525F66A4A85EA8B71E482A74F382D2CE5EBEEE8FDB2172F477DF4900D310536C0");
});

// MARK: signing string
test("signing string: domain tag and fields, one per line, lowercased addresses", () => {
  const request = makePaymentRequest({ address: OTHER.toUpperCase().replace("KASPA:", "kaspa:"), amountSompi: 1_250_000_000n, memo: "Dinner & drinks", toChattingAddress: true });
  assert.equal(
    paymentRequestSigningString(request, MAKER.toUpperCase()),
    `kachat-payment-request:v1\n${OTHER}\n1250000000\nDinner & drinks\n1\n${MAKER}`,
  );
  const plain = makePaymentRequest({ address: OTHER, amountSompi: 1n, memo: "", toChattingAddress: false });
  assert.equal(paymentRequestSigningString(plain, MAKER), `kachat-payment-request:v1\n${OTHER}\n1\n\n0\n${MAKER}`);
  assert.equal(paymentRequestDigest(plain, MAKER).length, 32);
});

// MARK: build
test("link format: kaspa: dropped, exact amount, unreserved-only memo, chat, by + sig", () => {
  const unsigned = makePaymentRequest({ address: MAKER, amountSompi: 1_250_000_000n, memo: "Pizza & 2 drinks = 100% (ok)!", toChattingAddress: true });
  assert.equal(paymentRequestAmountText(unsigned), "12.5");
  assert.equal(
    paymentRequestLinkTail(unsigned),
    `${MAKER.slice(6)}?amount=12.5&memo=Pizza%20%26%202%20drinks%20%3D%20100%25%20%28ok%29%21&chat=1`,
  );
  const signed = signPaymentRequest(unsigned, MAKER, MAKER_KEY);
  assert.ok(signed && /^[0-9a-f]{128}$/.test(signed.signature));
  assert.equal(signed.creator, MAKER);
  const link = paymentRequestUniversalLink(signed);
  assert.equal(link, `https://kachat.app/pay/${MAKER.slice(6)}?amount=12.5&memo=Pizza%20%26%202%20drinks%20%3D%20100%25%20%28ok%29%21&chat=1&by=${MAKER.slice(6)}&sig=${signed.signature}`);
  assert.equal(paymentRequestAppLink(signed), link.replace("https://kachat.app/pay/", "kachat://pay/"));
  // KaPay's kapay:// and its old kachatwallet:// carry the same tail (KaPay d9bec97).
  for (const scheme of ["kapay", "kachatwallet", "KaPay"]) {
    const other = parsePaymentRequestLink(link.replace("https://kachat.app/pay/", `${scheme}://pay/`));
    assert.ok(other, `${scheme}:// is accepted`);
    assert.equal(other.amountSompi, signed.amountSompi);
  }
  assert.equal(parsePaymentRequestLink(link.replace("https://kachat.app/pay/", "kapayx://pay/")), null, "only those schemes");
  // deterministic, as iOS: the same request signs to the same bytes
  assert.equal(signPaymentRequest(unsigned, MAKER, MAKER_KEY).signature, signed.signature);
  assert.equal(paymentRequestAmountText(makePaymentRequest({ address: MAKER, amountSompi: 1n })), "0.00000001");
  assert.equal(paymentRequestAmountText(makePaymentRequest({ address: MAKER, amountSompi: 700_000_000n })), "7");
});
test("testnet keeps its kaspatest: prefix in the path and in by", () => {
  const signed = signPaymentRequest(makePaymentRequest({ address: MAKER_TN, amountSompi: 5n }), MAKER_TN, MAKER_KEY);
  assert.ok(paymentRequestLinkTail(signed).startsWith(`${MAKER_TN}?amount=0.00000005&by=${MAKER_TN}&sig=`));
  assert.deepEqual(parsePaymentRequestLink(paymentRequestUniversalLink(signed), { hrp: "kaspatest" }), signed);
  assert.equal(parsePaymentRequestLink(paymentRequestUniversalLink(signed), { hrp: "kaspa" }), null);
});

// MARK: round trip
test("sign + verify round trip through both link forms", () => {
  const request = signPaymentRequest(makePaymentRequest({ address: OTHER, amountSompi: 99_000_000n, memo: "Café ☕ für 2 👨‍👩‍👧", toChattingAddress: false }), MAKER, MAKER_KEY);
  assert.ok(verifyPaymentRequestSignature(request.signature, MAKER, request));
  for (const link of [paymentRequestUniversalLink(request), paymentRequestAppLink(request), paymentRequestUniversalLink(request).replace("https://kachat.app", "https://www.kachat.app")]) {
    assert.deepEqual(parsePaymentRequestLink(link), request, link);
  }
  // uppercase hex reads the same (iOS Data(hexString:) lowercases)
  assert.deepEqual(parsePaymentRequestLink(paymentRequestUniversalLink(request).replace(/sig=([0-9a-f]+)/, (_, s) => `sig=${s.toUpperCase()}`)), request);
});
test("unsigned links parse with no maker; one of by/sig alone is refused", () => {
  const unsigned = makePaymentRequest({ address: OTHER, amountSompi: 100_000_000n, memo: "rent" });
  const link = paymentRequestUniversalLink(unsigned);
  assert.equal(link, `https://kachat.app/pay/${OTHER.slice(6)}?amount=1&memo=rent`);
  const parsed = parsePaymentRequestLink(link);
  assert.equal(parsed.creator, null);
  assert.equal(parsed.signature, null);
  assert.equal(parsePaymentRequestLink(`${link}&by=${MAKER.slice(6)}`), null);
  assert.equal(parsePaymentRequestLink(`${link}&sig=${"ab".repeat(64)}`), null);
});

// MARK: tamper refusal
test("a changed amount, address, memo, chat flag or maker is refused", () => {
  const request = signPaymentRequest(makePaymentRequest({ address: OTHER, amountSompi: 1_250_000_000n, memo: "Dinner", toChattingAddress: true }), MAKER, MAKER_KEY);
  const link = paymentRequestUniversalLink(request);
  assert.ok(parsePaymentRequestLink(link));
  assert.equal(parsePaymentRequestLink(link.replace("amount=12.5", "amount=125")), null);
  assert.equal(parsePaymentRequestLink(link.replace(OTHER.slice(6), MAKER.slice(6))), null);
  assert.equal(parsePaymentRequestLink(link.replace("memo=Dinner", "memo=Dinner2")), null);
  assert.equal(parsePaymentRequestLink(link.replace("&chat=1", "")), null);
  assert.equal(parsePaymentRequestLink(link.replace(`by=${MAKER.slice(6)}`, `by=${OTHER.slice(6)}`)), null);
  const flipped = request.signature.slice(0, -1) + (request.signature.endsWith("0") ? "1" : "0");
  assert.equal(parsePaymentRequestLink(link.replace(request.signature, flipped)), null);
  // a valid signature by someone else over the same fields is not the named maker's
  const byOther = signPaymentRequest(makePaymentRequest(request), OTHER, OTHER_KEY);
  assert.equal(parsePaymentRequestLink(link.replace(request.signature, byOther.signature)), null);
  assert.equal(verifyPaymentRequestSignature(request.signature, MAKER, { ...request, amountSompi: 1_250_000_001n }), false);
});

// MARK: validation
test("addresses: checksum, network and length; amounts exact and positive", () => {
  assert.ok(isPaymentAddress(MAKER, "kaspa"));
  assert.equal(isPaymentAddress(MAKER, "kaspatest"), false);
  assert.equal(isPaymentAddress(MAKER.slice(0, -1) + (MAKER.endsWith("q") ? "p" : "q"), "kaspa"), false);
  const tail = OTHER.slice(6);
  assert.ok(parsePaymentRequest(tail, "amount=1"));
  assert.ok(parsePaymentRequest(`KASPA:${tail.toUpperCase()}`, "amount=1"));
  for (const amount of ["0", "0.0", "", "1,5", "-1", "1e3", "1.123456789", "+1", "１"]) {
    assert.equal(parsePaymentRequest(tail, `amount=${encodeURIComponent(amount)}`), null, amount);
  }
  assert.equal(parsePaymentRequest(tail, "memo=x"), null);
  assert.equal(parsePaymentRequest(tail, "amount"), null);
  assert.equal(parsePaymentRequest(tail, "AMOUNT=2").amountSompi, 200_000_000n);
  assert.equal(parsePaymentRequest(tail, "amount=.5").amountSompi, 50_000_000n);
  assert.equal(parsePaymentRequest(tail, "amount=1&memo=%zz"), null);
  assert.equal(parsePaymentRequestLink(`https://kachat.app/pay/${tail}/extra?amount=1`), null);
  assert.equal(parsePaymentRequestLink(`https://evil.example/pay/${tail}?amount=1`), null);
});
test("memo: control and direction marks out, trimmed, 140 characters, '+' stays '+'", () => {
  assert.equal(cleanPaymentMemo("  a‮b​c\u0007d﻿ \n"), "abcd");
  const long = "👍".repeat(200);
  assert.equal(memoCharacters(cleanPaymentMemo(long)).length, PAYMENT_REQUEST_MEMO_LIMIT);
  assert.equal(memoCharacters(clampMemoText("é".repeat(150))).length, 140);
  const parsed = parsePaymentRequest(OTHER.slice(6), "amount=1&memo=a+b%2Bc");
  assert.equal(parsed.memo, "a+b+c");
});

for (const [name, fn] of tests) {
  try { await fn(); pass++; }
  catch (error) { console.error(`FAIL ${name}\n  ${error?.message || error}`); process.exitCode = 1; }
}
console.log(`payment-request: ${pass}/${tests.length} passed`);
