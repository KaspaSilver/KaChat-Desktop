// The /nc-proxy relay on Cloudflare Pages (desktop.kachat.app): a Pages Function, deployed with the
// site from the same push. It does what the Node relay (tools/relay-guard.mjs) does for a site other
// people open, with the same rules (tools/relay-rules.mjs):
//   - indexers, api.kaspa.org, node seeds, prices, KNS (engine/endpoints.js fetch wrapper)
//   - link previews + preview images (x-preview, x-preview-image)
//   - ChangeNOW Swap: the server's key (CHANGENOW_API_KEY, a Pages secret) on the four swap calls only
// and never Nextcloud or Talk: those stay between a person and their own Nextcloud, through a KaChat
// they run themselves (Kaspa Quick Start), as on the sidecar (refuseNextcloud).
//
// What differs from the Node relay, and why:
//   * No DNS pinning. Requests leave from Cloudflare's network, where there is no private network
//     of ours behind the relay to reach, and Cloudflare refuses fetches to private, loopback and
//     link-local destinations itself. Names the relay must never reach (isBlockedHost) are still
//     refused here, and so is every literal IP address (Cloudflare does not fetch those either).
//   * The client is CF-Connecting-IP, which Cloudflare sets and a client cannot. Rate limits are
//     counted per Cloudflare isolate, so they are a backstop; a WAF rate-limiting rule on /nc-proxy/
//     is the real limit.
//   * The timeout covers waiting for the answer to start, not the whole download.
//
// Environment (Pages project settings):
//   CHANGENOW_API_KEY           secret: the server's ChangeNOW key. Unset: Swap is "not available".
//   KACHAT_RELAY_RATE_MAX       requests per client per minute (default 600)
//   KACHAT_CHANGENOW_RATE_MAX   key-attached ChangeNOW calls per client per minute (default 30)
//   NC_PROXY_UPSTREAM_TIMEOUT_MS  wait for a read to start answering (default 30000; writes 120000)
import {
  PROBE_REPLY, HOP_BY_HOP, STRIPPED_RESPONSE_HEADERS, CLIENT_IDENTITY_HEADERS, NAVIGATION_DESTS,
  WRITE_API_HOST_RE, NEXTCLOUD_REFUSED_MESSAGE, isNextcloudRelayRequest, NEXTCLOUD_ORIGIN_HEADER,
  CHANGENOW_ORIGIN, CHANGENOW_KEY_HEADER, CHANGENOW_KEY_ROUTES, SWAP_UNAVAILABLE_MESSAGE,
  SWAP_PROBE_PATH, CHANGENOW_CLIENT_KEY_HEADER, ipv6Bytes, isBlockedHost, createLimiter,
  applyPreviewHeaders,
} from "../../tools/relay-rules.mjs";

const MOUNT_RE = /^\/nc-proxy(?=\/|$)/;
const MAX_REDIRECT_HOPS = 5;
const NO_BODY_STATUSES = new Set([101, 204, 205, 304]);

/** Rate limiters, kept per isolate: one for the relay and one for the swap calls, per configured limit. */
const limiters = new Map();
const limiterFor = (name, max) => {
  const key = `${name}:${max}`;
  if (!limiters.has(key)) limiters.set(key, createLimiter(max));
  return limiters.get(key);
};

const numberSetting = (value, fallback) => (Number(value) > 0 ? Number(value) : fallback);

/** A literal IP address in a URL host (brackets and all). The relay fetches names only. */
const isIpLiteral = (hostname) => {
  const h = String(hostname || "").replace(/^\[|\]$/g, "");
  return h.includes(":") || /^\d+(\.\d+){0,3}$/.test(h);
};

/** The rate-limit bucket: an IPv4 address as-is, an IPv6 one by its /64 (rateKeyFor in relay-guard). */
export function clientKey(request) {
  const ip = String(request.headers.get("cf-connecting-ip") || "").trim().toLowerCase();
  if (!ip) return "?";
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  if (mapped) return mapped[1];
  if (!ip.includes(":")) return ip;
  const bytes = ipv6Bytes(ip);
  if (!bytes) return ip;
  const groups = [];
  for (let i = 0; i < 8; i += 2) groups.push(((bytes[i] << 8) | bytes[i + 1]).toString(16));
  return `${groups.join(":")}::/64`;
}

