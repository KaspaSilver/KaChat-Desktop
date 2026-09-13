// Central, user-configurable endpoint registry (Settings > Connectivity). Every
// hardcoded API base now reads through here, so the defaults below reproduce the
// exact current behavior — nothing changes unless the user edits a field.
//
// Keys mirror iOS's AppSettings connectivity fields:
//   kaspaApi     — Kaspa REST API (api.kaspa.org): balances, tx history, fees
//   kasiaIndexer — Kasia message indexer (COMM message query)
//   pushIndexer  — Kasia push/notification indexer
//   knsApi       — KNS domain/profile API
//   trustedNode  — wRPC node endpoint ("" = auto-discover via the resolver)
const ENDPOINTS_KEY = "kachat-endpoints-v1";

export const ENDPOINT_DEFAULTS = Object.freeze({
  kaspaApi: "https://api.kaspa.org",
  // KaChat's own indexer (kachat.duckdns.org) is now the default chat/message + group-chat
  // indexer, matching iOS/Android. In a browser it is routed through the same-origin proxy when the
  // server hosting the page has one (see vite.config.mjs / installIndexerProxy), because the
  // indexer sends no CORS headers of its own.
  kasiaIndexer: "https://kachat.duckdns.org",
  kapostIndexer: "https://kachat.duckdns.org",
  broadcastIndexer: "https://kachat.duckdns.org",
  pushIndexer: "https://kachat.duckdns.org",
  knsApi: "https://api.knsdomains.org/mainnet/api/v1",
  translationService: "https://kachat.duckdns.org",
  trustedNode: "",
});
// iOS AppSettings.defaultTrustedNodeAddress: the node "Default (Recommended)" connects to.
export const DEFAULT_TRUSTED_NODE = "grpcs://toccata.kaspium.io";

// Retired / superseded chat-indexer defaults. Drop any stored override still pointing at one of
// these so it falls back to the current default (kachat.duckdns.org): indexer.kasia.fyi is offline,
// and indexer.kasia.wtf was the previous default now replaced by KaChat's own indexer.
const RETIRED_INDEXER_URLS = ["https://indexer.kasia.fyi", "https://indexer.kasia.wtf"];

function loadStored() {
  try {
    const raw = JSON.parse(localStorage.getItem(ENDPOINTS_KEY) || "{}");
    return raw && typeof raw === "object" ? raw : {};
  } catch { return {}; }
}

let overrides = loadStored();

(function migrateRetiredIndexer() {
  const current = overrides.kasiaIndexer;
  if (current != null && RETIRED_INDEXER_URLS.includes(String(current).trim().replace(/\/+$/, ""))) {
    delete overrides.kasiaIndexer;
    try { localStorage.setItem(ENDPOINTS_KEY, JSON.stringify(overrides)); } catch {}
  }
})();

// In the Vite dev browser, the chat indexers may send no CORS headers, so direct fetch() calls
// would be blocked. Group chat and 1:1 sync REQUIRE these hosts, so we transparently reroute every
// request to the indexer hosts (kachat.duckdns.org — the current default — and the legacy
// kasia.wtf, still valid as a manual override) through the same-origin /nc-proxy middleware (see
// vite.config.mjs), which forwards it server-side where CORS does not apply. Wrapping fetch once —
// rather than rewriting URLs in getEndpoint() — covers ALL call sites (sync.js, group-indexer.js,
// messages.js, kaposts.js, broadcasts.js, and the settings input path) and keeps the URLs real
// https:// everywhere else, so normalizeBaseUrl and any deployment without the proxy still hit the
// host directly.
// api.kaspa.org rides through the proxy too: its RATE-LIMIT/error responses carry no CORS
// headers, so direct browser fetches degrade into a wall of red CORS noise the moment a
// balance-lookup burst trips its limiter. Server-side forwarding has no CORS at all.
const INDEXER_PROXY_HOST_RE = /(^|\.)kasia\.wtf$|(^|\.)kachat\.duckdns\.org$|^api\.kaspa\.org$/i;
/// Where the proxy lives, relative to wherever the app is served from.
///
/// The published site sits under /desktop/, so the proxy is at /desktop/nc-proxy/ - a root-absolute
/// /nc-proxy/ 404s there. Vite substitutes BASE_URL at build time; every other caller of the proxy
/// already goes through it (see nextcloud.js, kns.js), and this one did not.
function proxyRoot() {
  let base = "/";
  try { base = import.meta.env.BASE_URL || "/"; } catch { base = "/"; }
  return `${base}nc-proxy/`;
}

/// What the proxy answers a probe with, so "the proxy is here" is a 200 rather than an error the
/// browser console reports in red on a perfectly healthy deployment.
const PROBE_REPLY = "kachat-proxy";

