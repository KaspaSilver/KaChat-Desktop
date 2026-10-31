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
//   - indexers, api.kaspa.org, node seeds ...  (engine/endpoints.js fetch wrapper)
//   - ChangeNOW Swap                 (ui/swap-quote.js: quotes, minimum, create, status)
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
//   * Write methods go only where the app writes: its own API hosts, or the ONE Nextcloud the app
//     names in x-kachat-nextcloud-origin - on /remote.php/ or /ocs/ with Basic/Bearer auth, or a
//     Talk guest session (jar + OCS).
//   * Rate limits key on the socket peer (an IPv6 client by its /64); forwarding headers count only
//     from a trusted proxy. A flood of new addresses evicts expired and one-off entries, never
//     everyone's counters at once.
//   * The server's ChangeNOW API key (never in the page) rides only on the app's four swap calls -
//     GET estimated-amount, GET min-amount, GET by-id, POST exchange on https://api.changenow.io -
//     from a same-origin page or a listed KaPay Extension, under its own per-client limit. A key
//     header a client sends is dropped on every request, so nobody can route their own key through
//     here either. Without a server key those four calls are answered "Swap is not available right
//     now" (503).
//
// Node 20+, no dependencies: the sidecar copy runs as-is under node:20-alpine (with relay-rules.mjs
// beside it). What it refuses, strips and allows is in relay-rules.mjs, shared with the Cloudflare
// Pages Function (functions/nc-proxy/[[path]].js).
import http from "node:http";
import https from "node:https";
import dns from "node:dns";
import net from "node:net";
import {
  PROBE_REPLY, HOP_BY_HOP, STRIPPED_RESPONSE_HEADERS, CLIENT_IDENTITY_HEADERS, NAVIGATION_DESTS,
  WRITE_API_HOST_RE, NEXTCLOUD_WRITE_PATH_RE, NEXTCLOUD_REFUSED_MESSAGE, isNextcloudRelayRequest,
  JAR_ID_RE, NEXTCLOUD_ORIGIN_HEADER, RATE_MAX_KEYS, CHANGENOW_ORIGIN, CHANGENOW_KEY_HEADER,
  CHANGENOW_KEY_ROUTES, SWAP_UNAVAILABLE_MESSAGE, SWAP_PROBE_PATH, CHANGENOW_CLIENT_KEY_HEADER,
  CHANGENOW_CLIENT_KEY_RE, EXTENSION_ID_HEADER, parseExtensionIds, listedExtensionCaller, ipv4Octets,
  ipv6Bytes, isBlockedHost, createLimiter, applyPreviewHeaders,
} from "./relay-rules.mjs";

// The rules are defined in relay-rules.mjs; these were always exported from here, and still are.
export {
  HOP_BY_HOP, STRIPPED_RESPONSE_HEADERS, NEXTCLOUD_REFUSED_MESSAGE, isNextcloudRelayRequest,
  NEXTCLOUD_ORIGIN_HEADER, CHANGENOW_ORIGIN, CHANGENOW_KEY_HEADER, CHANGENOW_KEY_ROUTES,
  SWAP_UNAVAILABLE_MESSAGE, SWAP_PROBE_PATH, CHANGENOW_CLIENT_KEY_HEADER, isBlockedHost,
};

// --- Addresses -------------------------------------------------------------------------------

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

/** The rate-limit bucket for a client address: an IPv4 address as-is (IPv4-mapped IPv6 counts as
 *  the IPv4 address), an IPv6 address by its /64 - one subscriber's whole allocation, which costs
 *  nothing to rotate through. Anything else (no peer) is returned unchanged. */
