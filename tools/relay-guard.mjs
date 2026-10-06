// The /nc-proxy relay, shared by the Vite dev/preview server (vite.config.mjs) and the standalone
// sidecar that serves static deployments (tools/nc-proxy-server.mjs). One implementation, so a
// fix made for one can never again be missing from the other (DSK-001/002/003).
//
// The app routes cross-origin, CORS-less calls through a same-origin
//   <base>nc-proxy/<encodeURIComponent(origin)>/<path>?<query>
// passthrough:
//   - Nextcloud WebDAV/OCS          (ui/nextcloud.js: Basic auth, PROPFIND/PUT/MKCOL/DELETE/POST)
//   - Nextcloud Talk                 (ui/talk.js: Basic auth, or a guest session in a cookie jar)
//   - KNS name resolution            (engine/kns.js)
//   - link previews + preview images (ui/app.js, ui/kachat-names-live.js: x-preview, x-preview-image)
//   - indexers, api.kaspa.org, node seeds, ChangeNOW ... (engine/endpoints.js fetch wrapper)
//
// What this module guarantees for every request:
//   * The host actually connected to is the host that was checked: the target URL is built first
//     and must keep the encoded origin (a scheme-relative "//other-host/" path is refused), the
//     name is resolved ONCE, every answer must be allowed, and the socket is pinned to that
//     answer with a custom `lookup` - on the first hop and on every redirect hop.
//   * Loopback, link-local/cloud metadata, unspecified, multicast/reserved, NAT64, 6to4/Teredo
//     and documentation ranges are never reachable. Private ranges (RFC1918, CGNAT, ULA) are
//     reachable only when the caller opts in (a LAN Nextcloud behind a private dev server).
//   * The relay answers fetch() calls, never a page: document/frame loads are refused, and every
//     relayed answer carries `content-security-policy: sandbox` + `x-content-type-options: nosniff`,
//     with cookies, auth challenges, refresh/link, clear-site-data and hop-by-hop headers removed.
//   * The browser's cookies for THIS origin never leave, and nothing that identifies the reader
//     (forwarding headers, cf-*) is passed on.
//   * Write methods go only where the app writes: its own API hosts, Nextcloud-shaped requests
//     (Basic/Bearer auth on /remote.php/, /ocs/, /index.php/), or a Talk guest session (jar + OCS).
//   * Rate limits key on the socket peer; forwarding headers count only from a trusted proxy.
//
// Node 20+, no dependencies: the sidecar copy runs as-is under node:20-alpine.
import http from "node:http";
import https from "node:https";
import dns from "node:dns";
import net from "node:net";

// Connection-scoped headers (RFC 9110 7.6.1): they describe one hop and must not be relayed.
// Relaying transfer-encoding is what once truncated large Nextcloud downloads.
export const HOP_BY_HOP = [
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade", "proxy-connection",
];

// Upstream response headers that must never reach the browser as if this origin had sent them.
export const STRIPPED_RESPONSE_HEADERS = [
  "set-cookie", "set-cookie2",                       // cookie tossing onto this origin
  "www-authenticate", "proxy-authenticate",          // a native auth prompt on our domain
  "refresh", "link",                                 // navigation / preload / prefetch
  "clear-site-data",                                 // would wipe the wallet's storage
  "strict-transport-security", "alt-svc",            // transport policy for OUR host
  "service-worker-allowed", "origin-agent-cluster",
  "nel", "report-to", "reporting-endpoints",         // report beacons to a third party
  "content-security-policy-report-only",
  "access-control-allow-origin", "access-control-allow-credentials",
  "access-control-allow-headers", "access-control-allow-methods",
  "access-control-expose-headers", "access-control-max-age",
];

// Headers that would tell the target who the reader is. The relay speaks for itself.
const CLIENT_IDENTITY_HEADERS = [
  "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-forwarded-port",
  "x-forwarded-server", "forwarded", "x-real-ip", "true-client-ip", "x-client-ip",
  "x-cluster-client-ip", "via",
];

// Request kinds a browser uses to RENDER a response. The relay never serves those.
const NAVIGATION_DESTS = new Set(["document", "iframe", "frame", "embed", "object"]);

