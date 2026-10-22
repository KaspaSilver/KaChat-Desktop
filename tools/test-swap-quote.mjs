// ChangeNOW Swap quote logic (ui/swap-quote.js; iOS SwapService + ChangeNowAPIClient at f94db5a^
// with 4b9da6a and 2eebb70), against a MOCKED ChangeNOW. Nothing here reaches api.changenow.io and
// no real exchange is ever created. Run from the repo root:
//
//   node tools/test-swap-quote.mjs
//
// Covers both directions of the quote (typed "You Send" -> direct quote, typed "You Get" -> the
// pair's line from min-amount + two probes, solved and confirmed, one refinement), the minimum,
// the 60 s line cache, the client's errors (ChangeNOW 4xx body, the relay's 503 "not available" and
// its 429), that the client never sends a key, and the whole path page -> relay -> ChangeNOW with
// the server's key attached by the relay.
import http from "node:http";
import assert from "node:assert/strict";
import { createRelay, CHANGENOW_KEY_HEADER } from "./relay-guard.mjs";
import {
  KAS, USDC_POLYGON, CURATED_COINS, formatQuotedAmount, createChangeNowClient, createSwapQuoter,
  rateLine, portfolioPrefill, swapSourceTxId, SwapUnavailableError,
} from "../ui/swap-quote.js";

let failures = 0;
let passes = 0;
async function test(name, fn) {
  try { await fn(); passes += 1; console.log(`ok   ${name}`); }
  catch (error) { failures += 1; console.log(`FAIL ${name} -- ${error?.message || error}`); }
}

const USDT_TRC20 = CURATED_COINS.find((c) => c.ticker === "usdt" && c.network === "trx");

// ---------------------------------------------------------------------------------------------
// An in-memory ChangeNOW. A standard-flow quote is a straight line in the send amount:
// to = rate * (from - depositFee) - withdrawalFee. `drift` moves the rate after the probes, the
// way a live rate ticks between the probes and the confirming quote.
// ---------------------------------------------------------------------------------------------
function mockChangeNow({ rate = 7.5, depositFee = 0.3, withdrawalFee = 2, min = 2.5 } = {}) {
  const calls = [];
  const state = { rate, depositFee, withdrawalFee, min, estimates: 0, driftAfter: Infinity, driftRate: rate };
  const quoteFor = (from) => {
    const r = state.estimates > state.driftAfter ? state.driftRate : state.rate;
    return Math.max(0, r * (from - state.depositFee) - state.withdrawalFee);
  };
  const client = {
    async minAmount(from, to) { calls.push({ kind: "min", from, to }); return state.min; },
    async estimate(from, to, fromAmount) {
      assert.equal(typeof fromAmount, "string", "amounts go to ChangeNOW as plain decimal text");
      assert.ok(!/e/i.test(fromAmount), `no scientific notation: ${fromAmount}`);
      state.estimates += 1;
      calls.push({ kind: "estimate", from, to, fromAmount });
      const x = Number(fromAmount);
      return { fromAmount: x, toAmount: quoteFor(x), transactionSpeedForecast: "10-60", warningMessage: null };
    },
  };
  return { client, calls, state };
}

// --- formatting ------------------------------------------------------------------------------
await test("formatQuotedAmount: 8 places, trailing zeros and dot trimmed, never scientific", () => {
  assert.equal(formatQuotedAmount(1.234567891234), "1.23456789");
  assert.equal(formatQuotedAmount(100), "100");
  assert.equal(formatQuotedAmount(12.5), "12.5");
  assert.equal(formatQuotedAmount(0.1 + 0.2), "0.3");
  assert.equal(formatQuotedAmount(1e-9), "0");
  assert.equal(formatQuotedAmount(0.00000001), "0.00000001");
  assert.equal(formatQuotedAmount(123456789.5), "123456789.5");
  assert.equal(formatQuotedAmount(1e21 / 1e13), "100000000");
});

await test("rate line: 1 X ≈ y Y from the quote's own figures", () => {
  assert.equal(rateLine({ fromAmount: 10, toAmount: 71.5, fromLabel: "USDC Coin (Polygon)", toLabel: "KAS" }), "1 USDC Coin (Polygon) ≈ 7.15000000 KAS");
  assert.equal(rateLine({ fromAmount: 0, toAmount: 5, fromLabel: "KAS", toLabel: "Bitcoin" }), "N/A");
});

