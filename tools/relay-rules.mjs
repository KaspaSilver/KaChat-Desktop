// The /nc-proxy relay's rules: what it refuses, strips and allows. Shared by the Node relay
// (tools/relay-guard.mjs: the Vite dev/preview server and the sidecar) and the Cloudflare Pages
// Function that serves desktop.kachat.app (functions/nc-proxy/[[path]].js), so a fix made for one
// is never missing from the other (DSK-001/002/003).
//
// No imports: this file runs under Node and in Cloudflare's runtime alike.

/** What the relay answers its probe with (engine/endpoints.js isProxyAvailable). */
export const PROBE_REPLY = "kachat-proxy";

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
export const CLIENT_IDENTITY_HEADERS = [
  "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-forwarded-port",
  "x-forwarded-server", "forwarded", "x-real-ip", "true-client-ip", "x-client-ip",
  "x-cluster-client-ip", "via",
];

// Request kinds a browser uses to RENDER a response. The relay never serves those.
export const NAVIGATION_DESTS = new Set(["document", "iframe", "frame", "embed", "object"]);

// Hosts the app itself writes to (the hosts engine/endpoints.js relays, plus KNS).
export const WRITE_API_HOST_RE = /(^|\.)kasia\.wtf$|^indexer\.kachat\.app$|^api(-tn\d+)?\.kaspa\.org$|(^|\.)kaspa\.(green|red|stream|blue|ws)$|^api\.knsdomains\.org$/i;
// Nextcloud's write roots: WebDAV (remote.php) and OCS (ocs/v1.php, ocs/v2.php incl. Talk/spreed).
// ui/nextcloud.js and ui/talk.js write only under these; index.php (previews) is only ever read.
export const NEXTCLOUD_WRITE_PATH_RE = /^\/(?:remote\.php|ocs)\//i;
// Paths only a Nextcloud serves for what KaChat does with it: WebDAV/OCS (files, backups, Talk),
// sign-in and status, previews, and a public share's raw file (/s/TOKEN/download|preview).
export const NEXTCLOUD_PATH_RE = /^\/(?:index\.php\/)?(?:remote\.php\/|ocs\/|status\.php|login\/v2|login\/flow|core\/preview|apps\/(?:spreed|files_sharing)\/|s\/[A-Za-z0-9_-]{10,}\/(?:download|preview))/i;
export const NEXTCLOUD_REFUSED_MESSAGE = "Nextcloud is not relayed by this site. Run KaChat and Nextcloud with Kaspa Quick Start.";

/** Is this relay request Nextcloud traffic? Anything carrying credentials (Authorization), the
 *  app's Nextcloud or Talk markers, or a Nextcloud-only path. Used by `refuseNextcloud`. */
export function isNextcloudRelayRequest(headers, target) {
  const h = headers || {};
  if (String(h.authorization || "").trim()) return true;
  if (String(h[NEXTCLOUD_ORIGIN_HEADER] || "").trim()) return true;
  if (String(h["x-proxy-jar"] || "").trim()) return true;
  if (String(h["ocs-apirequest"] || "").trim()) return true;
  return NEXTCLOUD_PATH_RE.test(String(target?.pathname || ""));
}
export const JAR_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
// The Nextcloud origin the app is talking to, sent by ui/nextcloud.js and ui/talk.js on every
// relayed Nextcloud call. Writes to a non-API host must go to exactly this origin.
export const NEXTCLOUD_ORIGIN_HEADER = "x-kachat-nextcloud-origin";
// Rate-limit bookkeeping: at most this many client keys are tracked per limiter.
export const RATE_MAX_KEYS = 5000;

// ChangeNOW: the server's API key is attached only to the swap calls ui/swap-quote.js makes (iOS
// ChangeNowAPIClient: estimated-amount, min-amount, exchange, by-id), and api.changenow.io is a
// write host for the one POST among them only.
export const CHANGENOW_ORIGIN = "https://api.changenow.io";
export const CHANGENOW_KEY_HEADER = "x-changenow-api-key";
export const CHANGENOW_KEY_ROUTES = new Set([
  "GET /v2/exchange/estimated-amount",
  "GET /v2/exchange/min-amount",
  "GET /v2/exchange/by-id",
  "POST /v2/exchange",
]);
/** What the four swap calls are answered with when this server has no ChangeNOW key. The app shows
 *  its own "not available" screen on it (the x-kachat-swap: unavailable header). */
