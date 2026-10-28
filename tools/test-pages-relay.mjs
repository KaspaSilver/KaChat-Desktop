// Tests for the Cloudflare Pages relay (functions/nc-proxy/[[path]].js), the /nc-proxy of
// desktop.kachat.app. The function runs here as Pages would call it, with fetch replaced by a
// recorder, so nothing touches the network. Run from the repo root:
//
//   node tools/test-pages-relay.mjs
//
// The same promises as the Node relay (tools/test-relay-guard.mjs) for a site other people open:
// probes, navigation refusal, the encoded origin kept, blocked hosts and literal IPs, no Nextcloud,
// the write gate, the ChangeNOW key on the four swap calls from this site only, stripped request and
// response headers, checked redirect hops, soft 404, rate limits, and no relaying into itself.
import { onRequest, clientKey } from "../functions/nc-proxy/[[path]].js";
import { CHANGENOW_KEY_HEADER, CHANGENOW_CLIENT_KEY_HEADER, NEXTCLOUD_REFUSED_MESSAGE, SWAP_UNAVAILABLE_MESSAGE } from "./relay-rules.mjs";

let failures = 0;
let passes = 0;
function check(name, condition, detail = "") {
  if (condition) { passes += 1; console.log(`ok   ${name}`); }
  else { failures += 1; console.log(`FAIL ${name}${detail ? ` -- ${detail}` : ""}`); }
}

const SITE = "https://desktop.kachat.app";
const enc = (origin) => encodeURIComponent(origin);

// fetch, replaced: every call is recorded, and `answer(url, init)` decides the response.
let calls = [];
let answer = () => new Response("upstream body", { status: 200, headers: { "content-type": "text/plain" } });
globalThis.fetch = async (url, init = {}) => {
  calls.push({ url: String(url), init, headers: new Headers(init.headers || {}) });
  return answer(String(url), init);
};

let ipCounter = 0;
/** One relay call. Each gets its own client address unless `ip` is given, so limits stay apart. */
async function relay(path, { method = "GET", headers = {}, body, env = {}, ip } = {}) {
  calls = [];
  ipCounter += 1;
  const request = new Request(`${SITE}${path}`, {
    method,
    headers: { "cf-connecting-ip": ip ?? `198.51.100.${ipCounter % 250}`, "sec-fetch-dest": "empty", "sec-fetch-mode": "cors", ...headers },
    body,
  });
  const response = await onRequest({ request, env });
  return { status: response.status, headers: response.headers, text: await response.text() };
}

// ---- Probes ------------------------------------------------------------------------------------
{
  const r = await relay("/nc-proxy/__probe");
  check("probe answers kachat-proxy", r.status === 200 && r.text === "kachat-proxy");
  check("probe makes no upstream call", calls.length === 0);
  check("swap probe is off without a key", (await relay("/nc-proxy/__swap")).text === "off");
  check("swap probe is on with a key", (await relay("/nc-proxy/__swap", { env: { CHANGENOW_API_KEY: "k".repeat(32) } })).text === "on");
}

// ---- Refusals before any upstream call ---------------------------------------------------------
{
  let r = await relay(`/nc-proxy/${enc("https://api.kaspa.org")}/info`, { headers: { "sec-fetch-dest": "document", "sec-fetch-mode": "navigate" } });
  check("a page load of a relayed URL is refused", r.status === 403 && calls.length === 0);
  r = await relay(`/nc-proxy/${enc("https://api.kaspa.org")}/info`, { headers: { "sec-fetch-dest": "iframe" } });
  check("a framed load is refused", r.status === 403);
  r = await relay("/nc-proxy/not-a-url/x");
  check("a bad origin is 400 Bad proxy target", r.status === 400 && r.text === "Bad proxy target");
  r = await relay(`/nc-proxy/${enc("ftp://example.com")}/x`);
  check("a non-http origin is refused", r.status === 400);
  r = await relay(`/nc-proxy/${enc("https://user:pw@example.com")}/x`);
  check("credentials in the origin are refused", r.status === 400);
  r = await relay(`/nc-proxy/${enc("https://api.kaspa.org")}//169.254.169.254/latest/meta-data`);
  check("a scheme-relative path cannot swap the host", r.status === 403 && calls.length === 0);
  for (const host of ["http://localhost:8080", "http://metadata.google.internal", "http://169.254.169.254", "http://10.0.0.5", "http://[::1]", "http://2130706433"]) {
    r = await relay(`/nc-proxy/${enc(host)}/x`);
    check(`${host} is never reached`, r.status === 403 && calls.length === 0, `status ${r.status}`);
  }
  r = await relay(`/nc-proxy/${enc(SITE)}/nc-proxy/${enc("https://api.kaspa.org")}/info`);
  check("the relay never relays into itself", r.status === 403 && calls.length === 0);
  r = await relay(`/nc-proxy/${enc(SITE)}/manifest.json`);
  check("the site's own manifest can be fetched (the app's relay check)", r.status === 200 && calls[0]?.url === `${SITE}/manifest.json`);
}

