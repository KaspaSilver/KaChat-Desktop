// Tests for the /nc-proxy relay (tools/relay-guard.mjs) and the standalone sidecar
// (tools/nc-proxy-server.mjs). Local servers only - no internet needed. Run from the repo root:
//
//   node tools/test-relay-guard.mjs
//
// Covers DSK-001 (scheme-relative SSRF, blocked ranges, redirect hops), DSK-002 (navigation
// refusal, response sandboxing/stripping, request cookie stripping) and DSK-003 (rate-limit key,
// write gate, ChangeNOW key gate).
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRelay, ipBlocked, resolveAllowed } from "./relay-guard.mjs";

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
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(lastSeen));
  });
});
const upstreamPort = await listen(upstream);
const UP = encodeURIComponent(`http://upstream.test:${upstreamPort}`);

// Name resolution for tests: "upstream.test" is the local server; every other name goes through
// the real guard (so 127.0.0.1 etc. stay blocked, including on redirect hops).
const testResolve = (hostname) => (hostname === "upstream.test"
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
  env: { ...process.env, NC_PROXY_PORT: "0", NC_PROXY_HOST: "127.0.0.1" },
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
} finally {
  sidecar.kill();
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

// Write gate (DSK-003).
const basic = `Basic ${Buffer.from("alice:app-password").toString("base64")}`;
const writes = [
  ["POST without auth refused", "POST", "/api/form", {}, 403],
  ["junk Authorization refused", "POST", "/remote.php/dav/files/alice/x", { authorization: "x" }, 403],
  ["Basic on a non-Nextcloud path refused", "PUT", "/upload", { authorization: basic }, 403],
  ["WebDAV PUT with Basic allowed", "PUT", "/remote.php/dav/files/alice/backup.json", { authorization: basic }, 200],
  ["WebDAV MKCOL with Basic allowed", "MKCOL", "/remote.php/dav/files/alice/KaChat", { authorization: basic }, 200],
  ["OCS share POST with Basic allowed", "POST", "/ocs/v2.php/apps/files_sharing/api/v1/shares?format=json", { authorization: basic, "ocs-apirequest": "true" }, 200],
  ["Bearer on index.php allowed", "POST", "/index.php/apps/x", { authorization: "Bearer tok123" }, 200],
  ["Talk guest (jar + OCS) allowed", "POST", "/ocs/v2.php/apps/spreed/api/v4/room/tok/participants/active", { "x-proxy-jar": "jarJarJar1234", "ocs-apirequest": "true" }, 200],
  ["jar without OCS-APIRequest refused", "POST", "/ocs/v2.php/apps/spreed/api/v4/room/tok/participants/active", { "x-proxy-jar": "jarJarJar1234" }, 403],
  ["jar on a WebDAV path refused", "PUT", "/remote.php/dav/files/x", { "x-proxy-jar": "jarJarJar1234", "ocs-apirequest": "true" }, 403],
  ["dot-segment escape refused", "POST", "/remote.php/../admin", { authorization: basic }, 403],
];
for (const [name, method, path, headers, want] of writes) {
  const r = await request(relayPort, `/nc-proxy/${UP}${path}`, { method, headers, body: "x" });
  check(`write gate: ${name}`, r.status === want, `got ${r.status} ${r.body.slice(0, 80)}`);
}
const writeSeen = await request(relayPort, `/nc-proxy/${UP}/remote.php/dav/files/alice/b.json`, { method: "PUT", headers: { authorization: basic }, body: "payload" });
const writeEcho = JSON.parse(writeSeen.body);
check("PUT body + Authorization reach Nextcloud", writeEcho.body === "payload" && writeEcho.headers.authorization === basic);

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

// --- 5. ChangeNOW key gate (DSK-003) -----------------------------------------------------------
const cnUrl = (path) => new URL(`https://api.changenow.io${path}`);
const app = { host: "kachat.app", "sec-fetch-site": "same-origin" };
const cnCases = [
  ["app GET quote (Referer)", "GET", "/v2/exchange/estimated-amount", { ...app, referer: "https://kachat.app/desktop/" }, true],
  ["app POST create (Origin)", "POST", "/v2/exchange", { ...app, origin: "https://kachat.app" }, true],
  ["app GET status", "GET", "/v2/exchange/by-id", { ...app, referer: "https://kachat.app/desktop/#swaps" }, true],
  ["foreign Origin", "POST", "/v2/exchange", { ...app, origin: "https://evil.example" }, false],
  ["no Origin, foreign Referer", "GET", "/v2/exchange/min-amount", { ...app, referer: "https://evil.example/" }, false],
  ["no Origin, no Referer", "GET", "/v2/exchange/min-amount", { ...app }, false],
  ["no Fetch Metadata", "GET", "/v2/exchange/min-amount", { host: "kachat.app", referer: "https://kachat.app/desktop/" }, false],
  ["unlisted endpoint", "GET", "/v2/exchange/currencies", { ...app, referer: "https://kachat.app/desktop/" }, false],
  ["wrong method", "DELETE", "/v2/exchange", { ...app, origin: "https://kachat.app" }, false],
];
for (const [name, method, path, headers, want] of cnCases) {
  check(`changenow key: ${name}`, relay.changenowKeyAllowed(fake("127.0.0.1", headers), method, cnUrl(path)) === want);
}
check("changenow key: not over http", !relay.changenowKeyAllowed(fake("127.0.0.1", { ...app, referer: "https://kachat.app/" }), "GET", new URL("http://api.changenow.io/v2/exchange/by-id")));
check("changenow key: X-Forwarded-Host from a trusted proxy", relay.changenowKeyAllowed(fake("127.0.0.1", { host: "127.0.0.1:8790", "x-forwarded-host": "kachat.app", "sec-fetch-site": "same-origin", referer: "https://kachat.app/desktop/" }), "GET", cnUrl("/v2/exchange/by-id")));
check("changenow key: X-Forwarded-Host ignored from an untrusted peer", !relay.changenowKeyAllowed(fake("203.0.113.5", { host: "127.0.0.1:8790", "x-forwarded-host": "kachat.app", "sec-fetch-site": "same-origin", referer: "https://kachat.app/desktop/" }), "GET", cnUrl("/v2/exchange/by-id")));

server.close();
upstream.close();
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