export function rateKeyFor(address) {
  const ip = normalizePeer(address);
  if (net.isIP(ip) !== 6) return ip;
  const bytes = ipv6Bytes(ip);
  if (!bytes) return ip;
  if (bytes.slice(0, 10).every((x) => x === 0) && bytes[10] === 0xff && bytes[11] === 0xff) return bytes.slice(12).join(".");
  const groups = [];
  for (let i = 0; i < 8; i += 2) groups.push(((bytes[i] << 8) | bytes[i + 1]).toString(16));
  return `${groups.join(":")}::/64`;
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
 * @param {number}  [options.readTimeoutMs]   GET/HEAD/OPTIONS socket inactivity limit
 * @param {number}  [options.rateMax]          requests per client per minute
 * @param {number}  [options.rateMaxKeys]      client keys tracked by the limiter (default 5000)
 * @param {string|function} [options.changenowApiKey] the server's ChangeNOW key (or a getter); empty
 *                  means swaps are off on this server
 * @param {boolean} [options.acceptClientChangenowKey] a KaChat someone runs for themselves (the dev /
 *                  preview server, a personal deployment): with no server key, the swap calls use
 *                  the key the person pasted in the app (CHANGENOW_CLIENT_KEY_HEADER). Never on a
 *                  site other people open.
 * @param {number}  [options.changenowRateMax] key-attached ChangeNOW calls per client per minute (30)
 * @param {string}  [options.kapayExtensionIds] KAPAY_EXTENSION_IDS syntax: the KaPay Extension IDs
 *                  whose Swap may use the server's key (listedExtensionCaller); empty: none
 * @param {string}  [options.changenowOrigin]  where the key routes live - tests only
 * @param {function} [options.resolveAllowed]  (hostname) => {address,family}|null - tests only
 * @param {function} [options.log]
 */
export function createRelay(options = {}) {
  const allowPrivate = Boolean(options.allowPrivate);
  const isTrustedProxy = parseTrustedProxies(options.trustedProxies);
  const trustCf = Boolean(options.trustCfConnectingIp);
  const readTimeoutMs = Number(options.readTimeoutMs) > 0 ? Number(options.readTimeoutMs) : 15000;
  const longPollTimeoutMs = Math.max(60000, readTimeoutMs);
  const writeTimeoutMs = Math.max(120000, readTimeoutMs);
  const rateMax = Number(options.rateMax) > 0 ? Number(options.rateMax) : 600;
  const rateMaxKeys = Number(options.rateMaxKeys) > 0 ? Number(options.rateMaxKeys) : RATE_MAX_KEYS;
  const changenowKey = () => String((typeof options.changenowApiKey === "function" ? options.changenowApiKey() : options.changenowApiKey) || "").trim();
  const changenowRateMax = Number(options.changenowRateMax) > 0 ? Number(options.changenowRateMax) : 30;
  const acceptClientChangenowKey = Boolean(options.acceptClientChangenowKey);
  const kapayExtensionIds = parseExtensionIds(options.kapayExtensionIds);
  const changenowOrigin = String(options.changenowOrigin || CHANGENOW_ORIGIN).replace(/\/+$/, "").toLowerCase();
  const resolveTarget = typeof options.resolveAllowed === "function"
    ? options.resolveAllowed
    : (hostname) => resolveAllowed(hostname, { allowPrivate });
  const log = typeof options.log === "function" ? options.log : () => {};
  // A relay run by a site other people open (desktop.kachat.app's sidecar) carries no Nextcloud
  // traffic at all: logins, app passwords, Talk and share links stay between the person and their
  // Nextcloud, through a KaChat they run themselves (Kaspa Quick Start). The app turns Nextcloud
  // off on such sites too; this also stops an old, cached copy of the page from using the relay.
  const refuseNextcloud = Boolean(options.refuseNextcloud);
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
   *  XFF prefix, which nginx's $proxy_add_x_forwarded_for keeps, cannot choose the key).
   *  The answer is a rate-limit bucket (rateKeyFor): an IPv6 client counts by its /64. */
  const clientAddress = (req) => {
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
  const clientKey = (req) => rateKeyFor(clientAddress(req));

  const overRate = createLimiter(rateMax, rateMaxKeys);
  const overChangenowRate = createLimiter(changenowRateMax, rateMaxKeys);
  let lastRateLog = 0;
  const noteRateLimited = (key, what) => {
    const now = Date.now();
    if (now - lastRateLog > 60_000) { lastRateLog = now; log(`nc-proxy: ${what} rate limit hit for ${key}`); }
  };

  /** The Nextcloud origin the app declared for this call (NEXTCLOUD_ORIGIN_HEADER), normalised
   *  the way URL.origin is (lower-case host, default port dropped), or "" when absent/invalid. */
  const declaredNextcloudOrigin = (req) => {
    const raw = String(req.headers[NEXTCLOUD_ORIGIN_HEADER] || "").trim();
    if (!raw) return "";
    try {
      const url = new URL(raw);
      return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password ? url.origin : "";
    } catch { return ""; }
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

  /** Is this one of the app's four ChangeNOW swap calls (the only ones the server key rides on)? */
  const isChangenowKeyRoute = (method, target) => target.origin.toLowerCase() === changenowOrigin
    && CHANGENOW_KEY_ROUTES.has(`${String(method || "GET").toUpperCase()} ${target.pathname.replace(/\/+$/, "")}`);

  /** May this write (non GET/HEAD/OPTIONS) go to `target`? */
  const writeAllowed = (req, target) => {
    // ChangeNOW only for creating an exchange (POST /v2/exchange), never any other write there.
    if (isChangenowKeyRoute(req.method, target)) return true;
    if (WRITE_API_HOST_RE.test(target.hostname)) return true;
    // Only to the Nextcloud the app is connected to, and only on its WebDAV/OCS roots.
    const declared = declaredNextcloudOrigin(req);
    if (!declared || declared !== target.origin) return false;
    if (!NEXTCLOUD_WRITE_PATH_RE.test(target.pathname)) return false;
    // A Nextcloud app password (Basic) or token (Bearer).
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
      res.end(PROBE_REPLY);
      return;
    }
    // "Can this site swap?" (ui/swaps.js): whether a server ChangeNOW key is configured. Says
    // nothing about the key itself.
    if (probePath === SWAP_PROBE_PATH) {
      res.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" });
      res.end(changenowKey() ? "on" : (acceptClientChangenowKey ? "bring-your-own" : "off"));
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
    if (refuseNextcloud && isNextcloudRelayRequest(req.headers, target)) {
      refuse(res, 403, NEXTCLOUD_REFUSED_MESSAGE);
      return;
    }
    const method = String(req.method || "GET").toUpperCase();
    if (!["GET", "HEAD", "OPTIONS"].includes(method) && !writeAllowed(req, target)) {
      refuse(res, 403, "Proxy method not allowed");
      return;
    }

    const headers = { ...req.headers };
    // A key under ChangeNOW's own header never comes from a client. The person's pasted key
    // (their own KaChat only) rides under ours and is taken off here; it goes out only below.
    delete headers[CHANGENOW_KEY_HEADER];
    const pastedKey = String(headers[CHANGENOW_CLIENT_KEY_HEADER] || "").trim();
    delete headers[CHANGENOW_CLIENT_KEY_HEADER];
    if (isChangenowKeyRoute(method, target)) {
      const serverKey = changenowKey() || (acceptClientChangenowKey && CHANGENOW_CLIENT_KEY_RE.test(pastedKey) ? pastedKey : "");
      if (!serverKey) {
        refuse(res, 503, SWAP_UNAVAILABLE_MESSAGE, { "x-kachat-swap": "unavailable" });
        return;
      }
      if (!sameOriginCaller(req) && !listedExtensionCaller(req.headers, kapayExtensionIds)) {
        refuse(res, 403, "Swap requests are only relayed for this site's own pages");
        return;
      }
      if (overChangenowRate(who)) {
        noteRateLimited(who, "ChangeNOW");
        refuse(res, 429, "Too many swap requests", { "retry-after": "60" });
        return;
      }
      headers[CHANGENOW_KEY_HEADER] = serverKey;
    }
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
    delete headers[NEXTCLOUD_ORIGIN_HEADER];
    delete headers[EXTENSION_ID_HEADER];
    const jarCookies = JAR_ID_RE.test(jarId) ? jarFor(jarId, origin.origin) : null;
    if (jarCookies && jarCookies.size) headers.cookie = [...jarCookies].map(([n, v]) => `${n}=${v}`).join("; ");
    // Talk's signaling channel is a long poll the server holds for up to 30s.
    const longPoll = String(headers["x-proxy-long-poll"] || "") === "1";
    delete headers["x-proxy-long-poll"];
    applyPreviewHeaders(headers, origin.hostname);
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
        delete hopHeaders[CHANGENOW_KEY_HEADER];
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

  return { handle, clientKey, writeAllowed, overRate, isChangenowKeyRoute, sameOriginCaller };
}
