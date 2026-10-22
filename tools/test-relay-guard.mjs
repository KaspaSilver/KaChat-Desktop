// Tests for the /nc-proxy relay (tools/relay-guard.mjs) and the standalone sidecar
// (tools/nc-proxy-server.mjs). Local servers only - no internet needed. Run from the repo root:
//
//   node tools/test-relay-guard.mjs
//
// Covers DSK-001 (scheme-relative SSRF, blocked ranges, redirect hops), DSK-002 (navigation
// refusal, response sandboxing/stripping, request cookie stripping) and DSK-003 (rate-limit key and
// eviction, IPv6 /64 buckets, write gate bound to the declared Nextcloud origin), and the ChangeNOW
// key gate (the server key only on the four swap calls, never a client's, its own rate limit).
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRelay, ipBlocked, resolveAllowed, CHANGENOW_KEY_HEADER, SWAP_UNAVAILABLE_MESSAGE } from "./relay-guard.mjs";

const here = dirname(fileURLToPath(import.meta.url));
let failures = 0;
let passes = 0;
function check(name, condition, detail = "") {
  if (condition) { passes += 1; console.log(`ok   ${name}`); }
  else { failures += 1; console.log(`FAIL ${name}${detail ? ` -- ${detail}` : ""}`); }
}

function request(port, path, { method = "GET", headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}
const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));

// --- Upstream: the "internet" the relay talks to --------------------------------------------
let lastSeen = null;
const upstream = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    lastSeen = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString("utf8") };
    const path = req.url.split("?")[0];
    if (path === "/page") {
      res.writeHead(200, {
        "content-type": "text/html",
        "set-cookie": ["sid=evil; Path=/", "other=1"],
        "www-authenticate": "Basic realm=x",
        "proxy-authenticate": "Basic realm=y",
        refresh: "0; url=https://evil.example/",
        link: "<https://evil.example/x.js>; rel=preload",
        "clear-site-data": "\"storage\"",
        "access-control-allow-origin": "*",
        "content-security-policy": "default-src *",
        "x-custom": "kept",
      });
      res.write("<script>alert(1)</script>");
      res.end("<p>tail</p>"); // chunked: no content-length
      return;
    }
    if (path === "/redirect-internal") { res.writeHead(302, { location: `http://127.0.0.1:${upstreamPort}/page` }); res.end(); return; }
    if (path === "/redirect-same") { res.writeHead(302, { location: "/echo?from=redirect" }); res.end(); return; }
    if (path === "/setcookie") { res.writeHead(200, { "set-cookie": "sid=abc123; Path=/; HttpOnly" }); res.end("{}"); return; }
    if (path === "/missing") { res.writeHead(404, { "content-type": "application/json" }); res.end("{}"); return; }
    // A ChangeNOW call that redirects to another origin (the key must not follow it).
    if (path === "/v2/exchange/by-id" && req.url.includes("id=hop")) { res.writeHead(302, { location: `http://other.test:${upstreamPort}/echo` }); res.end(); return; }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(lastSeen));
  });
});
const upstreamPort = await listen(upstream);
const UP = encodeURIComponent(`http://upstream.test:${upstreamPort}`);

// Name resolution for tests: "upstream.test" is the local server; every other name goes through
// the real guard (so 127.0.0.1 etc. stay blocked, including on redirect hops).
const testResolve = (hostname) => (hostname === "upstream.test" || hostname === "other.test"
  ? Promise.resolve({ address: "127.0.0.1", family: 4 })
  : resolveAllowed(hostname));

function relayServer(options) {
  const relay = createRelay({ resolveAllowed: testResolve, ...options });
  const server = http.createServer((req, res) => relay.handle(req, res, String(req.url || "").replace(/^\/nc-proxy(?=\/|\?|$)/, "")));
  return { relay, server };
}

// --- 1. Address classification ---------------------------------------------------------------
const blocked = ["127.0.0.1", "0.0.0.0", "0.1.2.3", "10.0.0.1", "172.17.0.1", "192.168.1.1", "100.64.0.1",
  "169.254.169.254", "224.0.0.1", "239.255.255.250", "255.255.255.255", "::", "::1", "::ffff:127.0.0.1",
  "::ffff:7f00:1", "::127.0.0.1", "fe80::1", "fc00::1", "fd12:3456::1", "ff02::1", "64:ff9b::7f00:1",
  "64:ff9b::a9fe:a9fe", "2002:7f00:1::1", "not-an-ip"];
