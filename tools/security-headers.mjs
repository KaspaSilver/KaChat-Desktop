// Security response headers for the KaChat Desktop page (DSK-014): one place that spells out the
// Content-Security-Policy and its companions, used by vite.config.mjs for `vite preview` (and so the
// Docker image, which serves through vite preview) and mirrored line for line in
// docs/SECURITY_HEADERS.md for the nginx in front of kachat.app/desktop/.
//
// What the app needs, and why each allowance is there:
//   script-src  'self' + 'wasm-unsafe-eval': every script is a same-origin file (index.html carries
//               no inline script or on*= handler; the https-only upgrade-insecure-requests
//               bootstrap is public/upgrade-insecure.js). 'wasm-unsafe-eval' lets the Kaspa SDK and
//               the Kasia cipher compile their .wasm. No 'unsafe-inline', no 'unsafe-eval'.
//   style-src   'unsafe-inline': the UI sets style="" attributes and inline style text all over.
//   img-src / media-src  https: data: blob: — avatars, banners and link-preview images come from
//               whatever host a KNS / .kachat profile or a pasted link names; relayed pictures and
//               Nextcloud thumbnails arrive as blob: object URLs; broadcast images and voice notes
//               as data: URLs.
//   connect-src https: wss: — the Kaspa REST API, the KaChat/Kasia indexers, KNS, translation,
//               price APIs and the public-node resolver are all user-configurable (Settings >
//               Connectivity), and the wRPC node is any wss:// the resolver hands out or the user
//               types. Same-origin covers the /nc-proxy relay (Nextcloud, Talk, link previews).
//   worker-src  'self': the service worker (public/sw.js). The app starts no other workers.
//   frame-src   'none': the app embeds no frames.
//   frame-ancestors 'none' + X-Frame-Options: DENY: nobody may frame the wallet (clickjacking).
//
// A plain-http LAN deployment (`vite preview` on 192.168.x.x talking ws:// to a local node) must keep
// http:/ws: working, so the preview policy adds them and leaves out upgrade-insecure-requests; the
// https production policy has upgrade-insecure-requests and no plain-http sources.

/** The CSP directives, in order. `https` = the page is only ever served over https. */
export function contentSecurityPolicy({ https = true } = {}) {
  const insecure = https ? [] : ["http:"];
  const insecureWs = https ? [] : ["http:", "ws:"];
  const directives = [
    ["default-src", "'self'"],
    ["script-src", "'self'", "'wasm-unsafe-eval'"],
    ["style-src", "'self'", "'unsafe-inline'"],
    ["img-src", "'self'", "data:", "blob:", "https:", ...insecure],
    ["media-src", "'self'", "data:", "blob:", "https:", ...insecure],
    ["connect-src", "'self'", "https:", "wss:", ...insecureWs],
    ["font-src", "'self'", "data:"],
    ["worker-src", "'self'"],
    ["manifest-src", "'self'"],
    ["frame-src", "'none'"],
    ["object-src", "'none'"],
    ["base-uri", "'self'"],
    ["form-action", "'self'"],
    ["frame-ancestors", "'none'"],
  ];
  if (https) directives.push(["upgrade-insecure-requests"]);
  return directives.map((d) => d.join(" ")).join("; ");
}

/** Every header the page and its static assets are served with. */
export function securityHeaders({ https = true } = {}) {
  return {
    "Content-Security-Policy": contentSecurityPolicy({ https }),
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
  };
}
