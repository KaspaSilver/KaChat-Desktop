import { NETWORK_ID, validateMainnetAddress, sompiToKaspaDisplay } from "./utils.js";
import { kasToSompi, utxoAmountSompi, MAX_U64, checkedUtxoAnswer } from "./amounts.js";
import { getEndpoint } from "./endpoints.js";

// Every real send (messages, handshakes, self-stash, KAS payments, KNS
// commits) funnels through sendKaspa()'s UTXO-fetch-then-spend window below.
// Firing several of these concurrently — e.g. a user sending multiple chat
// messages in quick succession — lets two calls fetch the same unspent UTXOs
// before either has broadcast, so both try to spend them and one fails.
// Keyed per source address (not global) so unrelated addresses never wait on
// each other; queued per address since they share one UTXO pool.
const sendQueues = new Map();

/** Runs a task in the per-address send queue: anything that picks and spends coins from one
 *  address goes through here so two builds never choose the same coin. */
export function enqueueSend(sourceAddress, task) {
  const previous = sendQueues.get(sourceAddress) || Promise.resolve();
  const next = previous.then(task, task).finally(() => {
    if (sendQueues.get(sourceAddress) === next) sendQueues.delete(sourceAddress);
  });
  sendQueues.set(sourceAddress, next);
  return next;
}

export async function getBalance(kaspa, rpc, address) {
  const response = checkedUtxoAnswer(await rpc.getUtxosByAddresses([address]));
  const entries = sanitizeUtxoEntries(response.entries);
  const totalSompi = totalUtxoSompi(entries);
  return {
    entries,
    totalSompi,
    totalKas: sompiToKaspaDisplay(kaspa, totalSompi),
    utxoCount: entries.length,
  };
}

// Node-supplied UTXO values (iOS IOS-020): the pool connects to public peers, and a broken or
// malicious node can report an amount that is not a whole number, or one past u64. BigInt never
// overflows, but such a value thrown into a sort, a sum or the WASM SDK (which panics on it) took
// the whole send down with an opaque error. An entry without a usable amount is dropped; a set
// whose total no longer fits a u64 is refused outright.
/** The entries with a whole, positive, u64-sized amount; anything else is left out. */
export function sanitizeUtxoEntries(entries) {
  return (Array.isArray(entries) ? entries : []).filter((entry) => utxoAmountSompi(entry) != null);
}
/** The total of sanitized entries in sompi; throws when it does not fit a u64. */
export function totalUtxoSompi(entries) {
  let total = 0n;
  for (const entry of entries || []) total += utxoAmountSompi(entry) ?? 0n;
  if (total > MAX_U64) throw new Error("Invalid UTXO data: amount overflow");
  return total;
}
const bySompiAsc = (a, b) => { const x = utxoAmountSompi(a) ?? 0n; const y = utxoAmountSompi(b) ?? 0n; return x > y ? 1 : (x < y ? -1 : 0); };
const bySompiDesc = (a, b) => bySompiAsc(b, a);
/** The address's UTXOs, sanitized, through `withRpc` when given (a node failover) else `rpc`. */
async function fetchUtxoEntries({ rpc, withRpc, sourceAddress, label }) {
  const fetchUtxos = async (activeRpc) => checkedUtxoAnswer(await activeRpc.getUtxosByAddresses([sourceAddress]));
  const response = withRpc ? await withRpc(fetchUtxos, { retries: 1, label }) : await fetchUtxos(rpc);
  const entries = sanitizeUtxoEntries(response?.entries);
  totalUtxoSompi(entries);
  return entries;
}

// A failed submit is not always a failed send (iOS IOS-014): a node can accept the transaction
// while its answer is lost, and the retry on the standby (or the transient-UTXO retry below) then
// hears "already in the mempool" / "already spent" for that very transaction. Reporting that as a
// failure invites a resend that pays twice. So before an error is thrown, the transaction's own
// id (known before the submit) is looked up: in the node's mempool, else accepted per the REST
// API, twice a moment apart. Found means the send went out.
const ACCEPTANCE_RECHECK_MS = 1500;
/** Whether the network already has `txid`: in a mempool, or accepted (REST API). */
export async function isTransactionKnown({ rpc = null, withRpc = null, txid } = {}) {
  const id = String(txid || "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(id)) return false;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await sleep(ACCEPTANCE_RECHECK_MS);
    try {
      const lookup = async (activeRpc) => {
        if (typeof activeRpc?.getMempoolEntry !== "function") return null;
        return activeRpc.getMempoolEntry({ transactionId: id, includeOrphanPool: true, filterTransactionPool: false });
      };
      const entry = withRpc ? await withRpc(lookup, { retries: 0, label: "Mempool lookup" }) : await lookup(rpc);
      if (entry?.mempoolEntry || entry?.entry) return true;
    } catch { /* not in this node's mempool (or no answer): ask the REST API */ }
    try {
      const base = String(getEndpoint("kaspaApi") || "").replace(/\/+$/, "");
      if (base && typeof fetch === "function") {
        const response = await fetch(`${base}/transactions/${id}?inputs=false&outputs=false&resolve_previous_outpoints=no`, { headers: { Accept: "application/json" }, cache: "no-store" });
        if (response.ok && (await response.json())?.is_accepted === true) return true;
      }
    } catch { /* unknown: treated as not found */ }
  }
  return false;
}
// "Orphan where orphan is disallowed" (iOS 4eb492f, NodePoolService.submitTransaction): the
// inputs came from a node that already has their parent transaction (the UTXO query), but the
// node this submit reached hasn't caught up yet - a reaction or message sent right after the
// previous one, or a chained send's next transaction. The parent is given a moment to propagate
// and the SAME signed transaction is submitted once more; then the node is asked to hold it as an
// orphan until the parent arrives. Nothing is rebuilt here, so nothing can be paid twice.
export const ORPHAN_WAIT_MS = 1500;
/** Whether a submit error is the node's orphan rejection. */
export function isOrphanRejection(error) {
  return String(error?.message || error || "").toLowerCase().includes("orphan");
}
/**
 * Submits through `submit(activeRpc, { allowOrphan })` (via `withRpc` when given) and returns the
 * transaction id. `submit` should pass `allowOrphan` on to `submitTransaction` (default false).
 * An orphan rejection waits `orphanWaitMs`, resubmits once, then submits allowing an orphan (see
 * above). On any other error, a transaction the network already has (`txid`, computed locally)
 * counts as sent; anything else is rethrown. Every submit in this file goes through here.
 */
