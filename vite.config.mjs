import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import { createRelay } from "./tools/relay-guard.mjs";
import { securityHeaders } from "./tools/security-headers.mjs";

// ChangeNOW Swap: the server's key, read here once and kept in this process only. CHANGENOW_API_KEY
// is the name; VITE_CHANGENOW_API_KEY (what older docker-compose files passed) is accepted as a
// fallback. A VITE_ name is something Vite puts into the browser bundle (ui/origin-migration.js
// reads import.meta.env whole), so it is taken out of the environment here and out of the resolved
// env below - the key reaches the relay and never the page.
let changenowApiKey = String(process.env.CHANGENOW_API_KEY || process.env.VITE_CHANGENOW_API_KEY || "").trim();
delete process.env.VITE_CHANGENOW_API_KEY;

// Same-origin relay. The desktop app runs in a browser, and stock Nextcloud (and several other
// hosts the app talks to) send no CORS headers - so the app routes those calls through
//   /nc-proxy/<encodeURIComponent(origin)>/<path>
// and this middleware forwards them server-side, where CORS doesn't exist. Public /s/TOKEN share
// links are NOT proxied - recipients open those on the real server.
//
// The relay itself (SSRF guard with DNS pinning, navigation refusal, response sandboxing, cookie
// jars for Nextcloud Talk, write/rate/ChangeNOW controls) lives in tools/relay-guard.mjs and is
// shared with the standalone sidecar (tools/nc-proxy-server.mjs) that serves static deployments.
function nextcloudProxy() {
  // One handler, mounted on BOTH the dev server and the preview server. `configureServer` alone
  // meant the proxy existed only while running `vite dev`; `vite build` + `vite preview` hashes
  // every asset (permanent cache-busting) and this hook is what keeps the relay working there.
  const relay = createRelay({
    // Private ranges (RFC1918, CGNAT/Tailscale, IPv6 ULA) only for a private install whose
    // Nextcloud sits on the same LAN. On a public deployment they would expose the host's network.
    allowPrivate: String(process.env.KACHAT_RELAY_ALLOW_PRIVATE || "") === "1",
    // Whose X-Forwarded-For counts for the rate limit (default: loopback only). Behind a reverse
    // proxy in another container, list that proxy's address here.
    trustedProxies: process.env.KACHAT_TRUSTED_PROXIES,
    trustCfConnectingIp: String(process.env.KACHAT_TRUST_CF_CONNECTING_IP || "") === "1",
    rateMax: Number(process.env.KACHAT_RELAY_RATE_MAX || 600),
    // ChangeNOW: attached only to the app's own four swap calls, under its own per-client limit.
    changenowApiKey: () => changenowApiKey,
    changenowRateMax: Number(process.env.KACHAT_CHANGENOW_RATE_MAX || 30),
    // A seed or API that never answers must not hold the connection until the CDN in front gives
    // up (Cloudflare's 522): fifteen seconds for reads; writes get two minutes, long polls one.
    readTimeoutMs: 15000,
    log: (line) => console.warn(line),
  });

  const mount = (server) => {
    // Mounted at /nc-proxy and, when the site is built under a base (the published site lives at
    // /desktop/), at <base>/nc-proxy as well: a reverse proxy that forwards the path unchanged
    // reaches the handler either way. The client builds its URL from the same base.
    const base = String(server.config?.base || "/").replace(/\/+$/, "");
    const mounts = new Set(["/nc-proxy", `${base}/nc-proxy`]);
    // connect strips the mount prefix, so req.url is "/<origin>/<path>?<query>".
    for (const mountPath of mounts) server.middlewares.use(mountPath, (req, res) => relay.handle(req, res, req.url || ""));
  };
  return {
    name: "kachat-nextcloud-proxy",
    // A VITE_CHANGENOW_API_KEY in a .env file is loaded after this file runs: the relay takes it
    // (when nothing above set a key) and the bundle's env loses it.
    configResolved(config) {
      if (!config.env || !("VITE_CHANGENOW_API_KEY" in config.env)) return;
      if (!changenowApiKey) changenowApiKey = String(config.env.VITE_CHANGENOW_API_KEY || "").trim();
      delete config.env.VITE_CHANGENOW_API_KEY;
    },
    configureServer: mount,
    configurePreviewServer: mount,
  };
}

// The launch screen (index.html .boot-splash) shows "KaChat 5.2.2 (231)" under the Kaspa logo
// before any script has run, so the label is written into the HTML here - read from ui/app.js's
// APP_VERSION / APP_BUILD each time, so it can never disagree with the one Settings shows.
function appVersionLabel() {
  return {
    name: "kachat-app-version-label",
    transformIndexHtml(html) {
      let label = "";
      try {
        const source = readFileSync(new URL("./ui/app.js", import.meta.url), "utf8");
        const version = source.match(/^const APP_VERSION = "([^"]+)";/m)?.[1];
        const build = source.match(/^const APP_BUILD = (\d+);/m)?.[1];
        if (version && build) label = `KaChat ${version} (${build})`;
      } catch { /* the label stays empty */ }
      return html.replace("%KACHAT_VERSION_LABEL%", label);
    },
  };
}

export default defineConfig({
  plugins: [nextcloudProxy(), appVersionLabel()],
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
    // DSK-014: CSP (no inline script, wasm allowed, framing refused), X-Frame-Options, nosniff and
    // Referrer-Policy on the page and every built asset. Vite applies these to static files and
    // index.html only, never to the /nc-proxy relay above, which sends its own sandbox CSP. This
    // is the http-tolerant variant (a LAN install may talk plain http/ws to a local node); the
    // https site's nginx uses the stricter one, see docs/SECURITY_HEADERS.md. The dev server is
    // left without it so HMR and the dev overlay keep working untouched.
    headers: securityHeaders({ https: false }),
  },
});