for (const ip of blocked) check(`blocked: ${ip}`, ipBlocked(ip));
for (const ip of ["93.184.216.34", "1.1.1.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) check(`allowed: ${ip}`, !ipBlocked(ip));
check("private allowed with allowPrivate", !ipBlocked("192.168.1.10", { allowPrivate: true }) && !ipBlocked("fd00::5", { allowPrivate: true }));
check("loopback never allowed even with allowPrivate", ipBlocked("127.0.0.1", { allowPrivate: true }) && ipBlocked("169.254.169.254", { allowPrivate: true }));

// --- 2. The sidecar, as deployed (spawned with node) ------------------------------------------
const sidecar = spawn(process.execPath, [join(here, "nc-proxy-server.mjs")], {
  env: { ...process.env, NC_PROXY_PORT: "0", NC_PROXY_HOST: "127.0.0.1", CHANGENOW_API_KEY: "", KACHAT_RELAY_ALLOW_NEXTCLOUD: "" },
  stdio: ["ignore", "pipe", "pipe"],
});
const sidecarPort = await new Promise((resolve, reject) => {
  let out = "";
  sidecar.stdout.on("data", (d) => { out += d; const m = /listening on [^:]+:(\d+)/.exec(out); if (m) resolve(Number(m[1])); });
  sidecar.on("exit", (code) => reject(new Error(`sidecar exited ${code}`)));
  setTimeout(() => reject(new Error("sidecar did not start")), 5000);
});
try {
  for (const path of [
    "/http%3A%2F%2Fexample.com//127.0.0.1/",
    "/http%3A%2F%2Fexample.com//169.254.169.254/latest/meta-data/",
    "/https%3A%2F%2Fexample.com//172.17.0.1:9443/",
    "/http%3A%2F%2F127.0.0.1%3A8790/",
    "/http%3A%2F%2Flocalhost/",
    "/http%3A%2F%2F0.0.0.0/",
    "/http%3A%2F%2F%5B%3A%3Affff%3A7f00%3A1%5D/",
    "/http%3A%2F%2F%5B64%3Aff9b%3A%3A7f00%3A1%5D/",
    "/http%3A%2F%2F224.0.0.1/",
    "/http%3A%2F%2F0x7f.1/",
  ]) {
    for (const prefix of ["/desktop/nc-proxy", "/nc-proxy"]) {
      const r = await request(sidecarPort, `${prefix}${path}`);
      check(`sidecar 403 ${prefix}${path}`, r.status === 403, `got ${r.status} ${r.body}`);
    }
  }
  const nav = await request(sidecarPort, "/desktop/nc-proxy/https%3A%2F%2Fevil.example/x.html", { headers: { "sec-fetch-dest": "document", "sec-fetch-mode": "navigate" } });
  check("sidecar refuses a document navigation", nav.status === 403, `got ${nav.status}`);
  for (const dest of ["iframe", "frame", "embed", "object"]) {
    const r = await request(sidecarPort, "/desktop/nc-proxy/https%3A%2F%2Fevil.example/x.html", { headers: { "sec-fetch-dest": dest } });
    check(`sidecar refuses sec-fetch-dest: ${dest}`, r.status === 403, `got ${r.status}`);
  }
  const probe = await request(sidecarPort, "/desktop/nc-proxy/__probe");
  check("sidecar answers __probe", probe.status === 200 && probe.body === "kachat-proxy");
  const health = await request(sidecarPort, "/health");
  check("sidecar /health", health.status === 200 && health.body === "ok");
  const bad = await request(sidecarPort, "/desktop/nc-proxy/not-a-url/");
  check("sidecar 400 on a bad target", bad.status === 400);
  const write = await request(sidecarPort, "/desktop/nc-proxy/https%3A%2F%2Fvictim.example/form", { method: "POST", headers: { authorization: "x" }, body: "a=1" });
  check("sidecar refuses an arbitrary write with a junk Authorization", write.status === 403, `got ${write.status}`);
  // The hosted sidecar relays no Nextcloud traffic (refuseNextcloud on by default).
  const NC = encodeURIComponent("https://cloud.example.org");
  for (const [label, path, opts] of [
    ["a sign-in check with Basic auth", `/${NC}/ocs/v2.php/cloud/user?format=json`, { headers: { authorization: "Basic dTpw", "ocs-apirequest": "true" } }],
    ["a WebDAV upload", `/${NC}/remote.php/dav/files/u/KaChat/x.jpg`, { method: "PUT", headers: { authorization: "Basic dTpw", "x-kachat-nextcloud-origin": "https://cloud.example.org" }, body: "x" }],
    ["a Talk guest request", `/${NC}/ocs/v2.php/apps/spreed/api/v4/room/abc/participants/active`, { method: "POST", headers: { "x-proxy-jar": "0123456789abcdef0123456789abcdef", "ocs-apirequest": "true" } }],
    ["a share link's file check", `/${NC}/s/AbCdEfGhIjK123/download`, { headers: { range: "bytes=0-1" } }],
    ["a share link's file check under index.php", `/${NC}/index.php/s/AbCdEfGhIjK123/download`, {}],
    ["a Login Flow v2 start", `/${NC}/index.php/login/v2`, { method: "POST" }],
    ["a status.php probe", `/${NC}/status.php`, {}],
  ]) {
    const r = await request(sidecarPort, `/desktop/nc-proxy${path}`, opts);
    check(`sidecar refuses Nextcloud: ${label}`, r.status === 403 && r.body.includes("Kaspa Quick Start"), `got ${r.status} ${r.body}`);
  }
  // No CHANGENOW_API_KEY: the swap probe says off and the swap calls answer "not available" here,
  // without anything going out.
  const swapOff = await request(sidecarPort, "/desktop/nc-proxy/__swap");
  check("sidecar without a key: __swap is off", swapOff.status === 200 && swapOff.body === "off", `${swapOff.status} ${swapOff.body}`);
  const CN = encodeURIComponent("https://api.changenow.io");
  const noKey = await request(sidecarPort, `/desktop/nc-proxy/${CN}/v2/exchange/min-amount?fromCurrency=usdc&fromNetwork=matic&toCurrency=kas&toNetwork=kas&flow=standard`, { headers: { host: "desktop.kachat.app", "sec-fetch-site": "same-origin", referer: "https://desktop.kachat.app/" } });
  check("sidecar without a key: a swap call is 503 Swap is not available", noKey.status === 503 && noKey.headers["x-kachat-swap"] === "unavailable" && noKey.body === SWAP_UNAVAILABLE_MESSAGE, `${noKey.status} ${noKey.body}`);
} finally {
  sidecar.kill();
}

// --- 2a. The sidecar WITH a key: swap is on, Nextcloud is still refused, and nothing reaches
// ChangeNOW unless the call comes from the site's own page (no request here goes out). ----------
{
  const keyed = spawn(process.execPath, [join(here, "nc-proxy-server.mjs")], {
    env: { ...process.env, NC_PROXY_PORT: "0", NC_PROXY_HOST: "127.0.0.1", CHANGENOW_API_KEY: "sidecar-test-key-not-real", KACHAT_RELAY_ALLOW_NEXTCLOUD: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const keyedPort = await new Promise((resolve, reject) => {
    let out = "";
    keyed.stdout.on("data", (d) => { out += d; const m = /listening on [^:]+:(\d+)/.exec(out); if (m) resolve(Number(m[1])); });
    keyed.on("exit", (code) => reject(new Error(`sidecar exited ${code}`)));
    setTimeout(() => reject(new Error("sidecar did not start")), 5000);
  });
  try {
    const on = await request(keyedPort, "/desktop/nc-proxy/__swap");
    check("sidecar with a key: __swap is on (the key itself is never shown)", on.status === 200 && on.body === "on", `${on.status} ${on.body}`);
    const NC = encodeURIComponent("https://cloud.example.org");
    const nc = await request(keyedPort, `/desktop/nc-proxy/${NC}/remote.php/dav/files/u/x`, { method: "PUT", headers: { authorization: "Basic dTpw", "x-kachat-nextcloud-origin": "https://cloud.example.org" }, body: "x" });
    check("sidecar with a key: Nextcloud is still refused", nc.status === 403 && nc.body.includes("Kaspa Quick Start"), `${nc.status} ${nc.body}`);
    const CN = encodeURIComponent("https://api.changenow.io");
    const foreign = await request(keyedPort, `/desktop/nc-proxy/${CN}/v2/exchange`, { method: "POST", headers: { host: "desktop.kachat.app", "sec-fetch-site": "cross-site", origin: "https://evil.example", "content-type": "application/json" }, body: "{}" });
    check("sidecar with a key: a cross-site create is refused before anything goes out", foreign.status === 403, `${foreign.status} ${foreign.body}`);
    const noMeta = await request(keyedPort, `/desktop/nc-proxy/${CN}/v2/exchange/by-id?id=abc`, { headers: { host: "desktop.kachat.app" } });
    check("sidecar with a key: a status call without Fetch Metadata is refused", noMeta.status === 403, `${noMeta.status} ${noMeta.body}`);
  } finally {
    keyed.kill();
  }
}

// --- 2b. refuseNextcloud: indexer/API reads still pass, Nextcloud traffic does not ------------
{
  const { server: ncOff } = relayServer({ refuseNextcloud: true });
  const ncOffPort = await listen(ncOff);
  const plain = await request(ncOffPort, `/nc-proxy/${UP}/page`, { headers: { "sec-fetch-dest": "empty", "sec-fetch-mode": "cors" } });
  check("refuseNextcloud: a plain read still relays", plain.status === 200, `got ${plain.status}`);
  const api = await request(ncOffPort, `/nc-proxy/${UP}/addresses/kaspa:qx/full-transactions?limit=1`);
  check("refuseNextcloud: an API-shaped read still relays", api.status !== 403, `got ${api.status}`);
  const article = await request(ncOffPort, `/nc-proxy/${UP}/index.php/topic/s/abc`);
  check("refuseNextcloud: an ordinary index.php page still relays", article.status !== 403, `got ${article.status}`);
  const authed = await request(ncOffPort, `/nc-proxy/${UP}/page`, { headers: { authorization: "Bearer t" } });
  check("refuseNextcloud: anything carrying credentials is refused", authed.status === 403, `got ${authed.status}`);
  const dav = await request(ncOffPort, `/nc-proxy/${UP}/remote.php/dav/files/u/`, { method: "PROPFIND" });
  check("refuseNextcloud: WebDAV is refused without credentials too", dav.status === 403, `got ${dav.status}`);
  ncOff.close();
  const { server: ncOn } = relayServer({});
  const ncOnPort = await listen(ncOn);
  const share = await request(ncOnPort, `/nc-proxy/${UP}/s/AbCdEfGhIjK123/download`);
  check("without refuseNextcloud (dev server, Kaspa Quick Start) a share link still relays", share.status !== 403, `got ${share.status}`);
  ncOn.close();
}

// --- 3. Relayed responses + forwarded requests (local upstream) -------------------------------
const { relay, server } = relayServer({});
const relayPort = await listen(server);

const page = await request(relayPort, `/nc-proxy/${UP}/page`, { headers: { "sec-fetch-dest": "empty", "sec-fetch-mode": "cors", "sec-fetch-site": "same-origin" } });
check("relayed page arrives", page.status === 200 && page.body.includes("tail"), `got ${page.status} ${page.body}`);
check("csp sandbox forced", page.headers["content-security-policy"] === "sandbox", page.headers["content-security-policy"]);
check("nosniff forced", page.headers["x-content-type-options"] === "nosniff");
for (const h of ["set-cookie", "www-authenticate", "proxy-authenticate", "refresh", "link", "clear-site-data", "access-control-allow-origin"]) {
  check(`response header stripped: ${h}`, page.headers[h] === undefined, String(page.headers[h]));
}
check("ordinary response header kept", page.headers["x-custom"] === "kept");

const echo = JSON.parse((await request(relayPort, `/nc-proxy/${UP}/echo?q=1`, {
  headers: {
    cookie: "kachat-session=secret", origin: "https://kachat.app", referer: "https://kachat.app/desktop/",
    "x-forwarded-for": "6.6.6.6", "cf-connecting-ip": "6.6.6.6", "x-real-ip": "6.6.6.6",
    "x-proxy-long-poll": "1", "x-preview": "1", "sec-fetch-site": "same-origin", accept: "*/*",
  },
})).body);
check("query string is forwarded", echo.url === "/echo?q=1", echo.url);
check("browser cookie is not forwarded", echo.headers.cookie === undefined, echo.headers.cookie);
check("origin/referer not forwarded", echo.headers.origin === undefined && echo.headers.referer === undefined);
check("client identity headers not forwarded", !echo.headers["x-forwarded-for"] && !echo.headers["cf-connecting-ip"] && !echo.headers["x-real-ip"]);
check("relay-internal headers not forwarded", !echo.headers["x-proxy-long-poll"] && !echo.headers["x-preview"] && !echo.headers["sec-fetch-site"]);
check("host is the target", echo.headers.host === `upstream.test:${upstreamPort}`, echo.headers.host);
check("x-preview uses a crawler UA + html accept", /facebookexternalhit/.test(echo.headers["user-agent"]) && echo.headers.accept === "text/html,application/xhtml+xml");

// The origin check on its own (not just the address check behind it): a scheme-relative path
// pointing at a host that WOULD resolve to an allowed address must still be refused.
const hostSwap = await request(relayPort, `/nc-proxy/${encodeURIComponent("http://example.com")}//upstream.test:${upstreamPort}/echo`);
check("scheme-relative path cannot swap the host", hostSwap.status === 403, `got ${hostSwap.status}`);

const viaQueryOnly =await request(relayPort, `/nc-proxy/${UP}?only=query`);
check("origin with only a query string keeps the query", viaQueryOnly.status === 200 && JSON.parse(viaQueryOnly.body).url === "/?only=query", viaQueryOnly.body);

const redirInternal = await request(relayPort, `/nc-proxy/${UP}/redirect-internal`);
check("redirect into 127.0.0.1 is refused", redirInternal.status === 403, `got ${redirInternal.status}`);
const redirSame = await request(relayPort, `/nc-proxy/${UP}/redirect-same`);
check("same-origin redirect is followed", redirSame.status === 200 && JSON.parse(redirSame.body).url === "/echo?from=redirect");

const soft = await request(relayPort, `/nc-proxy/${UP}/missing`, { headers: { "x-proxy-soft-404": "1" } });
check("soft 404 (KNS)", soft.status === 200 && soft.headers["x-upstream-status"] === "404");

// Write gate (DSK-003): writes only to the Nextcloud the app declares, on /remote.php/ or /ocs/.
const basic = `Basic ${Buffer.from("alice:app-password").toString("base64")}`;
const NC = { "x-kachat-nextcloud-origin": `http://upstream.test:${upstreamPort}` };
const OTHER_NC = { "x-kachat-nextcloud-origin": "https://cloud.example" };
const writes = [
  ["POST without auth refused", "POST", "/api/form", { ...NC }, 403],
  ["junk Authorization refused", "POST", "/remote.php/dav/files/alice/x", { ...NC, authorization: "x" }, 403],
  ["Basic on a non-Nextcloud path refused", "PUT", "/upload", { ...NC, authorization: basic }, 403],
  ["WebDAV PUT with Basic to the declared origin allowed", "PUT", "/remote.php/dav/files/alice/backup.json", { ...NC, authorization: basic }, 200],
  ["WebDAV MKCOL with Basic allowed", "MKCOL", "/remote.php/dav/files/alice/KaChat", { ...NC, authorization: basic }, 200],
  ["WebDAV PROPFIND with Basic allowed", "PROPFIND", "/remote.php/dav/files/alice/", { ...NC, authorization: basic, depth: "1" }, 200],
  ["WebDAV DELETE with Basic allowed", "DELETE", "/remote.php/dav/files/alice/old.json", { ...NC, authorization: basic }, 200],
  ["OCS share POST with Basic allowed", "POST", "/ocs/v2.php/apps/files_sharing/api/v1/shares?format=json", { ...NC, authorization: basic, "ocs-apirequest": "true" }, 200],
  ["Bearer on /ocs/ allowed", "POST", "/ocs/v2.php/apps/x", { ...NC, authorization: "Bearer tok123" }, 200],
  ["Talk guest (jar + OCS) allowed", "POST", "/ocs/v2.php/apps/spreed/api/v4/room/tok/participants/active", { ...NC, "x-proxy-jar": "jarJarJar1234", "ocs-apirequest": "true" }, 200],
  ["jar without OCS-APIRequest refused", "POST", "/ocs/v2.php/apps/spreed/api/v4/room/tok/participants/active", { ...NC, "x-proxy-jar": "jarJarJar1234" }, 403],
  ["jar on a WebDAV path refused", "PUT", "/remote.php/dav/files/x", { ...NC, "x-proxy-jar": "jarJarJar1234", "ocs-apirequest": "true" }, 403],
  ["dot-segment escape refused", "POST", "/remote.php/../admin", { ...NC, authorization: basic }, 403],
  // index.php is only ever read by the app (previews), so it is no longer a write root.
  ["Bearer on /index.php/ refused", "POST", "/index.php/apps/x", { ...NC, authorization: "Bearer tok123" }, 403],
  ["Basic PUT on /index.php/ refused", "PUT", "/index.php/apps/files/x", { ...NC, authorization: basic }, 403],
  // The declared origin must be the target's origin.
  ["no declared origin refused", "PUT", "/remote.php/dav/files/alice/backup.json", { authorization: basic }, 403],
  ["write to a different host than declared refused", "PUT", "/remote.php/dav/files/alice/backup.json", { ...OTHER_NC, authorization: basic }, 403],
  ["declared origin with another port refused", "PUT", "/remote.php/dav/files/alice/backup.json", { "x-kachat-nextcloud-origin": "http://upstream.test:1", authorization: basic }, 403],
  ["declared origin with another scheme refused", "PUT", "/remote.php/dav/files/alice/backup.json", { "x-kachat-nextcloud-origin": `https://upstream.test:${upstreamPort}`, authorization: basic }, 403],
  ["garbage declared origin refused", "PUT", "/remote.php/dav/files/alice/backup.json", { "x-kachat-nextcloud-origin": "not a url", authorization: basic }, 403],
  ["Talk guest declaring another host refused", "POST", "/ocs/v2.php/apps/spreed/api/v4/room/tok/participants/active", { ...OTHER_NC, "x-proxy-jar": "jarJarJar1234", "ocs-apirequest": "true" }, 403],
  ["declared origin with a path/trailing slash still matches", "PUT", "/remote.php/dav/files/alice/c.json", { "x-kachat-nextcloud-origin": `HTTP://UPSTREAM.test:${upstreamPort}/nextcloud/`, authorization: basic }, 200],
];
for (const [name, method, path, headers, want] of writes) {
  const r = await request(relayPort, `/nc-proxy/${UP}${path}`, { method, headers, body: method === "DELETE" ? null : "x" });
  check(`write gate: ${name}`, r.status === want, `got ${r.status} ${r.body.slice(0, 80)}`);
}
const writeSeen = await request(relayPort, `/nc-proxy/${UP}/remote.php/dav/files/alice/b.json`, { method: "PUT", headers: { ...NC, authorization: basic }, body: "payload" });
const writeEcho = JSON.parse(writeSeen.body);
check("PUT body + Authorization reach Nextcloud", writeEcho.body === "payload" && writeEcho.headers.authorization === basic);
check("declared-origin header is not forwarded", writeEcho.headers["x-kachat-nextcloud-origin"] === undefined);
// Reads are unaffected by the write gate: no header, a foreign header, index.php.
for (const [name, path, headers] of [
  ["GET without a declared origin", "/echo", {}],
  ["GET declaring another host", "/remote.php/dav/files/alice/a.json", { ...OTHER_NC, authorization: basic }],
  ["GET on /index.php/ (previews)", "/index.php/core/preview.png?file=%2Fa.jpg", { authorization: basic }],
]) {
  const r = await request(relayPort, `/nc-proxy/${UP}${path}`, { headers });
  check(`reads unaffected: ${name}`, r.status === 200, `got ${r.status}`);
}
const headRead = await request(relayPort, `/nc-proxy/${UP}/echo`, { method: "HEAD", headers: OTHER_NC });
check("reads unaffected: HEAD declaring another host", headRead.status === 200, `got ${headRead.status}`);
// The app's own API hosts keep their write access without the header (engine/endpoints.js).
const apiHost = (hostname) => new URL(`https://${hostname}/v1/x`);
const fakeReq = (headers = {}) => ({ socket: { remoteAddress: "127.0.0.1" }, headers });
check("API host write needs no declared origin", relay.writeAllowed(fakeReq(), apiHost("api.kaspa.org")) && relay.writeAllowed(fakeReq(), apiHost("indexer.kasia.wtf")));
// ChangeNOW is a write host for creating an exchange only (POST /v2/exchange).
const cnReq = (method) => ({ socket: { remoteAddress: "127.0.0.1" }, headers: {}, method });
check("ChangeNOW: POST /v2/exchange may be written", relay.writeAllowed(cnReq("POST"), new URL("https://api.changenow.io/v2/exchange")));
check("ChangeNOW: no other write there", !relay.writeAllowed(cnReq("POST"), new URL("https://api.changenow.io/v2/exchange/other"))
  && !relay.writeAllowed(cnReq("DELETE"), new URL("https://api.changenow.io/v2/exchange"))
  && !relay.writeAllowed(cnReq("PUT"), new URL("https://api.changenow.io/v2/exchange"))
  && !relay.writeAllowed(cnReq("POST"), new URL("https://api.changenow.io/v1/transactions"))
  && !relay.writeAllowed(cnReq("POST"), new URL("https://changenow.io/v2/exchange"))
  && !relay.writeAllowed(cnReq("POST"), new URL("http://api.changenow.io/v2/exchange")));

// Cookie jar for Talk.
const jar = "talkJar_0123456789";
const setc = await request(relayPort, `/nc-proxy/${UP}/setcookie`, { headers: { "x-proxy-jar": jar } });
check("jar Set-Cookie is not handed to the browser", setc.headers["set-cookie"] === undefined);
const withJar = JSON.parse((await request(relayPort, `/nc-proxy/${UP}/echo`, { headers: { "x-proxy-jar": jar } })).body);
check("jar cookie is sent back to the same origin", withJar.headers.cookie === "sid=abc123", withJar.headers.cookie);
check("jar id is not forwarded", withJar.headers["x-proxy-jar"] === undefined);
const noJar = JSON.parse((await request(relayPort, `/nc-proxy/${UP}/echo`)).body);
check("no jar, no cookie", noJar.headers.cookie === undefined);

// --- 4. Rate-limit key (DSK-003) ---------------------------------------------------------------
const fake = (remoteAddress, headers = {}) => ({ socket: { remoteAddress }, headers });
check("untrusted peer: spoofed XFF ignored", relay.clientKey(fake("203.0.113.9", { "x-forwarded-for": "1.2.3.4" })) === "203.0.113.9");
check("untrusted peer: spoofed cf-connecting-ip ignored", relay.clientKey(fake("203.0.113.9", { "cf-connecting-ip": "1.2.3.4" })) === "203.0.113.9");
check("trusted loopback peer: right-most XFF used", relay.clientKey(fake("127.0.0.1", { "x-forwarded-for": "6.6.6.6, 198.51.100.7" })) === "198.51.100.7");
check("trusted peer: cf-connecting-ip ignored by default", relay.clientKey(fake("::ffff:127.0.0.1", { "cf-connecting-ip": "1.2.3.4" })) === "127.0.0.1");
const docker = createRelay({ trustedProxies: "172.17.0.1, 10.9.0.0/16" });
check("KACHAT_TRUSTED_PROXIES: listed gateway trusted", docker.clientKey(fake("172.17.0.1", { "x-forwarded-for": "198.51.100.8" })) === "198.51.100.8");
check("KACHAT_TRUSTED_PROXIES replaces loopback default", docker.clientKey(fake("127.0.0.1", { "x-forwarded-for": "198.51.100.8" })) === "127.0.0.1");
const cf = createRelay({ trustCfConnectingIp: true });
check("cf-connecting-ip only with the opt-in + trusted peer", cf.clientKey(fake("127.0.0.1", { "cf-connecting-ip": "198.51.100.9" })) === "198.51.100.9"
  && cf.clientKey(fake("203.0.113.1", { "cf-connecting-ip": "198.51.100.9" })) === "203.0.113.1");

// End to end: an untrusted peer rotating X-Forwarded-For still hits its own limit.
const strict = relayServer({ trustedProxies: "none", rateMax: 3 });
const strictPort = await listen(strict.server);
const statuses = [];
for (let i = 0; i < 5; i += 1) statuses.push((await request(strictPort, "/nc-proxy/bad", { headers: { "x-forwarded-for": `10.0.0.${i}` } })).status);
check("rotating XFF from an untrusted peer is still rate limited", statuses.slice(0, 3).every((s) => s === 400) && statuses.slice(3).every((s) => s === 429), statuses.join(","));
strict.server.close();
const trusting = relayServer({ rateMax: 2 }); // loopback trusted by default
const trustingPort = await listen(trusting.server);
const tStatuses = [];
for (let i = 0; i < 4; i += 1) tStatuses.push((await request(trustingPort, "/nc-proxy/bad", { headers: { "x-forwarded-for": `198.51.100.${i}` } })).status);
check("behind a trusted proxy, each client has its own bucket", tStatuses.every((s) => s === 400), tStatuses.join(","));
trusting.server.close();

// --- 5. Limiter eviction + IPv6 /64 buckets (DSK-003) -----------------------------------------
// Rotating thousands of fresh addresses must not reset anyone already being counted.
const evict = createRelay({ rateMax: 3 });
const limited = "198.51.100.1";   // already over its limit
const midQuota = "198.51.100.2";  // two of its three requests used
const over = [];
for (let i = 0; i < 4; i += 1) over.push(evict.overRate(limited));
evict.overRate(midQuota); evict.overRate(midQuota);
check("limiter: the limited client is over before the flood", over.join(",") === "false,false,false,true", over.join(","));
let floodLimited = 0;
for (let i = 0; i < 6000; i += 1) if (evict.overRate(`2001:db8:${(i >> 8).toString(16)}:${(i & 0xff).toString(16)}::/64`)) floodLimited += 1;
check("limiter: 6000 one-off clients each get their own fresh window", floodLimited === 0, String(floodLimited));
check("limiter: 6000 rotating clients do not reset a limited client", evict.overRate(limited) === true);
check("limiter: 6000 rotating clients do not reset a mid-quota client", evict.overRate(midQuota) === false && evict.overRate(midQuota) === true);
// Over the bound with only repeat callers, the oldest goes - one at a time, never all.
const small = createRelay({ rateMax: 3, rateMaxKeys: 3 });
for (const k of ["a", "b", "c"]) { small.overRate(k); small.overRate(k); }
small.overRate("d"); small.overRate("d"); // evicts "a" only
check("limiter: full of repeat callers, only the oldest is evicted", [1, 2].map(() => small.overRate("b")).join(",") === "false,true"
  && [1, 2, 3].map(() => small.overRate("a")).join(",") === "false,false,false");

// Clients in one IPv6 /64 share a bucket; IPv4-mapped IPv6 counts as the IPv4 address.
check("IPv6 /64 key", relay.clientKey(fake("2001:db8:1:2::1")) === "2001:db8:1:2::/64", relay.clientKey(fake("2001:db8:1:2::1")));
check("IPv6 addresses in one /64 share a key", relay.clientKey(fake("2001:db8:1:2::1")) === relay.clientKey(fake("2001:0db8:0001:0002:abcd:ef01:2345:6789")));
check("IPv6 addresses in different /64s do not", relay.clientKey(fake("2001:db8:1:2::1")) !== relay.clientKey(fake("2001:db8:1:3::1")));
check("IPv4-mapped IPv6 keys as IPv4", relay.clientKey(fake("::ffff:198.51.100.7")) === "198.51.100.7" && relay.clientKey(fake("::ffff:c633:6407")) === "198.51.100.7");
check("IPv6 from a trusted proxy's XFF keys by /64", relay.clientKey(fake("127.0.0.1", { "x-forwarded-for": "2001:db8:aa:bb:1::9" })) === "2001:db8:aa:bb::/64");
const v6 = relayServer({ rateMax: 2 }); // loopback trusted by default
const v6Port = await listen(v6.server);
const v6Statuses = [];
for (const addr of ["2001:db8:5:6::1", "2001:db8:5:6::2", "2001:db8:5:6:ffff:ffff:ffff:fffe"]) {
  v6Statuses.push((await request(v6Port, "/nc-proxy/bad", { headers: { "x-forwarded-for": addr } })).status);
}
v6Statuses.push((await request(v6Port, "/nc-proxy/bad", { headers: { "x-forwarded-for": "2001:db8:5:7::1" } })).status);
check("rotating addresses inside one /64 share a bucket; the next /64 does not", v6Statuses.join(",") === "400,400,429,400", v6Statuses.join(","));
v6.server.close();

// --- 6. ChangeNOW key gate ---------------------------------------------------------------------
// The upstream plays api.changenow.io (changenowOrigin is a tests-only option). Nothing here talks
// to the real ChangeNOW.
{
  const CN_ORIGIN = `http://upstream.test:${upstreamPort}`;
  const CNE = encodeURIComponent(CN_ORIGIN);
  const SERVER_KEY = "server-key-for-tests";
  const page = { host: "kachat.test", "sec-fetch-site": "same-origin", referer: "https://kachat.test/desktop/" };
  const pagePost = { host: "kachat.test", "sec-fetch-site": "same-origin", origin: "https://kachat.test", "content-type": "application/json" };
  const quoteQ = "?fromCurrency=usdc&fromNetwork=matic&toCurrency=kas&toNetwork=kas&fromAmount=10&flow=standard";
  const minQ = "?fromCurrency=usdc&fromNetwork=matic&toCurrency=kas&toNetwork=kas&flow=standard";
  const { relay: cnRelay, server: cnServer } = relayServer({ changenowApiKey: () => SERVER_KEY, changenowOrigin: CN_ORIGIN, changenowRateMax: 100 });
  const cnPort = await listen(cnServer);
  const seen = async (path, opts) => {
    lastSeen = null;
    const r = await request(cnPort, `/nc-proxy/${CNE}${path}`, opts);
    return { r, up: lastSeen };
  };

  for (const [label, path, opts] of [
    ["GET estimated-amount", `/v2/exchange/estimated-amount${quoteQ}`, { headers: page }],
    ["GET min-amount", `/v2/exchange/min-amount${minQ}`, { headers: page }],
    ["GET by-id", "/v2/exchange/by-id?id=abc123", { headers: page }],
    ["POST exchange", "/v2/exchange", { method: "POST", headers: pagePost, body: JSON.stringify({ fromCurrency: "usdc", fromAmount: "10", address: "kaspa:qz", flow: "standard" }) }],
  ]) {
    const { r, up } = await seen(path, opts);
    check(`changenow: ${label} carries the server key`, r.status === 200 && up?.headers[CHANGENOW_KEY_HEADER] === SERVER_KEY, `${r.status} ${up?.headers?.[CHANGENOW_KEY_HEADER]}`);
  }
  const posted = await seen("/v2/exchange", { method: "POST", headers: pagePost, body: "{\"a\":1}" });
  check("changenow: the create body reaches ChangeNOW", posted.up?.method === "POST" && posted.up?.body === "{\"a\":1}");
  check("changenow: a trailing slash is the same route", (await seen(`/v2/exchange/min-amount/${minQ}`, { headers: page })).up?.headers[CHANGENOW_KEY_HEADER] === SERVER_KEY);

  // A key the client sends is never passed on: replaced on the swap calls, dropped everywhere else.
  const clientKey = await seen(`/v2/exchange/estimated-amount${quoteQ}`, { headers: { ...page, [CHANGENOW_KEY_HEADER]: "client-own-key" } });
  check("changenow: a client key header is replaced by the server key", clientKey.up?.headers[CHANGENOW_KEY_HEADER] === SERVER_KEY);
  const elsewhere = await request(relayPort, `/nc-proxy/${UP}/echo`, { headers: { [CHANGENOW_KEY_HEADER]: "client-own-key" } });
  check("changenow: a client key header is stripped on any other call", JSON.parse(elsewhere.body).headers[CHANGENOW_KEY_HEADER] === undefined);
  const elsewhere2 = await seen("/echo", { headers: { ...page, [CHANGENOW_KEY_HEADER]: "client-own-key" } });
  check("changenow: and on a non-swap path of the ChangeNOW origin", elsewhere2.up && elsewhere2.up.headers[CHANGENOW_KEY_HEADER] === undefined);

  // No key on other ChangeNOW paths or methods.
  const currencies = await seen("/v2/exchange/currencies?active=true", { headers: page });
  check("changenow: no key on an unlisted path (currencies)", currencies.r.status === 200 && currencies.up?.headers[CHANGENOW_KEY_HEADER] === undefined);
  const v1 = await seen("/v1/exchange-amount/10/usdc_kas", { headers: page });
  check("changenow: no key on the v1 API", v1.up?.headers[CHANGENOW_KEY_HEADER] === undefined);
  const head = await seen(`/v2/exchange/min-amount${minQ}`, { method: "HEAD", headers: page });
  check("changenow: no key on a HEAD of a swap path", head.up?.headers[CHANGENOW_KEY_HEADER] === undefined);
  const otherPost = await seen("/v2/exchange/other", { method: "POST", headers: pagePost, body: "{}" });
  check("changenow: POST to another path is refused", otherPost.r.status === 403 && otherPost.up === null, `${otherPost.r.status}`);
  const del = await seen("/v2/exchange", { method: "DELETE", headers: pagePost });
  check("changenow: DELETE is refused", del.r.status === 403 && del.up === null, `${del.r.status}`);

  // Only for the site's own pages.
  for (const [label, headers] of [
    ["no Fetch Metadata", { host: "kachat.test", referer: "https://kachat.test/desktop/" }],
    ["cross-site", { ...page, "sec-fetch-site": "cross-site" }],
    ["a foreign Origin", { ...pagePost, origin: "https://evil.example" }],
    ["a foreign Referer", { ...page, referer: "https://evil.example/" }],
    ["no Origin and no Referer", { host: "kachat.test", "sec-fetch-site": "same-origin" }],
  ]) {
    const { r, up } = await seen(`/v2/exchange/min-amount${minQ}`, { headers });
    check(`changenow: refused with ${label}`, r.status === 403 && up === null, `${r.status}`);
  }
  check("changenow: X-Forwarded-Host counts from a trusted proxy", cnRelay.sameOriginCaller(fake("127.0.0.1", { host: "127.0.0.1:8790", "x-forwarded-host": "kachat.test", "sec-fetch-site": "same-origin", referer: "https://kachat.test/desktop/" })));
  check("changenow: X-Forwarded-Host is ignored from anyone else", !cnRelay.sameOriginCaller(fake("203.0.113.5", { host: "127.0.0.1:8790", "x-forwarded-host": "kachat.test", "sec-fetch-site": "same-origin", referer: "https://kachat.test/desktop/" })));

  // A redirect to another origin does not take the key along.
  const hop = await request(cnPort, `/nc-proxy/${CNE}/v2/exchange/by-id?id=hop`, { headers: page });
  check("changenow: the key does not follow a redirect to another origin", hop.status === 200 && JSON.parse(hop.body).headers[CHANGENOW_KEY_HEADER] === undefined, hop.body.slice(0, 120));

  // Its own per-client limit (3 here): the 4th swap call in a minute is refused, another client
  // (behind the trusted loopback proxy) still has its own, and ordinary relaying is unaffected.
  const limited = relayServer({ changenowApiKey: SERVER_KEY, changenowOrigin: CN_ORIGIN, changenowRateMax: 3 });
  const limitedPort = await listen(limited.server);
  const statuses = [];
  for (let i = 0; i < 4; i += 1) {
    statuses.push((await request(limitedPort, `/nc-proxy/${CNE}/v2/exchange/min-amount${minQ}`, { headers: { ...page, "x-forwarded-for": "198.51.100.20" } })).status);
  }
  check("changenow: per-client swap limit", statuses.join(",") === "200,200,200,429", statuses.join(","));
  const tooMany = await request(limitedPort, `/nc-proxy/${CNE}/v2/exchange/by-id?id=x`, { headers: { ...page, "x-forwarded-for": "198.51.100.20" } });
  check("changenow: the limit answers 429 Too many swap requests with retry-after", tooMany.status === 429 && tooMany.body === "Too many swap requests" && tooMany.headers["retry-after"] === "60");
  const otherClient = await request(limitedPort, `/nc-proxy/${CNE}/v2/exchange/min-amount${minQ}`, { headers: { ...page, "x-forwarded-for": "198.51.100.21" } });
  check("changenow: another client has its own swap limit", otherClient.status === 200, `${otherClient.status}`);
  const plainRead = await request(limitedPort, `/nc-proxy/${UP}/echo`, { headers: { "x-forwarded-for": "198.51.100.20" } });
  check("changenow: the swap limit does not touch ordinary relaying", plainRead.status === 200, `${plainRead.status}`);
  limited.server.close();

  // No server key: the four calls answer "not available" and nothing goes out; the probe says off.
  const off = relayServer({ changenowApiKey: "", changenowOrigin: CN_ORIGIN });
  const offPort = await listen(off.server);
  lastSeen = null;
  const offQuote = await request(offPort, `/nc-proxy/${CNE}/v2/exchange/estimated-amount${quoteQ}`, { headers: page });
  check("changenow without a key: 503 Swap is not available", offQuote.status === 503 && offQuote.headers["x-kachat-swap"] === "unavailable" && offQuote.body === SWAP_UNAVAILABLE_MESSAGE && lastSeen === null, `${offQuote.status} ${offQuote.body}`);
  const offProbe = await request(offPort, "/nc-proxy/__swap");
  check("changenow without a key: __swap is off", offProbe.body === "off");
  const onProbe = await request(cnPort, "/nc-proxy/__swap");
  check("changenow with a key: __swap is on", onProbe.status === 200 && onProbe.body === "on" && !onProbe.body.includes(SERVER_KEY));
  off.server.close();

  // The hosted sidecar's setting (refuseNextcloud) does not get in the way of swaps.
  const hosted = relayServer({ refuseNextcloud: true, changenowApiKey: SERVER_KEY, changenowOrigin: CN_ORIGIN });
  const hostedPort = await listen(hosted.server);
  lastSeen = null;
  const hostedQuote = await request(hostedPort, `/nc-proxy/${CNE}/v2/exchange/estimated-amount${quoteQ}`, { headers: page });
  check("hosted relay: a swap quote still relays with the key", hostedQuote.status === 200 && lastSeen?.headers[CHANGENOW_KEY_HEADER] === SERVER_KEY, `${hostedQuote.status}`);
  const hostedNc = await request(hostedPort, `/nc-proxy/${UP}/remote.php/dav/files/u/`, { method: "PROPFIND", headers: { authorization: "Basic dTpw" } });
  check("hosted relay: still no Nextcloud", hostedNc.status === 403, `${hostedNc.status}`);
  hosted.server.close();
  cnServer.close();
}

server.close();
upstream.close();
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