export async function submitConfirmingAcceptance({ rpc = null, withRpc = null, submit, txid, label = "Transaction broadcast", log = () => {}, orphanWaitMs = ORPHAN_WAIT_MS }) {
  const submitOnce = async (allowOrphan) => {
    const run = (activeRpc) => submit(activeRpc, { allowOrphan });
    const response = withRpc ? await withRpc(run, { retries: 1, label }) : await run(rpc);
    const returned = typeof response === "string" ? response : response?.transactionId;
    return String(returned || txid || "");
  };
  try {
    return await submitOnce(false);
  } catch (error) {
    if (isOrphanRejection(error)) {
      log(`${label}: the node called ${txid || "the transaction"} an orphan (its parent hasn't reached it yet); waiting ${orphanWaitMs}ms and submitting the same transaction again.`);
      await sleep(orphanWaitMs);
      try { return await submitOnce(false); } catch { /* still not there: let the node hold it */ }
      try {
        const sent = await submitOnce(true);
        log(`${label}: ${String(sent).slice(0, 12)} submitted as an orphan: its parent hadn't reached that node yet.`);
        return sent;
      } catch { /* fall through to the acceptance check with the original error */ }
    }
    if (txid && await isTransactionKnown({ rpc, withRpc, txid })) {
      log(`${label}: the submit reported "${error?.message || error}" but the network has ${txid}; treated as sent.`);
      return String(txid);
    }
    throw error;
  }
}

// Coins reserved by scheduled KaPosts (KAPOSTS_INDEXER.md §5.10): a signed transaction waiting
// for its time depends on them, so every builder here leaves them alone. "txid:index" strings.
let reservedOutpoints = new Set();
export function setReservedOutpoints(list) {
  reservedOutpoints = new Set(Array.isArray(list) ? list.map(String) : []);
}
export function excludeReservedUtxos(entries) {
  if (!reservedOutpoints.size) return entries;
  return (entries || []).filter((entry) => !reservedOutpoints.has(`${entry?.outpoint?.transactionId}:${entry?.outpoint?.index}`));
}

/** The one coin an arena message spends (iOS builds every chess send with a single input): the
 *  largest coin that covers the amount plus a fee margin. Null when no single coin can. */
export function singleInputFor(entries, amountSompi, marginSompi = 300_000n) {
  const sorted = sanitizeUtxoEntries(entries).sort(bySompiDesc);
  const pick = sorted.find((e) => utxoAmountSompi(e) >= amountSompi + marginSompi) || null;
  return pick ? [pick] : null;
}

/** "txid:index" keys from a coin-control list: "txid:index" strings, { transactionId, index }
 *  outpoints, or UTXO entries carrying an `outpoint`. Anything unreadable is dropped. */
export function outpointKeysFrom(list) {
  if (!Array.isArray(list)) return [];
  const keys = [];
  for (const item of list) {
    if (typeof item === "string") { if (item.includes(":")) keys.push(item); continue; }
    const outpoint = item?.outpoint || item;
    const txid = outpoint?.transactionId ?? outpoint?.transaction_id;
    const index = outpoint?.index;
    if (txid != null && index != null && txid !== "") keys.push(`${txid}:${index}`);
  }
  return keys;
}

/** A non-negative whole number of sompi as BigInt; anything else (missing, negative, NaN) is 0. */
export function extraFeeSompiFrom(value) {
  if (value == null || value === "") return 0n;
  try {
    const sompi = typeof value === "bigint" ? value : BigInt(Math.round(Number(value)));
    return sompi > 0n ? sompi : 0n;
  } catch {
    return 0n;
  }
}

// `manualUtxos` (iOS manualUtxos): coin control - an outpoint list ("txid:index" strings, outpoints
// or UTXO entries) the build may pick from; used when `selectedOutpoints` is not given. Null or
// empty = automatic selection, as before.
// `extraFeeSompi` (iOS extraFeeSompi): a priority fee in sompi paid on top of the minimum fee (the
// Fast / Priority / custom extra), added to `feeKas`. 0 = unchanged behaviour.
export async function sendKaspa({ kaspa, rpc, withRpc = null, privateKey, sourceAddress, destinationAddress, amountKas, feeKas = "0", payload = null, selectedOutpoints = null, manualUtxos = null, extraFeeSompi = 0, changeAddress = null, singleInput = false, exactAmount = false, log = () => {} }) {
  const outpoints = selectedOutpoints && selectedOutpoints.length ? selectedOutpoints : outpointKeysFrom(manualUtxos);
  // Coin control never falls back to coins the person didn't pick (iOS IOS-012): a non-empty pick
  // that names no readable coin is refused, not sent as an automatic selection.
  if (!outpoints.length && Array.isArray(manualUtxos) && manualUtxos.length) {
    throw new Error("Selected UTXOs are no longer available - please reselect.");
  }
  const extraFee = extraFeeSompiFrom(extraFeeSompi);
  return enqueueSend(sourceAddress, () => sendKaspaWithUtxoRetry({ kaspa, rpc, withRpc, privateKey, sourceAddress, destinationAddress, amountKas, feeKas, extraFeeSompi: extraFee, payload, selectedOutpoints: outpoints.length ? outpoints : null, changeAddress, singleInput, exactAmount, log }));
}

