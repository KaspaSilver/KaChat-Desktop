// ChangeNOW Swap: the coins, the API client and the quote logic (iOS SwapModels.swift,
// ChangeNowAPIClient.swift and SwapService's live quote, as they were at f94db5a^ with 4b9da6a and
// 2eebb70). No DOM here, so tools/test-swap-quote.mjs runs it against a mocked ChangeNOW.
//
// The client never holds or sends an API key. Every call goes to the same-origin relay
// (tools/relay-guard.mjs), which attaches the server's key to exactly these four calls and drops
// any key header a page sends.

export const CHANGENOW_BASE = "https://api.changenow.io";

// ---------------------------------------------------------------------------
// Coins (iOS SwapModels.SwapCoin). KAS is always one side of the pair. Every (ticker, network)
// pair was checked against ChangeNOW's live /v2/exchange/currencies list on iOS; getting one
// wrong would send a payout to the wrong chain, so none of this is guessed.
// ---------------------------------------------------------------------------
export const KAS = Object.freeze({ ticker: "kas", network: "kas", displayName: "Kaspa" });
export const CURATED_COINS = Object.freeze([
  { ticker: "btc", network: "btc", displayName: "Bitcoin" },
  { ticker: "eth", network: "eth", displayName: "Ethereum" },
  { ticker: "sol", network: "sol", displayName: "Solana" },
  { ticker: "xrp", network: "xrp", displayName: "XRP" },
  { ticker: "bnb", network: "bsc", displayName: "BNB (BNB Smart Chain)" },
  { ticker: "trx", network: "trx", displayName: "TRON" },
  { ticker: "hype", network: "hyperevm", displayName: "Hyperliquid" },
  { ticker: "doge", network: "doge", displayName: "Dogecoin" },
  { ticker: "ltc", network: "ltc", displayName: "Litecoin" },
  { ticker: "zec", network: "zec", displayName: "Zcash" },
  { ticker: "xmr", network: "xmr", displayName: "Monero" },
  { ticker: "ada", network: "ada", displayName: "Cardano" },
  { ticker: "bch", network: "bch", displayName: "Bitcoin Cash" },
  { ticker: "etc", network: "etc", displayName: "Ethereum Classic" },
  { ticker: "usdt", network: "eth", displayName: "Tether (ERC20)" },
  { ticker: "usdt", network: "trx", displayName: "Tether (TRC20)" },
  { ticker: "usdt", network: "bsc", displayName: "Tether (BNB Smart Chain)" },
  { ticker: "usdt", network: "sol", displayName: "Tether (Solana)" },
  { ticker: "usdt", network: "matic", displayName: "Tether (Polygon)" },
  { ticker: "usdt", network: "arbitrum", displayName: "Tether (Arbitrum)" },
  { ticker: "usdt", network: "op", displayName: "Tether (Optimism)" },
  { ticker: "usdc", network: "matic", displayName: "USDC Coin (Polygon)" },
  { ticker: "usdc", network: "eth", displayName: "USDC Coin (Ethereum)" },
  { ticker: "usdc", network: "sol", displayName: "USDC Coin (Solana)" },
  { ticker: "usdc", network: "bsc", displayName: "USDC Coin (BNB Smart Chain)" },
  { ticker: "usdc", network: "algo", displayName: "USDC Coin (Algorand)" },
  { ticker: "usdc", network: "op", displayName: "USDC Coin (Optimism)" },
  { ticker: "usdc", network: "arbitrum", displayName: "USDC Coin (Arbitrum)" },
  { ticker: "usdc", network: "base", displayName: "USDC Coin (Base)" },
  { ticker: "usdc", network: "sui", displayName: "USDC Coin (Sui)" },
].map((coin) => Object.freeze(coin)));
/** iOS SwapService.otherCoin's default: USDC on Polygon (ChangeNOW's network code is "matic"). */
export const USDC_POLYGON = CURATED_COINS.find((c) => c.ticker === "usdc" && c.network === "matic");
/** Tickers with more than one network: one row in the picker that expands in place. */
export const GROUPED_TICKERS = Object.freeze({ usdt: "Tether", usdc: "USD Coin" });
/** USDC and USDT pinned as the picker's first two rows, in that order. */
export const PINNED_GROUP_TICKERS = Object.freeze(["usdc", "usdt"]);

export function sameCoin(a, b) {
  return Boolean(a && b && a.ticker === b.ticker && a.network === b.network);
}

/** Plain decimal text for a quoted amount: up to 8 places, trailing zeros trimmed, never scientific
 *  notation (iOS SwapService.formatQuotedAmount). Shown in the card and, for a "You Get" quote,
 *  sent back to ChangeNOW as the send amount the exchange is created with. */
export function formatQuotedAmount(value) {
  let text = Number(value).toFixed(8);
  while (text.endsWith("0")) text = text.slice(0, -1);
  if (text.endsWith(".")) text = text.slice(0, -1);
  return text;
}