await test("coins: KAS is kas/kas, the default other coin is USDC on Polygon (matic), 30 curated pairs", () => {
  assert.deepEqual({ ...KAS }, { ticker: "kas", network: "kas", displayName: "Kaspa" });
  assert.deepEqual({ ...USDC_POLYGON }, { ticker: "usdc", network: "matic", displayName: "USDC Coin (Polygon)" });
  assert.equal(CURATED_COINS.length, 30);
  assert.equal(new Set(CURATED_COINS.map((c) => `${c.ticker}/${c.network}`)).size, 30);
});

// --- "You Send" typed: one direct quote ---------------------------------------------------------
await test("You Send -> You Get: one direct quote with the typed text, You Get is its toAmount", async () => {
  const { client, calls } = mockChangeNow();
  const quoter = createSwapQuoter(client);
  const q = await quoter.quote({ side: "send", from: USDC_POLYGON, to: KAS, amountText: "10" });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { kind: "estimate", from: USDC_POLYGON, to: KAS, fromAmount: "10" });
  assert.equal(q.sendText, "10", "the typed card keeps what was typed");
  assert.equal(q.getText, formatQuotedAmount(7.5 * (10 - 0.3) - 2));
  assert.equal(q.fromAmount, 10);
  assert.equal(q.toAmount, 7.5 * (10 - 0.3) - 2);
});

await test("KAS -> other coin works the same way round", async () => {
  const { client, calls } = mockChangeNow({ rate: 0.08, depositFee: 1, withdrawalFee: 0.5, min: 60 });
  const q = await createSwapQuoter(client).quote({ side: "send", from: KAS, to: USDT_TRC20, amountText: "1000" });
  assert.equal(calls[0].from, KAS);
  assert.equal(calls[0].to, USDT_TRC20);
  assert.equal(q.getText, formatQuotedAmount(0.08 * (1000 - 1) - 0.5));
});

await test("an empty, zero or non-numeric amount is not quoted", async () => {
  const { client, calls } = mockChangeNow();
  const quoter = createSwapQuoter(client);
  for (const text of ["", "0", "-5", "abc", "  "]) {
    await assert.rejects(quoter.quote({ side: "send", from: USDC_POLYGON, to: KAS, amountText: text }));
  }
  assert.equal(calls.length, 0);
});

// --- "You Get" typed: derived from direct quotes -----------------------------------------------
await test("You Get -> You Send: min-amount, probes at 2x and 20x the minimum, then one confirming quote", async () => {
  const { client, calls, state } = mockChangeNow();
  const quoter = createSwapQuoter(client);
  const target = 1000;
  const q = await quoter.quote({ side: "get", from: USDC_POLYGON, to: KAS, amountText: "1000" });
  assert.deepEqual(calls.map((c) => c.kind), ["min", "estimate", "estimate", "estimate"]);
  assert.deepEqual(calls.slice(1, 3).map((c) => c.fromAmount).sort(), [formatQuotedAmount(state.min * 2), formatQuotedAmount(state.min * 20)].sort());
  // The line is exact here, so the solved amount is the true one, rounded UP at the 8th place.
  const exact = (target + state.withdrawalFee) / state.rate + state.depositFee;
  const sent = Number(calls[3].fromAmount);
  assert.ok(sent >= exact - 1e-12 && sent - exact < 1.01e-8, `send ${sent} vs exact ${exact}`);
  assert.equal(q.sendText, formatQuotedAmount(sent), "You Send is the confirmed quote's fromAmount");
  assert.equal(q.getText, "1000", "the typed card keeps what was typed");
  assert.ok(q.toAmount >= target, "rounded up: the payout errs toward the target, not under it");
  assert.ok(Math.abs(q.toAmount - target) / target <= 0.002);
});

await test("You Get: the pair's line is cached for 60 s, then fetched again", async () => {
  const { client, calls } = mockChangeNow();
  let clock = 1_000_000;
  const quoter = createSwapQuoter(client, { now: () => clock });
  await quoter.quote({ side: "get", from: USDC_POLYGON, to: KAS, amountText: "500" });
  calls.length = 0;
  clock += 59_000;
  await quoter.quote({ side: "get", from: USDC_POLYGON, to: KAS, amountText: "700" });
  assert.deepEqual(calls.map((c) => c.kind), ["estimate"], "within a minute: only the confirming quote");
  calls.length = 0;
  clock += 2_000;
  await quoter.quote({ side: "get", from: USDC_POLYGON, to: KAS, amountText: "700" });
  assert.deepEqual(calls.map((c) => c.kind), ["min", "estimate", "estimate", "estimate"], "after a minute: the line again");
  // Another pair has its own line.
  calls.length = 0;
  await quoter.quote({ side: "get", from: USDT_TRC20, to: KAS, amountText: "700" });
  assert.equal(calls[0].kind, "min");
});