// Consolidate ("compound") every UTXO at `sourceAddress` into a single self-output with NO change,
// matching iOS's Compound UTXOs. A plain self-send that leaves a tiny change output gets rejected
// by Kaspa's KIP-9 storage-mass rule, so the transaction is assembled by hand with exactly one
// output of (total - fee); more than 80 coins are compounded in chunks of 80.
export async function sweepAllToSelf({ kaspa, rpc, withRpc = null, privateKey, sourceAddress, totalFeeSompi = null, log = () => {} }) {
  return enqueueSend(sourceAddress, () => sweepAllToSelfNow({ kaspa, rpc, withRpc, privateKey, sourceAddress, totalFeeSompi, log }));
}
// One all-schnorr-input transaction tops out near the standard mass ceiling around ~85 inputs.
const MAX_INPUTS_PER_SWEEP = 80;
async function sweepAllToSelfNow({ kaspa, rpc, withRpc, privateKey, sourceAddress, totalFeeSompi, log }) {
  let entries = await fetchUtxoEntries({ rpc, withRpc, sourceAddress, label: "Compound UTXO fetch" });
  if (!entries || entries.length === 0) throw new Error("No UTXOs to compound.");
  entries = excludeReservedUtxos(entries);
  if (entries.length === 0) throw new Error("Every coin is reserved by a scheduled post.");
  entries.sort(bySompiAsc);

  // Built by hand, never through the generator: asking it for (total - fee) left it a few
  // hundred sompi of change, which it dutifully emitted as a second output - and an output that
  // small has a KIP-9 storage mass far past the maximum, so every compound of a healthy balance
  // died with "Storage mass exceeds maximum". Exactly one output of (total - fee) per
  // transaction means no change can exist. Same approach as sendMaxKaspaNow below.
  const chunks = [];
  for (let i = 0; i < entries.length; i += MAX_INPUTS_PER_SWEEP) chunks.push(entries.slice(i, i + MAX_INPUTS_PER_SWEEP));
  const txids = [];
  for (const [index, chunk] of chunks.entries()) {
    const total = totalUtxoSompi(chunk);
    const draft = kaspa.createTransaction(chunk, [{ address: sourceAddress, amount: total - (total / 20n) }], 0n);
    const floorFeeSompi = BigInt(kaspa.calculateTransactionFee(NETWORK_ID, draft, 1) ?? 0n);
    // The displayed policy fee is what the whole compound pays when it fits one transaction;
    // a chunked compound pays each chunk's own network floor.
    let fee = chunks.length === 1 && totalFeeSompi != null ? BigInt(totalFeeSompi) : floorFeeSompi;
    if (fee < floorFeeSompi) fee = floorFeeSompi;
    const amount = total - fee;
    if (amount <= 0n) throw new Error("Balance too low to compound after network fees.");
    const tx = kaspa.createTransaction(chunk, [{ address: sourceAddress, amount }], 0n);
    const signed = kaspa.signTransaction(tx, [signingKeyArg(privateKey)], true);
    const submit = (activeRpc, { allowOrphan = false } = {}) => activeRpc.submitTransaction({ transaction: signed, allowOrphan });
    let txid;
    try {
      txid = await submitConfirmingAcceptance({ rpc, withRpc, submit, txid: signed.id, label: "Compound broadcast", log });
    } catch (error) {
      // Earlier chunks already went out: say so, and never let a retry compound them again.
      if (txids.length) { error.submittedTxids = [...txids]; error.message = `${error.message} (${txids.length} of ${chunks.length} compound transactions were sent)`; }
      throw error;
    }
    txids.push(txid);
    log(`Compound txid (${index + 1}/${chunks.length}):`, txid);
  }
  return { txids };
}

// True "Max" send to a recipient: probe the exact fee for spending every input, then send
// exactly (total - totalFee) with the difference over the base fee paid as priority — so the
// generator emits a SINGLE output and folds any sub-dust remainder into the fee. A near-max
// amount sent through the normal path can't work: whatever tiny remainder is left becomes a
// dust change output, and Kaspa's KIP-9 storage-mass rule rejects the transaction (the same
// reason sweepAllToSelf above is a two-pass exact sweep). `totalFeeSompi` is the UI's
// displayed policy fee; it is clamped up to the generator's own base fee if too low.
//
// Options shared by sendMaxKaspa, sendMaxWithPayload and estimateMaxSend (audits DSK-042, DSK-043):
// - `selectedOutpoints` / `manualUtxos`: coin control (as sendKaspa); otherwise every coin the
//   address holds that no scheduled KaPost reserves.
// - fee: `totalFeeSompi` (a displayed total, raised to the network floor when below it), else the
//   network floor for this exact shape (all inputs, one output, the payload) + `extraFeeSompi`.
// - `payload`: carried by the one output's transaction (a chat payment's kchat:1:pay:). A payload
//   that states the amount must be built for `expectedAmountSompi`.
// - pin ("send exactly what's shown"): `expectedOutpoints` is the exact coin set Max was computed
//   from, and `expectedAmountSompi` the amount the person saw. A different coin set, or a fee that
//   no longer fits (total - expected below the fee, or above it by more than
//   MAX_PIN_FEE_SLACK_SOMPI), throws a MAX_AMOUNT_CHANGED error carrying the new plan and nothing
//   is sent. Within the slack the shown amount is sent and those few sompi go to the fee.
export const MAX_SEND_INPUT_LIMIT = 80;
// A few bytes of payload or address script at the 100 sompi/gram floor (a payload byte is ~200
// sompi, an address-script byte ~1100): far below any fee-tier step.
export const MAX_PIN_FEE_SLACK_SOMPI = 5000n;
export const MAX_AMOUNT_CHANGED = "maxAmountChanged";
export const MAX_AMOUNT_CHANGED_MESSAGE = "The available amount changed. Check the new amount and slide again.";
const TOO_MANY_COINS_FOR_MAX = "Too many coins for one transaction. Run Compound UTXOs first, then send Max.";
const outpointKeyOf = (entry) => `${entry?.outpoint?.transactionId}:${entry?.outpoint?.index}`;