const refuse = (status, message, extra = {}) => new Response(message, {
  status,
  headers: { "content-type": "text/plain", "cache-control": "no-store", "x-content-type-options": "nosniff", ...extra },
});

const isChangenowKeyRoute = (method, target) => target.origin.toLowerCase() === CHANGENOW_ORIGIN
  && CHANGENOW_KEY_ROUTES.has(`${method} ${target.pathname.replace(/\/+$/, "")}`);

/** A same-origin call from the page itself: Fetch Metadata says so AND the Origin (or, for a GET,
 *  which carries none, the Referer) names this site. */
const sameOriginCaller = (request, siteHost) => {
  if (String(request.headers.get("sec-fetch-site") || "").toLowerCase() !== "same-origin") return false;
  const hostOf = (value) => { try { return new URL(String(value)).host.toLowerCase(); } catch { return ""; } };
  const origin = request.headers.get("origin");
  if (origin !== null) return hostOf(origin) === siteHost;
  const referer = request.headers.get("referer");
  return Boolean(referer) && hostOf(referer) === siteHost;
};

/** A target the relay may connect to: a name, not one that must never be reached, and not the relay
 *  itself (relaying to /nc-proxy here would call this function again, and again). */
const targetAllowed = (target, siteHost) => !isBlockedHost(target.hostname)
  && !isIpLiteral(target.hostname)
  && !(target.host.toLowerCase() === siteHost && MOUNT_RE.test(target.pathname));