// Hosts the app itself writes to (the hosts engine/endpoints.js relays, plus KNS).
const WRITE_API_HOST_RE = /(^|\.)kasia\.wtf$|(^|\.)kachat\.duckdns\.org$|^tnkachat\.duckdns\.org$|^api(-tn\d+)?\.kaspa\.org$|(^|\.)kaspa\.(green|red|stream|blue|ws)$|(^|\.)changenow\.io$|^api\.knsdomains\.org$/i;
// Nextcloud's API roots: WebDAV (remote.php), OCS (ocs/v1.php, ocs/v2.php incl. Talk/spreed),
// and index.php routes (previews). ui/nextcloud.js and ui/talk.js write only under these.
const NEXTCLOUD_PATH_RE = /^\/(?:remote\.php|ocs|index\.php)\//i;
const JAR_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

// ChangeNOW: the server's API key is attached only to the swap calls ui/swaps.js makes.
const CHANGENOW_HOST = "api.changenow.io";
const CHANGENOW_KEY_ROUTES = new Set([
  "GET /v2/exchange/estimated-amount",
  "GET /v2/exchange/min-amount",
  "GET /v2/exchange/by-id",
  "POST /v2/exchange",
]);

// --- Addresses -------------------------------------------------------------------------------

function ipv4Octets(ip) {
  const parts = String(ip).split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  return octets.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? octets : null;
}

/** 16 bytes of an IPv6 address (validated by net.isIP first), embedded dotted quad included. */
function ipv6Bytes(ip) {
  let s = String(ip).split("%")[0].toLowerCase();
  let tail = null;
  const dotted = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (dotted) {
    tail = ipv4Octets(dotted[2]);
    if (!tail) return null;
    s = `${dotted[1]}0:0`;
  }
  const groupsOf = (part) => (part ? part.split(":").map((h) => parseInt(h, 16)) : []);
  let groups;
  if (s.includes("::")) {
    const [head, rest] = s.split("::");
    const h = groupsOf(head);
    const t = groupsOf(rest);
    groups = [...h, ...new Array(Math.max(0, 8 - h.length - t.length)).fill(0), ...t];
  } else {
    groups = groupsOf(s);
  }
  if (groups.length !== 8 || groups.some((g) => !Number.isInteger(g) || g < 0 || g > 0xffff)) return null;
  const bytes = [];
  for (const g of groups) bytes.push(g >> 8, g & 0xff);
  if (tail) bytes.splice(12, 4, ...tail);
  return bytes;
}

/** "Private" = reachable only with allowPrivate (a LAN Nextcloud); everything else blocked here
 *  is never reachable. Returns "blocked", "private" or "public". */
function classifyIpv4(octets) {
  const [a, b, c] = octets;
  if (a === 0 || a === 127 || a >= 224) return "blocked";             // this-net, loopback, 224/3
  if (a === 169 && b === 254) return "blocked";                        // link-local + metadata
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return "blocked";  // IETF assignments, TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return "blocked";             // 6to4 relay anycast
  if (a === 198 && (b === 18 || b === 19)) return "blocked";           // benchmarking 198.18/15
  if (a === 198 && b === 51 && c === 100) return "blocked";            // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return "blocked";             // TEST-NET-3
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return "private";
  if (a === 100 && b >= 64 && b <= 127) return "private";              // CGNAT / Tailscale
  return "public";
}

function classifyIpv6(bytes) {
  const zeroUpTo = (n) => bytes.slice(0, n).every((x) => x === 0);
  if (zeroUpTo(10) && bytes[10] === 0xff && bytes[11] === 0xff) return classifyIpv4(bytes.slice(12)); // ::ffff:0:0/96
  if (zeroUpTo(12)) return "blocked";                                  // ::, ::1, ::a.b.c.d (compat)
  if (bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b) return "blocked"; // 64:ff9b::/96 + 64:ff9b:1::/48 NAT64
  if (bytes[0] === 0x01 && bytes.slice(1, 8).every((x) => x === 0)) return "blocked"; // 100::/64 discard
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return "blocked";        // 2002::/16 6to4
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x00 && bytes[3] === 0x00) return "blocked"; // 2001::/32 Teredo
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) return "blocked"; // 2001:db8::/32 docs
  if (bytes[0] === 0xff) return "blocked";                             // ff00::/8 multicast
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return "blocked"; // fe80::/10 link-local
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0xc0) return "blocked"; // fec0::/10 site-local
  if ((bytes[0] & 0xfe) === 0xfc) return "private";                    // fc00::/7 ULA
  return "public";
}