/** The coins a Max send spends from the address's sanitized entries: reserved coins dropped, then
 *  narrowed to the coin-control pick when there is one. Throws when nothing is left. */
export function maxSendEntries(entries, selectedOutpoints = null) {
  let list = Array.isArray(entries) ? [...entries] : [];
  if (list.length === 0) throw new Error("No UTXOs to send.");
  list = excludeReservedUtxos(list);
  if (list.length === 0) throw new Error("Every coin is reserved by a scheduled post.");
  if (selectedOutpoints && selectedOutpoints.length) {
    const wanted = new Set(selectedOutpoints);
    list = list.filter((entry) => wanted.has(outpointKeyOf(entry)));
    if (list.length === 0) throw new Error("The selected coins are no longer available.");
  }
  return list.sort(bySompiAsc);
}

/**
 * The exact single-output Max for `entries` (already chosen): no change can exist, so nothing is
 * left for KIP-9 to reject. Pure and synchronous: the same numbers the send uses.
 * Returns { entries, outpoints, totalSompi, floorFeeSompi, feeSompi, amountSompi }.
 */
export function planMaxSend({ kaspa, entries, destinationAddress, payload = null, totalFeeSompi = null, extraFeeSompi = 0 }) {
  const chosen = [...(entries || [])].sort(bySompiAsc);
  if (chosen.length === 0) throw new Error("No UTXOs to send.");
  // One all-schnorr-input transaction tops out near the standard mass ceiling around ~85
  // inputs; the generator would split into a chain, but a max send must be a single tx.
  if (chosen.length > MAX_SEND_INPUT_LIMIT) throw new Error(TOO_MANY_COINS_FOR_MAX);
  const total = totalUtxoSompi(chosen);
  const payloadArg = payload && payload.length ? payload : undefined;
  // The exact network-floor fee for this shape (all inputs, ONE output, the payload), measured on
  // a draft. Undefined means the mass is over the standard limit.
  const draft = kaspa.createTransaction(chosen, [{ address: destinationAddress, amount: total - (total / 20n) }], 0n, payloadArg);
  const floorRaw = kaspa.calculateTransactionFee(NETWORK_ID, draft, 1);
  if (floorRaw == null) throw new Error(TOO_MANY_COINS_FOR_MAX);
  const floorFeeSompi = BigInt(floorRaw);
  let feeSompi;
  if (totalFeeSompi != null) {
    feeSompi = BigInt(totalFeeSompi);
    if (feeSompi < floorFeeSompi) feeSompi = floorFeeSompi;
  } else {
    feeSompi = floorFeeSompi + extraFeeSompiFrom(extraFeeSompi);
  }
  const amountSompi = total - feeSompi;
  if (amountSompi <= 0n) throw new Error("Balance too low after network fees.");
  return { entries: chosen, outpoints: chosen.map(outpointKeyOf), totalSompi: total, floorFeeSompi, feeSompi, amountSompi };
}

/** The error a pinned Max throws when what it would send is no longer what was shown. */
function maxAmountChangedError(plan) {
  const error = new Error(MAX_AMOUNT_CHANGED_MESSAGE);
  error.code = MAX_AMOUNT_CHANGED;
  error.amountSompi = plan.amountSompi;
  error.feeSompi = plan.feeSompi;
  error.outpoints = plan.outpoints;
  return error;
}

/** Checks a plan against the pin; returns { amountSompi, feeSompi } to send, or throws. */
export function applyMaxPin(plan, { expectedAmountSompi = null, expectedOutpoints = null } = {}) {
  if (expectedOutpoints != null) {
    const expected = new Set(outpointKeysFrom(expectedOutpoints));
    const same = expected.size === plan.outpoints.length && plan.outpoints.every((key) => expected.has(key));
    if (!same) throw maxAmountChangedError(plan);
  }
  if (expectedAmountSompi == null) return { amountSompi: plan.amountSompi, feeSompi: plan.feeSompi };
  const expected = BigInt(expectedAmountSompi);
  const fee = plan.totalSompi - expected;
  if (expected <= 0n || fee < plan.feeSompi || fee > plan.feeSompi + MAX_PIN_FEE_SLACK_SOMPI) throw maxAmountChangedError(plan);
  return { amountSompi: expected, feeSompi: fee };
}