// ---- Nextcloud never ---------------------------------------------------------------------------
{
  let r = await relay(`/nc-proxy/${enc("https://cloud.example.com")}/remote.php/dav/files/me/`, { method: "GET" });
  check("a Nextcloud path is refused", r.status === 403 && r.text === NEXTCLOUD_REFUSED_MESSAGE && calls.length === 0);
  r = await relay(`/nc-proxy/${enc("https://cloud.example.com")}/x`, { headers: { authorization: "Basic dTpw" } });
  check("anything carrying credentials is refused", r.status === 403 && r.text === NEXTCLOUD_REFUSED_MESSAGE);
  r = await relay(`/nc-proxy/${enc("https://cloud.example.com")}/x`, { headers: { "x-kachat-nextcloud-origin": "https://cloud.example.com" } });
  check("the app's Nextcloud marker is refused", r.status === 403);
  r = await relay(`/nc-proxy/${enc("https://cloud.example.com")}/x`, { headers: { "x-proxy-jar": "abcdefgh" } });
  check("a Talk cookie jar is refused", r.status === 403 && calls.length === 0);
}

// ---- The write gate ----------------------------------------------------------------------------
{
  let r = await relay(`/nc-proxy/${enc("https://example.com")}/x`, { method: "POST", body: "{}" });
  check("a write to an arbitrary host is refused", r.status === 403 && calls.length === 0);
  r = await relay(`/nc-proxy/${enc("https://kachat.duckdns.org")}/handshakes`, { method: "POST", body: "{\"a\":1}", headers: { "content-type": "application/json" } });
  check("a write to the indexer goes through", r.status === 200 && calls[0]?.init.method === "POST");
  check("the write carries its body", calls[0]?.init.body !== undefined);
}

// ---- ChangeNOW ---------------------------------------------------------------------------------
{
  const KEY = "s".repeat(40);
  const swap = `/nc-proxy/${enc("https://api.changenow.io")}/v2/exchange/estimated-amount?fromCurrency=kas`;
  const same = { "sec-fetch-site": "same-origin", referer: `${SITE}/` };
  let r = await relay(swap, { headers: same });
  check("no server key: swap is 503 not available", r.status === 503 && r.text === SWAP_UNAVAILABLE_MESSAGE && r.headers.get("x-kachat-swap") === "unavailable");
  r = await relay(swap, { headers: { ...same, [CHANGENOW_CLIENT_KEY_HEADER]: "p".repeat(32) } });
  check("a pasted key is never used here", r.status === 503 && calls.length === 0);
  r = await relay(swap, { env: { CHANGENOW_API_KEY: KEY }, headers: { "sec-fetch-site": "cross-site", origin: "https://evil.example" } });
  check("another site cannot use the server key", r.status === 403 && calls.length === 0);
  r = await relay(swap, { env: { CHANGENOW_API_KEY: KEY }, headers: same });
  check("this site's swap call carries the server key", r.status === 200 && calls[0]?.headers.get(CHANGENOW_KEY_HEADER) === KEY);
  r = await relay(`/nc-proxy/${enc("https://api.changenow.io")}/v2/exchange/currencies`, { env: { CHANGENOW_API_KEY: KEY }, headers: { ...same, [CHANGENOW_KEY_HEADER]: "client-key" } });
  check("other ChangeNOW calls get no key, not even the client's", calls[0] && !calls[0].headers.has(CHANGENOW_KEY_HEADER));
  r = await relay(`/nc-proxy/${enc("https://api.changenow.io")}/v2/exchange`, { method: "POST", body: "{}", env: { CHANGENOW_API_KEY: KEY }, headers: same });
  check("creating an exchange is the one ChangeNOW write", r.status === 200 && calls[0]?.headers.get(CHANGENOW_KEY_HEADER) === KEY);
  r = await relay(`/nc-proxy/${enc("https://api.changenow.io")}/v2/other`, { method: "POST", body: "{}", env: { CHANGENOW_API_KEY: KEY }, headers: same });
  check("no other ChangeNOW write", r.status === 403);
  // A swap limit of its own.
  const ip = "203.0.113.77";
  let last = null;
  for (let i = 0; i < 3; i += 1) last = await relay(swap, { ip, env: { CHANGENOW_API_KEY: KEY, KACHAT_CHANGENOW_RATE_MAX: "2" }, headers: same });
  check("the swap limit answers 429", last.status === 429 && last.text === "Too many swap requests");
}