/** Is `address` (a literal IP) off limits? Anything that is not a valid IP is. */
export function ipBlocked(address, { allowPrivate = false } = {}) {
  const ip = String(address || "").trim().toLowerCase().replace(/^\[|\]$/g, "");
  const kind = net.isIP(ip.split("%")[0]);
  let cls = "blocked";
  if (kind === 4) cls = classifyIpv4(ipv4Octets(ip));
  else if (kind === 6) {
    const bytes = ipv6Bytes(ip);
    cls = bytes ? classifyIpv6(bytes) : "blocked";
  }
  if (cls === "private") return !allowPrivate;
  return cls !== "public";
}

/** Names the relay must never reach, whatever they resolve to. */
export function isBlockedHost(hostname) {
  const h = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
  return !h || h === "localhost" || h.endsWith(".localhost")
    || h === "metadata.google.internal" || h === "metadata" || h.endsWith(".internal");
}

/** Resolve `hostname` once. Returns the address to pin the connection to, or null when the name
 *  is blocked, does not resolve, or ANY answer is off limits (a mixed answer is how rebinding
 *  attacks hide the internal address). */
export async function resolveAllowed(hostname, { allowPrivate = false } = {}) {
  const h = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
  if (isBlockedHost(h)) return null;
  const kind = net.isIP(h);
  if (kind) return ipBlocked(h, { allowPrivate }) ? null : { address: h, family: kind };
  let answers = [];
  try { answers = await dns.promises.lookup(h, { all: true, verbatim: true }); } catch { return null; }
  if (!answers.length || answers.some((a) => ipBlocked(a.address, { allowPrivate }))) return null;
  return { address: answers[0].address, family: answers[0].family };
}

// --- Trusted proxies (who may tell us the client's address) ----------------------------------

function normalizePeer(address) {
  const ip = String(address || "").trim().toLowerCase().replace(/^\[|\]$/g, "").split("%")[0];
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  return mapped ? mapped[1] : ip;
}

/** KACHAT_TRUSTED_PROXIES: comma/space separated IPs or CIDRs, plus the word `loopback`
 *  (127.0.0.0/8 and ::1) or `none`. Unset or empty means `loopback` - the sidecar and the
 *  preview server sit behind a reverse proxy on the same machine. Setting it REPLACES the
 *  default, so list `loopback` too if you still want it. */
export function parseTrustedProxies(spec) {
  const list = new net.BlockList();
  const raw = String(spec ?? "").trim() || "loopback";
  for (const token of raw.split(/[\s,]+/).filter(Boolean)) {
    const t = token.toLowerCase();
    if (t === "none") continue;
    if (t === "loopback") {
      list.addSubnet("127.0.0.0", 8, "ipv4");
      list.addAddress("::1", "ipv6");
      continue;
    }
    const [addr, prefix] = t.split("/");
    const kind = net.isIP(addr);
    if (!kind) throw new Error(`KACHAT_TRUSTED_PROXIES: not an IP or CIDR: ${token}`);
    const type = kind === 4 ? "ipv4" : "ipv6";
    if (prefix === undefined) list.addAddress(addr, type);
    else list.addSubnet(addr, Number(prefix), type);
  }
  return (address) => {
    const ip = normalizePeer(address);
    const kind = net.isIP(ip);
    return kind ? list.check(ip, kind === 4 ? "ipv4" : "ipv6") : false;
  };
}

// --- The relay -------------------------------------------------------------------------------

/**
 * @param {object} options
 * @param {boolean} [options.allowPrivate]  reach RFC1918/CGNAT/ULA (private installs only)
 * @param {string}  [options.trustedProxies] KACHAT_TRUSTED_PROXIES syntax (default: loopback)
 * @param {boolean} [options.trustCfConnectingIp] honour cf-connecting-ip from a trusted proxy
 *                  (only when the trusted proxy is Cloudflare-fronted and clears the header otherwise)
 * @param {string|function} [options.changenowApiKey] server ChangeNOW key (or a getter)
 * @param {number}  [options.readTimeoutMs]   GET/HEAD/OPTIONS socket inactivity limit
 * @param {number}  [options.rateMax]          requests per client per minute
 * @param {number}  [options.changenowRateMax] key-attached ChangeNOW calls per client per minute
 * @param {function} [options.resolveAllowed]  (hostname) => {address,family}|null - tests only
 * @param {function} [options.log]
 */