/** Rounds up at the eighth place, so a payout errs toward the target, not under it. */
function ceil8(value) {
  return Math.ceil(value * 100_000_000) / 100_000_000;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** What the swap screen shows when this site has no ChangeNOW key (the relay's 503). */
export const SWAP_UNAVAILABLE_TITLE = "Swap is not available right now";

export class SwapUnavailableError extends Error {
  constructor() {
    super(`${SWAP_UNAVAILABLE_TITLE}.`);
    this.name = "SwapUnavailableError";
    this.unavailable = true;
  }
}

/** iOS ChangeNowError.httpError: ChangeNOW's 4xx bodies carry the real reason, so the first 300
 *  characters of the body go into the message rather than a bare status code. */
export class ChangeNowError extends Error {
  constructor(status, body = "") {
    const text = String(body || "").slice(0, 300);
    super(text ? `ChangeNOW error (${status}): ${text}` : `ChangeNOW error (${status}).`);
    this.name = "ChangeNowError";
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// ChangeNOW v2 client (iOS ChangeNowAPIClient)
// ---------------------------------------------------------------------------

/**
 * @param {object} options
 * @param {function} options.fetchImpl  (url, init) => Promise<Response>
 * @param {function} [options.urlFor]   (absoluteChangeNowUrl) => the URL actually fetched (the relay)
 * @param {number}   [options.timeoutMs] per request (iOS: 20 s, so a quote fails fast enough to retry)
 */
export function createChangeNowClient({ fetchImpl, urlFor = (url) => url, timeoutMs = 20_000 } = {}) {
  if (typeof fetchImpl !== "function") throw new Error("createChangeNowClient needs fetchImpl");

  async function request(path, { query = null, method = "GET", body = null } = {}) {
    const url = new URL(`${CHANGENOW_BASE}${path}`);
    if (query) for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      // Never a key header: the relay adds the server's, and only to these calls.
      const headers = { Accept: "application/json" };
      if (body) headers["Content-Type"] = "application/json";
      const response = await fetchImpl(urlFor(url.toString()), {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        cache: "no-store",
        signal: controller?.signal,
      });
      const text = await response.text();
      if (!response.ok) {
        if (response.status === 503 && String(response.headers?.get?.("x-kachat-swap") || "") === "unavailable") {
          throw new SwapUnavailableError();
        }
        // The relay's own per-client swap limit (tools/relay-guard.mjs), not ChangeNOW's.
        if (response.status === 429 && text.trim() === "Too many swap requests") {
          throw new Error("Too many swap requests. Try again in a minute.");
        }
        throw new ChangeNowError(response.status, text);
      }
      return text ? JSON.parse(text) : {};
    } catch (error) {
      if (error?.name === "AbortError") throw new Error("The request timed out.");
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  const pair = (from, to) => ({
    fromCurrency: from.ticker, fromNetwork: from.network, toCurrency: to.ticker, toNetwork: to.network,
  });

  return {
    /** A live quote: how much `to` a given `fromAmount` converts to right now. */
    estimate: (from, to, fromAmount) => request("/v2/exchange/estimated-amount", {
      query: { ...pair(from, to), fromAmount, flow: "standard" },
    }),
    /** The smallest `fromAmount` ChangeNOW takes for this pair on the standard flow. */
    minAmount: async (from, to) => {
      const response = await request("/v2/exchange/min-amount", { query: { ...pair(from, to), flow: "standard" } });
      const min = Number(response?.minAmount);
      if (!Number.isFinite(min)) throw new Error("ChangeNOW did not return a minimum for this pair.");
      return min;
    },
    /** Opens an exchange; its payinAddress is where the "from" coin has to arrive. */
    create: (from, to, fromAmount, address) => request("/v2/exchange", {
      method: "POST",
      body: { ...pair(from, to), fromAmount, address, flow: "standard" },
    }),
    /** Status of an exchange created earlier. */
    status: (id) => request("/v2/exchange/by-id", { query: { id } }),
  };
}

// ---------------------------------------------------------------------------
// Quotes (iOS SwapService.rescheduleEstimate / linearQuote / reverseQuote)
// ---------------------------------------------------------------------------

/**
 * Both directions of the live quote.
 *
 * "You Send" typed: one direct quote; its toAmount fills "You Get".
 * "You Get" typed: ChangeNOW has no reverse quote on the standard flow ("unsupported now in
 * standard flow"), but a standard-flow quote is a straight line in the send amount (the rate after
 * the deposit fee, the withdrawal fee off the top). The pair's line is pinned from the minimum and
 * two direct quotes at 2x and 20x it (cached a minute), solved for the target, and the answer
 * confirmed with a real direct quote at that amount - its toAmount is what ChangeNOW itself says
 * lands. One refinement when the confirmation is more than 0.2% off. A target the pair's minimum
 * cannot reach fails with what the minimum gets instead.
 */
export function createSwapQuoter(client, { now = () => Date.now(), ttlMs = 60_000 } = {}) {
  const lines = new Map(); // "from>to" -> { slope, intercept, minFrom, fetchedAt }

  async function linearQuote(from, to) {
    const key = `${from.ticker}/${from.network}>${to.ticker}/${to.network}`;
    const cached = lines.get(key);
    if (cached && now() - cached.fetchedAt < ttlMs) return cached;
    const minFrom = await client.minAmount(from, to);
    // Two probes well inside the accepted range, a decade apart so fee rounding cannot tilt the slope.
    const lowFrom = minFrom * 2;
    const highFrom = minFrom * 20;
    const [low, high] = await Promise.all([
      client.estimate(from, to, formatQuotedAmount(lowFrom)),
      client.estimate(from, to, formatQuotedAmount(highFrom)),
    ]);
    const lowX = Number(low?.fromAmount ?? lowFrom);
    const highX = Number(high?.fromAmount ?? highFrom);
    const slope = (Number(high?.toAmount) - Number(low?.toAmount)) / (highX - lowX);
    if (!(slope > 0) || !Number.isFinite(slope)) throw new Error("ChangeNOW returned an unusable rate for this pair");
    const line = { slope, intercept: Number(low.toAmount) - slope * lowX, minFrom, fetchedAt: now() };
    lines.set(key, line);
    return line;
  }

  async function reverseQuote(from, to, target) {
    const line = await linearQuote(from, to);
    let sendAmount = ceil8((target - line.intercept) / line.slope);
    if (!(sendAmount >= line.minFrom)) {
      const minTo = line.slope * line.minFrom + line.intercept;
      throw new Error(`Minimum you can get is about ${formatQuotedAmount(minTo)} ${to.displayName}`);
    }
    let confirmed = await client.estimate(from, to, formatQuotedAmount(sendAmount));
    if (Math.abs(Number(confirmed?.toAmount) - target) / target > 0.002) {
      sendAmount += (target - Number(confirmed.toAmount)) / line.slope;
      sendAmount = Math.max(line.minFrom, ceil8(sendAmount));
      confirmed = await client.estimate(from, to, formatQuotedAmount(sendAmount));
    }
    return confirmed;
  }

  /**
   * One quote for what the person typed. `side` is "send" (typed under You Send) or "get" (typed
   * under You Get). Resolves { fromAmount, toAmount, sendText, getText }: both figures are
   * ChangeNOW's, and the typed card's text comes back as it was typed.
   */
  async function quote({ side, from, to, amountText }) {
    const typed = String(amountText ?? "").trim();
    const amount = Number(typed);
    if (!typed || !Number.isFinite(amount) || amount <= 0) throw new Error("Enter an amount");
    const response = side === "get"
      ? await reverseQuote(from, to, amount)
      : await client.estimate(from, to, typed);
    const fromAmount = Number(response?.fromAmount ?? (side === "get" ? NaN : amount));
    const toAmount = Number(response?.toAmount);
    if (!Number.isFinite(fromAmount) || !Number.isFinite(toAmount)) throw new Error("ChangeNOW returned an unusable rate for this pair");
    return {
      fromAmount,
      toAmount,
      sendText: side === "get" ? formatQuotedAmount(fromAmount) : typed,
      getText: side === "get" ? typed : formatQuotedAmount(toAmount),
    };
  }

  return { quote, reverseQuote, linearQuote, clearCache: () => lines.clear() };
}

/** The rate line under the cards (iOS rateText): "1 X ≈ 0.12345678 Y", from the quote itself. */
export function rateLine({ fromAmount, toAmount, fromLabel, toLabel }) {
  if (!(Number(fromAmount) > 0)) return "N/A";
  return `1 ${fromLabel} ≈ ${(Number(toAmount) / Number(fromAmount)).toFixed(8)} ${toLabel}`;
}

/** What a finished swap adds to a portfolio (iOS SwapService.portfolioPrefill): a buy when KAS came
 *  in, a sell when it went out, the other coin's amount as its value. Null when the amounts can't
 *  be read. */
export function portfolioPrefill(swap) {
  const kasReceived = swap?.toTicker === "kas";
  const kasText = kasReceived ? swap?.toAmount : swap?.fromAmount;
  const otherText = kasReceived ? swap?.fromAmount : swap?.toAmount;
  const amountKas = kasText === "" || kasText == null ? NaN : Number(kasText);
  const fiatValue = otherText === "" || otherText == null ? NaN : Number(otherText);
  if (!Number.isFinite(amountKas) || !Number.isFinite(fiatValue)) return null;
  return {
    type: kasReceived ? "buy" : "sell",
    amountKas,
    fiatValue,
    timestamp: Number(swap.createdAt) || Date.now(),
    notes: `ChangeNOW swap ${swap.id}`,
  };
}

/** The key a ChangeNOW swap is recorded under in a portfolio (iOS PortfolioViewModel.swapSourceTxId):
 *  namespaced so it can never collide with a Kaspa txid. */
export function swapSourceTxId(swapId) {
  return `changenow:${swapId}`;
}
