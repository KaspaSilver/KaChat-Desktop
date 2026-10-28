// node tools/test-kaposts-tip-and-pay-card.mjs - KaPost Settings' default tip in KAS or the app's
// currency (iOS 4c0d5a8), and the payment request link a post's card is drawn from (iOS 0b9fd28):
// ui/kaposts-format.js against the real link parser (engine/payment-request.js). Test keys only;
// nothing leaves the machine.
import assert from "node:assert/strict";
import { schnorr } from "@noble/curves/secp256k1.js";
import {
  kapostsFiatFieldText, kapostsKasFieldText, kapostsTipFieldAmount, kapostsSwitchTipText,
  kapostsDefaultTipSompi, kapostsPaymentRequestIn,
} from "../ui/kaposts-format.js";
import {
  makePaymentRequest, signPaymentRequest, parsePaymentRequestLink, paymentRequestUniversalLink, paymentRequestAppLink,
} from "../engine/payment-request.js";
import { addressOf } from "../engine/kachat-names/registry-state.js";

const fromHex = (h) => Uint8Array.from(h.match(/../g), (b) => parseInt(b, 16));
const MAKER_KEY = "0000000000000000000000000000000000000000000000000000000000000003";
const MAKER = addressOf(schnorr.getPublicKey(fromHex(MAKER_KEY)), "kaspa");

// MARK: the field's text in each unit
assert.equal(kapostsFiatFieldText(1), "1");
assert.equal(kapostsFiatFieldText(1.5), "1.5");
assert.equal(kapostsFiatFieldText(0.25), "0.25");
assert.equal(kapostsFiatFieldText(0.254), "0.25", "two decimals");
assert.equal(kapostsFiatFieldText(0), "");
assert.equal(kapostsKasFieldText(12.5), "12.5");
assert.equal(kapostsKasFieldText(0.00000001), "0.00000001");
assert.equal(kapostsKasFieldText(1 / 3), "0.33333333", "eight decimals");

assert.equal(kapostsTipFieldAmount("1.5"), 1.5);
assert.equal(kapostsTipFieldAmount("1,5"), 1.5, "the locale's comma");
assert.equal(kapostsTipFieldAmount(".5"), 0.5);
assert.equal(kapostsTipFieldAmount("0"), null);
assert.equal(kapostsTipFieldAmount(""), null);
assert.equal(kapostsTipFieldAmount("abc"), null);
assert.equal(kapostsTipFieldAmount("-1"), null);

// MARK: tapping the unit carries the amount over at today's price
assert.equal(kapostsSwitchTipText("10", true, 0.08), "0.8", "10 KAS at $0.08 is $0.80");
assert.equal(kapostsSwitchTipText("1", false, 0.08), "12.5", "$1 at $0.08 is 12.5 KAS");
assert.equal(kapostsSwitchTipText("1", true, null), "1", "no price: the number stays as typed");
assert.equal(kapostsSwitchTipText("", true, 0.08), "", "nothing typed: nothing to carry");

// MARK: what one tip sends
assert.equal(kapostsDefaultTipSompi(null, 0.08), null, "no default tip");
assert.equal(kapostsDefaultTipSompi({ sompi: 150_000_000 }, null), 150_000_000, "a KAS tip needs no price");
assert.equal(kapostsDefaultTipSompi({ fiat: 1, currency: "usd" }, 0.08), 1_250_000_000, "$1 at $0.08 = 12.5 KAS");
assert.equal(kapostsDefaultTipSompi({ fiat: 1, currency: "usd" }, 0.07), 1_428_571_429, "to the nearest sompi");
assert.equal(kapostsDefaultTipSompi({ fiat: 1, currency: "usd" }, null), null, "no price: nothing to send yet");
assert.equal(kapostsDefaultTipSompi({ fiat: 1, currency: "usd" }, 0), null);
assert.equal(kapostsDefaultTipSompi({ fiat: 1, currency: "usd", sompi: 5 }, 0.1), 1_000_000_000, "a currency tip wins");

// MARK: a payment request link in a post
const unsigned = makePaymentRequest({ address: MAKER, amountSompi: 1_250_000_000n, memo: "Coffee & cake" });
const signed = signPaymentRequest(unsigned, MAKER, MAKER_KEY);
const universal = paymentRequestUniversalLink(signed);
const app = paymentRequestAppLink(unsigned);

{
  const found = kapostsPaymentRequestIn(`Chip in for the party: ${universal}`, parsePaymentRequestLink);
  assert.ok(found, "a signed kachat.app link");
  assert.equal(found.raw, universal);
  assert.equal(found.bodyText, "Chip in for the party:", "the link leaves the text");
  assert.equal(found.request.amountSompi, 1_250_000_000n);
  assert.equal(found.request.memo, "Coffee & cake");
  assert.equal(found.request.creator, MAKER, "the signer");
}
{
  const found = kapostsPaymentRequestIn(`${app}.`, parsePaymentRequestLink);
  assert.ok(found, "a kachat:// link with prose punctuation after it");
  assert.equal(found.raw, app);
  assert.equal(found.bodyText, ".");
  assert.equal(found.request.creator, null, "unsigned");
}
{
  const found = kapostsPaymentRequestIn(universal, parsePaymentRequestLink);
  assert.equal(found.bodyText, "", "a post that is only the link has no text left");
}
assert.equal(kapostsPaymentRequestIn("no links here", parsePaymentRequestLink), null);
assert.equal(kapostsPaymentRequestIn("https://kachat.app/post/abcdef0123456789", parsePaymentRequestLink), null, "a post link is not a payment request");
assert.equal(kapostsPaymentRequestIn(`https://kachat.app/post/abcdef0123456789 then ${universal}`, parsePaymentRequestLink), null,
  "only the first KaChat link counts (iOS KaChatInternalLink.match)");
assert.equal(kapostsPaymentRequestIn(universal.replace("amount=12.5", "amount=99"), parsePaymentRequestLink), null, "a changed amount fails its signature");
assert.equal(kapostsPaymentRequestIn(`https://kachat.app/pay/${MAKER.slice(6)}?amount=0`, parsePaymentRequestLink), null, "no amount");
assert.equal(kapostsPaymentRequestIn(universal, null), null, "no parser, no card");

console.log("kaposts tip and pay card: ok");