function maxPickFrom(selectedOutpoints, manualUtxos) {
  const picked = selectedOutpoints && selectedOutpoints.length ? selectedOutpoints : outpointKeysFrom(manualUtxos);
  // Coin control never falls back to coins the person didn't pick (iOS IOS-012).
  if (!picked.length && Array.isArray(manualUtxos) && manualUtxos.length) {
    throw new Error("Selected UTXOs are no longer available - please reselect.");
  }
  return picked.length ? picked : null;
}

/**
 * Max without sending (the Max buttons): the address's coins fetched now, the same choice and fee
 * as the send. `payloadBytes` (a length) or `payloadFor(totalSompi)` stands in for a payload not
 * built yet. Returns the plan (without its entries) plus `availableSompi`, every unreserved coin
 * at the address.
 */
export async function estimateMaxSend({ kaspa, rpc, withRpc = null, sourceAddress, destinationAddress = null, selectedOutpoints = null, manualUtxos = null, payload = null, payloadBytes = 0, payloadFor = null, totalFeeSompi = null, extraFeeSompi = 0 }) {
  const picked = maxPickFrom(selectedOutpoints, manualUtxos);
  const fetched = await fetchUtxoEntries({ rpc, withRpc, sourceAddress, label: "Max estimate UTXO fetch" });
  const availableSompi = totalUtxoSompi(excludeReservedUtxos(fetched));
  const entries = maxSendEntries(fetched, picked);
  const length = Math.max(0, Number(payloadBytes) || 0);
  // `payloadFor(totalSompi)`: the payload built for the chosen coins' total (iOS prices a payment
  // payload with the whole balance as its amount: never shorter than the real one).
  let priced = payload || (length ? new Uint8Array(length) : null);
  if (!priced && typeof payloadFor === "function") priced = (await payloadFor(totalUtxoSompi(entries))) || null;
  const plan = planMaxSend({
    kaspa, entries,
    destinationAddress: validateMainnetAddress(destinationAddress || sourceAddress),
    payload: priced,
    totalFeeSompi, extraFeeSompi,
  });
  return {
    outpoints: plan.outpoints, totalSompi: plan.totalSompi, floorFeeSompi: plan.floorFeeSompi,
    feeSompi: plan.feeSompi, amountSompi: plan.amountSompi, inputCount: plan.outpoints.length, availableSompi,
  };
}

export async function sendMaxKaspa(args) {
  return enqueueSend(args.sourceAddress, () => sendMaxKaspaNow(args));
}
/** sendMaxKaspa with a payload (a chat payment at Max): one output, no change, the payload on it. */
export async function sendMaxWithPayload(args) {
  if (!args?.payload) throw new Error("Payload is required for a pay-max-with-payload send.");
  return sendMaxKaspa(args);
}
async function sendMaxKaspaNow({ kaspa, rpc, withRpc = null, privateKey, sourceAddress, destinationAddress: rawDestination, totalFeeSompi = null, extraFeeSompi = 0, selectedOutpoints = null, manualUtxos = null, payload = null, expectedAmountSompi = null, expectedOutpoints = null, log = () => {} }) {
  // Like sendKaspaNow: only an address of the running network (IOS-003) - the script is built
  // from the payload alone, so the other network's address would pay this chain's script.
  const destinationAddress = validateMainnetAddress(rawDestination);
  const picked = maxPickFrom(selectedOutpoints, manualUtxos);
  const fetched = await fetchUtxoEntries({ rpc, withRpc, sourceAddress, label: "Max send UTXO fetch" });
  const entries = maxSendEntries(fetched, picked);

  // Built by hand, never through the generator: the output is exactly (total - fee), so no change
  // output can ever exist (the generator's own change/dust handling is what kept tripping KIP-9 on
  // near-max amounts). Mirrors the KNS reveal's manual-build approach.
  const plan = planMaxSend({ kaspa, entries, destinationAddress, payload, totalFeeSompi, extraFeeSompi });
  const { amountSompi: amount, feeSompi } = applyMaxPin(plan, { expectedAmountSompi, expectedOutpoints });
  const payloadArg = payload && payload.length ? payload : undefined;
  const tx = kaspa.createTransaction(plan.entries, [{ address: destinationAddress, amount }], 0n, payloadArg);
  const finalFloor = kaspa.calculateTransactionFee(NETWORK_ID, tx, 1);
  if (finalFloor == null) throw new Error(TOO_MANY_COINS_FOR_MAX);
  if (BigInt(finalFloor) > feeSompi) throw new Error("Balance too low after network fees.");
  const signed = kaspa.signTransaction(tx, [signingKeyArg(privateKey)], true);
  const submit = (activeRpc, { allowOrphan = false } = {}) => activeRpc.submitTransaction({ transaction: signed, allowOrphan });
  const txid = await submitConfirmingAcceptance({ rpc, withRpc, submit, txid: signed.id, label: "Max send broadcast", log });
  log("Max send txid:", txid, `(${plan.entries.length} input${plan.entries.length === 1 ? "" : "s"}, one output, fee ${feeSompi} sompi)`);
  return { txids: [txid], amountSompi: amount, feeSompi, outpoints: plan.outpoints };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Back-to-back self-sends (spamming chat/group messages) each spend the wallet's UTXO and
// create a change UTXO that the node's confirmed UTXO set doesn't reflect for a moment. The
// next queued send then finds no spendable UTXO (or tries to spend the just-spent one and the
// mempool rejects it as already-spent/orphan) until the change lands. These are TRANSIENT: a
// short wait + refetch succeeds. We retry ONLY on those UTXO-availability symptoms - never on a
// generic network error (withRpc already handles node failover) or a real "insufficient funds",
// and never after a tx was actually accepted (a returned result never reaches the retry). This
// makes rapid message sending reliable without needing full UTXO-chaining.
function isTransientUtxoError(error) {
  // Part of the send already went out (a chained send's earlier transaction): a retry would
  // rebuild and pay again.
  if (Array.isArray(error?.submittedTxids) && error.submittedTxids.length) return false;
  const m = String(error?.message || error || "").toLowerCase();
  return m.includes("no utxos") ||
    m.includes("insufficient") ||
    m.includes("already spent") ||
    m.includes("orphan") ||
    m.includes("outpoint") ||
    (m.includes("utxo") && m.includes("not found"));
}

async function sendKaspaWithUtxoRetry(params) {
  return retryOnTransientUtxo(() => sendKaspaNow(params), params.log);
}

async function retryOnTransientUtxo(run, log) {
  const maxAttempts = 5;
  const retryDelayMs = 1200;
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await run();
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts || !isTransientUtxoError(error)) throw error;
      log?.(`Send attempt ${attempt} hit a transient UTXO state (${error.message}); retrying in ${retryDelayMs}ms.`);
      await sleep(retryDelayMs);
    }
  }
  throw lastError;
}