await test("You Get: a rate that moved since the probes is refined once (more than 0.2% off)", async () => {
  const { client, calls, state } = mockChangeNow();
  state.driftAfter = 2;          // the two probes see 7.5, the confirmation and refinement 7.35 (-2%)
  state.driftRate = 7.35;
  const target = 2000;
  const q = await createSwapQuoter(client).quote({ side: "get", from: USDC_POLYGON, to: KAS, amountText: String(target) });
  assert.deepEqual(calls.map((c) => c.kind), ["min", "estimate", "estimate", "estimate", "estimate"]);
  const first = Number(calls[3].fromAmount);
  const firstGot = 7.35 * (first - 0.3) - 2;
  const refined = Math.ceil((first + (target - firstGot) / 7.5) * 1e8) / 1e8;
  assert.equal(calls[4].fromAmount, formatQuotedAmount(refined), "send += (target - got) / slope, rounded up");
  assert.equal(q.sendText, formatQuotedAmount(refined));
  assert.ok(Math.abs(q.toAmount - target) / target < 0.002);
});

await test("You Get: within 0.2% there is no refinement", async () => {
  const { client, calls, state } = mockChangeNow();
  state.driftAfter = 2;
  state.driftRate = 7.5 * 0.999; // -0.1%
  await createSwapQuoter(client).quote({ side: "get", from: USDC_POLYGON, to: KAS, amountText: "2000" });
  assert.equal(calls.filter((c) => c.kind === "estimate").length, 3);
});

await test("You Get: a refinement never goes below the minimum", async () => {
  const { client, calls, state } = mockChangeNow({ min: 2.5 });
  // What the minimum gets: 7.5 * (2.5 - 0.3) - 2 = 14.5. Ask for a hair over it, then let the rate
  // jump up so the refinement would undershoot the minimum.
  state.driftAfter = 2;
  state.driftRate = 9;
  await createSwapQuoter(client).quote({ side: "get", from: USDC_POLYGON, to: KAS, amountText: "14.6" });
  const last = calls[calls.length - 1];
  assert.ok(Number(last.fromAmount) >= state.min, `refined ${last.fromAmount} >= min ${state.min}`);
});

await test("You Get below what the minimum gets: fails with the least you can get, before any confirming quote", async () => {
  const { client, calls, state } = mockChangeNow({ min: 2.5 });
  const minTo = state.rate * (state.min - state.depositFee) - state.withdrawalFee; // 14.5
  await assert.rejects(
    createSwapQuoter(client).quote({ side: "get", from: USDC_POLYGON, to: KAS, amountText: "10" }),
    (error) => error.message === `Minimum you can get is about ${formatQuotedAmount(minTo)} Kaspa`,
  );
  assert.deepEqual(calls.map((c) => c.kind), ["min", "estimate", "estimate"], "no confirming quote below the minimum");
});

await test("You Get exactly at the minimum's payout is quoted", async () => {
  const { client, state } = mockChangeNow({ min: 2.5 });
  const minTo = state.rate * (state.min - state.depositFee) - state.withdrawalFee;
  const q = await createSwapQuoter(client).quote({ side: "get", from: USDC_POLYGON, to: KAS, amountText: String(minTo + 0.01) });
  assert.ok(Number(q.sendText) >= state.min);
});

await test("You Get: a flat or falling line is refused as unusable", async () => {
  const { client, state } = mockChangeNow();
  state.rate = 0;
  await assert.rejects(
    createSwapQuoter(client).quote({ side: "get", from: USDC_POLYGON, to: KAS, amountText: "100" }),
    /ChangeNOW returned an unusable rate for this pair/,
  );
});

