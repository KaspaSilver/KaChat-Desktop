# Moving KaChat Desktop to https://desktop.kachat.app/ (DSK-013)

**For:** the owner and whoever administers kachat.app (nginx, certbot, the deploy cron).
**Why:** browser storage belongs to an origin, not a path. At `https://kachat.app/desktop/` the wallet
shares the `https://kachat.app` origin with the link site and the relay sidecar, so a bug in any of
them can read the wallet's localStorage and IndexedDB. A dedicated origin that hosts nothing else
removes that.

The app side is done (see "What the app already does" at the end). This file lists the server
work, in order, plus rollback and testing.

---

## 0. Before you start

- The app code with `ui/origin-migration.js` must be on `main` and deployed to **both** places
  below. The old address only shows the "moved" screen once it serves a build that contains it.
- Pick the **switch-over date**: the day both sites are live. From that day the old address stops
  running the app for anyone with saved accounts and offers "Move my accounts" instead.
- Do **not** add `Cross-Origin-Opener-Policy: same-origin` to either site during the transition.
  The hand-off uses `window.open` + `window.opener` + `postMessage`; COOP `same-origin` on the new
  site cuts the opener and the move silently never starts. (Nothing sends COOP today; keep it that
  way until the old address is a plain redirect.)

## 1. DNS

Point `desktop.kachat.app` at the same server as `kachat.app`:

```
desktop.kachat.app.  300  IN  A     <kachat.app IPv4>
desktop.kachat.app.  300  IN  AAAA  <kachat.app IPv6>     ; only if kachat.app has AAAA
```

or `desktop.kachat.app. CNAME kachat.app.` if your DNS provider prefers that. Check:

```sh
dig +short desktop.kachat.app A
dig +short desktop.kachat.app AAAA
```

## 2. Certificate