// A payload-carrying transaction back to the source address with exactly ONE output of
// (chosen inputs - fee) and no change: iOS KaChatTransactionBuilder.buildSavedHandshakeStashTx.
// Used for the self-stash recovery notes, which carry no amount of their own. Built by hand like
// sweepAllToSelf / sendMaxKaspa: the generator path (a 0.0001 KAS output plus change) leaves a
// tiny output whose KIP-9 storage mass is far over the limit (audit DSK-020). With a single output
// the storage mass is C/out - sum(C/in), which is nil when out is the inputs less a fee.
// Coins are taken largest first (iOS), one at a time until the fee is covered and the mass fits.
export async function sendPayloadToSelf({ kaspa, rpc, withRpc = null, privateKey, sourceAddress, payload, log = () => {} }) {
  if (!payload) throw new Error("Payload is required for a self-stash transaction.");
  return enqueueSend(sourceAddress, () => retryOnTransientUtxo(
    () => sendPayloadToSelfNow({ kaspa, rpc, withRpc, privateKey, sourceAddress, payload, log }),
    log,
  ));
}
async function sendPayloadToSelfNow({ kaspa, rpc, withRpc, privateKey, sourceAddress, payload, log }) {
  let entries = await fetchUtxoEntries({ rpc, withRpc, sourceAddress, label: "Self-stash UTXO refresh" });
  if (!entries || entries.length === 0) throw new Error("No UTXOs found. Fund the receive address first.");
  entries = excludeReservedUtxos(entries);
  if (entries.length === 0) throw new Error("Every coin is reserved by a scheduled post. Wait for it to go out, or cancel it in KaPosts > Scheduled.");
  const sorted = [...entries].sort(bySompiDesc);

  const chosen = [];
  let total = 0n;
  for (const entry of sorted) {
    if (chosen.length >= MAX_INPUTS_PER_SWEEP) break;
    chosen.push(entry);
    total += utxoAmountSompi(entry) ?? 0n;
    // Fee for this exact shape (these inputs, one output, the payload). Undefined means the mass
    // is over the standard limit: take another coin.
    const draft = kaspa.createTransaction(chosen, [{ address: sourceAddress, amount: total - (total / 20n) }], 0n, payload);
    const draftFee = kaspa.calculateTransactionFee(NETWORK_ID, draft, 1);
    if (draftFee == null) continue;
    const amount = total - BigInt(draftFee);
    if (amount <= 0n) continue;
    const tx = kaspa.createTransaction(chosen, [{ address: sourceAddress, amount }], 0n, payload);
    const finalFee = kaspa.calculateTransactionFee(NETWORK_ID, tx, 1);
    if (finalFee == null || BigInt(finalFee) > BigInt(draftFee)) continue;
    const signed = kaspa.signTransaction(tx, [signingKeyArg(privateKey)], true);
    const submit = (activeRpc, { allowOrphan = false } = {}) => activeRpc.submitTransaction({ transaction: signed, allowOrphan });
    const txid = await submitConfirmingAcceptance({ rpc, withRpc, submit, txid: signed.id, label: "Self-stash broadcast", log });
    log("Self-stash txid:", txid, `(${chosen.length} input${chosen.length === 1 ? "" : "s"}, one output, fee ${draftFee} sompi)`);
    return { txids: [txid], amountSompi: amount, feeSompi: BigInt(draftFee) };
  }
  throw new Error("Balance too low to pay the self-stash network fee.");
}

// The SDK takes a private key as "a string or an instance of PrivateKey". The string form can
// never go stale, so a live key object is handed over as its hex; a dead one (freed, or minted
// by another module instance) cannot produce hex and goes through as-is for the SDK to judge.
function signingKeyArg(privateKey) {
  if (typeof privateKey === "string") return privateKey;
  try {
    const hex = privateKey?.__wbg_ptr ? String(privateKey.toString()) : "";
    return /^[0-9a-f]{64}$/i.test(hex) ? hex : privateKey;
  } catch {
    return privateKey;
  }
}

function describeKey(privateKey) {
  if (typeof privateKey === "string") return "key: hex string";
  if (!privateKey) return "key: missing";
  return `key: ${privateKey.constructor?.name || typeof privateKey} ptr=${privateKey.__wbg_ptr ?? "n/a"}`;
}

