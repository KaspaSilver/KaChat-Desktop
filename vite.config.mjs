import { defineConfig } from "vite";
import http from "node:http";
import https from "node:https";

// Same-origin Nextcloud proxy. The desktop app runs in a browser, and stock Nextcloud sends no
// CORS headers on WebDAV/OCS — so ui/nextcloud.js routes every API call through
//   /nc-proxy/<encodeURIComponent(origin)>/<path>
// and this middleware forwards it server-side, where CORS doesn't exist. Public /s/TOKEN share
// links are NOT proxied — recipients open those on the real server.
//
// Note: with `--host 0.0.0.0` this proxy is reachable from the LAN like the rest of the dev
// server — it forwards only to the origin encoded in each request's own path (no ambient
// credentials; the browser supplies the Authorization header per request).
function nextcloudProxy() {
  // One handler, mounted on BOTH the dev server and the preview server. `configureServer` alone
  // meant the proxy existed only while running `vite dev`, which is why the deployment ran the dev
  // server - a dev server serving the public site, with no minification and no content-hashed
  // filenames, so a returning visitor could be handed a stale module. `vite build` + `vite preview`
  // hashes every asset (permanent cache-busting, no hand-maintained ?v= numbers) and this hook is
  // what lets Nextcloud keep working there.
  // Connection-scoped headers, which belong to one hop and must not be relayed to the next.
  const HOP_BY_HOP = [
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailer", "transfer-encoding", "upgrade",
  ];

  // Cookie jars for Nextcloud Talk. The relay strips cookies both ways (see below), and that
  // is right for WebDAV - but a Talk GUEST session lives in the PHP session cookie, and even an
  // own-account Talk session is one cookie the server expects back. A request carrying
  // x-proxy-jar: <id> gets the cookies that origin set for that jar attached, and the answer's
  // Set-Cookie stored under it. Jars are memory-only, per relay process, and expire after an
  // hour idle - a call is over long before that.
  const jars = new Map(); // jarId -> { origin -> { name -> value }, touched }
  const JAR_TTL_MS = 60 * 60 * 1000;
  const JAR_MAX = 500; // bounded: an internet client must not be able to grow this without limit
  const jarFor = (id, origin) => {
    const now = Date.now();
    for (const [key, jar] of jars) if (now - jar.touched > JAR_TTL_MS) jars.delete(key);
    let jar = jars.get(id);
    if (!jar) {
      while (jars.size >= JAR_MAX) jars.delete(jars.keys().next().value); // oldest first
      jar = { byOrigin: new Map(), touched: now }; jars.set(id, jar);
    }
    jar.touched = now;
    let cookies = jar.byOrigin.get(origin);
    if (!cookies) { cookies = new Map(); jar.byOrigin.set(origin, cookies); }
    return cookies;
  };

  // Hosts the relay must never reach: the machine it runs on, link-local and cloud metadata.
  const isBlockedHost = (hostname) => {
    const h = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
    return !h || h === "localhost" || h.endsWith(".localhost")
      || /^127\./.test(h) || /^0\./.test(h) || h === "0.0.0.0"
      || h === "::1" || h === "::" || h.startsWith("::ffff:")
      || /^169\.254\./.test(h) || /^fe80:/i.test(h) || /^f[cd][0-9a-f]{2}:/i.test(h)
      || h === "metadata.google.internal";
  };

  const mount = (server) => {
    // Mounted at /nc-proxy and, when the site is built under a base (the published site lives at
    // /desktop/), at <base>/nc-proxy as well: a reverse proxy that forwards the path unchanged
    // reaches the handler either way. The client builds its URL from the same base.
    const base = String(server.config?.base || "/").replace(/\/+$/, "");
    const mounts = new Set(["/nc-proxy", `${base}/nc-proxy`]);
    for (const mountPath of mounts) server.middlewares.use(mountPath, (req, res) => {
        // connect strips the mount prefix, so req.url is "/<origin>/<path>?<query>".
        // "Are you there?" - answered before anything else, so a healthy deployment does not have
        // to report its own liveness check as a console error. See engine/endpoints.js.
        // Tolerant of a trailing slash or a cache-busting query a proxy in front may add.
        const probePath = String(req.url || "").split("?")[0].replace(/\/+$/, "");
        if (probePath === "/__probe") {
          res.statusCode = 200;
          res.setHeader("content-type", "text/plain");
          res.setHeader("cache-control", "no-store");
          res.end("kachat-proxy");
          return;
        }
        // The relay answers the app's own fetch() calls, never a navigation: a top-level load of
        // a relayed URL would render someone else's HTML on this origin, with this origin's
        // storage in reach. Browsers label the request kind; a document/frame load is refused.
        const fetchDest = String(req.headers["sec-fetch-dest"] || "").toLowerCase();
        if (["document", "iframe", "frame", "embed", "object"].includes(fetchDest)) {
          res.statusCode = 403;
          res.end("Proxy target not allowed");
          return;
        }
        const match = /^\/([^/]+)(\/.*)?$/.exec(req.url || "");
        let origin = null;
        try {
          origin = match ? new URL(decodeURIComponent(match[1])) : null;
        } catch { /* handled below */ }
        if (!origin || (origin.protocol !== "http:" && origin.protocol !== "https:")) {
          res.statusCode = 400;
          res.end("Bad proxy target");
          return;
        }
        // SSRF guard: this proxy is reachable from the LAN (--host 0.0.0.0) and, through the
        // reverse proxy, from the internet — so it must never forward into the dev machine
        // itself or the link-local/cloud-metadata range. RFC1918 LAN targets stay allowed on
        // purpose (a self-hosted Nextcloud on the LAN is a supported setup). Note: a public
        // DNS name resolving to a blocked address (rebinding) is not caught here — this is a
        // dev-server hardening layer, not a security boundary for production.
        // The guard runs on the TARGET actually forwarded (the path segment can be
        // scheme-relative, "//host/...", which would rewrite the host after an origin-only
        // check) and again on every redirect hop.
        let target = null;
        try { target = new URL(match[2] || "/", `${origin.protocol}//${origin.host}`); } catch { target = null; }
        if (!target || target.origin !== origin.origin || isBlockedHost(target.hostname)) {
          res.statusCode = 403;
          res.end("Proxy target not allowed");
          return;
        }
        const headers = { ...req.headers, host: origin.host };
        // The browser's origin/referer would confuse some reverse-proxy setups — drop them.
        delete headers.origin;
        delete headers.referer;
        // Never relay cookies in either direction. Nextcloud answers the first (cookie-less,
        // Basic-auth) call by setting a session cookie; the browser stored it for THIS origin and
        // sent it back on every later proxied request, so WebDAV saw a session cookie next to
        // Basic auth, treated the call as a browser session without a CSRF token, and answered
        // 401 - right after a successful connect. An API client authenticates per request.
        delete headers.cookie;
        const jarId = String(headers["x-proxy-jar"] || "").trim();
        delete headers["x-proxy-jar"];
        const jarCookies = /^[A-Za-z0-9_-]{8,64}$/.test(jarId) ? jarFor(jarId, origin.origin) : null;
        if (jarCookies && jarCookies.size) {
          headers.cookie = [...jarCookies].map(([name, value]) => `${name}=${value}`).join("; ");
        }
        // The Talk signaling channel is a long poll the server holds for up to 30s: give it
        // room, where an ordinary relay call is cut off at fifteen.
        const longPoll = String(headers["x-proxy-long-poll"] || "") === "1";
        delete headers["x-proxy-long-poll"];
        // Hop-by-hop headers describe THIS connection, not the message, and a proxy must not
        // relay them (RFC 9110 7.6.1). Passing them on is what truncated large downloads: a
        // Nextcloud backup answered with `transfer-encoding: chunked` had that header copied onto
        // our own response, so Node was told the body was already framed while it was also doing
        // its own framing, and the stream ended early - a 6MB archive arriving as ~5.8MB of
        // unterminated JSON.
        for (const hop of HOP_BY_HOP) delete headers[hop];
        // Link-preview scrape (x-preview): use a crawler User-Agent so sites emit their og:image /
        // og:title the way they do for Facebook/Slack unfurlers (a plain browser UA increasingly
        // gets a login/consent wall). Mirrors iOS LinkPreviewService's facebookexternalhit UA.
        // EXCEPTION: Twitter/X 404s the crawler UA but DOES serve Open Graph tags to a real browser
        // UA (the opposite of Instagram/Facebook) - so use a browser UA there. iOS/Android already
        // scrape non-Meta hosts like x.com with a browser UA, which is why they preview it fine.
        if (headers["x-preview"] === "1") {
          const host = origin.hostname.replace(/^www\./, "").toLowerCase();
          const browserUaHosts = new Set(["x.com", "twitter.com", "mobile.twitter.com"]);
          headers["user-agent"] = browserUaHosts.has(host)
            ? "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15"
            : "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)";
          delete headers.accept;
          headers.accept = "text/html,application/xhtml+xml";
        }
        delete headers["x-preview"];
        // Preview IMAGE bytes (x-preview-image): Meta's CDNs (cdninstagram/fbcdn) refuse a bare
        // hotlink from a page, so the card fetches the picture through here with a browser UA and
        // the post as Referer - and, when that is refused too, as Meta's own crawler. Mirrors iOS
        // LinkPreviewService.fetchPreviewImage.
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
        // ChangeNOW: the API key lives on the server (CHANGENOW_API_KEY, or the same
        // VITE_CHANGENOW_API_KEY docker-compose already passes) and is attached here, so no
        // reader ever has to paste one and the key never ships inside the page. A key the page
        // sends itself (a reader's own, from Settings) wins.
        // Attached only for the app's own calls (browsers mark them same-origin); a bare client
        // on the internet must not be able to spend this deployment's quota through the relay.
        const sameOriginCall = String(req.headers["sec-fetch-site"] || "same-origin").toLowerCase() === "same-origin";
        if (sameOriginCall && /(^|\.)changenow\.io$/i.test(origin.hostname)) {
          const serverKey = String(process.env.CHANGENOW_API_KEY || process.env.VITE_CHANGENOW_API_KEY || "").trim();
          if (serverKey && !String(headers["x-changenow-api-key"] || "").trim()) headers["x-changenow-api-key"] = serverKey;
        }
        // Opt-in "soft 404": APIs that use 404 to mean "not found, and that's normal" (KNS
        // primary-name lookups for addresses without domains) make the browser console scream
        // red for every answer. When the caller sends x-proxy-soft-404, an upstream 404 is
        // returned as 200 with x-upstream-status: 404 so the client can still detect it.
        const soft404 = headers["x-proxy-soft-404"] === "1";
        delete headers["x-proxy-soft-404"];

        // Redirects are followed SERVER-SIDE (GET/HEAD, capped hops): passing a 3xx through
        // hands the browser a cross-origin Location it follows directly and gets CORS-blocked
        // on (seen with maps.apple short links in link previews).
        const MAX_REDIRECT_HOPS = 5;
        function forward(target, hop) {
          const client = target.protocol === "http:" ? http : https;
          // A redirect to another origin gets a clean request: the browser's Authorization (a
          // Nextcloud app password), the jar's cookies and the ChangeNOW key belong to the origin
          // that was asked for, never to wherever it pointed.
          const hopHeaders = { ...headers, host: target.host };
          if (target.origin !== origin.origin) {
            delete hopHeaders.authorization;
            delete hopHeaders.cookie;
            delete hopHeaders["x-changenow-api-key"];
          }
          const upstream = client.request(
            {
              protocol: target.protocol,
              hostname: target.hostname,
              port: target.port || (target.protocol === "http:" ? 80 : 443),
              method: req.method,
              path: `${target.pathname}${target.search}` || "/",
              headers: hopHeaders,
            },
            (upstreamRes) => {
              const status = upstreamRes.statusCode || 502;
              const location = upstreamRes.headers.location;
              if (location && status >= 300 && status < 400 && hop < MAX_REDIRECT_HOPS
                  && (req.method === "GET" || req.method === "HEAD")) {
                upstreamRes.resume(); // discard the redirect body
                let next = null;
                try { next = new URL(location, target); } catch { next = null; }
                // A server redirecting to the very URL that was asked (a seed did this) would
                // loop until the hop cap; hand it through as-is instead.
                if (next && next.href === target.href) next = null;
                // A redirect must obey the same SSRF guard as the original target.
                const nextBlocked = !next || isBlockedHost(next.hostname);
                if (!nextBlocked && (next.protocol === "http:" || next.protocol === "https:")) {
                  forward(next, hop + 1);
                  return;
                }
              }
              const mask404 = soft404 && upstreamRes.statusCode === 404;
              const responseHeaders = { ...upstreamRes.headers };
              for (const hop of HOP_BY_HOP) delete responseHeaders[hop];
              if (jarCookies) {
                const setCookies = [].concat(upstreamRes.headers["set-cookie"] || []);
                for (const line of setCookies) {
                  const first = String(line).split(";")[0];
                  const eq = first.indexOf("=");
                  if (eq <= 0) continue;
                  const name = first.slice(0, eq).trim();
                  const value = first.slice(eq + 1).trim();
                  if (/max-age=0|expires=thu, 01 jan 1970/i.test(line)) jarCookies.delete(name);
                  else jarCookies.set(name, value);
                }
              }
              delete responseHeaders["set-cookie"];
              // Whatever comes back is data for fetch(), never a page of this origin: an opaque
              // sandbox and no sniffing, and no upstream auth challenge or refresh can reach the
              // browser as if it were ours.
              responseHeaders["content-security-policy"] = "sandbox";
              responseHeaders["x-content-type-options"] = "nosniff";
              delete responseHeaders["www-authenticate"];
              delete responseHeaders["proxy-authenticate"];
              delete responseHeaders.refresh;
              delete responseHeaders.link;
              if (mask404) responseHeaders["x-upstream-status"] = "404";
              res.writeHead(mask404 ? 200 : status, responseHeaders);
              upstreamRes.pipe(res);
            },
          );
          // A seed or API that never answers must not hold the relay's connection open until
          // the CDN in front gives up on it (Cloudflare's 522 is exactly that): fifteen seconds,
          // then a 504 of our own.
          upstream.setTimeout(longPoll ? 60000 : 15000, () => upstream.destroy(new Error("upstream timed out")));
          upstream.on("error", (error) => {
            if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
            res.end(`Proxy error: ${error.message}`);
          });
          // Only the FIRST hop carries the browser's request body; redirect hops are GET/HEAD.
          if (hop === 0) req.pipe(upstream);
          else upstream.end();
        }
        forward(target, 0);
    });
  };
  return {
    name: "kachat-nextcloud-proxy",
    configureServer: mount,
    configurePreviewServer: mount,
  };
}