With the system nginx on kachat.app (certbot's nginx plugin):

```sh
sudo certbot certonly --nginx -d desktop.kachat.app
# or, if certbot should also write the ssl_* lines into the new server block:
# sudo certbot --nginx -d desktop.kachat.app
```

Webroot alternative (if the nginx plugin is not installed):

```sh
sudo mkdir -p /var/www/desktop.kachat.app
sudo certbot certonly --webroot -w /var/www/desktop.kachat.app -d desktop.kachat.app
```

Renewal is covered by the existing certbot timer; check with `sudo certbot renew --dry-run`.

## 3. Web root

```sh
sudo mkdir -p /var/www/desktop.kachat.app
sudo chown <deploy-user>:<deploy-user> /var/www/desktop.kachat.app
```

## 4. nginx server block for desktop.kachat.app

New file, e.g. `/etc/nginx/sites-available/desktop.kachat.app`, then
`sudo ln -s ../sites-available/desktop.kachat.app /etc/nginx/sites-enabled/`.

This site hosts **only** the wallet and its relay. Nothing else may ever be added to this origin.

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name desktop.kachat.app;
    location /.well-known/acme-challenge/ { root /var/www/desktop.kachat.app; }
    location / { return 301 https://desktop.kachat.app$request_uri; }
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;                       # nginx >= 1.25.1; older: "listen 443 ssl http2;"
    server_name desktop.kachat.app;

    ssl_certificate     /etc/letsencrypt/live/desktop.kachat.app/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/desktop.kachat.app/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;      # if certbot installed it
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;         # if present

    root /var/www/desktop.kachat.app;
    index index.html;
    include mime.types;              # .js as JavaScript, .wasm as application/wasm (nosniff)

    add_header Strict-Transport-Security "max-age=31536000" always;
    # Security headers: copy the four lines from docs/SECURITY_HEADERS.md (DSK-014) exactly,
    # i.e. Content-Security-Policy (the https policy), X-Frame-Options DENY,
    # X-Content-Type-Options nosniff, Referrer-Policy strict-origin-when-cross-origin.
    # They are NOT repeated here so there is one source of truth; the policy text itself is
    # generated from tools/security-headers.mjs.
    # add_header Content-Security-Policy "...from docs/SECURITY_HEADERS.md..." always;
    # add_header X-Frame-Options "DENY" always;
    # add_header X-Content-Type-Options "nosniff" always;
    # add_header Referrer-Policy "strict-origin-when-cross-origin" always;

    # The app shell: SPA fallback. index.html, sw.js and manifest.json must revalidate so a new
    # build (and a new service worker) is picked up on the next load.
    location / {
        try_files $uri $uri/ /index.html;
        add_header Cache-Control "no-cache" always;
        # add_header lines here replace the server-level ones: repeat the four security headers
        # (and HSTS) in this block too - see "Inheritance" in docs/SECURITY_HEADERS.md.
    }

    # Content-hashed build output: immutable.
    location /assets/ {
        try_files $uri =404;
        add_header Cache-Control "public, max-age=31536000, immutable" always;
        # repeat the security headers here as well (nosniff matters most for assets)
    }

    # The relay (tools/nc-proxy-server.mjs + relay-guard.mjs in the kachat-ncproxy container).
    # Sibling location, so it never inherits the page's add_header lines: the relay sends its own
    # `content-security-policy: sandbox` + nosniff. No `rewrite` (it would decode %2F in the
    # encoded origin); the sidecar strips /nc-proxy itself.
    location /nc-proxy/ {
        proxy_pass http://127.0.0.1:8790;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;      # overwrite, never append a client value
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;              # Talk signalling long polls / upgrades
        proxy_set_header Connection $connection_upgrade_or_close;   # see the map below, or use ""
        proxy_buffering off;                                 # long polls stream through
        proxy_read_timeout 150s;                             # writes get up to 120 s upstream
        proxy_send_timeout 150s;
        client_max_body_size 200m;                           # Nextcloud media uploads
    }
}
```

If you do not already have a `$connection_upgrade_or_close` map, add this to the `http {}` block (or
just use `proxy_set_header Connection "";`):

```nginx
map $http_upgrade $connection_upgrade_or_close { default upgrade; "" ""; }
```

Copy `proxy_read_timeout`, `client_max_body_size` and the buffering settings from the existing
`location /desktop/nc-proxy/` block if they differ: the new block should behave exactly like the old
one. Then:

```sh
sudo nginx -t && sudo systemctl reload nginx
```

### Relay sidecar notes (`kachat-ncproxy`)

- **No relay change is needed.** `tools/nc-proxy-server.mjs` strips an optional `/desktop` prefix
  and then `/nc-proxy`, so the same container serves `/desktop/nc-proxy/...` (old) and
  `/nc-proxy/...` (new) at once. The relay checks no page origin, so it needs no allowlist edit.
- **`KACHAT_TRUSTED_PROXIES`.** The relay rate-limits per client and only believes
  `X-Forwarded-For` from listed peers (default `loopback`). nginx on the host reaching a container
  through a published port arrives from the Docker bridge gateway, not 127.0.0.1, unless the
  daemon runs with `userland-proxy` enabled. Check what the container sees:
  `docker logs kachat-ncproxy` or temporarily `KACHAT_RELAY_RATE_MAX=1` and look at the client key.
  If it is the gateway, set e.g. `KACHAT_TRUSTED_PROXIES=172.17.0.1` (the actual gateway of its
  network) on the container. Whatever works for the old `/desktop/nc-proxy/` today works
  unchanged for the new block, because both come from the same nginx.
- Do not set `KACHAT_TRUST_CF_CONNECTING_IP=1` unless the site really sits behind Cloudflare.
- Optional later: give the relay its own origin, `relay.kachat.app` (see section 9). Not needed
  now: the relay on the wallet origin is the same arrangement as today, minus the link site.

## 5. Deploy script (`/home/vahome/kachat-app-deploy/deploy.sh` on the indexer box)

Today it runs `npx vite build --base=/desktop/` when `main` moves and rsyncs `dist/` to
`kachat.app:/var/www/html/desktop/`. Change it to build **twice** from the same commit and rsync
each build to its own root:

```sh
# new origin, base "/"
npm run build:desktop-origin -- --outDir dist-origin --emptyOutDir
rsync -a --delete dist-origin/ kachat.app:/var/www/desktop.kachat.app/

# old address, base "/desktop/" - keeps serving the "moved" screen during the transition
npm run build:desktop-subpath -- --outDir dist-subpath --emptyOutDir
rsync -a --delete dist-subpath/ kachat.app:/var/www/html/desktop/
```

(`npm ci` once before, as the script does today; `tools/check-wasm.sh` runs inside both scripts.)
Notes:

- Build order does not matter, but deploy **both** in the same run so the two addresses always run
  the same release (the hand-off protocol is versioned, `v: 1`, and both sides must speak it).
- Keep `--delete` on each rsync but never point one rsync at the other's root.
- `dist-origin/` and `dist-subpath/` are build output; add them to the clone's ignore list on the
  build box (or build into a temp dir) so they never get committed.
- The migration origins are compiled in. Defaults are `https://kachat.app` + `/desktop/` (old) and
  `https://desktop.kachat.app` + `/` (new); the build needs no env. Overrides, for a staging pair:
  `VITE_KACHAT_MIGRATE_FROM`, `VITE_KACHAT_MIGRATE_FROM_PATH`, `VITE_KACHAT_MIGRATE_TO`,
  `VITE_KACHAT_MIGRATE_TO_PATH`. **The module is OFF by default**: a build only shows the move screen
  (old address) and accepts the hand-off (new address) when built with `VITE_KACHAT_MIGRATE=1`. Turn it
  on in the deploy script for BOTH builds only after desktop.kachat.app is live and serving the new build
  (step order: DNS + certificate + nginx, deploy the new-address build with `VITE_KACHAT_MIGRATE=1`,
  check it loads, then deploy the old-address build with `VITE_KACHAT_MIGRATE=1`).
- The test site `kachatdesktoptest.duckdns.org` (base `/`) needs no change: its origin is neither
  of the two, so the module does nothing there. Same for Docker/self-hosted installs.

## 6. The old address during the transition (kachat.app/desktop/)

Keep `location /desktop/` and `location /desktop/nc-proxy/` exactly as they are, serving the new
`build:desktop-subpath` output. What visitors see there now:

| Visitor | Old address shows |
|---|---|
| Has saved accounts | "KaChat Desktop has moved to desktop.kachat.app" + **Move my accounts** (+ "Not now - open KaChat here this time", one tab only) |
| No saved accounts | "KaChat Desktop has moved", forwards to desktop.kachat.app after 4 s |
| Already moved | "Moved on <date>", **Open desktop.kachat.app**, **Remove KaChat data from the old address**, "Move my accounts again" |

Make sure `index.html` under `/desktop/` is not cached for long (`Cache-Control: no-cache`, as in
section 4), otherwise browsers keep showing the old app until the cache expires.

Also update anything that links to `https://kachat.app/desktop/`: the kachat.app home page / link
site ("Open in browser" fallbacks, if any), READMEs, store listings, social bios. They can point
straight at `https://desktop.kachat.app/`.

## 7. After N weeks: the old address becomes a redirect

Suggested N = 8-12 weeks (owner decides; watch the access log for `/desktop/` hits from returning
users first). Then replace the two `/desktop/` locations with:

```nginx
location = /desktop { return 301 https://desktop.kachat.app/; }
location /desktop/  { return 301 https://desktop.kachat.app/; }
```

and drop the `build:desktop-subpath` step from the deploy script. **Consequence:** anyone who had
not pressed "Move my accounts" by then can no longer reach their old-address data from a browser
(the data stays on their disk under kachat.app, but no page there reads it any more). They must
restore from their seed phrases. Announce the date in the app (the moved screen) and elsewhere
before switching. A gentler variant: keep serving only the subpath build (no app, just the move
screen) indefinitely, it is tiny and costs nothing.

When the redirect is live, also remove `location /desktop/nc-proxy/` so the relay is no longer
reachable on the kachat.app origin at all.

## 8. Rollback

The change is additive, so rollback is cheap:

1. **New site broken, old fine:** in the deploy script, build the old address with
   `npm run build:desktop-subpath` (without `VITE_KACHAT_MIGRATE=1` ...` and redeploy. The old address runs
   the app again exactly as before (moved users keep their old data there unless they pressed
   "Remove"). Leave desktop.kachat.app up or take its server block down.
2. **Moved users after a rollback:** their marker (`kachat-origin-migrated-v1`) stays in storage
   but is ignored when the module is off; their old data is still there unless they removed it.
   Accounts created or changed on the new site after the move exist only there; tell users to
   keep using desktop.kachat.app or restore from seed on the old one.
3. **Full revert:** `git revert` the app commit, redeploy the old address, remove the new server
   block, `sudo nginx -t && sudo systemctl reload nginx`. Leave the certificate and DNS in place;
   they are harmless.

Nothing in the hand-off deletes data automatically: the old copy stays until the user presses
"Remove KaChat data from the old address", and a failed write on the new side restores what was
there before.

## 9. Option for later: the relay on its own origin (relay.kachat.app)

Not required now. To finish DSK-013's suggestion completely:

- DNS + certificate + server block for `relay.kachat.app` with only `location /nc-proxy/` (as above).
- The relay must then answer CORS for exactly `https://desktop.kachat.app` (preflight included,
  credentials only if Talk cookies need them), and `connect-src` in the CSP gains that origin.
- The app builds relay URLs from `import.meta.env.BASE_URL` today (`engine/endpoints.js`
  `proxyRoot()`, `ui/nextcloud.js`, `engine/kns.js`); those would read a configurable relay base
  instead. A separate app change, not part of this move.

## 10. Test plan

Before announcing:

1. `curl -sI https://desktop.kachat.app/` - 200, the four security headers + HSTS, no COOP header.
2. `curl -sI https://desktop.kachat.app/nc-proxy/__probe` - relay answers (body `kachat-proxy`),
   carries the relay's sandbox CSP, not the page CSP.
3. `curl -s https://desktop.kachat.app/manifest.json` - `start_url` and `scope` are `./`;
   `curl -sI https://desktop.kachat.app/sw.js` - 200, JavaScript type.
4. Open https://desktop.kachat.app/ in a clean profile: the app starts, connects to a node, the
   "Coming from kachat.app/desktop?" hint shows at the bottom; dismiss it.
5. In a browser profile that has a **throwaway** account on https://kachat.app/desktop/ (set an
   app password on it): reload the old address - the moved screen with **Move my accounts**.
   Press it - a window opens at desktop.kachat.app showing the account name and address - press
   **Move accounts here** - the new window reloads into KaChat and asks for the password; the same
   password opens the account; chats and settings are there. The old tab says "Done".
