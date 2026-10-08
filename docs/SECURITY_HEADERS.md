# Security response headers (DSK-014)

KaChat Desktop is a wallet. Two things protect it at the HTTP layer, and only the server can send
them (`frame-ancestors` and `X-Frame-Options` are ignored in a `<meta>` tag):

- **No framing.** `frame-ancestors 'none'` and `X-Frame-Options: DENY` stop another site from loading
  the app in a hidden iframe and steering clicks onto Send, slide-to-send or "Reveal private key".
- **An XSS backstop.** `script-src 'self' 'wasm-unsafe-eval'` allows only the app's own script files
  and WebAssembly. Injected `<script>` text, `on*=` attributes and `javascript:` URLs do not run.

The policy is defined once in `tools/security-headers.mjs`. `vite preview` (and the Docker image,
which serves through `vite preview`) sends it automatically. nginx needs the lines below.

## kachat.app: nginx `location /desktop/`

Add these to the `location /desktop/` block that serves the static `vite build --base=/desktop/`
output. Each one goes on a single line:

```nginx
add_header Content-Security-Policy "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; media-src 'self' data: blob: https:; connect-src 'self' https: wss:; font-src 'self' data:; worker-src 'self'; manifest-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests" always;
add_header X-Frame-Options "DENY" always;
add_header X-Content-Type-Options "nosniff" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
```

Notes for the nginx side:

- **Leave the relay alone.** Do not put these headers on `location /desktop/nc-proxy/`. The relay
  (tools/nc-proxy-server.mjs on 127.0.0.1:8790) sends its own `content-security-policy: sandbox` and
  `x-content-type-options: nosniff` on every relayed answer. A second CSP from nginx would be
  enforced on top of it. Keep `/desktop/nc-proxy/` as its own **sibling** location (the longest
  prefix wins, so it never runs the `/desktop/` block's `add_header` lines). If it is nested inside
  `location /desktop/` instead, it inherits them unless it declares at least one `add_header` of its
  own (nginx inherits `add_header` only into blocks that declare none).
- **Inheritance applies to the page too.** If `location /desktop/` (or a location nested in it, or a
  regex location such as `location ~* \.(js|css|png|wasm)$` used for caching) has any `add_header`
  of its own, that block no longer inherits server-level headers. Repeat the four lines in every
  location that serves the page or its assets. `index.html` is the one that matters most, because the
  browser takes CSP and framing rules from the document. The assets need only `nosniff`, but sending
  all four is harmless.
- **`always`** makes nginx send the headers on 4xx/5xx answers too.
- **MIME types.** With `nosniff`, `.js` must be served as JavaScript and `.wasm` as
  `application/wasm` (`include mime.types;` covers both on current nginx). The app downloads its
  `.wasm` itself and compiles the bytes, so a wrong wasm type does not break it. A wrong `.js` type
  does.
- **Deploy the build as a whole.** `index.html` now loads `/desktop/upgrade-insecure.js` (copied from
  `public/`) instead of an inline script. An old `index.html` with the inline script would be blocked
  by this CSP. That script still adds `upgrade-insecure-requests` on https pages served without
  these headers.

Check from anywhere:

```sh
curl -sI https://kachat.app/desktop/ | grep -iE 'content-security|x-frame|x-content-type|referrer'
curl -sI https://kachat.app/desktop/nc-proxy/__probe | grep -iE 'content-security|x-frame'   # sandbox only
```

## What each allowance is for

| Directive | Value | Why |
|---|---|---|
| `script-src` | `'self' 'wasm-unsafe-eval'` | Only the app's own files run. `'wasm-unsafe-eval'` lets the Kaspa SDK (`kaspa_bg.wasm`) and the Kasia cipher (`cipher_bg.wasm`) compile. There is no `'unsafe-inline'` and no `'unsafe-eval'`. |
| `style-src` | `'self' 'unsafe-inline'` | The UI uses `style=""` attributes and injects style text in many places. Styles cannot run script. |
| `img-src`, `media-src` | `'self' data: blob: https:` | Avatars, banners and link-preview images come from any host a KNS or .kachat profile or a pasted link names. Relayed pictures and Nextcloud thumbnails are `blob:` URLs, and broadcast images and voice notes are `data:` URLs. |
| `connect-src` | `'self' https: wss:` | **Broad on purpose.** Every API base can be changed in Settings > Connectivity: the Kaspa REST API, the chat/KaPosts/broadcast/push indexers, KNS, translation and the custom wRPC node. The public-node resolver hands out arbitrary `wss://` nodes, and the price and name APIs are third-party hosts. `'self'` covers the `/nc-proxy` relay (Nextcloud, Talk signalling, link previews, CORS-less hosts). WebRTC media (Talk calls) is not governed by CSP. |
| `worker-src` | `'self'` | The service worker (`sw.js`). The app starts no other workers. |
| `frame-src` | `'none'` | The app embeds no frames. |
| `frame-ancestors` | `'none'` | Nobody may frame the app. |
| `object-src`, `base-uri`, `form-action` | `'none'`, `'self'`, `'self'` | No plugins. A `<base>` tag cannot repoint relative URLs. Forms only submit (and only in-page) to this origin. |
| `upgrade-insecure-requests` | https only | Plain-http subresources (an `http://` og:image, a leftover `ws://` node) become https/wss, so the tab does not drop to "Not secure". |

`Referrer-Policy: strict-origin-when-cross-origin` is the browser default made explicit. Nothing in
the app or the relay checks `Referer`, and pictures from .kachat hosts are already requested with
`referrerpolicy="no-referrer"`.

## vite preview / Docker

`vite.config.mjs` sets `preview.headers` from `securityHeaders({ https: false })`. This is the same
policy plus `http:` (img/media/connect) and `ws:` (connect), and without
`upgrade-insecure-requests`. A LAN install served over plain http may talk to a local node at
`ws://192.168.x.x:17110` or a local indexer over http, and `upgrade-insecure-requests` on an http
page would break its own same-origin assets. Behind an https reverse proxy, `upgrade-insecure.js`
still adds the upgrade. Vite applies `preview.headers` to `index.html` and the static files only,
never to the `/nc-proxy` relay middleware.

The dev server (`npm run dev`) sends no CSP, so HMR and the error overlay keep working.
