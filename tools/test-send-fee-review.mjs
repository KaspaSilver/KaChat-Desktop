// The send screens' side of the iOS fee and coin fixes (KaChat d23e6f7a, KaPay 1652437, KaPlay
// 4922804, KaPost 33095ac): a fee that can't be worked out turns the swipe off with Try Again, a
// send rebuilt at the swipe that would pay more than the Review sends nothing and the Review works
// its fee out again, Max says when it is capped at one transaction's coins, Coin Control greys out
// coins a send can't spend and Available / Compound count only those, a pasted payment request
// fills the screen only when the paste is the link, every submit holds its coins (Cold Storage
// too), and a handshake whose outcome is unknown is "Not confirmed" with no Retry. The engine side
// is in tools/test-amounts.mjs. Run: node tools/test-send-fee-review.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const app = read("../ui/app.js");
const between = (text, from, to) => {
  const start = text.indexOf(from);
  assert.ok(start >= 0, `missing: ${from}`);
  return text.slice(start, text.indexOf(to, start + from.length));
};

// --- Send Kaspa: the fee ---------------------------------------------------------------------
const estimate = between(app, "async function estimateSendKaspaBaseFee", "function stopSendKaspaFeeEstimate");
assert.match(estimate, /catch \(error\) \{ base = null; failure = userFacingError\(error\) \|\| ""; \}/);
assert.match(estimate, /setSendKaspaFeeError\(base == null \? \(failure \|\| SEND_FEE_UNKNOWN_TEXT\) : ""\);/, "no fee: why, with Try Again");
assert.match(estimate, /function setSendKaspaFeeError\(message\) \{[\s\S]{0,600}data-send-kaspa-fee-retry>Try Again<\/button>[\s\S]{0,400}setSendKaspaFeeError\(""\);\s*scheduleSendKaspaFeeEstimate\(\);/);
assert.match(between(app, "function scheduleSendKaspaFeeEstimate", "\n}\n"), /setSendKaspaFeeError\(""\);/, "a new estimate clears it");
assert.match(between(app, "function stopSendKaspaFeeEstimate", "\n}\n"), /setSendKaspaFeeError\(""\);/, "Max owns the fee: no stale error");
assert.match(app, /function refreshSendKaspaSwipe\(\) \{[^}]*sendKaspaBaseFeeKas != null\);/, "the swipe stays off without a fee");
// priced with the recipient's own output (the fee shown is the fee paid)
assert.match(between(app, "function sendKaspaEstimateFee", "\n}\n"), /engine\.estimateSendFee\(amountKas, selectedOutpoints, payloadBytes, sendKaspaRecipient\)[\s\S]*engine\.estimateSendFeeForAddress\(sendKaspaSourceAddress\(\), amountKas, selectedOutpoints, 0, sendKaspaRecipient, \{ quantumChange \}\)/);
// A request to a chatting address is priced as the chat payment it becomes (payload, memo
// included), and a spending source's quantum-safe change is priced in (audit 2026-11-13).
assert.match(between(app, "function sendKaspaEstimateFee", "\n}\n"), /estimatePaymentPayloadBytes\(String\(request\.memo \|\| ""\)/);
assert.match(between(app, "function spendingSendRotatesChange", "\n}\n"), /if \(purpose === "payment"\) return true;[\s\S]*spendingChangeIndex\(/);

// --- Send Kaspa: the swipe-time fee check ----------------------------------------------------
const sendFn = between(app, "sendFn: ({ destination, amountKas, feeKas, selectedOutpoints }) => {", "onSent: ({ txid, destination, amountKas }) => {");
assert.match(sendFn, /const expectedFeeSompi = kasToSompi\(trimKas8\(sendKaspaTotalFeeKas\(\)\)\);/);
assert.match(sendFn, /if \(error\?\.code === SEND_FEE_CHANGED\) scheduleSendKaspaFeeEstimate\(\);\s*throw error;/, "nothing sent: the Review works its fee out again");
assert.match(sendFn, /changeAddress: fresh\?\.address \|\| null,\s*expectedFeeSompi,/, "from a spending address too");
assert.match(sendFn, /engine\.send\(destination, amountKas, feeKas, \{ \.\.\.\(outpoints \? \{ selectedOutpoints: outpoints \} : \{\}\), expectedFeeSompi \}\)\s*\.catch\(refreshFeeIfChanged\)/);
assert.ok(sendFn.indexOf("expectedFeeSompi") > sendFn.indexOf("if (sendKaspaMaxMode) return sendKaspaPinnedMax"), "a Max has its own pin; Compound its own fee");
const engineSrc = read("../engine/index.js");
assert.match(engineSrc, /expectedFeeSompi: options\.expectedFeeSompi \?\? null,/);
assert.match(engineSrc, /exactAmount = false, expectedFeeSompi = null, owner = this\.address \}\) \{/);

// --- Max capped at one transaction's coins ---------------------------------------------------
assert.match(app, /capped: Boolean\(plan\.cappedAtInputLimit\),\s*\};/, "the chat payment's Max");
assert.match(app, /tip\.max = \{[^}]*capped: Boolean\(plan\.cappedAtInputLimit\) \};/, "the tip's Max");
assert.match(between(app, "function refreshPaymentSheetState", "function renderPaymentFromWarning"), /else if \(cappedMax\) \{[\s\S]{0,200}payNoteEl\.textContent = MAX_CAPPED_NOTE;/);
assert.match(between(app, "function tipRefreshState", "function tipSetError"), /else if \(activeTipMax\(\)\?\.capped\) \{[\s\S]{0,200}note\.textContent = MAX_CAPPED_NOTE;/);

// --- Chat payment and tip: a failed estimate holds the swipe, with Try Again -----------------
const payFee = between(app, "function schedulePaymentFee", "function resetPaymentSheetFields");
assert.match(payFee, /paymentFeeError = userFacingError\(error\) \|\| "Couldn't work out the network fee\.";/);
assert.match(payFee, /data-pay-fee-retry[\s\S]{0,120}paymentFeeError = "";[\s\S]{0,80}schedulePaymentFee\(\);/);
assert.match(app, /function paySwipeCanSend\(\) \{[^}]*&& !paymentFeeError;/);
assert.match(between(app, "function refreshPaymentSheetState", "function renderPaymentFromWarning"), /data-pay-fee-retry>Try Again<\/button>/);
const tipFee = between(app, "function tipScheduleFee", "function activeTipMax");
assert.match(tipFee, /state\.feeError = state\.baseFeeSompi == null \? \(failure \|\| "Couldn't work out the network fee\."\) : "";/);
assert.match(between(app, "function tipRefreshState", "function tipSetError"), /tipSlider\.setEnabled\(Boolean\(tip\) && sompi > 0n && !sending && !tip\.estimating && !tip\.feeError && tipTotalFeeSompi\(\) != null\);/,
  "the tip swipe waits for its fee (KaPost canSend)");
assert.match(app, /data-tip-fee-retry[\s\S]{0,140}tipState\.feeError = "";\s*tipScheduleFee\(\);/);

// --- Coins a send can't spend ----------------------------------------------------------------
const reason = between(app, "function coinUnavailableReason", "\n}\n");
assert.match(reason, /if \(!excludeJustSpentUtxos\(\[entry\]\)\.length\) return "Just spent by a send";/);
assert.match(reason, /if \(!excludeReservedUtxos\(\[entry\]\)\.length\) return "Held by a scheduled post";/);
assert.equal((app.match(/unavailableReason: coinUnavailableReason,/g) || []).length, 3, "Send Kaspa, the chat payment and the tip");
assert.match(between(app, "function sendKaspaUnreservedBalance", "\n}\n"), /excludeJustSpentUtxos\(excludeReservedUtxos\(balance\?\.entries \|\| \[\]\)\)/, "Available counts what a send can spend");
assert.equal((app.match(/if \(excludeJustSpentUtxos\(excludeReservedUtxos\((utxos|lastManageAddressUtxos)\)\)\.length > 1\) \{/g) || []).length, 2, "Compound: the chatting and a spending address");
assert.match(between(app, "async function tipLoadAvailable", "function tipSetSource"), /excludeJustSpentUtxos\(excludeReservedUtxos\(balance\?\.entries \|\| \[\]\)\)/, "the tip's Available");
const payFrom = between(app, "async function refreshComposerAvailableBalance", "function setPaymentSource");
assert.equal((payFrom.match(/sendKaspaUnreservedBalance\(/g) || []).length, 2, "the chat payment's From balance, either source");
const picker = read("../ui/send-kaspa-components.js");
const coinPicker = between(picker, "export function openCoinControlPicker", "export function closeCoinControlPicker");
assert.match(coinPicker, /unavailableReason = null, onDone/);
assert.match(coinPicker, /const on = !reason && selected\.has\(key\);/);
assert.match(coinPicker, /\$\{reason \? ' disabled aria-disabled="true"' : ""\}/);
assert.match(coinPicker, /cold-coincontrol-unavailable/);
assert.match(coinPicker, /const live = new Set\(available\(\)\.map\(utxoEntryKey\)\);/, "a held coin drops out of an earlier pick");
assert.match(coinPicker, /\[data-sk-coin-all\]"\)\) \{ available\(\)\.forEach/, "Select All takes only spendable coins");
assert.match(coinPicker, /const picked = available\(\)\s*\.filter/);
assert.match(coinPicker, /if \(!row \|\| row\.disabled\) return;/);
assert.match(read("../ui/styles.css"), /\.cold-coincontrol-row\.unavailable \{ opacity: 0\.5;/);

// --- A pasted payment request ----------------------------------------------------------------
assert.match(app, /if \(link\?\.kind !== "pay"\) return;[\s\S]{0,400}if \(link\.raw !== value\.trim\(\)\) return;\s*applyPaymentRequestToSendKaspa\(link\.request\);/);

// --- Cold Storage holds its coins too --------------------------------------------------------
const kspt = read("../ui/kspt.js");
assert.match(between(kspt, "export async function broadcastSigned", "\n}\n"), /spends: transactionSpends\(tx\),/);

// --- A handshake with an unknown outcome -----------------------------------------------------
const handshake = between(app, "async function sendOutgoingHandshake", "\n}\n");
const unknownBranch = between(handshake, "if (error?.code === SEND_OUTCOME_UNKNOWN) {", "updateMessageStatus(conversationEntry.id, message.id, { status: MESSAGE_STATUSES.FAILED });");
assert.match(unknownBranch, /updateMessageStatus\(conversationEntry\.id, message\.id, \{ \.\.\.sendFailurePatch\(error\), messageType: "handshake", transport: "onchain" \}\);/, "Not confirmed under its txid");
assert.match(unknownBranch, /contact\.relationshipState = accepting \? "established" : "outgoing-request";/, "no second handshake (Accept / resend) while it may have landed");
assert.match(unknownBranch, /return true;/);
assert.doesNotMatch(unknownBranch, /showFailedToSend|request-failed/);
assert.ok(handshake.indexOf("SEND_OUTCOME_UNKNOWN") < handshake.indexOf("MESSAGE_STATUSES.FAILED"), "checked before the failure path");

console.log("send fee review: ok");