export const SWAP_UNAVAILABLE_MESSAGE = "Swap is not available right now.";
/** The relay's own swap probe: "on" with a server key, "bring-your-own" on a KaChat someone runs
 *  for themselves that takes the key they paste in the app, "off" otherwise (ui/swaps.js asks). */
export const SWAP_PROBE_PATH = "/__swap";
/** The key a person pasted into their own KaChat (Kaspa Hub > ChangeNOW Swap). Taken only by a
 *  relay created with acceptClientChangenowKey and only when it has no key of its own; never
 *  forwarded under this name. */
export const CHANGENOW_CLIENT_KEY_HEADER = "x-kachat-changenow-key";
export const CHANGENOW_CLIENT_KEY_RE = /^[A-Za-z0-9_-]{16,128}$/;

// --- Addresses -------------------------------------------------------------------------------

export function ipv4Octets(ip) {
  const parts = String(ip).split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  return octets.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? octets : null;
}

/** 16 bytes of an IPv6 address (validate it first: net.isIP, or an address Cloudflare reported),
 *  embedded dotted quad included. null when it does not parse. */
export function ipv6Bytes(ip) {
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

/** Names the relay must never reach, whatever they resolve to. */
export function isBlockedHost(hostname) {
  const h = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
  return !h || h === "localhost" || h.endsWith(".localhost")
    || h === "metadata.google.internal" || h === "metadata" || h.endsWith(".internal");
}

// --- Rate limits -----------------------------------------------------------------------------

/** The rate-limit window. */
export const RATE_WINDOW_MS = 60_000;

/** A fixed-window counter per client key, holding at most `maxKeys` keys. When full it forgets
 *  expired windows first, then the oldest keys seen only ONCE in their window (forgetting one
 *  costs at most a single extra request), and only then the oldest repeat callers. A flood of
 *  fresh addresses therefore never resets a client that is actually using (or over) its quota,
 *  and nothing ever clears every counter at once. */
export function createLimiter(max, maxKeys = RATE_MAX_KEYS) {
  // Both maps are in insertion order. `once` only ever receives a key at its window start, so
  // it is also in window order; `repeat` is in promotion order (close to window order).
  const once = new Map();   // key -> { start, count: 1 }
  const repeat = new Map(); // key -> { start, count >= 2 }
  const expired = (entry, now) => now - entry.start > RATE_WINDOW_MS;
  const size = () => once.size + repeat.size;
  const makeRoom = (now) => {
    if (size() < maxKeys) return;
    for (const [key, entry] of once) { if (!expired(entry, now)) break; once.delete(key); }
    while (size() >= maxKeys && once.size) once.delete(once.keys().next().value);
    if (size() < maxKeys) return;
    for (const [key, entry] of repeat) if (expired(entry, now)) repeat.delete(key);
    while (size() >= maxKeys && repeat.size) repeat.delete(repeat.keys().next().value);
  };
  return (key) => {
    const now = Date.now();
    let entry = repeat.get(key);
    if (entry) {
      if (expired(entry, now)) { repeat.delete(key); entry = null; }
    } else {
      entry = once.get(key) || null;
      if (entry) {
        once.delete(key);
        if (expired(entry, now)) entry = null;
        else repeat.set(key, entry); // second call in this window: promoted
      }
    }
    if (!entry) {
      makeRoom(now);
      entry = { start: now, count: 0 };
      once.set(key, entry);
    }
    entry.count += 1;
    return entry.count > max;
  };
}

// --- Link previews ---------------------------------------------------------------------------

/** The request headers a link-preview scrape (x-preview: 1) or preview-image fetch (x-preview-image)
 *  goes out with, set on `headers` (a plain object, lower-case names) for a target on `hostname`.
 *  The x-preview* markers themselves are removed. */
export function applyPreviewHeaders(headers, hostname) {
  // Link-preview scrape: a crawler UA so sites emit og: tags as they do for unfurlers. Twitter/X
  // 404s the crawler but serves OG tags to a browser UA. Mirrors iOS LinkPreviewService.
  if (headers["x-preview"] === "1") {
    const host = hostname.replace(/^www\./, "").toLowerCase();
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
}
