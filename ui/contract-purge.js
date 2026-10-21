// The on-load contract purge (iOS purgeContractAddressPaymentChats) and its one-time recovery
// (DSK-055), as pure functions over plain conversation rows so the rules can be tested without a
// page. ui/app.js maps its state into rows ({ id, isSelf, contactAddress, messages,
// hiddenMessageKeys }), owns storage and rendering, and applies the plan.
//
// Since quantum (KIP-22) addresses, "P2SH" alone no longer means "contract": a payment can be paid
// FROM a quantum-safe address (iOS 0b4e27e, Desktop 52977ae). So, as on iOS, only a conversation
// whose CONTACT is a script address is a contract chat. A payment bubble is never judged by the
// shape of its sender or receiver - not in the self chat, not anywhere.

function normalizeTxId(txid) { return String(txid || "").trim().toLowerCase(); }

function isPaymentBubble(message) {
  return message?.messageType === "payment" || message?.transport === "kaspa-payment" || message?.transport === "kaspa-payment-rest";
}

/// iOS purgeContractAddressPaymentChats: the payments of every conversation whose contact is a
/// script address are suppressed for good (`txIds`), and a conversation they empty goes away
/// (`emptiedIds`, iOS removeSuppressedPaymentMessages: "the emptied auto-added conversations go
/// away"). The self chat is never one of them.
export function contractPurgePlan(rows, { isScriptAddress }) {
  const txIds = [];
  const emptiedIds = [];
  for (const row of rows || []) {
    if (row?.isSelf || !isScriptAddress(row?.contactAddress)) continue;
    const messages = Array.isArray(row.messages) ? row.messages : [];
    const payments = messages.filter((message) => isPaymentBubble(message) && normalizeTxId(message.txid));
    txIds.push(...payments.map((message) => message.txid));
    if (payments.length === messages.length) emptiedIds.push(row.id);
  }
  return { txIds, emptiedIds };
}

/// DSK-055 recovery: older builds also suppressed, for good, any payment bubble whose sender or
/// receiver was a script address - in the self chat ("Received X KAS / From: kaspa:p…" from a
/// quantum payer) and in ordinary chats. The suppressed map stores no reason, only when, so the
/// purge's bubbles are found by where they were hidden: a suppressed txid among the
/// hiddenMessageKeys of the self chat or of a chat whose contact is NOT a script address. Those
/// come out of the suppressed map (`txIds`) and out of those chats' hidden keys (`unhide`), so a
/// sweep, a payment_notice or an archive can file them again - each still behind the narrowed
/// contract rule (isKachatContractTransaction), which re-suppresses a real contract on sight.
///
/// Never recovered:
/// - a txid that belongs to a script-contact chat (still hidden or shown there): that is the
///   iOS rule's own suppression;
/// - the self chat's copy of a payment also hidden in another (non-script) chat: a payment_notice
///   moved it out of the self chat (takePaymentOutOfSelfChat), so only that chat gets it back.
/// `selfTxIds` are the ones recovered into the self chat, for the stranger sweep to read again.
export function contractSuppressionRecovery(rows, suppressedIds, { isScriptAddress }) {
  const suppressed = suppressedIds instanceof Set
    ? new Set([...suppressedIds].map(normalizeTxId))
    : new Set(Object.keys(suppressedIds || {}).map(normalizeTxId));
  const list = (rows || []).filter(Boolean);
  const contractTxIds = new Set();
  for (const row of list) {
    if (row.isSelf || !isScriptAddress(row.contactAddress)) continue;
    for (const message of row.messages || []) if (message?.txid) contractTxIds.add(normalizeTxId(message.txid));
    for (const key of row.hiddenMessageKeys || []) contractTxIds.add(normalizeTxId(key));
  }
  const candidatesOf = (row) => new Set((row.hiddenMessageKeys || [])
    .map(normalizeTxId)
    .filter((id) => id && suppressed.has(id) && !contractTxIds.has(id)));
  const plainRows = list.filter((row) => !row.isSelf && !isScriptAddress(row.contactAddress));
  const hiddenInOtherChat = new Set();
  for (const row of plainRows) for (const id of candidatesOf(row)) hiddenInOtherChat.add(id);

  const txIds = new Set();
  const selfTxIds = new Set();
  const unhide = [];
  for (const row of list) {
    if (!row.isSelf && isScriptAddress(row.contactAddress)) continue;
    const ids = candidatesOf(row);
    if (row.isSelf) for (const id of [...ids]) if (hiddenInOtherChat.has(id)) ids.delete(id);
    if (!ids.size) continue;
    for (const id of ids) {
      txIds.add(id);
      if (row.isSelf) selfTxIds.add(id);
    }
    unhide.push({ id: row.id, keys: (row.hiddenMessageKeys || []).filter((key) => ids.has(normalizeTxId(key))) });
  }
  return { txIds: [...txIds], selfTxIds: [...selfTxIds], unhide };
}