function installIndexerProxy() {
  if (typeof window === "undefined" || typeof window.fetch !== "function" || window.__kasiaProxyInstalled) return;
  window.__kasiaProxyInstalled = true;
  const nativeFetch = window.fetch.bind(window);

  // Is this page being served by something that carries the /nc-proxy handler?
  //
  // It used to be gated on import.meta.env.DEV, on the assumption that anything else was a
  // packaged build talking to the network directly, where CORS does not apply. That assumption was
  // wrong the moment the app was published as a website: the production build served at
  // kachat.app is a browser page like any other, the indexer sends no Access-Control-Allow-Origin,
  // and every request it made was refused. The proxy was mounted on the preview server all along -
  // only the client half of it was switched off.
  //
  // Asked rather than assumed, because the answer differs per deployment: the dev server and the
  // preview server behind kachat.app both have it, a plain static host serving the built files
  // does not, and a file:// open has no server at all. The proxy answers __probe with a known
  // string; anything else - a 404, an SPA fallback page, a network error - means no proxy, and
  // requests go direct exactly as before.
  let probe = null;
  const proxyAvailable = () => {
    if (!probe) {
      probe = (async () => {
        try {
          const response = await nativeFetch(`${proxyRoot()}__probe`, { cache: "no-store" });
          const body = (await response.text()).trim();
          // Two ways the proxy identifies itself, because a server can be older than the page it
          // is serving: the current one answers a probe with a known string, and every version
          // before that answered an unparseable target with 400 "Bad proxy target". Accepting both
          // means a deployment mid-update proxies rather than falling back to direct requests that
          // CORS then refuses.
          if (response.ok) return body === PROBE_REPLY;
          return response.status === 400 && body === "Bad proxy target";
        } catch { return false; }
      })();
    }
    return probe;
  };

  window.fetch = (input, init) => {
    let rawUrl = "";
    try {
      // Cover every fetch input shape: string, URL instance (sync.js builds these - a URL has
      // no .url property, so it used to silently bypass the proxy), and Request.
      rawUrl = typeof input === "string" ? input
        : (input instanceof URL) ? input.href
        : (input && input.url) || "";
      if (rawUrl) {
        const parsed = new URL(rawUrl, window.location.origin);
        if (INDEXER_PROXY_HOST_RE.test(parsed.hostname)) {
          const proxied = `${proxyRoot()}${encodeURIComponent(parsed.origin)}${parsed.pathname}${parsed.search}`;
          return traceApiCall(rawUrl, init, () => proxyAvailable().then((ok) => {
            if (!ok) return nativeFetch(input, init);
            if (typeof input === "string" || input instanceof URL) return nativeFetch(proxied, init);
            return nativeFetch(new Request(proxied, input), init);
          }));
        }
      }
    } catch { /* fall through to native fetch */ }
    return traceApiCall(rawUrl, init, () => nativeFetch(input, init));
  };
}
installIndexerProxy();

// Verbose API Logging (iOS Diagnostics): every indexer/API request with its method, status and
// timing, handed to whatever log sink the app registers. Off, nothing here runs - failed and slow
// requests are still reported by their own callers.
let verboseApiLogging = false;
let apiLogSink = null;
const API_HOST_RE = /(^|\.)kasia\.wtf$|(^|\.)kachat\.duckdns\.org$|^api\.kaspa\.org$|knsdomains\.org$/i;
export function setVerboseApiLogging(enabled, sink = null) {
  verboseApiLogging = Boolean(enabled);
  if (sink) apiLogSink = sink;
}
export function isVerboseApiLogging() { return verboseApiLogging; }
function traceApiCall(rawUrl, init, run) {
  if (!verboseApiLogging || !apiLogSink || !rawUrl) return run();
  let host = "";
  try { host = new URL(rawUrl, window.location.origin).hostname; } catch { host = ""; }
  if (!API_HOST_RE.test(host)) return run();
  const method = String(init?.method || "GET").toUpperCase();
  const started = performance.now();
  const shortUrl = rawUrl.length > 160 ? `${rawUrl.slice(0, 157)}...` : rawUrl;
  return run().then((response) => {
    apiLogSink(`[API] ${method} ${shortUrl} -> ${response?.status ?? "?"} in ${Math.round(performance.now() - started)}ms`);
    return response;
  }, (error) => {
    apiLogSink(`[API] ${method} ${shortUrl} -> failed after ${Math.round(performance.now() - started)}ms: ${error?.message || error}`);
    throw error;
  });
}

function persist() {
  try { localStorage.setItem(ENDPOINTS_KEY, JSON.stringify(overrides)); } catch {}
}

// Returns the effective endpoint for a key (override if set and non-empty, else
// the default). Trailing slashes are trimmed so callers can append paths safely.
export function getEndpoint(key) {
  const value = overrides[key];
  const resolved = (value != null && String(value).trim()) ? String(value).trim() : (ENDPOINT_DEFAULTS[key] || "");
  return resolved.replace(/\/+$/, "");
}

export function getEndpoints() {
  const out = {};
  for (const key of Object.keys(ENDPOINT_DEFAULTS)) out[key] = getEndpoint(key);
  return out;
}

// Raw stored override for a key (may be "" if the user cleared it). Used by the
// settings UI to show exactly what the user typed vs. the default.
export function getEndpointOverride(key) {
  return overrides[key] != null ? String(overrides[key]) : "";
}

export function setEndpoint(key, value) {
  if (!(key in ENDPOINT_DEFAULTS)) return;
  const clean = String(value ?? "").trim();
  if (!clean || clean === ENDPOINT_DEFAULTS[key]) delete overrides[key];
  else overrides[key] = clean;
  persist();
}

export function resetEndpoints() {
  overrides = {};
  persist();
}