export default defineConfig({
  plugins: [nextcloudProxy()],
  // The Kaspa SDK is wasm-bindgen output, and its generated glue checks that an object handed
  // across the boundary is an instance of the expected class - reporting the constructor's NAME
  // when it is not. Minification renames classes, so on the built site `new Resolver()` arrived as
  // `object constructor \`e\` does not match expected class \`Resolver\`` and automatic node
  // selection could not connect at all. Dev was fine because dev does not minify, which is exactly
  // why this only ever appeared on the published site.
  // Vite 8 bundles and minifies with rolldown/oxc, and the `esbuild.keepNames` that used to do
  // this is ignored there - so on the built site the class names were mangled again and every
  // object handed to the SDK failed its cast: `new Resolver()` (automatic node scan) and, seen
  // as "Invalid PrivateKey (must be a string or an instance of PrivateKey)", signMessage for
  // KaPosts, KNS and group actions. Both the transform and the minifier are told to keep names.
  esbuild: {
    keepNames: true,
  },
  oxc: {
    keepNames: true,
  },
  build: {
    rolldownOptions: {
      output: {
        keepNames: true,
      },
    },
  },
  server: {
    // Vite rejects unknown Host headers by default; allow access via the
    // DuckDNS domain fronted by Nginx Proxy Manager.
    allowedHosts: [".duckdns.org"],
  },
  // Same allowance for the built site, which is what the public deployment should serve.
  preview: {
    host: "0.0.0.0",
    allowedHosts: [".duckdns.org"],
  },
});