// ---- What leaves, and what comes back ----------------------------------------------------------
{
  answer = () => new Response("data", {
    status: 200,
    headers: {
      "content-type": "application/json", "set-cookie": "a=b", "www-authenticate": "Basic", "clear-site-data": "\"*\"",
      "access-control-allow-origin": "*", "strict-transport-security": "max-age=1", link: "<x>; rel=preload",
    },
  });
  const r = await relay(`/nc-proxy/${enc("https://api.kaspa.org")}/info/blockdag`, {
    headers: {
      cookie: "session=1", origin: SITE, referer: `${SITE}/`, "x-forwarded-for": "1.2.3.4", "x-real-ip": "1.2.3.4",
      "cf-ray": "abc", "sec-fetch-site": "same-origin", accept: "application/json",
    },
  });
  const sent = calls[0]?.headers;
  for (const name of ["cookie", "origin", "referer", "x-forwarded-for", "x-real-ip", "cf-ray", "cf-connecting-ip", "sec-fetch-site", "sec-fetch-dest"]) {
    check(`request header ${name} is not passed on`, sent && !sent.has(name));
  }
  check("an ordinary request header is passed on", sent?.get("accept") === "application/json");
  for (const name of ["set-cookie", "www-authenticate", "clear-site-data", "access-control-allow-origin", "strict-transport-security", "link"]) {
    check(`response header ${name} is removed`, !r.headers.has(name));
  }
  check("the answer is sandboxed", r.headers.get("content-security-policy") === "sandbox");
  check("the answer is nosniff", r.headers.get("x-content-type-options") === "nosniff");
  check("the body arrives", r.text === "data");
}

// ---- Redirects ---------------------------------------------------------------------------------
{
  answer = (url) => (url.startsWith("https://api.kaspa.org/")
    ? new Response(null, { status: 302, headers: { location: "https://mirror.example.org/moved" } })
    : new Response("moved here", { status: 200 }));
  let r = await relay(`/nc-proxy/${enc("https://api.kaspa.org")}/old`);
  check("a redirect is followed here", r.status === 200 && r.text === "moved here" && calls.length === 2);
  check("the hop goes where Location says", calls[1]?.url === "https://mirror.example.org/moved");
  check("fetch is never left to follow redirects itself", calls.every((c) => c.init.redirect === "manual"));

  answer = () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1/admin" } });
  r = await relay(`/nc-proxy/${enc("https://api.kaspa.org")}/old`);
  check("a redirect to a blocked host is refused", r.status === 403 && r.text === "Redirect target not allowed" && calls.length === 1);

  answer = () => new Response(null, { status: 302, headers: { location: `${SITE}/nc-proxy/${enc("https://example.com")}/x` } });
  r = await relay(`/nc-proxy/${enc("https://api.kaspa.org")}/old`);
  check("a redirect back into the relay is refused", r.status === 403 && calls.length === 1);

  const KEY = "s".repeat(40);
  answer = (url) => (url.startsWith("https://api.changenow.io/")
    ? new Response(null, { status: 302, headers: { location: "https://elsewhere.example.org/x" } })
    : new Response("ok", { status: 200 }));
  r = await relay(`/nc-proxy/${enc("https://api.changenow.io")}/v2/exchange/min-amount?x=1`, {
    env: { CHANGENOW_API_KEY: KEY }, headers: { "sec-fetch-site": "same-origin", referer: `${SITE}/` },
  });
  check("the ChangeNOW key does not follow a redirect to another origin", calls[0]?.headers.get(CHANGENOW_KEY_HEADER) === KEY && calls[1] && !calls[1].headers.has(CHANGENOW_KEY_HEADER));

  let hops = 0;
  answer = () => { hops += 1; return new Response(null, { status: 302, headers: { location: `https://api.kaspa.org/loop${hops}` } }); };
  r = await relay(`/nc-proxy/${enc("https://api.kaspa.org")}/loop0`);
  check("redirect hops are capped", calls.length === 6 && r.status === 302, `calls ${calls.length}, status ${r.status}`);

  answer = () => new Response(null, { status: 302, headers: { location: "https://other.example.org/" } });
  r = await relay(`/nc-proxy/${enc("https://kachat.duckdns.org")}/handshakes`, { method: "POST", body: "{}" });
  check("a write's redirect is passed back, not followed", r.status === 302 && calls.length === 1);
}