// --- Portfolio hooks ---------------------------------------------------------------------------
await test("Add to Portfolio prefill: KAS in is a buy, KAS out is a sell, unreadable is null", () => {
  const buy = portfolioPrefill({ id: "ex1", fromTicker: "usdc", toTicker: "kas", fromAmount: "10", toAmount: "70.75", createdAt: 1_700_000_000_000 });
  assert.deepEqual(buy, { type: "buy", amountKas: 70.75, fiatValue: 10, timestamp: 1_700_000_000_000, notes: "ChangeNOW swap ex1" });
  const sell = portfolioPrefill({ id: "ex2", fromTicker: "kas", toTicker: "usdt", fromAmount: "1000", toAmount: "79.4", createdAt: 5 });
  assert.equal(sell.type, "sell");
  assert.equal(sell.amountKas, 1000);
  assert.equal(sell.fiatValue, 79.4);
  assert.equal(portfolioPrefill({ id: "ex3", fromTicker: "usdc", toTicker: "kas", fromAmount: "10", toAmount: "" }), null);
  assert.equal(swapSourceTxId("abc"), "changenow:abc");
});

// --- The client, over HTTP, against a mock ChangeNOW server ------------------------------------
let mockSeen = [];
const mockServer = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const url = new URL(req.url, "http://mock");
    mockSeen.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
    const json = (status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (url.pathname === "/v2/exchange/min-amount") return json(200, { fromCurrency: "usdc", minAmount: 2.5 });
    if (url.pathname === "/v2/exchange/estimated-amount") {
      const from = Number(url.searchParams.get("fromAmount"));
      if (from < 2.5) return json(400, { error: "deposit_too_small", message: "Amount is less than minimal" });
      return json(200, { fromAmount: from, toAmount: 7.5 * (from - 0.3) - 2, transactionSpeedForecast: "10-60", warningMessage: null });
    }
    if (url.pathname === "/v2/exchange" && req.method === "POST") {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      return json(200, { id: "mock-exchange-1", payinAddress: "0xMockDepositAddress", payoutAddress: body.address, fromAmount: Number(body.fromAmount), toAmount: 70.75, status: "new" });
    }
    if (url.pathname === "/v2/exchange/by-id") return json(200, { id: url.searchParams.get("id"), status: "finished" });
    return json(404, { message: "not found" });
  });
});
const mockPort = await new Promise((resolve) => mockServer.listen(0, "127.0.0.1", () => resolve(mockServer.address().port)));
const MOCK_ORIGIN = `http://127.0.0.1:${mockPort}`;

await test("client: query, method and body as iOS ChangeNowAPIClient sends them, and never a key", async () => {
  mockSeen = [];
  const client = createChangeNowClient({ fetchImpl: fetch, urlFor: (url) => url.replace("https://api.changenow.io", MOCK_ORIGIN) });
  const estimate = await client.estimate(USDC_POLYGON, KAS, "10");
  assert.equal(estimate.toAmount, 7.5 * 9.7 - 2);
  assert.equal(await client.minAmount(USDC_POLYGON, KAS), 2.5);
  const created = await client.create(USDC_POLYGON, KAS, "10", "kaspa:qtestpayout");
  assert.equal(created.payinAddress, "0xMockDepositAddress");
  assert.equal((await client.status("mock-exchange-1")).status, "finished");
  assert.deepEqual(mockSeen.map((r) => `${r.method} ${r.path}`), [
    "GET /v2/exchange/estimated-amount", "GET /v2/exchange/min-amount", "POST /v2/exchange", "GET /v2/exchange/by-id",
  ]);
  assert.deepEqual(mockSeen[0].query, { fromCurrency: "usdc", fromNetwork: "matic", toCurrency: "kas", toNetwork: "kas", fromAmount: "10", flow: "standard" });
  assert.deepEqual(mockSeen[1].query, { fromCurrency: "usdc", fromNetwork: "matic", toCurrency: "kas", toNetwork: "kas", flow: "standard" });
  assert.deepEqual(JSON.parse(mockSeen[2].body), { fromCurrency: "usdc", fromNetwork: "matic", toCurrency: "kas", toNetwork: "kas", fromAmount: "10", address: "kaspa:qtestpayout", flow: "standard" });
  assert.equal(mockSeen[2].headers["content-type"], "application/json");
  assert.deepEqual(mockSeen[3].query, { id: "mock-exchange-1" });
  for (const r of mockSeen) assert.equal(r.headers[CHANGENOW_KEY_HEADER], undefined, "the page never sends a key");
});

await test("client: a ChangeNOW 4xx says why (the body, first 300 characters)", async () => {
  const client = createChangeNowClient({ fetchImpl: fetch, urlFor: (url) => url.replace("https://api.changenow.io", MOCK_ORIGIN) });
  await assert.rejects(client.estimate(USDC_POLYGON, KAS, "1"), (error) => error.message === 'ChangeNOW error (400): {"error":"deposit_too_small","message":"Amount is less than minimal"}' && error.status === 400);
});