export function createRelay(options = {}) {
  const allowPrivate = Boolean(options.allowPrivate);
  const isTrustedProxy = parseTrustedProxies(options.trustedProxies);
  const trustCf = Boolean(options.trustCfConnectingIp);
  const changenowKey = () => String((typeof options.changenowApiKey === "function" ? options.changenowApiKey() : options.changenowApiKey) || "").trim();
  const readTimeoutMs = Number(options.readTimeoutMs) > 0 ? Number(options.readTimeoutMs) : 15000;
  const longPollTimeoutMs = Math.max(60000, readTimeoutMs);
  const writeTimeoutMs = Math.max(120000, readTimeoutMs);
  const RATE_WINDOW_MS = 60_000;
  const rateMax = Number(options.rateMax) > 0 ? Number(options.rateMax) : 600;
  const changenowRateMax = Number(options.changenowRateMax) > 0 ? Number(options.changenowRateMax) : 30;
  const resolveTarget = typeof options.resolveAllowed === "function"
    ? options.resolveAllowed
    : (hostname) => resolveAllowed(hostname, { allowPrivate });
  const log = typeof options.log === "function" ? options.log : () => {};
  const MAX_REDIRECT_HOPS = 5;

  // Cookie jars for Nextcloud Talk. Cookies never travel between the browser and a target, but a
  // Talk GUEST session lives in the PHP session cookie. A request carrying x-proxy-jar: <id> gets
  // the cookies that origin set for that jar, and the answer's Set-Cookie is stored under it.
  // Memory-only, per relay process, bounded, and dropped after an hour idle.
  const jars = new Map(); // jarId -> { byOrigin: Map(origin -> Map(name -> value)), touched }
  const JAR_TTL_MS = 60 * 60 * 1000;
  const JAR_MAX = 500;
  const jarFor = (id, origin) => {
    const now = Date.now();
    for (const [key, jar] of jars) if (now - jar.touched > JAR_TTL_MS) jars.delete(key);
    let jar = jars.get(id);
    if (!jar) {
      while (jars.size >= JAR_MAX) jars.delete(jars.keys().next().value);
      jar = { byOrigin: new Map(), touched: now };
      jars.set(id, jar);
    }
    jar.touched = now;
    let cookies = jar.byOrigin.get(origin);
    if (!cookies) { cookies = new Map(); jar.byOrigin.set(origin, cookies); }
    return cookies;
  };

  /** Who is asking: the socket peer, unless the peer is a trusted proxy, in which case the
   *  right-most X-Forwarded-For entry that is not itself a trusted proxy (so a client-supplied
   *  XFF prefix, which nginx's $proxy_add_x_forwarded_for keeps, cannot choose the key). */
  const clientKey = (req) => {
    const peer = normalizePeer(req.socket?.remoteAddress) || "?";
    if (!isTrustedProxy(peer)) return peer;
    if (trustCf) {
      const cf = normalizePeer(String(req.headers["cf-connecting-ip"] || ""));
      if (net.isIP(cf)) return cf;
    }
    const hops = String(req.headers["x-forwarded-for"] || "").split(",").map((s) => normalizePeer(s)).filter((s) => net.isIP(s));
    for (let i = hops.length - 1; i >= 0; i -= 1) if (!isTrustedProxy(hops[i])) return hops[i];
    return hops[0] || peer;
  };

  const makeLimiter = (max) => {
    const byKey = new Map();
    return (key) => {
      const now = Date.now();
      let entry = byKey.get(key);
      if (!entry || now - entry.start > RATE_WINDOW_MS) {
        if (byKey.size > 5000) byKey.clear();
        entry = { start: now, count: 0 };
        byKey.set(key, entry);
      }
      entry.count += 1;
      return entry.count > max;
    };
  };
  const overRate = makeLimiter(rateMax);
  const overChangenowRate = makeLimiter(changenowRateMax);
  let lastRateLog = 0;
  const noteRateLimited = (key, what) => {
    const now = Date.now();
    if (now - lastRateLog > 60_000) { lastRateLog = now; log(`nc-proxy: ${what} rate limit hit for ${key}`); }
  };

  /** The host this request was addressed to (the site the app is served from). */
  const requestHost = (req) => {
    const peerTrusted = isTrustedProxy(req.socket?.remoteAddress);
    const forwarded = peerTrusted ? String(req.headers["x-forwarded-host"] || "").split(",")[0].trim() : "";
    return (forwarded || String(req.headers.host || "")).trim().toLowerCase();
  };

  /** A same-origin call from the page itself: Fetch Metadata says so AND the Origin (or, for a
   *  GET, which carries none, the Referer) names the host the request was sent to. */
  const sameOriginCaller = (req) => {
    if (String(req.headers["sec-fetch-site"] || "").toLowerCase() !== "same-origin") return false;
    const expected = requestHost(req);
    if (!expected) return false;
    const hostOf = (value) => { try { return new URL(String(value)).host.toLowerCase(); } catch { return ""; } };
    if (req.headers.origin !== undefined) return hostOf(req.headers.origin) === expected;
    return Boolean(req.headers.referer) && hostOf(req.headers.referer) === expected;
  };

  /** Should the server's ChangeNOW key ride on this call? */
  const changenowKeyAllowed = (req, method, target) => target.protocol === "https:"
    && target.hostname.toLowerCase() === CHANGENOW_HOST
    && CHANGENOW_KEY_ROUTES.has(`${method} ${target.pathname.replace(/\/+$/, "")}`)
    && sameOriginCaller(req);

  /** May this write (non GET/HEAD/OPTIONS) go to `target`? */
  const writeAllowed = (req, target) => {
    if (WRITE_API_HOST_RE.test(target.hostname)) return true;
    if (!NEXTCLOUD_PATH_RE.test(target.pathname)) return false;
    // A Nextcloud app password (Basic) or token (Bearer), on a Nextcloud API path.
    if (/^(basic|bearer)\s+\S+/i.test(String(req.headers.authorization || "").trim())) return true;
    // A Talk guest session: its cookie jar, on an OCS path, flagged as an OCS API call.
    return JAR_ID_RE.test(String(req.headers["x-proxy-jar"] || "").trim())
      && /^\/ocs\//i.test(target.pathname)
      && String(req.headers["ocs-apirequest"] || "").toLowerCase() === "true";
  };

  const refuse = (res, status, message, extra = {}) => {
    res.writeHead(status, { "content-type": "text/plain", "cache-control": "no-store", "x-content-type-options": "nosniff", ...extra });
    res.end(message);
  };

  /** Handle one relay request. `url` is the part after the mount: "/<origin>/<path>?<query>". */
  const handle = (req, res, url) => {
    // "Are you there?" (engine/endpoints.js) - answered before anything else.
    const probePath = String(url || "").split("?")[0].replace(/\/+$/, "");
    if (probePath === "/__probe") {
      res.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" });
      res.end("kachat-proxy");
      return;
    }
    // Never a page of this origin: a top-level or framed load of a relayed URL would render
    // someone else's HTML here, with this origin's storage in reach.
    const fetchDest = String(req.headers["sec-fetch-dest"] || "").toLowerCase();
    const fetchMode = String(req.headers["sec-fetch-mode"] || "").toLowerCase();
    if (NAVIGATION_DESTS.has(fetchDest) || fetchMode === "navigate" || fetchMode === "nested-navigate") {
      refuse(res, 403, "Proxy target not allowed");
      return;
    }
    const who = clientKey(req);
    if (overRate(who)) {
      noteRateLimited(who, "relay");
      refuse(res, 429, "Too many requests", { "retry-after": "60" });
      return;
    }
    const match = /^\/([^/?]+)(\/[^?]*)?(\?.*)?$/.exec(String(url || ""));
    let origin = null;
    try { origin = match ? new URL(decodeURIComponent(match[1])) : null; } catch { origin = null; }
    if (!origin || (origin.protocol !== "http:" && origin.protocol !== "https:") || origin.username || origin.password) {
      refuse(res, 400, "Bad proxy target");
      return;
    }
    // The TARGET actually forwarded must keep the encoded origin: a path segment like
    // "//169.254.169.254/" is scheme-relative and would replace the host after an origin check.
    let target = null;
    try { target = new URL(`${match[2] || "/"}${match[3] || ""}`, origin.origin); } catch { target = null; }
    if (!target || target.origin !== origin.origin || isBlockedHost(target.hostname)) {
      refuse(res, 403, "Proxy target not allowed");
      return;
    }
    const method = String(req.method || "GET").toUpperCase();
    if (!["GET", "HEAD", "OPTIONS"].includes(method) && !writeAllowed(req, target)) {
      refuse(res, 403, "Proxy method not allowed");
      return;
    }

    const headers = { ...req.headers };
    // The browser's origin/referer would confuse some reverse-proxy setups, and its cookies
    // belong to THIS site. Nextcloud also mistakes a stray session cookie next to Basic auth
    // for a browser session without a CSRF token and answers 401.
    delete headers.host;
    delete headers.origin;
    delete headers.referer;
    delete headers.cookie;
    for (const name of CLIENT_IDENTITY_HEADERS) delete headers[name];
    for (const name of Object.keys(headers)) {
      if (name.startsWith("cf-") || name.startsWith("sec-fetch-")) delete headers[name];
    }
    for (const name of HOP_BY_HOP) delete headers[name];
    const jarId = String(headers["x-proxy-jar"] || "").trim();
    delete headers["x-proxy-jar"];
    const jarCookies = JAR_ID_RE.test(jarId) ? jarFor(jarId, origin.origin) : null;
    if (jarCookies && jarCookies.size) headers.cookie = [...jarCookies].map(([n, v]) => `${n}=${v}`).join("; ");
    // Talk's signaling channel is a long poll the server holds for up to 30s.
    const longPoll = String(headers["x-proxy-long-poll"] || "") === "1";
    delete headers["x-proxy-long-poll"];
    // Link-preview scrape: a crawler UA so sites emit og: tags as they do for unfurlers. Twitter/X
    // 404s the crawler but serves OG tags to a browser UA. Mirrors iOS LinkPreviewService.
    if (headers["x-preview"] === "1") {
      const host = origin.hostname.replace(/^www\./, "").toLowerCase();
      const browserUaHosts = new Set(["x.com", "twitter.com", "mobile.twitter.com"]);
      headers["user-agent"] = browserUaHosts.has(host)
        ? "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15"
        : "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)";
      headers.accept = "text/html,application/xhtml+xml";
    }
    delete headers["x-preview"];
    // Preview IMAGE bytes: Meta's CDNs refuse a bare hotlink, so a browser UA + the post as
    // Referer, or Meta's own crawler. Mirrors iOS LinkPreviewService.fetchPreviewImage.
    if (headers["x-preview-image"]) {
      const crawler = headers["x-preview-image"] === "crawler";
      headers["user-agent"] = crawler
        ? "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)"
        : "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";
      headers.accept = "image/avif,image/webp,image/apng,image/*,*/*;q=0.8";
      if (!crawler && headers["x-preview-referer"]) headers.referer = String(headers["x-preview-referer"]);
    }
    delete headers["x-preview-image"];
    delete headers["x-preview-referer"];
    // ChangeNOW: the server key (never shipped in the page) rides only on the app's own swap calls.
    // A key the page sends itself (a reader's own, from Settings) wins and is just passed on.
    const serverKey = changenowKey();
    if (serverKey && !String(headers["x-changenow-api-key"] || "").trim() && changenowKeyAllowed(req, method, target)) {
      if (overChangenowRate(who)) {
        noteRateLimited(who, "ChangeNOW");
        refuse(res, 429, "Too many swap requests", { "retry-after": "60" });
        return;
      }
      headers["x-changenow-api-key"] = serverKey;
    }
    // Opt-in "soft 404" (KNS): an upstream 404 comes back as 200 + x-upstream-status: 404.
    const soft404 = headers["x-proxy-soft-404"] === "1";
    delete headers["x-proxy-soft-404"];

    const isWrite = !["GET", "HEAD", "OPTIONS"].includes(method);
    const timeoutMs = isWrite ? writeTimeoutMs : (longPoll ? longPollTimeoutMs : readTimeoutMs);
    // Set once an answer (relayed or refused) has started, so a late timeout/error cannot
    // write a second one; a failure after the headers went out just cuts the stream.
    let answered = false;
    const fail = (status, message) => {
      if (res.headersSent) { if (!res.writableFinished) res.destroy(); return; }
      answered = true;
      refuse(res, status, message);
    };

    // Redirects are followed server-side (GET/HEAD, capped): a 3xx passed through would hand the
    // browser a cross-origin Location that CORS then refuses. Each hop is checked and pinned.
    const forward = async (hopTarget, hop) => {
      const pinned = await resolveTarget(hopTarget.hostname);
      if (!pinned) { fail(403, hop === 0 ? "Proxy target not allowed" : "Redirect target not allowed"); return; }
      const pinnedLookup = (_host, opts, callback) => {
        if (typeof opts === "function") { callback = opts; opts = {}; }
        if (opts && opts.all) callback(null, [{ address: pinned.address, family: pinned.family }]);
        else callback(null, pinned.address, pinned.family);
      };
      // A redirect to another origin gets a clean request: Authorization, jar cookies and the
      // ChangeNOW key belong to the origin that was asked for.
      const sameOrigin = hopTarget.origin === origin.origin;
      const hopHeaders = { ...headers, host: hopTarget.host };
      if (!sameOrigin) {
        delete hopHeaders.authorization;
        delete hopHeaders.cookie;
        delete hopHeaders["x-changenow-api-key"];
      }
      const client = hopTarget.protocol === "http:" ? http : https;
      const upstream = client.request({
        protocol: hopTarget.protocol,
        hostname: hopTarget.hostname.replace(/^\[|\]$/g, ""),
        port: hopTarget.port || (hopTarget.protocol === "http:" ? 80 : 443),
        method,
        path: `${hopTarget.pathname}${hopTarget.search}` || "/",
        headers: hopHeaders,
        lookup: pinnedLookup,
        servername: net.isIP(hopTarget.hostname.replace(/^\[|\]$/g, "")) ? undefined : hopTarget.hostname,
      }, (upstreamRes) => {
        const status = upstreamRes.statusCode || 502;
        const location = upstreamRes.headers.location;
        if (location && status >= 300 && status < 400 && hop < MAX_REDIRECT_HOPS && (method === "GET" || method === "HEAD")) {
          let next = null;
          try { next = new URL(location, hopTarget); } catch { next = null; }
          // A server redirecting to the very URL asked for would loop; pass that through.
          if (next && next.href !== hopTarget.href && (next.protocol === "http:" || next.protocol === "https:")) {
            upstreamRes.resume();
            if (next.username || next.password || isBlockedHost(next.hostname)) { fail(403, "Redirect target not allowed"); return; }
            forward(next, hop + 1).catch(() => fail(502, "Proxy error"));
            return;
          }
        }
        if (answered) { upstreamRes.resume(); return; }
        answered = true;
        if (jarCookies && sameOrigin) {
          for (const line of [].concat(upstreamRes.headers["set-cookie"] || [])) {
            const first = String(line).split(";")[0];
            const eq = first.indexOf("=");
            if (eq <= 0) continue;
            const name = first.slice(0, eq).trim();
            const value = first.slice(eq + 1).trim();
            if (/max-age=0|expires=thu, 01 jan 1970/i.test(line)) jarCookies.delete(name);
            else jarCookies.set(name, value);
          }
        }
        const responseHeaders = { ...upstreamRes.headers };
        for (const name of HOP_BY_HOP) delete responseHeaders[name];
        for (const name of STRIPPED_RESPONSE_HEADERS) delete responseHeaders[name];
        // Data for fetch(), never a page of this origin.
        responseHeaders["content-security-policy"] = "sandbox";
        responseHeaders["x-content-type-options"] = "nosniff";
        const mask404 = soft404 && status === 404;
        if (mask404) responseHeaders["x-upstream-status"] = "404";
        res.writeHead(mask404 ? 200 : status, responseHeaders);
        upstreamRes.pipe(res);
      });
      // Socket inactivity: a stalled upstream gets a prompt 504 rather than the front proxy's.
      // Writes (a large Nextcloud backup PUT) may sit silent while the server stores them.
      upstream.setTimeout(timeoutMs, () => {
        fail(504, "Proxy upstream timeout");
        upstream.destroy();
      });
      upstream.on("error", (error) => fail(502, `Proxy error: ${error.message}`));
      res.on("close", () => { if (!res.writableFinished) upstream.destroy(); });
      // Only the first hop carries the browser's body; redirect hops are GET/HEAD.
      if (hop === 0) req.pipe(upstream);
      else upstream.end();
    };
    forward(target, 0).catch(() => fail(502, "Proxy error"));
  };

  return { handle, clientKey, writeAllowed, changenowKeyAllowed, sameOriginCaller };
}