// ---- Soft 404 ----------------------------------------------------------------------------------
{
  answer = () => new Response("nope", { status: 404 });
  let r = await relay(`/nc-proxy/${enc("https://api.knsdomains.org")}/name`, { headers: { "x-proxy-soft-404": "1" } });
  check("soft 404 answers 200 + x-upstream-status", r.status === 200 && r.headers.get("x-upstream-status") === "404");
  check("the soft-404 marker is not passed on", calls[0] && !calls[0].headers.has("x-proxy-soft-404"));
  r = await relay(`/nc-proxy/${enc("https://api.knsdomains.org")}/name`);
  check("without it a 404 stays 404", r.status === 404);
}

// ---- Link previews -----------------------------------------------------------------------------
{
  answer = () => new Response("<html></html>", { status: 200 });
  await relay(`/nc-proxy/${enc("https://www.example.com")}/post`, { headers: { "x-preview": "1" } });
  check("a preview scrape goes out as a link unfurler", /facebookexternalhit/.test(calls[0]?.headers.get("user-agent") || "") && !calls[0].headers.has("x-preview"));
  await relay(`/nc-proxy/${enc("https://x.com")}/post`, { headers: { "x-preview": "1" } });
  check("x.com gets a browser user agent", /Safari/.test(calls[0]?.headers.get("user-agent") || ""));
}

// ---- Rate limits and client keys ---------------------------------------------------------------
{
  answer = () => new Response("ok", { status: 200 });
  const ip = "192.0.2.200";
  let last = null;
  for (let i = 0; i < 4; i += 1) last = await relay(`/nc-proxy/${enc("https://api.kaspa.org")}/info`, { ip, env: { KACHAT_RELAY_RATE_MAX: "3" } });
  check("the relay limit answers 429 with retry-after", last.status === 429 && last.headers.get("retry-after") === "60");
  const other = await relay(`/nc-proxy/${enc("https://api.kaspa.org")}/info`, { ip: "192.0.2.201", env: { KACHAT_RELAY_RATE_MAX: "3" } });
  check("another client is not limited by it", other.status === 200);

  const key = (ip) => clientKey(new Request(SITE, { headers: { "cf-connecting-ip": ip } }));
  check("an IPv4 client counts by its address", key("203.0.113.9") === "203.0.113.9");
  check("an IPv6 client counts by its /64", key("2001:db8:1:2:aaaa::1") === key("2001:db8:1:2:bbbb::9") && key("2001:db8:1:2::1") === "2001:db8:1:2::/64");
  check("another /64 is another client", key("2001:db8:1:3::1") !== key("2001:db8:1:2::1"));
  check("IPv4-mapped IPv6 counts as the IPv4 address", key("::ffff:203.0.113.9") === "203.0.113.9");
}

// ---- Upstream failures -------------------------------------------------------------------------
{
  answer = () => { throw new Error("connection refused"); };
  const r = await relay(`/nc-proxy/${enc("https://api.kaspa.org")}/info`);
  check("an upstream failure is a 502", r.status === 502 && r.text.startsWith("Proxy error"));
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