await test("client: the relay's 503 'not available' becomes SwapUnavailableError; its 429 a plain sentence", async () => {
  const fake = (status, body, headers = {}) => async () => new Response(body, { status, headers });
  const unavailable = createChangeNowClient({ fetchImpl: fake(503, "Swap is not available right now.", { "x-kachat-swap": "unavailable" }) });
  await assert.rejects(unavailable.minAmount(USDC_POLYGON, KAS), (error) => error instanceof SwapUnavailableError && error.unavailable === true && error.message === "Swap is not available right now.");
  // A 503 from ChangeNOW itself (no relay marker) is just a ChangeNOW error.
  const upstream503 = createChangeNowClient({ fetchImpl: fake(503, "maintenance") });
  await assert.rejects(upstream503.minAmount(USDC_POLYGON, KAS), (error) => !error.unavailable && error.message === "ChangeNOW error (503): maintenance");
  const limited = createChangeNowClient({ fetchImpl: fake(429, "Too many swap requests") });
  await assert.rejects(limited.status("x"), /Too many swap requests\. Try again in a minute\./);
});

await test("client: a request that hangs times out", async () => {
  const hang = (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
  const client = createChangeNowClient({ fetchImpl: hang, timeoutMs: 30 });
  await assert.rejects(client.status("x"), /The request timed out\./);
});

// --- Page -> relay -> (mock) ChangeNOW: the relay attaches the server key ----------------------
await test("through the relay: both quote directions and a (mock) create, the key added by the relay only", async () => {
  mockSeen = [];
  const SERVER_KEY = "relay-test-key";
  const relay = createRelay({
    changenowApiKey: SERVER_KEY,
    changenowOrigin: MOCK_ORIGIN,
    allowPrivate: false,
    resolveAllowed: async () => ({ address: "127.0.0.1", family: 4 }), // tests only: the mock is local
  });
  const relayServer = http.createServer((req, res) => relay.handle(req, res, String(req.url || "").replace(/^\/nc-proxy/, "")));
  const relayPort = await new Promise((resolve) => relayServer.listen(0, "127.0.0.1", () => resolve(relayServer.address().port)));
  try {
    const site = `http://127.0.0.1:${relayPort}`;
    // What the browser adds to a same-origin fetch from the page.
    const pageFetch = (url, init = {}) => fetch(url, {
      ...init,
      headers: { ...(init.headers || {}), "sec-fetch-site": "same-origin", referer: `${site}/`, ...(init.method === "POST" ? { origin: site } : {}) },
    });
    const client = createChangeNowClient({
      fetchImpl: pageFetch,
      urlFor: (url) => {
        const parsed = new URL(url.replace("https://api.changenow.io", MOCK_ORIGIN));
        return `${site}/nc-proxy/${encodeURIComponent(parsed.origin)}${parsed.pathname}${parsed.search}`;
      },
    });
    const quoter = createSwapQuoter(client);
    const direct = await quoter.quote({ side: "send", from: USDC_POLYGON, to: KAS, amountText: "10" });
    assert.equal(direct.getText, formatQuotedAmount(7.5 * 9.7 - 2));
    const reverse = await quoter.quote({ side: "get", from: USDC_POLYGON, to: KAS, amountText: "500" });
    assert.ok(Math.abs(Number(reverse.toAmount) - 500) / 500 <= 0.002);
    await assert.rejects(quoter.quote({ side: "get", from: USDC_POLYGON, to: KAS, amountText: "5" }), /Minimum you can get is about 14\.5 Kaspa/);
    const created = await client.create(USDC_POLYGON, KAS, reverse.sendText, "kaspa:qtestpayout");
    assert.equal(created.id, "mock-exchange-1");
    assert.ok(mockSeen.length >= 6);
    for (const r of mockSeen) assert.equal(r.headers[CHANGENOW_KEY_HEADER], SERVER_KEY, `${r.method} ${r.path} carries the server key`);
    assert.equal(mockSeen[mockSeen.length - 1].method, "POST");
    assert.equal(JSON.parse(mockSeen[mockSeen.length - 1].body).fromAmount, reverse.sendText);
  } finally {
    relayServer.close();
  }
});

mockServer.close();
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