6. Reload the old address: the moved screen. Press **Remove KaChat data from the old address**,
   confirm; reload: still the moved screen, "No KaChat data is left". DevTools > Application on
   kachat.app: no `kachat-*` localStorage keys except `kachat-origin-migrated-v1`, no
   `kachat-desktop` IndexedDB, no service worker for `/desktop/`.
7. Old address in a profile **without** accounts: the notice, then a redirect to the new site.
8. An installed old PWA (Chrome "Install app" on kachat.app/desktop): opens the moved screen, not a
   cached app; install again from desktop.kachat.app.
9. Nextcloud / link previews on the new site (they use `/nc-proxy/`); a KNS lookup; Talk if used.
10. The other kachat.app pages (link site, post/broadcast previews) still work.
11. Delete the throwaway account data on both origins afterwards.

Known limitation: a **Home Screen web app on iPhone/iPad** keeps its own storage and cannot pass it
to a browser window, so the hand-off cannot work from there. The moved screen says so and offers
"Not now - open KaChat here this time" so those users can write down their seed phrases (or export
a backup) and restore on the new address.

---

## What the app already does (for reference)

- `ui/origin-migration.js`, called first thing from `ui/app.js` (`await originMigrationGate()`),
  before anything touches storage; `ui/pwa.js` registers no service worker on the old address.