export async function onRequest({ request, env = {} }) {
  const site = new URL(request.url);
  const siteHost = site.host.toLowerCase();
  // The part after the mount: "/<origin>/<path>?<query>", still percent-encoded.
  const rest = `${site.pathname.replace(MOUNT_RE, "")}${site.search}`;
  const changenowKey = String(env.CHANGENOW_API_KEY || "").trim();

  // "Are you there?" and "Can this site swap?" (engine/endpoints.js, ui/swaps.js).
  const probePath = rest.split("?")[0].replace(/\/+$/, "");
  if (probePath === "/__probe") return new Response(PROBE_REPLY, { headers: { "content-type": "text/plain", "cache-control": "no-store" } });
  if (probePath === SWAP_PROBE_PATH) {
    return new Response(changenowKey ? "on" : "off", { headers: { "content-type": "text/plain", "cache-control": "no-store" } });
  }

  // Never a page of this origin.
  const fetchDest = String(request.headers.get("sec-fetch-dest") || "").toLowerCase();
  const fetchMode = String(request.headers.get("sec-fetch-mode") || "").toLowerCase();
  if (NAVIGATION_DESTS.has(fetchDest) || fetchMode === "navigate" || fetchMode === "nested-navigate") {
    return refuse(403, "Proxy target not allowed");
  }
  const who = clientKey(request);
  if (limiterFor("relay", numberSetting(env.KACHAT_RELAY_RATE_MAX, 600))(who)) {
    return refuse(429, "Too many requests", { "retry-after": "60" });
  }

  const match = /^\/([^/?]+)(\/[^?]*)?(\?.*)?$/.exec(rest);
  let origin = null;
  try { origin = match ? new URL(decodeURIComponent(match[1])) : null; } catch { origin = null; }
  if (!origin || (origin.protocol !== "http:" && origin.protocol !== "https:") || origin.username || origin.password) {
    return refuse(400, "Bad proxy target");
  }
  // The target forwarded must keep the encoded origin: "//other-host/" is scheme-relative.
  let target = null;
  try { target = new URL(`${match[2] || "/"}${match[3] || ""}`, origin.origin); } catch { target = null; }
  if (!target || target.origin !== origin.origin || !targetAllowed(target, siteHost)) {
    return refuse(403, "Proxy target not allowed");
  }

  // Plain object, lower-case names, as relay-rules.mjs expects.
  const headers = Object.fromEntries(request.headers);
  if (isNextcloudRelayRequest(headers, target)) return refuse(403, NEXTCLOUD_REFUSED_MESSAGE);

  const method = String(request.method || "GET").toUpperCase();
  const isWrite = !["GET", "HEAD", "OPTIONS"].includes(method);
  // Writes go only where the app writes (Nextcloud writes were refused above).
  if (isWrite && !isChangenowKeyRoute(method, target) && !WRITE_API_HOST_RE.test(target.hostname)) {
    return refuse(403, "Proxy method not allowed");
  }

  // No client brings a ChangeNOW key, under its header or ours (a pasted key is for a KaChat
  // someone runs for themselves, never a site other people open).
  delete headers[CHANGENOW_KEY_HEADER];
  delete headers[CHANGENOW_CLIENT_KEY_HEADER];
  if (isChangenowKeyRoute(method, target)) {
    if (!changenowKey) return refuse(503, SWAP_UNAVAILABLE_MESSAGE, { "x-kachat-swap": "unavailable" });
    if (!sameOriginCaller(request, siteHost)) return refuse(403, "Swap requests are only relayed for this site's own pages");
    if (limiterFor("changenow", numberSetting(env.KACHAT_CHANGENOW_RATE_MAX, 30))(who)) {
      return refuse(429, "Too many swap requests", { "retry-after": "60" });
    }
    headers[CHANGENOW_KEY_HEADER] = changenowKey;
  }

  // Nothing of this site's (cookies, origin, referer) and nothing that identifies the reader.
  for (const name of ["host", "origin", "referer", "cookie", "content-length", ...CLIENT_IDENTITY_HEADERS, ...HOP_BY_HOP]) delete headers[name];
  for (const name of Object.keys(headers)) {
    if (name.startsWith("cf-") || name.startsWith("sec-fetch-")) delete headers[name];
  }
  for (const name of ["x-proxy-jar", NEXTCLOUD_ORIGIN_HEADER, "x-proxy-long-poll"]) delete headers[name];
  applyPreviewHeaders(headers, origin.hostname);
  const soft404 = headers["x-proxy-soft-404"] === "1";
  delete headers["x-proxy-soft-404"];

  const timeoutMs = isWrite ? 120_000 : numberSetting(env.NC_PROXY_UPSTREAM_TIMEOUT_MS, 30_000);
  // Redirects are followed here (GET/HEAD, capped), each hop checked like the first.
  let hopTarget = target;
  for (let hop = 0; ; hop += 1) {
    // Another origin gets a clean request: Authorization and the ChangeNOW key belong to the one asked.
    const hopHeaders = { ...headers };
    if (hopTarget.origin !== origin.origin) {
      delete hopHeaders.authorization;
      delete hopHeaders[CHANGENOW_KEY_HEADER];
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let upstream;
    try {
      upstream = await fetch(hopTarget.href, {
        method,
        headers: hopHeaders,
        // Only the first hop carries the browser's body; redirect hops are GET/HEAD.
        body: isWrite && hop === 0 ? request.body : undefined,
        redirect: "manual",
        signal: controller.signal,
      });
    } catch (error) {
      return controller.signal.aborted ? refuse(504, "Proxy upstream timeout") : refuse(502, `Proxy error: ${error?.message || error}`);
    } finally {
      clearTimeout(timer);
    }

    const status = upstream.status;
    const location = upstream.headers.get("location");
    if (location && status >= 300 && status < 400 && hop < MAX_REDIRECT_HOPS && (method === "GET" || method === "HEAD")) {
      let next = null;
      try { next = new URL(location, hopTarget); } catch { next = null; }
      // A server redirecting to the very URL asked for would loop; that answer is passed through.
      if (next && next.href !== hopTarget.href && (next.protocol === "http:" || next.protocol === "https:")) {
        await upstream.body?.cancel();
        if (next.username || next.password || !targetAllowed(next, siteHost)) return refuse(403, "Redirect target not allowed");
        hopTarget = next;
        continue;
      }
    }

    const responseHeaders = new Headers(upstream.headers);
    for (const name of [...HOP_BY_HOP, ...STRIPPED_RESPONSE_HEADERS]) responseHeaders.delete(name);
    // The body arrives decoded; the runtime encodes it again to match content-encoding, so a
    // length taken from the encoded upstream answer would be wrong.
    if (responseHeaders.has("content-encoding")) responseHeaders.delete("content-length");
    // Data for fetch(), never a page of this origin.
    responseHeaders.set("content-security-policy", "sandbox");
    responseHeaders.set("x-content-type-options", "nosniff");
    const mask404 = soft404 && status === 404;
    if (mask404) responseHeaders.set("x-upstream-status", "404");
    const finalStatus = mask404 ? 200 : status;
    const body = method === "HEAD" || NO_BODY_STATUSES.has(finalStatus) ? null : upstream.body;
    return new Response(body, { status: finalStatus, headers: responseHeaders });
  }
}