async function sendKaspaNow({ kaspa, rpc, withRpc = null, privateKey, sourceAddress, destinationAddress, amountKas, feeKas = "0", extraFeeSompi = 0n, payload = null, selectedOutpoints = null, changeAddress = null, singleInput = false, exactAmount = false, log = () => {} }) {
  const to = validateMainnetAddress(destinationAddress);
  const amount = String(amountKas ?? "").trim();
  // Exact sompi (engine/amounts.js, iOS IOS-010): "1,5" is 1.5 KAS, never NaN, and an absurd
  // amount is refused here rather than reaching the SDK, whose kaspaToSompi panics on it.
  const amountSompi = kasToSompi(amountKas);
  if (amountSompi == null || amountSompi <= 0n) throw new Error("Amount must be greater than 0.");
  const feeSompi = kasToSompi(feeKas || "0");
  if (feeSompi == null) throw new Error("The network fee is not a valid amount.");
  // The priority fee on top of the generator's own minimum: feeKas plus any extra in sompi.
  const prioritySompi = feeSompi + extraFeeSompiFrom(extraFeeSompi);

  let entries = await fetchUtxoEntries({ rpc, withRpc, sourceAddress, label: "UTXO refresh" });
  if (!entries || entries.length === 0) throw new Error("No UTXOs found. Fund the receive address first.");
  entries = excludeReservedUtxos(entries);
  if (entries.length === 0) throw new Error("Every coin is reserved by a scheduled post. Wait for it to go out, or cancel it in KaPosts > Scheduled.");

  // Coin control: if the caller picked specific UTXOs, spend only those (mirrors
  // iOS's manualUtxos). An outpoint is keyed as "transactionId:index".
  if (selectedOutpoints && selectedOutpoints.length) {
    const wanted = new Set(selectedOutpoints);
    entries = entries.filter((entry) => {
      const outpoint = entry.outpoint || {};
      return wanted.has(`${outpoint.transactionId}:${outpoint.index}`);
    });
    if (entries.length === 0) throw new Error("None of the selected UTXOs are still available. Refresh and try again.");
  }
  // An arena message spends one coin when one can carry it, so the fee is the one-input fee
  // the label promised (mobile parity); a wallet of only small coins falls back to the usual pick.
  if (singleInput && !selectedOutpoints?.length) {
    const one = singleInputFor(entries, amountSompi);
    if (one) entries = one;
  }
  entries.sort(bySompiAsc);

  if (payload) {
    const payloadKind = payload instanceof Uint8Array ? "Uint8Array" : typeof payload;
    const payloadLength = payload instanceof Uint8Array ? payload.length : String(payload).length;
    log("Payload:", payloadKind, payloadLength, "bytes/chars");
  }
  // iOS KaChatTransactionBuilder, after KIP-9: a wallet that holds a message's or handshake's
  // nominal amount but not a fee on top spends everything it has into ONE output of (total - fee).
  // A message is a self-spend and a handshake is recognised by payload, not by amount, so a
  // little under the nominal figure serves just as well - and it is the only way an account
  // funded by a 0.2 KAS handshake can ever answer it. Protocol sends only (self-spends and
  // payload-carrying sends); a plain payment keeps the strict path and its "insufficient funds".
  // A chat payment carries its (encrypted) payment payload too, but it must pay exactly what was
  // asked for, so `exactAmount` keeps it on the strict path.
  const protocolSend = !exactAmount && (to === sourceAddress || Boolean(payload));
  if (protocolSend && entries.length <= 80) {
    const totalSompi = totalUtxoSompi(entries);
    if (totalSompi >= amountSompi / 2n) {
      const draft = kaspa.createTransaction(entries, [{ address: to, amount: totalSompi - (totalSompi / 20n) }], 0n, payload || undefined);
      const floorFee = BigInt(kaspa.calculateTransactionFee(NETWORK_ID, draft, 1) ?? 0n);
      const totalFee = floorFee + prioritySompi;
      if (totalSompi < amountSompi + totalFee && totalSompi > totalFee) {
        const reduced = totalSompi - totalFee;
        log(`Balance holds the amount but not the fee; sending ${reduced} sompi as one output (total minus fee).`);
        const tx = kaspa.createTransaction(entries, [{ address: to, amount: reduced }], 0n, payload || undefined);
        const signed = kaspa.signTransaction(tx, [signingKeyArg(privateKey)], true);
        const submitReduced = (activeRpc, { allowOrphan = false } = {}) => activeRpc.submitTransaction({ transaction: signed, allowOrphan });
        const txid = await submitConfirmingAcceptance({ rpc, withRpc, submit: submitReduced, txid: signed.id, label: "Transaction broadcast", log });
        log("Broadcast txid:", txid);
        return { result: { summary: { reduced: true, amountSompi: reduced, feeSompi: totalFee } }, txids: [txid] };
      }
    }
  }

  // Change goes where the caller says (a fresh spending address when the primary spends, see
  // ui/app.js freshChangeForSpendingIndex) and otherwise back to the source.
  const changeTo = changeAddress ? validateMainnetAddress(changeAddress) : sourceAddress;
  log("Creating transaction from", sourceAddress, "to", to, "amount", amount, "KAS", changeTo !== sourceAddress ? `(change to ${changeTo})` : "");
  const result = await kaspa.createTransactions({
    entries,
    outputs: [{ address: to, amount: amountSompi }],
    priorityFee: prioritySompi,
    changeAddress: changeTo,
    networkId: NETWORK_ID,
    ...(payload ? { payload } : {}),
  });
  log("Transaction summary:", result.summary);

  const txids = [];
  const signer = signingKeyArg(privateKey);
  for (const pending of result.transactions) {
    try {
      await pending.sign([signer]);
    } catch (error) {
      log("Signing failed:", describeKey(privateKey), String(error));
      throw error;
    }
    // pending.submit() never allows an orphan; the orphan-allowed resubmit sends the same signed
    // transaction through submitTransaction itself.
    const submitSignedTransaction = (activeRpc, { allowOrphan = false } = {}) => (allowOrphan
      ? activeRpc.submitTransaction({ transaction: pending.transaction, allowOrphan: true })
      : pending.submit(activeRpc));
    let localId = null;
    try { localId = pending.id ? String(pending.id) : null; } catch { localId = null; }
    let txid;
    try {
      txid = await submitConfirmingAcceptance({ rpc, withRpc, submit: submitSignedTransaction, txid: localId, label: "Transaction broadcast", log });
    } catch (error) {
      // A chained send whose earlier transactions went out: never retried (that would pay again).
      if (txids.length) error.submittedTxids = [...txids];
      throw error;
    }
    txids.push(txid);
    log("Broadcast txid:", txid);
  }
  return { result, txids };
}