- Hand-off: the old page opens `https://desktop.kachat.app/?migrate=1`; the new page (only with
  that parameter **and** a `window.opener`) sends `ready` with a fresh 32-byte nonce to exactly
  `https://kachat.app`; the old page answers once, to exactly `https://desktop.kachat.app`, with the
  nonce and a snapshot; the new page checks origin, source window, nonce, shapes and size
  (128 Mi characters), shows the accounts and asks the user, replaces its KaChat data, reads it
  back, and acknowledges with a SHA-256 of what it stored. Only a matching hash marks the old
  address "moved". No data in URLs, no `"*"` target origins, nothing decrypted.
- What moves: all `kachat*` localStorage keys except rebuildable caches (prices, balance
  snapshots, profile/KNS caches, Public Chats caches, node registries, .kachat registry cache),
  plus the IndexedDB chat store (`kachat-desktop`/`kv`). Not moved: sessionStorage (sign in again),
  service-worker caches, notification permission, the installed web app.
- Builds: `npm run build:desktop-origin` (base `/`) and `npm run build:desktop-subpath`
  (base `/desktop/`); all paths (relay, `sw.js`, manifest, icons, `.wasm`, `upgrade-insecure.js`)
  follow the base.
- Tests: `node tools/test-origin-migration.mjs`.
