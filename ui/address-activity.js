// Address Activity's rules (iOS 56b75c8, AddressActivityNotifier; KaPay 34f4b45 / 42470af). Pure,
// so tools/test-address-activity.mjs can run them without the app.
//
// The chatting address notifies only for a plain transfer: a transaction with a payload (a KaChat
// chat payment, a message, a handshake) is the chat's own news and stays quiet. Every address's
// catch-up counts only receives newer than its floor - the newest block time an earlier catch-up
// looked at, or when the address started being tracked - newest first and no more than the
// balance grew by, so older history is never announced again (KaPay 34f4b45). A receive is never
// announced when any of its inputs spends from one of our addresses: our own change, including
// what another app on the same seed sends (KaPay 42470af).

/** A transaction with no payload: plain KAS, not a KaChat chat payment, message or handshake
 *  (iOS isPlainTransfer). The REST API sends the payload as hex, "" or null when there is none. */
export function isPlainTransferTx(tx) {
  return !String(tx?.payload ?? "").trim();
}

/** A REST transaction's block time in ms, 0 when unknown. */
export function txBlockTimeMs(tx) {
  const value = Number(tx?.block_time ?? tx?.blockTime ?? 0);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/** One catch-up look at an address (KaPay 34f4b45): `floor` is the newest block time (ms) already
 *  looked at (0 = none yet: the balance increase alone bounds it). Gives the floor to store (the
 *  newest fetched block time, never below `floor`; `floor` when nothing has one) and the txs that
 *  may count, newest first (one with no block time yet is the newest): those newer than the floor,
 *  and for the chatting address plain transfers only. */
export function catchUpCandidates(txs, floor, { chatting = false } = {}) {
  const list = Array.isArray(txs) ? txs : [];
  const previous = Number(floor) > 0 ? Number(floor) : 0;
  const times = list.map(txBlockTimeMs).filter((time) => time > 0);
  const nextFloor = times.length ? Math.max(Math.max(...times), previous) : previous;
  const rank = (tx) => txBlockTimeMs(tx) || Number.MAX_SAFE_INTEGER;
  const candidates = list
    .filter((tx) => !(previous && txBlockTimeMs(tx) && txBlockTimeMs(tx) <= previous))
    .filter((tx) => !chatting || isPlainTransferTx(tx))
    .sort((a, b) => rank(b) - rank(a));
  return { nextFloor, candidates };
}

function inputAddress(input) {
  return String(
    input?.previous_outpoint_address || input?.previousOutpointAddress ||
    input?.previous_outpoint_resolved?.script_public_key_address ||
    input?.previousOutpointResolved?.scriptPublicKeyAddress || "",
  ).trim();
}

/**
 * Whether `tx` spends from any of our addresses (KaPay 42470af spendsOwnFunds): true as soon as one
 * input is ours, false when every input is placed and none is, null when some input couldn't be
 * placed. An input the REST API left unresolved (usual for a transaction seconds old) is matched
 * against `recentOwnSpent` (outpoints "txid:index" our addresses just spent), then looked up in the
 * transaction that created it: `outputAddress(txid, index)` resolves to that output's address, or
 * null when it can't be read.
 */
export async function spendsOwnFunds(tx, ownAddresses, { recentOwnSpent = null, outputAddress = null } = {}) {
  const inputs = Array.isArray(tx?.inputs) ? tx.inputs : [];
  if (!inputs.length) return null;
  const unresolved = [];
  let unknown = false;
  for (const input of inputs) {
    const address = inputAddress(input);
    if (address) {
      if (ownAddresses.has(address)) return true;
      continue;
    }
    const hash = String(input?.previous_outpoint_hash ?? input?.previousOutpoint?.transactionId ?? "").trim();
    const index = Number(input?.previous_outpoint_index ?? input?.previousOutpoint?.index);
    if (!hash || !Number.isInteger(index) || index < 0) { unknown = true; continue; }
    if (recentOwnSpent?.has?.(`${hash}:${index}`)) return true;
    unresolved.push({ hash, index });
  }
  for (const { hash, index } of unresolved) {
    let address = null;
    try { address = outputAddress ? await outputAddress(hash, index) : null; } catch { address = null; }
    if (!address) { unknown = true; continue; }
    if (ownAddresses.has(address)) return true;
  }
  return unknown ? null : false;
}