// Builds (but never signs or submits) a representative transaction to read
// its real, SDK-calculated network fee back out of the generator summary —
// used for the composer's "Show Fee Estimate" preference. payloadBytes is an
// estimate of the real Kasia COMM payload's byte length for the draft text,
// since mass (and therefore fee) scales with payload size.
// Builds the representative tx and returns { feeSompi, massGrams } from the generator summary.
export async function estimateOnchainFeeDetail({ kaspa, rpc, withRpc = null, sourceAddress, amountKas = "0.2", payloadBytes = 0, selectedOutpoints = null, singleInput = false }) {
  // An amount that isn't one (or is past the supply) has no estimate, rather than a WASM panic.
  const amountSompi = kasToSompi(amountKas);
  if (amountSompi == null) return null;
  let entries = await fetchUtxoEntries({ rpc, withRpc, sourceAddress, label: "Fee estimate UTXO refresh" });
  if (!entries || entries.length === 0) return null;
  // Coins a scheduled post already spends are off the table for the estimate, as for the send.
  entries = excludeReservedUtxos(entries);
  if (entries.length === 0) return null;
  // Coin control: estimate against exactly the chosen UTXOs (matches iOS passing manualUtxos to
  // its fee estimate) so the fee reflects those inputs' mass, not an automatic selection.
  if (selectedOutpoints && selectedOutpoints.length) {
    const wanted = new Set(selectedOutpoints);
    entries = entries.filter((entry) => {
      const outpoint = entry.outpoint || {};
      return wanted.has(`${outpoint.transactionId}:${outpoint.index}`);
    });
    if (entries.length === 0) return null;
  }
  if (singleInput && !selectedOutpoints?.length) {
    const one = singleInputFor(entries, amountSompi);
    if (one) entries = one;
  }
  entries.sort(bySompiAsc);

  const result = await kaspa.createTransactions({
    entries,
    outputs: [{ address: sourceAddress, amount: amountSompi }],
    priorityFee: 0n,
    changeAddress: sourceAddress,
    networkId: NETWORK_ID,
    payload: new Uint8Array(Math.max(0, payloadBytes)),
  });
  const feesSompi = result.summary?.fees;
  if (feesSompi == null) return null;
  const massGrams = result.summary?.mass;
  return { feeSompi: BigInt(feesSompi), massGrams: massGrams != null ? BigInt(massGrams) : 0n };
}

export async function estimateOnchainFee(opts) {
  const detail = await estimateOnchainFeeDetail(opts);
  return detail ? sompiToKaspaDisplay(opts.kaspa, detail.feeSompi) : null;
}

// Fee-rate policy matching iOS's KaspaFeePolicy.minimumRelayFeePerGramSompi (100 sompi per gram).
// The WASM SDK's own `summary.fees` uses the ~1 sompi/gram network floor, which is ~100x lower
// than what iOS/kassigner charge, so a fee estimate needs to apply this policy explicitly.
const POLICY_SOMPI_PER_GRAM = 100n;

// Estimate for the Send screen: returns the SDK's own base fee AND the policy fee (mass * 100),
// both as KAS strings. The UI shows the policy fee (like iOS) and pays the difference as a
// priority tip on top of the SDK's automatic base.
export async function estimateSendFeeDetail(opts) {
  const detail = await estimateOnchainFeeDetail(opts);
  if (!detail) return null;
  const policySompi = detail.massGrams * POLICY_SOMPI_PER_GRAM;
  const effectiveSompi = policySompi > detail.feeSompi ? policySompi : detail.feeSompi;
  return {
    sdkFeeKas: sompiToKaspaDisplay(opts.kaspa, detail.feeSompi),
    policyFeeKas: sompiToKaspaDisplay(opts.kaspa, effectiveSompi),
    // The same two figures as BigInt sompi, for screens that do fee arithmetic (the chat Send
    // KAS sheet's Fast / Priority / custom extra).
    sdkFeeSompi: detail.feeSompi,
    policyFeeSompi: effectiveSompi,
  };
}

export async function sendPayloadTransaction({
  kaspa,
  rpc,
  withRpc = null,
  privateKey,
  sourceAddress,
  destinationAddress,
  amountKas = "0.0001",
  feeKas = "0",
  payload,
  changeAddress = null,
  singleInput = false,
  log = () => {},
}) {
  if (!payload) throw new Error("Payload is required for a message transaction.");
  return sendKaspa({
    kaspa,
    rpc,
    withRpc,
    privateKey,
    sourceAddress,
    destinationAddress,
    amountKas,
    feeKas,
    payload,
    changeAddress,
    singleInput,
    log,
  });
}
